// Talking to `dd2dash0 review`, the CLI's local review server (CONTRACT-003 §6-7). Only same-origin calls, and only
// when the console is served by that command: GET /api/plan answers there and 404s on a plain static host, so the
// console then falls back to downloading review.json. Never any other network call.
import type { Report } from "./report";
import { buildReviewJson, type ReviewState } from "./review";

export interface CliPlan {
  planHash: string;
  reportSha256: string;
  reviewOrder: string[];
  decided: number;
}

export type SaveResult =
  | { ok: true; file: string; pending: string[]; skippedAlerts: string[]; warnings: string[] }
  | { ok: false; error: string; problems: string[] };

type Fetch = typeof fetch;

/** The plan the CLI serves, or null when the console isn't running under `dd2dash0 review`. */
export async function fetchCliPlan(f: Fetch = fetch): Promise<CliPlan | null> {
  try {
    const res = await f("/api/plan", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<CliPlan>;
    return typeof j.planHash === "string" && typeof j.reportSha256 === "string"
      ? {
          planHash: j.planHash,
          reportSha256: j.reportSha256,
          reviewOrder: j.reviewOrder ?? [],
          decided: j.decided ?? 0,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * review.json for the CLI: the usual export plus plan_sha256, but only when the loaded report is the plan's own
 * report (same bytes). A different report keeps report_sha256 alone, so the CLI refuses it instead of misbinding.
 */
export function cliReviewJson(report: Report, sha: string, state: ReviewState, plan: CliPlan) {
  const base = buildReviewJson(report, sha, state);
  return sha === plan.reportSha256 ? { ...base, plan_sha256: plan.planHash } : base;
}

export async function saveReviewToCli(body: unknown, f: Fetch = fetch): Promise<SaveResult> {
  try {
    const res = await f("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as {
      ok?: unknown;
      file?: unknown;
      pending?: unknown;
      skippedAlerts?: unknown;
      warnings?: unknown;
      error?: unknown;
      problems?: unknown;
    };
    if (res.ok && j.ok === true)
      return {
        ok: true,
        file: String(j.file ?? "review.json"),
        pending: Array.isArray(j.pending) ? (j.pending as string[]) : [],
        skippedAlerts: Array.isArray(j.skippedAlerts) ? (j.skippedAlerts as string[]) : [],
        warnings: Array.isArray(j.warnings) ? (j.warnings as string[]) : [],
      };
    const problems = Array.isArray(j.problems)
      ? (j.problems as { message?: unknown }[]).map((p) => String(p?.message ?? p))
      : [];
    return { ok: false, error: String(j.error ?? `the CLI answered ${res.status}`), problems };
  } catch (e) {
    return {
      ok: false,
      error: `could not reach dd2dash0 review (${(e as Error).message})`,
      problems: [],
    };
  }
}
