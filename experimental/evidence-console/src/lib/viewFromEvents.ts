// When report.json does not exist yet (a run in progress), show what the event log itself records. Nothing more.
import { buildReportView, type ReportError, type ReportView } from "./model";
import type { EventState } from "./reducer";

export function viewFromEvents(s: EventState): ReportView | ReportError {
  const items = s.events
    .filter((e) => e.type === "item.done")
    .map((e) => ({
      id: e.id, title: e.title, kind: e.kind, status: e.status, widget_type: e.widget_type, group: e.group, dashboard: e.dashboard,
      promql: e.promql, source_queries: e.source_queries, reason_codes: e.reason_codes, manual_actions: e.manual_actions,
    }));
  return buildReportView({ items, run: { options: { mode: typeof s.started?.mode === "string" ? s.started.mode : undefined } } });
}
