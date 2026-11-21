// server/src/ai/slotExtractor.js
import { complete } from './groq.js';
import { toDay3 } from '../utils/dates.js';

/**
 * Use the Groq model to extract structured slots from a natural-language question.
 *
 * We keep this logic as simple as possible and let the LLM do the heavy lifting.
 * The rest of the app just consumes the slots.
 */

const SYSTEM_PROMPT = `
You are a slot-filling assistant for the UTG Academic Assistant.
You MUST respond with ONLY a single JSON object, no commentary.

Your job: read the user's question about timetables / lecturers / classes,
and produce a JSON object with this schema:

{
  "intent": "who_teaches" | "when_is" | "where_is" | "schedule_day" | "next_class" | "generic",
  "course_code": string | null,       // e.g. "ICT202", "INS404"
  "title_kw": string | null,          // short course title keywords, e.g. "Artificial Intelligence"
  "dept": string | null,              // "CS", "INS", "CPS", "TEL", etc.
  "day": string | null,               // 3-letter English weekday e.g. "Mon", "Tue"
  "date_iso": string | null,          // YYYY-MM-DD if user gives a specific date
  "time": string | null,              // HH:MM 24h if user mentions explicit time
  "lecturer_name": string | null,     // full name of lecturer if question mentions them
  "venue": string | null,             // room / hall / lab name if the question is about a place
  "exam": boolean                     // true if the question is about an exam / the exam timetable
}

Guidelines:

- "intent":
  - If the user asks who teaches something → "who_teaches"
  - If they ask when or "what time" → "when_is"
  - If they ask where / which room / venue → "where_is"
  - If they ask for schedule on a day → "schedule_day"
  - If they ask for next upcoming class → "next_class"
  - Otherwise → "generic"

- course_code:
  - Use compact format without spaces, e.g. "ICT202", "INS404", "CPS416".
  - If the question includes a code like "ICT 202" or "CPS 416/ CPS 313",
    pick the most relevant code and normalize to no spaces. Example:
      "ICT 202"   → "ICT202"
      "CPS 416/ CPS 313" → "CPS416"
  - If no code is mentioned, leave it null.

- title_kw:
  - Short phrase of the course name, e.g. "Artificial Intelligence", "Web Programming II".
  - If the question uses a short label like "AI" for Artificial Intelligence, set "title_kw":"AI".
  - If the question is purely about a lecturer (e.g. "Which courses is Baboucarr teaching?"),
    you can leave title_kw null.

- dept:
  - Department code if explicitly mentioned, e.g. "CS", "INS", "CPS", "TEL". Otherwise null.

- day:
  - If the question says Monday, Tuesday, etc., map to 3-letter English form:
    "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun".
  - Resolve relative days ("today", "tomorrow", "yesterday", "tonight") using the current date
    given in the user message, and output the resulting 3-letter weekday.

- date_iso:
  - If the user gives a full date like "2025-11-03", copy it exactly here.
  - Otherwise null.

- time:
  - If the user gives a specific clock time like "11:30", "8:30", "14:00",
    normalize to 24h "HH:MM" format.
  - Otherwise null.

- lecturer_name:
  - If the question mentions a lecturer (e.g. "Baboucarr Drammeh", "Mr. Baboucarr Drammeh"),
    extract their full name as it appears, without the title:
      "Mr. Baboucarr Drammeh" → "Baboucarr Drammeh"
      "Jane Doe" → "Jane Doe"
  - If no lecturer is mentioned, use null.

- venue:
  - A room, hall or lab the user asks about, e.g. "Lab 2", "Chancery Hall". Otherwise null.

- exam:
  - true when the user asks about an exam, examination, paper or the exam timetable
    ("When is the AI exam?", "Do I have an exam tomorrow?"). false for ordinary classes.

- Follow-up questions:
  - You may be given the earlier turns of the conversation. If the latest question is a
    follow-up that leaves details out ("What about Tuesday?", "And who teaches it?",
    "Where is that?"), carry the missing slots over from the earlier turns (including "exam")
    and change only what the latest question changes.
  - If the latest question starts a new topic, ignore the earlier turns.
  - Small talk ("hi", "thanks") has no slots: set everything to null with intent "generic".

Examples:

Q: "Who is teaching AI?"
→ {
  "intent": "who_teaches",
  "course_code": null,
  "title_kw": "AI",
  "dept": null,
  "day": null,
  "date_iso": null,
  "time": null,
  "lecturer_name": null,
  "venue": null,
  "exam": false
}

Q: "Show Monday schedule for CS."
→ {
  "intent": "schedule_day",
  "course_code": null,
  "title_kw": null,
  "dept": "CS",
  "day": "Mon",
  "date_iso": null,
  "time": null,
  "lecturer_name": null,
  "venue": null,
  "exam": false
}

Q: "How many courses is Baboucarr Drammeh teaching on Monday?"
→ {
  "intent": "generic",
  "course_code": null,
  "title_kw": null,
  "dept": null,
  "day": "Mon",
  "date_iso": null,
  "time": null,
  "lecturer_name": "Baboucarr Drammeh",
  "venue": null,
  "exam": false
}

Return ONLY valid JSON, no extra text.
`;

