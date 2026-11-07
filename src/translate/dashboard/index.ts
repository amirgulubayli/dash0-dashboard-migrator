// T5: IR Dashboard -> Dash0 DashboardDefinition (Perses), plus a per-panel result list for the report (T8).
// Layout (knowledge base D-24): Datadog's ordered grid is 12 columns, Dash0's 24, so x and width double.
// A group's children are laid out inside the group's own width (a 6-wide group has children spanning 0..6), and
// Datadog puts groups side by side. A Perses Grid section is always full width, so children scale by 24 / group
// width to fill it (catalog layout.group.scale).
// Height has no documented ratio; ROW_SCALE is a heuristic until it's tuned against a Dash0 golden export.
// Groups become titled Grid sections; runs of top-level widgets become untitled sections, in source order.
import { worst, isGroup, type Dashboard, type Finding, type Layout, type Panel, type Status } from "../../ir/index.js";
import { dash0Id, type DashboardDefinition, type GridItem, type GridLayout, type PersesPanel } from "../../targets/dash0/index.js";
import { toPersesPanel, type PanelResult } from "./panels.js";
import { translateLogStream } from "./logtable.js";
import type { LogAttributes } from "../logs/index.js";
import { translateRequests, type TranslateExpr, type TranslateLog, type TranslateOptions } from "./queries.js";

export { translateRequests } from "./queries.js";
export type { TranslateExpr, TranslateLog, TranslateOptions, ExprTranslation, PanelQuery, RequestTranslation } from "./queries.js";
export type { PanelResult } from "./panels.js";
export { translateLogStream } from "./logtable.js";
export type { AttributeFilter, LogTableSpec, LogTableTranslation } from "./logtable.js";

export const ROW_SCALE = 3;

/** Scalar widgets whose log queries have no verified window form yet: Dash0's TimeSeriesTable display of a
 *  [$__range] query is unprobed. Stat panels use the window form (log.scalar.window + calculation last-number,
 *  probe:range-var). */
const SCALAR_PENDING_KINDS = new Set<string>(["toplist", "table"]);

/** A log query in a toplist/table widget: manual, with the reason, until the TimeSeriesTable display is probed. */
const scalarLogPending: TranslateLog = (q, t) => ({
  status: "manual",
  promql: null,
  rules: [],
  assumptions: [],
  findings: [
    {
      status: "manual",
      code: "query.datasource",
      message: "log query in a toplist/table widget: Datadog evaluates it over the whole timeframe; the per-interval form would show a per-bucket value, and how a TimeSeriesTable shows the window form ([$__range]) is not probed yet",
      itemKind: "query",
      itemId: t.where,
      ...(q.search?.query !== undefined && { original: q.search.query }),
    },
  ],
  node: null,
  groups: null,
});
const AUTO = { w: 12, h: 6 };

export interface DashboardTranslation {
  dashboard: DashboardDefinition;
  panels: PanelResult[];
  status: Status;
  /** Dashboard-level findings (variables, layout); panel findings are on each PanelResult. */
  findings: Finding[];
}

/**
 * `translateLog` (T12) is optional: without it, log queries fail closed as before. `logAttributes`
 * (mappings/log-attributes.yaml) turns log streams into LogTable panels; without it they stay placeholders.
 */
