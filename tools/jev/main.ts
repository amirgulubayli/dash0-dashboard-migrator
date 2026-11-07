// CLI for the Jev review tooling (plan 08). Needs TYPESAFE_API_KEY. Answers are cached under out/jev-cache.
//   npx tsx tools/jev/main.ts priority <report.json> [out.json]   J1: review-priority sidecar for the console
//   npx tsx tools/jev/main.ts evidence <mapping.yaml>             J3: evidence score per mapping row
import { readFileSync, writeFileSync } from "node:fs";
import { evidenceNote, reviewPriority, scoreEvidence } from "./uses.js";

async function main() {
  const [cmd, file, out] = process.argv.slice(2);
  if (cmd === "priority" && file) {
    const p = await reviewPriority(JSON.parse(readFileSync(file, "utf8")));
    const dest = out ?? file.replace(/\.json$/, "") + ".review-priority.json";
    writeFileSync(dest, JSON.stringify(p, null, 2));
    console.log(`[jev] ${p.items.length} items ranked by ${p.model} -> ${dest}`);
    for (const i of p.items.slice(0, 10)) console.log(`  ${i.score.toFixed(2)}  ${i.level.padEnd(12)}  ${i.id}`);
  } else if (cmd === "evidence" && file) {
    console.log(evidenceNote(file, await scoreEvidence(readFileSync(file, "utf8"))));
  } else {
    console.error("usage: main.ts priority <report.json> [out.json] | evidence <mapping.yaml>");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[jev] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
