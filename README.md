# dd2dash0

**Move your Datadog dashboards and monitors to Dash0 with one command, and get a report that tells you exactly what made it.**

`dd2dash0` reads your Datadog account and translates every dashboard to a **Perses** dashboard, every query to **PromQL**, and every monitor to a **Dash0 check rule**. It imports them into Dash0, reads each item back, checks that the new queries return real data, and prints how well it went.

Translation is **deterministic**: a Datadog query parser, rule tables and metric mapping tables do the work. **No AI model touches your queries.** Anything that can't be translated exactly is never dropped: it lands as a placeholder panel holding the original query, and the report says why.

It runs in your terminal, because the people who migrate monitoring are engineers, and engineers live there. No web app to log in to, no account to create.

## Quick start

Download one file and run it. No Node, no clone, no install:

```bash
# macOS, Apple silicon (M1-M4)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-arm64.tar.gz | tar xz && cd dd2dash0-macos-arm64 && ./dd2dash0
```
```bash
# macOS, Intel
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-x64.tar.gz | tar xz && cd dd2dash0-macos-x64 && ./dd2dash0
```
```bash
# Linux x64 (use dd2dash0-linux-arm64 on ARM)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-linux-x64.tar.gz | tar xz && cd dd2dash0-linux-x64 && ./dd2dash0
```
Windows: download `dd2dash0-windows-x64.zip` from [Releases](https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest), unzip it, and run `.\dd2dash0.exe` in PowerShell.

Each archive holds the `dd2dash0` executable, its `mappings/` folder (keep them together) and a short README. `SHA256SUMS.txt` on the release lists the checksums. If macOS refuses a browser download ("cannot be opened"), run `xattr -d com.apple.quarantine dd2dash0` once; downloading with `curl` as above avoids this.

## What a run looks like

A real run against our Datadog trial and Dash0 org (1 dashboard, 1 monitor):

```
╭──────────────────────────────────────────╮
│ ◆ dd2dash0 0.4.1                         │
│   Datadog → Dash0 · deterministic, no AI │
╰──────────────────────────────────────────╯

● Keys
  ⎿ Datadog  datadoghq.eu · API key …b57c · app key …e17s  ✓
  ⎿ Dash0    api.europe-west4.gcp.dash0.com · default · token …Waoy  ✓

● Translate  1 dashboard · 1 monitor → 37 items  0.5s
  ⎿ 21 exact-under · 10 bounded · 5 manual · 1 unsupported

● Review
  Import 10 approximate panels? They are translated within a proven error bound.  › Yes, import them
  ⎿ 6 panel(s) can't be translated exactly; they become placeholder panels with the original Datadog query.
  Import this check rule?  › Yes, import it (it starts off)

● Import  1 dashboard · 1 check rule  1.2s
● Verify  read back 2/2 · 22/22 queries return data  0.7s

╭─ Result ───────────────────────────────────────────────╮
│ success     ███████████████░░░    31/37   83%          │
│ translated  ███████████████░░░    31/37   83%          │
│ landed      ██████████████████    37/37  100%          │
│ live        ██████████████████    22/22  100%          │
│                                                        │
│ gaps   metric.no_equivalent ×5 · widget.unsupported ×1 │
│ rules  1 imported (0 on, 1 off)                        │
│ report report.html · report.md                         │
╰────────────────────────────────────────────────────────╯
```

What the numbers mean (each counts every panel, including notes, and every monitor; percentages round down):

| Number | Meaning |
|---|---|
| **translated** | exact, exact under stated conditions, or approximate within a proven bound and approved by you |
| **landed** | imported into Dash0 and read back identical (placeholders count: they landed) |
| **live** | the migrated query returns data in Dash0 when the Datadog query has data (last hour) |
| **success** | translated, landed, and not missing data |

Every run writes `dd2dash0-run/<time>/report.html` (open it in a browser), `report.md` and `report.json`, with every panel and monitor, its claim, the original Datadog query, the PromQL, and what to do by hand where needed.

## What you need

