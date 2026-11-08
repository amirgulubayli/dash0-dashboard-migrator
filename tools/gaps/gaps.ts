// Plan 10 steps 1-2 (MEASURE + DECOMPOSE), the pure part: report(s) -> gap tree -> levers -> parallel waves.
// Same input, same bytes out: everything is sorted and nothing carries a timestamp. No model is called.
//
// Root: every item whose claim is weaker than exact-under (bounded, manual, unsupported), or weaker than exact with
// --include-exact-under. An item's *binding causes* are the findings at the item's own claim level (the ones that make
// it that weak; an exact-under finding on a bounded item is not why it is bounded). Each cause becomes a leaf keyed by
// finding code (+ integration prefix for metric/tag data gaps, + rule id when one code covers several rules). Each leaf
// gets a lever, read from the rule catalog:
//   mapping     a mapping-table change (data, plan 05 §7 lever 1)
//   rule        implement / widen a stronger catalog rule that names this one (note: "replaces …", "uses …")
//   probe       the stronger rule waits on an open probe (src/rules/probes.ts): goes to the owner on the hub
//   contract    no stronger rule exists: a new rule or a claim change (plan 05 §8: a CONTRACT change, main room)
//   impossible  the rule says the construct has no equivalent (maths.md §9.5): stop this branch
import { overlaps, ownerName, type OwnerRow } from "../lib/notes.js";
import { claimOf, claimRank, cell, namesRule, type GapItem, type GapReport } from "../lib/report.js";

export interface CatalogRule {
  id: string;
  status: string;
  state: string;
  priority: number;
  owner: string;
  match: string;
  emit: string;
  requires: string[];
  epsilon?: string;
  note?: string;
  findingCode?: string;
}

export interface GapContext {
  rules: CatalogRule[];
  /** Probe id -> answer ("open" | "yes" | "no") and question. */
  probes: Record<string, { question: string; answer: string }>;
  /** Rule id -> the catalog source file that defines it (src/rules/catalog/<x>.ts). */
  catalogFile: Record<string, string>;
  /** Finding code -> rule id when the finding carries no ruleId (src/rules resolveCode). */
  resolve: (code: string) => string | undefined;
  /** Existing mapping tables: repo-relative file, the metric prefixes it covers, and its generator if it is generated. */
  mappingTables: { file: string; prefixes: string[]; generatedBy?: string }[];
  owners: OwnerRow[];
}

export type LeverKind = "mapping" | "rule" | "probe" | "contract" | "impossible";

export interface Lever {
  key: string;
  kind: LeverKind;
  /** Mapping file, rule id, probe ids, or the rule that needs a CONTRACT. */
  target: string;
  why: string;
  /** Code/data files the lever edits (disjointness is decided on these). */
  files: string[];
  /** Catalog rows it adds or flips: one-row edits in src/rules/catalog, merged by git, so not counted as overlap. */
  catalogRows: string[];
  owner: string;
  leaves: string[];
  items: string[];
  /** Items for which this lever removes every binding cause: it upgrades them on its own. */
  upgradesAlone: string[];
  score: number;
  /** Parallel round: levers in the same wave touch disjoint files. 0 = not delegated (probe / contract / impossible). */
  wave: number;
}

export interface Leaf {
  key: string;
  code: string;
  scope: string | null;
  rule: { id: string; status: string; state: string } | null;
  items: string[];
  byStatus: Record<string, number>;
  examples: string[];
  lever: string;
}

export interface CodeNode {
  code: string;
  items: string[];
  leaves: Leaf[];
}

export interface GapsDoc {
  schema: "dd2dash0.gaps/v1";
  round: number;
  sources: { label: string; items: number; outputHash: string | null }[];
  root: { items: number; inGap: number; byStatus: Record<string, number>; threshold: string };
  tree: CodeNode[];
  levers: Lever[];
  waves: string[][];
}

/** Items weigh by how weak their claim is, like tools/improve's gap score. */
const WEIGHT: Record<string, number> = { "exact-under": 1, bounded: 2, manual: 4 };
const weight = (status: string) => WEIGHT[claimOf(status) ?? "manual"] ?? 4;

