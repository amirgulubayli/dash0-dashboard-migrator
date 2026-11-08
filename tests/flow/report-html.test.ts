// report.html: one offline, deterministic page; counts only (no percentages), EXACT IF with its condition, manual and
// unsupported grouped by reason code with the plain sentence, header with input/target/mode/version/output hash, proof
// rows that say "Not recorded" / "Not checked" unless the run recorded them, Datadog next to PromQL, plain words from
// src/rules/plain.ts, monitors with thresholds, a legend, accessible meters, and a working dry-run state.
import { describe, expect, it } from "vitest";
import { REPORT_CSS, reportBody, reportFilterCss, reportHtml } from "../../src/flow/report-html.js";
import { scoreOf, type Row, type RunFacts } from "../../src/flow/score.js";
import { explainPlain } from "../../src/rules/plain.js";

const base: Row = { id: "x", kind: "panel", title: "t", dashboard: "Redis", widget: "timeseries", status: "exact-under", decision: "as translated", translated: true, landed: true, landedDetail: "created, read-back match", live: "live", success: true, reasons: [], manualActions: [], sourceQueries: [], promql: [] };
const row = (o: Partial<Row>): Row => ({ ...base, ...o });
const facts: RunFacts = { version: "0.5.0", source: "Datadog API datadoghq.eu", target: "Dash0 x / default", mode: "live", inputHash: "a".repeat(64), outputHash: "b".repeat(64), planHash: "c".repeat(64), windowSeconds: 3600, startedAt: "2026-11-08T10:00:00.000Z" };

const NO_EQ = "Not migrated automatically: placeholder panel. The original is kept so a person can rebuild it.";
const DERIVED = "Not migrated automatically: until select.metric.derived ships. The original is kept so a person can rebuild it.";
const UNSUP = "Dash0 has no panel for this kind of widget; a placeholder keeps the original.";
const manual = { status: "manual", decision: "placeholder", translated: false, live: "n/a", success: false } as const;
const rows: Row[] = [
  row({ id: "p1", title: "Memory used", sourceQueries: ["avg:redis.mem.used{*}"], promql: ['avg({otel_metric_name="redis.memory.used"})'], plain: "Same result as in Datadog, as long as both tools cut time into the same buckets.", condition: "Datadog and Dash0 bucket time the same way (A.align)" }),
  row({ id: "p2", title: "Hit rate", status: "bounded", decision: "approved", live: "error", liveDetail: "parse error <x>", success: false, sourceQueries: ["q2"], promql: ["p2"] }),
  row({ id: "p3", title: "Notes <b>", dashboard: "NGINX", widget: "check_status", status: "unsupported", decision: "placeholder", translated: false, live: "n/a", success: false, reasons: ["widget.unsupported"], reasonPlain: { "widget.unsupported": UNSUP }, manualActions: ["Rebuild it by hand"] }),
  row({ id: "p4", title: "Queue depth", ...manual, reasons: ["metric.no_equivalent"], reasonPlain: { "metric.no_equivalent": NO_EQ } }),
  row({ id: "p5", title: "Lag", ...manual, reasons: ["metric.no_equivalent", "metric.derived"], reasonPlain: { "metric.no_equivalent": NO_EQ, "metric.derived": DERIVED } }),
  row({ id: "p6", title: "Ratio", ...manual, reasons: ["metric.derived"], reasonPlain: { "metric.derived": DERIVED } }),
  row({ id: "m1", kind: "alert", title: "High memory", dashboard: null, widget: "metric alert", sourceQueries: ["avg(last_5m):avg:redis.mem.used{*} > 90"], promql: ["avg_over_time(x[5m]) > 90"], thresholds: { failed: 90, degraded: 70 }, enabled: false }),
];
const dryRows = rows.map((r) => ({ ...r, landed: null, live: null, success: null, landedDetail: r.kind === "alert" ? "no check rule (not translatable)" : "no target" }));
const dryFacts: RunFacts = { ...facts, mode: "dry-run", source: "folder fixtures/datadog", target: "Dash0 (dry run)" };
/** The page without its stylesheet (CSS lengths like 100% are not text a person reads). */
const noCss = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, "");
const section = (h: string, id: string, end: string) => h.slice(h.indexOf(`id="${id}"`), h.indexOf(end, h.indexOf(`id="${id}"`)));

