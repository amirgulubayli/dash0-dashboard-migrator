// The live incident view (wow-factor spec W6): what `dd2dash0 watch` records. Pure: parsing and geometry helpers
// only. The fetch of `dd2dash0 review`'s GET /api/watch lives in cli-server.ts with the other same-origin calls.
// The Dash0 lane is COMPUTED (the migrated rule's own query against its own thresholds; Dash0 has no API for a
// rule's live state), and every label that shows it says so.

export type AlertState = "ok" | "degraded" | "failed" | "nodata" | "unknown";
export type Side = "datadog" | "dash0";

export interface WatchEvent {
  side: Side;
  alertId: string;
  from: AlertState | null;
  to: AlertState;
  at: string;
  method: "api" | "computed";
  value?: number;
}

export interface WatchSample {
  alertId: string;
  at: string;
  value: number | null;
}

export interface SideSummary {
  peak: AlertState | null;
  firedAt: string | null;
  recoveredAt: string | null;
  method: "api" | "computed" | null;
}

export interface ParityResult {
  alertId: string;
  verdict: "pass" | "fail" | "no-incident";
  datadog: SideSummary;
  dash0: SideSummary;
  fireGapMs: number | null;
  recoverGapMs: number | null;
  boundMs: number;
  reasons: string[];
}

export interface WatchData {
  startedAt: string | null;
  endedAt: string | null;
  events: WatchEvent[];
  samples: WatchSample[];
  parity: ParityResult[];
}

const isObj = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES = new Set<string>(["ok", "degraded", "failed", "nodata", "unknown"]);

interface LooseEvent {
  side?: unknown;
  alertId?: unknown;
  at?: unknown;
  to?: unknown;
}
interface LooseSample {
  alertId?: unknown;
  at?: unknown;
  value?: unknown;
}
interface LooseBody {
  timeline?: { startedAt?: unknown; endedAt?: unknown; events?: unknown; samples?: unknown };
  parity?: { results?: unknown } | null;
}

const isEvent = (e: unknown): e is WatchEvent => {
  if (!isObj(e)) return false;
  const x = e as LooseEvent;
  return (
    (x.side === "datadog" || x.side === "dash0") &&
    typeof x.alertId === "string" &&
    typeof x.at === "string" &&
    typeof x.to === "string" &&
    STATES.has(x.to)
  );
};
const isSample = (v: unknown): v is WatchSample => {
  if (!isObj(v)) return false;
  const x = v as LooseSample;
  return (
    typeof x.alertId === "string" &&
    typeof x.at === "string" &&
    (x.value === null || typeof x.value === "number")
  );
};

/** Parse GET /api/watch defensively: unknown fields are ignored, bad events and samples are dropped. */
export function parseWatch(body: unknown): WatchData | null {
  if (!isObj(body)) return null;
  const b = body as LooseBody;
  const t = b.timeline;
  if (!isObj(t)) return null;
  const events = Array.isArray(t.events) ? t.events.filter(isEvent) : [];
  const samples = Array.isArray(t.samples) ? t.samples.filter(isSample) : [];
  const results =
    isObj(b.parity) && Array.isArray(b.parity.results) ? (b.parity.results as ParityResult[]) : [];
  return {
    startedAt: typeof t.startedAt === "string" ? t.startedAt : null,
    endedAt: typeof t.endedAt === "string" ? t.endedAt : null,
    events,
    samples,
    parity: results,
  };
}

/** The time window the lanes and the chart share: the watch's own start and last poll. */
export function windowOf(d: WatchData, alertId: string): { t0: number; t1: number } {
  const times = [
    ...d.events.filter((e) => e.alertId === alertId).map((e) => Date.parse(e.at)),
    ...d.samples.filter((s) => s.alertId === alertId).map((s) => Date.parse(s.at)),
  ];
  const t0 = Math.min(d.startedAt ? Date.parse(d.startedAt) : Infinity, ...times);
  const t1 = Math.max(d.endedAt ? Date.parse(d.endedAt) : -Infinity, ...times);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return { t0: 0, t1: 1000 };
  return { t0, t1: Math.max(t1, t0 + 1000) };
}

export interface Segment {
  state: AlertState;
  from: number;
  to: number;
  value?: number;
}

/** One lane: each state lasts from its event until the next event on that side, the last one until t1. */
export function laneSegments(
  events: WatchEvent[],
  alertId: string,
  side: Side,
  t1: number,
): Segment[] {
  const evs = events
    .filter((e) => e.alertId === alertId && e.side === side)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return evs.map((e, i) => ({
    state: e.to,
    from: Date.parse(e.at),
    to: i + 1 < evs.length ? Date.parse(evs[i + 1]!.at) : t1,
    ...(e.value !== undefined ? { value: e.value } : {}),
  }));
}

export function currentState(events: WatchEvent[], alertId: string, side: Side): AlertState | null {
  const evs = events.filter((e) => e.alertId === alertId && e.side === side);
  return evs.length ? evs[evs.length - 1]!.to : null;
}

/** y range for the value chart: always shows both thresholds and every sample, with a little headroom. */
export function valueRange(
  values: number[],
  th: { degraded?: number; failed?: number } | undefined,
): { lo: number; hi: number } {
  const all = [
    ...values,
    ...(th?.degraded !== undefined ? [th.degraded] : []),
    ...(th?.failed !== undefined ? [th.failed] : []),
  ];
  if (!all.length) return { lo: 0, hi: 1 };
  const lo = Math.min(0, ...all);
  const max = Math.max(...all);
  const hi = max <= lo ? lo + 1 : max + (max - lo) * 0.08;
  return { lo, hi };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const hhmmss = (t: number | string) => new Date(t).toISOString().slice(11, 19);
