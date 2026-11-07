import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  durationMs,
  fromDatadog,
  parity,
  plannedAlerts,
  ruleValueExpr,
  runWatch,
  stateFromValue,
  Timeline,
  verdictLine,
  type WatchEvent,
} from "../../src/pipeline/watch.js";
import { listPlanFiles } from "../../src/pipeline/plan-lock.js";

const T0 = Date.parse("2026-11-08T14:00:00Z");
const ev = (side: "datadog" | "dash0", to: WatchEvent["to"], s: number): WatchEvent => ({
  side,
  alertId: "a",
  from: null,
  to,
  at: new Date(T0 + s * 1000).toISOString(),
  method: side === "datadog" ? "api" : "computed",
});
const BOUND = 125_000; // 2 x 1m + 5s

describe("parity verdict", () => {
  it("passes when both fire at the same severity within the bound, and both recover", () => {
    const p = parity([ev("datadog", "ok", 0), ev("dash0", "ok", 0), ev("datadog", "failed", 130), ev("dash0", "failed", 151), ev("dash0", "ok", 400), ev("datadog", "ok", 420)], "a", BOUND);
    expect(p.verdict).toBe("pass");
    expect(p.fireGapMs).toBe(21_000);
    expect(p.recoverGapMs).toBe(20_000);
    expect(verdictLine(p, "[Redis] High memory")).toBe(
      "[Redis] High memory: Datadog failed at 14:02:10, Dash0 failed (computed) at 14:02:31, 21 s apart (bound 125 s): PASS.",
    );
  });

  it("fails on a gap over the bound", () => {
    const p = parity([ev("datadog", "failed", 0), ev("dash0", "failed", 200)], "a", BOUND);
    expect(p.verdict).toBe("fail");
    expect(p.reasons[0]).toMatch(/over the 125 s bound/);
  });

  it("fails on a severity mismatch", () => {
    const p = parity([ev("datadog", "failed", 0), ev("dash0", "degraded", 10)], "a", BOUND);
    expect(p.reasons).toContain("severity differs: Datadog failed, Dash0 degraded");
  });

  it("fails when one side never fires, and says which", () => {
    expect(parity([ev("datadog", "degraded", 0), ev("dash0", "ok", 0)], "a", BOUND).reasons).toEqual(["Datadog fired, Dash0 never did"]);
    expect(parity([ev("datadog", "ok", 0), ev("dash0", "failed", 0)], "a", BOUND).reasons).toEqual(["Dash0 fired, Datadog never did"]);
  });

  it("reports no incident when nothing fired", () => {
    expect(parity([ev("datadog", "ok", 0), ev("dash0", "ok", 0)], "a", BOUND).verdict).toBe("no-incident");
  });

  it("measures the gap at the peak: warn then alert on both sides", () => {
    const p = parity([ev("datadog", "degraded", 0), ev("datadog", "failed", 60), ev("dash0", "degraded", 5), ev("dash0", "failed", 70)], "a", BOUND);
    expect(p.verdict).toBe("pass");
    expect(p.fireGapMs).toBe(10_000);
  });
});

describe("timeline and state helpers", () => {
  it("records only state changes", () => {
    const tl = new Timeline();
    const at = new Date(T0);
    expect(tl.record("datadog", "a", "ok", at, "api")).not.toBeNull();
    expect(tl.record("datadog", "a", "ok", at, "api")).toBeNull();
    expect(tl.record("dash0", "a", "ok", at, "computed")).not.toBeNull();
    expect(tl.record("datadog", "a", "failed", at, "api")?.from).toBe("ok");
    expect(tl.events).toHaveLength(3);
  });

  it("maps Datadog states and computes the Dash0 state from the rule", () => {
    expect([fromDatadog("OK"), fromDatadog("Warn"), fromDatadog("Alert"), fromDatadog("No Data"), fromDatadog("Skipped")]).toEqual(["ok", "degraded", "failed", "nodata", "unknown"]);
    expect(ruleValueExpr("avg_over_time(x[5m:1m]) > $__threshold")).toBe("avg_over_time(x[5m:1m])");
    expect(ruleValueExpr("x > 3")).toBeNull();
    const th = { degraded: 70, failed: 90 };
    expect([stateFromValue(null, ">", th), stateFromValue(50, ">", th), stateFromValue(75, ">", th), stateFromValue(95, ">", th)]).toEqual(["nodata", "ok", "degraded", "failed"]);
    expect(stateFromValue(5, "<", { failed: 10 })).toBe("failed");
    expect([durationMs("5s"), durationMs("1m"), durationMs("30m"), durationMs("250ms")]).toEqual([5000, 60_000, 1_800_000, 250]);
    expect(() => durationMs("5")).toThrow();
  });
});

