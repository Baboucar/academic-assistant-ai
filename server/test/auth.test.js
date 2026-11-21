import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let ctx;
let outbox;
before(async () => {
    ctx = await setup();
    ({ outbox } = await import('../src/auth/mailer.js'));
});
after(async () => { await ctx.close(); });
beforeEach(() => { outbox.length = 0; });

const anon = {};
const post = (path, body) => ctx.post(`/api/auth${path}`, body, anon);
const codeIn = (mail) => mail.text.match(/\b(\d{6})\b/)[1];
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Register and confirm a student; returns { token, user }. */
async function signUp(mat, email, password = 'correct horse') {
    const r = await post('/register', { mat_number: mat, email, password });
    assert.equal(r.status, 201);
    const verified = await post('/verify', { email, code: codeIn(outbox.at(-1)) });
    assert.equal(verified.status, 200);
    return verified.json();
}

test('sign-up emails a code, and the code opens a session that can chat', async () => {
    const r = await post('/register', { mat_number: ' 2221 6001 ', email: 'Awa@UTG.edu', password: 'correct horse' });
    assert.equal(r.status, 201);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'awa@utg.edu');
    // the code travels only by email unless the local test switch is on
    assert.equal((await r.json()).dev_code, undefined);

    // not usable before the email is confirmed
    const early = await post('/login', { identifier: 'awa@utg.edu', password: 'correct horse' });
    assert.equal(early.status, 403);
    assert.equal((await early.json()).needs_verification, true);

    const verified = await post('/verify', { email: 'awa@utg.edu', code: codeIn(outbox[0]) });
    assert.equal(verified.status, 200);
    const { token, user } = await verified.json();
    assert.deepEqual({ mat: user.mat_number, email: user.email }, { mat: '22216001', email: 'awa@utg.edu' });

    const me = await ctx.get('/api/auth/me', bearer(token));
    assert.equal((await me.json()).user.mat_number, '22216001');
    const chat = await ctx.post('/api/chat', { question: 'hello' }, bearer(token));
    assert.equal(chat.status, 200);

    // a code works once
    assert.notEqual((await post('/verify', { email: 'awa@utg.edu', code: codeIn(outbox[0]) })).status, 200);
});

test('only university addresses and plausible matriculation numbers may register', async () => {
    const cases = [
        [{ mat_number: '22216002', email: 'someone@gmail.com', password: 'correct horse' }, /@utg\.edu/],
        [{ mat_number: '22216002', email: 'someone@utg.edu.evil.com', password: 'correct horse' }, /@utg\.edu/],
        [{ mat_number: '22216002', email: 'someone@sub.utg.edu', password: 'correct horse' }, /@utg\.edu/],
        [{ mat_number: 'x', email: 'someone@utg.edu', password: 'correct horse' }, /matriculation/],
        [{ mat_number: "1' OR '1'='1", email: 'someone@utg.edu', password: 'correct horse' }, /matriculation/],
        [{ mat_number: '22216002', email: 'someone@utg.edu', password: 'short' }, /8 characters/],
    ];
    for (const [body, message] of cases) {
        const r = await post('/register', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match((await r.json()).error, message);
    }
    assert.equal(outbox.length, 0);
});

test('a confirmed account cannot be registered again, by email or by matriculation number', async () => {
    await signUp('22216003', 'lamin@utg.edu');
    const sameEmail = await post('/register', { mat_number: '22219999', email: 'lamin@utg.edu', password: 'another pass' });
    assert.equal(sameEmail.status, 409);
    const sameMat = await post('/register', { mat_number: '22216003', email: 'other@utg.edu', password: 'another pass' });
    assert.equal(sameMat.status, 409);
});

test('wrong codes are limited, and passwords and codes are stored only as hashes', async () => {
    await post('/register', { mat_number: '22216004', email: 'fatou@utg.edu', password: 'correct horse' });
    const real = codeIn(outbox.at(-1));
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
        assert.equal((await post('/verify', { email: 'fatou@utg.edu', code: wrong })).status, 400);
    }
    // even the right code is refused after five misses
    const locked = await post('/verify', { email: 'fatou@utg.edu', code: real });
    assert.equal(locked.status, 400);
    assert.match((await locked.json()).error, /new code/i);

    const user = ctx.accountsDb.prepare(`SELECT * FROM users WHERE email = 'fatou@utg.edu'`).get();
    assert.ok(!user.password_hash.includes('correct horse'));
    const stored = ctx.accountsDb.prepare(`SELECT code_hash FROM email_codes WHERE user_id = ?`).get(user.id);
    assert.notEqual(stored.code_hash, real);

    // asking again straight away does not send a second email
    const before = outbox.length;
    assert.equal((await post('/resend', { email: 'fatou@utg.edu' })).status, 429);
    assert.equal(outbox.length, before);
});

