// T5: IR Dashboard -> Dash0 DashboardDefinition (Perses), plus a per-panel result list for the report (T8).
// Layout (knowledge base D-24): Datadog's ordered grid is 12 columns, Dash0's 24, so x and width double.
// Height has no documented ratio; ROW_SCALE is a heuristic until it's tuned against a Dash0 golden export.
// Groups become titled Grid sections; runs of top-level widgets become untitled sections, in source order.
import { worst, isGroup, type Dashboard, type Finding, type Layout, type Panel, type Status } from "../../ir/index.js";
import { dash0Id, type DashboardDefinition, type GridItem, type GridLayout, type PersesPanel } from "../../targets/dash0/index.js";
import { toPersesPanel, type PanelResult } from "./panels.js";
import { translateRequests, type TranslateExpr, type TranslateOptions } from "./queries.js";

export { translateRequests } from "./queries.js";
export type { TranslateExpr, TranslateOptions, ExprTranslation, PanelQuery, RequestTranslation } from "./queries.js";
export type { PanelResult } from "./panels.js";

export const ROW_SCALE = 3;
const AUTO = { w: 12, h: 6 };

export interface DashboardTranslation {
  dashboard: DashboardDefinition;
  panels: PanelResult[];
  status: Status;
  /** Dashboard-level findings (variables, layout); panel findings are on each PanelResult. */
  findings: Finding[];
}

export function toPerses(d: Dashboard, translate: TranslateExpr): DashboardTranslation {
  const dashItem = `dd-dash-${d.source.id}`;
  const findings: Finding[] = [];

  // Template variables are pinned to their defaults in v1 (D-21): no Perses variable, no filter in PromQL.
  const variables: TranslateOptions["variables"] = {};
  for (const v of d.variables) {
    variables[v.name] = { tag: null };
    const pinnedTo = v.default ?? "*";
    findings.push({
      status: "exact-under",
      code: "variable.pinned",
      message: `template variable $${v.name}${v.tagKey ? ` (tag ${v.tagKey})` : ""} is pinned to '${pinnedTo}'; no Dash0 variable is created`,
      itemKind: "variable",
      itemId: `${dashItem}/var-${v.name}`,
      assumptions: [pinnedTo === "*" ? `$${v.name} is left at '*'` : `viewers accept '*' instead of Datadog's default '${pinnedTo}'`],
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
    const q = p.kind === "markdown" || p.kind === "unsupported" || p.kind === "logs" ? null : translateRequests(p.requests, translate, variables, itemId);
    const r = toPersesPanel(p, itemId, q);
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
      if (children.length) layouts.push(grid(children, item.title ?? null, findings, dashItem));
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

/** One Grid section. Datadog x/width double (12 -> 24); y/height scale by ROW_SCALE; missing layouts auto-flow. */
function grid(items: { key: string; layout: Layout | null }[], title: string | null, findings: Finding[], dashItem: string): GridLayout {
  const placed = items.filter((i) => i.layout);
  const y0 = placed.length ? Math.min(...placed.map((i) => i.layout!.y)) : 0;
  const out: GridItem[] = [];
  let flowY = placed.length ? Math.max(...placed.map((i) => (i.layout!.y - y0 + i.layout!.h) * ROW_SCALE)) : 0;
  let flowX = 0;
  for (const i of items) {
    if (i.layout) {
      let x = i.layout.x * 2;
      let width = Math.max(1, i.layout.w * 2);
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
