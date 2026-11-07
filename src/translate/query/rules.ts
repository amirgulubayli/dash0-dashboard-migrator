// The translation table as data (plan 02 §2 rule 1). Every ruleId has a status claim (plan 03 §2),
// the assumptions it needs, and at least one test asserting the exact PromQL it produces.
import type { Status } from "./types.js";

export const ASSUMPTIONS = {
  "A.align": "PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2)",
  "A.boundary": "no sample lies exactly on a bucket boundary (maths.md T8, A3)",
  "A.kind-gauge": "the metric is a gauge; there is no mapping-table entry to confirm its kind",
  "A.monitor-rollup-60s": "Datadog evaluates the monitor's inner query on 60 s buckets",
  "A.nonzero-denominator": "the denominator is never 0 (Datadog drops the point, PromQL yields ±Inf/NaN)",
  "A.var-default": "a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing",
  "A.var-regex": "the dashboard substitutes the variable as a regex of escaped literal values (a single value, or (a|b) for several)",
  "A.tag-default": "the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry)",
  "A.query-threshold": "Datadog evaluates the threshold written in the monitor query, which differs from options.thresholds.critical",
} as const;

export type AssumptionId = keyof typeof ASSUMPTIONS;

export interface Rule {
  status: Status;
  assumptions: AssumptionId[];
  description: string;
}

const exact = (description: string): Rule => ({ status: "exact", assumptions: [], description });
const under = (assumptions: AssumptionId[], description: string): Rule => ({
  status: "exact-under",
  assumptions,
  description,
});
const bounded = (description: string): Rule => ({ status: "bounded", assumptions: [], description });

export const RULES = {
  // selection
  "select.metric.mapped": exact("Datadog metric -> {otel_metric_name=...} through the mapping table"),
  "select.metric.unmapped": under(["A.kind-gauge"], "no mapping entry: keep the Datadog name, assume gauge"),
  "select.metric.approximate": bounded("the mapping table marks the OTel metric as approximate (see the entry's note)"),
  "select.labels": exact("mapping-table labels pick the series: redis.cpu.sys -> {otel_metric_name=\"redis.cpu.time\", state=\"sys\"}"),
  "time.ddrate.plain": bounded(
    "Datadog RATE metric (stored per second) read from an OTel counter: a plain query -> rate(x[w]) (D-18, maths.md T3b); dashboards use w = $__rate_interval",
  ),
  "scope.all": exact("{*} -> no matchers"),
  "scope.tag.eq": exact("key:value -> key=\"value\""),
  "scope.tag.neq": exact("!key:value / -key:value -> key!=\"value\""),
  "scope.tag.wildcard": exact("key:a* -> key=~\"^a.*$\" (Dash0 regex is unanchored, so anchor it)"),
  "scope.in": exact("key IN (a,b) -> key=~\"^(a|b)$\""),
  "scope.or.same-key": exact("key:a OR key:b -> key=~\"^(a|b)$\""),
  "scope.not": exact("NOT key:a -> key!=\"a\""),
  "scope.var": under(["A.var-regex"], "$var -> label=~\"^($var)$\" on the variable's tag (anchored: Dash0 regex is unanchored)"),
  "label.default": under(["A.tag-default"], "tag without a tag-table entry -> label with dots replaced by underscores"),
  // time aggregation (Datadog does time first, then space)
  "time.rollup.default": under(["A.align", "A.boundary"], "implicit avg rollup -> avg_over_time(x[interval])"),
  "time.rollup.explicit": under(["A.align", "A.boundary"], ".rollup(fn, s) -> fn_over_time(x[s])"),
  "time.rollup.monitor-bucket": under(
    ["A.boundary"],
    "monitor inner query: fn_over_time(x[1m]) inside a 1m-step subquery, aligned to Unix minutes by construction",
  ),
  "time.as_count.gauge": exact(".as_count() has no effect on gauges"),
  "time.as_rate.gauge": exact(".as_rate() has no effect on gauges"),
  "time.as_count.delta": under(["A.align", "A.boundary"], ".as_count() on a delta sum -> sum_over_time(x[w])"),
  "time.as_count.counter": bounded(
    ".as_count() on a cumulative counter -> increase(x[w]) (extrapolated, maths.md T3b); dashboards use w = $__rate_interval",
  ),
  "time.as_rate.counter": bounded(".as_rate() on a cumulative counter -> rate(x[w]) (maths.md T3b); dashboards use w = $__rate_interval"),
  "time.fill.null": exact(".fill(null) is Datadog's default: no filling"),
  // space aggregation
  "space.agg": exact("avg|sum|min|max|count by {tags} -> PromQL aggregation by (labels)"),
  "space.default-avg": exact("legacy query without aggregator: Datadog averages -> avg"),
  // pointwise
  "map.abs": exact("abs(q) -> abs(x)"),
  "map.log2": exact("log2(q) -> log2(x)"),
  "map.log10": exact("log10(q) -> log10(x)"),
  "map.clamp_min": exact("clamp_min(q, n) -> clamp_min(x, n)"),
  "map.clamp_max": exact("clamp_max(q, n) -> clamp_max(x, n)"),
  "map.timeshift": exact("timeshift(q, -s) / hour_before(q) / ... -> offset s on every selector"),
  "arith.number": exact("arithmetic with a constant"),
  "arith.same-groups": exact("arithmetic between queries with identical group-by labels (one-to-one matching)"),
  "arith.div": under(["A.nonzero-denominator"], "division between queries"),
  "arith.neg": exact("unary minus"),
  // monitors
  "monitor.window": under(
    ["A.monitor-rollup-60s", "A.boundary"],
    "fn(last_W):Q -> fn_over_time((Q on 1m buckets)[W:1m]), the subquery form that mirrors Datadog's order (maths.md §5)",
  ),
  "monitor.cmp.gt": exact("> / >= -> expr > $__threshold, critical -> failed, warning -> degraded"),
  "monitor.cmp.lt": exact("< / <= -> -(expr) > $__threshold with negated thresholds (maths.md T7)"),
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;
