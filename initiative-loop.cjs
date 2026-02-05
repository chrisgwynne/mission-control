#!/usr/bin/env node
/*
  Mission Control — Initiative Loop

  Purpose:
  - Keep the board alive by proactively creating *useful* Inbox tasks when there is no work.
  - Conservative + deduped: never flood.

  Model:
  - When open-task inventory is low, create a few tasks from a curated pool and from live signals.
  - Leave tasks unassigned; Zeus will assign per workflow rules.

  Guardrails:
  - Cap tasks/day
  - Cap tasks/tick
  - Do not create when backlog already healthy
  - Dedupe by exact title

  All contained in /home/chris/.openclaw/workspace/dashboard/
*/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'mc.db');
const STATE_PATH = path.resolve(__dirname, 'initiative-loop.state.json');

const POLL_MS = Number(process.env.INITIATIVE_POLL_MS || 5 * 60_000);

const MIN_OPEN_TARGET = Number(process.env.INITIATIVE_MIN_OPEN_TARGET || 20); // if we have >= this many open tasks, don't create
const MAX_CREATE_PER_TICK = Number(process.env.INITIATIVE_MAX_CREATE_PER_TICK || 3);
const MAX_CREATE_PER_DAY = Number(process.env.INITIATIVE_MAX_CREATE_PER_DAY || 12);

const DEFAULT_PRIORITY = Number(process.env.INITIATIVE_DEFAULT_PRIORITY || 2);

const OPEN_STATUSES = new Set(['inbox', 'assigned', 'in_progress', 'review']);

function nowMs() { return Date.now(); }
function isoDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nanoid(n = 10) {
  // not cryptographically important; local id
  return crypto.randomBytes(Math.ceil(n * 0.75)).toString('base64url').slice(0, n);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { day: isoDay(), createdToday: 0, lastTickAt: 0, recentlyCreatedTitles: [] };
  }
}

function writeState(st) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

function resetDayIfNeeded(st) {
  const d = isoDay();
  if (st.day !== d) {
    st.day = d;
    st.createdToday = 0;
    st.recentlyCreatedTitles = [];
  }
}

function openTaskCount(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
  let n = 0;
  for (const r of rows) {
    if (OPEN_STATUSES.has(String(r.status))) n += Number(r.n || 0);
  }
  return n;
}

function taskExistsByTitle(db, title) {
  const row = db.prepare('SELECT id FROM tasks WHERE title=? LIMIT 1').get(title);
  return !!row;
}

function insertTask(db, { title, description, priority = DEFAULT_PRIORITY }) {
  const ts = nowMs();
  const id = nanoid(10);

  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at, needs_approval, checklist)
    VALUES (@id, @title, @description, 'inbox', @priority, @ts, @ts, 0, '')
  `).run({ id, title, description: description || '', priority, ts });

  db.prepare(`
    INSERT INTO activities (id, created_at, type, agent_id, task_id, message)
    VALUES (@aid, @ts, 'task_created', 'hermes', @taskId, @msg)
  `).run({
    aid: 'act_' + nanoid(10),
    ts,
    taskId: id,
    msg: `Initiative: created task “${title}”`
  });

  return id;
}

async function fetchOpenMemoryQuestions(hostname = '127.0.0.1') {
  try {
    const res = await fetch(`http://${hostname}:3000/api/questions?status=open&limit=200`, { cache: 'no-store' });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.rows) ? j.rows : [];
  } catch {
    return [];
  }
}

