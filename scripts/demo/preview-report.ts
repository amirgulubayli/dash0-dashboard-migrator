// Preview report.html offline: translate the bundled fixtures (no keys, nothing imported) and write two reports.
//
//   npx tsx scripts/demo/preview-report.ts [outDir]
//
//   <outDir>/dry/report.html    a dry run exactly as `dd2dash0` writes it (landed, live and success not measured)
//   <outDir>/keys.html          the `--browser` key page (static copy; the real one is served on 127.0.0.1)
//   <outDir>/live/report.html   the same items with SIMULATED landing and live-check results, so the live-only parts
//                               of the page (success, live column, failures) can be looked at without a Dash0 tenant.
//                               The simulated values are picked deterministically from the item id; they are not real.
// Default outDir: <os tmp>/dd2dash0-preview. The page itself is built by src/flow/report-html.ts, unchanged.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "../../src/pipeline/migrate.js";
import { decisionsOf, rowsOf, scoreOf, writeRunReport, type Row, type RunFacts } from "../../src/flow/score.js";
import type { Live } from "../../src/flow/verify.js";
import { _keysPage } from "../../src/flow/keys-web.js";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(process.argv[2] ?? join(tmpdir(), "dd2dash0-preview"));

const r = await migrate({ ingest: { input: join(root, "fixtures/datadog") }, source: { kind: "folder", site: null, path: "fixtures/datadog" }, mappingsDir: join(root, "mappings"), outDir: join(out, "work"), mode: "none", version: "preview" });
const report = r.report;
const items = report.items;
const review = { file: "", boundedApproved: 0, boundedFlagged: 0, acknowledged: 0, rulesApproved: items.filter((i) => i.kind === "alert" && (i.status === "exact" || i.status === "exact-under" || i.status === "bounded")).map((i) => i.id), rulesRejected: [], manualMonitors: [] };
const decisions = decisionsOf(review, items);
const facts = (mode: RunFacts["mode"]): RunFacts => ({
  version: report.run.version,
  source: "Datadog fixtures/datadog",
  target: mode === "live" ? "Dash0 demo / default (simulated results)" : "Dash0 (dry run)",
  mode,
  inputHash: report.run.inputHash,
  outputHash: report.run.outputHash,
  planHash: createHash("sha256").update(report.run.outputHash).digest("hex"),
  windowSeconds: 3600,
  startedAt: "2026-11-08T10:00:00.000Z",
});

// Dry run: exactly what the guided flow writes without an import.
const dryRows = rowsOf(report, decisions, null, false);
mkdirSync(join(out, "dry"), { recursive: true });
const dry = writeRunReport(join(out, "dry"), scoreOf(dryRows), dryRows, facts("dry-run"));

// Simulated live run: deterministic pseudo-results per item id.
const h = (s: string) => createHash("sha256").update(s).digest()[0]!;
const liveRows: Row[] = dryRows.map((row) => {
  const placeholder = row.status === "manual" || row.status === "unsupported";
  const landed = !(row.kind === "alert" && placeholder) && h(row.id + "l") > 6;
  const hasQuery = row.promql.length > 0;
  const x = h(row.id + "v");
  const live: Live = !hasQuery || placeholder ? "n/a" : x < 14 ? "missing" : x < 22 ? "error" : x < 60 ? "no-data" : "live";
  const liveDetail = live === "missing" ? "metric not received in Dash0 yet (check the collector)" : live === "error" ? "parse error: unexpected character" : undefined;
  const success = row.translated && landed && live !== "missing" && live !== "error";
  return { ...row, landed, landedDetail: landed ? "created, read-back match" : row.kind === "alert" && placeholder ? "no check rule (not translatable)" : "created, read-back mismatch", live, ...(liveDetail ? { liveDetail } : {}), success, ...(row.kind === "alert" && landed ? { enabled: h(row.id + "e") > 128 } : {}) };
});
mkdirSync(join(out, "live"), { recursive: true });
const live = writeRunReport(join(out, "live"), scoreOf(liveRows), liveRows, facts("live"));

// The one-time key page (served by `--browser` with a strict CSP; here a static copy for looking at it).
const keys = join(out, "keys.html");
writeFileSync(keys, _keysPage({ need: { datadog: true, dash0: true }, known: { DD_SITE: "datadoghq.eu", DASH0_DATASET: "default", DASH0_AUTH_TOKEN: "auth_preview_0000_abcd" }, cwd: "~/work/migration", onReady: () => {} }, "preview"));

console.log(`dry   ${pathToFileURL(dry.html).href}`);
console.log(`live  ${pathToFileURL(live.html).href}`);
console.log(`keys  ${pathToFileURL(keys).href}`);
