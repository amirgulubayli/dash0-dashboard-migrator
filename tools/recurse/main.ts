// tools/recurse: plan 10's loop driver. MEASURE + DECOMPOSE (tools/gaps), then the ROUND PLAN, and with --brief one
// markdown brief per lever. It never calls a model: a person (or an agent they start) picks a brief up.
//
//   npm run recurse -- [--round N] [--base <branch>] [--in-flight <lever key> ...] [--brief [dir]] [--post]
//                      [--corpus <dir>] [--report <report.json>] [--branch-prefix amir/claude] [--out out/recurse]
//
// --post sends the round plan to the hub: node $HUB_POST --room dash0-promql "<text>" (HUB_POST defaults to the nearest
// scripts/hub-post.mjs in a parent directory, i.e. the dash0-team workspace).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseGapsArgs, runGaps, writeGaps } from "../gaps/main.js";
import { stableJson } from "../lib/report.js";
import { brief, hubText, leverBranch, roundPlan, slug, type PlanOptions } from "./plan.js";

interface RecurseOptions {
  gapArgs: string[];
  round: number;
  base: string;
  inFlight: string[];
  brief: string | null;
  post: boolean;
  branchPrefix: string;
  out: string;
}

function parse(argv: string[], root: string): RecurseOptions {
  const o: RecurseOptions = { gapArgs: [], round: 1, base: process.env.RECURSE_BASE || "feature/datadog-to-dash0", inFlight: [], brief: null, post: false, branchPrefix: "lever", out: join(root, "out", "recurse") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--round") o.round = Number(val());
    else if (a === "--base") o.base = val();
    else if (a === "--in-flight") o.inFlight.push(val());
    else if (a === "--brief") o.brief = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? resolve(argv[++i]!) : "";
    else if (a === "--post") o.post = true;
    else if (a === "--branch-prefix") o.branchPrefix = val();
    else if (a === "--out") o.out = resolve(val());
    else if (a === "--corpus" || a === "--report") o.gapArgs.push(a, val());
    else if (a === "--include-exact-under") o.gapArgs.push(a);
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(o.round) || o.round < 1) throw new Error("--round needs a positive integer");
  return o;
}

function hubPost(from: string): string | null {
  if (process.env.HUB_POST) return process.env.HUB_POST;
  let d = resolve(from);
  for (let i = 0; i < 8; i++) {
    const f = join(d, "scripts", "hub-post.mjs");
    if (existsSync(f)) return f;
    if (dirname(d) === d) break;
    d = dirname(d);
  }
  return null;
}

async function main() {
  const root = process.cwd();
  const o = parse(process.argv.slice(2), root);
  const gopts = parseGapsArgs([...o.gapArgs, "--round", String(o.round), ...o.inFlight.flatMap((k) => ["--in-flight", k]), "--out", join(o.out, `round-${o.round}`)], root);
  const { doc, md, notesFile } = runGaps(gopts);
  writeGaps(gopts, doc, md);
  const popts: PlanOptions = { baseBranch: o.base, inFlight: o.inFlight, branchPrefix: o.branchPrefix };
  const plan = roundPlan(doc, popts);
  writeFileSync(join(gopts.out, "round-plan.md"), plan);
  console.log(plan);
  console.log(md);
  if (!notesFile) console.error("[recurse] NOTES.md not found (set NOTES_MD): owners show as '?'");

  if (o.brief !== null) {
    const dir = o.brief || join(gopts.out, "briefs");
    mkdirSync(dir, { recursive: true });
    const fl = new Set(o.inFlight);
    const index: { lever: string; file: string; branch: string | null }[] = [];
    for (const l of doc.levers) {
      if (fl.has(l.key)) continue;
      const file = `${String(index.length + 1).padStart(2, "0")}-${slug(l.key)}.md`;
      writeFileSync(join(dir, file), brief(doc, l, popts));
      index.push({ lever: l.key, file, branch: l.kind === "mapping" || l.kind === "rule" ? leverBranch(doc, l, popts) : null });
    }
    writeFileSync(join(dir, "index.json"), stableJson(index));
    console.error(`[recurse] wrote ${index.length} brief(s) to ${dir}`);
  }

  if (o.post) {
    const script = hubPost(root);
    if (!script) throw new Error("--post: hub-post.mjs not found; set HUB_POST");
    // No shell: the text goes to node as one argv entry, whatever it contains.
    const r = spawnSync(process.execPath, [script, "--room", "dash0-promql", hubText(doc, popts)], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`hub post failed: ${r.stdout}${r.stderr}`);
    console.error(`[recurse] ${r.stdout.trim()}`);
  }
}

main().catch((e) => {
  console.error(`[recurse] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
