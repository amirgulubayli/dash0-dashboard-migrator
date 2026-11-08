// The step timeline of the browser page (web-term.ts): keys -> translate -> review -> import -> verify -> report.
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

export interface TimelineSnapshot {
  steps: StepState[];
  /** The step that is running now, or null. */
  current: StepKey | null;
  /** true once the flow has exited. */
  ended: boolean;
  code: number | null;
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
  /** The run's report.html, from the Result card's link (only a file that exists). */
  reportFile: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed bytes as written to the terminal. Returns true when the timeline changed. */
  feed(chunk: string): boolean {
    const before = JSON.stringify(this.steps) + this.reportFile;
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
    return JSON.stringify(this.steps) + this.reportFile !== before;
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
    return { steps: this.steps.map((s) => ({ ...s, details: [...s.details] })), current: cur ? cur.key : null, ended: this.ended, code: this.code };
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
      return;
    }
    const det = /^\s+⎿ (.*)$/.exec(text);
    if (det && this.last) {
      const d = det[1]!.trim();
      this.last.details.push(d);
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
  const sum = noPercent(s.summary.replace(/→/g, "to").replace(/·/g, ",").replace(/\s+/g, " ").trim());
  const what = s.state === "failed" ? "failed" : s.state === "skipped" ? "skipped" : "done";
  return `${s.label} ${what}${sum && s.state !== "skipped" ? `: ${sum}` : ""}.`.replace(/\.\.$/, ".");
}

/** Removes percentages ("82%", "82 %") so spoken and silent updates stay counts only. */
export const noPercent = (s: string) => s.replace(/\s*\d+(?:\.\d+)?\s*%/g, "").replace(/%/g, "").replace(/\s{2,}/g, " ").trim();

// ------------------------------------------------------------------------------------------------ page pieces
// Same palette and glyphs as web-term.ts's page (its CSS variables), so the timeline reads as part of the terminal.

export const TIMELINE_HTML = `<ol id="tl" class="tl" aria-label="Steps">${STEPS.map((s) => `<li class="st pending" data-k="${s.key}"><span class="sd" aria-hidden="true">○</span><span class="sl">${s.label}</span><span class="sm"></span><span class="tm"></span></li>`).join("")}</ol>`;

export const TIMELINE_CSS = `
.tl{list-style:none;margin:0;padding:12px 20px 10px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0 14px;border-bottom:1px solid var(--line);flex:none;font-size:12.5px}
.st{position:relative;min-width:0;padding-top:16px}
.st::before{content:"";position:absolute;top:6px;left:14px;right:-14px;height:1px;background:var(--line)}
.st:last-child::before{display:none}
.st.done::before,.st.skipped::before{background:color-mix(in srgb,var(--accent) 55%,var(--line))}
.sd{position:absolute;top:-2px;left:0;width:12px;text-align:center;line-height:16px;color:var(--dim);background:var(--bg)}
.sl{font-weight:600;color:var(--dim)}
.sm{display:block;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.55em}
.tm{display:block;color:var(--dim);font-size:11.5px;min-height:1.4em}
.st.running .sd,.st.running .sl{color:var(--accent)}
.st.running .sd{animation:pulse 1.6s ease-in-out infinite}
.st.done .sd{color:var(--ok)}.st.done .sl{color:var(--fg)}
.st.skipped .sd{color:var(--dim)}.st.skipped .sl{color:var(--dim)}
.st.failed .sd,.st.failed .sl{color:var(--bad)}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.st.running .sd{animation:none}}
@media (max-width:760px){.tl{grid-template-columns:1fr;gap:2px}.st{padding:0 0 0 20px}.st::before{display:none}.sd{top:0}.sm{display:inline;margin-left:1ch}.tm{display:inline;margin-left:1ch}}
#report{display:none;max-width:1480px;margin:0 auto;padding:0 20px 48px}
#report.on{display:block}
#report .rh{display:flex;justify-content:space-between;gap:12px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding:14px 0 10px}
#report .rh b{color:var(--fg);font-weight:600}
#report iframe{width:100%;height:80vh;border:1px solid var(--line);border-radius:8px;background:#fff;display:block}
.tbtn{font:inherit;font-size:12px;color:var(--dim);background:none;border:1px solid var(--line);border-radius:999px;padding:1px 10px;cursor:pointer}
.tbtn:hover{color:var(--fg);border-color:var(--accent)}
#term.short{padding-bottom:32px}
`;

/** Browser side: draws {t:"steps"} and {t:"report"} events. Plain ES2017, no imports; inlined into the page's one script. */
export const TIMELINE_JS = String.raw`
const tlEl = document.getElementById("tl"), reportEl = document.getElementById("report");
const GLYPH = { pending: "○", running: "●", done: "✓", skipped: "–", failed: "✗" };
function drawSteps(snap) {
  for (const s of snap.steps) {
    const li = tlEl.querySelector('[data-k="' + s.key + '"]');
    if (!li) continue;
    li.className = "st " + s.state;
    li.querySelector(".sd").textContent = GLYPH[s.state] || "○";
    const sm = li.querySelector(".sm");
    const line = s.state === "running" ? (s.running || s.summary) : s.summary;
    sm.textContent = line ? "⎿ " + line : "";
    sm.title = [s.summary].concat(s.details).filter(Boolean).join("\n");
    li.querySelector(".tm").textContent = s.state === "running" ? "running" : s.state === "pending" ? "" : s.time;
    li.setAttribute("aria-label", s.label + ": " + s.state + (line ? ", " + line : ""));
  }
  if (window.ddVoice) window.ddVoice.steps(snap);
}
function showReport(ev) {
  reportEl.textContent = "";
  const head = document.createElement("div"); head.className = "rh";
  const t = document.createElement("span"); t.append(Object.assign(document.createElement("b"), { textContent: "● Report" }), " · " + ev.label);
  const a = document.createElement("a"); a.href = ev.url; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = "open in a new tab ↗";
  head.append(t, a);
  const f = document.createElement("iframe");
  f.title = "Run report"; f.src = ev.inline; f.setAttribute("sandbox", "allow-same-origin");
  f.addEventListener("load", () => { try { const h = f.contentDocument.documentElement.scrollHeight; if (h > 200) f.style.height = h + 24 + "px"; } catch (e) {} });
  reportEl.append(head, f); reportEl.classList.add("on"); term.classList.add("short");
  if (window.ddVoice) window.ddVoice.report();
}
`;
