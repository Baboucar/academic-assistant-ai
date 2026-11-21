// The one place where tables are defined.
//
// There are two database files:
//   - the TIMETABLE database (tmp/utg.db): what was read from the uploaded
//     files. It can be thrown away and rebuilt from data/ at any time.
//   - the ACCOUNTS database (var/accounts.db): student accounts, sessions,
//     admin settings and logs. It cannot be rebuilt and must be backed up.
//
// Each list below is a history of changes. A database remembers how many it
// has applied (PRAGMA user_version), and `migrate` applies the rest, in order,
// each in its own transaction. To change a table, ADD a step at the end; never
// edit a step that has shipped.
//
// This file has no imports, so the ingest script can use it too.

const hasColumn = (db, table, column) =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
const hasTable = (db, table) =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;

const SOURCE_TYPES = `'timetable','exams','calendar','notices'`;

export const TIMETABLE_MIGRATIONS = [
    // 1. Everything that existed before versions were tracked. Databases made by
    //    earlier releases have some of these tables in older shapes, so this step
    //    creates what is missing and adds what was added later.
    function baseline(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS timetable (
            id INTEGER PRIMARY KEY,
            dept TEXT, course_code TEXT, course_title TEXT,
            day TEXT, start_time TEXT, end_time TEXT,
            venue TEXT, lecturer TEXT, source_file TEXT, semester TEXT
          );
          CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY,
            dept TEXT, course_code TEXT, course_title TEXT,
            date TEXT,          -- YYYY-MM-DD
            start_time TEXT,    -- HH:MM
            end_time TEXT,
            venue TEXT, lecturer TEXT, source_file TEXT, semester TEXT
          );
          CREATE TABLE IF NOT EXISTS calendar (
            id INTEGER PRIMARY KEY,
            date TEXT, title TEXT, description TEXT, source_file TEXT, semester TEXT
          );
          CREATE TABLE IF NOT EXISTS notices (
            id INTEGER PRIMARY KEY,
            date TEXT, title TEXT, body TEXT, source_file TEXT, semester TEXT
          );
          CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY,
            source_file TEXT UNIQUE,
            type TEXT CHECK (type IN (${SOURCE_TYPES})),
            semester TEXT,
            ingested_at TEXT DEFAULT (datetime('now')),
            dept TEXT
          );
        `);

        for (const table of ['timetable', 'calendar', 'notices']) {
            if (!hasColumn(db, table, 'semester')) db.exec(`ALTER TABLE ${table} ADD COLUMN semester TEXT`);
        }
        if (!hasColumn(db, 'exams', 'lecturer')) db.exec(`ALTER TABLE exams ADD COLUMN lecturer TEXT`);

        // sources.type gained 'exams'. SQLite cannot change a CHECK in place, so an
        // old table is rebuilt.
        const sources = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'`).get();
        if (!sources.sql.includes(`'exams'`)) {
            const dept = hasColumn(db, 'sources', 'dept') ? 'dept' : 'NULL';
            db.exec(`
              CREATE TABLE sources_new (
                id INTEGER PRIMARY KEY,
                source_file TEXT UNIQUE,
                type TEXT CHECK (type IN (${SOURCE_TYPES})),
                semester TEXT,
                ingested_at TEXT DEFAULT (datetime('now')),
                dept TEXT
              );
              INSERT INTO sources_new (id, source_file, type, semester, ingested_at, dept)
                SELECT id, source_file, type, semester, ingested_at, ${dept} FROM sources;
              DROP TABLE sources;
              ALTER TABLE sources_new RENAME TO sources;
            `);
        } else if (!hasColumn(db, 'sources', 'dept')) {
            db.exec(`ALTER TABLE sources ADD COLUMN dept TEXT`);
        }

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tt_day_dept ON timetable(day, dept);
          CREATE INDEX IF NOT EXISTS idx_tt_course ON timetable(course_code);
          CREATE INDEX IF NOT EXISTS idx_tt_semester ON timetable(semester);
          CREATE INDEX IF NOT EXISTS idx_exams_date ON exams(date);
          CREATE INDEX IF NOT EXISTS idx_exams_course ON exams(course_code);
          CREATE INDEX IF NOT EXISTS idx_cal_date ON calendar(date);
          CREATE INDEX IF NOT EXISTS idx_cal_semester ON calendar(semester);
          CREATE INDEX IF NOT EXISTS idx_notices_semester ON notices(semester);
          CREATE INDEX IF NOT EXISTS idx_sources_semester ON sources(semester);
        `);
    },

    // 2. Exams are filtered by semester like classes.
    function examSemesterIndex(db) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_exams_semester ON exams(semester)`);
    },
];

