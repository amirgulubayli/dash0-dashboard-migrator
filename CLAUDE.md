# Dash0 Hackathon - Observability Migrator (Datadog -> Dash0, + more vendors)

24-hour hackathon. Build a **CLI transpiler** that migrates dashboards, queries and alerts from
Datadog (primary) and other vendors (bonus points) into Dash0, using open standards:
**Perses** (dashboards), **PromQL** (queries), **Prometheus alerting rules + Dash0 `$__threshold`** (alerts),
**OpenTelemetry semantic conventions** (metric/attribute names).

## Hard rules from the brief (do not break)
- **No LLM in the translation path.** Query/config translation must be deterministic: parsers,
  explicit rules, mapping tables. "LLM wrapper that rewrites configs" = disqualified.
  (AI may only appear as clearly labelled suggestions for items flagged "manual" - safest to skip.)
- **Never silently drop functionality.** Every unsupported widget/function is logged and reported;
  preserve the original config for reference (panel description / alert annotation).
- **Source ingest:** official vendor APIs with user credentials, AND folder-of-exports mode.
- **Destination:** Dash0 import APIs (below).
- **Extensible:** vendor-specific adapters feeding one shared intermediate representation (IR).
- **Submission:** fork https://github.com/vimouzin/dash0-dashboard-migrator (currently empty apart
  from README), work on a feature branch, never commit to upstream main, open PR to upstream main
  with: summary, key features, setup + usage, known limitations.
- Dash0 org name must start with `thinc` (EU region). Datadog trial on EU site (app.datadoghq.eu).
- Minimum to qualify: ingest >=1 dashboard + >=1 alert -> translate -> show them working in Dash0.

## Architecture (repo already scaffolded by teammate - follow the existing layout)
TypeScript, Node >=22, ESM. Tests: vitest. PromQL validation: @prometheus-io/lezer-promql.
CLI: `dd2dash0 migrate --from datadog (--input <dir> | --api) [--dry-run] [--out <dir>] [--only dashboards|monitors]`
(`npx tsx src/cli.ts ...`). Work is split into tasks T1-T8; each module folder has a README describing its task.
Check `src/cli.ts` and module READMEs before changing shared contracts (CLI flags, IR types) - coordinate with teammate first.
```
src/sources/datadog     -> fetch via API or read exported JSON
src/parse               -> Datadog query grammar -> AST
src/ir                  -> intermediate representation (Dashboard, Panel, Query, Alert, TranslationStatus)
src/translate/query     -> AST -> PromQL
src/translate/dashboard -> widgets/layout -> Perses
src/translate/alerts    -> monitors -> Dash0 check rules ($__threshold)
src/validate            -> PromQL parse, schema checks; reject bad items BEFORE import
src/targets/dash0       -> import APIs
src/report              -> migration report (exact / approximate / manual)
mappings/               -> Datadog -> OTel metric name tables
fixtures/datadog        -> redisdb, postgres, nginx dashboards + monitors
```
Future vendors (New Relic, Grafana) = new folder under src/sources/ feeding the same IR.
Every translated item gets status: **exact** | **approximate (reason)** | **manual (reason)**.

## Dash0 API facts (verified from docs)
- Base URL (EU Ireland): `https://api.eu-west-1.aws.dash0.com`. Auth: `Authorization: Bearer $DASH0_AUTH_TOKEN`.
  Optional `?dataset=default` (or `Dash0-Dataset` header).
- `POST /api/import/dashboard` - body `{kind:"Dashboard", metadata:{name, dash0Extensions:{id?}}, spec:{display, datasources, variables, panels, layouts, duration, refreshInterval}}`.
  No id -> create; existing id -> overwrite.
- `POST /api/import/check-rules` - body `{items:[PrometheusAlertRule...]}` (<=1000, <=2MB).
  Sample item: `{name, expression}`. **Whole batch rejected if any item invalid. Not idempotent** -> validate first, don't re-run blindly.
  Full PrometheusAlertRule schema not on the page - get it from Dash0's OpenAPI JSON or by exporting a UI-made rule.
- `$__threshold`: put after a comparison op, e.g. `sum(rate(...[5m])) > $__threshold`. Supports
  **degraded** and **critical** values; higher = critical. Without it, any non-empty result = CRITICAL.
- PromQL naming in Dash0: select metrics by `{otel_metric_name="redis.clients.connected", ...}` (dots kept);
  label names use underscores (`service_name`, `service_namespace`).
- Docs: https://www.dash0.com/docs/api-reference/operations/post/api/import/dashboard ,
  https://www.dash0.com/docs/api-reference/operations/post/api/import/check-rules ,
  https://www.dash0.com/docs/dash0/monitoring/alerting/alerting-model#the-dollarthreshold-extension ,
  https://perses.dev/

**FIRST TASK (Phase 0 spike):** build one dashboard + one check rule by hand in the Dash0 UI,
export them, and save as `fixtures/dash0/` golden files. Use them to learn the exact Perses panel
plugin kinds, datasource block and check-rule fields Dash0 accepts. Don't guess the schema.

## Test corpus: DataDog/integrations-core
Repo: https://github.com/DataDog/integrations-core - `<integration>/assets/dashboards/*.json`,
`<integration>/assets/monitors/*.json`, `<integration>/metadata.csv`.
Sparse-clone only the assets: `git clone --filter=blob:none --sparse ... && git sparse-checkout set --no-cone '*/assets/' '*/metadata.csv'`.

