#!/usr/bin/env node
/*
  Mission Control — GOG Sentinel Loop (Gmail + Calendar → Tasks)

  - Gmail: pull unread inbox messages and create Inbox tasks.
  - Calendar: pull next 24h events and create prep tasks.

  Full autonomy mode: tasks are created; specialist agents can act.
  (We do not auto-send emails yet in v1; we surface as tasks to avoid accidental misfires.)

  Guardrails:
  - Dedupe by message/event IDs in state file
  - Max tasks per tick
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'mc.db');
const STATE_PATH = path.resolve(__dirname, 'gog-sentinel.state.json');

const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';
const ROOM_ID = process.env.BREAKROOM_ID || 'breakroom';

const POLL_MS = Number(process.env.GOG_SENTINEL_POLL_MS || 10 * 60_000);
const MAX_CREATE_PER_TICK = Number(process.env.GOG_SENTINEL_MAX_CREATE_PER_TICK || 10);

const ACCOUNT = process.env.GOG_ACCOUNT || '';
const GOG_BIN = process.env.GOG_BIN || 'gog';

function nowMs(){ return Date.now(); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function nanoid(n=10){ return crypto.randomBytes(Math.ceil(n*0.75)).toString('base64url').slice(0,n); }

function readState(){
  try { return JSON.parse(fs.readFileSync(STATE_PATH,'utf8')); }
  catch {
    return {
      seen: { gmail: {}, events: {} },
      pendingSends: [],
      lastCancelScanAt: 0,
      lastTickAt: 0
    };
  }
}
function writeState(st){ fs.writeFileSync(STATE_PATH, JSON.stringify(st,null,2)); }

function taskExistsByTitle(db, title){
  return !!db.prepare('SELECT id FROM tasks WHERE title=? LIMIT 1').get(title);
}

function insertTask(db, { title, description, priority=2 }){
  const ts = nowMs();
  const id = nanoid(10);
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at, needs_approval, checklist)
    VALUES (@id,@title,@description,'inbox',@priority,@ts,@ts,0,'')
  `).run({ id, title, description: description||'', priority, ts });

  db.prepare(`
    INSERT INTO activities (id, created_at, type, agent_id, task_id, message)
    VALUES (@aid,@ts,'task_created','hermes',@taskId,@msg)
  `).run({
    aid: 'act_' + nanoid(10),
    ts,
    taskId: id,
    msg: `GOG Sentinel: created task “${title}”`
  });

  return id;
}

function gogJson(args){
  const base = [GOG_BIN];
  if (ACCOUNT) base.push('--account', ACCOUNT);
  base.push('--json', '--no-input');
  const out = execFileSync(base[0], base.slice(1).concat(args), { encoding:'utf8', stdio:['ignore','pipe','pipe'] });
  return JSON.parse(out);
}

function gogText(args, inputText=null){
  const base = [GOG_BIN];
  if (ACCOUNT) base.push('--account', ACCOUNT);
  // no --json for create/update when we might send body via stdin; use --json when supported explicitly
  const out = execFileSync(base[0], base.slice(1).concat(args), {
    encoding:'utf8',
    stdio: ['pipe','pipe','pipe'],
    input: inputText == null ? undefined : inputText
  });
  return String(out||'').trim();
}

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

async function postToRoom(agentId, content) {
  return httpJson(`${BASE}/api/rooms/${encodeURIComponent(ROOM_ID)}/messages`, {
    method: 'POST',
    body: { fromAgentId: agentId, content }
  });
}

function openclawAgent(agentId, message, timeoutSec = 240) {
  const OPENCLAW = process.env.OPENCLAW_BIN || '/home/chris/.npm-global/bin/openclaw';
  const out = execFileSync(OPENCLAW, ['agent','--agent',agentId,'--message',message,'--json','--timeout',String(timeoutSec)], { encoding:'utf8' });
  const j = JSON.parse(out);
  const payload = j?.result?.payloads?.[0]?.text ?? '';
  return String(payload||'').trim();
}

function iso(ts){
  return new Date(ts).toISOString();
}

function extractEmail(s) {
  const m = String(s||'').match(/<([^>]+)>/);
  if (m) return m[1];
  // fallback: first token that looks like email
  const m2 = String(s||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m2 ? m2[0] : '';
}

function scheduleDraftSend(st, draftId, meta) {
  const delayMs = Number(process.env.GOG_AUTO_SEND_DELAY_MS || 30 * 60_000);
  const sendAt = nowMs() + delayMs;
  st.pendingSends ||= [];
  st.pendingSends.push({
    draftId,
    sendAt,
    createdAt: nowMs(),
    subject: meta.subject,
    to: meta.to,
    replyToMessageId: meta.replyToMessageId
  });
}

function gmailTick(st, db, created){
  const q = process.env.GOG_GMAIL_QUERY || 'is:unread in:inbox newer_than:3d';
  const max = Number(process.env.GOG_GMAIL_MAX || 20);

  let data;
  try {
    data = gogJson(['gmail','messages','search', q, '--max', String(max)]);
  } catch (e) {
    if (!taskExistsByTitle(db, 'Fix: GOG Gmail monitoring failing')) {
      insertTask(db, {
        title: 'Fix: GOG Gmail monitoring failing',
        priority: 3,
        description: `gog gmail messages search failed. Error: ${String(e.message||e).slice(0,400)}`
      });
    }
    return;
  }

  const msgs = Array.isArray(data.messages) ? data.messages : [];
  for (const m of msgs) {
    if (created.n >= MAX_CREATE_PER_TICK) return;

    const id = String(m.id || '');
    if (!id) continue;
    if (st.seen.gmail[id]) continue;

    const from = String(m.from || '').trim();
    const subj = String(m.subject || '(no subject)').trim();
    const date = String(m.date || '').trim();
    const labelsArr = Array.isArray(m.labels) ? m.labels : [];
    const labels = labelsArr.join(', ');

    const title = `📧 ${subj}`;
    const desc = [
      `From: ${from}`,
      `Date: ${date}`,
      `Gmail message id: ${id}`,
      labels ? `Labels: ${labels}` : null,
      '',
      `Next actions: reply / archive / create follow-up tasks.`,
    ].filter(Boolean).join('\n');

    if (!taskExistsByTitle(db, title)) {
      insertTask(db, { title, description: desc, priority: (labels.includes('IMPORTANT') ? 3 : 2) });
      created.n++;
    }

    // Auto-draft + send after delay (configurable).
    // Heuristic: only if IMPORTANT and not noreply.
    const eligible = labelsArr.includes('IMPORTANT') && !/noreply/i.test(from);
    if (eligible) {
      try {
        const meta = gogJson(['gmail','get', id, '--format', 'metadata', '--headers', 'From,To,Subject,Date']);
        const snippet = String(meta.snippet || '').slice(0, 600);
        const toEmail = extractEmail(from);
        if (toEmail) {
          const prompt = [
            'Draft a short, friendly reply email.',
            'Keep it concise (3-8 lines).',
            'If it is a transactional/notification email, do NOT reply; instead output NO_REPLY.',
            `Subject: ${subj}`,
            `From: ${from}`,
            snippet ? `Snippet: ${snippet}` : '',
          ].filter(Boolean).join('\n');

          const body = openclawAgent('prometheus', prompt, 180);
          if (body && body.trim() && body.trim() !== 'NO_REPLY') {
            // Create draft in-thread
            const out = gogText([
              'gmail','drafts','create',
              '--to', toEmail,
              '--subject', `Re: ${subj}`,
              '--reply-to-message-id', id,
              '--body-file', '-'
            ], body.trim() + '\n');

            // gog prints JSON only with --json; we can fetch latest drafts to find the newest.
            const drafts = gogJson(['gmail','drafts','list', '--max', '1']);
            const draftId = String(drafts?.drafts?.[0]?.id || drafts?.items?.[0]?.id || '').trim();

            if (draftId) {
              scheduleDraftSend(st, draftId, { subject: subj, to: toEmail, replyToMessageId: id });
              const mins = Math.round(Number(process.env.GOG_AUTO_SEND_DELAY_MS || 30*60_000) / 60000);
              postToRoom('hermes', `📧 Draft created for: “${subj}” (to ${toEmail})\nDraft id: ${draftId}\nScheduled send in ~${mins} minutes. To cancel: post “cancel draft ${draftId}” in breakroom.`).catch(()=>{});
            }
          }
        }
      } catch {
        // ignore draft failures for now
      }
    }

    st.seen.gmail[id] = nowMs();
  }
}

function calendarTick(st, db, created){
  const horizonHrs = Number(process.env.GOG_CAL_HORIZON_HRS || 24);
  const from = iso(nowMs() - 5 * 60_000); // slight back buffer
  const to = iso(nowMs() + horizonHrs * 60 * 60_000);

  let cals;
  try {
    cals = gogJson(['calendar','calendars']);
  } catch (e) {
    if (!taskExistsByTitle(db, 'Fix: GOG Calendar monitoring failing')) {
      insertTask(db, {
        title: 'Fix: GOG Calendar monitoring failing',
        priority: 3,
        description: `gog calendar calendars failed. Error: ${String(e.message||e).slice(0,400)}`
      });
    }
    return;
  }

  const calendars = Array.isArray(cals.calendars) ? cals.calendars : (Array.isArray(cals.items) ? cals.items : []);
  const primary = calendars.find(x => x.primary) || calendars[0];
  const calId = primary?.id || ACCOUNT;
  if (!calId) return;

  let ev;
  try {
    ev = gogJson(['calendar','events', calId, '--from', from, '--to', to]);
  } catch (e) {
    return;
  }

  const events = Array.isArray(ev.events) ? ev.events : [];
  for (const e of events) {
    if (created.n >= MAX_CREATE_PER_TICK) return;

    const id = String(e.id || '');
    if (!id) continue;
    if (st.seen.events[id]) continue;

    const summary = String(e.summary || 'Calendar event').trim();
    const start = String(e.start || e.startTime || e.start_date_time || e.startDateTime || '').trim();
    const end = String(e.end || e.endTime || e.end_date_time || e.endDateTime || '').trim();

    const title = `🗓️ Prep: ${summary}`;
    const desc = [
      `Calendar: ${calId}`,
      `Event id: ${id}`,
      start ? `Start: ${start}` : null,
      end ? `End: ${end}` : null,
      '',
      `Prep checklist: agenda, links, attendees, outcome, follow-ups.`,
    ].filter(Boolean).join('\n');

    if (!taskExistsByTitle(db, title)) {
      insertTask(db, { title, description: desc, priority: 2 });
      created.n++;
    }

    st.seen.events[id] = nowMs();
  }
}

async function scanCancels(st) {
  // Look for: "cancel draft <id>" in breakroom messages since last scan.
  st.lastCancelScanAt = Number(st.lastCancelScanAt || 0);
  try {
    const db = new Database(DB_PATH);
    const rows = db.prepare(
      'SELECT from_agent_id, content, created_at FROM room_messages WHERE room_id=? AND created_at > ? ORDER BY created_at ASC LIMIT 100'
    ).all(ROOM_ID, st.lastCancelScanAt);
    db.close();

    if (!rows.length) return;
    st.lastCancelScanAt = rows[rows.length - 1].created_at;

    for (const r of rows) {
      const who = String(r.from_agent_id || '').toLowerCase();
      if (!['jarvis','chris'].includes(who)) continue;
      const m = String(r.content || '').match(/cancel\s+draft\s+(\S+)/i);
      if (!m) continue;
      const id = m[1];
      const before = (st.pendingSends || []).length;
      st.pendingSends = (st.pendingSends || []).filter(p => p.draftId !== id);
      const after = st.pendingSends.length;
      if (after < before) {
        await postToRoom('hermes', `🛑 Canceled scheduled send for draft ${id}.`);
      }
    }
  } catch {
    // ignore
  }
}

async function processPendingSends(st) {
  st.pendingSends ||= [];
  const now = nowMs();
  const due = st.pendingSends.filter(p => Number(p.sendAt||0) <= now);
  const keep = st.pendingSends.filter(p => Number(p.sendAt||0) > now);

  for (const p of due) {
    try {
      gogText(['gmail','drafts','send', p.draftId]);
      await postToRoom('hermes', `✅ Sent draft ${p.draftId} (${p.subject || 'email'}).`);
    } catch (e) {
      // If send fails, keep it and report once.
      keep.push({ ...p, sendAt: now + 10*60_000, lastError: String(e.message||e).slice(0,200) });
      await postToRoom('hermes', `⚠️ Failed sending draft ${p.draftId}; will retry in 10 min. Error: ${String(e.message||e).slice(0,160)}`);
    }
  }

  st.pendingSends = keep;
}

async function tick(){
  const st = readState();
  st.seen ||= { gmail: {}, events: {} };

  // keep state from growing unbounded
  const trimMap = (m) => {
    const entries = Object.entries(m||{}).sort((a,b)=>b[1]-a[1]).slice(0, 2000);
    return Object.fromEntries(entries);
  };
  st.seen.gmail = trimMap(st.seen.gmail);
  st.seen.events = trimMap(st.seen.events);

  await scanCancels(st);
  await processPendingSends(st);

  const created = { n: 0 };

  const db = new Database(DB_PATH);
  try {
    gmailTick(st, db, created);
    calendarTick(st, db, created);
    st.lastTickAt = nowMs();
    writeState(st);
  } finally {
    try { db.close(); } catch {}
  }
}

async function main(){
  console.log(`GOG Sentinel running. poll=${POLL_MS}ms account=${ACCOUNT||'(default)'}`);
  writeState(readState());
  while(true){
    try { await tick(); }
    catch(e){ console.log('[gog-sentinel] tick failed:', e?.message||String(e)); }
    await sleep(POLL_MS);
  }
}

main();
