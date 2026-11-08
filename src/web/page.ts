// The `dd2dash0 ui` page: one HTML document with inline CSS and JS (no CDN, no external assets).
// Look: pitch deck v5.4 tokens (docs/web-ui-contract.md §3). Honesty rules (§5): counts, never percentages;
// EXACT IF always with its condition; status = shape + word + colour; "Not recorded" / "Not checked" when a file
// doesn't record it. Everything shown comes from /api/state, which the server reads from the CLI's files.
// Written without template literals inside the client code so the whole page can live in one String.raw.
import { ANSI_JS } from "./ansi.js";

const CSS = String.raw`
:root{--violet:#6d28d9;--violet-2:#a78bfa;--violet-3:#ede7fb;--ink:#13131c;--ink-2:#1d1d2a;--body:#474757;--muted:#6b6b7a;
--lav:#f4f1fc;--lav-2:#e4dcf7;--amber:#b45309;--amber-bg:#fff7ed;--red:#b4224a;--red-bg:#fdf0f3;--green:#1f7a4d;--white:#fff;
--radius:14px;--shadow:0 1px 2px rgba(19,19,28,.05),0 6px 24px rgba(109,40,217,.06);
--sans:"Poppins","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"JetBrains Mono","Cascadia Mono",Consolas,monospace;
--term-h:260px}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#fff;color:var(--body);font-family:var(--sans);font-size:14px;line-height:1.45}
button{font:inherit;cursor:pointer}
:focus-visible{outline:3px solid var(--violet-2);outline-offset:2px}
.app{display:grid;grid-template-rows:auto 1fr auto;height:100vh}
header{display:flex;align-items:center;gap:18px;padding:14px 24px;border-bottom:1px solid var(--lav-2);background:#fff}
.brand{font-weight:700;font-size:20px;color:var(--ink);letter-spacing:-.01em;white-space:nowrap}
.brand b{color:var(--violet)}.brand span{color:var(--muted);font-weight:500}
.route{display:flex;align-items:center;gap:8px;min-width:0;flex:1;color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--lav);border:1px solid var(--lav-2);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42ch}
.pill.dry{background:var(--amber-bg);border-color:#fcd9b0;color:var(--amber)}
.badge{font-size:11px;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:6px;border:1px solid var(--lav-2);color:var(--muted)}
.badge.live{color:var(--violet);border-color:var(--violet-2)}
.badge.live::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--violet);margin-right:6px;animation:pulse 1.6s infinite}
.btn{border:1px solid var(--lav-2);background:#fff;color:var(--ink);border-radius:10px;padding:7px 13px;font-weight:600;font-size:13px;transition:background .15s,border-color .15s,transform .05s}
.btn:hover{background:var(--lav);border-color:var(--violet-2)}.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--violet);border-color:var(--violet);color:#fff}.btn.primary:hover{background:#5b21b6}
.btn[disabled]{opacity:.45;cursor:not-allowed}
main{display:grid;grid-template-columns:330px minmax(0,1fr);min-height:0}
@media (min-width:1700px){main{grid-template-columns:380px minmax(0,1fr)}}
/* step rail */
.rail{padding:20px 18px 20px 24px;overflow:auto;border-right:1px solid var(--lav-2);background:linear-gradient(#fff,#fbfaff)}
.rail h2,.card h2{margin:0 0 12px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
.step{position:relative;background:var(--lav);border:1.5px solid var(--lav-2);border-radius:var(--radius);padding:14px 16px 14px 16px;margin-bottom:14px;transition:border-color .2s,box-shadow .2s,background .2s}
.step+.step::before{content:"";position:absolute;left:33px;top:-15px;width:2px;height:14px;background:var(--lav-2)}
.step.done+.step::before{background:var(--violet-2)}
.step .top{display:flex;align-items:center;gap:12px}
.num{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:16px;background:#fff;color:var(--violet);border:2px solid var(--lav-2);flex:none}
.step h3{margin:0;font-size:18px;color:var(--ink);font-weight:700;flex:1}
.st{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:6px;background:#fff;color:var(--muted);border:1px solid var(--lav-2);white-space:nowrap}
.step.current{border-color:var(--violet);background:#fff;box-shadow:0 0 0 4px var(--violet-3)}
.step.running{border-color:var(--violet);background:#fff;animation:glow 1.6s ease-in-out infinite}
.step.running .num{background:var(--violet);color:#fff;border-color:var(--violet)}
.step.running .st{color:var(--violet);border-color:var(--violet-2)}
.step.done .num{background:var(--violet);color:#fff;border-color:var(--violet)}
.step.done .st{color:var(--violet);border-color:var(--violet-2);background:var(--violet-3)}
.step.failed{border-color:var(--red);background:var(--red-bg)}.step.failed .num{color:var(--red);border-color:var(--red)}.step.failed .st{color:var(--red);border-color:#f0b9c8}
.step.blocked{opacity:.78}.step.blocked .st{color:var(--muted)}
.cmd{margin:10px 0 0;font-family:var(--mono);font-size:11.5px;color:var(--ink);background:#fff;border:1px solid var(--lav-2);border-radius:8px;padding:7px 9px;word-break:break-all;line-height:1.4}
.cmd::before{content:"$ ";color:var(--violet)}
.cmd.nocmd::before{content:""}
.step .meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;min-height:32px}
.step .note{font-size:12.5px;color:var(--body);margin-top:8px}
.step.blocked .note::before{content:"\23F8  ";}
.dur{font-family:var(--mono);font-size:12px;color:var(--muted)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--violet-2);border-top-color:var(--violet);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes glow{0%,100%{box-shadow:0 0 0 3px var(--violet-3)}50%{box-shadow:0 0 0 7px rgba(109,40,217,.16)}}
.rail .hint{font-size:12px;color:var(--muted);margin-top:4px}
.rail .hint kbd,.kbd{font-family:var(--mono);font-size:11px;background:var(--lav);border:1px solid var(--lav-2);border-radius:4px;padding:0 5px;color:var(--ink)}
/* centre */
.centre{overflow:auto;padding:20px 28px 28px;min-width:0}
.card{background:#fff;border:1px solid var(--lav-2);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px;margin-bottom:18px}
.counts{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:28px;align-items:start}
.headline{font-size:54px;line-height:1;font-weight:700;color:var(--ink);letter-spacing:-.03em;white-space:nowrap}
.headline small{font-size:22px;color:var(--muted);font-weight:600;letter-spacing:0}
.headline-label{font-size:15px;color:var(--ink);font-weight:600;margin-top:6px}
.headline-sub{font-size:12.5px;color:var(--muted);margin-top:4px}
.delta{display:inline-block;margin-left:10px;font-size:14px;font-weight:700;padding:3px 9px;border-radius:999px;vertical-align:middle;opacity:0;transition:opacity .3s}
.delta.show{opacity:1}.delta.up{background:var(--violet-3);color:var(--violet)}.delta.down{background:var(--red-bg);color:var(--red)}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}
.fact{background:var(--lav);border-radius:10px;padding:8px 10px}
.fact b{display:block;font-size:20px;color:var(--ink)}.fact span{font-size:11.5px;color:var(--muted)}
.fact.nr b{font-size:13px;color:var(--muted);font-weight:600;padding:5px 0 3px}
.barrow{margin-bottom:14px}
.barhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12.5px;color:var(--muted)}
.barhead b{color:var(--ink);font-size:13px}
.bar{display:flex;height:26px;border-radius:8px;overflow:hidden;background:var(--lav);border:1px solid var(--lav-2)}
.bar>div{display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;min-width:0;overflow:hidden;white-space:nowrap;transition:flex-grow .5s ease}
.c-exact{background:var(--violet)}.c-exact-under{background:#8b5cf6}.c-bounded{background:var(--amber)}.c-manual{background:var(--muted)}.c-unsupported{background:var(--red)}
.d-approved{background:var(--violet)}.d-flagged{background:var(--amber)}.d-rejected{background:var(--red)}.d-pending{background:transparent;color:var(--muted)!important}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px}
.legend button{border:0;background:none;padding:2px 0;color:var(--body);font-size:12.5px;display:inline-flex;align-items:center;gap:6px}
.legend button:hover{color:var(--violet)}
.legend .n{font-weight:700;color:var(--ink)}
/* chips: shape + word + colour */
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:6px;white-space:nowrap;border:1px solid}
.chip i{font-style:normal;font-size:12px}
.chip.exact{color:var(--violet);background:var(--violet-3);border-color:#d6c8f5}
.chip.exact-under{color:#5b21b6;background:#f3eeff;border-color:#d6c8f5}
.chip.bounded{color:var(--amber);background:var(--amber-bg);border-color:#fcd9b0}
.chip.manual{color:#4b4b5c;background:#f1f1f4;border-color:#d9d9e0}
.chip.unsupported{color:var(--red);background:var(--red-bg);border-color:#f0b9c8}
.chip.monitor{color:var(--ink);background:#fff;border-color:var(--lav-2)}
/* landed panel */
.landed{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.landed .fact b{font-size:24px}
.banner{border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:12px}
.banner.dry{background:var(--amber-bg);color:var(--amber);border:1px solid #fcd9b0}
.banner.ok{background:var(--violet-3);color:var(--violet)}
.banner.keys{background:var(--lav);color:var(--ink);border:1px dashed var(--violet-2)}
.banner code{font-family:var(--mono);font-size:12px;background:#fff;padding:1px 5px;border-radius:4px}
/* table */
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.toolbar input[type=search],.toolbar select{font:inherit;font-size:13px;border:1px solid var(--lav-2);border-radius:10px;padding:7px 11px;background:#fff;color:var(--ink)}
.toolbar input[type=search]{flex:1;min-width:200px}
.toolbar .sep{flex:1}
.fchip{border:1px solid var(--lav-2);background:#fff;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:600;color:var(--body)}
.fchip[aria-pressed=true]{background:var(--violet);border-color:var(--violet);color:#fff}
.table{border:1px solid var(--lav-2);border-radius:12px;overflow:hidden}
.row{display:grid;grid-template-columns:132px minmax(0,1fr) 150px 196px;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--lav-2);background:#fff;outline:none}
.row:first-child{border-top:0}
.row.head{background:var(--lav);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:8px 14px;position:sticky;top:0;z-index:1}
.row:not(.head):hover{background:#fcfbff}
.row:focus{background:#faf7ff;box-shadow:inset 3px 0 0 var(--violet)}
.row .t{min-width:0}
.row .t b{color:var(--ink);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .t span{font-size:12px;color:var(--muted);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .t .cond{color:#5b21b6}
.row .t .cond::before{content:"if: ";font-weight:700}
.row .st2{font-size:12px;color:var(--muted)}
.dec{display:flex;gap:4px;justify-content:flex-end}
.dec button{border:1px solid var(--lav-2);background:#fff;border-radius:8px;padding:4px 8px;font-size:12px;font-weight:600;color:var(--body);display:inline-flex;align-items:center;gap:4px}
.dec button:hover{border-color:var(--violet-2)}
.dec button u{text-decoration:none;font-family:var(--mono);font-size:10px;color:var(--muted)}
.dec button.on.approved{background:var(--violet);border-color:var(--violet);color:#fff}
.dec button.on.flagged{background:var(--amber);border-color:var(--amber);color:#fff}
.dec button.on.rejected{background:var(--red);border-color:var(--red);color:#fff}
.dec button.on u{color:rgba(255,255,255,.8)}
.row.flash{animation:flash .6s}
@keyframes flash{from{background:var(--violet-3)}to{background:#fff}}
.detail{grid-column:1/-1;background:var(--lav);border-radius:10px;padding:14px 16px;margin-top:4px;cursor:auto}
.detail p{margin:0 0 10px;color:var(--ink)}
.detail .lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:10px 0 4px}
.sbs{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.code{font-family:var(--mono);font-size:12px;background:var(--ink);color:#e9e7f5;border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;min-height:38px}
.code.dd{background:#fff;color:var(--ink);border:1px solid var(--lav-2)}
.code .none{color:var(--muted);font-style:italic}
.reasons{margin:0;padding-left:18px}.reasons li{margin:2px 0;font-size:12.5px}
.facts4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.facts4 div{background:#fff;border-radius:8px;padding:6px 9px;font-size:12px}
.facts4 b{display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.empty{padding:40px 20px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--ink);font-size:16px;margin-bottom:6px}
footer.foot{margin-top:18px;font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center}
/* terminal */
.term{background:var(--ink);color:#e9e7f5;display:flex;flex-direction:column;height:var(--term-h);min-height:36px;border-top:3px solid var(--violet)}
.term.collapsed{height:38px!important}
.term .grip{height:6px;margin-top:-6px;cursor:ns-resize}
.term .bar2{display:flex;align-items:center;gap:10px;padding:7px 14px 7px 18px;background:var(--ink-2);font-size:12px;color:#b9b6cc}
.term .bar2 .ttl{font-weight:700;color:#fff;letter-spacing:.04em}
.term .bar2 .ttl::before{content:"\25CF";color:var(--violet-2);margin-right:8px}
.term .bar2 .cmdline{font-family:var(--mono);color:var(--violet-2);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.term .bar2 button{background:transparent;border:1px solid #3a3a4d;color:#d9d7e8;border-radius:7px;padding:3px 10px;font-size:12px}
.term .bar2 button:hover{border-color:var(--violet-2);color:#fff}
.term pre{margin:0;flex:1;overflow:auto;padding:10px 18px 14px;font-family:var(--mono);font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.term pre .err{color:#ffb4c4}
.term pre .run{display:block;margin-top:8px;color:var(--violet-2);font-weight:700}
.term pre .ms{display:block;color:#86f0bb}
.term pre .ph{color:#7d7a92}
/* toast, modal, voice dock */
.toasts{position:fixed;top:72px;right:22px;display:flex;flex-direction:column;gap:8px;z-index:20;max-width:420px}
.toast{background:var(--ink);color:#fff;padding:11px 15px;border-radius:12px;box-shadow:0 10px 30px rgba(19,19,28,.25);font-size:13px;border-left:4px solid var(--violet-2);animation:tin .25s ease}
@keyframes tin{from{transform:translateY(-6px);opacity:0}to{transform:none;opacity:1}}
.modal{position:fixed;inset:0;background:rgba(19,19,28,.45);display:grid;place-items:center;z-index:30}
.modal[hidden]{display:none}
.modal .box{background:#fff;border-radius:16px;padding:22px 24px;max-width:460px;width:calc(100% - 40px);box-shadow:0 20px 60px rgba(19,19,28,.35)}
.modal .box h3{margin:0 0 8px;color:var(--ink)}
.modal .box p{margin:0 0 18px;white-space:pre-wrap}
.modal .acts{display:flex;justify-content:flex-end;gap:8px}
#voice-dock{position:fixed;right:22px;bottom:calc(var(--term-h) + 18px);z-index:15}
#voice-dock[hidden]{display:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:1400px){.row{grid-template-columns:120px minmax(0,1fr) 120px 186px}.counts{grid-template-columns:240px minmax(0,1fr)}.headline{font-size:46px}}
`;

