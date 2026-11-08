// tools/improve: the build-time improvement loop (plan 06 §6). Not part of the migrator: src/ never imports it.
//
//   npx tsx tools/improve/main.ts [--rounds N] [--depth 1] [--budget-usd 5] [--max-turns 40] [--patience 2]
//                                 [--gap <key>] [--picker deterministic|jev] [--jev-review] [--dry-run] [--keep]
//
// Jev (plans 08, 09 §5) is OFF by default and only suggests. It runs only when asked (--picker jev: J2, choose among
// the top 5 deterministic gaps; --jev-review: J3, score each new mapping row's evidence after the gates pass) AND
// TYPESAFE_API_KEY is set AND JEV_DISABLED is not 1. Any Jev failure falls back to the deterministic path.
//
// Each round: measure the fixtures -> pick the biggest actionable gap -> one agent in a fresh worktree -> gates
// (scope, typecheck, all tests, determinism, no regression, untouched items byte-identical, the gap shrinks,
// coverage doesn't drop) -> pass: commit on branch improve/<gap> for review; fail: discard and record why.
// Stops at --rounds, at --budget-usd, or after --patience rounds without progress. Nothing is pushed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGaps, pickGap } from "./gaps.js";
import { evaluate, type CommandResults } from "./gates.js";
import { changedFiles, createWorkspace, measure, run, tail } from "./workspace.js";

interface Options {
  rounds: number;
  depth: number;
  budgetUsd: number;
  maxTurns: number;
  patience: number;
  gap: string | null;
  dryRun: boolean;
  keep: boolean;
  /** Who picks the gap: the deterministic ranking (default), or Jev among its top 5 (J2). */
  picker: "deterministic" | "jev";
  /** J3: Jev scores the evidence of new mapping rows after the gates pass. A note, never a gate. */
  jevReview: boolean;
}

