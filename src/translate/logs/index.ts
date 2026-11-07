// T12: Datadog log queries and log monitors -> PromQL on Dash0's synthetic dash0.logs counter.
// Deterministic, no I/O (loadLogAttributes is the only function that reads a file). Fail closed: anything without a
// rule is `manual` with no PromQL. Label names were verified live (docs/research/dash0.md, "dash0.logs labels").
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Finding, Status } from "../../ir/index.js";
import { worst } from "../../ir/index.js";
import { parseLogSearch, type LogNode, type LogValue } from "../../parse/logsearch/index.js";
import { render, type Duration, type PMatcher, type PNode } from "../query/promql.js";
import { validatePromQL } from "../../validate/promql.js";

// ---------------- rules (data) ----------------

export const LOG_ASSUMPTIONS = {
  "A.log-count": "Dash0's dash0.logs counter counts the same log records Datadog indexed (no sampling or exclusion filters on either side)",
  "A.log-source": "logs carry Datadog's `source` as a `source` attribute (set by the shipper); OTel has no built-in equivalent",
  "A.log-attr-default": "a log attribute without a table entry keeps its name in OTel (dots become underscores in the label)",
  "A.log-fulltext": "Datadog's free-text match of a word equals a case-insensitive substring match on the log body",
  "A.var-regex": "the dashboard substitutes the variable as a regex of escaped literal values (a single value, or (a|b) for several)",
  "A.var-default": "a template variable without a facet is left at its default '*', so dropping it filters nothing",
  "A.top-stable": "the ranking of the series is the same at every step, so Datadog's whole-window ranking picks the same groups as PromQL's per-step topk",
  "A.group-limit": "the number of groups stays within the widget's group limit, so Datadog shows every group too",
  "A.severity-map": "the Datadog status maps to the OTel severity range listed in mappings/log-attributes.yaml (no 1:1 level)",
  "A.all-indexes": "every Datadog log index is queried (Dash0 has no indexes)",
} as const;
export type LogAssumptionId = keyof typeof LOG_ASSUMPTIONS;

interface LogRule {
  status: Status;
  assumptions: LogAssumptionId[];
  description: string;
}
const r = (status: Status, assumptions: LogAssumptionId[], description: string): LogRule => ({ status, assumptions, description });

export const LOG_RULES = {
  "log.count": r("bounded", ["A.log-count"], "count of logs matching Q -> sum by (g) (increase({otel_metric_name=\"dash0.logs\", m(Q)}[w]))"),
  "log.cardinality": r("bounded", ["A.log-count"], "cardinality of @a -> count by (g) (sum by (g, a) (increase(...[w])) > 0)"),
  "log.match.reserved": r("exact", [], "service/host/env/version:x -> the resource label (service_name, ...)"),
  "log.match.reserved.approx": r("exact-under", ["A.log-source"], "source:x -> source=\"x\" (no OTel counterpart)"),
  "log.match.attr": r("exact-under", ["A.log-attr-default"], "@a.b:x -> a_b=\"x\" (renames from mappings/log-attributes.yaml applied)"),
  "log.match.value": r("exact", [], "k:v -> =, k:v* -> =~\"^v.*$\", k:(a OR b) -> =~\"^(a|b)$\", k:* -> =~\".+\", negations -> != / !~"),
  "log.match.status": r("exact", [], "status:error -> otel_log_severity_range=\"ERROR\""),
  "log.match.status.approx": r("exact-under", ["A.severity-map"], "status:critical/notice/ok/... -> the nearest OTel severity range"),
  "log.match.text": r("exact-under", ["A.log-fulltext"], "free text w -> otel_log_body=~\"(?i).*w.*\""),
  "log.match.var": r("exact-under", ["A.var-regex"], "$var on a facet -> label=~\"^($var)$\""),
  "log.match.var.dropped": r("exact-under", ["A.var-default"], "$var without a facet -> dropped while it is '*'"),
  "log.group_by": r("exact", [], "group_by facets -> by (labels)"),
  "log.group_by.limit": r("exact-under", ["A.top-stable"], "one facet with a limit N -> topk(N, ...) (bottomk for asc)"),
  "log.group_by.multi-limit": r("exact-under", ["A.group-limit"], "several facets with limits -> by (labels), limits not applied"),
  "log.group_by.exclude-missing": r("exact", [], "should_exclude_missing: true -> label!=\"\" for each group-by label"),
  "log.indexes": r("exact-under", ["A.all-indexes"], "indexes other than '*' -> all logs (Dash0 has no indexes)"),
  "log.monitor.count": r("bounded", ["A.log-count"], "logs(Q).rollup(count).by(g).last(W) op T -> sum by (g) (increase(...[W])) op $__threshold"),
} as const satisfies Record<string, LogRule>;
export type LogRuleId = keyof typeof LOG_RULES;

