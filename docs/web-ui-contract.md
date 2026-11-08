# `dd2dash0 ui`: web app over the real CLI, plus the JARVIS voice companion (contract)

Status: building, Sun 2026-11-08 10:40, owner Amir (UI). Two parallel builders share this file. Change it only by
editing this file in the same PR, and say so in the PR.

## 1. What it is
`dd2dash0 ui [--input <dir>] [--out <dir>] [--port 7319]` starts a local server on 127.0.0.1 and opens the page.
The page **drives the real CLI**. Each step runs the actual command as a child process
(`node|tsx <same entry> plan ...`, `apply ... --dry-run`, and so on). Its stdout and stderr stream into an embedded
terminal panel, and the command line is shown above the output. The structured state is read from the files the CLI
writes (`<out>/plan/report.json`, `review.json`, the apply report). Nothing is translated in the browser or in the
server: the server only spawns the CLI and reads its files. **No LLM in translation**, as before.

The steps match the pitch deck's slide 4: **Plan → Review → Apply → Watch**.
| Step | Command spawned | Offline? |
|---|---|---|
| Plan | `plan --input <dir> --out <out>/plan` (or `--api` when DD keys are set) | yes, with `--input` |
| Review | no command: the decisions UI writes `<out>/review.json` in the exact format `apply --approved` reads (`src/pipeline/review.ts` parseReview; bind it to the plan hash the same way `review --terminal` does) | yes |
| Apply | `apply <out>/plan --approved <out>/review.json [--dry-run]` (`--dry-run` when there are no Dash0 keys) | dry-run yes |
| Watch | live read-back and data check (reuse `src/flow/verify.ts` through a CLI path, or show "needs Dash0 + Datadog keys") | no |

## 2. Server API (src/web/server.ts), all JSON, 127.0.0.1 only, Host/Origin checked
- `GET /` serves the app (one HTML file with inline CSS and JS, no CDN). `GET /voice.js` is served by the voice module, if it is mounted.
- `GET /api/state` returns `State`:
  ```ts
  type StepId = "plan" | "review" | "apply" | "watch";
  type StepState = "idle" | "running" | "done" | "failed" | "blocked";
  interface State {
    version: string; source: string; target: string; dryRun: boolean;
    steps: { id: StepId; state: StepState; command?: string; startedAt?: string; endedAt?: string; exitCode?: number; note?: string }[];
    current: StepId | null;
    accuracy: { total: number; byClaim: Record<"exact"|"exact-under"|"bounded"|"manual"|"unsupported", number>;
                translatedPct: number; approved: number; pending: number; rejected: number;
                landed?: number; live?: number; successPct?: number };
    items: { id: string; kind: "panel"|"alert"; title: string; dashboard?: string; claim: string; plain?: string;
             datadog: string[]; promql: string[]; reasons: string[]; decision: "approved"|"flagged"|"rejected"|"pending" }[];
  }
  ```
- `GET /api/events` is a Server-Sent Events stream. Every event is `{ type, at, ... }`:
  - `step` `{ step, state, command?, exitCode? }`
  - `line` `{ step, stream: "stdout"|"stderr", text }` (one terminal line, ANSI kept; the client renders the colours)
  - `accuracy` `{ accuracy }` (sent whenever it changes)
  - `decision` `{ id, decision, by: "ui"|"voice" }`
  - `milestone` `{ text }`: a one-sentence plain-English summary of what just happened, for the voice agent to say
- `POST /api/run/:step` starts a step and returns `{ ok, error? }`. It refuses while another step is running, and refuses Apply until a review exists.
- `POST /api/decision` takes `{ id, decision, by }` (bulk: `{ ids, decision, by }`). It rewrites review.json and emits `decision` + `accuracy`.
- The voice module is mounted as `mountVoice(server: { route(method, path, handler) ; state(): State; on(fn: (e) => void): () => void; run(step): Promise<{ok:boolean;error?:string}>; decide(ids, decision, by) })`.
  It lives in `src/web/voice.ts` and exports `mountVoice`. The server calls it **only if** `ELEVENLABS_API_KEY` and
  `ELEVENLABS_AGENT_ID` are set; otherwise the page hides the voice dock.

## 3. Look (pitch deck v5.4)
Font: Poppins (inline the 400/600/700 subsets as base64 woff2 only if under 150 KB total; otherwise use a system
geometric stack: `"Poppins", "Inter", ui-sans-serif, system-ui`). Terminal text: `ui-monospace, "JetBrains Mono", Consolas`.
| Token | Value | Use |
|---|---|---|
| `--violet` | `#6d28d9` | primary accent, current step, primary buttons, brand word |
| `--violet-2` | `#a78bfa` | accent on dark surfaces |
| `--ink` | `#13131c` | headings, dark panels (the terminal background) |
| `--body` | `#474757` | body text |
| `--muted` | `#6b6b7a` | secondary text |
| `--lav` | `#f4f1fc` | step cards, surfaces |
| `--lav-2` | `#e4dcf7` | borders, inactive steps |
| `--amber` | `#b45309` (bg `#fff7ed`) | bounded / needs review |
| `--red` | `#b4224a` | failed / unsupported |
| white | `#ffffff` | page |
Claims: exact and exact-under use violet, bounded uses amber, manual uses muted, unsupported uses red. The labels match the CLI: `✓ exact`, `✓ exact-under`, `± bounded`, `! manual`, `∅ unsupported`.
Layout: the left column is a big **step rail** (Plan → Review → Apply → Watch as the deck's cards, the running step pulsing violet).
The centre shows **accuracy** (a big success or translated %, a stacked claim bar, the review progress approved/pending/rejected) and then the
**review table** (filter by claim, approve / flag / reject per row and in bulk, with Datadog | PromQL side by side and the plain sentence).
The bottom or right is a **terminal panel** (dark `--ink`) streaming the real CLI with the command line on top. A **voice dock** sits bottom-right.

## 4. JARVIS companion (src/web/voice.ts + /voice.js)
A conversational ElevenLabs agent that **talks you through the run while it works**:
- It hears every `milestone` (and step changes) and speaks a short line: "Plan done: 102 items, 76 percent translated. 38 need your review."
- It answers questions from tools that read `/api/state`: `get_status`, `get_accuracy`, `get_item(query)`, `list_attention()`.
- With the action tools `run_step(step)` and `decide(ids, decision)`, the UI asks for one click to confirm before anything runs or changes.
  It never imports without that click.
- Its API key stays server-side. The server mints a short-lived conversation token (`GET /api/voice/token`).
- It never translates or changes a claim. Every number it says comes from the tools. (The prompt from experimental/serve/VOICE_AGENT.md, upgraded.)
