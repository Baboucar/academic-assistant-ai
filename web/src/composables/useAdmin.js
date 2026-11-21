// Admin session and data. Credentials live in memory only: they are never written
// to storage, so closing or reloading the tab signs the admin out.
import { ref } from 'vue';
import { adminDeleteSource, adminListSources, adminReingest, adminUploadFile } from '@/api';

const creds = ref(null); // { user, pass } once signed in
const sources = ref([]);
const counts = ref({ timetable: 0, exams: 0, calendar: 0, notices: 0, sources: 0 });
const loading = ref(false);

function apply(data) {
    sources.value = data.sources || [];
    counts.value = { timetable: 0, exams: 0, calendar: 0, notices: 0, sources: 0, ...(data.counts || {}) };
}

function signOut() {
    creds.value = null;
    sources.value = [];
}

/** Run an admin call; a 401 means the password changed or the session is stale. */
async function guarded(fn) {
    try {
        return await fn();
    } catch (e) {
        if (e?.status === 401) signOut();
        throw e;
    }
}

/** Throws ApiError (status 401 = wrong credentials, 503 = admin not configured). */
async function signIn(user, pass) {
    const attempt = { user, pass };
    apply(await adminListSources(attempt));
    creds.value = attempt;
}

async function refresh() {
    if (!creds.value) return;
    loading.value = true;
    try {
        apply(await guarded(() => adminListSources(creds.value)));
    } finally {
        loading.value = false;
    }
}

async function upload(file, options) {
    const result = await guarded(() => adminUploadFile(creds.value, file, options));
    await refresh();
    return result;
}

async function remove(file, deleteFile) {
    const result = await guarded(() => adminDeleteSource(creds.value, file, deleteFile));
    await refresh();
    return result;
}

async function reingest(file = '') {
    const result = await guarded(() => adminReingest(creds.value, { file }));
    await refresh();
    return result;
}

export function useAdmin() {
    return { creds, sources, counts, loading, signIn, signOut, refresh, upload, remove, reingest };
}
