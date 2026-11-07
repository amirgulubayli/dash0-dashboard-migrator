// The three places Jev helps (plan 08). Each only suggests; none can change migrate's output.
//   J1 reviewPriority: which non-exact report items a person should review first (a sidecar file for the console).
//   J2 pickGapWithJev: which of the top deterministic gaps the next build-time round works on (the gates still decide).
//   J3 scoreEvidence:  how strong the cited evidence is for each mapping row an agent wrote (a review note, not a gate).
import { parse as parseYaml } from "yaml";
import type { Gap } from "../improve/gaps.js";
import { askJev, type JevOptions, type JevQuestion } from "./client.js";

// ---------------- J2: gap picker ----------------

export interface GapPick {
  gap: Gap;
  by: "jev" | "deterministic";
  model?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  note?: string;
}

/**
 * Ask Jev to choose among the top `n` actionable gaps of the deterministic ranking. If Jev fails, fall back to the
 * deterministic first choice and say so: Jev can steer the loop, never stop it.
 */
export async function pickGapWithJev(ranked: Gap[], n = 5, o: JevOptions = {}): Promise<GapPick | null> {
  const top = ranked.filter((g) => g.actionable).slice(0, n);
  if (top.length === 0) return null;
  if (top.length === 1) return { gap: top[0]!, by: "deterministic", note: "only one actionable gap" };
  const criteria = Object.fromEntries(
    top.map((g) => [g.key, `${g.items.length} report items affected (score ${g.score}). Names: ${(g.subjects.length ? g.subjects : g.examples).slice(0, 12).join(", ")}`]),
  );
  const state = [
    "We migrate Datadog dashboards and monitors to Dash0 with a deterministic compiler. A build-time agent can close one",
    "coverage gap per round by writing mapping-table rows from upstream metadata, then mechanical gates decide.",
    "Prefer the gap where correct, well-documented mappings will fix the most dashboard panels people actually use.",
  ].join(" ");
  try {
    const r = await askJev(state, { gap: { type: "choice", instructions: "Which gap should the next round work on?", criteria } }, o);
    const a = r.answers.gap;
    return { gap: top.find((g) => g.key === a.choice)!, by: "jev", model: r.model, confidence: a.confidence, probabilities: a.probabilities };
  } catch (e) {
    return { gap: top[0]!, by: "deterministic", note: `Jev unavailable (${e instanceof Error ? e.message : e}); used the deterministic ranking` };
  }
}

// ---------------- J3: evidence scores for mapping rows ----------------

export const EVIDENCE_LEVELS = [
  "Weak: the descriptions differ or the evidence is missing",
  "Partial: related quantities, but scope, unit or aggregation differ",
  "Good: same quantity, with minor wording or unit differences",
  "Strong: clearly the same quantity, unit and kind",
];

export interface RowEvidence {
  metric: string;
  status: string;
  otel: string | null;
  score: number;
  confidence: number;
  /** A row claiming "exact" with less than good evidence, or "none" with strong evidence for a match. */
  flag: string | null;
}

/** Score every row of a mapping table (YAML text). Rows are batched, several questions per Jev request. */
export async function scoreEvidence(yamlText: string, o: JevOptions = {}, batch = 12): Promise<{ model: string; rows: RowEvidence[] }> {
  const doc = parseYaml(yamlText) as { metrics?: Record<string, { otel?: string | null; status?: string; note?: string; ddKind?: string; otelKind?: string | null; unit?: string; labels?: Record<string, string> }> };
  const rows = Object.entries(doc.metrics ?? {});
  const out: RowEvidence[] = [];
  let model = "";
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const questions: Record<string, JevQuestion> = {};
    chunk.forEach(([metric, r], k) => {
      questions[`r${k}`] = {
        type: "score",
        instructions: `Mapping row: Datadog '${metric}' (${r.ddKind ?? "?"}) -> OTel '${r.otel ?? "none"}' (${r.otelKind ?? "-"})${r.labels ? ` with labels ${JSON.stringify(r.labels)}` : ""}, claimed status '${r.status}'. Evidence note: ${r.note ?? "(none)"}. How strong is the evidence that these measure the same thing?`,
        criteria: EVIDENCE_LEVELS,
      };
    });
    const res = await askJev("Rate the evidence for each Datadog -> OpenTelemetry metric mapping row, using only the row and its evidence note.", questions, o);
    model = res.model;
    chunk.forEach(([metric, r], k) => {
      const a = res.answers[`r${k}`] as { score: number; confidence: number };
      const status = r.status ?? "?";
      const flag = status === "exact" && a.score < 2 ? "claims exact, but Jev rates the evidence below 'good'" : status === "none" && a.score >= 2.5 ? "claims no equivalent, but Jev rates a match as likely" : null;
      out.push({ metric, status, otel: r.otel ?? null, score: a.score, confidence: a.confidence, flag });
    });
  }
  return { model, rows: out };
}

