// Plan 10 steps 3, 5, 6 (DELEGATE, RETURN, RECURSE), the pure part: a gaps.json -> the round plan and one brief per
// lever. It writes text for people and agents; it never calls a model itself.
import type { GapsDoc, Lever } from "../gaps/gaps.js";
import { cell } from "../lib/report.js";

export const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

export interface PlanOptions {
  /** Branch the levers start from (the current feature branch). */
  baseBranch: string;
  /** Lever keys already being worked on (an earlier round): listed, not briefed. */
  inFlight?: string[];
  /** Branch prefix for lever branches, e.g. "amir/claude". */
  branchPrefix?: string;
}

export function leverBranch(doc: GapsDoc, l: Lever, o: PlanOptions): string {
  return `${o.branchPrefix ?? "lever"}/r${doc.round}-${slug(l.target).slice(0, 40)}`;
}

/** The round plan, as markdown: which levers run (in parallel waves), which go to an owner on the hub, which stop. */
export function roundPlan(doc: GapsDoc, o: PlanOptions): string {
  const fl = new Set(o.inFlight ?? []);
  const L: string[] = [];
  const delegated = doc.levers.filter((l) => l.wave > 0 && !fl.has(l.key));
  const hub = doc.levers.filter((l) => l.kind === "probe" || l.kind === "contract");
  const stop = doc.levers.filter((l) => l.kind === "impossible");
  const flight = doc.levers.filter((l) => fl.has(l.key));
  L.push(`# ROUND PLAN ${doc.round} (plan 10)`, "");
  L.push(`Measured: ${doc.root.inGap}/${doc.root.items} items below exact-under (${Object.entries(doc.root.byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}). Base: \`${o.baseBranch}\`.`, "");
  L.push("| # | Lever | Kind | Items (alone) | Owner reviews | Wave | Files |", "|---|---|---|---|---|---|---|");
  let n = 0;
  for (const l of [...delegated, ...flight, ...hub, ...stop]) {
    const wave = fl.has(l.key) ? "in flight" : l.wave ? `${l.wave}` : l.kind === "impossible" ? "stop" : "hub";
    L.push(`| ${++n} | \`${cell(l.target)}\` | ${l.kind} | ${l.items.length} (${l.upgradesAlone.length}) | ${cell(l.owner)} | ${wave} | ${l.files.map((f) => `\`${f}\``).join(", ") || "-"} |`);
  }
  L.push("");
  const waves = doc.waves.map((w) => w.filter((k) => !fl.has(k))).filter((w) => w.length);
  if (waves.length) {
    L.push("Parallel: levers in one wave touch disjoint files, so one sub-agent each can run at the same time.");
    waves.forEach((w, i) => L.push(`- wave ${i + 1}: ${w.map((k) => `\`${k}\``).join(", ")}`));
  } else L.push("Nothing to delegate this round.");
  if (hub.length) L.push("", `To owners on the hub (not to sub-agents): ${hub.map((l) => `\`${l.key}\` -> ${l.owner}`).join("; ")}.`);
  if (stop.length) L.push("", `Stopped (no equivalent, maths.md §9.5): ${stop.map((l) => `\`${l.target}\` (${l.items.length} items)`).join(", ")}.`);
  L.push("", "Each delegated lever returns either a PR-ready branch that passes `npm run gate` with its before/after item table, or a decomposition into sub-gaps (each with a brief). Sub-gaps are the next round's levers.", "");
  return L.join("\n");
}

/** One brief per lever: what to prove, the files, the gates, and the two allowed returns. */
export function brief(doc: GapsDoc, l: Lever, o: PlanOptions): string {
  const branch = leverBranch(doc, l, o);
  const leaves = doc.tree.flatMap((n) => n.leaves).filter((x) => l.leaves.includes(x.key));
  const L: string[] = [];
  L.push(`# Brief: ${l.kind} lever \`${l.target}\` (round ${doc.round})`, "");
  L.push(`- **Lever key:** \`${l.key}\``);
  L.push(`- **Owner who reviews and merges:** ${l.owner} (NOTES.md owners table)`);
  L.push(`- **Upgrades:** ${l.items.length} item(s), ${l.upgradesAlone.length} on its own (the rest also need another lever)`);
  L.push(`- **Why:** ${l.why}`);
  if (l.wave) L.push(`- **Parallel wave:** ${l.wave} (file-disjoint from the other levers in that wave)`);
  L.push("");
  L.push("## The gap", "");
  for (const x of leaves) {
    L.push(`### \`${x.key}\` (${x.items.length} items${x.rule ? `, rule \`${x.rule.id}\` ${x.rule.status}/${x.rule.state}` : ""})`, "");
    for (const e of x.examples) L.push(`- ${e}`);
    L.push("", "<details><summary>items</summary>", "", ...x.items.map((i) => `- \`${i}\``), "", "</details>", "");
  }

  L.push("## What to prove", "");
  const prove: Record<Lever["kind"], string[]> = {
    mapping: [
      `Every row you add or change in \`${l.target}\` is true to its pinned sources: the OTel name, kind, unit and labels exist in the receiver metadata.yaml, ddKind follows how the Datadog check submits the metric (L1-L7, tests/ir/mappings-logic.test.ts).`,
      "Cite the source for each row in its `note`. A row that is approximate says what differs; an exact row must have no transform (L7).",
      "If the honest answer is \"no equivalent\", say so in the row (metric.no_equivalent). That is a valid result, not a failure.",
    ],
    rule: [
      `Prove the claim of \`${l.target}\` (the catalog row's status): a maths note (docs/research/maths.md) or cited sources for exact/exact-under; for bounded, the ε formula.`,
      "Implement it as rules/tables only. No model, no network, no clock in src/ (plan 05 D3).",
      "Flip or add the catalog row (src/rules/catalog), with a unit test asserting the exact output (D8). A bounded rule also needs a fast-check property test under tests/semantics that names the rule id (gate M2), or an entry in tools/gate/m2-pending.json that a reviewer accepts.",
    ],
    probe: [`Not for a sub-agent: post the probe question to its owner on the hub. ${l.why}`, "When the answer comes back, record it in src/rules/probes.ts (catalog owner) and re-run `npm run recurse`: the stronger rule then shows up as a rule lever."],
    contract: [`Not for a sub-agent: a new rule or a claim change is a CONTRACT change (plan 05 §8). Post the proposal in the main room. ${l.why}`],
    impossible: [`Stop this branch: ${l.why}. The items stay manual with the original kept; the report already says why.`],
  };
  for (const p of prove[l.kind]) L.push(`- ${p}`);
  L.push("");

  if (l.kind === "mapping" || l.kind === "rule") {
    L.push("## Files", "");
    for (const f of l.files) L.push(`- \`${f}\``);
    for (const r of l.catalogRows) L.push(`- catalog row \`${r}\``);
    L.push("- your new tests", "", "Touch nothing else. Other owners' files need a hub post first.", "");
    L.push("## Setup", "", "```", `git fetch origin && git worktree add -b ${branch} ../tasks/${slug(branch.split("/").pop()!)} origin/${o.baseBranch}`, "npm ci", "npm run gaps -- --out out/gaps-before   # the before table", "```", "");
    L.push("## Gates (all must pass)", "", "```", `npm run gate -- --base-ref origin/${o.baseBranch}`, "```", "");
    L.push("typecheck (src, tools), the full suite, L1-L7, catalog conformance, M1, M2, determinism, per-item no-regression (an honest downgrade passes only with `--allow-downgrade <item id>:<reason>`), goldens changed (run `UPDATE_GOLDEN=1 npx vitest run tests/golden` and list the changed items), parity when keys exist.", "");
    L.push("## Return exactly one of", "");
    L.push(`1. **PR-ready branch** \`${branch}\`: the gate table, and the before/after item table (\`npm run gaps\` before and after; the items of this lever must move up).`);
    L.push("2. **A decomposition**: the sub-gaps that block this lever (needs a probe, a CONTRACT change, data, another lever first). For each: key, what blocks it, the items it holds back, and its own brief in this format. They become round " + (doc.round + 1) + "'s levers.");
    L.push("");
  }
  return L.join("\n");
}

/** The round plan as one hub post (plain text, short). */
export function hubText(doc: GapsDoc, o: PlanOptions): string {
  const fl = new Set(o.inFlight ?? []);
  const parts = doc.levers
    .filter((l) => !fl.has(l.key) && l.kind !== "impossible")
    .map((l) => `${l.kind} ${l.target} -> ${l.owner} (${l.items.length} items${l.wave ? `, wave ${l.wave}` : ", hub"})`);
  return `ROUND PLAN ${doc.round} (plan 10, base ${o.baseBranch}): ${doc.root.inGap}/${doc.root.items} items below exact-under. ${parts.join("; ")}. Owners: VETO ${doc.round} <lever> to stop one.`;
}
