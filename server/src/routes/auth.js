// Student accounts: matriculation number + university email + password.
// Mounted at /api/auth. The email address is confirmed with a six-digit code.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/connect.js';
import { env } from '../env.js';
import { HttpError, wrap } from '../errors.js';
import { mailConfigured, sendMail } from '../auth/mailer.js';
import { requireUser } from '../middleware/requireUser.js';
import {
    burnPasswordCheck, hashPassword, newCode, newToken, sameHash, sha256, verifyPassword,
} from '../auth/crypto.js';

export const auth = Router();

const MINUTE = 60 * 1000;
const CODE_TTL = 15 * MINUTE;
const RESEND_COOLDOWN = MINUTE;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_TTL = 30 * 24 * 60 * MINUTE;
const MAX_FAILED_LOGINS = 8;
const LOCK_TIME = 15 * MINUTE;

const BAD_CODE = 'That code is not right. Check the email and try again.';
const BAD_LOGIN = 'Wrong email, matriculation number or password.';

// ---------- input ----------
const domains = env.STUDENT_EMAIL_DOMAINS;
const domainList = domains.map((d) => `@${d}`).join(' or ');
const matPattern = new RegExp(env.MAT_NUMBER_PATTERN);

const Email = z
    .string({ required_error: 'Email is required' })
    .trim()
    .toLowerCase()
    .max(254)
    .email('Enter a valid email address');
