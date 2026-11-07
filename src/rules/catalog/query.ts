// Query rules: parse → select → scope → kind → time → space → function → arith → monitor.
// Rows owned by T4 and marked implemented mirror src/translate/query/rules.ts (PR #3) id for id;
// T4's fail-closed guards (its `manual(...)` codes) are listed too, so every outcome has a catalog entry.
import type { RuleDef } from "../types.js";
import { EPS_RATE, section } from "./build.js";

const P = "docs/research/promql-translation.md; plan 03; T4 rules.ts";
const parse = section("parse", "T3", "implemented", "T3 src/parse (PR #1, merged)");
const select = section("select", "T4", "implemented", P);
const selectPlan = section("select", "T4", "planned", P);
const scope = section("scope", "T4", "implemented", P);
const kind = section("kind", "T4", "implemented", "plan 03 §3; T4 lower.ts");
const kindPlan = section("kind", "T4", "planned", "plan 03 §3");
const time = section("time", "T4", "implemented", P);
const timePlan = section("time", "T4", "planned", P);
const space = section("space", "T4", "implemented", P);
const fn = section("function", "T4", "implemented", P);
const fnPlan = section("function", "T4", "planned", "docs/research/kb/06_TRANSLATION_RULES.md §6; promql-translation.md");
const arith = section("arith", "T4", "implemented", P);
const arithPlan = section("arith", "T4", "planned", P);
const mon = section("monitor", "T4", "implemented", "maths.md §5-6; T4 translateMonitor");
const monPlan = section("monitor", "T6", "planned", "plan 04 §2.2");

