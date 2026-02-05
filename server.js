import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { openDb, nowMs } from './scripts/db.js';

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Dev-friendly: prevent stale cached JS/HTML while iterating on the UI
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Serve the dashboard UI from this folder
app.use(express.static(process.cwd(), { extensions: ['html'] }));

// Ensure DB schema evolves safely (ALTER TABLE for new columns)
function ensureSchema() {
  const db = openDb();
  try {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map(r => r.name);
    if (!cols.includes('needs_approval')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('checklist')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN checklist TEXT NOT NULL DEFAULT ''`);
    }

    // room_messages + room_mentions tables
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    if (!tables.includes('room_messages')) {
      db.exec(`CREATE TABLE IF NOT EXISTS room_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        from_agent_id TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at DESC);`);
    }
    if (!tables.includes('room_mentions')) {
      db.exec(`CREATE TABLE IF NOT EXISTS room_mentions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY (message_id) REFERENCES room_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_room_mentions_agent_unread ON room_mentions(agent_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_room_mentions_room ON room_mentions(room_id, created_at DESC);`);
    }
    if (!tables.includes('task_mentions')) {
      db.exec(`CREATE TABLE IF NOT EXISTS task_mentions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_mentions_agent_unread ON task_mentions(agent_id, read_at);
      CREATE INDEX IF NOT EXISTS idx_task_mentions_task ON task_mentions(task_id, created_at DESC);`);
    }
    if (!tables.includes('task_links')) {
      db.exec(`CREATE TABLE IF NOT EXISTS task_links (
        id TEXT PRIMARY KEY,
        from_task_id TEXT NOT NULL,
        to_task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (from_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (to_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(from_task_id, to_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_links_from ON task_links(from_task_id);
      CREATE INDEX IF NOT EXISTS idx_task_links_to ON task_links(to_task_id);`);
    }

    // FTS5 virtual tables for search
    if (!tables.includes('tasks_fts')) {
      db.exec(`CREATE VIRTUAL TABLE tasks_fts USING fts5(
        title, description,
        content='tasks',
        content_rowid='rowid'
      );`);
      // Populate with existing data
      db.exec(`INSERT INTO tasks_fts(rowid, title, description) 
               SELECT rowid, title, description FROM tasks WHERE title IS NOT NULL;`);
    }
    if (!tables.includes('messages_fts')) {
      db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );`);
      db.exec(`INSERT INTO messages_fts(rowid, content) 
               SELECT rowid, content FROM messages WHERE content IS NOT NULL;`);
    }
    if (!tables.includes('activities_fts')) {
      db.exec(`CREATE VIRTUAL TABLE activities_fts USING fts5(
        message,
        content='activities',
        content_rowid='rowid'
      );`);
      db.exec(`INSERT INTO activities_fts(rowid, message) 
               SELECT rowid, message FROM activities WHERE message IS NOT NULL;`);
    }

    // Triggers to keep FTS indexes updated
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map(r => r.name);
    if (!triggers.includes('tasks_fts_insert')) {
      db.exec(`CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
      END;`);
    }
    if (!triggers.includes('tasks_fts_update')) {
      db.exec(`CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks BEGIN
        UPDATE tasks_fts SET title = new.title, description = new.description WHERE rowid = old.rowid;
      END;`);
    }
    if (!triggers.includes('tasks_fts_delete')) {
      db.exec(`CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
        DELETE FROM tasks_fts WHERE rowid = old.rowid;
      END;`);
    }
    if (!triggers.includes('messages_fts_insert')) {
      db.exec(`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;`);
    }
    if (!triggers.includes('messages_fts_delete')) {
      db.exec(`CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;`);
    }
    if (!triggers.includes('activities_fts_insert')) {
      db.exec(`CREATE TRIGGER activities_fts_insert AFTER INSERT ON activities BEGIN
        INSERT INTO activities_fts(rowid, message) VALUES (new.rowid, new.message);
      END;`);
    }
    if (!triggers.includes('activities_fts_delete')) {
      db.exec(`CREATE TRIGGER activities_fts_delete AFTER DELETE ON activities BEGIN
        DELETE FROM activities_fts WHERE rowid = old.rowid;
      END;`);
    }
  } finally {
    db.close();
  }
}

ensureSchema();

function buildState(db) {
  const agents = db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all();
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all();
  const assignees = db.prepare('SELECT * FROM task_assignees').all();
  const messages = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 50').all();
  const commentCounts = db.prepare('SELECT from_agent_id as agent_id, COUNT(*) as c FROM messages GROUP BY from_agent_id').all();
  const activities = db.prepare('SELECT * FROM activities ORDER BY created_at DESC LIMIT 50').all();

  const taskAssigneesByTask = new Map();
  for (const row of assignees) {
    const arr = taskAssigneesByTask.get(row.task_id) || [];
    arr.push(row.agent_id);
    taskAssigneesByTask.set(row.task_id, arr);
  }

  const commentCountsByAgent = new Map();
  for (const row of commentCounts) {
    if (!row?.agent_id) continue;
    commentCountsByAgent.set(row.agent_id, row.c || 0);
  }

  return {
    agents: agents.map(a => ({ ...a, commentCount: commentCountsByAgent.get(a.id) || 0 })),
    tasks: tasks.map(t => ({ ...t, assigneeIds: taskAssigneesByTask.get(t.id) || [] })),
    messages,
    activities,
    serverTime: nowMs(),
  };
}

function emit(wss, event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

const OBSIDIAN_LOG_DIR = '/mnt/homes/Chris/Obsidian/Everything/OpenClaw Second Brain/Logs';

function appendObsidianLog({ type, agentId, taskId, message }) {
  try {
    fs.mkdirSync(OBSIDIAN_LOG_DIR, { recursive: true });
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;
    const file = `${OBSIDIAN_LOG_DIR}/${date}.md`;

    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const who = String(agentId || 'system').toUpperCase();
    const taskPart = taskId ? ` • Task: ${taskId}` : '';
    const header = `\n\n---\n**${time}** • **${who}** • \`${type}\`${taskPart}\n\n`;
    fs.appendFileSync(file, header + message + '\n', 'utf8');
  } catch {
    // best-effort; never break the API
  }
}

// API
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: nowMs() });
});

