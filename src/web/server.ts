// `dd2dash0 ui`: the local web app over the real CLI (docs/web-ui-contract.md). node:http only, 127.0.0.1 only,
// Host checked on every request and Origin on every POST (no DNS rebinding, no cross-site requests). One run at a
// time; Server-Sent Events with a heartbeat. The server never translates: see app.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { STEPS, UiApp, type AppOptions, type By, type StepId, type UiDecision, type UiEvent, type State } from "./app.js";
import { pageHtml } from "./page.js";

export type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;

/** What the voice module (src/web/voice.ts, mountVoice) gets. */
export interface VoiceHost {
  route(method: string, path: string, handler: Handler): void;
  state(): State;
  on(fn: (e: UiEvent) => void): () => void;
  run(step: StepId): Promise<{ ok: boolean; error?: string }>;
  decide(ids: string[], decision: UiDecision, by: By): { ok: boolean; error?: string };
}

export interface UiServer {
  app: UiApp;
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1 << 20;

export function allowedHost(host: string | undefined, port: number): boolean {
  return !!host && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}
export function allowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export async function createUiServer(opts: AppOptions & { port?: number; voice?: boolean }): Promise<UiServer> {
  const app = new UiApp(opts);
  const routes = new Map<string, Handler>();
  const clients = new Set<ServerResponse>();
  let port = opts.port ?? 7319;

  const log: UiEvent[] = [];
  app.on((e) => {
    if (e.type === "line" || e.type === "milestone") {
      log.push(e);
      if (log.length > 3000) log.splice(0, log.length - 3000);
    }
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(frame);
  });
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, port)) return json(res, 403, { ok: false, error: "host not allowed" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const method = req.method ?? "GET";
      if (method === "POST" && !allowedOrigin(req.headers.origin, port)) return json(res, 403, { ok: false, error: "origin not allowed" });

      const custom = routes.get(`${method} ${url.pathname}`);
      if (custom) {
        const body = method === "POST" ? await readBody(req) : undefined;
        return await custom(req, res, body);
      }
      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.elevenlabs.io wss://*.elevenlabs.io; media-src 'self' blob: data:",
        });
        return res.end(pageHtml());
      }
      if (method === "GET" && url.pathname === "/api/state") return json(res, 200, app.state());
      if (method === "GET" && url.pathname === "/api/log") return json(res, 200, { lines: log.filter((e) => e.type === "line") });
      if (method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(`: connected\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const run = /^\/api\/run\/([a-z]+)$/.exec(url.pathname);
      if (method === "POST" && run) {
        await readBody(req);
        const step = run[1] as StepId;
        if (!STEPS.includes(step)) return json(res, 404, { ok: false, error: `unknown step ${step}` });
        const r = app.run(step);
        return json(res, r.ok ? 200 : 409, r);
      }
      if (method === "POST" && url.pathname === "/api/decision") {
        const b = (await readBody(req)) as { id?: string; ids?: string[]; decision?: UiDecision; by?: By };
        const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string") : typeof b.id === "string" ? [b.id] : [];
        if (!ids.length || !b.decision) return json(res, 400, { ok: false, error: "expected { id | ids, decision, by }" });
        const r = app.decide(ids, b.decision, b.by === "voice" ? "voice" : "ui");
        return json(res, r.ok ? 200 : 409, r);
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { ok: false, error: (e as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      ok();
    });
  });
  port = (server.address() as { port: number }).port;

  if (opts.voice !== false) app.voice = await mountVoiceIfConfigured(app, routes);

  return {
    app,
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      clearInterval(heartbeat);
      app.stop();
      for (const c of clients) c.end();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/** Mount src/web/voice.ts (built by the voice workstream) only when it exists and the ElevenLabs keys are set. */
async function mountVoiceIfConfigured(app: UiApp, routes: Map<string, Handler>): Promise<boolean> {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID) return false;
  const file = ["voice.js", "voice.ts"].map((f) => join(import.meta.dirname, f)).find((f) => existsSync(f));
  if (!file) return false;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { mountVoice?: (host: VoiceHost) => unknown };
    if (typeof mod.mountVoice !== "function") return false;
    const host: VoiceHost = {
      route: (method, path, handler) => void routes.set(`${method.toUpperCase()} ${path}`, handler),
      state: () => app.state(),
      on: (fn) => app.on(fn),
      run: async (step) => app.run(step),
      decide: (ids, decision, by) => app.decide(ids, decision, by),
    };
    await mod.mountVoice(host);
    return true;
  } catch (e) {
    console.error(`dd2dash0 ui: voice not mounted (${(e as Error).message})`);
    return false;
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser: the URL is printed */
  }
}

export const UI_USAGE = `usage: dd2dash0 ui [--input <dir>] [--out <dir>] [--port 7319] [--dry-run] [--no-open]

  Opens a local web page that runs this CLI step by step (Plan -> Review -> Apply -> Watch) and shows
  its output live. Without --input and without Datadog keys it offers the bundled demo data.`;

/** `dd2dash0 ui`: parse its flags, start the server, keep running until Ctrl+C. */
export async function startUi(args: string[], version: string): Promise<number> {
  let input: string | undefined;
  let out = "dd2dash0-run/ui";
  let port = 7319;
  let open = true;
  let forceDryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--input") input = val();
      else if (a === "--out") out = val();
      else if (a === "--port") port = Number(val());
      else if (a === "--no-open") open = false;
      else if (a === "--dry-run") forceDryRun = true;
      else if (a === "--help" || a === "-h") {
        console.log(UI_USAGE);
        return 0;
      } else throw new Error(`unknown option ${a}`);
    } catch (e) {
      console.error(`${(e as Error).message}\n\n${UI_USAGE}`);
      return 3;
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a port number\n\n${UI_USAGE}`);
    return 3;
  }
  let inputLabel: string | undefined;
  if (!input && !(process.env.DD_API_KEY && process.env.DD_APP_KEY)) {
    const demo = resolve(import.meta.dirname, "..", "..", "fixtures", "datadog");
    if (existsSync(demo)) {
      input = demo;
      inputLabel = "demo data (fixtures/datadog)";
    }
  }
  let ui: UiServer;
  try {
    ui = await createUiServer({ version, out, ...(input ? { input } : {}), ...(inputLabel ? { inputLabel } : {}), forceDryRun, port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === "EADDRINUSE" ? `dd2dash0 ui: port ${port} is in use (try --port <n>)` : `dd2dash0 ui: ${err.message}`);
    return 1;
  }
  const s = ui.app.state();
  console.log(`dd2dash0 ui ${version}: ${ui.url}`);
  console.log(`  source  ${s.source}`);
  console.log(`  target  ${s.target}`);
  console.log(`  run dir ${s.out}${ui.app.voice ? "\n  voice   on (ElevenLabs)" : ""}`);
  console.log(`  Ctrl+C to stop`);
  if (open) openBrowser(ui.url);
  await new Promise<void>((done) => {
    const stop = () => {
      void ui.close().then(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
