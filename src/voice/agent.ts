// ElevenLabs narrator agent for `dd2dash0 serve`: one spec, created or updated by `dd2dash0 voice setup`.
// The agent only explains a finished deterministic run. Every number it says comes from report.json through its two
// client tools, which any UI answers by calling the serve endpoints in VOICE_TOOL_ROUTES. No AI in translation.
// The API key is only ever used server-side (here and in serve); nothing in this file sends it anywhere else.

export const AGENT_NAME = "dd2dash0 migration narrator";
export const AGENT_TAG = "dd2dash0";

export const FIRST_MESSAGE =
  "I'm your migration narrator. I'll talk you through the Datadog to Dash0 run; interrupt me any time.";

export const SYSTEM_PROMPT = `You narrate a live migration of Datadog dashboards and monitors into Dash0, done by a deterministic compiler
(parsers, rule tables and mapping tables, no AI in the translation). You are the explainer, not the translator.

Messages that start with [EVENT] come from the system, not the user: say one short sentence (max 20 words)
about it, in plain English, then stop. Contextual updates are background; do not read them out.

When the user asks a question, call get_summary or get_item_details first and answer only from what they
return. Never invent numbers or claim more accuracy than the report shows. Statuses: exact = same numbers as
Datadog for any data; exact-under = same numbers while the listed assumptions hold; bounded = within a stated
error bound; manual = not translated, original kept; unsupported = Dash0 has no equivalent widget.
When asked how to close a gap, say what the finding code means and the realistic options (add a mapping-table
row, write and test a new translation rule, or rebuild by hand), and say which ones need a person.
Keep answers under 4 sentences unless asked for detail.`;

export interface ClientToolSpec {
  type: "client";
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, { type: "string"; description: string }>; required: string[] };
  expects_response: true;
  response_timeout_secs: number;
}

/** The two client tools. Names and parameter names are the contract between the agent and every UI. */
export const CLIENT_TOOLS: ClientToolSpec[] = [
  {
    type: "client",
    name: "get_summary",
    description: "Coverage, counts by status, the biggest gaps and the items not migrated, for the current run.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 20,
  },
  {
    type: "client",
    name: "get_item_details",
    description: "One panel or monitor: its Datadog query, the PromQL, the status, why, and the manual follow-ups.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "An item id, or part of a panel or monitor title." } },
      required: ["query"],
    },
    expects_response: true,
    response_timeout_secs: 20,
  },
];

/** Where a UI answers each client tool (relative to the serve origin). */
export const VOICE_TOOL_ROUTES = {
  get_summary: { method: "GET", path: "/api/voice/tools/get_summary", params: [] as string[] },
  get_item_details: { method: "GET", path: "/api/voice/tools/get_item_details", params: ["query"] },
} as const;

export function conversationConfig(llm: string) {
  return {
    agent: {
      language: "en",
      first_message: FIRST_MESSAGE,
      prompt: { prompt: SYSTEM_PROMPT, llm, temperature: 0.3 },
    },
  };
}

const API = "https://api.elevenlabs.io";

export interface SetupOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Update this agent instead of looking one up by name. */
  agentId?: string;
  name?: string;
  llm?: string;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface SetupResult {
  agentId: string | null;
  agentAction: "created" | "updated" | "would-create" | "would-update";
  tools: { name: string; id: string | null; action: "created" | "updated" | "would-create" | "would-update" }[];
}

class ElevenLabsError extends Error {}

function client(o: SetupOptions) {
  const f = o.fetch ?? fetch;
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await f(API + path, {
      method,
      headers: { "xi-api-key": o.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      // Error bodies from ElevenLabs describe the request, never the key; still cap their length.
      const text = (await r.text().catch(() => "")).slice(0, 400);
      throw new ElevenLabsError(`ElevenLabs ${method} ${path.split("?")[0]} failed: ${r.status} ${text}`);
    }
    return (r.status === 204 ? undefined : await r.json()) as T;
  };
}

type ToolRow = { id: string; tool_config?: { name?: string; type?: string } };
type AgentRow = { agent_id: string; name?: string };

/** Find the agent by exact name. Returns null when none exists. */
export async function findAgentByName(o: SetupOptions, name = o.name ?? AGENT_NAME): Promise<string | null> {
  const call = client(o);
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ search: name, page_size: "100", ...(cursor ? { cursor } : {}) });
    const r = await call<{ agents?: AgentRow[]; has_more?: boolean; next_cursor?: string }>("GET", `/v1/convai/agents?${q}`);
    const hit = (r.agents ?? []).find((a) => a.name === name);
    if (hit) return hit.agent_id;
    if (!r.has_more || !r.next_cursor) return null;
    cursor = r.next_cursor;
  }
  return null;
}

/** Create or update the two client tools and the narrator agent. Safe to re-run: matches by name, never duplicates. */
export async function setupAgent(o: SetupOptions): Promise<SetupResult> {
  const call = client(o);
  const log = o.log ?? (() => {});
  const name = o.name ?? AGENT_NAME;
  const llm = o.llm ?? "gemini-2.5-flash";

  const existing = (await call<{ tools?: ToolRow[] }>("GET", "/v1/convai/tools")).tools ?? [];
  const tools: SetupResult["tools"] = [];
  for (const spec of CLIENT_TOOLS) {
    const found = existing.find((t) => t.tool_config?.name === spec.name && t.tool_config?.type === "client");
    if (o.dryRun) {
      tools.push({ name: spec.name, id: found?.id ?? null, action: found ? "would-update" : "would-create" });
    } else if (found) {
      await call("PATCH", `/v1/convai/tools/${encodeURIComponent(found.id)}`, { tool_config: spec });
      tools.push({ name: spec.name, id: found.id, action: "updated" });
    } else {
      const r = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: spec });
      tools.push({ name: spec.name, id: r.id, action: "created" });
    }
    log(`tool ${spec.name}: ${tools.at(-1)!.action}${tools.at(-1)!.id ? ` (${tools.at(-1)!.id})` : ""}`);
  }

  const agentId = o.agentId ?? (await findAgentByName(o, name));
  const cfg = conversationConfig(llm);
  const toolIds = tools.map((t) => t.id).filter((x): x is string => !!x);
  const body = {
    name,
    tags: [AGENT_TAG],
    conversation_config: { ...cfg, agent: { ...cfg.agent, prompt: { ...cfg.agent.prompt, tool_ids: toolIds } } },
    // Keep authentication on: serve mints short-lived conversation tokens, so the key never reaches a browser.
    platform_settings: { auth: { enable_auth: true } },
  };
  let agentAction: SetupResult["agentAction"];
  let id = agentId;
  if (o.dryRun) agentAction = agentId ? "would-update" : "would-create";
  else if (agentId) {
    await call("PATCH", `/v1/convai/agents/${encodeURIComponent(agentId)}`, body);
    agentAction = "updated";
  } else {
    id = (await call<{ agent_id: string }>("POST", "/v1/convai/agents/create", body)).agent_id;
    agentAction = "created";
  }
  log(`agent "${name}": ${agentAction}${id ? ` (${id})` : ""}`);
  return { agentId: id, agentAction, tools };
}
