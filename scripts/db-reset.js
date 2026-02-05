import fs from 'node:fs';
import { DB_PATH, openDb } from './db.js';
import { execSync } from 'node:child_process';

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log(`Deleted ${DB_PATH}`);
}

execSync('node scripts/db-migrate.js', { stdio: 'inherit' });
execSync('node scripts/db-seed.js', { stdio: 'inherit' });

const db = openDb();
try {
  console.log('OK: db ready');
} finally {
  db.close();
}
