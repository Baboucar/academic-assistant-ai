// Other names for a course, kept as data an admin can change rather than in code:
// "AI" -> "Artificial Intelligence", "Intelligent Systems" -> "Artificial Intelligence".
// A search for any name in a family looks for all of them.
import { accountsDb } from './accounts.js';

const selectAll = accountsDb.prepare(`SELECT alias, title FROM aliases ORDER BY title COLLATE NOCASE, alias COLLATE NOCASE`);
const insert = accountsDb.prepare(
    `INSERT INTO aliases (alias, title) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET title = excluded.title`,
);
const remove = accountsDb.prepare(`DELETE FROM aliases WHERE alias = ?`);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cache = null;
function load() {
    if (cache) return cache;
    const rows = selectAll.all();
    const byAlias = new Map(rows.map((r) => [r.alias.toUpperCase(), r.title]));
    const family = new Map(); // TITLE -> [title, alias, alias, ...]
    for (const { alias, title } of rows) {
        const key = title.toUpperCase();
        if (!family.has(key)) family.set(key, [title]);
        family.get(key).push(alias);
    }
    // longest first, so "Data Communications and Networks" wins over "Data Communications"
    const finders = rows
        .map((r) => ({ title: r.title, length: r.alias.length, re: new RegExp(`(^|[^a-z0-9])${escapeRegex(r.alias)}(?![a-z0-9])`, 'i') }))
        .sort((a, b) => b.length - a.length);
    cache = { rows, byAlias, family, finders };
    return cache;
}

export const Aliases = {
    list: () => load().rows,

    add(alias, title) {
        insert.run(alias, title);
        cache = null;
    },
    remove(alias) {
        const changed = remove.run(alias).changes;
        cache = null;
        return changed > 0;
    },

    /** The full title a name stands for ("AI" -> "Artificial Intelligence"), or the text itself. */
    canonical(text) {
        if (!text) return text;
        return load().byAlias.get(String(text).trim().toUpperCase()) || text;
    },

    /** Every name to search for when one is asked about. */
    phrasesFor(text) {
        if (!text) return [];
        const title = this.canonical(text);
        const family = load().family.get(String(title).trim().toUpperCase());
        return [...new Set([String(text).trim(), ...(family || [title])])];
    },

    /** An alias or title named in free text -> { title, text: the words that matched }, or null. */
    match(text) {
        const q = String(text || '');
        for (const { re, title } of load().finders) {
            const m = q.match(re);
            if (m) return { title, text: m[0].slice(m[1].length) };
        }
        for (const [title] of load().family.values()) {
            const m = q.match(new RegExp(`(^|[^a-z0-9])${escapeRegex(title)}(?![a-z0-9])`, 'i'));
            if (m) return { title, text: m[0].slice(m[1].length) };
        }
        return null;
    },
    /** An alias or title named in free text -> its full title, or null. */
    find(text) {
        return this.match(text)?.title ?? null;
    },

    /** Short names and what they stand for, for the model's glossary. */
    acronyms() {
        return Object.fromEntries(load().rows.filter((r) => r.alias.length <= 6 && !/\s/.test(r.alias)).map((r) => [r.alias, r.title]));
    },

    /** Aliases too short to be ordinary search words ("AI"), which must still match. */
    shortTokens() {
        return new Set(load().rows.map((r) => r.alias.toUpperCase()).filter((a) => a.length <= 3 && !/\s/.test(a)));
    },
};
