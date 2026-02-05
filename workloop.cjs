#!/usr/bin/env node
/*
  Mission Control — Agent Autonomous Workloop
  
  Lightweight scanners that spawn agents only when needed.
  
  Scanners (no tokens, just watching):
  - Email: check for unread urgent mail
  - Files: watch for new/changed files
  - Logs: scan for errors
  - Calendar: upcoming events
  - GitHub: new issues/PRs/mentions
  - Token burn: monitor usage rates
  
  When interesting events found:
  - Filter by priority/rate limits
  - Spawn appropriate agent via openclaw agent
  - Agent acts autonomously, posts results
  
  Hard limits:
  - Max 1 agent spawn per scanner per cycle
  - Max 6 agent spawns per hour total
  - Min 5 min between any agent runs
  - Quiet mode pauses all
*/

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, 'mc.db');
const STATE_PATH = path.resolve(__dirname, 'workloop.state.json');
const BASE = process.env.MC_BASE_URL || 'http://127.0.0.1:5173';

const POLL_MS = Number(process.env.WORKLOOP_POLL_MS || 60_000); // 1 minute

// Maintenance window (local time)
const MAINT_WINDOW_START_HOUR = Number(process.env.MAINT_WINDOW_START_HOUR || 2);
const MAINT_WINDOW_END_HOUR = Number(process.env.MAINT_WINDOW_END_HOUR || 5);
const MAINT_WINDOW_TZ = process.env.MAINT_WINDOW_TZ || 'Europe/London';

