import { describe, expect, it } from "vitest";
import cliReport from "./fixtures/cli-report.redis.json?raw";
import { parseReport, widgetBreakdown, isTranslatedMonitor } from "@/lib/report";
import { importPlan, planText } from "@/lib/review";
import { explainCode } from "@/lib/reason-codes";
import { thresholdsText, verdictCopy } from "@/lib/presentation";

const load = () => {
  const r = parseReport(cliReport);
  if (!r.ok) throw new Error(r.error);
  return r.report;
};

describe("monitor counts come from what was translated", () => {
  it("counts a manual monitor as a monitor but not as a check rule", () => {
    const rep = load();
    const monitors = rep.items.filter((i) => i.kind === "monitor");
    const b = widgetBreakdown(rep.items);
    expect(b.checkRules).toBe(monitors.length);
    expect(b.checkRulesTranslated).toBe(monitors.filter(isTranslatedMonitor).length);
    expect(b.checkRulesTranslated).toBeLessThanOrEqual(b.checkRules);
  });
  it("the plan line counts only translated monitors as check rules", () => {
    const rep = load();
    const plan = importPlan(rep, { reviewer: "", decisions: {} } as never);
    expect(plan.checkRules.total).toBe(widgetBreakdown(rep.items).checkRulesTranslated);
    if (plan.checkRules.total === 0) expect(planText(plan)).toContain("0 check rules");
  });
});

describe("no placeholder wording for missing data", () => {
  it("thresholds text shows only the numbers present, never n/a", () => {
    expect(thresholdsText(undefined)).toBeUndefined();
    expect(thresholdsText({ degraded: null, failed: null })).toBeUndefined();
    expect(thresholdsText({ degraded: 80, failed: 90 })).toBe("Warning 80%, critical 90%");
    expect(thresholdsText({ degraded: null, failed: 90 })).toBe("critical 90%");
  });
  it("a monitor verdict never says widget or placeholder", () => {
    const text = verdictCopy({ kind: "monitor", status: "unsupported" });
    expect(text).not.toMatch(/widget|placeholder/i);
    expect(verdictCopy({ kind: "widget", status: "unsupported" })).toMatch(/widget/);
  });
  it("explains every fn.* code and leaves unknown codes unexplained (no filler sentence)", () => {
    expect(explainCode("fn.anomalies")).toMatch(/anomalies\(\)/);
    expect(explainCode("totally.unknown")).toBeUndefined();
  });
});
