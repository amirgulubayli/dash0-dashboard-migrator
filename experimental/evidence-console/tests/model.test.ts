import { describe, expect, it } from "vitest";
import { buildBrief } from "../src/lib/brief";
import { buildReportView, labelText, NO_PROMQL, NOT_CHECKED, NOT_RECORDED, type ReportView } from "../src/lib/model";
import { smallReport } from "./helpers";

const view = (r: unknown): ReportView => {
  const v = buildReportView(r);
  if (!v.ok) throw new Error(v.error);
  return v;
};

describe("counts", () => {
  it("counts widgets from the report and keeps monitors and groups out of the widget total", () => {
    const v = view(smallReport());
    expect(v.widgetCount).toBe(4);
    expect(v.monitors.map((m) => m.id)).toEqual(["m1"]);
    expect(v.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(v.labelCounts.reduce((n, c) => n + c.count, 0)).toBe(v.widgetCount);
  });
  it("changes when the report changes (nothing is hard-coded)", () => {
    const r = smallReport();
    r.items.push({ kind: "panel", id: "p5", title: "Extra", status: "unsupported" }, { kind: "panel", id: "p6", title: "Extra 2", status: "unsupported" });
    const v = view(r);
    expect(v.widgetCount).toBe(6);
    expect(v.labelCounts.find((c) => c.label === "unsupported")?.count).toBe(2);
  });
  it("marks text notes inside the label count instead of hiding them", () => {
    const v = view(smallReport());
    const eu = v.labelCounts.find((c) => c.label === "exact-under");
    expect(eu).toEqual({ label: "exact-under", count: 2, textNotes: 1 });
    expect(v.widgets[0]?.isTextNote).toBe(true);
    expect(v.widgets[3]?.isTextNote).toBe(false);
  });
  it("keeps a label the report uses even if it is not one of the standard four", () => {
    const r = smallReport();
    r.items.push({ kind: "panel", id: "p7", title: "Odd", status: "exact" });
    expect(view(r).labelCounts.find((c) => c.label === "exact")?.count).toBe(1);
  });
});

describe("label mapping", () => {
  it("shows exact-under as EXACT IF and the rest in capitals; absent label is NO LABEL", () => {
    expect(labelText("exact-under")).toBe("EXACT IF");
    expect(labelText("bounded")).toBe("BOUNDED");
    expect(labelText("manual")).toBe("MANUAL");
    expect(labelText("unsupported")).toBe("UNSUPPORTED");
    expect(labelText(null)).toBe("NO LABEL");
  });
});

describe("selection", () => {
  it("defaults to the first bounded item, else the first manual item", () => {
    expect(view(smallReport()).defaultSelectionId).toBe("p2");
    const r = smallReport();
    r.items = r.items.filter((i: any) => i.status !== "bounded");
    expect(view(r).defaultSelectionId).toBe("p3");
  });
});

describe("missing and malformed values", () => {
  it("rejects a report that is not usable and says why", () => {
    expect(buildReportView(null)).toEqual({ ok: false, error: "report.json is not a JSON object" });
    expect(buildReportView({ items: "no" })).toEqual({ ok: false, error: "report.json has no items array" });
  });
  it("survives wrong types without throwing and records what it ignored", () => {
    const v = view({ items: [{ kind: "panel", id: 5, title: null, status: 7, promql: "oops", source_queries: [1, "ok"], reason_codes: { a: 1 }, target: "x" }, 42, null] });
    expect(v.widgets).toHaveLength(1);
    const w = v.widgets[0]!;
    expect(w.label).toBeNull();
    expect(w.promql).toEqual([]);
    expect(w.sourceQueries).toEqual(["ok"]);
    expect(w.malformed).toEqual(expect.arrayContaining(["status", "promql", "source_queries", "reason_codes"]));
    expect(w.importStatus.recorded).toBe(false);
    expect(v.others).toHaveLength(2);
  });
  it("shows an unknown reason code without an invented explanation", () => {
    const r = smallReport();
    r.items[4].reason_codes = ["made.up"];
    expect(view(r).widgets.find((w) => w.id === "p4")?.reasons).toEqual([{ code: "made.up", explanation: null }]);
  });
  it("only accepts http(s) Dash0 links", () => {
    const r = smallReport();
    r.items[3].dash0Url = "javascript:alert(1)";
    r.items[4].dash0Url = "https://app.dash0.com/x";
    const v = view(r);
    expect(v.widgets.find((w) => w.id === "p3")?.dash0Link).toBeNull();
    expect(v.widgets.find((w) => w.id === "p4")?.dash0Link).toBe("https://app.dash0.com/x");
  });
});

describe("query rendering", () => {
  it("keeps the original query and the PromQL as separate lists and never copies one into the other", () => {
    const w = view(smallReport()).widgets.find((x) => x.id === "p2")!;
    expect(w.sourceQueries).toEqual(["avg:a{*}"]);
    expect(w.promql).toEqual(["avg(a)"]);
  });
  it("leaves PromQL empty when none was generated (the screen prints the fixed line)", () => {
    const w = view(smallReport()).widgets.find((x) => x.id === "p3")!;
    expect(w.promql).toEqual([]);
    expect(NO_PROMQL).toBe("No PromQL generated");
  });
});

describe("evidence kinds stay distinct", () => {
  it("a recorded import says nothing about live data or parity", () => {
    const w = view(smallReport()).widgets.find((x) => x.id === "p2")!;
    expect(w.importStatus.recorded).toBe(true);
    expect(w.importStatus.text).toMatch(/dry run/);
    expect(w.liveData).toEqual({ recorded: false, text: NOT_CHECKED });
    expect(w.parity).toEqual({ recorded: false, text: NOT_CHECKED });
    expect(w.dash0Link).toBeNull();
  });
  it("shows live and parity only when the report records them, each on its own", () => {
    const r = smallReport();
    r.items[2].live = "live";
    r.items[3].parity = { status: "within 1%" };
    const v = view(r);
    const p2 = v.widgets.find((x) => x.id === "p2")!;
    const p3 = v.widgets.find((x) => x.id === "p3")!;
    expect(p2.liveData.text).toBe("live");
    expect(p2.parity.recorded).toBe(false);
    expect(p3.parity.text).toBe("within 1%");
    expect(p3.liveData.recorded).toBe(false);
  });
  it("shows an item with no target as Not recorded, not as imported", () => {
    expect(view(smallReport()).widgets.find((x) => x.id === "p3")!.importStatus.text).toBe(NOT_RECORDED);
  });
  it("shows a check rule as disabled when the run records enableRules=false, and as not recorded otherwise", () => {
    expect(view(smallReport()).monitors[0]?.checkRuleState?.text).toMatch(/^Disabled/);
    const r = smallReport();
    delete r.run.options.enableRules;
    expect(view(r).monitors[0]?.checkRuleState).toEqual({ recorded: false, text: NOT_RECORDED });
  });
});

describe("brief", () => {
  it("is built only from the report: ids and order come straight from it", () => {
    const b = buildBrief(view(smallReport()));
    expect(b.manualOrUnsupported.map((e) => e.id)).toEqual(["p3"]);
    expect(b.bounded.map((e) => e.id)).toEqual(["p2"]);
    expect(b.conditions).toEqual([{ condition: "no counter reset", ids: ["p4"] }]);
    expect(b.textNotesExcluded).toBe(1);
    expect(b.monitorIssues.map((m) => m.id)).toEqual(["m1"]);
    expect(b.total).toBe(4);
  });
});
