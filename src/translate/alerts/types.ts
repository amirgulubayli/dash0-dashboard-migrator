// T6 types. Rules come from the catalog (src/rules, T17); every applied rule id is a catalog id.
import type { Finding, Status } from "../../ir/index.js";
import type { MonitorQuery } from "../../parse/index.js";

/**
 * Body of POST /api/import/check-rule. Structurally identical to T7's PrometheusAlertRule
 * (src/targets/dash0/schema.ts, PR #5); switch to that import once PR #5 merges.
 */
export interface CheckRule {
  id?: string;
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
  /** "dd-monitor-<id>": the check rule id and the report item id. */
  itemId: string;
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