app.get('/api/health', (req, res) => {
  const db = openDb();
  try {
    const ts = nowMs();

    // Workloop state (best-effort)
    let workloopState = null;
    try {
      const p = path.resolve(process.cwd(), 'workloop.state.json');
      if (fs.existsSync(p)) workloopState = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      workloopState = null;
    }

    // Mention queue stats
    const mq = db.prepare(`
      SELECT status, COUNT(*) as c
      FROM mention_queue
      GROUP BY status
    `).all();

    const mqByAgent = db.prepare(`
      SELECT agent_id, status, COUNT(*) as c
      FROM mention_queue
      GROUP BY agent_id, status
      ORDER BY agent_id, status
    `).all();

    const mqOldest = db.prepare(`
      SELECT id, agent_id, kind, task_id, status, tries, created_at, processing_started_at, last_error
      FROM mention_queue
      WHERE status IN ('pending','error','processing')
      ORDER BY COALESCE(processing_started_at, created_at) ASC
      LIMIT 5
    `).all();

    const unreadTaskMentions = db.prepare(`SELECT COUNT(*) as c FROM task_mentions WHERE read_at IS NULL`).get()?.c || 0;
    const unreadRoomMentions = db.prepare(`SELECT COUNT(*) as c FROM room_mentions WHERE read_at IS NULL`).get()?.c || 0;

    const tasksByStatus = db.prepare(`SELECT status, COUNT(*) as c FROM tasks GROUP BY status`).all();

    // Recent gateway errors (best-effort tail)
    let gatewayErrors = [];
    try {
      const gatewayLog = path.join(process.env.HOME, '.openclaw', 'logs', 'gateway.log');
      if (fs.existsSync(gatewayLog)) {
        const lines = fs.readFileSync(gatewayLog, 'utf8').split('\n');
        gatewayErrors = lines.filter(l => /error|failed|insufficient balance|timed out/i.test(l)).slice(-15);
      }
    } catch {
      gatewayErrors = [];
    }

    // GitHub auth probe (best-effort)
    let gh = { ok: false };
    try {
      const statusOut = execSync('gh auth status -t 2>/dev/null || gh auth status', { encoding: 'utf8', timeout: 4000, stdio: ['ignore','pipe','pipe'] });
      const userOut = execSync("gh api user --jq '{login:.login,id:.id}'", { encoding: 'utf8', timeout: 4000, stdio: ['ignore','pipe','pipe'] });
      gh = { ok: true, status: statusOut.trim().split('\n').slice(0, 8).join('\n'), user: userOut.trim() };
    } catch (e) {
      gh = { ok: false, error: String(e?.message || e).slice(0, 300) };
    }

    res.json({
      ok: true,
      ts,
      workloopState,
      maintenanceWindow: {
        tz: process.env.MAINT_WINDOW_TZ || 'Europe/London',
        startHour: Number(process.env.MAINT_WINDOW_START_HOUR || 2),
        endHour: Number(process.env.MAINT_WINDOW_END_HOUR || 5)
      },
      mentionQueue: { byStatus: mq, byAgent: mqByAgent, oldest: mqOldest },
      unread: { taskMentions: unreadTaskMentions, roomMentions: unreadRoomMentions },
      tasksByStatus,
      gatewayErrors,
      gh,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    db.close();
  }
});

// Search API using FTS5
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  if (!q || q.length < 2) return res.json({ ok: true, results: [], query: q });

  const db = openDb();
  try {
    // Escape FTS5 special chars
    const ftsQuery = q.replace(/["\*]/g, '').split(/\s+/).join(' OR ');

    // Search tasks
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.created_at,
             snippet(tasks_fts, 0, '<mark>', '</mark>', '...', 64) as snippet,
             rank as relevance
      FROM tasks_fts
      JOIN tasks t ON t.rowid = tasks_fts.rowid
      WHERE tasks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit);

    // Search messages
    const messages = db.prepare(`
      SELECT m.id, m.task_id, m.from_agent_id, m.content, m.created_at,
             snippet(messages_fts, 0, '<mark>', '</mark>', '...', 64) as snippet,
             rank as relevance
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit);

    // Search activities
    const activities = db.prepare(`
      SELECT a.id, a.type, a.agent_id, a.task_id, a.message, a.created_at,
             snippet(activities_fts, 0, '<mark>', '</mark>', '...', 64) as snippet,
             rank as relevance
      FROM activities_fts
      JOIN activities a ON a.rowid = activities_fts.rowid
      WHERE activities_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit);

    res.json({
      ok: true,
      query: q,
      results: {
        tasks: tasks.map(r => ({ ...r, kind: 'task' })),
        messages: messages.map(r => ({ ...r, kind: 'message' })),
        activities: activities.map(r => ({ ...r, kind: 'activity' })),
      },
      total: tasks.length + messages.length + activities.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    db.close();
  }
});

app.get('/api/state', (req, res) => {
  const db = openDb();
  try {
    res.json(buildState(db));
  } finally {
    db.close();
  }
});

app.post('/api/tasks', (req, res) => {
  const { title, description = '', status = 'inbox', priority = 2, needsApproval, checklist = '', assigneeIds = [], byAgentId = 'zeus' } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });

  const db = openDb();
  const ts = nowMs();
  const id = nanoid(10);

  try {
    const needs_approval = (needsApproval != null) ? Number(!!needsApproval) : (Number(priority) === 4 ? 1 : 0);

    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, needs_approval, checklist, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, title, description, status, priority, needs_approval, checklist || '', ts, ts);

    for (const aid of assigneeIds) {
      db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, agent_id) VALUES (?, ?)').run(id, aid);
    }

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'task_created', byAgentId, id, `Task created: ${title}`, ts);

    // Auto decision log when creating a Critical task
    if (Number(priority) === 4) {
      const msg = `Marked task as CRITICAL: ${title}`;
      db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'decision_added', byAgentId, id, msg, ts);
      appendObsidianLog({ type: 'decision_added', agentId: byAgentId, taskId: id, message: msg });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    res.json({ ok: true, task });
  } finally {
    db.close();
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  // Soft delete (archive) so agents can reference past work.
  const id = req.params.id;
  const { byAgentId = 'zeus' } = req.body || {};
  const db = openDb();
  const ts = nowMs();

  try {
    const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run('archived', ts, id);

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'task_archived', byAgentId, id, `Task archived: ${existing.title}`, ts);

    res.json({ ok: true });
  } finally {
    db.close();
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  const id = req.params.id;
  const { title, description, status, priority, needsApproval, checklist, assigneeIds, byAgentId = 'zeus' } = req.body || {};
  const db = openDb();
  const ts = nowMs();

  try {
    const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const prevPriority = existing.priority;

    db.prepare(`UPDATE tasks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      status = COALESCE(?, status),
      priority = COALESCE(?, priority),
      needs_approval = COALESCE(?, needs_approval),
      checklist = COALESCE(?, checklist),
      updated_at = ?
      WHERE id = ?
    `).run(
      title ?? null,
      description ?? null,
      status ?? null,
      priority ?? null,
      (needsApproval != null) ? Number(!!needsApproval) : null,
      (checklist != null) ? String(checklist) : null,
      ts,
      id
    );

    if (Array.isArray(assigneeIds)) {
      db.prepare('DELETE FROM task_assignees WHERE task_id=?').run(id);
      for (const aid of assigneeIds) {
        db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, agent_id) VALUES (?, ?)').run(id, aid);
      }
    }

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'task_updated', byAgentId, id, `Task updated`, ts);

    // Auto decision log when priority is escalated to Critical
    if (priority != null && Number(priority) === 4 && Number(prevPriority) !== 4) {
      const titleNow = title ?? existing.title;
      const msg = `Escalated to CRITICAL: ${titleNow}`;
      db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'decision_added', byAgentId, id, msg, ts);
      appendObsidianLog({ type: 'decision_added', agentId: byAgentId, taskId: id, message: msg });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    res.json({ ok: true, task });
  } finally {
    db.close();
  }
});

