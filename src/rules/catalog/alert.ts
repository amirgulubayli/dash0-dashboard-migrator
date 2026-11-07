// Monitor → Dash0 check rule: classify → (query stages) → monitor → alert → message. Plan 04 §2 (T6).
// Behavioural options are claims about when the rule fires; notification options are not (A.notify-manual).
import type { RuleDef } from "../types.js";
import { section } from "./build.js";

const P04 = "plan 04 §2; docs/research/kb/06_TRANSLATION_RULES.md §8";
const classify = section("classify", "T6", "planned", P04);
const alert = section("alert", "T6", "planned", P04);
const msg = section("message", "T6", "planned", "plan 04 §2.5");

export const ALERT_RULES: RuleDef[] = [
  // ---------- classify ----------
  classify("classify.monitor.metric", 10, "exact", 'monitor type "metric alert" or "query alert"', "goes through the query stages and the monitor stage"),
  classify("classify.monitor.log", 20, "exact", 'monitor type "log alert"', "goes through the logs stage (logs.alert)"),
  classify("classify.monitor.other", 999, "manual", "composite, service check, event, synthetics, SLO, process, anomaly-type and any other monitor", "no rule; original kept", {
    fallback: true,
    findingCode: "monitor.type",
  }),

  // ---------- alert: identity and thresholds ----------
  alert("alert.id", 10, "exact", "monitor id", 'id "dd-monitor-<id>", label dd_monitor_id="<id>" (re-runs overwrite, D-31)'),
  alert("alert.name", 20, "exact", "monitor name", "name as is (template tokens in names are not expanded)"),
  alert("alert.threshold.both", 30, "exact", "critical and warning thresholds", "thresholds {failed: critical, degraded: warning}"),
  alert("alert.threshold.warnonly", 40, "exact", "warning threshold only", "thresholds {degraded: warning}"),
  alert("alert.threshold.recovery", 50, "manual", "critical_recovery / warning_recovery", "no output: value hysteresis has no Dash0 form (keep_firing_for is time-based)", {
    findingCode: "monitor.option",
    note: "Policy (kb 06 §8): never import a weaker active alert silently. An override may import it disabled.",
  }),
  alert("alert.group", 60, "exact", "multi-alert by {tags}", "grouping stays in the expression, one alert per series"),
  alert("alert.defaults", 70, "exact-under", "evaluation schedule", 'interval "1m", for "0s", keep_firing_for "0s"', { assumptions: ["A.eval-1m"] }),

  // ---------- alert: behavioural options ----------
  alert("alert.opt.evaluation_delay", 100, "exact", "options.evaluation_delay = s", "offset s on every selector in the expression", {
    findingCode: "monitor.option",
    note: "Same transform as map.timeshift. Plan 04 had it as a warn-only finding; kb 06 §8 proposes the offset.",
  }),
  alert("alert.opt.require_full_window.true", 110, "exact-under", "require_full_window: true", "expression unchanged", { assumptions: ["A.full-window"], findingCode: "monitor.option" }),
  alert("alert.opt.require_full_window.false", 120, "exact", "require_full_window: false or absent", "expression unchanged (PromQL evaluates partial windows)"),
  alert("alert.opt.new_group_delay", 130, "exact-under", "new_group_delay / new_host_delay", "expression unchanged", { assumptions: ["A.no-new-groups"], findingCode: "monitor.option" }),
  alert("alert.opt.no_data", 140, "exact-under", "notify_no_data + no_data_timeframe T, ungrouped monitor", 'companion rule absent_over_time(<selector>[T]), id "dd-monitor-<id>-nodata", behind a CLI flag', {
    assumptions: ["A.boundary"],
    findingCode: "monitor.option",
  }),
  alert("alert.opt.no_data.grouped", 150, "manual", "notify_no_data on a multi-alert monitor", "no companion rule: absent_over_time does not work per group", { findingCode: "monitor.option" }),

  // ---------- alert: notification and metadata options ----------
  alert("alert.opt.notification", 200, "exact-under", "renotify_interval, escalation_message, notify_audit, include_tags, notification channels", "not emitted; listed in the report as manual setup", {
    assumptions: ["A.notify-manual"],
    findingCode: "monitor.option",
  }),
  alert("alert.priority", 210, "exact", "priority n", 'label priority="P<n>"'),
  alert("alert.tags", 220, "exact", "tags k:v with valid label keys", "labels {k: v}"),
  alert("alert.tags.rename", 230, "exact-under", "tags whose keys are not valid label names", "key sanitised to [a-zA-Z_][a-zA-Z0-9_]*, rename recorded", { assumptions: ["A.label-rename"] }),
  alert("alert.opt.unknown", 999, "manual", "any other option", "no output; option kept in the report", { fallback: true, findingCode: "monitor.option" }),

  // ---------- message ----------
  msg("alert.msg.summary", 10, "exact", "monitor name and message", "annotations {summary: name, description: rewritten message}"),
  msg("alert.msg.value", 20, "exact", "{{value}}", "{{ $value }} (negated rules carry a note: the value shown is negated)"),
  msg("alert.msg.label", 30, "exact", "{{<tag>.name}}", "{{ $labels.<tag> }} with the same key sanitising as alert.tags"),
  msg("alert.msg.conditional.label", 40, "exact", "{{#is_alert}} / {{#is_warning}} / {{#is_recovery}} blocks", '{{ if eq $labels.<threshold> "failed" }} … {{ end }}', {
    requires: ["probe:threshold-label"],
  }),
  msg("alert.msg.conditional", 50, "exact-under", "{{#is_alert}} / {{#is_warning}} blocks (until probe:threshold-label is yes)", "the block's text kept unconditionally", { assumptions: ["A.msg-conditional"] }),
  msg("alert.msg.handle", 60, "exact-under", "@slack-… / @pagerduty-… / @user@… handles", "removed from the text, listed in the report as channels to create", { assumptions: ["A.notify-manual"] }),
  msg("alert.msg.unknown-token", 999, "exact-under", "any other {{…}} token", 'escaped as literal text {{ "{{token}}" }} so the Go template still parses', {
    assumptions: ["A.msg-verbatim"],
    fallback: true,
  }),
];
