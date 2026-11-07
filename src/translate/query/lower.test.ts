import { describe, expect, it } from "vitest";
import { parseFormula, parseMonitorQuery, parseQuery } from "../../parse/index.js";
import type { Expr } from "../../parse/index.js";
import { validatePromQL } from "../../validate/promql.js";
import { RULES, translateMonitor, translateQuery } from "./index.js";
import type { MetricMapping, TranslateContext } from "./index.js";

const METRICS: Record<string, MetricMapping> = {
  "redis.mem.used": { otel: "redis.memory.used", kind: "gauge" },
  "redis.mem.maxmemory": { otel: "redis.maxmemory", kind: "gauge" },
  "system.cpu.user": { otel: "system.cpu.utilization", kind: "gauge" },
  "nginx.requests": { otel: "nginx.requests", kind: "counter" },
  "app.events": { otel: "app.events", kind: "delta" },
  "http.duration": { otel: "http.server.request.duration", kind: "histogram" },
};
const CTX: TranslateContext = {
  metric: (n) => METRICS[n],
  tag: (t) => ({ host: "host_name", env: "deployment_environment_name", service: "service_name" })[t],
  variables: { host: { tag: "host" }, scope: { tag: null } },
};

function q(src: string, ctx: TranslateContext = CTX) {
  const p = parseQuery(src);
  if (!p.ok) throw new Error(p.error.message);
  return translateQuery(p.value, ctx);
}
function mon(src: string, opts: { critical?: number; warning?: number } = {}, ctx: TranslateContext = CTX) {
  const p = parseMonitorQuery(src);
  if (!p.ok) throw new Error(p.error.message);
  return translateMonitor(p.value, opts, ctx);
}

const SEL = (name: string, extra = "") => `{otel_metric_name="${name}"${extra}}`;
const used = new Set<string>();
const track = <T extends { rules: string[] }>(r: T): T => {
  r.rules.forEach((x) => used.add(x));
  return r;
};

