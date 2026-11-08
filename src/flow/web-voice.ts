// The ElevenLabs voice narrator of the browser page, server side: the conversation-token route and the locally served
// SDK. It narrates and answers from run state only; it never translates and never changes a claim.
//
// The API key (env ELEVENLABS_API_KEY) stays in this process: it is sent only to api.elevenlabs.io, never in a
// response, an error or a log line. Without a key the voice is absent: no dock, no SDK, no extra CSP.
// The agent is ELEVENLABS_AGENT_ID, or found by name ("dd2dash0 migration narrator") through the agents API.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const AGENT_NAME = "dd2dash0 migration narrator";
const API = "https://api.elevenlabs.io";

export function voiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ELEVENLABS_API_KEY;
}

/** Extra CSP sources the SDK needs (WebRTC via LiveKit, audio worklets from blob: URLs). Only added with a key. */
export const VOICE_CSP = {
  connect: "https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io",
  script: "blob:",
  extra: "media-src blob: mediastream:; worker-src blob:",
};

let sdkCache: string | null | undefined;
/**
 * @elevenlabs/client 1.30.0's self-contained browser build (dist/lib.iife.js, global ElevenLabsClient), read from
 * node_modules. Its ESM entry (dist/index.js) imports livekit-client and other modules, so the one-file build is the
 * one a page without a bundler can load. null when the optional dependency is missing (the one-file Bun binary).
 */
export function sdkSource(): string | null {
  if (sdkCache !== undefined) return sdkCache;
  try {
    const entry = createRequire(import.meta.url).resolve("@elevenlabs/client");
    const iife = entry.replace(/[\\/]index\.js$/, "/lib.iife.js");
    sdkCache = existsSync(iife) ? readFileSync(iife, "utf8") : null;
  } catch {
    sdkCache = null;
  }
  return sdkCache;
}

export interface VoiceDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export type TokenResult = { status: number; body: { token: string } | { error: string } };

/** Mints a short-lived conversation token. The reply carries the token or a fixed error text; never the key. */
export function tokenMinter(d: VoiceDeps = {}): () => Promise<TokenResult> {
  const env = d.env ?? process.env;
  const f = d.fetch ?? globalThis.fetch;
  let agentId = env.ELEVENLABS_AGENT_ID ?? "";
  return async () => {
    const key = env.ELEVENLABS_API_KEY ?? "";
    if (!key) return { status: 404, body: { error: "voice not configured" } };
    const headers = { "xi-api-key": key };
    try {
      if (!agentId) {
        const r = await f(`${API}/v1/convai/agents?search=${encodeURIComponent(AGENT_NAME)}`, { headers });
        if (!r.ok) return { status: 502, body: { error: `could not find the agent (HTTP ${r.status})` } };
        const list = (await r.json()) as { agents?: { agent_id?: string; name?: string }[] };
        agentId = list.agents?.find((a) => a.name === AGENT_NAME)?.agent_id ?? "";
        if (!agentId) return { status: 502, body: { error: `no agent named "${AGENT_NAME}"` } };
      }
      const r = await f(`${API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, { headers });
      if (!r.ok) return { status: 502, body: { error: `token request failed (HTTP ${r.status})` } };
      const j = (await r.json()) as { token?: unknown };
      if (typeof j.token !== "string" || !j.token || j.token.includes(key)) return { status: 502, body: { error: "no token returned" } };
      return { status: 200, body: { token: j.token } };
    } catch {
      return { status: 502, body: { error: "token request failed (network)" } }; // the error itself could carry request details
    }
  };
}
