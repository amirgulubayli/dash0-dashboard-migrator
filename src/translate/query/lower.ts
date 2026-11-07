// T4: Datadog query AST (src/parse) -> PromQL AST, rule by rule. Deterministic, no I/O.
// Fail closed (plan 02 §2 rule 2): a construct without a rule makes the whole query `manual`, with no PromQL.
import type { Expr, MetricQuery, MonitorQuery, ScopeExpr } from "../../parse/index.js";
import { validatePromQL } from "../../validate/promql.js";
import { mapSelectors, render, type Duration, type PMatcher, type PNode } from "./promql.js";
import { ASSUMPTIONS, RULES, type AssumptionId, type RuleId } from "./rules.js";
import { worst, type Finding, type MetricMapping, type QueryTranslation, type Status, type TranslateContext } from "./types.js";

class Manual extends Error {}

const SPACE_AGGS = new Set(["avg", "sum", "min", "max", "count"]);
const ROLLUP_FNS = new Set(["avg", "sum", "min", "max", "count"]);
const TIMESHIFT_FNS: Record<string, number> = { hour_before: 3600, day_before: 86400, week_before: 604800 };
const UNARY_MAPS: Record<string, RuleId> = { abs: "map.abs", log2: "map.log2", log10: "map.log10" };

interface Lowered {
  node: PNode;
  /** Output labels after space aggregation (sorted), or null for a scalar/number. */
  groups: string[] | null;
}

class Lowerer {
  rules: RuleId[] = [];
  extraAssumptions: AssumptionId[] = [];
  findings: Finding[] = [];

  constructor(
    readonly ctx: TranslateContext,
    readonly interval: Duration,
    /** Inside a monitor's 1m-step subquery the rollup is aligned by construction. */
    readonly monitor: boolean,
  ) {}

  use(rule: RuleId): void {
    if (!this.rules.includes(rule)) this.rules.push(rule);
  }
  assume(a: AssumptionId): void {
    if (!this.extraAssumptions.includes(a)) this.extraAssumptions.push(a);
  }
  /** Record a CONTRACT-001 finding. Assumption ids are expanded to their checkable wording. */
  find(
    status: Finding["status"],
    code: string,
    message: string,
    opts: { ruleId?: RuleId; assumptions?: AssumptionId[]; original?: unknown } = {},
  ): void {
    // A formula can reference the same query twice (`query1 / (query1 + query2)`): report each finding once.
    if (this.findings.some((f) => f.code === code && f.message === message)) return;
    const original = opts.original === undefined ? undefined : typeof opts.original === "string" ? opts.original : JSON.stringify(stripSpans(opts.original));
    this.findings.push({
      status,
      code,
      message,
      itemKind: this.monitor ? "alert" : "query",
      itemId: this.ctx.where ?? "",
      ...(opts.ruleId !== undefined && { ruleId: opts.ruleId }),
      ...(opts.assumptions?.length && { assumptions: opts.assumptions.map((a) => ASSUMPTIONS[a]) }),
      ...(original !== undefined && { original }),
    });
  }
  manual(code: string, message: string, original?: unknown): never {
    this.find("manual", code, message, { original });
    throw new Manual(message);
  }

  label(ddTag: string): string {
    const mapped = this.ctx.tag?.(ddTag);
    if (mapped !== undefined) return mapped;
    const label = ddTag.replace(/[^A-Za-z0-9_]/g, "_");
    this.use("label.default");
    this.find("exact-under", "tag.unmapped", `tag '${ddTag}' has no tag-table entry; using label '${label}'`, {
      ruleId: "label.default",
      assumptions: ["A.tag-default"],
    });
    return label;
  }

  // ---------- expressions ----------

