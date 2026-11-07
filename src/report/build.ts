// Builds report.json from the pipeline's outputs. Pure: same inputs give byte-identical output (no timestamps).
import { isGroup, type Alert, type Dashboard, type Finding, type Panel } from "../ir/index.js";
import type { DashboardTranslation } from "../translate/dashboard/index.js";
import { canonicalJson, dash0Id, sha256, type GridItem, type Manifest } from "../targets/dash0/index.js";
import { validatePromQL } from "../validate/promql.js";
import type { AlertConversion } from "../pipeline/alerts-interim.js";
import type { Report, ReportItem, ReportStatus } from "./types.js";

export interface BuildInput {
  version: string;
  inputHash: string;
  options: Record<string, unknown>;
  mappingFiles: string[];
  ingestFindings: Finding[];
  dashboards: { source: Dashboard; translation: DashboardTranslation }[];
  alerts: { alert: Alert; conversion: AlertConversion }[];
  manifest: Manifest | null;
  mode: "dry-run" | "live" | "none";
}

const NOTE_TYPES = new Set(["note", "free_text"]);

export function buildReport(b: BuildInput): Report {
  const target = (kind: "dashboard" | "check-rule", id: string): ReportItem["target"] => {
    const r = b.manifest?.results.find((x) => x.kind === kind && x.id === id);
    return r ? { dash0Id: id, kind, action: r.action, readBack: r.readBack.state } : null;
  };
  const items: ReportItem[] = [];
  // Ingest findings about a specific widget (e.g. widget.unsupported) belong on that panel's item.
  const byItem = new Map<string, Finding[]>();
  const findings: Finding[] = [];
  for (const f of b.ingestFindings) {
    if (f.itemKind === "panel" || f.itemKind === "group") (byItem.get(f.itemId) ?? byItem.set(f.itemId, []).get(f.itemId)!).push(f);
    else findings.push(f);
  }
  const readBackCheck = (t: ReportItem["target"]) => (!t || t.readBack === "skipped" ? null : t.readBack === "match");

  for (const { source: d, translation: t } of b.dashboards) {
    findings.push(...t.findings);
    const dashItem = `dd-dash-${d.source.id}`;
    const tgt = target("dashboard", dash0Id(d.source.id));
    // The IR panel and group title behind each itemId, built the same way T5 builds itemIds.
    const ir = new Map<string, { panel: Panel; group: string | null }>();
    for (const it of d.items) {
      if (isGroup(it)) for (const p of it.panels) ir.set(`${dashItem}/${it.id}/${p.id}`, { panel: p, group: it.title ?? null });
      else ir.set(`${dashItem}/${it.id}`, { panel: it, group: null });
    }
    // Panel keys are inserted in the same order as t.panels, so index i matches.
    const keys = Object.keys(t.dashboard.spec.panels);
    const grid = new Map<string, GridItem>();
    for (const l of t.dashboard.spec.layouts) for (const g of l.spec.items) grid.set(g.content.$ref.replace("#/spec/panels/", ""), g);

    t.panels.forEach((r0, i) => {
      const extra = byItem.get(r0.itemId) ?? [];
      byItem.delete(r0.itemId);
      const r = extra.length ? { ...r0, findings: [...extra, ...r0.findings] } : r0;
      const src = ir.get(r.itemId);
      const g = grid.get(keys[i]!);
      const status: ReportStatus = r.placeholder && src?.panel.kind === "unsupported" ? "unsupported" : r.status;
      const manual_actions: string[] = [];
      if (r.placeholder) manual_actions.push(`Rebuild "${r.title}" (Datadog ${r.sourceType}) by hand in Dash0; the placeholder panel holds the original query.`);
      items.push({
        id: r.itemId,
        kind: "panel",
        title: r.title,
        widget_type: r.sourceType,
        dashboard: d.title,
        group: src?.group ?? null,
        layout: g ? { x: g.x, y: g.y, w: g.width, h: g.height } : null,
        source: d.source.origin ?? d.source.id,
        source_queries: src ? src.panel.requests.flatMap((q) => q.queries.map((x) => x.expr)).filter(Boolean) : [],
        source_formula: src && src.panel.requests.some((q) => q.formulas.length) ? src.panel.requests.flatMap((q) => q.formulas.map((f) => f.expr)) : null,
        promql: r.promql,
        status,
        reason_codes: [...new Set(r.findings.map((f) => f.code))],
        certificate: {
          sourceHash: sha256(canonicalJson(src?.panel.original ?? null)),
          outputHash: sha256(canonicalJson(r.panel)),
          rules: r.rules,
          status,
          assumptions: r.assumptions,
          ...epsilonOf(r.findings),
          checks: { parses: r.promql.every((q) => validatePromQL(q).ok), importedReadBack: readBackCheck(tgt) },
        },
        findings: r.findings,
        ...(manual_actions.length ? { manual_actions } : {}),
        target: tgt,
      });
    });
  }

  for (const { alert: a, conversion: c } of [...b.alerts].sort((x, y) => (x.alert.source.id < y.alert.source.id ? -1 : 1))) {
    const tgt = c.rule?.id ? target("check-rule", c.rule.id) : null;
    const manual_actions: string[] = [];
    if (!c.rule) manual_actions.push(`Recreate the monitor "${a.name}" by hand in Dash0 (see findings).`);
    else {
      if (!b.options.enableRules) manual_actions.push("Review and enable the check rule in Dash0 (imported disabled, D-30).");
      const handles = [...new Set(a.message.match(/@[\w.-]+/g) ?? [])];
      if (handles.length) manual_actions.push(`Attach Dash0 notification channels for ${handles.join(", ")}.`);
    }
    items.push({
      id: `dd-monitor-${a.source.id}`,
      kind: "alert",
      title: a.name,
      widget_type: a.type,
      dashboard: null,
      group: null,
      layout: null,
      source: a.source.origin ?? a.source.id,
      source_queries: [a.query],
      source_formula: null,
      promql: c.promql ? [c.promql] : [],
      status: c.status,
      reason_codes: [...new Set(c.findings.map((f) => f.code))],
      certificate: {
        sourceHash: sha256(canonicalJson(a.original)),
        outputHash: c.rule ? sha256(canonicalJson(c.rule)) : null,
        rules: c.rules,
        status: c.status,
        assumptions: c.assumptions,
        ...epsilonOf(c.findings),
        checks: { parses: c.promql ? validatePromQL(c.promql).ok : false, importedReadBack: readBackCheck(tgt) },
      },
      findings: c.findings,
      ...(c.rule?.thresholds ? { thresholds: { failed: c.rule.thresholds.failed!, ...(c.rule.thresholds.degraded !== undefined && { degraded: c.rule.thresholds.degraded }) } } : {}),
      ...(manual_actions.length ? { manual_actions } : {}),
      target: tgt,
    });
  }

  // Findings about widgets that produced no item (none expected) stay visible at run level.
  for (const fs of byItem.values()) findings.push(...fs);

  // Summary
  const byKind: Report["summary"]["byKind"] = {};
  for (const it of items) {
    const k = (byKind[it.kind] ??= {});
    k[it.status] = (k[it.status] ?? 0) + 1;
  }
  const scored = items.filter((i) => i.kind === "panel" && !NOTE_TYPES.has(i.widget_type));
  const count = (ss: ReportStatus[]) => scored.filter((i) => ss.includes(i.status)).length;
  const ratio = (n: number) => (scored.length ? Math.floor((n / scored.length) * 1000) / 1000 : 0); // floor: never round up
  const findingsByCode: Record<string, number> = {};
  for (const f of [...findings, ...items.flatMap((i) => i.findings)]) findingsByCode[f.code] = (findingsByCode[f.code] ?? 0) + 1;
  const m = b.manifest?.summary;

  return {
    schema: "dd2dash0.report/v1",
    run: { tool: "dd2dash0", version: b.version, inputHash: b.inputHash, outputHash: sha256(canonicalJson(items)), options: b.options, mappingFiles: b.mappingFiles },
    summary: {
      dashboards: b.dashboards.length,
      alerts: b.alerts.length,
      byKind,
      coverageExact: ratio(count(["exact", "exact-under"])),
      coverageTranslated: ratio(count(["exact", "exact-under", "bounded"])),
      findingsByCode: Object.fromEntries(Object.entries(findingsByCode).sort(([a], [z]) => (a < z ? -1 : 1))),
      import: m ? { mode: b.mode, written: m["dry-run"], imported: m.imported, failed: m.failed, rejected: m["rejected-preflight"], readBackMatch: m.readBackMatch } : null,
    },
    findings,
    items,
  };
}

function epsilonOf(fs: Finding[]): { epsilon?: string } {
  const e = [...new Set(fs.map((f) => f.epsilon).filter((x): x is string => !!x))];
  return e.length ? { epsilon: e.join("; ") } : {};
}
