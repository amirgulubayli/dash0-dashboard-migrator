// JARVIS voice companion, server side. `dd2dash0 ui` calls mountVoice(server) only when ELEVENLABS_API_KEY and
// ELEVENLABS_AGENT_ID are set (docs/web-ui-contract.md §2, §4; setup in docs/VOICE.md).
//
//   GET /api/voice/config  { enabled, sdk }                      (is voice usable on this server?)
//   GET /api/voice/token   { token }                             (short-lived ElevenLabs conversation token)
//   GET /voice.js          the bundled @elevenlabs/client IIFE + the JARVIS dock (src/web/voice-client.ts)
//
// The API key never leaves this process: it is only sent to api.elevenlabs.io, never echoed in a response, an error
// or a log line. All routes refuse a Host or Origin that is not this machine (DNS rebinding, cross-site fetches).
// The agent narrates; it never translates and never changes a claim (its tools only read the page state).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { voiceClientScript } from "./voice-client.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** The part of the web server mountVoice needs (docs/web-ui-contract.md §2). The other members are not used here. */
export interface VoiceServerHost {
  route(method: string, path: string, handler: RouteHandler): void;
  [k: string]: unknown;
}

export interface VoiceOptions {
  apiKey?: string;
  agentId?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** The bundled SDK source, or null when it is not installed (e.g. the one-file binary). Injected for tests. */
  sdkSource?: () => string | null;
  /** ElevenLabs API origin. Default https://api.elevenlabs.io (use https://api.eu.residency.elevenlabs.io for EU). */
  apiOrigin?: string;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function voiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID);
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

/** True when the request plainly comes from a page on this machine. */
export function isLocalRequest(req: Pick<IncomingMessage, "headers">): boolean {
  const host = req.headers.host;
  if (!host || !LOCAL_HOSTS.has(hostnameOf(String(host)))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const u = new URL(String(origin));
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  return true;
}

let sdkCache: string | null | undefined;
/** The SDK's self-contained browser build (global `ElevenLabsClient`), read from node_modules. No CDN. */
export function loadSdkSource(): string | null {
  if (sdkCache !== undefined) return sdkCache;
  try {
    const entry = createRequire(import.meta.url).resolve("@elevenlabs/client");
    sdkCache = readFileSync(entry.replace(/index\.js$/, "lib.iife.js"), "utf8");
  } catch {
    sdkCache = null; // optional dependency missing, or a compiled binary without node_modules
  }
  return sdkCache;
}

function send(res: ServerResponse, status: number, type: string, body: string, secret?: string): void {
  // Belt and braces: the key must never appear in a JSON reply (real keys are long; short test strings are skipped
  // so redaction cannot corrupt unrelated text).
  const safe = secret && secret.length >= 16 && body.includes(secret) ? body.split(secret).join("[redacted]") : body;
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(safe);
}

export function mountVoice(server: VoiceServerHost, opts: VoiceOptions = {}): { enabled: boolean } {
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
  const agentId = opts.agentId ?? process.env.ELEVENLABS_AGENT_ID ?? "";
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sdk = opts.sdkSource ?? loadSdkSource;
  const apiOrigin = (opts.apiOrigin ?? process.env.ELEVENLABS_API_ORIGIN ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const enabled = !!(apiKey && agentId);
  const json = (res: ServerResponse, status: number, v: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(v), apiKey || undefined);
  const forbidden = (res: ServerResponse) => json(res, 403, { error: "forbidden: local requests only" });

  server.route("GET", "/api/voice/config", (req, res) => {
    if (!isLocalRequest(req)) return forbidden(res);
    json(res, 200, { enabled, sdk: sdk() !== null });
  });

  server.route("GET", "/api/voice/token", async (req, res) => {
    if (!isLocalRequest(req)) return forbidden(res);
    if (!enabled) return json(res, 404, { error: "voice not configured (set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID)" });
    try {
      const r = await doFetch(`${apiOrigin}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
        headers: { "xi-api-key": apiKey },
      });
      if (!r.ok) return json(res, 502, { error: `ElevenLabs token request failed (HTTP ${r.status})` });
      const body = (await r.json()) as { token?: unknown };
      if (typeof body?.token !== "string" || !body.token) return json(res, 502, { error: "ElevenLabs returned no token" });
      json(res, 200, { token: body.token });
    } catch {
      // Do not echo the underlying error: it could carry request details.
      json(res, 502, { error: "ElevenLabs token request failed (network)" });
    }
  });

  server.route("GET", "/voice.js", (req, res) => {
    if (!isLocalRequest(req)) return forbidden(res);
    const lib = sdk();
    const prelude = lib ?? "/* @elevenlabs/client is not bundled in this build: voice is unavailable. */";
    send(res, 200, "text/javascript; charset=utf-8", prelude + "\n;\n" + voiceClientScript());
  });

  return { enabled };
}