const StudentEmail = Email.refine((e) => domains.includes(e.split('@')[1]), {
    message: `Use your ${domainList} email address`,
});
const MatNumber = z.preprocess(
    (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase(),
    z.string().regex(matPattern, 'That does not look like a matriculation number'),
);
const Password = z
    .string({ required_error: 'Password is required' })
    .min(8, 'Use at least 8 characters for the password')
    .max(200, 'That password is too long');
const Code = z.preprocess((v) => String(v ?? '').replace(/\D/g, ''), z.string().length(6, BAD_CODE));

function parse(schema, body) {
    const result = schema.safeParse(body || {});
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request');
    return result.data;
}

// ---------- storage ----------
const q = {
    byEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    byMat: db.prepare(`SELECT * FROM users WHERE mat_number = ?`),
    insert: db.prepare(
        `INSERT INTO users (mat_number, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    ),
    remove: db.prepare(`DELETE FROM users WHERE id = ?`),
    verify: db.prepare(`UPDATE users SET verified_at = ? WHERE id = ?`),
    setPassword: db.prepare(
        `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`,
    ),
    failLogin: db.prepare(`UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`),
    clearFails: db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`),

    getCode: db.prepare(`SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?`),
    putCode: db.prepare(`
      INSERT INTO email_codes (user_id, purpose, code_hash, attempts, sent_at, expires_at)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(user_id, purpose) DO UPDATE
        SET code_hash = excluded.code_hash, attempts = 0,
            sent_at = excluded.sent_at, expires_at = excluded.expires_at`),
    missCode: db.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?`),
    dropCode: db.prepare(`DELETE FROM email_codes WHERE user_id = ? AND purpose = ?`),

    addSession: db.prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    ),
    dropSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    dropUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
    dropExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
};

const publicUser = (u) => ({ id: u.id, mat_number: u.mat_number, email: u.email });

function startSession(user) {
    const now = Date.now();
    const token = newToken();
    q.dropExpiredSessions.run(now);
    q.addSession.run(sha256(token), user.id, now, now + SESSION_TTL);
    return { token, user: publicUser(user) };
}

// ---------- emailed codes ----------
const EMAILS = {
    verify: (code) => ({
        subject: `${code} is your UTG Academic Assistant code`,
        text:
            `Your code is ${code}\n\n` +
            `Enter it in the UTG Academic Assistant to confirm your email address. ` +
            `It works for 15 minutes.\n\nIf you did not create an account, ignore this email.`,
    }),
    reset: (code) => ({
        subject: `${code} is your UTG Academic Assistant password code`,
        text:
            `Your code is ${code}\n\n` +
            `Enter it in the UTG Academic Assistant to choose a new password. ` +
            `It works for 15 minutes.\n\nIf you did not ask for this, ignore this email: your password has not changed.`,
    }),
};

/** Email a fresh code and return it. Returns null (and sends nothing) if one went out in the last minute. */
async function sendCode(user, purpose) {
    const now = Date.now();
    const last = q.getCode.get(user.id, purpose);
    if (last && now - last.sent_at < RESEND_COOLDOWN) return null;

    const code = newCode();
    q.putCode.run(user.id, purpose, sha256(code), now, now + CODE_TTL);
    await sendMail({ to: user.email, ...EMAILS[purpose](code) });
    return code;
}

/**
 * Local testing without an email server: DEV_SHOW_CODES=1 puts the code in the
 * reply so the sign-up screen can show it. Off unless switched on, and ignored
 * once SMTP is configured.
 */
const devCode = (code) => (env.DEV_SHOW_CODES && !mailConfigured() && code ? { dev_code: code } : {});

/** Throws unless `code` is the live code for this user and purpose. Uses it up on success. */
function useCode(user, purpose, code) {
    const row = user ? q.getCode.get(user.id, purpose) : null;
    if (!row) throw new HttpError(400, BAD_CODE);
    if (row.expires_at < Date.now()) throw new HttpError(400, 'That code has expired. Ask for a new one.');
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
        throw new HttpError(400, 'Too many wrong tries. Ask for a new code.');
    }
    if (!sameHash(sha256(code), row.code_hash)) {
        q.missCode.run(user.id, purpose);
        throw new HttpError(400, BAD_CODE);
    }
    q.dropCode.run(user.id, purpose);
}

// ---------- routes ----------

// POST /api/auth/register { mat_number, email, password } -> emails a code
auth.post(
    '/register',
    wrap(async (req, res) => {
        const { mat_number, email, password } = parse(
            z.object({ mat_number: MatNumber, email: StudentEmail, password: Password }),
            req.body,
        );

        const sameEmail = q.byEmail.get(email);
        const sameMat = q.byMat.get(mat_number);
        if (sameEmail?.verified_at || sameMat?.verified_at) {
            throw new HttpError(409, 'An account with that email or matriculation number already exists. Sign in instead.');
        }

        // An unconfirmed sign-up reserves nothing: it is replaced by the new one,
        // but the same address is not emailed more than once a minute.
        const last = sameEmail && q.getCode.get(sameEmail.id, 'verify');
        if (last && Date.now() - last.sent_at < RESEND_COOLDOWN) {
            throw new HttpError(429, 'A code was just sent to that address. Please wait a minute and try again.');
        }
        const hash = await hashPassword(password);
        const id = db.transaction(() => {
            for (const stale of new Set([sameEmail?.id, sameMat?.id])) if (stale) q.remove.run(stale);
            return q.insert.run(mat_number, email, hash, Date.now()).lastInsertRowid;
        })();

        const code = await sendCode({ id, email }, 'verify');
        res.status(201).json({ ok: true, email, ...devCode(code) });
    }),
);

// POST /api/auth/verify { email, code } -> { token, user }
auth.post(
    '/verify',
    wrap(async (req, res) => {
        const { email, code } = parse(z.object({ email: Email, code: Code }), req.body);
        const user = q.byEmail.get(email);
        if (user?.verified_at) throw new HttpError(409, 'That email is already confirmed. Sign in instead.');
        useCode(user, 'verify', code);
        q.verify.run(Date.now(), user.id);
        res.json(startSession(user));
    }),
);

// POST /api/auth/resend { email } -> emails another sign-up code
auth.post(
    '/resend',
    wrap(async (req, res) => {
        const { email } = parse(z.object({ email: Email }), req.body);
        const user = q.byEmail.get(email);
        let code = null;
        if (user && !user.verified_at) {
            code = await sendCode(user, 'verify');
            if (!code) throw new HttpError(429, 'A code was just sent. Please wait a minute before asking for another.');
        }
        res.json({ ok: true, ...devCode(code) });
    }),
);

// POST /api/auth/login { identifier (email or matriculation number), password } -> { token, user }
auth.post(
    '/login',
    wrap(async (req, res) => {
        const { identifier, password } = parse(
            z.object({
                identifier: z.string({ required_error: 'Enter your email or matriculation number' }).trim().min(1).max(254),
                password: z.string({ required_error: 'Password is required' }).min(1).max(200),
            }),
            req.body,
        );
        const user = identifier.includes('@')
            ? q.byEmail.get(identifier.toLowerCase())
            : q.byMat.get(identifier.replace(/\s+/g, '').toUpperCase());

        if (!user) {
            await burnPasswordCheck(password);
            throw new HttpError(401, BAD_LOGIN);
        }
        const now = Date.now();
        if (user.locked_until && user.locked_until > now) {
            const minutes = Math.ceil((user.locked_until - now) / MINUTE);
            throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`);
        }
        if (!(await verifyPassword(password, user.password_hash))) {
            const fails = user.failed_logins + 1;
            const lock = fails >= MAX_FAILED_LOGINS;
            q.failLogin.run(lock ? 0 : fails, lock ? now + LOCK_TIME : null, user.id);
            throw new HttpError(401, BAD_LOGIN);
        }
        q.clearFails.run(user.id);

        if (!user.verified_at) {
            const code = await sendCode(user, 'verify');
            return res.status(403).json({
                error: 'Confirm your email first. We sent you a code.',
                needs_verification: true,
                email: user.email,
                ...devCode(code),
            });
        }
        res.json(startSession(user));
    }),
);

// POST /api/auth/forgot { email } -> emails a password code (same reply whether or not the account exists)
auth.post(
    '/forgot',
    wrap(async (req, res) => {
        const { email } = parse(z.object({ email: Email }), req.body);
        const user = q.byEmail.get(email);
        const code = user?.verified_at ? await sendCode(user, 'reset') : null;
        res.json({ ok: true, ...devCode(code) });
    }),
);

// POST /api/auth/reset { email, code, password } -> { token, user }; signs out other devices
auth.post(
    '/reset',
    wrap(async (req, res) => {
        const { email, code, password } = parse(
            z.object({ email: Email, code: Code, password: Password }),
            req.body,
        );
        const found = q.byEmail.get(email);
        const user = found?.verified_at ? found : null;
        useCode(user, 'reset', code);
        q.setPassword.run(await hashPassword(password), user.id);
        q.dropUserSessions.run(user.id);
        res.json(startSession(user));
    }),
);

// GET /api/auth/me -> { user }
auth.get('/me', requireUser, (req, res) => res.json({ user: req.user }));

// POST /api/auth/logout
auth.post('/logout', requireUser, (req, res) => {
    q.dropSession.run(req.sessionHash);
    res.json({ ok: true });
});
