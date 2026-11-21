// server/src/routes/chat.js
//
// POST /api/chat           -> { answer, slots, filters, matches, schedule, clarify? }
// POST /api/chat?stream=1  -> Server-Sent Events:
//   { event: 'meta', slots, filters, matches, schedule, clarify? }   once, before the answer
//   { event: 'chunk', text }                                         as the answer is written
//   { event: 'error', message }                                      if the model fails mid-answer
//   { event: 'done' }                                                at the end
//
// How a question is handled (see ../chat/understand.js and ../chat/compose.js):
//   1. a repeated first question is answered from the cache;
//   2. the question becomes a search, by code alone when it is simple, else with one model call;
//   3. the answer is written by code when the rows decide it (schedule summary,
//      nothing found, which department?), else by one model call;
//   4. if the model cannot be reached, code writes the answer from the rows.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, wrap } from '../errors.js';
import { activeSemester, Queries } from '../db/queries.js';
import { env } from '../env.js';
import { nowIn } from '../utils/dates.js';
import { complete, completeStream } from '../ai/groq.js';
import { answerCache } from '../chat/cache.js';
import { logQuestion } from '../chat/log.js';
import { ALL_DEPARTMENTS, appliedFilters, buildContext } from '../chat/understand.js';
import {
    answerMessages, clarifyText, HELP_TEXT, NOT_FOUND, notFoundText, notUnderstoodText, rowsText, SCHEDULE_FROM, scheduleSummary,
} from '../chat/compose.js';

export { buildContext };
export const chat = Router();

const Body = z.object({
    question: z.string().trim().min(1, 'question is required').max(500, 'question is too long'),
    // Earlier turns, oldest first, so follow-ups like "What about Tuesday?" make sense
    history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(8000) }))
        .max(20)
        .optional()
        .default([]),
});

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
};

// A question with no searchable part that still looks like it is about the timetable
const ABOUT_TIMETABLE = /\b(class|classes|lecture|lectures|lecturer|course|courses|exam|exams|teach|teaches|teaching|venue|room|hall|lab|schedule|timetable|when|where)\b/i;

/** Only the first question of a chat is cached: a follow-up depends on what came before. */
function cacheKeyFor(question, history, now) {
    if (history.length) return null;
    const text = question.toLowerCase().replace(/\s+/g, ' ').replace(/[?!.\s]+$/, '');
    return [now, Queries.dataVersion(), activeSemester() || '', text].join('|');
}

/**
 * Decide how to answer. Returns { outcome, text } when code writes the answer,
 * or { outcome, messages, fallback } when the model should, with the text to
 * use if the model cannot be reached.
 */
function plan(context) {
    if (context.clarify) return { outcome: 'clarify', text: clarifyText(context) };
    if (!context.searched) {
        if (ABOUT_TIMETABLE.test(context.question)) return { outcome: 'not_understood', text: notUnderstoodText() };
        return { outcome: 'chat', messages: answerMessages(context), fallback: HELP_TEXT };
    }
    if (!context.matches.length) return { outcome: 'not_found', text: notFoundText(context) };
    if (context.matches.length >= SCHEDULE_FROM) return { outcome: 'answered', text: scheduleSummary(context) };
    // the model is unavailable already: do not try it a second time
    if (context.degraded) return { outcome: 'answered', text: rowsText(context) };
    return { outcome: 'answered', messages: answerMessages(context), fallback: rowsText(context) };
}

