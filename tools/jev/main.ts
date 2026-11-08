// CLI for the Jev review tooling (plan 08). Off unless TYPESAFE_API_KEY is set (and JEV_DISABLED is not 1).
// Answers are cached under .jev-cache/. Output is a suggestion (Jev), never a migrator claim.
//   npx tsx tools/jev/main.ts priority <report.json> [out.json]   J1: review-priority.json sidecar (item id -> score)
//   npx tsx tools/jev/main.ts evidence <mapping.yaml>             J3: evidence score per mapping row
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createJev, JEV_LABEL } from "./client.js";
import { evidenceNote, reviewPriority, scoreEvidence } from "./uses.js";

const usage = "usage: main.ts priority <report.json> [out.json] | evidence <mapping.yaml>";

async function main() {
  const [cmd, file, out] = process.argv.slice(2);
  if (!((cmd === "priority" || cmd === "evidence") && file)) {
    console.error(usage);
    process.exit(2);
  }
  const jev = createJev({ requested: true });
  if (!jev.enabled) {
    console.log(`[jev] ${jev.reason}; nothing written`);
    return;
  }
  if (cmd === "priority") {
    const p = await reviewPriority(JSON.parse(readFileSync(file, "utf8")), jev);
    const dest = out ?? join(dirname(file), "review-priority.json");
    writeFileSync(dest, JSON.stringify(p, null, 2) + "\n");
    console.log(`[jev] ${JEV_LABEL}: ${p.items.length} items ranked by ${p.model} -> ${dest}`);
    for (const i of p.items.slice(0, 10)) console.log(`  ${i.score.toFixed(2)}  ${i.level.padEnd(12)}  ${i.id}`);
  } else {
    console.log(evidenceNote(file, await scoreEvidence(readFileSync(file, "utf8"), jev)));
  }
}

main().catch((e) => {
  console.error(`[jev] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
