# 00 · Architecture and team plan

Status: **DRAFT v0.1** (2026-11-07). The IR in section 4 is a *proposal*. The T1 owner ratifies it
by posting it as CONTRACT-001 (section 6). Until then, code against it but expect renames.

Background, the brief's hard rules, Dash0 API facts and the translation rule table are in
[`CLAUDE.md`](../../CLAUDE.md). This doc doesn't repeat them. It covers **who builds what, and the
interfaces between modules**.

---

## 1. Pipeline

```
            ┌──────────── vendor-specific ────────────┐   ┌──────── vendor-neutral ─────────┐
 Datadog    │ T2 sources/datadog    T3 parse          │   │                                  │
 API/folder ─┼─> raw JSON ──> IR Dashboard / IR Alert  │──>│ T5 translate/dashboard ─> Perses │──> T7 targets/dash0
            │      (queries kept as source strings)   │   │ T6 translate/alerts ─> CheckRule │      (POST / dry-run)
            │                                         │   │        │                         │
            │ T4 translate/query: DD string ─T3 AST─> │<──┼────────┘ (QueryTranslator by     │
            │    PromQL + Findings  (T4 validate)     │   │           vendor)                │
            └─────────────────────────────────────────┘   └──────────────┬──────────────────┘
                                                                          v
                                                 T8 report (Findings -> terminal, report.json, report.md)
                                                 T8 cli.ts wires all of the above
```

Design rules:
- **The IR is source-side and vendor-neutral in structure.** Dashboards, panels, layout, variables
  and alerts are normalised. **Query text stays in the vendor's language** (`SourceQuery`) and is
  translated only at the edge, by a per-vendor `QueryTranslator`. A New Relic adapter adds
  `sources/newrelic` and an NRQL translator. T5, T6, T7 and T8 stay unchanged.
- **Every lossy decision emits a `Finding`.** No module returns `null`, or skips an item, without one.
- **Originals travel with the item** (`original` field) so T5 and T6 can put them in panel
  descriptions and alert annotations.
- **Pure functions** everywhere except T2 (reads files, fetches) and T7 (POSTs). This makes testing easy.

## 2. Task board

| Task | Scope (only touch these paths) | Deliverable | Depends on | Owner |
|---|---|---|---|---|
| **T0** Phase 0 spike | `fixtures/dash0/`, `docker-compose.yml` | Hand-made Dash0 dashboard + check rule exported as golden files; Redis + DD Agent + OTel Collector compose | accounts | _unclaimed, do first_ |
| **T1** IR + mappings (HOT) | `src/ir/**`, `mappings/**` | IR types, `Finding`, mapping loader, redisdb/postgres/nginx metric tables (from `metadata.csv` + DD OTel mapping doc) | nothing | _Amir? (confirm)_ |
| **T2** Datadog ingest | `src/sources/datadog/**` | `--input` folder and `--api` (EU) → IR. Unwraps `{version, definition}`. Normalises legacy `q` and `queries`+`formulas` | T1 | _unclaimed_ |
| **T3** DD query parser | `src/parse/**` | Recursive-descent parser for metric queries, formulas and monitor queries → AST. Errors carry position | nothing | **Ali (proposed)** |
| **T4** Query → PromQL + validate | `src/translate/query/**`, `src/validate/**` | `datadogQueryTranslator`, PromQL builder, lezer-promql validation, Perses shape checks | T1, T3 | **Ali (proposed, after T3)** |
| **T5** Dashboard → Perses | `src/translate/dashboard/**` | Widget → panel, 12→24 grid, groups, variables, unsupported → Markdown + Finding | T1, T4 interface, T0 golden | _unclaimed_ |
| **T6** Monitor → check rule | `src/translate/alerts/**` | `$__threshold`, critical/degraded, message templating, tags → labels, `anomalies()` → manual | T1, T4 interface, T0 golden | _unclaimed_ |
| **T7** Dash0 target | `src/targets/dash0/**` | Import client, ids `dd-<id>`, `--dry-run` writes to `--out`, pre-validation (the check-rule batch is all-or-nothing) | T1, T0 golden | _unclaimed_ |
| **T8** Report + CLI (HOT: cli.ts) | `src/report/**`, `src/cli.ts` | Report outputs, CLI flags, end-to-end wiring, corpus coverage command | all | _Amir? (confirm)_ |

