// Enter the keys in a browser instead of the terminal: a one-time page on 127.0.0.1 at a secret URL. The page sends
// the keys only to this local server, which checks them against Datadog and Dash0 (read-only) and hands them to the
// CLI. The server accepts only its own origin, closes itself after the keys are accepted, and times out. Keys are
// never logged; responses never echo a secret.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkDash0, checkDatadog, DEFAULTS, fingerprint, normalizeDash0Url, SECRET_KEYS, validSite, type KeyName, type Keys } from "./keys.js";

export interface WebKeysOptions {
  need: { datadog: boolean; dash0: boolean };
  /** Keys already found in env / .env (secrets are shown only as a fingerprint). */
  known: Keys;
  /** Folder the CLI runs in, shown in the header. */
  cwd: string;
  /** Where "save" writes the keys, shown next to the checkbox (e.g. ~/.config/dd2dash0/.env). */
  savePath?: string;
  fetch?: typeof fetch;
  /** Give up after this many ms. Default 15 minutes. */
  timeoutMs?: number;
  /** Called with the URL once the server listens (print it, open the browser). */
  onReady: (url: string) => void;
}

export interface WebKeysResult {
  keys: Keys;
  save: boolean;
}

type FieldState = { ok: boolean; message?: string };

const FIELDS: Record<"datadog" | "dash0", KeyName[]> = {
  datadog: ["DD_SITE", "DD_API_KEY", "DD_APP_KEY"],
  dash0: ["DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"],
};

