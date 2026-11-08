// Optional AI explanation. OFF unless the human starts the server with ENABLE_AI_EXPLANATION=1 and a key in their own shell.
// The key is read from process.env only, never logged, never sent to the browser. No SDK: one fetch to the Messages API.
import { buildBrief } from "../src/lib/brief";
import { buildReportView } from "../src/lib/model";

export interface AiConfig {
  enabled: boolean;
  keyPresent: boolean;
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv): AiConfig {
  const enabled = env.ENABLE_AI_EXPLANATION === "1";
  return { enabled, keyPresent: enabled && typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0 };
}

export interface AiItem {
  id: string;
  label: string | null;
  reason: string[];
  condition: string | null;
}

/** Only id, label, reason and condition per item leave this process. No queries, no names, no run metadata. */
export function aiPayloadFromReport(report: unknown): AiItem[] {
  const view = buildReportView(report);
  if (!view.ok) return [];
  const brief = buildBrief(view);
  const out: AiItem[] = [];
  const add = (id: string, label: string | null, reason: string[], condition: string | null) => out.push({ id, label, reason, condition });
  for (const e of [...brief.manualOrUnsupported, ...brief.bounded]) add(e.id, e.label, e.reasonCodes, e.condition);
  for (const g of brief.conditions) for (const id of g.ids) add(id, "exact-under", [], g.condition);
  return out;
}

export interface AiNote {
  id: string;
  text: string;
}

export interface AiResult {
  notes: AiNote[];
  rejected: number; // notes dropped: unknown id, banned wording, or wrong shape
}

// The model may not declare anything safe/verified, and may not claim results the report does not record.
const BANNED = /\b(verified|fired|safe|safely|guaranteed|matches datadog|identical to datadog|correct)\b/i;

/** Validates the model's reply against the report's own ids. Pure; never touches the report. */
export function validateAiReply(reply: unknown, validIds: ReadonlySet<string>): AiResult {
  let rejected = 0;
  const notes: AiNote[] = [];
  const seen = new Set<string>();
  const list = typeof reply === "object" && reply !== null && Array.isArray((reply as { notes?: unknown }).notes) ? (reply as { notes: unknown[] }).notes : null;
  if (!list) return { notes, rejected: 1 };
  for (const n of list) {
    const o = n as { id?: unknown; text?: unknown };
    if (typeof o?.id !== "string" || typeof o?.text !== "string" || !validIds.has(o.id) || seen.has(o.id) || BANNED.test(o.text) || /promql|```/i.test(o.text) || o.text.length > 600) {
      rejected += 1;
      continue;
    }
    seen.add(o.id);
    notes.push({ id: o.id, text: o.text.replace(/[\u0000-\u001f]/g, " ").trim() });
  }
  return { notes, rejected };
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const SYSTEM = [
  "You help a reviewer read a migration report. You get a list of items: id, label, reason codes, condition.",
  "Reply with JSON only: {\"notes\":[{\"id\":\"<an id from the list>\",\"text\":\"<one plain sentence, max 40 words>\"}]}.",
  "Explain what the reviewer should look at for that item, using only the reason codes and condition given.",
  "Do not say anything is safe, correct, verified or equivalent. Do not write queries or code. Do not invent ids.",
].join(" ");

export async function explainWithAi(report: unknown, env: NodeJS.ProcessEnv, fetcher: Fetcher): Promise<AiResult & { enabled: true }> {
  const cfg = aiConfigFromEnv(env);
  if (!cfg.enabled || !cfg.keyPresent) throw new Error("AI explanation is switched off");
  const items = aiPayloadFromReport(report);
  const res = await fetcher("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.AI_EXPLANATION_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify({ items }) }] }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);
  const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = null;
  }
  return { enabled: true, ...validateAiReply(parsed, new Set(items.map((i) => i.id))) };
}
