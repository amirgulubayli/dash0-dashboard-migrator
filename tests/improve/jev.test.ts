// tools/jev (plan 08) offline: the client caches by request hash and validates answers; the uses fall back or flag
// as designed. Jev itself is mocked: no network, no key.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev, canonical, hashRequest } from "../../tools/jev/client.js";
import { pickGapWithJev, reviewPriority, scoreEvidence } from "../../tools/jev/uses.js";
import type { Gap } from "../../tools/improve/gaps.js";

const reply = (answers: Record<string, unknown>, status = 200) =>
  (async () => new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status })) as unknown as typeof fetch;
const counted = (answers: (body: any) => Record<string, unknown>) => {
  let calls = 0;
  const f = (async (_u: string, init: { body: string }) => {
    calls++;
    return new Response(JSON.stringify({ model: "jev-test", answers: answers(JSON.parse(init.body)) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
};
const dir = () => mkdtempSync(join(tmpdir(), "jev-test-"));
const gap = (key: string, score: number): Gap => ({ key, code: "metric.unmapped", scope: key.split(":")[1] ?? null, items: ["a"], examples: [], subjects: [`${key}.x`], score, actionable: true });

describe("Jev client", () => {
  it("hashes requests canonically (key order doesn't matter)", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const q = { x: { type: "choice" as const, instructions: "i", criteria: { a: "A", b: "B" } } };
    expect(hashRequest("s", q)).toBe(hashRequest("s", { x: { criteria: { b: "B", a: "A" }, instructions: "i", type: "choice" as const } }));
  });

  it("caches answers on disk and reuses them without calling Jev", async () => {
    const cacheDir = dir();
    const c = counted(() => ({ x: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }));
    const q = { x: { type: "choice" as const, instructions: "i", criteria: { a: "A", b: "B" } } };
    const first = await askJev("s", q, { apiKey: "k", cacheDir, fetchImpl: c.f });
    const second = await askJev("s", q, { apiKey: "k", cacheDir, fetchImpl: c.f });
    expect([first.cached, second.cached, c.calls()]).toEqual([false, true, 1]);
    expect(second.answers.x.choice).toBe("a");
    expect(second.model).toBe("jev-test");
    expect(readdirSync(cacheDir)).toEqual([`${first.inputHash}.json`]);
  });

  it("rejects missing keys, HTTP errors and answers that don't fit the question", async () => {
    const q = { x: { type: "choice" as const, instructions: "i", criteria: { a: "A" } } };
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    await expect(askJev("s", q, { cacheDir: dir() })).rejects.toThrow(/TYPESAFE_API_KEY/);
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    await expect(askJev("s", q, { apiKey: "k", cacheDir: dir(), fetchImpl: reply({}, 401) })).rejects.toThrow(/HTTP 401/);
    await expect(askJev("s", q, { apiKey: "k", cacheDir: dir(), fetchImpl: reply({ x: { type: "choice", choice: "zzz", confidence: 1, probabilities: {} } }) })).rejects.toThrow(/unknown option/);
    await expect(askJev("s", q, { apiKey: "k", cacheDir: dir(), fetchImpl: reply({}) })).rejects.toThrow(/no choice answer/);
  });
});

describe("J2: gap picker", () => {
  const ranked = [gap("metric.unmapped:postgresql", 30), gap("metric.unmapped:nginx", 10), gap("tag.unmapped", 18)];

  it("takes Jev's choice among the top deterministic gaps", async () => {
    const p = await pickGapWithJev(ranked, 5, { apiKey: "k", cacheDir: dir(), fetchImpl: reply({ gap: { type: "choice", choice: "metric.unmapped:nginx", confidence: 0.8, probabilities: { "metric.unmapped:nginx": 0.8 } } }) });
    expect(p).toMatchObject({ by: "jev", model: "jev-test", gap: { key: "metric.unmapped:nginx" } });
  });

  it("falls back to the deterministic first gap when Jev fails: Jev steers, it never stops the loop", async () => {
    const p = await pickGapWithJev(ranked, 5, { apiKey: "k", cacheDir: dir(), fetchImpl: reply({}, 500) });
    expect(p).toMatchObject({ by: "deterministic", gap: { key: "metric.unmapped:postgresql" } });
    expect(p!.note).toMatch(/Jev unavailable/);
  });
});

describe("J3: evidence scores", () => {
  const yaml = `version: 1
integration: postgresql
metrics:
  postgresql.max_connections: {otel: "postgresql.connection.max", ddKind: gauge, otelKind: gauge, status: exact, note: "same setting"}
  postgresql.locks: {otel: "postgresql.database.locks", ddKind: gauge, otelKind: gauge, status: exact, note: "different scope"}
  postgresql.replication_delay: {otel: null, ddKind: gauge, otelKind: null, status: none, note: "no match"}
`;
  it("scores every row and flags exact claims with weak evidence (and 'none' with a likely match)", async () => {
    const scores = [3, 1.2, 2.8];
    const f = counted((b) => Object.fromEntries(Object.keys(b.questions).map((id, i) => [id, { type: "score", score: scores[i], confidence: 0.7, legend: {}, probabilities: {} }])));
    const e = await scoreEvidence(yaml, { apiKey: "k", cacheDir: dir(), fetchImpl: f.f });
    expect(e.rows.map((r) => [r.metric, r.flag !== null])).toEqual([
      ["postgresql.max_connections", false],
      ["postgresql.locks", true],
      ["postgresql.replication_delay", true],
    ]);
  });
});

describe("J1: review priority", () => {
  it("ranks non-exact items, skips exact ones, and ties the result to the report hash", async () => {
    const item = (id: string, status: string) => ({ id, kind: "panel", title: id, widget_type: "timeseries", status, source_queries: ["avg:x{*}"], promql: ["x"], findings: [], certificate: { assumptions: [] } });
    const report = { run: { outputHash: "h1" }, items: [item("a", "exact"), item("b", "bounded"), item("c", "manual")] };
    const f = counted((b) => Object.fromEntries(Object.keys(b.questions).map((id, i) => [id, { type: "score", score: i === 0 ? 1 : 3, confidence: 0.9, legend: {}, probabilities: {} }])));
    const p = await reviewPriority(report, { apiKey: "k", cacheDir: dir(), fetchImpl: f.f });
    expect(p.reportOutputHash).toBe("h1");
    expect(p.items.map((i) => i.id)).toEqual(["c", "b"]);
    expect(p.items[0]!.level).toBe("Review first");
  });
});
