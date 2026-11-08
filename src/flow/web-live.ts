// Live views on top of web-term.ts's page: the run timeline, live counters, the gaps -> levers panel, the report inline
// and the ElevenLabs voice dock. web-term stays the one renderer of the flow; this module only reads what the flow
// prints (the same bytes the terminal gets) and the report.json files it writes, and sends one small structured SSE
// event, {t:"live"}, alongside the bytes. It never changes terminal output, never translates, never changes a claim.
//
// Honesty: counts only (never a share or percentage), "EXACT IF" always with its condition, and "Not measured" /
// "Not checked" / "Not recorded" for anything the run did not record.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { gapsOf, type Gaps } from "./web-gaps.js";
import { Timeline, noPercent, type Counts, type RunReportJson, type TimelineSnapshot } from "./web-timeline.js";
import { dockScript } from "./web-voice-client.js";
import { sdkSource, tokenMinter, VOICE_CSP, voiceEnabled, type TokenResult } from "./web-voice.js";

export interface LiveState {
  tl: TimelineSnapshot;
  gaps: Gaps | null;
  /** "plan" while only the plan's report.json exists, "run" once the run wrote its own. */
  gapsFrom: "plan" | "run" | null;
  report: { url: string; label: string } | null;
  dryRun: boolean | null;
}

export interface LiveHost {
  token: string;
  origin: () => string;
  send: (ev: { t: "live"; state: LiveState; say?: string[] }) => void;
  cwd?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Live {
  feed: (bytes: string) => void;
  finish: (code: number) => void;
  /** A page (re)connected: send the current state (no spoken lines). */
  replay: () => void;
  /** Routes under /<secret>/x/. true when handled. The Host header is already checked by web-term. */
  handle: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
  state: () => LiveState;
  tool: (name: string, query: string) => string | null;
}

const argOf = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function webLive(h: LiveHost): Live {
  const now = h.now ?? Date.now;
  const cwd = h.cwd ?? process.cwd();
  const argv = h.argv ?? process.argv;
  const env = h.env ?? process.env;
  const startedAt = now();
  const tl = new Timeline(now);
  let gaps: Gaps | null = null;
  let gapsFrom: LiveState["gapsFrom"] = null;
  let plan: RunReportJson | null = null;
  let run: RunReportJson | null = null;
  const mint = tokenMinter({ env, ...(h.fetch ? { fetch: h.fetch } : {}) });
  const base = `/${h.token}`;

  const readJson = (f: string): RunReportJson | null => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as RunReportJson;
    } catch {
      return null;
    }
  };
  /** The plan's report.json, written by Translate: <--out>/plan, else the newest ./dd2dash0-run/<stamp>/plan. */
  const planFile = (): string | null => {
    const out = argOf(argv, "--out");
    if (out) {
      const f = resolve(cwd, out, "plan", "report.json");
      return existsSync(f) ? f : null;
    }
    const root = join(cwd, "dd2dash0-run");
    if (!existsSync(root)) return null;
    const cands = readdirSync(root)
      .map((d) => join(root, d, "plan", "report.json"))
      .filter((f) => existsSync(f) && statSync(f).mtimeMs >= startedAt - 1000)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return cands[0] ?? null;
  };
  const runFile = () => (tl.reportFile ? join(dirname(tl.reportFile), "report.json") : null);

  const state = (): LiveState => ({
    tl: tl.snapshot(),
    gaps,
    gapsFrom,
    report: tl.reportFile && existsSync(tl.reportFile) ? { url: `${base}/x/report`, label: "report.html" } : null,
    dryRun: argv.includes("--dry-run") ? true : run ? !/live/.test(JSON.stringify((run as { facts?: { mode?: string } }).facts ?? {})) : null,
  });

  const refresh = () => {
    if (!plan && tl.steps.find((s) => s.key === "translate")!.state === "done") {
      const f = planFile();
      if (f) plan = readJson(f);
      if (plan && !run) (gaps = gapsOf(plan)), (gapsFrom = "plan");
    }
    // The Result card's link can be cut off when the path is long (box() keeps only the text): the run folder is the
    // plan folder's parent, so its report.html sits there.
    if (!tl.reportFile && tl.steps.find((s) => s.key === "report")!.state === "done") {
      const pf = planFile();
      const html = pf ? join(dirname(dirname(pf)), "report.html") : null;
      if (html && existsSync(html)) tl.reportFile = html;
    }
    const rf = runFile();
    if (!run && rf && existsSync(rf) && tl.steps.find((s) => s.key === "report")!.state === "done") {
      run = readJson(rf);
      if (run) {
        tl.useReport(run);
        gaps = gapsOf(run);
        gapsFrom = "run";
      }
    }
  };

  const emit = (spoken: boolean) => {
    refresh();
    const say = spoken ? tl.takeMilestones().map((m) => spokenLine(m.text, m.key, tl.counts)) : (tl.takeMilestones(), []);
    h.send({ t: "live", state: state(), ...(say.length ? { say } : {}) });
  };

  const tool = (name: string, query: string): string | null => toolAnswer(name, query, state(), run ?? plan);

  return {
    feed: (bytes) => {
      if (tl.feed(bytes)) emit(true);
    },
    finish: (code) => {
      tl.finish(code);
      emit(true);
    },
    replay: () => emit(false),
    state,
    tool,
    handle: async (req, res, path) => {
      if (!path.startsWith(`${base}/x/`)) return false;
      const sub = path.slice(base.length + 3);
      const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", ...extra });
        res.end(body);
        return true;
      };
      if (req.method === "GET" && sub === "report") {
        const f = tl.reportFile;
        if (!f || !existsSync(f)) return send(404, "text/plain", "not found");
        // Sandboxed like web-term's file route, and frameable by this page only.
        return send(200, "text/html; charset=utf-8", readFileSync(f, "utf8"), {
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
          "X-Frame-Options": "SAMEORIGIN",
        });
      }
      const t = /^tool\/([a-z_]+)$/.exec(sub);
      if (req.method === "GET" && t) {
        const q = new URL(req.url ?? "", "http://x").searchParams.get("query") ?? "";
        const a = tool(t[1]!, q);
        return a === null ? send(404, "application/json", '{"error":"no such tool"}') : send(200, "application/json", a);
      }
      if (!voiceEnabled(env)) return false;
      if (req.method === "POST" && sub === "voice/token") {
        if (req.headers.origin !== h.origin()) return send(403, "application/json", '{"error":"forbidden"}');
        const r: TokenResult = await mint();
        return send(r.status, "application/json", JSON.stringify(r.body));
      }
      if (req.method === "GET" && sub === "voice/sdk.js") {
        const s = sdkSource();
        return s ? send(200, "text/javascript; charset=utf-8", s) : send(404, "text/plain", "voice not bundled");
      }
      if (req.method === "GET" && sub === "voice/dock.js") return send(200, "text/javascript; charset=utf-8", dockScript(base));
      return false;
    },
  };
}

