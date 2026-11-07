// Capability probes: facts about Dash0 or Datadog that a rule depends on and that nobody has confirmed yet.
// A rule that `requires` an open probe stays planned. When a probe is answered, record it here with the evidence.

export interface Probe {
  question: string;
  how: string;
  answer: "open" | "yes" | "no";
}

export const PROBES = {
  "probe:anchored": {
    question: "Does Dash0 accept increase(x[1m] anchored)?",
    how: "maths.md §11 probe 1: run it in the Dash0 query API",
    answer: "open",
  },
  "probe:at-modifier": {
    question: "Does Dash0 accept the @ end() modifier in queries?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): @ end() accepted by the query API; 935/935 queries with the new constructs accepted (hub #278). That test did NOT show that a dashboard substitutes $__range: see probe:range-var.",
    answer: "yes",
  },
  "probe:range-var": {
    question: "Does a Dash0 dashboard substitute $__range with its visible time range in panel queries (and a stat panel with calculation last-number show the value at the end of that range)?",
    how: "The query API does not substitute variables (it rejects [$__interval] with a parse error) and Dash0's docs only describe $__interval, so only a rendered panel can answer: put the same count over [$__range] and over a fixed window side by side on a throwaway dashboard, change the time range (15m, 1h) and compare",
    answer: "open",
  },
  "probe:lt-threshold": {
    question: "How does Dash0 compare $__threshold for `<` expressions (is higher always worse)?",
    how: "maths.md §11 probe 5, T0 check-rule export",
    answer: "open",
  },
  "probe:threshold-label": {
    question: "Does Dash0 expose which threshold fired (failed / degraded) as a label usable in annotation templates?",
    how: "T0: fire a test rule and read its notification payload",
    answer: "open",
  },
  "probe:statchart-calculation": {
    question: "Which StatChart `calculation` names does Dash0 accept (mean, max, min, sum, last)?",
    how: "T0: export a StatChart with each calculation",
    answer: "open",
  },
  "probe:listvariable": {
    question: "Does Dash0 import accept Perses ListVariable + PrometheusLabelValuesVariable, or only Dash0FilterVariable?",
    how: "plan 00 open question; T7 dry-run import of a dashboard with one ListVariable",
    answer: "open",
  },
  "probe:row-height": {
    question: "Is one Dash0 grid row as tall as one Datadog grid row?",
    how: "T0: compare a golden export with the Datadog source",
    answer: "open",
  },
  "probe:collapse": {
    question: "Does Dash0 honour Grid display.collapse.open for titled sections?",
    how: "T0: export a dashboard with one collapsed group",
    answer: "open",
  },
  "probe:piechart": {
    question: "Does Dash0 render a Perses PieChart from a PromQL query with a grouping?",
    how: "T0 or T7 dry-run",
    answer: "open",
  },
  "probe:log-labels": {
    question: "What are the label names for severity and body on {otel_metric_name=\"dash0.logs\"}?",
    how: "LIVE 2026-11-07 (Ali, org thinc_bavarian_big_ben): severity otel_log_severity_range / otel_log_severity_text, body otel_log_body (unanchored regex), attributes with dots as underscores; docs/research/dash0.md \"dash0.logs labels\", dash0-team 71e47aa",
    answer: "yes",
  },
  "probe:dd-formula-join": {
    question: "In a Datadog formula over queries with different groupings, do unmatched groups drop?",
    how: "maths.md §11 probe 3",
    answer: "open",
  },
} as const satisfies Record<string, Probe>;

export type ProbeId = keyof typeof PROBES;