function curatedPool({ hasQuestions = false, questionSample = null } = {}) {
  const items = [
    {
      title: 'Fix: Task ordering should be new → old within each column',
      priority: 3,
      description: 'User request: each status column ordered newest-first. Verify drag/drop unaffected. Suggested assignee: Artemis.'
    },
    {
      title: 'Fix: OpenClaw browser control service timeout (15s)',
      priority: 4,
      description: 'Investigate “Can\'t reach the openclaw browser control service (timed out after 15000ms)”. Add health probe + remediation. Suggested assignee: Hermes.'
    },
    {
      title: 'Improve: Agent modal “Done” tab should only show OUTCOME/COMPLETION SUMMARY',
      priority: 2,
      description: 'Filter to outcome-only items; reduce noise; keep it scannable. Suggested assignee: Artemis.'
    },
    {
      title: 'Implement: Better dashboard search (FTS5 + UI)',
      priority: 2,
      description: 'Upgrade search experience beyond current behavior: highlight, filters, fast keyboard. Suggested assignee: Apollo + Artemis.'
    },
    {
      title: 'Mobile-ready Mission Control dashboard',
      priority: 2,
      description: 'Make Kanban + drawers responsive and usable on mobile. Suggested assignee: Artemis.'
    },
    {
      title: 'Breakroom: tune “alive mode” so agents talk naturally without spam',
      priority: 2,
      description: 'Adjust chain length, unsolicited interval, spark cadence. Add topic rotation and per-agent personalities. Suggested assignee: Hermes + Prometheus.'
    },
    {
      title: 'Memory Bank: improve question quality (fewer generic, more actionable)',
      priority: 2,
      description: 'Improve reflection question generator: dedupe, avoid repetition, ask about true unknowns. Suggested assignee: Prometheus.'
    },
    {
      title: 'Ops: add “Autonomy inventory” — what signals we watch and why',
      priority: 1,
      description: 'Document what feeds create tasks (emails, calendar, GitHub, errors). Make it auditable + editable. Suggested assignee: Zeus.'
    },
  ];

  if (hasQuestions && questionSample) {
    items.unshift({
      title: 'Memory Bank: answer open reflection questions (seed learning)',
      priority: 2,
      description: `There are open reflection questions to answer. Example: “${String(questionSample).slice(0, 120)}”. Suggested assignee: Jarvis/Chris.`
    });
  }

  return items;
}

function pickCandidates(db, st, dynamic) {
  const pool = curatedPool(dynamic);

  // Filter out tasks that already exist
  const candidates = pool.filter(t => !taskExistsByTitle(db, t.title));

  // Also avoid repeating recently created titles (state-level dedupe)
  const recent = new Set((st.recentlyCreatedTitles || []).map(String));
  return candidates.filter(t => !recent.has(t.title));
}

async function tick() {
  const st = readState();
  resetDayIfNeeded(st);

  const db = new Database(DB_PATH);
  try {
    const open = openTaskCount(db);
    if (open >= MIN_OPEN_TARGET) return;

    if (st.createdToday >= MAX_CREATE_PER_DAY) return;

    const host = process.env.MEMORY_HOST || '127.0.0.1';
    const qs = await fetchOpenMemoryQuestions(host);

    const dynamic = {
      hasQuestions: qs.length > 0,
      questionSample: qs[0]?.question || null,
    };

    const candidates = pickCandidates(db, st, dynamic);
    if (!candidates.length) return;

    const budget = Math.min(MAX_CREATE_PER_TICK, MAX_CREATE_PER_DAY - st.createdToday);
    let made = 0;

    for (const c of candidates.slice(0, budget)) {
      const id = insertTask(db, c);
      st.createdToday++;
      st.recentlyCreatedTitles = [c.title, ...(st.recentlyCreatedTitles || [])].slice(0, 50);
      made++;
      console.log(`[initiative] created ${id} ${c.title}`);
    }

    if (made) writeState(st);

  } finally {
    try { db.close(); } catch {}
  }
}

async function main() {
  console.log(`Initiative loop running. poll=${POLL_MS}ms minOpenTarget=${MIN_OPEN_TARGET} max/day=${MAX_CREATE_PER_DAY}`);

  // ensure state exists
  const st = readState();
  resetDayIfNeeded(st);
  writeState(st);

  while (true) {
    try {
      await tick();
    } catch (e) {
      console.log('[initiative] tick failed:', e?.message || String(e));
    }
    await sleep(POLL_MS);
  }
}

main();