Survey results (516 dashboards, 329 monitors):
- Widgets: timeseries 4619, query_value 2512, toplist 2176, group 1808, note 1735, sunburst 793,
  list_stream 753, query_table 725, image 352, check_status 188, geomap 122 ... long tail (hostmap, flame_graph, sankey...).
- Request format: ~85% new `queries`+`formulas`, ~15% legacy `q:` string -> parse both.
- Data sources: metrics 6392, logs 4998, security_signals 350, cloud_cost 139, ... -> metrics first, logs stretch.
- Functions by frequency: as_count, default_zero, rollup, top, fill, as_rate, exclude_null,
  monotonic_diff, count_nonzero, weighted, per_second, per_minute, derivative, timeshift, week_before, diff, ...
- Monitors: query alert 284 (86%), log alert 35, service check 7. `anomalies()` in 46 -> flag manual.
- `metadata.csv` has `metric_type` (gauge/count/rate) + unit per metric -> **use it** to pick correct
  rate/increase semantics. This is the "semantic correctness" story.
- Demo integration: **redisdb** (1 dashboard, 36 widgets, all metric-based, 1 monitor; OTel Collector
  has a redis receiver). Backups: postgres, nginx, mysql.

## Translation rules (starting set)
| Datadog | PromQL / Dash0 | status |
|---|---|---|
| `avg:m{env:prod,!role:replica} by {host}` | `avg by (host) ({otel_metric_name="m'", env="prod", role!="replica"})` | exact |
| `tag:val*` | `tag=~"val.*"` | exact |
| `.as_rate()` / `per_second()` on count | `rate(...[$__rate_interval])` | exact |
| `per_minute()` | `rate(...)*60` | exact |
| `.as_count()` | `increase(...[$__interval])` | approximate |
| `rollup(avg,60)` | `avg_over_time(...[60s])` | exact |
| `top(q,10,'mean','desc')` | `topk(10, ...)` | approximate |
| `week_before()` / `timeshift(-3600)` | `offset 1w` / `offset 1h` | exact |
| `default_zero()` / `fill(zero)` | `... or vector(0)` | approximate |
| `derivative()` / `abs()` / `log10()` | `deriv()` / `abs()` / `log10()` | exact/approx |
| formulas `query1/query2*100` | inline sub-expressions, `on()`/`ignoring()` for label matching | careful |
| `anomalies()` `forecast()` `outliers()` | - | manual |
| monitor `avg(last_5m):<q> > 90` (warning 80) | `avg_over_time(<q>[5m]) > $__threshold`, critical 90, degraded 80 | exact |
| monitor message `{{host.name}}` | annotation `{{ $labels.host }}` | exact |
| monitor tags | rule labels | exact |

Widgets -> Perses: timeseries->TimeSeriesChart, query_value->StatChart, toplist->BarChart,
query_table->Table, note->Markdown, group->collapsible Grid section. Layout: Datadog 12-col grid ->
Perses 24-col (x2 on x/width). `ordered` layouts without positions -> auto-flow.
(Confirm all plugin kinds against the Phase 0 golden export.)

Metric names: lookup table DD->OTel per demo integration (e.g. `redis.net.clients`->`redis.clients.connected`).
No mapping -> keep original name + warning.

## Timeline (team 3-4; milestones are gates)
- **H0-2 Phase 0:** accounts, fork+branch, CLI skeleton, Dash0 golden exports, docker-compose with
  Redis + Datadog Agent (->Datadog) + OTel Collector (->Dash0) so both platforms have the same live data.
  Import redisdb dashboard+monitor into Datadog.
- **H2-8 Phase 1:** A: DD query grammar->PromQL (TDD). B: widget->Perses + layout. C: monitor->check rule + Dash0 importer.
  D: Datadog API adapter (`/api/v1/dashboard`, `/api/v1/monitor`, EU site `api.datadoghq.eu`) + folder ingest.
  **M1 @H8: Redis dashboard + monitor live in Dash0 with data.**
- **H8-14 Phase 2:** functions, formulas, groups, more widgets; validation; migration report;
  run translator over all 516/329 -> coverage stats. **M2 @H14: 3 integrations end-to-end + coverage numbers.**
- **H14-20 Phase 3:** equivalence check (same window: DD query API vs Dash0 Prometheus API, per-panel diff);
  New Relic adapter (NerdGraph export + NRQL parser -> same IR); optional Grafana adapter (already PromQL).
  Skip Cribl.
- **H20-24 Phase 4:** feature freeze, README, PR, backup demo video, rehearse twice.

## Demo script (~3 min)
DD Redis dashboard -> one CLI command -> same dashboard live in Dash0 + alert firing at right severity
-> migration report with flags -> corpus coverage numbers -> equivalence diff -> repeat with New Relic.

## Env vars
`DD_API_KEY`, `DD_APP_KEY`, `DD_SITE=datadoghq.eu`, `DASH0_AUTH_TOKEN`,
`DASH0_API_URL=https://api.eu-west-1.aws.dash0.com`, `DASH0_DATASET=default`,
`NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`. Never commit secrets - `.env` in `.gitignore`.
