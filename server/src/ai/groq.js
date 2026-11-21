// Thin client for the chat completions endpoint (Groq, or any OpenAI-compatible API).
import { env } from '../env.js';
import { HttpError } from '../errors.js';

// Free tiers have small per-minute limits. When the provider says "busy, retry in
// a moment", wait and retry rather than failing the question, as long as the
// wait is short.
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 8000;

function retryWaitMs(r) {
    const seconds = Number(r.headers.get('retry-after'));
    if (!r.headers.has('retry-after') || !Number.isFinite(seconds) || seconds < 0) return 2000;
    return Math.ceil(seconds * 1000) + 250;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// How the provider has been doing lately, for /api/health and the operator.
const health = { lastOkAt: 0, lastErrorAt: 0, lastError: '', lastErrorStatus: 0 };
const noteOk = () => { health.lastOkAt = Date.now(); };
function noteError(status, message) {
    health.lastErrorAt = Date.now();
    health.lastErrorStatus = status;
    health.lastError = String(message || '').slice(0, 200);
}

/**
 * 'ok' | 'busy' (rate-limited) | 'down' (failing) | 'unknown' (not used yet, or not for a while).
 * Based on the most recent calls; nothing is sent to the provider to find out.
 */
export function aiStatus() {
    const recent = 5 * 60 * 1000;
    const now = Date.now();
    let state = 'unknown';
    if (health.lastErrorAt > health.lastOkAt && now - health.lastErrorAt < recent) {
        state = health.lastErrorStatus === 429 ? 'busy' : 'down';
    } else if (health.lastOkAt && now - health.lastOkAt < recent) {
        state = 'ok';
    }
    return {
        state,
        last_ok_at: health.lastOkAt || null,
        last_error_at: health.lastErrorAt || null,
        // the status only: the provider's message can name the account and its limits,
        // and this is public. The full message is in the server log.
        last_error_status: health.lastErrorAt ? health.lastErrorStatus : null,
    };
}

async function post(body, signal) {
    try {
        return await fetch(`${env.GROQ_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.GROQ_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: env.MODEL, ...body }),
            signal,
        });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        console.error('Model request failed:', e?.message || e);
        noteError(0, e?.message || 'network error');
        throw new HttpError(502, 'Could not reach the AI model. Please try again.');
    }
}

async function request(body, signal) {
    if (!env.GROQ_API_KEY) {
        throw new HttpError(503, 'The AI model is not configured. Set GROQ_API_KEY in server/.env');
    }

    let r = await post(body, signal);
    for (let attempt = 0; r.status === 429 && attempt < MAX_RETRIES; attempt++) {
        const wait = retryWaitMs(r);
        if (wait > MAX_RETRY_WAIT_MS) break;
        await r.body?.cancel().catch(() => {});
        await sleep(wait, signal);
        r = await post(body, signal);
    }

    if (!r.ok) {
        const text = await r.text().catch(() => '');
        console.error(`Model error ${r.status}: ${text.slice(0, 500)}`);
        noteError(r.status, text.slice(0, 200));
        if (r.status === 429) throw new HttpError(429, 'The AI model is busy right now. Please try again in a moment.');
        if (r.status === 401) throw new HttpError(503, 'The AI model rejected the API key. Check GROQ_API_KEY.');
        // providers retire models; a 404 here means MODEL names one that is gone
        if (r.status === 404) throw new HttpError(503, `The AI model "${env.MODEL}" is not available. Check MODEL in server/.env`);
        throw new HttpError(502, 'The AI model returned an error. Please try again.');
    }
    noteOk();
    return r;
}

/** One-shot completion. Returns the message text. */
export async function complete(messages, { temperature = 0.2, signal } = {}) {
    const r = await request({ messages, temperature }, signal);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || '';
}

/** Streaming completion. Yields text deltas as they arrive. */
export async function* completeStream(messages, { temperature = 0.2, signal } = {}) {
    const r = await request({ messages, temperature, stream: true }, signal);
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
                if (delta) yield delta;
            } catch {
                // ignore keep-alives and partial frames
            }
        }
    }
}