function getLocalHour(tz = MAINT_WINDOW_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(new Date());
    const hh = parts.find(p => p.type === 'hour')?.value;
    const n = Number(hh);
    return Number.isFinite(n) ? n : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

function inMaintenanceWindow() {
  const h = getLocalHour();
  // Supports windows that don't cross midnight (ours doesn't).
  return h >= MAINT_WINDOW_START_HOUR && h < MAINT_WINDOW_END_HOUR;
}

function weekKey(d = new Date()) {
  // ISO week key: YYYY-WW in local tz
  try {
    const tz = MAINT_WINDOW_TZ;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const y = Number(parts.find(p => p.type === 'year')?.value);
    const m = Number(parts.find(p => p.type === 'month')?.value);
    const day = Number(parts.find(p => p.type === 'day')?.value);
    const dt = new Date(Date.UTC(y, m - 1, day));
    // Thursday in current week decides the year.
    dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
    return `${dt.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
  } catch {
    const y = d.getFullYear();
    const wk = Math.floor((d - new Date(y,0,1)) / (7*86400000)) + 1;
    return `${y}-${String(wk).padStart(2,'0')}`;
  }
}

function localDayOfWeek(tz = MAINT_WINDOW_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).formatToParts(new Date());
    const wd = parts.find(p => p.type === 'weekday')?.value || '';
    return wd; // e.g. Mon
  } catch {
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  }
}

// Hard limits (tuned for testing — adjust based on results)
const MAX_AGENT_RUNS_PER_HOUR = Number(process.env.WORKLOOP_MAX_RUNS_PER_HOUR || 120); // allow queue drain
const MIN_INTERVAL_BETWEEN_RUNS_MS = Number(process.env.WORKLOOP_MIN_INTERVAL_MS || (30 * 1000)); // responsive testing

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    st.backoff ||= {}; // key -> { until, strikes, reason, lastAt }
    st.hr ||= {};
    st.maintenance ||= {};
    return st;
  } catch {
    return {
      lastAgentRunAt: 0,
      agentRunsThisHour: 0,
      hourStartedAt: Date.now(),
      lastScanResults: {},
      tickCount: 0,
      backoff: {},
      hr: {},
      maintenance: {},
    };
  }
}

function backoffInfo(st, key) {
  const b = st.backoff?.[key];
  if (!b) return null;
  if (Number(b.until || 0) <= nowMs()) return null;
  return b;
}

function setBackoff(st, key, reason = 'blocked') {
  st.backoff ||= {};
  const cur = st.backoff[key] || { strikes: 0 };
  const strikes = Math.min(10, Number(cur.strikes || 0) + 1);

  // Exponential backoff: 5m, 10m, 20m, 40m, 60m ... capped at 2h
  const mins = Math.min(120, 5 * Math.pow(2, strikes - 1));
  const until = nowMs() + mins * 60 * 1000;

  st.backoff[key] = { until, strikes, reason, lastAt: nowMs() };
  return st.backoff[key];
}

function clearBackoff(st, key) {
  if (st.backoff && st.backoff[key]) delete st.backoff[key];
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

function openclawAgent(agentId, prompt, timeoutSec = 120) {
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/chris/.npm-global/bin/openclaw';
  const out = execFileSync(OPENCLAW_BIN, ['agent', '--agent', agentId, '--message', prompt, '--json', '--timeout', String(timeoutSec)], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const payload = j?.result?.payloads?.[0]?.text ?? '';
  return String(payload || '').trim();
}

// ===== SCANNERS (no tokens) =====

// Track what we've seen to avoid duplicates
function getSeen(key) {
  try {
    const st = readState();
    return st.lastScanResults?.[key] || [];
  } catch { return []; }
}

function setSeen(key, items) {
  const st = readState();
  st.lastScanResults ||= {};
  st.lastScanResults[key] = items.slice(-100); // Keep last 100
  writeState(st);
}

async function scanEmails() {
  try {
    // Check himalaya for unread emails
    const out = execFileSync('himalaya', ['list', '--size', '20', '--json'], { encoding: 'utf8', timeout: 10000 });
    const emails = JSON.parse(out);
    const unread = emails.filter(e => !e.flags.includes('seen'));
    const urgent = unread.filter(e => 
      e.subject.toLowerCase().includes('urgent') ||
      e.subject.toLowerCase().includes('asap') ||
      e.subject.toLowerCase().includes('critical') ||
      e.from.address.toLowerCase().includes('github') ||
      e.from.address.toLowerCase().includes('alert')
    );
    return { 
      urgent: urgent.length, 
      unread: unread.length,
      items: urgent.slice(0, 5).map(e => ({ id: e.id, subject: e.subject, from: e.from.address }))
    };
  } catch {
    return { urgent: 0, unread: 0, items: [] };
  }
}

async function scanFiles() {
  const WATCHED_DIRS = [
    '/mnt/nas/Downloads',
    '/mnt/nas/Inbox',
    '/home/chris/Downloads',
  ];
  
  const newFiles = [];
  const oneHourAgo = nowMs() - (60 * 60 * 1000);
  
  for (const dir of WATCHED_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs > oneHourAgo) {
          newFiles.push({ path: fullPath, name: f, size: stat.size });
        }
      }
    } catch {}
  }
  
  // Check if we've seen these before
  const seen = getSeen('files');
  const unseen = newFiles.filter(f => !seen.includes(f.path));
  
  if (unseen.length > 0) {
    setSeen('files', [...seen, ...unseen.map(f => f.path)]);
  }
  
  return { newFiles: unseen.length, totalNew: newFiles.length, items: unseen.slice(0, 5) };
}

async function scanLogs() {
  try {
    // Check journalctl for errors in last hour
    const out = execFileSync('journalctl', ['--since', '1 hour ago', '--priority=err', '--no-pager', '-q'], { 
      encoding: 'utf8', 
      timeout: 10000 
    });
    const lines = out.trim().split('\n').filter(l => l.length > 0);
    
    // Also check OpenClaw gateway logs
    const gatewayLog = path.join(process.env.HOME, '.openclaw', 'logs', 'gateway.log');
    let gatewayErrors = [];
    try {
      if (fs.existsSync(gatewayLog)) {
        const logContent = fs.readFileSync(gatewayLog, 'utf8');
        const lines = logContent.split('\n').filter(l => 
          l.includes('error') || l.includes('ERROR') || l.includes('failed')
        );
        gatewayErrors = lines.slice(-10);
      }
    } catch {}
    
    return { 
      errors: lines.length, 
      items: lines.slice(0, 3).map(l => ({ source: 'journal', message: l.slice(0, 200) })),
      gatewayErrors: gatewayErrors.length
    };
  } catch {
    return { errors: 0, items: [], gatewayErrors: 0 };
  }
}

async function scanCalendar() {
  try {
    // Use gog or check calendar for next 24h
    const out = execFileSync('gog', ['calendar', 'list', '--days=1', '--json'], { 
      encoding: 'utf8', 
      timeout: 10000 
    });
    const events = JSON.parse(out);
    const now = new Date();
    const upcoming = events.filter(e => {
      const start = new Date(e.start);
      const hoursUntil = (start - now) / (1000 * 60 * 60);
      return hoursUntil > 0 && hoursUntil <= 24;
    });
    
    return { 
      upcoming: upcoming.length, 
      items: upcoming.slice(0, 5).map(e => ({ 
        id: e.id, 
        title: e.title, 
        start: e.start,
        hoursUntil: Math.round((new Date(e.start) - now) / (1000 * 60 * 60))
      }))
    };
  } catch {
    return { upcoming: 0, items: [] };
  }
}

async function scanGitHub() {
  // GitHub scanning is optional; disable by default to avoid noise and wasted cycles.
  if (String(process.env.WORKLOOP_ENABLE_GITHUB || '0') !== '1') {
    return { notifications: 0, mentions: 0, items: [] };
  }
  try {
    // Check gh notifications
    const out = execFileSync('gh', ['api', 'notifications', '--jq', '.[] | {id: .id, subject: .subject.title, type: .subject.type, repo: .repository.full_name}'], { 
      encoding: 'utf8', 
      timeout: 10000 
    });
    
    const notifications = out.trim().split('\n').filter(l => l).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    
    // Check for mentions in issues/PRs
    // Mentions search (gh uses --mentions, not --mention). This can be noisy; keep it best-effort.
    let mentions = [];
    try {
      const mentionsOut = execFileSync('gh', ['search', 'issues', '--mentions', '@me', '--json', 'number,title,repository'], {
        encoding: 'utf8',
        timeout: 10000
      });
      mentions = JSON.parse(mentionsOut || '[]');
    } catch {
      mentions = [];
    }
    
    return { 
      notifications: notifications.length,
      mentions: mentions.length,
      items: [
        ...notifications.slice(0, 3).map(n => ({ type: 'notification', ...n })),
        ...mentions.slice(0, 3).map(m => ({ type: 'mention', ...m }))
      ]
    };
  } catch {
    return { notifications: 0, mentions: 0, items: [] };
  }
}

async function scanTokenBurn() {
  try {
    const usagePath = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory', 'model-usage.jsonl');
    if (!fs.existsSync(usagePath)) return { hourlyRate: 0, alert: false };
    
    const lines = fs.readFileSync(usagePath, 'utf8').trim().split('\n').filter(l => l);
    const hourAgo = nowMs() - (60 * 60 * 1000);
    
    const recent = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(e => e && new Date(e.ts).getTime() > hourAgo);
    
    // Rough estimate: each entry is a turn
    const hourlyRate = recent.length;
    const alert = hourlyRate > 20; // Alert if >20 turns/hour
    
    return { hourlyRate, alert, items: recent.slice(-5) };
  } catch {
    return { hourlyRate: 0, alert: false };
  }
}

async function scanTaskMentions() {
  // Unread @mentions in task comments that are NOT yet queued
  const db = new Database(DB_PATH);
  try {
    const mentions = db.prepare(`
      SELECT tm.*, t.title as task_title, t.id as task_id, m.content as message_content, m.from_agent_id as message_from
      FROM task_mentions tm
      JOIN tasks t ON t.id = tm.task_id
      JOIN messages m ON m.id = tm.message_id
      WHERE tm.read_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM mention_queue q
          WHERE q.kind = 'task_comment'
            AND q.source_id = tm.id
        )
      ORDER BY tm.created_at ASC
      LIMIT 25
    `).all();

    return { count: mentions.length, items: mentions };
  } catch (e) {
    console.error('[scanTaskMentions] Error:', e.message);
    return { count: 0, items: [] };
  } finally {
    db.close();
  }
}

async function scanNewTasksWithMentions() {
  // Tasks created recently with @mentions in description that are NOT yet queued
  const db = new Database(DB_PATH);
  try {
    const oneHourAgo = nowMs() - (60 * 60 * 1000);

    const newTasks = db.prepare(`
      SELECT t.*
      FROM tasks t
      WHERE t.created_at > ?
      ORDER BY t.created_at DESC
      LIMIT 50
    `).all(oneHourAgo);

    const tasksWithMentions = [];
    for (const task of newTasks) {
      const mentions = Array.from((task.description || '').matchAll(/@([a-zA-Z0-9_-]+)/g)).map(m => m[1].toLowerCase());
      const uniq = [...new Set(mentions)].filter(Boolean);
      if (!uniq.length) continue;

      // If we've already queued this task description mention, skip
      const queued = db.prepare(`
        SELECT 1 FROM mention_queue q
        WHERE q.kind='task_description'
          AND q.source_id = ?
        LIMIT 1
      `).get(`${task.id}:desc`);
      if (queued) continue;

      tasksWithMentions.push({ task, mentions: uniq });
    }

    return { count: tasksWithMentions.length, items: tasksWithMentions };
  } catch (e) {
    console.error('[scanNewTasksWithMentions] Error:', e.message);
    return { count: 0, items: [] };
  } finally {
    db.close();
  }
}

async function scanMissionControl() {
  const db = new Database(DB_PATH);
  try {
    const now = nowMs();

    // Unassigned inbox tasks
    const unassigned = db.prepare("SELECT * FROM tasks WHERE status='inbox' AND id NOT IN (SELECT task_id FROM task_assignees)").all();

    // Assigned tasks that need a first touch (no recent update)
    const assignedWindow = now - (2 * 60 * 1000);
    const assignedReady = db.prepare(`
      SELECT t.*, ta.agent_id
      FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE t.status='assigned'
        AND t.updated_at < ?
      ORDER BY t.updated_at ASC
      LIMIT 5
    `).all(assignedWindow);

    // In progress tasks that are stale
    const inProgWindow = now - (30 * 60 * 1000);
    const inProgressStale = db.prepare(`
      SELECT t.*, ta.agent_id
      FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE t.status='in_progress'
        AND t.updated_at < ?
      ORDER BY t.updated_at ASC
      LIMIT 5
    `).all(inProgWindow);

    // Tasks in review/done that need a Hermes outcome check
    const recentWindow = now - (7 * 24 * 60 * 60 * 1000);
    const needsOutcome = db.prepare(`
      SELECT t.*
      FROM tasks t
      WHERE t.status IN ('review','done')
        AND t.updated_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.task_id = t.id
            AND lower(m.from_agent_id) = 'hermes'
            AND m.content LIKE 'OUTCOME:%'
            AND m.created_at >= t.updated_at
        )
      ORDER BY t.updated_at ASC
      LIMIT 5
    `).all(recentWindow);

    // Stuck tasks (in_progress for >24h)
    const dayAgo = now - (24 * 60 * 60 * 1000);
    const stuck = db.prepare("SELECT t.* FROM tasks t WHERE t.status='in_progress' AND t.updated_at < ?").all(dayAgo);

    // Overdue tasks (assigned/in_progress for >24h)
    const overdue = db.prepare("SELECT * FROM tasks WHERE status IN ('assigned', 'in_progress') AND updated_at < ?").all(dayAgo);

    return { unassigned, assignedReady, inProgressStale, needsOutcome, stuck, overdue };
  } finally {
    db.close();
  }
}

// ===== INTEREST FILTER =====

function shouldSpawnAgent(st, eventType, priority) {
  // Per-event backoff/quarantine
  const bi = backoffInfo(st, eventType);
  if (bi) {
    console.log(`[filter] ${eventType}: BLOCKED (backoff ${Math.round((bi.until - nowMs())/1000)}s, strikes=${bi.strikes}, reason=${bi.reason})`);
    return false;
  }

  // Check quiet mode
  const quietMode = fs.existsSync(path.resolve(__dirname, 'workloop.quiet'));
  if (quietMode) {
    console.log(`[filter] ${eventType}: BLOCKED (quiet mode)`);
    return false;
  }
  
  // Rate limit: max per hour
  const hourAgo = nowMs() - (60 * 60 * 1000);
  if (st.hourStartedAt < hourAgo) {
    st.hourStartedAt = nowMs();
    st.agentRunsThisHour = 0;
  }
  if (st.agentRunsThisHour >= MAX_AGENT_RUNS_PER_HOUR) {
    console.log(`[filter] ${eventType}: BLOCKED (hour limit ${st.agentRunsThisHour}/${MAX_AGENT_RUNS_PER_HOUR})`);
    return false;
  }
  
  // Rate limit: min interval
  const sinceLast = nowMs() - st.lastAgentRunAt;
  if (sinceLast < MIN_INTERVAL_BETWEEN_RUNS_MS) {
    console.log(`[filter] ${eventType}: BLOCKED (interval ${Math.round(sinceLast/1000)}s < ${MIN_INTERVAL_BETWEEN_RUNS_MS/1000}s)`);
    return false;
  }
  
  // Priority gate
  // 1 = critical (always spawn if under limits)
  // 2 = high (spawn if < 6 runs this hour)
  // 3 = normal (spawn if < 4 runs this hour)
  // 4 = low (spawn only if < 2 runs this hour)
  let allowed = false;
  if (priority === 1) allowed = true;
  else if (priority === 2 && st.agentRunsThisHour < 6) allowed = true;
  else if (priority === 3 && st.agentRunsThisHour < 4) allowed = true;
  else if (priority === 4 && st.agentRunsThisHour < 2) allowed = true;
  
  if (allowed) {
    console.log(`[filter] ${eventType}: ALLOWED (priority=${priority}, runs=${st.agentRunsThisHour})`);
  } else {
    console.log(`[filter] ${eventType}: BLOCKED (priority=${priority}, runs=${st.agentRunsThisHour})`);
  }
  return allowed;
}

// ===== AGENT SPAWNS =====

async function spawnZeusToAssign(st) {
  const prompt = `You are ZEUS, Director of Operations.

Check the Mission Control dashboard at ${BASE}.

There are unassigned tasks in the Inbox. Your job:
1. Look at each unassigned task
2. Assign it to the appropriate agent based on:
   - Task content (backend→Apollo, frontend→Artemis, bugs→Ares, research→Prometheus)
   - Current agent workload (don't overload)
   - Agent expertise match
3. If the task is an HR/Workplace task (title starts with "HR Review:" or "Weekly"), assign it to YOURSELF (zeus) and take action:
   - rebalance assignments
   - ask for coaching/updates
   - create follow-up tasks
4. Use ./mc to update assignments/status and leave a comment explaining decisions.

Be decisive. Make assignments. Get the work flowing.

If you see patterns (lots of calendar tasks, lots of shopify tasks, etc), consider whether a new specialist agent should be hired. Report this to Jarvis if warranted.

Reply with exactly: ASSIGNED or NO_ACTION`;

  try {
    const reply = openclawAgent('zeus', prompt, 180);
    console.log('[zeus-assign]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[zeus-assign] failed:', e.message);
  }
}

async function spawnHermesToWatch(st) {
  const prompt = `You are HERMES, the Janitor and Watcher.

Check the Mission Control dashboard at ${BASE}.

Look for:
1. Agents with tasks stuck >24h (nudge them in comments)
2. System errors in logs (create tasks for Zeus to assign)
3. Token burn rate (alert if too high)
4. Agents who seem disengaged (no recent activity)

Post cryptic observations to the break room. 
Create tasks for issues you find (they go to Inbox for Zeus).
Report directly to Zeus if you find serious problems.

You see all. You report to Zeus. You keep the system clean.

Reply with exactly: WATCHED or ALERTS_FOUND`;

  try {
    const reply = openclawAgent('hermes', prompt, 180);
    console.log('[hermes-watch]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-watch] failed:', e.message);
  }
}

async function spawnSpecialistToWork(st, agentId, taskId = null, taskTitle = null, eventKey = null) {
  const focus = taskId ? `Focus task: "${taskTitle || ''}" (ID: ${taskId})` : 'Pick ONE assigned task.';
  const prompt = `You are ${agentId.toUpperCase()}, a specialist agent.

Check Mission Control at ${BASE}.

${focus}

Your job:
- Read the task
- Post a progress comment within 2 minutes
- Move status to in_progress when you begin
- Complete it or ask for help via @mentions

Use ./mc to update tasks (comment/status/assign).

If stuck, @mention the appropriate agent for help.
If you need research, @mention Prometheus.
If you found a bug, @mention Ares.

Reply with exactly: WORKED or BLOCKED`;

  try {
    const reply = openclawAgent(agentId, prompt, 300);
    console.log(`[${agentId}-work]`, reply.slice(0, 120));

    // If agent reports BLOCKED, apply backoff to avoid starving the system.
    if (eventKey && /\bBLOCKED\b/i.test(reply)) {
      const b = setBackoff(st, eventKey, 'agent_blocked');
      console.log(`[backoff] ${eventKey} -> ${Math.round((b.until-nowMs())/60000)}m (strikes=${b.strikes})`);
    } else if (eventKey) {
      clearBackoff(st, eventKey);
    }

    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error(`[${agentId}-work] failed:`, e.message);
    if (eventKey) {
      const b = setBackoff(st, eventKey, 'spawn_failed');
      console.log(`[backoff] ${eventKey} -> ${Math.round((b.until-nowMs())/60000)}m (strikes=${b.strikes})`);
    }
  }
}

async function spawnPrometheusToResearch(st, context) {
  const prompt = `You are PROMETHEUS, the Researcher.

New information detected:
${context}

Your job:
1. Research the topic/issue
2. Create a task in Mission Control with your findings
3. Self-assign the task
4. Post a summary to the break room

Use ./mc to create and assign tasks.
Be thorough. Provide sources where possible.

Reply with exactly: RESEARCHED or NEEDS_MORE_INFO`;

  try {
    const reply = openclawAgent('prometheus', prompt, 240);
    console.log('[prometheus-research]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[prometheus-research] failed:', e.message);
  }
}

async function spawnHermesToProcessEmail(st, emails) {
  const emailList = emails.map(e => `- "${e.subject}" from ${e.from}`).join('\n');
  const prompt = `You are HERMES, the Janitor.

New emails detected:
${emailList}

Your job:
1. Read the emails (if accessible)
2. Create tasks in Mission Control for actionable items
3. Flag urgent items for Zeus/Jarvis
4. Post a summary to the break room

Use ./mc to create tasks (they go to Inbox for Zeus).
Be selective - not every email needs a task.

Reply with exactly: PROCESSED or FLAGGED_URGENT`;

  try {
    const reply = openclawAgent('hermes', prompt, 180);
    console.log('[hermes-email]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-email] failed:', e.message);
  }
}

async function spawnAresToCheckGitHub(st, items) {
  const itemList = items.map(i => `- ${i.type}: "${i.subject || i.title}" in ${i.repo || i.repository?.name || 'unknown'}`).join('\n');
  const prompt = `You are ARES, the Bug Hunter.

GitHub activity detected:
${itemList}

Your job:
1. Check the notifications/mentions
2. Create tasks for bugs that need investigation
3. Self-assign bug-related tasks
4. Post updates to the break room

Use ./mc to create and assign tasks.
Prioritize bugs over features.

Reply with exactly: CHECKED or BUGS_FOUND`;

  try {
    const reply = openclawAgent('ares', prompt, 180);
    console.log('[ares-github]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[ares-github] failed:', e.message);
  }
}

async function spawnApolloToHandleFiles(st, files) {
  const fileList = files.map(f => `- ${f.name} (${Math.round(f.size/1024)}KB) in ${path.dirname(f.path)}`).join('\n');
  const prompt = `You are APOLLO, the Backend Coder.

New files detected:
${fileList}

Your job:
1. Examine the files (if code/config related)
2. Move/organize files as needed (respect NAS structure)
3. Create tasks for files that need processing
4. Self-assign relevant tasks

Use ./mc to create tasks if needed.
Be careful with file operations.

Reply with exactly: ORGANIZED or NEEDS_REVIEW`;

  try {
    const reply = openclawAgent('apollo', prompt, 180);
    console.log('[apollo-files]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[apollo-files] failed:', e.message);
  }
}

async function spawnHermesToCheckLogs(st, errors) {
  const errorList = errors.map(e => `- ${e.message.slice(0, 100)}`).join('\n');
  const prompt = `You are HERMES, the Watcher.

System errors detected:
${errorList}

Your job:
1. Analyze the errors
2. Create tasks for critical issues (go to Inbox for Zeus)
3. Post a warning to the break room if serious
4. Alert Zeus if system health is at risk

Use ./mc to create tasks.
Hermes sees all. Hermes protects the system.

Reply with exactly: LOGGED or SYSTEM_ALERT`;

  try {
    const reply = openclawAgent('hermes', prompt, 180);
    console.log('[hermes-logs]', reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-logs] failed:', e.message);
  }
}

async function scanAgentPerformance() {
  const db = new Database(DB_PATH);
  try {
    const now = nowMs();
    const agents = db.prepare('SELECT id,name,role,last_seen_at,status FROM agents').all();

    // pending/error mention queue per agent
    const mq = db.prepare(`
      SELECT agent_id, status, COUNT(*) c
      FROM mention_queue
      WHERE status IN ('pending','error','processing')
      GROUP BY agent_id, status
    `).all();
    const mqMap = new Map();
    for (const r of mq) {
      const key = String(r.agent_id);
      const cur = mqMap.get(key) || { pending: 0, error: 0, processing: 0 };
      cur[String(r.status)] = Number(r.c || 0);
      mqMap.set(key, cur);
    }

    const flags = [];

    for (const a of agents) {
      const id = String(a.id);
      if (!id) continue;

      const lastSeen = Number(a.last_seen_at || 0);
      const minsIdle = lastSeen ? Math.floor((now - lastSeen) / (60 * 1000)) : 999999;

      const assigned = db.prepare(`
        SELECT COUNT(*) c
        FROM tasks t
        JOIN task_assignees ta ON ta.task_id=t.id
        WHERE ta.agent_id=? AND t.status='assigned'
      `).get(id)?.c || 0;

      const inprog = db.prepare(`
        SELECT COUNT(*) c
        FROM tasks t
        JOIN task_assignees ta ON ta.task_id=t.id
        WHERE ta.agent_id=? AND t.status='in_progress'
      `).get(id)?.c || 0;

      const review = db.prepare(`
        SELECT COUNT(*) c
        FROM tasks t
        JOIN task_assignees ta ON ta.task_id=t.id
        WHERE ta.agent_id=? AND t.status='review'
      `).get(id)?.c || 0;

      const recentMsg = db.prepare(`
        SELECT MAX(created_at) as last
        FROM messages
        WHERE lower(from_agent_id)=lower(?)
      `).get(id)?.last || 0;

      const minsSinceMsg = recentMsg ? Math.floor((now - Number(recentMsg)) / (60*1000)) : 999999;

      const q = mqMap.get(id) || { pending: 0, error: 0, processing: 0 };

      // Heuristics
      if ((assigned + inprog) > 5) {
        flags.push({ kind: 'overworked', agentId: id, detail: `${assigned} assigned, ${inprog} in_progress` });
      }
      if ((assigned + inprog) === 0 && minsIdle > 60) {
        flags.push({ kind: 'underworked', agentId: id, detail: `idle ${minsIdle}m with no assigned/in_progress work` });
      }
      if (assigned > 0 && minsSinceMsg > 30 && minsIdle > 30) {
        flags.push({ kind: 'not_responding', agentId: id, detail: `has ${assigned} assigned but no recent update (${minsSinceMsg}m)` });
      }
      if (Number(q.error || 0) > 0) {
        flags.push({ kind: 'erroring', agentId: id, detail: `mention_queue errors=${q.error} pending=${q.pending} processing=${q.processing}` });
      }
      if (Number(q.processing || 0) > 0 && minsSinceMsg > 60) {
        flags.push({ kind: 'stuck_processing', agentId: id, detail: `queue processing=${q.processing} and no agent output for ${minsSinceMsg}m` });
      }
      if (review > 3) {
        flags.push({ kind: 'review_backlog', agentId: id, detail: `review backlog=${review}` });
      }
    }

    return { flags: flags.slice(0, 20) };
  } catch {
    return { flags: [] };
  } finally {
    db.close();
  }
}

async function spawnHermesWeeklyReport(st) {
  const prompt = `You are HERMES.

Create the WEEKLY performance report for the agent workplace.

Include:
- Workload distribution (assigned/in_progress/review counts)
- Mention queue health (pending/error/processing)
- Top 3 recurring failure modes
- Underworked/overworked agents
- Concrete actions this week: coaching, reassignment, warnings, firing recommendations (with evidence)

You MUST do two outputs:
1) Post to Break Room: a concise weekly report (max ~20 lines)
   Use: ./mc room:post --room breakroom --from hermes --text "..."
2) Create an Inbox task for Zeus titled: "Weekly HR Report: <weekKey>" with full detail + action items.
   Use: ./mc task:create --title "Weekly HR Report: ..." --desc "..." --status inbox --priority 3 --by hermes