/** [rule under test, Datadog query, expected PromQL, expected status] */
const CASES: [string, string, string, string][] = [
  ["select.metric.mapped", "avg:system.cpu.user{*}", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["select.metric.unmapped", "avg:foo.bar{*}", `avg (avg_over_time(${SEL("foo.bar")}[$__interval]))`, "exact-under"],
  ["scope.all", "sum:system.cpu.user{*}", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["scope.tag.eq", "avg:system.cpu.user{env:prod}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name="prod"')}[$__interval]))`, "exact-under"],
  ["scope.tag.neq", "avg:system.cpu.user{!env:dev}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!="dev"')}[$__interval]))`, "exact-under"],
  ["scope.tag.wildcard", "avg:system.cpu.user{host:web-*.a}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', host_name=~"^web-.*\\\\.a$"')}[$__interval]))`, "exact-under"],
  ["scope.in", "avg:system.cpu.user{env IN (prod,stage)}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^(prod|stage)$"')}[$__interval]))`, "exact-under"],
  ["scope.or.same-key", "avg:system.cpu.user{env:prod OR env:stage}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^(prod|stage)$"')}[$__interval]))`, "exact-under"],
  ["scope.not", "avg:system.cpu.user{NOT env:dev}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!="dev"')}[$__interval]))`, "exact-under"],
  ["scope.var", "avg:redis.mem.used{$host} by {host}", `avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"$host"')}[$__interval]))`, "exact-under"],
  ["time.rollup.default", "max:system.cpu.user{*}", `max (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.rollup.explicit", "avg:redis.mem.used{*} by {host}.rollup(max, 300)", `avg by (host_name) (max_over_time(${SEL("redis.memory.used")}[5m]))`, "exact-under"],
  ["time.as_count.gauge", "sum:system.cpu.user{*}.as_count()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_rate.gauge", "sum:system.cpu.user{*}.as_rate()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_count.delta", "sum:app.events{*}.as_count()", `sum (sum_over_time(${SEL("app.events")}[$__interval]))`, "exact-under"],
  ["time.as_count.counter", "sum:nginx.requests{*} by {host}.as_count()", `sum by (host_name) (increase(${SEL("nginx.requests")}[$__interval]))`, "bounded"],
  ["time.as_rate.counter", "sum:nginx.requests{*}.as_rate()", `sum (rate(${SEL("nginx.requests")}[$__interval]))`, "bounded"],
  ["time.fill.null", "avg:system.cpu.user{*}.fill(null)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["space.agg", "count:system.cpu.user{*} by {host,env}", `count by (deployment_environment_name, host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["space.default-avg", "system.cpu.user{*}", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["map.abs", "abs(avg:system.cpu.user{*})", `abs(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.log2", "log2(avg:system.cpu.user{*})", `log2(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.log10", "log10(avg:system.cpu.user{*})", `log10(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.clamp_min", "clamp_min(avg:system.cpu.user{*}, 0)", `clamp_min(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])), 0)`, "exact-under"],
  ["map.clamp_max", "clamp_max(avg:system.cpu.user{*}, 100)", `clamp_max(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])), 100)`, "exact-under"],
  ["map.timeshift", "timeshift(avg:system.cpu.user{*}, -3600)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval] offset 1h))`, "exact-under"],
  ["arith.number", "100 * avg:system.cpu.user{*}", `100 * avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["arith.same-groups", "avg:redis.mem.used{*} by {host} - avg:redis.mem.maxmemory{*} by {host}", `avg by (host_name) (avg_over_time(${SEL("redis.memory.used")}[$__interval])) - avg by (host_name) (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`, "exact-under"],
  ["arith.div", "avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*}", `avg (avg_over_time(${SEL("redis.memory.used")}[$__interval])) / avg (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`, "exact-under"],
  ["arith.neg", "-avg:system.cpu.user{*}", `-avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
];

describe("rule table: one exact PromQL string per rule", () => {
  for (const [rule, src, promql, status] of CASES) {
    it(`${rule}: ${src}`, () => {
      const r = track(q(src));
      expect(r.findings.filter((f) => f.severity === "unsupported" || f.severity === "error")).toEqual([]);
      expect(r.promql).toBe(promql);
      expect(r.rules).toContain(rule);
      expect(r.status).toBe(status);
      expect(validatePromQL(r.promql!).ok).toBe(true);
    });
  }

  it("unmapped metric warns and records the gauge assumption", () => {
    const r = q("avg:foo.bar{*}");
    expect(r.findings).toMatchObject([{ severity: "warn", code: "metric.unmapped" }]);
    expect(r.assumptions).toContain("A.kind-gauge");
  });

  it("free-form $scope is dropped under the A.var-default assumption", () => {
    const r = track(q("avg:redis.mem.used{$scope,$host} by {host}"));
    expect(r.promql).toBe(`avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"$host"')}[$__interval]))`);
    expect(r.assumptions).toContain("A.var-default");
    expect(r.findings).toMatchObject([{ code: "scope.var.free-form" }]);
  });

  it("interval can be fixed per dashboard", () => {
    expect(q("avg:system.cpu.user{*}", { ...CTX, interval: 60 }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization")}[1m]))`,
    );
  });

  it("is deterministic: same input, same bytes", () => {
    const src = "avg:redis.mem.used{env:prod,$host,service:a} by {service,host}";
    expect(q(src).promql).toBe(q(src).promql);
    expect(q(src).promql).toBe(q("avg:redis.mem.used{service:a,$host,env:prod} by {host,service}").promql);
  });
});

describe("formulas", () => {
  it("substitutes query refs and keeps Datadog's arithmetic", () => {
    const env = new Map<string, Expr>();
    for (const [k, s] of [
      ["query1", "avg:redis.mem.used{*} by {host}"],
      ["query2", "max:redis.mem.maxmemory{*} by {host}"],
    ] as const) {
      const p = parseQuery(s);
      if (p.ok) env.set(k, p.value);
    }
    const f = parseFormula("100 * query1 / query2");
    if (!f.ok) throw new Error();
    const r = translateQuery(f.value, CTX, env);
    expect(r.promql).toBe(
      `100 * avg by (host_name) (avg_over_time(${SEL("redis.memory.used")}[$__interval])) / max by (host_name) (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`,
    );
    expect(r.status).toBe("exact-under");
  });

  it("an unknown ref is manual", () => {
    const f = parseFormula("query9 * 2");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, CTX, new Map())).toMatchObject({ status: "manual", promql: null });
  });
});

describe("fail closed: manual, no PromQL, original kept", () => {
  for (const [code, src] of [
    ["fn.anomalies", "anomalies(avg:system.cpu.user{*}, 'basic', 2)"],
    ["fn.top", "top(avg:system.cpu.user{*} by {host}, 10, 'mean', 'desc')"],
    ["fn.per_second", "per_second(sum:nginx.requests{*})"],
    ["time.fill", "avg:system.cpu.user{*}.fill(zero)"],
    ["time.kind", "sum:nginx.requests{*}"],
    ["time.kind", "avg:http.duration{*}"],
    ["space.agg", "p99:system.cpu.user{*}"],
    ["scope.bare-tag", "avg:system.cpu.user{canary}"],
    ["scope.or.cross-key", "avg:system.cpu.user{env:prod OR host:a}"],
    ["scope.same-key", "avg:system.cpu.user{host:a,host:b}"],
    ["arith.group-mismatch", "avg:redis.mem.used{*} by {host} / avg:redis.mem.maxmemory{*}"],
    ["query.value-filter", "count(v: v>=0):system.cpu.user{*}"],
    ["time.kind-unknown", "sum:unmapped.hits{*}.as_count()"],
  ] as const) {
    it(`${code}: ${src}`, () => {
      const r = q(src);
      expect(r.status).toBe("manual");
      expect(r.promql).toBeNull();
      expect(r.findings.some((f) => f.severity === "unsupported" && f.code === code)).toBe(true);
    });
  }
});

describe("monitors", () => {
  it("redis high_mem: the evaluator's exact subquery form (maths.md §5)", () => {
    const r = track(mon("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90", { critical: 90, warning: 70 }));
    expect(r.promql).toBe(
      `avg_over_time((100 * avg (avg_over_time(${SEL("redis.memory.used")}[1m])) / avg (avg_over_time(${SEL("redis.maxmemory")}[1m])))[5m:1m]) > $__threshold`,
    );
    expect(r.thresholds).toEqual({ failed: 90, degraded: 70 });
    expect(r.negated).toBe(false);
    expect(r.status).toBe("exact-under");
    expect(r.assumptions).toEqual(["A.boundary", "A.monitor-rollup-60s", "A.nonzero-denominator"]);
    expect(r.rules).toEqual(expect.arrayContaining(["monitor.window", "monitor.cmp.gt", "time.rollup.monitor-bucket"]));
  });

  it("< becomes a negated > with negated thresholds (maths.md T7)", () => {
    const r = track(mon("min(last_15m):avg:system.cpu.user{*} by {host} < 10", { critical: 10, warning: 20 }));
    expect(r.promql).toBe(
      `-min_over_time((avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[1m])))[15m:1m]) > $__threshold`,
    );
    expect(r.thresholds).toEqual({ failed: -10, degraded: -20 });
    expect(r.negated).toBe(true);
  });

  it(">= keeps >=; missing warning means no degraded threshold", () => {
    const r = mon("max(last_1h):max:system.cpu.user{env:prod} >= 95");
    expect(r.promql?.endsWith(">= $__threshold")).toBe(true);
    expect(r.thresholds).toEqual({ failed: 95 });
  });

  it("warns when options.thresholds.critical disagrees with the query", () => {
    const r = mon("avg(last_5m):avg:system.cpu.user{*} > 90", { critical: 80 });
    expect(r.thresholds).toEqual({ failed: 90 });
    expect(r.findings.some((f) => f.code === "monitor.threshold.mismatch")).toBe(true);
  });

  for (const [code, src] of [
    ["monitor.change", "change(avg(last_5m),last_5m):avg:system.cpu.user{*} > 10"],
    ["monitor.window.kind", "max(next_12h):avg:system.cpu.user{*} > 1"],
    ["monitor.cmp", "avg(last_5m):avg:system.cpu.user{*} == 0"],
    ["fn.anomalies", "avg(last_1h):anomalies(avg:system.cpu.user{*}, 'basic', 2) >= 1"],
    ["time.rollup.monitor-width", "avg(last_5m):avg:system.cpu.user{*}.rollup(avg, 300) > 1"],
  ] as const) {
    it(`manual: ${code}`, () => {
      const r = mon(src);
      expect(r).toMatchObject({ status: "manual", promql: null, thresholds: null });
      expect(r.findings.some((f) => f.code === code)).toBe(true);
    });
  }
});

describe("coverage of the rule table", () => {
  it("every non-manual rule is exercised by a test above", () => {
    const missing = Object.keys(RULES).filter((r) => !used.has(r));
    expect(missing).toEqual([]);
  });
});
