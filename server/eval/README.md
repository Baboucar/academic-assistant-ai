# Answer-quality evaluation

A fixed list of questions, each with the timetable rows the answer should be
written from. Run it before and after you change the model, a prompt, or the
code that reads questions, and compare the two results.

| File | What it is |
| --- | --- |
| `fixture.js` | A made-up timetable: 40 classes and 17 exams in three departments (CS, INS, LAW). No real names. |
| `questions.js` | 70 questions a student might type, each with what should come back. |
| `../scripts/eval.js` | Starts the app, asks the questions, prints what passed. |

## What it measures

The app answers a question in two steps: it turns the question into a search
(by code when the question is simple, otherwise with a model call), then writes
an answer from the rows the search found. The first step is where things most
often go wrong, and the reply to `POST /api/chat` shows how it went: `matches`
holds the rows, and `clarify` is present when the assistant asked "Which
department do you want?".

For each question the script checks `matches` and `clarify`:

- the right course codes came back, and no others;
- class rows for a class question, exam rows for an exam question;
- the right day or date, where the case names one;
- "Which department do you want?" was asked when it should be, and not otherwise;
- nothing came back for small talk, for things that are not in the timetable,
  and for attempts to make the assistant ignore its instructions.

It runs the real app: the same routes, search and prompts that students use,
with a throwaway database filled from `fixture.js`.

## What it does not measure

- **The wording of the answer.** A reply with the right rows passes even if the
  sentence written from them is wrong or badly put. The answer text is saved in
  the `--json` file so you can read it; nothing checks it.
