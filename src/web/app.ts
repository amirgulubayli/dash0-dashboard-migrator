// The web UI's model (docs/web-ui-contract.md): runs the real CLI as a child process for Plan and Apply, writes
// review.json for Review, reads back for Watch, and derives every number from the files the CLI wrote. It never
// translates: claims, PromQL and plain sentences come from <out>/plan/report.json as the CLI wrote them.
// State survives a page reload and a server restart: it's all files under <out>.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Report, ReportItem } from "../report/types.js";
import { allowedDecisions, type Decision, type ReviewDecision, type ReviewFile } from "../pipeline/review.js";
import { reviewQueue, toReviewItem } from "../pipeline/review-session.js";
import { verifyPlan } from "../pipeline/plan-lock.js";
import { rowsOf, scoreOf } from "../flow/score.js";
import { verifyLive, type LiveResult } from "../flow/verify.js";
import { knownKeys, type Keys } from "../flow/keys.js";
import { currentCli, displayCommand, type CliInvocation } from "./spawn.js";

export type StepId = "plan" | "review" | "apply" | "watch";
export type StepState = "idle" | "running" | "done" | "failed" | "blocked";
export type UiDecision = "approved" | "flagged" | "rejected" | "pending";
export type Claim = "exact" | "exact-under" | "bounded" | "manual" | "unsupported";
export type By = "ui" | "voice";
export const STEPS: StepId[] = ["plan", "review", "apply", "watch"];
const CLAIMS: Claim[] = ["exact", "exact-under", "bounded", "manual", "unsupported"];

export interface Step {
  id: StepId;
  state: StepState;
  command?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  note?: string;
}

export interface Accuracy {
  total: number;
  byClaim: Record<Claim, number>;
  approved: number;
  pending: number;
  rejected: number;
  /** Additive: flagged decisions (contract lists approved/pending/rejected; flagged is its own count here). */
  flagged: number;
  /** Additive: items apply needs a decision for (summary.reviewOrder), and how many of those are still open. */
  required: number;
  requiredOpen: number;
  translated: number;
  landed?: number;
  live?: number;
  /** Translated AND landed AND not a live-data failure (src/flow/score.ts); only once apply imported for real. */
  success?: number;
  /** Additive: panels vs monitors per label (monitors are never in the widget totals). */
  panels: { total: number; byClaim: Record<Claim, number> };
  monitors: { total: number; byClaim: Record<Claim, number> };
}

export interface Item {
  id: string;
  kind: "panel" | "alert";
  title: string;
  dashboard?: string;
  claim: string;
  plain?: string;
  datadog: string[];
  promql: string[];
  reasons: string[];
  decision: UiDecision;
  // Additive fields (the contract allows adding):
  widget?: string;
  condition?: string;
  /** True: apply needs a decision for it (it's in the report's review order). */
  required: boolean;
  /** What a decision becomes in review.json: approved | flagged | acknowledged | none (exact items: imported as translated). */
  reviewAs: Record<Exclude<UiDecision, "pending">, Decision | null>;
  /** After apply: the import action and read-back state ("dry-run, read-back skipped", "created, read-back match"). */
  landed?: string;
  /** After watch: live | missing | no-data | error | n/a. */
  live?: string;
  liveDetail?: string;
}

export interface Applied {
  mode: "dry-run" | "live";
  written: number;
  imported: number;
  failed: number;
  rejected: number;
  readBackMatch: number;
  dashboards: number;
  rules: number;
  placeholders: number;
}

export interface State {
  version: string;
  source: string;
  target: string;
  dryRun: boolean;
  steps: Step[];
  current: StepId | null;
  accuracy: Accuracy;
  items: Item[];
  // Additive:
  out: string;
  planHash?: string;
  /** The run's output hash, read from report.json (run.outputHash). */
  outputHash?: string;
  applied?: Applied;
  keys: { datadog: boolean; dash0: boolean };
  voice: boolean;
}

