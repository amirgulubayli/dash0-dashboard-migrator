// The whole run: ingest -> translate (T4) -> dashboards (T5) / alerts (T6, interim) -> import (T7) -> report (T8).
// Pure up to the import step; the only network I/O is ingest --api and the Dash0 import.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ingestDatadog, type IngestOptions } from "../sources/datadog/index.js";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../ir/index.js";
import { translateQuery, type TranslateContext } from "../translate/query/index.js";
import { toPerses, type DashboardTranslation, type TranslateExpr, type TranslateLog } from "../translate/dashboard/index.js";
import { loadLogAttributes, translateLogQuery } from "../translate/logs/index.js";
import { existsSync } from "node:fs";
import { canonicalJson, importAll, sha256, type Dash0Config, type DashboardDefinition, type Manifest, type PrometheusAlertRule } from "../targets/dash0/index.js";
import { makeAlertConverter, type AlertConversion, type ConverterContext } from "../translate/alerts/index.js";
import { translateMonitor } from "../translate/query/index.js";
import type { Alert } from "../ir/index.js";

/** Monitor -> check rule. Default: T6 (src/translate/alerts) over T4's translateMonitor. */
export type AlertConverter = (a: Alert, ctx: TranslateContext) => AlertConversion;
type T6Context = TranslateContext & ConverterContext;
const t6 = makeAlertConverter((mq, t, ctx: T6Context) => translateMonitor(mq, t, ctx));
const defaultAlertConverter: AlertConverter = (a, ctx) => t6(a, ctx as T6Context);
import { buildReport } from "../report/build.js";
import type { Report } from "../report/types.js";

export interface MigrateOptions {
  ingest: IngestOptions;
  /** mappings/ directory (contains tags.yaml and datadog/*.yaml). */
  mappingsDir: string;
  outDir: string;
  /** "dry-run" writes payloads only; "live" imports into Dash0; "none" skips the target step. */
  mode: "dry-run" | "live" | "none";
  enableRules?: boolean;
  dash0?: Dash0Config;
  alertConverter?: AlertConverter;
  version: string;
}

export interface MigrateResult {
  report: Report;
  manifest: Manifest | null;
  dashboards: DashboardTranslation[];
  alerts: { alert: import("../ir/index.js").Alert; conversion: AlertConversion }[];
}

export async function migrate(o: MigrateOptions): Promise<MigrateResult> {
  const ingested = await ingestDatadog(o.ingest);
  const mappings = loadMappings(o.mappingsDir);
  const base: TranslateContext = {
    metric: metricLookup(mappings),
    availability: (dd) => metricAvailability(mappings, dd),
    tag: tagLookup(mappings),
  };
  const translate: TranslateExpr = (e, t) => translateQuery(e, { ...base, variables: t.variables, where: t.where }, t.env);

  // T12: log queries -> dash0.logs PromQL, when the log-attribute table is present.
  const logAttributesFile = join(o.mappingsDir, "log-attributes.yaml");
  const attributes = existsSync(logAttributesFile) ? loadLogAttributes(logAttributesFile) : null;
  const translateLog: TranslateLog | undefined = attributes ? (q, t) => translateLogQuery(q, { attributes, variables: t.variables, where: t.where }) : undefined;

  const dashboards = ingested.dashboards.map((d) => ({ source: d, out: toPerses(d, translate, translateLog, attributes ?? undefined) }));
  const convert = o.alertConverter ?? defaultAlertConverter;
  const alerts = ingested.alerts.map((alert) => ({ alert, conversion: convert(alert, base) }));

  let manifest: Manifest | null = null;
  if (o.mode !== "none") {
    const payloads: { dashboards: DashboardDefinition[]; rules: PrometheusAlertRule[] } = {
      dashboards: dashboards.map((d) => d.out.dashboard),
      rules: alerts.flatMap((a) => (a.conversion.rule ? [a.conversion.rule] : [])),
    };
    manifest = await importAll(payloads, {
      dryRun: o.mode === "dry-run",
      outDir: join(o.outDir, "dash0"),
      ...(o.enableRules !== undefined && { enableRules: o.enableRules }),
      ...(o.mode === "live" && o.dash0 ? { config: o.dash0 } : {}),
    });
  }

  const mappingFiles = [join(o.mappingsDir, "tags.yaml"), ...(attributes ? [logAttributesFile] : []), ...readdirSync(join(o.mappingsDir, "datadog")).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(o.mappingsDir, "datadog", f))];
  const inputHash = sha256(canonicalJson({ dashboards: ingested.dashboards.map((d) => d.original), alerts: ingested.alerts.map((a) => a.original) }));
  const report = buildReport({
    version: o.version,
    inputHash,
    options: { input: o.ingest.input ? "folder" : "api", only: o.ingest.only ?? "all", mode: o.mode, enableRules: !!o.enableRules },
    mappingFiles: mappingFiles.map((f) => f.replace(/\\/g, "/").split("/").slice(-2).join("/")),
    ingestFindings: ingested.findings,
    dashboards: dashboards.map((d) => ({ source: d.source, translation: d.out })),
    alerts,
    manifest,
    mode: o.mode,
  });
  return { report, manifest, dashboards: dashboards.map((d) => d.out), alerts };
}

/** Exit status for the CLI: fail only when something we tried to import failed or was rejected. */
export function overallOk(r: MigrateResult): boolean {
  return !r.manifest || (r.manifest.summary.failed === 0 && r.manifest.summary["rejected-preflight"] === 0);
}

