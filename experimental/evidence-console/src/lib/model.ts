// Turns a loaded report.json into a view model. Everything shown on screen is computed here from the report;
// nothing is hard-coded and nothing is inferred (no equivalence from query text, no live data from an import).

export const NOT_RECORDED = "Not recorded";
export const NOT_CHECKED = "Not checked";
export const NO_PROMQL = "No PromQL generated";

export type Label = "exact" | "exact-under" | "bounded" | "manual" | "unsupported";
export const STANDARD_LABELS: Label[] = ["exact-under", "bounded", "manual", "unsupported"];

/** Display text for the report's own labels. exact-under is shown as "EXACT IF" (the claim holds if its conditions hold). */
export function labelText(label: string | null): string {
  if (!label) return "NO LABEL";
  if (label === "exact-under") return "EXACT IF";
  return label.toUpperCase();
}

export interface Reason {
  code: string;
  explanation: string | null;
}

export interface EvidenceField {
  recorded: boolean;
  text: string;
}

export interface ItemView {
  id: string;
  title: string;
  kind: "panel" | "group" | "alert" | "other";
  label: string | null; // the report's own label, verbatim; null when absent or not a string
  widgetType: string | null;
  isTextNote: boolean;
  group: string | null;
  dashboard: string | null;
  sourceQueries: string[];
  promql: string[];
  condition: string | null;
  plain: string | null;
  technical: string | null;
  assumptions: string[];
  reasons: Reason[];
  decisionRequired: boolean | null;
  manualActions: string[];
  /** Three distinct pieces of evidence, never derived from one another. */
  importStatus: EvidenceField;
  liveData: EvidenceField;
  parity: EvidenceField;
  dash0Link: string | null;
  checkRuleState: EvidenceField | null; // alerts only
  malformed: string[]; // names of fields that were present but not the expected type
}

export interface ReportView {
  ok: true;
  schema: string | null;
  dashboardNames: string[];
  runMode: string | null;
  enableRules: boolean | null;
  widgets: ItemView[]; // kind panel, in report order
  groups: ItemView[];
  monitors: ItemView[];
  others: ItemView[];
  widgetCount: number;
  labelCounts: { label: string; count: number; textNotes: number }[];
  textNoteCount: number;
  monitorLabelCounts: { label: string; count: number }[];
  defaultSelectionId: string | null;
}

export interface ReportError {
  ok: false;
  error: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strArray(v: unknown, field: string, malformed: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    malformed.push(field);
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") out.push(x);
    else malformed.push(field);
  }
  return out;
}

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A recorded value may be a plain string or an object with a `status`/`result`/`state` string. Anything else is "not recorded". */
function recordedText(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (isObj(v)) {
    for (const k of ["status", "result", "state", "verdict", "live"]) {
      const x = v[k];
      if (typeof x === "string" && x.length > 0) return x;
    }
  }
  return null;
}

function importField(item: Record<string, unknown>, runMode: string | null): EvidenceField {
  const t = item.target;
  if (!isObj(t)) return { recorded: false, text: NOT_RECORDED };
  const action = typeof t.action === "string" ? t.action : null;
  const readBack = typeof t.readBack === "string" ? t.readBack : null;
  if (!action && !readBack) return { recorded: false, text: NOT_RECORDED };
  const parts: string[] = [];
  if (action === "dry-run" || runMode === "dry-run") parts.push("Not imported: this was a dry run");
  else if (action) parts.push(`Import action: ${action}`);
  parts.push(readBack ? `read-back: ${readBack}` : `read-back: ${NOT_RECORDED.toLowerCase()}`);
  return { recorded: true, text: parts.join("; ") };
}

function checkRuleState(kind: ItemView["kind"], enableRules: boolean | null, imp: EvidenceField): EvidenceField | null {
  if (kind !== "alert") return null;
  if (enableRules === null) return { recorded: false, text: NOT_RECORDED };
  const base = enableRules ? "Enabled" : "Disabled";
  return { recorded: true, text: `${base} (enable-rules option ${enableRules ? "on" : "off"}${imp.text.startsWith("Not imported") ? "; not imported yet" : ""})` };
}

function normalizeKind(v: unknown): ItemView["kind"] {
  return v === "panel" || v === "group" || v === "alert" ? v : "other";
}

