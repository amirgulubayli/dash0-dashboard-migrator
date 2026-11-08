# Voice narrator (ElevenLabs) for `dd2dash0 serve`

The narrator **explains a finished, deterministic run**. It never translates anything: every number it says comes from `report.json` through its tools. That keeps the migrator inside the brief's "no LLM in translation" rule.

## 1. Create the agent (one command)
```bash
ELEVENLABS_API_KEY=<key> npx tsx src/cli.ts voice setup            # --dry-run to preview
```
This creates (or, on re-runs, updates in place) the agent **"dd2dash0 migration narrator"** and its two client tools,
from the single spec in `src/voice/agent.ts`: first message, system prompt, a low-latency LLM (`--llm`, default
`gemini-2.5-flash`), and authentication **enabled**, so a browser only ever gets a short-lived conversation token.
Nothing is clicked in the ElevenLabs dashboard; edit `agent.ts` and re-run to change the agent.

- `get_summary`: no parameters. Returns coverage, counts by status, the biggest gaps and the items not migrated.
- `get_item_details`: one string parameter `query` (an item id or part of a title). Returns the Datadog query, the PromQL, the status, why, and the manual follow-ups.

## 2. Run
```bash
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run --out out
ELEVENLABS_API_KEY=<key> npx tsx src/cli.ts serve --out out   # finds the agent by name; ELEVENLABS_AGENT_ID overrides
```
Open http://127.0.0.1:4317 and click **Start voice**. Use `localhost` or `127.0.0.1`: browsers allow the microphone only there or over HTTPS. **Replay** restarts the run. `--pace <ms>` sets the speed.

How it behaves:
- Every event goes to the agent as silent context (`sendContextualUpdate`).
- Milestones (a dashboard finished, a widget that can't be migrated, the final verdict) become `[EVENT] …` messages (`sendUserMessage`). These are throttled to one every 6 s, and none is sent while the agent is speaking.
- You can interrupt at any time and ask, e.g. "why is the high-memory alert only bounded?" or "what's the biggest gap and how do we close it?"

## 3. Building a UI on it (no UI ships with this; the built-in viewer is one client)
`dd2dash0 serve` is the backend. Any page on `localhost`/`127.0.0.1` (any port, e.g. a Vite dev server) may call it
cross-origin; other origins get no CORS headers. The key never leaves the server.

| Route | What it returns |
|---|---|
| `GET /api/voice/config` | `enabled`, `reason` (why voice is off, if it is), `agent {id,name}`, `connection {type:"webrtc", tokenUrl, sdkUrl}`, `tools[]` (name, description, JSON-schema `parameters`, `route`), `events {url}` |
| `GET /api/voice/token` | `{ token, agentId, connectionType }`, a short-lived conversation token |
| `GET /api/voice/tools/get_summary` | the `get_summary` tool result |
| `GET /api/voice/tools/get_item_details?query=` | the `get_item_details` tool result |
| `GET /events?pace=<ms>` | SSE replay of the run; each `data:` line is a run event plus a `say` sentence |
| `GET /vendor/elevenlabs.js` | the pinned `@elevenlabs/client` browser build (optional dependency) |

Minimal client (React or plain JS, using `@elevenlabs/client`):
```js
const base = "http://127.0.0.1:4317";
const cfg = await (await fetch(base + "/api/voice/config")).json();
if (!cfg.enabled) throw new Error(cfg.reason);
const { token } = await (await fetch(base + cfg.connection.tokenUrl)).json();
const clientTools = Object.fromEntries(cfg.tools.map((t) => [t.name, async (args = {}) => {
  const q = new URLSearchParams(Object.fromEntries(t.route.params.map((p) => [p, args[p] ?? ""])));
  return JSON.stringify(await (await fetch(`${base}${t.route.path}?${q}`)).json());
}]));
const conv = await Conversation.startSession({ conversationToken: token, connectionType: "webrtc", clientTools });
// Optional narration: forward run events as silent context, milestones as "[EVENT] ..." user messages.
new EventSource(base + "/events").onmessage = (m) => conv.sendContextualUpdate(JSON.parse(m.data).say ?? m.data);
```
The tool list comes from the config, so a UI never hard-codes tool names: change a tool in `agent.ts`, re-run
`voice setup`, and every client follows.
