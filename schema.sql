-- Mission Control (MVP) schema (SQLite)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'spc',
  status TEXT NOT NULL DEFAULT 'idle',
  session_key TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  priority INTEGER NOT NULL DEFAULT 2,
  needs_approval INTEGER NOT NULL DEFAULT 0,
  checklist TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (task_id, agent_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_agent_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  from_agent_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS room_mentions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES room_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_mentions_agent_unread ON room_mentions(agent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_room_mentions_room ON room_mentions(room_id, created_at DESC);

-- Task mentions for @mentions in task comments
CREATE TABLE IF NOT EXISTS task_mentions (
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
CREATE INDEX IF NOT EXISTS idx_task_mentions_task ON task_mentions(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);