/** Check a full set of keys; per-field results (used by the page for inline ✓ / ✗). */
export async function checkAll(k: Keys, need: WebKeysOptions["need"], f: typeof fetch = fetch): Promise<{ ok: boolean; fields: Partial<Record<KeyName, FieldState>>; keys: Keys }> {
  const fields: Partial<Record<KeyName, FieldState>> = {};
  const keys: Keys = { ...k };
  // Flag every empty required field in one pass, so the page shows all of them at once.
  for (const n of [...(need.datadog ? (["DD_API_KEY", "DD_APP_KEY"] as const) : []), ...(need.dash0 ? (["DASH0_API_URL", "DASH0_AUTH_TOKEN"] as const) : [])])
    if (!keys[n]) fields[n] = { ok: false, message: "required" };
  const missing = (n: KeyName) => {
    if (keys[n]) return false;
    fields[n] = { ok: false, message: "required" };
    return true;
  };
  if (need.datadog) {
    keys.DD_SITE = keys.DD_SITE || DEFAULTS.DD_SITE;
    const site = keys.DD_SITE!;
    if (!validSite(site)) fields.DD_SITE = { ok: false, message: "not a Datadog site (e.g. datadoghq.eu, us5.datadoghq.com)" };
    else {
      fields.DD_SITE = { ok: true };
      const m1 = missing("DD_API_KEY");
      const m2 = missing("DD_APP_KEY");
      if (!m1 && !m2) {
        const c = await checkDatadog({ site, apiKey: keys.DD_API_KEY!, appKey: keys.DD_APP_KEY! }, f);
        if (c.ok) fields.DD_API_KEY = fields.DD_APP_KEY = { ok: true };
        else if (/application key/.test(c.message)) {
          fields.DD_API_KEY = { ok: true };
          fields.DD_APP_KEY = { ok: false, message: c.message };
        } else if (/could not reach/.test(c.message)) fields.DD_SITE = { ok: false, message: c.message };
        else fields.DD_API_KEY = { ok: false, message: c.message };
      }
    }
  }
  if (need.dash0) {
    keys.DASH0_DATASET = keys.DASH0_DATASET || DEFAULTS.DASH0_DATASET;
    if (!missing("DASH0_API_URL")) {
      const u = normalizeDash0Url(keys.DASH0_API_URL!);
      if ("error" in u) fields.DASH0_API_URL = { ok: false, message: u.error };
      else {
        keys.DASH0_API_URL = u.url;
        if (!missing("DASH0_AUTH_TOKEN")) {
          const c = await checkDash0({ apiUrl: u.url, token: keys.DASH0_AUTH_TOKEN!, dataset: keys.DASH0_DATASET! }, f);
          if (c.ok) fields.DASH0_API_URL = fields.DASH0_AUTH_TOKEN = fields.DASH0_DATASET = { ok: true };
          else if (/404/.test(c.message)) {
            fields.DASH0_API_URL = { ok: false, message: c.message };
            fields.DASH0_DATASET = { ok: false, message: "check the dataset name" };
          } else if (/could not reach/.test(c.message)) fields.DASH0_API_URL = { ok: false, message: c.message };
          else {
            fields.DASH0_API_URL = { ok: true };
            fields.DASH0_AUTH_TOKEN = { ok: false, message: c.message };
          }
        }
      }
    }
  }
  return { ok: Object.values(fields).every((x) => x!.ok), fields, keys };
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** Run the one-time page until valid keys are submitted. Rejects on timeout. */
export function webKeys(o: WebKeysOptions): Promise<WebKeysResult> {
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    let origin = "";
    let finished = false;
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => send(res, 500, "text/plain", "error"));
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error("no keys were entered in the browser within 15 minutes"));
    }, o.timeoutMs ?? 15 * 60_000);
    timer.unref();
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 300).unref(); // let the last response flush
      server.closeIdleConnections?.();
    };

    async function handle(req: IncomingMessage, res: ServerResponse) {
      // Only our own address (DNS rebinding) and only the secret path.
      if (req.headers.host !== origin.replace("http://", "")) return send(res, 421, "text/plain", "wrong host");
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === `/${token}`) return send(res, 200, "text/html; charset=utf-8", page(o, nonce), { "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` });
      if (req.method === "POST" && path === `/${token}/check`) {
        if (finished) return send(res, 410, "application/json", JSON.stringify({ error: "already done" }));
        if (req.headers.origin !== origin || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
        const body = await readBody(req, 16_384);
        let parsed: { keys?: Record<string, unknown>; save?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400, "application/json", JSON.stringify({ error: "bad json" }));
        }
        const typed: Keys = {};
        for (const group of Object.values(FIELDS))
          for (const n of group) {
            const v = parsed.keys?.[n];
            if (typeof v === "string" && v.trim()) typed[n] = v.trim();
          }
        const merged: Keys = { ...o.known, ...typed };
        const r = await checkAll(merged, o.need, o.fetch ?? fetch);
        send(res, 200, "application/json", JSON.stringify({ ok: r.ok, fields: r.fields }));
        if (r.ok) {
          finish();
          resolve({ keys: r.keys, save: parsed.save === true });
        }
        return;
      }
      send(res, 404, "text/plain", "not found");
    }

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      o.onReady(`${origin}/${token}`);
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", ...extra });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABEL: Record<KeyName, { label: string; where: string; ph: string }> = {
  DD_SITE: { label: "site", where: "The domain you log in at, without app.: app.datadoghq.eu → datadoghq.eu; us5.datadoghq.com stays as is.", ph: "datadoghq.eu" },
  DD_API_KEY: { label: "API key", where: "Datadog → Organization Settings → API Keys. Usually 32 hex characters.", ph: "32 hex characters" },
  DD_APP_KEY: { label: "app key", where: "Datadog → Organization Settings → Application Keys. Needs dashboards_read and monitors_read. Usually 40 hex characters.", ph: "40 hex characters" },
  DASH0_API_URL: { label: "API URL", where: "Dash0 → Settings → Endpoints → API. Not the OTLP ingress endpoint.", ph: "https://api.eu-west-1.aws.dash0.com" },
  DASH0_AUTH_TOKEN: { label: "token", where: "Dash0 → Settings → Auth Tokens. Starts with auth_.", ph: "auth_…" },
  DASH0_DATASET: { label: "dataset", where: "Leave default unless your organization sends data to another dataset.", ph: "default" },
};

