// dd2dash0 watch (wow-factor spec W1 + W2): watch a Datadog monitor and the Dash0 check rule we migrated from it,
// record every state change of both in one timeline, and give a parity verdict: did both reach the same severity,
// and how far apart in time? Deterministic: it only polls, records and compares. It never changes an alert.
//
// Datadog side: GET /api/v1/monitor/{id} -> overall_state (method "api").
// Dash0 side: no endpoint for a rule's live state is known yet (open probe for Ali), so the state is COMPUTED from
// the rule itself: its expression is run as an instant query with $__threshold set to the failed, then the degraded
// threshold; any series returned means that level is crossed (method "computed"). The timeline labels which method
// produced each event, so a computed crossing is never presented as "Dash0 fired".
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dash0Config } from "../targets/dash0/client.js";

export type AlertState = "ok" | "degraded" | "failed" | "nodata" | "unknown";
export type Side = "datadog" | "dash0";

export interface WatchEvent {
  side: Side;
  /** Report item id of the alert (dd-monitor-…). */
  alertId: string;
  from: AlertState | null;
  to: AlertState;
  /** ISO time the poll saw the new state. */
  at: string;
  method: "api" | "computed";
  /** The value behind the state when known (computed side: the expression's highest value). */
  value?: number;
}

export interface WatchedAlert {
  alertId: string;
  title: string;
  /** Datadog monitor id (numeric, as the Datadog API knows it). */
  ddMonitorId: string;
  rule: { id: string; expression: string; interval: string; thresholds: { degraded?: number; failed?: number } };
}

const RANK: Record<AlertState, number> = { unknown: -1, nodata: 0, ok: 0, degraded: 1, failed: 2 };
export const isFiring = (s: AlertState) => s === "degraded" || s === "failed";

/** Datadog overall_state -> our states: Alert = critical = failed, Warn = degraded. */
export function fromDatadog(overall: unknown): AlertState {
  switch (overall) {
    case "OK":
      return "ok";
    case "Warn":
      return "degraded";
    case "Alert":
      return "failed";
    case "No Data":
      return "nodata";
    default:
      return "unknown";
  }
}

/** "1m", "30s", "2h" -> ms. */
export function durationMs(d: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(d.trim());
  if (!m) throw new Error(`not a duration: '${d}' (use e.g. 5s, 1m, 30m)`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

/** Records only state changes, per side and alert. */
export class Timeline {
  readonly events: WatchEvent[] = [];
  private last = new Map<string, AlertState>();
  record(side: Side, alertId: string, to: AlertState, at: Date, method: WatchEvent["method"], value?: number): WatchEvent | null {
    const key = `${side}\u0000${alertId}`;
    const from = this.last.get(key) ?? null;
    if (from === to) return null;
    this.last.set(key, to);
    const ev: WatchEvent = { side, alertId, from, to, at: at.toISOString(), method, ...(value !== undefined && Number.isFinite(value) ? { value } : {}) };
    this.events.push(ev);
    return ev;
  }
  state(side: Side, alertId: string): AlertState | null {
    return this.last.get(`${side}\u0000${alertId}`) ?? null;
  }
}

export interface SideSummary {
  /** Highest severity seen. */
  peak: AlertState | null;
  /** First time the side reached its peak (only when firing). */
  firedAt: string | null;
  /** First return to ok after firing. */
  recoveredAt: string | null;
  method: WatchEvent["method"] | null;
}

export interface ParityResult {
  alertId: string;
  verdict: "pass" | "fail" | "no-incident";
  datadog: SideSummary;
  dash0: SideSummary;
  /** |Datadog fire - Dash0 fire| in ms; null when one side never fired. */
  fireGapMs: number | null;
  recoverGapMs: number | null;
  boundMs: number;
  reasons: string[];
}

function summarize(evs: WatchEvent[]): SideSummary {
  let peak: AlertState | null = null;
  let firedAt: string | null = null;
  let recoveredAt: string | null = null;
  let method: WatchEvent["method"] | null = null;
  for (const e of evs) {
    method = e.method;
    if (peak === null || RANK[e.to] > RANK[peak]) {
      peak = e.to;
      if (isFiring(e.to)) {
        firedAt = e.at;
        recoveredAt = null;
      }
    }
    if (firedAt && e.to === "ok" && !recoveredAt) recoveredAt = e.at;
  }
  return { peak, firedAt: peak && isFiring(peak) ? firedAt : null, recoveredAt, method };
}

const gap = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) : null);
const fmt = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 600_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/**
 * Pass when both sides fired, reached the same peak severity, and fired within the bound. The bound is
 * 2 x the rule's evaluation interval + the poll interval (+ Datadog's evaluation delay), from the rule, not a hand-set
 * number. Recovery is reported, and fails the verdict only when both recovered and the gap is over the bound.
 */
