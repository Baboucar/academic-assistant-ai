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

export const env = {
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

    // Used to resolve "today", "tomorrow" and "next class"
    TIMEZONE: process.env.TIMEZONE || 'Africa/Banjul',

    ROOT,
    DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    DB_PATH: path.resolve(process.env.DB_PATH || path.join(ROOT, 'tmp', 'utg.db')),
};
