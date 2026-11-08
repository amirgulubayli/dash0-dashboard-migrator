import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLocalRequest, mountVoice, voiceConfigured, type RouteHandler } from "../../src/web/voice.js";
import { createNarrator } from "../../src/web/voice-narration.js";
import { createVoiceTools, type Dd2Ui, type UiState } from "../../src/web/voice-tools.js";
import { voiceClientScript } from "../../src/web/voice-client.js";

const KEY = "sk_test_SECRET_KEY_1234567890";
const AGENT = "agent_abc";

function fakeServer() {
  const routes = new Map<string, RouteHandler>();
  return { routes, route: (m: string, p: string, h: RouteHandler) => void routes.set(`${m} ${p}`, h) };
}

async function call(h: RouteHandler, headers: Record<string, string>) {
  let status = 0;
  let body = "";
  let resHeaders: Record<string, string> = {};
  const res = {
    writeHead(s: number, hd: Record<string, string>) { status = s; resHeaders = hd; },
    end(b: string) { body = b; },
  } as unknown as ServerResponse;
  await h({ headers, method: "GET", url: "/" } as unknown as IncomingMessage, res);
  return { status, body, headers: resHeaders };
}

const LOCAL = { host: "127.0.0.1:7319" };

describe("mountVoice routes", () => {
  it("registers config, token and voice.js routes", () => {
    const s = fakeServer();
    const r = mountVoice(s, { apiKey: KEY, agentId: AGENT, fetch: vi.fn(), sdkSource: () => null });
    expect(r.enabled).toBe(true);
    expect([...s.routes.keys()].sort()).toEqual(["GET /api/voice/config", "GET /api/voice/token", "GET /voice.js"]);
  });

  it("is off without both env vars", () => {
    expect(voiceConfigured({ ELEVENLABS_API_KEY: KEY })).toBe(false);
    expect(voiceConfigured({ ELEVENLABS_AGENT_ID: AGENT })).toBe(false);
    expect(voiceConfigured({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: AGENT })).toBe(true);
  });

  it("mints a token with the key server-side and never returns the key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ token: "tok_123" }), { status: 200 }));
    const s = fakeServer();
    mountVoice(s, { apiKey: KEY, agentId: AGENT, fetch: f as unknown as typeof fetch, sdkSource: () => null });
    const r = await call(s.routes.get("GET /api/voice/token")!, LOCAL);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ token: "tok_123" });
    expect(r.body).not.toContain(KEY);
    expect(r.headers["cache-control"]).toBe("no-store");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_abc");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
  });

  it.each([
    [{ host: "evil.example:7319" }],
    [{ host: "127.0.0.1:7319", origin: "https://evil.example" }],
    [{ host: "127.0.0.1:7319", origin: "null" }],
    [{ host: "127.0.0.1:7319", "sec-fetch-site": "cross-site" }],
    [{}],
  ])("refuses bad Host/Origin %j without calling ElevenLabs", async (headers) => {
    const f = vi.fn();
    const s = fakeServer();
    mountVoice(s, { apiKey: KEY, agentId: AGENT, fetch: f as unknown as typeof fetch, sdkSource: () => null });
    for (const route of ["GET /api/voice/token", "GET /api/voice/config", "GET /voice.js"]) {
      const r = await call(s.routes.get(route)!, headers as Record<string, string>);
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(KEY);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts localhost, 127.0.0.1 and [::1] with matching origins", () => {
    expect(isLocalRequest({ headers: { host: "localhost:7319", origin: "http://localhost:7319" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "[::1]:7319" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "127.0.0.1:7319", "sec-fetch-site": "same-origin" } })).toBe(true);
  });

  it("errors never include the key (upstream failure, upstream echoing the key, network error)", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => new Response(`bad key ${KEY}`, { status: 401 }),
      async () => new Response(JSON.stringify({ token: 42, detail: KEY }), { status: 200 }),
      async () => { throw new Error(`connect failed with xi-api-key=${KEY}`); },
    ];
    for (const impl of cases) {
      const s = fakeServer();
      mountVoice(s, { apiKey: KEY, agentId: AGENT, fetch: vi.fn(impl) as unknown as typeof fetch, sdkSource: () => null });
      const r = await call(s.routes.get("GET /api/voice/token")!, LOCAL);
      expect(r.status).toBe(502);
      expect(r.body).not.toContain(KEY);
      expect(JSON.parse(r.body).error).toMatch(/ElevenLabs/);
    }
  });

  it("returns 404 from the token route when not configured", async () => {
    const s = fakeServer();
    mountVoice(s, { apiKey: "", agentId: "", fetch: vi.fn(), sdkSource: () => null });
    const r = await call(s.routes.get("GET /api/voice/token")!, LOCAL);
    expect(r.status).toBe(404);
  });

  it("serves the SDK and the dock from /voice.js with no CDN reference", async () => {
    const s = fakeServer();
    mountVoice(s, { apiKey: KEY, agentId: AGENT, fetch: vi.fn(), sdkSource: () => "var ElevenLabsClient = {};" });
    const r = await call(s.routes.get("GET /voice.js")!, LOCAL);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
    expect(r.body.startsWith("var ElevenLabsClient = {};")).toBe(true);
    expect(r.body).toContain("voiceDock");
    expect(r.body).not.toMatch(/https?:\/\/(cdn|unpkg|esm\.sh)/);
    expect(r.body).not.toContain(KEY);
  });

  it("the served client script is valid JavaScript and self-contained", () => {
    const src = voiceClientScript();
    expect(() => new vm.Script(src)).not.toThrow();
    // Running it with a minimal DOM must not throw on missing outer references.
    const els: Record<string, any> = {};
    const el = (): any => ({
      dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, appendChild() {},
      querySelector: (sel: string) => (els[sel] ??= el()), set innerHTML(_v: string) {}, hidden: true, textContent: "",
    });
    const document = { readyState: "complete", head: el(), body: el(), getElementById: () => null, createElement: el };
    const window: any = { document, addEventListener() {} };
    window.window = window;
    expect(() => vm.runInNewContext(src, { window, document, setTimeout, setInterval, clearInterval })).not.toThrow();
    expect(window.__jarvisMounted).toBe(true);
  });
});

