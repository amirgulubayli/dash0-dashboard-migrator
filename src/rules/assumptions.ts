// Assumptions behind exact-under claims (plan 03 §2). Each is phrased so it can be checked on live data.
// The first six are T4's (src/translate/query/rules.ts, PR #3), copied verbatim; tests/rules keeps them in sync.

export const ASSUMPTIONS = {
  // T4
  "A.align": "PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2)",
  "A.boundary": "no sample lies exactly on a bucket boundary (maths.md T8, A3)",
  "A.kind-gauge": "the metric is a gauge; there is no mapping-table entry to confirm its kind",
  "A.monitor-rollup-60s": "Datadog evaluates the monitor's inner query on 60 s buckets",
  "A.nonzero-denominator": "the denominator is never 0 (Datadog drops the point, PromQL yields ±Inf/NaN)",
  "A.var-default": "a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing",
  // T17 additions
  "A.same-samples": "Datadog and Dash0 see the same samples of the counter (maths.md T4 model: a RATE point is (vᵢ − vᵢ₋₁)/s)",
  "A.full-window": "every evaluated series has samples across the whole monitor window (Datadog require_full_window)",
  "A.no-new-groups": "no new group (host, tag value) appears during the monitor's new_group_delay / new_host_delay",
  "A.eval-1m": "Datadog evaluates the monitor once per minute (true for metric monitors with windows up to 24 h)",
  "A.notify-manual": "notification routing (channels, renotify, escalation) is recreated by hand in Dash0; it does not change when the rule fires",
  "A.label-rename": "nothing downstream matches on the original Datadog tag key spelling, only on the sanitised label",
  "A.msg-conditional": "the reader of a notification can tell failed from degraded by the rule's threshold, so text from {{#is_alert}} / {{#is_warning}} blocks may appear unconditionally",
  "A.msg-verbatim": "showing an unknown Datadog template token as literal text is acceptable in the notification",
  "A.style": "fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning",
  "A.row-height": "one Dash0 grid row has the same height as one Datadog grid row (to confirm from the T0 golden export)",
  "A.var-values": "a label's values in Dash0 are the same set as the matching tag's values in Datadog",
  "A.table-single-query": "the table has one query, default sorting and no conditional formats",
  "A.top-uniform": "every ranked series has samples on the same uniform grid over the dashboard range, and no two window means tie",
} as const;

export type AssumptionId = keyof typeof ASSUMPTIONS;

/** T4's assumption ids, in T4's order. */
export const T4_ASSUMPTION_IDS = [
  "A.align",
  "A.boundary",
  "A.kind-gauge",
  "A.monitor-rollup-60s",
  "A.nonzero-denominator",
  "A.var-default",
] as const satisfies readonly AssumptionId[];
