#!/usr/bin/env node
/*
  Mission Control — Sentinel Loop (Proactive Monitoring → Tasks)

  Goal:
  - Continuously monitor important signals and *create tasks* (not execute) so agents can work autonomously.
  - Keep external side-effects approval-gated (no emailing/posting without explicit instruction).

  Current signals (v1):
  - OpenClaw GitHub releases (new tag → create review task)

  Guardrails:
  - Dedup tasks by title
  - Rate limit per tick
  - Keep state in sentinel-loop.state.json
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';
const ROOM_ID = process.env.BREAKROOM_ID || 'breakroom';

const { xaiChat } = require('./xai-client.cjs');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'mc.db');
const STATE_PATH = path.resolve(__dirname, 'sentinel-loop.state.json');

const POLL_MS = Number(process.env.SENTINEL_POLL_MS || 60 * 60_000); // 1h
const MAX_CREATE_PER_TICK = Number(process.env.SENTINEL_MAX_CREATE_PER_TICK || 3);

const OPENCLAW_REPO = process.env.SENTINEL_OPENCLAW_REPO || 'openclaw/openclaw';

function nowMs(){ return Date.now(); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function nanoid(n=10){ return crypto.randomBytes(Math.ceil(n*0.75)).toString('base64url').slice(0,n); }

function readState(){
  try { return JSON.parse(fs.readFileSync(STATE_PATH,'utf8')); }
  catch { return { lastTickAt: 0, seen: { releases: {} } }; }
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
    msg: `Sentinel: created task “${title}”`
  });

  return id;
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

function ghJson(args){
  const GH = process.env.GH_BIN || 'gh';
  const out = execFileSync(GH, args, { encoding:'utf8', stdio:['ignore','pipe','pipe'] });
  return out;
}

function checkOpenClawReleases(st, outTasks){
  const key = `releases:${OPENCLAW_REPO}`;
  st.seen.releases ||= {};
  const lastTag = st.seen.releases[key] || null;

  let newest = null;
  try {
    // newest first
    const out = ghJson(['release','list','-R',OPENCLAW_REPO,'-L','1']);
    // Example:
    // openclaw 2026.2.3\tLatest\tv2026.2.3\t2026-02-05T01:57:22Z
    const line = String(out).trim().split('\n')[0] || '';
    const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
    // Find the tag column (starts with v)
    newest = parts.find(p => /^v\d/.test(p)) || null;
  } catch (e) {
    outTasks.push({
      title: 'Fix: GitHub auth/gh CLI required for Sentinel monitoring',
      priority: 3,
      description: `Sentinel failed running: gh release list -R ${OPENCLAW_REPO}. Error: ${String(e.message||e).slice(0,300)}`
    });
    return;
  }

  if (!newest) return;
  if (lastTag && newest === lastTag) return;

  // Update seen immediately to avoid repeats
  st.seen.releases[key] = newest;

  outTasks.push({
    title: `Review OpenClaw release ${newest}`,
    priority: 2,
    description: `New release detected on GitHub (${OPENCLAW_REPO}). Review changelog, assess impact, schedule update within maintenance window (02:00–05:00 Europe/London).`
  });
}

async function tick(){
  const st = readState();
  st.seen ||= {};
  st.seen.daily ||= {};

  const db = new Database(DB_PATH);
  try {
    const toCreate = [];
    checkOpenClawReleases(st, toCreate);

    // Daily OpenClaw scan + digest (GitHub signals → summarized by xAI)
    const day = new Date().toISOString().slice(0,10);
    if (st.seen.daily.openclawDigestDay !== day) {
      try {
        const sinceIso = new Date(Date.now() - 24*60*60*1000).toISOString().slice(0,10);

        const releases = String(ghJson(['release','list','-R',OPENCLAW_REPO,'-L','10'])).trim();
        const prs = String(ghJson(['api', `search/issues?q=repo:${OPENCLAW_REPO}+is:pr+merged:>=${sinceIso}&sort=updated&order=desc&per_page=10`, '--jq', '.items[] | "- #\(.number) \(.title) (\(.html_url))"'])).trim();
        const issues = String(ghJson(['api', `search/issues?q=repo:${OPENCLAW_REPO}+is:issue+updated:>=${sinceIso}&sort=updated&order=desc&per_page=10`, '--jq', '.items[] | "- #\(.number) \(.title) (\(.html_url))"'])).trim();

        const raw = [
          `Repo: ${OPENCLAW_REPO}`,
          `Window: last 24h (since ${sinceIso})`,
          '',
          'Releases (latest 10):',
          releases || '(none)',
          '',
          'Merged PRs / updated PRs:',
          prs || '(none)',
          '',
          'Updated issues:',
          issues || '(none)',
        ].join('\n');

        const messages = [
          { role: 'system', content: 'You are an operator assistant. Produce concise daily digests for an engineer/operator.' },
          { role: 'user', content: `From the signals below, write an OpenClaw daily digest with 8-12 bullets. Each bullet should be actionable and include a link when available. Avoid fluff.\n\n${raw}` }
        ];

        const { content } = await xaiChat({ messages, model: 'grok-4-latest', temperature: 0.2 });
        if (content) {
          await postToRoom('prometheus', `🗞️ OpenClaw daily digest (${day})\n\n${content}`);
          st.seen.daily.openclawDigestDay = day;
          console.log('[sentinel] posted daily digest');
        }
      } catch (e) {
        toCreate.push({
          title: 'Fix: Sentinel daily digest failed',
          priority: 3,
          description: `Sentinel failed generating/posting OpenClaw digest: ${String(e.message||e).slice(0,400)}`
        });
      }
    }

    let created = 0;
    for (const t of toCreate) {
      if (created >= MAX_CREATE_PER_TICK) break;
      if (taskExistsByTitle(db, t.title)) continue;
      insertTask(db, t);
      created++;
      console.log('[sentinel] created', t.title);
    }

    st.lastTickAt = nowMs();
    writeState(st);

  } finally {
    try { db.close(); } catch {}
  }
}

async function main(){
  console.log(`Sentinel loop running. poll=${POLL_MS}ms repo=${OPENCLAW_REPO}`);
  const st = readState();
  writeState(st);

  while(true){
    try { await tick(); }
    catch(e){ console.log('[sentinel] tick failed:', e?.message||String(e)); }
    await sleep(POLL_MS);
  }
}

main();
