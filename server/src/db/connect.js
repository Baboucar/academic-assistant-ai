// The TIMETABLE database: what was read from the uploaded files (tmp/utg.db by
// default). It holds nothing that cannot be rebuilt from data/.
// Accounts, settings and logs are in a separate file: see accounts.js.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from '../env.js';
import { migrate, TIMETABLE_MIGRATIONS } from './migrations.js';

// create the folder on a fresh clone, before any ingest has run
fs.mkdirSync(path.dirname(env.DB_PATH), { recursive: true });
export const db = new Database(env.DB_PATH);
db.pragma('journal_mode = WAL');
// The ingest script writes from its own process: wait for its lock instead of failing.
db.pragma('busy_timeout = 5000');
migrate(db, TIMETABLE_MIGRATIONS);
