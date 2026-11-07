// IR Panel -> Perses panel in Dash0's dialect (only kinds Dash0 renders: docs/research/dash0.md).
// Anything that can't be a faithful panel becomes a Markdown placeholder that shows the original and the reason,
// the same pattern Dash0's own Grafana importer uses.
import { worst, type Finding, type Panel, type Status } from "../../ir/index.js";
import type { PersesPanel } from "../../targets/dash0/index.js";
import type { RequestTranslation } from "./queries.js";

export interface PanelResult {
  itemId: string;
  title: string;
  sourceType: string;
  /** Perses plugin kind emitted. "Markdown" for placeholders. */
  persesKind: string;
  placeholder: boolean;
  status: Status;
  promql: string[];
  rules: string[];
  assumptions: string[];
  findings: Finding[];
  panel: PersesPanel;
}

/** query_value aggregator -> StatChart calculation. */
const CALC: Record<string, string> = { avg: "mean", sum: "sum", min: "min", max: "max", last: "last-number" };

export function toPersesPanel(p: Panel, itemId: string, q: RequestTranslation | null): PanelResult {
  const title = p.title?.trim() || p.sourceType;
  const findings: Finding[] = [...(q?.findings ?? [])];
  let status: Status = q?.status ?? "exact";
  const rules = [...(q?.rules ?? [])];
  const note = (s: Exclude<Status, "exact">, code: string, message: string, original?: string) => {
    status = worst(status, s);
    findings.push({ status: s, code, message, itemKind: "panel", itemId, ...(original !== undefined ? { original } : {}) });
  };
  const result = (persesKind: string, spec: Record<string, unknown>, placeholder = false): PanelResult => {
    const queries = placeholder ? [] : (q?.queries ?? []);
    return {
      itemId,
      title,
      sourceType: p.sourceType,
      persesKind,
      placeholder,
      status: placeholder ? "manual" : status,
      promql: queries.map((x) => x.promql),
      rules,
      assumptions: [...(q?.assumptions ?? [])],
      findings,
      panel: {
        kind: "Panel",
        spec: {
          display: { name: title, description: describe(p, itemId) },
          plugin: { kind: persesKind, spec },
          ...(queries.length
            ? {
                queries: queries.map((x) => ({
                  kind: "TimeSeriesQuery" as const,
                  spec: { plugin: { kind: "PrometheusTimeSeriesQuery" as const, spec: { query: x.promql, ...(x.legend ? { seriesNameFormat: x.legend } : {}) } } },
                })),
              }
            : {}),
        },
      },
    };
  };
  const placeholder = (reason: string) => result("Markdown", { text: placeholderText(p, itemId, reason) }, true);

  switch (p.kind) {
    case "markdown":
      rules.push("panel.note");
      return result("Markdown", { text: String(p.options.text ?? "") });
    case "unsupported":
      // T2 already emitted widget.unsupported for this panel.
      return placeholder(`Dash0 has no panel for the Datadog '${p.sourceType}' widget.`);
    case "logs":
      note("manual", "logs.not_translated", "log widgets are not translated yet (log search -> dash0.logs / LogTable is plan 01 T12)", p.requests[0]?.queries[0]?.expr);
      return placeholder("Log widgets are not migrated yet.");
  }

  // Query-backed panels: with no PromQL at all, show a placeholder instead of an empty chart.
  if (!q || q.queries.length === 0) return placeholder("None of its queries could be translated to PromQL (see the findings).");

  switch (p.kind) {
    case "timeseries": {
      rules.push("panel.timeseries");
      const types = (p.options.displayTypes as string[] | undefined) ?? [];
      const spec: Record<string, unknown> = {};
      if (types.length && types.every((t) => t === "bars")) spec.visual = { display: "bar" };
      else if (types.some((t) => t === "area" || t === "bars")) note("bounded", "panel.style", `display types ${[...new Set(types)].join(", ")} drawn as lines`);
      if (p.options.showLegend === true) spec.legend = { position: "bottom" };
      return result("TimeSeriesChart", spec);
    }
    case "stat": {
      rules.push("panel.stat");
      const agg = p.requests[0]?.queries[0]?.aggregator;
      let calculation = agg ? CALC[agg] : undefined;
      if (!calculation) {
        calculation = "mean";
        note("exact-under", "panel.stat.aggregator", agg ? `aggregator '${agg}' has no StatChart calculation; mean used` : "no aggregator given; Datadog's avg assumed", agg);
      }
      if (q.queries.length > 1) note("bounded", "panel.stat.multi", `${q.queries.length} queries on one stat panel; Dash0 shows the first`);
      const spec: Record<string, unknown> = { calculation };
      if (typeof p.options.precision === "number") spec.format = { unit: "decimal", decimalPlaces: p.options.precision };
      if (p.options.conditionalFormats) note("bounded", "panel.conditional_format", "conditional colour formats are not migrated");
      return result("StatChart", spec);
    }
    case "toplist":
    case "table": {
      rules.push(`panel.${p.kind}`);
      const limits = p.requests.flatMap((r) => r.formulas.map((f) => f.limit).filter((x) => x !== undefined));
      note(
        "bounded",
        `panel.${p.kind}.table`,
        `Datadog ${p.sourceType} shown as a TimeSeriesTable${limits.length ? `; the top-${limits[0]!.count} limit and ranking are not applied` : ""}`,
      );
      return result("TimeSeriesTable", {});
    }
  }
}

function describe(p: Panel, itemId: string): string {
  const qs = p.requests.flatMap((r) => [...r.formulas.map((f) => f.expr), ...r.queries.map((q) => `${q.refId}: ${q.expr}`)]).filter(Boolean);
  return `Migrated from Datadog ${p.sourceType} (${itemId}).${qs.length ? ` Original: ${qs.join("; ").slice(0, 900)}` : ""}`;
}

function placeholderText(p: Panel, itemId: string, reason: string): string {
  const lines = [`**Not migrated:** Datadog \`${p.sourceType}\` widget${p.title ? ` "${p.title}"` : ""}.`, "", reason, ""];
  const qs = p.requests.flatMap((r) => r.queries.map((q) => q.expr)).filter(Boolean);
  if (qs.length) lines.push("Original queries:", "", ...qs.map((x) => "    " + x), "");
  lines.push(`See the migration report: \`${itemId}\`.`);
  return lines.join("\n");
}