app.post('/api/messages', (req, res) => {
  const { taskId, fromAgentId = null, content, byAgentId = fromAgentId || 'zeus' } = req.body || {};
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });

  const db = openDb();
  const ts = nowMs();
  const id = nanoid(10);

  try {
    const task = db.prepare('SELECT id, title FROM tasks WHERE id=?').get(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });

    db.prepare(`INSERT INTO messages (id, task_id, from_agent_id, content, created_at)
                VALUES (?, ?, ?, ?, ?)`).run(id, taskId, fromAgentId, content, ts);

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'message_sent', byAgentId, taskId, `New comment on: ${task.title}`, ts);

    // Persist @mentions in task comments
    const mentions = Array.from(content.matchAll(/@([a-zA-Z0-9_-]+)/g)).map(m => m[1].toLowerCase());
    const uniq = Array.from(new Set(mentions));
    for (const agentId of uniq) {
      const agent = db.prepare('SELECT id FROM agents WHERE id=?').get(agentId);
      if (agent) {
        db.prepare(`INSERT INTO task_mentions (id, task_id, message_id, agent_id, created_at, read_at)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), taskId, id, agentId, ts, null);
      }
    }

    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    res.json({ ok: true, message: msg });
  } finally {
    db.close();
  }
});

// Create a standalone activity item (docs/decisions/etc)
app.post('/api/activities', (req, res) => {
  const { type, agentId = null, taskId = null, message } = req.body || {};
  if (!type || typeof type !== 'string') return res.status(400).json({ error: 'type required' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

  const db = openDb();
  const ts = nowMs();

  try {
    const id = nanoid(10);
    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(id, type, agentId, taskId, message, ts);

    if (agentId) {
      db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(ts, agentId);
    }

    if (type === 'doc_note' || type === 'decision_added' || type === 'approval_toggled' || type === 'checklist_updated') {
      appendObsidianLog({ type, agentId, taskId, message });
    }

    const row = db.prepare('SELECT * FROM activities WHERE id=?').get(id);
    res.json({ ok: true, activity: row });
  } finally {
    db.close();
  }
});

// Send a message to an agent (stored as an activity for now)
// Break room APIs
app.get('/api/rooms/:id/messages', (req, res) => {
  const roomId = req.params.id;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const db = openDb();
  try {
    const rows = db.prepare('SELECT * FROM room_messages WHERE room_id=? ORDER BY created_at DESC LIMIT ?').all(roomId, limit);
    res.json({ ok: true, roomId, messages: rows.reverse() });
  } finally {
    db.close();
  }
});

app.get('/api/mentions/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT rm.id as mention_id, rm.room_id, rm.message_id, rm.agent_id, rm.created_at, rm.read_at,
             m.from_agent_id, m.content, m.created_at as message_created_at
      FROM room_mentions rm
      JOIN room_messages m ON m.id = rm.message_id
      WHERE rm.agent_id = ?
      ORDER BY rm.created_at DESC
      LIMIT ?
    `).all(agentId, limit);
    res.json({ ok: true, agentId, mentions: rows });
  } finally {
    db.close();
  }
});

