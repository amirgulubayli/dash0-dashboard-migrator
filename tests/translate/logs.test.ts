import { describe, expect, it } from "vitest";
import { parseLogSearch } from "../../src/parse/logsearch/index.js";
import { parseFormula, parseQuery } from "../../src/parse/index.js";
import { LOG_RULES, loadLogAttributes, logRef, translateLogMonitor, translateLogQuery } from "../../src/translate/logs/index.js";
import type { DatadogLogQuery, LogTranslateContext } from "../../src/translate/logs/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import type { FormulaEnv } from "../../src/translate/query/index.js";
import { validatePromQL } from "../../src/validate/promql.js";

const attributes = loadLogAttributes("mappings/log-attributes.yaml");
const CTX: LogTranslateContext = { attributes, variables: { Host: { tag: "host" }, User: { tag: "@usr.name" }, scope: { tag: null } } };
const L = (m = "") => `{otel_metric_name="dash0.logs"${m}}[$__interval]`;
const used = new Set<string>();
const lq = (search: string, extra: Partial<DatadogLogQuery> = {}) => {
  const r = translateLogQuery({ search: { query: search }, compute: { aggregation: "count" }, ...extra }, CTX);
  r.rules.forEach((x) => used.add(x));
  return r;
};

describe("log-search parser", () => {
  it("parses the corpus shapes", () => {
    for (const q of [
      "source:wazuh service:system @rule.groups:(sshd invalid_login) $Agent_Name",
      '@nvps.objecttype:"Request Response" -@entityName:"" $user_name',
      "@message_id:(101* OR 103*) $Host",
      "status:error (timeout OR refused) -@http.status_code:404",
      "@duration:>1000",
      "*",
      "",
    ])
      expect(parseLogSearch(q).ok, q).toBe(true);
  });
  it("reports a position on errors and never throws", () => {
    const r = parseLogSearch("source:x (unclosed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBeGreaterThan(0);
    expect(parseLogSearch("(".repeat(5000)).ok).toBe(false);
  });
});

/** [rule, search, extra, expected PromQL, status] */
const CASES: [string, string, Partial<DatadogLogQuery>, string, string][] = [
  ["log.count", "", {}, `sum (increase(${L()}))`, "bounded"],
  ["log.match.reserved", "service:checkout host:web-1", {}, `sum (increase(${L(', host_name="web-1", service_name="checkout"')}))`, "bounded"],
  ["log.match.reserved.approx", "source:redis", {}, `sum (increase(${L(', source="redis"')}))`, "bounded"],
  ["log.match.attr", "@http.status_code:502 @db.system:postgresql", {}, `sum (increase(${L(', db_system_name="postgresql", http_status_code="502"')}))`, "bounded"],
  ["log.match.value", "@evt.name:(login* OR logout) -@usr.id:* -@http.method:GET", {}, `sum (increase(${L(', evt_name=~"^(login.*|logout)$", http_method!="GET", usr_id=""')}))`, "bounded"],
  ["log.match.status", "status:(error OR warn)", {}, `sum (increase(${L(', otel_log_severity_range=~"^(ERROR|WARN)$"')}))`, "bounded"],
  ["log.match.status.approx", "status:critical", {}, `sum (increase(${L(', otel_log_severity_range="FATAL"')}))`, "bounded"],
  ["log.match.text", 'timeout -"card declined"', {}, `sum (increase(${L(', otel_log_body!~"(?i).*card declined.*", otel_log_body=~"(?i).*timeout.*"')}))`, "bounded"],
  ["log.match.var", "$Host -$User", {}, `sum (increase(${L(', host_name=~"^($Host)$", usr_name!~"^($User)$"')}))`, "bounded"],
  ["log.match.var.dropped", "service:a $scope", {}, `sum (increase(${L(', service_name="a"')}))`, "bounded"],
  ["log.group_by", "service:a", { group_by: [{ facet: "@usr.name" }, { facet: "status" }] }, `sum by (otel_log_severity_range, usr_name) (increase(${L(', service_name="a"')}))`, "bounded"],
  ["log.group_by.limit", "service:a", { group_by: [{ facet: "@usr.name", limit: 10, sort: { order: "asc" } }] }, `bottomk(10, sum by (usr_name) (increase(${L(', service_name="a"')})))`, "bounded"],
  ["log.group_by.multi-limit", "", { group_by: [{ facet: "host", limit: 5 }, { facet: "service", limit: 3 }] }, `sum by (host_name, service_name) (increase(${L()}))`, "bounded"],
  ["log.group_by.exclude-missing", "", { group_by: { fields: ["@policy_name"], limit: 10, sort: { order: "desc" }, should_exclude_missing: true } }, `topk(10, sum by (policy_name) (increase(${L(', policy_name!=""')})))`, "bounded"],
  ["log.cardinality", "service:a", { compute: { aggregation: "cardinality", metric: "@usr.id" }, group_by: [{ facet: "host" }] }, `count by (host_name) (sum by (host_name, usr_id) (increase(${L(', service_name="a"')})) > 0)`, "bounded"],
  ["log.indexes", "", { indexes: ["main", "security"] }, `sum (increase(${L()}))`, "bounded"],
];

describe("log queries: one exact PromQL string per rule", () => {
  for (const [rule, search, extra, promql, status] of CASES) {
    it(`${rule}: ${search || "(all logs)"}`, () => {
      const r = lq(search, extra);
      expect(r.findings.filter((f) => f.status === "manual")).toEqual([]);
      expect(r.promql).toBe(promql);
      expect(r.rules).toContain(rule);
      expect(r.status).toBe(status);
      expect(validatePromQL(r.promql!).ok).toBe(true);
    });
  }
});

describe("log queries: fail closed", () => {
  for (const [code, search, extra] of [
    ["log.measure", "service:a", { compute: { aggregation: "avg", metric: "@duration" } }],
    ["log.or.cross-key", "service:a OR host:b", {}],
    ["log.range", "@duration:>1000", {}],
    ["log.not.complex", "NOT (service:a host:b)", {}],
    ["log.status.unknown", "status:verbose", {}],
    ["log.search.parse", "source:x (unclosed", {}],
    ["log.group_by.shape", "", { group_by: "host" as never }],
  ] as const) {
    it(code, () => {
      const r = lq(search, extra as Partial<DatadogLogQuery>);
      expect(r).toMatchObject({ status: "manual", promql: null });
      expect(r.findings.some((f) => f.status === "manual" && f.code === code)).toBe(true);
    });
  }
});

describe("log monitors", () => {
  it("count over the window with Datadog's thresholds", () => {
    const r = translateLogMonitor('logs("source:nginx status:error").index("*").rollup("count").by("host").last("5m") > 10', { critical: 10, warning: 5 }, CTX);
    r.rules.forEach((x) => used.add(x));
    expect(r.promql).toBe(
      'sum by (host_name) (increase({otel_metric_name="dash0.logs", otel_log_severity_range="ERROR", source="nginx"}[5m])) > $__threshold',
    );
    expect(r).toMatchObject({ status: "bounded", thresholds: { failed: 10, degraded: 5 }, negated: false });
  });
  it("< is negated, and unknown shapes are manual", () => {
    const lt = translateLogMonitor('logs("service:api").index("*").rollup("count").last("15m") < 1', {}, CTX);
    expect(lt.promql).toBe('-sum (increase({otel_metric_name="dash0.logs", service_name="api"}[15m])) > $__threshold');
    expect(lt).toMatchObject({ thresholds: { failed: -1 }, negated: true });
    expect(translateLogMonitor('formula("query1 / query").last("1d") > 10', {}, CTX).status).toBe("manual");
  });
});

describe("formulas mixing log and metric queries", () => {
  it("error ratio: log query / metric query", () => {
    const errors = translateLogQuery({ search: { query: "service:api status:error" }, compute: { aggregation: "count" } }, CTX);
    const p = parseQuery("sum:trace.http.request.hits{service:api}.as_count()");
    if (!p.ok) throw new Error();
    const env: FormulaEnv = new Map([["query1", logRef(errors)], ["query2", p.value]]);
    const f = parseFormula("100 * query1 / query2");
    if (!f.ok) throw new Error();
    const r = translateQuery(f.value, { ddKind: () => "count" }, env);
    expect(r.promql).toBe(
      `100 * sum (increase(${L(', otel_log_severity_range="ERROR", service_name="api"')})) / sum (increase({otel_metric_name="trace.http.request.hits", service="api"}[$__rate_interval]))`,
    );
    expect(r.status).toBe("bounded");
    expect(r.rules).toEqual(expect.arrayContaining(["log.count", "time.unmapped.counter"]));
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.log-count", "A.otel-counter"]));
  });
  it("a manual log query makes the formula manual", () => {
    const bad = translateLogQuery({ search: { query: "@x:>1" }, compute: { aggregation: "count" } }, CTX);
    const f = parseFormula("query1 * 2");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, {}, new Map([["query1", logRef(bad)]]))).toMatchObject({ status: "manual", promql: null });
  });
});

describe("coverage of the log rule table", () => {
  it("every log rule is exercised by a test above", () => {
    expect(Object.keys(LOG_RULES).filter((r) => !used.has(r))).toEqual([]);
  });
});
