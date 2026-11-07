// dd2dash0 review: the shared queue, the terminal review, the review server, and server -> apply end to end.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runApply } from "../../src/pipeline/apply.js";
import { resolveConfig } from "../../src/pipeline/config.js";
import { runPlan } from "../../src/pipeline/plan.js";
import { readLock } from "../../src/pipeline/plan-lock.js";
import { reviewQueue } from "../../src/pipeline/review-session.js";
import { terminalReview } from "../../src/pipeline/review-terminal.js";
import type { Report } from "../../src/report/types.js";
import { startReviewServer } from "../../src/serve/review.js";

const ROOT = join(import.meta.dirname, "..", "..");
async function makePlan() {
  const work = mkdtempSync(join(tmpdir(), "dd2dash0-rv-"));
  cpSync(join(ROOT, "fixtures", "datadog"), join(work, "src"), { recursive: true });
  const planDir = join(work, "plan");
  await runPlan({ config: resolveConfig({ source: { kind: "folder", path: "src" } }, {}, {}), outDir: planDir, defaultMappingsDir: join(ROOT, "mappings"), resolvedInput: join(work, "src"), version: "test" });
  return { work, planDir, report: JSON.parse(readFileSync(join(planDir, "report.json"), "utf8")) as Report };
}

describe("review queue", () => {
  it("only items that need a decision, manual -> unsupported -> bounded, alerts first", async () => {
    const { report } = await makePlan();
    const q = reviewQueue(report);
    expect(q.every((i) => i.status === "manual" || i.status === "unsupported" || i.status === "bounded" || i.kind === "alert")).toBe(true);
    expect(q.some((i) => i.status === "exact-under" && i.kind === "panel")).toBe(false);
    const rank = { manual: 0, unsupported: 1, bounded: 2, "exact-under": 3 } as Record<string, number>;
    for (let n = 1; n < q.length; n++) expect(rank[q[n - 1]!.status]! <= rank[q[n]!.status]!).toBe(true);
    expect(q[0]!.kind).toBe("alert");
    expect(reviewQueue(report).map((i) => i.id)).toEqual(q.map((i) => i.id)); // deterministic
  });
});

