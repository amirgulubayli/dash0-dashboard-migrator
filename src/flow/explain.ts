// `dd2dash0 explain "<datadog query>"`: one query, shown going through the real engine stage by stage: the
// recursive-descent parse (the AST as a tree), the mapping tables, the translation rules that fired with their
// claims, the PromQL (validated with the official grammar), and the final claim with the conditions it rests on.
// It calls exactly the code a migration calls; nothing here translates on its own.
import { basename } from "node:path";
import { metricAvailability, metricLookup, metricRatio, ddKindLookup, tagLookup } from "../ir/index.js";
import { loadDdKinds, loadMappings, type Mappings } from "../ir/mappings.js";
import { parseMonitorQuery, parseQuery, type Arg, type Expr, type MonitorQuery, type ScopeExpr } from "../parse/index.js";
import { ASSUMPTIONS, RULES, translateMonitor, translateQuery, type QueryTranslation, type TranslateContext } from "../translate/query/index.js";
import { validatePromQL } from "../validate/promql.js";
import { claim, CLAIM_MEANING, CLAIM_ROLE, CLAIMS, hang, padEnd, paint, width, wrap, type Claim, type Paint, type Ui } from "../ui/style.js";

const isMonitor = (src: string) => /^\s*[a-z_]+\(\s*(last|current|next)_\w+\s*\)\s*:/i.test(src);

/** The AST as an indented tree, using the source spans for scopes so the original text shows. */
export function astTree(e: Expr, src: string): string[] {
  const out: string[] = [];
  const text = (s: { start: number; end: number }) => src.slice(s.start, s.end);
  const scope = (s: ScopeExpr | null): string => (s === null ? "(none)" : s.type === "all" ? "*" : text(s.span));
  const node = (x: Expr, pre: string, last: boolean, label = ""): void => {
    const head = `${pre}${last ? "└─ " : "├─ "}${label}`;
    const kid = pre + (last ? "   " : "│  ");
    switch (x.type) {
      case "metric": {
        out.push(`${head}metric ${x.metric}`);
        const rows = [
          ["space agg", x.spaceAgg ?? "(none, legacy form)"],
          ["scope", scope(x.scope)],
          ...(x.groupBy.length ? [["group by", x.groupBy.join(", ")]] : []),
          ...(x.valueFilter ? [["value filter", `v ${x.valueFilter.op} ${x.valueFilter.value}`]] : []),
        ];
        rows.forEach(([k, v], i) => out.push(`${kid}${i === rows.length - 1 ? "└─ " : "├─ "}${k}: ${v}`));
        return;
      }
      case "number":
        out.push(`${head}number ${x.raw}`);
        return;
      case "ref":
        out.push(`${head}ref ${x.name}`);
        return;
      case "paren":
        return node(x.expr, pre, last, label);
      case "neg":
        out.push(`${head}negate`);
        return node(x.expr, kid, true);
      case "binary":
        out.push(`${head}binary ${x.op}`);
        node(x.left, kid, false);
        return node(x.right, kid, true);
      case "postfix":
        out.push(`${head}.${x.call.name}(${x.call.args.map((a) => argText(a, src)).join(", ")})`);
        return node(x.target, kid, true);
      case "call": {
        out.push(`${head}${x.name}()`);
        x.args.forEach((a, i) => {
          const lastArg = i === x.args.length - 1;
          if (a.type === "expr") node(a.expr, kid, lastArg);
          else out.push(`${kid}${lastArg ? "└─ " : "├─ "}${argText(a, src)}`);
        });
        return;
      }
    }
  };
  node(e, "", true);
  return out;
}

function argText(a: Arg, src: string): string {
  if (a.type === "string") return `'${a.value}'`;
  if (a.type === "word") return a.value;
  if (a.type === "tags") return `{${a.tags.join(", ")}}`;
  if (a.type === "named") return `${a.name}=${argText(a.value, src)}`;
  return src.slice(a.span.start, a.span.end);
}