export type UiEvent =
  | { type: "step"; at: string; step: StepId; state: StepState; command?: string; exitCode?: number }
  | { type: "line"; at: string; step: StepId; stream: "stdout" | "stderr"; text: string }
  | { type: "accuracy"; at: string; accuracy: Accuracy }
  | { type: "decision"; at: string; id: string; decision: UiDecision; by: By }
  | { type: "milestone"; at: string; text: string };
type EventBody = UiEvent extends infer E ? (E extends UiEvent ? Omit<E, "at"> : never) : never;

export interface AppOptions {
  version: string;
  out: string;
  /** Datadog export folder; absent: --api when Datadog keys are set. */
  input?: string;
  /** Shown as the source (e.g. "demo data (fixtures/datadog)"). */
  inputLabel?: string;
  /** Force apply --dry-run even with Dash0 keys. */
  forceDryRun?: boolean;
  cli?: CliInvocation;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test hook: verifyLive replacement. */
  verify?: typeof verifyLive;
}

interface RunRecord {
  command: string;
  args: string[];
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** For apply: whether it ran with --dry-run. */
  dryRun?: boolean;
}
interface DecisionRecord {
  decision: Exclude<UiDecision, "pending">;
  by: By;
  at: string;
}
interface DecisionsFile {
  planHash: string;
  decisions: Record<string, DecisionRecord>;
}

const now = () => new Date().toISOString();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
};
const writeAtomic = (p: string, text: string) => {
  writeFileSync(`${p}.tmp`, text);
  renameSync(`${p}.tmp`, p);
};
const claimsOf = (xs: ReportItem[]) => Object.fromEntries(CLAIMS.map((c) => [c, xs.filter((i) => i.status === c).length])) as Record<Claim, number>;
const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);

/** What a UI decision becomes in review.json for this item (null: nothing is written; apply decides by claim). */
export function reviewDecisionFor(item: ReportItem, d: UiDecision): Decision | null {
  const r = toReviewItem(item);
  if (!r || d === "pending") return null;
  const allowed = allowedDecisions(r);
  if (d === "approved") return allowed.includes("approved") ? "approved" : allowed.includes("acknowledged") ? "acknowledged" : null;
  return allowed.includes("flagged") ? "flagged" : null;
}

export class UiApp {
  readonly out: string;
  readonly planDir: string;
  readonly reviewPath: string;
  private readonly decisionsPath: string;
  private readonly runsPath: string;
  private readonly watchPath: string;
  private readonly listeners = new Set<(e: UiEvent) => void>();
  private running: { step: StepId; child?: ChildProcess; done: Promise<void> } | null = null;
  private readonly cli: CliInvocation;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  voice = false;

  constructor(private readonly o: AppOptions) {
    this.out = resolve(o.out);
    this.planDir = join(this.out, "plan");
    this.reviewPath = join(this.out, "review.json");
    this.decisionsPath = join(this.out, "ui-decisions.json");
    this.runsPath = join(this.out, "ui-runs.json");
    this.watchPath = join(this.out, "watch.json");
    this.cli = o.cli ?? currentCli();
    this.env = o.env ?? process.env;
    this.cwd = o.cwd ?? process.cwd();
    mkdirSync(this.out, { recursive: true });
  }

