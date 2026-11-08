// `dd2dash0` with no arguments: the one guided flow.
//   keys -> plan (dry run) -> batched review -> apply (rules disabled) -> verify (read-back + live data) -> report
// Every step reuses the existing gated pipeline (plan.lock, review.json, apply's refusals); this file only chains them.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Report } from "../report/types.js";
import { runApply } from "../pipeline/apply.js";
import { resolveConfig } from "../pipeline/config.js";
import { runPlan } from "../pipeline/plan.js";
import { importAll, type PrometheusAlertRule } from "../targets/dash0/index.js";
import { KeyError, resolveKeys, type KeyIO } from "./keys.js";
import { batchedReview } from "./review.js";
import { decisionsOf, rowsOf, scoreOf, summaryText, writeRunReport, type RunFacts } from "./score.js";
import { verifyLive } from "./verify.js";

export const EXIT = { ok: 0, failed: 1, refused: 2, usage: 3 } as const;

export interface GuidedOptions {
  yes: boolean;
  /** Folder of exported Datadog JSON/YAML instead of the API (hidden flag; fixtures, tests, backup demo). */
  input?: string;
  only?: "dashboards" | "monitors";
  /** Run directory; default ./dd2dash0-run/<timestamp>. */
  out?: string;
  /** Translate and write payloads, import nothing, skip the live checks (hidden flag). */
  dryRun?: boolean;
  version: string;
  mappingsDir: string;
  io: KeyIO;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const WINDOW_S = 3600;

export async function guided(o: GuidedOptions): Promise<number> {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const io = o.io;
  const started = (o.now ?? (() => new Date()))();
  const stamp = started.toISOString().replace(/[:]/g, "").replace(/\..*$/, "");
  const runDir = resolve(cwd, o.out ?? join("dd2dash0-run", stamp));
  const live = !o.dryRun;
  const useApi = !o.input;

  // 1. Keys
  io.print("1/5  Keys");
  let keys;
  try {
    keys = await resolveKeys({ need: { datadog: useApi, dash0: live }, env, cwd, io, yes: o.yes, ...(o.fetch ? { fetch: o.fetch } : {}) });
  } catch (e) {
    if (e instanceof KeyError) {
      io.print(`dd2dash0: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
  if (!live && !useApi) io.print("  (dry run from a folder: no keys needed)");
  // The pipeline's ingest reads the Datadog keys from the environment; set them for this process only.
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) continue;
    env[k] = v;
    process.env[k] = v;
  }

  // 2. Plan
  io.print("");
  io.print(`2/5  Translating ${useApi ? `everything in Datadog (${keys.DD_SITE})` : o.input}${o.only ? ` (${o.only} only)` : ""}`);
  mkdirSync(runDir, { recursive: true });
  const planDir = join(runDir, "plan");
  const config = resolveConfig(useApi ? { source: { kind: "api", site: keys.DD_SITE! } } : { source: { kind: "folder", path: resolve(cwd, o.input!) } }, {}, env);
  let plan;
  try {
    plan = await runPlan({ config, outDir: planDir, defaultMappingsDir: o.mappingsDir, ...(o.input ? { resolvedInput: resolve(cwd, o.input) } : {}), ...(o.only ? { only: o.only } : {}), version: o.version });
  } catch (e) {
    io.print(`dd2dash0: could not read or translate the source: ${(e as Error).message}`);
    return EXIT.usage;
  }
  const report: Report = plan.result.report;
  const items = report.items.filter((i) => i.kind === "panel" || i.kind === "alert");
  const by = (s: string) => items.filter((i) => i.status === s).length;
  io.print(`  ${report.summary.dashboards} dashboards, ${report.summary.alerts} monitors -> ${items.length} items: ${by("exact")} exact · ${by("exact-under")} exact-under · ${by("bounded")} bounded · ${by("manual")} manual · ${by("unsupported")} unsupported`);
  if (items.length === 0) {
    io.print("  Nothing to migrate (no dashboards or monitors found).");
    return EXIT.ok;
  }

  // 3. Review
  io.print("");
  io.print("3/5  Review");
  const review = await batchedReview(planDir, io, { yes: o.yes });

  // 4. Apply
  io.print("");
  io.print(live ? `4/5  Importing into Dash0 (${new URL(keys.DASH0_API_URL!).host}, dataset ${keys.DASH0_DATASET}); check rules go in disabled` : "4/5  Writing Dash0 payloads (dry run, nothing imported)");
  const dash0 = live ? { apiUrl: keys.DASH0_API_URL!, token: keys.DASH0_AUTH_TOKEN!, dataset: keys.DASH0_DATASET!, ...(o.fetch ? { fetch: o.fetch } : {}) } : undefined;
  const applied = await runApply({ planDir, reviewFile: review.file, dryRun: !live, enableRules: false, cwd, ...(dash0 ? { dash0 } : {}) });
  if (applied.kind === "refused") {
    io.print("  apply refused:");
    for (const r of applied.reasons) io.print(`    ${r}`);
    return EXIT.refused;
  }
  for (const w of applied.warnings) io.print(`  ! ${w}`);
  const failedImports = applied.manifest.results.filter((r) => r.errors.length);
  for (const r of failedImports) io.print(`  ✗ ${r.kind} ${r.name}: ${r.errors.join("; ")}${r.traceId ? ` (traceId ${r.traceId})` : ""}`);
  io.print(`  ${live ? "imported" : "written"}: ${applied.imported.dashboards} dashboard(s), ${applied.imported.rules} check rule(s)${failedImports.length ? `, ${failedImports.length} failed` : ""}`);
  const appliedReport = JSON.parse(readFileSync(applied.reportFile, "utf8")) as Report;

  // 5. Verify
  io.print("");
  let liveResults = null;
  if (live) {
    io.print(`5/5  Verifying: read-back done; checking the last ${WINDOW_S / 60} min of data in Dash0${useApi ? " and Datadog" : ""}`);
    liveResults = await verifyLive(appliedReport.items, {
      dash0: dash0!,
      ...(keys.DD_API_KEY && keys.DD_APP_KEY && keys.DD_SITE ? { datadog: { site: keys.DD_SITE, apiKey: keys.DD_API_KEY, appKey: keys.DD_APP_KEY } } : {}),
      windowSeconds: WINDOW_S,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
  } else io.print("5/5  Verify skipped (dry run)");

  // Report
  const decisions = decisionsOf(review, appliedReport.items);
  const facts: RunFacts = {
    version: o.version,
    source: useApi ? `Datadog ${keys.DD_SITE}` : `folder ${o.input}`,
    target: live ? `Dash0 ${new URL(keys.DASH0_API_URL!).host} / ${keys.DASH0_DATASET}` : "Dash0 (dry run)",
    mode: live ? "live" : "dry-run",
    inputHash: report.run.inputHash,
    outputHash: report.run.outputHash,
    planHash: plan.planHash,
    windowSeconds: WINDOW_S,
    startedAt: started.toISOString(),
  };
  let enabled = new Set<string>();
  const write = () => {
    const rows = rowsOf(appliedReport, decisions, liveResults, live, enabled);
    const score = scoreOf(rows);
    return { rows, score, files: writeRunReport(runDir, score, rows, facts) };
  };
  let out = write();
  io.print("");
  for (const l of summaryText(out.score, facts, { rulesImported: applied.imported.rules, manualMonitors: review.manualMonitors.length, reportMd: out.files.md.startsWith(cwd) ? out.files.md.slice(cwd.length + 1) : out.files.md })) io.print(l);

  // Offer to enable the approved, imported rules (default No).
  const importedRuleIds = applied.manifest.results.filter((r) => r.kind === "check-rule" && r.action === "imported").map((r) => r.id);
  if (live && importedRuleIds.length && !o.yes) {
    const a = ((await io.ask(`Enable the ${importedRuleIds.length} approved check rule(s) now? They will start evaluating and can notify. [y/N] `)) ?? "").trim().toLowerCase();
    if (a === "y" || a === "yes") {
      const dir = join(planDir, "dash0", "check-rules"); // the plan always writes every payload
      const payloads = importedRuleIds
        .map((id) => join(dir, `${id}.json`))
        .filter(existsSync)
        .map((p) => ({ ...(JSON.parse(readFileSync(p, "utf8")) as PrometheusAlertRule), enabled: true }));
      const m = await importAll({ dashboards: [], rules: payloads }, { dryRun: false, outDir: join(runDir, "enable"), enableRules: true, config: dash0! });
      enabled = new Set(m.results.filter((r) => r.action === "imported").map((r) => r.id));
      const bad = m.results.filter((r) => r.errors.length);
      io.print(`  ${enabled.size} rule(s) enabled${bad.length ? `, ${bad.length} failed: ${bad.map((r) => `${r.name}: ${r.errors.join("; ")}`).join(" | ")}` : ""}`);
      out = write();
    } else io.print("  Left disabled. Enable them in Dash0 when you're ready.");
  }

  const liveFail = out.rows.some((r) => r.live === "missing" || r.live === "error");
  return applied.ok && !liveFail ? EXIT.ok : EXIT.failed;
}

/** Terminal I/O: readline for answers, muted echo for secrets. */
export function terminalIO(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): KeyIO & { close: () => void } {
  const rl = createInterface({ input, output, terminal: input.isTTY === true });
  let muted = false;
  const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  const orig = r._writeToOutput.bind(rl);
  r._writeToOutput = (s: string) => {
    if (!muted) orig(s);
    else if (s.includes("\n") || s.includes("\r")) orig("\n");
  };
  const lines: string[] = [];
  let waiting: ((l: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    if (waiting) waiting(null);
  });
  const ask = (prompt: string, secret = false) =>
    new Promise<string | null>((res) => {
      output.write(prompt);
      muted = secret && input.isTTY === true;
      const done = (l: string | null) => {
        muted = false;
        // Piped input isn't echoed by a terminal: echo answers (never secrets) so the transcript reads right.
        if (input.isTTY !== true) output.write(l === null ? "\n" : secret ? "\n" : `${l}\n`);
        res(l);
      };
      if (lines.length) done(lines.shift()!);
      else if (closed) done(null);
      else waiting = done;
    });
  return {
    ask: (p) => ask(p),
    askSecret: (p) => ask(p, true),
    print: (l) => output.write(l + "\n"),
    close: () => rl.close(),
  };
}
