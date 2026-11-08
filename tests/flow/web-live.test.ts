// The live views on web-term's page: timeline and counts from the real flow's bytes, gaps -> levers from report.json,
// spoken lines (counts only, throttled), and the voice token route (never leaks the key, refuses a bad Origin).
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guided } from "../../src/flow/run.js";
import { page } from "../../src/flow/web-term.js";
import { gapsOf, leverOf } from "../../src/flow/web-gaps.js";
import { liveCsp, liveTags, spokenLine, webLive, type LiveState } from "../../src/flow/web-live.js";
import { Timeline, type RunReportJson } from "../../src/flow/web-timeline.js";
import { createNarrator, dockScript } from "../../src/flow/web-voice-client.js";
import { tokenMinter } from "../../src/flow/web-voice.js";
import { Ui } from "../../src/ui/style.js";

const ROOT = resolve(__dirname, "../..");
const KEY = "sk_test_0123456789abcdef0123456789abcdef";

/** The real guided flow, dry run on the fixtures, written as on a colour terminal (spinners and all). */
async function fixturesRun() {
  const work = mkdtempSync(join(tmpdir(), "dd2dash0-live-"));
  let bytes = "";
  const out = { isTTY: true, columns: 96, write: (s: string) => void (bytes += s) };
  const env = { FORCE_COLOR: "1", TERM: "xterm-256color", DD2DASH0_NO_OPEN: "1" };
  const io = { ask: async () => null, askSecret: async () => null, print: (l: string) => out.write(l + "\n"), choose: async () => 0, askBlock: async () => null };
  const code = await guided({ yes: false, dryRun: true, input: join(ROOT, "fixtures", "datadog"), out: "run", version: "test", mappingsDir: join(ROOT, "mappings"), io, ui: new Ui(out, env), env, cwd: work, home: join(work, "home"), open: () => {} });
  return { code, bytes, work };
}

describe("web live: timeline and counts from the real flow output", () => {
  it("detects all six steps, their results and the printed counts (fixtures, dry run)", async () => {
    const { code, bytes, work } = await fixturesRun();
    expect(code).toBe(0);
    const tl = new Timeline();
    // Feed it in small chunks, as the SSE stream sees it.
    for (let i = 0; i < bytes.length; i += 37) tl.feed(bytes.slice(i, i + 37));
    tl.finish(code);
    const s = tl.snapshot();
    expect(s.steps.map((x) => [x.key, x.state])).toEqual([["keys", "done"], ["translate", "done"], ["review", "done"], ["import", "done"], ["verify", "skipped"], ["report", "done"]]);
    expect(s.steps[1]!.summary).toMatch(/4 dashboards · 6 monitors → 102 items/);
    expect(s.steps[1]!.time).toMatch(/^\d+\.\ds$/);
    expect(s.counts.items).toBe(102);
    expect(s.counts.byLabel).toEqual({ exact: 0, "exact-under": 40, bounded: 38, manual: 18, unsupported: 6 });
    expect(s.counts.translated).toEqual({ count: 78, total: 102 });
    expect(s.counts.landed).toBeNull(); // dry run: "not measured"
    // Same numbers from report.json once it exists.
    const rep = JSON.parse(readFileSync(join(work, "run", "report.json"), "utf8")) as RunReportJson;
    tl.useReport(rep);
    expect(tl.counts).toMatchObject({ items: 102, translated: { count: 78, total: 102 }, landed: null, live: null, source: "report.json" });
  }, 60_000);

  it("marks a failed step", () => {
    const tl = new Timeline();
    tl.feed("\x1b[38;5;111m●\x1b[39m \x1b[1mKeys\x1b[22m\n\x1b[38;5;203m●\x1b[39m \x1b[1mTranslate\x1b[22m  \x1b[38;5;203mcould not read or translate the source\x1b[39m  \x1b[2m0.1s\x1b[22m\n");
    tl.finish(2);
    expect(tl.snapshot().steps[1]).toMatchObject({ state: "failed", time: "0.1s" });
  });
});

describe("web live: gaps -> levers", () => {
  it("groups the items below EXACT IF by reason code, with lever and owner", () => {
    const rep: RunReportJson = {
      items: [
        { id: "a", kind: "panel", title: "A", status: "exact" },
        { id: "b", kind: "panel", title: "B", status: "bounded", reasons: ["tag.unmapped", "metric.approximate"] },
        { id: "c", kind: "panel", title: "C", status: "bounded", reasons: ["tag.unmapped"] },
        { id: "d", kind: "alert", title: "D", status: "manual", reasons: ["fn.anomalies"] },
        { id: "e", kind: "panel", title: "E", status: "unsupported", reasons: ["widget.unsupported"] },
        { id: "f", kind: "panel", title: "F", status: "exact-under", reason_codes: ["scope.var.free-form"] },
        { id: "g", kind: "group", title: "G", status: "manual", reasons: ["x"] },
      ],
    };
    const g = gapsOf(rep);
    expect(g.total).toBe(6);
    expect(g.notExact).toBe(4);
    expect(g.groups[0]).toMatchObject({ code: "tag.unmapped", count: 2, byLabel: { bounded: 2 }, lever: "mapping row", owner: "mappings" });
    expect(g.groups.find((x) => x.code === "fn.anomalies")).toMatchObject({ lever: "impossible" });
    expect(g.groups.find((x) => x.code === "widget.unsupported")).toMatchObject({ lever: "Dash0 panel type missing" });
    expect(g.groups.find((x) => x.code === "metric.approximate")).toMatchObject({ lever: "probe" });
    expect(g.groups.find((x) => x.code === "scope.var.free-form")).toBeUndefined(); // exact-under is not a gap
    expect(g.levers.find((l) => l.lever === "mapping row")).toEqual({ lever: "mapping row", groups: 1, items: 2 });
  });

  it("the reason -> lever table: longest match wins, unknown codes default to a new rule", () => {
    expect(leverOf("metric.unmapped")).toEqual({ lever: "mapping row", owner: "mappings" });
    expect(leverOf("metric.derived")).toEqual({ lever: "new rule", owner: "translate" });
    expect(leverOf("widget.query_table.columns").lever).toBe("Dash0 panel type missing");
    expect(leverOf("something.new")).toEqual({ lever: "new rule", owner: "translate" });
  });
});

