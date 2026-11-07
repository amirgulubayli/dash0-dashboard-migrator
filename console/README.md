# Migration Review Console

A browser-only tool for reviewing a Datadog-to-Dash0 migration. It reads the `report.json` written by the migration CLI. It shows an overview, a dashboard map, an items list and a review queue, and exports your decisions as `review.json`.

There is no backend, no login, no AI and no network calls. Translation is done by the CLI (it must be deterministic); this app only displays and reviews the result.

## Run it

The lockfile is `bun.lock`, so Bun is the package manager.

```sh
bun install
bun run dev      # http://localhost:8080
bun run build
bun run test
```

`npm install` / `npm run dev` also work, but they won't use the lockfile.

## Load a report.json

- **Public folder:** put the file at `public/report.json`. On start the app fetches `/report.json`; if it exists it is loaded as real data and the sample banner is hidden.
- **Button:** use **Load report.json** in the header to pick a file from disk.
- If neither is present the bundled sample (`src/data/report.sample.json`) is shown with a banner.

**The sample data is predicted, not tool output.** It was written by hand to match the expected shape of the CLI's report. Do not treat its numbers as results.

## What the files contain

**report.json** (input, from the CLI): run info, a summary, diagnostics, and a list of items (groups, widgets and monitors). Each item has its source queries, the translated PromQL, a status (exact, approximate or no equivalent metric), reason codes, layout and verification results. All parsing and field names live in `src/lib/report.ts`.

**review.json** (output, exported from the Review page): `schema_version`, `report_sha256` (SHA-256 of the exact report text you loaded), `reviewer`, and `decisions`, a list of `{ id, decision, note }` where decision is `approved`, `flagged` or `acknowledged`. Decisions are also kept in your browser's localStorage, keyed by the same hash, so they never carry across reports.

## Lovable

The project was created in [Lovable](https://lovable.dev) and syncs with it. See `AGENTS.md` for what Lovable manages. Outside Lovable, its error-reporting hooks do nothing.
