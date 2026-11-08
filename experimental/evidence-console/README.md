# Evidence console

A read-only screen for a jury to inspect one dd2dash0 run. It shows what `report.json` and `events.jsonl` record, nothing more. It has no import button, no approve button and no chatbot. The CLI demo works without it.

Lives only in this folder (own `package.json` and lockfile). It does not touch `experimental/console`, `src/` or the root project.

## Launch

```sh
cd experimental/evidence-console
npm install
npm start                    # builds the UI and serves the demo data on http://127.0.0.1:4173
```

Other files, by path, on any port:

```sh
npm run build
npx tsx server/main.ts --report /path/to/report.json --events /path/to/events.jsonl --port 4173
```

The demo data in `demo-data/` came from an offline dry run on the Redis overview dashboard and the `high_mem` monitor (`dd2dash0 migrate --from datadog --input <dir> --dry-run`). No Dash0 call was made and nothing was imported.

## What it shows

- Widgets assessed, and a count per label the report uses. `exact-under` is shown as **EXACT IF**. Text notes carry their label and a "text note" marker.
- Every widget as a tile with the label written on it, in source order. Monitors are a separate row and never counted in the widget totals.
- An evidence panel for the selected item: original Datadog query, generated PromQL (or "No PromQL generated"), the exact-if condition or the bounded difference, reason codes with explanations, and four separate pieces of evidence: import, live data, parity, Dash0 link. Anything the report does not record reads "Not recorded" or "Not checked".
- A stage bar driven only by events in `events.jsonl`, a LIVE or REPLAY badge, and **Replay this run**, which feeds the same events through the same reducer.
- **What needs my attention?**: a checklist built from the report (not translated, bounded, conditions to confirm, monitors apart).

## Rules it keeps

- Server binds to `127.0.0.1`, checks the Host header, sends no CORS headers, serves exactly the two files given by `--report` and `--events` and the built UI from memory. No path parameter exists; query strings are ignored. Files are opened read-only.
- No network calls, except the optional AI call below.
- No number is hard-coded; every count is computed from the loaded report.
- It never says "verified", "fired" or "matches Datadog". It never infers equivalence from query text, live data from an import, or a firing alert from a threshold. A check rule is shown as disabled when the run records `enableRules: false`.
- The report today does not record per-item live-data results, parity results or Dash0 links (the CLI keeps those in `report.md`/`report.html`). The screen reads optional `live`, `parity` and `dash0Url` / `dash0.url` / `target.url` fields if a later report adds them.
- The event log records no timestamps, so replay is paced for visibility and says so. If a log has timestamps, replay uses them and says "Playback slowed for visibility" when slowed.

## AI explanation

AI explanation is off by default and stays off in the demo until the team has the Dash0 mentor's answer.

It turns on only if the human starts the server with `ENABLE_AI_EXPLANATION=1` and an API key set in their own shell (`ANTHROPIC_API_KEY`). The key is read from the process environment only, never from a file, never logged, never sent to the browser. There is no AI SDK: one `fetch` in `server/ai.ts`. Only `id`, `label`, reason codes and `condition` per item leave the machine. Every id in the reply is checked against the report on the server, notes that call something safe or verified or that contain queries are dropped, and the result is shown as plain text labelled "AI explanation". The checklist itself never depends on it.

## Tests

```sh
npm test         # 51 tests: counts, labels, malformed input, evidence kinds, replay, tail, AI off, id checks, server path safety
npm run typecheck
```

`npm run screenshots` (with the server running) writes PNGs to `screenshots/` using an already-installed Playwright browser.
