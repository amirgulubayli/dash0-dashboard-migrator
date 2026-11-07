// T6 types. Rules come from the catalog (src/rules, T17); every applied rule id is a catalog id.
import type { Finding, Status } from "../../ir/index.js";
import type { MonitorQuery } from "../../parse/index.js";

/**
 * Body of a Dash0 check rule. Structurally a subset of T7's PrometheusAlertRule (src/targets/dash0/schema.ts, PR #5).
 * It has no `id`: Dash0 rejects a body that carries one (400, docs/research/dash0.md "Idempotent imports").
 * The rule is addressed by its origin instead (AlertTranslation.origin): PUT /api/alerting/check-rules/{origin} upserts.
 */
export interface CheckRule {
  name: string;
  expression: string;
  thresholds?: { degraded?: number; failed?: number };
  interval?: string;
  for?: string;
  keep_firing_for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  enabled?: boolean;
}

/** A finding as T4 emits it today (plan 00 shape) or after its move to CONTRACT-001. */
export interface UpstreamFinding {
  code: string;
  message: string;
  severity?: string;
  status?: string;
  ruleId?: string;
  original?: unknown;
}

/** What T6 needs from T4's translateMonitor (src/translate/query, PR #3). */
export interface MonitorTranslationLike {
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: UpstreamFinding[];
  thresholds: { failed?: number; degraded?: number } | null;
  negated: boolean;
}

export type MonitorTranslator = (mq: MonitorQuery, thresholds: { critical?: number; warning?: number }) => MonitorTranslationLike;

export interface AlertDeps {
  /** T4's translateMonitor with the translate context already bound: (mq, t) => translateMonitor(mq, t, ctx). */
  translateMonitor: MonitorTranslator;
  /** Datadog tag key -> PromQL label (T1's tagLookup). Unmapped keys are sanitised. */
  tag?: (ddTag: string) => string | undefined;
  /** Emit a rule even when the item is manual, imported disabled for review (kb 06 §8 override). Default false. */
  keepManual?: boolean;
}

export interface AlertTranslation {
  /** "dd-monitor-<id>": the report item id. */
  itemId: string;
  /** Dash0 origin of the check rule ("dd-monitor-<id>", same as itemId). T7 imports with PUT /api/alerting/check-rules/{origin}, so re-runs overwrite. */
  origin: string;
  status: Status;
  /** null when the monitor is manual (unless keepManual). Canonical key order, labels sorted. */
  rule: CheckRule | null;
  /** Catalog rule ids in order of application. */
  rules: string[];
  /** Catalog assumption ids. */
  assumptions: string[];
  epsilon: string[];
  findings: Finding[];
  /** Notification handles removed from the message (@slack-…), to recreate in Dash0 by hand. */
  channels: string[];
}