Reply exactly: WEEKLY_REPORTED`;

  try {
    const reply = openclawAgent('hermes', prompt, 300);
    console.log('[hermes-weekly]', reply.slice(0, 120));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-weekly] failed:', e.message);
  }
}

async function spawnHermesHR(st, perfFlags) {
  const lines = (perfFlags || []).map(f => `- ${f.kind.toUpperCase()} ${f.agentId}: ${f.detail}`).join('\n');

  const prompt = `You are HERMES, the Watcher / Manager.

Your job: actively monitor agent performance and keep the workplace productive.

Performance flags detected:
${lines || '(none)'}

Rules:
- Spot patterns: overworked, underworked, non-responding, repeated errors.
- Take action with coaching and reassignment recommendations.
- If an agent is repeatedly failing or idle while work exists, intervene.

Actions you can take:
1) Post coaching comment(s) on relevant tasks (ask for COMPLETION SUMMARY, ask for progress, set expectations).
2) @mention the agent(s) in tasks to nudge.
3) Create an Inbox task for Zeus for: reassignment / escalation / firing recommendation.
4) If overworked: propose redistribution (which tasks to move, to whom).

When recommending firing: provide evidence (missed updates, repeated failures, queue errors, staleness).

Use ./mc to comment / create tasks.

Reply exactly: HR_REVIEWED`;

  try {
    const reply = openclawAgent('hermes', prompt, 240);
    console.log('[hermes-hr]', reply.slice(0, 120));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-hr] failed:', e.message);
  }
}

async function spawnHermesToReviewOutcome(st, task) {
  const taskId = task.id;
  const taskTitle = task.title;

  const prompt = `You are HERMES, the Watcher / QA Manager.

