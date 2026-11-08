// The terminal presentation: one claim vocabulary, answer-first explain, wrapping at narrow widths, the dry-run
// result card, errors that say what to do next, and plain output that is byte-for-byte deterministic.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explain } from "../../src/flow/explain.js";
import { resultCard } from "../../src/flow/run.js";
import type { Score } from "../../src/flow/score.js";
import { claim, claimCounts, CLAIM_GLYPH, CLAIMS, hang, paint, truncateStart, Ui, width, wrap } from "../../src/ui/style.js";

const MAPPINGS = join(import.meta.dirname, "..", "..", "mappings");
const ui = (columns = 100, env: NodeJS.ProcessEnv = { NO_COLOR: "1" }) => {
  const out: string[] = [];
  return { out, ui: new Ui({ write: (s) => void out.push(s), isTTY: false, columns }, env, () => 0) };
};
const run = (query: string, columns = 100) => {
  const u = ui(columns);
  let t = 0;
  // A clock that moves: plain output must not show it.
  const code = explain({ query, mappingsDir: MAPPINGS, ui: u.ui, version: "test", now: () => (t += 1.234) });
  return { code, text: u.out.join("") };
};

describe("claim vocabulary", () => {
  it("one word and one glyph per claim; ✗ is kept for failures", () => {
    const p = paint(false);
    expect(CLAIMS.map((c) => claim(p, c))).toEqual(["✓ exact", "✓ exact-under", "± bounded", "! manual", "∅ unsupported"]);
    expect(Object.values(CLAIM_GLYPH)).not.toContain("✗");
    expect(claimCounts(p, { exact: 0, "exact-under": 40, bounded: 38, manual: 18, unsupported: 6 })).toBe("✓ 40 exact-under · ± 38 bounded · ! 18 manual · ∅ 6 unsupported");
  });

  it("colors follow the report.html roles (exact/exact-under ok, bounded accent, manual warn, unsupported bad)", () => {
    const p = paint(true);
    expect(claim(p, "exact-under")).toBe(p.ok("✓ exact-under"));
    expect(claim(p, "bounded")).toBe(p.accent("± bounded"));
    expect(claim(p, "manual")).toBe(p.warn("! manual"));
    expect(claim(p, "unsupported")).toBe(p.bad("∅ unsupported"));
  });
});

describe("wrapping", () => {
  it("wraps on words, hangs continuation lines, and keeps the end of a long path", () => {
    expect(wrap("aaa bbb ccc ddd", 7)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(hang("A.align  ", "one two three four", 19, { min: 5 })).toEqual(["A.align  one two", "         three four"]);
    expect(hang("a-very-long-prefix  ", "one two", 24, { min: 10, under: 2 })).toEqual(["a-very-long-prefix", "  one two"]);
    expect(truncateStart("/a/b/c/run/report.html", 12)).toBe("…report.html");
  });
});

describe("explain, answer first", () => {
  it("puts the claim and the PromQL before the stages, then repeats the claim with its conditions", () => {
    const { code, text } = run("avg:redis.mem.used{env:prod} by {host}");
    expect(code).toBe(0);
    const first = text.indexOf("● Claim");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(text.indexOf("● 1 Parse"));
    expect(text.slice(first, text.indexOf("\n", first))).toContain("✓ exact-under  if A.align, A.boundary");
    expect(text.lastIndexOf("● Claim")).toBeGreaterThan(text.indexOf("● 4 PromQL"));
  });

  it("names the finding that sets a bounded or manual claim", () => {
    expect(run("avg:postgresql.connections{*} by {db}").text).toMatch(/● Claim {2}± bounded {2}because of metric\.approximate/);
    const m = run("anomalies(avg:redis.mem.used{*}, 'basic', 2)");
    expect(m.code).toBe(1);
    expect(m.text).toMatch(/● Claim {2}! manual {2}because of fn\.anomalies/);
  });

  it("plain output is deterministic: no timings, same bytes every run", () => {
    const a = run("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90").text;
    expect(a).not.toMatch(/\d ms\b/);
    expect(run("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90").text).toBe(a);
  });

  it("fits a 60-column terminal, except the PromQL (kept whole so it can be copied)", () => {
    const { text } = run("avg:postgresql.connections{$scope,$db,$host} by {db}.rollup(max)", 60);
    const long = text.split("\n").filter((l) => width(l) > 60);
    for (const l of long) expect(l).toMatch(/otel_metric_name|^  avg:postgresql/); // the PromQL and the query itself
  });

  it("a log search gets a hint, not just a parse error", () => {
    const { code, text } = run("source:nginx @http.status_code:(404 OR 500)");
    expect(code).toBe(3);
    expect(text).toContain("not a Datadog metric query");
    expect(text).toMatch(/looks like a log search/);
  });

  it("any other parse error shows the expected form", () => {
    expect(run("avg:redis.mem.used{").text).toMatch(/Expected <agg>:<metric>\{<scope>\} by \{<tags>\}/);
  });
});

describe("result card", () => {
  const dry: Score = {
    total: 102,
    panels: 96,
    monitors: 6,
    translated: { count: 78, total: 102, pct: 76 },
    landed: null,
    live: null,
    success: null,
    liveCounts: null,
    topGaps: [["metric.no_equivalent", 8], ["metric.derived", 6], ["widget.unsupported", 6]],
  };
  const x = { live: false, rulesImported: 1, rulesOn: 0, manualMonitors: 5, html: "/w/run/report.html", md: "/w/run/report.md", rel: (f: string) => f.replace("/w/", ""), claims: { "exact-under": 40, bounded: 38, manual: 18, unsupported: 6 } };

  it("dry run: headline first, one meter, claim counts, no empty bars", () => {
    const text = resultCard(ui().ui, dry, x).join("\n");
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/78 of 102 items translated {2}76%/);
    expect(text).not.toContain("not measured");
    expect(text).toContain("dry run: landed, live and success need a live import");
    expect(text).toContain("✓ 40 exact-under · ± 38 bounded · ! 18 manual · ∅ 6 unsupported");
    expect(text).toContain("5 monitors not a rule (manual)");
  });

  it("stays inside a 60-column terminal and never cuts a plain-text path", () => {
    const lines = resultCard(ui(60).ui, dry, { ...x, rel: (f: string) => "../../../../" + f }).join("\n").split("\n");
    for (const l of lines.filter((l) => !l.startsWith("report") && !l.startsWith("        /"))) expect(width(l)).toBeLessThanOrEqual(60);
    expect(lines.join("\n")).toContain("/w/run/report.html");
    expect(lines.join("\n")).not.toContain("../");
  });
});
