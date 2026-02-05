import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.MEMORY_DB_PATH || path.join(__dirname, 'memory.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function ensureColumn(db, table, colName, colDef) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
  }
}

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply schema (idempotent for new DBs)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  // Lightweight migrations for existing DBs
  ensureColumn(db, 'memory_items', 'expires_at', 'INTEGER');
  ensureColumn(db, 'memory_items', 'reaffirmed_at', 'INTEGER');

  // Ensure questions table exists for existing DBs
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  if (!tables.includes('memory_questions')) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
  }

  return db;
}

export { DB_PATH };