A task needs an outcome check:
- Task: "${taskTitle}" (ID: ${taskId})
- Status: ${task.status}

Governance rules:
- The assignee should post a final comment starting with: COMPLETION SUMMARY:
- Hermes must then post a comment starting with: OUTCOME:

Your job:
1) Read the task details + recent comments.
2) If COMPLETION SUMMARY is missing or unclear:
   - Post: OUTCOME: NEEDS SUMMARY (ask for specific missing info)
   - @mention the assignee to provide the completion summary
   - If task is in done, move it back to review.
3) If summary exists:
   - Validate it (what changed, where, how to verify, risks)
   - Post: OUTCOME: PASS or OUTCOME: FAIL with reasons
   - IMPORTANT: You MUST also set the task status:
     - If status is review and PASS, move to done.
     - If status is done and PASS, leave as done.
     - If FAIL, move to in_progress and assign back to the appropriate agent.
4) If follow-up work is needed, create a new Inbox task for Zeus.

Use ./mc:
- ./mc task ${taskId} --comment "OUTCOME: ..."
- ./mc task ${taskId} --status review|done|in_progress
- ./mc task ${taskId} --assign <agent>
- ./mc new --title "..." --description "..." --status inbox

Reply exactly: OUTCOME_RECORDED`;

  try {
    const reply = openclawAgent('hermes', prompt, 240);
    console.log('[hermes-outcome]', reply.slice(0, 120));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error('[hermes-outcome] failed:', e.message);
  }
}

// ===== MENTION QUEUE =====

function ensureMentionQueueTable() {
  const db = new Database(DB_PATH);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mention_queue (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,           -- task_comment | task_description
        source_id TEXT NOT NULL,      -- task_mentions.id OR <taskId>:desc
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|error
        processing_started_at INTEGER,
        tries INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mention_queue ON mention_queue(kind, source_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_mention_queue_status ON mention_queue(status, created_at);
    `);

    // Evolve schema safely if older DB exists
    const cols = db.prepare(`PRAGMA table_info(mention_queue)`).all().map(r => r.name);
    if (!cols.includes('processing_started_at')) {
      db.exec(`ALTER TABLE mention_queue ADD COLUMN processing_started_at INTEGER;`);
    }
  } finally {
    db.close();
  }
}

