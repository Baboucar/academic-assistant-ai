// The ACCOUNTS database: student accounts, sessions, admin settings and logs
// (var/accounts.db by default). Unlike the timetable database it cannot be
// rebuilt from files, so it lives apart from it and is what `npm run backup`
// is mostly for.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from '../env.js';
import { db as timetableDb } from './connect.js';
import { ACCOUNTS_MIGRATIONS, hasTable, migrate } from './migrations.js';

fs.mkdirSync(path.dirname(env.ACCOUNTS_DB_PATH), { recursive: true });
export const accountsDb = new Database(env.ACCOUNTS_DB_PATH);
accountsDb.pragma('journal_mode = WAL');
accountsDb.pragma('busy_timeout = 5000');
accountsDb.pragma('foreign_keys = ON');
migrate(accountsDb, ACCOUNTS_MIGRATIONS);

// Accounts used to live in the timetable database. Move them across once, and
// only into an empty accounts database, so nothing is ever overwritten.
if (hasTable(timetableDb, 'users')) {
    const old = timetableDb.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    const current = accountsDb.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    if (old > 0 && current === 0) {
        const copy = (table, columns) => {
            const rows = timetableDb.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all();
            const insert = accountsDb.prepare(
                `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
            );
            for (const row of rows) insert.run(row);
            return rows.length;
        };
        const moved = accountsDb.transaction(() => ({
            users: copy('users', ['id', 'mat_number', 'email', 'password_hash', 'verified_at', 'failed_logins', 'locked_until', 'created_at']),
            codes: copy('email_codes', ['user_id', 'purpose', 'code_hash', 'attempts', 'sent_at', 'expires_at']),
            sessions: copy('sessions', ['token_hash', 'user_id', 'created_at', 'expires_at']),
        }))();
        console.log(`Moved ${moved.users} account(s) and ${moved.sessions} session(s) into ${env.ACCOUNTS_DB_PATH}`);
    }
    if (old === 0 || current === 0) {
        // the copy above succeeded (or there was nothing to copy): the old tables can go
        timetableDb.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS email_codes; DROP TABLE IF EXISTS users;`);
    }
}

// ---- settings ----
const getSetting = accountsDb.prepare(`SELECT value FROM settings WHERE key = ?`);
const putSetting = accountsDb.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);
const dropSetting = accountsDb.prepare(`DELETE FROM settings WHERE key = ?`);

export const Settings = {
    get: (key) => getSetting.get(key)?.value ?? null,
    set: (key, value) => (value === null || value === undefined ? dropSetting.run(key) : putSetting.run(key, String(value))),
};

// ---- admin log ----
const addAdminLog = accountsDb.prepare(
    `INSERT INTO admin_log (at, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
);
/** Record something an admin did. Never throws: a log failure must not undo the action. */
export function recordAdminAction(admin, action, target = '', detail = '') {
    try {
        addAdminLog.run(Date.now(), String(admin || 'admin'), action, String(target || ''), String(detail || '').slice(0, 500));
    } catch (e) {
        console.error('Could not write the admin log:', e?.message || e);
    }
}
export const recentAdminActions = (limit = 50) =>
    accountsDb.prepare(`SELECT at, admin, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?`).all(limit);