describe("terminal review", () => {
  it("records decisions as you go, re-asks on a wrong key, takes a note when flagging, resumes after quitting", async () => {
    const { planDir, report } = await makePlan();
    const q = reviewQueue(report);
    const firstBounded = q.findIndex((i) => i.status === "bounded");
    const lines: string[] = [];
    const keys = [...q.slice(0, firstBounded).map(() => "k"), "x", "f", "values look off", "q"];
    const io = { ask: async () => keys.shift() ?? null, print: (l: string) => lines.push(l) };
    const r1 = await terminalReview(planDir, "tester", io);
    expect(r1.quit).toBe(true);
    expect(lines.some((l) => l.includes("choose one of: [a]pprove, [f]lag"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(planDir, "review.json"), "utf8"));
    expect(saved.plan_sha256).toBe(readLock(planDir).planHash);
    expect(saved.decisions).toHaveLength(firstBounded + 1);
    expect(saved.decisions.at(-1)).toEqual({ id: q[firstBounded]!.id, decision: "flagged", note: "values look off" });

    const lines2: string[] = [];
    await terminalReview(planDir, "tester", { ask: async () => "q", print: (l) => lines2.push(l) });
    expect(lines2[0]).toContain(`${firstBounded + 1} already decided (resumed from review.json)`);
  });

  it("refuses a plan whose files changed", async () => {
    const { planDir } = await makePlan();
    writeFileSync(join(planDir, "report.md"), "edited");
    await expect(terminalReview(planDir, "t", { ask: async () => "q", print: () => {} })).rejects.toThrow(/plan changed/);
  });
});

describe("review server", () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("serves the plan, checks and saves a console review, refuses bad ones, then apply uses it", async () => {
    const { work, planDir, report } = await makePlan();
    const consoleDir = join(work, "console");
    mkdirSync(join(consoleDir, "assets"), { recursive: true });
    writeFileSync(join(consoleDir, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(consoleDir, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(work, "secret.txt"), "nope");
    const { server, url } = await startReviewServer({ planDir, port: 0, consoleDir, reviewer: "srv" });
    servers.push(server);

    const bytes = await (await fetch(url + "report.json")).arrayBuffer();
    expect(Buffer.from(bytes).equals(readFileSync(join(planDir, "report.json")))).toBe(true);
    const plan = (await (await fetch(url + "api/plan")).json()) as { planHash: string; reportSha256: string; reviewOrder: string[] };
    expect(plan.planHash).toBe(readLock(planDir).planHash);
    expect(plan.reviewOrder).toEqual(reviewQueue(report).map((i) => i.id));
    expect(await (await fetch(url + "assets/app.js")).text()).toBe("console.log(1)");
    expect(await (await fetch(url + "items/whatever")).text()).toContain("<title>console</title>"); // SPA fallback
    expect((await fetch(url + "..%2Fsecret.txt")).status).toBe(404);
    expect((await fetch(url + "review.json")).status).toBe(404);

    // A console-style review: bound by report_sha256 only (what today's console exports).
    const decisions = reviewQueue(report).map((i) =>
      i.status === "bounded" ? { id: i.id, decision: "approved", note: "" } : i.kind === "alert" && i.status !== "manual" ? { id: i.id, decision: "approved", note: "" } : { id: i.id, decision: "acknowledged", note: "" },
    );
    const reportSha = createHash("sha256").update(readFileSync(join(planDir, "report.json"))).digest("hex");
    const post = (body: unknown) => fetch(url + "api/review", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await post("{not json")).status).toBe(400);
    const bad = await post({ schema_version: "1", report_sha256: reportSha, decisions: [{ id: decisions[0]!.id, decision: "approved" }] });
    expect(bad.status).toBe(409); // approving a manual item isn't allowed
    const ok = await post({ schema_version: "1", report_sha256: reportSha, reviewer: "web", decisions });
    expect(ok.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(planDir, "review.json"), "utf8"));
    expect(saved).toMatchObject({ plan_sha256: plan.planHash, reviewer: "web" }); // the server binds it to the plan
    expect((await fetch(url + "review.json")).status).toBe(200);

    const applied = await runApply({ planDir, reviewFile: join(planDir, "review.json"), dryRun: true, cwd: work });
    expect(applied.kind).toBe("done");
    if (applied.kind === "done") expect(applied.imported.rules).toBe(2);
    expect(existsSync(join(planDir, "apply", "report.json"))).toBe(true);
  });

  it("serves the live watch files for the Incident view (404 before a watch, the JSON once there is one)", async () => {
    const { planDir } = await makePlan();
    const { server, url } = await startReviewServer({ planDir, port: 0 });
    servers.push(server);
    const none = await fetch(url + "api/watch");
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toMatch(/dd2dash0 watch/);
    mkdirSync(join(planDir, "watch"), { recursive: true });
    const timeline = { schema: "dd2dash0.watch/v1", startedAt: "2026-11-08T14:00:00.000Z", endedAt: "2026-11-08T14:01:00.000Z", events: [], samples: [{ alertId: "a", at: "2026-11-08T14:00:00.000Z", value: 61 }] };
    writeFileSync(join(planDir, "watch", "timeline.json"), JSON.stringify(timeline));
    const res = await fetch(url + "api/watch");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ timeline, parity: null });
    writeFileSync(join(planDir, "watch", "timeline.json"), '{"half":');
    expect((await fetch(url + "api/watch")).status).toBe(503);
  });

  it("without a built console, / explains how to build it", async () => {
    const { planDir } = await makePlan();
    const { server, url } = await startReviewServer({ planDir, port: 0 });
    servers.push(server);
    expect(await (await fetch(url)).text()).toContain("npx bun run build");
  });
});