export const ACCOUNTS_MIGRATIONS = [
    // 1. Student accounts. (These tables first lived in the timetable database;
    //    accounts.js moves any rows found there.)
    function accounts(db) {
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
    },

    // 2. Things an admin sets, and the records an operator needs.
    function settingsAndLogs(db) {
        db.exec(`
          -- Small key/value settings, e.g. current_semester
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT
          );
          -- Other names for a course: "AI" -> "Artificial Intelligence". Searching for
          -- either finds both.
          CREATE TABLE aliases (
            alias TEXT PRIMARY KEY COLLATE NOCASE,
            title TEXT NOT NULL
          );
          -- Who changed what in the admin dashboard
          CREATE TABLE admin_log (
            id INTEGER PRIMARY KEY,
            at INTEGER NOT NULL,          -- epoch ms
            admin TEXT NOT NULL,
            action TEXT NOT NULL,         -- upload | delete | reingest | setting | alias
            target TEXT,
            detail TEXT
          );
          CREATE INDEX idx_admin_log_at ON admin_log(at);
          -- What students ask and how it went. No student is recorded with a question.
          CREATE TABLE question_log (
            id INTEGER PRIMARY KEY,
            at INTEGER NOT NULL,          -- epoch ms
            question TEXT NOT NULL,
            outcome TEXT NOT NULL,        -- answered | not_found | not_understood | clarify | chat | error
            kind TEXT,                    -- class | exam
            rows INTEGER NOT NULL DEFAULT 0,
            filters TEXT,                 -- JSON of the search that was run
            model_calls INTEGER NOT NULL DEFAULT 0,
            cached INTEGER NOT NULL DEFAULT 0,
            ms INTEGER NOT NULL DEFAULT 0,
            error TEXT
          );
          CREATE INDEX idx_question_log_at ON question_log(at);
          CREATE INDEX idx_question_log_outcome ON question_log(outcome, at);
          -- Emails sent per day, per address and in total ('*'), to protect the mailbox's allowance
          CREATE TABLE mail_counters (
            day TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
            key TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, key)
          );
        `);
        const seed = db.prepare(`INSERT OR IGNORE INTO aliases (alias, title) VALUES (?, ?)`);
        for (const [alias, title] of [
            ['AI', 'Artificial Intelligence'],
            ['Intelligent Systems', 'Artificial Intelligence'],
            ['DCN', 'Data Communications and Network'],
            ['Data Communications', 'Data Communications and Network'],
            ['Data Communication', 'Data Communications and Network'],
            ['Data Communications and Networks', 'Data Communications and Network'],
            ['Data Communication and Network', 'Data Communications and Network'],
            ['Data Communication and Networks', 'Data Communications and Network'],
            ['Data Communications and Networking', 'Data Communications and Network'],
        ]) {
            seed.run(alias, title);
        }
    },
];

/** Bring a database up to date. Returns the version it ends at. */
export function migrate(db, migrations) {
    for (;;) {
        // "immediate" takes the write lock before reading the version, so when the
        // server and the ingest script start together one waits for the other
        // (busy_timeout) instead of both trying the same step.
        const version = db.transaction(() => {
            const current = db.pragma('user_version', { simple: true });
            if (current >= migrations.length) return current;
            migrations[current](db);
            db.pragma(`user_version = ${current + 1}`);
            return current + 1;
        }).immediate();
        if (version >= migrations.length) return version;
    }
}

export { hasTable };