  expr(e: Expr, env?: Map<string, Expr>): Lowered {
    switch (e.type) {
      case "number":
        return { node: { k: "num", value: e.value }, groups: null };
      case "paren":
        return this.expr(e.expr, env);
      case "neg": {
        this.use("arith.neg");
        const x = this.expr(e.expr, env);
        return { node: { k: "neg", expr: x.node }, groups: x.groups };
      }
      case "metric":
        return this.metric(e, []);
      case "postfix": {
        // Unwind the chain: q.a().b() -> base q, calls [a, b] in application order.
        const calls = [];
        let base: Expr = e;
        while (base.type === "postfix") {
          calls.unshift(base.call);
          base = base.target;
        }
        if (base.type !== "metric") this.manual("query.postfix.non-metric", "postfix function on a non-metric expression");
        return this.metric(base, calls);
      }
      case "binary":
        return this.binary(e.op, e.left, e.right, env);
      case "ref": {
        const target = env?.get(e.name);
        if (!target) this.manual("formula.ref.unknown", `formula references unknown query '${e.name}'`);
        return this.expr(target, env);
      }
      case "call":
        return this.call(e, env);
    }
  }

  binary(op: "+" | "-" | "*" | "/", left: Expr, right: Expr, env?: Map<string, Expr>): Lowered {
    const l = this.expr(left, env);
    const r = this.expr(right, env);
    if (l.groups && r.groups) {
      if (l.groups.join(",") !== r.groups.join(","))
        this.manual(
          "arith.group-mismatch",
          `arithmetic between different group-bys (${l.groups.join(",") || "none"} vs ${r.groups.join(",") || "none"}) needs explicit vector matching`,
        );
      this.use("arith.same-groups");
    } else this.use("arith.number");
    if (op === "/" && r.node.k === "num" && r.node.value === 0)
      this.manual("arith.div-zero", "division by the constant 0: Datadog drops the points, PromQL would return ±Inf/NaN");
    if (op === "/" && r.groups) this.use("arith.div");
    return { node: { k: "binary", op, lhs: l.node, rhs: r.node }, groups: l.groups ?? r.groups };
  }

  call(e: Extract<Expr, { type: "call" }>, env?: Map<string, Expr>): Lowered {
    const exprArg = (i: number): Expr => {
      const a = e.args[i];
      if (a?.type !== "expr") this.manual("fn.args", `${e.name}(): argument ${i + 1} must be a query`);
      return a.expr;
    };
    const numArg = (i: number): number => {
      const a = e.args[i];
      const x = a?.type === "expr" ? a.expr : null;
      if (x?.type === "number") return x.value;
      if (x?.type === "neg" && x.expr.type === "number") return -x.expr.value;
      this.manual("fn.args", `${e.name}(): argument ${i + 1} must be a number`);
    };

    const unary = UNARY_MAPS[e.name];
    if (unary && e.args.length === 1) {
      this.use(unary);
      const x = this.expr(exprArg(0), env);
      return { node: { k: "call", fn: e.name, args: [x.node] }, groups: x.groups };
    }
    if ((e.name === "clamp_min" || e.name === "clamp_max") && e.args.length === 2) {
      this.use(`map.${e.name}`);
      const x = this.expr(exprArg(0), env);
      return { node: { k: "call", fn: e.name, args: [x.node, { k: "num", value: numArg(1) }] }, groups: x.groups };
    }
    let shift: number | undefined;
    if (e.name === "timeshift" && e.args.length === 2) shift = -numArg(1);
    else if (TIMESHIFT_FNS[e.name] && e.args.length === 1) shift = TIMESHIFT_FNS[e.name];
    if (shift !== undefined) {
      if (!(shift > 0) || !Number.isInteger(shift)) this.manual("fn.timeshift.future", `${e.name}(): only whole-second shifts into the past are supported`);
      this.use("map.timeshift");
      const x = this.expr(exprArg(0), env);
      const node = mapSelectors(x.node, (s) => ({ ...s, offset: (s.offset ?? 0) + shift! }));
      return { node, groups: x.groups };
    }
    this.manual(`fn.${e.name}`, `no exact rule for Datadog function ${e.name}()`);
  }

  // ---------- metric query ----------