/** Every metric name and tag key the query uses (for the mapping stage). */
function collect(e: Expr, metrics: Set<string>, tags: Set<string>): void {
  const scopeTags = (s: ScopeExpr | null): void => {
    if (!s) return;
    if (s.type === "tag" && s.key) tags.add(s.key);
    else if (s.type === "in") tags.add(s.key);
    else if (s.type === "and" || s.type === "or") s.items.forEach(scopeTags);
    else if (s.type === "not") scopeTags(s.expr);
  };
  switch (e.type) {
    case "metric":
      metrics.add(e.metric);
      e.groupBy.forEach((g) => tags.add(g));
      scopeTags(e.scope);
      return;
    case "paren":
    case "neg":
      return collect(e.expr, metrics, tags);
    case "binary":
      collect(e.left, metrics, tags);
      return collect(e.right, metrics, tags);
    case "postfix":
      return collect(e.target, metrics, tags);
    case "call":
      for (const a of e.args) if (a.type === "expr") collect(a.expr, metrics, tags);
      return;
  }
}

/** Light PromQL highlighting: metric names in the accent color, functions bold, keywords dim. */
export function highlightPromQL(p: Paint, q: string): string {
  if (!p.on) return q;
  return q
    .replace(/\b(by|without|on|ignoring|group_left|group_right|offset|bool)\b/g, (m) => p.dim(m))
    .replace(/\b([a-z_]+)(?=\s*\()/g, (m) => p.bold(m))
    .replace(/otel_metric_name="([^"]+)"/g, (_m, name: string) => `otel_metric_name="${p.accent(name)}"`);
}

export interface ExplainOptions {
  query: string;
  mappingsDir: string;
  ui: Ui;
  version: string;
  now?: () => number;
}

/** Log / event search syntax (not a metric query): `source:nginx @http.status_code:500`, `service:web status:error`. */
const looksLikeLogSearch = (src: string) => !/[{}]/.test(src) && (/(^|\s)@[\w.]+:/.test(src) || /^(source|service|status|host|env):\S/.test(src));

const ruleOf = (id: string) => (RULES as Record<string, { status: string; description: string }>)[id];
const isKnown = (s: string): s is Claim => (CLAIMS as readonly string[]).includes(s);
/** The claim meanings, phrased for one query (the conditions or reasons follow). */
const MEANING: Record<string, string> = {
  ...CLAIM_MEANING,
  "exact-under": "same result as Datadog whenever these conditions hold",
  bounded: "within a stated error bound of Datadog's result; the bound and its conditions are at the end",
  manual: "needs a person: no exact or bounded rule covers this query",
};

