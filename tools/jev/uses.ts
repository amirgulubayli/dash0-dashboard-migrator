// The three places Jev helps (plans 08 and 09 §5). Each only suggests; none can change migrate's output, and each
// falls back to the deterministic path when Jev is off or fails.
//   J1 reviewPriority: which non-exact report items a person should review first (sidecar review-priority.json).
//   J2 pickGapWithJev: which of the top 5 deterministic gaps the next build-time round works on (the gates decide).
//   J3 scoreEvidence:  how strong the evidence is for each new mapping row (0-3); rows under 1.5 are flagged in the
//                      round result. A note for the reviewer, never a gate.
import { parse as parseYaml } from "yaml";
import type { Gap } from "../improve/gaps.js";
import { canonical, JEV_LABEL, type Jev, type ScoreQuestion } from "./client.js";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------- J2: gap picker ----------------

export const PICK_TOP_N = 5;

export interface GapPick {
  gap: Gap;
  by: "jev" | "deterministic";
  label: string;
  model?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** The deterministic candidates Jev chose among. */
  candidates: string[];
  note?: string;
}

/**
 * Ask Jev to choose among the top `n` actionable gaps of the deterministic ranking (already in ranked order). If Jev
 * is off or fails, return the deterministic first choice and say why: Jev can steer the loop, never stop it.
 */
export async function pickGapWithJev(ranked: Gap[], jev: Jev, n = PICK_TOP_N): Promise<GapPick | null> {
  const top = ranked.filter((g) => g.actionable).slice(0, n);
  if (top.length === 0) return null;
  const candidates = top.map((g) => g.key);
  const fallback = (note: string): GapPick => ({ gap: top[0]!, by: "deterministic", label: "deterministic ranking", candidates, note });
  if (!jev.enabled) return fallback(jev.reason);
  if (top.length === 1) return fallback("only one actionable gap; Jev not asked");
  const criteria = Object.fromEntries(
    top.map((g) => [g.key, `${g.items.length} report items affected (score ${g.score}). Names: ${(g.subjects.length ? g.subjects : g.examples).slice(0, 12).join(", ")}`]),
  );
  const state = [
    "We migrate Datadog dashboards and monitors to Dash0 with a deterministic compiler. A build-time agent can close one",
    "coverage gap per round by writing mapping-table rows from upstream metadata, then mechanical gates decide.",
    "Prefer the gap where correct, well-documented mappings will fix the most dashboard panels people actually use.",
  ].join(" ");
  try {
    const r = await jev.ask(state, { gap: { type: "choice", instructions: "Which gap should the next round work on?", criteria } });
    const a = r.answers.gap;
    const gap = top.find((g) => g.key === a.choice);
    if (!gap) return fallback(`Jev chose '${a.choice}', not a candidate; used the deterministic ranking`);
    return { gap, by: "jev", label: JEV_LABEL, model: r.model, confidence: a.confidence, probabilities: a.probabilities, candidates };
  } catch (e) {
    return fallback(`Jev unavailable (${errText(e)}); used the deterministic ranking`);
  }
}

// ---------------- J3: evidence scores for new mapping rows ----------------

export const EVIDENCE_LEVELS = [
  "Weak: the descriptions differ or the evidence is missing",
  "Partial: related quantities, but scope, unit or aggregation differ",
  "Good: same quantity, with minor wording or unit differences",
  "Strong: clearly the same quantity, unit and kind",
];
/** Rows scoring below this are flagged for the reviewer (plan 09 §5). */
export const EVIDENCE_FLAG_BELOW = 1.5;

type Row = { otel?: string | null; status?: string; note?: string; ddKind?: string; otelKind?: string | null; unit?: string; labels?: Record<string, string> };
const rowsOf = (yamlText: string | null): Record<string, Row> => (yamlText ? ((parseYaml(yamlText) as { metrics?: Record<string, Row> } | null)?.metrics ?? {}) : {});

/** Metric names whose row is new or changed in `after` compared with `before` (null: the file is new). */
export function newMappingRows(before: string | null, after: string): string[] {
  const b = rowsOf(before);
  return Object.entries(rowsOf(after))
    .filter(([m, r]) => !(m in b) || canonical(b[m]) !== canonical(r))
    .map(([m]) => m);
}

export interface RowEvidence {
  metric: string;
  status: string;
  otel: string | null;
  score: number;
  confidence: number;
  flagged: boolean;
}

export interface EvidenceReview {
  label: string;
  model: string;
  threshold: number;
  rows: RowEvidence[];
  flagged: string[];
  /** Set when Jev was off or failed: nothing was scored. */
  skipped?: string;
}

