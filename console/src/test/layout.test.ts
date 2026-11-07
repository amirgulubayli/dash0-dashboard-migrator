import { expect, it } from "vitest";
import sample from "@/data/report.sample.json?raw";
import { parseReport } from "@/lib/report";
import { buildMapLayout } from "@/lib/layout";
it("packs all seven groups in file order and retains widget geometry", () => {
  const result = parseReport(sample);
  if (!result.ok) throw new Error(result.error);
  const layout = buildMapLayout(result.report.items);
  expect(layout.bands.flatMap((b) => b.groups.map((g) => g.item?.id))).toEqual(["group-1", "group-2", "group-3", "group-4", "group-5", "group-6", "group-7"]);
  expect(layout.unplaced).toHaveLength(0);
  expect(layout.bands[1]?.groups[0]?.widgets.find((w) => w.item.id === "widget-3.4")?.box).toEqual({ x: 4, y: 4, w: 2, h: 2 });
});