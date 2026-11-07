import type { GridBox, ReportItem } from "./report";

export interface PlacedWidget { item: ReportItem; box: GridBox }
export interface PlacedGroup {
  item: ReportItem | null;
  title: string;
  x: number;
  w: number;
  rows: number; // rows actually used by widgets
  widgets: PlacedWidget[];
}
export interface Band { groups: PlacedGroup[] }
export interface MapLayout { bands: Band[]; unplaced: ReportItem[]; warnings: string[] }

const COLS = 12;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Datadog flows groups in order, and group y values restart, so groups are packed in
 * file order into bands of 12 columns. Widgets keep their relative x, y, w, h inside a
 * grid that is group.w columns wide.
 */
export function buildMapLayout(items: ReportItem[]): MapLayout {
  const warnings: string[] = [];
  const groups = items.filter((i) => i.kind === "group");
  const widgets = items.filter((i) => i.kind === "widget");
  const unplaced: ReportItem[] = [];
  const placed: PlacedGroup[] = [];

  for (const g of groups) {
    if (!g.layout) continue;
    const w = clamp(Math.round(g.layout.w), 1, COLS);
    const x = clamp(Math.round(g.layout.x), 0, COLS - w);
    if (w !== g.layout.w || x !== g.layout.x) warnings.push(`${g.id}: position clamped to the grid.`);
    placed.push({ item: g, title: g.title || g.id, x, w, rows: 0, widgets: [] });
  }
  const byTitle = new Map(placed.map((p) => [p.title, p]));

  for (const it of widgets) {
    const grp = it.group ? byTitle.get(it.group) : undefined;
    if (!grp || !it.layout) {
      unplaced.push(it);
      continue;
    }
    const w = clamp(Math.round(it.layout.w), 1, grp.w);
    const x = clamp(Math.round(it.layout.x), 0, grp.w - w);
    const h = Math.max(1, Math.round(it.layout.h));
    const y = Math.max(0, Math.round(it.layout.y));
    if (w !== it.layout.w || x !== it.layout.x) warnings.push(`${it.id}: position clamped to its group.`);
    grp.widgets.push({ item: it, box: { x, y, w, h } });
    grp.rows = Math.max(grp.rows, y + h);
  }

  const bands: Band[] = [];
  let cur: Band | null = null;
  let cursor = 0;
  for (const g of placed) {
    if (!cur || g.x < cursor || g.x + g.w > COLS) {
      cur = { groups: [] };
      bands.push(cur);
    }
    cur.groups.push(g);
    cursor = g.x + g.w;
  }
  return { bands, unplaced, warnings };
}

/** True when the smallest widget would render under the minimum tile height at this row unit. */
export function needsStretch(layout: MapLayout, rowUnit: number, gap: number, minTile: number): boolean {
  return layout.bands.some((b) =>
    b.groups.some((g) => g.widgets.some((w) => w.box.h * rowUnit + (w.box.h - 1) * gap < minTile)),
  );
}
