// Read-only data server. Binds 127.0.0.1 only. Serves exactly two data files (set by flags) plus the built UI from memory.
// No path parameters, no CORS headers, no writes. The only outbound call is the optional AI request (off by default).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { aiConfigFromEnv, explainWithAi, type Fetcher } from "./ai";
import { FilePoller } from "./tail";

export interface ServerOptions {
  reportPath: string;
  eventsPath: string;
  port: number;
  distDir?: string | null;
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  pollMs?: number;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json" };

/** Loads the built UI into memory once, so no request ever maps to a path on disk. */
export function loadStatic(distDir: string | null | undefined): Map<string, { type: string; body: Buffer }> {
  const files = new Map<string, { type: string; body: Buffer }>();
  if (!distDir) return files;
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else files.set(`/${prefix}${name}`, { type: TYPES[extname(name)] ?? "application/octet-stream", body: readFileSync(full) });
    }
  };
  try {
    walk(distDir, "");
  } catch {
    /* no build yet: API still works */
  }
  return files;
}

function hostOk(req: IncomingMessage, port: number): boolean {
  const h = (req.headers.host ?? "").toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
  res.end(body);
}

function readLines(path: string): { events: unknown[]; malformed: number } {
  const poller = new FilePoller(path);
  const r = poller.poll();
  return { events: r.events, malformed: poller.malformed };
}

export function createEvidenceServer(opts: ServerOptions): Server {
  const env = opts.env ?? process.env;
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>);
  const statics = loadStatic(opts.distDir);
  const ai = aiConfigFromEnv(env);
  const server = createServer((req, res) => {
    // Any query string is ignored on purpose: nothing a client sends selects a file.
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!hostOk(req, opts.port)) return send(res, 403, "text/plain", "forbidden host");

    if (path === "/api/config") {
      if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
      return send(res, 200, "application/json", JSON.stringify({ aiEnabled: ai.enabled && ai.keyPresent, aiRequestedButNoKey: ai.enabled && !ai.keyPresent }));
    }
    if (path === "/api/report") {
      if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
      try {
        return send(res, 200, "application/json", readFileSync(opts.reportPath));
      } catch {
        return send(res, 404, "application/json", JSON.stringify({ error: "report file not found" }));
      }
    }
    if (path === "/api/replay-data") {
      if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
      return send(res, 200, "application/json", JSON.stringify(readLines(opts.eventsPath)));
    }
    if (path === "/api/events") {
      if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
      const poller = new FilePoller(opts.eventsPath); // a new poller per connection: a reconnect gets the whole backlog again; the client drops duplicates by seq
      const tick = () => {
        const r = poller.poll();
        if (r.truncated) res.write("event: reset\ndata: {}\n\n");
        for (const e of r.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      tick();
      const timer = setInterval(tick, opts.pollMs ?? 400);
      const beat = setInterval(() => res.write(": keepalive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(timer);
        clearInterval(beat);
      });
      return;
    }
    if (path === "/api/brief-ai") {
      if (req.method !== "POST") return send(res, 405, "text/plain", "method not allowed");
      if (!ai.enabled || !ai.keyPresent) return send(res, 200, "application/json", JSON.stringify({ enabled: false, message: "AI explanation is switched off." }));
      // The request body is never read: the server builds the payload from the report file itself.
      let report: unknown;
      try {
        report = JSON.parse(readFileSync(opts.reportPath, "utf8"));
      } catch {
        return send(res, 404, "application/json", JSON.stringify({ error: "report file not found" }));
      }
      explainWithAi(report, env, fetcher).then(
        (r) => send(res, 200, "application/json", JSON.stringify(r)),
        () => send(res, 502, "application/json", JSON.stringify({ enabled: true, error: "AI explanation unavailable" })),
      );
      return;
    }
    if (path.startsWith("/api/")) return send(res, 404, "text/plain", "not found");
    if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
    const hit = statics.get(path === "/" ? "/index.html" : path) ?? (path.includes(".") ? undefined : statics.get("/index.html"));
    if (!hit) return send(res, 404, "text/plain", "not found");
    return send(res, 200, hit.type, hit.body);
  });
  return server;
}

export function listenLocal(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}