export function normalizeItem(raw: unknown, index: number, reasonCodes: Record<string, unknown>, runMode: string | null, enableRules: boolean | null): ItemView {
  const o: Record<string, unknown> = isObj(raw) ? raw : {};
  const malformed: string[] = [];
  const kind = normalizeKind(o.kind);
  const id = strOrNull(o.id) ?? `(item ${index + 1}, no id)`;
  const label = typeof o.status === "string" && o.status.length > 0 ? o.status : null;
  if (o.status !== undefined && o.status !== null && label === null) malformed.push("status");

  const codes = strArray(o.reason_codes, "reason_codes", malformed);
  const reasons: Reason[] = codes.map((code) => {
    const rc = reasonCodes[code];
    const explanation = isObj(rc) ? (strOrNull(rc.plain) ?? strOrNull(rc.explanation)) : null;
    return { code, explanation };
  });

  const explain = isObj(o.explain) ? o.explain : null;
  const cert = isObj(o.certificate) ? o.certificate : null;
  const widgetType = strOrNull(o.widget_type);
  const imp = importField(o, runMode);

  const live = recordedText(o.live) ?? recordedText(o.liveData) ?? recordedText(o.verify);
  const parity = recordedText(o.parity);
  const target = isObj(o.target) ? o.target : {};
  const dash0 = isObj(o.dash0) ? o.dash0 : {};
  const link = httpUrl(o.dash0Url) ?? httpUrl(dash0.url) ?? httpUrl(target.url);

  return {
    id,
    title: strOrNull(o.title) ?? id,
    kind,
    label,
    widgetType,
    isTextNote: kind === "panel" && widgetType === "note",
    group: strOrNull(o.group),
    dashboard: strOrNull(o.dashboard),
    sourceQueries: strArray(o.source_queries, "source_queries", malformed),
    promql: strArray(o.promql, "promql", malformed),
    condition: strOrNull(o.condition),
    plain: explain ? strOrNull(explain.plain) : null,
    technical: explain ? strOrNull(explain.technical) : null,
    assumptions: cert ? strArray(cert.assumptions, "certificate.assumptions", malformed) : [],
    reasons,
    decisionRequired: typeof o.decision_required === "boolean" ? o.decision_required : null,
    manualActions: strArray(o.manual_actions, "manual_actions", malformed),
    importStatus: imp,
    liveData: live ? { recorded: true, text: live } : { recorded: false, text: NOT_CHECKED },
    parity: parity ? { recorded: true, text: parity } : { recorded: false, text: NOT_CHECKED },
    dash0Link: link,
    checkRuleState: checkRuleState(kind, enableRules, imp),
    malformed,
  };
}

export function countLabels(items: ItemView[]): { label: string; count: number; textNotes: number }[] {
  const m = new Map<string, { count: number; textNotes: number }>();
  for (const l of STANDARD_LABELS) m.set(l, { count: 0, textNotes: 0 });
  for (const it of items) {
    const key = it.label ?? "(no label)";
    const e = m.get(key) ?? { count: 0, textNotes: 0 };
    e.count += 1;
    if (it.isTextNote) e.textNotes += 1;
    m.set(key, e);
  }
  return [...m.entries()].map(([label, v]) => ({ label, ...v }));
}

export function chooseDefault(widgets: ItemView[], all: ItemView[]): string | null {
  const pick = (label: string) => widgets.find((w) => w.label === label && !w.isTextNote) ?? widgets.find((w) => w.label === label);
  return (pick("bounded") ?? pick("manual") ?? widgets[0] ?? all[0])?.id ?? null;
}

export function buildReportView(report: unknown): ReportView | ReportError {
  if (!isObj(report)) return { ok: false, error: "report.json is not a JSON object" };
  if (!Array.isArray(report.items)) return { ok: false, error: "report.json has no items array" };
  const run = isObj(report.run) ? report.run : {};
  const options = isObj(run.options) ? run.options : {};
  const runMode = strOrNull(options.mode);
  const enableRules = typeof options.enableRules === "boolean" ? options.enableRules : null;
  const reasonCodes = isObj(report.reasonCodes) ? report.reasonCodes : {};
  const items = report.items.map((r, i) => normalizeItem(r, i, reasonCodes, runMode, enableRules));
  const widgets = items.filter((i) => i.kind === "panel");
  const monitors = items.filter((i) => i.kind === "alert");
  const groups = items.filter((i) => i.kind === "group");
  const others = items.filter((i) => i.kind === "other");
  const names: string[] = [];
  for (const w of [...widgets, ...monitors]) if (w.dashboard && !names.includes(w.dashboard)) names.push(w.dashboard);
  const summary = isObj(report.summary) ? report.summary : {};
  void summary;
  return {
    ok: true,
    schema: strOrNull(report.schema),
    dashboardNames: names,
    runMode,
    enableRules,
    widgets,
    groups,
    monitors,
    others,
    widgetCount: widgets.length,
    labelCounts: countLabels(widgets),
    textNoteCount: widgets.filter((w) => w.isTextNote).length,
    monitorLabelCounts: countLabels(monitors).map(({ label, count }) => ({ label, count })),
    defaultSelectionId: chooseDefault(widgets, items),
  };
}

export function findItem(view: ReportView, id: string | null): ItemView | null {
  if (!id) return null;
  return [...view.widgets, ...view.monitors, ...view.groups, ...view.others].find((i) => i.id === id) ?? null;
}
