# Rule catalog

Generated from `src/rules/` by `npx tsx src/rules/write-doc.ts`. Do not edit by hand; `tests/rules` fails when this file is stale.
The formal definition (what a rule is, the axioms, how rules are admitted) is plan 05 in the dash0-team workspace.

## Summary

| | exact | exact-under | bounded | manual | total |
|---|---|---|---|---|---|
| implemented | 68 | 42 | 18 | 38 | 166 |
| planned | 18 | 22 | 2 | 14 | 56 |

## Pipeline order

| # | Stage | Unit of matching | Total | Rules | Summary |
|---|---|---|---|---|---|
| 1 | `ingest` Ingest and normalise | source item | no | 3 | Read the source JSON, unwrap containers, coerce types, keep the raw original. |
| 2 | `classify` Classify the item | monitor | yes | 3 | Decide which pipeline a monitor goes through; anything unknown stops here as manual. |
| 3 | `parse` Parse | query string | yes | 4 | Datadog query / formula / monitor strings → AST (T3). Unparseable text is manual with the original kept. |
| 4 | `select` Select the metric | metric reference | yes | 12 | Datadog metric → OTel metric through the mapping table. |
| 5 | `scope` Scope filters | filter term | no | 17 | Datadog tag filters → PromQL label matchers. The parser's grammar enumerates the forms. |
| 6 | `kind` Metric-kind check | metric reference | no | 3 | Plan 03 §3: the source kind decides which time aggregation is legal. |
| 7 | `time` Time aggregation | postfix or rollup call | no | 26 | Rollups, .as_count(), .as_rate(), fill(). Datadog aggregates time first. |
| 8 | `space` Space aggregation | aggregation | no | 2 | avg/sum/min/max/count by {tags}, applied after time aggregation. |
| 9 | `function` Functions | function call | yes | 32 | Pointwise and window functions. Every Datadog function is listed; unknown ones are manual. |
| 10 | `arith` Arithmetic and formulas | binary or unary operation | no | 9 | Formulas over named queries, constants, division. |
| 11 | `monitor` Monitor query | monitor query part (window, time aggregation, comparator) | yes | 12 | The monitor's window, time aggregation and comparator around the translated inner query. |
| 12 | `alert` Check-rule assembly | monitor field or option | yes | 19 | Thresholds, ids, labels and every monitor option. Each option is a rule; none is dropped. |
| 13 | `message` Message → annotations | template token | yes | 13 | Deterministic Mustache token rewrite into Go-template annotations. |
| 14 | `widget` Widget → panel | widget | yes | 16 | One mapper per Datadog widget type; anything else becomes a Markdown placeholder with the original. |
| 15 | `panel` Panel options | panel attribute | no | 4 | Units, markers and visual options on a panel a widget rule produced. |
| 16 | `layout` Layout and groups | widget position or group | no | 6 | 12-column Datadog grid → 24-column Perses grid; groups → titled sections. |
| 17 | `variable` Template variables | template variable | yes | 4 | Datadog template variables → Perses / Dash0 variables or pinned defaults. |
| 18 | `logs` Log queries | log query or search term | yes | 25 | Datadog log search and log widgets/monitors → dash0.logs counts (plan 01 §1). |
| 19 | `validate` Validate | emitted artefact | no | 3 | Every output parses and passes preflight before it may be emitted. |
| 20 | `canonical` Canonical form and hash | emitted artefact | no | 3 | One spelling per meaning, so the output hash is a function of the input only. |
| 21 | `emit` Import and report | emitted artefact or run | no | 6 | Idempotent single-item import, read-back, and a certificate for every source item. |

## Ingest and normalise (`ingest`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `ingest.monitor.unwrap` | integrations-core monitor file {version, definition: {...}} | the definition object | exact | — | — | T2 | planned |
| 20 | `ingest.numbers` | numbers stored as strings ("90", "0") | numbers | exact | — | — | T2 | planned |
| 30 | `ingest.keep-raw` | every source item | raw JSON kept next to its IR node (rule 4), sha256 → certificate.sourceHash | exact | — | — | T2 | planned |

## Classify the item (`classify`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `classify.monitor.metric` | monitor type "metric alert" or "query alert" | goes through the query stages and the monitor stage | exact | unit | — | T6 | implemented |
| 20 | `classify.monitor.log` | monitor type "log alert" | goes through the logs stage (log.monitor.count) | exact | — | — | T6 | planned |
| 999 (fallback) | `classify.monitor.other` | composite, service check, event, synthetics, SLO, process, log (until T12) and any other monitor | no rule; original kept | manual | unit | — | T6 | implemented |

- `classify.monitor.log`: Until T12 lands, log alerts take classify.monitor.other.

## Parse (`parse`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `parse.query` | Datadog metric query string | AST with spans | exact | unit, corpus:7371 | — | T3 | implemented |
| 20 | `parse.formula` | formula over named queries (query1 / query2 * 100) | AST with refs | exact | unit, corpus:7371 | — | T3 | implemented |
| 30 | `parse.monitor` | monitor query: fn(last_W):Q op t | {timeAgg, window, inner, op, threshold} | exact | unit, corpus:272 | — | T3 | implemented |
| 999 (fallback) | `parse.error` | text the grammar does not accept | no output; original kept | manual | unit | — | T3 | implemented |

## Select the metric (`select`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `select.metric.approximate` | mapping entry marked approximate | selector as mapped, status at best bounded | bounded(ε) | unit | — | T4 | implemented |
| 20 | `select.metric.mapped` | Datadog metric with a mapping entry | {otel_metric_name="<otel>"} | exact | unit | — | T4 | implemented |
| 30 | `select.labels` | mapping entry with extra labels (redis.cpu.sys) | adds matchers: {otel_metric_name="redis.cpu.time", state="sys"} | exact | unit | — | T4 | implemented |
| 40 | `select.labels.clash` | query filters on a label the mapping already fixes | no output | manual | unit | — | T4 | implemented |
| 50 | `query.value-filter` | distribution value filter (v: ...) | no output: PromQL has no per-value filter | manual | unit | — | T4 | implemented |
| 60 | `metric.no_equivalent` | mapping says the OTel receiver emits no equivalent | no output; placeholder panel | manual | unit | — | T4 | implemented |
| 62 | `metric.needs_transform` | mapping entry with scale or sumBy (CONTRACT-002) | no output until select.metric.transform ships | manual | unit | — | T4 | implemented |
| 64 | `metric.derived` | mapping entry that is an expression over several OTel metrics | no output until select.metric.derived ships | manual | unit | — | T4 | implemented |
| 66 | `select.metric.transform` | mapping entry with scale k and/or sumBy labels | k * x, sum without(<sumBy>) (x): both exact rewrites | exact | — | — | T4 | planned |
| 68 | `select.metric.derived` | mapping entry with a derived expression over several OTel metrics | the entry's PromQL expression, status from the entry's own claim | exact-under(A.align) | — | — | T4 | planned |
| 90 | `select.metric.kind-metadata` | Datadog metric with no mapping entry but a kind in its integration's metadata.csv | keep the Datadog name; kind from metadata.csv | exact-under(A.kind-metadata) | unit | — | T4 | implemented |
| 999 (fallback) | `select.metric.unmapped` | Datadog metric with no mapping entry | keep the Datadog name, assume gauge | exact-under(A.kind-gauge) | unit | — | T4 | implemented |