  metric(m: MetricQuery, calls: { name: string; args: import("../../parse/index.js").Arg[] }[]): Lowered {
    if (m.valueFilter) this.manual("query.value-filter", "distribution value filters (v: ...) have no PromQL equivalent");

    let mapping: MetricMapping | undefined = this.ctx.metric?.(m.metric);
    const mapped = mapping !== undefined;
    if (!mapping) {
      // The table can know a metric and still have no usable OTel equivalent: never query a metric that doesn't exist.
      const why = this.ctx.availability?.(m.metric) ?? "unmapped";
      if (why === "no_equivalent") this.manual("metric.no_equivalent", `${m.metric}: the OTel receiver emits no equivalent metric`);
      if (why === "derived") this.manual("metric.derived", `${m.metric}: the equivalent is an expression over several OTel metrics (not translated yet)`);
      if (why === "needs_transform") this.manual("metric.needs_transform", `${m.metric}: the mapping needs a scale or sumBy transform that T4 doesn't apply yet`);
    }
    if (mapping) this.use("select.metric.mapped");
    else {
      this.use("select.metric.unmapped");
      this.find("exact-under", "metric.unmapped", `no mapping for ${m.metric}; kept the Datadog name and assumed a gauge`, {
        ruleId: "select.metric.unmapped",
        assumptions: ["A.kind-gauge"],
      });
      mapping = { otel: m.metric, kind: "gauge" };
    }

    if (mapping.status === "approximate") {
      this.use("select.metric.approximate");
      this.find("bounded", "metric.approximate", `${m.metric} -> ${mapping.otel} is an approximate mapping${mapping.note ? `: ${mapping.note}` : ""}`, {
        ruleId: "select.metric.approximate",
      });
    }

    // Mapping-table labels select the right OTel series (redis.cpu.sys -> redis.cpu.time{state="sys"}).
    const labelMatchers: PMatcher[] = Object.entries(mapping.labels ?? {}).map(([label, value]) => ({ label, op: "=", value }));
    if (labelMatchers.length) this.use("select.labels");
    const scopeMatchers = this.scope(m.scope);
    const clash = scopeMatchers.find((s) => labelMatchers.some((l) => l.label === s.label));
    if (clash) this.manual("select.labels.clash", `the query filters on '${clash.label}', which the mapping already fixes`);
    const matchers: PMatcher[] = [{ label: "otel_metric_name", op: "=", value: mapping.otel }, ...labelMatchers, ...scopeMatchers];

    // Effective kind. Datadog's own kind decides the time aggregation when the table gives it (T1 kindTransform):
    // a Datadog gauge stays a gauge even when the OTel receiver emits a counter; a Datadog RATE on an OTel counter
    // means a plain query already shows per-second values, so it needs rate() (D-18).
    let kind = mapping.kind;
    let ddRate = false;
    if (mapping.ddKind !== undefined) {
      if (mapping.ddKind === "gauge" && kind !== "histogram") kind = "gauge";
      else if (mapping.ddKind === "rate" && kind === "counter") ddRate = true;
      else this.manual("time.kind", `Datadog ${mapping.ddKind} stored as an OTel ${kind}: no tested rule yet`);
    }

    // Time aggregation, Datadog order: per series first.
    let fn = "avg";
    let width: Duration = this.interval;
    let explicitRollup = false;
    let counterMode: "increase" | "rate" | null = null;
    for (const c of calls) {
      if (c.name === "rollup") {
        const f = c.args[0];
        const s = c.args[1];
        if (f?.type !== "word" || !ROLLUP_FNS.has(f.value)) this.manual("time.rollup.fn", `.rollup(): unsupported function`, c);
        fn = f.value;
        if (s) {
          const n = s.type === "expr" && s.expr.type === "number" ? s.expr.value : NaN;
          if (!Number.isInteger(n) || n <= 0) this.manual("time.rollup.width", ".rollup(): width must be whole seconds");
          if (this.monitor && n !== 60) this.manual("time.rollup.monitor-width", "monitor queries support only 60 s rollups");
          width = n;
        }
        if (c.args.length > 2) this.manual("time.rollup.args", ".rollup(): too many arguments");
        explicitRollup = true;
      } else if (c.name === "as_count" && this.monitor) {
        this.manual("monitor.as_count", ".as_count() in a monitor: Datadog evaluates it on a sum path we don't model yet");
      } else if (c.name === "as_count" || c.name === "as_rate") {
        // .as_count()/.as_rate() suggest a count or rate metric, so don't lean on the gauge assumption here.
        if (!mapped) this.manual("time.kind-unknown", `.${c.name}() on ${m.metric}: its kind is unknown (no mapping entry), so the time aggregation can't be chosen`);
        if (kind === "gauge") this.use(`time.${c.name}.gauge`);
        else if (kind === "counter") {
          this.use(`time.${c.name}.counter`);
          counterMode = c.name === "as_count" ? "increase" : "rate";
        } else if (kind === "delta" && c.name === "as_count") {
          this.use("time.as_count.delta");
          fn = "sum";
        } else this.manual(`time.${c.name}.${kind}`, `.${c.name}() on a ${kind} metric has no exact rule`);
      } else if (c.name === "fill") {
        const a = c.args[0];
        if (c.args.length === 1 && a?.type === "word" && a.value === "null") this.use("time.fill.null");
        else this.manual("time.fill", ".fill() other than null has no exact rule (PromQL does not fill gaps)");
      } else this.manual(`fn.${c.name}`, `no exact rule for .${c.name}()`);
    }
    if (ddRate && !counterMode) {
      this.use("time.ddrate.plain");
      counterMode = "rate";
    }
    if ((kind === "counter" && !counterMode) || kind === "histogram" || (kind === "delta" && fn !== "sum"))
      this.manual("time.kind", `a ${kind} metric needs an explicit .as_count()/.as_rate() to fix its time aggregation`);
    if (counterMode && explicitRollup) this.manual("time.rollup.counter", ".rollup() combined with a counter rate has no exact rule");

    // rate()/increase() need at least two samples per window; on dashboards use Perses' $__rate_interval for that.
    const range: Duration = counterMode && width === "$__interval" ? "$__rate_interval" : width;
    const sel: PNode = { k: "selector", matchers, range };
    let inner: PNode;
    if (counterMode) inner = { k: "call", fn: counterMode, args: [sel] };
    else {
      this.use(this.monitor ? "time.rollup.monitor-bucket" : explicitRollup ? "time.rollup.explicit" : "time.rollup.default");
      inner = { k: "call", fn: `${fn}_over_time`, args: [sel] };
    }

    // Space aggregation.
    let agg = m.spaceAgg;
    if (agg === null) {
      this.use("space.default-avg");
      agg = "avg";
    } else if (!SPACE_AGGS.has(agg)) this.manual("space.agg", `space aggregator ${agg}: needs a histogram mapping`);
    else this.use("space.agg");
    const by = [...new Set(m.groupBy.map((t) => this.label(t)))].sort();
    return { node: { k: "agg", op: agg as "avg", by, expr: inner }, groups: by };
  }

