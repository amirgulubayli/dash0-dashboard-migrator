import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aiConfigFromEnv } from "./ai";
import { createEvidenceServer, listenLocal } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const reportPath = resolve(flag("report", resolve(root, "demo-data/report.json")));
const eventsPath = resolve(flag("events", resolve(root, "demo-data/events.jsonl")));
const port = Number(flag("port", "4173"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port must be 1-65535");
  process.exit(3);
}
for (const [what, p] of [["report", reportPath], ["events", eventsPath]] as const) {
  if (!existsSync(p)) console.warn(`warning: ${what} file not found yet: ${p}`);
}
const server = createEvidenceServer({ reportPath, eventsPath, port, distDir: resolve(root, "dist") });
await listenLocal(server, port);
const ai = aiConfigFromEnv(process.env);
console.log(`Evidence console on http://127.0.0.1:${port}  (read-only)`);
console.log(`  report: ${reportPath}\n  events: ${eventsPath}`);
console.log(ai.enabled ? (ai.keyPresent ? "  AI explanation: ON (you enabled it in your shell)" : "  AI explanation: requested but no key in your shell, so it stays OFF") : "  AI explanation: off");