chat.post(
    '/chat',
    wrap(async (req, res) => {
        const parsed = Body.safeParse(req.body || {});
        if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues[0]?.message || 'Invalid request');
        }
        const { question, history } = parsed.data;
        const isStream = ['1', 'true'].includes(String(req.query.stream || '').toLowerCase());
        const started = Date.now();
        const meter = { modelCalls: 0 };

        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        /** Send a whole answer at once (cache hit, or an answer written by code). */
        const reply = ({ answer, ...meta }) => {
            if (!isStream) return res.json({ answer, ...meta });
            res.writeHead(200, SSE_HEADERS);
            send({ event: 'meta', ...meta });
            send({ event: 'chunk', text: answer });
            send({ event: 'done' });
            return res.end();
        };

        // Stop paying for tokens nobody will read if the client goes away
        const aborter = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) aborter.abort();
        });
        const { signal } = aborter;

        // the campus date: "today" must not be answered from yesterday's memory after midnight there
        const today = nowIn(env.TIMEZONE).iso;
        const cacheKey = cacheKeyFor(question, history, today);
        const cached = answerCache.get(cacheKey);
        if (cached) {
            logQuestion({ ...cached.log, question, cached: true, modelCalls: 0, ms: Date.now() - started });
            return reply(cached.payload);
        }

        let context;
        try {
            context = await buildContext(question, history, { signal, meter });
        } catch (e) {
            if (e?.name === 'AbortError') return;
            logQuestion({ question, outcome: 'error', modelCalls: meter.modelCalls, ms: Date.now() - started, error: e?.message });
            throw e;
        }

        const { slots, exam } = context;
        const filters = context.filters;
        // Several departments match and none was named: ask, and show no rows yet
        const clarify = context.clarify ? { options: [...context.clarify, ALL_DEPARTMENTS] } : undefined;
        const matches = clarify ? [] : context.matches;
        // tells the client to show the rows as a schedule rather than tucked away
        const schedule = matches.length >= SCHEDULE_FROM;
        // `degraded` tells the client the model was unavailable and code alone read the question
        const meta = { slots, filters, matches, schedule, ...(clarify ? { clarify } : {}), ...(context.degraded ? { degraded: true } : {}) };

        const step = plan(context);
        const log = (extra = {}) => ({
            question,
            outcome: step.outcome,
            kind: context.searched ? (exam ? 'exam' : 'class') : null,
            rows: matches.length,
            filters: appliedFilters(filters),
            modelCalls: meter.modelCalls,
            ms: Date.now() - started,
            ...extra,
        });
        const remember = (answer) => {
            // "next class" depends on the time of day, and a degraded answer should not outlive the outage
            if (context.nextClass || context.degraded) return;
            answerCache.set(cacheKey, { payload: { answer, ...meta }, log: log() });
        };

        // --- written by code: no model call ---
        if (step.text !== undefined) {
            remember(step.text);
            logQuestion(log());
            return reply({ answer: step.text, ...meta });
        }

        // --- written by the model, with a code-written fallback ---
        meter.modelCalls++;
        if (!isStream) {
            let answer;
            try {
                answer = await complete(step.messages, { signal });
                if (answer) {
                    remember(answer);
                    logQuestion(log());
                } else {
                    // the model said nothing: answer from the rows, and do not remember it
                    answer = step.fallback || NOT_FOUND;
                    logQuestion(log({ error: 'the model returned an empty reply' }));
                }
            } catch (e) {
                if (e?.name === 'AbortError') return;
                if (!(e instanceof HttpError)) {
                    logQuestion(log({ outcome: 'error', error: e?.message }));
                    throw e;
                }
                answer = step.fallback;
                logQuestion(log({ error: `model unavailable, answered from the rows: ${e.message}` }));
            }
            return res.json({ answer, ...meta });
        }

        res.writeHead(200, SSE_HEADERS);
        send({ event: 'meta', ...meta });
        let written = '';
        try {
            for await (const text of completeStream(step.messages, { signal })) {
                written += text;
                send({ event: 'chunk', text });
            }
            if (written) {
                send({ event: 'done' });
                remember(written);
                logQuestion(log());
            } else {
                // the model said nothing: answer from the rows, and do not remember it
                send({ event: 'chunk', text: step.fallback || NOT_FOUND });
                send({ event: 'done' });
                logQuestion(log({ error: 'the model returned an empty reply' }));
            }
        } catch (e) {
            if (e?.name === 'AbortError' || signal.aborted) return;
            if (e instanceof HttpError && !written) {
                // the model never started: answer from the rows instead of failing
                send({ event: 'chunk', text: step.fallback });
                send({ event: 'done' });
                logQuestion(log({ error: `model unavailable, answered from the rows: ${e.message}` }));
            } else {
                if (!(e instanceof HttpError)) console.error(e);
                send({
                    event: 'error',
                    message: e instanceof HttpError ? e.message : 'The answer was interrupted. Please try again.',
                });
                logQuestion(log({ outcome: 'error', error: e?.message }));
            }
        } finally {
            res.end();
        }
    }),
);