app.post('/api/mentions/:agentId/read', (req, res) => {
  const agentId = req.params.agentId;
  const { roomId = null } = req.body || {};
  const db = openDb();
  const ts = nowMs();
  try {
    if (roomId) {
      db.prepare('UPDATE room_mentions SET read_at=? WHERE agent_id=? AND room_id=? AND read_at IS NULL').run(ts, agentId, roomId);
    } else {
      db.prepare('UPDATE room_mentions SET read_at=? WHERE agent_id=? AND read_at IS NULL').run(ts, agentId);
    }
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

// Task mentions APIs (for @mentions in task comments)
app.get('/api/tasks/mentions/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT tm.id as mention_id, tm.task_id, tm.message_id, tm.agent_id, tm.created_at, tm.read_at,
             m.from_agent_id, m.content, m.created_at as message_created_at, t.title as task_title
      FROM task_mentions tm
      JOIN messages m ON m.id = tm.message_id
      JOIN tasks t ON t.id = tm.task_id
      WHERE tm.agent_id = ?
      ORDER BY tm.created_at DESC
      LIMIT ?
    `).all(agentId, limit);
    res.json({ ok: true, agentId, mentions: rows });
  } finally {
    db.close();
  }
});

app.post('/api/tasks/mentions/:agentId/read', (req, res) => {
  const agentId = req.params.agentId;
  const { taskId = null } = req.body || {};
  const db = openDb();
  const ts = nowMs();
  try {
    if (taskId) {
      db.prepare('UPDATE task_mentions SET read_at=? WHERE agent_id=? AND task_id=? AND read_at IS NULL').run(ts, agentId, taskId);
    } else {
      db.prepare('UPDATE task_mentions SET read_at=? WHERE agent_id=? AND read_at IS NULL').run(ts, agentId);
    }
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

// Task Links API
app.get('/api/tasks/:id/links', (req, res) => {
  const taskId = req.params.id;
  const db = openDb();
  try {
    const links = db.prepare(`
      SELECT tl.*, t.title as linked_task_title, t.status as linked_task_status
      FROM task_links tl
      JOIN tasks t ON t.id = tl.to_task_id
      WHERE tl.from_task_id = ?
      ORDER BY tl.created_at DESC
    `).all(taskId);
    res.json({ ok: true, links });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    db.close();
  }
});

app.post('/api/tasks/:id/links', (req, res) => {
  const fromTaskId = req.params.id;
  const { toTaskId, linkType = 'related', byAgentId = 'zeus' } = req.body || {};
  if (!toTaskId) return res.status(400).json({ ok: false, error: 'toTaskId required' });

  const db = openDb();
  const ts = nowMs();
  try {
    const id = `${nowMs()}_${Math.random().toString(36).slice(2, 10)}`;
    db.prepare('INSERT INTO task_links (id, from_task_id, to_task_id, link_type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, fromTaskId, toTaskId, linkType, byAgentId, ts);

    // Create activity
    const fromTask = db.prepare('SELECT title FROM tasks WHERE id=?').get(fromTaskId);
    const toTask = db.prepare('SELECT title FROM tasks WHERE id=?').get(toTaskId);
    const msg = `Linked task ${fromTaskId} (${fromTask?.title || 'unknown'}) to ${toTaskId} (${toTask?.title || 'unknown'})`;
    db.prepare('INSERT INTO activities (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${ts}_link`, 'task_linked', byAgentId, fromTaskId, msg, ts);

    res.json({ ok: true, link: { id, from_task_id: fromTaskId, to_task_id: toTaskId, link_type: linkType } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    db.close();
  }
});

app.delete('/api/tasks/:id/links/:linkId', (req, res) => {
  const { id: fromTaskId, linkId } = req.params;
  const db = openDb();
  try {
    db.prepare('DELETE FROM task_links WHERE id=? AND from_task_id=?').run(linkId, fromTaskId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    db.close();
  }
});

function rateLimitRoom(db, roomId, agentId, nowTs) {
  // Hard guardrails:
  // - max 1 msg / 2 min per agent
  // - max 10 msgs / hour per agent
  // - max 50 msgs / hour total
  const last = db.prepare('SELECT created_at FROM room_messages WHERE room_id=? AND from_agent_id=? ORDER BY created_at DESC LIMIT 1').get(roomId, agentId);
  if (last && (nowTs - last.created_at) < (2 * 60 * 1000)) return { ok: false, reason: 'Too fast (1 msg / 2 min).' };

  const sinceHour = nowTs - (60 * 60 * 1000);
  const perHour = db.prepare('SELECT COUNT(*) AS c FROM room_messages WHERE room_id=? AND from_agent_id=? AND created_at >= ?').get(roomId, agentId, sinceHour)?.c || 0;
  if (perHour >= 10) return { ok: false, reason: 'Rate limit (10 msgs / hour).' };

  const totalHour = db.prepare('SELECT COUNT(*) AS c FROM room_messages WHERE room_id=? AND created_at >= ?').get(roomId, sinceHour)?.c || 0;
  if (totalHour >= 50) return { ok: false, reason: 'Room rate limit (50 msgs / hour).' };

  return { ok: true };
}

app.post('/api/rooms/:id/messages', (req, res) => {
  const roomId = req.params.id;
  const { fromAgentId = 'jarvis', content } = req.body || {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });

  const db = openDb();
  const ts = nowMs();
  try {
    const agentId = String(fromAgentId || 'jarvis').toLowerCase();

    // Length guardrail
    const msg = String(content).slice(0, 500);

    const rl = rateLimitRoom(db, roomId, agentId, ts);
    if (!rl.ok) return res.status(429).json({ error: rl.reason });

    const id = nanoid(10);
    db.prepare(`INSERT INTO room_messages (id, room_id, from_agent_id, content, created_at)
                VALUES (?, ?, ?, ?, ?)`).run(id, roomId, agentId, msg, ts);

    // Persist @mentions
    const text = msg;
    const mentions = Array.from(text.matchAll(/@([a-zA-Z0-9_-]+)/g)).map(m => m[1].toLowerCase());
    const uniq = Array.from(new Set(mentions));
    for (const m of uniq) {
      const a = db.prepare('SELECT id FROM agents WHERE lower(id)=? OR lower(name)=?').get(m, m);
      if (a?.id) {
        db.prepare(`INSERT INTO room_mentions (id, room_id, message_id, agent_id, created_at, read_at)
                    VALUES (?, ?, ?, ?, ?, NULL)`).run(nanoid(10), roomId, id, a.id, ts);
      }
    }

    // Echo into live feed as chat
    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, NULL, ?, ?)`).run(nanoid(10), 'room_message', agentId, `Break room: ${msg}`, ts);

    // Touch last_seen
    db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(ts, agentId);

    const row = db.prepare('SELECT * FROM room_messages WHERE id=?').get(id);
    res.json({ ok: true, message: row });
  } finally {
    db.close();
  }
});

app.post('/api/agents/:id/ping', (req, res) => {
  const agentId = req.params.id;
  const { fromAgentId = 'jarvis', content } = req.body || {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });

  const db = openDb();
  const ts = nowMs();

  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, NULL, ?, ?)`).run(nanoid(10), 'agent_ping', agentId, `Message from ${fromAgentId}: ${content}`, ts);

    res.json({ ok: true });
  } finally {
    db.close();
  }
});