  // ---------- scope -> matchers ----------

  scope(s: ScopeExpr | null): PMatcher[] {
    if (!s || s.type === "all") {
      this.use("scope.all");
      return [];
    }
    if (s.type === "and") {
      const out = s.items.flatMap((i) => this.scope(i));
      const eqLabels = out.filter((m) => m.op === "=" || m.op === "=~").map((m) => m.label);
      if (new Set(eqLabels).size !== eqLabels.length)
        this.manual("scope.same-key", "the same tag key appears twice in one scope; Datadog's meaning is ambiguous here", s);
      return out;
    }
    if (s.type === "var") return this.variable(s.name, s.negated);
    if (s.type === "in") {
      this.use("scope.in");
      return [{ label: this.label(s.key), op: s.negated ? "!~" : "=~", value: `^(${s.values.map(pattern).join("|")})$` }];
    }
    if (s.type === "or") {
      const tags = s.items.filter((i): i is Extract<ScopeExpr, { type: "tag" }> => i.type === "tag" && !i.negated && i.key !== null);
      const keys = new Set(tags.map((t) => t.key));
      if (tags.length !== s.items.length || keys.size !== 1)
        this.manual("scope.or.cross-key", "OR across different tag keys is not a matcher set", s);
      this.use("scope.or.same-key");
      return [{ label: this.label(tags[0]!.key!), op: "=~", value: `^(${tags.map((t) => pattern(t.value)).join("|")})$` }];
    }
    if (s.type === "not") {
      if (s.expr.type !== "tag" || s.expr.negated) this.manual("scope.not.complex", "NOT over a compound filter has no matcher form", s);
      this.use("scope.not");
      return this.tag({ ...s.expr, negated: true });
    }
    return this.tag(s);
  }

