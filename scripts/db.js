import Database from 'better-sqlite3';
import path from 'node:path';

export const DB_PATH = process.env.MC_DB_PATH || path.resolve(process.cwd(), 'mc.db');

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function nowMs() {
  return Date.now();
}
