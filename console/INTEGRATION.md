# Integration guide

Hand-off for engineers putting the Migration Review Console into the team's migrator fork and wiring it to the real CLI.

## 1. What it is and the hard rules

A browser app for reviewing a Datadog-to-Dash0 migration. It reads the `report.json` the CLI writes, shows an overview, a dashboard map, an items list and a review queue, and exports the reviewer's decisions as `review.json`.

Hard rules. Do not break these:

- **Browser only.** No backend, no login.
- **No AI and no network calls.** The only fetch is the same-origin `/report.json` from the public folder.
- **No translation logic.** Translation must be deterministic and lives in the CLI. The app only displays and reviews.
- **Parsing only in `src/lib/report.ts`.** It is the only file that knows `report.json` field names. If the CLI renames a field, fix it there and nowhere else.
- **Every number shown is computed from the loaded file.** Never hard-code counts.
- **No confidence scores.**
- **`review.json` keeps `report_sha256` and the `approved` / `flagged` / `acknowledged` values unchanged.** The CLI depends on them.

## 2. Run and build

Bun is the package manager (`bun.lock`). If Bun is not installed, use `npx bun`.

```sh
npx bun install
npx bun run dev        # http://localhost:8080 (if that port is taken, use the URL Vite prints)
npx bun run build
npx bun run test       # vitest
npx bun run lint
```

`npx bun run shots` takes 1920x1080 screenshots into `shots/` and checks for horizontal overflow at 1920 and 1440. It needs the dev server running; set `SHOTS_URL` if the URL differs. It also needs Playwright's Chromium (`npx playwright install chromium`).

## 3. Data contract

### report.json (input)

Top level. Only `items` is required; without an `items` array the file is rejected.

| Field | Used for |
| --- | --- |
| `items` (required, array) | Everything below |
| `schema_version` | Shown only |
| `run.tool_version`, `run.source`, `run.source_commit`, `run.source_sha256`, `run.mapping_version`, `run.rule_version` | Run info |
| `SAMPLE` | If present, the sample banner is shown (see section 4) |
| `summary.widgets`, `summary.monitors` | Counts per status plus `total`; each missing number falls back to a count from `items` |
| `summary.metrics.mapped`, `.total`, `.no_equivalent` | Metric coverage |
| `summary.numerical.passed`, `.failed` | Numbers-check count |
| `diagnostics` (array) | Kept, passed through |

Each entry in `items`:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | **yes** | String. Numbers are converted to strings. Decisions are keyed by it. |
| `status` | **yes** | `exact`, `approximate`, `no_data`, `unsupported` or `failed`. May be omitted if `claim` is set (see below). |
| `kind` | no | `group`, `widget` or `monitor`. If missing it is inferred from the id: starts with `group` is a group, starts with `monitor` is a monitor, otherwise a widget. |
| `claim` | no | `exact`, `exact-under`, `bounded` or `manual`. Any other value is ignored. |
| `condition` | no | Text used with `exact-under`. |
| `title`, `widget_type`, `group`, `source_path`, `target_panel`, `notes` | no | Display text. `widget_type` of `note` is a text note; `list_stream` and `log_stream` are log panels. |
| `layout`, `target_layout` | no | `{x, y, w, h}`. Needs numeric `w` and `h`, otherwise treated as absent. `x` and `y` default to 0. |
| `source_queries`, `source_formula`, `promql`, `reason_codes` | no | Array of strings. A single string is wrapped into an array. Missing means empty. |
| `thresholds.degraded`, `thresholds.failed` | no | Numbers, for the check rule. |
| `verification.schema_valid`, `.promql_valid`, `.imported`, `.returns_data` | no | Booleans. Anything else (including `null` and missing) is kept as `null`, which means "not tested". `returns_data: false` shows "No samples yet". |
| `verification.numeric_check` | no | Kept as is. |
| `dash0.asset_id`, `dash0.url`, `dash0.import_status` | no | Strings or `null`. A `dash0.url` shows an "Open in Dash0" link. |

An item with no `id`, or with neither `status` nor a usable `claim`, is skipped and a warning is recorded.

How `claim`, `condition` and unknown statuses are handled:

- If `status` is missing, it is derived from `claim`: `exact` and `exact-under` give `exact`; `bounded` gives `approximate`; `manual` gives `unsupported`. If both are present, `status` wins.
- `status: "exact"` with `claim: "exact-under"` is shown as "Exact if <condition>" (or "condition not supplied"). It stays `exact`, so it needs no review.
- An unrecognised `status` string is kept. It gets a neutral "unknown" look and is counted in `total` only, not in any status count. Add the name to `report.ts` and `src/lib/status.ts` to support it.
- Review eligibility follows `status`, not `claim`: groups and exact widgets are never reviewed; every monitor is.

### review.json (output)

Exported from the Review page as `review.json`:

```json
{
  "schema_version": "1",
  "report_sha256": "<SHA-256 hex of the exact report.json text that was loaded>",
  "reviewer": "name typed by the reviewer",
  "decisions": [
    { "id": "widget-4.1", "decision": "approved", "note": "" }
  ]
}
```

