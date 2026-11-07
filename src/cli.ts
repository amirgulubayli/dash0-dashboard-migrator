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

export const VERSION = "0.2.0";

const USAGE = `dd2dash0 ${VERSION}: migrate Datadog dashboards + monitors to Dash0 (Perses, PromQL, check rules)

Usage:
  dd2dash0 plan  (--input <dir> | --api) [--config dd2dash0.yaml] [--out plan] [options]   translate, import nothing
  dd2dash0 review <plan dir> [--terminal] [--port 4318] [--reviewer <name>]                 decide what gets imported
  dd2dash0 apply <plan dir> --approved <review.json> [--enable-rules] [--allow-pending] [--dry-run]
  dd2dash0 migrate --from datadog (--input <dir> | --api) [options]                        one-shot: translate + import all
  dd2dash0 serve [--out <dir>] [--port 4317] [--pace <ms>]    live viewer (+ voice narrator) for a run

Options:
  --input <dir>        folder of exported Datadog JSON or YAML (dashboards and monitors, any depth)
  --api                read from the Datadog API (DD_SITE, default datadoghq.eu; DD_API_KEY, DD_APP_KEY)
  --dry-run            translate and write the Dash0 payloads to <out>/dash0, import nothing
  --no-import          translate and report only
  --out <dir>          output directory (default ./out): report.json, report.md, dash0/
  --only <what>        dashboards | monitors
  --enable-rules       import check rules enabled (default: disabled, D-30)
  --mappings <dir>     mapping tables (default: the package's mappings/)
  --channels <file>    Datadog @handle -> existing Dash0 notification channel id (default: <mappings>/notification-channels.yaml)

plan writes a plan directory (report.json, report.md, events.jsonl, dash0/ payloads, plan.lock). A review
(review.json from the console) binds to the plan's hash; apply imports only what was approved and refuses on a
changed plan, a review of another plan, a changed Datadog source, or approximate panels with no decision.
Exit codes (plan, apply): 0 ok, 1 some imports failed, 2 refused, 3 usage or config error.

migrate writes <out>/report.json, report.md, events.jsonl and (unless --no-import) <out>/dash0/.
serve replays <out>'s run in the browser; with ELEVENLABS_AGENT_ID + ELEVENLABS_API_KEY set, an ElevenLabs
voice agent narrates it and answers questions (setup: src/serve/VOICE_AGENT.md).

Live import needs DASH0_API_URL and DASH0_AUTH_TOKEN (and optionally DASH0_DATASET), e.g.
  npx tsx --env-file=.env src/cli.ts migrate --from datadog --input fixtures/datadog

Translation is deterministic: rules, parsers and mapping tables. No LLM is involved.`;

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
  if (cmd === "migrate") return runMigrate(rest);
  if (cmd === "serve") return runServe(rest);
  console.error(`unknown command: ${cmd} (try --help)`);
  return 2;
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
  const f: Flags = { api: false, dryRun: false, noImport: false, out: "out", enableRules: false, mappings: join(import.meta.dirname, "..", "mappings") };
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
    return 2;
  }
  const mode = f.noImport ? "none" : f.dryRun ? "dry-run" : "live";
  let dash0;
  if (mode === "live") {
    try {
      dash0 = configFromEnv();
    } catch (e) {
      console.error(`${(e as Error).message}\nUse --dry-run to translate without importing.`);
      return 2;
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
    for (const l of summaryLines(r.report, files)) console.log(l);
    if (r.manifest) {
      for (const x of r.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    }
    return overallOk(r) ? 0 : 1;
  } catch (e) {
    console.error(`dd2dash0: ${(e as Error).message}`);
    return 1;
  }
}

const EXIT = { ok: 0, failed: 1, refused: 2, usage: 3 } as const;

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
      defaultMappingsDir: join(import.meta.dirname, "..", "mappings"),
      ...(config.source.kind === "folder" ? { resolvedInput: resolve(config.source.path) } : {}),
      ...(only ? { only: only as "dashboards" | "monitors" } : {}),
      version: VERSION,
    });
    for (const l of summaryLines(p.result.report, p.files)) console.log(l);
    console.log(`  plan ${p.planHash.slice(0, 16)}  ->  next: review it (dd2dash0 review ${r.v["--out"] ?? "plan"}), then dd2dash0 apply ${r.v["--out"] ?? "plan"} --approved <review.json>`);
    return EXIT.ok;
  } catch (e) {
    console.error(`dd2dash0 plan: ${(e as Error).message}`);
    return EXIT.failed;
  }
}

async function runReviewCmd(args: string[]): Promise<number> {
  const r = readArgs(args, ["--port", "--reviewer", "--console"], ["--terminal", "--all"]);
  if (typeof r === "string" || r._.length !== 1) {
    console.error(`${typeof r === "string" ? r : "usage: dd2dash0 review <plan dir> [--terminal]"}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const planDir = resolve(r._[0]!);
  const reviewer = r.v["--reviewer"] ?? process.env.USER ?? "";
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
  const port = Number(r.v["--port"] ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port must be a port number");
    return EXIT.usage;
  }
  const consoleDir = r.v["--console"] ? resolve(r.v["--console"]) : findConsoleDir(import.meta.dirname);
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
      console.error("dd2dash0 apply: refused");
      for (const x of o.reasons) console.error(`  ${x}`);
      return EXIT.refused;
    }
    const m = o.manifest.summary;
    console.log(`dd2dash0 apply: ${dryRun ? "dry run, nothing imported" : "imported"}: ${o.imported.dashboards} dashboard(s), ${o.imported.rules} check rule(s)`);
    console.log(`  ${dryRun ? `written ${m["dry-run"]}` : `imported ${m.imported}, read back identical ${m.readBackMatch}`}, failed ${m.failed}, rejected by preflight ${m["rejected-preflight"]}`);
    if (o.placeholders.length) console.log(`  flagged in review -> placeholder: ${o.placeholders.length} panel(s)`);
    if (o.skippedAlerts.length) console.log(`  check rules not imported (flagged or not approved): ${o.skippedAlerts.join(", ")}`);
    for (const x of o.manifest.results.filter((x) => x.errors.length)) console.error(`  ! ${x.kind} ${x.id}: ${x.errors.join("; ")}${x.traceId ? ` (traceId ${x.traceId})` : ""}`);
    console.log(`  report: ${o.reportFile}${o.ok ? "" : "  (re-run apply to retry what failed; imports are idempotent)"}`);
    return o.ok ? EXIT.ok : EXIT.failed;
  } catch (e) {
    console.error(`dd2dash0 apply: ${(e as Error).message}`);
    return EXIT.failed;
  }
}

async function runServe(args: string[]): Promise<number> {
  let out = "out", port = 4317, pace = 700;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    if (a === "--out" && v) (out = v), i++;
    else if (a === "--port" && v && Number.isInteger(Number(v))) (port = Number(v)), i++;
    else if (a === "--pace" && v && Number.isFinite(Number(v))) (pace = Number(v)), i++;
    else {
      console.error(`unknown or incomplete option ${a}\n\n${USAGE}`);
      return 2;
    }
  }
  try {
    loadReport(resolve(out));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
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