describe("narration (event -> utterance)", () => {
  it("throttles to one spoken update per 6 s and never while speaking", () => {
    const n = createNarrator({ settleMs: 0 });
    n.push({ type: "milestone", text: "Plan finished: 78 of 102 translated." }, 0);
    expect(n.tick(0, true).speak).toBeUndefined(); // speaking: hold
    expect(n.tick(100, false).speak).toBe("[EVENT] Plan finished: 78 of 102 translated.");
    n.push({ type: "milestone", text: "Review saved." }, 200);
    expect(n.tick(3000, false).speak).toBeUndefined(); // < 6 s since last
    expect(n.tick(6100, false).speak).toBe("[EVENT] Review saved.");
  });

  it("coalesces a burst: waits for quiet, drops stale 'started', keeps the milestone over the bare 'finished'", () => {
    const n = createNarrator();
    n.push({ type: "step", step: "plan", state: "running" }, 0);
    n.push({ type: "step", step: "plan", state: "done", exitCode: 0 }, 300);
    n.push({ type: "milestone", text: "Plan finished: 78 of 102 translated, 38 bounded need your review." }, 600);
    expect(n.tick(1000, false).speak).toBeUndefined(); // still settling
    expect(n.tick(2000, false).speak).toBe("[EVENT] Plan finished: 78 of 102 translated, 38 bounded need your review.");
    expect(n.pending()).toEqual([]);
  });

  it("says failures with the exit code", () => {
    const n = createNarrator({ settleMs: 0 });
    n.push({ type: "step", step: "apply", state: "failed", exitCode: 2 }, 0);
    expect(n.tick(10, false).speak).toBe("[EVENT] Apply failed with exit code 2.");
  });

  it("never speaks line events; summarises them silently at most every 5 s", () => {
    const n = createNarrator({ settleMs: 0 });
    for (let i = 0; i < 40; i++) n.push({ type: "line", step: "plan", stream: "stdout", text: `\x1b[32mline ${i}\x1b[0m` }, i);
    n.push({ type: "line", step: "plan", stream: "stderr", text: "warn: something" }, 41);
    const t = n.tick(100, false);
    expect(t.speak).toBeUndefined();
    expect(t.context).toContain("41 new lines (41 from plan)");
    expect(t.context).toContain("Last stderr: warn: something");
    expect(t.context).not.toContain("\x1b");
    n.push({ type: "line", step: "plan", stream: "stdout", text: "more" }, 200);
    expect(n.tick(2000, false).context).toBeUndefined();
    expect(n.tick(5200, false).context).toContain("1 new line ");
  });

  it("caps a coalesced update at two sentences", () => {
    const n = createNarrator({ settleMs: 0 });
    for (const t of ["One.", "Two.", "Three."]) n.push({ type: "milestone", text: t }, 0);
    expect(n.tick(10, false).speak).toBe("[EVENT] Two. Three.");
  });

  it("narration for a sample state never contains a '%' (honesty rule: counts only)", () => {
    const n = createNarrator({ settleMs: 0, minGapMs: 0 });
    const events = [
      { type: "step", step: "plan", state: "running" },
      { type: "milestone", text: "Plan finished: 102 items, 76% translated. 78 of 102 translated, 38 bounded need your review." },
      { type: "milestone", text: "Accuracy is 98.5 percent." },
      { type: "step", step: "plan", state: "done", exitCode: 0 },
      { type: "line", step: "plan", stream: "stdout", text: "coverage 76%" },
      { type: "accuracy", accuracy: { translatedPct: 76 } },
      { type: "decision", id: "w1", decision: "approved", by: "voice" },
      { type: "step", step: "apply", state: "done" },
    ];
    const spoken: string[] = [];
    events.forEach((e, i) => {
      n.push(e, i);
      const t = n.tick(i + 100, false);
      if (t.speak) spoken.push(t.speak);
    });
    expect(spoken.length).toBeGreaterThan(0);
    for (const s of spoken) {
      expect(s).not.toContain("%");
      expect(s).not.toMatch(/percent/i);
    }
    expect(spoken.join(" ")).toContain("78 of 102 translated, 38 bounded need your review.");
  });
});

