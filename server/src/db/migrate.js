// Migrations for databases created by an older version. Takes an open
// better-sqlite3 handle and has no imports, so the ingest script can use it too.

const SOURCES_TABLE = `(
  id INTEGER PRIMARY KEY,
  source_file TEXT UNIQUE,
  type TEXT CHECK (type IN ('timetable','exams','calendar','notices')),
  semester TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  dept TEXT
)`;

export function migrate(db) {
    // `semester` was added after the first release
    for (const table of ['timetable', 'calendar', 'notices']) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN semester TEXT`); } catch { /* already there */ }
    }

    // `sources.type` gained 'exams'. SQLite cannot change a CHECK in place, so
    // an old table is rebuilt once.
    const sources = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'`).get();
    if (sources && !sources.sql.includes("'exams'")) {
        db.transaction(() => {
            db.exec(`CREATE TABLE sources_new ${SOURCES_TABLE}`);
            db.exec(`INSERT INTO sources_new (id, source_file, type, semester, ingested_at)
                     SELECT id, source_file, type, semester, ingested_at FROM sources`);
            db.exec(`DROP TABLE sources`);
            db.exec(`ALTER TABLE sources_new RENAME TO sources`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_semester ON sources(semester)`);
        })();
    }

    // Exam timetables name the lecturer for each paper
    try { db.exec(`ALTER TABLE exams ADD COLUMN lecturer TEXT`); } catch { /* already there, or no exams table yet */ }

    // The department (or school) a file belongs to, chosen at upload
    try { db.exec(`ALTER TABLE sources ADD COLUMN dept TEXT`); } catch { /* already there */ }
}
