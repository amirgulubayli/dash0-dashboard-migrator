// T4 types. Status and Finding are the shared CONTRACT-001 types from src/ir.
import type { Finding, MetricAvailability, Status } from "../../ir/index.js";

export type { Finding, MetricAvailability, Status };
export { worst } from "../../ir/index.js";

/** OTel-side metric kind (plan 03 §3). `gauge` is assumed when the mapping table has no entry. */
export type MetricKind = "gauge" | "counter" | "delta" | "histogram";

/**
 * Structurally compatible with T1's `MetricLookup` (src/ir/context.ts), so `metricLookup(mappings)` plugs in
 * as `ctx.metric` directly. Only `otel` and `kind` are required.
 */
export interface MetricMapping {
  otel: string;
  /** OTel-side kind. */
  kind: MetricKind;
  /** How Datadog stores it. When present, it decides the time aggregation (a Datadog gauge read from an OTel counter is still a gauge). */
  ddKind?: "gauge" | "rate" | "count" | "distribution";
  /** Extra equality matchers that select the right series, e.g. redis.cpu.sys -> {state: "sys"}. */
  labels?: Record<string, string>;
  /** Name-mapping fidelity from the table. "approximate" makes the result at best `bounded`. */
  status?: "exact" | "approximate";
  note?: string;
}

export interface TranslateContext {
  /** Datadog metric name -> OTel metric. Undefined: see `availability`; truly unmapped keeps the Datadog name, assumes gauge, warns. */
  metric?: (ddName: string) => MetricMapping | undefined;
  /**
   * Why a metric has no lookup (T1 `metricAvailability`). `no_equivalent`, `derived` and `needs_transform` fail closed
   * (manual). Without it, every metric the lookup doesn't return is treated as unmapped.
   */
  availability?: (ddName: string) => MetricAvailability;
  /** Datadog tag key -> PromQL label. Undefined: dots become underscores, with a `tag.unmapped` finding. */
  tag?: (ddTag: string) => string | undefined;
  /** Dashboard template variables: name -> the tag key it filters (Datadog `prefix`), or null for free-form. */
  variables?: Record<string, { tag: string | null }>;
  /** Default rollup width for dashboard queries: seconds, or "$__interval" (the default). */
  interval?: number | "$__interval";
  /** Item id copied into every finding's `itemId`, e.g. "dd-dash-abc/panel-12/query1". */
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
