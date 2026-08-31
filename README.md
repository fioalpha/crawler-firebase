# crawler-firebase

Browser-automation crawler that logs into the Firebase console, opens a project's
Crashlytics dashboard, and scrapes:

- Crash-free users / crash-free sessions percentages
- The issues list (title + row text, which includes event count / affected users / trend)
- The stack trace for each issue

Results are written as a timestamped JSON file under `output/`.

## Setup

```bash
npm install
npx playwright install chromium
```

## First run (interactive login + project pick)

```bash
npm run crawl
```

A real Chrome window opens. If you're not already signed in, sign into the Google
account that has access to your Firebase project (complete 2FA if prompted) — the script
waits for as long as it takes. That session is saved in `.browser-profile/` and reused on
every future run, so this manual step is normally only needed once.

You'll then be asked which Firebase project to crawl. That choice is saved in
`state.json` and reused silently afterwards.

## Later runs

```bash
npm run crawl
```

Reuses the saved login and project — no prompts, unless the saved session has expired
(rare, but Google sessions do eventually lapse) or you pass `--reset-project` to pick a
different project:

```bash
npm run reset-project
```

To just confirm the saved login still works without doing a full crawl:

```bash
npm run login
```

## Why this is fragile, and what to do when a scrape step fails

Firebase console has no public read API for Crashlytics, and its DOM isn't documented —
every selector here is a best-effort guess (built on text like "Crashlytics" and
"Crash-free", and on URL shapes like `/project/<id>/...` and `/issues/<id>`), not
something verified against the live page. It **will** need a correction pass once you run
it against your real project.

When a step can't find what it expects, it doesn't crash silently — it dumps a screenshot,
the full HTML, and the visible text of the page to `debug/<timestamp>_<label>.{png,html,txt}`
and prints where. If a run comes back with a warning or error, open the `.png` for that
step (or share it) so the corresponding selector in `src/crashlytics.ts` or
`src/projectSelect.ts` can be fixed against what the page actually looks like.

## Project layout

- `src/browser.ts` — launches Chromium with a persistent profile (keeps the login session).
- `src/login.ts` — detects whether Google login is needed and waits for it.
- `src/projectSelect.ts` — lists/prompts for which Firebase project to crawl.
- `src/crashlytics.ts` — clicks into Crashlytics and scrapes metrics/issues/stack traces.
- `src/debug.ts` — dumps page state whenever a selector doesn't find what it expects.
- `src/state.ts` — persists the chosen project id between runs.
- `src/index.ts` — orchestrates the above and writes the output JSON.

## A lower-maintenance alternative

If this turns out to be too brittle to keep up with (Google login flow changes, Crashlytics
UI changes, sessions expiring), Firebase's officially supported way to get this data out
programmatically is enabling **Crashlytics's BigQuery export** in the console once, then
querying crash events with SQL — no browser automation, no login flow, no DOM to track.
Worth switching to if this crawler becomes high-maintenance.
