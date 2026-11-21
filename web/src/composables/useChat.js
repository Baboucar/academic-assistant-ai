// Chat state: the signed-in student's conversations. Kept at module level so it
// survives moving between screens, and saved in localStorage (one list per
// student) so it survives a reload.
import { computed, ref, watch } from 'vue';
import { sendQuestion, sendQuestionStream } from '@/api';
import { useAuth } from '@/composables/useAuth';

const STORAGE_PREFIX = 'utg-chats-v2:';
const SETTINGS_KEY = 'utg-chat-settings-v1';
const MAX_CONVERSATIONS = 30;
const MAX_SAVED_MESSAGES = 60;
const TITLE_LENGTH = 60;
// How many earlier messages go to the server so follow-ups make sense
const HISTORY_MESSAGES = 6;

// crypto.randomUUID needs HTTPS; a campus deployment may be plain HTTP
let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function cleanMessages(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .map((m) => ({
            id: String(m.id || newId()),
            role: m.role,
            text: m.text,
            // an answer that was mid-flight when the page closed never finished
            status: m.status === 'pending' || m.status === 'streaming' ? 'stopped' : m.status || 'done',
            sources: Array.isArray(m.sources) ? m.sources : [],
            filters: m.filters || null,
            // the rows are shown as a schedule and the text only summarises them
            schedule: Boolean(m.schedule),
            // choices offered when the assistant asked "which department?"
            choices: Array.isArray(m.choices) ? m.choices.filter((c) => typeof c === 'string') : [],
            error: m.error || '',
        }));
}

function loadConversations(userId) {
    if (userId == null) return [];
    const saved = readJson(STORAGE_PREFIX + userId, []);
    if (!Array.isArray(saved)) return [];
    return saved
        .filter((c) => c && Array.isArray(c.messages))
        .map((c) => ({
            id: String(c.id || newId()),
            title: String(c.title || 'Untitled chat').slice(0, TITLE_LENGTH),
            updatedAt: Number(c.updatedAt) || 0,
            messages: cleanMessages(c.messages),
        }))
        .filter((c) => c.messages.length);
}

const { user } = useAuth();

/** Conversations, most recently used first. */
const conversations = ref(loadConversations(user.value?.id));
/** The open conversation, or null for a new chat that has no messages yet. */
const activeId = ref(null);
const busy = ref(false);
const streaming = ref(readJson(SETTINGS_KEY, {}).streaming !== false);
let aborter = null;

const NO_MESSAGES = [];
const active = computed(() => conversations.value.find((c) => c.id === activeId.value) || null);
const messages = computed(() => active.value?.messages ?? NO_MESSAGES);

function save() {
    if (user.value?.id == null) return;
    try {
        const trimmed = conversations.value
            .slice(0, MAX_CONVERSATIONS)
            .map((c) => ({ ...c, messages: c.messages.slice(-MAX_SAVED_MESSAGES) }));
        localStorage.setItem(STORAGE_PREFIX + user.value.id, JSON.stringify(trimmed));
    } catch {
        // storage full or blocked: the chat still works, it just is not remembered
    }
}

// Signing in or out swaps in that student's chats
watch(
    () => user.value?.id,
    (id) => {
        aborter?.abort();
        conversations.value = loadConversations(id);
        activeId.value = null;
    },
);

watch(streaming, (value) => {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ streaming: value }));
    } catch {
        // ignore
    }
});

const lastUserIndex = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
        if (messages.value[i].role === 'user') return i;
    }
    return -1;
});

