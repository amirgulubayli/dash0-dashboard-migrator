// T4 types. Finding follows the plan 00 contract; it moves to src/ir once T1 lands.

/** Plan 03 §2: the relation between the Datadog meaning and the emitted PromQL meaning. */
export type Status = "exact" | "exact-under" | "bounded" | "manual";

/** Worst first: composition takes the worst status of its parts. */
export const STATUS_ORDER: Status[] = ["exact", "exact-under", "bounded", "manual"];

export function worst(a: Status, b: Status): Status {
  return STATUS_ORDER.indexOf(a) >= STATUS_ORDER.indexOf(b) ? a : b;
}

export interface Finding {
  severity: "info" | "warn" | "error" | "unsupported";
  code: string;
  where: string;
  message: string;
  original?: unknown;
}

/** OTel-side metric kind (plan 03 §3). `gauge` is assumed when the mapping table has no entry. */
export type MetricKind = "gauge" | "counter" | "delta" | "histogram";

export interface MetricMapping {
  otel: string;
  kind: MetricKind;
}

export interface TranslateContext {
  /** Datadog metric name -> OTel metric. Undefined: keep the Datadog name, assume gauge, warn. */
  metric?: (ddName: string) => MetricMapping | undefined;
  /** Datadog tag key -> PromQL label. Undefined: dots become underscores. */
  tag?: (ddTag: string) => string | undefined;
  /** Dashboard template variables: name -> the tag key it filters (Datadog `prefix`), or null for free-form. */
  variables?: Record<string, { tag: string | null }>;
  /** Default rollup width for dashboard queries: seconds, or "$__interval" (the default). */
  interval?: number | "$__interval";
  /** JSON path of the item being translated, copied into every finding. */
  where?: string;
}

export interface QueryTranslation {
  status: Status;
  /** Rendered PromQL, or null when status is manual. */
  promql: string | null;
  /** ruleIds applied, in application order (deduplicated). */
  rules: string[];
  /** Assumption ids for exact-under (see ASSUMPTIONS). */
  assumptions: string[];
  findings: Finding[];
}
