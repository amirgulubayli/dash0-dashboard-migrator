// report.json (schema "dd2dash0.report/v1"). Follows Henry's proposal (dash0-team docs/report-schema-proposal.md)
// for the flat per-item fields the review console reads, with CONTRACT-001's Finding and Status.
// One difference from the proposal: findings use CONTRACT-001's {status, code, ...}, not {severity, ...}.
// A placeholder panel gets the report-only status "unsupported".
import type { Finding, Status } from "../ir/index.js";

export type ReportStatus = Status | "unsupported";

export interface ReportCertificate {
  sourceHash: string;
  outputHash: string | null;
  rules: string[];
  status: ReportStatus;
  assumptions: string[];
  epsilon?: string;
  checks: { parses: boolean; importedReadBack?: boolean | null };
}

export interface ReportItem {
  id: string;
  kind: "panel" | "alert";
  title: string;
  widget_type: string;
  /** Dashboard title (panels) or null (alerts). */
  dashboard: string | null;
  /** Title of the containing group, or null. */
  group: string | null;
  /** In the 24-column Dash0 grid; null for alerts. */
  layout: { x: number; y: number; w: number; h: number } | null;
  /** Source file or "api". */
  source: string;
  source_queries: string[];
  source_formula: string[] | null;
  promql: string[];
  status: ReportStatus;
  reason_codes: string[];
  certificate: ReportCertificate;
  findings: Finding[];
  thresholds?: { failed: number; degraded?: number };
  manual_actions?: string[];
  target: { dash0Id: string; kind: "dashboard" | "check-rule"; action: string; readBack: string } | null;
}

export interface Report {
  schema: "dd2dash0.report/v1";
  run: {
    tool: "dd2dash0";
    version: string;
    /** sha256 over every source document (canonical JSON), so a changed input is visible. */
    inputHash: string;
    /** sha256 over `items`. Same input and same tool version give the same hash: the determinism check. */
    outputHash: string;
    options: Record<string, unknown>;
    mappingFiles: string[];
  };
  summary: {
    dashboards: number;
    alerts: number;
    byKind: Record<string, Partial<Record<ReportStatus, number>>>;
    /** (exact + exact-under) / panels with queries or text. Never rounded up. */
    coverageExact: number;
    /** (exact + exact-under + bounded) / same denominator. */
    coverageTranslated: number;
    findingsByCode: Record<string, number>;
    /** written = payloads written to <out>/dash0 in a dry run. */
    import: { mode: "dry-run" | "live" | "none"; written: number; imported: number; failed: number; rejected: number; readBackMatch: number } | null;
  };
  /** Dashboard- and run-level findings (variables, unreadable files, layout). */
  findings: Finding[];
  items: ReportItem[];
}
