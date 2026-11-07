// IR Panel -> Perses panel in Dash0's dialect (only kinds Dash0 renders: docs/research/dash0.md).
// Anything that can't be a faithful panel becomes a Markdown placeholder that shows the original and the reason,
// the same pattern Dash0's own Grafana importer uses.
import { worst, type Finding, type Panel, type Status } from "../../ir/index.js";
import type { PersesPanel } from "../../targets/dash0/index.js";
import type { RequestTranslation } from "./queries.js";
import { conditionalFormatsToThresholds, markersToThresholds } from "./thresholds.js";
import type { LogTableTranslation } from "./logtable.js";

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

export function toPersesPanel(p: Panel, itemId: string, q: RequestTranslation | null, logs?: LogTableTranslation): PanelResult {
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
      assumptions,
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
  const placeholder = (rule: string, reason: string) => {
    rules.push(rule);
    return result("Markdown", { text: placeholderText(p, itemId, reason) }, true);
  };
  /** A rule whose claim is exact-under: cite it, record its assumptions, and report it (catalog axiom D6). */
  const under = (rule: string, assumptionIds: string[], message: string, original?: string) => {
    rules.push(rule);
    for (const a of assumptionIds) if (!assumptions.includes(a)) assumptions.push(a);
    status = worst(status, "exact-under");
    findings.push({ status: "exact-under", code: rule, message, itemKind: "panel", itemId, ruleId: rule, assumptions: assumptionIds.map((a) => ASSUMPTION_TEXT[a] ?? a), ...(original !== undefined ? { original } : {}) });
  };
  const assumptions: string[] = [...(q?.assumptions ?? [])];

  // Rule ids and claims follow the T17 catalog (src/rules/catalog/dashboard.ts, PR #8).
  switch (p.kind) {
    case "markdown":
      under("widget.note", ["A.style"], "note text kept; its colour, font size and alignment are not migrated");
      return result("Markdown", { text: String(p.options.text ?? "") });
    case "unsupported":
      // T2 already emitted the widget.unsupported finding for this panel.
      return placeholder(unsupportedRule(p.sourceType), `Dash0 has no panel for the Datadog '${p.sourceType}' widget.`);
    case "logs":
      // log_stream / list_stream -> LogTable (logs.stream) when the search has an AND-of-filters form.
      if (logs?.spec) {
        status = worst(status, logs.status);
        for (const r of logs.rules) if (!rules.includes(r)) rules.push(r);
        for (const a of logs.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
        findings.push(...logs.findings);
        return result("LogTable", { ...logs.spec });
      }
      if (logs) {
        findings.push(...logs.findings);
        return placeholder("widget.logs", "The log search has no Dash0 LogTable filter form (see the findings).");
      }
      note("manual", "query.datasource", "log widgets need the log-attribute table (mappings/log-attributes.yaml) to become a LogTable", p.requests[0]?.queries[0]?.expr);
      return placeholder("widget.logs", "Log widgets are not migrated without the log-attribute table.");
  }

  // Query-backed panels: with no PromQL at all, show a placeholder instead of an empty chart.
  if (!q || q.queries.length === 0) return placeholder("widget.unknown", "None of its queries could be translated to PromQL (see the findings).");

  const styleLost: string[] = [];
  switch (p.kind) {
    case "timeseries": {
      rules.push("widget.timeseries");
      const types = (p.options.displayTypes as string[] | undefined) ?? [];
      const spec: Record<string, unknown> = {};
      if (types.length && types.every((t) => t === "bars")) spec.visual = { display: "bar" };
      else if (types.some((t) => t === "area" || t === "bars")) styleLost.push(`display types ${[...new Set(types)].join(", ")} drawn as lines`);
      if (p.options.showLegend === true) spec.legend = { position: "bottom" };
      const mk = markersToThresholds(p.options.markers);
      if (mk.thresholds) {
        spec.thresholds = mk.thresholds;
        under("panel.markers", ["A.style"], [`${mk.thresholds.steps.length} marker line(s) -> TimeSeriesChart thresholds`, ...mk.notes].join("; "), JSON.stringify(p.options.markers));
      }
      if (mk.skipped.length) styleLost.push(`marker(s) ${mk.skipped.map((m) => `'${m}'`).join(", ")} not migrated (unrecognised value)`);
      if (styleLost.length) under("panel.style", ["A.style"], styleLost.join("; "));
      return result("TimeSeriesChart", spec);
    }
    case "stat": {
      const agg = p.requests[0]?.queries[0]?.aggregator;
      // A log query in the window form ([$__range], log.scalar.window) already is the whole-timeframe value:
      // the panel shows the value at the end of the range (A.log-range), whatever the Datadog aggregator.
      const logWindow = q.rules.includes("log.scalar.window");
      // last-number is only right for the window form: a stat that also shows a metric query fails closed.
      if (logWindow && !p.requests.every((r) => r.queries.every((x) => x.dataSource === "logs"))) {
        return placeholder("arith.scalar-log-mixed", "This stat panel mixes a whole-timeframe log count with a metric query; one StatChart calculation can't show both as Datadog does.");
      }
      let calculation = logWindow ? "last-number" : agg ? CALC[agg] : undefined;
      if (logWindow) {
        /* rule and assumptions come from T12 with the query */
      } else if (calculation) under("widget.query_value", ["A.align", "A.boundary"], `aggregator ${agg} -> StatChart calculation ${calculation}`);
      else {
        calculation = "mean";
        under("widget.query_value.default-agg", ["A.agg-default"], agg ? `aggregator '${agg}' has no StatChart calculation; mean used` : "no aggregator given; Datadog's avg assumed", agg);
      }
      if (q.queries.length > 1) under("widget.query_value.multi", ["A.stat-first"], `${q.queries.length} queries on one stat panel; Dash0 shows the first`);
      const spec: Record<string, unknown> = { calculation };
      if (typeof p.options.precision === "number") spec.format = { unit: "decimal", decimalPlaces: p.options.precision };
      if (p.options.conditionalFormats) {
        const cf = conditionalFormatsToThresholds(p.options.conditionalFormats);
        if (cf.thresholds) {
          spec.thresholds = cf.thresholds;
          const msg = `${(p.options.conditionalFormats as unknown[]).length} conditional format rule(s) -> StatChart thresholds`;
          under("panel.conditional-format", ["A.style"], [msg, ...cf.notes].join("; "), JSON.stringify(p.options.conditionalFormats));
        } else if (cf.unsupported) under("panel.style", ["A.style"], `conditional colour formats are not migrated (no equivalent for ${cf.unsupported})`, JSON.stringify(p.options.conditionalFormats));
      }
      return result("StatChart", spec);
    }
    case "toplist": {
      const limits = p.requests.flatMap((r) => r.formulas.map((f) => f.limit).filter((x) => x !== undefined));
      under("widget.toplist.unranked", ["A.top-unlimited"], `toplist shown as a TimeSeriesTable of every series${limits.length ? `, without the top-${limits[0]!.count} limit and ranking` : ""}`);
      return result("TimeSeriesTable", {});
    }
    case "table": {
      const queries = p.requests.reduce((n, r) => n + Math.max(r.formulas.length, r.queries.length), 0);
      if (queries > 1 || p.options.conditionalFormats) {
        // Several columns: Datadog joins them per group, a TimeSeriesTable lists series. Catalog: manual.
        return placeholder("widget.query_table.complex", `This query_table has ${queries} columns; Dash0's TimeSeriesTable can't join them per group.`);
      }
      under("widget.query_table", ["A.table-single-query"], "single-query table shown as a TimeSeriesTable");
      return result("TimeSeriesTable", {});
    }
  }
}

/** Catalog rule for a widget type Dash0 has no panel for (all report the T2 finding code widget.unsupported). */
function unsupportedRule(type: string): string {
  if (type === "heatmap" || type === "distribution" || type === "histogram") return "widget.heatmap";
  if (type === "treemap") return "widget.treemap";
  if (type === "scatterplot") return "widget.scatterplot";
  if (KNOWN_UNSUPPORTED.has(type)) return "widget.unsupported";
  return "widget.unknown";
}
const KNOWN_UNSUPPORTED = new Set(["hostmap", "service_map", "manage_status", "check_status", "slo", "trace_service", "geomap", "funnel", "iframe", "event_stream", "event_timeline", "split_graph", "change", "sunburst", "list_stream", "log_stream"]);

/** Assumption wording, from the T17 catalog (src/rules/assumptions.ts). The last three are requested additions. */
const ASSUMPTION_TEXT: Record<string, string> = {
  "A.style": "fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning",
  "A.align": "PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2)",
  "A.boundary": "no sample lies exactly on a bucket boundary (maths.md T8, A3)",
  "A.table-single-query": "the table has one query, default sorting and no conditional formats",
  "A.top-unlimited": "showing every series, unranked and without the top-N limit, is acceptable until fn.top.window ships",
  "A.agg-default": "a query_value request without an aggregator uses Datadog's default, avg",
  "A.stat-first": "only the first query of a multi-query stat panel matters",
};

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