/** Score the rows of a mapping table (YAML text), all of them or only `only`. Batched, several questions per request. */
export async function scoreEvidence(yamlText: string, jev: Jev, only?: readonly string[], batch = 12): Promise<EvidenceReview> {
  const empty = (skipped: string): EvidenceReview => ({ label: JEV_LABEL, model: "", threshold: EVIDENCE_FLAG_BELOW, rows: [], flagged: [], skipped });
  if (!jev.enabled) return empty(jev.reason);
  const all = rowsOf(yamlText);
  const rows = Object.entries(all).filter(([m]) => !only || only.includes(m));
  const out: RowEvidence[] = [];
  const models = new Set<string>();
  try {
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const questions: Record<string, ScoreQuestion> = {};
      chunk.forEach(([metric, r], k) => {
        questions[`r${k}`] = {
          type: "score",
          instructions: `Mapping row: Datadog '${metric}' (${r.ddKind ?? "?"}) -> OTel '${r.otel ?? "none"}' (${r.otelKind ?? "-"})${r.labels ? ` with labels ${JSON.stringify(r.labels)}` : ""}, claimed status '${r.status}'. Evidence note: ${r.note ?? "(none)"}. How strong is the evidence that this row is right?`,
          criteria: EVIDENCE_LEVELS,
        };
      });
      const res = await jev.ask("Rate the evidence for each Datadog -> OpenTelemetry metric mapping row, using only the row and its evidence note.", questions);
      models.add(res.model);
      chunk.forEach(([metric, r], k) => {
        const a = res.answers[`r${k}`]!;
        out.push({ metric, status: r.status ?? "?", otel: r.otel ?? null, score: a.score, confidence: a.confidence, flagged: a.score < EVIDENCE_FLAG_BELOW });
      });
    }
  } catch (e) {
    return empty(`Jev unavailable (${errText(e)}); no evidence scores`);
  }
  return { label: JEV_LABEL, model: [...models].join(", "), threshold: EVIDENCE_FLAG_BELOW, rows: out, flagged: out.filter((r) => r.flagged).map((r) => r.metric) };
}

/** Markdown review note for the round result / commit message. */
export function evidenceNote(file: string, e: EvidenceReview): string {
  if (e.skipped) return `Jev evidence check for ${file}: skipped (${e.skipped}).`;
  return [
    `Jev evidence check for ${file} — ${e.label} for the reviewer, not a gate (${e.model}). Scale 0 to 3: ${EVIDENCE_LEVELS.map((l, i) => `${i} ${l.split(":")[0]}`).join(", ")}. Flag below ${e.threshold}.`,
    ...e.rows.map((r) => `- ${r.flagged ? "FLAG " : ""}${r.metric} -> ${r.otel ?? "none"} [${r.status}]: ${r.score.toFixed(2)} (confidence ${r.confidence.toFixed(2)})`),
    e.flagged.length
      ? `${e.flagged.length} row(s) flagged. Every gate passed, so Jev and the gates disagree here: worth a human look.`
      : "No rows flagged.",
  ].join("\n");
}

// ---------------- J1: review priority for the console ----------------

export const URGENCY_LEVELS = [
  "Can wait: the result is exact or the assumption is routine",
  "Worth a look: an assumption a reviewer should confirm",
  "Review soon: an approximation that could mislead a reader",
  "Review first: likely wrong or missing for an important panel or alert",
];

export interface ReportLike {
  run?: { outputHash?: string };
  items: {
    id: string;
    kind?: string;
    title?: string;
    widget_type?: string;
    status: string;
    source_queries?: string[];
    promql?: string[];
    findings?: { status: string; code: string; message: string }[];
    certificate?: { assumptions?: string[] };
  }[];
}

/** The review-priority.json sidecar. `scores` is the item id -> score map the console reads. */
export interface ReviewPriority {
  label: string;
  generatedBy: "jev";
  model: string;
  /** The report this belongs to: a different report means stale suggestions. */
  reportOutputHash: string | null;
  scale: string[];
  note: string;
  scores: Record<string, number>;
  /** Same items, most urgent first. */
  items: { id: string; score: number; confidence: number; level: string }[];
}

/** J1. Throws when Jev is off or fails (it is a standalone CLI step, not part of the loop). */
export async function reviewPriority(report: ReportLike, jev: Jev, batch = 10): Promise<ReviewPriority> {
  if (!jev.enabled) throw new Error(jev.reason);
  const todo = report.items.filter((i) => i.status !== "exact");
  const items: ReviewPriority["items"] = [];
  const models = new Set<string>();
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const questions: Record<string, ScoreQuestion> = {};
    chunk.forEach((it, k) => {
      const findings = (it.findings ?? []).filter((f) => f.status !== "exact").map((f) => `${f.status} ${f.code}: ${f.message}`).slice(0, 6);
      questions[`i${k}`] = {
        type: "score",
        instructions: `${it.kind ?? "item"} '${it.title ?? it.id}' (${it.widget_type ?? "?"}), migration status '${it.status}'. Source: ${(it.source_queries ?? []).join(" | ").slice(0, 400)}. Output: ${(it.promql ?? []).join(" | ").slice(0, 400) || "(placeholder, nothing emitted)"}. Findings: ${findings.join("; ") || "(none)"}. Assumptions: ${(it.certificate?.assumptions ?? []).slice(0, 4).join("; ") || "(none)"}. How urgently should a person review this item?`,
        criteria: URGENCY_LEVELS,
      };
    });
    const res = await jev.ask("A migration report lists each Datadog dashboard panel or monitor with its Dash0 translation and why it may be imperfect. Rank review urgency for a person checking the migration.", questions);
    models.add(res.model);
    chunk.forEach((it, k) => {
      const a = res.answers[`i${k}`]!;
      items.push({ id: it.id, score: a.score, confidence: a.confidence, level: URGENCY_LEVELS[Math.round(a.score)]!.split(":")[0]! });
    });
  }
  items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    label: JEV_LABEL,
    generatedBy: "jev",
    model: [...models].join(", "),
    reportOutputHash: report.run?.outputHash ?? null,
    scale: URGENCY_LEVELS,
    note: "Suggested review order (Jev). A suggestion only: statuses and output come from the deterministic migrator.",
    scores: Object.fromEntries(items.map((i) => [i.id, i.score])),
    items,
  };
}
