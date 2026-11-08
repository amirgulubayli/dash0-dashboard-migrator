// Plan 10 tooling (tools/gaps, tools/gate, tools/recurse): the pure parts, on small synthetic inputs. Fast, no network,
// no migrate run, no model.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildGaps, integrationOf, renderMarkdown, upgradeCandidates, type CatalogRule, type GapContext } from "../../tools/gaps/gaps.js";
import { fileGate } from "../../tools/gate/main.js";
import { checkDeterminism, checkM1, checkM2, checkNoRegression, compareClaims, namesRule, parseAllowDowngrade } from "../../tools/gate/checks.js";
import { ownerName, overlaps, parseOwners } from "../../tools/lib/notes.js";
import { CLAIM_ORDER, claimOf, claimRank, stableJson, type GapItem, type GapReport } from "../../tools/lib/report.js";
import { brief, hubText, roundPlan } from "../../tools/recurse/plan.js";

const ROOT = join(import.meta.dirname, "..", "..");

const NOTES = `
## Owners
| Area (fork paths) | Owner | Backup |
|---|---|---|
| T4 query (\`src/translate/query/**\`) | Ali | Amir |
| T5 log paths (\`src/translate/dashboard/**\` log paths) | Ali | Amir |
| T5 rest (\`src/translate/dashboard/**\` rest) | Amir | Michael |
| T1 mappings (\`mappings/**\`) | Ali | Amir |
| T17 catalog (\`src/rules/**\`) | Michael | Ali |

## Next section
`;

const rule = (id: string, status: string, o: Partial<CatalogRule> = {}): CatalogRule => ({ id, status, state: "implemented", priority: 10, owner: "T4", match: id, emit: id, requires: [], ...o });
const RULES: CatalogRule[] = [
  rule("select.metric.approximate", "bounded", { epsilon: "per row" }),
  rule("metric.unmapped", "exact-under"),
  rule("metric.derived", "manual", { emit: "no output until select.metric.derived ships" }),
  rule("select.metric.derived", "exact-under", { state: "planned", note: "Replaces metric.derived." }),
  rule("fn.anomalies", "manual", { emit: "no output: no PromQL counterpart (maths.md §9.5)" }),
  rule("widget.toplist.unranked", "exact-under", { owner: "T5", note: "widget.toplist replaces it once fn.top.window ships" }),
  rule("fn.top.window", "exact-under", { state: "planned", requires: ["probe:range-var"] }),
  rule("time.as_count.counter", "bounded", { epsilon: "T3b" }),
  rule("time.as_count.counter.anchored", "exact-under", { state: "planned", requires: ["probe:anchored"], note: "beats time.as_count.counter once Dash0 accepts anchored" }),
  rule("alert.threshold.recovery", "manual", { owner: "T6", emit: "no output: value hysteresis has no Dash0 form" }),
  rule("panel.style", "exact-under", { owner: "T5" }),
];
const ctx: GapContext = {
  rules: RULES,
  probes: { "probe:anchored": { question: "anchored?", answer: "open" }, "probe:range-var": { question: "$__range?", answer: "yes" } },
  catalogFile: { "select.metric.derived": "src/rules/catalog/query.ts", "time.as_count.counter.anchored": "src/rules/catalog/query.ts" },
  resolve: (code) => RULES.find((r) => r.id === code || r.findingCode === code)?.id,
  mappingTables: [
    { file: "mappings/datadog/postgresql.yaml", prefixes: ["postgresql"] },
    { file: "mappings/datadog/redisdb.yaml", prefixes: ["redis"], generatedBy: "scripts/build-redis-mapping.mjs" },
  ],
  owners: parseOwners(NOTES),
};

const f = (status: string, code: string, message: string, ruleId?: string) => ({ status, code, message, ...(ruleId && { ruleId }) });
const item = (id: string, status: string, findings: GapItem["findings"], extra: Partial<GapItem> = {}): GapItem => ({ id, kind: "panel", status, findings, certificate: { outputHash: `h-${id}`, rules: [] }, ...extra });