// The page script, as a raw string so its regular expressions keep their backslashes. Format hints only run in the
// browser and never block or show a value; the real check is the server's read-only call. No "${" or backticks here.
const SCRIPT = String.raw`
const f=document.getElementById("f"),go=document.getElementById("go"),st=document.getElementById("status"),frames="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";let spin;
const rows=()=>f.querySelectorAll(".row[data-field]");
function setRow(row,state,msg){row.classList.remove("ok","bad","warn","checking");if(state)row.classList.add(state);row.querySelector(".msg").textContent=msg||"";const i=row.querySelector("input");if(state==="bad")i.setAttribute("aria-invalid","true");else i.removeAttribute("aria-invalid");}
const FMT={DD_SITE:v=>/^([a-z0-9-]+\.)*(datadoghq\.(com|eu)|ddog-gov\.com)$/i.test(v.replace(/^https?:\/\//,"").replace(/\/.*$/,""))?"":"usually datadoghq.eu, datadoghq.com or us5.datadoghq.com",
 DD_API_KEY:v=>/^[0-9a-f]{32}$/i.test(v)?"":"a Datadog API key is usually 32 hex characters",
 DD_APP_KEY:v=>/^[0-9a-f]{40}$/i.test(v)?"":"a Datadog application key is usually 40 hex characters",
 DASH0_API_URL:v=>/ingress/i.test(v)?"this looks like the ingress endpoint; use the API one (api.…dash0.com)":/dash0/i.test(v)?"":"usually https://api.<region>.dash0.com",
 DASH0_AUTH_TOKEN:v=>/^auth_/.test(v)?"":"Dash0 tokens usually start with auth_"};
for(const row of rows()){const i=row.querySelector("input"),fmt=FMT[row.dataset.field];
 i.addEventListener("input",()=>{if(!row.classList.contains("checking"))setRow(row,"","");});
 i.addEventListener("blur",()=>{const v=i.value.trim();if(!fmt||!v||row.classList.contains("bad")||row.classList.contains("ok"))return;const m=fmt(v);setRow(row,m?"warn":"",m);});}
f.addEventListener("submit",async(e)=>{e.preventDefault();if(go.disabled)return;
 const keys={};for(const i of f.querySelectorAll(".row input"))keys[i.name]=i.value;
 for(const row of rows())setRow(row,"checking","");st.textContent="";
 go.disabled=true;let n=0;spin=setInterval(()=>{go.textContent=frames[n++%10]+" checking";},80);
 try{const r=await fetch(location.pathname+"/check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({keys,save:document.getElementById("save").checked})});
  const j=await r.json();for(const row of rows()){const s=j.fields&&j.fields[row.dataset.field];setRow(row,s?(s.ok?"ok":"bad"):"",s&&!s.ok&&s.message?s.message:"");}
  if(j.ok){document.body.classList.add("is-done");return;}
  if(!r.ok&&!j.fields)st.textContent=j.error==="already done"?"Already connected. Return to the terminal.":"Something went wrong; check the terminal.";
  const nb=f.querySelectorAll(".row.bad").length;if(nb)st.textContent=nb===1?"1 field needs a look.":nb+" fields need a look.";
  const bad=f.querySelector(".row.bad input");if(bad)bad.focus();
 }catch{for(const row of rows())setRow(row,"","");st.textContent="The terminal stopped listening. Run dd2dash0 again.";}
 finally{clearInterval(spin);go.textContent="Check and continue";go.disabled=false;}});
const drop=document.getElementById("drop"),dmsg=document.getElementById("dropmsg");
function fill(text){const got={};for(const raw of text.split(/\r?\n/)){const m=/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw);if(!m)continue;let v=m[2].trim();if(/^(['"]).*\1$/.test(v))v=v.slice(1,-1);else v=v.replace(/\s+#.*$/,"");got[m[1]]=v;}
 const used=[];for(const i of f.querySelectorAll(".row input")){if(got[i.name]){i.value=got[i.name];used.push(i.name);setRow(i.closest(".row"),"","");}}
 dmsg.className="msg "+(used.length?"ok-msg":"");dmsg.textContent=used.length?"⎿ filled "+used.join(", "):"⎿ no dd2dash0 keys found in that text";if(used.length)go.focus();}
drop.addEventListener("click",()=>drop.focus());
drop.addEventListener("paste",(e)=>{const t=e.clipboardData&&e.clipboardData.getData("text");if(t){e.preventDefault();fill(t);}});
for(const ev of["dragenter","dragover"])document.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add("over");});
document.addEventListener("dragleave",(e)=>{if(!e.relatedTarget)drop.classList.remove("over");});
document.addEventListener("drop",async(e)=>{e.preventDefault();drop.classList.remove("over");const file=e.dataTransfer&&e.dataTransfer.files[0];if(file&&file.size<65536)fill(await file.text());});
const first=[...f.querySelectorAll(".row input")].find(i=>!i.value&&i.required);(first||f.querySelector(".row input")).focus();
`;

