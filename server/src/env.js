// server/src/env.js
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function origins(value) {
    const list = String(value || '*').split(',').map((s) => s.trim()).filter(Boolean);
    return list.length === 0 || list.includes('*') ? '*' : list;
}

/** "alice:secret one,bob:secret two" -> [{ user, pass }] */
function adminList(value) {
    return String(value || '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
            const at = pair.indexOf(':');
            return at > 0 ? { user: pair.slice(0, at).trim(), pass: pair.slice(at + 1) } : null;
        })
        .filter((a) => a && a.user && a.pass);
}

export const env = {
    // "production" turns on the start-up checks in index.js
    PRODUCTION: process.env.NODE_ENV === 'production',
    PORT: Number(process.env.PORT) || 5051,
    // "*" or a comma-separated list of allowed origins
    ORIGIN: origins(process.env.ORIGIN),
    // Set to 1 when the API runs behind a reverse proxy, so rate limits see the real client IP
    TRUST_PROXY: process.env.TRUST_PROXY || '',

    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    // Any OpenAI-compatible endpoint works here (Groq by default)
    GROQ_BASE_URL: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    MODEL: process.env.MODEL || 'openai/gpt-oss-120b',

    ADMIN_USER: process.env.ADMIN_USER || '',
    ADMIN_PASS: process.env.ADMIN_PASS || '',
    // More admins, each with their own password, so the log shows who changed what:
    // ADMIN_USERS="awa:long password one,lamin:long password two"
    ADMIN_USERS: adminList(process.env.ADMIN_USERS),

    // Student accounts: which email domains may register, and what a matriculation number looks like
    STUDENT_EMAIL_DOMAINS: String(process.env.STUDENT_EMAIL_DOMAINS || 'utg.edu')
        .split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    MAT_NUMBER_PATTERN: process.env.MAT_NUMBER_PATTERN || '^[A-Z0-9]{5,12}$',
    // Outgoing email for sign-up codes. Without SMTP_HOST the code is printed in the server log.
    SMTP_HOST: process.env.SMTP_HOST || '',
    SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
    MAIL_FROM: process.env.MAIL_FROM || process.env.SMTP_USER || 'UTG Academic Assistant <no-reply@localhost>',
    // Local testing only: with no SMTP server, show the emailed code on screen. Never set this on a real deployment.
    DEV_SHOW_CODES: ['1', 'true'].includes(String(process.env.DEV_SHOW_CODES || '').toLowerCase()),
    // Per-student question limits (the AI allowance is shared by everyone)
    CHAT_PER_MINUTE: Number(process.env.CHAT_PER_MINUTE) || 10,
    CHAT_PER_DAY: Number(process.env.CHAT_PER_DAY) || 150,
    // How long an answer is reused for the same question (first question of a chat only). 0 turns it off.
    ANSWER_CACHE_SECONDS: process.env.ANSWER_CACHE_SECONDS === undefined ? 600 : Number(process.env.ANSWER_CACHE_SECONDS) || 0,
    // Backstop on sign-up/sign-in requests per network address. A whole campus can sit
    // behind one address, so this is high; guessing is limited per account instead.
    AUTH_PER_15_MIN: Number(process.env.AUTH_PER_15_MIN) || 3000,
    // Emails (sign-up and password codes) per day: to one address, and in total
    MAIL_PER_ADDRESS_PER_DAY: Number(process.env.MAIL_PER_ADDRESS_PER_DAY) || 8,
    MAIL_PER_DAY: Number(process.env.MAIL_PER_DAY) || 400,
    // Sign-up, resend and reset requests per network address per hour
    MAIL_PER_NETWORK_PER_HOUR: Number(process.env.MAIL_PER_NETWORK_PER_HOUR) || 120,
    // Set to 1 if student addresses contain the matriculation number (22216789@...):
    // sign-up then requires the two to agree
    MAT_IN_EMAIL: ['1', 'true'].includes(String(process.env.MAT_IN_EMAIL || '').toLowerCase()),

    // Used to resolve "today", "tomorrow" and "next class"
    TIMEZONE: process.env.TIMEZONE || 'Africa/Banjul',

    ROOT,
    DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    // The timetable database: rebuilt from DATA_DIR by the ingest script
    DB_PATH: path.resolve(process.env.DB_PATH || path.join(ROOT, 'tmp', 'utg.db')),
    // Accounts, sessions, settings and logs: cannot be rebuilt, so it is kept apart and backed up
    ACCOUNTS_DB_PATH: path.resolve(process.env.ACCOUNTS_DB_PATH || path.join(ROOT, 'var', 'accounts.db')),
    // Where `npm run backup` puts dated copies of both databases
    BACKUP_DIR: path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups')),
};

/** Every admin sign-in: the single ADMIN_USER/ADMIN_PASS pair plus ADMIN_USERS. */
export function admins() {
    const list = [...env.ADMIN_USERS];
    if (env.ADMIN_USER && env.ADMIN_PASS) list.unshift({ user: env.ADMIN_USER, pass: env.ADMIN_PASS });
    return list;
}

/**
 * What must be fixed before this configuration is safe to run for real users.
 * In production (NODE_ENV=production) the server refuses to start while any
 * problem remains; in development they are only printed.
 */
export function productionProblems() {
    const problems = [];
    if (!env.GROQ_API_KEY) problems.push('GROQ_API_KEY is not set: no question can be answered.');
    if (!admins().length) problems.push('No admin sign-in is set (ADMIN_USER and ADMIN_PASS, or ADMIN_USERS).');
    const declared = String(process.env.ADMIN_USERS || '').split(',').filter((entry) => entry.trim()).length;
    if (declared !== env.ADMIN_USERS.length) {
        problems.push('ADMIN_USERS has an entry that is not "name:password" (a password cannot contain a comma).');
    }
    for (const admin of admins()) {
        if (admin.pass.length < 12) problems.push(`The admin password for "${admin.user}" is shorter than 12 characters.`);
    }
    if (env.ORIGIN === '*') problems.push('ORIGIN is "*": set it to the address of the website, for example https://assistant.example.edu');
    if (!env.SMTP_HOST) problems.push('SMTP_HOST is not set: sign-up codes cannot be emailed.');
    if (env.DEV_SHOW_CODES) problems.push('DEV_SHOW_CODES is on: sign-up codes would be shown on screen instead of emailed.');
    return problems;
}