app.patch('/api/agents/:id', (req, res) => {
  const id = req.params.id;
  const { status, lastSeenAt, byAgentId = id } = req.body || {};
  const db = openDb();
  const ts = nowMs();

  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id);
    if (!agent) return res.status(404).json({ error: 'not found' });

    db.prepare(`UPDATE agents SET
      status = COALESCE(?, status),
      last_seen_at = COALESCE(?, last_seen_at)
      WHERE id=?
    `).run(status ?? null, lastSeenAt ?? ts, id);

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, NULL, ?, ?)`).run(nanoid(10), 'agent_updated', byAgentId, `Agent updated`, ts);

    const updated = db.prepare('SELECT * FROM agents WHERE id=?').get(id);
    res.json({ ok: true, agent: updated });
  } finally {
    db.close();
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: nowMs() }));
});

// naive broadcast: poll for changes every 1s and push full state (MVP).
// We'll optimize to event-based once UI wiring is done.
let lastDigest = '';
setInterval(() => {
  const db = openDb();
  try {
    const state = buildState(db);
    const digest = JSON.stringify({ a: state.activities[0]?.id, m: state.messages[0]?.id, t: state.tasks[0]?.id, s: state.serverTime });
    if (digest !== lastDigest) {
      lastDigest = digest;
      emit(wss, { type: 'state', state });
    }
  } catch (e) {
    // ignore
  } finally {
    db.close();
  }
}, 1000);

console.log(`Mission Control server starting on http://${HOST}:${PORT}`);
server.listen(PORT, HOST);
