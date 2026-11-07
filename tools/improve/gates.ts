// The mechanical gates a candidate change must pass. Pure functions over two snapshots, plus the command results.
// No model judges anything here: a change is accepted only if every gate holds.
import { gapKey, gapSize } from "./gaps.js";
import type { Snapshot } from "./snapshot.js";

/** Lower is better. "unsupported" is a placeholder panel (report-only status). */
export const RANK: Record<string, number> = { exact: 0, "exact-under": 1, bounded: 2, manual: 3, unsupported: 4 };

export interface GateResult {
  ok: boolean;
  gates: { name: string; ok: boolean; detail: string }[];
  gapBefore: number;
  gapAfter: number;
  /** In-gap items that got worse only because a metric was mapped to "no equivalent". */
  honestDowngrades: string[];
}

export interface CommandResults {
  typecheck: { ok: boolean; tail: string };
  tests: { ok: boolean; tail: string };
  /** Two migrate runs of the candidate gave the same output hash. */
  deterministic: boolean;
}

/** Files an agent may touch in v0. Everything else is out of scope and fails the gate. */
export function allowedPath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  if (n.includes("..")) return false;
  if (/^mappings\/datadog\/[a-z0-9_-]+\.yaml$/.test(n)) return n !== "mappings/datadog/redisdb.yaml"; // redisdb.yaml is generated
  if (n === "mappings/tags.yaml") return true;
  return /^tests\/improve\/gen-[a-z0-9_-]+\.test\.ts$/.test(n);
}

export function evaluate(before: Snapshot, after: Snapshot, gap: string, changed: string[], cmd: CommandResults): GateResult {
  const gates: GateResult["gates"] = [];
  const gate = (name: string, ok: boolean, detail: string) => gates.push({ name, ok, detail });

  const bad = changed.filter((p) => !allowedPath(p));
  gate("scope", changed.length > 0 && bad.length === 0, bad.length ? `outside the allowed files: ${bad.join(", ")}` : changed.length ? `${changed.length} file(s): ${changed.join(", ")}` : "no files changed");
  gate("typecheck", cmd.typecheck.ok, cmd.typecheck.ok ? "clean" : cmd.typecheck.tail);
  gate("tests", cmd.tests.ok, cmd.tests.ok ? "all green" : cmd.tests.tail);
  gate("determinism", cmd.deterministic, cmd.deterministic ? "two runs, same output hash" : "two runs gave different output");

  // No regression: no item gets a worse status; items the gap didn't touch keep their exact output.
  const inGap = new Set(before.items.filter((i) => i.findings.some((f) => gapKey(f.code, f.message).key === gap)).map((i) => i.id));
  const afterBy = new Map(after.items.map((i) => [i.id, i]));
  const worse: string[] = [];
  const drifted: string[] = [];
  const lost: string[] = [];
  const honest: string[] = [];
  for (const b of before.items) {
    const a = afterBy.get(b.id);
    if (!a) {
      lost.push(b.id);
      continue;
    }
    if ((RANK[a.status] ?? 9) > (RANK[b.status] ?? 9)) {
      // An item in the gap may get worse only by an honest "no equivalent" (the old status rested on the guess
      // that the Datadog name exists in Dash0). Those are listed for the reviewer, not hidden.
      if (inGap.has(b.id) && a.findings.some((f) => f.code === "metric.no_equivalent")) honest.push(`${b.id}: ${b.status} -> ${a.status}`);
      else worse.push(`${b.id}: ${b.status} -> ${a.status}`);
    }
    if (!inGap.has(b.id) && a.outputHash !== b.outputHash) drifted.push(b.id);
  }
  gate(
    "no-regression",
    worse.length === 0 && lost.length === 0,
    worse.length || lost.length
      ? [...worse, ...lost.map((x) => `${x}: missing`)].slice(0, 10).join("; ")
      : honest.length
        ? `no item got worse except ${honest.length} now marked "no equivalent" (review these): ${honest.slice(0, 5).join("; ")}`
        : "no item got worse",
  );
  gate("untouched-stable", drifted.length === 0, drifted.length ? `${drifted.length} item(s) outside the gap changed output: ${drifted.slice(0, 5).join(", ")}` : "items outside the gap are byte-identical");

  // Progress: the targeted gap shrinks, and overall coverage doesn't drop.
  const gapBefore = gapSize(before, gap);
  const gapAfter = gapSize(after, gap);
  gate("progress", gapAfter < gapBefore, `${gap}: ${gapBefore} -> ${gapAfter} finding(s)`);
  const kept = after.coverageExact >= before.coverageExact && after.coverageTranslated >= before.coverageTranslated;
  gate(
    "coverage",
    kept || (worse.length === 0 && honest.length > 0),
    `exact ${before.coverageExact} -> ${after.coverageExact}, translated ${before.coverageTranslated} -> ${after.coverageTranslated}${kept ? "" : " (drop explained by the no-equivalent items above)"}`,
  );

  return { ok: gates.every((g) => g.ok), gates, gapBefore, gapAfter, honestDowngrades: honest };
}
