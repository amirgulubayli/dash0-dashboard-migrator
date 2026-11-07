// Gap picking for the improvement loop. Pure and deterministic: the same report gives the same gap list, in the same
// order. Nothing here calls a model.
//
// A "gap" is a reason items are worse than exact, grouped so one agent can close it with one coherent change:
//   metric.unmapped / metric.no_equivalent  -> by integration prefix (nginx., postgresql., ...)
//   tag.unmapped                             -> one gap for the tag table
//   everything else                          -> by finding code
import type { Snapshot, SnapshotItem } from "./snapshot.js";

export interface Gap {
  /** Stable key, e.g. "metric.unmapped:nginx". */
  key: string;
  code: string;
  /** Integration prefix or tag, when the gap is grouped by one. */
  scope: string | null;
  /** Distinct report items that carry a finding in this gap. */
  items: string[];
  /** Distinct finding messages (capped), so the brief shows real examples. */
  examples: string[];
  /** Ranking score: items weighted by how bad their worst finding in the gap is. */
  score: number;
  /** Whether v0 lets an agent work on it (only mapping-table gaps). */
  actionable: boolean;
}

/** Gap codes an agent may close in v0, by editing mapping tables and adding tests. */
export const ACTIONABLE = new Set(["metric.unmapped", "tag.unmapped"]);

const WEIGHT: Record<string, number> = { manual: 4, bounded: 2, "exact-under": 1 };

export function gapKey(code: string, message: string): { key: string; scope: string | null } {
  if (code === "metric.unmapped" || code === "metric.no_equivalent") {
    const m = /(?:no mapping for|for) ([A-Za-z0-9_]+)\./.exec(message);
    const scope = m ? m[1]! : null;
    return { key: scope ? `${code}:${scope}` : code, scope };
  }
  return { key: code, scope: null };
}

export function findGaps(s: Snapshot): Gap[] {
  const by = new Map<string, { code: string; scope: string | null; items: Map<string, number>; examples: Set<string> }>();
  const add = (item: SnapshotItem) => {
    for (const f of item.findings) {
      const w = WEIGHT[f.status];
      if (!w) continue;
      const { key, scope } = gapKey(f.code, f.message);
      let g = by.get(key);
      if (!g) by.set(key, (g = { code: f.code, scope, items: new Map(), examples: new Set() }));
      g.items.set(item.id, Math.max(g.items.get(item.id) ?? 0, w));
      if (g.examples.size < 12) g.examples.add(f.message);
    }
  };
  for (const i of s.items) add(i);
  return [...by.entries()]
    .map(([key, g]) => ({
      key,
      code: g.code,
      scope: g.scope,
      items: [...g.items.keys()].sort(),
      examples: [...g.examples].sort(),
      score: [...g.items.values()].reduce((a, b) => a + b, 0),
      actionable: ACTIONABLE.has(g.code),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** The biggest actionable gap not in `skip` (gaps already tried this run), or null. */
export function pickGap(s: Snapshot, skip: ReadonlySet<string> = new Set()): Gap | null {
  return findGaps(s).find((g) => g.actionable && !skip.has(g.key)) ?? null;
}

/** How many findings of one gap remain. The loop's progress measure for that gap. */
export function gapSize(s: Snapshot, key: string): number {
  let n = 0;
  for (const i of s.items) for (const f of i.findings) if (WEIGHT[f.status] && gapKey(f.code, f.message).key === key) n++;
  return n;
}