const REPORT: GapReport = {
  run: { outputHash: "abc" },
  items: [
    item("p1", "bounded", [f("bounded", "metric.approximate", "postgresql.rows_fetched -> postgresql.tup_fetched is approximate", "select.metric.approximate"), f("exact-under", "panel.style", "style")]),
    item("p2", "bounded", [f("bounded", "metric.approximate", "postgresql.locks -> postgresql.database.locks is approximate", "select.metric.approximate")]),
    item("r1", "manual", [f("manual", "metric.derived", "redis.mem.fragmentation: an expression over several metrics"), f("bounded", "metric.approximate", "redis.x -> y")]),
    item("r2", "bounded", [f("bounded", "metric.approximate", "redis.net.commands -> redis.commands.processed")]),
    item("a1", "manual", [f("manual", "fn.anomalies", "no exact rule for anomalies()")]),
    item("t1", "bounded", [f("exact-under", "widget.toplist.unranked", "toplist without ranking")], { certificate: { outputHash: "h", rules: ["time.as_count.counter", "widget.toplist.unranked"] } }),
    item("m1", "manual", [f("manual", "monitor.option", "critical_recovery has no Dash0 form", "alert.threshold.recovery"), f("manual", "metric.derived", "postgresql.percent_usage_connections: expression")]),
    item("ok", "exact", []),
    item("eu", "exact-under", [f("exact-under", "widget.toplist.unranked", "toplist")]),
    { id: "g", kind: "group", status: "exact", findings: [] },
  ],
};

describe("claim order (read from src/ir worst(), as the catalog's compose() uses it)", () => {
  it("is exact > exact-under > bounded > manual, and a placeholder (unsupported) claims manual", () => {
    expect(CLAIM_ORDER).toEqual(["exact", "exact-under", "bounded", "manual"]);
    expect(claimOf("unsupported")).toBe("manual");
    expect(claimRank("unsupported")).toBe(claimRank("manual"));
    expect(claimRank("nonsense")).toBeGreaterThan(claimRank("manual"));
  });
});

