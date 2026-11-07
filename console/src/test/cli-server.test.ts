import { describe, expect, it } from "vitest";
import cliReport from "@/test/fixtures/cli-report.redis.json?raw";
import { parseReport } from "@/lib/report";
import { emptyReview } from "@/lib/review";
import { cliReviewJson, fetchCliPlan, saveReviewToCli } from "@/lib/cli-server";

const report = (() => {
  const r = parseReport(cliReport);
  if (!r.ok) throw new Error(r.error);
  return r.report;
})();
const plan = {
  planHash: "p".repeat(64),
  reportSha256: "r".repeat(64),
  reviewOrder: [],
  decided: 0,
};
const res = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

describe("dd2dash0 review server client", () => {
  it("binds to the plan only when the loaded report is the plan's report", () => {
    const state = { ...emptyReview(), reviewer: "m" };
    expect(cliReviewJson(report, plan.reportSha256, state, plan)).toMatchObject({
      plan_sha256: plan.planHash,
      report_sha256: plan.reportSha256,
    });
    expect(cliReviewJson(report, "x".repeat(64), state, plan)).not.toHaveProperty("plan_sha256");
  });

  it("detects the CLI server and falls back to null on a static host", async () => {
    expect(await fetchCliPlan(() => res(200, plan))).toEqual(plan);
    expect(await fetchCliPlan(() => res(404, {}))).toBeNull();
    expect(await fetchCliPlan(() => Promise.reject(new Error("offline")))).toBeNull();
    expect(await fetchCliPlan(() => res(200, { hello: 1 }))).toBeNull();
  });

  it("reports a saved review and a refused one", async () => {
    const ok = await saveReviewToCli({}, () =>
      res(200, {
        ok: true,
        file: "/tmp/plan/review.json",
        pending: ["a"],
        skippedAlerts: [],
        warnings: [],
      }),
    );
    expect(ok).toEqual({
      ok: true,
      file: "/tmp/plan/review.json",
      pending: ["a"],
      skippedAlerts: [],
      warnings: [],
    });
    const refused = await saveReviewToCli({}, () =>
      res(409, {
        error: "review does not fit this plan",
        problems: [{ code: "plan.mismatch", message: "made for another plan" }],
      }),
    );
    expect(refused).toEqual({
      ok: false,
      error: "review does not fit this plan",
      problems: ["made for another plan"],
    });
  });
});
