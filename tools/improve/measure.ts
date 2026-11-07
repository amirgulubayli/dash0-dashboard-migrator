// Subprocess entry: run the migrator of the checkout in the current directory over its fixtures, offline, and write
// a Snapshot. Usage (cwd = a checkout):  npx tsx <this file> <out.json>
// It imports the checkout's own src/, so a candidate workspace is measured with its own code and mapping tables.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotOf } from "./snapshot.js";

const out = process.argv[2];
if (!out) throw new Error("usage: measure.ts <out.json>");
const root = process.cwd();
const { migrate } = (await import(pathToFileURL(join(root, "src", "pipeline", "migrate.ts")).href)) as typeof import("../../src/pipeline/migrate.js");
const tmp = mkdtempSync(join(tmpdir(), "improve-"));
try {
  const run = await migrate({ ingest: { input: join(root, "fixtures", "datadog") }, mappingsDir: join(root, "mappings"), outDir: tmp, mode: "none", version: "improve" });
  writeFileSync(resolve(out), JSON.stringify(snapshotOf(run.report)));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
