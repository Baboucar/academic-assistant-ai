// A small in-memory store of recent answers, so the same question from many
// students ("What classes are on today?") is worked out once.
import { env } from '../env.js';

const MAX_ENTRIES = 500;
const store = new Map();

export const answerCache = {
    /** Tests switch this on for the one test that is about caching. */
    enabled: env.ANSWER_CACHE_SECONDS > 0,

    get(key) {
        if (!this.enabled || !key) return null;
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expires < Date.now()) {
            store.delete(key);
            return null;
        }
        return entry.value;
    },

    set(key, value) {
        if (!this.enabled || !key) return;
        // oldest out first (a Map keeps insertion order)
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
        store.set(key, { value, expires: Date.now() + Math.max(1, env.ANSWER_CACHE_SECONDS || 600) * 1000 });
    },

    /** Call when something that changes answers is edited (aliases, the current semester). */
    clear: () => store.clear(),
    get size() {
        return store.size;
    },
};