/** Task -> the code it owns in the fork (NOTES.md owners table, by area). */
export const TASK_PATHS: Record<string, string> = {
  T1: "mappings/**",
  T2: "src/sources/**",
  T3: "src/parse/**",
  T4: "src/translate/query/**",
  T5: "src/translate/dashboard/**",
  T6: "src/translate/alerts/**",
  T7: "src/targets/**",
  T8: "src/report/**",
  T12: "src/translate/logs/**",
  T16: "tests/semantics/**",
  T17: "src/rules/**",
};

const DATA_CODES = new Set(["metric.unmapped", "metric.approximate", "metric.no_equivalent", "tag.unmapped"]);

/** Integration prefix of the first dotted metric name in a message ("postgresql.rows_fetched -> …" -> postgresql). */
export function integrationOf(message: string): string | null {
  return /\b([a-z][a-z0-9_]*)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*/.exec(message)?.[1] ?? null;
}

interface Cause {
  code: string;
  ruleId: string | null;
  message: string;
}

/** The findings that make an item as weak as it is; falls back to certificate rules, then to "unexplained". */
export function bindingCauses(item: GapItem, rules: ReadonlyMap<string, CatalogRule>, resolve: GapContext["resolve"]): Cause[] {
  const rank = claimRank(item.status);
  const out: Cause[] = item.findings
    .filter((f) => claimRank(f.status) === rank)
    .map((f) => ({ code: f.code, ruleId: f.ruleId ?? resolve(f.code) ?? null, message: f.message }));
  if (out.length) return out;
  for (const id of item.certificate?.rules ?? []) {
    const r = rules.get(id);
    if (r && claimRank(r.status) === rank) out.push({ code: id, ruleId: id, message: `${r.match} -> ${r.emit} (certificate rule, no finding)` });
  }
  if (out.length) return out;
  return [{ code: "unexplained", ruleId: null, message: `status ${item.status} with no finding at that level; reason codes: ${(item.reason_codes ?? []).join(", ") || "none"}` }];
}

function leafKeyOf(c: Cause): { key: string; scope: string | null } {
  if (DATA_CODES.has(c.code) || c.code.startsWith("metric.")) {
    const scope = c.code === "tag.unmapped" ? null : integrationOf(c.message);
    return { key: scope ? `${c.code}:${scope}` : c.code, scope };
  }
  if (c.code === "widget.unsupported") {
    const w = /'([A-Za-z0-9_]+)' widget/.exec(c.message)?.[1] ?? null;
    return { key: w ? `${c.code}:${w}` : c.code, scope: w };
  }
  if (c.ruleId && c.ruleId !== c.code) return { key: `${c.code}:${c.ruleId}`, scope: c.ruleId };
  return { key: c.code, scope: null };
}

const mentions = (text: string | undefined, id: string) => !!text && namesRule(text, id);
/** What a rule says about other rules: its output and note. (Not `match`: a fallback's match lists widget types.) */
const textOf = (r: CatalogRule) => `${r.emit} ${r.note ?? ""}`;

/**
 * Upgrades of `r`: rules tied to it by name in either direction (select.metric.derived "Replaces metric.derived") that
 * claim more, or claim the same but are stated to replace it ("widget.toplist replaces it once fn.top.window ships":
 * same lattice level, fewer assumptions).
 */
