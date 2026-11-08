// The browser half of JARVIS, served as GET /voice.js by src/web/voice.ts (after the bundled ElevenLabs SDK).
//
// No build step: `createNarrator`, `createVoiceTools` and `voiceDock` are written in TypeScript and shipped with
// Function.prototype.toString, so each must be self-contained (no imports or outer references inside the body).
// It codes against the page's `window.dd2ui = { state(), on(fn), confirm(text), run(step), decide(ids, decision, by) }`
// and the `#voice-dock` element (created bottom-right if the page has none).

import { createNarrator } from "./voice-narration.js";
import { createVoiceTools } from "./voice-tools.js";

export interface DockDeps {
  createNarrator: typeof createNarrator;
  createVoiceTools: typeof createVoiceTools;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function voiceDock(win: any, deps: DockDeps): void {
  const doc = win.document;
  if (win.__jarvisMounted) return;
  win.__jarvisMounted = true;

  const css = `
  #voice-dock{position:fixed;right:20px;bottom:20px;z-index:50;display:flex;align-items:flex-end;gap:10px;font-family:"Poppins","Inter",ui-sans-serif,system-ui;}
  .jv-panel{display:none;flex-direction:column;gap:6px;max-width:320px;background:#13131c;color:#f4f1fc;border-radius:14px;padding:10px 12px;box-shadow:0 10px 30px rgba(19,19,28,.25);font-size:12.5px;line-height:1.4}
  #voice-dock.jv-on .jv-panel{display:flex}
  .jv-head{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.04em;font-size:11px;text-transform:uppercase;color:#a78bfa}
  .jv-head span{flex:1}
  .jv-cap{min-height:1.4em;opacity:.95}
  .jv-cap b{color:#a78bfa;font-weight:600;margin-right:4px}
  .jv-cap.jv-you b{color:#c9c9d6}
  .jv-note{font-size:11px;color:#9a9aae}
  .jv-btn{border:1px solid #3a3a4c;background:transparent;color:#f4f1fc;border-radius:999px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer}
  .jv-btn:hover{border-color:#a78bfa}
  .jv-btn[aria-pressed=true]{background:#a78bfa;color:#13131c;border-color:#a78bfa}
  .jv-orb{position:relative;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:radial-gradient(circle at 35% 30%,#a78bfa,#6d28d9 62%);box-shadow:0 6px 22px rgba(109,40,217,.45);color:#fff;display:grid;place-items:center;flex:none}
  .jv-orb:focus-visible{outline:3px solid #a78bfa;outline-offset:3px}
  .jv-orb svg{width:24px;height:24px}
  .jv-orb::before,.jv-orb::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #a78bfa;opacity:0;pointer-events:none}
  .jv-orb[data-s=listening]::before{animation:jv-ring 2.4s ease-out infinite}
  .jv-orb[data-s=speaking]::before{animation:jv-ring 1.1s ease-out infinite}
  .jv-orb[data-s=speaking]::after{animation:jv-ring 1.1s ease-out .55s infinite}
  .jv-orb[data-s=thinking]{animation:jv-breathe 1.4s ease-in-out infinite}
  .jv-orb[data-s=connecting]{opacity:.75;animation:jv-breathe 1s ease-in-out infinite}
  .jv-orb[data-s=idle]{background:radial-gradient(circle at 35% 30%,#8b5cf6,#6d28d9 62%)}
  @keyframes jv-ring{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.55);opacity:0}}
  @keyframes jv-breathe{0%,100%{transform:scale(1)}50%{transform:scale(.93)}}
  @media (prefers-reduced-motion:reduce){.jv-orb,.jv-orb::before,.jv-orb::after{animation:none!important}}
  `;
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.appendChild(style);

  let dock = doc.getElementById("voice-dock");
  if (!dock) {
    dock = doc.createElement("div");
    dock.id = "voice-dock";
    doc.body.appendChild(dock);
  }
  dock.hidden = false;
  dock.innerHTML = `
    <div class="jv-panel" role="status" aria-live="polite">
      <div class="jv-head"><span>JARVIS · <i class="jv-st">idle</i></span>
        <button class="jv-btn jv-mute" aria-pressed="false" title="Mute microphone">Mute</button>
        <button class="jv-btn jv-end" title="End conversation">End</button></div>
      <div class="jv-cap jv-said"><b>JARVIS</b><span></span></div>
      <div class="jv-cap jv-you jv-heard"><b>You</b><span></span></div>
      <div class="jv-note">Narrates the deterministic results. No AI in translation.</div>
    </div>
    <button class="jv-orb" data-s="idle" aria-label="Talk to JARVIS" title="Talk to JARVIS">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
    </button>`;
  const q = (s: string) => dock.querySelector(s);
  const orb = q(".jv-orb"), stLabel = q(".jv-st"), said = q(".jv-said span"), heard = q(".jv-heard span");
  const muteBtn = q(".jv-mute"), endBtn = q(".jv-end");

  let conv: any = null;
  let mode = "idle";
  let muted = false;
  let timer: any = null;
  let unsubscribe: any = null;
  const narrator = deps.createNarrator();

  const setState = (s: string) => {
    mode = s;
    orb.dataset.s = s;
    stLabel.textContent = s;
    dock.classList.toggle("jv-on", s !== "idle");
    orb.setAttribute("aria-label", s === "idle" ? "Talk to JARVIS" : "JARVIS is " + s);
  };
  const caption = (el: any, text: string) => {
    el.textContent = String(text ?? "").slice(0, 220);
  };

  const waitForUi = async (): Promise<any> => {
    for (let i = 0; i < 100 && !win.dd2ui; i++) await new Promise((r) => setTimeout(r, 100));
    if (!win.dd2ui) throw new Error("page bridge (window.dd2ui) not found");
    return win.dd2ui;
  };

  const wrapTools = (tools: Record<string, (p: any) => Promise<string>>) => {
    const wrapped: Record<string, (p: any) => Promise<string>> = {};
    for (const [name, fn] of Object.entries(tools)) {
      wrapped[name] = async (p: any) => {
        if (mode !== "speaking") setState("thinking");
        return fn(p);
      };
    }
    return wrapped;
  };

  const stop = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
    unsubscribe = null;
    const c = conv;
    conv = null;
    if (c) {
      try { await c.endSession(); } catch { /* ignore */ }
    }
    setState("idle");
  };

