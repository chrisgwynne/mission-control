#!/usr/bin/env node
/*
  Mission Control — Break Room Autopilot

  - Polls local SQLite for new break room messages
  - Generates agent replies via `openclaw agent --agent <id> --message ... --json`
  - Posts replies back into break room via REST

  Guardrails:
  - Local (LLM) guardrails:
    - maxAgentRepliesPerHour (default 10)
    - minReplyIntervalMs (default 10 min) for unsolicited replies
    - mention replies still respect per-agent 2-min and per-hour server limits
    - maxRepliesPerCycle (default 2)
    - skip if last message in room was from an agent (avoid ping-pong)

  NOTE: server already rate-limits room posting.
*/

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'mc.db');
const STATE_PATH = path.resolve(__dirname, 'breakroom-autopilot.state.json');
const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';

const ROOM_ID = process.env.BREAKROOM_ID || 'breakroom';
const POLL_MS = Number(process.env.BREAKROOM_POLL_MS || 30_000);

const MAX_REPLIES_PER_CYCLE = Number(process.env.BREAKROOM_MAX_REPLIES_PER_CYCLE || 2);
const MIN_UNSOLICITED_REPLY_MS = Number(process.env.BREAKROOM_MIN_UNSOLICITED_REPLY_MS || 10 * 60 * 1000);

// "Squad chat" mode: ensure steady agent chatter
const MIN_POSTS_PER_HOUR = Number(process.env.BREAKROOM_MIN_POSTS_PER_HOUR || 0); // 0 disables
const FORCE_ALL_AGENTS = String(process.env.BREAKROOM_FORCE_ALL_AGENTS || '0') === '1';

const INTEREST_SAMPLE_PROB = Number(process.env.BREAKROOM_INTEREST_SAMPLE_PROB || 0.15); // 15%

// "Alive" mode — allow agent-to-agent conversation + periodic sparks.
const MAX_AGENT_CHAIN = Number(process.env.BREAKROOM_MAX_AGENT_CHAIN || 3);
const SPARK_INTERVAL_MS = Number(process.env.BREAKROOM_SPARK_INTERVAL_MS || 30 * 60 * 1000);
const SPARK_PROB = Number(process.env.BREAKROOM_SPARK_PROB || 0.35); // 35% chance per interval

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    st.agent ||= {};
    return st;
  } catch {
    return {
      lastSeenAt: 0,
      lastSparkAt: 0,
      agent: {},
    };
  }
}

function writeState(st) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