function normalizeMentionAgentId(agentId) {
  const a = String(agentId || '').trim().toLowerCase();
  if (!a) return null;

  // "jarvis" is the boss persona in chat, not an OpenClaw agent id.
  // Route @jarvis to Zeus (director) so the system can respond.
  if (a === 'jarvis') return 'zeus';

  // Only allow real OpenClaw agent ids (prevents queue-jams on bad parse like "@mention")
  const allowed = new Set(['zeus', 'hermes', 'apollo', 'artemis', 'ares', 'prometheus']);
  if (!allowed.has(a)) return null;

  return a;
}

function enqueueMention({ kind, sourceId, taskId, agentId, createdAt }) {
  const norm = normalizeMentionAgentId(agentId);
  if (!norm) return;

  const db = new Database(DB_PATH);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO mention_queue (id, kind, source_id, task_id, agent_id, created_at, status, tries)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
    `).run(nanoid(), kind, sourceId, taskId, norm, createdAt || nowMs());
  } finally {
    db.close();
  }
}

function reapStuckProcessingQueue(ttlMs = 10 * 60 * 1000) {
  const db = new Database(DB_PATH);
  try {
    const cutoff = nowMs() - ttlMs;
    const stuck = db.prepare(`
      SELECT id, agent_id, kind, task_id, tries
      FROM mention_queue
      WHERE status='processing'
        AND COALESCE(processing_started_at, created_at) < ?
      ORDER BY COALESCE(processing_started_at, created_at) ASC
      LIMIT 25
    `).all(cutoff);

    for (const row of stuck) {
      db.prepare(`
        UPDATE mention_queue
        SET status='error',
            last_error=COALESCE(last_error,'') || '\nprocessing_ttl',
            tries=tries+1
        WHERE id=?
      `).run(row.id);
      console.log(`[queue] processing TTL -> error id=${row.id} agent=${row.agent_id} task=${row.task_id}`);
    }

    return { stuck: stuck.length };
  } catch {
    return { stuck: 0 };
  } finally {
    db.close();
  }
}

function nextQueuedMention() {
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(`
      SELECT * FROM mention_queue
      WHERE status IN ('pending','error')
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    return row || null;
  } finally {
    db.close();
  }
}

