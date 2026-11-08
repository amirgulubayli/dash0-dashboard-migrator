// Jev (TypeSafe's decision model) client for build-time and review tooling. Plan 08 / decision D-47: Jev never sits
// in the translation path. src/ never imports tools/ (tests/improve/jev.test.ts and loop.test.ts check), and nothing
// here can change migrate's output: Jev only produces suggestions that a person or a mechanical gate acts on.
//
// Off by default. Jev runs only when the caller asks for it (--picker jev, --jev-review, or the tools/jev CLI) AND
// TYPESAFE_API_KEY is set AND JEV_DISABLED is not 1. Otherwise createJev() returns a context whose ask() refuses
// without touching the network, and every use falls back to the deterministic path.
//
// Jev has no seed or temperature, and answers can change between releases. So every answer is cached on disk in
// .jev-cache/<sha256>.json, keyed by sha256 of the canonical {model, question, state}, and stored with the model
// version that gave it. A re-run with the same input reuses the stored answer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Every Jev output carries this label, so nobody mistakes it for a migrator claim. */
export const JEV_LABEL = "suggestion (Jev)";
export const DEFAULT_TIMEOUT_MS = 30_000;

export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = ChoiceQuestion | ScoreQuestion;

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
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
}
export type JevAnswer = ChoiceAnswer | ScoreAnswer;
type AnswerFor<Q> = Q extends { type: "choice" } ? ChoiceAnswer : ScoreAnswer;

/** What one cache file holds. */
export interface CacheEntry<A extends JevAnswer = JevAnswer> {
  /** The model version that answered (e.g. jev-1.14.0). */
  model: string;
  /** sha256 of the canonical {model, question, state}; also the file name. */
  inputHash: string;
  answeredAt: string;
  answer: A;
}

export interface JevResult<Q extends Record<string, JevQuestion>> {
  /** The model version(s) that answered; several when some answers came from an older cache entry. */
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  /** Per question: the cache key and whether it was served from cache. */
  meta: { [K in keyof Q]: { inputHash: string; cached: boolean; answeredAt: string } };
}

export interface JevConfig {
  /** The caller asked for Jev (a flag or the CLI). Without it Jev is off whatever the environment says. */
  requested: boolean;
  /** Defaults to process.env. Reads TYPESAFE_API_KEY and JEV_DISABLED. */
  env?: Record<string, string | undefined>;
  /** Cache directory; default .jev-cache under the current directory (gitignored). */
  cacheDir?: string;
  /** For tests: replace the HTTP call. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface Jev {
  enabled: boolean;
  /** One line saying why Jev is on or off (never contains the key). */
  reason: string;
  ask<Q extends Record<string, JevQuestion>>(state: string, questions: Q): Promise<JevResult<Q>>;
}

/** Stable JSON: object keys sorted, so the same request always hashes the same. */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

/** The cache key of one question: sha256 of the canonical {model, question, state}. */
export function hashQuestion(state: string, question: JevQuestion, model = JEV_MODEL): string {
  return createHash("sha256").update(canonical({ model, question, state })).digest("hex");
}

/** Whether Jev may run, and a one-line reason. Pure: reads only the given env. */
export function jevGate(requested: boolean, env: Record<string, string | undefined> = process.env): { enabled: boolean; reason: string } {
  if (!requested) return { enabled: false, reason: "Jev off (not requested); deterministic path" };
  if (env.JEV_DISABLED === "1") return { enabled: false, reason: "Jev off (JEV_DISABLED=1); deterministic path" };
  if (!env.TYPESAFE_API_KEY) return { enabled: false, reason: "Jev off (TYPESAFE_API_KEY not set); deterministic path" };
  return { enabled: true, reason: `Jev on (${JEV_MODEL}); its output is a ${JEV_LABEL}, the gates still decide` };
}

