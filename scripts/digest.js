#!/usr/bin/env node
/*
  Daily digest generator (private output to Chris).

  IMPORTANT: Repo is public. Do NOT print or persist raw task descriptions/emails in git.
  This script reads local SQLite DBs and outputs a short operator digest.
*/

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DASH_DIR = process.cwd();
const DB_PATH = process.env.MC_DB_PATH || path.resolve(DASH_DIR, 'mc.db');
const MEM_DB_PATH = process.env.MEM_DB_PATH || path.resolve(DASH_DIR, 'memory', 'memory.db');

function nowMs() { return Date.now(); }
function startOfLocalDayMs(tz = 'Europe/London') {
  const d = new Date();
  // get YYYY-MM-DD in tz
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
  const y = Number(parts.find(p=>p.type==='year')?.value);
  const m = Number(parts.find(p=>p.type==='month')?.value);
  const day = Number(parts.find(p=>p.type==='day')?.value);
  // midnight in tz approximated by constructing UTC then offsetting via format (good enough for daily digest)
  const utc = Date.UTC(y, m-1, day, 0, 0, 0);
  return utc;
}

function safeTitle(t) {
  // Title is allowed to show to Chris in Telegram. Keep short.
  return String(t || '').replace(/\s+/g,' ').trim().slice(0, 120);
}

function main() {
  const tz = process.env.TZ || 'Europe/London';
  const since = startOfLocalDayMs(tz);

  const db = new Database(DB_PATH, { readonly: true });

  const shipped = db.prepare(`
    SELECT id, title, updated_at
    FROM tasks
    WHERE status='done' AND updated_at >= ?
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(since);

  const inProg = db.prepare(`
    SELECT t.id, t.title, t.status, t.updated_at, t.priority
    FROM tasks t
    WHERE t.status IN ('in_progress','assigned','review')
    ORDER BY t.priority DESC, t.updated_at ASC
    LIMIT 12
  `).all();

  const staleMs = Number(process.env.DIGEST_STALE_MS || (60*60*1000));
  const stale = db.prepare(`
    SELECT id, title, status, updated_at, priority
    FROM tasks
    WHERE status IN ('assigned','in_progress') AND updated_at < ?
    ORDER BY updated_at ASC
    LIMIT 10
  `).all(nowMs() - staleMs);

  const mentionQ = (() => {
    try {
      const row = db.prepare(`SELECT count(*) as c FROM mention_queue WHERE status IN ('queued','processing','error')`).get();
      return Number(row?.c||0);
    } catch { return null; }
  })();

  db.close();

  // Memory bank counts
  let mem = { drafts: null, questions: null };
  try {
    if (fs.existsSync(MEM_DB_PATH)) {
      const mdb = new Database(MEM_DB_PATH, { readonly: true });
      try {
        const d = mdb.prepare(`SELECT count(*) as c FROM memory_items WHERE bank='draft' AND status='pending'`).get();
        mem.drafts = Number(d?.c||0);
      } catch {}
      try {
        const q = mdb.prepare(`SELECT count(*) as c FROM memory_questions WHERE status='open'`).get();
        mem.questions = Number(q?.c||0);
      } catch {}
      mdb.close();
    }
  } catch {}

  // Inbox pressure (GOG sentinel)
  let emailPressure = null;
  try {
    const p = path.resolve(DASH_DIR, 'gog-sentinel.state.json');
    if (fs.existsSync(p)) {
      const st = JSON.parse(fs.readFileSync(p,'utf8'));
      emailPressure = {
        pendingSends: Array.isArray(st.pendingSends) ? st.pendingSends.length : null,
        lastRunAt: st.lastRunAt || null,
      };
    }
  } catch {}

  const lines = [];
  lines.push(`Evening digest (quick, no bullshit)`);
  lines.push('');

  lines.push(`- Shipped today: ${shipped.length ? shipped.map(t=>`• ${safeTitle(t.title)}`).join('\n  ') : '—'}`);
  lines.push('');

  lines.push(`- In progress:`);
  if (!inProg.length) lines.push('  —');
  else for (const t of inProg) lines.push(`  • [${t.priority}] ${safeTitle(t.title)} (${t.status || '—'})`);
  lines.push('');

  lines.push(`- Broken/risk:`);
  if (!stale.length && !mentionQ) lines.push('  —');
  if (stale.length) {
    for (const t of stale) lines.push(`  • STALE ${t.status} ${Math.round((nowMs()-t.updated_at)/60000)}m: ${safeTitle(t.title)}`);
  }
  if (mentionQ != null) lines.push(`  • mention_queue pending: ${mentionQ}`);
  lines.push('');

  lines.push(`- Inbox pressure (email/calendar):`);
  if (!emailPressure) lines.push('  —');
  else {
    if (emailPressure.pendingSends != null) lines.push(`  • pending auto-sends: ${emailPressure.pendingSends}`);
  }
  lines.push('');

  lines.push(`- Memory bank (drafts/questions):`);
  lines.push(`  • drafts: ${mem.drafts ?? '—'} | open questions: ${mem.questions ?? '—'}`);
  lines.push('');

  // Next moves: pick the 3 oldest stale/inprogress
  const next = stale.slice(0,3);
  lines.push(`- Next 3 moves:`);
  if (!next.length) lines.push('  —');
  else for (const t of next) lines.push(`  • unblock: ${safeTitle(t.title)}`);

  process.stdout.write(lines.join('\n') + '\n');
}

main();
