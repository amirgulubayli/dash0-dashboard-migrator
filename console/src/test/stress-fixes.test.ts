// Fixes from Henry's stress run (docs/stress/STRESS_REPORT.md, hub #675).
import { describe, expect, it } from "vitest";
import cliReport from "@/test/fixtures/cli-report.redis.json?raw";
import { importState, parseReport, safeHttpsUrl, type ReportItem } from "@/lib/report";

const ok = (text: string) => {
  const r = parseReport(text);
  if (!r.ok) throw new Error(r.error);
  return r.report;
};

describe("stress-run fixes", () => {
  it("accepts a report.json saved with a UTF-8 byte order mark", () => {
    const plain = ok(cliReport);
    const bom = ok("﻿" + cliReport);
    expect(bom.items.length).toBe(plain.items.length);
  });

  it("only links https: URLs", () => {
    expect(safeHttpsUrl("https://app.dash0.com/dashboards?org=x")).toBe(
      "https://app.dash0.com/dashboards?org=x",
    );
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("JavaScript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("http://app.dash0.com")).toBeUndefined();
    expect(safeHttpsUrl("data:text/html,x")).toBeUndefined();
    expect(safeHttpsUrl("/dashboards")).toBeUndefined();
    expect(safeHttpsUrl(undefined)).toBeUndefined();
  });

  it("derives the import state from the data", () => {
    const base = { id: "a", status: "exact", kind: "widget" } as ReportItem;
    expect(importState(base)).toBe("pending");
    expect(importState({ ...base, verification: { imported: true } })).toBe("imported");
    expect(importState({ ...base, dash0: { import_status: "created" } })).toBe("imported");
    expect(importState({ ...base, dash0: { import_status: "failed" } })).toBe("failed");
  });

  it("keeps an item with an unknown or numeric status, counted as can't migrate, with a warning", () => {
    const j = JSON.parse(cliReport);
    j.items[0].status = "weird";
    j.items[1].status = 7;
    const r = ok(JSON.stringify(j));
    expect(r.items.length).toBe(j.items.length);
    expect(r.items.find((i) => i.id === j.items[0].id)?.status).toBe("unsupported");
    expect(r.items.find((i) => i.id === j.items[1].id)?.status).toBe("unsupported");
    expect(r.warnings.filter((w) => w.includes("unknown status")).length).toBe(2);
  });
});
