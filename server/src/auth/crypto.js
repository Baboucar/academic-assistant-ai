// Password hashing and random secrets, using only Node's built-in crypto.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

const normal = (password) => String(password).normalize('NFKC');

/** Hash a password with a fresh salt: "scrypt$<salt>$<hash>". */
export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(normal(password), salt, KEY_LENGTH);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(normal(password), Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

// Checked when the account does not exist, so a wrong email takes as long as a wrong password
let dummyHash = null;
export async function burnPasswordCheck(password) {
    dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
    await verifyPassword(password, dummyHash);
}

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function sameHash(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Session token: only its hash is stored, so a database leak does not expose sessions. */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Six-digit code for emails. */
export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
