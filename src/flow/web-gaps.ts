// The recursive workflow made visible (plan 10's loop: measure, decompose, next round): after Translate, every item
// that is not exact is grouped by reason code, counted, and given the lever that would move it and the owner area.
//
// Read from report.json only (the plan's, then the run's): nothing from tools/, nothing recomputed, nothing
// translated. The reason -> lever table below is small and explicit on purpose; an unknown code falls back to
// "new rule" in the translate area, which is the honest default (someone has to write and test a rule).
import type { RunReportJson } from "./web-timeline.js";

export type Lever = "mapping row" | "new rule" | "probe" | "Dash0 panel type missing" | "impossible";

export interface LeverRule {
  /** A reason code, or a prefix ending in "." (longest match wins). */
  match: string;
  lever: Lever;
  owner: string;
}

export const LEVERS: LeverRule[] = [
  // A row in a mapping table closes it (Datadog metric or tag -> OTel name).
  { match: "metric.unmapped", lever: "mapping row", owner: "mappings" },
  { match: "select.metric.unmapped", lever: "mapping row", owner: "mappings" },
  { match: "tag.unmapped", lever: "mapping row", owner: "mappings" },
  { match: "metric.needs_transform", lever: "mapping row", owner: "mappings" },
  { match: "select.metric.transform", lever: "mapping row", owner: "mappings" },
  { match: "label.default", lever: "mapping row", owner: "mappings" },
  // Only a measurement settles it: does Dash0 have an equivalent series at all?
  { match: "metric.no_equivalent", lever: "probe", owner: "verify" },
  { match: "metric.approximate", lever: "probe", owner: "verify" },
  { match: "select.metric.approximate", lever: "probe", owner: "verify" },
  // Dash0 (Perses) has no panel or panel feature for it.
  { match: "widget.", lever: "Dash0 panel type missing", owner: "dashboard panels" },
  { match: "panel.", lever: "Dash0 panel type missing", owner: "dashboard panels" },
  { match: "logs.stream", lever: "Dash0 panel type missing", owner: "dashboard panels" },
  // No deterministic PromQL equivalent exists.
  { match: "fn.anomalies", lever: "impossible", owner: "manual rebuild" },
  { match: "fn.forecast", lever: "impossible", owner: "manual rebuild" },
  { match: "fn.outliers", lever: "impossible", owner: "manual rebuild" },
  { match: "query.datasource", lever: "impossible", owner: "manual rebuild" },
  // A translation rule (with its claim and tests) would close it.
  { match: "metric.", lever: "new rule", owner: "translate" },
  { match: "fn.", lever: "new rule", owner: "translate" },
  { match: "time.", lever: "new rule", owner: "translate" },
  { match: "scope.", lever: "new rule", owner: "translate" },
  { match: "log.", lever: "new rule", owner: "logs" },
  { match: "monitor.", lever: "new rule", owner: "monitors" },
  { match: "alert.", lever: "new rule", owner: "monitors" },
  { match: "query.", lever: "new rule", owner: "parser" },
  { match: "promql.", lever: "new rule", owner: "parser" },
];

export function leverOf(code: string): { lever: Lever; owner: string } {
  let best: LeverRule | null = null;
  for (const r of LEVERS) {
    const hit = r.match.endsWith(".") ? code.startsWith(r.match) : code === r.match || code.startsWith(r.match + ".");
    if (hit && (!best || r.match.length > best.match.length)) best = r;
  }
  return best ? { lever: best.lever, owner: best.owner } : { lever: "new rule", owner: "translate" };
}

export interface Gap {
  code: string;
  /** Items below EXACT IF that carry this reason code. One item with two codes counts in both groups. */
  count: number;
  byLabel: Record<string, number>;
  lever: Lever;
  owner: string;
  /** Up to three item titles, for the voice and tooltips. */
  examples: string[];
}

export interface Gaps {
  /** Items below EXACT IF: bounded, manual or unsupported (the gap set, plan 10). */
  notExact: number;
  total: number;
  groups: Gap[];
  /** Per lever: how many reason groups and items it touches. */
  levers: { lever: Lever; groups: number; items: number }[];
}

/** Group the items of a report.json (run: items[].reasons; plan: items[].reason_codes) by reason code. */
export function gapsOf(report: RunReportJson): Gaps {
  const items = (report.items ?? []).filter((i) => i.kind === "panel" || i.kind === "alert");
  const map = new Map<string, Gap>();
  const leverItems = new Map<Lever, Set<string>>();
  let notExact = 0;
  for (const it of items) {
    // Plan 10: the gap set is what sits below EXACT IF (exact and exact-under are not gaps).
    if (it.status === "exact" || it.status === "exact-under") continue;
    notExact++;
    const codes = [...new Set(it.reasons ?? it.reason_codes ?? [])];
    if (!codes.length) codes.push("reason.not_recorded");
    for (const code of codes) {
      let g = map.get(code);
      if (!g) map.set(code, (g = { code, count: 0, byLabel: {}, ...leverOf(code), examples: [] }));
      g.count++;
      g.byLabel[it.status] = (g.byLabel[it.status] ?? 0) + 1;
      if (g.examples.length < 3 && it.title) g.examples.push(it.title);
      if (!leverItems.has(g.lever)) leverItems.set(g.lever, new Set());
      leverItems.get(g.lever)!.add(it.id);
    }
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const levers = [...leverItems.entries()]
    .map(([lever, ids]) => ({ lever, groups: groups.filter((g) => g.lever === lever).length, items: ids.size }))
    .sort((a, b) => b.items - a.items);
  return { notExact, total: items.length, groups, levers };
}
