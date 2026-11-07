// One agent working one gap, inside a candidate workspace. This is the only file that calls a model, and it lives
// outside src/: the shipped migrator never imports it (tests/improve/boundary.test.ts checks that).
// The agent can read the repo, fetch the cited upstream sources, write mapping rows and a test, and measure its
// change. It cannot touch anything else (allowedPath), and it doesn't decide whether its change is accepted:
// the gates in gates.ts do.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Gap } from "./gaps.js";
import { allowedPath, evaluate } from "./gates.js";
import type { Snapshot } from "./snapshot.js";
import { changedFiles, measure, run, tail } from "./workspace.js";

export const MODEL = "claude-opus-5-5";
/** Claude Opus 5.5 list prices, $ per million tokens (input, output, cache read, cache write 5m). */
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

/** Upstream sources per integration prefix: the agent may only cite (and fetch) these. */
export const SOURCES: Record<string, { datadog: string; otel: string }> = {
  nginx: {
    datadog: "https://raw.githubusercontent.com/DataDog/integrations-core/master/nginx/metadata.csv",
    otel: "https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v0.164.0/receiver/nginxreceiver/metadata.yaml",
  },
  postgresql: {
    datadog: "https://raw.githubusercontent.com/DataDog/integrations-core/master/postgres/metadata.csv",
    otel: "https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v0.164.0/receiver/postgresqlreceiver/metadata.yaml",
  },
  redis: {
    datadog: "https://raw.githubusercontent.com/DataDog/integrations-core/master/redisdb/metadata.csv",
    otel: "https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/v0.164.0/receiver/redisreceiver/metadata.yaml",
  },
};

export interface AgentOptions {
  workspace: string;
  gap: Gap;
  baseline: Snapshot;
  maxTurns: number;
  budgetUsd: number;
  log: (line: string) => void;
}

export interface AgentResult {
  submitted: boolean;
  summary: string;
  turns: number;
  costUsd: number;
  stop: string;
}

const SYSTEM = `You improve the mapping tables of dd2dash0, a deterministic Datadog -> Dash0 migrator. The migrator itself never
calls a model; you work at build time, and your change is checked by mechanical gates (typecheck, every test,
determinism, no regression, the gap shrinks) and then reviewed by a person in a draft PR.

Rules:
- Correctness over coverage. Map a Datadog metric to an OTel metric only when the upstream sources you were given say
  they measure the same thing. Use status "exact" only for the same quantity and unit; "approximate" (with a note
  saying what differs) when close; status "none" (otel: null, with a note) when there is no equivalent. A wrong
  "exact" row is worse than a missing one.
- Every row's note says where the evidence is (metadata.csv description vs receiver metadata.yaml description).
- Kinds matter: ddKind is how Datadog stores the metric (gauge | rate | count | distribution, from metadata.csv),
  otelKind how the receiver emits it (gauge | counter | updowncounter | histogram). The translator inserts rate()
  when a Datadog rate maps to an OTel counter.
- Only write the files the tools allow. Follow the schema in mappings/README.md and src/ir/mappings.ts exactly, and
  match the style of mappings/datadog/redisdb.yaml (but don't edit it: it is generated).
- Add a test file tests/improve/gen-<scope>.test.ts that loads the table with the repo's loader and asserts the rows
  you added (including at least one "none" or "approximate" row if you added any).
- Use measure to see the gap shrink and that no item got worse, and run_tests before you submit.
- Submit with a short summary: rows added by status, anything you deliberately left unmapped and why.
- If something outside your allowed files blocks you (for example an existing test that fails because of your
  change), don't stop silently: submit with a summary starting 'BLOCKED:' that names the file and the problem.`;

