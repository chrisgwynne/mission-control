-- Dual-bank memory system (draft + approved) MVP schema

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  bank TEXT NOT NULL CHECK (bank IN ('draft','approved')),

  -- Content
  title TEXT,
  statement TEXT NOT NULL,
  category TEXT,

  -- Confidence + status
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),

  -- Provenance
  source_type TEXT,
  source_ref TEXT,
  source_agent_id TEXT,
  source_notes TEXT,

  -- Approval metadata
  approved_at INTEGER,
  approved_by TEXT,
  approval_notes TEXT,

  -- Retention / freshness
  expires_at INTEGER,
  reaffirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_items_bank_status ON memory_items(bank, status);
CREATE INDEX IF NOT EXISTS idx_memory_items_updated ON memory_items(updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  actor TEXT,
  detail_json TEXT,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id, created_at);

-- Reflection questions (always visible)
CREATE TABLE IF NOT EXISTS memory_questions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  question TEXT NOT NULL,
  reason TEXT,
  related_memory_id TEXT,
  confidence REAL,
  FOREIGN KEY (related_memory_id) REFERENCES memory_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_questions_status ON memory_questions(status, updated_at DESC);