export function upgradeCandidates(r: CatalogRule, rules: readonly CatalogRule[]): CatalogRule[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "<c> replaces it" in r's note, or "Replaces <r>" in c's note.
  const replaces = (c: CatalogRule) =>
    new RegExp(`${esc(c.id)} replaces`, "i").test(r.note ?? "") || new RegExp(`replaces ${esc(r.id)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, "i").test(c.note ?? "");
  return rules
    .filter((c) => c.id !== r.id && (mentions(textOf(c), r.id) || mentions(textOf(r), c.id)))
    .filter((c) => claimRank(c.status) < claimRank(r.status) || (claimRank(c.status) === claimRank(r.status) && replaces(c)))
    .sort((a, b) => claimRank(a.status) - claimRank(b.status) || (a.state === b.state ? 0 : a.state === "implemented" ? -1 : 1) || a.priority - b.priority || a.id.localeCompare(b.id));
}

type Proposal = Omit<Lever, "leaves" | "items" | "upgradesAlone" | "score" | "wave" | "owner"> & { ownerPaths: string[] };

export function proposeLever(leaf: { code: string; scope: string | null; ruleId: string | null }, ctx: GapContext): Proposal {
  const rules = new Map(ctx.rules.map((r) => [r.id, r]));
  const r = leaf.ruleId ? rules.get(leaf.ruleId) : undefined;
  const openProbes = (x: CatalogRule) => x.requires.filter((p) => ctx.probes[p]?.answer !== "yes");
  const ruleFiles = (x: CatalogRule) => (TASK_PATHS[x.owner] ? [TASK_PATHS[x.owner]!] : []);
  const catalogRow = (x: CatalogRule) => `${ctx.catalogFile[x.id] ?? "src/rules/catalog"}#${x.id}`;

  // Data gaps: the lever is a mapping table, never a rule (plan 05 §7: these are data, not rules).
  if (leaf.code === "tag.unmapped")
    return { key: "mapping:mappings/tags.yaml", kind: "mapping", target: "mappings/tags.yaml", why: "tags without a tag-table entry fall back to label.default (exact-under A.tag-default)", files: ["mappings/tags.yaml"], catalogRows: [], ownerPaths: ["mappings/**"] };
  if (DATA_CODES.has(leaf.code) && leaf.scope) {
    const table = ctx.mappingTables.find((t) => t.prefixes.includes(leaf.scope!)) ?? ctx.mappingTables.find((t) => t.file === `mappings/datadog/${leaf.scope}.yaml`);
    const file = table?.file ?? `mappings/datadog/${leaf.scope}.yaml`;
    const note = !table ? " (new table)" : table.generatedBy ? ` (generated: change ${table.generatedBy} and regenerate)` : "";
    const why: Record<string, string> = {
      "metric.unmapped": "no mapping row: the Datadog name is kept and assumed a gauge",
      "metric.approximate": "the row is approximate (bounded, select.metric.approximate): an exact row, a unit/label transform (R1-transform) or a derived expression upgrades it",
      "metric.no_equivalent": "the pinned receiver emits nothing equivalent: a derived row (select.metric.derived) or another receiver, else it stays manual",
    };
    return { key: `mapping:${file}`, kind: "mapping", target: file, why: `${why[leaf.code] ?? leaf.code}${note}`, files: [file], catalogRows: [], ownerPaths: [file] };
  }

  if (!r) return { key: `contract:${leaf.code}`, kind: "contract", target: leaf.code, why: `finding code '${leaf.code}' resolves to no catalog rule: add one (plan 05 D10)`, files: [], catalogRows: [], ownerPaths: ["src/rules/**"] };

  // A widget-type leaf only upgrades through a rule for that widget type (widget.geomap names widget.unsupported, but
  // only geomaps can use it).
  const cands = upgradeCandidates(r, ctx.rules).filter((c) => leaf.code !== "widget.unsupported" || !leaf.scope || c.id === `widget.${leaf.scope}` || mentions(c.match, leaf.scope));
  const c = cands[0];
  if (c) {
    const open = openProbes(c);
    if (c.state === "planned" && open.length)
      return { key: `probe:${open.map((p) => p.replace(/^probe:/, "")).join("+")}`, kind: "probe", target: open.join(", "), why: `${c.id} (${c.status}, planned) upgrades ${r.id} once ${open.map((p) => `${p}: ${ctx.probes[p]?.question ?? "?"}`).join("; ")}`, files: [], catalogRows: [catalogRow(c)], ownerPaths: ruleFiles(c) };
    return {
      key: `rule:${c.id}`,
      kind: "rule",
      target: c.id,
      why: c.state === "planned" ? `implement ${c.id} (${c.status}, planned; probes ${c.requires.length ? "answered" : "none needed"}): it upgrades ${r.id} (${r.status})` : `${c.id} (${c.status}) is implemented but does not match these items: widen its guard`,
      files: ruleFiles(c),
      catalogRows: [catalogRow(c)],
      ownerPaths: ruleFiles(c),
    };
  }
  const open = openProbes(r);
  if (open.length)
    return { key: `probe:${open.map((p) => p.replace(/^probe:/, "")).join("+")}`, kind: "probe", target: open.join(", "), why: `${r.id} (${r.status}, ${r.state}) rests on ${open.map((p) => `${p}: ${ctx.probes[p]?.question ?? "?"}`).join("; ")}`, files: [], catalogRows: [catalogRow(r)], ownerPaths: ruleFiles(r) };
  if (/§9\.5/.test(textOf(r)))
    return { key: `impossible:${r.id}`, kind: "impossible", target: r.id, why: `${r.emit}`, files: [], catalogRows: [], ownerPaths: [] };
  return {
    key: `contract:${r.id}`,
    kind: "contract",
    target: r.id,
    why: `no stronger catalog rule names ${r.id} (${r.status}: ${r.emit}): a new rule or a claim change is a CONTRACT change (plan 05 §8)`,
    files: [],
    catalogRows: [catalogRow(r)],
    ownerPaths: ["src/rules/**"],
  };
}

export interface BuildOptions {
  includeExactUnder?: boolean;
  round?: number;
  /** Lever keys already being worked on (an earlier round): listed, never put in a wave. */
  inFlight?: string[];
}

export function buildGaps(sources: { label: string; report: GapReport }[], ctx: GapContext, o: BuildOptions = {}): GapsDoc {
  const threshold = o.includeExactUnder ? "exact" : "exact-under";
  const limit = claimRank(threshold);
  const rules = new Map(ctx.rules.map((r) => [r.id, r]));
  const leaves = new Map<string, { code: string; scope: string | null; ruleId: string | null; items: Map<string, string>; examples: Set<string> }>();
  const itemCauses = new Map<string, Set<string>>(); // item -> leaf keys
  const itemStatus = new Map<string, string>();
  const byStatus: Record<string, number> = {};
  let total = 0;

  for (const s of sources)
    for (const it of s.report.items) {
      if (it.kind === "group") continue;
      total++;
      if (claimRank(it.status) <= limit) continue;
      const id = s.label === "fixtures" ? it.id : `${s.label}:${it.id}`;
      byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
      itemStatus.set(id, it.status);
      for (const c of bindingCauses(it, rules, ctx.resolve)) {
        const { key, scope } = leafKeyOf(c);
        let l = leaves.get(key);
        if (!l) leaves.set(key, (l = { code: c.code, scope, ruleId: c.ruleId, items: new Map(), examples: new Set() }));
        l.items.set(id, it.status);
        l.examples.add(c.message.length > 160 ? c.message.slice(0, 157) + "..." : c.message);
        if (!itemCauses.has(id)) itemCauses.set(id, new Set());
        itemCauses.get(id)!.add(key);
      }
    }

  // Leaves -> levers (several leaves may share one lever, e.g. every metric code of one integration).
  const levers = new Map<string, Lever & { ownerPaths?: string[] }>();
  const leafLever = new Map<string, string>();
  const leafList: Leaf[] = [];
  for (const [key, l] of [...leaves].sort((a, b) => a[0].localeCompare(b[0]))) {
    const p = proposeLever({ code: l.code, scope: l.scope, ruleId: l.ruleId }, ctx);
    leafLever.set(key, p.key);
    let lv = levers.get(p.key);
    if (!lv) {
      const { ownerPaths, ...rest } = p;
      levers.set(p.key, (lv = { ...rest, owner: p.kind === "impossible" ? "-" : ownerName(ownerPaths, ctx.owners), leaves: [], items: [], upgradesAlone: [], score: 0, wave: 0 }));
    }
    lv.leaves.push(key);
    const r = l.ruleId ? rules.get(l.ruleId) : undefined;
    const byS: Record<string, number> = {};
    for (const st of l.items.values()) byS[st] = (byS[st] ?? 0) + 1;
    leafList.push({
      key,
      code: l.code,
      scope: l.scope,
      rule: r ? { id: r.id, status: r.status, state: r.state } : null,
      items: [...l.items.keys()].sort(),
      byStatus: sortKeys(byS),
      examples: [...l.examples].sort().slice(0, 5),
      lever: p.key,
    });
  }
  for (const [id, causes] of itemCauses) {
    const ls = new Set([...causes].map((c) => leafLever.get(c)!));
    for (const k of ls) {
      const lv = levers.get(k)!;
      lv.items.push(id);
      lv.score += weight(itemStatus.get(id)!);
      if (ls.size === 1) lv.upgradesAlone.push(id);
    }
  }
  const leverList = [...levers.values()]
    .map((l) => ({ ...l, items: l.items.sort(), upgradesAlone: l.upgradesAlone.sort(), leaves: l.leaves.sort() }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  // Waves: delegable levers (mapping, rule), biggest first, each into the first wave it shares no file with.
  const inFlight = new Set(o.inFlight ?? []);
  const waves: string[][] = [];
  const waveFiles: string[][] = [];
  for (const l of leverList) {
    if ((l.kind !== "mapping" && l.kind !== "rule") || inFlight.has(l.key)) continue;
    let w = waveFiles.findIndex((fs) => !fs.some((f) => l.files.some((g) => overlaps(f, g))));
    if (w < 0) {
      w = waves.length;
      waves.push([]);
      waveFiles.push([]);
    }
    waves[w]!.push(l.key);
    waveFiles[w]!.push(...l.files);
    l.wave = w + 1;
  }

  const tree = new Map<string, CodeNode>();
  for (const leaf of leafList) {
    let n = tree.get(leaf.code);
    if (!n) tree.set(leaf.code, (n = { code: leaf.code, items: [], leaves: [] }));
    n.leaves.push(leaf);
    n.items = [...new Set([...n.items, ...leaf.items])].sort();
  }
  const treeList = [...tree.values()].sort((a, b) => b.items.length - a.items.length || a.code.localeCompare(b.code));
  for (const n of treeList) n.leaves.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));

  return {
    schema: "dd2dash0.gaps/v1",
    round: o.round ?? 1,
    sources: sources.map((s) => ({ label: s.label, items: s.report.items.filter((i) => i.kind !== "group").length, outputHash: s.report.run?.outputHash ?? null })),
    root: { items: total, inGap: itemStatus.size, byStatus: sortKeys(byStatus), threshold: `claim weaker than ${threshold}` },
    tree: treeList,
    levers: leverList,
    waves,
  };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort((a, b) => claimRank(a) - claimRank(b) || a.localeCompare(b)).map((k) => [k, o[k]!]));
}