// ---------------- attribute table ----------------

export interface LogAttributes {
  reserved: Record<string, { label: string; status: "exact" | "approximate" }>;
  renames: Record<string, string>;
  severity: Record<string, { range: string; status: "exact" | "approximate" }>;
}

/** Parse mappings/log-attributes.yaml. Pure; fails loudly on a malformed table. */
export function parseLogAttributes(text: string): LogAttributes {
  const doc = parseYaml(text) as any;
  if (!doc || doc.version !== 1) throw new Error("log-attributes: expected version: 1");
  for (const k of ["reserved", "renames", "severity"]) if (typeof doc[k] !== "object" || doc[k] === null) throw new Error(`log-attributes: missing '${k}'`);
  return { reserved: doc.reserved, renames: doc.renames, severity: doc.severity };
}

/** The only I/O here: read the table from disk. */
export function loadLogAttributes(path: string): LogAttributes {
  return parseLogAttributes(readFileSync(path, "utf8"));
}

// ---------------- translation ----------------

export interface LogTranslateContext {
  attributes: LogAttributes;
  /** Dashboard template variables: name -> the facet or tag it filters (Datadog `prefix`), or null. */
  variables?: Record<string, { tag: string | null }>;
  /** Default bucket width: seconds or "$__interval" (default). */
  interval?: number | "$__interval";
  /** Item id copied into every finding. */
  where?: string;
}

/** Same shape as T4's QueryTranslation, plus the tree and group labels so formulas can combine log and metric queries. */
export interface LogTranslation {
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
  node: PNode | null;
  groups: string[] | null;
}

/** The parts of a Datadog `data_source: logs` query that matter. */
export interface DatadogLogQuery {
  search?: { query?: string };
  compute?: { aggregation?: string; metric?: string; interval?: number };
  /** A list of facets, or the newer object form {fields, limit, sort, should_exclude_missing}. */
  group_by?: { facet?: string; limit?: number; sort?: { order?: string } }[] | { fields?: string[]; limit?: number; sort?: { order?: string }; should_exclude_missing?: boolean };
  indexes?: string[];
}

class Manual extends Error {}

class LogLowerer {
  rules: LogRuleId[] = [];
  findings: Finding[] = [];
  constructor(
    readonly ctx: LogTranslateContext,
    readonly itemKind: "query" | "alert",
  ) {}

  use(id: LogRuleId): void {
    if (!this.rules.includes(id)) this.rules.push(id);
  }
  find(status: Finding["status"], code: string, message: string, original?: string): void {
    if (this.findings.some((f) => f.code === code && f.message === message)) return;
    this.findings.push({ status, code, message, itemKind: this.itemKind, itemId: this.ctx.where ?? "", ...(original !== undefined && { original }) });
  }
  manual(code: string, message: string, original?: string): never {
    this.find("manual", code, message, original);
    throw new Manual(message);
  }

  /** Datadog key (reserved tag or @facet) -> Dash0 label. */
  label(key: string): string {
    if (key.startsWith("@")) {
      let attr = key.slice(1);
      attr = this.ctx.attributes.renames[attr] ?? attr;
      this.use("log.match.attr");
      return attr.replace(/[^A-Za-z0-9_]/g, "_");
    }
    const res = this.ctx.attributes.reserved[key];
    if (res) {
      this.use(res.status === "exact" ? "log.match.reserved" : "log.match.reserved.approx");
      return res.label;
    }
    // A tag without '@' (env, region, kube_namespace ...): a resource attribute of the same name.
    this.use("log.match.attr");
    const attr = this.ctx.attributes.renames[key] ?? key;
    return attr.replace(/[^A-Za-z0-9_]/g, "_");
  }