function sampleState(): UiState {
  return {
    version: "0.5.0", source: "datadog", target: "dash0", dryRun: true,
    current: null,
    steps: [
      { id: "plan", state: "done", command: "dd2dash0 plan --input fixtures/datadog --out out/plan", exitCode: 0 },
      { id: "review", state: "idle" },
      { id: "apply", state: "idle" },
      { id: "watch", state: "blocked", note: "needs Dash0 + Datadog keys" },
    ],
    accuracy: {
      total: 5, byClaim: { exact: 1, "exact-under": 1, bounded: 2, manual: 1, unsupported: 0 },
      translatedPct: 80, successPct: 99, approved: 1, pending: 4, rejected: 0,
    },
    items: [
      { id: "w1", kind: "panel", title: "Requests per second", claim: "exact", datadog: ["sum:http.req{*}.as_rate()"], promql: ["sum(rate(http_req[1m]))"], reasons: [], decision: "approved" },
      { id: "w2", kind: "panel", title: "p95 latency", claim: "bounded", plain: "95th percentile latency", datadog: ["p95:lat{*}"], promql: ["histogram_quantile(0.95, ...)"], reasons: ["histogram-bucket-error"], decision: "pending" },
      { id: "w3", kind: "panel", title: "Error count", claim: "exact-under", datadog: ["sum:errors{*}.as_count()"], promql: ["sum(increase(errors[5m]))"], reasons: ["counter has no resets"], decision: "pending" },
      { id: "w4", kind: "panel", title: "Memory headroom", claim: "bounded", datadog: ["avg:mem{*}"], promql: ["avg(mem)"], reasons: ["histogram-bucket-error"], decision: "flagged" },
      { id: "a1", kind: "alert", title: "High memory alert", claim: "manual", datadog: ["avg(last_5m):avg:mem{*} > 90"], promql: [], reasons: ["anomaly-function"], decision: "pending" },
    ],
  } as UiState;
}

function fakeUi(state: UiState, allow: boolean) {
  return {
    state: () => state,
    confirm: vi.fn(async () => allow),
    run: vi.fn(async () => ({ ok: true })),
    decide: vi.fn(async () => undefined),
  } satisfies Dd2Ui;
}

