export const REASON_CODES: Record<string, string> = {
  RATE_CONVERSION: "Datadog stores this as a per-second rate, so we rebuild it from a counter with rate().",
  DB_SUM_REQUIRED: "OpenTelemetry splits this by database, so we add the databases together.",
  DEFAULT_ROLLUP_DIFFERENCE: "Datadog picks its own time buckets and Dash0 samples differently, so values can differ slightly.",
  NO_EQUIVALENT_METRIC: "The OpenTelemetry Redis receiver doesn't collect this metric, so the panel stays empty.",
  UNSUPPORTED_WIDGET: "Dash0 has no equivalent chart for this widget type yet.",
  NON_METRIC_DATA_SOURCE: "This panel shows logs, which PromQL can't query.",
  LABEL_MAPPING_MISSING: 'The "by host" split was dropped because our telemetry has no host label.',
  TEMPLATE_VARIABLE_PINNED: 'Dashboard filters were fixed to "all" for now.',
  ZERO_DENOMINATOR_RISK: "This divides by a value that can be zero.",
  LABELS_DROPPED_BY_AGGREGATION: "The alert averages everything, so Dash0 can't say which instance triggered it.",
  MONITOR_OPTION_UNSUPPORTED: "A Datadog alert setting has no Dash0 equivalent and needs a human decision.",
  METRIC_NOT_ENABLED: "The collector has this metric switched off by default; we turn it on in the config.",
  LAYOUT_APPROXIMATE: "Dash0 uses a 24-column grid, so positions are converted and may shift slightly.",
  APPROXIMATE_FUNCTION: "A Datadog function like per_minute or diff is rebuilt in PromQL with a small difference in the maths.",
};

export const explainCode = (code: string): string | undefined => REASON_CODES[code];