  matchers(n: LogNode | null): PMatcher[] {
    if (n === null) return [];
    switch (n.type) {
      case "and":
        return n.items.flatMap((i) => this.matchers(i));
      case "or":
        return this.orSameKey(n);
      case "not":
        this.manual("log.not.complex", "NOT over a compound log search has no matcher form");
      case "range":
        this.manual("log.range", `numeric range on ${n.key} (${n.raw}): labels can't be compared as numbers`);
      case "var":
        return this.variable(n.name, n.negated);
      case "text":
        return [this.text(n.value, n.quoted, n.negated)];
      case "term":
        return [this.term(n.key, n.values, n.negated)];
    }
  }

  orSameKey(n: Extract<LogNode, { type: "or" }>): PMatcher[] {
    const terms = n.items.filter((i): i is Extract<LogNode, { type: "term" }> => i.type === "term" && !i.negated);
    if (terms.length !== n.items.length || new Set(terms.map((t) => t.key)).size !== 1)
      this.manual("log.or.cross-key", "OR across different keys (or with free text) is not a matcher set");
    return [this.term(terms[0]!.key, terms.flatMap((t) => t.values), false)];
  }

  term(key: string, values: LogValue[], negated: boolean): PMatcher {
    if (key === "status") return this.status(values, negated);
    const label = this.label(key);
    this.use("log.match.value");
    if (values.length === 1 && !values[0]!.quoted && values[0]!.text === "*")
      return { label, op: negated ? "=" : "=~", value: negated ? "" : ".+" }; // exists / doesn't exist
    const pats = values.map((v) => (v.quoted ? escapeRe(v.text) : pattern(v.text)));
    const plain = values.length === 1 && (values[0]!.quoted || !values[0]!.text.includes("*"));
    if (plain) return { label, op: negated ? "!=" : "=", value: values[0]!.text };
    return { label, op: negated ? "!~" : "=~", value: `^(${pats.join("|")})$` };
  }

  status(values: LogValue[], negated: boolean): PMatcher {
    const ranges = values.map((v) => {
      const s = this.ctx.attributes.severity[v.text.toLowerCase()];
      if (!s || v.text.includes("*")) this.manual("log.status.unknown", `status:${v.text} has no OTel severity range`);
      this.use(s.status === "exact" ? "log.match.status" : "log.match.status.approx");
      return s.range;
    });
    const uniq = [...new Set(ranges)];
    if (uniq.length === 1) return { label: "otel_log_severity_range", op: negated ? "!=" : "=", value: uniq[0]! };
    return { label: "otel_log_severity_range", op: negated ? "!~" : "=~", value: `^(${uniq.join("|")})$` };
  }

  text(value: string, quoted: boolean, negated: boolean): PMatcher {
    this.use("log.match.text");
    const body = quoted ? escapeRe(value) : pattern(value);
    return { label: "otel_log_body", op: negated ? "!~" : "=~", value: `(?i).*${body}.*` };
  }

  variable(name: string, negated: boolean): PMatcher[] {
    const def = this.ctx.variables?.[name];
    if (!def || def.tag === null) {
      if (negated) this.manual("log.var.negated", `negated free-form template variable $${name}`);
      this.use("log.match.var.dropped");
      this.find("exact-under", "scope.var.free-form", `template variable $${name} has no facet; dropped (exact while it is left at '*')`);
      return [];
    }
    const label = this.label(def.tag);
    this.use("log.match.var");
    return [{ label, op: negated ? "!~" : "=~", value: `^($${name})$` }];
  }

