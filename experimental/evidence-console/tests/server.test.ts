import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceServer, listenLocal } from "../server/server";
import { fixturePath } from "./helpers";

const freePort = () => new Promise<number>((res) => { const s = netServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

function get(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    r.on("error", reject);
    r.end();
  });
}

const open: { close: () => void }[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

async function boot(env: NodeJS.ProcessEnv = {}, fetcher?: any) {
  const dir = mkdtempSync(join(tmpdir(), "evsrv-"));
  const reportPath = join(dir, "report.json");
  const eventsPath = join(dir, "events.jsonl");
  copyFileSync(fixturePath("report.small.json"), reportPath);
  copyFileSync(fixturePath("events.small.jsonl"), eventsPath);
  const port = await freePort();
  const server = createEvidenceServer({ reportPath, eventsPath, port, env, fetcher, pollMs: 25 });
  await listenLocal(server, port);
  open.push({ close: () => { server.closeAllConnections(); server.close(); } });
  return { port, reportPath, eventsPath, server };
}

describe("server is read-only and local", () => {
  it("binds to 127.0.0.1", async () => {
    const { server } = await boot();
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });
  it("serves the configured report and events and nothing else", async () => {
    const { port, reportPath } = await boot();
    const r = await get(port, "/api/report");
    expect(r.status).toBe(200);
    expect(r.body).toBe(readFileSync(reportPath, "utf8"));
    const e = await get(port, "/api/replay-data");
    expect(JSON.parse(e.body).events).toHaveLength(10);
  });
  it("ignores any path-like parameter: ?path=, ?file=, traversal and encoded traversal", async () => {
    const { port, reportPath } = await boot();
    const mine = readFileSync(reportPath, "utf8");
    expect((await get(port, "/api/report?path=/etc/passwd")).body).toBe(mine);
    expect((await get(port, "/api/report?file=../../etc/passwd")).body).toBe(mine);
    for (const p of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/api/../../etc/passwd", "/api/report/../../../etc/passwd", "//etc/passwd", "/etc/passwd"]) {
      const r = await get(port, p);
      expect(r.body).not.toMatch(/root:/);
      expect([200, 404]).toContain(r.status);
    }
  });
  it("refuses every method except the documented one, so nothing can write", async () => {
    const { port, reportPath, eventsPath } = await boot();
    const before = [readFileSync(reportPath, "utf8"), readFileSync(eventsPath, "utf8")];
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect((await get(port, "/api/report", { method: m })).status).toBe(405);
    expect((await get(port, "/api/replay-data", { method: "POST" })).status).toBe(405);
    expect((await get(port, "/api/brief-ai", { method: "GET" })).status).toBe(405);
    expect([readFileSync(reportPath, "utf8"), readFileSync(eventsPath, "utf8")]).toEqual(before);
  });
  it("refuses a foreign Host header (DNS rebinding) and sends no CORS headers", async () => {
    const { port } = await boot();
    expect((await get(port, "/api/report", { host: "evil.example" })).status).toBe(403);
    const ok = await get(port, "/api/report");
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("never modifies either file when serving", async () => {
    const { port, reportPath, eventsPath } = await boot();
    const m = [statSync(reportPath).mtimeMs, statSync(eventsPath).mtimeMs];
    await get(port, "/api/report");
    await get(port, "/api/replay-data");
    expect([statSync(reportPath).mtimeMs, statSync(eventsPath).mtimeMs]).toEqual(m);
  });
});

describe("AI route", () => {
  it("says it is switched off and never calls out when AI is off", async () => {
    const f = vi.fn();
    const { port } = await boot({}, f);
    const r = await get(port, "/api/brief-ai", { method: "POST" });
    expect(JSON.parse(r.body)).toEqual({ enabled: false, message: "AI explanation is switched off." });
    expect(f).not.toHaveBeenCalled();
    expect(JSON.parse((await get(port, "/api/config")).body).aiEnabled).toBe(false);
  });
  it("when the human enabled it, returns only validated notes and never the key", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"notes":[{"id":"p3","text":"Check why no metric exists."},{"id":"ghost","text":"nope"}]}' }] }) }));
    const { port } = await boot({ ENABLE_AI_EXPLANATION: "1", ANTHROPIC_API_KEY: "test-key-not-real" }, f);
    const r = await get(port, "/api/brief-ai", { method: "POST" });
    expect(JSON.parse(r.body)).toEqual({ enabled: true, notes: [{ id: "p3", text: "Check why no metric exists." }], rejected: 1 });
    expect(r.body).not.toContain("test-key-not-real");
    expect((await get(port, "/api/config")).body).not.toContain("test-key-not-real");
  });
});

describe("events stream", () => {
  it("sends complete lines only, waits for a partial line, and signals truncation", async () => {
    const { port, eventsPath } = await boot();
    writeFileSync(eventsPath, '{"seq":0,"type":"run.start"}\n{"seq":1,"type":"dashboard.sta');
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => { chunks.push(c); });
        const step = async (fn: () => void, wait = 120) => { fn(); await new Promise((x) => setTimeout(x, wait)); };
        (async () => {
          await new Promise((x) => setTimeout(x, 120));
          const first = chunks.join("");
          expect(first).toContain('"seq":0');
          expect(first).not.toContain("dashboard.sta");
          await step(() => appendFileSync(eventsPath, 'rt","dashboard":"D"}\n'));
          expect(chunks.join("")).toContain('"type":"dashboard.start"');
          await step(() => writeFileSync(eventsPath, '{"seq":0,"type":"run.start"}\n'));
          expect(chunks.join("")).toContain("event: reset");
          r.destroy();
          resolve();
        })().catch(reject);
      });
      r.on("error", () => undefined);
      r.end();
    });
  });
});
