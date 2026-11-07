// W4 proof card: one offline, deterministic HTML page per run.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { readProofInputs, renderProof, writeProof } from "../../src/pipeline/proof.js";
import { parity, type WatchEvent } from "../../src/pipeline/watch.js";

const ROOT = join(import.meta.dirname, "..", "..");
const FIX = join(ROOT, "fixtures", "datadog");

async function fixturePlan(): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), "proof-")), "plan");
  const code = await main(["plan", "--input", FIX, "--out", dir]);
  expect(code).toBe(0);
  return dir;
}

function addWatch(plan: string, alertId: string): void {
  const T0 = Date.parse("2026-11-08T14:00:00Z");
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const events: WatchEvent[] = [
    { side: "datadog", alertId, from: null, to: "ok", at: at(0), method: "api" },
    { side: "dash0", alertId, from: null, to: "ok", at: at(0), method: "computed", value: 61 },
    { side: "datadog", alertId, from: "ok", to: "failed", at: at(120), method: "api" },
    { side: "dash0", alertId, from: "ok", to: "failed", at: at(140), method: "computed", value: 93 },
    { side: "datadog", alertId, from: "failed", to: "ok", at: at(420), method: "api" },
    { side: "dash0", alertId, from: "failed", to: "ok", at: at(440), method: "computed", value: 55 },
  ];
  mkdirSync(join(plan, "watch"), { recursive: true });
  writeFileSync(join(plan, "watch", "timeline.json"), JSON.stringify({ schema: "dd2dash0.watch/v1", startedAt: at(0), endedAt: at(480), events }));
  writeFileSync(join(plan, "watch", "parity.json"), JSON.stringify({ schema: "dd2dash0.parity/v1", results: [parity(events, alertId, 125_000)] }));
}

describe("proof card", async () => {
  const plan = await fixturePlan();
  const report = JSON.parse(readFileSync(join(plan, "report.json"), "utf8"));
  const highMem = report.items.find((i: { kind: string; title: string }) => i.kind === "alert" && /High memory/.test(i.title)).id as string;

  it("without a watch it says so, and still lists everything that needs a person", () => {
    const { html, inputs } = writeProof(plan);
    expect(inputs.planIntact).toBe(true);
    expect(inputs.applied).toBe(false);
    expect(html).toMatch(/Not watched yet/);
    expect(html).toMatch(/Planned, not imported yet/);
    expect(html).toMatch(/Chart parity<\/h2><p class="muted">Not measured in this run/);
    const todo = report.items.filter((i: { kind: string; status: string }) => i.kind !== "group" && (i.status === "manual" || i.status === "unsupported"));
    expect(todo.length).toBeGreaterThan(0);
    const section = html.slice(html.indexOf("Everything that needs a person"));
    expect((section.match(/<tr><td>/g) ?? []).length).toBe(todo.length);
  });

  it("is deterministic and loads nothing from the network", () => {
    addWatch(plan, highMem);
    const a = writeProof(plan).html;
    const b = renderProof(readProofInputs(plan));
    expect(b).toBe(a);
    expect(a).not.toMatch(/<script|<link|@import|url\(|src=|<img|<iframe/i);
    expect(a).not.toMatch(/https?:\/\//);
  });

  it("shows the verdict, the measured gap against the bound, and labels the Dash0 lane computed", () => {
    const html = writeProof(plan).html;
    expect(html).toMatch(/✓<\/span> PASS/);
    expect(html).toMatch(/<div class="hero">20 s<\/div><div class="muted">between the two firings · bound 2 min 5 s/);
    expect(html).toMatch(/class="lane-sub"[^>]*>computed</);
    expect(html).toMatch(/The Dash0 lane is <b>computed<\/b>/);
    expect(html).toMatch(/20 s apart/);
  });

  it("floors percentages and escapes everything from the inputs", () => {
    const inputs = readProofInputs(plan);
    inputs.report.summary.coverageExact = 0.4489;
    inputs.report.items = [
      ...inputs.report.items,
      { ...inputs.report.items.find((i) => i.kind === "panel")!, id: "x", title: '<script>alert("x")</script>', status: "manual", manual_actions: ["<b>do</b>"] },
    ];
    const html = renderProof(inputs);
    expect(html).toMatch(/<b>44\.8%<\/b>/);
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;do&lt;/b&gt;");
  });

  it("flags a plan that changed after planning, and proof/ itself is not part of the plan lock", () => {
    writeProof(plan); // proof/proof.html exists now: the lock must not see it
    expect(readProofInputs(plan).planIntact).toBe(true);
    writeFileSync(join(plan, "report.md"), "edited by hand\n");
    const html = writeProof(plan).html;
    expect(html).toMatch(/✕ changed since planning/);
  });

  it("adds the corpus bars from a corpus-coverage --json file, and refuses a missing one", () => {
    const corpus = join(mkdtempSync(join(tmpdir(), "corpus-")), "c.json");
    writeFileSync(corpus, JSON.stringify({ dashboards: 516, monitors: 329, pipeline: { panels: { total: 10, by: { "exact-under": 6, manual: 4 } }, alerts: { total: 2, by: { "exact-under": 1, manual: 1 } } } }));
    const html = writeProof(plan, { corpus }).html;
    expect(html).toMatch(/516 dashboards and 329 monitors/);
    expect(html).toMatch(/Corpus panels <span class="muted">10<\/span>/);
    expect(() => writeProof(plan, { corpus: corpus + ".missing" })).toThrow(/corpus file not found/);
  });

  it("the CLI writes <plan>/proof/proof.html and exits 0; a missing plan is a usage error", async () => {
    expect(await main(["proof", plan])).toBe(0);
    expect(readFileSync(join(plan, "proof", "proof.html"), "utf8")).toMatch(/^<!doctype html>/);
    expect(await main(["proof", join(plan, "nope")])).toBe(3);
  });
});
