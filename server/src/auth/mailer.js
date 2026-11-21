// Outgoing email (sign-up and password-reset codes).
// With SMTP_HOST set, mail goes out through that server. Without it, the message
// is printed in the server log so the app can be tried before email is set up.
import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { HttpError } from '../errors.js';

/** Messages "sent" during tests, newest last. */
export const outbox = [];

export const mailConfigured = () => Boolean(env.SMTP_HOST);

let transport = null;
function getTransport() {
    transport ||= nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    return transport;
}

export async function sendMail({ to, subject, text }) {
    if (process.env.NODE_ENV === 'test') {
        outbox.push({ to, subject, text });
        return;
    }
    if (!mailConfigured()) {
        console.log(`[email is not set up: printing instead]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
        return;
    }
    try {
        await getTransport().sendMail({
            from: env.MAIL_FROM,
            to,
            subject,
            text,
            signal: AbortSignal.timeout(20_000),
        });
    } catch (e) {
        console.error('Email could not be sent:', e?.message || e);
        throw new HttpError(502, 'We could not send the email. Please try again in a moment.');
    }
}
