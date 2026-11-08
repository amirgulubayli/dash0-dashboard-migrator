// "What needs my attention?": a deterministic checklist. Membership, counts, ids and order come from the report only.
import type { ItemView, ReportView } from "./model";

export interface BriefEntry {
  id: string;
  title: string;
  label: string | null;
  reasonCodes: string[];
  condition: string | null;
}

export interface ConditionGroup {
  condition: string;
  ids: string[];
}

export interface MonitorIssue {
  id: string;
  title: string;
  label: string | null;
  checkRuleState: string | null;
  notes: string[];
}

export interface Brief {
  manualOrUnsupported: BriefEntry[];
  bounded: BriefEntry[];
  conditions: ConditionGroup[];
  textNotesExcluded: number;
  monitorIssues: MonitorIssue[];
  total: number;
}

function entry(i: ItemView): BriefEntry {
  return { id: i.id, title: i.title, label: i.label, reasonCodes: i.reasons.map((r) => r.code), condition: i.condition };
}

export function buildBrief(view: ReportView): Brief {
  const real = view.widgets.filter((w) => !w.isTextNote);
  const manualOrUnsupported = real.filter((w) => w.label === "manual" || w.label === "unsupported").map(entry);
  const bounded = real.filter((w) => w.label === "bounded").map(entry);
  const byCondition = new Map<string, string[]>();
  for (const w of real) {
    if (w.label !== "exact-under") continue;
    const c = w.condition ?? "(condition not recorded)";
    byCondition.set(c, [...(byCondition.get(c) ?? []), w.id]);
  }
  const conditions = [...byCondition.entries()].map(([condition, ids]) => ({ condition, ids }));
  const monitorIssues: MonitorIssue[] = view.monitors.map((m) => ({
    id: m.id,
    title: m.title,
    label: m.label,
    checkRuleState: m.checkRuleState ? m.checkRuleState.text : null,
    notes: [...m.manualActions, ...(m.condition ? [m.condition] : [])],
  }));
  return {
    manualOrUnsupported, bounded, conditions,
    textNotesExcluded: view.widgets.length - real.length,
    monitorIssues,
    total: manualOrUnsupported.length + bounded.length + conditions.length + monitorIssues.length,
  };
}