/** One short spoken line for a milestone: counts only, never a percentage; "exact-under" said as "exact if …". */
export function spokenLine(text: string, key: string, c: Counts): string {
  let s = noPercent(text).replace(/(\d+) exact-under/g, "$1 exact if their conditions hold");
  if (key === "translate" && c.byLabel) {
    const b = c.byLabel;
    const parts = [b.exact && `${b.exact} exact`, b["exact-under"] && `${b["exact-under"]} exact if their conditions hold`, b.bounded && `${b.bounded} bounded`, b.manual && `${b.manual} manual`, b.unsupported && `${b.unsupported} unsupported`].filter(Boolean);
    if (parts.length) s += ` ${parts.join(", ")}.`;
  }
  if (key === "report" && c.translated) s = `Report written: ${c.translated.count} of ${c.translated.total} translated.`;
  return noPercent(s);
}

const NOT_MEASURED = "Not measured";
const measured = (m: Counts["landed"], word: string) => (m === undefined ? "Not recorded" : m === null ? word : `${m.count} of ${m.total}`);

/** The voice agent's client tools, answered from run state only (the flow's printed steps and report.json). */
export function toolAnswer(name: string, query: string, s: LiveState, report: RunReportJson | null): string | null {
  const j = (v: unknown) => JSON.stringify(v);
  const c = s.tl.counts;
  const items = (report?.items ?? []).filter((i) => i.kind === "panel" || i.kind === "alert");
  const claim = (it: (typeof items)[number]) => {
    const r = it.reasons ?? it.reason_codes ?? [];
    return it.status === "exact-under" ? `EXACT IF ${r.length ? r.join("; ") : "its conditions hold (condition not recorded)"}` : it.status;
  };
  switch (name) {
    case "get_status":
      return j({
        rule: "Counts only, never percentages.",
        current_step: s.tl.current ?? (s.tl.ended ? "finished" : "none running"),
        exit_code: s.tl.code ?? "Not recorded",
        dry_run: s.dryRun ?? "Not recorded",
        steps: s.tl.steps.map((x) => ({ step: x.label, state: x.state, result: x.summary || (x.state === "pending" ? "" : "Not recorded"), duration: x.time || "Not recorded" })),
        report: s.report ? "written" : "not written yet",
      });
    case "get_counts":
      return j({
        rule: "Counts only, never percentages. Say 'exact-under' as 'exact if' plus its condition (get_item has it).",
        source: c.source,
        items_found: c.items ?? "Not recorded",
        dashboards: c.dashboards ?? "Not recorded",
        monitors: c.monitors ?? "Not recorded",
        by_label: c.byLabel ?? "Not recorded",
        translated: c.translated ? `${c.translated.count} of ${c.translated.total}` : "Not recorded",
        landed: measured(c.landed, NOT_MEASURED),
        live: measured(c.live, "Not checked"),
      });
    case "get_item": {
      const q = query.trim().toLowerCase();
      if (!items.length) return j({ found: false, message: "No report.json yet: item details are Not recorded." });
      if (!q) return j({ found: false, message: "No query given." });
      let hits = items.filter((i) => i.id.toLowerCase() === q);
      if (!hits.length) hits = items.filter((i) => `${i.title} ${i.id} ${i.dashboard ?? ""}`.toLowerCase().includes(q));
      if (!hits.length) {
        const w = q.split(/\s+/).filter((x) => x.length > 2);
        hits = items.filter((i) => w.length > 0 && w.every((x) => `${i.title} ${i.id} ${i.dashboard ?? ""}`.toLowerCase().includes(x)));
      }
      if (!hits.length) return j({ found: false, message: `Nothing matches "${query}".` });
      return j({
        found: true,
        matches: hits.length,
        items: hits.slice(0, 3).map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          dashboard: i.dashboard ?? "Not recorded",
          claim: claim(i),
          reasons: i.reasons ?? i.reason_codes ?? [],
          datadog: i.sourceQueries?.length ? i.sourceQueries : "Not recorded",
          promql: i.promql?.length ? i.promql : "No PromQL generated",
          landed: i.landed === undefined || i.landed === null ? NOT_MEASURED : i.landed,
          live: i.live ?? "Not checked",
        })),
      });
    }
    case "list_attention": {
      const att = items.filter((i) => i.status === "bounded" || i.status === "manual" || i.status === "unsupported");
      if (!items.length) return j({ message: "No report.json yet: Not recorded." });
      const by: Record<string, { count: number; examples: string[] }> = {};
      for (const i of att) {
        const g = (by[i.status] ??= { count: 0, examples: [] });
        g.count++;
        if (g.examples.length < 5) g.examples.push(i.title);
      }
      return j({ needing_attention: att.length, of: items.length, by_label: by });
    }
    case "list_gaps":
      if (!s.gaps) return j({ message: "Gaps are measured after Translate: Not recorded yet." });
      return j({
        loop: "measure, decompose by reason, pull the lever, run again",
        not_exact: s.gaps.notExact,
        of: s.gaps.total,
        levers: s.gaps.levers,
        groups: s.gaps.groups.slice(0, 10).map((g) => ({ reason: g.code, items: g.count, by_label: g.byLabel, lever: g.lever, owner: g.owner })),
      });
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------ page pieces
// Same palette and glyphs as web-term.ts's page (its CSS variables), so the views read as part of the terminal.

