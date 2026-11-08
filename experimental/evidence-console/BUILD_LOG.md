# BUILD_LOG: evidence console

Branch `henry/evidence-console`, from `feature/datadog-to-dash0` @ e3e134f. Everything lives in this folder.

## Step 1: audit (real files, offline dry run on Redis overview + high_mem, 0.5.0)
Decision: reusing `experimental/console` would cost more than 30 minutes (bun, shadcn, its own contract), so this is a fresh minimal Vite + React app. Nothing copied.

report.json (`schema: dd2dash0.report/v2`), top level: `findings, items, reasonCodes, run, schema, summary`.
- `items[]` kinds: `panel`, `group` (structure rows, always `exact`, not widgets), `alert` (monitors).
- item fields used: `id, title, kind, status (the label), widget_type, group, dashboard, source_queries[], promql[], condition, explain.{plain,technical}, certificate.{assumptions,checks,rules,status}, reason_codes[], decision_required, manual_actions[], target.{action,readBack,dash0Id,kind}`.
- `reasonCodes` is an object keyed by code with `{plain, explanation, label, catalogRule}`.
- `run.options.{mode,enableRules}`; `summary.import.{mode,written,imported,...}`.
- Text notes: `widget_type: "note"`, labelled `exact-under` by the report (condition is about fonts/colours). Shown with a "text note" marker.
- Bounded items have `condition: null`; the bound is only in `explain.plain` (shown as the difference).

NOT in report.json (shown as "Not checked" / "Not recorded"): live-data result, parity result, Dash0 URL, per-item import outcome beyond `target.action/readBack`. The live verify results are only in the flow's report.md/html. The app reads optional `live`, `parity`, `dash0Url` / `dash0.url` / `target.url` fields if a future report records them.

events.jsonl: `{seq, type, ...}`; types seen: `run.start, dashboard.start, item.done, dashboard.done, import.done, run.done`. No timestamps are recorded (so replay is paced, and says so). `item.done` carries `id, kind, title, status, promql, source_queries, reason_codes`. Group items have no events.

## Step 2: data server
`server/server.ts`: 127.0.0.1 only, host-header check, fixed routes, query strings ignored, UI served from an in-memory map, no CORS headers, files opened read-only. `server/tail.ts`: complete lines only, partial last line kept, truncation resets.