| Key | Where to find it |
|---|---|
| Datadog API key | Datadog → Organization Settings → API Keys |
| Datadog application key | Organization Settings → Application Keys (needs `dashboards_read`, `monitors_read`) |
| Datadog site | `datadoghq.eu`, `datadoghq.com`, `us5.datadoghq.com`, … |
| Dash0 API URL | Dash0 → Settings → Endpoints → **API** (not the ingress/OTLP endpoint) |
| Dash0 auth token | Dash0 → Settings → Auth Tokens |
| Dash0 dataset | usually `default` |

`dd2dash0` looks for them in the environment and in `./.env`. It asks for anything missing, in the terminal (keys hidden as you type) or, if you choose, on a one-time page on your own computer (`--browser`: 127.0.0.1 only, secret link, closes after use). It checks every key with a read-only call before doing anything, and offers to save them to `./.env` (readable only by you).

## What it does, step by step

1. **Keys**: finds, asks for, and checks the six values above.
2. **Translate**: reads every dashboard and monitor from the Datadog API and translates them. Nothing is written yet.
3. **Review**: one question for all approximate panels, one per monitor (arrow keys). Panels that can't be translated exactly become placeholders with the original query.
4. **Import**: dashboards and check rules go into Dash0. Re-runs replace, never duplicate. New check rules start **off**, so nobody gets paged by surprise; a rule that already exists keeps its on/off state.
5. **Verify**: reads every item back from Dash0 and runs every migrated query against the last hour of data, next to the original Datadog query.
6. **Report**: the result card, `report.html`, `report.md`, `report.json`. At the end it offers to turn the approved rules on (default no) and to open the report.

Options: `--yes` (no questions: keys from env or `.env`, approve approximate panels and translatable monitors), `--only dashboards|monitors`, `--browser`, `--out <dir>`, `--help`. Exit codes: 0 all good, 1 something failed (see the report), 2 refused, 3 usage or key error. Scripting commands (`plan`, `review --terminal`, `apply`, `migrate`) are listed by `--help-advanced`.

## How it works

```
Datadog API ──► parse (Datadog query grammar → AST) ──► IR (dashboards, panels, queries, alerts)
            ──► translate (PromQL + Perses panels + Dash0 check rules, every step emits findings)
            ──► validate (PromQL parses, Perses shape, preflight) ──► import (Dash0 API) ──► read back
            ──► verify (Dash0 query API vs Datadog query API, last hour) ──► report
```

- **Deterministic**: the same input and version always give the same output (the report carries an output hash to prove it).
- **Honest claims**: every item is `exact`, `exact-under` (exact if stated conditions hold), `bounded` (within a proven error), `manual` or `unsupported`. Nothing is rounded up.
- **Metric mappings**: Datadog integration metrics map to their OpenTelemetry receiver equivalents through `mappings/` (Redis, PostgreSQL, NGINX, system/host metrics).
- **Monitors**: become Prometheus alerting rules with Dash0's threshold extension (`critical` → `failed`, `warning` → `degraded`).

## Known limits

- Monitors that use Datadog-only functions (anomaly detection, forecasts, outliers) can't become a PromQL rule. They are listed in the report with the reason, not imported.
- Metrics with no OpenTelemetry equivalent keep their Datadog name and are flagged (`metric.no_equivalent`): the panel lands, but Dash0 may have no series by that name.
- Datadog Agent integrations not in `mappings/` translate structurally, with every unmapped metric flagged.
- The arrow-key prompts are not tested on Windows yet.

## Run from source

```bash
git clone https://github.com/amirgulubayli/dash0-dashboard-migrator && cd dash0-dashboard-migrator
npm ci
npx tsx src/cli.ts                                              # the guided flow
npx tsx src/cli.ts --dry-run --input fixtures/datadog           # offline: translate the bundled fixtures, import nothing
npm test                                                        # the test suite
```

Needs Node 22+. Pushing a tag `v<version>` (matching the version in `package.json` and `src/cli.ts`) builds every platform and publishes a release (`.github/workflows/release.yml`).

`experimental/` holds parked extras (a web review console, a live viewer and voice narrator). They are not part of the CLI.