- `select.metric.approximate`: ε: per mapping entry: the difference stated in the entry's note (e.g. RSS vs used memory). Tried before select.metric.mapped: an entry marked approximate never counts as exact.
- `select.labels`: Applied together with select.metric.mapped or select.metric.approximate (it refines their selector, it does not replace it).
- `select.metric.transform`: Replaces metric.needs_transform. Each part is an exact identity; needs T4 support and a unit test per entry shape.
- `select.metric.derived`: Replaces metric.derived. The claim comes from the mapping row, which must carry its own status and test.
- `select.metric.unmapped`: Biggest lever for coverage: more generated mapping tables (T1 follow-up) turn these into select.metric.mapped.

## Scope filters (`scope`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `scope.all` | {*} | no matchers | exact | unit | — | T4 | implemented |
| 20 | `scope.tag.eq` | key:value | key="value" | exact | unit | — | T4 | implemented |
| 30 | `scope.tag.neq` | !key:value / -key:value | key!="value" | exact | unit | — | T4 | implemented |
| 40 | `scope.tag.wildcard` | key:a* | key=~"^a.*$" (anchored: Dash0 regex is unanchored, D-16) | exact | unit | — | T4 | implemented |
| 50 | `scope.in` | key IN (a,b) | key=~"^(a\|b)$" | exact | unit | — | T4 | implemented |
| 60 | `scope.or.same-key` | key:a OR key:b | key=~"^(a\|b)$" | exact | unit | — | T4 | implemented |
| 70 | `scope.not` | NOT key:a | key!="a" | exact | unit | — | T4 | implemented |
| 75 | `scope.not.set` | NOT (key:a OR key:b) / NOT key IN (a,b) / NOT key:a* | key!~"^(a\|b)$" | exact | unit | — | T4 | implemented |
| 80 | `scope.var` | $var bound to a tag key | label=~"^($var)$" (anchored: Dash0 regex is unanchored) | exact-under(A.var-regex) | unit | — | T4 | implemented |
| 82 | `scope.var.negated` | !$var / -$var | label!~"^($var)$" | exact-under(A.var-regex) | unit | — | T4 | implemented |
| 84 | `scope.same-key.var` | a literal filter and a template variable on the same key | both matchers | exact-under(A.same-key-and, A.var-regex) | unit | — | T4 | implemented |
| 85 | `label.default` | tag without a tag-table entry | label with dots replaced by underscores | exact-under(A.tag-default) | unit | — | T4 | implemented |
| 90 | `scope.var.free-form` | $var with no tag key ($scope) | dropped; filters nothing at its default | exact-under(A.var-default) | unit | — | T4 | implemented |
| 100 | `scope.same-key` | the same tag key twice in one scope | no output: Datadog's meaning is ambiguous | manual | unit | — | T4 | implemented |
| 110 | `scope.or.cross-key` | key1:a OR key2:b | no output: not a matcher set | manual | unit | — | T4 | implemented |
| 120 | `scope.not.complex` | NOT over a compound filter | no output | manual | unit | — | T4 | implemented |
| 130 | `scope.bare-tag` | bare tag without a key | no output: no label to map to | manual | unit | — | T4 | implemented |

- `scope.or.cross-key`: Candidate: union of two selectors with `or`, exact when the series sets are disjoint. Needs a claim and a property test first.

## Metric-kind check (`kind`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `time.kind` | kind combination with no tested rule (e.g. a counter without .as_count()/.as_rate()) | no output | manual | unit | — | T4 | implemented |
| 20 | `time.kind-unknown` | .as_count()/.as_rate() on a metric with no mapping entry | no output: the time aggregation depends on the kind | manual | unit | — | T4 | implemented |
| 30 | `kind.check` | every emitted function against the metric's kind and unit | type error → manual before emission (rate() on a gauge, bytes + seconds) | exact | — | — | T4 | planned |

