// The signed-in student. The session token is kept in localStorage so a reload
// (or coming back tomorrow) does not ask for the password again.
import { computed, ref } from 'vue';
import {
    authForgot, authLogin, authLogout, authMe, authRegister, authResend, authReset, authVerify,
    onStudentSignedOut, setStudentToken,
} from '@/api';

const STORAGE_KEY = 'utg-auth-v1';

function readSaved() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
        if (saved && typeof saved.token === 'string' && saved.user?.id != null) return saved;
    } catch {
        // unreadable: treat as signed out
    }
    return null;
}

const saved = readSaved();
const user = ref(saved?.user ?? null); // { id, mat_number, email }
setStudentToken(saved?.token);

const isSignedIn = computed(() => Boolean(user.value));

function setSession(session) {
    user.value = session?.user ?? null;
    setStudentToken(session?.token);
    try {
        if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: session.token, user: session.user }));
        else localStorage.removeItem(STORAGE_KEY);
    } catch {
        // storage blocked: the session still works until the tab closes
    }
}

// The server rejected the token (expired, or the password was reset elsewhere)
onStudentSignedOut(() => setSession(null));

/** Check a saved session with the server; a rejected one signs the student out. */
async function restore() {
    if (!user.value) return;
    try {
        const { user: fresh } = await authMe();
        if (fresh) user.value = fresh;
    } catch {
        // 401 is handled by onStudentSignedOut; offline keeps the saved session
    }
}

async function signIn(identifier, password) {
    setSession(await authLogin(identifier, password));
}
/** Finish a sign-up with the emailed code. */
async function verify(email, code) {
    setSession(await authVerify(email, code));
}
async function resetPassword(email, code, password) {
    setSession(await authReset(email, code, password));
}
async function signOut() {
    try {
        await authLogout();
    } catch {
        // signing out locally matters more than telling the server
    }
    setSession(null);
}

export function useAuth() {
    return {
        user,
        isSignedIn,
        restore,
        register: authRegister,
        resend: authResend,
        forgot: authForgot,
        verify,
        signIn,
        resetPassword,
        signOut,
    };
}

/** Test helper: forget the in-memory session and re-read storage. */
export function resetAuthForTests() {
    const again = readSaved();
    user.value = again?.user ?? null;
    setStudentToken(again?.token);
}
