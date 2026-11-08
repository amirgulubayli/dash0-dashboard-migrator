// JARVIS narration: turns the UI's event stream into short spoken updates and silent context for the voice agent.
//
// Pure and clock-injected so it is unit-testable. It is ALSO shipped to the browser verbatim: src/web/voice-client.ts
// serialises `createNarrator` with Function.prototype.toString, so the function body must stay self-contained
// (no imports, no references to anything outside it). Types are erased, so they are fine.
//
// Honesty rules (team-wide): no percentages, accuracy or confidence figures are ever spoken. Any sentence carrying a
// "%" or the word "percent" is dropped, never rewritten into a number we did not read.

export interface NarratorEvent {
  type: string;
  at?: string;
  step?: string;
  state?: string;
  exitCode?: number;
  stream?: string;
  text?: string;
  id?: string;
  decision?: string;
  by?: string;
  [k: string]: unknown;
}

export interface NarratorOptions {
  /** Minimum gap between two spoken updates (ms). Default 6000. */
  minGapMs?: number;
  /** A burst is spoken only after this much quiet (ms), so near-simultaneous events coalesce. Default 1200. */
  settleMs?: number;
  /** Minimum gap between two silent terminal summaries (ms). Default 5000. */
  contextGapMs?: number;
  /** At most this many sentences per spoken update. Default 2. */
  maxSentences?: number;
}

export interface NarratorTick {
  /** Text for sendUserMessage (starts with "[EVENT] "), or undefined. */
  speak?: string;
  /** Text for sendContextualUpdate (never spoken), or undefined. */
  context?: string;
}

export interface Narrator {
  push(e: NarratorEvent, now: number): void;
  tick(now: number, speaking: boolean): NarratorTick;
  /** Queued sentences not yet spoken (for tests / debugging). */
  pending(): string[];
}

export function createNarrator(opts: NarratorOptions = {}): Narrator {
  const minGap = opts.minGapMs ?? 6000;
  const settle = opts.settleMs ?? 1200;
  const contextGap = opts.contextGapMs ?? 5000;
  const maxSentences = opts.maxSentences ?? 2;
  const LABEL: Record<string, string> = { plan: "Plan", review: "Review", apply: "Apply", watch: "Watch" };

  let queue: string[] = [];
  let lastSpoken = -Infinity;
  let lastQueued = -Infinity;
  let lastContext = -Infinity;
  let lineCount = 0;
  let lineSteps: Record<string, number> = {};
  let lastStderr = "";
  let lastLine = "";
  let otherContext: string[] = [];

  // Drop every sentence that mentions a percentage: we never say percentages (honesty rule 1).
  const clean = (s: string): string => {
    const text = String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
    const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
    return sentences
      .map((x) => x.trim())
      .filter((x) => x && !/%|\bper ?cent\b/i.test(x))
      .join(" ")
      .trim();
  };
  const enqueue = (s: string, now: number) => {
    const c = clean(s);
    if (!c) return;
    queue = queue.filter((q) => q !== c);
    queue.push(c);
    lastQueued = now;
  };

  return {
    push(e, now) {
      if (!e || typeof e.type !== "string") return;
      switch (e.type) {
        case "milestone":
          if (e.text) enqueue(String(e.text), now);
          break;
        case "step": {
          const label = LABEL[String(e.step)] ?? String(e.step ?? "A step");
          if (e.state === "running") enqueue(`${label} started.`, now);
          else if (e.state === "done") {
            // A milestone usually follows with the counts; the step line is the fallback.
            enqueue(`${label} finished.`, now);
          } else if (e.state === "failed")
            enqueue(`${label} failed${typeof e.exitCode === "number" ? ` with exit code ${e.exitCode}` : ""}.`, now);
          else if (e.state === "blocked") enqueue(`${label} is blocked.`, now);
          break;
        }
        case "line": {
          lineCount++;
          const st = String(e.step ?? "?");
          lineSteps[st] = (lineSteps[st] ?? 0) + 1;
          const t = String(e.text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
          if (t) {
            lastLine = t.slice(0, 160);
            if (e.stream === "stderr") lastStderr = t.slice(0, 160);
          }
          break;
        }
        case "decision":
          otherContext.push(`Decision recorded: ${String(e.id)} is ${String(e.decision)} (by ${String(e.by ?? "ui")}).`);
          break;
        default:
          break;
      }
    },
    tick(now, speaking) {
      const out: NarratorTick = {};
      if (!speaking && queue.length && now - lastSpoken >= minGap && now - lastQueued >= settle) {
        // Coalesce: "X started." is stale once "X finished." or a milestone is queued; keep the newest sentences.
        let batch = queue.slice();
        queue = [];
        const later = batch.join(" ");
        batch = batch.filter((s) => {
          const m = /^(\w+) started\.$/.exec(s);
          return !(m && (later.includes(`${m[1]} finished.`) || later.includes(`${m[1]} failed`)));
        });
        // A milestone (anything that is not a bare step line) supersedes the bare "X finished." line.
        const hasMilestone = batch.some((s) => !/^\w+ (started|finished|is blocked)\.$|^\w+ failed/.test(s));
        if (hasMilestone) batch = batch.filter((s) => !/^\w+ finished\.$/.test(s));
        const sentences = batch.slice(-maxSentences);
        if (sentences.length) {
          out.speak = "[EVENT] " + sentences.join(" ");
          lastSpoken = now;
        }
      }
      if ((lineCount || otherContext.length) && now - lastContext >= contextGap) {
        const parts: string[] = [];
        if (lineCount) {
          const per = Object.entries(lineSteps)
            .map(([s, n]) => `${n} from ${s}`)
            .join(", ");
          parts.push(`Terminal: ${lineCount} new line${lineCount === 1 ? "" : "s"} (${per}). Last: ${lastLine || "(blank)"}`);
          if (lastStderr) parts.push(`Last stderr: ${lastStderr}`);
        }
        parts.push(...otherContext.slice(-5));
        out.context = parts.join(" ");
        lineCount = 0;
        lineSteps = {};
        lastStderr = "";
        otherContext = [];
        lastContext = now;
      }
      return out;
    },
    pending() {
      return queue.slice();
    },
  };
}
