// tools/jev (plans 08, 09 §5) offline: Jev is a fake fetch, so no network and no real key. Covers the off-by-default
// gate, the per-question cache, fallback on errors and timeouts, J2 choice mapping, J3 flag threshold, J1 sidecar
// shape, and the boundary that keeps src/ away from tools/.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, createJev, hashQuestion, JEV_LABEL, JEV_MODEL, jevGate, type JevConfig } from "../../tools/jev/client.js";
import { EVIDENCE_FLAG_BELOW, evidenceNote, newMappingRows, pickGapWithJev, reviewPriority, scoreEvidence } from "../../tools/jev/uses.js";
import type { Gap } from "../../tools/improve/gaps.js";

const ROOT = join(import.meta.dirname, "..", "..");
const KEY = "test-key-not-real";
const ON = { TYPESAFE_API_KEY: KEY };
const dir = () => mkdtempSync(join(tmpdir(), "jev-test-"));

/** A fake fetch that counts calls and answers each question in the request via `answer`. */
function fakeJev(answer: (id: string, q: any, body: any) => unknown, status = 200) {
  const calls: any[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, answer(id, q, body)]));
    return new Response(JSON.stringify({ model: "jev-test-1", answers }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const throwingFetch = () => {
  let n = 0;
  const f = (async () => {
    n++;
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  return { f, count: () => n };
};
const jevWith = (fetchImpl: typeof fetch, extra: Partial<JevConfig> = {}) => createJev({ requested: true, env: ON, cacheDir: dir(), fetchImpl, ...extra });
const gap = (key: string, score: number, actionable = true): Gap => ({ key, code: "metric.unmapped", scope: key.split(":")[1] ?? null, items: ["a"], examples: [], subjects: [`${key}.x`], score, actionable });
const choiceQ = { x: { type: "choice" as const, instructions: "i", criteria: { a: "A", b: "B" } } };

describe("gate: Jev is off by default", () => {
  it("needs both the request and the key, and JEV_DISABLED=1 wins", () => {
    expect(jevGate(false, ON).enabled).toBe(false);
    expect(jevGate(true, {}).enabled).toBe(false);
    expect(jevGate(true, { ...ON, JEV_DISABLED: "1" }).enabled).toBe(false);
    expect(jevGate(true, ON).enabled).toBe(true);
    for (const g of [jevGate(false, ON), jevGate(true, {}), jevGate(true, { ...ON, JEV_DISABLED: "1" }), jevGate(true, ON)]) {
      expect(g.reason).not.toContain(KEY);
      expect(g.reason.split("\n")).toHaveLength(1);
    }
  });

  it("flag off, key missing or kill switch => fetch is never called, every use falls back", async () => {
    const yaml = `metrics:\n  a.b: {otel: "a.b", status: exact, note: "n"}\n`;
    const report = { items: [{ id: "i1", status: "manual" }] };
    for (const cfg of [{ requested: false, env: ON }, { requested: true, env: {} }, { requested: true, env: { ...ON, JEV_DISABLED: "1" } }]) {
      const { f, calls } = fakeJev(() => ({ type: "choice", choice: "a", confidence: 1, probabilities: {} }));
      const jev = createJev({ ...cfg, cacheDir: dir(), fetchImpl: f });
      expect(jev.enabled).toBe(false);
      await expect(jev.ask("s", choiceQ)).rejects.toThrow(/Jev off/);
      const p = await pickGapWithJev([gap("metric.unmapped:a", 9), gap("metric.unmapped:b", 5)], jev);
      expect(p).toMatchObject({ by: "deterministic", gap: { key: "metric.unmapped:a" } });
      expect((await scoreEvidence(yaml, jev)).skipped).toMatch(/Jev off/);
      await expect(reviewPriority(report, jev)).rejects.toThrow(/Jev off/);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("client: cache", () => {
  it("keys by sha256 of the canonical {model, question, state}", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const h = hashQuestion("s", choiceQ.x);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashQuestion("s", { criteria: { b: "B", a: "A" }, instructions: "i", type: "choice" })).toBe(h);
    expect(hashQuestion("s2", choiceQ.x)).not.toBe(h);
    expect(hashQuestion("s", choiceQ.x, "jev-other")).not.toBe(h);
  });

  it("miss calls Jev and stores {model, inputHash, answeredAt, answer}; hit reuses it without a call", async () => {
    const cacheDir = dir();
    const { f, calls } = fakeJev(() => ({ type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }));
    const jev = createJev({ requested: true, env: ON, cacheDir, fetchImpl: f });
    const first = await jev.ask("s", choiceQ);
    const second = await jev.ask("s", choiceQ);
    expect([first.meta.x.cached, second.meta.x.cached, calls.length]).toEqual([false, true, 1]);
    expect(calls[0]).toMatchObject({ model: JEV_MODEL, state: "s", questions: choiceQ });
    expect(second.answers.x.choice).toBe("a");
    const h = hashQuestion("s", choiceQ.x);
    expect(readdirSync(cacheDir)).toEqual([`${h}.json`]);
    const entry = JSON.parse(readFileSync(join(cacheDir, `${h}.json`), "utf8"));
    expect(Object.keys(entry).sort()).toEqual(["answer", "answeredAt", "inputHash", "model"]);
    expect(entry).toMatchObject({ model: "jev-test-1", inputHash: h, answer: { type: "choice", choice: "a" } });
    expect(JSON.stringify(entry)).not.toContain(KEY);
  });

  it("asks only the uncached questions of a batch", async () => {
    const cacheDir = dir();
    const { f, calls } = fakeJev(() => ({ type: "score", score: 2, confidence: 0.5, probabilities: {} }));
    const jev = createJev({ requested: true, env: ON, cacheDir, fetchImpl: f });
    const q = (n: string) => ({ type: "score" as const, instructions: n, criteria: ["0", "1", "2", "3"] });
    await jev.ask("s", { a: q("a") });
    const r = await jev.ask("s", { a: q("a"), b: q("b") });
    expect(Object.keys(calls[1].questions)).toEqual(["b"]);
    expect([r.meta.a.cached, r.meta.b.cached]).toEqual([true, false]);
  });

  it("re-asks when a cache file is corrupt", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, `${hashQuestion("s", choiceQ.x)}.json`), "{not json");
    const { f, calls } = fakeJev(() => ({ type: "choice", choice: "b", confidence: 1, probabilities: {} }));
    const r = await createJev({ requested: true, env: ON, cacheDir, fetchImpl: f }).ask("s", choiceQ);
    expect([r.answers.x.choice, calls.length]).toEqual(["b", 1]);
  });
});

describe("client: errors", () => {
  it("rejects HTTP errors (key redacted), bad answers and timeouts, and caches none of them", async () => {
    const cacheDir = dir();
    const echo = (async () => new Response(`bad key ${KEY}`, { status: 401 })) as unknown as typeof fetch;
    const err = await createJev({ requested: true, env: ON, cacheDir, fetchImpl: echo }).ask("s", choiceQ).catch((e: Error) => e.message);
    expect(err).toMatch(/HTTP 401/);
    expect(err).not.toContain(KEY);
    await expect(jevWith(fakeJev(() => ({ type: "choice", choice: "zzz", confidence: 1, probabilities: {} })).f).ask("s", choiceQ)).rejects.toThrow(/unknown option/);
    await expect(jevWith(fakeJev(() => undefined).f).ask("s", choiceQ)).rejects.toThrow(/no choice answer/);
    const sq = { y: { type: "score" as const, instructions: "i", criteria: ["0", "1"] } };
    await expect(jevWith(fakeJev(() => ({ type: "score", score: 7, confidence: 1, probabilities: {} })).f).ask("s", sq)).rejects.toThrow(/outside 0..1/);
    const hang = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(jevWith(hang, { timeoutMs: 20 }).ask("s", choiceQ)).rejects.toThrow(/no answer within 20 ms/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });
});

describe("J2: planner picks among the top 5 deterministic gaps", () => {
  const ranked = [gap("tag.unmapped", 40, false), ...["pg", "nginx", "redis", "mysql", "kafka", "mongo"].map((s, i) => gap(`metric.unmapped:${s}`, 30 - i))];

  it("offers only the top 5 actionable gaps and maps Jev's choice back to the gap", async () => {
    const { f, calls } = fakeJev(() => ({ type: "choice", choice: "metric.unmapped:redis", confidence: 0.8, probabilities: { "metric.unmapped:redis": 0.8 } }));
    const p = await pickGapWithJev(ranked, jevWith(f));
    expect(Object.keys(calls[0].questions.gap.criteria)).toEqual(["pg", "nginx", "redis", "mysql", "kafka"].map((s) => `metric.unmapped:${s}`));
    expect(p).toMatchObject({ by: "jev", label: JEV_LABEL, model: "jev-test-1", confidence: 0.8, gap: { key: "metric.unmapped:redis" } });
    expect(p!.candidates).toHaveLength(5);
  });

  it("falls back to the deterministic first gap on network errors: Jev steers, it never stops the loop", async () => {
    const t = throwingFetch();
    const p = await pickGapWithJev(ranked, jevWith(t.f));
    expect(p).toMatchObject({ by: "deterministic", gap: { key: "metric.unmapped:pg" } });
    expect(p!.note).toMatch(/Jev unavailable.*ECONNREFUSED/);
    expect(t.count()).toBe(1);
  });

  it("returns null with no actionable gap and skips Jev with a single candidate", async () => {
    const { f, calls } = fakeJev(() => ({}));
    expect(await pickGapWithJev([gap("tag.unmapped", 1, false)], jevWith(f))).toBeNull();
    expect(await pickGapWithJev([gap("metric.unmapped:pg", 1)], jevWith(f))).toMatchObject({ by: "deterministic" });
    expect(calls).toHaveLength(0);
  });
});

describe("J3: evidence reviewer scores new rows 0-3 and flags < 1.5", () => {
  const before = `version: 1\nintegration: postgresql\nmetrics:\n  postgresql.old: {otel: "postgresql.old", ddKind: gauge, otelKind: gauge, status: exact, note: "old"}\n  postgresql.changed: {otel: "x", ddKind: gauge, otelKind: gauge, status: exact, note: "v1"}\n`;
  const after = `version: 1\nintegration: postgresql\nmetrics:\n  postgresql.old: {otel: "postgresql.old", ddKind: gauge, otelKind: gauge, status: exact, note: "old"}\n  postgresql.changed: {otel: "x", ddKind: gauge, otelKind: gauge, status: exact, note: "v2"}\n  postgresql.a: {otel: "a", ddKind: gauge, otelKind: gauge, status: exact, note: "n"}\n  postgresql.b: {otel: "b", ddKind: gauge, otelKind: gauge, status: approximate, note: "n"}\n`;

  it("finds new and changed rows only", () => {
    expect(newMappingRows(before, after)).toEqual(["postgresql.changed", "postgresql.a", "postgresql.b"]);
    expect(newMappingRows(null, after)).toHaveLength(4);
  });

  it("flags exactly the rows scoring below the threshold", async () => {
    expect(EVIDENCE_FLAG_BELOW).toBe(1.5);
    const scores: Record<string, number> = { "postgresql.changed": 1.5, "postgresql.a": 1.49, "postgresql.b": 2.7 };
    const { f, calls } = fakeJev((_id, q) => ({ type: "score", score: scores[/Datadog '([^']+)'/.exec(q.instructions)![1]!], confidence: 0.7, probabilities: {} }));
    const e = await scoreEvidence(after, jevWith(f), newMappingRows(before, after));
    expect(calls[0].questions.r0.criteria).toHaveLength(4); // 0..3
    expect(e.rows.map((r) => [r.metric, r.flagged])).toEqual([["postgresql.changed", false], ["postgresql.a", true], ["postgresql.b", false]]);
    expect(e).toMatchObject({ label: JEV_LABEL, threshold: 1.5, flagged: ["postgresql.a"] });
    expect(evidenceNote("mappings/datadog/postgresql.yaml", e)).toMatch(/suggestion \(Jev\)[\s\S]*FLAG postgresql\.a[\s\S]*1 row\(s\) flagged/);
  });

  it("returns a skipped review (no throw) when Jev fails", async () => {
    const e = await scoreEvidence(after, jevWith(throwingFetch().f));
    expect(e.rows).toEqual([]);
    expect(e.skipped).toMatch(/Jev unavailable/);
    expect(evidenceNote("f.yaml", e)).toMatch(/skipped/);
  });
});

describe("J1: review-priority.json sidecar", () => {
  it("scores non-exact items into an id -> score map, most urgent first, tied to the report hash", async () => {
    const item = (id: string, status: string) => ({ id, kind: "panel", title: id, widget_type: "timeseries", status, source_queries: ["avg:x{*}"], promql: ["x"], findings: [], certificate: { assumptions: [] } });
    const report = { run: { outputHash: "h1" }, items: [item("a", "exact"), item("b", "bounded"), item("c", "manual")] };
    const { f } = fakeJev((_id, q) => ({ type: "score", score: q.instructions.includes("'manual'") ? 2.9 : 1.1, confidence: 0.9, probabilities: {} }));
    const p = await reviewPriority(report, jevWith(f));
    expect(p).toMatchObject({ label: JEV_LABEL, generatedBy: "jev", model: "jev-test-1", reportOutputHash: "h1", scores: { b: 1.1, c: 2.9 } });
    expect(Object.keys(p.scores).sort()).toEqual(["b", "c"]);
    expect(p.items.map((i) => [i.id, i.level])).toEqual([["c", "Review first"], ["b", "Worth a look"]]);
    expect(p.scale).toHaveLength(4);
  });
});

describe("boundary: src/ never imports tools/ (Jev stays out of the translation path)", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
  it("no file under src/ references tools/ or tools/jev", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((f) => /\.(ts|tsx|js|mjs|cjs|json)$/.test(f))
      .filter((f) => /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*\btools\//.test(readFileSync(f, "utf8")) || /typesafe|jev\//i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
