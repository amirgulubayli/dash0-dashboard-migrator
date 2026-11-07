// Stages around the translation: ingest, logs, validate, canonical, emit.
import type { RuleDef } from "../types.js";
import { EPS_RATE, section } from "./build.js";

const ingest = section("ingest", "T2", "planned", "plan 00; dash0-migrator skill (key facts)");
const logs = section("logs", "T12", "planned", "plan 01 §1; maths.md §8");
const validate = section("validate", "T4", "implemented", "dash0-migrator rule 3");
const preflight = section("validate", "T7", "implemented", "T7 PR #5");
const canon = section("canonical", "T13", "planned", "plan 02 rule 5; plan 03 §5");
const emitT7 = section("emit", "T7", "implemented", "T7 PR #5; D-30, D-31");
const emitT8 = section("emit", "T8", "planned", "plan 04 §3; plan 03 §5");

export const PIPELINE_RULES: RuleDef[] = [
  // ---------- ingest ----------
  ingest("ingest.monitor.unwrap", 10, "exact", "integrations-core monitor file {version, definition: {...}}", "the definition object"),
  ingest("ingest.numbers", 20, "exact", 'numbers stored as strings ("90", "0")', "numbers"),
  ingest("ingest.keep-raw", 30, "exact", "every source item", "raw JSON kept next to its IR node (rule 4), sha256 → certificate.sourceHash"),

  // ---------- logs ----------
  logs("logs.count", 10, "bounded", "log query, compute count, search Q, group_by facets", 'sum by (<labels>) (increase({otel_metric_name="dash0.logs", <matchers(Q)>}[$__interval]))', {
    epsilon: EPS_RATE,
    requires: ["probe:log-labels"],
    evidence: ["proof:T3"],
    note: "exact-under(A.same-samples) once probe:anchored is yes (maths.md §8).",
  }),
  logs("logs.rate", 20, "bounded", "log count shown as a rate", 'sum by (<labels>) (rate({otel_metric_name="dash0.logs", …}[1m]))', { epsilon: EPS_RATE, requires: ["probe:log-labels"], evidence: ["proof:T3"] }),
  logs("logs.search.kv", 30, "exact", "key:value / -key:value", 'label="value" / label!="value"', { requires: ["probe:log-labels"] }),
  logs("logs.search.wildcard", 40, "exact", "key:val*", 'label=~"^val.*$"'),
  logs("logs.search.status", 50, "exact", "status:error", "severity label matcher", { requires: ["probe:log-labels"] }),
  logs("logs.search.word", 60, "exact", "bare words", "body regex matcher", { requires: ["probe:log-labels"] }),
  logs("logs.search.or.cross-key", 70, "exact", "key1:a OR key2:b", "count(A) + count(B) − count(A and B) (inclusion–exclusion)", { evidence: ["proof:log-or", "exhaustive:E5"] }),
  logs("logs.alert", 80, "bounded", "log alert monitor", 'sum(increase({otel_metric_name="dash0.logs", …}[W])) > $__threshold', { epsilon: EPS_RATE, requires: ["probe:log-labels"], evidence: ["proof:T3"] }),
  logs("logs.measure", 90, "manual", "avg / sum / percentile / cardinality over @attr", "no output: dash0.logs only counts", { findingCode: "query.datasource" }),
  logs("logs.stream", 100, "manual", "log_stream / list_stream widget", "placeholder until the LogTable schema comes from T0"),
  logs("logs.unparsed", 999, "manual", "log search the log-search parser does not accept", "no output; original kept", { fallback: true, findingCode: "query.parse_error" }),

  // ---------- validate ----------
  validate("validate.promql", 10, "exact", "every emitted PromQL string", "must parse with @prometheus-io/lezer-promql"),
  validate("promql.invalid", 20, "manual", "emitted PromQL that does not parse", "nothing emitted; error finding (never a broken query)"),
  preflight("validate.preflight", 30, "exact", "every DashboardDefinition / PrometheusAlertRule", "preflightDashboard / preflightCheckRule against Dash0's OpenAPI types"),

  // ---------- canonical ----------
  canon("canonical.matchers", 10, "exact", "label matchers", "sorted by label name, then operator"),
  canon("canonical.json", 20, "exact", "output JSON", "keys sorted, numbers in shortest round-trip form"),
  canon("canonical.hash", 30, "exact", "canonical output", "sha256 → certificate.outputHash; same input gives the same bytes (determinism test M2)"),

  // ---------- emit ----------
  emitT7("emit.id", 10, "exact", "every dashboard and check rule", 'id "dd-<source id>", so re-runs overwrite (idempotent)'),
  emitT7("emit.single-item", 20, "exact", "import", "one POST per item (/api/import/dashboard, /api/import/check-rule), never the all-or-nothing bulk call"),
  emitT7("emit.rules-disabled", 30, "exact", "imported check rules", "enabled: false unless --enable-rules (D-30)"),
  emitT7("emit.readback", 40, "exact", "after import", "GET by id and compare the normalised payload; mismatch is an error finding"),
  emitT8("emit.certificate", 50, "exact", "every source item", "one report.json entry with its certificate: hashes, rules, status, assumptions, ε, checks"),
  emitT8("emit.no-silent-drop", 60, "exact", "the whole run", "count(source items) = count(report items); otherwise the run fails"),
];
