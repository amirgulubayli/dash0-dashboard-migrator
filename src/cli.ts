#!/usr/bin/env node
// dd2dash0 CLI (T8; HOT: post a CONTRACT before changing flags).
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFromEnv } from "./targets/dash0/index.js";
import { migrate, overallOk } from "./pipeline/migrate.js";
import { summaryLines, writeReport } from "./report/index.js";
import { reportToEvents } from "./report/events.js";
import { loadReport, startServer } from "./serve/server.js";

export const VERSION = "0.2.0";

const USAGE = `dd2dash0 ${VERSION}: migrate Datadog dashboards + monitors to Dash0 (Perses, PromQL, check rules)

Usage:
  dd2dash0 migrate --from datadog (--input <dir> | --api) [options]
  dd2dash0 serve [--out <dir>] [--port 4317] [--pace <ms>]    live viewer (+ voice narrator) for a run

Options:
  --input <dir>        folder of exported Datadog JSON (dashboards and monitors, any depth)
  --api                read from the Datadog API (DD_SITE, default datadoghq.eu; DD_API_KEY, DD_APP_KEY)
  --dry-run            translate and write the Dash0 payloads to <out>/dash0, import nothing
  --no-import          translate and report only
  --out <dir>          output directory (default ./out): report.json, report.md, dash0/
  --only <what>        dashboards | monitors
  --enable-rules       import check rules enabled (default: disabled, D-30)
  --mappings <dir>     mapping tables (default: the package's mappings/)

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
      mappingsDir: resolve(f.mappings),
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