- `report_sha256` is computed in the browser from the raw file text, byte for byte. The CLI must hash the same bytes (the file it wrote) and refuse a `review.json` that does not match.
- Only valid decisions are written. Invalid ones are dropped: a decision not allowed for the item, or a check rule marked `approved` before all five checklist ticks.
- Allowed decisions: approximate widget gives `approved` or `flagged`; unsupported, no-equivalent and failed widgets give `acknowledged` only; check rule gives `approved` or `flagged`; groups and exact widgets get none.
- Decisions are also kept in the reviewer's localStorage under `mrc-review:<sha>`, so they never carry across reports.

What each decision means for import:

| Item | Decision | Import does |
| --- | --- | --- |
| Exact widget | none needed | Imports the translated panel |
| Approximate widget | `approved` | Imports the translated panel |
| Approximate widget | `flagged` | Imports a placeholder panel with the note |
| Approximate widget | no decision | Not decided; the console counts it as pending |
| Unsupported, no-equivalent or failed widget | `acknowledged` | Always a placeholder panel |
| Check rule | `approved` | Imports the check rule |
| Check rule | `flagged` or none | Does not import the check rule |

## 4. The integration hook

Put the CLI's output at `public/report.json`. On start the app fetches `/report.json`. If the file exists and parses, it is loaded as real data and the sample banner is hidden. If it is missing or invalid, the bundled sample (`src/data/report.sample.json`) is shown with a banner. The **Load report.json** button in the sidebar loads a file from disk instead.

The banner also shows if the file itself contains a top-level `SAMPLE` key, so the CLI must not write one.

## 5. Moving it into the fork

Copy the app into `console/` in the fork as its own package. Keep Bun there. Exclude `console/` from the fork's root lint, tests and tsconfig so it does not affect the CLI's checks.

Copy these from this repo:

- `package.json`, `bun.lock`, `bunfig.toml`
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `components.json`, `.prettierrc`, `.prettierignore`, `.gitignore`
- `src/` (all of it, including `src/data/report.sample.json` and `src/test/`)
- `public/`
- `scripts/shots.mjs`
- `README.md`, `AGENTS.md`, `INTEGRATION.md`

Do not copy `.lovable/`, `node_modules/`, `shots/` or `roadmap.md`. `src/routeTree.gen.ts` is generated by TanStack Router; copy it, and do not edit it by hand. The Lovable error-reporting files in `src/lib/` do nothing outside Lovable and can stay.

In the fork's root config, add `console/` to the ignore list of ESLint, the test runner and tsconfig `exclude`. `console/` has its own `eslint.config.js`, `vitest.config.ts` and `tsconfig.json`.

One-command smoke test:

```sh
cd console && npx bun install --frozen-lockfile && npx bun run test && npx bun run build
```

## 6. Tasks for the team board

| ID | Owner role | Task | Files | Acceptance check |
| --- | --- | --- | --- | --- |
| U1 | Fork maintainer | Copy the app into `console/` and open a PR. | `console/**`, root lint, test and tsconfig excludes | The smoke test passes in `console/`. Root lint, tests and tsc do not touch `console/`. |
| U2 | CLI engineer | CLI writes `report.json` to `console/public/report.json` using the agreed schema. | CLI report writer, `console/public/report.json` | `npx bun run dev` loads it with no sample banner. The warnings list is empty. |
| U3 | CLI engineer | CLI reads `review.json` with `--approved` and checks `report_sha256`. | CLI import command | A `review.json` from a different `report.json` is refused with a clear error. A matching one imports per the table in section 3. |
| U4 | Console engineer | Replace the sample with real CLI output and fix field mismatches. Change `src/lib/report.ts` only. | `src/lib/report.ts`, `src/test/report.test.ts` | Counts on Overview match the CLI's own summary. No other file changed for a rename. |
| U5 | CLI engineer | After import, fill `dash0.url` and the `verification` fields, then re-write `report.json`. | CLI import step, `console/public/report.json` | Items show "Open in Dash0" and verified chips. The new file has a new hash, so old decisions do not carry over. |
| U6 | Front-end engineer | Projector polish on real data. | `src/styles.css`, `src/components/map/DashboardMap.tsx`, `src/components/detail/DetailPanel.tsx` | `npx bun run shots` reports no overflow at 1920x1080 and 1440x900. Approve, Flag and Acknowledge are visible on the map without scrolling the page. |
| U7 | Front-end engineer (optional) | Evidence tab for the numbers check. | `src/lib/report.ts` (read `numeric_check`), a new component under `src/components/` | Each item with a `numeric_check` shows its result. Counts come from the file. |

## 7. Known gaps

- **The sample data is predicted.** `src/data/report.sample.json` was written by hand to match the expected CLI output. Its numbers are not results.
- **Commands are provisional.** The `--approved` flag and the import command in U3 are the planned shape, not final.
- **Status names are mapped in `report.ts`.** `exact-under`, `bounded` and `manual` come in as `claim` values and are mapped to `exact`, `approximate` and `unsupported` there. If the CLI uses different names, change the mapping there.
- **Bad `/report.json` falls back silently.** If the file exists but does not parse, the app shows the sample with its banner and no error. Check the banner.
- **Dev port.** The README says 8080; Vite moves to the next free port if it is taken.
