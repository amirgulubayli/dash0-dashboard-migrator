// Log widgets end to end: Datadog JSON -> T2 ingest -> T5 (with T4 + T12) -> T7 preflight -> T8 report.
// Widget shapes follow Datadog's dashboard API (data_source "logs", search, compute, group_by).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFromDatadog } from "../../src/sources/datadog/index.js";
import { toPerses, type TranslateExpr, type TranslateLog } from "../../src/translate/dashboard/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import { loadLogAttributes, translateLogQuery } from "../../src/translate/logs/index.js";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { preflightDashboard } from "../../src/targets/dash0/index.js";
import { migrate } from "../../src/pipeline/migrate.js";
import { validatePromQL } from "../../src/validate/promql.js";
import { CATALOG } from "../../src/rules/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const m = loadMappings(join(ROOT, "mappings"));
const attributes = loadLogAttributes(join(ROOT, "mappings", "log-attributes.yaml"));
const base = { metric: metricLookup(m), availability: (d: string) => metricAvailability(m, d), tag: tagLookup(m) };
const translate: TranslateExpr = (e, o) => translateQuery(e, { ...base, variables: o.variables, where: o.where }, o.env);
const translateLog: TranslateLog = (q, o) => translateLogQuery(q, { attributes, variables: o.variables, where: o.where });

const logQ = (name: string, query: string, extra: object = {}) => ({ data_source: "logs", name, indexes: ["*"], compute: { aggregation: "count" }, search: { query }, ...extra });
const widget = (id: number, type: string, title: string, requests: unknown, x = 0) => ({ id, layout: { x, y: 0, width: 4, height: 2 }, definition: { type, title, requests } });

const DASH = {
  title: "API logs",
  layout_type: "ordered",
  template_variables: [{ name: "service", prefix: "service", default: "*" }],
  widgets: [
    widget(1, "timeseries", "Errors by service", [{ response_format: "timeseries", queries: [logQ("query1", "status:error", { group_by: [{ facet: "service", limit: 10, sort: { order: "desc" } }] })], formulas: [{ formula: "query1" }] }]),
    widget(2, "query_value", "Error rate %", [{ response_format: "scalar", queries: [{ ...logQ("a", "service:api status:error"), aggregator: "sum" }, { ...logQ("b", "service:api"), aggregator: "sum" }], formulas: [{ formula: "100 * a / b" }] }], 4),
    widget(3, "timeseries", "Errors per command", [{ response_format: "timeseries", queries: [logQ("logs", "source:redis status:error"), { data_source: "metrics", name: "cmds", query: "sum:redis.net.commands{*}" }], formulas: [{ formula: "logs / cmds" }] }], 8),
    widget(4, "timeseries", "Average duration", [{ response_format: "timeseries", queries: [logQ("d", "service:api", { compute: { aggregation: "avg", metric: "@duration" } })], formulas: [{ formula: "d" }] }]),
    { id: 5, layout: { x: 4, y: 2, width: 6, height: 4 }, definition: { type: "list_stream", title: "Error stream", requests: [{ response_format: "event_list", query: { data_source: "logs_stream", query_string: "status:error" } }] } },
  ],
};

describe("log widgets through T5 with T4 + T12", () => {
  const { dashboard } = dashboardFromDatadog(DASH, { vendor: "datadog", id: "api-logs" });
  const r = toPerses(dashboard, translate, translateLog);
  const p = (title: string) => r.panels.find((x) => x.title === title)!;

  it("a log count with a group limit becomes a dash0.logs query", () => {
    const e = p("Errors by service");
    expect(e.placeholder).toBe(false);
    expect(e.promql).toHaveLength(1);
    expect(e.promql[0]).toMatch(/otel_metric_name="dash0\.logs"/);
    expect(e.promql[0]).toMatch(/otel_log_severity_range="ERROR"/);
    expect(e.promql[0]).toMatch(/^topk\(10, sum by \(service_name\) \(increase\(/);
    expect(e.rules).toEqual(expect.arrayContaining(["log.count", "log.group_by.limit", "widget.timeseries"]));
  });

  it("a formula over two log queries (error rate) combines both counts", () => {
    const e = p("Error rate %");
    expect(e.promql).toHaveLength(1);
    expect(e.promql[0]).toMatch(/^100 \* .*dash0\.logs.* \/ .*dash0\.logs/);
    expect(e.panel.spec.plugin.kind).toBe("StatChart");
  });

  it("a formula can mix a log query and a metric query", () => {
    const e = p("Errors per command");
    expect(e.promql).toHaveLength(1);
    expect(e.promql[0]).toContain('otel_metric_name="dash0.logs"');
    expect(e.promql[0]).toContain('otel_metric_name="redis.commands.processed"');
  });

  it("a log measure T12 can't translate fails closed with T12's own finding, as a placeholder", () => {
    const e = p("Average duration");
    expect(e).toMatchObject({ placeholder: true, status: "manual" });
    expect(e.findings.some((f) => f.status === "manual")).toBe(true);
  });

  it("log streams stay placeholders (LogTable is planned in the catalog)", () => {
    expect(p("Error stream")).toMatchObject({ placeholder: true });
    expect(p("Error stream").rules).toContain("widget.logs");
  });

  it("every emitted query parses and the dashboard passes T7 preflight", () => {
    for (const x of r.panels) for (const q of x.promql) expect(validatePromQL(q).ok, q).toBe(true);
    expect(preflightDashboard(r.dashboard)).toEqual([]);
  });

  it("without a log translator, log queries still fail closed (backwards compatible)", () => {
    const plain = toPerses(dashboard, translate);
    expect(plain.panels.find((x) => x.title === "Errors by service")!).toMatchObject({ placeholder: true, status: "manual" });
  });
});

describe("migrate wires T12 in from mappings/log-attributes.yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  mkdirSync(join(dir, "dashboards"));
  writeFileSync(join(dir, "dashboards", "api-logs.json"), JSON.stringify(DASH));
  const run = await migrate({ ingest: { input: dir }, mappingsDir: join(ROOT, "mappings"), outDir: join(dir, "out"), mode: "dry-run", version: "test" });

  it("log panels translate in the CLI pipeline and the report lists the attribute table", () => {
    const item = run.report.items.find((i) => i.title === "Errors by service")!;
    expect(item.promql[0]).toContain("dash0.logs");
    expect(run.report.run.mappingFiles).toContain("mappings/log-attributes.yaml");
    expect(run.report.summary.import).toMatchObject({ rejected: 0 });
  });

  it("every rule id the log panels cite is in the T17 catalog", () => {
    const known = new Set(CATALOG.map((r) => r.id));
    const cited = new Set(run.report.items.flatMap((i) => i.certificate.rules));
    expect([...cited].filter((id) => !known.has(id) && !["widget.query_value.default-agg", "widget.query_value.multi", "widget.toplist.unranked"].includes(id))).toEqual([]);
  });
});