export function explain(o: ExplainOptions): number {
  const { ui } = o;
  const p = ui.p;
  const now = o.now ?? (() => performance.now());
  // Timings only on a live terminal: piped or logged output stays byte-for-byte deterministic.
  const ms = (t: number) => (ui.out.isTTY ? `  ${t.toFixed(2)} ms` : "");
  const cols = ui.out.columns;
  const src = o.query.trim();
  const dotOf = (status: string) => p[isKnown(status) ? CLAIM_ROLE[status] : "bad"]("●");
  const section = (title: string, summary = "", dot = p.accent("●")) => {
    const one = `${dot} ${p.bold(title)}${summary ? `  ${summary}` : ""}`;
    // Narrow terminal: the summary moves to its own line rather than running off the edge.
    if (width(one) <= cols) ui.line(one);
    else {
      ui.line(`${dot} ${p.bold(title)}`);
      ui.line(`  ${summary}`);
    }
  };
  /** A ⎿ detail line, word-wrapped to the terminal; continuation lines hang under the text. */
  const item = (prefix: string, text: string, color?: (s: string) => string, min = 28) =>
    hang(prefix, text, cols - 4, { under: 2, min, ...(color ? { color } : {}) }).forEach((l, i) => (i === 0 ? ui.detail(l) : ui.line(`    ${l}`)));
  const detailWrapped = (text: string, color?: (s: string) => string) => item("", text, color);
  ui.header(o.version, "explain: one query through the engine");

  const monitor = isMonitor(src);
  const t0 = now();
  const parsed = monitor ? parseMonitorQuery(src) : parseQuery(src);
  const parseMs = now() - t0;
  if (!parsed.ok) {
    const e = parsed.error;
    section("Parse", p.bad("✗ not a Datadog metric query"), p.bad("●"));
    ui.line(`    ${src}`);
    ui.line(`    ${" ".repeat(Math.max(0, e.pos))}${p.bad("^")} ${e.message}`);
    ui.line();
    if (looksLikeLogSearch(src))
      detailWrapped(`This looks like a log search (source:, @attribute). explain covers metric and monitor queries; a log widget migrates as a "! manual" placeholder panel that keeps this query.`);
    else detailWrapped(`Expected <agg>:<metric>{<scope>} by {<tags>}, for example avg:redis.mem.used{env:prod} by {host}, or a monitor query such as avg(last_5m):avg:redis.mem.used{*} > 90`);
    return 3;
  }
  const expr: Expr = monitor ? (parsed.value as MonitorQuery).query : (parsed.value as Expr);

  const mappings: Mappings = loadMappings(o.mappingsDir);
  const kinds = loadDdKinds(o.mappingsDir);
  const ctx: TranslateContext = { metric: metricLookup(mappings), availability: (dd) => metricAvailability(mappings, dd), ratio: metricRatio(mappings), tag: tagLookup(mappings), ddKind: ddKindLookup(kinds, mappings) };
  const t1 = now();
  const r: QueryTranslation & { thresholds?: { failed: number; degraded?: number } | null } = monitor ? translateMonitor(parsed.value as MonitorQuery, { critical: (parsed.value as MonitorQuery).threshold }, ctx) : translateQuery(expr, ctx);
  const trMs = now() - t1;
  const v = r.promql ? validatePromQL(r.promql) : null;
  // The findings that set the final claim (same claim as the result); the rest are notes.
  const deciding = [...new Set(r.findings.filter((f) => f.status === r.status).map((f) => f.code))];
  const thresholds = r.thresholds ? `failed > ${r.thresholds.failed}${r.thresholds.degraded !== undefined ? ` · degraded > ${r.thresholds.degraded}` : ""}` : "";

  // The answer first (claim, what it means, the PromQL); the numbered stages show how the engine got there.
  ui.line(`  ${src}`);
  ui.line();
  const why = r.status === "exact-under" && r.assumptions.length ? `if ${r.assumptions.join(", ")}` : deciding.length ? `because of ${deciding.join(", ")}` : "";
  const top = `${dotOf(r.status)} ${p.bold("Claim")}  ${claim(p, r.status)}`;
  if (!why || width(`${top}  ${why}`) <= cols) ui.line(`${top}${why ? `  ${p.dim(why)}` : ""}`);
  else {
    ui.line(top);
    detailWrapped(why, p.dim);
  }
  detailWrapped(MEANING[r.status] ?? "");
  if (r.promql) ui.detail(`${p.dim("PromQL")}  ${highlightPromQL(p, r.promql)}`);
  else ui.detail(`${p.dim("PromQL")}  ${p.warn("none")}${p.dim(": a migration lands a placeholder panel with the original query")}`);
  if (thresholds) ui.detail(`${p.dim("rule")}    ${thresholds}`);
  ui.line();
  const rule = "How the engine got there ";
  ui.line(p.dim(rule + "─".repeat(Math.max(0, Math.min(cols, 72) - rule.length))));
  ui.line();

  // 1. Parse
  section("1 Parse", p.dim(`recursive-descent parser, Datadog query grammar → AST${ms(parseMs)}`));
  if (monitor) {
    const m = parsed.value as MonitorQuery;
    ui.line(`  ${p.dim("monitor")}  ${m.timeAgg}(${m.window}) ${m.change ? `${m.change.kind}(…, ${m.change.compareWindow}) ` : ""}${m.op} ${m.threshold}`);
  }
  for (const l of astTree(expr, src)) ui.line(`  ${l.replace(/^[│├└─ ]+/, (m) => p.dim(m)).replace(/^(\S*?[│├└─ ]*)([a-z ]+:)/, (_m, a: string, b: string) => a + p.dim(b))}`);
  ui.line();

  // 2. Map
  const metrics = new Set<string>();
  const tags = new Set<string>();
  collect(expr, metrics, tags);
  section("2 Map", p.dim(`${mappings.metrics.size.toLocaleString("en")} curated metric mappings · ${Object.keys(kinds).length.toLocaleString("en")} Datadog metric kinds`));
  for (const m of metrics) {
    const hit = ctx.metric!(m);
    const avail = ctx.availability!(m);
    const origin = mappings.origin.get(m);
    if (hit) {
      const st = hit.status ?? "exact";
      const extra = [hit.kind, st === "approximate" ? "approximate → bounded" : st, ...(hit.scale && hit.scale !== 1 ? [`× ${hit.scale}`] : []), ...(hit.sumBy?.length ? [`sum over ${hit.sumBy.join(", ")}`] : []), ...(hit.labels ? Object.entries(hit.labels).map(([k, val]) => `${k}="${val}"`) : [])];
      item(`${m} ${p.dim("→")} ${p.accent(hit.otel)}  `, `${extra.join(" · ")}${origin ? `  mappings/datadog/${basename(origin)}` : ""}`, p.dim, 24);
    } else {
      const ratio = ctx.ratio!(m);
      if (ratio) {
        ui.detail(`${m} ${p.dim("→")} ${p.accent(`${ratio.num} / ${ratio.den}`)}  ${p.dim("ratio of two mapped metrics")}${origin ? p.dim(`  mappings/datadog/${basename(origin)}`) : ""}`);
        for (const side of [ratio.num, ratio.den]) {
          const h = ctx.metric!(side);
          if (h) ui.detail(`  ${side} ${p.dim("→")} ${p.accent(h.otel)}  ${p.dim([h.kind, h.status ?? "exact"].join(" · "))}`);
        }
        continue;
      }
      const kind = ctx.ddKind!(m);
      const what = avail === "unmapped" ? "no curated mapping" : avail === "derived" ? "derived (no single OTel metric)" : avail.replace(/_/g, " ");
      ui.detail(`${m} ${p.dim("→")} ${p.warn(what)}${kind ? p.dim(`  Datadog kind ${kind} (integrations-core metadata)`) : ""}`);
    }
  }
  for (const t of tags) {
    const mapped = ctx.tag!(t);
    ui.detail(`tag ${t} ${p.dim("→")} ${mapped ? p.accent(mapped) : `${t.replace(/\./g, "_")} ${p.dim("(default: dots → underscores)")}`}`);
  }
  ui.line();

  // 3. Rules
  section("3 Rules", p.dim(r.rules.length ? `${r.rules.length} applied from the rule table${ms(trMs)}` : `none applied: no rule covers this query${ms(trMs)}`));
  const plain = paint(false);
  const idW = Math.max(0, ...r.rules.map((id) => id.length));
  const claimW = Math.max(0, ...r.rules.map((id) => width(claim(plain, ruleOf(id)?.status ?? "?"))));
  for (const id of r.rules) {
    const rl = ruleOf(id);
    const head = `${id.padEnd(idW)}  ${padEnd(claim(p, rl?.status ?? "?"), claimW)}`;
    const desc = rl?.description ?? "";
    // Narrow terminal: the description moves under the rule id instead of running off the edge.
    item(`${head}  `, desc, p.dim, 40);
  }
  ui.line();

  // 4. PromQL
  if (r.promql && v) {
    section("4 PromQL", v.ok ? `${p.dim("parsed by the official PromQL grammar (lezer-promql)")} ${p.ok("✓")}` : p.bad("does not parse: " + v.errors.map((e) => e.message).join("; ")));
    ui.line(`  ${highlightPromQL(p, r.promql)}`);
    if (thresholds) ui.detail(p.dim(`Dash0 check rule: ${thresholds} (the expression ends in $__threshold)`));
  } else section("4 PromQL", p.warn("none: a migration lands a placeholder panel with the original query"), p.warn("●"));
  ui.line();

  // 5. The claim again, with everything it rests on.
  section("Claim", claim(p, r.status), dotOf(r.status));
  detailWrapped(`${MEANING[r.status] ?? ""}${r.assumptions.length ? ":" : ""}`, p.dim);
  const aw = Math.max(0, ...r.assumptions.map((a) => a.length));
  for (const a of r.assumptions) item(`${p.dim(a.padEnd(aw))}  `, (ASSUMPTIONS as Record<string, string>)[a] ?? "");
  if (r.findings.length) {
    const cw = Math.max(...r.findings.map((f) => width(claim(plain, f.status))));
    for (const f of r.findings) {
      ui.detail(`${padEnd(claim(p, f.status), cw)}  ${f.code}`);
      for (const l of wrap(f.message, cols - 6)) ui.line(`      ${p.dim(l)}`); // long prose: its own block under the code
    }
  }
  ui.line();
  for (const l of wrap("Deterministic: same query and tables, same output. No AI model is involved.", cols)) ui.line(p.dim(l));
  return r.promql ? 0 : 1;
}
