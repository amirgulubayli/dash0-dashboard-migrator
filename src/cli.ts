#!/usr/bin/env node
// dd2dash0 CLI entry point (T8 owns this file; HOT: post CONTRACT before changing flags).
// Planned: dd2dash0 migrate --from datadog [--input ./exports | --api] [--dry-run] [--out ./out] [--only dashboards|monitors]

export const VERSION = "0.1.0";

export function main(argv: string[] = process.argv.slice(2)): number {
  const [cmd] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`dd2dash0 ${VERSION}: migrate Datadog dashboards + monitors to Dash0 (Perses, PromQL, check rules)

Usage:
  dd2dash0 migrate --from datadog (--input <dir> | --api) [--dry-run] [--out <dir>] [--only dashboards|monitors]

Not implemented yet. See the task board (tasks T1-T8).`);
    return 0;
  }
  if (cmd === "--version") { console.log(VERSION); return 0; }
  console.error(`unknown command: ${cmd} (try --help)`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts")) {
  process.exitCode = main();
}
