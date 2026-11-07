# translate/query

Task **T4** · scope `src/translate/query/**`, `src/validate/**` · Datadog query AST (from `src/parse`) -> PromQL. Deterministic, no I/O, no LLM.

## API
```ts
translateQuery(expr, ctx?, env?)            // dashboard query or formula (env: query1 -> parsed query)
translateMonitor(monitorQuery, {critical, warning}?, ctx?)  // metric/query alert -> check-rule expression
validatePromQL(text)                        // src/validate/promql.ts, @prometheus-io/lezer-promql
```
Each call returns `{ status, promql, rules, assumptions, findings }`. Monitors also return `thresholds {failed, degraded?}` and `negated`.
- `status` is the plan 03 claim: `exact | exact-under | bounded | manual`. It's the worst status among the rules applied.
- `promql` is `null` exactly when `status` is `manual`.
- `rules` lists the `ruleId`s applied. `assumptions` is the ledger for `exact-under`; ids and meanings are in `ASSUMPTIONS`.

`ctx` injects the lookups, so T1's `mappings/*.yaml` plugs in without changes here:
- `metric(ddName)`: `{otel, kind}`.
- `tag(ddTag)`: a label name. The default turns dots into `_`.
- `variables`: template var name -> tag key, or `null` for free-form.
- `interval`: `"$__interval"` by default.

## Rules are data
`rules.ts` holds every rule: `ruleId -> {status, assumptions, description}`. `tests/translate/query.test.ts` asserts one exact PromQL string per rule, and fails if any rule in the table has no test.

Choices worth knowing:
- **Datadog order is kept:** time aggregation per series first, then space aggregation. That gives `avg by (h) (avg_over_time(x[$__interval]))`.
- **Regexes are anchored** (`^…$`), because Dash0 matches them unanchored.
- **Monitors use the subquery form** that the reference evaluator showed is exact (maths.md §5): `fn_over_time((Q on 1m buckets)[W:1m]) > $__threshold`.
- **`<` and `<=` monitors are negated** (maths.md T7). Thresholds are negated too, and `negated: true` is set.

## Fails closed
Anything without a rule makes the whole query `manual`, with no PromQL and an `unsupported` finding that names the construct. Examples: `top`, `anomalies`, `per_second`, `weighted`, `fill(zero)`, `pXX:`, OR across tag keys, bare tags, mismatched group-bys in arithmetic, `change()` monitors, and `.as_count()`/`.as_rate()` on a metric whose kind isn't in the mapping table.

An unmapped metric **without** those modifiers keeps its Datadog name and is assumed to be a gauge. That's `exact-under(A.kind-gauge)` plus a `warn` finding.

## Corpus (integrations-core, 7556 queries, no mapping table yet)
- 5556 `exact-under`, 2000 `manual`.
- 0 crashes, and 0 emitted queries fail lezer.
- Most of the `manual` cases are `.as_count()`/`.as_rate()` on metrics whose kind is still unknown. T1's kind table will move them.