export function parity(events: WatchEvent[], alertId: string, boundMs: number): ParityResult {
  const mine = events.filter((e) => e.alertId === alertId);
  const datadog = summarize(mine.filter((e) => e.side === "datadog"));
  const dash0 = summarize(mine.filter((e) => e.side === "dash0"));
  const fireGapMs = gap(datadog.firedAt, dash0.firedAt);
  const recoverGapMs = gap(datadog.recoveredAt, dash0.recoveredAt);
  const reasons: string[] = [];
  if (!datadog.firedAt && !dash0.firedAt) {
    return { alertId, verdict: "no-incident", datadog, dash0, fireGapMs, recoverGapMs, boundMs, reasons: ["neither side fired while watching"] };
  }
  if (!datadog.firedAt) reasons.push("Dash0 fired, Datadog never did");
  if (!dash0.firedAt) reasons.push("Datadog fired, Dash0 never did");
  if (datadog.firedAt && dash0.firedAt && datadog.peak !== dash0.peak) reasons.push(`severity differs: Datadog ${datadog.peak}, Dash0 ${dash0.peak}`);
  if (fireGapMs !== null && fireGapMs > boundMs) reasons.push(`fired ${fmt(fireGapMs)} apart, over the ${fmt(boundMs)} bound`);
  if (recoverGapMs !== null && recoverGapMs > boundMs) reasons.push(`recovered ${fmt(recoverGapMs)} apart, over the ${fmt(boundMs)} bound`);
  return { alertId, verdict: reasons.length ? "fail" : "pass", datadog, dash0, fireGapMs, recoverGapMs, boundMs, reasons };
}

/** One line for the terminal and the voice agent: what happened, with the measured gap, never more than that. */
export function verdictLine(p: ParityResult, title: string): string {
  const t = (iso: string | null) => (iso ? iso.slice(11, 19) : "-");
  if (p.verdict === "no-incident") return `${title}: no incident seen on either side yet.`;
  const head = `${title}: Datadog ${p.datadog.peak ?? "-"} at ${t(p.datadog.firedAt)}, Dash0 ${p.dash0.peak ?? "-"}${p.dash0.method === "computed" ? " (computed)" : ""} at ${t(p.dash0.firedAt)}`;
  const g = p.fireGapMs !== null ? `, ${fmt(p.fireGapMs)} apart (bound ${fmt(p.boundMs)})` : "";
  return `${head}${g}: ${p.verdict.toUpperCase()}${p.reasons.length ? ` (${p.reasons.join("; ")})` : ""}.`;
}

// ---------------------------------------------------------------- plan -> alerts

interface RuleFile {
  id: string;
  name: string;
  expression: string;
  interval?: string;
  thresholds?: { degraded?: number; failed?: number };
  labels?: Record<string, string>;
}

/**
 * The alerts a plan can watch: every check-rule payload, joined to its report item. `ddIds` maps a report item id
 * (or a substring of it) to the numeric Datadog monitor id; without it the rule's dd_monitor_id label is used when
 * it is numeric (API ingest), and otherwise the Datadog monitor is looked up by name at watch time.
 */
export function plannedAlerts(planDir: string, select: string[] = []): (Omit<WatchedAlert, "ddMonitorId"> & { ddMonitorId: string | null })[] {
  const dir = join(planDir, "dash0", "check-rules");
  if (!existsSync(dir)) throw new Error(`${dir} not found: run 'dd2dash0 plan' first (check-rule payloads are written there)`);
  const report = JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as { items: { id: string; kind: string; title?: string; target?: { dash0Id?: string } }[] };
  const byRule = new Map(report.items.filter((i) => i.kind === "alert" && i.target?.dash0Id).map((i) => [i.target!.dash0Id!, i]));
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as RuleFile;
    const item = byRule.get(r.id);
    const alertId = item?.id ?? `dd-monitor-${r.labels?.dd_monitor_id ?? r.id}`;
    if (select.length && !select.some((s) => alertId.includes(s) || r.name.includes(s))) continue;
    const label = r.labels?.dd_monitor_id ?? "";
    out.push({
      alertId,
      title: r.name,
      ddMonitorId: /^\d+$/.test(label) ? label : null,
      rule: { id: r.id, expression: r.expression, interval: r.interval ?? "1m", thresholds: r.thresholds ?? {} },
    });
  }
  return out;
}