const BODY = String.raw`
<div class="app">
<header>
  <div class="brand"><b>dd2dash0</b> <span>/ Migration Review</span></div>
  <div class="route" id="route"></div>
  <span class="badge" id="conn" title="Server-Sent Events connection">OFFLINE</span>
  <button class="btn" id="attn" title="Show the items that still need a person (keyboard: n)">What needs my attention?</button>
</header>
<main>
  <nav class="rail" aria-label="Steps">
    <h2>Run</h2>
    <div id="steps"></div>
    <div class="hint">Keys: <kbd>a</kbd> approve, <kbd>f</kbd> flag, <kbd>r</kbd> reject, <kbd>u</kbd> undo on the focused row; <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>Enter</kbd> details, <kbd>/</kbd> search.</div>
  </nav>
  <section class="centre" id="centre" aria-label="Results">
    <div class="card" id="countsCard"></div>
    <div id="landedCard"></div>
    <div class="card">
      <h2 id="reviewTitle">Human check</h2>
      <div class="toolbar" id="toolbar">
        <input type="search" id="q" placeholder="Search title, dashboard, query, PromQL..." aria-label="Search items">
        <select id="fDash" aria-label="Filter by dashboard"></select>
        <select id="fDec" aria-label="Filter by decision">
          <option value="">Any decision</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="flagged">Flagged</option><option value="rejected">Rejected</option>
        </select>
      </div>
      <div class="toolbar" id="claimbar"></div>
      <div class="toolbar" id="bulk"></div>
      <div class="table" id="table" role="grid" aria-label="Review items"></div>
      <footer class="foot" id="foot"></footer>
    </div>
  </section>
</main>
<section class="term" id="term" aria-label="Terminal">
  <div class="grip" id="grip" title="Drag to resize"></div>
  <div class="bar2"><span class="ttl">TERMINAL</span><span class="cmdline" id="cmdline">the real CLI runs here</span>
    <button id="copy" title="Copy the terminal output">Copy</button><button id="clear" title="Clear the panel (not the log)">Clear</button><button id="fold" aria-expanded="true">Collapse</button></div>
  <pre id="out" tabindex="0" aria-live="off"></pre>
</section>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<div class="modal" id="modal" hidden role="dialog" aria-modal="true" aria-labelledby="mt"><div class="box"><h3 id="mt">Confirm</h3><p id="mtext"></p>
  <div class="acts"><button class="btn" id="mno">Cancel</button><button class="btn primary" id="myes">Confirm</button></div></div></div>
<div id="voice-dock" hidden aria-label="Voice companion"></div>
`;