function brief(g: Gap): string {
  const src = g.scope ? SOURCES[g.scope] : undefined;
  return [
    `Gap: ${g.key} (${g.items.length} report item(s), score ${g.score}).`,
    "",
    "Example findings:",
    ...g.examples.map((e) => `- ${e}`),
    "",
    ...(g.subjects.length
      ? [`Every name in this gap, most-used first. These are what the fixtures use: cover them first, each as exact / approximate / none, before adding any other row:`, g.subjects.join(", "), ""]
      : []),
    src
      ? `Upstream sources for '${g.scope}' (fetch these):\n- Datadog metadata: ${src.datadog}\n- OTel receiver metadata: ${src.otel}`
      : `No upstream source is registered for this gap; work only from what is in the repository, and map nothing you can't justify.`,
    "",
    g.code === "tag.unmapped" ? "Close the gap by adding entries to mappings/tags.yaml." : `Close the gap by adding mappings/datadog/${g.scope ?? "<integration>"}.yaml.`,
    "Start by reading mappings/README.md, src/ir/mappings.ts and the fixture dashboards that use these metrics (grep).",
  ].join("\n");
}

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "list_files",
    description: "List files under a directory of the repository (repo-relative path).",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a repository file as numbered lines. Large files: pass offset (1-based line) and limit.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search tracked files with a regular expression (git grep -nE). Optional path limits the search.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "write_file",
    description:
      "Write a whole file. Allowed: mappings/datadog/<integration>.yaml (not redisdb.yaml), mappings/tags.yaml, tests/improve/gen-<name>.test.ts.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false },
  },
  {
    name: "measure",
    description: "Run the migrator over the fixtures with your changes and compare with the baseline: gap size, coverage, items that got worse.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_tests",
    description: "Run vitest (one test file, or the whole suite when file is omitted).",
    input_schema: { type: "object", properties: { file: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "submit",
    description: "Finish: your change is ready for the gates. Give a short summary for the PR.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, allowed_domains: ["raw.githubusercontent.com", "github.com"] },
];

/** Inputs are validated by hand: with eager input streaming the server no longer does it. */
function str(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = input[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string`);
  return v;
}
class ToolError extends Error {}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const client = new Anthropic();
  const ws = o.workspace;
  const inside = (p: string) => {
    const abs = resolve(ws, p);
    const rel = relative(ws, abs).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel.startsWith("node_modules")) throw new ToolError(`path outside the repository: ${p}`);
    return { abs, rel };
  };

  const tools: Record<string, (i: Record<string, unknown>) => string> = {
    list_files(i) {
      const { abs, rel } = inside(str(i, "dir")!);
      return readdirSync(abs)
        .map((n) => (statSync(join(abs, n)).isDirectory() ? `${rel}/${n}/` : `${rel}/${n}`))
        .join("\n");
    },
    read_file(i) {
      const { abs } = inside(str(i, "path")!);
      const lines = readFileSync(abs, "utf8").split("\n");
      const from = Math.max(1, Number(i.offset ?? 1));
      const n = Math.min(Number(i.limit ?? 400), 1500);
      const out = lines.slice(from - 1, from - 1 + n).map((l, k) => `${from + k}\t${l.length > 400 ? l.slice(0, 400) + "…" : l}`);
      return `${out.join("\n")}\n[lines ${from}-${from + out.length - 1} of ${lines.length}]`;
    },
    grep(i) {
      const args = ["grep", "-nE", "--", str(i, "pattern")!];
      const p = str(i, "path", false);
      if (p) args.push(inside(p).rel);
      return tail(run("git", args, ws).out, 6000) || "(no matches)";
    },
    write_file(i) {
      const { abs, rel } = inside(str(i, "path")!);
      if (!allowedPath(rel)) throw new ToolError(`not allowed to write ${rel}`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, str(i, "contents")!);
      return `wrote ${rel}`;
    },
    measure() {
      const after = measure(ws);
      const r = evaluate(o.baseline, after, o.gap.key, changedFiles(ws), { typecheck: { ok: true, tail: "" }, tests: { ok: true, tail: "" }, deterministic: true });
      return r.gates
        .filter((g) => !["typecheck", "tests", "determinism"].includes(g.name))
        .map((g) => `${g.ok ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`)
        .join("\n");
    },
    run_tests(i) {
      const f = str(i, "file", false);
      const r = run("npx", ["vitest", "run", ...(f ? [inside(f).rel] : [])], ws);
      return `${r.ok ? "PASSED" : "FAILED"}\n${tail(r.out, 4000)}`;
    },
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: brief(o.gap) }];
  let cost = 0;
  let nudged = false;
  for (let turn = 1; turn <= o.maxTurns; turn++) {
    if (cost >= o.budgetUsd) return { submitted: false, summary: "", turns: turn - 1, costUsd: cost, stop: `budget ($${cost.toFixed(2)} of $${o.budgetUsd})` };
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: SYSTEM,
          tools: TOOLS,
          messages,
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw e;
      o.log(`turn ${turn}: a tool input was not valid JSON; re-issuing the turn`);
      continue;
    }
    const u = msg.usage;
    cost += ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / 1e6;

    if (msg.stop_reason === "refusal") return { submitted: false, summary: "", turns: turn, costUsd: cost, stop: "refusal" };
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      const said = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (said) o.log(`turn ${turn}: agent said: ${said.slice(0, 600)}`);
      // One reminder: the round only counts if the agent submits (or says why it can't, which is logged).
      if (!nudged && msg.stop_reason === "end_turn") {
        nudged = true;
        messages.push({ role: "assistant", content: msg.content });
        messages.push({ role: "user", content: "You ended without calling submit. Call submit now: either with your summary, or with a summary starting 'BLOCKED:' that says exactly what stops you (for example a file you are not allowed to edit)." });
        continue;
      }
      return { submitted: false, summary: said, turns: turn, costUsd: cost, stop: `ended without submitting (${msg.stop_reason})` };
    }
    if (msg.stop_reason === "max_tokens") return { submitted: false, summary: "", turns: turn, costUsd: cost, stop: "max_tokens with a pending tool call" };
    messages.push({ role: "assistant", content: msg.content });

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let submitted: string | null = null;
    for (const c of calls) {
      const input = (c.input ?? {}) as Record<string, unknown>;
      try {
        if (c.name === "submit") {
          submitted = str(input, "summary")!;
          results.push({ type: "tool_result", tool_use_id: c.id, content: "submitted" });
          continue;
        }
        const fn = tools[c.name];
        if (!fn) throw new ToolError(`unknown tool ${c.name}`);
        const out = fn(input);
        o.log(`turn ${turn}: ${c.name} ${JSON.stringify(input).slice(0, 120)}`);
        results.push({ type: "tool_result", tool_use_id: c.id, content: out });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        o.log(`turn ${turn}: ${c.name} error: ${m.slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: c.id, content: m, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
    if (submitted !== null) {
      if (submitted.startsWith("BLOCKED:")) {
        o.log(`agent blocked: ${submitted.slice(0, 600)}`);
        return { submitted: false, summary: submitted, turns: turn, costUsd: cost, stop: "blocked" };
      }
      return { submitted: true, summary: submitted, turns: turn, costUsd: cost, stop: "submitted" };
    }
  }
  return { submitted: false, summary: "", turns: o.maxTurns, costUsd: cost, stop: "max turns" };
}

