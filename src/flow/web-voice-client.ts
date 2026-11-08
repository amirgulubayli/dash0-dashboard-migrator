// The voice dock of the browser page (bottom-right): an orb (idle / listening / speaking), one caption line, mute and
// end. Served as /<secret>/x/voice/dock.js after the locally served SDK, only when ELEVENLABS_API_KEY is set.
//
// No build step: createNarrator and voiceDock are TypeScript shipped with Function.prototype.toString, so each body
// must stay self-contained (no imports, no outer references).
//
// The narrator turns step changes and milestones into short spoken lines: counts only (a sentence with "%" or
// "percent" is dropped, never rewritten), at least minGapMs apart, never while the agent speaks, bursts coalesced.
// Client tools answer only from run state (the server's /x/tool/<name> routes, read from the flow and report.json).
// The one action (open the report) waits for a click in the page.

export interface NarratorOptions {
  /** Minimum gap between two spoken lines (ms). Default 6000. */
  minGapMs?: number;
  /** Wait this long after the last queued line so a burst is spoken once (ms). Default 1200. */
  settleMs?: number;
  /** At most this many sentences per spoken line. Default 2. */
  maxSentences?: number;
}

export interface Narrator {
  push(text: string, now: number): void;
  /** The line to speak now, if any ("[EVENT] ..."). */
  tick(now: number, speaking: boolean): string | undefined;
  pending(): string[];
}

export function createNarrator(opts: NarratorOptions = {}): Narrator {
  const minGap = opts.minGapMs ?? 6000;
  const settle = opts.settleMs ?? 1200;
  const max = opts.maxSentences ?? 2;
  let queue: string[] = [];
  let lastSpoken = -Infinity;
  let lastQueued = -Infinity;
  const clean = (s: string): string =>
    (String(s ?? "").replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*/g) ?? [])
      .map((x) => x.trim())
      .filter((x) => x && !/%|\bper ?cent\b/i.test(x))
      .join(" ");
  return {
    push(text, now) {
      const c = clean(text);
      if (!c) return;
      // A newer line about the same step replaces the older one ("Translate done: …" supersedes "Translate started.").
      const head = c.split(/[ :]/)[0];
      queue = queue.filter((q) => q !== c && q.split(/[ :]/)[0] !== head);
      queue.push(c);
      lastQueued = now;
    },
    tick(now, speaking) {
      if (speaking || !queue.length || now - lastSpoken < minGap || now - lastQueued < settle) return undefined;
      const batch = queue.slice(-max);
      queue = [];
      lastSpoken = now;
      return "[EVENT] " + batch.join(" ");
    },
    pending() {
      return queue.slice();
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function voiceDock(win: any, base: string, makeNarrator: typeof createNarrator): void {
  const doc = win.document;
  const dock = doc.getElementById("vdock");
  if (!dock || win.__ddVoice) return;
  const orb = dock.querySelector(".vorb"), cap = dock.querySelector(".vcap"), mute = dock.querySelector(".vmute"), end = dock.querySelector(".vend"), act = dock.querySelector(".vact");
  dock.hidden = false;
  let conv: any = null;
  let mode = "idle";
  let timer: any = null;
  const narrator = makeNarrator();
  const set = (m: string) => {
    mode = m;
    orb.dataset.s = m;
    dock.classList.toggle("on", m !== "idle");
    orb.setAttribute("aria-label", m === "idle" ? "Talk to the narrator" : "Narrator: " + m);
  };
  const say = (t: string) => (cap.textContent = String(t ?? "").replace(/\s+/g, " ").slice(0, 160));
  const tool = (name: string) => async (p: any) => {
    const q = p && p.query ? "?query=" + encodeURIComponent(String(p.query)) : "";
    const r = await win.fetch(base + "/x/tool/" + name + q);
    return r.ok ? await r.text() : JSON.stringify({ error: "not available" });
  };
  // The one action: the agent may ask to open the report; only a click in the page does it.
  const openReport = async () => {
    const a = doc.querySelector("#rframe-open");
    if (!a) return JSON.stringify({ ok: false, message: "The report is not written yet." });
    act.hidden = false;
    act.textContent = "Open the report ↗";
    act.onclick = () => { act.hidden = true; a.click(); };
    return JSON.stringify({ ok: false, message: "A button is shown in the page; the user has to click it. Nothing was opened by you." });
  };
  const tools: any = {
    get_status: tool("get_status"), get_counts: tool("get_counts"), get_item: tool("get_item"),
    list_attention: tool("list_attention"), list_gaps: tool("list_gaps"), open_report: openReport,
    // The live agent's older tool names (docs/VOICE.md), answered from the same state.
    get_summary: tool("get_counts"), get_item_details: tool("get_item"),
  };
  const stop = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    const c = conv;
    conv = null;
    if (c) { try { await c.endSession(); } catch (e) { /* already closed */ } }
    set("idle");
  };
  const start = async () => {
    if (conv || mode !== "idle") return;
    const C = win.ElevenLabsClient;
    if (!C || !C.Conversation) { say("Voice is not available in this build."); return; }
    set("connecting");
    say("Connecting…");
    try {
      const r = await win.fetch(base + "/x/voice/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token) throw new Error(j.error || "no conversation token");
      conv = await C.Conversation.startSession({
        conversationToken: j.token,
        connectionType: "webrtc",
        clientTools: tools,
        onModeChange: (m: any) => set(m && m.mode === "speaking" ? "speaking" : "listening"),
        onMessage: (m: any) => { if (m && m.message) say(((m.role || m.source) === "user" ? "You: " : "") + m.message); },
        onError: () => say("Voice error. Try again."),
        onDisconnect: () => { conv = null; stop(); },
      });
      set("listening");
      try { conv.sendContextualUpdate("Run state now: " + (await tool("get_status")({}))); } catch (e) { /* not ready */ }
      timer = setInterval(() => {
        if (!conv) return;
        const line = narrator.tick(Date.now(), mode === "speaking");
        if (line) conv.sendUserMessage(line);
      }, 400);
    } catch (e: any) {
      say("Could not start the voice: " + String((e && e.message) || e));
      await stop();
    }
  };
  orb.addEventListener("click", () => (conv ? null : start()));
  mute.addEventListener("click", () => {
    if (!conv) return;
    const on = mute.getAttribute("aria-pressed") !== "true";
    conv.setMicMuted(on);
    mute.setAttribute("aria-pressed", String(on));
    mute.textContent = on ? "unmute" : "mute";
  });
  end.addEventListener("click", () => stop());
  win.addEventListener("beforeunload", () => conv && conv.endSession());
  win.__ddVoice = { milestone: (t: string) => narrator.push(t, Date.now()) };
}

/** /x/voice/dock.js */
export function dockScript(base: string): string {
  return [
    "(function(){",
    "var __name = function(f){ return f; };", // tsx/esbuild keepNames may inject __name calls
    `var createNarrator = (${createNarrator.toString()});`,
    `var voiceDock = (${voiceDock.toString()});`,
    `voiceDock(window, ${JSON.stringify(base)}, createNarrator);`,
    "})();",
  ].join("\n");
}