/** Earlier turns worth sending as context: real text only, no failed answers. */
function historyFor(list) {
    return list
        .filter((m) => m.text.trim() && m.status !== 'error')
        .slice(-HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
}

function titleFrom(text) {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

/**
 * Ask a question in the open conversation (starting one if needed). Resolves
 * with the assistant message once it has finished, failed or been stopped;
 * resolves with null if nothing was sent.
 */
async function send(question) {
    const text = String(question || '').trim();
    if (!text || busy.value) return null;

    if (!active.value) {
        const id = newId();
        conversations.value.unshift({ id, title: titleFrom(text), updatedAt: Date.now(), messages: [] });
        activeId.value = id;
    } else if (conversations.value[0] !== active.value) {
        // most recently used first
        conversations.value = [active.value, ...conversations.value.filter((c) => c !== active.value)];
    }
    // read it back through the ref so later writes are reactive
    const conversation = active.value;
    conversation.updatedAt = Date.now();

    const history = historyFor(conversation.messages);
    conversation.messages.push({ id: newId(), role: 'user', text, status: 'done', sources: [], filters: null, schedule: false, choices: [], error: '' });
    conversation.messages.push({ id: newId(), role: 'assistant', text: '', status: 'pending', sources: [], filters: null, schedule: false, choices: [], error: '' });
    const answer = conversation.messages[conversation.messages.length - 1];

    busy.value = true;
    aborter = new AbortController();
    const { signal } = aborter;
    save();

    try {
        if (streaming.value) {
            await sendQuestionStream(text, {
                history,
                signal,
                onMeta: (meta) => {
                    answer.sources = meta.matches || [];
                    answer.filters = meta.filters || null;
                    answer.schedule = Boolean(meta.schedule);
                    answer.choices = meta.clarify?.options || [];
                },
                onChunk: (chunk) => {
                    answer.status = 'streaming';
                    answer.text += chunk;
                },
            });
        } else {
            const res = await sendQuestion(text, { history, signal });
            answer.text = res.answer || '';
            answer.sources = res.matches || [];
            answer.filters = res.filters || null;
            answer.schedule = Boolean(res.schedule);
            answer.choices = res.clarify?.options || [];
        }
        if (!answer.text.trim()) answer.text = 'I could not find it.';
        answer.status = 'done';
    } catch (e) {
        if (e?.name === 'AbortError') {
            answer.status = 'stopped';
        } else {
            answer.status = 'error';
            answer.error = e?.message || 'Something went wrong. Please try again.';
        }
    } finally {
        busy.value = false;
        aborter = null;
        save();
    }
    return answer;
}

function stop() {
    aborter?.abort();
}

/** Remove the last question and everything after it; returns the question text. */
function takeLastQuestion() {
    if (busy.value || lastUserIndex.value === -1) return '';
    const [question] = active.value.messages.splice(lastUserIndex.value);
    save();
    return question.text;
}

/** Ask the last question again (after an error, a stop, or for a second try). */
function retry() {
    const text = takeLastQuestion();
    return text ? send(text) : Promise.resolve(null);
}

/** Start a blank chat. It joins the list once the first question is asked. */
function newChat() {
    stop();
    activeId.value = null;
}

function openChat(id) {
    if (id === activeId.value) return;
    stop();
    activeId.value = conversations.value.some((c) => c.id === id) ? id : null;
}

/** Delete a conversation. Returns a function that puts it back (for "Undo"). */
function deleteChat(id) {
    const index = conversations.value.findIndex((c) => c.id === id);
    if (index === -1) return () => {};
    const wasActive = activeId.value === id;
    if (wasActive) newChat();
    const [removed] = conversations.value.splice(index, 1);
    save();
    return () => {
        if (conversations.value.some((c) => c.id === removed.id)) return;
        conversations.value.splice(Math.min(index, conversations.value.length), 0, removed);
        save();
    };
}

export function useChat() {
    return {
        conversations, activeId, active, messages, busy, streaming, lastUserIndex,
        send, stop, retry, takeLastQuestion, newChat, openChat, deleteChat,
    };
}

/** Test helper: drop in-memory state and re-read storage. */
export function resetChatForTests() {
    aborter = null;
    busy.value = false;
    conversations.value = loadConversations(user.value?.id);
    activeId.value = null;
    streaming.value = readJson(SETTINGS_KEY, {}).streaming !== false;
}
