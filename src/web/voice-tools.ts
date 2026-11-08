// JARVIS client tools: what the ElevenLabs agent can call from the browser. Every answer is read from the page's state
// (`window.dd2ui.state()`, which mirrors GET /api/state); nothing is computed beyond counting and filtering, nothing is
// translated, no claim is changed. Action tools (run_step, decide) only proceed after the user clicks Allow in the
// page's own confirm dialog, and decisions made by voice carry by: "voice".
//
// Shipped to the browser verbatim (see src/web/voice-client.ts): `createVoiceTools` must stay self-contained.
//
// Honesty rules: counts only, never percentages (State.accuracy's *Pct fields are deliberately ignored);
// exact-under is phrased "exact if <condition>"; anything the state does not record is "not recorded".

export type StepId = "plan" | "review" | "apply" | "watch";
export type Decision = "approved" | "flagged" | "rejected" | "pending";

export interface UiItem {
  id: string;
  kind: string;
  title: string;
  dashboard?: string;
  claim: string;
  plain?: string;
  datadog: string[];
  promql: string[];
  reasons: string[];
  decision: string;
}

export interface UiState {
  version?: string;
  source?: string;
  target?: string;
  dryRun?: boolean;
  steps: { id: string; state: string; command?: string; exitCode?: number; note?: string; startedAt?: string; endedAt?: string }[];
  current: string | null;
  accuracy: {
    total: number;
    byClaim: Record<string, number>;
    approved: number;
    pending: number;
    rejected: number;
    landed?: number;
    live?: number;
    [k: string]: unknown;
  };
  items: UiItem[];
}

export interface Dd2Ui {
  state(): UiState;
  confirm(text: string): Promise<boolean>;
  run(step: string): Promise<{ ok: boolean; error?: string } | unknown>;
  decide(ids: string[], decision: string, by: string): Promise<unknown> | unknown;
}

export type VoiceTools = Record<string, (params: any) => Promise<string>>;

