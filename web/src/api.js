// web/src/api.js

export const API_BASE =
    import.meta.env.VITE_API_BASE?.replace(/\/+$/, '') ||
    'http://localhost:5051';

/**
 * An error the UI can show as-is: `message` is written for people, `status` is
 * the HTTP code (0 = network), `data` is the rest of the server's reply, if any.
 */
export class ApiError extends Error {
    constructor(message, status = 0, data = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.data = data;
    }
}

// ---- Student session: the token is sent on requests marked `student: true` ----
let studentToken = '';
let onSignedOut = null;

export function setStudentToken(token) {
    studentToken = token || '';
}
/** Called when the server no longer accepts the session (expired, or signed out elsewhere). */
export function onStudentSignedOut(handler) {
    onSignedOut = handler;
}

const OFFLINE = 'Could not reach the server. Check that the API is running and try again.';

async function request(path, { student = false, ...options } = {}) {
    if (student && studentToken) {
        options.headers = { ...options.headers, Authorization: `Bearer ${studentToken}` };
    }
    let r;
    try {
        r = await fetch(`${API_BASE}${path}`, options);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(OFFLINE, 0);
    }
    if (!r.ok) {
        const error = await toApiError(r);
        if (student && r.status === 401) onSignedOut?.();
        throw error;
    }
    return r;
}

async function toApiError(r) {
    let message = '';
    let data = null;
    try {
        const text = await r.text();
        try {
            data = JSON.parse(text);
            message = data?.error || '';
        } catch {
            // not JSON (a proxy error page, say): fall back to a generic message
        }
    } catch {
        // body unreadable
    }
    if (!message) {
        message = r.status >= 500 ? 'The server had a problem. Please try again.' : `Request failed (${r.status}).`;
    }
    return new ApiError(message, r.status, data);
}

const json = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** Server status: { ok, ai_configured, admin_configured, counts }. */
export async function getHealth({ signal } = {}) {
    const r = await request('/api/health', { signal });
    return r.json();
}

/**
 * Ask a question and wait for the whole answer.
 * `history` is the earlier turns ([{ role, text }]) so follow-ups work.
 * Returns { answer, matches, filters, slots }.
 */
export async function sendQuestion(question, { history = [], signal } = {}) {
    const r = await request('/api/chat', { ...json({ question, history }), signal, student: true });
    return r.json();
}

/**
 * Ask a question and receive the answer as it is written.
 * Calls onMeta({ matches, filters, slots }) once, then onChunk(text) per piece.
 * Resolves when the answer is complete; rejects with ApiError if it fails part-way.
 */
export async function sendQuestionStream(question, { history = [], signal, onMeta, onChunk } = {}) {
    const r = await request('/api/chat?stream=1', { ...json({ question, history }), signal, student: true });
    if (!r.body) throw new ApiError('This browser cannot read a streamed answer. Turn streaming off and try again.');

    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finished = false;

    const handle = (frame) => {
        for (const line of frame.split('\n')) {
            const payload = line.replace(/^data:\s?/, '').trim();
            if (!payload) continue;
            let event;
            try {
                event = JSON.parse(payload);
            } catch {
                continue; // keep-alive or partial frame
            }
            if (event.event === 'meta') onMeta?.(event);
            else if (event.event === 'chunk' && event.text) onChunk?.(event.text);
            else if (event.event === 'done') finished = true;
            else if (event.event === 'error') {
                throw new ApiError(event.message || 'The answer was interrupted. Please try again.', 502);
            }
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) handle(frame);
    }
    if (buffer.trim()) handle(buffer);
    if (!finished) throw new ApiError('The connection dropped before the answer finished. Please try again.', 0);
}

/** List of ingested files of one type (signed-in students). */
export async function listSources(type = 'timetable') {
    const r = await request(`/api/tools/list_sources/${encodeURIComponent(type)}`, { student: true });
    return r.json(); // { sources: [...] }
}

// ---------------- Student accounts ----------------
const authPost = async (path, body, options = {}) => (await request(`/api/auth${path}`, { ...json(body), ...options })).json();