// ---------------------------------------------------------------- pollers

export interface DatadogEnv {
  site: string;
  apiKey: string;
  appKey: string;
}

export function datadogEnv(env: NodeJS.ProcessEnv = process.env): DatadogEnv {
  const site = env.DD_SITE ?? "datadoghq.eu";
  if (!env.DD_API_KEY || !env.DD_APP_KEY) throw new Error("DD_API_KEY and DD_APP_KEY are required to watch Datadog monitors");
  if (!/^[a-z0-9.-]+$/.test(site)) throw new Error(`invalid DD_SITE '${site}'`);
  return { site, apiKey: env.DD_API_KEY, appKey: env.DD_APP_KEY };
}

async function ddGet<T>(dd: DatadogEnv, path: string, f: typeof fetch): Promise<T> {
  const res = await f(new URL(path, `https://api.${dd.site}`), { headers: { "DD-API-KEY": dd.apiKey, "DD-APPLICATION-KEY": dd.appKey, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Datadog GET ${path.split("?")[0]} -> ${res.status}`); // keys are headers only, never in messages
  return (await res.json()) as T;
}

/** Find a monitor by exact name (the plan from fixtures has no numeric ids). */
export async function findDatadogMonitor(dd: DatadogEnv, name: string, f: typeof fetch = fetch): Promise<string | null> {
  const list = await ddGet<{ id: number; name: string }[]>(dd, `/api/v1/monitor?name=${encodeURIComponent(name)}`, f);
  const hit = list.filter((m) => m.name === name);
  return hit.length === 1 ? String(hit[0]!.id) : null;
}

export async function datadogState(dd: DatadogEnv, monitorId: string, f: typeof fetch = fetch): Promise<{ state: AlertState; evaluationDelayS: number }> {
  const m = await ddGet<{ overall_state?: string; options?: { evaluation_delay?: number } }>(dd, `/api/v1/monitor/${encodeURIComponent(monitorId)}`, f);
  return { state: fromDatadog(m.overall_state), evaluationDelayS: Number(m.options?.evaluation_delay ?? 0) || 0 };
}

/** Instant query; returns the highest sample value, or null when the expression returns no series. */
async function instant(cfg: Dash0Config, query: string, at: Date, f: typeof fetch): Promise<number | null> {
  const ds = cfg.dataset ?? "default";
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/api/prometheus/api/v1/query?dataset=${encodeURIComponent(ds)}&query=${encodeURIComponent(query)}&time=${at.getTime() / 1000}`;
  const res = await f(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`Dash0 query -> ${res.status}`);
  const j = (await res.json()) as { data?: { result?: { value?: [number, string] }[] } };
  const vals = (j.data?.result ?? []).map((r) => Number(r.value?.[1])).filter((v) => Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

/** The rule's expression with its comparison removed: "<lhs> > $__threshold" -> "<lhs>". */
export function ruleValueExpr(expression: string): string | null {
  const m = /^(.*\S)\s*(>=|<=|>|<|==|!=)\s*\$__threshold\s*$/s.exec(expression);
  return m ? m[1]! : null;
}

export function stateFromValue(value: number | null, op: string, th: { degraded?: number; failed?: number }): AlertState {
  if (value === null) return "nodata";
  const cross = (t: number | undefined) =>
    t !== undefined && ({ ">": value > t, ">=": value >= t, "<": value < t, "<=": value <= t, "==": value === t, "!=": value !== t } as Record<string, boolean>)[op];
  if (cross(th.failed)) return "failed";
  if (cross(th.degraded)) return "degraded";
  return "ok";
}

/** Computed Dash0 state: the rule's left-hand side as an instant query, compared with its own thresholds. */
export async function dash0ComputedState(cfg: Dash0Config, rule: WatchedAlert["rule"], at: Date, f: typeof fetch = fetch): Promise<{ state: AlertState; value: number | null }> {
  const lhs = ruleValueExpr(rule.expression);
  if (!lhs) return { state: "unknown", value: null };
  const op = /(>=|<=|>|<|==|!=)\s*\$__threshold\s*$/.exec(rule.expression)![1]!;
  const value = await instant(cfg, lhs, at, f);
  return { state: stateFromValue(value, op, rule.thresholds), value };
}

// ---------------------------------------------------------------- the loop

export interface WatchOptions {
  planDir: string;
  alerts: WatchedAlert[];
  dd: DatadogEnv;
  dash0: Dash0Config;
  everyMs: number;
  /** Stop after this long (default 30 min). */
  maxMs: number;
  /** Stop once every watched alert has fired and recovered on both sides. */
  untilRecovered: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  /** Set to stop the loop (Ctrl-C). */
  signal?: { stopped: boolean };
}

export interface WatchResult {
  timeline: WatchEvent[];
  parity: ParityResult[];
  ok: boolean;
  /** A side whose API never answered during the whole watch (the verdict means nothing then): exit 3. */
  apiError: string | null;
  files: { timeline: string; parity: string };
}

export async function runWatch(o: WatchOptions): Promise<WatchResult> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const print = o.print ?? (() => {});
  const tl = new Timeline();
  const evalDelayMs = new Map<string, number>();
  const answered = { datadog: false, dash0: false };
  const lastError: Record<Side, string> = { datadog: "", dash0: "" };
  const start = now().getTime();
  const outDir = join(o.planDir, "watch");
  mkdirSync(outDir, { recursive: true });
  const files = { timeline: join(outDir, "timeline.json"), parity: join(outDir, "parity.json") };
  const bound = (a: WatchedAlert) => 2 * durationMs(a.rule.interval) + o.everyMs + (evalDelayMs.get(a.alertId) ?? 0);
  const results = () => o.alerts.map((a) => parity(tl.events, a.alertId, bound(a)));
  const save = () => {
    writeFileSync(files.timeline, JSON.stringify({ schema: "dd2dash0.watch/v1", events: tl.events }, null, 2) + "\n");
    writeFileSync(files.parity, JSON.stringify({ schema: "dd2dash0.parity/v1", results: results() }, null, 2) + "\n");
  };
  const lane = (e: WatchEvent, title: string) =>
    `${e.at.slice(11, 19)}  ${e.side === "datadog" ? `${(e.from ?? "·").padEnd(8)}-> ${e.to.padEnd(8)}` + " ".repeat(6) + "|" : " ".repeat(25) + `| ${(e.from ?? "·").padEnd(8)}-> ${e.to}${e.method === "computed" ? " (computed)" : ""}`}  ${title}${e.value !== undefined ? `  value ${+e.value.toFixed(2)}` : ""}`;
  print(`time      Datadog                   | Dash0 (${o.alerts.map((a) => a.title).join(", ")})`);

  for (;;) {
    const at = now();
    for (const a of o.alerts) {
      try {
        const d = await datadogState(o.dd, a.ddMonitorId, f);
        answered.datadog = true;
        evalDelayMs.set(a.alertId, d.evaluationDelayS * 1000);
        const e = tl.record("datadog", a.alertId, d.state, at, "api");
        if (e) print(lane(e, a.title));
      } catch (err) {
        lastError.datadog = (err as Error).message;
        print(`${at.toISOString().slice(11, 19)}  Datadog poll failed for ${a.title}: ${(err as Error).message}`);
      }
      try {
        const c = await dash0ComputedState(o.dash0, a.rule, at, f);
        answered.dash0 = true;
        const e = tl.record("dash0", a.alertId, c.state, at, "computed", c.value ?? undefined);
        if (e) print(lane(e, a.title));
      } catch (err) {
        lastError.dash0 = (err as Error).message;
        print(`${at.toISOString().slice(11, 19)}  Dash0 poll failed for ${a.title}: ${(err as Error).message}`);
      }
    }
    save();
    const done = o.untilRecovered && results().every((p) => p.datadog.recoveredAt && p.dash0.recoveredAt);
    if (done || o.signal?.stopped || now().getTime() - start >= o.maxMs) break;
    await sleep(o.everyMs);
  }
  const final = results();
  for (const p of final) print(verdictLine(p, o.alerts.find((a) => a.alertId === p.alertId)!.title));
  save();
  const silent = (["datadog", "dash0"] as const).filter((s) => !answered[s]);
  const apiError = silent.length ? silent.map((s) => `${s} never answered (${lastError[s] || "no response"})`).join("; ") : null;
  if (apiError) print(`API error: ${apiError}. The verdict above is not meaningful.`);
  return { timeline: tl.events, parity: final, ok: !apiError && final.every((p) => p.verdict === "pass"), apiError, files };
}
