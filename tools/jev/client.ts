// Jev (TypeSafe's decision model) client for build-time and review tooling. Plan 08 / decision D-47: Jev never sits
// in the translation path. src/ never imports this (tests/improve/loop.test.ts checks), and nothing here can change
// migrate's output: Jev only produces suggestions that a person or a mechanical gate acts on.
//
// Jev has no seed or temperature, and answers can change between releases. So every answer is cached on disk by a
// hash of the exact request, and stored with the model version that gave it. A re-run with the same input reuses
// the stored answer, which keeps suggestions stable (for the demo, and for review).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
export type JevAnswer = ChoiceAnswer | ScoreAnswer;

export interface JevResult<Q extends Record<string, JevQuestion>> {
  /** The model version that answered (e.g. jev-1.14.0). */
  model: string;
  /** sha256 of the canonical request; the cache key. */
  inputHash: string;
  answeredAt: string;
  cached: boolean;
  answers: { [K in keyof Q]: Q[K] extends { type: "choice" } ? ChoiceAnswer : ScoreAnswer };
  usage?: { input_tokens: number; output_tokens: number };
}

export interface JevOptions {
  /** Defaults to env TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Cache directory; default out/jev-cache under the current directory. */
  cacheDir?: string;
  /** For tests: replace the HTTP call. */
  fetchImpl?: typeof fetch;
}

/** Stable JSON: object keys sorted, so the same request always hashes the same. */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

export function hashRequest(state: string, questions: Record<string, JevQuestion>): string {
  return createHash("sha256").update(canonical({ model: JEV_MODEL, state, questions })).digest("hex");
}

export async function askJev<Q extends Record<string, JevQuestion>>(state: string, questions: Q, o: JevOptions = {}): Promise<JevResult<Q>> {
  const inputHash = hashRequest(state, questions);
  const dir = o.cacheDir ?? join(process.cwd(), "out", "jev-cache");
  const file = join(dir, `${inputHash}.json`);
  if (existsSync(file)) return { ...(JSON.parse(readFileSync(file, "utf8")) as JevResult<Q>), cached: true };

  const key = o.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("Jev: set TYPESAFE_API_KEY in the environment");
  const res = await (o.fetchImpl ?? fetch)(JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`Jev: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model: string; answers: Record<string, JevAnswer>; usage?: JevResult<Q>["usage"] };
  for (const id of Object.keys(questions)) {
    const a = body.answers?.[id];
    if (!a || a.type !== questions[id]!.type) throw new Error(`Jev: no ${questions[id]!.type} answer for '${id}'`);
    if (a.type === "choice" && !(a.choice in (questions[id] as { criteria: Record<string, string> }).criteria)) throw new Error(`Jev: '${id}' chose unknown option '${a.choice}'`);
  }
  const out: JevResult<Q> = { model: body.model, inputHash, answeredAt: new Date().toISOString(), cached: false, answers: body.answers as JevResult<Q>["answers"], ...(body.usage && { usage: body.usage }) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}
