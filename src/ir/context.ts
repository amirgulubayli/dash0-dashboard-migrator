// Adapters from the mapping tables to the lookups T4's TranslateContext expects:
//   ctx.metric(dd) -> { otel, kind }   and   ctx.tag(dd) -> label   (Ali, hub #104).
// The metric lookup returns T4's shape plus two fields T4 should honour (CONTRACT-001 asks):
//   labels  extra matchers that select the right series, e.g. redis.cpu.sys -> redis.cpu.time{state="sys"}
//   ddKind  how Datadog stores the metric. ddKind "rate" on an OTel counter means a PLAIN Datadog query already
//           shows a per-second rate, so it translates to rate(...) (D-18), not to "counter needs .as_count()".
import type { DatadogKind, Mappings } from "./mappings.js";
import { kindTransform } from "./mappings.js";

/** T4's MetricKind. updowncounter is read like a gauge in PromQL (no rate), so it maps to "gauge". */
export type TranslatorKind = "gauge" | "counter" | "delta" | "histogram";

export interface MetricLookup {
  otel: string;
  kind: TranslatorKind;
  labels: Record<string, string>;
  ddKind: DatadogKind;
  /** "rate" when the translator must wrap the selector in rate() to match what Datadog stores. */
  transform: "none" | "rate";
  status: "exact" | "approximate";
  note?: string;
}

/**
 * Why a metric has no lookup, so the caller can emit the right finding code.
 * needs_transform: the entry sets `scale` or `sumBy`, which no translator applies yet. It fails closed (manual)
 * instead of silently emitting the wrong unit or un-summed series (Ali's review of PR #4).
 */
export type MetricAvailability = "mapped" | "unmapped" | "no_equivalent" | "derived" | "needs_transform";

export function metricAvailability(m: Mappings, dd: string): MetricAvailability {
  const e = m.metrics.get(dd);
  if (!e) return "unmapped";
  if (e.otel === null) return e.derived ? "derived" : "no_equivalent";
  if (e.scale !== undefined || e.sumBy.length > 0) return "needs_transform";
  return "mapped";
}

/** ctx.metric for T4. undefined unless availability is "mapped" (check metricAvailability for the reason). */
export function metricLookup(m: Mappings): (dd: string) => MetricLookup | undefined {
  return (dd) => {
    if (metricAvailability(m, dd) !== "mapped") return undefined;
    const e = m.metrics.get(dd)!;
    if (e.otel === null || e.otelKind === null || e.status === "none") return undefined;
    const kind: TranslatorKind = e.otelKind === "counter" ? "counter" : e.otelKind === "histogram" ? "histogram" : "gauge";
    return {
      otel: e.otel,
      kind,
      labels: e.labels,
      ddKind: e.ddKind,
      transform: kindTransform(e).transform,
      status: e.status,
      ...(e.note !== undefined && { note: e.note }),
    };
  };
}

/** ctx.tag for T4. undefined for unmapped tags (T4 then replaces dots with underscores and emits tag.unmapped). */
export function tagLookup(m: Mappings): (dd: string) => string | undefined {
  return (dd) => m.tags.get(dd)?.label;
}