function validate(id: string, q: JevQuestion, a: unknown): JevAnswer {
  const x = a as { type?: unknown; choice?: unknown; score?: unknown; confidence?: unknown; probabilities?: Record<string, number> } | undefined;
  if (!x || x.type !== q.type) throw new Error(`Jev: no ${q.type} answer for '${id}'`);
  if (q.type === "choice") {
    if (typeof x.choice !== "string" || !(x.choice in q.criteria)) throw new Error(`Jev: '${id}' chose unknown option '${String(x.choice)}'`);
  } else {
    const max = q.criteria.length - 1;
    if (typeof x.score !== "number" || !Number.isFinite(x.score) || x.score < 0 || x.score > max) throw new Error(`Jev: '${id}' score ${String(x.score)} is outside 0..${max}`);
  }
  return { ...(x as unknown as JevAnswer), confidence: typeof x.confidence === "number" ? x.confidence : 0, probabilities: x.probabilities ?? {} };
}

export function createJev(c: JevConfig): Jev {
  const env = c.env ?? process.env;
  const gate = jevGate(c.requested, env);
  const dir = c.cacheDir ?? join(process.cwd(), ".jev-cache");
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function ask<Q extends Record<string, JevQuestion>>(state: string, questions: Q): Promise<JevResult<Q>> {
    const answers: Record<string, JevAnswer> = {};
    const meta: Record<string, { inputHash: string; cached: boolean; answeredAt: string }> = {};
    const models = new Set<string>();
    const todo: Record<string, JevQuestion> = {};
    const hashes: Record<string, string> = {};
    for (const [id, q] of Object.entries(questions)) {
      const h = (hashes[id] = hashQuestion(state, q));
      const file = join(dir, `${h}.json`);
      if (existsSync(file)) {
        try {
          const e = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
          answers[id] = validate(id, q, e.answer);
          meta[id] = { inputHash: h, cached: true, answeredAt: e.answeredAt };
          models.add(e.model);
          continue;
        } catch {
          // A corrupt or mismatched cache file: ask again and overwrite it.
        }
      }
      todo[id] = q;
    }

    if (Object.keys(todo).length > 0) {
      if (!gate.enabled) throw new Error(gate.reason); // belt and braces: ask() is only exposed when Jev is on
      const key = env.TYPESAFE_API_KEY!;
      const redact = (s: string) => s.split(key).join("[redacted]");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let body: { model?: string; answers?: Record<string, unknown> };
      try {
        const res = await (c.fetchImpl ?? fetch)(JEV_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: JEV_MODEL, state, questions: todo }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`Jev: HTTP ${res.status}: ${redact((await res.text()).slice(0, 300))}`);
        body = (await res.json()) as typeof body;
      } catch (e) {
        if (ctl.signal.aborted) throw new Error(`Jev: no answer within ${timeoutMs} ms`);
        throw new Error(redact(e instanceof Error ? e.message : String(e)));
      } finally {
        clearTimeout(timer);
      }
      const model = typeof body.model === "string" ? body.model : JEV_MODEL;
      const answeredAt = new Date().toISOString();
      const fresh: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(todo)) fresh[id] = validate(id, q, body.answers?.[id]); // all or nothing
      mkdirSync(dir, { recursive: true });
      for (const [id, a] of Object.entries(fresh)) {
        const entry: CacheEntry = { model, inputHash: hashes[id]!, answeredAt, answer: a };
        writeFileSync(join(dir, `${hashes[id]}.json`), JSON.stringify(entry, null, 2) + "\n");
        answers[id] = a;
        meta[id] = { inputHash: hashes[id]!, cached: false, answeredAt };
      }
      models.add(model);
    }
    return { model: [...models].sort().join(", "), answers, meta } as JevResult<Q>;
  }

  return {
    enabled: gate.enabled,
    reason: gate.reason,
    ask: gate.enabled ? ask : async () => Promise.reject(new Error(gate.reason)),
  };
}
