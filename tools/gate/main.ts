// tools/gate: plan 10 step 4 (GATE) as one command. Build time only; src/ never imports it; no model is called.
//
//   npm run gate -- [--base-ref <git ref> | --baseline <report.json>] [--allow-downgrade <item id>:<reason> ...]
//                   [--allow-fail <test file> ...] [--parity-host <host>] [--parity-strict] [--out out/gate]
//
// Gates (all mechanical, the author can't argue with them):
//   typecheck (src)     npx tsc -p . --noEmit
//   typecheck (tools)   npx tsc -p tools
//   full suite          npx vitest run (one run, JSON reporter); --allow-fail names a test file that may fail
//                       (e.g. a platform-only failure), and the table still lists it
//   L1-L7 logic         tests/ir/mappings-logic.test.ts (plan 09 §3), from the same run
//   catalog conformance tests/rules/*.test.ts + tests/cli/catalog-conformance.test.ts (plan 05 §4), same run
//   M1 epsilon-attached every catalog rule claiming bounded states an ε (plan 09 §4)
//   M2 bound-tested     every rule with an ε is named by a fast-check test in tests/semantics, or listed in
//                       tools/gate/m2-pending.json (reviewed, may only shrink: new or stale entries fail)
//   determinism         two migrate runs on the fixtures, same report.json sha256
//   no-regression       per item vs the baseline (default: migrate at origin/HEAD in a temp worktree, same fixtures):
//                       every claim same or stronger; a downgrade passes only if --allow-downgrade names the item
//   goldens changed     tests/golden files changed vs the base ref, and the items whose output changed (listed)
//   parity              scripts/parity.ts (Ali, PR #57) as a subprocess when it exists, DD/Dash0 keys are set and a
//                       host is given (PARITY_HOST or --parity-host); else "skipped". Advisory unless --parity-strict.
// Exit 1 if any gate fails. Writes <out>/gate.json, <out>/gate.md and <out>/report.json (the candidate's report).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CATALOG } from "../../src/rules/index.js";
import { createWorkspace } from "../improve/workspace.js";
import { migrate, run, stableJson, tail, type GapReport } from "../lib/report.js";
import { checkDeterminism, checkM1, checkM2, checkNoRegression, parseAllowDowngrade, renderTable, type GateRow, type PendingEntry } from "./checks.js";

export interface GateOptions {
  root: string;
  baseRef: string;
  baseline: string | null;
  allowDowngrade: { id: string; reason: string }[];
  allowFail: string[];
  parityHost: string | null;
  parityStrict: boolean;
  out: string;
}

