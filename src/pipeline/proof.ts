// dd2dash0 proof (wow-factor spec W4): one self-contained HTML page per run that keeps the evidence.
// Inputs: a plan directory (report.json, plan.lock), plus what later steps wrote there (apply/report.json, watch/),
// plus an optional corpus summary (scripts/corpus-coverage.ts --json). Output: <plan>/proof/proof.html.
//
// Rules: no network (no scripts, fonts, images or links that load anything), deterministic (the page is a function of
// the input files only: no clock, no random ids), and never claims more than the inputs say. A part we did not
// measure says so instead of disappearing; the Dash0 lane of the alert timeline is labelled "computed".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Report, ReportItem } from "../report/types.js";
import { readLock, verifyPlan } from "./plan-lock.js";
import type { AlertState, ParityResult, WatchEvent } from "./watch.js";

const STATUSES = ["exact", "exact-under", "bounded", "manual", "unsupported"] as const;
type St = (typeof STATUSES)[number];

/** Plain words for each status, shown in the legend and the table. */
const STATUS_WORDS: Record<St, string> = {
  exact: "exact",
  "exact-under": "exact, under stated assumptions",
  bounded: "approximate, with a stated error bound",
  manual: "needs a person",
  unsupported: "no Dash0 equivalent",
};

export interface CorpusSummary {
  dashboards?: number;
  monitors?: number;
  pipeline?: { panels?: { total: number; by: Record<string, number> }; alerts?: { total: number; by: Record<string, number> } };
}

export interface ProofInputs {
  report: Report;
  planHash: string;
  planIntact: boolean;
  /** True when the report came from apply/report.json (the import happened, live or dry-run). */
  applied: boolean;
  watch: { startedAt?: string; endedAt?: string; events: WatchEvent[] } | null;
  parity: ParityResult[] | null;
  corpus: CorpusSummary | null;
}

/** Read everything the card needs from a plan directory. Missing optional parts become null, never an error. */
export function readProofInputs(planDir: string, corpusFile?: string): ProofInputs {
  if (!existsSync(join(planDir, "report.json"))) throw new Error(`${planDir} has no report.json: run 'dd2dash0 plan' first`);
  const appliedFile = join(planDir, "apply", "report.json");
  const applied = existsSync(appliedFile);
  const report = JSON.parse(readFileSync(applied ? appliedFile : join(planDir, "report.json"), "utf8")) as Report;
  const check = verifyPlan(planDir);
  const planHash = check.ok ? check.planHash : readLock(planDir).planHash;
  const json = <T>(f: string): T | null => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null);
  const watch = json<{ startedAt?: string; endedAt?: string; events: WatchEvent[] }>(join(planDir, "watch", "timeline.json"));
  const parity = json<{ results: ParityResult[] }>(join(planDir, "watch", "parity.json"))?.results ?? null;
  const corpus = corpusFile ? json<CorpusSummary>(corpusFile) : null;
  if (corpusFile && !corpus) throw new Error(`corpus file not found: ${corpusFile}`);
  return { report, planHash, planIntact: check.ok, applied, watch, parity, corpus };
}

// ------------------------------------------------------------------ helpers

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Percentage, floored to one decimal (coverage is never rounded up). */
const pctFloor = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;
const short = (h: string | null | undefined) => (h ? h.slice(0, 12) : "not recorded");
const hhmmss = (iso: string) => iso.slice(11, 19);
const dur = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

const STATE: Record<AlertState, { label: string; icon: string; cls: string }> = {
  ok: { label: "ok", icon: "✓", cls: "st-ok" },
  degraded: { label: "degraded", icon: "▲", cls: "st-warn" },
  failed: { label: "failed", icon: "✕", cls: "st-crit" },
  nodata: { label: "no data", icon: "○", cls: "st-none" },
  unknown: { label: "unknown", icon: "?", cls: "st-none" },
};

function counts(by: Partial<Record<string, number>> | undefined): { s: St; n: number }[] {
  return STATUSES.map((s) => ({ s, n: by?.[s] ?? 0 }));
}

// ------------------------------------------------------------------ parts

