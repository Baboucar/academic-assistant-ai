// Make dated, consistent copies of both databases:
//
//   npm --prefix server run backup
//
// Safe to run while the server is running: SQLite's backup API copies a
// consistent snapshot, unlike copying the .db file by hand (which misses
// whatever is still in the -wal file next to it).
// Copies go to BACKUP_DIR (default ./backups); the newest KEEP of each are kept.
// Run it nightly from cron and copy the folder off the machine.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../src/env.js';

const KEEP = Number(process.env.BACKUP_KEEP) || 14;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function backup(source, name) {
    if (!fs.existsSync(source)) {
        console.log(`${name}: nothing to back up yet (${source} does not exist)`);
        return null;
    }
    fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
    const target = path.join(env.BACKUP_DIR, `${name}-${stamp}.db`);
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
        await db.backup(target);
    } finally {
        db.close();
    }
    // prove the copy opens and is whole before trusting it, and leave it as one
    // plain file (no -wal / -shm beside it) so it can be copied anywhere as is
    const copy = new Database(target);
    copy.pragma('journal_mode = DELETE');
    const check = copy.pragma('integrity_check', { simple: true });
    copy.close();
    if (check !== 'ok') {
        fs.renameSync(target, `${target}.FAILED`);
        throw new Error(`${target} failed its integrity check (${check}); it was renamed to ${path.basename(target)}.FAILED`);
    }

    const old = fs
        .readdirSync(env.BACKUP_DIR)
        .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.db'))
        .sort()
        .reverse()
        .slice(KEEP);
    for (const f of old) fs.rmSync(path.join(env.BACKUP_DIR, f), { force: true });

    console.log(`${name}: ${target} (${fs.statSync(target).size} bytes)${old.length ? `, removed ${old.length} older` : ''}`);
    return target;
}

try {
    // accounts first: it is the one that cannot be rebuilt
    await backup(env.ACCOUNTS_DB_PATH, 'accounts');
    await backup(env.DB_PATH, 'timetable');
} catch (e) {
    console.error(`Backup failed: ${e?.message || e}`);
    process.exit(1);
}