  /** Selector + compute + group_by -> PromQL. `window` overrides the bucket width (monitors). */
  query(q: DatadogLogQuery, window?: number): { node: PNode; groups: string[] } {
    // Exported JSON is not always well-formed: anything unexpected fails closed instead of throwing.
    // Newer group_by form: {fields: [...], limit, sort, should_exclude_missing} -> the list form.
    let excludeMissing = false;
    let gb = q.group_by;
    if (gb !== undefined && !Array.isArray(gb)) {
      if (typeof gb !== "object" || gb === null || !Array.isArray(gb.fields)) this.manual("log.group_by.shape", "group_by is neither a list nor {fields: [...]}", JSON.stringify(q.group_by));
      const o = gb;
      excludeMissing = o.should_exclude_missing === true;
      gb = o.fields!.map((facet, i) => ({ facet, ...(i === 0 && o.limit !== undefined && { limit: o.limit }), ...(o.sort && { sort: o.sort }) }));
      if (o.fields!.length > 1 && o.limit !== undefined) gb = gb.map((g) => ({ ...g, limit: o.limit }));
    }
    if (q.indexes !== undefined && !Array.isArray(q.indexes)) this.manual("log.indexes.shape", "indexes is not a list", JSON.stringify(q.indexes));
    if (q.search?.query !== undefined && typeof q.search.query !== "string") this.manual("log.search.shape", "search.query is not a string");
    const indexes = q.indexes ?? [];
    if (indexes.length && !indexes.every((i) => i === "*")) {
      this.use("log.indexes");
      this.find("exact-under", "log.indexes", `log indexes ${indexes.join(",")} have no Dash0 counterpart; querying all logs`);
    }
    const parsed = parseLogSearch(q.search?.query ?? "");
    if (!parsed.ok) this.manual("log.search.parse", `log search does not parse: ${parsed.error.message} at ${parsed.error.pos}`, q.search?.query);
    const matchers: PMatcher[] = [{ label: "otel_metric_name", op: "=", value: "dash0.logs" }, ...this.matchers(parsed.value)];

    const by: string[] = [];
    const facets = (gb ?? []) as { facet?: string; limit?: number; sort?: { order?: string } }[];
    for (const g of facets) {
      if (!g.facet) this.manual("log.group_by.facet", "group_by without a facet");
      by.push(g.facet === "status" ? "otel_log_severity_range" : this.label(g.facet));
    }
    if (facets.length) this.use("log.group_by");
    const groups = [...new Set(by)].sort();
    if (excludeMissing) {
      this.use("log.group_by.exclude-missing");
      for (const label of groups) if (!matchers.some((m) => m.label === label && m.op === "!=" && m.value === "")) matchers.push({ label, op: "!=", value: "" });
    }

    const width: Duration = window ?? (q.compute?.interval ? Math.round(q.compute.interval / 1000) : (this.ctx.interval ?? "$__interval"));
    const sel: PNode = { k: "selector", matchers, range: width };
    const inc: PNode = { k: "call", fn: "increase", args: [sel] };

    const agg = q.compute?.aggregation ?? "count";
    let node: PNode;
    if (agg === "count") {
      this.use("log.count");
      node = { k: "agg", op: "sum", by: groups, expr: inc };
    } else if (agg === "cardinality") {
      if (!q.compute?.metric) this.manual("log.cardinality.metric", "cardinality without a facet");
      const attr = this.label(q.compute.metric);
      this.use("log.cardinality");
      const perValue: PNode = { k: "agg", op: "sum", by: [...new Set([...groups, attr])].sort(), expr: inc };
      node = { k: "agg", op: "count", by: groups, expr: { k: "binary", op: ">", lhs: perValue, rhs: { k: "num", value: 0 } } };
    } else {
      this.manual("log.measure", `${agg} of ${q.compute?.metric ?? "a measure"}: dash0.logs only counts log records`);
    }

    // Group limits: one facet -> topk/bottomk; several -> recorded assumption.
    const limited = facets.filter((g) => g.limit !== undefined);
    if (limited.length === 1 && facets.length === 1) {
      const g = limited[0]!;
      this.use("log.group_by.limit");
      node = { k: "call", fn: g.sort?.order === "asc" ? "bottomk" : "topk", args: [{ k: "num", value: g.limit! }, node] };
    } else if (limited.length > 0) {
      this.use("log.group_by.multi-limit");
      this.find("exact-under", "log.group_by.multi-limit", "several group-by facets with limits; limits are not applied");
    }
    return { node, groups };
  }

