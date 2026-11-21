// A record of what students ask and how it went, so an admin can see which
// questions got no answer and an operator can see what happened when students
// report a problem. The student is not recorded with the question.
import { accountsDb } from '../db/accounts.js';

const KEEP_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

const insert = accountsDb.prepare(`
  INSERT INTO question_log (at, question, outcome, kind, rows, filters, model_calls, cached, ms, error)
  VALUES (@at, @question, @outcome, @kind, @rows, @filters, @model_calls, @cached, @ms, @error)
`);
const prune = accountsDb.prepare(`DELETE FROM question_log WHERE at < ?`);
let sincePrune = 0;

/** outcome: answered | not_found | not_understood | clarify | chat | error */
export function logQuestion({ question, outcome, kind = null, rows = 0, filters = null, modelCalls = 0, cached = false, ms = 0, error = null }) {
    try {
        insert.run({
            at: Date.now(),
            question: String(question || '').slice(0, 500),
            outcome,
            kind,
            rows,
            filters: filters ? JSON.stringify(filters).slice(0, 1000) : null,
            model_calls: modelCalls,
            cached: cached ? 1 : 0,
            ms: Math.round(ms),
            error: error ? String(error).slice(0, 300) : null,
        });
        if (++sincePrune >= 200) {
            sincePrune = 0;
            prune.run(Date.now() - KEEP_DAYS * DAY);
        }
    } catch (e) {
        // a logging failure must never fail the answer
        console.error('Could not write the question log:', e?.message || e);
    }
}

/** Counts by outcome and the questions that got no answer, for the last `days` days. */
export function questionStats(days = 7) {
    const since = Date.now() - Math.max(1, Math.min(90, Number(days) || 7)) * DAY;
    const totals = Object.fromEntries(
        accountsDb
            .prepare(`SELECT outcome, COUNT(*) AS n FROM question_log WHERE at >= ? GROUP BY outcome`)
            .all(since)
            .map((r) => [r.outcome, r.n]),
    );
    const sums = accountsDb
        .prepare(
            `SELECT COUNT(*) AS questions, COALESCE(SUM(model_calls), 0) AS model_calls,
                    COALESCE(SUM(cached), 0) AS cached, COALESCE(ROUND(AVG(ms)), 0) AS average_ms
             FROM question_log WHERE at >= ?`,
        )
        .get(since);
    const unanswered = accountsDb
        .prepare(
            `SELECT MIN(question) AS question, outcome, COUNT(*) AS times, MAX(at) AS last_at, MAX(error) AS error
             FROM question_log
             WHERE at >= ? AND outcome IN ('not_found', 'not_understood', 'error')
             GROUP BY LOWER(TRIM(question)), outcome
             ORDER BY times DESC, last_at DESC
             LIMIT 50`,
        )
        .all(since);
    return { since, ...sums, totals, unanswered };
}
