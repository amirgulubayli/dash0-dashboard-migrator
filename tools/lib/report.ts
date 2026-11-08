// Shared by tools/gaps, tools/gate and tools/recurse: the slice of report.json they read, the claim order, and how to
// run `migrate --no-import` in a checkout. Build-time only: src/ never imports tools/, and nothing here calls a model.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { worst, type Status } from "../../src/ir/index.js";

/** The fields of a report.json item (dd2dash0.report/v2) the tools read. Structural, so an older report still fits. */
export interface GapFinding {
  status: string;
  code: string;
  message: string;
  ruleId?: string;
}

export interface GapItem {
  id: string;
  kind: string;
  title?: string;
  dashboard?: string | null;
  widget_type?: string;
  status: string;
  reason_codes?: string[];
  certificate?: { outputHash: string | null; rules?: string[]; status?: string };
  findings: GapFinding[];
}

export interface GapReport {
  schema?: string;
  run?: { outputHash?: string };
  summary?: { coverageExact?: number; coverageTranslated?: number };
  items: GapItem[];
}

/**
 * The claim lattice, strongest first, read from the migrator itself: src/ir `worst()` is what the rule catalog's
 * `compose()` uses (plan 05 D5), so sorting the four statuses by it gives the order the catalog means
 * (src/rules/types.ts: exact > exact-under > bounded > manual). Nothing here restates the order by hand.
 */
const STATUSES: Status[] = ["manual", "bounded", "exact", "exact-under"];
export const CLAIM_ORDER: readonly Status[] = Object.freeze(
  [...STATUSES].sort((a, b) => (a === b ? 0 : worst(a, b) === b ? -1 : 1)),
);

/**
 * An item's claim. `unsupported` is the report-only status of a placeholder panel (src/report/types.ts), whose claim
 * is manual: nothing was translated, the original is kept. Unknown strings return null (treated as weakest).
 */
export function claimOf(status: string): Status | null {
  if (status === "unsupported") return "manual";
  return (CLAIM_ORDER as readonly string[]).includes(status) ? (status as Status) : null;
}

/** 0 = strongest (exact). An unknown status ranks below manual. */
export function claimRank(status: string): number {
  const c = claimOf(status);
  return c === null ? CLAIM_ORDER.length : CLAIM_ORDER.indexOf(c);
}

/** true when `a` is a strictly weaker claim than `b`. */
export const weaker = (a: string, b: string) => claimRank(a) > claimRank(b);

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export interface Run {
  ok: boolean;
  code: number | null;
  out: string;
}

/** Run a command, capture stdout+stderr (ANSI stripped). `shell` on Windows so `npx` resolves. */
export function run(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 128 * 1024 * 1024,
    env: opts.env ?? process.env,
  });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "") };
}

export const tail = (s: string, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s);

/** Quote an argument for the Windows shell when it has spaces (spawnSync with shell joins args with spaces). */
const q = (s: string) => (process.platform === "win32" && /\s/.test(s) ? `"${s}"` : s);

export interface MigrateRun {
  report: GapReport;
  /** Raw report.json bytes, for the determinism hash. */
  raw: string;
  /** sha256 of report.json. report.json carries no timestamps, so equal inputs give equal bytes. */
  sha256: string;
}

/**
 * `dd2dash0 migrate --from datadog --input <input> --no-import` in `cwd` (a checkout: its own src/ and mappings/),
 * into a temp directory that is removed afterwards. Throws with the output tail if migrate fails.
 */
export function migrate(cwd: string, input: string, keepAt?: string): MigrateRun {
  const out = keepAt ? resolve(keepAt) : join(mkdtempSync(join(tmpdir(), "dd2dash0-gaps-")), "run");
  try {
    const r = run("npx", ["tsx", "src/cli.ts", "migrate", "--from", "datadog", "--input", q(resolve(input)), "--no-import", "--out", q(out)], cwd);
    if (!r.ok) throw new Error(`migrate failed in ${cwd} (exit ${r.code}):\n${tail(r.out)}`);
    const raw = readFileSync(join(out, "report.json"), "utf8");
    return { report: JSON.parse(raw) as GapReport, raw, sha256: sha256(raw) };
  } finally {
    if (!keepAt) rmSync(join(out, ".."), { recursive: true, force: true });
  }
}

/** Stable JSON: object keys sorted, so the same data always serialises to the same bytes. */
export function stableJson(v: unknown, indent = 2): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(norm(v), null, indent) + "\n";
}

/** Markdown table cell: no pipes or newlines. */
export const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
/** The id as a whole token (time.rollup.counter does not count as a mention of time.rollup). */
export const namesRule = (text: string, id: string) => new RegExp(`(^|[^A-Za-z0-9_.-])${escape(id)}($|[^A-Za-z0-9_.-]|\\.(?![A-Za-z0-9_]))`).test(text);