- `time.kind-unknown`: 1,560 of the 2,000 manual corpus cases (hub #105). Fixed by mapping tables, not by rules.
- `kind.check`: Plan 03 §3 type checker: a guard, it never changes output, only blocks wrong-kind translations.

## Time aggregation (`time`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `time.ddrate.plain` | plain query on a Datadog RATE metric stored as an OTel counter | rate(x[w]) (D-18) | bounded(ε) | unit, proof:T3, property:T16 | — | T4 | implemented |
| 20 | `time.rollup.default` | implicit avg rollup | avg_over_time(x[interval]) | exact-under(A.align, A.boundary) | unit, proof:T8, exhaustive:E2 | — | T4 | implemented |
| 30 | `time.rollup.explicit` | .rollup(fn, s) | fn_over_time(x[s]) inside the space aggregation | exact-under(A.align, A.boundary) | unit, proof:T8, exhaustive:E2 | — | T4 | implemented |
| 40 | `time.rollup.monitor-bucket` | monitor inner query | fn_over_time(x[1m]) inside a 1m-step subquery, Unix-aligned by construction | exact-under(A.boundary) | unit, proof:T8, property:T16 | — | T4 | implemented |
| 50 | `time.as_count.gauge` | .as_count() on a gauge | no effect | exact | unit | — | T4 | implemented |
| 60 | `time.as_rate.gauge` | .as_rate() on a gauge | no effect | exact | unit | — | T4 | implemented |
| 70 | `time.as_count.delta` | .as_count() on a delta sum | sum_over_time(x[w]) | exact-under(A.align, A.boundary) | unit, proof:T8 | — | T4 | implemented |
| 75 | `time.as_count.counter.anchored` | .as_count() on a cumulative counter (or a Datadog RATE metric on an OTel counter) | increase(x[w] anchored) | exact-under(A.same-samples, A.align, A.boundary) | proof:T4, exhaustive:E1 | probe:anchored | T4 | planned |
| 80 | `time.as_count.counter` | .as_count() on a cumulative counter | increase(x[w]) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 90 | `time.as_rate.counter` | .as_rate() on a cumulative counter | rate(x[w]) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 92 | `time.unmapped.counter` | Datadog count/rate (metadata.csv) without a mapping entry, with .as_count() / .as_rate() or plain | increase(x[w]) / rate(x[w]) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 93 | `time.unmapped.suffix-counter` | no metadata.csv entry, name ends in .count/.total, with .as_count()/.as_rate() | treated as a Datadog count: increase / rate | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 94 | `time.count.default` | Datadog COUNT metric (metadata.csv) without a modifier | increase(x[w]), like .as_count() | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 95 | `time.as_rate.delta.sum` | .as_rate() on a delta sum | sum_over_time(x[w]) / w | exact-under(A.align, A.boundary) | — | — | T4 | planned |
| 100 | `time.fill.null` | .fill(null) | nothing: Datadog's default, PromQL does not fill | exact | unit | — | T4 | implemented |
| 102 | `time.fill.zero.single` | .fill(zero) on a single-series query | q or vector(0) | exact | unit | — | T4 | implemented |
| 104 | `time.weighted` | .weighted() | no-op | exact-under(A.static-tags) | unit | — | T4 | implemented |
| 110 | `time.as_rate.delta` | .as_rate() on a delta sum (until the planned rule ships) | no output | manual | unit | — | T4 | implemented |
| 120 | `time.as_count.histogram` | .as_count() on a histogram | no output | manual | unit | — | T4 | implemented |
| 130 | `time.as_rate.histogram` | .as_rate() on a histogram | no output | manual | unit | — | T4 | implemented |
| 140 | `time.rollup.fn` | .rollup() with an unsupported function | no output | manual | unit | — | T4 | implemented |
| 150 | `time.rollup.width` | .rollup() width that is not whole seconds | no output | manual | unit | — | T4 | implemented |
| 160 | `time.rollup.monitor-width` | monitor query with a rollup other than 60 s | no output | manual | unit | — | T4 | implemented |
| 170 | `time.rollup.args` | .rollup() with too many arguments | no output | manual | unit | — | T4 | implemented |
| 180 | `time.rollup.counter` | .as_count().rollup(sum, s) / .as_rate().rollup(avg, s) | increase(x[s]) / rate(x[s]) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 190 | `time.fill` | .fill() other than null (zero, last, linear) | no output: PromQL does not fill gaps | manual | unit | — | T4 | implemented |

- `time.ddrate.plain`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.as_count.counter.anchored`: Replaces time.as_count.counter (bounded) once Dash0 accepts `anchored`. Priority 75 so it wins when enabled.
- `time.as_count.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.as_rate.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.unmapped.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.unmapped.suffix-counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.count.default`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.as_rate.delta.sum`: Today T4 fails closed (time.as_rate.delta). Follows from T8 divided by a constant.
- `time.rollup.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `time.fill`: fill(zero): `or vector(0)` loses label sets; fill(last): last_over_time changes staleness. No claim yet.

## Space aggregation (`space`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `space.agg` | avg\|sum\|min\|max\|count by {tags} | PromQL aggregation by (labels) | exact | unit, proof:T5, exhaustive:E3 | — | T4 | implemented |
| 20 | `space.default-avg` | legacy query without an aggregator | avg | exact | unit | — | T4 | implemented |

## Functions (`function`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `map.abs` | abs(q) | abs(x) | exact | unit | — | T4 | implemented |
| 20 | `map.log2` | log2(q) | log2(x) | exact | unit | — | T4 | implemented |
| 30 | `map.log10` | log10(q) | log10(x) | exact | unit | — | T4 | implemented |
| 40 | `map.clamp_min` | clamp_min(q, n) | clamp_min(x, n) | exact | unit | — | T4 | implemented |
| 50 | `map.clamp_max` | clamp_max(q, n) | clamp_max(x, n) | exact | unit | — | T4 | implemented |
| 60 | `map.timeshift` | timeshift(q, -s) / hour_before / day_before / week_before | offset s on every selector | exact | unit | — | T4 | implemented |
| 70 | `fn.timeshift.future` | timeshift into the future or by a fraction of a second | no output | manual | unit | — | T4 | implemented |
| 80 | `fn.args` | function argument of the wrong type | no output | manual | unit | — | T4 | implemented |
| 90 | `query.postfix.non-metric` | postfix function on a non-metric expression | no output | manual | unit | — | T4 | implemented |
| 100 | `fn.per_unit.counter` | per_second/per_minute/per_hour(q) over a running total or a counter | k * agg(rate(x[w])) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 102 | `fn.per_unit.gauge` | per_second/per_minute/per_hour/derivative(q) over a plain gauge that only grows (a running total) | k * agg(rate(x[w])) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 105 | `fn.derivative.counter` | derivative(q) over a gauge holding an OTel counter's running total | agg(rate(x[w])) | bounded(ε) | unit, proof:T3 | — | T4 | implemented |
| 110 | `fn.diff` | diff(q) | q - (q offset interval) | exact-under(A.align, A.no-gaps) | unit | — | T4 | implemented |
| 115 | `fn.cutoff` | cutoff_min(q, n) / cutoff_max(q, n) | q >= n / q <= n | exact | unit | — | T4 | implemented |
| 120 | `fn.count_not_null` | count_not_null(q) | count(q) | exact | unit | — | T4 | implemented |
| 125 | `fn.count_nonzero` | count_nonzero(q) | count(q != 0) | exact | unit | — | T4 | implemented |
| 127 | `fn.default_zero.grouped` | default_zero(q) on a grouped dashboard query | q or 0 * q[$__range] @ end() | exact-under(A.at-range) | unit | probe:at-modifier, probe:range-var | T4 | implemented |
| 128 | `fn.default_zero.grouped.monitor` | default_zero(q) on a grouped monitor query | q or 0 * q over the evaluation window | exact-under(A.monitor-rollup-60s) | unit | — | T4 | implemented |
| 130 | `fn.default_zero.single` | default_zero(q) on a single-series query | q or vector(0) | exact | unit | — | T4 | implemented |
| 131 | `fn.exclude_null` | exclude_null(q) | label!="" on every selector for each group-by label (drops the N/A group) | exact | unit | — | T4 | implemented |
| 132 | `fn.monotonic_diff` | monotonic_diff(q) | (q - (q offset interval)) >= 0 | exact-under(A.align, A.no-gaps, A.mono-diff) | unit | — | T4 | implemented |
| 133 | `fn.round` | round(q) | round(x) | exact | unit | — | T4 | implemented |
| 134 | `fn.max_min.scalar` | max(q, n) / min(q, n) | clamp_min(x, n) / clamp_max(x, n) | exact | unit | — | T4 | implemented |
| 135 | `fn.max_min.series` | max(a, b) / min(a, b) of two queries with the same group-by | a >= b or b / a <= b or b (pointwise) | exact-under(A.both-present) | unit | — | T4 | implemented |
| 140 | `fn.top.window` | top(q, N, 'mean'\|'max'\|'min'\|'sum', 'desc'\|'asc') | x and on(<labels>) topk(N, <agg>_over_time(x[$__range] @ end())) (bottomk for asc) | exact-under(A.top-uniform) | — | probe:at-modifier, probe:range-var | T4 | planned |
| 145 | `fn.top` | top(q, N, method, order) / topN / bottomN | topk(N, q) / bottomk(N, q) | exact-under(A.top-stable) | unit | — | T4 | implemented |
| 150 | `fn.histogram.quantile` | pXX:metric on a distribution | histogram_quantile(0.XX, sum by (le, <g>) (rate(m_bucket[w]))) | bounded(ε) | — | — | T4 | planned |
| 160 | `fn.per_unit.kind` | per_second / per_minute / per_hour / derivative on a metric that is neither a counter nor a growing gauge | no output; deriv() is a least-squares slope, not Datadog's point difference | manual | unit | — | T4 | implemented |
| 180 | `fn.cumsum` | cumsum(q) / integral(q) | no output: accumulates over the visible window | manual | — | — | T4 | planned |
| 190 | `fn.anomalies` | anomalies() / forecast() / outliers() | no output: no PromQL counterpart (maths.md §9.5) | manual | — | — | T4 | planned |
| 200 | `fn.calendar-shift` | month_before() and other calendar shifts | no output: months are not fixed seconds | manual | — | — | T4 | planned |
| 999 (fallback) | `fn.unknown` | any other Datadog function (T4 emits fn.<name>) | no output; original kept | manual | unit | — | T4 | implemented |

- `fn.per_unit.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `fn.per_unit.gauge`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `fn.derivative.counter`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `fn.top.window`: Ranks once over the whole visible window, like Datadog, instead of per step like plain topk. 129 corpus cases (hub #105).
- `fn.top`: fn.top.window (planned, priority 140) drops A.top-stable by ranking once over the window.
- `fn.histogram.quantile`: ε: width of the histogram bucket containing the quantile, plus DDSketch's 1% relative error on the Datadog side. Depends on how the metric is ingested (explicit buckets vs exponential histogram).

## Arithmetic and formulas (`arith`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `arith.number` | arithmetic with a constant | same operator with the constant | exact | unit | — | T4 | implemented |
| 20 | `arith.same-groups` | arithmetic between queries with identical group-by labels | one-to-one vector matching | exact | unit | — | T4 | implemented |
| 30 | `arith.div` | division between queries | a / b | exact-under(A.nonzero-denominator) | unit, proof:T6 | — | T4 | implemented |
| 40 | `arith.neg` | unary minus | -x | exact | unit | — | T4 | implemented |
| 45 | `arith.div-zero` | division by the constant 0 | no output: Datadog drops the point, PromQL gives ±Inf/NaN | manual | unit | — | T4 | implemented |
| 50 | `arith.group-mismatch` | arithmetic between queries with different groupings | no output | manual | unit | — | T4 | implemented |
| 52 | `arith.scalar-log-mixed` | a scalar log count (over [$__range]) combined with a per-interval value (a metric, or a log time series) | no output: the two cover different windows | manual | unit | — | T4 | implemented |
| 55 | `arith.group-subset` | formula where one side's groups are a subset of the other's | a / on(<common>) group_left b | exact-under(A.nonzero-denominator) | — | probe:dd-formula-join | T4 | planned |
| 60 | `formula.ref.unknown` | formula references a query that does not exist | no output | manual | unit | — | T4 | implemented |

- `arith.group-mismatch`: Planned arith.group-subset (on(...) group_left) waits on probe:dd-formula-join.
- `arith.scalar-log-mixed`: Raised by T4 when a formula references a query carrying log.scalar.window next to anything evaluated per [$__interval].

## Monitor query (`monitor`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `monitor.window` | fn(last_W):Q with fn in avg\|sum\|min\|max | fn_over_time((Q on 1m buckets)[W:1m]), the subquery form (maths.md §5, D-28 corrected) | exact-under(A.monitor-rollup-60s, A.boundary) | unit, proof:T5, property:T16 | — | T4 | implemented |
| 20 | `monitor.cmp.gt` | > / >= | expr > $__threshold (>= for >=), critical → failed, warning → degraded | exact | unit | — | T4 | implemented |
| 30 | `monitor.cmp.lt` | < / <= | -(expr) > $__threshold with negated thresholds | exact | unit, proof:T7, exhaustive:E4 | probe:lt-threshold | T4 | implemented |
| 35 | `monitor.cmp.eq` | == T / != T | -abs(expr - T) >= $__threshold / abs(expr - T) > $__threshold, failed 0 | exact | unit | — | T4 | implemented |
| 40 | `monitor.sum.as_count` | sum(last_W):q.as_count() on a counter | agg(increase(x[W])) | bounded(ε) | unit, proof:T3, proof:T4 | — | T4 | implemented |
| 50 | `monitor.threshold.mismatch` | query threshold differs from options.thresholds.critical | the query's threshold is used; warn finding | exact-under(A.query-threshold) | unit | — | T4 | implemented |
| 55 | `monitor.as_count` | .as_count() inside a monitor query | no output (Datadog's monitor evaluation order for counts differs, kb 06 §7.1); alert.window.sum.count is the planned rule | manual | unit | — | T4 | implemented |
| 60 | `monitor.change` | change(fn(last_W), last_C) / pct_change(...) | X - X offset C; 100 * (X - X offset C) / X offset C | exact | unit | — | T4 | implemented |
| 70 | `monitor.window.kind` | window other than last_* (e.g. a cumulative window) | no output | manual | unit | — | T4 | implemented |
| 80 | `monitor.window.width` | window that is not whole minutes | no output | manual | unit | — | T4 | implemented |
| 90 | `monitor.time-agg` | monitor time aggregation other than avg/sum/min/max | no output | manual | unit | — | T4 | implemented |
| 999 (fallback) | `monitor.cmp` | any other comparator | no output | manual | unit | — | T4 | implemented |

- `monitor.sum.as_count`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).

## Check-rule assembly (`alert`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `alert.id` | monitor id | id = UUIDv5("datadog:monitor:<id>") in our fixed name space, so POST /api/import/check-rule upserts (live 2026-11-07, hub #289); origin "dd-monitor-<id>" for PUT by origin; label dd_monitor_id="<id>" | exact | unit | — | T6 | implemented |
| 20 | `alert.name` | monitor name | name as is (template tokens in names are not expanded) | exact | unit | — | T6 | implemented |
| 30 | `alert.threshold.both` | critical (from the query) and warning thresholds | thresholds {failed: critical, degraded: warning} | exact | unit | — | T6 | implemented |
| 40 | `alert.threshold.critical` | critical threshold only | thresholds {failed: critical} | exact | unit | — | T6 | implemented |
| 50 | `alert.threshold.recovery` | critical_recovery / warning_recovery | no output: value hysteresis has no Dash0 form (keep_firing_for is time-based) | manual | unit | — | T6 | implemented |
| 60 | `alert.group` | multi-alert by {tags} | grouping stays in the expression, one alert per series | exact | unit | — | T6 | implemented |
| 70 | `alert.defaults` | evaluation schedule | interval "1m", for "0s", keep_firing_for "0s" | exact-under(A.eval-1m) | unit | — | T6 | implemented |
| 100 | `alert.opt.evaluation_delay` | options.evaluation_delay = s (whole seconds) | the inner query is wrapped in timeshift(q, -s), so T4's map.timeshift puts offset s on every selector | exact | unit | — | T6 | implemented |
| 110 | `alert.opt.require_full_window.true` | require_full_window: true | expression unchanged | exact-under(A.full-window) | unit | — | T6 | implemented |
| 120 | `alert.opt.require_full_window.false` | require_full_window: false | expression unchanged (PromQL evaluates partial windows) | exact | unit | — | T6 | implemented |
| 130 | `alert.opt.new_group_delay` | new_group_delay / new_host_delay > 0 | expression unchanged | exact-under(A.no-new-groups) | unit | — | T6 | implemented |
| 135 | `alert.opt.no_data` | notify_no_data + no_data_timeframe T, ungrouped monitor | companion rule absent_over_time(<selector>[T]), id "dd-monitor-<id>-nodata", behind a CLI flag | exact-under(A.boundary) | — | — | T6 | planned |
| 140 | `alert.opt.no_data.report` | notify_no_data: true (with no_data_timeframe, timeout_h) or on_missing_data: show_no_data | main rule unchanged; the no-data alert is listed in the report | exact-under(A.no-data-manual) | unit | — | T6 | implemented |
| 150 | `alert.opt.on_missing_data.resolve` | on_missing_data: resolve | expression unchanged: with no samples a PromQL comparison returns nothing, so the alert resolves | exact | unit | — | T6 | implemented |
| 200 | `alert.opt.notification` | renotify_*, escalation_message, notify_audit, include_tags, notification_preset_name, notify_by, locked, restricted_roles, silenced | not emitted; listed in the report as manual setup | exact-under(A.notify-manual) | unit | — | T6 | implemented |
| 210 | `alert.priority` | priority n (1-5) | label priority="P<n>" | exact | unit | — | T6 | implemented |
| 220 | `alert.tags` | tags k:v with valid label keys | labels {k: v}; a tag without ':' becomes {tag: "true"} | exact | unit | — | T6 | implemented |
| 230 | `alert.tags.rename` | tags whose keys are not valid label names, clash with our labels, or repeat with several values | key sanitised to [a-zA-Z_][a-zA-Z0-9_]* (dd_tag_ prefix on a clash), repeated values joined with ',' | exact-under(A.label-rename) | unit | — | T6 | implemented |
| 999 (fallback) | `alert.opt.unknown` | any other option with a non-default value | no output; option kept in the report | manual | unit | — | T6 | implemented |

- `alert.threshold.recovery`: Policy (kb 06 §8): never import a weaker active alert silently. keepManual emits it disabled for review.
- `alert.group`: Carried by T4's space.agg: the by-labels survive into the alert expression.
- `alert.opt.evaluation_delay`: Plan 04 had it as a warn-only finding; kb 06 §8 proposes the offset.
- `alert.opt.no_data`: Replaces alert.opt.no_data.report for ungrouped monitors once built (needs the inner selector from T4).

## Message → annotations (`message`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `alert.msg.summary` | monitor name and message | annotations {summary: name, description: rewritten message} | exact | unit | — | T6 | implemented |
| 20 | `alert.msg.value` | {{value}} | {{ $value }} (negated rules carry a note: the value shown is negated) | exact | unit | — | T6 | implemented |
| 25 | `alert.msg.threshold` | {{threshold}} / {{warn_threshold}} | the threshold number itself | exact | unit | — | T6 | implemented |
| 30 | `alert.msg.label` | {{<tag>.name}} | {{ $labels.<label> }} through the tag mapping, then sanitised | exact | unit | — | T6 | implemented |
| 40 | `alert.msg.conditional.label` | {{#is_alert}} / {{#is_warning}} / {{#is_recovery}} blocks | {{ if eq $labels.<threshold> "failed" }} … {{ end }} | exact | — | probe:threshold-label | T6 | planned |
| 50 | `alert.msg.conditional` | {{#is_alert}} / {{#is_warning}} blocks (until probe:threshold-label is yes) | markers removed, the block's text kept unconditionally | exact-under(A.msg-conditional) | unit | — | T6 | implemented |
| 55 | `alert.msg.conditional.drop` | {{#is_recovery}}, {{#is_no_data}}, {{#is_renotify}}, {{^is_alert}} … blocks | block removed (never part of a firing notification) | exact-under(A.msg-recovery) | unit | — | T6 | implemented |
| 60 | `alert.msg.handle` | @slack-… / @pagerduty-… / @user@… handles with no entry in the channel file | removed from the text, listed in the report as channels to create | exact-under(A.notify-manual) | unit | — | T6 | implemented |
| 61 | `alert.notify.channel` | @handle in the main message, mapped in the channel file | annotation dash0.com/notification-channel-ids: "<channel id>" | exact | unit | — | T6 | implemented |
| 62 | `alert.notify.channel.critical-only` | @handle only inside {{#is_alert}}, mapped in the channel file | "<channel id>:critical-only" (Dash0 sends this channel only critical = failed notifications) | exact | unit | — | T6 | implemented |
| 63 | `alert.notify.channel.wider` | @handle only inside {{#is_warning}} or a recovery section, mapped in the channel file | "<channel id>": the channel gets every notification of the rule | exact-under(A.notify-wider) | unit | — | T6 | implemented |
| 70 | `alert.msg.truncate` | description over 2048 or summary over 255 characters | cut at the limit on a {{ … }} boundary, ending in … | exact-under(A.msg-length) | unit | — | T6 | implemented |
| 999 (fallback) | `alert.msg.unknown-token` | any other {{…}} token, and stray {{ / }} in text | escaped as a Go string literal {{ "{{token}}" }} so the template still parses | exact-under(A.msg-verbatim) | unit | — | T6 | implemented |

## Widget → panel (`widget`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `widget.timeseries` | timeseries | TimeSeriesChart, one query per Datadog query/formula | exact | — | — | T5 | planned |
| 20 | `widget.query_value` | query_value with aggregator avg\|max\|min\|sum\|last | StatChart with the matching calculation | exact-under(A.align, A.boundary) | — | probe:statchart-calculation | T5 | planned |
| 30 | `widget.toplist` | toplist | TimeSeriesTable sorted by value, limited to N (uses fn.top.window for the ranking) | exact-under(A.top-uniform) | — | probe:at-modifier | T5 | planned |
| 40 | `widget.query_table` | query_table | TimeSeriesTable | exact-under(A.table-single-query) | — | — | T5 | planned |
| 45 | `widget.query_table.complex` | query_table with several queries, custom sort or conditional formats | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |
| 50 | `widget.note` | note / free_text | Markdown with the same text | exact-under(A.style) | — | — | T5 | planned |
| 60 | `widget.image` | image | Markdown ![](url) | exact-under(A.style) | — | — | T5 | planned |
| 70 | `widget.alert_graph` | alert_graph (graph of a monitor) | TimeSeriesChart of the monitor's translated query with its thresholds | exact-under(A.style) | — | — | T5 | planned |
| 80 | `widget.alert_value` | alert_value | StatChart of the monitor's translated query | exact-under(A.style) | — | probe:statchart-calculation | T5 | planned |
| 90 | `widget.pie` | sunburst / pie | PieChart over the grouped query | exact-under(A.style) | — | probe:piechart | T5 | planned |
| 140 | `widget.logs` | log_stream / list_stream | Markdown panel with the original query and the reason (LogTable comes with logs.stream) | manual | — | — | T5 | planned |
| 150 | `widget.heatmap` | heatmap / distribution / histogram | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |
| 160 | `widget.treemap` | treemap | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |
| 170 | `widget.scatterplot` | scatterplot | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |
| 180 | `widget.unsupported` | hostmap, service_map, manage_status, check_status, slo, trace_service, geomap, funnel, iframe, event_stream, event_timeline, split_graph | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |
| 999 (fallback) | `widget.unknown` | any other widget type | Markdown panel with the original query and the reason | manual | — | — | T5 | planned |

- `widget.alert_graph`: Reuses the monitor's query translation; status = worst(this, that query).

## Panel options (`panel`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 100 | `panel.unit` | Datadog unit with a Perses format entry (bytes, percent, seconds, …) | format.unit | exact | — | — | T5 | planned |
| 110 | `panel.unit.unmapped` | unit without a format entry | format.unit decimal; original unit in the panel description | exact-under(A.style) | — | — | T5 | planned |
| 120 | `panel.markers` | markers / y-axis lines | TimeSeriesChart thresholds | exact-under(A.style) | — | — | T5 | planned |
| 130 | `panel.style` | palette, legend, display type, title alignment | closest Perses visual option | exact-under(A.style) | — | — | T5 | planned |

## Layout and groups (`layout`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `layout.ordered.grid` | ordered layout x, width (12 columns) | Perses Grid x = 2x, width = 2·width (24 columns, D-24) | exact | — | — | T5 | planned |
| 20 | `layout.ordered.height` | ordered layout y, height | y and height unchanged | exact-under(A.row-height) | — | probe:row-height | T5 | planned |
| 30 | `layout.free` | free layout | deterministic repack into the 24-column grid (row-major by y, then x) | exact-under(A.style) | — | — | T5 | planned |
| 40 | `layout.group` | group widget | its own Grid layout with display.title; children recurse | exact | — | — | T5 | planned |
| 50 | `layout.group.collapsed` | group collapsed / expanded | display.collapse.open | exact | — | probe:collapse | T5 | planned |
| 60 | `layout.powerpack` | powerpack | inlined like a group, title kept | exact-under(A.style) | — | — | T5 | planned |

## Template variables (`variable`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `variable.list` | template variable with a tag prefix | ListVariable + PrometheusLabelValuesVariable on the mapped label | exact-under(A.var-values) | — | probe:listvariable | T5 | planned |
| 20 | `variable.default.value` | variable pinned to a default other than * | label="<default>" in every query that uses it | exact | — | — | T5 | planned |
| 30 | `variable.pinned` | variable with default * (v1, until variable.list ships) | no variable, no matcher | exact-under(A.var-default) | — | — | T5 | planned |
| 999 (fallback) | `variable.unknown` | any other variable shape (available_values, multi-tag) | pinned; original kept in the report | manual | — | — | T5 | planned |

## Log queries (`logs`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `log.count` | log query, compute count, search Q, group_by g | sum by (g) (increase({otel_metric_name="dash0.logs", m(Q)}[w])) | bounded(ε) | unit, proof:T3, live:dash0-4110 | probe:log-labels | T12 | implemented |
| 20 | `log.cardinality` | cardinality of @a | count by (g) (sum by (g, a) (increase(...[w])) > 0) | bounded(ε) | unit, proof:T3, live:dash0-4110 | probe:log-labels | T12 | implemented |
| 30 | `log.match.reserved` | service / host / env / version:x | the resource label (service_name, ...) | exact | unit | probe:log-labels | T12 | implemented |
| 40 | `log.match.reserved.approx` | source:x | source="x" (no OTel counterpart) | exact-under(A.log-source) | unit | — | T12 | implemented |
| 50 | `log.match.attr` | @a.b:x | a_b="x" (renames from mappings/log-attributes.yaml applied) | exact-under(A.log-attr-default) | unit | probe:log-labels | T12 | implemented |
| 60 | `log.match.value` | k:v, k:v*, k:(a OR b), k:*, and their negations | =, =~"^v.*$", =~"^(a\|b)$", =~".+", != / !~ | exact | unit | — | T12 | implemented |
| 70 | `log.match.status` | status:error | otel_log_severity_range="ERROR" | exact | unit | probe:log-labels | T12 | implemented |
| 80 | `log.match.status.approx` | status:critical / notice / ok / ... | the nearest OTel severity range | exact-under(A.severity-map) | unit | probe:log-labels | T12 | implemented |
| 90 | `log.match.text` | free text w | otel_log_body=~"(?i).*w.*" | exact-under(A.log-fulltext) | unit | probe:log-labels | T12 | implemented |
| 100 | `log.match.var` | $var on a facet | label=~"^($var)$" | exact-under(A.var-regex) | unit | — | T12 | implemented |
| 110 | `log.match.var.dropped` | $var without a facet | dropped while it is '*' | exact-under(A.var-default) | unit | — | T12 | implemented |
| 120 | `log.group_by` | group_by facets | by (labels) | exact | unit | — | T12 | implemented |
| 130 | `log.group_by.limit` | one facet with a limit N | topk(N, ...) (bottomk for asc) | exact-under(A.top-stable) | unit | — | T12 | implemented |
| 140 | `log.group_by.multi-limit` | several facets with limits | by (labels), limits not applied | exact-under(A.group-limit) | unit | — | T12 | implemented |
| 150 | `log.group_by.exclude-missing` | should_exclude_missing: true | label!="" for each group-by label | exact | unit | — | T12 | implemented |
| 155 | `log.range.integer` | @a:>=500 / @a:[200 TO 299] on integer attributes | a=~ an exact regex over the decimal digits | exact | unit | — | T12 | implemented |
| 157 | `log.or.inclusion-exclusion` | count(A OR B ...) across different keys (up to 3 branches) | sum of counts by inclusion-exclusion | bounded(ε) | unit, proof:log-or, exhaustive:E5 | — | T12 | implemented |
| 160 | `log.indexes` | indexes other than '*' | all logs (Dash0 has no indexes) | exact-under(A.all-indexes) | unit | — | T12 | implemented |
| 170 | `log.monitor.count` | logs(Q).rollup(count).by(g).last(W) op T | sum by (g) (increase(...[W])) op $__threshold | bounded(ε) | unit, proof:T3 | probe:log-labels | T12 | implemented |
| 175 | `log.monitor.formula` | formula("...").last(W) over log queries | the formula over windowed counts | bounded(ε) | unit, proof:T3 | — | T12 | implemented |
| 180 | `log.scalar.window` | scalar log query: query_value, top list, table (Datadog aggregates over the whole timeframe) | the same count over [$__range] (not one [$__interval] bucket); the panel shows the last value | bounded(ε) | unit | probe:range-var | T12 | implemented |
| 200 | `logs.rate` | log count shown as a rate | sum by (<labels>) (rate({otel_metric_name="dash0.logs", …}[1m])) | bounded(ε) | proof:T3 | probe:log-labels | T12 | planned |
| 220 | `logs.measure` | avg / sum / percentile over @attr | no output: dash0.logs only counts | manual | — | — | T12 | planned |
| 230 | `logs.stream` | log_stream / list_stream widget | placeholder until the LogTable schema comes from T0 | manual | — | — | T12 | planned |
| 999 (fallback) | `logs.unparsed` | log search the log-search parser does not accept | no output; original kept | manual | — | — | T12 | planned |

- `log.count`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b). exact-under(A.same-samples) once probe:anchored is yes (maths.md §8).
- `log.cardinality`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `log.or.inclusion-exclusion`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `log.monitor.count`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `log.monitor.formula`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).
- `log.scalar.window`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b). T5 must set the stat/top-list calculation to last-number for these queries. A formula that mixes a scalar log count with a per-interval value fails closed (finding log.scalar.mixed, rule arith.scalar-log-mixed). EPS_RATE gets relatively tighter over a long range: the uncovered edge stays under one scrape interval while the window total grows with the range.
- `logs.rate`: ε: |r̂ − r| ≤ g·Δr per window: g = uncovered edge time (< one scrape interval), Δr = rate change inside the window (maths.md T3b).

## Validate (`validate`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `validate.promql` | every emitted PromQL string | must parse with @prometheus-io/lezer-promql | exact | unit | — | T4 | implemented |
| 20 | `promql.invalid` | emitted PromQL that does not parse | nothing emitted; error finding (never a broken query) | manual | unit | — | T4 | implemented |
| 30 | `validate.preflight` | every DashboardDefinition / PrometheusAlertRule | preflightDashboard / preflightCheckRule against Dash0's OpenAPI types | exact | unit | — | T7 | implemented |

## Canonical form and hash (`canonical`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `canonical.matchers` | label matchers | sorted by label name, then operator | exact | — | — | T13 | planned |
| 20 | `canonical.json` | output JSON | keys sorted, numbers in shortest round-trip form | exact | — | — | T13 | planned |
| 30 | `canonical.hash` | canonical output | sha256 → certificate.outputHash; same input gives the same bytes (determinism test M2) | exact | — | — | T13 | planned |

## Import and report (`emit`)

| Pri | Rule | Datadog | Output | Claim | Evidence | Needs | Owner | State |
|---|---|---|---|---|---|---|---|---|
| 10 | `emit.id` | every dashboard and check rule | id "dd-<source id>", so re-runs overwrite (idempotent) | exact | unit | — | T7 | implemented |
| 20 | `emit.single-item` | import | one POST per item (/api/import/dashboard, /api/import/check-rule), never the all-or-nothing bulk call | exact | unit | — | T7 | implemented |
| 30 | `emit.rules-disabled` | imported check rules | enabled: false unless --enable-rules (D-30) | exact | unit | — | T7 | implemented |
| 40 | `emit.readback` | after import | GET by id and compare the normalised payload; mismatch is an error finding | exact | unit | — | T7 | implemented |
| 50 | `emit.certificate` | every source item | one report.json entry with its certificate: hashes, rules, status, assumptions, ε, checks | exact | — | — | T8 | planned |
| 60 | `emit.no-silent-drop` | the whole run | count(source items) = count(report items); otherwise the run fails | exact | — | — | T8 | planned |

## Assumptions

| Id | Statement | Used by |
|---|---|---|
| `A.align` | PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2) | 9 |
| `A.boundary` | no sample lies exactly on a bucket boundary (maths.md T8, A3) | 9 |
| `A.kind-gauge` | the metric is a gauge; there is no mapping-table entry to confirm its kind | 1 |
| `A.monitor-rollup-60s` | Datadog evaluates the monitor's inner query on 60 s buckets | 2 |
| `A.nonzero-denominator` | the denominator is never 0 (Datadog drops the point, PromQL yields ±Inf/NaN) | 2 |
| `A.var-default` | a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing | 3 |
| `A.var-regex` | the dashboard substitutes the variable as a regex of escaped literal values (a single value, or (a\|b) for several) | 4 |
| `A.tag-default` | the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry) | 1 |
| `A.query-threshold` | Datadog evaluates the threshold written in the monitor query, which differs from options.thresholds.critical | 1 |
| `A.dd-per-unit` | Datadog's per_second/per_minute/per_hour on a gauge that holds a running total is its change per second/minute/hour between consecutive points, and the counter does not reset (Datadog docs; not yet checked against Datadog) | 3 |
| `A.no-gaps` | every rollup bucket has a sample, so Datadog's previous point is exactly one interval earlier | 2 |
| `A.kind-metadata` | the metric's kind is the one declared in its integration's metadata.csv (no curated mapping entry) | 3 |
| `A.otel-counter` | the OTel metric with this name is a cumulative counter (Datadog count/rate without a curated mapping entry) | 3 |
| `A.top-stable` | the ranking of the series is the same at every step, so Datadog's whole-window ranking picks the same series as PromQL's per-step topk | 2 |
| `A.static-tags` | each series keeps its tags for the whole window, so .weighted() has nothing to re-weight | 1 |
| `A.dd-count-default` | Datadog shows a COUNT metric queried without a modifier as counts per interval, i.e. like .as_count() (Datadog docs; not yet checked against Datadog) | 1 |
| `A.kind-suffix` | a metric with no metadata.csv entry whose name ends in .count or .total, queried with .as_count()/.as_rate(), is a monotonic count (Datadog OpenMetrics naming) | 1 |
| `A.mono-diff` | Datadog's monotonic_diff drops negative steps (counter resets) rather than reporting them as 0 | 1 |
| `A.same-key-and` | Datadog applies a literal tag filter and a template variable on the same key together (AND) | 1 |
| `A.at-range` | the dashboard substitutes $__range with its visible time range, so the zero-filled series are those present in the window (Dash0 accepts @ end(), verified live) | 1 |
| `A.monotonic` | the gauge only increases between resets (a running total), so its change per second is rate() | 1 |
| `A.both-present` | both arguments have a value at the step (Datadog's max/min of a missing point is the other argument) | 1 |
| `A.log-count` | Dash0's dash0.logs counter counts the same log records Datadog indexed (no sampling or exclusion filters on either side) | 6 |
| `A.log-source` | logs carry Datadog's `source` as a `source` attribute (set by the shipper); OTel has no built-in equivalent | 1 |
| `A.log-attr-default` | a log attribute without a table entry keeps its name in OTel (dots become underscores in the label) | 1 |
| `A.log-fulltext` | Datadog's free-text match of a word equals a case-insensitive substring match on the log body | 1 |
| `A.group-limit` | the number of groups stays within the widget's group limit, so Datadog shows every group too | 1 |
| `A.severity-map` | the Datadog status maps to the OTel severity range listed in mappings/log-attributes.yaml (no 1:1 level) | 1 |
| `A.all-indexes` | every Datadog log index is queried (Dash0 has no indexes) | 1 |
| `A.log-range` | the panel's $__range is the dashboard's visible time range and the panel shows the value at the end of that range (calculation last-number), so a scalar covers the same timeframe Datadog aggregates over | 1 |
| `A.same-samples` | Datadog and Dash0 see the same samples of the counter (maths.md T4 model: a RATE point is (vᵢ − vᵢ₋₁)/s) | 1 |
| `A.full-window` | every evaluated series has samples across the whole monitor window (Datadog require_full_window) | 1 |
| `A.no-new-groups` | no new group (host, tag value) appears during the monitor's new_group_delay / new_host_delay | 1 |
| `A.eval-1m` | Datadog evaluates the monitor once per minute (true for metric monitors with windows up to 24 h) | 1 |
| `A.notify-manual` | notification routing (channels, renotify, escalation) is recreated by hand in Dash0; it does not change when the rule fires | 2 |
| `A.label-rename` | nothing downstream matches on the original Datadog tag key spelling, only on the sanitised label | 1 |
| `A.msg-conditional` | the reader of a notification can tell failed from degraded by the rule's threshold, so text from {{#is_alert}} / {{#is_warning}} blocks may appear unconditionally | 1 |
| `A.msg-recovery` | text Datadog only sends on recovery, no-data or renotify notifications is not needed in a firing notification | 1 |
| `A.no-data-manual` | the monitor's no-data alert is recreated by hand in Dash0 (the companion absent_over_time rule is not generated yet) | 1 |
| `A.notify-wider` | the channel may also receive notifications Datadog did not send to it (Dash0 has no degraded-only or recovery-only channel binding) | 1 |
| `A.msg-length` | text beyond Dash0's annotation limits (description 2048, summary 255 characters) is not needed in the notification; the full original stays in the report | 1 |
| `A.msg-verbatim` | showing an unknown Datadog template token as literal text is acceptable in the notification | 1 |
| `A.style` | fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning | 10 |
| `A.row-height` | one Dash0 grid row has the same height as one Datadog grid row (to confirm from the T0 golden export) | 1 |
| `A.var-values` | a label's values in Dash0 are the same set as the matching tag's values in Datadog | 1 |
| `A.table-single-query` | the table has one query, default sorting and no conditional formats | 1 |
| `A.top-uniform` | every ranked series has samples on the same uniform grid over the dashboard range, and no two window means tie | 2 |

## Open probes

| Probe | Question | How | Rules waiting |
|---|---|---|---|
| `probe:anchored` (open) | Does Dash0 accept increase(x[1m] anchored)? | maths.md §11 probe 1: run it in the Dash0 query API | `time.as_count.counter.anchored` |
| `probe:at-modifier` (yes) | Does Dash0 accept the @ end() modifier in queries? | LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): @ end() accepted by the query API; 935/935 queries with the new constructs accepted (hub #278). That test did NOT show that a dashboard substitutes $__range: see probe:range-var. | `fn.default_zero.grouped`, `fn.top.window`, `widget.toplist` |
| `probe:range-var` (yes) | Does a Dash0 dashboard substitute $__range with its visible time range in panel queries (and a stat panel with calculation last-number show the value at the end of that range)? | LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben), visual check on a throwaway dashboard (the query API does not substitute variables, so only a rendered panel can answer): a StatChart (calculation last-number) over sum(increase({otel_metric_name="dash0.logs", service_name="frontend"}[$__range])) equalled the same query over a fixed [5m] with the picker at 5m (about 3k) and over a fixed [1h] with the picker at 1h (about 32k). 15m was not read. Import also accepted calculation last-number, and it rendered the last value. | `fn.default_zero.grouped`, `fn.top.window`, `log.scalar.window` |
| `probe:lt-threshold` (open) | How does Dash0 compare $__threshold for `<` expressions (is higher always worse)? | maths.md §11 probe 5, T0 check-rule export | `monitor.cmp.lt` |
| `probe:threshold-label` (open) | Does Dash0 expose which threshold fired (failed / degraded) as a label usable in annotation templates? | T0: fire a test rule and read its notification payload | `alert.msg.conditional.label` |
| `probe:statchart-calculation` (open) | Which StatChart `calculation` names does Dash0 accept (mean, max, min, sum, last)? | T0: export a StatChart with each calculation | `widget.query_value`, `widget.alert_value` |
| `probe:listvariable` (open) | Does Dash0 import accept Perses ListVariable + PrometheusLabelValuesVariable, or only Dash0FilterVariable? | plan 00 open question; T7 dry-run import of a dashboard with one ListVariable | `variable.list` |
| `probe:row-height` (open) | Is one Dash0 grid row as tall as one Datadog grid row? | T0: compare a golden export with the Datadog source | `layout.ordered.height` |
| `probe:collapse` (open) | Does Dash0 honour Grid display.collapse.open for titled sections? | T0: export a dashboard with one collapsed group | `layout.group.collapsed` |
| `probe:piechart` (open) | Does Dash0 render a Perses PieChart from a PromQL query with a grouping? | T0 or T7 dry-run | `widget.pie` |
| `probe:log-labels` (yes) | What are the label names for severity and body on {otel_metric_name="dash0.logs"}? | LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): severity otel_log_severity_range / otel_log_severity_text, body otel_log_body (unanchored regex), attributes with dots as underscores; docs/research/dash0.md "dash0.logs labels", dash0-team 71e47aa | `log.count`, `log.cardinality`, `log.match.reserved`, `log.match.attr`, `log.match.status`, `log.match.status.approx`, `log.match.text`, `log.monitor.count`, `logs.rate` |
| `probe:dd-formula-join` (open) | In a Datadog formula over queries with different groupings, do unmatched groups drop? | maths.md §11 probe 3 | `arith.group-subset` |

## Claims not yet backed by a proof, exhaustive check, property test or live run

Exact-under and bounded claims whose only evidence is a unit test or nothing. These are the next rules to take through the reference evaluator (T16).

- `select.metric.approximate` (bounded(ε), implemented, T4)
- `select.metric.derived` (exact-under(A.align), planned, T4)
- `select.metric.kind-metadata` (exact-under(A.kind-metadata), implemented, T4)
- `select.metric.unmapped` (exact-under(A.kind-gauge), implemented, T4)
- `scope.var` (exact-under(A.var-regex), implemented, T4)
- `scope.var.negated` (exact-under(A.var-regex), implemented, T4)
- `scope.same-key.var` (exact-under(A.same-key-and, A.var-regex), implemented, T4)
- `label.default` (exact-under(A.tag-default), implemented, T4)
- `scope.var.free-form` (exact-under(A.var-default), implemented, T4)
- `time.as_rate.delta.sum` (exact-under(A.align, A.boundary), planned, T4)
- `time.weighted` (exact-under(A.static-tags), implemented, T4)
- `fn.diff` (exact-under(A.align, A.no-gaps), implemented, T4)
- `fn.default_zero.grouped` (exact-under(A.at-range), implemented, T4)
- `fn.default_zero.grouped.monitor` (exact-under(A.monitor-rollup-60s), implemented, T4)
- `fn.monotonic_diff` (exact-under(A.align, A.no-gaps, A.mono-diff), implemented, T4)
- `fn.max_min.series` (exact-under(A.both-present), implemented, T4)
- `fn.top.window` (exact-under(A.top-uniform), planned, T4)
- `fn.top` (exact-under(A.top-stable), implemented, T4)
- `fn.histogram.quantile` (bounded(ε), planned, T4)
- `arith.group-subset` (exact-under(A.nonzero-denominator), planned, T4)
- `monitor.threshold.mismatch` (exact-under(A.query-threshold), implemented, T4)
- `alert.defaults` (exact-under(A.eval-1m), implemented, T6)
- `alert.opt.require_full_window.true` (exact-under(A.full-window), implemented, T6)
- `alert.opt.new_group_delay` (exact-under(A.no-new-groups), implemented, T6)
- `alert.opt.no_data` (exact-under(A.boundary), planned, T6)
- `alert.opt.no_data.report` (exact-under(A.no-data-manual), implemented, T6)
- `alert.opt.notification` (exact-under(A.notify-manual), implemented, T6)
- `alert.tags.rename` (exact-under(A.label-rename), implemented, T6)
- `alert.msg.conditional` (exact-under(A.msg-conditional), implemented, T6)
- `alert.msg.conditional.drop` (exact-under(A.msg-recovery), implemented, T6)
- `alert.msg.handle` (exact-under(A.notify-manual), implemented, T6)
- `alert.notify.channel.wider` (exact-under(A.notify-wider), implemented, T6)
- `alert.msg.truncate` (exact-under(A.msg-length), implemented, T6)
- `alert.msg.unknown-token` (exact-under(A.msg-verbatim), implemented, T6)
- `widget.query_value` (exact-under(A.align, A.boundary), planned, T5)
- `widget.toplist` (exact-under(A.top-uniform), planned, T5)
- `widget.query_table` (exact-under(A.table-single-query), planned, T5)
- `widget.note` (exact-under(A.style), planned, T5)
- `widget.image` (exact-under(A.style), planned, T5)
- `widget.alert_graph` (exact-under(A.style), planned, T5)
- `widget.alert_value` (exact-under(A.style), planned, T5)
- `widget.pie` (exact-under(A.style), planned, T5)
- `panel.unit.unmapped` (exact-under(A.style), planned, T5)
- `panel.markers` (exact-under(A.style), planned, T5)
- `panel.style` (exact-under(A.style), planned, T5)
- `layout.ordered.height` (exact-under(A.row-height), planned, T5)
- `layout.free` (exact-under(A.style), planned, T5)
- `layout.powerpack` (exact-under(A.style), planned, T5)
- `variable.list` (exact-under(A.var-values), planned, T5)
- `variable.pinned` (exact-under(A.var-default), planned, T5)
- `log.match.reserved.approx` (exact-under(A.log-source), implemented, T12)
- `log.match.attr` (exact-under(A.log-attr-default), implemented, T12)
- `log.match.status.approx` (exact-under(A.severity-map), implemented, T12)
- `log.match.text` (exact-under(A.log-fulltext), implemented, T12)
- `log.match.var` (exact-under(A.var-regex), implemented, T12)
- `log.match.var.dropped` (exact-under(A.var-default), implemented, T12)
- `log.group_by.limit` (exact-under(A.top-stable), implemented, T12)
- `log.group_by.multi-limit` (exact-under(A.group-limit), implemented, T12)
- `log.indexes` (exact-under(A.all-indexes), implemented, T12)
- `log.scalar.window` (bounded(ε), implemented, T12)

## Implemented ahead of an open probe

- `monitor.cmp.lt` needs probe:lt-threshold
