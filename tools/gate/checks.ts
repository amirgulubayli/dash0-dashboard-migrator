// Plan 10 step 4 (GATE), the pure checks. tools/gate/main.ts runs the commands and feeds these; tools/improve/gates.ts
// reuses compareClaims(). Nothing here calls a model or the network.
import { claimOf, namesRule, weaker, type GapItem } from "../lib/report.js";

export { namesRule };

export type GateStatus = "pass" | "fail" | "skip";

export interface GateRow {
  name: string;
  status: GateStatus;
  detail: string;
}

export interface RuleLike {
  id: string;
  status: string;
  epsilon?: string;
}

/** M1 epsilon-attached (plan 09 §4): every catalog rule that claims `bounded` states its ε. */
export function checkM1(rules: readonly RuleLike[]): { ok: boolean; missing: string[] } {
  const missing = rules.filter((r) => r.status === "bounded" && !r.epsilon?.trim()).map((r) => r.id).sort();
  return { ok: missing.length === 0, missing };
}

export interface PendingEntry {
  id: string;
  /** Why the rule has no property test yet, and what would close it. */
  reason: string;
}

export interface M2Result {
  ok: boolean;
  /** Rules with an ε that a property test names. */
  covered: string[];
  /** Rules with an ε, untested, listed in m2-pending.json (reviewed debt). */
  pending: string[];
  /** Rules with an ε, untested and not listed: the failure. */
  unlisted: string[];
  /** Allowlist entries that no longer apply (now tested, or no ε): the list must only shrink, so these fail too. */
  stale: string[];
}

/** A property test file: under tests/semantics and drives fast-check. */
export const isPropertyTest = (text: string) => /from\s+["']fast-check["']/.test(text);


/**
 * M2 bound-tested (plan 09 §4): every rule with an ε is named (by its rule id) in a fast-check property test under
 * tests/semantics, or listed in the reviewed allowlist. New untested rules fail; stale allowlist entries fail.
 */
export function checkM2(rules: readonly RuleLike[], semantics: readonly { path: string; text: string }[], pending: readonly PendingEntry[]): M2Result {
  const props = semantics.filter((f) => isPropertyTest(f.text));
  const withEps = rules.filter((r) => r.epsilon?.trim()).map((r) => r.id).sort();
  const listed = new Set(pending.map((p) => p.id));
  const covered: string[] = [];
  const pend: string[] = [];
  const unlisted: string[] = [];
  for (const id of withEps) {
    if (props.some((f) => namesRule(f.text, id))) covered.push(id);
    else if (listed.has(id)) pend.push(id);
    else unlisted.push(id);
  }
  const eps = new Set(withEps);
  const stale = [...listed].filter((id) => !eps.has(id) || covered.includes(id)).sort();
  return { ok: unlisted.length === 0 && stale.length === 0, covered, pending: pend, unlisted, stale };
}

/** `--allow-downgrade <item id>:<reason>`: the id must be named and the reason must not be empty. */
export function parseAllowDowngrade(arg: string): { id: string; reason: string } {
  const i = arg.indexOf(":");
  const id = i < 0 ? "" : arg.slice(0, i).trim();
  const reason = i < 0 ? "" : arg.slice(i + 1).trim();
  if (!id || !reason) throw new Error(`--allow-downgrade needs <item id>:<reason>, got '${arg}'`);
  return { id, reason };
}

export interface ClaimChange {
  id: string;
  from: string;
  to: string;
}

export interface ClaimComparison {
  /** Items whose claim got weaker (unsupported counts as manual: same claim, see tools/lib/report.ts). */
  worse: ClaimChange[];
  better: ClaimChange[];
  /** Items in the baseline that are gone. */
  lost: string[];
  added: string[];
  /** Items whose output bytes changed (certificate.outputHash), claim or not. */
  changedOutput: string[];
}

type Comparable = Pick<GapItem, "id" | "status" | "kind"> & { outputHash?: string | null; certificate?: { outputHash: string | null } };
const hashOf = (i: Comparable) => i.outputHash ?? i.certificate?.outputHash ?? null;

/** Per item, baseline vs candidate. Pure and order-independent; results are sorted by id. Group rows are skipped. */
export function compareClaims(before: readonly Comparable[], after: readonly Comparable[]): ClaimComparison {
  const keep = (xs: readonly Comparable[]) => xs.filter((i) => i.kind !== "group");
  const A = new Map(keep(after).map((i) => [i.id, i]));
  const B = new Map(keep(before).map((i) => [i.id, i]));
  const r: ClaimComparison = { worse: [], better: [], lost: [], added: [], changedOutput: [] };
  for (const [id, b] of [...B].sort((x, y) => x[0].localeCompare(y[0]))) {
    const a = A.get(id);
    if (!a) {
      r.lost.push(id);
      continue;
    }
    if (weaker(a.status, b.status)) r.worse.push({ id, from: b.status, to: a.status });
    else if (weaker(b.status, a.status)) r.better.push({ id, from: b.status, to: a.status });
    if (hashOf(a) !== hashOf(b)) r.changedOutput.push(id);
  }
  r.added = [...A.keys()].filter((id) => !B.has(id)).sort();
  return r;
}

export interface NoRegression {
  ok: boolean;
  /** Unallowed downgrades and losses: the failure. */
  regressions: string[];
  /** Downgrades the author named with --allow-downgrade, with the reason. */
  allowed: string[];
  /** --allow-downgrade entries that matched no downgrade (reported, so the list doesn't rot). */
  unusedAllows: string[];
  cmp: ClaimComparison;
}

/** Plan 10 step 4 NO-REGRESSION: every item's claim same or stronger, except downgrades named with a reason. */
export function checkNoRegression(before: readonly Comparable[], after: readonly Comparable[], allow: readonly { id: string; reason: string }[] = []): NoRegression {
  const cmp = compareClaims(before, after);
  const why = new Map(allow.map((a) => [a.id, a.reason]));
  const used = new Set<string>();
  const regressions: string[] = [];
  const allowed: string[] = [];
  const note = (id: string, text: string) => {
    if (why.has(id)) {
      used.add(id);
      allowed.push(`${text} (allowed: ${why.get(id)})`);
    } else regressions.push(text);
  };
  for (const w of cmp.worse) note(w.id, `${w.id}: ${w.from} -> ${w.to}`);
  for (const id of cmp.lost) note(id, `${id}: missing`);
  return { ok: regressions.length === 0, regressions, allowed, unusedAllows: [...why.keys()].filter((k) => !used.has(k)).sort(), cmp };
}

/** Two migrate runs, same report.json bytes. */
export function checkDeterminism(a: string, b: string): GateRow {
  return a === b ? { name: "determinism", status: "pass", detail: `two migrate runs, same sha256 ${a.slice(0, 16)}` } : { name: "determinism", status: "fail", detail: `two runs differ: ${a.slice(0, 16)} vs ${b.slice(0, 16)}` };
}

export const claimLabel = (s: string) => claimOf(s) ?? s;

const ICON: Record<GateStatus, string> = { pass: "PASS", fail: "FAIL", skip: "skip" };

export function renderTable(rows: readonly GateRow[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return ["| Gate | Result | Detail |", "|---|---|---|", ...rows.map((r) => `| ${r.name} | ${ICON[r.status]} | ${esc(r.detail)} |`)].join("\n");
}
