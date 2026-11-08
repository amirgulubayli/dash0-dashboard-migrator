#!/usr/bin/env node
// dd2dash0 CLI (T8; HOT: post a CONTRACT before changing flags).
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFromEnv } from "./targets/dash0/index.js";
import { migrate, overallOk } from "./pipeline/migrate.js";
import { summaryLines, writeReport } from "./report/index.js";
import { reportToEvents } from "./report/events.js";
import { loadReport, startServer } from "./serve/server.js";
import { ConfigError, loadConfig, resolveConfig, type Dd2dash0Config } from "./pipeline/config.js";
import { runPlan } from "./pipeline/plan.js";
import { runApply } from "./pipeline/apply.js";
import { terminalReview } from "./pipeline/review-terminal.js";
import { findConsoleDir, startReviewServer } from "./serve/review.js";
import { createInterface } from "node:readline/promises";
import { datadogEnv, durationMs, findDatadogMonitor, plannedAlerts, runWatch, type WatchedAlert } from "./pipeline/watch.js";
import { defaultMappingsDir, homeDir } from "./home.js";
import { writeProof } from "./pipeline/proof.js";
import { styler } from "./term.js";

export const VERSION = "0.2.0";
/** Defaults kept off 4317/4318, the OTLP ports a local OpenTelemetry Collector listens on. */
export const REVIEW_PORT = 7318;
export const SERVE_PORT = 7317;
const ui = styler();
const print = (lines: string[]) => lines.forEach((l, i) => console.log(i === 0 ? ui.bold(ui.claims(l)) : ui.claims(l)));

const USAGE = `dd2dash0 ${VERSION}: migrate Datadog dashboards and monitors to Dash0 (Perses dashboards, PromQL, check rules)

The reviewed flow, three steps:
  1. dd2dash0 plan --input <dir> | --api [--out plan]      translate everything, import nothing
  2. dd2dash0 review plan                                  decide in the browser (or add --terminal)
  3. dd2dash0 apply plan --approved plan/review.json       import only what you approved

Then show it works:
  dd2dash0 watch plan [--alert <name>]     Datadog monitor and migrated Dash0 rule side by side, parity verdict
  dd2dash0 proof plan                      one offline page: coverage, alert timeline, every item that needs a person

Other:
  dd2dash0 migrate --from datadog --input <dir> | --api [--dry-run | --no-import]   one shot, no review step
  dd2dash0 serve [--out <dir>]             replay a migrate run in the browser (optional voice narrator)
  dd2dash0                                 with no arguments in a terminal: the interactive app

Every claim in the output is one of five words:
  exact         same numbers as Datadog
  exact-under   exact if its stated conditions hold (shown per item)
  bounded       approximate, within a proven error bound (shown per item)
  manual        needs a person; the panel keeps the original query as a placeholder
  unsupported   no Dash0 equivalent; placeholder with the original

Options for plan and migrate:
  --input <dir>        folder of exported Datadog JSON or YAML (dashboards and monitors, any depth)
  --api                read from the Datadog API (DD_SITE, default datadoghq.eu; DD_API_KEY, DD_APP_KEY)
  --out <dir>          output directory (plan: ./plan, migrate: ./out)
  --only <what>        dashboards | monitors
  --enable-rules       import check rules enabled (default: disabled, D-30)
  --mappings <dir>     mapping tables (default: the package's mappings/)
  --channels <file>    Datadog @handle -> existing Dash0 notification channel id
Options for review:  --terminal  --port ${REVIEW_PORT}  --reviewer <name>
Options for apply:   --dry-run (write payloads, import nothing)  --allow-pending  --enable-rules  --skip-source-check
Options for watch:   --dd-monitor <name>=<id>,...  --every 5s  --max 30m  --until-recovered

apply refuses if the plan changed, the review belongs to another plan, the Datadog source changed, or an
approximate panel has no decision. Live import needs DASH0_API_URL and DASH0_AUTH_TOKEN (optional DASH0_DATASET);
watch also needs DD_API_KEY and DD_APP_KEY.

Exit codes: 0 ok, 1 some imports failed (watch: no parity), 2 refused, 3 usage, config or API error.
Translation is deterministic: rules, parsers and mapping tables. No LLM is involved.`;