/** A 100% composition bar: one row per thing measured, ordinal fill per status, 2px surface gaps between segments. */
function coverageBar(label: string, parts: { s: St; n: number }[]): string {
  const total = parts.reduce((a, p) => a + p.n, 0);
  const W = 640;
  const H = 28;
  let x = 0;
  const segs: string[] = [];
  const shown = parts.filter((p) => p.n > 0);
  shown.forEach((p, i) => {
    const w = total ? (p.n / total) * W : 0;
    const gap = i < shown.length - 1 ? 2 : 0;
    const rx = i === 0 || i === shown.length - 1 ? 4 : 0;
    const share = total ? pctFloor(p.n / total) : "0.0%";
    segs.push(
      `<rect class="fill-${p.s}" x="${x.toFixed(2)}" y="0" width="${Math.max(0, w - gap).toFixed(2)}" height="${H}" rx="${rx}"><title>${esc(label)}: ${p.n} ${esc(p.s)} (${share}), ${esc(STATUS_WORDS[p.s])}</title></rect>`,
    );
    if (w > 34) segs.push(`<text class="in-${p.s}" x="${(x + (w - gap) / 2).toFixed(2)}" y="18.5" text-anchor="middle">${p.n}</text>`);
    x += w;
  });
  return `<div class="bar-row"><div class="bar-label">${esc(label)} <span class="muted">${total}</span></div><svg class="bar" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}: ${shown.map((p) => `${p.n} ${p.s}`).join(", ")}">${segs.join("")}</svg></div>`;
}

function legend(): string {
  return `<ul class="legend">${STATUSES.map((s) => `<li><span class="sw fill-${s}"></span><b>${s}</b> <span class="muted">${esc(STATUS_WORDS[s])}</span></li>`).join("")}</ul>`;
}

function coverageTable(rows: { label: string; parts: { s: St; n: number }[] }[]): string {
  const head = `<tr><th></th>${STATUSES.map((s) => `<th class="num">${s}</th>`).join("")}<th class="num">total</th></tr>`;
  const body = rows
    .map((r) => {
      const t = r.parts.reduce((a, p) => a + p.n, 0);
      return `<tr><th>${esc(r.label)}</th>${r.parts.map((p) => `<td class="num">${p.n}</td>`).join("")}<td class="num">${t}</td></tr>`;
    })
    .join("");
  return `<details><summary>Table view</summary><table class="data">${head}${body}</table></details>`;
}