/** The page: terminal look (monospace, one accent, step tree), keyboard-first, no external assets; only nonce'd style and script. */
function page(o: WebKeysOptions, nonce: string): string {
  const row = (n: KeyName) => {
    const { label, where, ph } = LABEL[n];
    const known = o.known[n];
    const secret = SECRET_KEYS.has(n);
    const value = known && !secret ? known : "";
    const placeholder = known && secret ? `set in .env (${fingerprint(known)}), leave empty to keep` : ph;
    return `<div class="row" data-field="${n}">
      <label for="${n}">${label}</label>
      <div class="field"><input id="${n}" name="${n}" type="${secret ? "password" : "text"}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="${n}-msg ${n}-hint"${!known && !DEFAULTS[n] ? " required" : ""}>
      <div class="msg" id="${n}-msg" aria-live="polite"></div><div class="hint" id="${n}-hint">${esc(where)}</div></div>
      <span class="state" aria-hidden="true"></span>
    </div>`;
  };
  const section = (name: string, keys: KeyName[]) => `<section aria-labelledby="h-${name}"><h2 id="h-${name}"><span class="dot" aria-hidden="true">●</span> ${name}</h2>${keys.map(row).join("")}</section>`;
  const what = [o.need.datadog ? "Datadog, to read your dashboards and monitors" : "", o.need.dash0 ? "Dash0, to import them" : ""].filter(Boolean).join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0 · connect</title><meta name="robots" content="noindex"><meta name="color-scheme" content="dark light">
<style nonce="${nonce}">
:root{--bg:#0c0d10;--fg:#d9dbe0;--dim:#8d929c;--line:#2a2e35;--accent:#87afff;--ok:#5fd787;--warn:#d7af5f;--bad:#ff6b6b;--sel:#87afff40;--ease:cubic-bezier(.23,1,.32,1);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--fg:#1d1f23;--dim:#5d626b;--line:#d9d9d4;--accent:#2d55c4;--ok:#17703d;--warn:#875a08;--bad:#b42f2d;--sel:#2d55c430;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}::selection{background:var(--sel)}
body{font:14px/1.6 ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;padding:9vh 24px 48px}
main{max-width:660px;margin:0 auto}
.frame{border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin-bottom:12px;display:inline-block;min-width:min(100%,420px);max-width:100%;overflow-wrap:anywhere}
.frame b{font-weight:600}.mark{color:var(--accent)}.dim{color:var(--dim)}
.lede{color:var(--dim);margin:0 0 28px;font-size:13px;max-width:62ch}
section{margin:0 0 24px}h2{font-size:14px;font-weight:600;margin:0 0 6px}.dot{color:var(--accent)}
.row{display:grid;grid-template-columns:9ch 1fr 2ch;gap:0 12px;align-items:start;padding:6px 0 6px 2ch;position:relative}
.row::before{content:"⎿";position:absolute;left:0;top:6px;color:var(--dim)}.row.one{grid-template-columns:1fr}
label{color:var(--dim);padding-top:3px;cursor:pointer}.row:focus-within label{color:var(--fg)}
input{width:100%;font:inherit;color:var(--fg);background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:3px 0 4px;outline:none;transition:border-color 150ms ease}
input::placeholder{color:var(--dim);opacity:.85}input:focus{border-bottom-color:var(--accent)}
.row.bad input{border-bottom-color:var(--bad)}.row.warn input{border-bottom-color:var(--warn)}.row.ok input{border-bottom-color:color-mix(in srgb,var(--ok) 55%,var(--line))}
.hint{color:var(--dim);font-size:12px;margin-top:3px;line-height:1.5}
.msg{font-size:12px;margin-top:3px}.msg:empty{display:none}.row.bad .msg{color:var(--bad)}.row.warn .msg{color:var(--warn)}
.state{padding-top:3px;text-align:right}.row.ok .state::after{content:"✓";color:var(--ok)}.row.bad .state::after{content:"✗";color:var(--bad)}.row.warn .state::after{content:"!";color:var(--warn)}.row.checking .state::after{content:"…";color:var(--dim)}
.save{display:flex;gap:10px;align-items:flex-start;color:var(--dim);margin:6px 0 22px 2ch;cursor:pointer;user-select:none;font-size:13px}
.save input{width:auto;accent-color:var(--accent);margin-top:4px}
.go{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}
button{font:inherit;color:var(--bg);background:var(--fg);border:0;border-radius:7px;padding:8px 14px;cursor:pointer;transition:transform 140ms var(--ease),opacity 150ms ease}
button:hover{opacity:.9}button:active{transform:scale(.97)}button[disabled]{opacity:.55;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:3px}input:focus-visible{outline:none}
.kbd{color:var(--dim)}#status{font-size:12.5px;color:var(--bad)}#status:empty{display:none}
.foot{color:var(--dim);font-size:12px;margin-top:28px;max-width:62ch}
.drop{outline:none}.dz{border:1px dashed var(--line);border-radius:8px;padding:10px 12px;color:var(--dim);font-size:12.5px;cursor:pointer;transition:border-color 150ms ease,color 150ms ease}
.drop:focus .dz,.drop.over .dz{border-color:var(--accent);color:var(--fg)}.drop:focus-visible{outline:none}.k{color:var(--fg)}.ok-msg{color:var(--ok)}
.done{display:none}.is-done form,.is-done .lede{display:none}.is-done .done{display:block}
.done p{margin:4px 0}.done .big{font-size:15px}
@media (prefers-reduced-motion:reduce){button,input,.dz{transition:none}button:active{transform:none}}
@media (max-width:520px){body{padding:32px 16px 40px}.row{grid-template-columns:1fr 2ch}label{grid-column:1/-1}}
</style></head><body><main>
<div class="frame"><div><span class="mark" aria-hidden="true">◆</span> <b>dd2dash0</b> <span class="dim">· connect</span></div><div class="dim">${esc(o.cwd)}</div></div>
<p class="lede">Keys for ${esc(what)}. Secret fields stay hidden and are never shown back; at most their last 4 characters.</p>
<form id="f" novalidate>
<section class="drop" id="drop" tabindex="0" aria-label="Drop or paste a .env file"><h2><span class="dot" aria-hidden="true">●</span> Have a .env?</h2>
<div class="row one"><div class="field"><div class="dz">Drop it here, or click and paste its contents (<span class="k">Ctrl+V</span> / <span class="k">⌘V</span>). The fields below fill in; nothing leaves this page until you press the button.</div><div class="msg ok-msg" id="dropmsg" aria-live="polite"></div></div></div></section>
${o.need.datadog ? section("Datadog", FIELDS.datadog) : ""}
${o.need.dash0 ? section("Dash0", FIELDS.dash0) : ""}
<label class="save"><input type="checkbox" id="save" checked> <span>save them in ${esc(o.savePath ?? "~/.config/dd2dash0/.env")} (only you can read it; works from any folder)</span></label>
<div class="go"><button id="go" type="submit">Check and continue</button><span class="kbd">⏎</span><span id="status" role="status"></span></div>
<p class="foot">Keys go only to this computer (127.0.0.1). It checks them with one read-only call to Datadog and one to Dash0, then hands them to the terminal. This page works once.</p>
</form>
<div class="done" role="status"><p class="big"><span class="dot" aria-hidden="true">●</span> <b>Connected</b></p><p class="dim">  ⎿ Keys checked. The terminal is continuing; you can close this tab.</p></div>
</main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

/** Exported for tests and the preview: the page HTML for given options and nonce. */
export const _keysPage = page;
