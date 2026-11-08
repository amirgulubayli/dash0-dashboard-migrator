// One reducer for live and replay. It only records what the event log contains; it never invents a stage or an item.

export type RunEvent = { seq: number; type: string; [k: string]: unknown };

export interface EventState {
  events: RunEvent[]; // sorted by seq, duplicates (same seq) ignored
  itemsSeen: Map<string, RunEvent>; // item.done events by item id
  started: RunEvent | null;
  dashboardsStarted: RunEvent[];
  dashboardsDone: RunEvent[];
  importDone: RunEvent | null;
  runDone: RunEvent | null;
  duplicates: number;
  ignored: number; // events that did not look like events
}

export const emptyEventState = (): EventState => ({
  events: [], itemsSeen: new Map(), started: null, dashboardsStarted: [], dashboardsDone: [], importDone: null, runDone: null, duplicates: 0, ignored: 0,
});

export function isRunEvent(v: unknown): v is RunEvent {
  return typeof v === "object" && v !== null && typeof (v as RunEvent).seq === "number" && Number.isFinite((v as RunEvent).seq) && typeof (v as RunEvent).type === "string";
}

function derive(events: RunEvent[], duplicates: number, ignored: number): EventState {
  const s = emptyEventState();
  s.events = events;
  s.duplicates = duplicates;
  s.ignored = ignored;
  for (const e of events) {
    if (e.type === "run.start") s.started = e;
    else if (e.type === "dashboard.start") s.dashboardsStarted.push(e);
    else if (e.type === "dashboard.done") s.dashboardsDone.push(e);
    else if (e.type === "item.done" && typeof e.id === "string") s.itemsSeen.set(e.id, e);
    else if (e.type === "import.done") s.importDone = e;
    else if (e.type === "run.done") s.runDone = e;
  }
  return s;
}

/** Pure: returns a new state. Events may arrive out of order or twice; the result depends only on the set of distinct seq values. */
export function reduceEvent(state: EventState, raw: unknown): EventState {
  if (!isRunEvent(raw)) return { ...state, ignored: state.ignored + 1 };
  if (state.events.some((e) => e.seq === raw.seq)) return { ...state, duplicates: state.duplicates + 1 };
  const events = [...state.events, raw].sort((a, b) => a.seq - b.seq);
  return derive(events, state.duplicates, state.ignored);
}

export type StageStatus = "done" | "active" | "pending";
export interface Stage {
  key: string;
  label: string;
  status: StageStatus;
  detail: string | null;
}

/** Stages are driven only by events present in the log. With no events every stage is pending. */
export function stagesFrom(s: EventState): Stage[] {
  const panelsExpected = s.dashboardsStarted.reduce((n, e) => n + (typeof e.panels === "number" ? e.panels : 0), 0);
  const itemCount = s.itemsSeen.size;
  const started = s.started !== null;
  const stage = (done: boolean, active: boolean): StageStatus => (done ? "done" : active ? "active" : "pending");
  const reading = s.dashboardsStarted.length > 0;
  const assessedDone = s.dashboardsDone.length > 0 && s.dashboardsDone.length >= s.dashboardsStarted.length;
  const importMode = s.importDone && typeof s.importDone.mode === "string" ? s.importDone.mode : null;
  return [
    { key: "start", label: "Run started", status: stage(started, false), detail: started && typeof s.started?.mode === "string" ? `mode: ${s.started.mode}` : null },
    { key: "read", label: "Dashboards read", status: stage(reading, started && !reading), detail: reading ? `${s.dashboardsStarted.length} started` : null },
    {
      key: "assess", label: "Items assessed", status: stage(assessedDone, reading && !assessedDone),
      detail: itemCount > 0 ? (panelsExpected > 0 ? `${itemCount} items (${panelsExpected} widgets announced)` : `${itemCount} items`) : null,
    },
    { key: "import", label: "Import step", status: stage(s.importDone !== null, assessedDone && s.importDone === null), detail: importMode ? `mode: ${importMode}` : null },
    { key: "done", label: "Run finished", status: stage(s.runDone !== null, false), detail: null },
  ];
}

export function parseEventLines(text: string): { events: RunEvent[]; malformed: number } {
  const events: RunEvent[] = [];
  let malformed = 0;
  const lines = text.split("\n");
  // The last element is a partial line unless the text ended with a newline; only complete lines count.
  const complete = lines.slice(0, -1);
  for (const l of complete) {
    if (l.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(l);
      if (isRunEvent(v)) events.push(v);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

export interface ReplayPlan {
  delaysMs: number[]; // delay before each event
  hasRecordedTimestamps: boolean;
  slowed: boolean;
  note: string;
}

function tsOf(e: RunEvent): number | null {
  for (const k of ["ts", "timestamp", "time", "t"]) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const ms = Date.parse(v);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

/** speed 1 = recorded timing. Without recorded timestamps there is no "real" speed to compare against, so playback is paced and says so. */
export function planReplay(events: RunEvent[], speed: number, pacedMs = 120): ReplayPlan {
  const ts = events.map(tsOf);
  const has = events.length > 1 && ts.every((t) => t !== null);
  if (!has) return { delaysMs: events.map(() => pacedMs / (speed > 0 ? speed : 1)), hasRecordedTimestamps: false, slowed: false, note: "No timestamps recorded in this log: playback is paced for visibility" };
  const delays = ts.map((t, i) => (i === 0 ? 0 : Math.max(0, (t as number) - (ts[i - 1] as number)) / (speed > 0 ? speed : 1)));
  return { delaysMs: delays, hasRecordedTimestamps: true, slowed: speed < 1, note: speed < 1 ? "Playback slowed for visibility" : speed > 1 ? "Playback faster than the recorded timing" : "Playback at recorded timing" };
}