export function createVoiceTools(ui: Dd2Ui): VoiceTools {
  const STEPS = ["plan", "review", "apply", "watch"];
  const LABEL: Record<string, string> = { plan: "Plan", review: "Review", apply: "Apply", watch: "Watch" };
  const DECISIONS = ["approved", "flagged", "rejected", "pending"];
  const CLAIM_MEANING: Record<string, string> = {
    exact: "exact: same result as Datadog for any data",
    "exact-under": "exact if the listed conditions hold (say it as 'exact if' plus the condition)",
    bounded: "bounded: within a stated error bound, needs a human check",
    manual: "manual: not translated, the original is kept for a person to rebuild",
    unsupported: "unsupported: Dash0 has no equivalent, a placeholder keeps the original",
  };
  const out = (v: unknown) => JSON.stringify(v);
  const st = (): UiState => ui.state();
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  const spokenClaim = (it: UiItem): string => {
    if (it.claim === "exact-under") {
      const cond = (it.reasons ?? []).filter(Boolean).join("; ");
      return cond ? `exact if ${cond}` : "exact if its conditions hold (condition not recorded)";
    }
    return it.claim;
  };
  const describe = (it: UiItem) => ({
    id: it.id,
    kind: it.kind,
    title: it.title,
    dashboard: it.dashboard ?? "not recorded",
    claim: it.claim,
    say_claim_as: spokenClaim(it),
    plain: it.plain || "not recorded",
    datadog: it.datadog?.length ? it.datadog : ["not recorded"],
    promql: it.promql?.length ? it.promql : ["No PromQL generated"],
    reasons: it.reasons ?? [],
    decision: it.decision,
  });
  const needsReview = (it: UiItem) =>
    it.claim !== "exact" && (it.decision === "pending" || it.decision === "flagged");

  return {
    async get_status() {
      const s = st();
      const apply = s.steps.find((x) => x.id === "apply");
      return out({
        current_step: s.current ?? "none running",
        dry_run: !!s.dryRun,
        source: s.source ?? "not recorded",
        target: s.target ?? "not recorded",
        steps: s.steps.map((x) => ({
          step: LABEL[x.id] ?? x.id,
          state: x.state,
          command: x.command ?? "not recorded",
          exit_code: typeof x.exitCode === "number" ? x.exitCode : "not recorded",
          note: x.note ?? "",
        })),
        import_note:
          apply && apply.state === "done" && s.dryRun
            ? "Apply ran as a dry run: it imported nothing."
            : apply && apply.state === "done"
              ? "Apply finished; what landed is only what get_accuracy records."
              : "Nothing has been imported.",
      });
    },

    async get_accuracy() {
      const a = st().accuracy;
      const by = a.byClaim ?? {};
      const exact = n(by.exact), under = n(by["exact-under"]), bounded = n(by.bounded);
      const manual = n(by.manual), unsupported = n(by.unsupported);
      return out({
        rule: "Counts only. Never say a percentage. Say e.g. '78 of 102 translated'.",
        total: n(a.total),
        translated: exact + under + bounded,
        not_translated: manual + unsupported,
        by_claim: { exact, "exact-under (exact if its conditions hold)": under, bounded, manual, unsupported },
        review: { approved: n(a.approved), pending: n(a.pending), rejected: n(a.rejected) },
        landed_in_dash0: typeof a.landed === "number" ? a.landed : "not recorded",
        live_returning_data: typeof a.live === "number" ? a.live : "not checked",
        claim_meanings: CLAIM_MEANING,
      });
    },

    async get_item(params: { query?: string } = {}) {
      const q = String(params?.query ?? "").trim().toLowerCase();
      const items = st().items ?? [];
      if (!q) return out({ found: false, message: "No query given. Ask which item." });
      let hits = items.filter((it) => it.id.toLowerCase() === q);
      if (!hits.length) hits = items.filter((it) => it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
      if (!hits.length) {
        const words = q.split(/\s+/).filter((w) => w.length > 2);
        hits = items.filter((it) => {
          const hay = (it.title + " " + it.id + " " + (it.dashboard ?? "")).toLowerCase();
          return words.length > 0 && words.every((w) => hay.includes(w));
        });
      }
      if (!hits.length) return out({ found: false, message: `No item matches "${params?.query}". Say you don't know.` });
      return out({ found: true, matches: hits.length, items: hits.slice(0, 3).map(describe) });
    },

    async list_attention() {
      const items = (st().items ?? []).filter(needsReview);
      const groups: Record<string, UiItem[]> = {};
      for (const it of items) {
        const keys = it.reasons?.length ? it.reasons : [`(${it.claim}, no reason recorded)`];
        for (const r of keys) (groups[r] ??= []).push(it);
      }
      const grouped = Object.entries(groups)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([reason, its]) => ({
          reason,
          count: its.length,
          examples: its.slice(0, 5).map((it) => ({ id: it.id, title: it.title, claim: spokenClaim(it), decision: it.decision })),
        }));
      return out({
        needing_review: items.length,
        by_claim: items.reduce<Record<string, number>>((m, it) => ((m[it.claim] = (m[it.claim] ?? 0) + 1), m), {}),
        groups: grouped,
        note: "Review is a human check. Items can appear under several reasons.",
      });
    },

    async run_step(params: { step?: string } = {}) {
      const step = String(params?.step ?? "").toLowerCase().trim();
      if (!STEPS.includes(step)) return out({ ok: false, error: `Unknown step "${params?.step}". Steps: plan, review, apply, watch.` });
      const dry = step === "apply" && st().dryRun ? " (dry run)" : "";
      const allowed = await ui.confirm(`JARVIS wants to run ${LABEL[step]}${dry}. Allow?`);
      if (!allowed) return out({ ok: false, declined: true, message: "The user declined. Nothing was run." });
      try {
        const r = (await ui.run(step)) as { ok?: boolean; error?: string } | undefined;
        return out({ ok: !!r?.ok, error: r?.error, message: r?.ok ? `${LABEL[step]} started.` : `${LABEL[step]} did not start.` });
      } catch (e) {
        return out({ ok: false, error: String((e as Error)?.message ?? e) });
      }
    },

    async decide(params: { ids?: string[] | string; decision?: string } = {}) {
      const raw = params?.ids;
      const ids = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);
      const decision = String(params?.decision ?? "").toLowerCase().trim();
      if (!DECISIONS.includes(decision)) return out({ ok: false, error: `Decision must be one of ${DECISIONS.join(", ")}.` });
      const items = st().items ?? [];
      const known = ids.filter((id) => items.some((it) => it.id === id));
      const unknown = ids.filter((id) => !known.includes(id));
      if (!known.length) return out({ ok: false, error: "None of those ids exist. Use get_item to find ids first.", unknown });
      const titles = known.slice(0, 3).map((id) => items.find((it) => it.id === id)!.title);
      const more = known.length > 3 ? ` and ${known.length - 3} more` : "";
      const allowed = await ui.confirm(
        `JARVIS wants to mark ${known.length} item${known.length === 1 ? "" : "s"} as ${decision}: ${titles.join(", ")}${more}. Allow?`,
      );
      if (!allowed) return out({ ok: false, declined: true, message: "The user declined. Nothing changed." });
      try {
        await ui.decide(known, decision, "voice");
        return out({ ok: true, decided: known.length, decision, unknown });
      } catch (e) {
        return out({ ok: false, error: String((e as Error)?.message ?? e) });
      }
    },
  };
}