  const start = async () => {
    if (conv || mode === "connecting") return;
    const Client = win.ElevenLabsClient;
    if (!Client || !Client.Conversation) {
      setState("connecting");
      caption(said, "Voice is unavailable: the ElevenLabs client is not bundled in this build.");
      setTimeout(() => setState("idle"), 4000);
      return;
    }
    setState("connecting");
    caption(said, "Connecting...");
    caption(heard, "");
    try {
      const ui = await waitForUi();
      await win.navigator.mediaDevices.getUserMedia({ audio: true });
      const r = await win.fetch("/api/voice/token", { headers: { accept: "application/json" } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.token) throw new Error(body.error || "no conversation token");
      conv = await Client.Conversation.startSession({
        conversationToken: body.token,
        connectionType: "webrtc",
        clientTools: wrapTools(deps.createVoiceTools(ui)),
        onModeChange: ({ mode: m }: { mode: string }) => setState(m === "speaking" ? "speaking" : "listening"),
        onMessage: (m: any) => {
          if (!m || !m.message) return;
          const fromUser = (m.role ?? m.source) === "user";
          if (fromUser) {
            caption(heard, m.message);
            setState("thinking");
          } else caption(said, m.message);
        },
        onError: (msg: any) => caption(said, "Voice error: " + String(msg)),
        onDisconnect: () => {
          conv = null;
          stop();
        },
      });
      setState("listening");
      muted = false;
      muteBtn.setAttribute("aria-pressed", "false");
      // Background for the agent: where things stand right now (counts only, read from state).
      try {
        const s = ui.state();
        const cur = s.current ? `Running: ${s.current}.` : "Nothing running.";
        const steps = (s.steps || []).map((x: any) => `${x.id} ${x.state}`).join(", ");
        conv.sendContextualUpdate(`App state at connect. ${cur} Steps: ${steps}. Items: ${s.accuracy?.total ?? 0}.`);
      } catch { /* state not ready */ }
      unsubscribe = ui.on((e: any) => narrator.push(e, Date.now()));
      timer = setInterval(() => {
        if (!conv) return;
        const t = narrator.tick(Date.now(), mode === "speaking");
        if (t.context) conv.sendContextualUpdate(t.context);
        if (t.speak) conv.sendUserMessage(t.speak);
      }, 500);
    } catch (err: any) {
      caption(said, "Could not start voice: " + String(err?.message ?? err));
      const c = conv;
      conv = null;
      if (c) { try { await c.endSession(); } catch { /* ignore */ } }
      setTimeout(() => { if (!conv) setState("idle"); }, 3500);
    }
  };

  orb.addEventListener("click", () => {
    if (!conv) start();
  });
  muteBtn.addEventListener("click", () => {
    if (!conv) return;
    muted = !muted;
    conv.setMicMuted(muted);
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.textContent = muted ? "Muted" : "Mute";
  });
  endBtn.addEventListener("click", () => stop());
  win.addEventListener("beforeunload", () => { if (conv) conv.endSession(); });
}

/** The browser script (without the SDK). `__name` is shimmed because tsx/esbuild's keepNames may inject it. */
export function voiceClientScript(): string {
  return [
    "/* dd2dash0 JARVIS voice dock: narrates deterministic results; never translates. */",
    "(function(){",
    "var __name = function(f){ return f; };",
    `var createNarrator = (${createNarrator.toString()});`,
    `var createVoiceTools = (${createVoiceTools.toString()});`,
    `var voiceDock = (${voiceDock.toString()});`,
    "function boot(){ voiceDock(window, { createNarrator: createNarrator, createVoiceTools: createVoiceTools }); }",
    "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();",
    "})();",
  ].join("\n");
}
