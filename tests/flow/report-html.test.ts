// report.html: one offline, deterministic page; headline, attention first, Datadog next to PromQL, plain words from
// src/rules/plain.ts, monitors with thresholds, a legend, accessible meters, and a working dry-run state.
import { describe, expect, it } from "vitest";
import { reportHtml } from "../../src/flow/report-html.js";
import { scoreOf, type Row, type RunFacts } from "../../src/flow/score.js";
import { explainPlain } from "../../src/rules/plain.js";

const base: Row = { id: "x", kind: "panel", title: "t", dashboard: "Redis", widget: "timeseries", status: "exact-under", decision: "as translated", translated: true, landed: true, landedDetail: "created, read-back match", live: "live", success: true, reasons: [], manualActions: [], sourceQueries: [], promql: [] };
const row = (o: Partial<Row>): Row => ({ ...base, ...o });
const facts: RunFacts = { version: "0.5.0", source: "Datadog datadoghq.eu", target: "Dash0 x / default", mode: "live", inputHash: "a".repeat(64), outputHash: "b".repeat(64), planHash: "c".repeat(64), windowSeconds: 3600, startedAt: "2026-11-08T10:00:00.000Z" };

const rows: Row[] = [
  row({ id: "p1", title: "Memory used", sourceQueries: ["avg:redis.mem.used{*}"], promql: ['avg({otel_metric_name="redis.memory.used"})'], plain: "Same result as in Datadog, as long as both tools cut time into the same buckets." }),
  row({ id: "p2", title: "Hit rate", status: "bounded", decision: "approved", live: "error", liveDetail: "parse error", success: false, sourceQueries: ["q2"], promql: ["p2"] }),
  row({ id: "p3", title: "Notes <b>", dashboard: "NGINX", widget: "check_status", status: "unsupported", decision: "placeholder", translated: false, live: "n/a", success: false, reasons: ["widget.unsupported"], manualActions: ["Rebuild it by hand"] }),
  row({ id: "m1", kind: "alert", title: "High memory", dashboard: null, widget: "metric alert", sourceQueries: ["avg(last_5m):avg:redis.mem.used{*} > 90"], promql: ["avg_over_time(x[5m]) > 90"], thresholds: { failed: 90, degraded: 70 }, enabled: false }),
];

describe("report.html", () => {
  const html = reportHtml(scoreOf(rows), rows, facts);

  it("is byte-identical for the same input and loads nothing external", () => {
    expect(reportHtml(scoreOf(rows), rows, facts)).toBe(html);
    expect(html).not.toMatch(/<script|<link|src=|href="http|@import|url\(/i);
    expect(html).toContain("&lt;b&gt;");
  });

  it("leads with the headline and accessible meters", () => {
    expect(html).toMatch(/<h1 id="h-sum"><span class="accent">50%<\/span> success/);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="2 of 4, 50%"');
    expect(html).toContain("2/4 <b>50%</b>");
  });

  it("lists what needs attention, most serious first, linking to each item", () => {
    const att = html.slice(html.indexOf('id="attention"'), html.indexOf('class="filter"'));
    expect(att.indexOf("Dash0 rejected the query")).toBeLessThan(att.indexOf("No Dash0 panel (unsupported)"));
    expect(att).toContain('href="#i2"');
    expect(att).toContain("Rebuild it by hand");
    expect(html).toContain('id="i2"');
  });

  it("shows the Datadog query next to the PromQL and the item's plain sentence", () => {
    expect(html).toMatch(/<span class="ql">Datadog<\/span><code>avg:redis\.mem\.used\{\*\}<\/code><\/div><div class="q"><span class="ql">PromQL<\/span><code>avg\(\{otel_metric_name=&quot;redis\.memory\.used&quot;\}\)<\/code>/);
    expect(html).toContain("as long as both tools cut time into the same buckets.");
    // No plain sentence in the row: falls back to the same template (bounded has one without assumptions).
    expect(html).toContain(explainPlain({ status: "bounded", rules: [], assumptions: [] }).replace(/'/g, "&#39;"));
  });

  it("shows monitors with thresholds and whether the rule is on", () => {
    expect(html).toContain("failed <b>90</b> · degraded <b>70</b>");
    expect(html).toContain("off (import disabled; turn on in Dash0)");
  });

  it("explains every claim with the plain.ts wording", () => {
    for (const s of ["exact", "bounded", "unsupported"] as const) expect(html).toContain(explainPlain({ status: s, rules: [], assumptions: [] }).replace(/'/g, "&#39;"));
    expect(html).toContain("Same result as in Datadog, as long as the conditions listed with the item hold.");
  });

  it("filters by claim without script (radio + :has) and groups dashboards under <details>", () => {
    expect(html).toContain('id="f-unsupported"');
    expect(html).toContain("main:has(#f-unsupported:checked) .item:not([data-claim=\"unsupported\"])");
    expect(html).toMatch(/<details class="dash" id="d1" open>/);
    expect(html).toContain("@media print");
  });

  it("dry run: says what is not measured and claims no landing", () => {
    const dry = rows.map((r) => ({ ...r, landed: null, live: null, success: null, landedDetail: r.kind === "alert" ? "no check rule (not translatable)" : "no target" }));
    const d = reportHtml(scoreOf(dry), dry, { ...facts, mode: "dry-run" });
    expect(d).toContain("Dry run: nothing was imported, so landed, live and success are not measured.");
    expect(d).toContain("not measured");
    expect(d).not.toContain("no check rule (not translatable)");
    expect(d).not.toContain('role="meter" aria-labelledby="mk-s"');
  });
});