test('sign in with email or matriculation number; sign out ends the session', async () => {
    await signUp('22216005', 'musa@utg.edu');

    const byMat = await post('/login', { identifier: '22216005', password: 'correct horse' });
    assert.equal(byMat.status, 200);
    const { token } = await byMat.json();
    assert.equal((await post('/login', { identifier: 'MUSA@utg.edu', password: 'correct horse' })).status, 200);

    const bad = await post('/login', { identifier: 'musa@utg.edu', password: 'wrong password' });
    const unknown = await post('/login', { identifier: 'nobody@utg.edu', password: 'wrong password' });
    assert.equal(bad.status, 401);
    assert.equal(unknown.status, 401);
    // the reply does not say whether the account exists
    assert.equal((await bad.json()).error, (await unknown.json()).error);

    assert.equal((await ctx.post('/api/auth/logout', {}, bearer(token))).status, 200);
    assert.equal((await ctx.get('/api/auth/me', bearer(token))).status, 401);
});

test('repeated wrong passwords lock the account for a while', async () => {
    await signUp('22216006', 'isatou@utg.edu');
    for (let i = 0; i < 8; i++) {
        assert.equal((await post('/login', { identifier: 'isatou@utg.edu', password: `guess ${i}` })).status, 401);
    }
    const locked = await post('/login', { identifier: 'isatou@utg.edu', password: 'correct horse' });
    assert.equal(locked.status, 429);
    assert.match((await locked.json()).error, /minute/);
});

test('password reset needs the emailed code and signs other devices out', async () => {
    const { token: oldToken } = await signUp('22216007', 'ousman@utg.edu');

    // same reply for an address with no account, and nothing is sent
    const before = outbox.length;
    assert.equal((await post('/forgot', { email: 'ghost@utg.edu' })).status, 200);
    assert.equal(outbox.length, before);

    assert.equal((await post('/forgot', { email: 'ousman@utg.edu' })).status, 200);
    const code = codeIn(outbox.at(-1));
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await post('/reset', { email: 'ousman@utg.edu', code: wrong, password: 'brand new pass' })).status, 400);

    const reset = await post('/reset', { email: 'ousman@utg.edu', code, password: 'brand new pass' });
    assert.equal(reset.status, 200);
    assert.equal((await ctx.get('/api/auth/me', bearer(oldToken))).status, 401);
    assert.equal((await post('/login', { identifier: 'ousman@utg.edu', password: 'correct horse' })).status, 401);
    assert.equal((await post('/login', { identifier: 'ousman@utg.edu', password: 'brand new pass' })).status, 200);
});

test('one mailbox cannot hold several accounts through "+" addresses', async () => {
    const r = await post('/register', { mat_number: '22216020', email: 'awa+second@utg.edu', password: 'correct horse' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /without a "\+"/);
    assert.equal(outbox.length, 0);
});

test('an address cannot be sent more than a few emails a day, however the requests are spaced', async () => {
    await post('/register', { mat_number: '22216021', email: 'flooded@utg.edu', password: 'correct horse' });
    const user = ctx.accountsDb.prepare(`SELECT id FROM users WHERE email = 'flooded@utg.edu'`).get();
    // pretend a minute passes between requests, so only the daily allowance is in play
    const wait = () => ctx.accountsDb.prepare(`UPDATE email_codes SET sent_at = sent_at - 120000 WHERE user_id = ?`).run(user.id);

    let statuses = [];
    for (let i = 0; i < 6; i++) {
        wait();
        statuses.push((await post('/resend', { email: 'flooded@utg.edu' })).status);
    }
    // the test allowance is 5 a day: 1 at sign-up, then 4 more, then refused
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
    assert.equal(outbox.filter((m) => m.to === 'flooded@utg.edu').length, 5);
});