const EXIT = { ok: 0, failed: 1, refused: 2, usage: 3 } as const;

export function main(argv: string[] = process.argv.slice(2)): number | Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "plan") return runPlanCmd(rest);
  if (cmd === "review") return runReviewCmd(rest);
  if (cmd === "apply") return runApplyCmd(rest);
  if (cmd === "watch") return runWatchCmd(rest);
  if (cmd === "proof") return runProofCmd(rest);
  if (cmd === "migrate") return runMigrate(rest);
  if (cmd === "serve") return runServe(rest);
  console.error(`unknown command: ${cmd} (try --help)`);
  return EXIT.usage;
}

interface Flags {
  from?: string;
  input?: string;
  api: boolean;
  dryRun: boolean;
  noImport: boolean;
  out: string;
  only?: "dashboards" | "monitors";
  enableRules: boolean;
  mappings: string;
  channels?: string;
}

export function parseFlags(args: string[]): Flags | string {
  const f: Flags = { api: false, dryRun: false, noImport: false, out: "out", enableRules: false, mappings: defaultMappingsDir() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      switch (a) {
        case "--from": f.from = val(); break;
        case "--input": f.input = val(); break;
        case "--api": f.api = true; break;
        case "--dry-run": f.dryRun = true; break;
        case "--no-import": f.noImport = true; break;
        case "--out": f.out = val(); break;
        case "--enable-rules": f.enableRules = true; break;
        case "--mappings": f.mappings = val(); break;
        case "--channels": f.channels = val(); break;
        case "--only": {
          const v = val();
          if (v !== "dashboards" && v !== "monitors") return "--only must be dashboards or monitors";
          f.only = v;
          break;
        }
        default: return `unknown option ${a}`;
      }
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (f.from !== "datadog") return "--from datadog is required (the only source so far)";
  if (!!f.input === f.api) return "pass exactly one of --input <dir> or --api";
  if (f.dryRun && f.noImport) return "--dry-run and --no-import are mutually exclusive";
  return f;
}

async function runMigrate(args: string[]): Promise<number> {
  const f = parseFlags(args);
  if (typeof f === "string") {
    console.error(`${f}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const mode = f.noImport ? "none" : f.dryRun ? "dry-run" : "live";
  let dash0;
  if (mode === "live") {
    try {
      dash0 = configFromEnv();
    } catch (e) {
      console.error(`${(e as Error).message}\nUse --dry-run to translate without importing.`);
      return EXIT.usage;
    }
  }
  try {
    const r = await migrate({
      ingest: { ...(f.input ? { input: resolve(f.input) } : { api: true }), ...(f.only ? { only: f.only } : {}) },
      source: f.input ? { kind: "folder", site: null, path: f.input } : { kind: "api", site: process.env.DD_SITE || "datadoghq.eu", path: null },
      mappingsDir: resolve(f.mappings),
      ...(f.channels ? { channelsFile: resolve(f.channels) } : {}),
      outDir: resolve(f.out),
      mode,
      enableRules: f.enableRules,
      ...(dash0 ? { dash0 } : {}),
      version: VERSION,
    });
    const files = writeReport(r.report, resolve(f.out));
    writeFileSync(join(resolve(f.out), "events.jsonl"), reportToEvents(r.report).map((e) => JSON.stringify(e)).join("\n") + "\n");
    print(summaryLines(r.report, files, { command: "migrate" }));
    if (r.manifest) {
      for (const x of r.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    }
    return overallOk(r) ? 0 : 1;
  } catch (e) {
    console.error(`dd2dash0: ${(e as Error).message}`);
    return 1;
  }
}

/** Reads `--name value` / `--flag` pairs; positional arguments are returned in `_`. */
function readArgs(args: string[], valued: string[], bools: string[]): { _: string[]; v: Record<string, string>; b: Set<string> } | string {
  const out = { _: [] as string[], v: {} as Record<string, string>, b: new Set<string>() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      out.v[a] = v;
    } else if (bools.includes(a)) out.b.add(a);
    else if (a.startsWith("--")) return `unknown option ${a}`;
    else out._.push(a);
  }
  return out;
}

async function runPlanCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--input", "--out", "--config", "--mappings", "--channels", "--only", "--from"], ["--api", "--enable-rules"]);
  if (typeof r === "string" || r._.length) {
    console.error(`${typeof r === "string" ? r : `unexpected argument ${r._[0]}`}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (r.v["--from"] && r.v["--from"] !== "datadog") {
    console.error("--from datadog is the only source so far");
    return EXIT.usage;
  }
  const only = r.v["--only"];
  if (only && only !== "dashboards" && only !== "monitors") {
    console.error("--only must be dashboards or monitors");
    return EXIT.usage;
  }
  if (r.v["--input"] && r.b.has("--api")) {
    console.error("pass at most one of --input <dir> or --api");
    return EXIT.usage;
  }
  const flags: Dd2dash0Config = {
    ...(r.v["--input"] ? { source: { kind: "folder" as const, path: r.v["--input"] } } : r.b.has("--api") ? { source: { kind: "api" as const } } : {}),
    ...(r.v["--mappings"] ? { mappings: resolve(r.v["--mappings"]) } : {}),
    ...(r.v["--channels"] ? { channels: resolve(r.v["--channels"]) } : {}),
    ...(r.b.has("--enable-rules") ? { enableRules: true } : {}),
  };
  let config;
  try {
    const file = loadConfig(r.v["--config"]);
    config = resolveConfig(file.config, flags);
    if (!file.file && !flags.source) {
      console.error(`pass --input <dir> or --api (or a source in dd2dash0.yaml)\n\n${USAGE}`);
      return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return EXIT.usage;
    }
    throw e;
  }
  const out = resolve(r.v["--out"] ?? "plan");
  try {
    const p = await runPlan({
      config,
      outDir: out,
      defaultMappingsDir: defaultMappingsDir(),
      ...(config.source.kind === "folder" ? { resolvedInput: resolve(config.source.path) } : {}),
      ...(only ? { only: only as "dashboards" | "monitors" } : {}),
      version: VERSION,
    });
    print(summaryLines(p.result.report, p.files, { command: "plan", planHash: p.planHash }));
    const dir = r.v["--out"] ?? "plan";
    console.log(`\n  next  ${ui.bold(`dd2dash0 review ${dir}`)}   then   ${ui.bold(`dd2dash0 apply ${dir} --approved ${join(dir, "review.json")}`)}`);
    return EXIT.ok;
  } catch (e) {
    console.error(ui.bad(`dd2dash0 plan: ${(e as Error).message}`));
    return EXIT.usage; // nothing was imported, so 1 ("some imports failed") would mislead
  }
}

async function runReviewCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--port", "--reviewer", "--console"], ["--terminal", "--all"]);
  if (typeof r === "string" || r._.length !== 1) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 review <plan dir> [--terminal]"}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const planDir = resolve(r._[0]!);
  const reviewer = r.v["--reviewer"] ?? process.env.USER ?? process.env.USERNAME ?? "";
  if (r.b.has("--terminal")) {
    // Read lines through the async iterator: it buffers input, so piped keystrokes aren't lost between prompts
    // (readline's question() drops lines that arrive while no question is pending).
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    try {
      const out = await terminalReview(planDir, reviewer, {
        ask: async (prompt) => {
          process.stdout.write(prompt);
          const n = await lines.next();
          if (!process.stdin.isTTY && !n.done) process.stdout.write(`${n.value}\n`); // echo piped input
          return n.done ? null : n.value;
        },
        print: (line) => console.log(line),
      }, { all: r.b.has("--all") });
      return EXIT.ok;
    } catch (e) {
      console.error(`dd2dash0 review: ${(e as Error).message}`);
      return EXIT.refused;
    } finally {
      rl.close();
    }
  }
  const port = Number(r.v["--port"] ?? REVIEW_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port must be a port number");
    return EXIT.usage;
  }
  const consoleDir = r.v["--console"] ? resolve(r.v["--console"]) : findConsoleDir(join(homeDir(), "src"));
  try {
    const { url } = await startReviewServer({ planDir, port, ...(consoleDir ? { consoleDir } : {}), reviewer });
    console.log(`dd2dash0 review: ${url}  (plan ${planDir}; ${consoleDir ? "console" : "console not built: notice page, or use --terminal"}; Ctrl+C to stop)`);
    console.log(`  decisions are saved to ${join(planDir, "review.json")}; then: dd2dash0 apply ${r._[0]} --approved ${join(r._[0]!, "review.json")}`);
    return new Promise<number>(() => {}); // keep serving
  } catch (e) {
    console.error(`dd2dash0 review: ${(e as Error).message}`);
    return EXIT.refused;
  }
}

async function runWatchCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--alert", "--dd-monitor", "--every", "--max"], ["--until-recovered"]);
  if (typeof r === "string" || r._.length !== 1) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 watch <plan dir> [--alert <name>]"}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const planDir = resolve(r._[0]!);
  try {
    const everyMs = durationMs(r.v["--every"] ?? "5s");
    const maxMs = durationMs(r.v["--max"] ?? "30m");
    if (everyMs < 1000) throw new Error("--every must be at least 1s");
    const dd = datadogEnv();
    const dash0 = configFromEnv();
    const ids = new Map(
      (r.v["--dd-monitor"] ?? "")
        .split(",")
        .filter(Boolean)
        .map((kv) => {
          const [k, v] = kv.split("=");
          if (!k || !v || !/^\d+$/.test(v)) throw new Error(`--dd-monitor expects <name>=<numeric id>, got '${kv}'`);
          return [k, v] as const;
        }),
    );
    const planned = plannedAlerts(planDir, r.v["--alert"] ? [r.v["--alert"]] : []);
    if (!planned.length) throw new Error(`no check rule in ${planDir} matches ${r.v["--alert"] ? `'${r.v["--alert"]}'` : "anything"}`);
    const alerts: WatchedAlert[] = [];
    for (const a of planned) {
      const given = [...ids].find(([k]) => a.alertId.includes(k) || a.title.includes(k))?.[1];
      const id = given ?? a.ddMonitorId ?? (await findDatadogMonitor(dd, a.title));
      if (!id) throw new Error(`no Datadog monitor id for '${a.title}': pass --dd-monitor ${a.alertId.replace(/^dd-monitor-/, "")}=<id>`);
      alerts.push({ ...a, ddMonitorId: id });
    }
    const signal = { stopped: false };
    process.once("SIGINT", () => (signal.stopped = true));
    const res = await runWatch({ planDir, alerts, dd, dash0, everyMs, maxMs, untilRecovered: r.b.has("--until-recovered"), print: (l) => console.log(l), signal });
    console.log(`  timeline: ${res.files.timeline}\n  parity:   ${res.files.parity}`);
    return res.apiError ? EXIT.usage : res.ok ? EXIT.ok : EXIT.failed;
  } catch (e) {
    console.error(`dd2dash0 watch: ${(e as Error).message}`);
    return EXIT.usage;
  }
}

function runProofCmd(args: string[]): number {
  const r = readArgs(args, ["--corpus", "--out"], []);
  if (typeof r === "string" || r._.length !== 1) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 proof <plan dir> [--corpus corpus.json] [--out proof.html]"}\n\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    const res = writeProof(resolve(r._[0]!), { ...(r.v["--corpus"] ? { corpus: resolve(r.v["--corpus"]) } : {}), ...(r.v["--out"] ? { out: resolve(r.v["--out"]) } : {}) });
    const p = res.inputs.parity;
    console.log(`proof card: ${res.file}`);
    console.log(`  plan ${res.inputs.planHash.slice(0, 12)} ${res.inputs.planIntact ? "(intact)" : "(CHANGED since planning)"}; ${res.inputs.applied ? "applied" : "not applied"}; ${p?.length ? `alerts watched: ${p.map((x) => x.verdict).join(", ")}` : "no watch yet"}`);
    return EXIT.ok;
  } catch (e) {
    console.error(`dd2dash0 proof: ${(e as Error).message}`);
    return EXIT.usage;
  }
}

