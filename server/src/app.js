// server/src/app.js — builds the Express app (index.js starts it; tests import it)
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';

import { health } from './routes/health.js';
import { tools } from './routes/tools.js';
import { chat } from './routes/chat.js';
import { admin } from './routes/admin.js';
import { auth } from './routes/auth.js';
import { requireUser } from './middleware/requireUser.js';
import { adminAuth } from './middleware/adminAuth.js';
import { errorMiddleware } from './errors.js';

export function createApp() {
    const app = express();
    app.disable('x-powered-by');
    if (env.TRUST_PROXY) app.set('trust proxy', 1);

    // middlewares
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
    app.use(cors({ origin: env.ORIGIN }));
    app.use(express.json({ limit: '200kb' }));

    // tiny request logger with timing (no external deps)
    if (process.env.NODE_ENV !== 'test') {
        app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                console.log(`${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - start}ms`);
            });
            next();
        });
    }

    const limiter = (options) =>
        rateLimit({
            standardHeaders: 'draft-7',
            legacyHeaders: false,
            ...options,
            message: { error: options.message },
        });

    // Each chat question costs two model calls, and the AI allowance is shared by
    // everyone. Questions are counted per signed-in student, not per network, so a
    // whole campus behind one address is not treated as one person.
    const perStudent = (req) => `student:${req.user.id}`;
    const chatMinuteLimiter = limiter({
        windowMs: 60 * 1000,
        limit: env.CHAT_PER_MINUTE,
        keyGenerator: perStudent,
        message: 'Too many questions in a short time. Please wait a minute and try again.',
    });
    const chatDayLimiter = limiter({
        windowMs: 24 * 60 * 60 * 1000,
        limit: env.CHAT_PER_DAY,
        keyGenerator: perStudent,
        message: "You have reached today's question limit. Please come back tomorrow.",
    });
    // Backstop for sign-up and sign-in; wrong passwords and codes are also counted per account.
    const authLimiter = limiter({
        windowMs: 15 * 60 * 1000,
        limit: 300,
        message: 'Too many attempts from this network. Please try again later.',
    });
    // Slow down password guessing: only rejected sign-ins count.
    const adminLimiter = limiter({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        skipSuccessfulRequests: true,
        requestWasSuccessful: (req, res) => res.statusCode !== 401,
        message: 'Too many failed attempts. Please try again later.',
    });

    // routes
    app.use('/api/health', health);
    app.use('/api/auth', authLimiter, auth);
    app.use('/api/tools', requireUser, tools);
    app.use('/api/chat', requireUser, chatMinuteLimiter, chatDayLimiter);
    app.use('/api', chat);
    app.use('/api/admin', adminLimiter, adminAuth, admin);

    app.use((req, res) => res.status(404).json({ error: 'Not found' }));

    // Centralized error handler
    app.use(errorMiddleware);

    return app;
}