**Critical path:** T0 + T1 → T3 → T4 → T5/T6 → T7 → T8. T3 and T0 can start immediately.
T2, T5, T6 and T7 can start as soon as CONTRACT-001 (the IR) is posted. Code them against stub
translators (`QueryTranslator` that returns `manual`).

To claim a task, put your name in the Owner column in a commit that touches only this file.

## 3. Milestones (from the brief)

| Gate | When | Done means |
|---|---|---|
| **M0** | H2 | Golden Dash0 exports in `fixtures/dash0/`. CONTRACT-001 posted. Everyone has `npm test` green |
| **M1** | H8 | `redisdb__overview` + `redisdb__high_mem` migrated **live in Dash0 with data** via one CLI command |
| **M2** | H14 | redisdb, postgres and nginx end-to-end. Coverage numbers over the 516 dashboards / 329 monitors |
| **M3** | H20 | Equivalence diff (DD query API vs Dash0 Prometheus API). New Relic adapter if time allows |
| **M4** | H24 | Feature freeze, README (setup, usage, limitations), PR to upstream main, demo rehearsed |

Vertical slice order (from `fixtures/datadog/README.md`): postgres timeseries dashboard → redisdb
high-mem monitor → redisdb overview → postgres screenboard → nginx (legacy `q`, unsupported widgets).

## 4. Interfaces (PROPOSED: ratify as CONTRACT-001)

Specs, not implementation. Final TypeScript lives in `src/ir/` (T1).

### 4.1 Findings (`src/ir/finding.ts`)
```ts
type TranslationStatus = "exact" | "approximate" | "manual";

interface Finding {
  status: Exclude<TranslationStatus, "exact">; // only non-exact things are findings
  code: string;          // stable machine id, e.g. "fn.top.approx", "widget.unsupported", "metric.unmapped"
  message: string;       // human sentence for the report
  itemKind: "dashboard" | "panel" | "query" | "alert";
  itemId: string;        // e.g. "dd-dash-abc/panel-12/query1" (built by whoever emits it)
  original?: string;     // the source fragment that triggered it
}
// Rolling up: an item's status = worst of (its own status, its children's findings).
```

### 4.2 IR (`src/ir/types.ts`)
```ts
interface SourceRef { vendor: "datadog" | "newrelic" | "grafana"; id: string; url?: string }

interface SourceQuery {          // NOT translated yet
  vendor: SourceRef["vendor"];
  refId: string;                 // "query1", "a", ...
  dataSource: string;            // "metrics" | "logs" | ... (non-metrics -> manual for now)
  expr: string;                  // raw vendor query text, e.g. "avg:redis.mem.used{$scope} by {host}"
  hidden?: boolean;
}
interface QuerySet {             // one widget request / one monitor
  queries: SourceQuery[];
  formulas: { expr: string; alias?: string }[];  // [] = plot every query; legacy "q" -> 1 query + 0 formulas
}

interface Variable { name: string; tagKey: string; default?: string; multi?: boolean }

interface Panel {
  id: string;
  kind: "timeseries" | "stat" | "bar" | "table" | "markdown" | "unsupported";
  title?: string;
  sourceType: string;            // original widget type, e.g. "query_value", "hostmap"
  layout: { x: number; y: number; w: number; h: number } | null;   // SOURCE grid units (DD: 12 col); null = auto-flow
  requests: QuerySet[];
  options: Record<string, unknown>;   // unit, precision, palette, markdown text, ...
  original: unknown;                  // raw widget JSON
}
interface Group { id: string; title?: string; collapsed?: boolean; panels: Panel[]; layout: Panel["layout"] }

interface Dashboard {
  source: SourceRef; title: string; description?: string;
  gridColumns: number;           // 12 for Datadog. T5 rescales to Perses' 24
  variables: Variable[];
  items: (Panel | Group)[];
  original: unknown;
}

interface Alert {
  source: SourceRef; name: string; message: string;
  type: string;                                  // "query alert", "log alert", ...
  query: string;                                 // full monitor query, e.g. "avg(last_5m):100 * a / b > 90"
  thresholds: { critical?: number; warning?: number; criticalRecovery?: number; warningRecovery?: number };
  tags: string[]; options: Record<string, unknown>; original: unknown;
}
```

