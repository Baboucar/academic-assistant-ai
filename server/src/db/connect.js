// server/src/db/connect.js
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from '../env.js';
import { migrate } from './migrate.js';

// 1) open DB + WAL (create the folder on a fresh clone, before any ingest has run)
fs.mkdirSync(path.dirname(env.DB_PATH), { recursive: true });
export const db = new Database(env.DB_PATH);
db.pragma('journal_mode = WAL');
// The ingest script writes from its own process: wait for its lock instead of failing.
db.pragma('busy_timeout = 5000');

// 2) create base tables (idempotent). Include semester columns for fresh DBs.
db.exec(`
CREATE TABLE IF NOT EXISTS timetable (
  id INTEGER PRIMARY KEY,
  dept TEXT,
  course_code TEXT,
  course_title TEXT,
  day TEXT,
  start_time TEXT,
  end_time TEXT,
  venue TEXT,
  lecturer TEXT,
  source_file TEXT,
  semester TEXT
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  dept TEXT,
  course_code TEXT,
  course_title TEXT,
  date TEXT,          -- YYYY-MM-DD
  start_time TEXT,    -- HH:MM
  end_time TEXT,
  venue TEXT,
  lecturer TEXT,
  source_file TEXT,
  semester TEXT
);
CREATE TABLE IF NOT EXISTS calendar (
  id INTEGER PRIMARY KEY,
  date TEXT,
  title TEXT,
  description TEXT,
  source_file TEXT,
  semester TEXT
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  date TEXT,
  title TEXT,
  body TEXT,
  source_file TEXT,
  semester TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  source_file TEXT UNIQUE,
  type TEXT CHECK (type IN ('timetable','exams','calendar','notices')),
  semester TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  dept TEXT
);
`);

// 3) bring databases from older versions up to date
migrate(db);

// 3b) student accounts (server only: the ingest script never touches these)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  mat_number TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified_at INTEGER,              -- epoch ms; NULL until the email is confirmed
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);
-- One pending emailed code per user and purpose ('verify' | 'reset'); only its hash is kept
CREATE TABLE IF NOT EXISTS email_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose)
);
-- Sign-in sessions; only the hash of the token is kept
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);
db.pragma('foreign_keys = ON');

// 4) indexes (guard each so old DBs won’t explode)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tt_day_dept ON timetable(day, dept)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tt_course   ON timetable(course_code)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tt_semester ON timetable(semester)`); } catch {}

try { db.exec(`CREATE INDEX IF NOT EXISTS idx_exams_date   ON exams(date)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_exams_course ON exams(course_code)`); } catch {}

try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_date     ON calendar(date)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_semester ON calendar(semester)`); } catch {}

try { db.exec(`CREATE INDEX IF NOT EXISTS idx_notices_semester ON notices(semester)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_semester ON sources(semester)`); } catch {}