  tag(t: Extract<ScopeExpr, { type: "tag" }>): PMatcher[] {
    if (t.key === null) this.manual("scope.bare-tag", `bare tag '${t.value}' has no key to map to a label`, t);
    const label = this.label(t.key);
    if (t.value.startsWith("$")) {
      // `topic:$queue.value`: a template variable used as the value of a fixed key.
      if (t.negated) this.manual("scope.var.negated", "negated template variables are not supported", t);
      this.use("scope.var");
      return [{ label, op: "=~", value: `^(${t.value.replace(/\.(value|key)$/, "")})$` }];
    }
    if (t.value.includes("*")) {
      this.use("scope.tag.wildcard");
      return [{ label, op: t.negated ? "!~" : "=~", value: `^${pattern(t.value)}$` }];
    }
    this.use(t.negated ? "scope.tag.neq" : "scope.tag.eq");
    return [{ label, op: t.negated ? "!=" : "=", value: t.value }];
  }

  variable(name: string, negated: boolean): PMatcher[] {
    if (negated) this.manual("scope.var.negated", `negated template variable $${name} is not supported`);
    const def = this.ctx.variables?.[name];
    if (!def || def.tag === null) {
      // Free-form variable (Datadog `$scope` with no prefix): its value is a whole tag, which no single matcher can take.
      // At its default value `*` it filters nothing, so dropping it is exact under that assumption.
      this.assume("A.var-default");
      this.find("exact-under", "scope.var.free-form", `template variable $${name} has no tag key; dropped (exact while it is left at '*')`, {
        assumptions: ["A.var-default"],
      });
      return [];
    }
    this.use("scope.var");
    return [{ label: this.label(def.tag), op: "=~", value: `^($${name})$` }];
  }

  // ---------- result ----------

  result(node: PNode | null): QueryTranslation {
    let status: Status = "exact";
    const assumptions: string[] = [];
    for (const id of this.rules) {
      const r = RULES[id];
      status = worst(status, r.status);
      for (const a of r.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
    }
    for (const a of this.extraAssumptions) {
      status = worst(status, "exact-under");
      if (!assumptions.includes(a)) assumptions.push(a);
    }
    if (!node) return { status: "manual", promql: null, rules: this.rules, assumptions: [], findings: this.findings };
    const promql = render(node);
    const v = validatePromQL(promql);
    if (!v.ok) {
      this.find("manual", "promql.invalid", `emitted PromQL does not parse: ${v.errors.map((x) => x.message).join("; ")}`, { original: promql });
      return { status: "manual", promql: null, rules: this.rules, assumptions: [], findings: this.findings };
    }
    return { status, promql, rules: this.rules, assumptions: assumptions.sort(), findings: this.findings };
  }
}

/** AST fragment without source spans, for a finding's `original`. */
function stripSpans(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripSpans);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([k]) => k !== "span").map(([k, v]) => [k, stripSpans(v)]));
  return x;
}

/** Datadog wildcard value -> regex body. `*` matches anything; every other character is literal. */
function pattern(v: string): string {
  return v
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
}

