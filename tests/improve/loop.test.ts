// tools/improve: the deterministic parts of the improvement loop (gap picking, gates) and the boundary that keeps
// the model out of the migrator. No model is called here.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findGaps, gapKey, gapSize, pickGap } from "../../tools/improve/gaps.js";
import { allowedPath, evaluate, type CommandResults } from "../../tools/improve/gates.js";
import type { Snapshot, SnapshotItem } from "../../tools/improve/snapshot.js";

const ROOT = join(import.meta.dirname, "..", "..");
const unmapped = (m: string) => ({ status: "exact-under", code: "metric.unmapped", message: `no mapping for ${m}; kept the Datadog name and assumed a gauge` });
const item = (id: string, status: string, findings: SnapshotItem["findings"] = [], outputHash: string | null = `h-${id}`): SnapshotItem => ({ id, status, outputHash, findings });
const snap = (items: SnapshotItem[], cov = [0.5, 0.6]): Snapshot => ({ coverageExact: cov[0]!, coverageTranslated: cov[1]!, outputHash: "x", items });
const OK: CommandResults = { typecheck: { ok: true, tail: "" }, tests: { ok: true, tail: "" }, deterministic: true };

const before = snap([
  item("a", "exact-under", [unmapped("postgresql.rows_fetched")]),
  item("b", "exact-under", [unmapped("postgresql.connections"), unmapped("postgresql.max_connections")]),
  item("c", "exact-under", [unmapped("nginx.net.reading")]),
  item("d", "manual", [{ status: "manual", code: "fn.anomalies", message: "anomalies() has no PromQL equivalent" }]),
  item("e", "exact"),
]);

describe("gap picking", () => {
  it("groups unmapped metrics by integration prefix", () => {
    expect(gapKey("metric.unmapped", "no mapping for postgresql.rows_fetched; kept ...")).toEqual({ key: "metric.unmapped:postgresql", scope: "postgresql" });
    expect(gapKey("fn.anomalies", "x")).toEqual({ key: "fn.anomalies", scope: null });
  });

  it("ranks gaps by weighted item count, deterministically", () => {
    const gaps = findGaps(before);
    expect(gaps.map((g) => g.key)).toEqual(["fn.anomalies", "metric.unmapped:postgresql", "metric.unmapped:nginx"]);
    expect(gaps[1]).toMatchObject({ items: ["a", "b"], score: 2, actionable: true });
    expect(findGaps(before)).toEqual(gaps);
  });

  it("picks the biggest actionable gap, skipping ones already tried", () => {
    expect(pickGap(before)?.key).toBe("metric.unmapped:postgresql");
    expect(pickGap(before, new Set(["metric.unmapped:postgresql"]))?.key).toBe("metric.unmapped:nginx");
    expect(pickGap(snap([item("e", "exact")]))).toBeNull();
    expect(gapSize(before, "metric.unmapped:postgresql")).toBe(3);
  });
});