/** Start a sign-up; a six-digit code is emailed. Returns { ok, email }. */
export const authRegister = (fields) => authPost('/register', fields);
/** Confirm the emailed code. Returns { token, user }. */
export const authVerify = (email, code) => authPost('/verify', { email, code });
export const authResend = (email) => authPost('/resend', { email });
/**
 * Sign in with an email or matriculation number. Returns { token, user }.
 * Rejects with status 403 and data.needs_verification when the email is not confirmed yet.
 */
export const authLogin = (identifier, password) => authPost('/login', { identifier, password });
export const authForgot = (email) => authPost('/forgot', { email });
/** Choose a new password with the emailed code. Returns { token, user }. */
export const authReset = (email, code, password) => authPost('/reset', { email, code, password });
export const authLogout = () => authPost('/logout', {}, { student: true });
/** The signed-in student: { user }. */
export async function authMe() {
    const r = await request('/api/auth/me', { student: true });
    return r.json();
}

// ---------------- Admin API (Basic Auth) ----------------
function authHeader(creds) {
    if (!creds?.user || !creds?.pass) return {};
    // btoa only takes Latin-1: encode first so any password works
    const bytes = new TextEncoder().encode(`${creds.user}:${creds.pass}`);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return { Authorization: `Basic ${btoa(binary)}` };
}

/** { sources: [{ type, source_file, semester, ingested_at, row_count }], counts } */
export async function adminListSources(creds) {
    const r = await request('/api/admin/sources', { headers: authHeader(creds) });
    return r.json();
}

/** Upload a file. Returns { ok, file, type, semester, ingest: { ok, log } | null }. */
export async function adminUploadFile(creds, file, { type = 'timetable', semester = '', dept = '', reingest = true, force = false } = {}) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('type', type);
    fd.append('semester', semester);
    fd.append('dept', dept);
    fd.append('reingest', reingest ? '1' : '0');
    // replace the rows already loaded even if this version reads far fewer
    if (force) fd.append('force', '1');
    const r = await request('/api/admin/upload', { method: 'POST', headers: authHeader(creds), body: fd });
    return r.json();
}

export async function adminDeleteSource(creds, file, deleteFile = false) {
    const r = await request(
        `/api/admin/source/${encodeURIComponent(file)}?deleteFile=${deleteFile ? '1' : '0'}`,
        { method: 'DELETE', headers: authHeader(creds) },
    );
    return r.json();
}

/** Re-ingest one file, or everything in data/ when `file` is empty. Returns { ok, log }. */
export async function adminReingest(creds, { file = '', semester = '', force = false } = {}) {
    const init = json({ file, semester, force });
    const r = await request('/api/admin/reingest', { ...init, headers: { ...init.headers, ...authHeader(creds) } });
    return r.json();
}

async function adminJson(creds, path, { method = 'GET', body } = {}) {
    const init = body === undefined ? { method, headers: {} } : { ...json(body), method };
    const r = await request(`/api/admin${path}`, { ...init, headers: { ...init.headers, ...authHeader(creds) } });
    return r.json();
}

/** { current_semester (pinned, "*" = all, null = automatic), active_semester, semesters: [{ semester, files }] } */
export const adminGetSettings = (creds) => adminJson(creds, '/settings');
export const adminSetSemester = (creds, current_semester) => adminJson(creds, '/settings', { method: 'PUT', body: { current_semester } });

/** Other names for a course: { aliases: [{ alias, title }] } */
export const adminListAliases = (creds) => adminJson(creds, '/aliases');
export const adminAddAlias = (creds, alias, title) => adminJson(creds, '/aliases', { method: 'POST', body: { alias, title } });
export const adminDeleteAlias = (creds, alias) => adminJson(creds, `/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' });

/** Who changed what: { log: [{ at, admin, action, target, detail }] } */
export const adminGetLog = (creds) => adminJson(creds, '/log?limit=30');
/** What students asked lately: { questions, model_calls, cached, totals, unanswered: [{ question, outcome, times, last_at }] } */
export const adminGetQuestions = (creds, days = 7) => adminJson(creds, `/questions?days=${days}`);