### 4.3 Module entry points
| Module | Export | Signature |
|---|---|---|
| T2 | `src/sources/datadog/index.ts` | `ingestDatadog(opts: {input?: string; api?: boolean; only?: "dashboards"\|"monitors"}): Promise<{dashboards: Dashboard[]; alerts: Alert[]; findings: Finding[]}>` |
| T3 | `src/parse/index.ts` | `parseMetricQuery(s): MetricQueryAst`, `parseFormula(s): FormulaAst`, `parseMonitorQuery(s): MonitorAst`. All throw `ParseError {message, pos}` |
| T4 | `src/translate/query/index.ts` | `interface QueryTranslator { translate(qs: QuerySet, ctx): TranslatedQuery[] }` with `TranslatedQuery = {promql: string; legend?: string; status; findings: Finding[]}`. `datadogQueryTranslator` implements it. A registry keyed by `vendor` |
| T4 | `src/validate/index.ts` | `validatePromql(s): {ok: true} \| {ok: false; error: string}`, `validatePerses(d): string[]` |
| T5 | `src/translate/dashboard/index.ts` | `toPerses(d: Dashboard, qt: QueryTranslator): {dashboard: PersesDashboard; findings: Finding[]}` |
| T6 | `src/translate/alerts/index.ts` | `toCheckRule(a: Alert, qt): {rule: Dash0CheckRule \| null; findings: Finding[]}` (null only alongside a `manual` finding) |
| T7 | `src/targets/dash0/index.ts` | `importDashboard(p, opts)`, `importCheckRules(rules, opts)`. `opts = {dryRun, outDir, apiUrl, token, dataset}` |
| T8 | `src/report/index.ts` | `buildReport(items, findings): Report`, `writeReport(r, outDir)`, `printSummary(r)` |

`ctx` for `QueryTranslator` carries: mappings (T1), metric metadata (type/unit from `metadata.csv`),
variables in scope, and mode (`"panel"` vs `"alert"`, because alerts get the `[window]` from the monitor).

Perses / Dash0 check-rule TypeScript types live in `src/targets/dash0/schema.ts`. They are owned by
T7 and written **from the T0 golden exports**, not guessed. T5 and T6 import them from there.

## 5. Conventions
- TypeScript strict, ESM, Node ≥ 22. Relative imports end in `.js`.
- Tests: `tests/<module>/*.test.ts` (vitest). TDD against `fixtures/datadog/`. Every translation
  rule in CLAUDE.md gets at least one test that checks the exact PromQL string.
- **No LLM / network calls in `parse`, `translate`, `validate`.** Network only in T2 and T7.
- Never commit secrets, `node_modules/`, `dist/` or `out/`.
- Branch: everyone works on `feature/datadog-to-dash0` (or short-lived `t<N>-*` branches merged into
  it). Rebase before push. Small commits that stay inside your task's scope.
- `npm run typecheck && npm test` must be green before every push.

## 6. Contracts and HOT files

HOT files: `src/ir/**`, `mappings/**` (format), `src/cli.ts` (flags), `src/targets/dash0/schema.ts`,
and this plan's section 4.

To change one:
1. Append an entry to [`../CONTRACTS.md`](../CONTRACTS.md): `CONTRACT-NNN · author · date · what changes · who is affected`.
2. Tell the team in chat with the CONTRACT number.
3. The owner makes the change in **one commit** that includes the updates to every caller (or stubs).
   Never rename a field silently.

## 7. Open questions
- Exact Perses panel plugin kinds and datasource block Dash0 accepts (T0 answers this).
- Full `PrometheusAlertRule` schema for `/api/import/check-rules` (T0: export a UI-made rule, or the OpenAPI JSON).
  Also: does Dash0 expect `$__threshold` per rule with `thresholds: {degraded, failed}`?
- Variables: does Dash0 Perses support `ListVariable` backed by PromQL `label_values`? (T0)
- Who owns the coverage run over the full integrations-core corpus (T8, or whoever is free at H8)?