/** Markdown review note for a draft PR. */
export function evidenceNote(file: string, e: { model: string; rows: RowEvidence[] }): string {
  const flagged = e.rows.filter((r) => r.flag);
  return [
    `Jev evidence check for ${file} (${e.model}; a suggestion for the reviewer, not a gate). Scale 0 to 3: ${EVIDENCE_LEVELS.map((l, i) => `${i} ${l.split(":")[0]}`).join(", ")}.`,
    ...e.rows.map((r) => `- ${r.flag ? "FLAG " : ""}${r.metric} -> ${r.otel ?? "none"} [${r.status}]: ${r.score.toFixed(2)} (confidence ${r.confidence.toFixed(2)})${r.flag ? `: ${r.flag}` : ""}`),
    flagged.length ? `${flagged.length} row(s) flagged for a closer look.` : "No rows flagged.",
  ].join("\n");
}

// ---------------- J1: review priority for the console ----------------

export const URGENCY_LEVELS = [
  "Can wait: the result is exact or the assumption is routine",
  "Worth a look: an assumption a reviewer should confirm",
  "Review soon: an approximation that could mislead a reader",
  "Review first: likely wrong or missing for an important panel or alert",
];

interface ReportLike {
  run: { outputHash: string };
  items: { id: string; kind: string; title: string; widget_type: string; status: string; source_queries: string[]; promql: string[]; findings: { status: string; code: string; message: string }[]; certificate: { assumptions: string[] } }[];
}

export interface ReviewPriority {
  /** The report this belongs to: a different report means stale suggestions. */
  reportOutputHash: string;
  model: string;
  generatedBy: "jev";
  note: string;
  items: { id: string; score: number; confidence: number; level: string }[];
}

export async function reviewPriority(report: ReportLike, o: JevOptions = {}, batch = 10): Promise<ReviewPriority> {
  const todo = report.items.filter((i) => i.status !== "exact");
  const items: ReviewPriority["items"] = [];
  let model = "";
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const questions: Record<string, JevQuestion> = {};
    chunk.forEach((it, k) => {
      const findings = it.findings.filter((f) => f.status !== "exact").map((f) => `${f.status} ${f.code}: ${f.message}`).slice(0, 6);
      questions[`i${k}`] = {
        type: "score",
        instructions: `${it.kind} '${it.title}' (${it.widget_type}), migration status '${it.status}'. Source: ${it.source_queries.join(" | ").slice(0, 400)}. Output: ${it.promql.join(" | ").slice(0, 400) || "(placeholder, nothing emitted)"}. Findings: ${findings.join("; ") || "(none)"}. Assumptions: ${it.certificate.assumptions.slice(0, 4).join("; ") || "(none)"}. How urgently should a person review this item?`,
        criteria: URGENCY_LEVELS,
      };
    });
    const res = await askJev("A migration report lists each Datadog dashboard panel or monitor with its Dash0 translation and why it may be imperfect. Rank review urgency for a person checking the migration.", questions, o);
    model = res.model;
    chunk.forEach((it, k) => {
      const a = res.answers[`i${k}`] as { score: number; confidence: number };
      items.push({ id: it.id, score: a.score, confidence: a.confidence, level: URGENCY_LEVELS[Math.round(a.score)]!.split(":")[0]! });
    });
  }
  items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { reportOutputHash: report.run.outputHash, model, generatedBy: "jev", note: "Suggested review order from Jev. A suggestion only: statuses and output come from the deterministic migrator.", items };
}