describe("report.html", () => {
  const html = reportHtml(scoreOf(rows), rows, facts);
  const dry = reportHtml(scoreOf(dryRows), dryRows, dryFacts);

  it("is byte-identical for the same input and loads nothing external", () => {
    expect(reportHtml(scoreOf(rows), rows, facts)).toBe(html);
    expect(reportHtml(scoreOf(dryRows), dryRows, dryFacts)).toBe(dry);
    expect(html).not.toMatch(/<script|<link|src=|href="http|@import|url\(/i);
    expect(html).toContain("&lt;b&gt;");
  });

  it("is the shell around the exported REPORT_CSS, filter rules and reportBody (for pages that reuse the look)", () => {
    const body = reportBody(scoreOf(rows), rows, facts);
    expect(body.startsWith('<a class="skip"')).toBe(true);
    expect(body).not.toMatch(/<html|<head[ >]|<style|<body/);
    expect(REPORT_CSS).toContain("--accent:#a78bfa");
    expect(REPORT_CSS).toContain("@media print");
    const head = html.slice(0, html.indexOf("<style>\n") + 8);
    expect(html).toBe(`${head}${REPORT_CSS}\n${reportFilterCss(rows)}\n</style></head><body id="top">${body}</body></html>\n`);
  });

  it("shows no percentage anywhere: headline, meters, bars and text are counts", () => {
    expect(noCss(html)).not.toContain("%");
    expect(noCss(dry)).not.toContain("%");
  });

  it("leads with a count headline and accessible meters", () => {
    expect(html).toMatch(/<h1 id="h-sum"><span class="accent">2 of 7<\/span> items succeeded/);
    expect(dry).toMatch(/<h1 id="h-sum"><span class="accent">3 of 7<\/span> items translated/);
    expect(dry).toContain("panels <b>2</b> of 6");
    expect(dry).toContain("monitors <b>1</b> of 1");
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="2 of 7"');
    expect(html).toContain("<b>2</b> of 7");
  });

  it("shows exact-under as EXACT IF with the item's condition, on every such row and in the legend", () => {
    expect(html).toContain('<b class="c-exact-under">EXACT IF</b> Datadog and Dash0 bucket time the same way (A.align)');
    // No condition recorded: says so instead of a bare EXACT IF.
    expect(section(html, "monitors", "</section>")).toContain('<b class="c-exact-under">EXACT IF</b> <span class="dim">condition not recorded in this run</span>');
    expect(html.match(/class="exactif"/g)).toHaveLength(rows.filter((r) => r.status === "exact-under").length);
    expect(section(html, "legend", "</section>")).toContain("EXACT IF followed by its condition");
    // Status chip: shape + word (+ colour class).
    expect(html).toContain('<span class="claim c-exact-under"><span aria-hidden="true">◐</span> EXACT IF</span>');
    expect(html).toContain('<span class="claim c-manual"><span aria-hidden="true">▲</span> manual</span>');
  });

  it("groups manual and unsupported by reason code with the plain sentence and count, before everything else", () => {
    const att = section(html, "attention", 'class="filter"');
    const iNoEq = att.indexOf('<code class="il rc">metric.no_equivalent</code>');
    const iDer = att.indexOf('<code class="il rc">metric.derived</code>');
    const iUns = att.indexOf('<code class="il rc">widget.unsupported</code>');
    expect(iNoEq).toBeGreaterThan(-1);
    expect(iNoEq).toBeLessThan(iDer); // 2 items before 1
    expect(iDer).toBeLessThan(iUns); // manual before unsupported
    expect(iUns).toBeLessThan(att.indexOf("Dash0 rejected the query")); // people first, then live failures
    expect(att).toContain('<span class="n">2 items</span><span class="agh">Not migrated automatically: placeholder panel.');
    expect(att).toContain(DERIVED);
    expect(att).toContain(UNSUP);
    expect(att).toContain("also metric.derived");
    expect(att).not.toContain("Not translated");
    expect(att).toContain("parse error &lt;x&gt;");
    expect(att).toContain('href="#i2"');
    expect(att).toContain("Rebuild it by hand");
    expect(html).toContain('id="i2"');
  });

  it("puts input, target, mode, version, commit and output hash in the header; hash and no-AI in the footer", () => {
    const hdr = html.slice(html.indexOf('<div class="frame">'), html.indexOf('<nav class="jump"'));
    for (const s of ["Datadog API datadoghq.eu", "Dash0 x / default", "live import", "dd2dash0 0.5.0", "commit not stamped", "b".repeat(16)]) expect(hdr).toContain(s);
    expect(reportHtml(scoreOf(rows), rows, { ...facts, toolCommit: "0123456789abcdef0123" })).toContain("commit 0123456789ab");
    expect(dry).toContain("folder fixtures/datadog");
    expect(dry).toContain("dry run, nothing imported");
    expect(html).toContain(`<b>${"b".repeat(16)}</b> · no AI in translation`);
  });

  it("proof: landed and returns-data only as recorded, parity always Not checked, no unrecorded claims", () => {
    const p = section(html, "summary", "</section>");
    expect(p).toContain("<b>7</b> of 7 imported and read back from Dash0 as a match");
    expect(p).toContain("<b>2</b> of 3 queries return data in Dash0");
    expect(p).toMatch(/values vs Datadog<\/dt><dd class="dim">Not checked/);
    const d = section(dry, "summary", "</section>");
    expect(d).toContain("Not recorded (dry run: nothing was imported)");
    expect(d).toMatch(/returns data<\/dt><dd class="dim">Not checked<\/dd>/);
    for (const h of [html, dry]) expect(h).not.toMatch(/verified|matches Datadog/i);
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
    expect(html).toContain("proven error bound");
  });

  it("filters by claim without script (radio + :has) and groups dashboards under <details>", () => {
    expect(html).toContain('id="f-unsupported"');
    expect(html).toContain("main:has(#f-unsupported:checked) .item:not([data-claim=\"unsupported\"])");
    expect(html).toMatch(/<details class="dash" id="d1" open>/);
    expect(html).toContain("@media print");
  });

  it("dry run: says what is not measured and claims no landing", () => {
    expect(dry).toContain("Dry run: nothing was imported, so landed, live and success are not measured.");
    expect(dry).toContain("not measured");
    expect(dry).not.toContain("no check rule (not translatable)");
    expect(dry).not.toContain('role="meter" aria-labelledby="mk-s"');
  });
});