- **Your real timetable.** The fixture is tidy. Rows read badly from a real PDF
  (a lecturer's name inside the course code cell, a missing venue) are not in it.
- **Speed under load, the web page, sign-in, uploads.**
- **Whether "no rows" was for the right reason.** A question the model misread
  and a course that is not in the timetable both give no rows.

A pass rate here is a way to compare two versions of the app. It is not the
share of real student questions that get a good answer.

## How to run it

From `server/`:

```bash
# Check the two files against each other and print what each question expects. No model calls.
node scripts/eval.js --list

# Dry run with a fake model. Needs no key. Shows that the script works; the numbers mean nothing.
node scripts/eval.js --stub --limit 5

# One question, or a few, against the real model
node scripts/eval.js --only abbr-os
node scripts/eval.js --only abbr-os,typo-day,exam-ai

# One or more categories
node scripts/eval.js --category "typo,follow-up"

# Everything, saving the details
node scripts/eval.js --json ../tmp/eval-before.json
```

A real run needs `GROQ_API_KEY` in `server/.env`; the script stops with a
message if it is missing. It uses `MODEL` from the same file unless you pass
`--model`.

The script never touches `tmp/utg.db`, the accounts database or `data/`. It
points the app at a temporary folder and deletes it at the end. The questions
and the made-up rows are sent to the model provider, as they would be for a
student.

### Comparing two versions

```bash
node scripts/eval.js --json ../tmp/eval-before.json
# ... change the prompt, the model, or the code ...
node scripts/eval.js --json ../tmp/eval-after.json --compare ../tmp/eval-before.json
```

`--compare` lists the questions that passed before and fail now, and the other
way round. To try another model without editing `.env`:

```bash
node scripts/eval.js --model <model name> --json ../tmp/eval-other-model.json --compare ../tmp/eval-before.json
```

The model does not give exactly the same reply every time. Before you conclude
that a change broke a question, run that question again with `--only`.

### Options

| Option | What it does |
| --- | --- |
| `--only <id,id>` | Run only these questions. |
| `--category <a,b>` | Run only these categories (the names in the summary). |
| `--limit <n>` | Run only the first n of the questions chosen. |
| `--pause <seconds>` | Wait between questions. Default 8 (0 with `--stub`). |
| `--retry-pause <seconds>` | Wait before the one retry after the model says it is busy. Default 60. |
| `--model <name>` | Use this model instead of `MODEL` from `server/.env`. |
| `--json <file>` | Save every result to a file. |
| `--compare <file>` | List what changed since an earlier `--json` file. |
| `--min <percent>` | Exit with code 1 if the pass rate is below this. Default 0: never. |
| `--stub` | Use the fake model from `test/helpers.js`. |
| `--list` | Print the questions and what each expects, then stop. |

Exit codes: 0 finished; 1 the pass rate is below `--min`; 2 it could not run or
had to stop (no key, model unavailable, a mistake in the options); 130 stopped
with Ctrl+C.

## How long a full run takes, and what it uses

These are estimates. Only two questions have been run against the real model
so far (they took 3.5 and 1.1 seconds); a full run has not been timed. Correct
this section after your first full run.

- **Time: about 12 minutes** for the 70 questions at the default pause: 69
  pauses of 8 seconds, plus one to four seconds for each question.
- **Model calls: about 75.** The app reads simple questions without the model
  and writes some answers without it, so a question costs zero, one or two
  calls. In a dry run where the fake model read every question correctly, the
  app made 39 calls to read questions and 34 to write answers. The summary of
  each real run prints the true number.
- **Tokens: roughly 80,000**, worked out from the size of the prompts in that
  dry run (about 290,000 characters, at four characters to a token), plus the
  replies. That is about 7,000 tokens a minute at the default pause.

The main README notes that a free Groq key allowed about 8,000 tokens a minute
when it was measured, so the default pause sits just inside that. Free keys
also have a daily allowance, and a full run can use a large part of it: check
yours at console.groq.com before running the whole set more than once a day.

If the provider says it is busy, the script waits (`--retry-pause`) and asks
that question once more. If it is still busy, the script stops and prints a
command that runs the questions it did not get to. If you see several "wait"
lines in one run, use a longer pause, for example `--pause 15`.

## How to read the result

One line for each question:

```text
PASS  typo-os        expected: CPS 304 [class]  |  got: CPS 304 [class]
FAIL  abbr-ai        expected: CPS 313 [class]  |  got: CPS 313, INS 302, INS 410 [class]
       not expected: INS 302, INS 410
       question: "who teaches ai"
       searched with: {"title":"Artificial Intelligence"}
ERROR title-plain    the model was not available: Could not reach the AI model. Please try again.
```

- **PASS**: the rows match what the case expects.
- **FAIL**: they do not. The lines under it say what was missing or extra, and
  what the question was turned into (`searched with`). That last line tells you
  where to look:
  - the search is wrong (a missing lecturer, the wrong day, an exam question
    read as a class question): the fault is in reading the question. Look at
    the prompt in `src/ai/slotExtractor.js`, the model, or the code that reads
    simple questions in `src/chat/understand.js`;
  - the search is right but the rows are wrong: the fault is in the search
    itself, `src/db/queries.js`. Changing the model will not fix it.
- **ERROR**: there was no answer to judge, usually because the model provider
  was busy or unreachable. When that happens the app can still reply from its
  own fallback, but such a reply says nothing about the model, so the script
  does not count it. Errors are not failures of answer quality; run those
  questions again.

Then a summary (the numbers here are only an example):

```text
Passed, by category
  course code            4 of 4   100%
  typo                   3 of 4    75%
  ...
  all                   61 of 70   87%

Model: openai/gpt-oss-120b. Time: 12m 10s.
Model calls the app made: 74 for 70 question(s).
```

Questions with an error, and questions not asked because the run stopped
early, count as not passed. The summary says how many there were, so you can
tell a bad result from an unfinished one.

Read the categories, not only the total. A change that fixes typos and breaks
follow-ups can leave the total where it was.

Some cases are expected to fail until the app can handle them, for example
`typo-lecturer` (a misspelt surname) and `venue-numbered` ("Lab 2" as opposed
to "Lab 1"). The `why` of each case says what it is there to catch. Do not
delete a case because it fails: that is the record of what does not work yet.

`today-no-dept`, `tomorrow-dept` and the other "relative day" cases expect
different rows depending on the day you run them. On a Saturday, "tomorrow" is
Sunday and the right result is no rows. `--list` shows what they expect today.

### The `--json` file

```text
started_at, finished_at, model, stub, timezone, today, pause_seconds, stopped_early
summary:  total, passed, failed, errors, notRun, passRate, modelCalls, byCategory
results:  one entry for each question:
  id, category, question, history, why
  expected       what the case expects (worked out for the day of the run)
  status         pass | fail | error | not_run
  problems       why it failed, as printed
  got            codes, kinds, days, dates, clarify, rows (the matches, trimmed),
                 filters and slots (what the question was turned into), answer (the text)
  attempts, http_status, ms
  outcome, model_calls   from the app's own question log
  error          for status "error"
```

These files are records of a run, not source: do not commit them.

## How to add a case

Add an entry to `QUESTIONS` in `questions.js`:

```js
{
    id: 'venue-letter',                          // unique; used with --only
    category: 'venue',                           // an existing category, or a new one
    question: 'anything in chancery hall b on friday?',
    expect: classes(['INS 411'], { days: ['Fri'] }),
    why: 'Venue with a letter, and a day.',      // what the case is there to catch
},
```

`expect` can use any mix of these:

| Key | Meaning |
| --- | --- |
| `codes` | The course codes of the rows that must come back: all of them, and no others. |
| `includes` | Course codes that must be among the rows. Others are allowed. |
| `kind` | `'class'`: no exam rows. `'exam'`: only exam rows. |
| `days` | The weekdays the rows must be on, for example `['Mon', 'Fri']`. |
| `dates` | The dates the exam rows must be on, for example `['2099-01-12']`. |
| `clarify` | `true`: the assistant must ask which department. `false`: it must not. |
| `none` | `true`: no rows at all. |

The helpers at the top of `questions.js` cover the usual cases:
`classes([...])`, `exams([...])`, `NOTHING`, `ASK_DEPARTMENT`, and
`classesFor({ dept, day, lecturer, venue })`, which works the codes out from the
fixture so you do not have to list them by hand.

For a follow-up, add `history`: the earlier turns, oldest first, as
`[{ role: 'user', text }, { role: 'assistant', text }]`.

For "today" or "tomorrow", make `expect` a function. It is given
`{ today, tomorrow, dayAfter }` as `'Mon'` to `'Sun'` in the server's timezone:

```js
expect: ({ tomorrow }) => classesFor({ dept: 'LAW', day: tomorrow }),
```

Three rules:

1. Write the question the way a student would type it, mistakes and all. The
   questions students really ask and get no answer to are in the app's question
   log; those are the best ones to add.
2. Write the expectation from the fixture, not from what the assistant answers
   today. If you are not sure what the right rows are, the case is not ready.
3. Run `node scripts/eval.js --list` afterwards. It checks that ids are
   unique and that every course code you expect is in the fixture, for every
   day of the week, without calling the model. Then run the new case alone
   with `--only`.

If a case needs a row the fixture does not have, add it to `fixture.js`, and
run `--list` again: a new row can change what other cases should expect (a new
Monday class in CS changes every "CS on Monday" case that lists its codes by
hand). Keep the fixture made up. Real timetables name real staff and are not
committed.