  // ---------- events ----------
  on(fn: (e: UiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: EventBody): void {
    const full = { ...e, at: now() } as UiEvent;
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        /* a broken listener never stops a run */
      }
    }
  }

  // ---------- keys & source ----------
  keys(): Keys {
    return knownKeys(this.env, this.cwd).keys;
  }
  private hasDatadog(k = this.keys()) {
    return !!(k.DD_API_KEY && k.DD_APP_KEY);
  }
  private hasDash0(k = this.keys()) {
    return !!(k.DASH0_API_URL && k.DASH0_AUTH_TOKEN);
  }
  dryRun(): boolean {
    return !!this.o.forceDryRun || !this.hasDash0();
  }
  private sourceArgs(): string[] | null {
    if (this.o.input) return ["--input", resolve(this.cwd, this.o.input)];
    if (this.hasDatadog()) return ["--api"];
    return null;
  }
  private shown(p: string): string {
    const r = relative(this.cwd, p);
    return r && !r.startsWith("..") && r.length < p.length ? r.replace(/\\/g, "/") : p.replace(/\\/g, "/");
  }

  // ---------- files ----------
  private report(): Report | null {
    return readJson<Report>(join(this.planDir, "report.json"));
  }
  private appliedReport(): Report | null {
    return readJson<Report>(join(this.planDir, "apply", "report.json"));
  }
  private runs(): Partial<Record<StepId, RunRecord>> {
    return readJson(this.runsPath) ?? {};
  }
  private saveRun(step: StepId, r: RunRecord) {
    const all = this.runs();
    all[step] = r;
    writeAtomic(this.runsPath, JSON.stringify(all, null, 2) + "\n");
  }
  private planHash(): string | null {
    if (!existsSync(join(this.planDir, "plan.lock"))) return null;
    const v = verifyPlan(this.planDir);
    return v.ok ? v.planHash : null;
  }
  private decisions(planHash: string | null): Record<string, DecisionRecord> {
    const f = readJson<DecisionsFile>(this.decisionsPath);
    if (!f || !planHash || f.planHash !== planHash) return {};
    return f.decisions;
  }

  planArgs(): string[] | null {
    const src = this.sourceArgs();
    return src ? ["plan", ...src, "--out", this.planDir] : null;
  }
  applyArgs(): string[] {
    return ["apply", this.planDir, "--approved", this.reviewPath, ...(this.dryRun() ? ["--dry-run"] : [])];
  }
  private shownArgs(args: string[]): string {
    return displayCommand(args.map((a) => (/[\\/]/.test(a) && existsSync(a) ? this.shown(a) : a.startsWith(this.out) ? this.shown(a) : a)));
  }

  // ---------- state ----------
  state(): State {
    const report = this.report();
    const planHash = report ? this.planHash() : null;
    const dec = this.decisions(planHash);
    const runs = this.runs();
    const keys = this.keys();
    const items = (report?.items ?? []).filter((i) => i.kind === "panel" || i.kind === "alert");
    const appliedFile = join(this.planDir, "apply", "report.json");
    const applied = this.appliedReport();
    const applyRun = runs.apply;
    const applyCurrent =
      !!applied && !!planHash && applied.run.planHash === planHash && !!applyRun && applyRun.exitCode !== undefined && applyRun.exitCode <= 1 && mtime(appliedFile) >= mtime(this.reviewPath) - 1;
    const liveApply = applyCurrent && applied!.summary.import?.mode === "live";
    const watchFile = applyCurrent ? readJson<{ planHash: string; results: Record<string, LiveResult> }>(this.watchPath) : null;
    const liveMap = watchFile && watchFile.planHash === planHash ? new Map(Object.entries(watchFile.results)) : null;

    const decisionOf = (id: string): UiDecision => dec[id]?.decision ?? "pending";
    const reviewExists = !!planHash && existsSync(this.reviewPath) && Object.keys(dec).length > 0;
    const required = items.filter((i) => i.decision_required);
    const pendingBounded = items.filter((i) => i.kind === "panel" && i.status === "bounded" && !reviewDecisionFor(i, decisionOf(i.id)));
    const requiredOpen = required.filter((i) => !reviewDecisionFor(i, decisionOf(i.id))).length;

    // accuracy, with the guided flow's definitions (src/flow/score.ts)
    const scoreDecisions = new Map(items.map((i) => [i.id, i.status === "bounded" && reviewDecisionFor(i, decisionOf(i.id)) === "approved" ? "approved" : decisionOf(i.id)]));
    const base = liveApply ? applied! : report;
    const score = base ? scoreOf(rowsOf(base, scoreDecisions, liveMap, liveApply)) : null;
    const byClaim = claimsOf(items);
    const count = (d: UiDecision) => items.filter((i) => decisionOf(i.id) === d).length;
    const accuracy: Accuracy = {
      total: items.length,
      byClaim,
      translated: score?.translated.count ?? 0,
      approved: count("approved"),
      pending: count("pending"),
      rejected: count("rejected"),
      flagged: count("flagged"),
      required: required.length,
      requiredOpen,
      ...(score?.landed ? { landed: score.landed.count } : {}),
      ...(score?.live ? { live: score.live.count } : {}),
      ...(score?.success ? { success: score.success.count } : {}),
      panels: { total: items.filter((i) => i.kind === "panel").length, byClaim: claimsOf(items.filter((i) => i.kind === "panel")) },
      monitors: { total: items.filter((i) => i.kind === "alert").length, byClaim: claimsOf(items.filter((i) => i.kind === "alert")) },
    };

    const appliedById = new Map((applyCurrent ? applied!.items : []).map((i) => [i.id, i]));
    const itemsOut: Item[] = items.map((i) => {
      const a = appliedById.get(i.id);
      const l = liveMap?.get(i.id);
      const reasons = [...new Set([...i.reason_codes, ...i.findings.map((f) => f.code)])].map((c) => {
        const rc = report!.reasonCodes[c];
        return rc ? `${c}: ${rc.plain || rc.explanation}` : c;
      });
      return {
        id: i.id,
        kind: i.kind as "panel" | "alert",
        title: i.title || i.widget_type || i.id,
        ...(i.dashboard ? { dashboard: i.dashboard } : {}),
        claim: i.status,
        ...(i.explain?.plain ? { plain: i.explain.plain } : {}),
        datadog: i.source_queries,
        promql: i.promql,
        reasons: [...reasons, ...(i.manual_actions ?? []).map((m) => `to do: ${m}`)],
        decision: decisionOf(i.id),
        widget: i.widget_type,
        ...(i.condition ? { condition: i.condition } : {}),
        required: i.decision_required,
        reviewAs: { approved: reviewDecisionFor(i, "approved"), flagged: reviewDecisionFor(i, "flagged"), rejected: reviewDecisionFor(i, "rejected") },
        ...(a?.target ? { landed: `${a.target.action}, read-back ${a.target.readBack}` } : a && applyCurrent ? { landed: i.kind === "alert" ? "no check rule (not translatable)" : "no target" } : {}),
        ...(l ? { live: l.live, ...(l.cause || l.error ? { liveDetail: l.cause ?? l.error } : {}) } : {}),
      };
    });

    // steps
    const run = this.running?.step;
    const rec = (s: StepId): Partial<Step> => {
      const r = runs[s];
      return r ? { command: r.command, startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}), ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) } : {};
    };
    const planArgs = this.planArgs();
    const planDone = !!report && !!planHash;
    const plan: Step = { id: "plan", state: "idle", ...(planArgs ? { command: this.shownArgs(planArgs) } : {}), ...rec("plan") };
    if (run === "plan") plan.state = "running";
    else if (!planArgs) Object.assign(plan, { state: "blocked", note: "no source: pass --input <dir> or set DD_API_KEY and DD_APP_KEY" });
    else if (runs.plan?.exitCode && runs.plan.exitCode !== 0) Object.assign(plan, { state: "failed", note: `exit ${runs.plan.exitCode}: see the terminal` });
    else if (planDone) Object.assign(plan, { state: "done", note: `${items.length} items, ${accuracy.translated} of ${accuracy.total} translated` });
    else if (report && !planHash) Object.assign(plan, { state: "failed", note: "the plan's files changed since it was written: run Plan again" });

    const review: Step = { id: "review", state: "idle", command: `writes ${this.shown(this.reviewPath)}` };
    if (!planDone) Object.assign(review, { state: "blocked", note: "run Plan first" });
    else if (pendingBounded.length === 0 && reviewExists) Object.assign(review, { state: "done", note: `${required.length - requiredOpen}/${required.length} decided${requiredOpen ? `, ${requiredOpen} monitor/placeholder left open` : ""}` });
    else Object.assign(review, { note: `${required.length - requiredOpen}/${required.length} decided; ${pendingBounded.length} approximate panel(s) need approve or flag` });

    const applyArgs = this.applyArgs();
    const apply: Step = { id: "apply", state: "idle", command: this.shownArgs(applyArgs), ...rec("apply") };
    if (applyRun && !applyRun.endedAt && run !== "apply") delete apply.startedAt;
    if (run === "apply") apply.state = "running";
    else if (!planDone) Object.assign(apply, { state: "blocked", note: "run Plan first" });
    else if (!reviewExists) Object.assign(apply, { state: "blocked", note: "no review yet: decide at least one item (review.json)" });
    else if (pendingBounded.length) Object.assign(apply, { state: "blocked", note: `${pendingBounded.length} approximate panel(s) still pending: apply refuses them` });
    else if (applyRun?.exitCode !== undefined && applyRun.exitCode >= 2 && mtime(this.reviewPath) <= mtime(this.runsPath))
      Object.assign(apply, { state: "failed", note: `refused (exit ${applyRun.exitCode}): see the terminal` });
    else if (applyCurrent) {
      const m = applied!.summary.import!;
      Object.assign(apply, {
        state: applyRun!.exitCode === 0 ? "done" : "failed",
        note: m.mode === "dry-run" ? `dry run: ${m.written} payload(s) written, nothing imported` : `imported ${m.imported}, read back ${m.readBackMatch}, failed ${m.failed}`,
      });
    } else if (applied && planHash && applied.run.planHash === planHash) Object.assign(apply, { note: "the review changed since the last apply: run it again" });

    const watch: Step = { id: "watch", state: "idle", command: "read back from Dash0, last hour of data (src/flow/verify.ts)", ...rec("watch") };
    if (run === "watch") watch.state = "running";
    else if (!this.hasDash0(keys)) Object.assign(watch, { state: "blocked", note: "needs Dash0 keys: set DASH0_API_URL and DASH0_AUTH_TOKEN (and DD_API_KEY, DD_APP_KEY for the Datadog side), in the environment or .env, then restart" });
    else if (!applyCurrent) Object.assign(watch, { state: "blocked", note: "run Apply first" });
    else if (!liveApply) Object.assign(watch, { state: "blocked", note: "the last apply was a dry run: nothing landed in Dash0 to watch" });
    else if (runs.watch?.exitCode) Object.assign(watch, { state: "failed", note: "the live check failed: see the terminal" });
    else if (liveMap) Object.assign(watch, { state: "done", note: `${accuracy.live ?? 0} live; ${accuracy.success ?? 0} of ${accuracy.total} succeeded` });

    const steps = [plan, review, apply, watch];
    const current = run ?? steps.find((s) => s.state !== "done" && s.state !== "blocked")?.id ?? (steps.every((s) => s.state === "done") ? null : steps.find((s) => s.state !== "done")?.id ?? null);

    const src = this.o.inputLabel ?? (this.o.input ? this.shown(resolve(this.cwd, this.o.input)) : this.hasDatadog(keys) ? `Datadog API (${keys.DD_SITE || "datadoghq.eu"})` : "none");
    return {
      version: this.o.version,
      source: src,
      target: this.hasDash0(keys) && !this.o.forceDryRun ? `Dash0 ${keys.DASH0_API_URL} (dataset ${keys.DASH0_DATASET || "default"})` : "dry run (no Dash0 keys): payloads written to disk",
      dryRun: this.dryRun(),
      steps,
      current,
      accuracy,
      items: itemsOut,
      out: this.out,
      ...(planHash ? { planHash } : {}),
      ...(report && planHash ? { outputHash: report.run.outputHash } : {}),
      ...(applyCurrent
        ? {
            applied: {
              mode: applied!.summary.import!.mode as "dry-run" | "live",
              written: applied!.summary.import!.written,
              imported: applied!.summary.import!.imported,
              failed: applied!.summary.import!.failed,
              rejected: applied!.summary.import!.rejected,
              readBackMatch: applied!.summary.import!.readBackMatch,
              dashboards: new Set(applied!.items.filter((i) => i.target?.kind === "dashboard").map((i) => i.target!.dash0Id)).size,
              rules: applied!.items.filter((i) => i.kind === "alert" && i.target && i.target.action !== "skipped-in-review").length,
              placeholders: items.filter((i) => i.kind === "panel" && i.status === "bounded" && reviewDecisionFor(i, decisionOf(i.id)) === "flagged").length,
            },
          }
        : {}),
      keys: { datadog: this.hasDatadog(keys), dash0: this.hasDash0(keys) },
      voice: this.voice,
    };
  }

  // ---------- decisions ----------
  decide(ids: string[], decision: UiDecision, by: By = "ui"): { ok: boolean; error?: string; changed?: number } {
    if (!["approved", "flagged", "rejected", "pending"].includes(decision)) return { ok: false, error: `unknown decision ${String(decision)}` };
    if (this.running?.step === "apply") return { ok: false, error: "apply is running: decisions are locked until it ends" };
    const report = this.report();
    const planHash = report ? this.planHash() : null;
    if (!report || !planHash) return { ok: false, error: "no plan yet: run Plan first" };
    const byId = new Map(report.items.map((i) => [i.id, i]));
    const unknown = ids.filter((id) => !byId.has(id) || (byId.get(id)!.kind !== "panel" && byId.get(id)!.kind !== "alert"));
    if (unknown.length) return { ok: false, error: `not in this plan: ${unknown.slice(0, 5).join(", ")}` };
    const before = this.state().accuracy;
    const dec = this.decisions(planHash);
    let changed = 0;
    for (const id of ids) {
      if ((dec[id]?.decision ?? "pending") === decision) continue;
      if (decision === "pending") delete dec[id];
      else dec[id] = { decision, by, at: now() };
      changed++;
    }
    writeAtomic(this.decisionsPath, JSON.stringify({ planHash, decisions: dec } satisfies DecisionsFile, null, 2) + "\n");
    this.writeReview(report, planHash, dec);
    for (const id of ids) this.emit({ type: "decision", id, decision, by });
    const after = this.state().accuracy;
    this.emit({ type: "accuracy", accuracy: after });
    if (after.translated !== before.translated)
      this.emit({ type: "milestone", text: `Translated is now ${after.translated} of ${after.total} (${after.translated > before.translated ? "up" : "down"} from ${before.translated}).` });
    if (before.requiredOpen > 0 && after.requiredOpen === 0) this.emit({ type: "milestone", text: "Every item that needs a decision has one. Apply is ready." });
    return { ok: true, changed };
  }

  /** review.json in the exact shape `review --terminal` writes (src/pipeline/review-session.ts reviewFile). */
  private writeReview(report: Report, planHash: string, dec: Record<string, DecisionRecord>): void {
    const reportSha256 = sha(readFileSync(join(this.planDir, "report.json")));
    const order = new Map(reviewQueue(report).map((i, n) => [i.id, n]));
    const decisions: ReviewDecision[] = [];
    for (const i of report.items) {
      const d = dec[i.id];
      if (!d) continue;
      const as = reviewDecisionFor(i, d.decision);
      if (as) decisions.push({ id: i.id, decision: as, note: d.by === "voice" ? `decided by voice (${d.decision})` : d.decision === "rejected" ? "rejected in dd2dash0 ui" : "" });
    }
    decisions.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.id < b.id ? -1 : 1));
    const reviewer = this.env.USER || this.env.USERNAME || "dd2dash0 ui";
    const file: ReviewFile = { schema_version: "1", plan_sha256: planHash, report_sha256: reportSha256, reviewer, decisions };
    writeAtomic(this.reviewPath, JSON.stringify(file, null, 2) + "\n");
  }

  // ---------- runs ----------
  isRunning(): StepId | null {
    return this.running?.step ?? null;
  }
  /** Resolves when the current run (if any) ends. */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  run(step: StepId): { ok: boolean; error?: string } {
    if (!STEPS.includes(step)) return { ok: false, error: `unknown step ${String(step)}` };
    if (this.running) return { ok: false, error: `another step is running: ${this.running.step}` };
    const st = this.state().steps.find((s) => s.id === step)!;
    if (step === "review") {
      if (st.state === "blocked") return { ok: false, error: st.note ?? "blocked" };
      this.emit({ type: "milestone", text: `Review: ${st.note ?? ""}.` });
      return { ok: true };
    }
    if (st.state === "blocked") return { ok: false, error: st.note ?? "blocked" };
    if (step === "plan") return this.spawnStep("plan", this.planArgs()!);
    if (step === "apply") return this.spawnStep("apply", this.applyArgs());
    return this.watchStep();
  }

  private spawnStep(step: "plan" | "apply", args: string[]): { ok: boolean; error?: string } {
    if (step === "plan") {
      rmSync(this.planDir, { recursive: true, force: true });
      rmSync(this.watchPath, { force: true });
    }
    const command = this.shownArgs(args);
    const record: RunRecord = { command, args, startedAt: now(), ...(step === "apply" ? { dryRun: this.dryRun() } : {}) };
    this.saveRun(step, record);
    const keys = this.keys();
    const env: NodeJS.ProcessEnv = { ...this.env, ...Object.fromEntries(Object.entries(keys).filter(([, v]) => v)), FORCE_COLOR: "1" };
    delete env.NO_COLOR;
    let child: ChildProcess;
    try {
      child = spawn(this.cli.cmd, [...this.cli.prefix, ...args], { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this.saveRun(step, { ...record, endedAt: now(), exitCode: 1 });
      return { ok: false, error: (e as Error).message };
    }
    const before = this.state().accuracy;
    this.emit({ type: "step", step, state: "running", command });
    this.emit({ type: "line", step, stream: "stdout", text: `\x1b[38;5;141m$ ${command}\x1b[0m` });
    const pipe = (stream: "stdout" | "stderr", src: NodeJS.ReadableStream | null) => {
      let buf = "";
      src?.setEncoding("utf8");
      src?.on("data", (d: string) => {
        buf += d;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const p of parts) this.emit({ type: "line", step, stream, text: p.slice(p.lastIndexOf("\r") + 1) });
      });
      return () => {
        if (buf) this.emit({ type: "line", step, stream, text: buf.slice(buf.lastIndexOf("\r") + 1) });
      };
    };
    const flushOut = pipe("stdout", child.stdout);
    const flushErr = pipe("stderr", child.stderr);
    const done = new Promise<void>((resolveDone) => {
      let finished = false;
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        flushOut();
        flushErr();
        this.saveRun(step, { ...record, endedAt: now(), exitCode: code });
        this.running = null;
        const s = this.state();
        const st = s.steps.find((x) => x.id === step)!;
        this.emit({ type: "step", step, state: code === 0 ? "done" : "failed", command, exitCode: code });
        this.emit({ type: "accuracy", accuracy: s.accuracy });
        this.emit({ type: "milestone", text: this.milestone(step, code, s, before) ?? `${step} ended: ${st.note ?? `exit ${code}`}` });
        resolveDone();
      };
      child.on("error", (e) => {
        this.emit({ type: "line", step, stream: "stderr", text: `could not start the CLI: ${e.message}` });
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
    this.running = { step, child, done };
    return { ok: true };
  }

  private milestone(step: StepId, code: number, s: State, before: Accuracy): string | null {
    const a = s.accuracy;
    if (step === "plan")
      return code === 0
        ? `Plan done: ${a.total} items, ${a.translated} of ${a.total} translated before review. ${a.requiredOpen} need your review.`
        : `Plan failed with exit code ${code}. The terminal shows why.`;
    if (step === "apply") {
      if (code >= 2) return "Apply refused: the review doesn't match the plan or panels are still pending. Nothing was imported.";
      if (!s.applied) return `Apply ended with exit code ${code}.`;
      return s.applied.mode === "dry-run"
        ? `Dry run done: ${s.applied.written} payloads written to disk, nothing imported into Dash0.`
        : `Apply done: ${s.applied.imported} imported, ${s.applied.readBackMatch} read back identical, ${s.applied.failed} failed.${a.success !== undefined ? ` ${a.success} of ${a.total} succeeded.` : ""}`;
    }
    void before;
    return null;
  }

  private watchStep(): { ok: boolean; error?: string } {
    const applied = this.appliedReport();
    if (!applied) return { ok: false, error: "run Apply first" };
    const keys = this.keys();
    const command = "verify: read back from Dash0 and check the last hour of data (src/flow/verify.ts)";
    const record: RunRecord = { command, args: [], startedAt: now() };
    this.saveRun("watch", record);
    this.emit({ type: "step", step: "watch", state: "running", command });
    this.emit({ type: "line", step: "watch", stream: "stdout", text: `\x1b[38;5;141m$ ${command}\x1b[0m` });
    const verify = this.o.verify ?? verifyLive;
    const planHash = this.planHash();
    const done = (async () => {
      let code = 0;
      try {
        const results = await verify(applied.items, {
          dash0: { apiUrl: keys.DASH0_API_URL!, token: keys.DASH0_AUTH_TOKEN!, dataset: keys.DASH0_DATASET || "default" },
          ...(this.hasDatadog(keys) ? { datadog: { site: keys.DD_SITE || "datadoghq.eu", apiKey: keys.DD_API_KEY!, appKey: keys.DD_APP_KEY! } } : {}),
        });
        const counts: Record<string, number> = {};
        for (const [id, r] of results) {
          counts[r.live] = (counts[r.live] ?? 0) + 1;
          if (r.live === "missing" || r.live === "error") this.emit({ type: "line", step: "watch", stream: "stdout", text: `  \x1b[31m✗\x1b[0m ${r.live.padEnd(8)} ${id}${r.cause || r.error ? `  (${r.cause ?? r.error})` : ""}` });
        }
        this.emit({ type: "line", step: "watch", stream: "stdout", text: `  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("  ")}` });
        writeAtomic(this.watchPath, JSON.stringify({ planHash, at: now(), results: Object.fromEntries(results) }, null, 2) + "\n");
      } catch (e) {
        code = 1;
        this.emit({ type: "line", step: "watch", stream: "stderr", text: `live check failed: ${(e as Error).message}` });
      }
      this.saveRun("watch", { ...record, endedAt: now(), exitCode: code });
      this.running = null;
      const s = this.state();
      this.emit({ type: "step", step: "watch", state: code === 0 ? "done" : "failed", command, exitCode: code });
      this.emit({ type: "accuracy", accuracy: s.accuracy });
      this.emit({ type: "milestone", text: code === 0 ? `Live check done: ${s.accuracy.live ?? 0} items return data in Dash0. ${s.accuracy.success ?? 0} of ${s.accuracy.total} succeeded.` : "The live check failed. The terminal shows why." });
    })();
    this.running = { step: "watch", done };
    return { ok: true };
  }

  /** Stop a running child (server shutdown). */
  stop(): void {
    this.running?.child?.kill();
  }
}
