import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/pipeline/migrate.js";
import { writeReport } from "../../src/report/index.js";
import { allowedOrigin, startServer } from "../../src/serve/server.js";
import { AGENT_NAME, CLIENT_TOOLS, SYSTEM_PROMPT, VOICE_TOOL_ROUTES, setupAgent } from "../../src/voice/agent.js";
import { runVoice } from "../../src/voice/cli.js";

type Call = { method: string; url: string; key: string | null; body: any };

/** In-memory ElevenLabs: tools and agents keyed by id, enough for list / create / patch / token. */
function fakeElevenLabs(seed: { agents?: { agent_id: string; name: string }[] } = {}) {
  const calls: Call[] = [];
  const tools: { id: string; tool_config: any }[] = [];
  const agents = [...(seed.agents ?? [])] as { agent_id: string; name: string; body?: any }[];
  let n = 0;
  const f = (async (u: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(u));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(u), key: (init.headers as Record<string, string>)["xi-api-key"] ?? null, body });
    const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    const p = url.pathname;
    if (p === "/v1/convai/tools" && method === "GET") return ok({ tools });
    if (p === "/v1/convai/tools" && method === "POST") {
      const t = { id: `tool_${++n}`, tool_config: body.tool_config };
      tools.push(t);
      return ok(t);
    }
    if (p.startsWith("/v1/convai/tools/") && method === "PATCH") return ok({ id: p.split("/").pop() });
    if (p === "/v1/convai/agents" && method === "GET") {
      const s = url.searchParams.get("search") ?? "";
      return ok({ agents: agents.filter((a) => a.name.includes(s)).map(({ agent_id, name }) => ({ agent_id, name })), has_more: false });
    }
    if (p === "/v1/convai/agents/create") {
      const a = { agent_id: `agent_${++n}`, name: body.name, body };
      agents.push(a);
      return ok({ agent_id: a.agent_id });
    }
    if (p.startsWith("/v1/convai/agents/") && method === "PATCH") return ok({});
    if (p === "/v1/convai/conversation/token") return ok({ token: `tok-for-${url.searchParams.get("agent_id")}` });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, calls, tools, agents };
}

describe("voice setup", () => {
  it("creates the tools and the agent once, then updates in place (no duplicates)", async () => {
    const el = fakeElevenLabs();
    const first = await setupAgent({ apiKey: "sk_X", fetch: el.f });
    expect(first.agentAction).toBe("created");
    expect(first.tools.map((t) => [t.name, t.action])).toEqual([["get_summary", "created"], ["get_item_details", "created"]]);
    const created = el.agents[0]!.body;
    expect(created.name).toBe(AGENT_NAME);
    expect(created.platform_settings.auth.enable_auth).toBe(true);
    expect(created.conversation_config.agent.prompt.prompt).toBe(SYSTEM_PROMPT);
    expect(created.conversation_config.agent.prompt.tool_ids).toEqual(["tool_1", "tool_2"]);

    const second = await setupAgent({ apiKey: "sk_X", fetch: el.f });
    expect(second).toMatchObject({ agentId: first.agentId, agentAction: "updated" });
    expect(second.tools.every((t) => t.action === "updated")).toBe(true);
    expect(el.tools).toHaveLength(2);
    expect(el.agents).toHaveLength(1);
    expect(el.calls.every((c) => c.key === "sk_X")).toBe(true);
  });
  it("dry run writes nothing", async () => {
    const el = fakeElevenLabs();
    const r = await setupAgent({ apiKey: "sk_X", fetch: el.f, dryRun: true });
    expect(r).toMatchObject({ agentId: null, agentAction: "would-create" });
    expect(el.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("matches the agent by exact name, not by substring", async () => {
    const el = fakeElevenLabs({ agents: [{ agent_id: "agent_other", name: `${AGENT_NAME} (old copy)` }] });
    expect((await setupAgent({ apiKey: "sk_X", fetch: el.f })).agentAction).toBe("created");
  });
  it("every client tool has a serve route with the same parameters", () => {
    for (const t of CLIENT_TOOLS) expect(VOICE_TOOL_ROUTES[t.name as keyof typeof VOICE_TOOL_ROUTES].params).toEqual(Object.keys(t.parameters.properties));
  });
  it("CLI: no key is a usage error, not a crash", async () => {
    expect(await runVoice(["setup"], {})).toBe(2);
    expect(await runVoice(["nope"], { ELEVENLABS_API_KEY: "k" })).toBe(2);
  });
});

describe("serve voice contract (UI-ready)", async () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const out = mkdtempSync(join(tmpdir(), "voice-"));
  const run = await migrate({ ingest: { input: join(ROOT, "fixtures", "datadog") }, mappingsDir: join(ROOT, "mappings"), outDir: out, mode: "dry-run", version: "test" });
  writeReport(run.report, out);
  const el = fakeElevenLabs({ agents: [{ agent_id: "agent_found", name: AGENT_NAME }] });
  // No agent id given: serve looks it up by name.
  const { server, url } = await startServer({ outDir: out, port: 0, pace: 0, elevenLabsKey: "sk_SECRET", fetch: el.f });
  const bare = await startServer({ outDir: out, port: 0, pace: 0 });
  afterAll(() => (server.close(), bare.server.close()));
  const get = (p: string, origin?: string, base = url) => fetch(new URL(p, base), origin ? { headers: { Origin: origin } } : {});

  it("config describes everything a UI needs, without the key", async () => {
    const text = await (await get("/api/voice/config")).text();
    expect(text).not.toContain("sk_SECRET");
    const c = JSON.parse(text);
    expect(c).toMatchObject({ enabled: true, reason: null, agent: { id: "agent_found", name: AGENT_NAME }, connection: { type: "webrtc", tokenUrl: "/api/voice/token" } });
    expect(c.tools.map((t: any) => t.name)).toEqual(["get_summary", "get_item_details"]);
    expect(c.tools[1].route).toEqual({ method: "GET", path: "/api/voice/tools/get_item_details", params: ["query"] });
  });
  it("without a key, config says why voice is off", async () => {
    expect(await (await get("/api/voice/config", undefined, bare.url)).json()).toMatchObject({ enabled: false, reason: "ELEVENLABS_API_KEY not set" });
    expect((await get("/api/voice/token", undefined, bare.url)).status).toBe(404);
  });
  it("token uses the agent found by name; the key stays server-side", async () => {
    const body = await (await get("/api/voice/token")).text();
    expect(JSON.parse(body)).toEqual({ token: "tok-for-agent_found", agentId: "agent_found", connectionType: "webrtc" });
    expect(body).not.toContain("sk_SECRET");
  });
  it("tool routes answer from the report", async () => {
    expect(await (await get("/api/voice/tools/get_summary")).json()).toMatchObject({ dashboards: 4, monitors: 6 });
    const items = await (await get("/api/voice/tools/get_item_details?query=high%20memory")).json();
    expect(items[0]).toMatchObject({ id: "dd-monitor-redisdb__high_mem", status: "exact-under" });
  });
  it("CORS: localhost UIs may call it, other sites may not", async () => {
    expect((await get("/api/voice/config", "http://localhost:5173")).headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect((await get("/events?pace=0", "http://127.0.0.1:3000")).headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
    expect((await get("/api/voice/token", "https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(new URL("/api/voice/token", url), { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(pre.status).toBe(403);
    expect(allowedOrigin("http://localhost.evil.example")).toBeNull();
  });
});