export const QUERY_RULES: RuleDef[] = [
  // ---------- parse ----------
  parse("parse.query", 10, "exact", "Datadog metric query string", "AST with spans", { evidence: ["unit", "corpus:7371"] }),
  parse("parse.formula", 20, "exact", "formula over named queries (query1 / query2 * 100)", "AST with refs", { evidence: ["unit", "corpus:7371"] }),
  parse("parse.monitor", 30, "exact", "monitor query: fn(last_W):Q op t", "{timeAgg, window, inner, op, threshold}", { evidence: ["unit", "corpus:272"] }),
  parse("parse.error", 999, "manual", "text the grammar does not accept", "no output; original kept", { fallback: true, findingCode: "query.parse_error" }),

  // ---------- select ----------
  select("select.metric.mapped", 20, "exact", "Datadog metric with a mapping entry", '{otel_metric_name="<otel>"}'),
  select("select.labels", 30, "exact", "mapping entry with extra labels (redis.cpu.sys)", 'adds matchers: {otel_metric_name="redis.cpu.time", state="sys"}', {
    note: "Applied together with select.metric.mapped or select.metric.approximate (it refines their selector, it does not replace it).",
  }),
  select("select.metric.approximate", 10, "bounded", "mapping entry marked approximate", "selector as mapped, status at best bounded", {
    findingCode: "metric.approximate",
    epsilon: "per mapping entry: the difference stated in the entry's note (e.g. RSS vs used memory)",
    note: "Tried before select.metric.mapped: an entry marked approximate never counts as exact.",
  }),
  select("select.labels.clash", 40, "manual", "query filters on a label the mapping already fixes", "no output"),
  select("query.value-filter", 50, "manual", "distribution value filter (v: ...)", "no output: PromQL has no per-value filter"),
  select("metric.no_equivalent", 60, "manual", "mapping says the OTel receiver emits no equivalent", "no output; placeholder panel"),
  select("metric.needs_transform", 62, "manual", "mapping entry with scale or sumBy (CONTRACT-002)", "no output until select.metric.transform ships"),
  select("metric.derived", 64, "manual", "mapping entry that is an expression over several OTel metrics", "no output until select.metric.derived ships"),
  selectPlan("select.metric.transform", 66, "exact", "mapping entry with scale k and/or sumBy labels", "k * x, sum without(<sumBy>) (x): both exact rewrites", {
    note: "Replaces metric.needs_transform. Each part is an exact identity; needs T4 support and a unit test per entry shape.",
  }),
  selectPlan("select.metric.derived", 68, "exact-under", "mapping entry with a derived expression over several OTel metrics", "the entry's PromQL expression, status from the entry's own claim", {
    assumptions: ["A.align"],
    note: "Replaces metric.derived. The claim comes from the mapping row, which must carry its own status and test.",
  }),
  select("select.metric.kind-metadata", 90, "exact-under", "Datadog metric with no mapping entry but a kind in its integration's metadata.csv", "keep the Datadog name; kind from metadata.csv", { assumptions: ["A.kind-metadata"] }),
  select("select.metric.unmapped", 999, "exact-under", "Datadog metric with no mapping entry", "keep the Datadog name, assume gauge", {
    assumptions: ["A.kind-gauge"],
    fallback: true,
    findingCode: "metric.unmapped",
    note: "Biggest lever for coverage: more generated mapping tables (T1 follow-up) turn these into select.metric.mapped.",
  }),

  // ---------- scope ----------
  scope("scope.all", 10, "exact", "{*}", "no matchers"),
  scope("scope.tag.eq", 20, "exact", "key:value", 'key="value"'),
  scope("scope.tag.neq", 30, "exact", "!key:value / -key:value", 'key!="value"'),
  scope("scope.tag.wildcard", 40, "exact", "key:a*", 'key=~"^a.*$" (anchored: Dash0 regex is unanchored, D-16)'),
  scope("scope.in", 50, "exact", "key IN (a,b)", 'key=~"^(a|b)$"'),
  scope("scope.or.same-key", 60, "exact", "key:a OR key:b", 'key=~"^(a|b)$"'),
  scope("scope.not", 70, "exact", "NOT key:a", 'key!="a"'),
  scope("scope.not.set", 75, "exact", "NOT (key:a OR key:b) / NOT key IN (a,b) / NOT key:a*", 'key!~"^(a|b)$"'),
  scope("scope.var", 80, "exact-under", "$var bound to a tag key", 'label=~"^($var)$" (anchored: Dash0 regex is unanchored)', { assumptions: ["A.var-regex"] }),
  scope("label.default", 85, "exact-under", "tag without a tag-table entry", "label with dots replaced by underscores", { assumptions: ["A.tag-default"], findingCode: "tag.unmapped" }),
  scope("scope.var.free-form", 90, "exact-under", "$var with no tag key ($scope)", "dropped; filters nothing at its default", { assumptions: ["A.var-default"] }),
  scope("scope.same-key", 100, "manual", "the same tag key twice in one scope", "no output: Datadog's meaning is ambiguous"),
  scope("scope.or.cross-key", 110, "manual", "key1:a OR key2:b", "no output: not a matcher set", {
    note: "Candidate: union of two selectors with `or`, exact when the series sets are disjoint. Needs a claim and a property test first.",
  }),
  scope("scope.not.complex", 120, "manual", "NOT over a compound filter", "no output"),
  scope("scope.bare-tag", 130, "manual", "bare tag without a key", "no output: no label to map to"),
  scope("scope.var.negated", 82, "exact-under", "!$var / -$var", 'label!~"^($var)$"', { assumptions: ["A.var-regex"] }),

  // ---------- kind ----------
  kind("time.kind", 10, "manual", "kind combination with no tested rule (e.g. a counter without .as_count()/.as_rate())", "no output"),
  kind("time.kind-unknown", 20, "manual", ".as_count()/.as_rate() on a metric with no mapping entry", "no output: the time aggregation depends on the kind", {
    note: "1,560 of the 2,000 manual corpus cases (hub #105). Fixed by mapping tables, not by rules.",
  }),
  kindPlan("kind.check", 30, "exact", "every emitted function against the metric's kind and unit", "type error → manual before emission (rate() on a gauge, bytes + seconds)", {
    note: "Plan 03 §3 type checker: a guard, it never changes output, only blocks wrong-kind translations.",
  }),

  // ---------- time ----------
  time("time.ddrate.plain", 10, "bounded", "plain query on a Datadog RATE metric stored as an OTel counter", "rate(x[w]) (D-18)", { epsilon: EPS_RATE, evidence: ["unit", "proof:T3", "property:T16"] }),
  time("time.rollup.default", 20, "exact-under", "implicit avg rollup", "avg_over_time(x[interval])", { assumptions: ["A.align", "A.boundary"], evidence: ["unit", "proof:T8", "exhaustive:E2"] }),
  time("time.rollup.explicit", 30, "exact-under", ".rollup(fn, s)", "fn_over_time(x[s]) inside the space aggregation", { assumptions: ["A.align", "A.boundary"], evidence: ["unit", "proof:T8", "exhaustive:E2"] }),
  time("time.rollup.monitor-bucket", 40, "exact-under", "monitor inner query", "fn_over_time(x[1m]) inside a 1m-step subquery, Unix-aligned by construction", { assumptions: ["A.boundary"], evidence: ["unit", "proof:T8", "property:T16"] }),
  time("time.as_count.gauge", 50, "exact", ".as_count() on a gauge", "no effect"),
  time("time.as_rate.gauge", 60, "exact", ".as_rate() on a gauge", "no effect"),
  time("time.as_count.delta", 70, "exact-under", ".as_count() on a delta sum", "sum_over_time(x[w])", { assumptions: ["A.align", "A.boundary"], evidence: ["unit", "proof:T8"] }),
  time("time.as_count.counter", 80, "bounded", ".as_count() on a cumulative counter", "increase(x[w])", { epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  time("time.as_rate.counter", 90, "bounded", ".as_rate() on a cumulative counter", "rate(x[w])", { epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  time("time.unmapped.counter", 92, "bounded", "Datadog count/rate (metadata.csv) without a mapping entry, with .as_count() / .as_rate() or plain", "increase(x[w]) / rate(x[w])", { assumptions: ["A.kind-metadata", "A.otel-counter"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  time("time.unmapped.suffix-counter", 93, "bounded", "no metadata.csv entry, name ends in .count/.total, with .as_count()/.as_rate()", "treated as a Datadog count: increase / rate", { assumptions: ["A.kind-suffix", "A.otel-counter"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  time("time.count.default", 94, "bounded", "Datadog COUNT metric (metadata.csv) without a modifier", "increase(x[w]), like .as_count()", { assumptions: ["A.kind-metadata", "A.otel-counter", "A.dd-count-default"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  timePlan("time.as_count.counter.anchored", 75, "exact-under", ".as_count() on a cumulative counter (or a Datadog RATE metric on an OTel counter)", "increase(x[w] anchored)", {
    assumptions: ["A.same-samples", "A.align", "A.boundary"],
    requires: ["probe:anchored"],
    evidence: ["proof:T4", "exhaustive:E1"],
    note: "Replaces time.as_count.counter (bounded) once Dash0 accepts `anchored`. Priority 75 so it wins when enabled.",
  }),
  timePlan("time.as_rate.delta.sum", 95, "exact-under", ".as_rate() on a delta sum", "sum_over_time(x[w]) / w", { assumptions: ["A.align", "A.boundary"], note: "Today T4 fails closed (time.as_rate.delta). Follows from T8 divided by a constant." }),
  time("time.fill.null", 100, "exact", ".fill(null)", "nothing: Datadog's default, PromQL does not fill"),
  time("time.fill.zero.single", 102, "exact", ".fill(zero) on a single-series query", "q or vector(0)"),
  time("time.weighted", 104, "exact-under", ".weighted()", "no-op", { assumptions: ["A.static-tags"] }),
  time("time.as_rate.delta", 110, "manual", ".as_rate() on a delta sum (until the planned rule ships)", "no output"),
  time("time.as_count.histogram", 120, "manual", ".as_count() on a histogram", "no output"),
  time("time.as_rate.histogram", 130, "manual", ".as_rate() on a histogram", "no output"),
  time("time.rollup.fn", 140, "manual", ".rollup() with an unsupported function", "no output"),
  time("time.rollup.width", 150, "manual", ".rollup() width that is not whole seconds", "no output"),
  time("time.rollup.monitor-width", 160, "manual", "monitor query with a rollup other than 60 s", "no output"),
  time("time.rollup.args", 170, "manual", ".rollup() with too many arguments", "no output"),
  time("time.rollup.counter", 180, "bounded", ".as_count().rollup(sum, s) / .as_rate().rollup(avg, s)", "increase(x[s]) / rate(x[s])", { epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  time("time.fill", 190, "manual", ".fill() other than null (zero, last, linear)", "no output: PromQL does not fill gaps", {
    note: "fill(zero): `or vector(0)` loses label sets; fill(last): last_over_time changes staleness. No claim yet.",
  }),

  // ---------- space ----------
  space("space.agg", 10, "exact", "avg|sum|min|max|count by {tags}", "PromQL aggregation by (labels)", { evidence: ["unit", "proof:T5", "exhaustive:E3"] }),
  space("space.default-avg", 20, "exact", "legacy query without an aggregator", "avg"),

  // ---------- function ----------
  fn("map.abs", 10, "exact", "abs(q)", "abs(x)"),
  fn("map.log2", 20, "exact", "log2(q)", "log2(x)"),
  fn("map.log10", 30, "exact", "log10(q)", "log10(x)"),
  fn("map.clamp_min", 40, "exact", "clamp_min(q, n)", "clamp_min(x, n)"),
  fn("map.clamp_max", 50, "exact", "clamp_max(q, n)", "clamp_max(x, n)"),
  fn("map.timeshift", 60, "exact", "timeshift(q, -s) / hour_before / day_before / week_before", "offset s on every selector"),
  fn("fn.timeshift.future", 70, "manual", "timeshift into the future or by a fraction of a second", "no output"),
  fn("fn.args", 80, "manual", "function argument of the wrong type", "no output"),
  fn("query.postfix.non-metric", 90, "manual", "postfix function on a non-metric expression", "no output"),
  fn("fn.per_unit.counter", 100, "bounded", "per_second/per_minute/per_hour(q) over a running total or a counter", "k * agg(rate(x[w]))", { assumptions: ["A.dd-per-unit"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  fn("fn.derivative.counter", 105, "bounded", "derivative(q) over a gauge holding an OTel counter's running total", "agg(rate(x[w]))", { assumptions: ["A.dd-per-unit"], epsilon: EPS_RATE, evidence: ["unit", "proof:T3"] }),
  fn("fn.diff", 110, "exact-under", "diff(q)", "q - (q offset interval)", { assumptions: ["A.align", "A.no-gaps"] }),
  fn("fn.top", 145, "exact-under", "top(q, N, method, order) / topN / bottomN", "topk(N, q) / bottomk(N, q)", { assumptions: ["A.top-stable"], note: "fn.top.window (planned, priority 140) drops A.top-stable by ranking once over the window." }),
  fn("fn.cutoff", 115, "exact", "cutoff_min(q, n) / cutoff_max(q, n)", "q >= n / q <= n"),
  fn("fn.count_not_null", 120, "exact", "count_not_null(q)", "count(q)"),
  fn("fn.count_nonzero", 125, "exact", "count_nonzero(q)", "count(q != 0)"),
  fn("fn.default_zero.single", 130, "exact", "default_zero(q) on a single-series query", "q or vector(0)"),
  fn("fn.exclude_null", 131, "exact", "exclude_null(q)", "label!=\"\" on every selector for each group-by label (drops the N/A group)"),
  fn("fn.monotonic_diff", 132, "exact-under", "monotonic_diff(q)", "(q - (q offset interval)) >= 0", { assumptions: ["A.align", "A.no-gaps", "A.mono-diff"] }),
  fn("fn.round", 133, "exact", "round(q)", "round(x)"),
  fn("fn.max_min.scalar", 134, "exact", "max(q, n) / min(q, n)", "clamp_min(x, n) / clamp_max(x, n)"),
  fn("fn.max_min.series", 135, "exact-under", "max(a, b) / min(a, b) of two queries with the same group-by", "a >= b or b / a <= b or b (pointwise)", { assumptions: ["A.both-present"] }),
  fnPlan("fn.top.window", 140, "exact-under", "top(q, N, 'mean'|'max'|'min'|'sum', 'desc'|'asc')", "x and on(<labels>) topk(N, <agg>_over_time(x[$__range] @ end())) (bottomk for asc)", {
    assumptions: ["A.top-uniform"],
    requires: ["probe:at-modifier"],
    note: "Ranks once over the whole visible window, like Datadog, instead of per step like plain topk. 129 corpus cases (hub #105).",
  }),
  fnPlan("fn.histogram.quantile", 150, "bounded", "pXX:metric on a distribution", "histogram_quantile(0.XX, sum by (le, <g>) (rate(m_bucket[w])))", {
    epsilon: "width of the histogram bucket containing the quantile, plus DDSketch's 1% relative error on the Datadog side",
    note: "Depends on how the metric is ingested (explicit buckets vs exponential histogram).",
  }),
  fnPlan("fn.per_unit.kind", 160, "manual", "per_second / per_minute / per_hour / derivative on a plain gauge (47 corpus cases)", "no output; candidate deriv() is a least-squares slope, not Datadog's point difference"),
  fnPlan("fn.cumsum", 180, "manual", "cumsum(q) / integral(q)", "no output: accumulates over the visible window"),
  fnPlan("fn.anomalies", 190, "manual", "anomalies() / forecast() / outliers()", "no output: no PromQL counterpart (maths.md §9.5)"),
  fnPlan("fn.calendar-shift", 200, "manual", "month_before() and other calendar shifts", "no output: months are not fixed seconds"),
  fn("fn.unknown", 999, "manual", "any other Datadog function (T4 emits fn.<name>)", "no output; original kept", { fallback: true, findingCode: "fn.unsupported" }),

  // ---------- arith ----------
  arith("arith.number", 10, "exact", "arithmetic with a constant", "same operator with the constant"),
  arith("arith.same-groups", 20, "exact", "arithmetic between queries with identical group-by labels", "one-to-one vector matching"),
  arith("arith.div", 30, "exact-under", "division between queries", "a / b", { assumptions: ["A.nonzero-denominator"], evidence: ["unit", "proof:T6"] }),
  arith("arith.neg", 40, "exact", "unary minus", "-x"),
  arith("arith.div-zero", 45, "manual", "division by the constant 0", "no output: Datadog drops the point, PromQL gives ±Inf/NaN"),
  arith("arith.group-mismatch", 50, "manual", "arithmetic between queries with different groupings", "no output", {
    note: "Planned arith.group-subset (on(...) group_left) waits on probe:dd-formula-join.",
  }),
  arithPlan("arith.group-subset", 55, "exact-under", "formula where one side's groups are a subset of the other's", "a / on(<common>) group_left b", {
    assumptions: ["A.nonzero-denominator"],
    requires: ["probe:dd-formula-join"],
  }),
  arith("formula.ref.unknown", 60, "manual", "formula references a query that does not exist", "no output"),

  // ---------- monitor ----------
  mon("monitor.window", 10, "exact-under", "fn(last_W):Q with fn in avg|sum|min|max", "fn_over_time((Q on 1m buckets)[W:1m]), the subquery form (maths.md §5, D-28 corrected)", {
    assumptions: ["A.monitor-rollup-60s", "A.boundary"],
    evidence: ["unit", "proof:T5", "property:T16"],
  }),
  mon("monitor.cmp.gt", 20, "exact", "> / >=", "expr > $__threshold (>= for >=), critical → failed, warning → degraded"),
  mon("monitor.cmp.lt", 30, "exact", "< / <=", "-(expr) > $__threshold with negated thresholds", { evidence: ["unit", "proof:T7", "exhaustive:E4"], requires: ["probe:lt-threshold"] }),
  mon("monitor.sum.as_count", 40, "bounded", "sum(last_W):q.as_count() on a counter", "agg(increase(x[W]))", { epsilon: EPS_RATE, evidence: ["unit", "proof:T3", "proof:T4"] }),
  mon("monitor.cmp.eq", 35, "exact", "== T / != T", "-abs(expr - T) >= $__threshold / abs(expr - T) > $__threshold, failed 0"),
  mon("monitor.threshold.mismatch", 50, "exact-under", "query threshold differs from options.thresholds.critical", "the query's threshold is used; warn finding", { assumptions: ["A.query-threshold"] }),
  mon("monitor.as_count", 55, "manual", ".as_count() inside a monitor query", "no output (Datadog's monitor evaluation order for counts differs, kb 06 §7.1); alert.window.sum.count is the planned rule"),
  mon("monitor.change", 60, "exact", "change(fn(last_W), last_C) / pct_change(...)", "X - X offset C; 100 * (X - X offset C) / X offset C"),
  mon("monitor.window.kind", 70, "manual", "window other than last_* (e.g. a cumulative window)", "no output"),
  mon("monitor.window.width", 80, "manual", "window that is not whole minutes", "no output"),
  mon("monitor.time-agg", 90, "manual", "monitor time aggregation other than avg/sum/min/max", "no output"),
  mon("monitor.cmp", 999, "manual", "any other comparator", "no output", { fallback: true }),
];

/**
 * T4's rule table ids (src/translate/query/rules.ts RULES), in T4's order. RULES_T4 in src/rules/index.ts is built from
 * these, so T4 can re-export it unchanged.
 */
export const T4_TABLE_IDS = [
  "select.metric.mapped",
  "select.metric.unmapped",
  "select.metric.kind-metadata",
  "time.unmapped.counter",
  "time.unmapped.suffix-counter",
  "time.count.default",
  "time.rollup.counter",
  "time.fill.zero.single",
  "select.metric.approximate",
  "select.labels",
  "time.ddrate.plain",
  "scope.all",
  "scope.tag.eq",
  "scope.tag.neq",
  "scope.tag.wildcard",
  "scope.in",
  "scope.or.same-key",
  "scope.not",
  "scope.not.set",
  "scope.var.negated",
  "scope.var",
  "label.default",
  "time.rollup.default",
  "time.rollup.explicit",
  "time.rollup.monitor-bucket",
  "time.as_count.gauge",
  "time.as_rate.gauge",
  "time.as_count.delta",
  "time.as_count.counter",
  "time.as_rate.counter",
  "time.fill.null",
  "time.weighted",
  "space.agg",
  "space.default-avg",
  "map.abs",
  "map.log2",
  "map.log10",
  "map.clamp_min",
  "map.clamp_max",
  "fn.per_unit.counter",
  "fn.diff",
  "fn.derivative.counter",
  "fn.top",
  "fn.cutoff",
  "fn.count_not_null",
  "fn.count_nonzero",
  "fn.default_zero.single",
  "fn.exclude_null",
  "fn.monotonic_diff",
  "fn.round",
  "fn.max_min.scalar",
  "fn.max_min.series",
  "map.timeshift",
  "arith.number",
  "arith.same-groups",
  "arith.div",
  "arith.neg",
  "monitor.window",
  "monitor.change",
  "monitor.sum.as_count",
  "monitor.cmp.eq",
  "monitor.cmp.gt",
  "monitor.cmp.lt",
] as const;