describe("voice tools (read only from state; actions need a click)", () => {
  it("get_accuracy returns counts only, never percentages, and unknowns as not recorded", async () => {
    const t = createVoiceTools(fakeUi(sampleState(), true));
    const a = JSON.parse(await t.get_accuracy({}));
    expect(a.total).toBe(5);
    expect(a.translated).toBe(4);
    expect(a.not_translated).toBe(1);
    expect(a.review).toEqual({ approved: 1, pending: 4, rejected: 0 });
    expect(a.landed_in_dash0).toBe("not recorded");
    expect(a.live_returning_data).toBe("not checked");
    expect(JSON.stringify(a)).not.toMatch(/Pct|"80"|:80|:99/);
  });

  it("get_status reflects steps and says a dry run imported nothing", async () => {
    const s = sampleState();
    s.steps[2] = { id: "apply", state: "done", exitCode: 0 };
    const st = JSON.parse(await createVoiceTools(fakeUi(s, true)).get_status({}));
    expect(st.current_step).toBe("none running");
    expect(st.steps.map((x: { state: string }) => x.state)).toEqual(["done", "idle", "done", "blocked"]);
    expect(st.import_note).toBe("Apply ran as a dry run: it imported nothing.");
  });

  it("get_item finds by id and by title, phrases exact-under as 'exact if <condition>'", async () => {
    const t = createVoiceTools(fakeUi(sampleState(), true));
    const byId = JSON.parse(await t.get_item({ query: "w3" }));
    expect(byId.items[0].say_claim_as).toBe("exact if counter has no resets");
    expect(byId.items[0].promql).toEqual(["sum(increase(errors[5m]))"]);
    const byTitle = JSON.parse(await t.get_item({ query: "memory alert" }));
    expect(byTitle.items[0].id).toBe("a1");
    expect(byTitle.items[0].promql).toEqual(["No PromQL generated"]);
    expect(JSON.parse(await t.get_item({ query: "nonexistent thing" })).found).toBe(false);
  });

  it("list_attention groups non-exact pending/flagged items by reason", async () => {
    const r = JSON.parse(await createVoiceTools(fakeUi(sampleState(), true)).list_attention({}));
    expect(r.needing_review).toBe(4);
    expect(r.groups[0]).toMatchObject({ reason: "histogram-bucket-error", count: 2 });
    expect(r.by_claim).toEqual({ bounded: 2, "exact-under": 1, manual: 1 });
  });

  it("tool outputs change only when the state changes", async () => {
    const s = sampleState();
    const t = createVoiceTools(fakeUi(s, true));
    const before = await t.get_accuracy({});
    expect(await t.get_accuracy({})).toBe(before);
    s.accuracy.approved = 3;
    expect(JSON.parse(await t.get_accuracy({})).review.approved).toBe(3);
  });

  it("run_step asks for a click and does nothing when declined", async () => {
    const ui = fakeUi(sampleState(), false);
    const r = JSON.parse(await createVoiceTools(ui).run_step({ step: "apply" }));
    expect(ui.confirm).toHaveBeenCalledWith("JARVIS wants to run Apply (dry run). Allow?");
    expect(ui.run).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, declined: true });
  });

  it("run_step runs after the click and returns the outcome", async () => {
    const ui = fakeUi(sampleState(), true);
    const r = JSON.parse(await createVoiceTools(ui).run_step({ step: "plan" }));
    expect(ui.confirm).toHaveBeenCalledWith("JARVIS wants to run Plan. Allow?");
    expect(ui.run).toHaveBeenCalledWith("plan");
    expect(r.ok).toBe(true);
    expect(JSON.parse(await createVoiceTools(ui).run_step({ step: "deploy-prod" })).ok).toBe(false);
    expect(ui.run).toHaveBeenCalledTimes(1);
  });

  it("decide requires a click and passes by: 'voice'; unknown ids are refused", async () => {
    const declined = fakeUi(sampleState(), false);
    expect(JSON.parse(await createVoiceTools(declined).decide({ ids: ["w2"], decision: "approved" })).declined).toBe(true);
    expect(declined.decide).not.toHaveBeenCalled();

    const ui = fakeUi(sampleState(), true);
    const r = JSON.parse(await createVoiceTools(ui).decide({ ids: ["w2", "w4", "nope"], decision: "approved" }));
    expect(ui.confirm).toHaveBeenCalledWith("JARVIS wants to mark 2 items as approved: p95 latency, Memory headroom. Allow?");
    expect(ui.decide).toHaveBeenCalledWith(["w2", "w4"], "approved", "voice");
    expect(r).toMatchObject({ ok: true, decided: 2, unknown: ["nope"] });

    const none = fakeUi(sampleState(), true);
    expect(JSON.parse(await createVoiceTools(none).decide({ ids: ["nope"], decision: "approved" })).ok).toBe(false);
    expect(JSON.parse(await createVoiceTools(none).decide({ ids: ["w2"], decision: "delete" })).ok).toBe(false);
    expect(none.confirm).not.toHaveBeenCalled();
    expect(none.decide).not.toHaveBeenCalled();
  });
});
