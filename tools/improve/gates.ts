// The mechanical gates a candidate change must pass. Pure functions over two snapshots, plus the command results.
// No model judges anything here: a change is accepted only if every gate holds.
// The claim order and the per-item comparison are shared with tools/gate (plan 10 step 4), so both loops judge
// "worse" the same way: the order comes from src/ir worst() (tools/lib/report.ts), and unsupported (a placeholder) is
// a manual claim.
import { compareClaims } from "../gate/checks.js";
import { claimRank } from "../lib/report.js";
import { gapKey, gapSize } from "./gaps.js";
import type { Snapshot, SnapshotItem } from "./snapshot.js";

export interface GateResult {
  ok: boolean;
  gates: { name: string; ok: boolean; detail: string }[];
  gapBefore: number;
  gapAfter: number;
  /** In-gap items whose status dropped because a guess was replaced honestly (approximate, no equivalent, derived). */
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
  const cmp = compareClaims(before.items.map((i) => ({ ...i, kind: "item" })), after.items.map((i) => ({ ...i, kind: "item" })));
  const worse: string[] = [];
  const honest: string[] = [];
  const lost = cmp.lost;
  for (const w of cmp.worse) {
    const b = before.items.find((i) => i.id === w.id)!;
    const a = afterBy.get(w.id)!;
    // An item in the gap rested on a guess: that the Datadog name exists in Dash0 as a gauge (metric.unmapped,
    // exact-under). Replacing the guess with a researched row may honestly lower its claimed status:
    //  - to bounded or better, when its gap findings went down (an approximate mapping replaced the guess);
    //  - to anything, when the item now says why (metric.no_equivalent or metric.derived).
    // Every such item is listed for the reviewer, not hidden. Anything else is a regression.
    const gapFindings = (i: SnapshotItem) => i.findings.filter((f) => gapKey(f.code, f.message).key === gap).length;
    const says = a.findings.some((f) => f.code === "metric.no_equivalent" || f.code === "metric.derived");
    const replaced = gapFindings(a) < gapFindings(b) && claimRank(a.status) <= claimRank("bounded");
    if (inGap.has(b.id) && (says || replaced)) honest.push(`${b.id}: ${b.status} -> ${a.status}${says ? " (no equivalent / derived)" : " (guess replaced by a researched mapping)"}`);
    else worse.push(`${b.id}: ${b.status} -> ${a.status}`);
  }
  const drifted = cmp.changedOutput.filter((id) => !inGap.has(id));
  gate(
    "no-regression",
    worse.length === 0 && lost.length === 0,
    worse.length || lost.length
      ? [...worse, ...lost.map((x) => `${x}: missing`)].slice(0, 10).join("; ")
      : honest.length
        ? `no item got worse except ${honest.length} in-gap item(s) whose guess was replaced honestly (review these): ${honest.slice(0, 5).join("; ")}`
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
    `exact ${before.coverageExact} -> ${after.coverageExact}, translated ${before.coverageTranslated} -> ${after.coverageTranslated}${kept ? "" : " (drop explained by the honestly replaced guesses above)"}`,
  );

  return { ok: gates.every((g) => g.ok), gates, gapBefore, gapAfter, honestDowngrades: honest };
}