/** web-term's CSP with the frame for the inline report and, with a voice key, the SDK's sources. */
export function liveCsp(csp: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = voiceEnabled(env) && sdkSource() !== null;
  let out = csp.replace("frame-ancestors 'none'", "frame-src 'self'; frame-ancestors 'none'");
  if (v) {
    out = out.replace("connect-src 'self'", `connect-src 'self' ${VOICE_CSP.connect}`).replace(/script-src ('nonce-[^']+')/, `script-src $1 ${VOICE_CSP.script}`);
    out += `; ${VOICE_CSP.extra}`;
  }
  return out;
}

/** The voice dock's markup and scripts: empty without a key (the dock is hidden). */
export function liveTags(token: string, nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!voiceEnabled(env) || sdkSource() === null) return "";
  return `<div id="vdock" class="vdock" hidden><div class="vpanel"><span class="vcap" role="status" aria-live="polite">Click the orb to talk. It narrates counts from this run; it never translates.</span><button type="button" class="vact" hidden></button><button type="button" class="vbtn vmute" aria-pressed="false">mute</button><button type="button" class="vbtn vend">end</button></div><button type="button" class="vorb" data-s="idle" aria-label="Talk to the narrator"><span></span></button></div>
<script nonce="${nonce}" src="/${token}/x/voice/sdk.js"></script><script nonce="${nonce}" src="/${token}/x/voice/dock.js"></script>`;
}

