# Voice narrator on the `--web` page (ElevenLabs)

The narrator talks you through a `dd2dash0 --web` run. It **never translates and never changes a claim**: every
number it says comes from its tools, which read the run state (the flow's printed steps and the `report.json` files
the run writes). Counts only, never percentages.

## Run
```powershell
. C:\RAG\code\ATHONGS\MUNICH\voice-env.ps1      # sets ELEVENLABS_API_KEY for this shell only
npx tsx src/cli.ts --web --input fixtures/datadog --dry-run
```
- Without `ELEVENLABS_API_KEY` the dock is absent (no SDK, no extra CSP).
- The agent is `ELEVENLABS_AGENT_ID`, or the agent named **`dd2dash0 migration narrator`** (found via the agents API).
- The key stays in the dd2dash0 process. The page asks `POST /<secret>/x/voice/token` (Host and Origin checked) for a
  short-lived conversation token. The key never reaches the browser, a log or git.
- The SDK is `@elevenlabs/client` 1.30.0 (optional dependency), served from `node_modules` (`dist/lib.iife.js`, its
  self-contained browser build). No CDN. In the one-file binary, where it isn't embedded, the voice is absent.
- Optional `DD2DASH0_WEB_PORT` pins the page's port (launch configs). The default is a random port, as before.

## Agent config to paste into the ElevenLabs dashboard (Amir)
**First message:** `I'm your migration narrator. I'll talk you through the Datadog to Dash0 run; interrupt me any time.`

**System prompt:**
```
You narrate a live migration of Datadog dashboards and monitors into Dash0, done by a deterministic compiler
(parsers, rule tables and mapping tables, no AI in the translation). You are the explainer, not the translator.

Messages that start with [EVENT] come from the page, not the user: say them in one short sentence (max 20 words),
then stop. Contextual updates are background; do not read them out.

When the user asks something, call a tool first and answer only from what it returns:
get_status (steps), get_counts (numbers), get_item (one item), list_attention (items needing a person),
list_gaps (reasons grouped, with the lever that would close each).
Rules:
- Counts only. Never say a percentage, a share, an accuracy or a confidence. Say "78 of 102 translated".
- "exact-under" is said as "exact if" followed by its condition (get_item returns it). Never just "exact".
- If a tool says "Not recorded", "Not measured" or "Not checked", say exactly that. Never guess a number.
- Labels: exact = same result as Datadog for any data; exact if = same result while the stated condition holds;
  bounded = within a proven error bound, needs a human check; manual = not translated, original kept;
  unsupported = Dash0 has no equivalent, placeholder keeps the original.
- Levers (list_gaps): mapping row, new rule, probe, Dash0 panel type missing, impossible. Say which need a person.
- You cannot run, import or change anything. open_report only shows a button; the user has to click it.
Keep answers under 4 sentences unless asked for detail.
```

**Client tools** (Tools, Add tool, Client; "Wait for response" ON; names are case-sensitive):
| name | parameters | returns |
|---|---|---|
| `get_status` | none | steps (state, one-line result, duration), current step, exit code, dry run |
| `get_counts` | none | items found, per label (exact / exact-under / bounded / manual / unsupported), translated, landed, live ("Not measured" / "Not checked" when the run didn't measure) |
| `get_item` | `query` (string): item id or part of a title | claim (EXACT IF + condition), reasons, Datadog query, PromQL, landed, live |
| `list_attention` | none | bounded / manual / unsupported items, counted, with examples |
| `list_gaps` | none | not-exact items grouped by reason code, with lever and owner |
| `open_report` | none | shows an "Open the report" button in the page; nothing opens without a click |

The page also answers the agent's current tool names, `get_summary` (same as `get_counts`) and `get_item_details`
(same as `get_item`), so the live agent works before it is updated.

Current live agent (read 2026-11-08, not changed): client tools `get_summary`, `get_item_details`; auth enabled.

## Narration
Step changes and milestones become `[EVENT]` lines: counts only (a sentence with `%` is dropped), at least 6 s apart,
never while the agent speaks, bursts coalesced (`src/flow/web-voice-client.ts`, tested in `tests/flow/web-live.test.ts`).
