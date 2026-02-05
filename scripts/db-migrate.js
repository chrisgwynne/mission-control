import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';

const schemaPath = path.resolve(process.cwd(), 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const db = openDb();
try {
  db.exec(schema);
  console.log('OK: migrated schema');
} finally {
  db.close();
}
