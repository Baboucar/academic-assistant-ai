// Requires a signed-in student: "Authorization: Bearer <session token>".
import { db } from '../db/connect.js';
import { sha256 } from '../auth/crypto.js';

const findSession = db.prepare(`
  SELECT s.token_hash, s.expires_at, u.id, u.mat_number, u.email
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND u.verified_at IS NOT NULL
`);

export function requireUser(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = token ? findSession.get(sha256(token)) : null;

    if (!session || session.expires_at < Date.now()) {
        return res.status(401).json({ error: 'Please sign in to continue.' });
    }
    req.user = { id: session.id, mat_number: session.mat_number, email: session.email };
    req.sessionHash = session.token_hash;
    next();
}