export const LIVE_CSS = `
.lv{display:flex;gap:28px;align-items:flex-start;padding:14px 20px 12px;border-bottom:1px solid var(--line);flex:none;font-size:12.5px}
.tl{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0 12px;flex:1;min-width:0}
.st{position:relative;min-width:0;padding-top:18px}
.st::before{content:"";position:absolute;top:7px;left:14px;right:-12px;height:1px;background:var(--line)}
.st:last-child::before{display:none}
.st.done::before,.st.skipped::before{background:var(--dim)}
.sd{position:absolute;top:0;left:0;width:14px;text-align:center;line-height:15px;color:var(--dim);background:var(--bg)}
.sl{font-weight:600;color:var(--dim)}
.sm{display:block;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.55em}
.tm{display:block;color:var(--dim);font-size:11.5px;min-height:1.4em}
.st.running .sd,.st.running .sl{color:var(--accent)}
.st.running .sd{animation:pulse 1.4s ease-in-out infinite}
.st.done .sd{color:var(--ok)}.st.done .sl{color:var(--fg)}
.st.failed .sd,.st.failed .sl,.st.failed .sm{color:var(--bad)}
@keyframes pulse{50%{opacity:.3}}
.ct{display:grid;grid-template-columns:auto auto;gap:1px 14px;flex:none;color:var(--dim);font-variant-numeric:tabular-nums;border-left:1px solid var(--line);padding-left:20px}
.ct b{color:var(--fg);font-weight:600;text-align:right}
.ct .x{color:var(--ok)}.ct .xi{color:var(--accent)}.ct .bd{color:var(--warn)}.ct .mn{color:var(--dim)}.ct .us{color:var(--bad)}
.ct .nm{color:var(--dim);font-weight:400;font-style:normal}
.ct .src{grid-column:1/-1;font-size:11px;margin-top:3px}
.lvmain{display:flex;justify-content:center;gap:28px;align-items:flex-start}
.lvmain #term{margin:0;flex:0 1 auto;min-width:0}
#gaps{display:none;width:360px;flex:none;position:sticky;top:20px;margin-top:28px;font-size:12.5px;border:1px solid var(--line);border-radius:6px;padding:12px 14px}
#gaps.on{display:block}
#gaps h2{font-size:12.5px;margin:0 0 2px;font-weight:600}
#gaps .sub{color:var(--dim);margin-bottom:10px}
#gaps .lvr{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:10px;color:var(--dim)}
#gaps .lvr b{color:var(--fg);font-weight:600}
#gaps table{width:100%;border-collapse:collapse}
#gaps td{padding:3px 0;vertical-align:top;border-top:1px solid var(--line)}
#gaps td.n{text-align:right;padding-right:10px;color:var(--fg);font-variant-numeric:tabular-nums;width:3ch}
#gaps td .lv2{display:block;color:var(--dim);font-size:11.5px}
#gaps a{text-decoration-color:var(--line)}
#gaps .more{color:var(--dim);margin-top:6px}
#report{display:none;max-width:1200px;margin:0 auto;padding:0 20px 48px}
#report.on{display:block}
#report .rh{display:flex;justify-content:space-between;gap:12px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding:14px 0 10px}
#report .rh b{color:var(--fg);font-weight:600}
#report iframe{width:100%;height:85vh;border:1px solid var(--line);border-radius:6px;background:#fff;display:block}
#term.short{padding-bottom:40px}
.vdock{position:fixed;right:18px;bottom:18px;display:flex;align-items:center;gap:10px;z-index:5;font-size:12px}
.vpanel{display:none;align-items:center;gap:8px;max-width:420px;background:var(--sel);border:1px solid var(--line);border-radius:999px;padding:5px 6px 5px 14px}
.vdock.on .vpanel,.vdock:hover .vpanel{display:flex}
.vcap{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.vbtn,.vact{font:inherit;font-size:11.5px;color:var(--dim);background:none;border:1px solid var(--line);border-radius:999px;padding:1px 9px;cursor:pointer}
.vact{color:var(--accent);border-color:var(--accent)}
.vbtn:hover{color:var(--fg);border-color:var(--accent)}
.vorb{position:relative;width:38px;height:38px;border-radius:50%;border:1px solid var(--line);background:var(--sel);cursor:pointer;display:grid;place-items:center;flex:none;padding:0}
.vorb span{width:12px;height:12px;border-radius:50%;background:var(--dim);transition:background .2s,transform .2s}
.vorb[data-s=connecting] span{background:var(--warn);animation:pulse 1s ease-in-out infinite}
.vorb[data-s=listening] span{background:var(--accent);animation:pulse 2.2s ease-in-out infinite}
.vorb[data-s=speaking] span{background:var(--ok);animation:speak .7s ease-in-out infinite}
.vorb::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:1px solid var(--accent);opacity:0}
.vorb[data-s=speaking]::after{animation:ring 1.2s ease-out infinite}
@keyframes speak{50%{transform:scale(1.45)}}
@keyframes ring{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion:reduce){.st.running .sd,.vorb span,.vorb::after{animation:none!important}}
@media (max-width:1180px){.lvmain{flex-direction:column;align-items:stretch}.lvmain #term{margin:0 auto}#gaps{position:static;width:auto;max-width:calc(98ch + 40px);margin:0 auto 24px}}
@media (max-width:760px){.lv{flex-direction:column;gap:10px}.tl{grid-template-columns:1fr;gap:2px}.st{padding:0 0 0 20px}.st::before{display:none}.sm,.tm{display:inline;margin-left:1ch}.ct{border:0;padding:0}}
`;

