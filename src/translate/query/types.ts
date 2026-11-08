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
  /**
   * Datadog's own kind for a metric WITHOUT a curated mapping (generated from integrations-core metadata.csv).
   * Curated mappings always win. Without it, an unmapped metric is assumed to be a gauge.
   */
  ddKind?: (ddName: string) => "gauge" | "count" | "rate" | "distribution" | undefined;
  /** Datadog tag key -> PromQL label. Undefined: dots become underscores, with a `tag.unmapped` finding. */
  tag?: (ddTag: string) => string | undefined;
  /** Dashboard template variables: name -> the tag key it filters (Datadog `prefix`), or null for free-form. */
  variables?: Record<string, { tag: string | null }>;
  /** Default rollup width for dashboard queries: seconds, or "$__interval" (the default). */
  interval?: number | "$__interval";
  /** Item id copied into every finding's `itemId`, e.g. "dd-dash-abc/panel-12/query1". */
  where?: string;
  /**
   * Set by T5 for a toplist: rank the query once over the visible window (fn.top.window) instead of emitting its
   * per-interval form. `aggregator` is the Datadog request aggregator (avg|sum|min|max|last), `limit` the formula's
   * top-N limit. When the window form has no rule, T4 returns the per-interval translation with `window.applied` false.
   */
  window?: ToplistWindow;
}

export interface ToplistWindow {
  aggregator?: string;
  limit?: { count: number; order: "asc" | "desc" };
}

/**
 * A query translated elsewhere (e.g. a `data_source: logs` query by T12), usable as a formula ref. Its status,
 * rules, assumptions and findings are merged into the formula's result.
 */
export interface LoweredRef {
  type: "lowered";
  node: import("./promql.js").PNode;
  /** Output labels (sorted), or null for a scalar. */
  groups: string[] | null;
  status: Status;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
}

/** Formula environment: query name -> parsed Datadog metric query, or an already-translated query. */
export type FormulaEnv = Map<string, import("../../parse/index.js").Expr | LoweredRef>;

export interface QueryTranslation {
  status: Status;
  /** Rendered PromQL, or null when status is manual. */
  promql: string | null;
  /** ruleIds applied, in application order (deduplicated). */
  rules: string[];
  /** Assumption ids for exact-under (see ASSUMPTIONS). */
  assumptions: string[];
  findings: Finding[];
  /** Only when ctx.window was set: whether the toplist was ranked over the window, and if not, why. */
  window?: { applied: boolean; reason?: string };
}