function parse(argv: string[]): Options {
  const o: Options = { rounds: 1, depth: 1, budgetUsd: 5, maxTurns: 40, patience: 2, gap: null, dryRun: false, keep: false, picker: "deterministic", jevReview: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const num = () => {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} needs a positive number`);
      return n;
    };
    if (a === "--rounds") o.rounds = num();
    else if (a === "--depth") o.depth = num();
    else if (a === "--budget-usd") o.budgetUsd = num();
    else if (a === "--max-turns") o.maxTurns = num();
    else if (a === "--patience") o.patience = num();
    else if (a === "--gap") o.gap = argv[++i] ?? null;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--picker") {
      const v = argv[++i];
      if (v !== "jev" && v !== "deterministic") throw new Error("--picker is deterministic or jev");
      o.picker = v;
    } else if (a === "--jev-review") o.jevReview = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.depth !== 1) throw new Error("--depth > 1 (agents splitting a gap into sub-agents) is not in v0 yet");
  return o;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

async function main() {
  const o = parse(process.argv.slice(2));
  const base = process.cwd();
  const logDir = join(base, "out", "improve");
  mkdirSync(logDir, { recursive: true });
  const log = (s: string) => console.log(`[improve] ${s}`);

  let baseline = measure(base);
  log(`baseline: coverage exact ${baseline.coverageExact}, translated ${baseline.coverageTranslated}, ${baseline.items.length} items`);
  log("top gaps:");
  for (const g of findGaps(baseline).slice(0, 8)) log(`  ${g.actionable ? "*" : " "} ${g.key.padEnd(34)} score ${String(g.score).padStart(3)}  items ${g.items.length}`);

  // Jev is loaded only when asked for; without the flags tools/jev is never imported and nothing leaves the machine.
  const jev = o.picker === "jev" || o.jevReview ? (await import("../jev/client.js")).createJev({ requested: true, cacheDir: join(base, ".jev-cache") }) : null;
  if (jev) log(jev.reason);
  const jevUses = jev?.enabled ? await import("../jev/uses.js") : null;

  const tried = new Set<string>();
  let spent = 0;
  let idle = 0;
  for (let round = 1; round <= o.rounds; round++) {
    let gap = o.gap ? (findGaps(baseline).find((g) => g.key === o.gap) ?? null) : pickGap(baseline, tried);
    let pickedBy: Record<string, unknown> = { by: o.gap ? "--gap" : "deterministic" };
    if (!o.gap && o.picker === "jev" && jev && jevUses) {
      const p = await jevUses.pickGapWithJev(findGaps(baseline).filter((g) => !tried.has(g.key)), jev);
      if (p) {
        gap = p.gap;
        pickedBy = { ...p, gap: p.gap.key };
        log(`picker: ${p.label}${p.model ? ` (${p.model}, confidence ${p.confidence?.toFixed(2)})` : ""}: ${p.gap.key}${p.note ? ` (${p.note})` : ""}`);
        if (p.probabilities) log(`  ${Object.entries(p.probabilities).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`);
      }
    }
    if (!gap) {
      log(o.gap ? `gap ${o.gap} not found` : "no actionable gap left");
      break;
    }
    if (!gap.actionable) throw new Error(`gap ${gap.key} is not actionable in v0 (mapping-table gaps only)`);
    tried.add(gap.key);
    log(`round ${round}: gap ${gap.key} (${gap.items.length} items)`);
    if (o.dryRun) {
      log("dry run: not calling the agent. Examples:");
      for (const e of gap.examples) log(`  - ${e}`);
      break;
    }
    if (spent >= o.budgetUsd) {
      log(`budget spent ($${spent.toFixed(2)})`);
      break;
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("set ANTHROPIC_API_KEY (e.g. in your shell or a local .env you source) to run a round");
    const { runAgent } = await import("./agent.js"); // the SDK is loaded only for a real round
    const ws = createWorkspace(base);
    const record: Record<string, unknown> = { round, gap: gap.key, pickedBy, workspace: ws.dir, startedAt: new Date().toISOString() };
    let accepted = false;
    try {
      const a = await runAgent({ workspace: ws.dir, gap, baseline, maxTurns: o.maxTurns, budgetUsd: o.budgetUsd - spent, log });
      spent += a.costUsd;
      Object.assign(record, { agent: a });
      log(`agent: ${a.stop} after ${a.turns} turn(s), ~$${a.costUsd.toFixed(2)}`);
      if (a.submitted) {
        const typecheck = run("npx", ["tsc", "-p", ".", "--noEmit"], ws.dir);
        const tests = run("npx", ["vitest", "run"], ws.dir);
        const s1 = measure(ws.dir);
        const s2 = measure(ws.dir);
        const cmd: CommandResults = { typecheck: { ok: typecheck.ok, tail: tail(typecheck.out, 800) }, tests: { ok: tests.ok, tail: tail(tests.out, 800) }, deterministic: s1.outputHash === s2.outputHash };
        const files = changedFiles(ws.dir);
        const r = evaluate(baseline, s1, gap.key, files, cmd);
        Object.assign(record, { gates: r });
        for (const g of r.gates) log(`  ${g.ok ? "PASS" : "FAIL"} ${g.name}: ${g.detail.split("\n")[0]}`);
        if (r.ok) {
          // J3 (plan 09 §5): Jev scores each new mapping row's evidence (0-3), rows under 1.5 flagged. Never a gate.
          let jevNote = "";
          if (o.jevReview && jev && jevUses) {
            const review: Record<string, unknown> = {};
            for (const f of files.filter((x) => x.startsWith("mappings/") && x.endsWith(".yaml"))) {
              try {
                const before = existsSync(join(base, f)) ? readFileSync(join(base, f), "utf8") : null;
                const after = readFileSync(join(ws.dir, f), "utf8");
                const e = await jevUses.scoreEvidence(after, jev, jevUses.newMappingRows(before, after));
                review[f] = e;
                jevNote += "\n\n" + jevUses.evidenceNote(f, e);
                log(`jev review: ${f}: ${e.skipped ?? `${e.rows.length} new row(s) scored, ${e.flagged.length} flagged${e.flagged.length ? `: ${e.flagged.join(", ")}` : ""}`}`);
              } catch (err) {
                log(`jev review skipped for ${f}: ${err instanceof Error ? err.message : err}`);
              }
            }
            Object.assign(record, { jevReview: review });
          }
          const branch = `improve/${slug(gap.key)}-${new Date().toISOString().slice(0, 10)}`;
          const msg = `improve: close ${gap.key} (${r.gapBefore} -> ${r.gapAfter} findings)\n\n${a.summary}${jevNote}\n\nGenerated by tools/improve (build time; model claude-opus-5-5). Gates: ${r.gates.map((g) => g.name).join(", ")}.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
          const msgFile = join(ws.dir, "..", "COMMIT_MSG");
          writeFileSync(msgFile, msg);
          const steps = [run("git", ["switch", "-c", branch], ws.dir), run("git", ["add", "--", ...files], ws.dir), run("git", ["commit", "-q", "-F", msgFile], ws.dir)];
          if (steps.every((s) => s.ok)) {
            accepted = true;
            Object.assign(record, { branch });
            log(`accepted: committed on ${branch} (not pushed). Review it, then push and open a draft PR.`);
            baseline = s1;
            idle = 0;
          } else log(`gates passed but the commit failed:\n${steps.map((s) => tail(s.out, 400)).join("\n")}`);
        }
      }
    } finally {
      writeFileSync(join(logDir, `round-${round}-${slug(gap.key)}.json`), JSON.stringify(record, null, 2));
      if (!accepted) {
        idle++;
        if (o.keep) log(`kept the workspace for inspection: ${ws.dir}`);
        else ws.remove();
      } else {
        // The branch lives on in the shared repository; the worktree can go.
        ws.remove();
      }
    }
    if (idle >= o.patience) {
      log(`${idle} round(s) without progress; stopping`);
      break;
    }
  }
  log(`done. spent ~$${spent.toFixed(2)}. Logs: ${logDir}`);
}

main().catch((e) => {
  console.error(`[improve] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
