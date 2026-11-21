// server/src/middleware/adminAuth.js
import crypto from 'node:crypto';
import { admins } from '../env.js';

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const payload = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = payload.indexOf(':');
    if (idx === -1) return null;
    return { user: payload.slice(0, idx), pass: payload.slice(idx + 1) };
  } catch {
    return null;
  }
}

// Compare without leaking, through timing, how much of the value matched.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function adminAuth(req, res, next) {
  // Require credentials to be configured
  const known = admins();
  if (!known.length) {
    return res.status(503).json({ error: 'Admin is not configured. Set ADMIN_USER and ADMIN_PASS in server/.env' });
  }

  // No WWW-Authenticate header: the web client has its own sign-in form, and the
  // header would make browsers pop up their native password dialog on top of it.
  const creds = parseBasicAuth(req.headers.authorization || '');
  if (!creds) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // check every admin, without stopping early, so timing does not reveal which name exists
  let match = null;
  for (const admin of known) {
    const userOk = safeEqual(creds.user, admin.user);
    const passOk = safeEqual(creds.pass, admin.pass);
    if (userOk && passOk) match = admin;
  }
  if (!match) return res.status(401).json({ error: 'Invalid username or password' });
  // who is signed in, for the admin log
  req.admin = match.user;
  return next();
}