export function parseGateArgs(argv: string[], root = process.cwd()): GateOptions {
  const o: GateOptions = { root, baseRef: process.env.GATE_BASE_REF || "origin/HEAD", baseline: null, allowDowngrade: [], allowFail: [], parityHost: process.env.PARITY_HOST || null, parityStrict: false, out: join(root, "out", "gate") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--base-ref") o.baseRef = val();
    else if (a === "--baseline") o.baseline = resolve(val());
    else if (a === "--allow-downgrade") o.allowDowngrade.push(parseAllowDowngrade(val()));
    else if (a === "--allow-fail") o.allowFail.push(val().replace(/\\/g, "/"));
    else if (a === "--parity-host") o.parityHost = val();
    else if (a === "--parity-strict") o.parityStrict = true;
    else if (a === "--out") o.out = resolve(val());
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

interface VitestJson {
  numFailedTests: number;
  numPassedTests: number;
  testResults: { name: string; status: string; message?: string; assertionResults: { status: string; fullName: string }[] }[];
}

const rel = (root: string, p: string) => relative(root, p).replace(/\\/g, "/");

/** Gate rows for a set of test files, from one vitest JSON run. */
export function fileGate(name: string, v: VitestJson, root: string, match: (f: string) => boolean, allowFail: string[] = []): GateRow {
  const files = v.testResults.filter((t) => match(rel(root, t.name)));
  if (!files.length) return { name, status: "fail", detail: "no matching test file ran" };
  const passed = files.reduce((n, t) => n + t.assertionResults.filter((a) => a.status === "passed").length, 0);
  const failedFiles = files.filter((t) => t.status !== "passed");
  const blocking = failedFiles.filter((t) => !allowFail.includes(rel(root, t.name)));
  const failNames = (ts: typeof files) =>
    ts.map((t) => {
      const f = t.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName);
      return `${rel(root, t.name)}${f.length ? ` (${f.length} failing: ${f.slice(0, 2).join("; ")})` : t.message ? ` (${t.message.split("\n")[0]})` : ""}`;
    });
  if (blocking.length) return { name, status: "fail", detail: failNames(blocking).join("; ") };
  const allowed = failedFiles.length ? `; allowed to fail (--allow-fail): ${failNames(failedFiles).join("; ")}` : "";
  return { name, status: "pass", detail: `${files.length} file(s), ${passed} test(s) green${allowed}` };
}

/** .env key names only (values are never read into this process's output); the parity subprocess loads the file. */
function envKeys(root: string): Set<string> {
  const keys = new Set(Object.keys(process.env).filter((k) => process.env[k]));
  const f = join(root, ".env");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*\S/.exec(l);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

export const PARITY_KEYS = ["DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL", "DASH0_AUTH_TOKEN"];

function parityGate(o: GateOptions, reportFile: string): GateRow {
  const name = "parity (scripts/parity.ts)";
  const script = join(o.root, "scripts", "parity.ts");
  if (!existsSync(script)) return { name, status: "skip", detail: "skipped (scripts/parity.ts not in this checkout; Ali's PR #57)" };
  const keys = envKeys(o.root);
  const missing = PARITY_KEYS.filter((k) => !keys.has(k));
  if (missing.length) return { name, status: "skip", detail: `skipped (no keys: ${missing.join(", ")})` };
  if (!o.parityHost) return { name, status: "skip", detail: "skipped (no host: set PARITY_HOST or --parity-host; the host must feed both Datadog and Dash0)" };
  const outJson = join(o.out, "parity.json");
  const args = ["tsx", ...(existsSync(join(o.root, ".env")) ? ["--env-file=.env"] : []), "scripts/parity.ts", reportFile, "--host", o.parityHost, "--json", outJson];
  const r = run("npx", args, o.root, { timeoutMs: 900_000 });
  if (!r.ok) return { name, status: "fail", detail: `parity.ts exited ${r.code}: ${tail(r.out, 300)}` };
  let rows: { verdict: string }[] = [];
  try {
    rows = (JSON.parse(readFileSync(outJson, "utf8")) as { rows: { verdict: string }[] }).rows;
  } catch {
    return { name, status: "fail", detail: "parity.ts wrote no readable --json output" };
  }
  const n = (v: string) => rows.filter((x) => x.verdict === v).length;
  const detail = `${rows.length} items on host ${o.parityHost}: close ${n("close")}, differs ${n("differs")}, trivial ${n("trivial")}, skipped ${n("skipped")}${o.parityStrict ? "" : " (advisory; --parity-strict fails on differs)"}`;
  return { name, status: o.parityStrict && n("differs") > 0 ? "fail" : "pass", detail };
}

/** The baseline report: --baseline, else migrate at --base-ref in a temp worktree over THIS checkout's fixtures. */
function baselineReport(o: GateOptions): { report: GapReport; label: string } {
  if (o.baseline) return { report: JSON.parse(readFileSync(o.baseline, "utf8")) as GapReport, label: rel(o.root, o.baseline).startsWith("..") ? o.baseline.replace(/\\/g, "/") : rel(o.root, o.baseline) };
  const ws = createWorkspace(o.root, o.baseRef);
  try {
    return { report: migrate(ws.dir, join(o.root, "fixtures", "datadog")).report, label: `${o.baseRef} (temp worktree, same fixtures)` };
  } finally {
    ws.remove();
  }
}

export async function runGate(o: GateOptions, log: (s: string) => void = () => {}): Promise<{ ok: boolean; rows: GateRow[] }> {
  mkdirSync(o.out, { recursive: true });
  const rows: GateRow[] = [];
  const add = (r: GateRow) => {
    rows.push(r);
    log(`${r.status.toUpperCase().padEnd(4)} ${r.name}: ${r.detail.slice(0, 200)}`);
  };

  for (const [name, args] of [
    ["typecheck (src)", ["tsc", "-p", ".", "--noEmit"]],
    ["typecheck (tools)", ["tsc", "-p", "tools"]],
  ] as const) {
    const r = run("npx", [...args], o.root);
    add({ name, status: r.ok ? "pass" : "fail", detail: r.ok ? "clean" : tail(r.out, 600) });
  }

  // One vitest run; the logic and catalog gates read their files from it.
  const tmp = mkdtempSync(join(tmpdir(), "gate-vitest-"));
  try {
    const jsonFile = join(tmp, "vitest.json");
    const r = run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${jsonFile}`], o.root, { timeoutMs: 1_200_000 });
    let v: VitestJson | null = null;
    try {
      v = JSON.parse(readFileSync(jsonFile, "utf8")) as VitestJson;
    } catch {
      add({ name: "full suite", status: "fail", detail: `vitest produced no JSON report: ${tail(r.out, 400)}` });
    }
    if (v) {
      add(fileGate("full suite", v, o.root, () => true, o.allowFail));
      add(fileGate("L1-L7 mapping logic", v, o.root, (f) => f === "tests/ir/mappings-logic.test.ts"));
      add(fileGate("catalog conformance", v, o.root, (f) => /^tests\/rules\/[^/]+\.test\.ts$/.test(f) || f === "tests/cli/catalog-conformance.test.ts"));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const m1 = checkM1(CATALOG);
  add({ name: "M1 epsilon-attached", status: m1.ok ? "pass" : "fail", detail: m1.ok ? `every bounded rule states its ε (${CATALOG.filter((r) => r.status === "bounded").length} rules)` : `bounded without ε: ${m1.missing.join(", ")}` });

  const semDir = join(o.root, "tests", "semantics");
  const sem = readdirSync(semDir).filter((f) => f.endsWith(".ts")).sort().map((f) => ({ path: `tests/semantics/${f}`, text: readFileSync(join(semDir, f), "utf8") }));
  const pending = (JSON.parse(readFileSync(join(o.root, "tools", "gate", "m2-pending.json"), "utf8")) as { pending: PendingEntry[] }).pending;
  const m2 = checkM2(CATALOG, sem, pending);
  add({
    name: "M2 bound-tested",
    status: m2.ok ? "pass" : "fail",
    detail: m2.ok
      ? `${m2.covered.length} ε rule(s) named by a property test (${m2.covered.join(", ") || "none"}); ${m2.pending.length} pending in tools/gate/m2-pending.json`
      : [m2.unlisted.length ? `new ε rule(s) with no property test and not in m2-pending.json: ${m2.unlisted.join(", ")}` : "", m2.stale.length ? `stale m2-pending.json entries (now tested or no ε; remove them): ${m2.stale.join(", ")}` : ""].filter(Boolean).join("; "),
  });

  const fixtures = join(o.root, "fixtures", "datadog");
  const a = migrate(o.root, fixtures, join(o.out, "run-1"));
  const b = migrate(o.root, fixtures, join(o.out, "run-2"));
  writeFileSync(join(o.out, "report.json"), a.raw);
  add(checkDeterminism(a.sha256, b.sha256));

  let changedOutput: string[] = [];
  try {
    const base = baselineReport(o);
    const nr = checkNoRegression(base.report.items, a.report.items, o.allowDowngrade);
    changedOutput = nr.cmp.changedOutput;
    const parts = [
      `vs ${base.label}`,
      `${nr.cmp.better.length} upgraded, ${nr.cmp.worse.length} downgraded, ${nr.cmp.lost.length} missing, ${nr.cmp.added.length} new`,
      nr.regressions.length ? `REGRESSIONS: ${nr.regressions.slice(0, 8).join("; ")}${nr.regressions.length > 8 ? ` (+${nr.regressions.length - 8})` : ""}` : "",
      nr.allowed.length ? `allowed: ${nr.allowed.join("; ")}` : "",
      nr.unusedAllows.length ? `unused --allow-downgrade: ${nr.unusedAllows.join(", ")}` : "",
    ].filter(Boolean);
    add({ name: "no-regression (per item)", status: nr.ok ? "pass" : "fail", detail: parts.join("; ") });
    writeFileSync(join(o.out, "no-regression.json"), stableJson({ baseline: base.label, ...nr }));
  } catch (e) {
    add({ name: "no-regression (per item)", status: "fail", detail: `no baseline: ${e instanceof Error ? e.message.split("\n")[0] : e}` });
  }

  const diff = run("git", ["diff", "--name-only", o.baseRef, "--", "tests/golden"], o.root);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--", "tests/golden"], o.root);
  const goldens = [...new Set([...diff.out.split("\n"), ...untracked.out.split("\n")].map((s) => s.trim()).filter(Boolean))].sort();
  add({
    name: "goldens changed",
    status: diff.ok ? "pass" : "fail",
    detail: diff.ok
      ? `${goldens.length} golden file(s) changed vs ${o.baseRef}${goldens.length ? `: ${goldens.join(", ")}` : ""}; ${changedOutput.length} item(s) changed output${changedOutput.length ? `: ${changedOutput.slice(0, 10).join(", ")}${changedOutput.length > 10 ? ` (+${changedOutput.length - 10})` : ""}` : ""}`
      : `git diff vs ${o.baseRef} failed: ${tail(diff.out, 200)}`,
  });

  add(parityGate(o, join(o.out, "report.json")));

  const ok = rows.every((r) => r.status !== "fail");
  const md = `${renderTable(rows)}\n\n**${ok ? "GATE PASSED" : "GATE FAILED"}** (${rows.filter((r) => r.status === "fail").length} failing)\n`;
  writeFileSync(join(o.out, "gate.md"), md);
  writeFileSync(join(o.out, "gate.json"), stableJson({ ok, rows }));
  return { ok, rows };
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/gate/main.ts");
if (isMain) {
  try {
    const o = parseGateArgs(process.argv.slice(2));
    const { ok, rows } = await runGate(o, (s) => console.error(`[gate] ${s}`));
    console.log(renderTable(rows));
    console.log(`\n${ok ? "GATE PASSED" : "GATE FAILED"}. Wrote ${join(o.out, "gate.md")}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`[gate] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
