import { describe, expect, it } from "vitest";
import { parseFormula, parseMonitorQuery, parseQuery } from "../../src/parse/index.js";
import type { Expr } from "../../src/parse/index.js";
import { validatePromQL } from "../../src/validate/promql.js";
import { RULES, translateMonitor, translateQuery } from "../../src/translate/query/index.js";
import type { MetricAvailability, MetricMapping, TranslateContext } from "../../src/translate/query/index.js";

const METRICS: Record<string, MetricMapping> = {
  "redis.mem.used": { otel: "redis.memory.used", kind: "gauge" },
  "redis.mem.maxmemory": { otel: "redis.maxmemory", kind: "gauge" },
  "system.cpu.user": { otel: "system.cpu.utilization", kind: "gauge" },
  "nginx.requests": { otel: "nginx.requests", kind: "counter" },
  "app.events": { otel: "app.events", kind: "delta" },
  "http.duration": { otel: "http.server.request.duration", kind: "histogram" },
  // Shaped like T1's metricLookup() output (PR #4), taken from mappings/datadog/redisdb.yaml.
  "redis.cpu.sys": { otel: "redis.cpu.time", kind: "counter", ddKind: "rate", labels: { state: "sys" }, status: "exact" },
  "redis.net.commands": { otel: "redis.commands.processed", kind: "counter", ddKind: "rate", status: "exact" },
  "redis.net.clients": { otel: "redis.clients.connected", kind: "gauge", ddKind: "gauge", status: "exact" },
  "redis.dd.gauge_on_counter": { otel: "redis.connections.received", kind: "counter", ddKind: "gauge", status: "exact" },
  "redis.dd.approx": { otel: "redis.memory.rss", kind: "gauge", ddKind: "gauge", status: "approximate", note: "RSS vs used" },
  "redis.dd.count": { otel: "redis.keys.evicted", kind: "counter", ddKind: "count", status: "exact" },
  // Datadog stores these running totals as gauges; the OTel receiver emits counters (as in redisdb.yaml).
  "redis.keys.evicted": { otel: "redis.keys.evicted", kind: "counter", ddKind: "gauge", status: "exact" },
  "redis.net.rejected": { otel: "redis.connections.rejected", kind: "counter", ddKind: "gauge", status: "exact" },
};
/** Mirrors T1's metricAvailability(): known to the table but not usable. */
const AVAILABILITY: Record<string, MetricAvailability> = {
  "redis.info.latency_ms": "no_equivalent",
  "redis.dd.derived": "derived",
  "redis.dd.scaled": "needs_transform",
};
const CTX: TranslateContext = {
  metric: (n) => METRICS[n],
  availability: (n) => AVAILABILITY[n] ?? (METRICS[n] ? "mapped" : "unmapped"),
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
  ["scope.var", "avg:redis.mem.used{$host} by {host}", `avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"^($host)$"')}[$__interval]))`, "exact-under"],
  ["time.rollup.default", "max:system.cpu.user{*}", `max (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.rollup.explicit", "avg:redis.mem.used{*} by {host}.rollup(max, 300)", `avg by (host_name) (max_over_time(${SEL("redis.memory.used")}[5m]))`, "exact-under"],
  ["time.as_count.gauge", "sum:system.cpu.user{*}.as_count()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_rate.gauge", "sum:system.cpu.user{*}.as_rate()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_count.delta", "sum:app.events{*}.as_count()", `sum (sum_over_time(${SEL("app.events")}[$__interval]))`, "exact-under"],
  ["time.as_count.counter", "sum:nginx.requests{*} by {host}.as_count()", `sum by (host_name) (increase(${SEL("nginx.requests")}[$__rate_interval]))`, "bounded"],
  ["time.as_rate.counter", "sum:nginx.requests{*}.as_rate()", `sum (rate(${SEL("nginx.requests")}[$__rate_interval]))`, "bounded"],
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
  ["label.default", "avg:system.cpu.user{region:eu-1}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', region="eu-1"')}[$__interval]))`, "exact-under"],
  ["fn.per_unit.counter", "per_minute(sum:redis.keys.evicted{*} by {host})", `60 * sum by (host_name) (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.counter", "per_second(avg:redis.keys.evicted{*})", `avg (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.counter", "per_hour(sum:redis.keys.evicted{*})", `3600 * sum (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.diff", "diff(sum:redis.net.rejected{*})", `sum (avg_over_time(${SEL("redis.connections.rejected")}[$__interval])) - sum (avg_over_time(${SEL("redis.connections.rejected")}[$__interval] offset $__interval))`, "exact-under"],
  ["arith.neg", "-avg:system.cpu.user{*}", `-avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  // T1 mapping fields (ddKind, labels, status)
  ["select.metric.mapped", "avg:redis.net.clients{*}", `avg (avg_over_time(${SEL("redis.clients.connected")}[$__interval]))`, "exact-under"],
  ["select.labels", "avg:redis.cpu.sys{*} by {host}", `avg by (host_name) (rate(${SEL("redis.cpu.time", ', state="sys"')}[$__rate_interval]))`, "bounded"],
  ["time.ddrate.plain", "sum:redis.net.commands{*}", `sum (rate(${SEL("redis.commands.processed")}[$__rate_interval]))`, "bounded"],
  ["time.as_count.counter", "sum:redis.net.commands{*}.as_count()", `sum (increase(${SEL("redis.commands.processed")}[$__rate_interval]))`, "bounded"],
  ["select.metric.mapped", "avg:redis.dd.gauge_on_counter{*}", `avg (avg_over_time(${SEL("redis.connections.received")}[$__interval]))`, "exact-under"],
  ["select.metric.approximate", "avg:redis.dd.approx{*}", `avg (avg_over_time(${SEL("redis.memory.rss")}[$__interval]))`, "bounded"],
];

describe("rule table: one exact PromQL string per rule", () => {
  for (const [rule, src, promql, status] of CASES) {
    it(`${rule}: ${src}`, () => {
      const r = track(q(src));
      expect(r.findings.filter((f) => f.status === "manual")).toEqual([]);
      expect(r.promql).toBe(promql);
      expect(r.rules).toContain(rule);
      expect(r.status).toBe(status);
      expect(validatePromQL(r.promql!).ok).toBe(true);
    });
  }

  it("unmapped metric warns and records the gauge assumption", () => {
    const r = q("avg:foo.bar{*}");
    expect(r.findings).toMatchObject([{ status: "exact-under", code: "metric.unmapped", itemKind: "query" }]);
    expect(r.assumptions).toContain("A.kind-gauge");
  });

  it("free-form $scope is dropped under the A.var-default assumption", () => {
    const r = track(q("avg:redis.mem.used{$scope,$host} by {host}"));
    expect(r.promql).toBe(`avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"^($host)$"')}[$__interval]))`);
    expect(r.assumptions).toContain("A.var-default");
    expect(r.findings).toMatchObject([{ code: "scope.var.free-form" }]);
  });

  it("findings use the CONTRACT-001 shape, with checkable assumption text", () => {
    const r = q("avg:foo.bar{region:eu}", { ...CTX, where: "dd-dash-1/panel-3/query1" });
    expect(r.findings).toEqual([
      {
        status: "exact-under",
        code: "metric.unmapped",
        message: "no mapping for foo.bar; kept the Datadog name and assumed a gauge",
        itemKind: "query",
        itemId: "dd-dash-1/panel-3/query1",
        ruleId: "select.metric.unmapped",
        assumptions: ["the metric is a gauge; there is no mapping-table entry to confirm its kind"],
      },
      {
        status: "exact-under",
        code: "tag.unmapped",
        message: "tag 'region' has no tag-table entry; using label 'region'",
        itemKind: "query",
        itemId: "dd-dash-1/panel-3/query1",
        ruleId: "label.default",
        assumptions: [
          "the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry)",
        ],
      },
    ]);
  });

  it("a variable used as a tag value is anchored too", () => {
    expect(q("avg:system.cpu.user{env:$env.value}", { ...CTX, variables: { env: { tag: "env" } } }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^($env)$"')}[$__interval]))`,
    );
  });

  it("a counter with an explicit width keeps it (no $__rate_interval)", () => {
    expect(q("sum:nginx.requests{*}.as_rate()", { ...CTX, interval: 60 }).promql).toBe(`sum (rate(${SEL("nginx.requests")}[1m]))`);
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

  it("a query referenced twice reports its findings once", () => {
    const env = new Map<string, Expr>();
    const p = parseQuery("avg:foo.hits{*}");
    if (p.ok) env.set("query1", p.value);
    const f = parseFormula("query1 / (query1 + 1)");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, CTX, env).findings.filter((x) => x.code === "metric.unmapped")).toHaveLength(1);
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
    ["time.kind", "per_second(sum:nginx.requests{*})"],
    ["fn.diff.offset", "diff(timeshift(avg:system.cpu.user{*}, -3600))"],
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
    ["time.kind", "sum:redis.dd.count{*}"],
    ["select.labels.clash", "avg:redis.cpu.sys{state:user}"],
    ["metric.no_equivalent", "avg:redis.info.latency_ms{*}"],
    ["metric.derived", "avg:redis.dd.derived{*}"],
    ["metric.needs_transform", "avg:redis.dd.scaled{*}"],
    ["arith.div-zero", "avg:system.cpu.user{*} / 0"],
    ["fn.per_unit.kind", "per_minute(avg:system.cpu.user{*})"],
    ["fn.per_unit.kind", "per_minute(max:redis.keys.evicted{*})"],
    ["fn.per_unit.kind", "per_minute(sum:redis.keys.evicted{*}.rollup(sum, 60))"],
    ["fn.per_unit.kind", "per_second(sum:nginx.requests{*}.as_count())"],
  ] as const) {
    it(`${code}: ${src}`, () => {
      const r = q(src);
      expect(r.status).toBe("manual");
      expect(r.promql).toBeNull();
      expect(r.findings.some((f) => f.status === "manual" && f.code === code)).toBe(true);
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
    expect(r.assumptions).toContain("A.query-threshold");
  });

  it(".as_count() inside a monitor is manual until Datadog's sum path is modelled", () => {
    const r = mon("sum(last_5m):sum:redis.net.commands{*}.as_count() > 100");
    expect(r).toMatchObject({ status: "manual", promql: null, thresholds: null });
    expect(r.findings).toMatchObject([{ status: "manual", code: "monitor.as_count", itemKind: "alert" }]);
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

describe("diff with a fixed interval", () => {
  it("adds the step to an existing fixed offset (monitors, fixed-interval dashboards)", () => {
    expect(q("diff(timeshift(avg:system.cpu.user{*}, -3600))", { ...CTX, interval: 60 }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization")}[1m] offset 1h)) - avg (avg_over_time(${SEL("system.cpu.utilization")}[1m] offset 61m))`,
    );
  });
});