describe("gates", () => {
  const gate = (r: ReturnType<typeof evaluate>, name: string) => r.gates.find((g) => g.name === name)!;
  const mapped = snap([
    item("a", "exact", [], "h-a2"),
    item("b", "exact-under", [unmapped("postgresql.max_connections")], "h-b2"),
    item("c", "exact-under", [unmapped("nginx.net.reading")]),
    item("d", "manual", [{ status: "manual", code: "fn.anomalies", message: "anomalies() has no PromQL equivalent" }]),
    item("e", "exact"),
  ], [0.55, 0.6]);

  it("accept a change that shrinks the gap and leaves everything else byte-identical", () => {
    const r = evaluate(before, mapped, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml", "tests/improve/gen-postgresql.test.ts"], OK);
    expect(r.ok).toBe(true);
    expect([r.gapBefore, r.gapAfter]).toEqual([3, 1]);
  });

  it("reject edits outside the allowed files, failing commands, or nondeterminism", () => {
    expect(gate(evaluate(before, mapped, "metric.unmapped:postgresql", ["src/translate/query/lower.ts"], OK), "scope").ok).toBe(false);
    expect(gate(evaluate(before, mapped, "metric.unmapped:postgresql", [], OK), "scope").ok).toBe(false);
    expect(evaluate(before, mapped, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], { ...OK, tests: { ok: false, tail: "1 failed" } }).ok).toBe(false);
    expect(evaluate(before, mapped, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], { ...OK, deterministic: false }).ok).toBe(false);
  });

  it("reject a change that alters an item outside the gap, or makes any item worse", () => {
    const drift = snap(mapped.items.map((i) => (i.id === "c" ? { ...i, outputHash: "changed" } : i)), [0.55, 0.6]);
    expect(gate(evaluate(before, drift, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK), "untouched-stable").ok).toBe(false);
    const worse = snap(mapped.items.map((i) => (i.id === "e" ? { ...i, status: "bounded" } : i)), [0.55, 0.6]);
    expect(gate(evaluate(before, worse, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK), "no-regression").ok).toBe(false);
  });

  it("reject a change that doesn't shrink the gap", () => {
    expect(gate(evaluate(before, before, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK), "progress").ok).toBe(false);
  });

  it("allow an in-gap item to drop only by an honest 'no equivalent', and list it", () => {
    const none = snap([
      ...mapped.items.filter((i) => i.id !== "a"),
      item("a", "unsupported", [{ status: "manual", code: "metric.no_equivalent", message: "postgresql.rows_fetched has no OTel equivalent" }], null),
    ], [0.45, 0.55]);
    const r = evaluate(before, none, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK);
    expect(r.ok).toBe(true);
    expect(r.honestDowngrades).toEqual(["a: exact-under -> unsupported (no equivalent / derived)"]);
    // The same drop without the no-equivalent finding is a regression.
    const bad = snap(none.items.map((i) => (i.id === "a" ? { ...i, findings: [] } : i)), [0.45, 0.55]);
    expect(evaluate(before, bad, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK).ok).toBe(false);
  });

  it("allow an in-gap guess to be replaced by an honest approximate row (to bounded), but not to drop further", () => {
    const approx = { status: "bounded", code: "metric.approximate", message: "postgresql.rows_fetched -> postgresql.tup_fetched is approximate" };
    const toBounded = snap([...mapped.items.filter((i) => i.id !== "a"), item("a", "bounded", [approx], "h-a3")], [0.45, 0.6]);
    const r = evaluate(before, toBounded, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK);
    expect(r.ok).toBe(true);
    expect(r.honestDowngrades).toEqual(["a: exact-under -> bounded (guess replaced by a researched mapping)"]);
    // Dropping to manual without saying why is still a regression, even though the guess is gone.
    const toManual = snap(toBounded.items.map((i) => (i.id === "a" ? { ...i, status: "manual" } : i)), [0.45, 0.55]);
    expect(evaluate(before, toManual, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK).ok).toBe(false);
    // An item outside the gap may never get worse.
    const outside = snap(toBounded.items.map((i) => (i.id === "c" ? { ...i, status: "bounded" } : i)), [0.45, 0.6]);
    expect(evaluate(before, outside, "metric.unmapped:postgresql", ["mappings/datadog/postgresql.yaml"], OK).ok).toBe(false);
  });

  it("allowedPath: mapping tables (not the generated redisdb.yaml) and generated tests only", () => {
    expect(allowedPath("mappings/datadog/postgresql.yaml")).toBe(true);
    expect(allowedPath("mappings/tags.yaml")).toBe(true);
    expect(allowedPath("tests/improve/gen-postgresql.test.ts")).toBe(true);
    for (const p of ["mappings/datadog/redisdb.yaml", "mappings/datadog/_kinds.json", "src/cli.ts", "tests/improve/loop.test.ts", "mappings/datadog/../../src/x.yaml", "package.json"])
      expect(allowedPath(p), p).toBe(false);
  });
});

describe("boundary: no model in the translation path", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

  it("nothing under src/ imports tools/ (the loop, Jev) or the Anthropic SDK", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /from\s+["'][^"']*(tools\/improve|@anthropic-ai\/sdk)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the SDK is a dev dependency only", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(pkg.devDependencies?.["@anthropic-ai/sdk"]).toBeDefined();
  });
});