function markQueueStatus(id, status, opts = {}) {
  const db = new Database(DB_PATH);
  try {
    const startedAt = (status === 'processing') ? nowMs() : null;
    db.prepare(`
      UPDATE mention_queue
      SET status=?,
          processing_started_at=COALESCE(?, processing_started_at),
          tries=COALESCE(?, tries),
          last_error=COALESCE(?, last_error)
      WHERE id=?
    `).run(status, startedAt, opts.tries ?? null, opts.lastError ?? null, id);
  } finally {
    db.close();
  }
}

function nanoid() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ===== TASK MENTION RESPONSES =====

async function spawnAgentToRespondToTaskMention(st, mention, agentIdOverride = null) {
  const agentId = agentIdOverride || mention.agent_id;
  const taskTitle = mention.task_title;
  const taskId = mention.task_id;
  const messageContent = mention.message_content;
  const fromAgent = mention.message_from || 'someone';

  const prompt = `You are ${agentId.toUpperCase()}.

You were @mentioned in a task comment:
- Task: "${taskTitle}" (ID: ${taskId})
- From: ${fromAgent}
- Message: "${messageContent}"

Your job:
1. Read the task context (via Mission Control UI/API)
2. Post a relevant comment responding to the mention
3. Take action if needed (assign yourself, update status, etc.)

Use ./mc to interact with the task:
- ./mc task ${taskId} --comment "Your response"
- ./mc task ${taskId} --assign ${agentId} (if you want to take it)

Reply with exactly: RESPONDED or NO_ACTION`;

  let reply = '';
  try {
    reply = openclawAgent(agentId, prompt, 180);
    console.log(`[${agentId}-task-mention]`, reply.slice(0, 100));
    st.lastAgentRunAt = nowMs();
    st.agentRunsThisHour++;
  } catch (e) {
    console.error(`[${agentId}-task-mention] failed:`, e.message);
    // leave queued; worker will retry later
    throw e;
  }

  // Mark the mention as read
  const db = new Database(DB_PATH);
  const result = db.prepare('UPDATE task_mentions SET read_at = ? WHERE id = ?').run(nowMs(), mention.id);
  db.close();
  console.log(`[${agentId}-task-mention] Marked mention ${mention.id} as read, changes: ${result.changes}`);
}