function run(ctx: TranslateContext, interval: Duration, monitor: boolean, f: (l: Lowerer) => PNode): QueryTranslation & { node: PNode | null } {
  const l = new Lowerer(ctx, interval, monitor);
  let node: PNode | null = null;
  try {
    node = f(l);
  } catch (e) {
    if (!(e instanceof Manual)) throw e;
  }
  const r = l.result(node);
  return { ...r, node: r.promql ? node : null };
}

/** A dashboard query or formula. `env` maps formula refs (`query1`) to their parsed queries. */
export function translateQuery(e: Expr, ctx: TranslateContext = {}, env?: Map<string, Expr>): QueryTranslation {
  const { node: _n, ...r } = run(ctx, ctx.interval ?? "$__interval", false, (l) => l.expr(e, env).node);
  return r;
}

export interface MonitorTranslation extends QueryTranslation {
  /** Dash0 check-rule thresholds; the expression always ends in `> $__threshold` or `>= $__threshold`. */
  thresholds: { failed: number; degraded?: number } | null;
  /** True when `<`/`<=` was turned into `-(expr) > $__threshold` (maths.md T7): the alert value shown is negated. */
  negated: boolean;
}

/** A metric/query alert monitor. `critical`/`warning` come from options.thresholds (critical defaults to the query's threshold). */
export function translateMonitor(
  mq: MonitorQuery,
  opts: { critical?: number; warning?: number } = {},
  ctx: TranslateContext = {},
): MonitorTranslation {
  let thresholds: MonitorTranslation["thresholds"] = null;
  let negated = false;
  const r = run(ctx, 60, true, (l) => {
    if (mq.change) l.manual("monitor.change", `${mq.change.kind}() monitors have no exact rule yet`);
    if (mq.windowKind !== "last") l.manual("monitor.window.kind", `${mq.window} windows are not supported (only last_*)`);
    if (!["avg", "sum", "min", "max"].includes(mq.timeAgg)) l.manual("monitor.time-agg", `monitor time aggregation ${mq.timeAgg}()`);
    if (mq.windowSeconds % 60 !== 0) l.manual("monitor.window.width", "monitor window must be whole minutes");
    const inner = l.expr(mq.query).node;
    l.use("monitor.window");
    let expr: PNode = { k: "call", fn: `${mq.timeAgg}_over_time`, args: [{ k: "subquery", expr: inner, range: mq.windowSeconds, step: 60 }] };

    // The query's threshold is what Datadog evaluates; options.thresholds.critical should equal it.
    const crit = mq.threshold;
    if (opts.critical !== undefined && opts.critical !== crit) {
      l.assume("A.query-threshold");
      l.find("exact-under", "monitor.threshold.mismatch", `options.thresholds.critical (${opts.critical}) differs from the query threshold (${crit}); using the query's`, {
        assumptions: ["A.query-threshold"],
      });
    }
    let op: ">" | ">=" = ">"; // every other branch below either sets it or throws
    if (mq.op === ">" || mq.op === ">=") {
      l.use("monitor.cmp.gt");
      op = mq.op;
      thresholds = { failed: crit, ...(opts.warning !== undefined ? { degraded: opts.warning } : {}) };
    } else if (mq.op === "<" || mq.op === "<=") {
      l.use("monitor.cmp.lt");
      op = mq.op === "<" ? ">" : ">=";
      negated = true;
      expr = { k: "neg", expr };
      thresholds = { failed: -crit, ...(opts.warning !== undefined ? { degraded: -opts.warning } : {}) };
    } else l.manual("monitor.cmp", `comparator ${mq.op} has no check-rule form`);
    return { k: "binary", op, lhs: expr, rhs: { k: "placeholder", name: "$__threshold" } };
  });
  const { node: _n, ...rest } = r;
  if (!rest.promql) {
    thresholds = null;
    negated = false;
  }
  return { ...rest, thresholds, negated };
}