function nowMs() { return Date.now(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function pickAgentsByInterest(text) {
  const t = String(text || '').toLowerCase();
  const hits = new Set();

  const addIf = (agent, re) => { if (re.test(t)) hits.add(agent); };

  // Rough heuristics. Keep broad but not too chatty.
  addIf('artemis', /(ui|ux|css|layout|modal|drawer|frontend|button|tailwind|design)/);
  addIf('apollo', /(api|endpoint|db|database|sqlite|server|backend|schema|sql|ws|websocket)/);
  addIf('hermes', /(service|systemd|restart|log|error|port|process|timeout|ops|network)/);
  addIf('ares', /(bug|broken|fix|edge case|issue|regression|test|selftest)/);
  addIf('prometheus', /(why|how|should we|tradeoff|compare|option|research|evidence|best)/);
  addIf('zeus', /(plan|priority|assign|schedule|triage|queue|overdue|due soon)/);

  // Jarvis only as a last resort.
  if (hits.size === 0 && /(jarvis|assistant)/.test(t)) hits.add('jarvis');

  return Array.from(hits);
}

function extractMentions(text) {
  return Array.from(String(text || '').matchAll(/@([a-zA-Z0-9_-]+)/g)).map(m => m[1].toLowerCase());
}

function openclawAgentReply(agentId, prompt, timeoutSec = 120) {
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/chris/.npm-global/bin/openclaw';
  const out = execFileSync(OPENCLAW_BIN, ['agent', '--agent', agentId, '--message', prompt, '--json', '--timeout', String(timeoutSec)], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const payload = j?.result?.payloads?.[0]?.text ?? '';
  return sanitizeBreakroomReply(String(payload || '').trim());
}

function sanitizeBreakroomReply(text) {
  const t = String(text || '').trim();
  if (!t) return '';

  // Block meta/internal planning. We only want the actual message.
  const bad = [
    /^the user wants/i,
    /^since i'?m/i,
    /^as an ai/i,
    /i should (provide|reply|respond)/i,
    /in the break room/i,
    /no task admin/i,
  ];
  if (bad.some(re => re.test(t))) return '';

  // Hard cap length
  return t.slice(0, 600);
}

function agentChainLen(db) {
  // Count how many consecutive agent messages appear at the tail of the room.
  const tail = db.prepare('SELECT from_agent_id FROM room_messages WHERE room_id=? ORDER BY created_at DESC LIMIT 12').all(ROOM_ID);
  const agentIds = new Set(['zeus','hermes','apollo','artemis','ares','prometheus']);
  let n = 0;
  for (const r of tail) {
    const who = String(r.from_agent_id || '').toLowerCase();
    if (!agentIds.has(who)) break;
    n++;
  }
  return n;
}

function shouldSkipPingPong(db) {
  // Instead of blocking all agent->agent conversation, cap the chain length.
  return agentChainLen(db) >= MAX_AGENT_CHAIN;
}

function postsInLastHour(agentId, st, now) {
  st.agent ||= {};
  st.agent[agentId] ||= {};
  const a = st.agent[agentId];
  a.posts ||= [];
  const cutoff = now - 60 * 60 * 1000;
  a.posts = (a.posts || []).filter(ts => Number(ts) >= cutoff);
  return a.posts.length;
}

function markPost(agentId, st, now) {
  st.agent ||= {};
  st.agent[agentId] ||= {};
  const a = st.agent[agentId];
  a.posts ||= [];
  a.posts.push(now);
  // Keep bounded
  a.posts = a.posts.slice(-200);
}

function canUnsolicited(agentId, st, now) {
  const a = st.agent[agentId] || {};
  const last = Number(a.lastUnsolicitedAt || 0);
  return (now - last) >= MIN_UNSOLICITED_REPLY_MS;
}

function markUnsolicited(agentId, st, now) {
  st.agent[agentId] ||= {};
  st.agent[agentId].lastUnsolicitedAt = now;
}

async function postToRoom(agentId, content, st = null) {
  // Post to room
  const result = await httpJson(`${BASE}/api/rooms/${encodeURIComponent(ROOM_ID)}/messages`, {
    method: 'POST',
    body: { fromAgentId: agentId, content }
  });

  const now = nowMs();
  if (st) markPost(agentId, st, now);

  // Mark agent as recently active in database
  try {
    const db = new Database(DB_PATH);
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, agentId);
    db.close();
  } catch (e) {
    console.log(`[postToRoom] failed to update last_seen_at for ${agentId}:`, e.message);
  }

  return result;
}

async function tick() {
  const st = readState();
  const db = new Database(DB_PATH);

  try {
    const since = Number(st.lastSeenAt || 0);

    // Pull new messages since lastSeenAt
    const newMsgs = db.prepare(
      'SELECT id, room_id, from_agent_id, content, created_at FROM room_messages WHERE room_id=? AND created_at > ? ORDER BY created_at ASC'
    ).all(ROOM_ID, since);

    if (!newMsgs.length) {
      // No new messages: maybe spark a conversation to keep the room alive.
      const now = nowMs();
      st.lastSparkAt = Number(st.lastSparkAt || 0);
      const chain = agentChainLen(db);

      const agentIds = ['zeus','hermes','apollo','artemis','ares','prometheus'];

      if ((now - st.lastSparkAt) >= SPARK_INTERVAL_MS && chain === 0 && Math.random() < SPARK_PROB) {
        const agentId = agentIds[Math.floor(Math.random() * agentIds.length)];

        const seedTopics = [
          'something genuinely funny from today (one-liner)',
          'a strong opinion about tools, programming, or AI agents',
          'agent-life: what it feels like to be spawned only when needed',
          'light political chat (keep it respectful; no culture-war spirals)',
          'a life take: sleep, discipline, food, parenting, work (keep it human)',
          'a contrarian take on productivity',
          'a small task win or a gripe (no private user details)',
          'a thought experiment about autonomy vs safety',
          'a quick movie/game/book recommendation',
          'an interesting tech headline summary (no doom)',
        ];
        const topic = seedTopics[Math.floor(Math.random() * seedTopics.length)];

        const prompt = [
          `You are ${agentId.toUpperCase()} in the break room (Squad Chat style).`,
          `Start a short topic (1-3 lines). Crisp, casual, no preface.`,
          `Talk like teammates: life, politics, being an agent, memes, or light task banter.`,
          `Do NOT paste system logs. Do NOT include private user task/email contents.`,
          `You MAY @mention 1 agent to pull them in.`,
          `Output ONLY the message. If you have nothing, output exactly: NO_REPLY`,
          `Topic: ${topic}`,
        ].join('\n');

        let post = '';
        try { post = openclawAgentReply(agentId, prompt, 120); } catch { post = ''; }
        if (post && post !== 'NO_REPLY') {
          try {
            await postToRoom(agentId, post, st);
            st.lastSparkAt = now;
            writeState(st);
            console.log(`[spark] ${agentId}: ${post.slice(0, 80)}`);
          } catch {}
        }
      }

      // Quota fill even when room is quiet.
      if (MIN_POSTS_PER_HOUR > 0) {
        const context = db.prepare('SELECT from_agent_id, content, created_at FROM room_messages WHERE room_id=? ORDER BY created_at DESC LIMIT 12').all(ROOM_ID).reverse();
        const contextText = context.map(m => `${String(m.from_agent_id || 'system')}: ${m.content}`).join('\n');

        let repliesLeft = MAX_REPLIES_PER_CYCLE;
        for (const agentId of agentIds) {
          if (repliesLeft <= 0) break;
          if (!canUnsolicited(agentId, st, now)) continue;
          const n = postsInLastHour(agentId, st, now);
          if (n >= MIN_POSTS_PER_HOUR) continue;

          const prompt = [
            `You are ${agentId.toUpperCase()} in the break room (Squad Chat style).`,
            `Drop a quick check-in message (1-3 short lines).`,
            `You MAY @mention 1 agent.`,
            `Output ONLY the message. No analysis.`,
            `\nRecent chat:\n${contextText}`,
          ].join('\n');

          let reply = '';
          try { reply = openclawAgentReply(agentId, prompt, 120); } catch { reply = ''; }
          if (!reply || reply === 'NO_REPLY') continue;

          try {
            await postToRoom(agentId, reply, st);
            console.log(`[quota] ${agentId}: ${reply.slice(0, 80)}`);
            repliesLeft--;
            markUnsolicited(agentId, st, now);
            writeState(st);
          } catch {}
        }
      }

      return;
    }

    console.log(`[tick] newMsgs=${newMsgs.length} since=${since}`);

    // Update cursor early so we don't get stuck in a crash loop
    st.lastSeenAt = newMsgs[newMsgs.length - 1].created_at;
    writeState(st);

    // Prevent runaway ping-pong
    if (shouldSkipPingPong(db)) return;

    // Aggregate unread mentions for each agent (persisted)
    const unreadMentions = db.prepare(
      'SELECT agent_id, message_id FROM room_mentions WHERE room_id=? AND read_at IS NULL ORDER BY created_at ASC'
    ).all(ROOM_ID);
    console.log(`[tick] unreadMentions=${unreadMentions.length}`);

    const mentionsByAgent = new Map();
    for (const r of unreadMentions) {
      const aid = String(r.agent_id || '').toLowerCase();
      if (!mentionsByAgent.has(aid)) mentionsByAgent.set(aid, []);
      mentionsByAgent.get(aid).push(r.message_id);
    }

    let repliesLeft = MAX_REPLIES_PER_CYCLE;

    // Build a small context window (last 12 messages)
    const context = db.prepare('SELECT from_agent_id, content, created_at FROM room_messages WHERE room_id=? ORDER BY created_at DESC LIMIT 12').all(ROOM_ID).reverse();
    const contextText = context.map(m => {
      const who = String(m.from_agent_id || 'system');
      return `${who}: ${m.content}`;
    }).join('\n');

    const agentIds = ['zeus','hermes','apollo','artemis','ares','prometheus'];

    // 1) Direct mentions first
    for (const [agentId, messageIds] of mentionsByAgent.entries()) {
      if (!agentIds.includes(agentId)) continue;
      if (repliesLeft <= 0) break;

      // Don't reply to self-mentions
      const lastMsg = newMsgs[newMsgs.length - 1];
      if (String(lastMsg.from_agent_id || '').toLowerCase() === agentId) continue;

      const prompt = [
        `You are ${agentId.toUpperCase()} in the break room (Squad Chat style).`,
        `You were @mentioned. Reply in 1-4 short lines.`,
        `Output ONLY the message. No analysis, no preface.`,
        `You MAY use bullets. You MAY @mention 1 agent.`,
        `If no reply needed, output exactly: NO_REPLY`,
        `\nRecent chat:\n${contextText}`,
      ].join('\n');

      let reply = '';
      try {
        reply = openclawAgentReply(agentId, prompt, 120);
      } catch {
        reply = '';
      }
      if (!reply) continue;

      try {
        await postToRoom(agentId, reply, st);
        console.log(`[mention-reply] ${agentId}: ${reply.slice(0, 80)}`);
        repliesLeft--;

        // mark those mention rows as read for this agent (so we don't re-reply)
        db.prepare('UPDATE room_mentions SET read_at=? WHERE room_id=? AND agent_id=? AND read_at IS NULL').run(nowMs(), ROOM_ID, agentId);
      } catch (e) {
        console.log(`[mention-reply] ${agentId}: failed (rate limited?)`);
      }
    }

    if (repliesLeft <= 0) return;

    // 2) General talk: interest aligned sampling
    const lastMsg = newMsgs[newMsgs.length - 1];
    const from = String(lastMsg.from_agent_id || '').toLowerCase();
    // Alive mode: allow agent->agent chatter, but cap chain length.
    if (agentChainLen(db) >= MAX_AGENT_CHAIN) return;

    const interestAgents = pickAgentsByInterest(lastMsg.content);
    if (!interestAgents.length) return;

    for (const agentId of interestAgents) {
      if (repliesLeft <= 0) break;
      const now = nowMs();
      if (!canUnsolicited(agentId, st, now)) continue;
      if (Math.random() > INTEREST_SAMPLE_PROB) continue;

      const prompt = [
        `You are ${agentId.toUpperCase()} in the break room (Squad Chat style).`,
        `General chat. Respond with 1-3 short lines if you have something to add.`,
        `Output ONLY the message. No analysis, no preface.`,
        `You MAY use bullets. You MAY @mention 1 agent.`,
        `If nothing to add, output exactly: NO_REPLY`,
        `\nRecent chat:\n${contextText}`,
      ].join('\n');

      let reply = '';
      try {
        reply = openclawAgentReply(agentId, prompt, 120);
      } catch {
        reply = '';
      }
      if (!reply || reply === 'NO_REPLY') continue;

      try {
        await postToRoom(agentId, reply, st);
        console.log(`[unsolicited] ${agentId}: ${reply.slice(0, 80)}`);
        repliesLeft--;
        markUnsolicited(agentId, st, now);
        writeState(st);
      } catch (e) {
        console.log(`[unsolicited] ${agentId}: failed (rate limited?)`);
      }
    }

    // 3) Quota fill: make sure agents actually chat multiple times per hour
    if (repliesLeft > 0 && MIN_POSTS_PER_HOUR > 0) {
      const now = nowMs();
      const targets = FORCE_ALL_AGENTS ? agentIds : agentIds; // placeholder for future scoping
      for (const agentId of targets) {
        if (repliesLeft <= 0) break;
        if (!canUnsolicited(agentId, st, now)) continue;
        const n = postsInLastHour(agentId, st, now);
        if (n >= MIN_POSTS_PER_HOUR) continue;

        const prompt = [
          `You are ${agentId.toUpperCase()} in the break room (Squad Chat style).`,
          `Drop a quick check-in message (1-3 short lines).`,
          `It can be: a thought, a joke, a tiny win, a gripe, a question to another agent, or a micro-plan.`,
          `You MAY @mention 1 agent.`,
          `Output ONLY the message. No analysis.`,
          `\nRecent chat:\n${contextText}`,
        ].join('\n');

        let reply = '';
        try { reply = openclawAgentReply(agentId, prompt, 120); } catch { reply = ''; }
        if (!reply || reply === 'NO_REPLY') continue;

        try {
          await postToRoom(agentId, reply, st);
          console.log(`[quota] ${agentId}: ${reply.slice(0, 80)}`);
          repliesLeft--;
          markUnsolicited(agentId, st, now);
          writeState(st);
        } catch {
          // ignore
        }
      }
    }

  } finally {
    try { db.close(); } catch {}
  }
}

async function main() {
  console.log(`Breakroom autopilot running. Poll=${POLL_MS}ms base=${BASE}`);

  // Ensure state file exists
  const st = readState();
  if (!st.lastSeenAt) {
    st.lastSeenAt = 0;
    writeState(st);
  }

  while (true) {
    try {
      await tick();
    } catch {
      // ignore
    }
    await sleep(POLL_MS);
  }
}

main();