export function toPerses(d: Dashboard, translate: TranslateExpr, translateLog?: TranslateLog, logAttributes?: LogAttributes): DashboardTranslation {
  const dashItem = `dd-dash-${d.source.id}`;
  const findings: Finding[] = [];

  // Template variables are pinned to their defaults in v1 (D-21): no Perses variable, no filter in PromQL.
  const variables: TranslateOptions["variables"] = {};
  for (const v of d.variables) {
    variables[v.name] = { tag: null };
    const pinnedTo = v.default ?? "*";
    // Catalog (T17): variable.pinned is exact-under A.var-default when the default is '*'. A different default
    // would need variable.default.value (a fixed matcher), which isn't implemented, so it falls back to
    // variable.unknown (manual; the finding code stays variable.pinned).
    const star = pinnedTo === "*";
    findings.push({
      status: star ? "exact-under" : "manual",
      code: "variable.pinned",
      ruleId: star ? "variable.pinned" : "variable.unknown",
      message: `template variable $${v.name}${v.tagKey ? ` (tag ${v.tagKey})` : ""} is pinned to '*'; no Dash0 variable is created${star ? "" : ` (Datadog's default was '${pinnedTo}')`}`,
      itemKind: "variable",
      itemId: `${dashItem}/var-${v.name}`,
      ...(star ? { assumptions: ["a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing"] } : { original: `$${v.name} default ${pinnedTo}` }),
    });
  }

  const panels: Record<string, PersesPanel> = {};
  const results: PanelResult[] = [];
  const layouts: GridLayout[] = [];
  const used = new Set<string>();
  const key = (id: string) => {
    let k = id.replace(/[^A-Za-z0-9_-]/g, "_");
    for (let n = 2; used.has(k); n++) k = `${id}_${n}`;
    used.add(k);
    return k;
  };
  const convert = (p: Panel, itemId: string): { key: string; layout: Layout | null } => {
    // Scalar widgets evaluate a log query over the whole timeframe in Datadog; T12's per-interval
    // increase(...[$__interval]) would show a per-bucket value (Ali's review of #19). Stat panels get T12's
    // window form ([$__range], log.scalar.window) and calculation last-number; toplist/table fail closed
    // until the TimeSeriesTable display of a [$__range] query is probed.
    const logFor: TranslateLog | undefined = !translateLog
      ? undefined
      : p.kind === "stat"
        ? (lq, t) => translateLog(lq, { ...t, scalar: true })
        : SCALAR_PENDING_KINDS.has(p.kind)
          ? scalarLogPending
          : translateLog;
    const q = p.kind === "markdown" || p.kind === "unsupported" || p.kind === "logs" ? null : translateRequests(p.requests, translate, variables, itemId, logFor);
    const logs = p.kind === "logs" && logAttributes ? translateLogStream(p, logAttributes, variables, itemId) : undefined;
    const r = toPersesPanel(p, itemId, q, logs);
    const k = key(p.id);
    panels[k] = r.panel;
    results.push(r);
    return { key: k, layout: p.layout };
  };

  let run: { key: string; layout: Layout | null }[] = [];
  const flush = () => {
    if (run.length) layouts.push(grid(run, null, findings, dashItem));
    run = [];
  };
  for (const item of d.items) {
    if (isGroup(item)) {
      flush();
      const children = item.panels.map((p) => convert(p, `${dashItem}/${item.id}/${p.id}`));
      if (children.length) layouts.push(grid(children, item.title ?? null, findings, dashItem, groupColumns(item.layout?.w, item.panels)));
    } else run.push(convert(item, `${dashItem}/${item.id}`));
  }
  flush();

  const status = results.reduce<Status>((s, r) => worst(s, r.status), worst("exact", ...findings.map((f) => f.status)));
  return {
    dashboard: {
      kind: "Dashboard",
      metadata: { name: d.title, dash0Extensions: { id: dash0Id(d.source.id), tags: ["dd2dash0"] } },
      spec: {
        display: { name: d.title, ...(d.description ? { description: d.description.slice(0, 2000) } : {}) },
        duration: "1h",
        variables: [],
        panels,
        layouts,
      },
    },
    panels: results,
    status,
    findings,
  };
}

/**
 * The width the children of a group are laid out in: the group's own width. A group with no layout, or children
 * reaching past it (old exports), uses the widest child edge instead, never less than 1 and never more than 12.
 */
export function groupColumns(groupWidth: number | undefined, children: Panel[]): number {
  const edge = Math.max(0, ...children.map((c) => (c.layout ? c.layout.x + c.layout.w : 0)));
  const w = groupWidth && groupWidth > 0 ? Math.max(groupWidth, edge) : edge || 12;
  return Math.min(12, Math.max(1, w));
}

/**
 * One Grid section. `cols` is the width of the Datadog grid the items are laid out in (12 at top level, the group's
 * width inside a group); x and width scale by 24 / cols. Edges are rounded, not widths, so neighbours stay adjacent
 * when 24 / cols isn't a whole number. y/height scale by ROW_SCALE; missing layouts auto-flow.
 */
function grid(items: { key: string; layout: Layout | null }[], title: string | null, findings: Finding[], dashItem: string, cols = 12): GridLayout {
  const placed = items.filter((i) => i.layout);
  const y0 = placed.length ? Math.min(...placed.map((i) => i.layout!.y)) : 0;
  const out: GridItem[] = [];
  let flowY = placed.length ? Math.max(...placed.map((i) => (i.layout!.y - y0 + i.layout!.h) * ROW_SCALE)) : 0;
  let flowX = 0;
  for (const i of items) {
    if (i.layout) {
      const f = 24 / cols;
      let x = Math.round(i.layout.x * f);
      let width = Math.max(1, Math.round((i.layout.x + i.layout.w) * f) - x);
      if (x + width > 24) {
        findings.push({ status: "bounded", code: "layout.clamped", message: `panel ${i.key} overflowed the 24-column grid and was clamped`, itemKind: "panel", itemId: dashItem });
        x = Math.min(x, 23);
        width = 24 - x;
      }
      out.push({ x, y: (i.layout.y - y0) * ROW_SCALE, width, height: Math.max(1, i.layout.h * ROW_SCALE), content: { $ref: `#/spec/panels/${i.key}` } });
    } else {
      if (flowX + AUTO.w > 24) {
        flowX = 0;
        flowY += AUTO.h;
      }
      out.push({ x: flowX, y: flowY, width: AUTO.w, height: AUTO.h, content: { $ref: `#/spec/panels/${i.key}` } });
      flowX += AUTO.w;
    }
  }
  return { kind: "Grid", spec: { ...(title ? { display: { title, collapse: { open: true } } } : {}), items: out } };
}
