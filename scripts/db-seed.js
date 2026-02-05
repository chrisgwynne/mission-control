import { openDb, nowMs } from './db.js';
import { nanoid } from 'nanoid';

const db = openDb();
const ts = nowMs();

function upsertAgent({ id, name, role, level = 'spc', status = 'idle', session_key = null }) {
  db.prepare(`
    INSERT INTO agents (id, name, role, level, status, session_key, created_at, last_seen_at)
    VALUES (@id, @name, @role, @level, @status, @session_key, @created_at, @last_seen_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      role=excluded.role,
      level=excluded.level,
      status=excluded.status,
      session_key=excluded.session_key
  `).run({ id, name, role, level, status, session_key, created_at: ts, last_seen_at: ts });
}

try {
  // 7-agent roster
  upsertAgent({ id: 'jarvis', name: 'Jarvis', role: 'Your assistant (you-only)', level: 'boss', status: 'idle', session_key: 'agent:main:main' });
  upsertAgent({ id: 'zeus', name: 'Zeus', role: 'Agent Delegator', level: 'lead', status: 'idle', session_key: 'agent:zeus:main' });
  upsertAgent({ id: 'hermes', name: 'Hermes', role: 'Janitor / Ops', level: 'spc', status: 'idle', session_key: 'agent:hermes:main' });
  upsertAgent({ id: 'apollo', name: 'Apollo', role: 'Backend Coder', level: 'spc', status: 'idle', session_key: 'agent:apollo:main' });
  upsertAgent({ id: 'artemis', name: 'Artemis', role: 'Frontend Coder', level: 'spc', status: 'idle', session_key: 'agent:artemis:main' });
  upsertAgent({ id: 'ares', name: 'Ares', role: 'Bug Hunter / Skills', level: 'spc', status: 'idle', session_key: 'agent:ares:main' });
  upsertAgent({ id: 'prometheus', name: 'Prometheus', role: 'Researcher', level: 'spc', status: 'idle', session_key: 'agent:prometheus:main' });

  // seed a few tasks
  const mkTask = db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at)
    VALUES (@id, @title, @description, @status, @priority, @created_at, @updated_at)
  `);

  const tasks = [
    { title: 'Stand up Mission Control backend', description: 'Create REST + WS server with SQLite persistence.', status: 'in_progress', priority: 1 },
    { title: 'Wire dashboard UI to realtime state', description: 'Replace placeholders with API + websocket updates.', status: 'assigned', priority: 2 },
    { title: 'Agent heartbeat integration', description: 'Cron-based wakeups that read tasks + post updates.', status: 'inbox', priority: 3 },
  ];

  for (const t of tasks) {
    const id = nanoid(10);
    mkTask.run({
      id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      created_at: ts,
      updated_at: ts,
    });

    // Assign some
    if (t.status !== 'inbox') {
      const who = t.title.includes('backend') ? 'apollo' : 'artemis';
      db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, agent_id) VALUES (?, ?)').run(id, who);
    }

    db.prepare(`INSERT INTO activities (id, type, agent_id, task_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(10), 'task_created', 'zeus', id, `Task created: ${t.title}`, ts);
  }

  console.log('OK: seeded');
} finally {
  db.close();
}