function fakePlan(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  mkdirSync(join(dir, "dash0", "check-rules"), { recursive: true });
  writeFileSync(
    join(dir, "dash0", "check-rules", "r1.json"),
    JSON.stringify({ id: "r1", name: "[Redis] High memory consumption", expression: "mem_pct > $__threshold", interval: "1m", thresholds: { degraded: 70, failed: 90 }, labels: { dd_monitor_id: "redisdb__high_mem" } }),
  );
  writeFileSync(join(dir, "report.json"), JSON.stringify({ items: [{ id: "dd-monitor-redisdb__high_mem", kind: "alert", target: { dash0Id: "r1" } }] }));
  return dir;
}

describe("runWatch", () => {
  it("polls both sides, writes timeline + parity, and stops once both recovered", async () => {
    const plan = fakePlan();
    const [a] = plannedAlerts(plan, ["high_mem"]);
    expect(a!.ddMonitorId).toBeNull(); // fixture plan: no numeric id, looked up or passed with --dd-monitor
    // A scripted incident: Datadog goes OK -> Alert -> OK; the Dash0 query value rises and falls one poll later.
    const dd = ["OK", "OK", "Alert", "Alert", "OK", "OK"];
    const val = [40, 40, 40, 95, 95, 40];
    let tick = 0;
    const f = (async (url: string | URL) => {
      const u = String(url);
      const body = u.includes("datadoghq") ? { overall_state: dd[tick], options: {} } : { data: { result: [{ value: [0, String(val[tick])] }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const lines: string[] = [];
    const res = await runWatch({
      planDir: plan,
      alerts: [{ ...a!, ddMonitorId: "123" }],
      dd: { site: "datadoghq.eu", apiKey: "k", appKey: "a" },
      dash0: { apiUrl: "https://api.example.dash0.com", token: "t" },
      everyMs: 5000,
      maxMs: 3_600_000,
      untilRecovered: true,
      fetch: f,
      now: () => new Date(T0 + tick * 5000),
      sleep: async () => void tick++,
      print: (l) => lines.push(l),
    });
    expect(res.ok).toBe(true);
    expect(res.parity[0]).toMatchObject({ verdict: "pass", fireGapMs: 5000, recoverGapMs: 5000 });
    expect(res.timeline.map((e) => `${e.side}:${e.to}`)).toEqual(["datadog:ok", "dash0:ok", "datadog:failed", "dash0:failed", "datadog:ok", "dash0:ok"]);
    expect(JSON.parse(readFileSync(res.files.parity, "utf8")).results[0].verdict).toBe("pass");
    expect(lines.at(-1)).toMatch(/PASS/);
    expect(lines.join("\n")).not.toMatch(/\bk\b.*\bt\b/); // no keys printed
  });

  it("an API that never answers is an API error, not a verdict (exit 3)", async () => {
    const plan = fakePlan();
    const [a] = plannedAlerts(plan, ["high_mem"]);
    let tick = 0;
    const f = (async (url: string | URL) =>
      String(url).includes("datadoghq") ? new Response(JSON.stringify({ overall_state: "OK", options: {} }), { status: 200 }) : new Response("nope", { status: 401 })) as typeof fetch;
    const res = await runWatch({
      planDir: plan,
      alerts: [{ ...a!, ddMonitorId: "123" }],
      dd: { site: "datadoghq.eu", apiKey: "k", appKey: "a" },
      dash0: { apiUrl: "https://api.example.dash0.com", token: "t" },
      everyMs: 5000,
      maxMs: 10_000,
      untilRecovered: false,
      fetch: f,
      now: () => new Date(T0 + tick * 5000),
      sleep: async () => void tick++,
    });
    expect(res.ok).toBe(false);
    expect(res.apiError).toMatch(/dash0 never answered \(Dash0 query -> 401\)/);
    expect(res.apiError).not.toMatch(/datadog/);
  });
  it("watch/ output is not part of the plan lock", () => {
    const plan = fakePlan();
    mkdirSync(join(plan, "watch"));
    writeFileSync(join(plan, "watch", "timeline.json"), "{}");
    expect(listPlanFiles(plan).some((p) => p.startsWith("watch/"))).toBe(false);
  });
});