const statusText = (b: Record<string, number>) => Object.entries(b).map(([k, v]) => `${v} ${k}`).join(", ");

export function renderMarkdown(doc: GapsDoc, inFlight: string[] = []): string {
  const L: string[] = [];
  const fl = new Set(inFlight);
  L.push(`## Gap tree, round ${doc.round}`, "");
  L.push(`${doc.root.inGap} of ${doc.root.items} items have a ${doc.root.threshold} (${statusText(doc.root.byStatus)}). Sources: ${doc.sources.map((s) => `${s.label} (${s.items} items, output ${s.outputHash?.slice(0, 16) ?? "?"})`).join("; ")}.`, "");
  L.push("| Cause (binding finding) | Scope | Items | Rule (claim, state) | Lever |", "|---|---|---|---|---|");
  for (const n of doc.tree)
    for (const l of n.leaves)
      L.push(`| \`${cell(l.code)}\` | ${l.scope ? cell(l.scope) : ""} | ${l.items.length} (${statusText(l.byStatus)}) | ${l.rule ? `\`${l.rule.id}\` (${l.rule.status}, ${l.rule.state})` : "-"} | ${cell(l.lever)} |`);
  L.push("", "## Levers", "");
  L.push("| Lever | Kind | Items (upgrades alone) | Files | Owner | Wave |", "|---|---|---|---|---|---|");
  for (const l of doc.levers) {
    const wave = fl.has(l.key) ? "in flight" : l.wave ? String(l.wave) : l.kind === "impossible" ? "stop" : "hub";
    L.push(`| \`${cell(l.target)}\` | ${l.kind} | ${l.items.length} (${l.upgradesAlone.length}) | ${l.files.map((f) => `\`${f}\``).join(", ") || "-"} | ${cell(l.owner)} | ${wave} |`);
  }
  L.push("");
  if (doc.waves.length) {
    L.push("Levers in the same wave touch disjoint files and can run in parallel:");
    doc.waves.forEach((w, i) => L.push(`- wave ${i + 1}: ${w.join(", ")}`));
    L.push("");
  }
  L.push("Why each lever:");
  for (const l of doc.levers) L.push(`- \`${l.key}\`: ${l.why}`);
  L.push("");
  return L.join("\n");
}