async function runApplyCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--approved"], ["--enable-rules", "--allow-pending", "--dry-run", "--skip-source-check"]);
  if (typeof r === "string" || r._.length !== 1 || !r.v["--approved"]) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 apply <plan dir> --approved <review.json>"}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const dryRun = r.b.has("--dry-run");
  let dash0;
  if (!dryRun) {
    try {
      dash0 = configFromEnv();
    } catch (e) {
      console.error(`${(e as Error).message}\nUse --dry-run to write the approved payloads without importing.`);
      return EXIT.usage;
    }
  }
  try {
    const o = await runApply({
      planDir: resolve(r._[0]!),
      reviewFile: resolve(r.v["--approved"]),
      enableRules: r.b.has("--enable-rules"),
      allowPending: r.b.has("--allow-pending"),
      dryRun,
      skipSourceCheck: r.b.has("--skip-source-check"),
      ...(dash0 ? { dash0 } : {}),
    });
    for (const w of o.warnings) console.error(`  warning: ${w}`);
    if (o.kind === "refused") {
      console.error(ui.bad("dd2dash0 apply: refused, nothing imported"));
      for (const x of o.reasons) console.error(`  ${x}`);
      return EXIT.refused;
    }
    const m = o.manifest.summary;
    console.log(ui.bold(`dd2dash0 apply  ${dryRun ? "dry run: nothing imported" : "imported into Dash0"}`));
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
    console.log(`  ${"scope".padEnd(9)}${n(o.imported.dashboards, "dashboard")} (exact items need no review) · ${n(o.imported.rules, "check rule")} you approved`);
    console.log(`  ${(dryRun ? "written" : "imported").padEnd(9)}${dryRun ? `${m["dry-run"]} payloads` : `${m.imported} · ${m.readBackMatch} read back identical`} · ${m.failed} failed · ${m["rejected-preflight"]} rejected by preflight`);
    if (o.placeholders.length) console.log(`  ${"flagged".padEnd(9)}${o.placeholders.length} panel(s) imported as placeholders with the reviewer's note`);
    if (o.skippedAlerts.length) console.log(`  ${"skipped".padEnd(9)}check rules not approved: ${o.skippedAlerts.join(", ")}`);
    for (const x of o.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    console.log(`  ${"report".padEnd(9)}${o.reportFile}${o.ok ? "" : ui.warn("  (re-run apply to retry what failed; imports are idempotent)")}`);
    if (o.ok && !dryRun) console.log(`\n  next  ${ui.bold(`dd2dash0 watch ${r._[0]}`)}   then   ${ui.bold(`dd2dash0 proof ${r._[0]}`)}`);
    return o.ok ? EXIT.ok : EXIT.failed;
  } catch (e) {
    // runApply only throws before importing (imports report failures per item), so this is a usage/config/API error.
    const msg = (e as Error).message;
    console.error(ui.bad(`dd2dash0 apply: ${msg}`));
    if (!/plan directory|plan schema/.test(msg)) console.error("  (apply re-reads the Datadog source to check it didn't change; pass --skip-source-check if it isn't reachable)");
    return EXIT.usage;
  }
}

async function runServe(args: string[]): Promise<number> {
  let out = "out", port = SERVE_PORT, pace = 700;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    if (a === "--out" && v) (out = v), i++;
    else if (a === "--port" && v && Number.isInteger(Number(v))) (port = Number(v)), i++;
    else if (a === "--pace" && v && Number.isFinite(Number(v))) (pace = Number(v)), i++;
    else {
      console.error(`unknown or incomplete option ${a}\n\n${USAGE}`);
      return EXIT.usage;
    }
  }
  try {
    loadReport(resolve(out));
  } catch (e) {
    console.error((e as Error).message);
    return EXIT.usage;
  }
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY?.trim();
  const { url } = await startServer({ outDir: resolve(out), port, pace, ...(agentId ? { agentId } : {}), ...(elevenLabsKey ? { elevenLabsKey } : {}) });
  console.log(`dd2dash0 live viewer: ${url}  (replaying ${join(out, "report.json")}; voice ${agentId && elevenLabsKey ? "on" : "off"}; Ctrl+C to stop)`);
  return new Promise<number>(() => {}); // keep serving
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  void Promise.resolve(main()).then((code) => {
    process.exitCode = code;
  });
}
