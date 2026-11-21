import { Router } from 'express';
import { env } from '../env.js';
import { Queries } from '../db/queries.js';

export const health = Router();

// GET /api/health — also tells the web client whether there is anything to ask about yet.
health.get('/', (_req, res) => {
    let counts = null;
    try {
        counts = Queries.counts();
    } catch {
        // database not readable: report it rather than fail the health check
    }
    res.json({
        ok: true,
        ts: Date.now(),
        ai_configured: Boolean(env.GROQ_API_KEY),
        admin_configured: Boolean(env.ADMIN_USER && env.ADMIN_PASS),
        email_domains: env.STUDENT_EMAIL_DOMAINS,
        counts,
    });
});
