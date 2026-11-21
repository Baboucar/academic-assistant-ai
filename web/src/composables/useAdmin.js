// Admin session and data. Credentials live in memory only: they are never written
// to storage, so closing or reloading the tab signs the admin out.
import { ref } from 'vue';
import {
    adminAddAlias, adminDeleteAlias, adminDeleteSource, adminGetLog, adminGetQuestions, adminGetSettings,
    adminListAliases, adminListSources, adminReingest, adminSetSemester, adminUploadFile,
} from '@/api';

const creds = ref(null); // { user, pass } once signed in
const sources = ref([]);
const counts = ref({ timetable: 0, exams: 0, calendar: 0, notices: 0, sources: 0 });
const loading = ref(false);
// { current_semester, active_semester, semesters }
const settings = ref(null);
const aliases = ref([]);
const log = ref([]);
const questions = ref(null);

function apply(data) {
    sources.value = data.sources || [];
    counts.value = { timetable: 0, exams: 0, calendar: 0, notices: 0, sources: 0, ...(data.counts || {}) };
}

function signOut() {
    creds.value = null;
    sources.value = [];
    settings.value = null;
    aliases.value = [];
    log.value = [];
    questions.value = null;
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

/** Settings, aliases, the change log and what students asked. A failure here never blocks the page. */
async function refreshExtras() {
    if (!creds.value) return;
    const load = async (target, fn, pick) => {
        try {
            target.value = pick(await guarded(() => fn(creds.value)));
        } catch {
            // leave what is showing; the main list reports connection problems
        }
    };
    await Promise.all([
        load(settings, adminGetSettings, (d) => d),
        load(aliases, adminListAliases, (d) => d.aliases || []),
        load(log, adminGetLog, (d) => d.log || []),
        load(questions, adminGetQuestions, (d) => d),
    ]);
}

/** Throws ApiError (status 401 = wrong credentials, 503 = admin not configured). */
async function signIn(user, pass) {
    const attempt = { user, pass };
    apply(await adminListSources(attempt));
    creds.value = attempt;
    refreshExtras();
}

async function refresh() {
    if (!creds.value) return;
    loading.value = true;
    try {
        apply(await guarded(() => adminListSources(creds.value)));
    } finally {
        loading.value = false;
    }
    refreshExtras();
}

/** Run a change, then reload the lists whether it worked or not (a refusal is recorded too). */
async function change(fn) {
    try {
        return await guarded(fn);
    } finally {
        await refresh().catch(() => {});
    }
}

const upload = (file, options) => change(() => adminUploadFile(creds.value, file, options));
const remove = (file, deleteFile) => change(() => adminDeleteSource(creds.value, file, deleteFile));
const reingest = (file = '', options = {}) => change(() => adminReingest(creds.value, { file, ...options }));
const setSemester = (value) => change(() => adminSetSemester(creds.value, value));
const addAlias = (alias, title) => change(() => adminAddAlias(creds.value, alias, title));
const removeAlias = (alias) => change(() => adminDeleteAlias(creds.value, alias));

export function useAdmin() {
    return {
        creds, sources, counts, loading, settings, aliases, log, questions,
        signIn, signOut, refresh, upload, remove, reingest, setSemester, addAlias, removeAlias,
    };
}