  result(node: PNode | null, groups: string[] | null): LogTranslation {
    let status: Status = "exact";
    const assumptions: string[] = [];
    for (const id of this.rules) {
      const rule = LOG_RULES[id];
      status = worst(status, rule.status);
      for (const a of rule.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
    }
    const fail = (): LogTranslation => ({ status: "manual", promql: null, rules: this.rules, assumptions: [], findings: this.findings, node: null, groups: null });
    if (!node) return fail();
    const promql = render(node);
    const v = validatePromQL(promql);
    if (!v.ok) {
      this.find("manual", "promql.invalid", `emitted PromQL does not parse: ${v.errors.map((e) => e.message).join("; ")}`, promql);
      return fail();
    }
    return { status, promql, rules: this.rules, assumptions: assumptions.sort(), findings: this.findings, node, groups };
  }
}

function run(ctx: LogTranslateContext, kind: "query" | "alert", f: (l: LogLowerer) => { node: PNode; groups: string[] }): LogTranslation {
  const l = new LogLowerer(ctx, kind);
  try {
    const { node, groups } = f(l);
    return l.result(node, groups);
  } catch (e) {
    if (e instanceof Manual) return l.result(null, null);
    throw e;
  }
}

/** A log translation as a T4 formula ref, so `query1 / query2` can mix log and metric queries. */
export function logRef(t: LogTranslation): import("../query/types.js").LoweredRef {
  return { type: "lowered", node: t.node ?? { k: "num", value: 0 }, groups: t.groups, status: t.status, rules: t.rules, assumptions: t.assumptions, findings: t.findings };
}

/** A dashboard query with `data_source: "logs"`. */
export function translateLogQuery(q: DatadogLogQuery, ctx: LogTranslateContext): LogTranslation {
  return run(ctx, "query", (l) => l.query(q));
}

// ---------------- log monitors ----------------

export interface LogMonitorTranslation extends LogTranslation {
  thresholds: { failed: number; degraded?: number } | null;
  negated: boolean;
}

const LOG_MONITOR =
  /^\s*logs\("((?:[^"\\]|\\.)*)"\)(?:\.index\("([^"]*)"\))?(?:\.rollup\("(count|cardinality)"(?:\s*,\s*"([^"]+)")?\))?(?:\.by\("([^"]*)"\))?\.last\("(\d+)([smhd])"\)\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** A `log alert` monitor query: logs("Q").index("*").rollup("count").by("host").last("5m") > 10. */
export function translateLogMonitor(query: string, opts: { critical?: number; warning?: number }, ctx: LogTranslateContext): LogMonitorTranslation {
  let thresholds: LogMonitorTranslation["thresholds"] = null;
  let negated = false;
  const t = run(ctx, "alert", (l) => {
    const m = LOG_MONITOR.exec(query);
    if (!m) return l.manual("log.monitor.shape", "log monitor query has a shape with no rule", query);
    const [, search, index, rollup, rollupAttr, by, n, unit, op, th] = m;
    const window = Number(n) * UNIT[unit!]!;
    const q: DatadogLogQuery = {
      search: { query: search!.replace(/\\"/g, '"') },
      ...(index && { indexes: index.split(",").map((s) => s.trim()) }),
      compute: { aggregation: rollup ?? "count", ...(rollupAttr && { metric: rollupAttr }) },
      group_by: (by ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((facet) => ({ facet })),
    };
    const { node, groups } = l.query(q, window);
    l.use("log.monitor.count");
    const crit = Number(th);
    let expr = node;
    let cmp: ">" | ">=" = op === ">=" || op === "<=" ? ">=" : ">";
    if (op === "<" || op === "<=") {
      negated = true;
      expr = { k: "neg", expr };
      thresholds = { failed: -crit, ...(opts.warning !== undefined && { degraded: -opts.warning }) };
    } else thresholds = { failed: crit, ...(opts.warning !== undefined && { degraded: opts.warning }) };
    if (opts.critical !== undefined && opts.critical !== crit)
      l.find("exact-under", "monitor.threshold.mismatch", `options.thresholds.critical (${opts.critical}) differs from the query threshold (${crit}); using the query's`);
    return { node: { k: "binary", op: cmp, lhs: expr, rhs: { k: "placeholder", name: "$__threshold" } }, groups };
  });
  if (!t.promql) return { ...t, thresholds: null, negated: false };
  return { ...t, thresholds, negated };
}

// ---------------- helpers ----------------

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

/** Datadog wildcard text -> regex body: `*` matches anything, `?` one character; everything else is literal. */
function pattern(v: string): string {
  return v
    .split("*")
    .map((p) => p.split("?").map((q) => q.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("."))
    .join(".*");
}