/** Browser side: draws {t:"live"} events. Plain ES2017, inlined into web-term's one page script. */
export const LIVE_JS = String.raw`
const LV = (() => {
  const STEPS = [["keys","Keys"],["translate","Translate"],["review","Review"],["import","Import"],["verify","Verify"],["report","Report"]];
  const GLYPH = { pending: "○", running: "●", done: "✓", skipped: "–", failed: "✗" };
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const strip = mk("div", "lv"); strip.id = "lv";
  const ol = mk("ol", "tl"); ol.setAttribute("aria-label", "Steps");
  for (const [k, label] of STEPS) { const li = mk("li", "st pending"); li.dataset.k = k; li.append(mk("span", "sd", "○"), mk("span", "sl", label), mk("span", "sm"), mk("span", "tm")); ol.append(li); }
  const ct = mk("div", "ct"); ct.setAttribute("aria-label", "Counts");
  strip.append(ol, ct);
  document.querySelector(".bar").after(strip);
  const main = mk("div", "lvmain"); const termEl = document.getElementById("term");
  termEl.before(main); main.append(termEl);
  const gapsEl = mk("aside"); gapsEl.id = "gaps"; gapsEl.setAttribute("aria-label", "Gaps to levers"); main.append(gapsEl);
  const reportEl = mk("section"); reportEl.id = "report"; main.after(reportEl);
  let reportShown = "", gapsKey = "";
  const n = (v, none) => v === undefined ? "Not recorded" : v === null ? none : typeof v === "number" ? String(v) : v.count + " / " + v.total;
  function counts(c) {
    ct.textContent = "";
    const row = (label, val, cls, title) => { const l = mk("span", "", label); const b = mk("b", cls || ""); if (/^Not /.test(val)) b.append(mk("i", "nm", val)); else b.textContent = val; if (title) { l.title = title; b.title = title; } ct.append(l, b); };
    row("items found", n(c.items, "Not recorded"));
    row("translated", n(c.translated, "Not recorded"));
    const by = c.byLabel || {};
    row("EXACT", c.byLabel ? String(by.exact) : "Not recorded", "x", "same result as Datadog for any data");
    row("EXACT IF", c.byLabel ? String(by["exact-under"]) : "Not recorded", "xi", "exact if the item's listed condition holds (each condition is in the report and in get_item)");
    row("bounded", c.byLabel ? String(by.bounded) : "Not recorded", "bd", "within a proven error bound; needs a human check");
    row("manual", c.byLabel ? String(by.manual) : "Not recorded", "mn", "not translated; the original query is kept for a person");
    row("unsupported", c.byLabel ? String(by.unsupported) : "Not recorded", "us", "Dash0 has no equivalent; a placeholder keeps the original");
    row("landed", n(c.landed, "Not measured"));
    row("live", n(c.live, "Not checked"));
    ct.append(mk("span", "src", c.source === "report.json" ? "from report.json" : "from the flow's output"));
  }
  function steps(snap) {
    for (const s of snap.steps) {
      const li = ol.querySelector('[data-k="' + s.key + '"]'); if (!li) continue;
      li.className = "st " + s.state;
      li.querySelector(".sd").textContent = GLYPH[s.state] || "○";
      const line = s.state === "running" ? (s.running || s.summary) : s.summary;
      const sm = li.querySelector(".sm"); sm.textContent = line ? "⎿ " + line : ""; sm.title = [s.summary].concat(s.details).filter(Boolean).join("\n");
      li.querySelector(".tm").textContent = s.state === "running" ? "running" : s.state === "pending" ? "" : s.time;
      li.setAttribute("aria-label", s.label + ": " + s.state + (line ? ", " + line : ""));
    }
  }
  function gaps(g, from) {
    const key = JSON.stringify(g) + from; if (key === gapsKey) return; gapsKey = key;
    gapsEl.textContent = ""; if (!g) { gapsEl.classList.remove("on"); return; }
    gapsEl.append(mk("h2", "", "Gaps → levers"), mk("div", "sub", g.notExact + " of " + g.total + " items are below EXACT IF (bounded, manual or unsupported) · grouped by reason · from " + (from === "run" ? "the run's" : "the plan's") + " report.json"));
    const lv = mk("div", "lvr"); for (const l of g.levers) { const s = mk("span"); s.append(mk("b", "", String(l.items)), " " + l.lever); lv.append(s); } gapsEl.append(lv);
    const tb = mk("table"); const LBL = { "exact-under": "EXACT IF", bounded: "bounded", manual: "manual", unsupported: "unsupported" };
    for (const r of g.groups.slice(0, 14)) {
      const tr = mk("tr"); tr.append(mk("td", "n", String(r.count)));
      const td = mk("td"); const a = mk("a", "", r.code); a.href = base + "/x/report#gap-" + encodeURIComponent(r.code); a.target = "_blank"; a.rel = "noreferrer";
      a.title = r.examples.join("\n");
      const by = Object.entries(r.byLabel).map(([k, v]) => v + " " + (LBL[k] || k) + (k === "exact-under" ? " " + r.code : "")).join(" · ");
      td.append(a, mk("span", "lv2", "→ " + r.lever + " · " + r.owner), mk("span", "lv2", by)); tr.append(td); tb.append(tr);
    }
    gapsEl.append(tb);
    if (g.groups.length > 14) gapsEl.append(mk("div", "more", "+ " + (g.groups.length - 14) + " more reasons in the report"));
    gapsEl.classList.add("on");
  }
  function report(r) {
    if (!r || reportShown === r.url) return; reportShown = r.url;
    reportEl.textContent = "";
    const head = mk("div", "rh"); const t = mk("span"); t.append(mk("b", "", "● Report"), " · " + r.label + " (sandboxed)");
    const a = mk("a", "", "open in a new tab ↗"); a.id = "rframe-open"; a.href = r.url; a.target = "_blank"; a.rel = "noreferrer";
    head.append(t, a);
    const f = mk("iframe"); f.title = "Run report"; f.src = r.url; f.setAttribute("sandbox", ""); f.setAttribute("referrerpolicy", "no-referrer");
    reportEl.append(head, f); reportEl.classList.add("on"); termEl.classList.add("short");
  }
  return {
    reset() { reportShown = ""; gapsKey = ""; reportEl.textContent = ""; reportEl.classList.remove("on"); gapsEl.classList.remove("on"); termEl.classList.remove("short"); },
    on(ev) {
      const s = ev.state; steps(s.tl); counts(s.tl.counts); gaps(s.gaps, s.gapsFrom); report(s.report);
      if (ev.say && window.__ddVoice) for (const t of ev.say) window.__ddVoice.milestone(t);
    },
  };
})();
`;