const JS = String.raw`
(function () {
  "use strict";
  var CLAIMS = ["manual", "unsupported", "bounded", "exact-under", "exact"];
  var CHIP = { exact: ["\u2713", "EXACT"], "exact-under": ["\u2713", "EXACT IF"], bounded: ["\u00B1", "BOUNDED"], manual: ["!", "MANUAL"], unsupported: ["\u2205", "UNSUPPORTED"] };
  var LEG = { exact: "\u2713 exact", "exact-under": "\u2713 exact if", bounded: "\u00B1 bounded", manual: "! manual", unsupported: "\u2205 unsupported" };
  var STEPN = { plan: "Plan", review: "Review", apply: "Apply", watch: "Watch" };
  var DEC = [["approved", "Approve", "a"], ["flagged", "Flag", "f"], ["rejected", "Reject", "r"]];
  var S = null, listeners = [], expanded = {}, focusId = null, lastTranslated = null;
  var filt = { q: "", claim: "", dash: "", dec: "", attn: false };
  var $ = function (id) { return document.getElementById(id); };
  function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function chip(c) { var x = CHIP[c] || ["?", String(c).toUpperCase()]; return '<span class="chip ' + esc(c) + '"><i aria-hidden="true">' + x[0] + "</i>" + x[1] + "</span>"; }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e) }; });
  }
  function toast(text, ms) {
    var d = document.createElement("div"); d.className = "toast"; d.textContent = text; $("toasts").appendChild(d);
    setTimeout(function () { d.remove(); }, ms || 5200);
  }
  function dur(st) {
    if (!st.startedAt) return "";
    var a = Date.parse(st.startedAt), b = st.endedAt ? Date.parse(st.endedAt) : Date.now();
    var s = Math.max(0, (b - a) / 1000);
    return s < 60 ? s.toFixed(1) + " s" : Math.floor(s / 60) + " min " + Math.round(s % 60) + " s";
  }

  // ---------- header ----------
  function renderHeader() {
    $("route").innerHTML = '<span class="pill" title="' + esc(S.source) + '">Datadog: ' + esc(S.source) + '</span><span aria-hidden="true">\u2192</span>' +
      '<span class="pill' + (S.dryRun ? " dry" : "") + '" title="' + esc(S.target) + '">' + (S.dryRun ? "dry run: imports nothing" : esc(S.target)) + "</span>";
    $("voice-dock").hidden = !S.voice;
  }

  // ---------- step rail ----------
  var RUNLABEL = { plan: "Run Plan", review: "Save review", apply: "Run Apply", watch: "Run Watch" };
  function renderSteps() {
    var h = "";
    S.steps.forEach(function (st, n) {
      var cur = S.current === st.id && st.state !== "running";
      var label = st.state === "running" ? '<span class="spin"></span>running' : st.state === "done" ? "\u2713 done" : st.state === "failed" ? "\u2717 failed" : st.state === "blocked" ? "blocked" : cur ? "next" : "idle";
      var canRun = st.state !== "blocked" && st.state !== "running" && !S.steps.some(function (x) { return x.state === "running"; });
      var btn = "";
      if (st.id === "apply" && canRun) btn = '<button class="btn primary" data-run="apply">' + (S.dryRun ? "Run Apply (dry run)" : "Run Apply") + "</button>";
      else if (st.id !== "review" && canRun) btn = '<button class="btn' + (cur || st.state === "failed" ? " primary" : "") + '" data-run="' + st.id + '">' + (st.state === "done" || st.state === "failed" ? "Run again" : RUNLABEL[st.id]) + "</button>";
      else if (st.id === "review" && st.state !== "blocked") btn = '<button class="btn" data-goto="review">' + (st.state === "done" ? "Open review" : "Review now") + "</button>";
      h += '<div class="step ' + st.state + (cur ? " current" : "") + '" aria-current="' + (cur || st.state === "running" ? "step" : "false") + '">' +
        '<div class="top"><div class="num">' + (st.state === "done" ? "\u2713" : st.state === "failed" ? "\u2717" : n + 1) + "</div><h3>" + STEPN[st.id] + '</h3><span class="st">' + label + "</span></div>" +
        (st.command ? '<div class="cmd' + (st.id === "review" || st.id === "watch" ? " nocmd" : "") + '">' + esc(st.command) + "</div>" : "") +
        (st.note ? '<div class="note">' + esc(st.note) + "</div>" : "") +
        '<div class="meta"><span class="dur" data-dur="' + st.id + '">' + (dur(st) ? "\u23F1 " + dur(st) : "") + (st.exitCode != null ? "  exit " + st.exitCode : "") + "</span>" + btn + "</div></div>";
    });
    $("steps").innerHTML = h;
  }
  setInterval(function () {
    if (!S) return;
    S.steps.forEach(function (st) { if (st.state === "running") { var el = document.querySelector('[data-dur="' + st.id + '"]'); if (el) el.textContent = "\u23F1 " + dur(st); } });
  }, 250);

  // ---------- counts (no percentages) ----------
  function seg(cls, n, total, label) {
    if (!n) return "";
    return '<div class="' + cls + '" style="flex-grow:' + n + '" title="' + esc(label + ": " + n + " of " + total) + '">' + (n / total > 0.035 ? n : "") + "</div>";
  }
  function renderCounts() {
    var a = S.accuracy, el = $("countsCard");
    if (!a.total) {
      el.innerHTML = '<div class="empty"><b>No plan yet</b>Run <span class="kbd">Plan</span> on the left: it runs the real CLI on ' + esc(S.source) + " and every count here comes from its report.</div>";
      return;
    }
    var measured = a.landed != null;
    var head = measured && a.success != null ? [a.success, "succeeded: translated, landed and not failing live"] : [a.translated, "translated (exact, exact if, and bounded you approved)"];
    var p = a.panels, m = a.monitors;
    var claimBar = function (grp, total, title) {
      return '<div class="barrow"><div class="barhead"><b>' + title + "</b><span>" + total + " total</span></div>" +
        '<div class="bar" role="img" aria-label="' + esc(title + ": " + CLAIMS.map(function (c) { return grp[c] + " " + LEG[c]; }).join(", ")) + '">' +
        ["exact", "exact-under", "bounded", "manual", "unsupported"].map(function (c) { return seg("c-" + c, grp[c], total, LEG[c]); }).join("") + "</div>" +
        '<div class="legend">' + CLAIMS.map(function (c) { return '<button data-claim="' + c + '" title="Show only ' + LEG[c] + '">' + chip(c) + ' <span class="n">' + grp[c] + "</span></button>"; }).join("") + "</div></div>";
    };
    var rev = '<div class="barrow"><div class="barhead"><b>Human check</b><span>' + (a.required - a.requiredOpen) + " of " + a.required + " items that apply needs a decision for are decided</span></div>" +
      '<div class="bar" role="img" aria-label="' + esc(a.approved + " approved, " + a.flagged + " flagged, " + a.rejected + " rejected, " + a.pending + " pending") + '">' +
      seg("d-approved", a.approved, a.total, "approved") + seg("d-flagged", a.flagged, a.total, "flagged") + seg("d-rejected", a.rejected, a.total, "rejected") + seg("d-pending", a.pending, a.total, "pending") + "</div>" +
      '<div class="legend"><span>\u2714 approved <span class="n">' + a.approved + '</span></span><span>\u2691 flagged <span class="n">' + a.flagged + '</span></span><span>\u2716 rejected <span class="n">' + a.rejected + '</span></span><span>\u25CB pending <span class="n">' + a.pending + "</span></span></div></div>";
    var landed = measured ? '<div class="fact"><b>' + a.landed + '</b><span>landed (read back from Dash0)</span></div>' : '<div class="fact nr"><b>Not recorded</b><span>landed: needs a real Apply</span></div>';
    var live = a.live != null ? '<div class="fact"><b>' + a.live + '</b><span>live (return data in Dash0)</span></div>' : '<div class="fact nr"><b>Not checked</b><span>live: needs Watch</span></div>';
    el.innerHTML = '<div class="counts"><div>' +
      '<div class="headline" aria-live="polite">' + head[0] + " <small>of " + a.total + '</small><span class="delta" id="delta"></span></div>' +
      '<div class="headline-label">' + head[1] + "</div>" +
      '<div class="headline-sub">' + p.total + " panels and " + m.total + " monitors, counted from report.json</div>" +
      '<div class="facts"><div class="fact"><b>' + a.translated + '</b><span>translated</span></div>' + landed + live + "</div></div><div>" +
      claimBar(p.byClaim, p.total, "Panels by label") + claimBar(m.byClaim, m.total, "Monitors by label (not in the panel totals)") + rev + "</div></div>";
    if (lastTranslated != null && lastTranslated !== a.translated) {
      var d = $("delta"), diff = a.translated - lastTranslated;
      d.textContent = (diff > 0 ? "+" : "") + diff + " translated"; d.className = "delta show " + (diff > 0 ? "up" : "down");
      setTimeout(function () { d.classList.remove("show"); }, 2600);
    }
    lastTranslated = a.translated;
  }

  // ---------- what landed / watch ----------
  function renderLanded() {
    var el = $("landedCard"), ap = S.applied, w = S.steps[3];
    if (!ap) { el.innerHTML = ""; return; }
    var h = '<div class="card"><h2>What Apply did</h2>';
    if (ap.mode === "dry-run") h += '<div class="banner dry"><b>Dry run: nothing was imported into Dash0.</b> The CLI wrote the approved payloads to <code>' + esc(S.out.replace(/\\/g, "/")) + "/plan/apply/dash0</code>. Set Dash0 keys and run Apply again to import.</div>";
    else h += '<div class="banner ok"><b>Imported into Dash0.</b> Each item was read back after the import; "landed" below means the read-back matched.</div>';
    h += '<div class="landed">' +
      (ap.mode === "dry-run" ? '<div class="fact"><b>' + ap.written + '</b><span>payloads written to disk</span></div><div class="fact nr"><b>Not recorded</b><span>imported (dry run)</span></div>'
        : '<div class="fact"><b>' + ap.imported + '</b><span>imported</span></div><div class="fact"><b>' + ap.readBackMatch + '</b><span>read back identical</span></div>') +
      '<div class="fact"><b>' + ap.rules + '</b><span>check rules ' + (ap.mode === "dry-run" ? "written" : "sent") + '</span></div><div class="fact"><b>' + ap.placeholders + '</b><span>flagged panels became placeholders</span></div>' +
      (ap.failed ? '<div class="fact"><b style="color:var(--red)">' + ap.failed + "</b><span>failed</span></div>" : "") + "</div>";
    if (!S.keys.dash0) h += '<div class="banner keys" style="margin-top:12px"><b>Watch needs keys.</b> Put <code>DASH0_API_URL</code>, <code>DASH0_AUTH_TOKEN</code> (and <code>DD_API_KEY</code>, <code>DD_APP_KEY</code> for the Datadog side) in the environment or in <code>.env</code>, then restart <code>dd2dash0 ui</code>. Until then, live is "Not checked".</div>';
    else if (w.state === "done") h += '<div class="banner ok" style="margin-top:12px">Watch ran: live state per item is in the table (column Result).</div>';
    el.innerHTML = h + "</div>";
  }

  // ---------- review table ----------
  function rank(it) { var r = CLAIMS.indexOf(it.claim); return r * 2 + (it.kind === "alert" ? 0 : 1); }
  function visible() {
    var q = filt.q.toLowerCase();
    return S.items.filter(function (it) {
      if (filt.attn && !(it.required && it.decision === "pending")) return false;
      if (filt.claim && it.claim !== filt.claim) return false;
      if (filt.dash && (filt.dash === "__monitors" ? it.kind !== "alert" : it.dashboard !== filt.dash)) return false;
      if (filt.dec && it.decision !== filt.dec) return false;
      if (q && (it.title + " " + (it.dashboard || "") + " " + it.datadog.join(" ") + " " + it.promql.join(" ") + " " + it.id).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (x, y) { return rank(x) - rank(y); });
  }
  function resultCell(it) {
    if (it.live) return '<span class="st2" title="' + esc(it.liveDetail || "") + '">' + esc(it.live) + "</span>";
    if (it.landed) return '<span class="st2" title="' + esc(it.landed) + '">' + esc(it.landed.replace(", read-back skipped", "")) + "</span>";
    return '<span class="st2">' + (it.required ? "needs a decision" : it.kind === "alert" ? "no check rule" : "imported as translated") + "</span>";
  }
  function codeBlock(lines, cls, none) {
    return '<div class="code ' + cls + '">' + (lines.length ? lines.map(esc).join("\n") : '<span class="none">' + none + "</span>") + "</div>";
  }
  function detail(it) {
    var asText = function (d) { var v = it.reviewAs[d]; return v ? "writes \u201C" + v + "\u201D to review.json" : "nothing in review.json"; };
    return '<div class="detail" data-detail="' + esc(it.id) + '">' +
      (it.condition ? '<div class="lbl">Exact if</div><p>' + esc(it.condition) + "</p>" : "") +
      '<div class="lbl">In plain words</div><p>' + esc(it.plain || "Not recorded") + "</p>" +
      '<div class="sbs"><div><div class="lbl">Datadog</div>' + codeBlock(it.datadog, "dd", "no query (" + esc(it.widget || it.kind) + ")") + '</div><div><div class="lbl">PromQL (Dash0)</div>' + codeBlock(it.promql, "", "No PromQL generated") + "</div></div>" +
      '<div class="lbl">Reasons</div>' + (it.reasons.length ? '<ul class="reasons">' + it.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" : "<p>None recorded</p>") +
      '<div class="lbl">Facts</div><div class="facts4"><div><b>Import</b>' + esc(it.landed || "Not recorded") + "</div><div><b>Returns data</b>" + esc(it.live || "Not checked") + (it.liveDetail ? " (" + esc(it.liveDetail) + ")" : "") +
      "</div><div><b>Approve</b>" + asText("approved") + "</div><div><b>Flag / reject</b>" + asText("flagged") + "</div></div>" +
      '<p style="margin-top:10px;font-size:12px;color:var(--muted)">id ' + esc(it.id) + (it.required ? "" : " \u00B7 apply imports it as translated whatever you decide here; your decision is a human check") + "</p></div>";
  }
  function renderTable() {
    var dashes = {}; S.items.forEach(function (it) { if (it.dashboard) dashes[it.dashboard] = (dashes[it.dashboard] || 0) + 1; });
    var ds = '<option value="">All dashboards and monitors</option>' + Object.keys(dashes).sort().map(function (d) { return '<option value="' + esc(d) + '"' + (filt.dash === d ? " selected" : "") + ">" + esc(d) + " (" + dashes[d] + ")</option>"; }).join("") +
      '<option value="__monitors"' + (filt.dash === "__monitors" ? " selected" : "") + ">Monitors only</option>";
    if ($("fDash").innerHTML !== ds) $("fDash").innerHTML = ds;
    $("claimbar").innerHTML = '<button class="fchip" data-fclaim="" aria-pressed="' + (!filt.claim) + '">All labels</button>' +
      CLAIMS.map(function (c) { return '<button class="fchip" data-fclaim="' + c + '" aria-pressed="' + (filt.claim === c) + '">' + CHIP[c][0] + " " + CHIP[c][1] + " " + S.accuracy.byClaim[c] + "</button>"; }).join("") +
      '<span class="sep"></span><button class="fchip" data-attn aria-pressed="' + filt.attn + '">Needs a person: ' + S.accuracy.requiredOpen + "</button>";
    var vis = visible();
    var pend = function (c) { return S.items.filter(function (it) { return it.claim === c && it.decision === "pending"; }).length; };
    $("bulk").innerHTML = S.items.length ? '<span style="font-size:12px;color:var(--muted)">Bulk:</span>' +
      '<button class="btn" data-bulk="exact-under" ' + (pend("exact-under") ? "" : "disabled") + ">\u2713 Approve all EXACT IF (" + pend("exact-under") + ")</button>" +
      '<button class="btn" data-bulk="exact" ' + (pend("exact") ? "" : "disabled") + ">\u2713 Approve all EXACT (" + pend("exact") + ")</button>" +
      '<button class="btn" data-bulk="visible" ' + (vis.some(function (it) { return it.decision === "pending"; }) ? "" : "disabled") + ">Approve visible pending</button>" +
      '<button class="btn" data-bulk="flagvis" ' + (vis.some(function (it) { return it.decision === "pending" && it.claim === "bounded"; }) ? "" : "disabled") + ">\u2691 Flag visible pending bounded</button>" : "";
    $("reviewTitle").textContent = "Human check \u00B7 " + vis.length + " of " + S.items.length + " shown";
    if (!S.items.length) { $("table").innerHTML = '<div class="empty"><b>Nothing to review yet</b>The items appear here when Plan has written report.json.</div>'; return; }
    var h = '<div class="row head" role="row"><span>Label</span><span>Item</span><span>Result</span><span style="text-align:right">Your decision</span></div>';
    vis.forEach(function (it) {
      var sub = it.claim === "exact-under" ? '<span class="cond">' + esc(it.condition || it.plain || "Not recorded") + "</span>" : "<span>" + esc((it.kind === "alert" ? "monitor" : it.dashboard || "") + (it.widget ? " \u00B7 " + it.widget : "")) + "</span>";
      h += '<div class="row" role="row" tabindex="0" data-id="' + esc(it.id) + '" aria-expanded="' + !!expanded[it.id] + '">' +
        "<span>" + chip(it.claim) + (it.kind === "alert" ? ' <span class="chip monitor" title="Datadog monitor"><i>\u25C9</i>MON</span>' : "") + "</span>" +
        '<span class="t"><b>' + esc(it.title) + "</b>" + sub + "</span>" + resultCell(it) +
        '<span class="dec">' + DEC.map(function (d) { var on = it.decision === d[0]; return '<button class="' + d[0] + (on ? " on" : "") + '" data-dec="' + d[0] + '" aria-pressed="' + on + '" title="' + d[1] + " (" + d[2] + ')">' + d[1] + " <u>" + d[2] + "</u></button>"; }).join("") + "</span>" +
        (expanded[it.id] ? detail(it) : "") + "</div>";
    });
    if (!vis.length) h += '<div class="empty"><b>No items match</b>Clear the filters to see everything.</div>';
    var y = $("centre").scrollTop;
    $("table").innerHTML = h;
    $("centre").scrollTop = y;
    if (focusId) { var f = document.querySelector('.row[data-id="' + cssEsc(focusId) + '"]'); if (f && document.activeElement && (document.activeElement === document.body || document.activeElement.classList.contains("row") || document.activeElement.tagName === "BUTTON")) f.focus({ preventScroll: true }); }
    $("foot").textContent = (S.outputHash ? "output hash " + S.outputHash.slice(0, 16) : "output hash Not recorded") + " \u00B7 no AI in translation \u00B7 dd2dash0 " + S.version;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  function render() { if (!S) return; renderHeader(); renderSteps(); renderCounts(); renderLanded(); renderTable(); }

  // ---------- state & events ----------
  var refreshTimer = null;
  function refresh() { return fetch("/api/state").then(function (r) { return r.json(); }).then(function (s) { S = s; render(); return s; }); }
  function soon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); }
  var out = $("out"), stick = true;
  out.addEventListener("scroll", function () { stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 30; });
  function addLine(e) {
    var span = document.createElement("span");
    if (/^\x1b\[38;5;141m\$ /.test(e.text)) { span.className = "run"; $("cmdline").textContent = e.text.replace(/\x1b\[[0-9;]*m/g, ""); }
    else if (e.stream === "stderr") span.className = "err";
    span.innerHTML = ansiToHtml(e.text) + "\n";
    out.appendChild(span);
    while (out.childNodes.length > 4000) out.removeChild(out.firstChild);
    if (stick) out.scrollTop = out.scrollHeight;
  }
  function connect() {
    var es = new EventSource("/api/events");
    es.onopen = function () { $("conn").textContent = "LIVE"; $("conn").className = "badge live"; };
    es.onerror = function () { $("conn").textContent = "RECONNECTING"; $("conn").className = "badge"; };
    es.onmessage = function (m) {
      var e; try { e = JSON.parse(m.data); } catch (x) { return; }
      listeners.slice().forEach(function (fn) { try { fn(e); } catch (x) { } });
      if (e.type === "line") addLine(e);
      else if (e.type === "milestone") { toast(e.text); var ms = document.createElement("span"); ms.className = "ms"; ms.textContent = "\u2192 " + e.text; out.appendChild(ms); if (stick) out.scrollTop = out.scrollHeight; }
      else if (e.type === "step") { soon(); if (e.state === "running") { $("term").classList.remove("collapsed"); } }
      else soon();
    };
  }

  // ---------- actions ----------
  function run(step) {
    return post("/api/run/" + step).then(function (r) { if (!r.ok) toast("Not started: " + r.error); soon(); return r; });
  }
  function decide(ids, decision, by) {
    if (!Array.isArray(ids)) ids = [ids];
    return post("/api/decision", { ids: ids, decision: decision, by: by || "ui" }).then(function (r) { if (!r.ok) toast("Not saved: " + r.error); else soon(); return r; });
  }
  var modalResolve = null;
  function confirmBox(text) {
    if (modalResolve) modalResolve(false);
    $("mtext").textContent = text; $("modal").hidden = false; $("myes").focus();
    return new Promise(function (res) { modalResolve = res; });
  }
  function closeModal(v) { $("modal").hidden = true; if (modalResolve) { var r = modalResolve; modalResolve = null; r(v); } }
  $("myes").onclick = function () { closeModal(true); };
  $("mno").onclick = function () { closeModal(false); };
  $("modal").addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(false); });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button,[data-id]"); if (!t) return;
    if (t.dataset.run) { run(t.dataset.run); return; }
    if (t.dataset.goto) { $("q").scrollIntoView({ behavior: "smooth", block: "center" }); filt.attn = true; render(); return; }
    if (t.dataset.claim != null || t.dataset.fclaim != null) { var c = t.dataset.claim != null ? t.dataset.claim : t.dataset.fclaim; filt.claim = filt.claim === c ? "" : c; renderTable(); return; }
    if (t.hasAttribute("data-attn")) { filt.attn = !filt.attn; renderTable(); return; }
    if (t.dataset.bulk) {
      var b = t.dataset.bulk, ids;
      if (b === "visible") ids = visible().filter(function (it) { return it.decision === "pending"; }).map(function (it) { return it.id; });
      else if (b === "flagvis") { ids = visible().filter(function (it) { return it.decision === "pending" && it.claim === "bounded"; }).map(function (it) { return it.id; }); decide(ids, "flagged"); return; }
      else ids = S.items.filter(function (it) { return it.claim === b && it.decision === "pending"; }).map(function (it) { return it.id; });
      if (ids.length) decide(ids, "approved");
      return;
    }
    var row = t.closest(".row[data-id]");
    if (t.dataset.dec && row) { var it = byId(row.dataset.id); focusId = row.dataset.id; decide([row.dataset.id], it && it.decision === t.dataset.dec ? "pending" : t.dataset.dec); return; }
    if (row && !e.target.closest(".detail")) { focusId = row.dataset.id; expanded[focusId] = !expanded[focusId]; renderTable(); }
  });
  function byId(id) { return S.items.filter(function (x) { return x.id === id; })[0]; }
  $("q").addEventListener("input", function () { filt.q = this.value; renderTable(); });
  $("fDash").addEventListener("change", function () { filt.dash = this.value; renderTable(); });
  $("fDec").addEventListener("change", function () { filt.dec = this.value; renderTable(); });
  $("attn").onclick = function () { filt.attn = true; filt.claim = ""; filt.dec = ""; renderTable(); var f = document.querySelector(".row[data-id]"); if (f) { f.focus(); focusId = f.dataset.id; } };
  document.addEventListener("focusin", function (e) { var r = e.target.closest && e.target.closest(".row[data-id]"); if (r) focusId = r.dataset.id; });
  document.addEventListener("keydown", function (e) {
    if (!$("modal").hidden) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "/") { e.preventDefault(); $("q").focus(); return; }
    if (e.key === "n" && !e.ctrlKey && !e.metaKey) { $("attn").click(); return; }
    var row = e.target.closest && e.target.closest(".row[data-id]"); if (!row || e.ctrlKey || e.metaKey || e.altKey) return;
    var map = { a: "approved", f: "flagged", r: "rejected", u: "pending" };
    if (map[e.key]) { e.preventDefault(); focusId = row.dataset.id; decide([row.dataset.id], map[e.key]); var nx = row.nextElementSibling; if (map[e.key] !== "pending" && nx && nx.dataset.id) { focusId = nx.dataset.id; nx.focus(); } return; }
    if (e.key === "Enter" || e.key === " ") { if (e.target.tagName === "BUTTON") return; e.preventDefault(); expanded[row.dataset.id] = !expanded[row.dataset.id]; renderTable(); return; }
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); var n = row.nextElementSibling; if (n && n.dataset.id) n.focus(); }
    if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); var p = row.previousElementSibling; if (p && p.dataset.id) p.focus(); }
  });

  // ---------- terminal panel ----------
  $("copy").onclick = function () {
    var text = out.innerText;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast("Terminal output copied", 1800); }, function () {
      var r = document.createRange(); r.selectNodeContents(out); var s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); toast("Terminal output copied", 1800);
    });
  };
  $("clear").onclick = function () { out.innerHTML = ""; };
  $("fold").onclick = function () { var c = $("term").classList.toggle("collapsed"); this.textContent = c ? "Expand" : "Collapse"; this.setAttribute("aria-expanded", String(!c)); };
  (function () {
    var g = $("grip"), drag = false;
    try { var saved = localStorage.getItem("dd2ui.termh"); if (saved) document.documentElement.style.setProperty("--term-h", saved); } catch (x) { }
    g.addEventListener("mousedown", function (e) { drag = true; e.preventDefault(); });
    window.addEventListener("mousemove", function (e) { if (!drag) return; var h = Math.max(80, Math.min(window.innerHeight - 200, window.innerHeight - e.clientY)); document.documentElement.style.setProperty("--term-h", h + "px"); });
    window.addEventListener("mouseup", function () { if (drag) { drag = false; try { localStorage.setItem("dd2ui.termh", getComputedStyle(document.documentElement).getPropertyValue("--term-h").trim()); } catch (x) { } } });
  })();

  // ---------- hook for the voice companion (docs/web-ui-contract.md §6) ----------
  window.dd2ui = {
    state: function () { return S; },
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    confirm: confirmBox,
    run: run,
    decide: decide,
  };

  fetch("/api/log").then(function (r) { return r.json(); }).then(function (l) {
    if (l.lines && l.lines.length) l.lines.forEach(addLine);
    else out.innerHTML = '<span class="ph">Each step runs the real dd2dash0 CLI as a child process; its output streams here with its colours.\n</span>';
  }).catch(function () { });
  refresh().then(function (s) {
    connect();
    if (s.voice) { var sc = document.createElement("script"); sc.src = "/voice.js"; document.body.appendChild(sc); }
  });
})();
`;

export function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dd2dash0 ui</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236d28d9'/%3E%3Cpath d='M9 17l5 5 9-12' stroke='white' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
${BODY}
<script>
${ANSI_JS}
${JS}
</script>
</body>
</html>`;
}