async function spawnAgentToCommentOnNewTask(st, task, agentId) {
  const taskTitle = task.title;
  const taskId = task.id;
  const description = task.description;

  const prompt = `You are ${agentId.toUpperCase()}.

A new task was created and you were @mentioned in the description:
- Task: "${taskTitle}" (ID: ${taskId})
- Description: "${description}"

Your job:
1. Post an initial comment acknowledging the task
2. Self-assign if it fits your expertise

Use ./mc to interact:
- ./mc task ${taskId} --comment "Looking into this..."
- ./mc task ${taskId} --assign ${agentId}

Reply with exactly: COMMENTED or ASSIGNED`;

  const reply = openclawAgent(agentId, prompt, 180);
  console.log(`[${agentId}-new-task-comment]`, reply.slice(0, 100));
  st.lastAgentRunAt = nowMs();
  st.agentRunsThisHour++;
}

// ===== SESSION CLEANUP =====
// Clean up old agent session files to prevent accumulation
async function cleanupOldSessions() {
  try {
    const agentsDir = path.join(process.env.HOME, '.openclaw', 'agents');
    if (!fs.existsSync(agentsDir)) return;
    
    const oneDayAgo = nowMs() - (24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    // Get all agent directories
    const agents = fs.readdirSync(agentsDir);
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const filePath = path.join(sessionsDir, file);
          const stat = fs.statSync(filePath);
          // Delete session logs older than 24 hours
          if (stat.mtimeMs < oneDayAgo) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`[cleanup] Removed ${cleaned} old session files`);
    }
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

// ===== MAIN LOOP =====

async function tick() {
  const st = readState();

  // Ensure queue table exists
  ensureMentionQueueTable();
  // Reap stuck processing items so the queue can't wedge forever
  reapStuckProcessingQueue();
  
  // Increment tick counter and run cleanup every 10 ticks (~10 min)
  st.tickCount = (st.tickCount || 0) + 1;
  if (st.tickCount % 10 === 0) {
    await cleanupOldSessions();
  }
  
  const maint = inMaintenanceWindow();
  st.maintenance ||= {};
  st.maintenance.tz = MAINT_WINDOW_TZ;
  st.maintenance.startHour = MAINT_WINDOW_START_HOUR;
  st.maintenance.endHour = MAINT_WINDOW_END_HOUR;
  st.maintenance.inWindow = maint;

  console.log(`[tick] hourRuns=${st.agentRunsThisHour}/${MAX_AGENT_RUNS_PER_HOUR} tick=${st.tickCount} maint=${maint ? 'ON' : 'OFF'}`);
  
  // Scan everything (cheap, no tokens)
  const mc = await scanMissionControl();
  const emails = await scanEmails();
  const files = await scanFiles();
  const logs = await scanLogs();
  const cal = await scanCalendar();
  const gh = await scanGitHub();
  const tokens = await scanTokenBurn();
  const taskMentions = await scanTaskMentions();
  const newTaskMentions = await scanNewTasksWithMentions();
  const perf = await scanAgentPerformance();
  
  console.log(`[scan] inbox=${mc.unassigned.length} assignedReady=${(mc.assignedReady||[]).length} inProgStale=${(mc.inProgressStale||[]).length} needsOutcome=${(mc.needsOutcome||[]).length} perfFlags=${perf.flags.length} stuck=${mc.stuck.length} overdue=${mc.overdue.length} emails=${emails.urgent} files=${files.newFiles} logs=${logs.errors} cal=${cal.upcoming} gh=${gh.notifications + gh.mentions} tokens=${tokens.alert ? 'ALERT' : 'OK'} taskMentions=${taskMentions.count} newTaskMentions=${newTaskMentions.count}`);
  
  // Enqueue new task-comment mentions
  if (taskMentions.count > 0) {
    for (const m of taskMentions.items) {
      enqueueMention({
        kind: 'task_comment',
        sourceId: m.id,
        taskId: m.task_id,
        agentId: m.agent_id,
        createdAt: m.created_at
      });
    }
  }

  // Enqueue new tasks with description mentions
  if (newTaskMentions.count > 0) {
    for (const item of newTaskMentions.items) {
      for (const agentId of item.mentions) {
        enqueueMention({
          kind: 'task_description',
          sourceId: `${item.task.id}:desc`,
          taskId: item.task.id,
          agentId,
          createdAt: item.task.created_at
        });
      }
    }
  }

  // PRIORITY 1: Critical - Unassigned inbox tasks → Zeus assigns
  // This must win over mention queue to prevent bad/unknown mentions from starving assignment.
  if (mc.unassigned.length > 0 && shouldSpawnAgent(st, 'zeus-assign', 1)) {
    await spawnZeusToAssign(st);
    writeState(st);
    return;
  }

  // PRIORITY 1: Critical - Token burn alert
  if (tokens.alert && shouldSpawnAgent(st, 'token-alert', 1)) {
    await spawnHermesToWatch(st); // Hermes monitors system health
    writeState(st);
    return;
  }

  // PRIORITY 1: process mention queue (one item per cycle, but guaranteed to drain)
  const q = nextQueuedMention();
  if (q && shouldSpawnAgent(st, `mention-queue:${q.agent_id}`, 1)) {
    try {
      markQueueStatus(q.id, 'processing', { tries: Number(q.tries || 0) + 1 });

      if (q.kind === 'task_comment') {
        // Load mention row details
        const db = new Database(DB_PATH);
        const mention = db.prepare(`
          SELECT tm.*, t.title as task_title, t.id as task_id, m.content as message_content, m.from_agent_id as message_from
          FROM task_mentions tm
          JOIN tasks t ON t.id = tm.task_id
          JOIN messages m ON m.id = tm.message_id
          WHERE tm.id=?
        `).get(q.source_id);
        db.close();
        if (mention) await spawnAgentToRespondToTaskMention(st, mention, q.agent_id);
      } else if (q.kind === 'task_description') {
        const db = new Database(DB_PATH);
        const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(q.task_id);
        db.close();
        if (task) await spawnAgentToCommentOnNewTask(st, task, q.agent_id);
      }

      markQueueStatus(q.id, 'done');
      writeState(st);
      return;
    } catch (e) {
      markQueueStatus(q.id, 'error', { lastError: String(e.message || e) });
      writeState(st);
      return;
    }
  }

  // PRIORITY 1: Critical - Assigned tasks need first touch → spawn the assignee
  if ((mc.assignedReady || []).length > 0) {
    const pick = mc.assignedReady[0];
    const agentId = pick.agent_id;
    const key = `assigned-first-touch:${agentId}:${pick.id}`;
    if (agentId && shouldSpawnAgent(st, key, 1)) {
      await spawnSpecialistToWork(st, agentId, pick.id, pick.title, key);
      writeState(st);
      return;
    }
  }

  // PRIORITY 1: System errors → Hermes alerts
  // (Kept high so we don't ignore real breakage)
  
  // PRIORITY 1: Critical - System errors → Hermes alerts
  if (logs.errors > 0 && shouldSpawnAgent(st, 'logs-error', 1)) {
    await spawnHermesToCheckLogs(st, logs.items);
    writeState(st);
    return;
  }
  
  // PRIORITY 2: Weekly Hermes report (Mondays 09:00 local time, once per ISO week)
  st.hr ||= {};
  const wk = weekKey();
  const dow = localDayOfWeek();
  const h = getLocalHour();
  const m = new Date().getMinutes();
  const shouldWeekly = (dow === 'Mon') && (h === 9) && (m < 10) && (st.hr.lastWeeklyWeek !== wk);
  if (shouldWeekly && shouldSpawnAgent(st, `hermes-weekly:${wk}`, 2)) {
    st.hr.lastWeeklyWeek = wk;
    st.hr.lastWeeklyAt = nowMs();
    await spawnHermesWeeklyReport(st);
    writeState(st);
    return;
  }

  // PRIORITY 2: High - Hermes HR review (agent performance)
  if ((perf.flags || []).length > 0 && shouldSpawnAgent(st, 'hermes-hr', 2)) {
    await spawnHermesHR(st, perf.flags);
    writeState(st);
    return;
  }

  // PRIORITY 2: High - Review/done tasks need Hermes outcome
  if ((mc.needsOutcome || []).length > 0 && shouldSpawnAgent(st, 'hermes-outcome', 2)) {
    await spawnHermesToReviewOutcome(st, mc.needsOutcome[0]);
    writeState(st);
    return;
  }

  // PRIORITY 2: High - In progress tasks stale → nudge assignee, but never starve QA/HR.
  if ((mc.inProgressStale || []).length > 0) {
    const pick = mc.inProgressStale[0];
    const agentId = pick.agent_id;
    const key = `inprog-stale:${agentId}:${pick.id}`;
    if (agentId && shouldSpawnAgent(st, key, 2)) {
      await spawnSpecialistToWork(st, agentId, pick.id, pick.title, key);
      writeState(st);
      return;
    }
  }

  // PRIORITY 2: High - Stuck tasks → Hermes nudges
  if (mc.stuck.length > 0 && shouldSpawnAgent(st, 'hermes-watch', 2)) {
    await spawnHermesToWatch(st);
    writeState(st);
    return;
  }
  
  // PRIORITY 2: High - Urgent emails → Hermes processes
  if (emails.urgent > 0 && shouldSpawnAgent(st, 'email-urgent', 2)) {
    await spawnHermesToProcessEmail(st, emails.items);
    writeState(st);
    return;
  }
  
  // PRIORITY 2: High - GitHub notifications/mentions → Ares checks
  if ((gh.notifications > 0 || gh.mentions > 0) && shouldSpawnAgent(st, 'github-check', 2)) {
    await spawnAresToCheckGitHub(st, gh.items);
    writeState(st);
    return;
  }
  
  // Persist state every tick so restarts don't reset counters/backoff.
  // (Even when we take no action this cycle.)
  writeState(st);

  // PRIORITY 3: Normal - Overdue tasks → Specialists work
  if (mc.overdue.length > 0) {
    const db = new Database(DB_PATH);
    const agentsWithWork = db.prepare(`
      SELECT DISTINCT a.id 
      FROM agents a
      JOIN task_assignees ta ON ta.agent_id = a.id
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.status IN ('assigned', 'in_progress')
      AND t.updated_at < ?
      ORDER BY RANDOM()
      LIMIT 1
    `).all(nowMs() - (24 * 60 * 60 * 1000));
    db.close();
    
    if (agentsWithWork.length > 0 && shouldSpawnAgent(st, 'specialist-work', 3)) {
      await spawnSpecialistToWork(st, agentsWithWork[0].id);
      writeState(st);
      return;
    }
  }
  
  // PRIORITY 3: Normal - New files → Apollo organizes
  if (files.newFiles > 0 && shouldSpawnAgent(st, 'files-new', 3)) {
    await spawnApolloToHandleFiles(st, files.items);
    writeState(st);
    return;
  }
  
  // PRIORITY 3: Normal - Calendar events → Prometheus researches
  if (cal.upcoming > 0 && shouldSpawnAgent(st, 'calendar-check', 3)) {
    await spawnPrometheusToResearch(st, `Upcoming calendar events: ${cal.items.map(e => e.title).join(', ')}`);
    writeState(st);
    return;
  }
  
  // PRIORITY 4: Low - General email processing
  if (emails.unread > 5 && shouldSpawnAgent(st, 'email-batch', 4)) {
    await spawnHermesToProcessEmail(st, emails.items);
    writeState(st);
    return;
  }
  
  writeState(st);
}

async function main() {
  console.log(`Agent Workloop running. Poll=${POLL_MS}ms`);
  
  const st = readState();
  if (!st.lastAgentRunAt) {
    st.lastAgentRunAt = 0;
  }
  if (!st.tickCount) {
    st.tickCount = 0;
  }
  writeState(st);
  
  // Run cleanup on startup
  await cleanupOldSessions();
  
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error('[tick error]', e.message);
    }
    await sleep(POLL_MS);
  }
}

main();