describe("web live: narration", () => {
  it("speaks at most every 6 s, never while speaking, coalesces bursts, and never says a percentage", () => {
    const n = createNarrator();
    n.push("Keys done.", 0);
    n.push("Translate started.", 100);
    n.push("Translate done: 78 of 102 translated. That is 76% overall.", 200);
    expect(n.tick(500, false)).toBeUndefined(); // the burst has not settled
    expect(n.tick(2000, true)).toBeUndefined(); // the agent is speaking
    const first = n.tick(2000, false)!;
    expect(first).toBe("[EVENT] Keys done. Translate done: 78 of 102 translated.");
    expect(first).not.toMatch(/%|percent/i);
    n.push("Import done.", 2500);
    expect(n.tick(4000, false)).toBeUndefined(); // < 6 s since the last line
    expect(n.tick(8100, false)).toBe("[EVENT] Import done.");
  });

  it("spoken lines are counts only and say exact-under as 'exact if'", () => {
    const c = { dashboards: 4, monitors: 6, items: 102, byLabel: { exact: 0, "exact-under": 40, bounded: 38, manual: 18, unsupported: 6 }, translated: { count: 78, total: 102 }, source: "printed" as const };
    const t = spokenLine("Translate done: 4 dashboards, 6 monitors to 102 items (76%).", "translate", c);
    expect(t).not.toMatch(/%/);
    expect(t).toMatch(/40 exact if their conditions hold/);
    expect(spokenLine("Report done.", "report", c)).toBe("Report written: 78 of 102 translated.");
  });

  it("the dock script compiles", () => {
    expect(() => new Function(dockScript("/tok"))).not.toThrow();
  });
});

describe("web live: voice token route", () => {
  const listen = async (env: NodeJS.ProcessEnv, f: typeof fetch) => {
    let origin = "";
    const live = webLive({ token: "tok", origin: () => origin, send: () => {}, env, fetch: f, argv: [] });
    const server = createServer((req, res) => void live.handle(req, res, (req.url ?? "").split("?")[0]!).then((h) => h || (res.writeHead(404), res.end())));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, close: () => server.close() };
  };

  it("mints a token without ever returning the key, finds the agent by name, refuses a bad Origin", async () => {
    const calls: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      calls.push(String(u));
      expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
      if (String(u).includes("/agents?")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent_x", name: "dd2dash0 migration narrator" }] }));
      return new Response(JSON.stringify({ token: "conv_tok_1" }));
    }) as typeof fetch;
    const s = await listen({ ELEVENLABS_API_KEY: KEY }, fake);
    const ok = await fetch(`${s.origin}/tok/x/voice/token`, { method: "POST", headers: { Origin: s.origin, "Content-Type": "application/json" }, body: "{}" });
    const body = await ok.text();
    expect(ok.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ token: "conv_tok_1" });
    expect(body).not.toContain(KEY);
    expect(calls[1]).toContain("agent_id=agent_x");
    const bad = await fetch(`${s.origin}/tok/x/voice/token`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(403);
    expect(await bad.text()).not.toContain(KEY);
    s.close();
  });

  it("an upstream error or a network failure never echoes the key", async () => {
    const err = tokenMinter({ env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: "a" }, fetch: (async () => new Response(`bad key ${KEY}`, { status: 401 })) as typeof fetch });
    expect(JSON.stringify(await err())).not.toContain(KEY);
    const net = tokenMinter({ env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: "a" }, fetch: (async () => { throw new Error(`connect failed ${KEY}`); }) as typeof fetch });
    const r = await net();
    expect(r.status).toBe(502);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("without a key the voice is absent: no dock, no SDK, no token route, CSP unchanged but for the report frame", async () => {
    expect(liveTags("tok", "n", {})).toBe("");
    const prev = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      expect(page({ version: "t", cwd: "~" }, "n0nce", "tok")).not.toMatch(/id="vdock"|voice\/sdk\.js/);
    } finally {
      if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
    }
    expect(liveCsp("default-src 'none'; script-src 'nonce-x'; connect-src 'self'; frame-ancestors 'none'", {})).toBe("default-src 'none'; script-src 'nonce-x'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'");
    const s = await listen({}, (async () => { throw new Error("no network in tests"); }) as typeof fetch);
    const r = await fetch(`${s.origin}/tok/x/voice/token`, { method: "POST", headers: { Origin: s.origin, "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(404);
    s.close();
  });

  it("client tools answer from run state only, with Not recorded / Not measured", () => {
    const live = webLive({ token: "tok", origin: () => "", send: () => {}, env: {}, argv: [] });
    const c = JSON.parse(live.tool("get_counts", "")!) as Record<string, unknown>;
    expect(c).toMatchObject({ items_found: "Not recorded", landed: "Not recorded", live: "Not recorded" });
    expect(JSON.stringify(c)).not.toMatch(/\d+%/);
    expect(JSON.parse(live.tool("list_gaps", "")!)).toMatchObject({ message: expect.stringMatching(/Not recorded/) });
    expect(live.tool("rerun", "")).toBeNull();
    const st: LiveState = live.state();
    expect(st.tl.steps).toHaveLength(6);
  });
});
