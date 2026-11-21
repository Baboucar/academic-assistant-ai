// server/src/index.js
import { env, productionProblems } from './env.js';
import { createApp } from './app.js';
import { db } from './db/connect.js';
import { accountsDb } from './db/accounts.js';

const problems = productionProblems();
if (env.PRODUCTION && problems.length) {
    console.error('Refusing to start in production until these are fixed (see server/.env.example, or deploy/.env.production.example with Docker):');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}
if (!env.PRODUCTION) {
    if (problems.length) {
        console.warn('Development mode (NODE_ENV is not "production"). Before real use, fix:');
        for (const problem of problems) console.warn(`  - ${problem}`);
    }
    if (env.DEV_SHOW_CODES && !env.SMTP_HOST) {
        console.warn('DEV_SHOW_CODES is on: sign-up codes are shown on screen instead of emailed.');
    } else if (!env.SMTP_HOST) {
        console.warn('SMTP_HOST is not set: sign-up codes are printed in this log instead of emailed.');
    }
}

const server = createApp().listen(env.PORT, () => {
    console.log(`API on :${env.PORT} (${env.PRODUCTION ? 'production' : 'development'})`);
});

// Stop cleanly: finish open requests, then close the databases so everything
// written is in the .db files (not only in the -wal files beside them).
let stopping = false;
function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: stopping`);
    const finish = () => {
        try { db.close(); } catch { /* already closed */ }
        try { accountsDb.close(); } catch { /* already closed */ }
        process.exit(0);
    };
    server.close(finish);
    // streamed answers can hold a connection open: do not wait for them forever
    setTimeout(finish, 5000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
