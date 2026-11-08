// Toplists through ingest -> T5 -> T4 with the window ranking (fn.top.window): a toplist with one metric query and a
// top-N limit becomes a TimeSeriesTable of topk(N, W(q)) at end(), so the table's last point (probe:range-var) is each
// kept series' whole-window value. Everything T4 can't rank keeps the unranked table, with the reason in the finding.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { dashboardFromDatadog } from "../../src/sources/datadog/index.js";
import { toPerses, type TranslateExpr } from "../../src/translate/dashboard/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { validatePromQL } from "../../src/validate/promql.js";

const ROOT = join(import.meta.dirname, "..", "..");
const m = loadMappings(join(ROOT, "mappings"));
const base = { metric: metricLookup(m), availability: (d: string) => metricAvailability(m, d), tag: tagLookup(m) };
// The CLI's wrapper (src/pipeline/migrate.ts): passes the toplist's window request on to T4.
const translate: TranslateExpr = (e, o) => translateQuery(e, { ...base, variables: o.variables, where: o.where, ...(o.window && { window: o.window }) }, o.env);

const toplist = (id: number, title: string, request: object) => ({ id, layout: { x: 0, y: 0, width: 4, height: 2 }, definition: { type: "toplist", title, requests: [{ response_format: "scalar", ...request }] } });
const q = (name: string, query: string, aggregator?: string) => ({ data_source: "metrics", name, query, ...(aggregator && { aggregator }) });
const SIZE = `avg by (table) (avg_over_time({otel_metric_name="postgresql.table.size"}[$__interval]))`;

const DASH = {
  title: "Toplists",
  layout_type: "ordered",
  widgets: [
    toplist(1, "Largest tables", { queries: [q("query1", "avg:postgresql.total_size{*} by {table}", "avg")], formulas: [{ formula: "query1", limit: { count: 5, order: "desc" } }] }),
    toplist(2, "Smallest tables (peak)", { queries: [q("query1", "avg:postgresql.total_size{*} by {table}", "max")], formulas: [{ formula: "query1", limit: { count: 3, order: "asc" } }] }),
    // Datadog's newer toplist format: the limit is in `sort`.
    toplist(3, "Largest tables (sort)", { queries: [q("query1", "avg:postgresql.total_size{*} by {table}", "avg")], formulas: [{ formula: "query1" }], sort: { count: 10, order_by: [{ type: "formula", index: 0, order: "desc" }] } }),
    toplist(4, "Busiest hosts", { queries: [q("query1", "sum:redis.net.commands{*} by {host}", "avg")], formulas: [{ formula: "query1", limit: { count: 10, order: "desc" } }] }),
    // Legacy request: the ranking is the top() in the query string.
    toplist(5, "Legacy top", { q: "top(avg:postgresql.total_size{*} by {table}, 10, 'mean', 'desc')", aggregator: "avg" }),
    // Not rankable: these keep the unranked table.
    toplist(6, "Ratio", { queries: [q("a", "avg:postgresql.total_size{*} by {table}", "avg"), q("b", "avg:postgresql.total_size{*} by {table}", "avg")], formulas: [{ formula: "a / b", limit: { count: 5, order: "desc" } }] }),
    toplist(7, "Average of counts", { queries: [q("query1", "sum:redis.net.commands{*} by {host}.as_count()", "avg")], formulas: [{ formula: "query1", limit: { count: 5, order: "desc" } }] }),
    toplist(8, "Two formulas", { queries: [q("a", "avg:postgresql.total_size{*} by {table}", "avg")], formulas: [{ formula: "a", limit: { count: 5, order: "desc" } }, { formula: "a * 2" }] }),
  ],
};

describe("toplists ranked over the whole window (widget.toplist, fn.top.window)", () => {
  const { dashboard } = dashboardFromDatadog(DASH, { vendor: "datadog", id: "toplists" });
  const r = toPerses(dashboard, translate);
  const p = (title: string) => r.panels.find((x) => x.title === title)!;

  it("gauge, aggregator avg, top 5: topk over the mean of the rollup buckets in the window", () => {
    const e = p("Largest tables");
    expect(e.promql).toEqual([`topk(5, avg_over_time((${SIZE})[$__range:$__interval] @ end()))`]);
    expect(e.panel.spec.plugin.kind).toBe("TimeSeriesTable");
    expect(e.status).toBe("exact-under");
    expect(e.rules).toEqual(expect.arrayContaining(["widget.toplist", "fn.top.window", "time.window.rollup"]));
    expect(e.rules).not.toContain("widget.toplist.unranked");
    const f = e.findings.find((x) => x.code === "widget.toplist")!;
    // the claim is which N series and their values, not the row order
    expect(f.message).toContain("Dash0's order, not sorted by value");
    expect(f.assumptions).toHaveLength(2);
  });

  it("aggregator max with an ascending limit: bottomk over the max of the buckets", () => {
    expect(p("Smallest tables (peak)").promql).toEqual([`bottomk(3, max_over_time((${SIZE})[$__range:$__interval] @ end()))`]);
  });

  it("the newer `sort` form is the same top-N limit", () => {
    const e = p("Largest tables (sort)");
    expect(e.promql).toEqual([`topk(10, avg_over_time((${SIZE})[$__range:$__interval] @ end()))`]);
    expect(e.rules).toContain("widget.toplist");
  });

  it("a Datadog RATE metric with aggregator avg: rate over the window (bounded, like the per-bucket rate)", () => {
    const e = p("Busiest hosts");
    expect(e.promql).toEqual([`topk(10, sum by (host_name) (rate({otel_metric_name="redis.commands.processed"}[$__range] @ end())))`]);
    expect(e.status).toBe("bounded");
    expect(e.rules).toEqual(expect.arrayContaining(["widget.toplist", "time.window.counter.sum"]));
  });

  it("a legacy query with top(): ranked by its method, shown by the aggregator", () => {
    const e = p("Legacy top");
    expect(e.promql).toEqual([`topk(10, avg_over_time((${SIZE})[$__range:$__interval] @ end()))`]);
    expect(e.rules).toContain("widget.toplist");
  });

  for (const [title, reason] of [
    ["Ratio", /not one metric query/],
    ["Average of counts", /average over the window of per-bucket counts/],
    ["Two formulas", /plots 2 queries, not one/],
  ] as const) {
    it(`not rankable, unranked with the reason: ${title}`, () => {
      const e = p(title);
      expect(e.placeholder).toBe(false);
      expect(e.panel.spec.plugin.kind).toBe("TimeSeriesTable");
      expect(e.rules).toContain("widget.toplist.unranked");
      expect(e.rules).not.toContain("widget.toplist");
      expect(e.rules).not.toContain("fn.top.window");
      expect(e.promql.every((x) => !x.includes("$__range"))).toBe(true);
      expect(e.findings.find((x) => x.code === "widget.toplist.unranked")!.message).toMatch(reason);
    });
  }

  it("every emitted query is valid PromQL", () => {
    for (const e of r.panels) for (const x of e.promql) expect(validatePromQL(x).ok, x).toBe(true);
  });
});
