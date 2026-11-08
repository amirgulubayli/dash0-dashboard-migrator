// The step timeline and live counters of the browser page (web-term.ts): keys -> translate -> review -> import ->
// verify -> report. web-term's server feeds it the bytes it already sends and emits a small structured SSE event
// ({t:"live"}, see web-live.ts) alongside them; the terminal output itself is unchanged.
//
// It is read from the same bytes the terminal gets, so the page can't show a step the CLI didn't print: "● Title"
// headings and finished steps ("● Title  summary  1.2s"), spinner frames for the running step, "⎿" detail lines and
// the closing "Result" card. The run's report.html is found from the card's own OSC 8 link. Nothing here changes what
// the flow prints, and nothing here translates: it only reads the CLI's output.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STEPS = [
  { key: "keys", label: "Keys", title: "Keys" },
  { key: "translate", label: "Translate", title: "Translate" },
  { key: "review", label: "Review", title: "Review" },
  { key: "import", label: "Import", title: "Import" },
  { key: "verify", label: "Verify", title: "Verify" },
  { key: "report", label: "Report", title: "Result" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export type StepStateName = "pending" | "running" | "done" | "skipped" | "failed";

export interface StepState {
  key: StepKey;
  label: string;
  state: StepStateName;
  /** The CLI's one-line result for the step (the text after the title, or its first ⎿ line). */
  summary: string;
  /** The ⎿ lines under the step, colors removed. */
  details: string[];
  /** The duration the CLI printed ("1.2s"), else measured from the first line of the step to its end. */
  time: string;
  /** While running: the spinner text ("Translating fixtures/datadog…"). */
  running: string;
}

export type Label = "exact" | "exact-under" | "bounded" | "manual" | "unsupported";
export const LABELS: Label[] = ["exact", "exact-under", "bounded", "manual", "unsupported"];
/** A measured count, or null when the run did not measure it (dry run: "Not measured"). */
export type Measured = { count: number; total: number } | null;

/** Counts exactly as the flow printed them (or, after the run, as report.json records them). Nothing is computed here. */
export interface Counts {
  dashboards: number | null;
  monitors: number | null;
  items: number | null;
  /** Per label, from the Translate step's "40 exact-under · 38 bounded · …" line (labels it omits are 0). */
  byLabel: Record<Label, number> | null;
  translated: Measured;
  /** undefined: not printed yet; null: the run said "not measured". */
  landed?: Measured;
  live?: Measured;
  source: "printed" | "report.json";
}

export interface TimelineSnapshot {
  steps: StepState[];
  /** The step that is running now, or null. */
  current: StepKey | null;
  /** true once the flow has exited. */
  ended: boolean;
  code: number | null;
  counts: Counts;
}

/** The parts of the run's report.json (score.ts writeRunReport) this page reads. */
export interface RunReportJson {
  schema?: string;
  score?: { total: number; panels: number; monitors: number; translated: { count: number; total: number }; landed: { count: number; total: number } | null; live: { count: number; total: number } | null };
  items?: { id: string; kind: string; title: string; dashboard?: string | null; status: string; reasons?: string[]; reason_codes?: string[]; decision?: string; landed?: boolean | null; live?: string | null; sourceQueries?: string[]; promql?: string[]; manualActions?: string[] }[];
}

/** A change worth saying out loud: a step finished, failed or was skipped. Counts come from the CLI's own summary. */
export interface Milestone {
  key: StepKey;
  state: StepStateName;
  text: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (.*?)(?:\s{2}\d+(?:\.\d+)?s|\s{2}\d+m\d+s)?\s*$/;
const TIME = /\s{2}(\d+(?:\.\d+)?s|\d+m\d+s)$/;
const BAD_DOT = /\x1b\[38;5;203m●/;

const fmt = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

export class Timeline {
  readonly steps: StepState[] = STEPS.map((s) => ({ key: s.key, label: s.label, state: "pending", summary: "", details: [], time: "", running: "" }));
  private started = new Map<StepKey, number>();
  private buf = "";
  private last: StepState | null = null;
  private inCard = false;
  private milestones: Milestone[] = [];
  ended = false;
  code: number | null = null;
  counts: Counts = { dashboards: null, monitors: null, items: null, byLabel: null, translated: null, source: "printed" };
  /** The run's report.html, from the Result card's link (only a file that exists). */
  reportFile: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed bytes as written to the terminal. Returns true when the timeline changed. */
  feed(chunk: string): boolean {
    const before = JSON.stringify(this.steps) + this.reportFile + JSON.stringify(this.counts);
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    // A partial line: the spinner of the running step is redrawn in place (\r, \x1b[2K) and never ends with \n.
    const frame = stripAnsi(lastSegment(this.buf));
    const m = SPINNER.exec(frame);
    if (m) {
      // Only ui.step() draws a spinner, and its title is printed when it ends: the spinner belongs to the step after
      // the last one the CLI named (Keys and Review are headings and never spin).
      const named = this.last ? this.steps.indexOf(this.last) : -1;
      const s = this.steps.slice(named + 1).find((x) => x.state === "pending" || x.state === "running");
      if (s) {
        this.start(s);
        s.running = m[1]!.trim();
      }
    }
    if (this.buf.length > 8192) this.buf = lastSegment(this.buf).slice(-2048);
    return JSON.stringify(this.steps) + this.reportFile + JSON.stringify(this.counts) !== before;
  }

  /** The flow exited: a running step ends as done (exit 0) or failed. */
  finish(code: number): void {
    if (this.buf) this.line(this.buf), (this.buf = "");
    this.ended = true;
    this.code = code;
    for (const s of this.steps) if (s.state === "running") this.end(s, code === 0 ? "done" : "failed");
    // A failed run whose failure line never named a step: mark the step after the last one that ran.
    if (code !== 0 && !this.steps.some((s) => s.state === "failed")) {
      const s = this.nextPending();
      if (s) this.end(s, "failed");
    }
  }

  snapshot(): TimelineSnapshot {
    const cur = this.steps.find((s) => s.state === "running");
    return { steps: this.steps.map((s) => ({ ...s, details: [...s.details] })), current: cur ? cur.key : null, ended: this.ended, code: this.code, counts: { ...this.counts } };
  }

  /** Milestones since the last call (step done / skipped / failed), for the narrator. */
  takeMilestones(): Milestone[] {
    const m = this.milestones;
    this.milestones = [];
    return m;
  }

  private line(rawLine: string): void {
    const raw = lastSegment(rawLine);
    const text = stripAnsi(raw).replace(/\s+$/, "");
    if (!text.trim()) return;
    if (this.inCard) {
      const link = /\x1b\]8;;(file:[^\x07\x1b]*report\.html)(?:\x07|\x1b\\)/.exec(raw);
      if (link) {
        try {
          const f = fileURLToPath(link[1]!);
          if (existsSync(f)) this.reportFile = f;
        } catch {
          /* not a file URL we can read */
        }
      }
      this.cardCounts(text.replace(/^│\s*/, ""));
      const rep = this.byKey("report");
      if (/^report\s/.test(text.replace(/^│\s*/, ""))) rep.summary = "report.html · report.md";
      if (text.startsWith("╰")) {
        this.inCard = false;
        this.end(rep, "done");
      }
      return;
    }
    if (text.startsWith("╭─ Result")) {
      this.inCard = true;
      this.start(this.byKey("report"));
      return;
    }
    const head = /^● (\S+)(.*)$/.exec(text);
    if (head) {
      const def = STEPS.find((s) => s.title === head[1]);
      if (!def) {
        // "● dd2dash0: <error>" (a red dot without a known title): the running step failed.
        if (BAD_DOT.test(raw)) {
          const s = this.steps.find((x) => x.state === "running") ?? this.nextPending();
          if (s) {
            if (!s.summary) s.summary = text.slice(2).trim();
            this.end(s, "failed");
          }
        }
        return;
      }
      const s = this.byKey(def.key);
      let rest = head[2]!.trim();
      const t = TIME.exec(head[2]!);
      if (t) rest = head[2]!.slice(0, t.index).trim();
      this.start(s);
      if (rest) s.summary = rest;
      if (t) {
        s.time = t[1]!;
        this.end(s, BAD_DOT.test(raw) ? "failed" : "done");
      } else if (rest) this.end(s, /^skipped/.test(rest) ? "skipped" : "done");
      this.last = s;
      if (def.key === "translate") {
        const m = /(\d+) dashboards? · (\d+) monitors? → (\d+) items/.exec(rest);
        if (m) Object.assign(this.counts, { dashboards: +m[1]!, monitors: +m[2]!, items: +m[3]! });
      }
      if (def.key === "verify") {
        const m = /read back (\d+)\/(\d+) · (\d+)\/(\d+) queries return data/.exec(rest);
        if (m) Object.assign(this.counts, { landed: { count: +m[1]!, total: +m[2]! }, live: { count: +m[3]!, total: +m[4]! } });
      }
      return;
    }
    const det = /^\s+⎿ (.*)$/.exec(text);
    if (det && this.last) {
      const d = det[1]!.trim();
      this.last.details.push(d);
      if (this.last.key === "translate" && !this.counts.byLabel && /^\d+ (exact|exact-under|bounded|manual|unsupported)( · |$)/.test(d)) {
        const by = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
        for (const m of d.matchAll(/(\d+) (exact-under|exact|bounded|manual|unsupported)\b/g)) by[m[2] as Label] = +m[1]!;
        this.counts.byLabel = by;
      }
      if (!this.last.summary) this.last.summary = d;
      return;
    }
    const x = /^✗ (.*)$/.exec(text.trim());
    if (x) {
      const s = this.steps.find((y) => y.state === "running") ?? this.last;
      if (s) {
        s.details.push(x[1]!);
        if (!s.summary) s.summary = x[1]!;
        this.end(s, "failed");
      }
    }
  }

  /** The Result card's meters: "translated  ███  78/102  76%" (the share is ignored: counts only) or "not measured". */
  private cardCounts(t: string): void {
    const m = /^(translated|landed|live)\s+\S+\s+(?:(\d+)\/(\d+)|not measured)/.exec(t);
    if (!m) return;
    const v: Measured = m[2] ? { count: +m[2], total: +m[3]! } : null;
    if (m[1] === "translated") this.counts.translated = v;
    else this.counts[m[1] as "landed" | "live"] = v;
  }

  /** Once the run wrote report.json, its numbers replace the printed ones (same numbers, one source of truth). */
  useReport(r: RunReportJson): void {
    const s = r.score;
    const by = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
    for (const it of r.items ?? []) if (it.status in by) by[it.status as Label]++;
    const m = (n: { count: number; total: number } | null | undefined): Measured => (n ? { count: n.count, total: n.total } : null);
    this.counts = {
      dashboards: this.counts.dashboards,
      monitors: s?.monitors ?? this.counts.monitors,
      items: s?.total ?? (r.items ?? []).length,
      byLabel: by,
      translated: m(s?.translated),
      landed: m(s?.landed),
      live: m(s?.live),
      source: "report.json",
    };
  }

  private byKey(k: StepKey): StepState {
    return this.steps.find((s) => s.key === k)!;
  }

  private nextPending(): StepState | undefined {
    let lastTouched = -1;
    this.steps.forEach((s, i) => s.state !== "pending" && (lastTouched = i));
    const cur = this.steps[lastTouched];
    if (cur && cur.state === "running") return cur;
    return this.steps.slice(lastTouched + 1).find((s) => s.state === "pending");
  }

  /** A step starts: every earlier step that is still open is finished (the CLI moved on). */
  private start(s: StepState): void {
    const idx = this.steps.indexOf(s);
    for (const e of this.steps.slice(0, idx)) if (e.state === "running") this.end(e, "done");
    if (s.state === "pending") {
      s.state = "running";
      this.started.set(s.key, this.now());
    }
  }

  private end(s: StepState, state: StepStateName): void {
    if (s.state === state) return;
    if (!this.started.has(s.key)) this.started.set(s.key, this.now());
    s.state = state;
    s.running = "";
    if (!s.time) s.time = fmt(this.now() - this.started.get(s.key)!);
    this.milestones.push({ key: s.key, state, text: milestoneText(s) });
  }
}

/** The text after the last carriage return or erase-line: what a terminal actually shows on that line. */
function lastSegment(s: string): string {
  const r = s.lastIndexOf("\r");
  const k = s.lastIndexOf("\x1b[2K");
  const at = Math.max(r >= 0 ? r + 1 : 0, k >= 0 ? k + 4 : 0);
  return s.slice(at);
}

/** One short spoken sentence for a finished step, from the CLI's own summary. Counts only: any percentage is dropped. */
export function milestoneText(s: Pick<StepState, "label" | "state" | "summary">): string {
  const sum = noPercent(s.summary.replace(/→/g, "to").replace(/\s*·\s*/g, ", ").replace(/\s+/g, " ").trim());
  const what = s.state === "failed" ? "failed" : s.state === "skipped" ? "skipped" : "done";
  return `${s.label} ${what}${sum && s.state !== "skipped" ? `: ${sum}` : ""}.`.replace(/\.\.$/, ".");
}

/** Removes percentages ("82%", "82 %") so spoken and silent updates stay counts only. */
export const noPercent = (s: string) => s.replace(/\s*\d+(?:\.\d+)?\s*%/g, "").replace(/%/g, "").replace(/\s{2,}/g, " ").trim();