const EMPTY_SLOTS = {
    intent: 'generic',
    course_code: null,
    title_kw: null,
    dept: null,
    day: null,
    date_iso: null,
    time: null,
    lecturer_name: null,
    venue: null,
    exam: false,
};

const INTENTS = new Set(['who_teaches', 'when_is', 'where_is', 'schedule_day', 'next_class', 'generic']);

const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/** Parse the model's reply (optionally fenced) into a JSON object, or null. */
export function parseSlotJson(raw) {
    let txt = String(raw || '').trim();
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
        const parsed = JSON.parse(txt);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Some models add a sentence around the object: take the outermost braces.
        const a = txt.indexOf('{');
        const b = txt.lastIndexOf('}');
        if (a !== -1 && b > a) {
            try { return JSON.parse(txt.slice(a, b + 1)); } catch { /* fall through */ }
        }
    }
    return null;
}

/** Clean up whatever the model returned into a predictable slot object. */
export function normalizeSlots(parsed) {
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SLOTS };

    const slots = { ...EMPTY_SLOTS };
    slots.intent = INTENTS.has(parsed.intent) ? parsed.intent : 'generic';
    slots.course_code = text(parsed.course_code).toUpperCase().replace(/\s+/g, '') || null;
    slots.title_kw = text(parsed.title_kw) || null;
    slots.dept = text(parsed.dept).toUpperCase() || null;
    slots.day = toDay3(text(parsed.day)) || toDay3(text(parsed.day).slice(0, 3));
    slots.venue = text(parsed.venue) || null;
    slots.exam = parsed.exam === true || parsed.exam === 'true';

    const date = text(parsed.date_iso);
    slots.date_iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

    const time = text(parsed.time).match(/^(\d{1,2}):(\d{2})$/);
    slots.time = time ? `${time[1].padStart(2, '0')}:${time[2]}` : null;

    // Strip common titles
    slots.lecturer_name =
        text(parsed.lecturer_name).replace(/\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+/gi, '').trim() || null;

    // ---- UTG-specific mappings ----
    // Map "AI" / "Artificial Intelligence" / "Intelligent Systems" to CPS416
    const titleUpper = (slots.title_kw || '').toUpperCase();
    if (!slots.course_code && slots.title_kw) {
        if (
            titleUpper === 'AI' ||
            titleUpper.includes('ARTIFICIAL INTELLIGENCE') ||
            titleUpper.includes('INTELLIGENT SYSTEMS')
        ) {
            slots.course_code = 'CPS416';
            if (!slots.dept) slots.dept = 'CPS';
        }
    }

    return slots;
}

/**
 * Extract slots for the latest question.
 * `history` is the earlier turns ([{ role, text }]) so follow-ups can be resolved;
 * `now` is { iso, weekday, time } in the campus timezone for relative days.
 */
export async function extractSlots(question, { history = [], now = null, signal } = {}) {
    const lines = [];
    if (now) lines.push(`Current date: ${now.weekday} ${now.iso}, time ${now.time}.`);
    if (history.length) {
        lines.push('Earlier turns of the conversation:');
        for (const turn of history) {
            const who = turn.role === 'assistant' ? 'Assistant' : 'User';
            lines.push(`${who}: ${String(turn.text || '').slice(0, 600)}`);
        }
    }
    lines.push(`Latest question: ${String(question || '')}`);

    const reply = await complete(
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: lines.join('\n') },
        ],
        { temperature: 0, signal },
    );

    return normalizeSlots(parseSlotJson(reply));
}
