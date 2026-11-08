// tools/gaps: plan 10 steps 1-2 (MEASURE + DECOMPOSE). Build time only; src/ never imports it; no model is called.
//
//   npm run gaps -- [--corpus <dir>] [--report <report.json> ...] [--include-exact-under] [--round N]
//                   [--in-flight <lever key> ...] [--out out/gaps]
//
// Runs `dd2dash0 migrate --from datadog --input fixtures/datadog --no-import` in this checkout (plus --corpus, if
// given), or reads --report files instead, builds the gap tree and writes <out>/gaps.json + <out>/gaps.md.
// Same input, same bytes: gaps.json has no timestamps, everything is sorted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { migrate, stableJson, type GapReport } from "../lib/report.js";
import { loadContext } from "./context.js";
import { buildGaps, renderMarkdown, type GapsDoc } from "./gaps.js";

export interface GapsOptions {
  root: string;
  corpus: string | null;
  reports: string[];
  includeExactUnder: boolean;
  round: number;
  inFlight: string[];
  out: string;
}

export function parseGapsArgs(argv: string[], root = process.cwd()): GapsOptions {
  const o: GapsOptions = { root, corpus: null, reports: [], includeExactUnder: false, round: 1, inFlight: [], out: join(root, "out", "gaps") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--corpus") o.corpus = resolve(val());
    else if (a === "--report") o.reports.push(resolve(val()));
    else if (a === "--include-exact-under") o.includeExactUnder = true;
    else if (a === "--round") o.round = Number(val());
    else if (a === "--in-flight") o.inFlight.push(val());
    else if (a === "--out") o.out = resolve(val());
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(o.round) || o.round < 1) throw new Error("--round needs a positive integer");
  return o;
}

/** Measure (or read the given reports) and decompose. */
export function runGaps(o: GapsOptions): { doc: GapsDoc; md: string; notesFile: string | null } {
  const sources: { label: string; report: GapReport }[] = [];
  if (o.reports.length) for (const f of o.reports) sources.push({ label: o.reports.length === 1 ? "fixtures" : basename(f, ".json"), report: JSON.parse(readFileSync(f, "utf8")) as GapReport });
  else {
    sources.push({ label: "fixtures", report: migrate(o.root, join(o.root, "fixtures", "datadog")).report });
    if (o.corpus) sources.push({ label: "corpus", report: migrate(o.root, o.corpus).report });
  }
  const ctx = loadContext(o.root);
  const doc = buildGaps(sources, ctx, { includeExactUnder: o.includeExactUnder, round: o.round, inFlight: o.inFlight });
  return { doc, md: renderMarkdown(doc, o.inFlight), notesFile: ctx.notesFile };
}

export function writeGaps(o: GapsOptions, doc: GapsDoc, md: string): void {
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "gaps.json"), stableJson(doc));
  writeFileSync(join(o.out, "gaps.md"), md);
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/gaps/main.ts");
if (isMain) {
  try {
    const o = parseGapsArgs(process.argv.slice(2));
    const { doc, md } = runGaps(o);
    writeGaps(o, doc, md);
    console.log(md);
    console.log(`[gaps] ${doc.root.inGap} items in the gap, ${doc.levers.length} levers, ${doc.waves.length} parallel wave(s). Wrote ${join(o.out, "gaps.json")} and gaps.md`);
  } catch (e) {
    console.error(`[gaps] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
