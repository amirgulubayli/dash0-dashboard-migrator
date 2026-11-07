// INTERIM monitor -> Dash0 check rule, so the pipeline runs end to end before T6 (Michael, src/translate/alerts)
// lands. It covers only what plan 04 §2 calls the vertical slice: the type gate, T4's translateMonitor (window,
// comparator, $__threshold with failed/degraded) and an explicit report of every other option. T6 replaces it
// through the `AlertConverter` hook in migrate.ts; nothing else depends on this file.
import { parseMonitorQuery, formatParseError } from "../parse/index.js";
import { translateMonitor, type TranslateContext } from "../translate/query/index.js";
import { worst, type Alert, type Finding, type Status } from "../ir/index.js";
import { dash0Id, type PrometheusAlertRule } from "../targets/dash0/index.js";

export interface AlertConversion {
  rule: PrometheusAlertRule | null;
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
}

export type AlertConverter = (a: Alert, ctx: TranslateContext) => AlertConversion;

const METRIC_TYPES = new Set(["query alert", "metric alert"]);
/** Options that change behaviour and have no check-rule field. Benign ones (include_tags, locked, ...) are skipped. */
const REPORTED: Record<string, (v: unknown) => boolean> = {
  require_full_window: (v) => v === true,
  new_host_delay: (v) => typeof v === "number" && v > 0,
  new_group_delay: (v) => typeof v === "number" && v > 0,
  evaluation_delay: (v) => typeof v === "number" && v > 0,
  notify_no_data: (v) => v === true,
  renotify_interval: (v) => typeof v === "number" && v > 0,
  timeout_h: (v) => typeof v === "number" && v > 0,
  escalation_message: (v) => typeof v === "string" && v.length > 0,
  threshold_windows: (v) => v !== null && v !== undefined,
  on_missing_data: (v) => typeof v === "string" && v !== "default",
};

export const interimAlertConverter: AlertConverter = (a, ctx) => {
  const itemId = `dd-monitor-${a.source.id}`;
  const findings: Finding[] = [];
  const out = (rule: PrometheusAlertRule | null, status: Status, extra: Partial<AlertConversion> = {}): AlertConversion => ({
    rule,
    status,
    promql: null,
    rules: [],
    assumptions: [],
    findings,
    ...extra,
  });
  const manual = (code: string, message: string, original?: string) => {
    findings.push({ status: "manual", code, message, itemKind: "alert", itemId, ...(original !== undefined ? { original } : {}) });
    return out(null, "manual");
  };

  if (!METRIC_TYPES.has(a.type)) return manual("monitor.type", `'${a.type}' monitors are not metric alerts; not migrated`, a.type);
  const p = parseMonitorQuery(a.query);
  if (!p.ok) return manual("query.parse_error", `monitor query does not parse: ${formatParseError(p.error)}`, a.query);
  const t = translateMonitor(p.value, { ...(a.thresholds.critical !== undefined && { critical: a.thresholds.critical }), ...(a.thresholds.warning !== undefined && { warning: a.thresholds.warning }) }, { ...ctx, where: itemId });
  findings.push(...t.findings);
  if (!t.promql || !t.thresholds) return out(null, "manual", { rules: t.rules });

  let status = t.status;
  const report = (code: string, message: string, original: string) => {
    status = worst(status, "bounded");
    findings.push({ status: "bounded", code, message, itemKind: "alert", itemId, original });
  };
  for (const [k, v] of Object.entries(a.options)) {
    if (REPORTED[k]?.(v)) report(`monitor.option.${k}`, `Datadog option ${k} has no Dash0 check-rule equivalent; not applied`, `${k}: ${JSON.stringify(v)}`);
  }
  if (a.thresholds.criticalRecovery !== undefined || a.thresholds.warningRecovery !== undefined) {
    report("monitor.option.recovery", "recovery thresholds (hysteresis) are not supported by check rules", JSON.stringify({ critical_recovery: a.thresholds.criticalRecovery, warning_recovery: a.thresholds.warningRecovery }));
  }
  if (/\{\{/.test(a.message)) report("monitor.message.template", "Datadog message template variables ({{...}}) are kept as text, not converted", a.message.slice(0, 200));

  const labels: Record<string, string> = {};
  for (const tag of a.tags) {
    const [k, ...rest] = tag.split(":");
    const key = (k ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]/, "_$&");
    if (key) labels[key] = rest.length ? rest.join(":") : "true";
  }
  const rule: PrometheusAlertRule = {
    id: dash0Id(a.source.id),
    name: a.name,
    expression: t.promql,
    thresholds: t.thresholds,
    interval: "1m",
    for: "0s",
    labels,
    annotations: {
      summary: a.name,
      description: (t.negated ? "[value shown negated: '<' monitor] " : "") + a.message.slice(0, 1800),
      "dd2dash0/source": `datadog monitor ${a.source.id}`,
    },
  };
  return out(rule, status, { promql: t.promql, rules: [...t.rules, "monitor.interim"], assumptions: t.assumptions });
};