describe("tools/gaps: gap tree and levers", () => {
  const doc = buildGaps([{ label: "fixtures", report: REPORT }], ctx, { round: 2 });
  const lever = (key: string) => doc.levers.find((l) => l.key === key)!;
  const leaf = (key: string) => doc.tree.flatMap((n) => n.leaves).find((l) => l.key === key)!;

  it("roots at items weaker than exact-under, and groups by the binding finding only", () => {
    expect(doc.root).toMatchObject({ items: 9, inGap: 7, byStatus: { bounded: 4, manual: 3 } });
    // p1's exact-under panel.style finding is not why it is bounded; r1's bounded finding is not why it is manual.
    expect(leaf("metric.approximate:postgresql").items).toEqual(["p1", "p2"]);
    expect(leaf("metric.approximate:redis").items).toEqual(["r2"]);
    expect(doc.tree.flatMap((n) => n.leaves).some((l) => l.code === "panel.style")).toBe(false);
  });

  it("falls back to certificate rules when no finding is at the item's level", () => {
    expect(leaf("time.as_count.counter").items).toEqual(["t1"]);
  });

  it("proposes levers from the catalog: mapping, rule, probe, contract, impossible", () => {
    expect(lever("mapping:mappings/datadog/postgresql.yaml")).toMatchObject({ kind: "mapping", items: ["p1", "p2"], upgradesAlone: ["p1", "p2"], owner: "Ali", files: ["mappings/datadog/postgresql.yaml"] });
    expect(lever("mapping:mappings/datadog/redisdb.yaml").why).toMatch(/generated: change scripts\/build-redis-mapping\.mjs/);
    expect(lever("rule:select.metric.derived")).toMatchObject({ kind: "rule", items: ["m1", "r1"], upgradesAlone: ["r1"], catalogRows: ["src/rules/catalog/query.ts#select.metric.derived"] });
    expect(lever("probe:anchored")).toMatchObject({ kind: "probe", items: ["t1"] });
    expect(lever("impossible:fn.anomalies")).toMatchObject({ kind: "impossible", owner: "-" });
    expect(lever("contract:alert.threshold.recovery")).toMatchObject({ kind: "contract", owner: "Michael", upgradesAlone: [] });
  });

  it("upgrade candidates are stronger rules tied by name, never weaker ones", () => {
    const tl = [...RULES, rule("widget.toplist", "exact-under", { owner: "T5", state: "planned", emit: "TimeSeriesTable (uses fn.top.window)" }), rule("panel.other", "exact-under", { note: "like widget.toplist.unranked" })];
    // Same claim counts only when stated as a replacement (fewer assumptions); a mere mention does not.
    expect(upgradeCandidates(tl.find((r) => r.id === "widget.toplist.unranked")!, tl).map((r) => r.id)).toEqual(["widget.toplist"]);
    expect(upgradeCandidates(tl.find((r) => r.id === "panel.style")!, tl).map((r) => r.id)).toEqual([]);
    expect(upgradeCandidates(RULES.find((r) => r.id === "metric.derived")!, RULES).map((r) => r.id)).toEqual(["select.metric.derived"]);
  });

  it("puts file-disjoint delegable levers in the same wave, and nothing else", () => {
    const delegable = doc.levers.filter((l) => l.kind === "mapping" || l.kind === "rule");
    expect(doc.waves.flat().sort()).toEqual(delegable.map((l) => l.key).sort());
    for (const w of doc.waves) {
      const files = w.flatMap((k) => lever(k).files);
      for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) expect(overlaps(files[i]!, files[j]!)).toBe(false);
    }
    const two = buildGaps([{ label: "fixtures", report: { items: [item("x", "manual", [f("manual", "metric.derived", "nginx.a: expr")]), item("y", "bounded", [f("bounded", "metric.approximate", "postgresql.b -> c")])] } }], { ...ctx, mappingTables: [] }, {});
    expect(two.waves.length).toBe(1);
  });

  it("is deterministic: same input, same bytes, regardless of item order", () => {
    const shuffled: GapReport = { ...REPORT, items: [...REPORT.items].reverse() };
    expect(stableJson(buildGaps([{ label: "fixtures", report: shuffled }], ctx, { round: 2 }))).toBe(stableJson(doc));
    expect(renderMarkdown(doc)).toBe(renderMarkdown(buildGaps([{ label: "fixtures", report: REPORT }], ctx, { round: 2 })));
    expect(stableJson(doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("--include-exact-under widens the root; in-flight levers stay out of the waves", () => {
    expect(buildGaps([{ label: "fixtures", report: REPORT }], ctx, { includeExactUnder: true }).root.inGap).toBe(8);
    const fl = buildGaps([{ label: "fixtures", report: REPORT }], ctx, { inFlight: ["rule:select.metric.derived"] });
    expect(fl.waves.flat()).not.toContain("rule:select.metric.derived");
  });

  it("integration prefix of a metric message", () => {
    expect(integrationOf("postgresql.rows_fetched -> postgresql.tup_fetched is approximate")).toBe("postgresql");
    expect(integrationOf("no dotted name here")).toBeNull();
  });
});

describe("tools/gate: M1 and M2 (plan 09 §4)", () => {
  const cat = [
    { id: "a.bounded", status: "bounded", epsilon: "T3b" },
    { id: "b.bounded", status: "bounded" },
    { id: "c.tested", status: "bounded", epsilon: "x" },
    { id: "d.pending", status: "bounded", epsilon: "y" },
    { id: "e.exact", status: "exact" },
  ];
  const prop = (text: string) => ({ path: "tests/semantics/p.test.ts", text: `import fc from "fast-check";\n${text}` });

  it("M1 fails a bounded rule with no ε", () => {
    expect(checkM1(cat)).toEqual({ ok: false, missing: ["b.bounded"] });
    expect(checkM1(cat.filter((r) => r.id !== "b.bounded")).ok).toBe(true);
  });

  it("M2: tested by id in a fast-check file, else pending, else fail; stale entries fail", () => {
    const r = checkM2(cat, [prop("// rule c.tested: the bound holds")], [{ id: "d.pending", reason: "proof only" }]);
    expect(r).toMatchObject({ ok: false, covered: ["c.tested"], pending: ["d.pending"], unlisted: ["a.bounded"], stale: [] });
    expect(checkM2(cat, [prop("c.tested")], [{ id: "a.bounded", reason: "r" }, { id: "d.pending", reason: "r" }]).ok).toBe(true);
    // Listed but now tested (or no ε any more): stale, the list must only shrink.
    expect(checkM2(cat, [prop("c.tested d.pending")], [{ id: "a.bounded", reason: "r" }, { id: "d.pending", reason: "r" }, { id: "e.exact", reason: "r" }]).stale).toEqual(["d.pending", "e.exact"]);
    // A mention in a file that is not a property test does not count.
    expect(checkM2(cat, [{ path: "tests/semantics/u.test.ts", text: "c.tested" }], []).covered).toEqual([]);
  });

  it("rule ids match as whole tokens", () => {
    expect(namesRule("rule time.rollup.counter.", "time.rollup.counter")).toBe(true);
    expect(namesRule("rule time.rollup.counter emits", "time.rollup")).toBe(false);
    expect(namesRule("(T4, rule time.rollup.counter)", "time.rollup.counter")).toBe(true);
  });

  it("the real catalog passes M1, and m2-pending.json lists real ε rules only", async () => {
    const { CATALOG } = await import("../../src/rules/index.js");
    expect(checkM1(CATALOG).ok).toBe(true);
    const pending = JSON.parse(readFileSync(join(ROOT, "tools", "gate", "m2-pending.json"), "utf8")).pending as { id: string; reason: string }[];
    const sem = readdirSync(join(ROOT, "tests", "semantics")).map((n) => ({ path: n, text: readFileSync(join(ROOT, "tests", "semantics", n), "utf8") }));
    const r = checkM2(CATALOG, sem, pending);
    expect({ unlisted: r.unlisted, stale: r.stale }).toEqual({ unlisted: [], stale: [] });
    for (const p of pending) expect(p.reason.length, p.id).toBeGreaterThan(10);
  });
});

describe("tools/gate: per-item no-regression", () => {
  const base = [item("a", "exact", []), item("b", "exact-under", []), item("c", "bounded", []), item("d", "manual", []), item("gone", "exact", [])];
  const cand = [item("a", "exact", []), item("b", "bounded", []), item("c", "exact-under", []), item("d", "unsupported", []), item("new", "manual", [])];

  it("catches a downgrade and a missing item, counts upgrades, and treats manual -> unsupported as the same claim", () => {
    const r = checkNoRegression(base, cand);
    expect(r.ok).toBe(false);
    expect(r.regressions).toEqual(["b: exact-under -> bounded", "gone: missing"]);
    expect(r.cmp.better).toEqual([{ id: "c", from: "bounded", to: "exact-under" }]);
    expect(r.cmp.added).toEqual(["new"]);
  });

  it("honours --allow-downgrade only for the named item, and reports unused allows", () => {
    const r = checkNoRegression(base, cand, [{ id: "b", reason: "guess replaced" }, { id: "gone", reason: "widget removed from fixture" }, { id: "zzz", reason: "typo" }]);
    expect(r.ok).toBe(true);
    expect(r.allowed).toEqual(["b: exact-under -> bounded (allowed: guess replaced)", "gone: missing (allowed: widget removed from fixture)"]);
    expect(r.unusedAllows).toEqual(["zzz"]);
    expect(checkNoRegression(base, cand, [{ id: "c", reason: "wrong item" }]).ok).toBe(false);
  });

  it("parses --allow-downgrade <id>:<reason> and refuses one without an id or a reason", () => {
    expect(parseAllowDowngrade("dd-dash-x/w-1:honest: no equivalent")).toEqual({ id: "dd-dash-x/w-1", reason: "honest: no equivalent" });
    expect(() => parseAllowDowngrade("dd-dash-x/w-1")).toThrow();
    expect(() => parseAllowDowngrade("dd-dash-x/w-1:  ")).toThrow();
    expect(() => parseAllowDowngrade(":reason")).toThrow();
  });

  it("lists items whose output changed, and ignores group rows", () => {
    const c = compareClaims([item("a", "exact", []), { id: "g", kind: "group", status: "exact", findings: [] }], [{ ...item("a", "exact", []), certificate: { outputHash: "other" } }]);
    expect(c.changedOutput).toEqual(["a"]);
    expect(c.lost).toEqual([]);
  });

  it("determinism compares the two report hashes", () => {
    expect(checkDeterminism("aa", "aa").status).toBe("pass");
    expect(checkDeterminism("aa", "bb").status).toBe("fail");
  });

  it("a test-file gate fails on failures unless --allow-fail names the file", () => {
    const v = {
      numFailedTests: 1,
      numPassedTests: 2,
      testResults: [
        { name: join(ROOT, "tests", "x.test.ts"), status: "passed", assertionResults: [{ status: "passed", fullName: "x" }, { status: "passed", fullName: "y" }] },
        { name: join(ROOT, "tests", "flow", "flow.test.ts"), status: "failed", assertionResults: [{ status: "failed", fullName: "saves 0600" }] },
      ],
    };
    expect(fileGate("suite", v, ROOT, () => true).status).toBe("fail");
    const ok = fileGate("suite", v, ROOT, () => true, ["tests/flow/flow.test.ts"]);
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/allowed to fail.*flow\.test\.ts/);
    expect(fileGate("L", v, ROOT, (p) => p === "tests/none.test.ts").status).toBe("fail");
  });
});

describe("tools/recurse: round plan and briefs", () => {
  const doc = buildGaps([{ label: "fixtures", report: REPORT }], ctx, { round: 2 });
  const o = { baseBranch: "feature/datadog-to-dash0", branchPrefix: "amir/claude" };

  it("is deterministic", () => {
    const again = buildGaps([{ label: "fixtures", report: { ...REPORT, items: [...REPORT.items].reverse() } }], ctx, { round: 2 });
    expect(roundPlan(again, o)).toBe(roundPlan(doc, o));
    for (let i = 0; i < doc.levers.length; i++) expect(brief(again, again.levers[i]!, o)).toBe(brief(doc, doc.levers[i]!, o));
    expect(hubText(again, o)).toBe(hubText(doc, o));
  });

  it("routes levers: waves for mapping/rule, the hub for probes and CONTRACTs, a stop for §9.5", () => {
    const plan = roundPlan(doc, o);
    expect(plan).toMatch(/wave 1: .*mapping:mappings\/datadog\/postgresql\.yaml/);
    expect(plan).toMatch(/To owners on the hub.*`probe:anchored` -> Ali/);
    expect(plan).toMatch(/Stopped \(no equivalent, maths\.md §9\.5\): `fn\.anomalies`/);
    const b = brief(doc, doc.levers.find((l) => l.key === "rule:select.metric.derived")!, o);
    expect(b).toMatch(/npm run gate -- --base-ref origin\/feature\/datadog-to-dash0/);
    expect(b).toMatch(/amir\/claude\/r2-select-metric-derived/);
    expect(b).toMatch(/A decomposition/);
    expect(brief(doc, doc.levers.find((l) => l.kind === "probe")!, o)).not.toMatch(/## Gates/);
  });
});

describe("owners (NOTES.md)", () => {
  it("parses the owners table and names both owners of a split area", () => {
    const rows = parseOwners(NOTES);
    expect(rows.map((r) => r.owner)).toEqual(["Ali", "Ali", "Amir", "Ali", "Michael"]);
    expect(ownerName(["mappings/datadog/nginx.yaml"], rows)).toBe("Ali");
    expect(ownerName(["src/translate/dashboard/**"], rows)).toBe("Ali or Amir");
    expect(ownerName(["src/rules/catalog/query.ts"], rows)).toBe("Michael");
    expect(ownerName(["nowhere/x.ts"], rows)).toBe("?");
  });
});

describe("boundary: the plan 10 tools call no model and src/ never imports tools/", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

  it("tools/gaps, gate, recurse and lib import neither the Anthropic SDK nor the improve agent", () => {
    const offenders = ["gaps", "gate", "recurse", "lib"]
      .flatMap((d) => files(join(ROOT, "tools", d)))
      .filter((p) => p.endsWith(".ts"))
      .filter((p) => /from\s+["'][^"']*(@anthropic-ai\/sdk|improve\/agent|tools\/jev)/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("nothing under src/ imports anything from tools/", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((p) => p.endsWith(".ts"))
      .filter((p) => /from\s+["'][^"']*\/tools\//.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
