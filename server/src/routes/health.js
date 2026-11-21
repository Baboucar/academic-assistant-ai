import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { admins, env } from '../env.js';
import { activeSemester, Queries } from '../db/queries.js';
import { aiStatus } from '../ai/groq.js';

export const health = Router();

let version = 'unknown';
try {
    version = JSON.parse(fs.readFileSync(path.join(env.ROOT, 'server', 'package.json'), 'utf8')).version || version;
} catch {
    // not fatal: the version is only informational
}

// GET /api/health
// For the web client (is there anything to ask about yet? which email addresses
// may register?) and for whoever runs the server: `ai.state` is 'ok', 'busy'
// (rate-limited), 'down' or 'unknown', from the most recent model calls.
health.get('/', (_req, res) => {
    let counts = null;
    let semester = null;
    try {
        counts = Queries.counts();
        semester = activeSemester();
    } catch {
        // database not readable: report it rather than fail the health check
    }
    res.json({
        ok: true,
        ts: Date.now(),
        version: process.env.GIT_SHA ? `${version}+${process.env.GIT_SHA.slice(0, 7)}` : version,
        mode: env.PRODUCTION ? 'production' : 'development',
        ai_configured: Boolean(env.GROQ_API_KEY),
        ai: aiStatus(),
        admin_configured: admins().length > 0,
        email_domains: env.STUDENT_EMAIL_DOMAINS,
        semester,
        counts,
    });
});