function verdictTile(p: ParityResult, title: string): string {
  const v = p.verdict === "pass" ? { cls: "st-ok", icon: "✓", word: "PASS" } : p.verdict === "fail" ? { cls: "st-crit", icon: "✕", word: "FAIL" } : { cls: "st-none", icon: "○", word: "NO INCIDENT" };
  const gap =
    p.fireGapMs !== null
      ? `<div class="hero">${esc(dur(p.fireGapMs))}</div><div class="muted">between the two firings · bound ${esc(dur(p.boundMs))}</div>`
      : `<div class="hero muted">–</div><div class="muted">${p.verdict === "no-incident" ? "nothing fired while watching" : "one side never fired"}</div>`;
  const rec = p.recoverGapMs !== null ? `<div class="muted">recovered ${esc(dur(p.recoverGapMs))} apart</div>` : "";
  const reasons = p.reasons.length ? `<ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  return `<div class="tile"><div class="tile-title">${esc(title)}</div><div class="verdict ${v.cls}"><span class="icon" aria-hidden="true">${v.icon}</span> ${v.word}</div>${gap}${rec}${reasons}</div>`;
}

/** Two lanes (Datadog, Dash0) of state segments over the watch window, firing marks and the measured gap. */
function timeline(events: WatchEvent[], alertId: string, p: ParityResult | undefined, window: { startedAt?: string; endedAt?: string }): string {
  const mine = events.filter((e) => e.alertId === alertId);
  if (!mine.length) return `<p class="muted">No events recorded for this alert.</p>`;
  const times = mine.map((e) => Date.parse(e.at));
  const t0 = Math.min(Date.parse(window.startedAt ?? mine[0]!.at), ...times);
  const t1 = Math.max(Date.parse(window.endedAt ?? mine[mine.length - 1]!.at), ...times, t0 + 1000);
  const L = 92;
  const W = 720;
  const plotW = W - L - 8;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * plotW;
  const laneY = { datadog: 34, dash0: 74 } as const;
  const LH = 28;
  const out: string[] = [];
  for (const side of ["datadog", "dash0"] as const) {
    const evs = mine.filter((e) => e.side === side);
    const y = laneY[side];
    out.push(`<text class="lane-label" x="0" y="${y + 18}">${side === "datadog" ? "Datadog" : "Dash0"}</text>`);
    if (side === "dash0" && evs.some((e) => e.method === "computed")) out.push(`<text class="lane-sub" x="0" y="${y + 30}">computed</text>`);
    evs.forEach((e, i) => {
      const a = Date.parse(e.at);
      const b = i + 1 < evs.length ? Date.parse(evs[i + 1]!.at) : t1;
      const x0 = X(a);
      const w = Math.max(1, X(b) - x0 - (i + 1 < evs.length ? 2 : 0));
      const st = STATE[e.to];
      out.push(
        `<rect class="${st.cls}" x="${x0.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${LH}" rx="4"><title>${side === "datadog" ? "Datadog" : "Dash0"}${e.method === "computed" ? " (computed)" : ""}: ${st.label} from ${hhmmss(e.at)}${e.value !== undefined ? `, value ${+e.value.toFixed(2)}` : ""}</title></rect>`,
      );
      if (w > 64) out.push(`<text class="in-${st.cls}" x="${(x0 + 8).toFixed(2)}" y="${y + 18.5}">${st.icon} ${st.label}</text>`);
    });
  }
  // Firing marks and the gap between them.
  const fired = p ? { datadog: p.datadog.firedAt, dash0: p.dash0.firedAt } : { datadog: null, dash0: null };
  for (const side of ["datadog", "dash0"] as const) {
    const at = fired[side];
    if (at) out.push(`<line class="mark" x1="${X(Date.parse(at)).toFixed(2)}" x2="${X(Date.parse(at)).toFixed(2)}" y1="${laneY[side] - 4}" y2="${laneY[side] + LH + 4}"/>`);
  }
  if (fired.datadog && fired.dash0 && p?.fireGapMs !== null && p) {
    const a = X(Date.parse(fired.datadog));
    const b = X(Date.parse(fired.dash0));
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    out.push(`<path class="bracket" d="M${lo.toFixed(2)},28 V22 H${hi.toFixed(2)} V28"/>`);
    out.push(`<text class="gap-label" x="${((lo + hi) / 2).toFixed(2)}" y="16" text-anchor="middle">${esc(dur(p.fireGapMs!))} apart</text>`);
  }
  // Time axis: start, middle, end (UTC).
  const ticks = [t0, (t0 + t1) / 2, t1];
  ticks.forEach((t, i) => {
    const anchor = i === 0 ? "start" : i === 2 ? "end" : "middle";
    out.push(`<text class="tick" x="${X(t).toFixed(2)}" y="124" text-anchor="${anchor}">${hhmmss(new Date(Math.round(t)).toISOString())} UTC</text>`);
  });
  const rows = mine
    .map((e) => `<tr><td>${hhmmss(e.at)}</td><td>${e.side === "datadog" ? "Datadog" : "Dash0"}</td><td>${esc(e.method)}</td><td>${e.from ? esc(STATE[e.from].label) : "–"} → ${esc(STATE[e.to].label)}</td><td class="num">${e.value !== undefined ? +e.value.toFixed(2) : ""}</td></tr>`)
    .join("");
  return `<svg class="timeline" viewBox="0 0 ${W} 130" role="img" aria-label="Alert states over time for Datadog and Dash0">${out.join("")}</svg>
<details><summary>Table view (${mine.length} state changes)</summary><table class="data"><tr><th>time (UTC)</th><th>side</th><th>method</th><th>change</th><th class="num">value</th></tr>${rows}</table></details>`;
}

function manualRows(items: ReportItem[], reasonPlain: (code: string) => string | null): string {
  const todo = items.filter((i) => i.kind !== "group" && (i.status === "manual" || i.status === "unsupported"));
  if (!todo.length) return `<p>Nothing needs a person: every item was translated.</p>`;
  const rows = todo
    .map((i) => {
      const why = i.explain?.plain || i.reason_codes.map((c) => reasonPlain(c) ?? c).join("; ");
      const codes = i.reason_codes.length ? `<div class="muted code">${i.reason_codes.map(esc).join(", ")}</div>` : "";
      return `<tr><td>${esc(i.title)}<div class="muted">${esc(i.kind === "alert" ? "monitor" : i.widget_type)}</div></td><td>${esc(i.status)}</td><td>${esc(why)}${codes}</td><td>${(i.manual_actions ?? []).map(esc).join("<br>")}</td></tr>`;
    })
    .join("");
  return `<table class="data"><tr><th>Item</th><th>Status</th><th>Why</th><th>What to do</th></tr>${rows}</table>`;
}

// ------------------------------------------------------------------ page

export function renderProof(x: ProofInputs): string {
  const r = x.report;
  const run = r.run;
  const src = run.source?.kind === "api" ? `Datadog API (${run.source.site ?? "site not recorded"})` : `Datadog export folder (${basename(run.source?.path ?? "") || "not recorded"})`;
  const ds = (run.config as { dash0?: { dataset?: string } } | undefined)?.dash0?.dataset ?? "default";
  const panels = counts(r.summary.byKind?.panel);
  const alerts = counts(r.summary.byKind?.alert);
  const titleOf = new Map(r.items.map((i) => [i.id, i.title]));
  const plain = (code: string) => r.reasonCodes?.[code]?.plain ?? null;

  const imp = r.summary.import;
  const importLine = x.applied && imp
    ? `${imp.mode === "live" ? "Imported into Dash0" : "Applied as a dry run"}: ${imp.mode === "live" ? `${imp.imported} imported, ${imp.readBackMatch} read back identical, ${imp.failed} failed, ${imp.rejected} rejected by preflight` : `${imp.written} payloads written, nothing imported`}.`
    : "Planned, not imported yet (no apply/report.json in this plan).";

  const verdicts = x.parity?.length
    ? `<div class="tiles">${x.parity.map((p) => verdictTile(p, titleOf.get(p.alertId) ?? p.alertId)).join("")}</div>`
    : `<p class="muted">Not watched yet. Run <code>dd2dash0 watch &lt;plan&gt;</code> during an incident to record both alerts.</p>`;
  const timelines =
    x.watch && x.parity?.length
      ? x.parity.map((p) => `<h3>${esc(titleOf.get(p.alertId) ?? p.alertId)}</h3>${timeline(x.watch!.events, p.alertId, p, x.watch!)}`).join("")
      : "";
  const computedNote = x.watch?.events.some((e) => e.method === "computed")
    ? `<p class="note">The Dash0 lane is <b>computed</b>: Dash0 has no API for a rule's live state, so dd2dash0 runs the migrated rule's own query and compares it with the rule's own thresholds. The Datadog lane is the monitor's state from the Datadog API.</p>`
    : "";

  const corpusPanels = x.corpus?.pipeline?.panels;
  const corpusAlerts = x.corpus?.pipeline?.alerts;
  const corpus =
    corpusPanels || corpusAlerts
      ? `<section><h2>At scale</h2><p class="muted">The same pipeline over ${x.corpus?.dashboards ?? "?"} dashboards and ${x.corpus?.monitors ?? "?"} monitors from DataDog/integrations-core (no network, deterministic).</p>${corpusPanels ? coverageBar("Corpus panels", counts(corpusPanels.by)) : ""}${corpusAlerts ? coverageBar("Corpus monitors", counts(corpusAlerts.by)) : ""}${coverageTable([...(corpusPanels ? [{ label: "Corpus panels", parts: counts(corpusPanels.by) }] : []), ...(corpusAlerts ? [{ label: "Corpus monitors", parts: counts(corpusAlerts.by) }] : [])])}</section>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dd2dash0 proof card · ${esc(short(x.planHash))}</title>
<style>${CSS}</style>
</head>
<body>
<main class="viz-root">
<header>
<p class="kicker">dd2dash0 proof card</p>
<h1>Datadog → Dash0</h1>
<p class="lede">${esc(src)} → Dash0 dataset <b>${esc(ds)}</b>. ${r.summary.dashboards} dashboard${r.summary.dashboards === 1 ? "" : "s"}, ${r.summary.alerts} monitor${r.summary.alerts === 1 ? "" : "s"}. Translated by rules and mapping tables only: no model in the translation path.</p>
<dl class="meta">
<div><dt>plan</dt><dd title="${esc(x.planHash)}">${esc(short(x.planHash))} <span class="${x.planIntact ? "ok-ink" : "bad-ink"}">${x.planIntact ? "✓ intact" : "✕ changed since planning"}</span></dd></div>
<div><dt>output</dt><dd title="${esc(run.outputHash)}">${esc(short(run.outputHash))}</dd></div>
<div><dt>input</dt><dd title="${esc(run.inputHash)}">${esc(short(run.inputHash))}</dd></div>
<div><dt>rule catalog</dt><dd title="${esc(run.catalogHash)}">${esc(short(run.catalogHash))}</dd></div>
<div><dt>tool</dt><dd>dd2dash0 ${esc(run.version)}${run.toolCommit ? ` @ ${esc(run.toolCommit.slice(0, 7))}` : ""}</dd></div>
</dl>
</header>

<section><h2>Same incident, both alerts</h2>${verdicts}${timelines}${computedNote}</section>

<section><h2>What was translated</h2>
<p class="lede">Exact or exact under stated assumptions: <b>${pctFloor(r.summary.coverageExact)}</b> of panels with a query or text. Translated, including approximations with an error bound: <b>${pctFloor(r.summary.coverageTranslated)}</b>. Percentages are floored, never rounded up.</p>
${coverageBar("Panels", panels)}${coverageBar("Monitors", alerts)}${legend()}${coverageTable([{ label: "Panels", parts: panels }, { label: "Monitors", parts: alerts }])}
<p>${esc(importLine)}</p>
</section>

<section><h2>Chart parity</h2><p class="muted">Not measured in this run. When it is, each compared panel shows the measured difference next to its rule's stated error bound.</p></section>

<section><h2>Everything that needs a person</h2><p class="muted">Nothing is dropped silently: every item that was not translated is listed with its reason and what to do.</p>${manualRows(r.items, plain)}</section>
${corpus}
<footer><p>Generated by dd2dash0 ${esc(run.version)} from plan ${esc(x.planHash)}. The page is a function of the plan directory${x.watch ? ", its watch/ timeline" : ""}${x.corpus ? " and the corpus summary" : ""}: the same inputs give the same bytes. It loads nothing from the network.</p></footer>
</main>
</body>
</html>
`;
}

export function writeProof(planDir: string, opts: { corpus?: string; out?: string } = {}): { file: string; html: string; inputs: ProofInputs } {
  const inputs = readProofInputs(planDir, opts.corpus);
  const html = renderProof(inputs);
  const file = opts.out ?? join(planDir, "proof", "proof.html");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, html);
  return { file, html, inputs };
}

// Light and dark are both selected (dataviz palette.md). Coverage uses a validated one-hue ordinal ramp (exact = most
// saturated); alert states use the fixed status palette, always with an icon and a label.
const CSS = `
.viz-root{color-scheme:light;--surface:#fcfcfb;--page:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--base:#c3c2b7;--ring:rgba(11,11,11,.10);
--o1:#104281;--o2:#1c5cab;--o3:#2a78d6;--o4:#5598e7;--o5:#86b6ef;--oi1:#fff;--oi2:#fff;--oi3:#fff;--oi4:#0b0b0b;--oi5:#0b0b0b;
--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;--none:#898781;--goodtext:#006300}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface:#1a1a19;--page:#0d0d0d;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);
--o1:#b7d3f6;--o2:#86b6ef;--o3:#5598e7;--o4:#2a78d6;--o5:#1c5cab;--oi1:#0b0b0b;--oi2:#0b0b0b;--oi3:#0b0b0b;--oi4:#fff;--oi5:#fff;--goodtext:#0ca30c}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface:#1a1a19;--page:#0d0d0d;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);
--o1:#b7d3f6;--o2:#86b6ef;--o3:#5598e7;--o4:#2a78d6;--o5:#1c5cab;--oi1:#0b0b0b;--oi2:#0b0b0b;--oi3:#0b0b0b;--oi4:#fff;--oi5:#fff;--goodtext:#0ca30c}
*{box-sizing:border-box}
body{margin:0;background:var(--page,#f9f9f7)}
.viz-root{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--page);max-width:860px;margin:0 auto;padding:32px 24px 48px}
h1{font-size:30px;margin:0 0 6px;font-weight:650;letter-spacing:-.01em}
h2{font-size:18px;margin:0 0 12px;font-weight:650}
h3{font-size:15px;margin:20px 0 6px;font-weight:600}
section{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:20px 22px;margin:16px 0}
.kicker{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.lede{color:var(--ink2);margin:0 0 12px}
.muted{color:var(--muted)}
.code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.meta{display:flex;flex-wrap:wrap;gap:8px 24px;margin:12px 0 0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.meta div{display:flex;gap:6px}.meta dt{color:var(--muted)}.meta dd{margin:0}
.ok-ink{color:var(--goodtext)}.bad-ink{color:var(--crit)}
.bar-row{display:grid;grid-template-columns:160px 1fr;align-items:center;gap:12px;margin:8px 0}
.bar-label{font-weight:600}.bar{width:100%;height:28px;display:block}
.bar text,.timeline text{font:600 12px system-ui,-apple-system,"Segoe UI",sans-serif}
.fill-exact{fill:var(--o1);background:var(--o1)}.fill-exact-under{fill:var(--o2);background:var(--o2)}.fill-bounded{fill:var(--o3);background:var(--o3)}.fill-manual{fill:var(--o4);background:var(--o4)}.fill-unsupported{fill:var(--o5);background:var(--o5)}
.in-exact{fill:var(--oi1)}.in-exact-under{fill:var(--oi2)}.in-bounded{fill:var(--oi3)}.in-manual{fill:var(--oi4)}.in-unsupported{fill:var(--oi5)}
.legend{list-style:none;padding:0;margin:10px 0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px}
.legend li{display:flex;align-items:center;gap:6px}.sw{display:inline-block;width:12px;height:12px;border-radius:3px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.tile{border:1px solid var(--ring);border-radius:10px;padding:14px 16px}
.tile-title{font-weight:600;margin-bottom:6px}
.verdict{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:14px;padding:2px 10px;border-radius:999px;margin-bottom:8px}
.verdict.st-ok{background:var(--good);color:#fff}.verdict.st-crit{background:var(--crit);color:#fff}.verdict.st-none{background:var(--grid);color:var(--ink)}
.hero{font-size:40px;font-weight:650;line-height:1.1}
.reasons{margin:8px 0 0;padding-left:18px;color:var(--ink2);font-size:13px}
.timeline{width:100%;height:auto;display:block;margin:4px 0}
.lane-label{fill:var(--ink)}.lane-sub{fill:var(--muted);font-weight:400!important;font-size:11px!important}
.st-ok{fill:var(--good)}.st-warn{fill:var(--warn)}.st-crit{fill:var(--crit)}.st-none{fill:var(--none)}
.in-st-ok,.in-st-crit,.in-st-none{fill:#fff}.in-st-warn{fill:#0b0b0b}
.mark{stroke:var(--ink);stroke-width:2}
.bracket{fill:none;stroke:var(--ink2);stroke-width:1.5}
.gap-label{fill:var(--ink)}.tick{fill:var(--muted);font-weight:400!important}
.note{background:var(--page);border-radius:8px;padding:10px 12px;color:var(--ink2);font-size:13px;margin:12px 0 0}
details{margin:8px 0}summary{cursor:pointer;color:var(--ink2);font-size:13px}
table.data{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
table.data th,table.data td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--grid)}
table.data th{color:var(--ink2);font-weight:600}
.num{text-align:right!important;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:12px;margin-top:20px}
@media (forced-colors:active){.bar rect,.timeline rect{stroke:CanvasText;stroke-width:1}}
`;
