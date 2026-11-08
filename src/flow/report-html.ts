// <run>/report.html: the run report a person opens after a run, in the same terminal look as the CLI and the key page
// (one accent, dim secondary text, ● headings, ⎿ results). One offline file: no external assets, no script. Light and
// dark follow the system; it prints with every section expanded. The same input always gives the same bytes: the only
// time shown is RunFacts.startedAt.
//
// Reading order: header (input, target, mode, version, output hash) -> headline counts (success, translated, landed,
// live) and what the run recorded as proof -> what needs attention, manual and unsupported first, grouped by reason code
// -> every dashboard's panels with the Datadog query next to the PromQL and the claim in plain words -> monitors with
// their thresholds -> how to read the claims. The claim words are the CLI's (exact, exact-under shown as "EXACT IF" with
// its condition, bounded, manual, unsupported); the plain sentences come from src/rules/plain.ts via report.json, never
// from this file.
//
// Honesty rules (dash0-team docs/research/ui/DESIGN_BRIEF.md): counts only, never a percentage; every number and the
// hash come from the run; a check the run did not record reads "Not recorded" / "Not checked"; a status is a shape, a
// word and a colour, never colour alone; manual and unsupported are never folded into "other".
import { createHash } from "node:crypto";
import { explainPlain, type ExplainStatus } from "../rules/plain.js";
import type { Num, Row, RunFacts, Score } from "./score.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CLAIMS = ["exact", "exact-under", "bounded", "manual", "unsupported"] as const;
const claimClass = (s: string) => ((CLAIMS as readonly string[]).includes(s) ? `c-${s}` : "c-other");
/** The word and shape shown for each claim: exact-under reads "EXACT IF" (always followed by its condition). */
const WORD: Record<string, string> = { exact: "exact", "exact-under": "EXACT IF", bounded: "bounded", manual: "manual", unsupported: "unsupported" };
const SHAPE: Record<string, string> = { exact: "●", "exact-under": "◐", bounded: "◇", manual: "▲", unsupported: "✕" };
const word = (s: string) => WORD[s] ?? s;

/** One sentence per claim for the legend, from the same templates the items use (src/rules/plain.ts). */
const LEGEND: Record<(typeof CLAIMS)[number], string> = {
  exact: explainPlain({ status: "exact", rules: [], assumptions: [] }),
  "exact-under": explainPlain({ status: "exact-under", rules: [], assumptions: ["the conditions listed with the item hold"] }),
  bounded: explainPlain({ status: "bounded", rules: [], assumptions: [] }),
  manual: explainPlain({ status: "manual", rules: [], assumptions: [] }),
  unsupported: explainPlain({ status: "unsupported", rules: [], assumptions: [] }),
};
const plainOf = (r: Row) => r.plain ?? ((CLAIMS as readonly string[]).includes(r.status) && r.status !== "exact-under" && r.status !== "manual" ? explainPlain({ status: r.status as ExplainStatus, rules: [], assumptions: [] }) : "");

const LIVE_WORDS: Record<string, string> = {
  live: "Dash0 returns data",
  missing: "Datadog has data, Dash0 has none",
  "no-data": "no data on either side in the window",
  error: "Dash0 rejected the query",
  "n/a": "no query to check (note, image, placeholder)",
};

const sr = (s: string) => `<span class="sr">${s}</span>`;
const mark = (b: boolean | null, what: string) =>
  b === null ? `<span class="dim" aria-hidden="true">–</span>${sr(`${what}: not measured`)}` : b ? `<span class="ok" aria-hidden="true">✓</span>${sr(`${what}: yes`)}` : `<span class="bad" aria-hidden="true">✗</span>${sr(`${what}: no`)}`;
const liveCell = (l: Row["live"]) =>
  l === null ? `<span class="dim" aria-hidden="true">–</span>${sr("live: not measured")}` : `<span class="${l === "live" ? "ok" : l === "missing" || l === "error" ? "bad" : "dim"}" title="${esc(LIVE_WORDS[l] ?? l)}">${esc(l)}</span>`;
const pill = (status: string) => `<span class="claim ${claimClass(status)}"><span aria-hidden="true">${SHAPE[status] ?? "○"}</span> ${esc(word(status))}</span>`;
/** exact-under: "EXACT IF" and the item's condition (report.json `condition`: its assumptions as sentences). */
const exactIf = (r: Row) =>
  r.status === "exact-under" ? `<p class="exactif"><b class="c-exact-under">EXACT IF</b> ${r.condition ? esc(r.condition) : `<span class="dim">condition not recorded in this run</span>`}</p>` : "";

function meter(id: string, name: string, n: Num | null, what: string, lead = false): string {
  const cls = `m${lead ? " lead" : ""}`;
  if (!n)
    return `<div class="${cls}"><span class="k" id="${id}">${name}</span><span class="bar off" aria-hidden="true"></span><span class="v dim">not measured</span><span class="w">${esc(what)}</span></div>`;
  return `<div class="${cls}"><span class="k" id="${id}">${name}</span><span class="bar" role="meter" aria-labelledby="${id}" aria-valuemin="0" aria-valuemax="${n.total}" aria-valuenow="${n.count}" aria-valuetext="${n.count} of ${n.total}"><i style="flex:${n.count}"></i><s style="flex:${n.total - n.count}"></s></span><span class="v"><b>${n.count}</b> of ${n.total}</span><span class="w">${esc(what)}</span></div>`;
}

function queries(r: Row): string {
  if (!r.sourceQueries.length && !r.promql.length) return "";
  const list = (qs: string[], none: string) => (qs.length ? qs.map((q) => `<code>${esc(q)}</code>`).join("") : `<span class="dim">${none}</span>`);
  return `<div class="qs"><div class="q"><span class="ql">Datadog</span>${list(r.sourceQueries, "no query")}</div><div class="q"><span class="ql">PromQL</span>${list(r.promql, r.status === "manual" || r.status === "unsupported" ? "none: kept as a placeholder with the original" : "none")}</div></div>`;
}

const todo = (r: Row) => (r.manualActions.length ? `<ul class="todo">${r.manualActions.map((a) => `<li><span class="warn">to do</span> ${esc(a)}</li>`).join("")}</ul>` : "");
const needsPerson = (r: Row) => r.status === "manual" || r.status === "unsupported";
/** Reason codes; for manual and unsupported items each code with its plain sentence (report.json reasonCodes). */
const codes = (r: Row) =>
  !r.reasons.length
    ? ""
    : needsPerson(r)
      ? `<ul class="codes">${r.reasons.map((c) => `<li><code class="il">${esc(c)}</code>${r.reasonPlain?.[c] ? ` <span class="dim">${esc(r.reasonPlain[c])}</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="codes"><span class="dim">codes</span> ${r.reasons.map((c) => `<code>${esc(c)}</code>`).join(" ")}</p>`;

const isAttentionRow = (r: Row) => !r.translated || r.landed === false || r.live === "missing" || r.live === "error";

/** A link-safe slug for stable anchors: the same input gives the same ids, independent of row order. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
/** Hands out unique ids: the base when free, else base-2, base-3, … (in row order, so still deterministic). */
function idMaker(): (base: string) => string {
  const used = new Set<string>();
  return (base) => {
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    used.add(id);
    return id;
  };
}
const byCount = <T extends { n: number; key: string }>(a: T, b: T) => b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The integration an item came from, read from its source path: integrations-core keeps <integration>/assets/…, the
 * bundled fixtures name files <integration>__<name>.json. Falls back to the file name, then the dashboard title.
 */
export function integrationOf(r: Pick<Row, "source" | "dashboard" | "kind">): string {
  const parts = (r.source && r.source !== "api" ? r.source : "").replaceAll("\\", "/").split("/").filter(Boolean);
  const a = parts.indexOf("assets");
  if (a > 0) return parts[a - 1]!;
  const file = parts.at(-1)?.replace(/\.json$/i, "");
  if (file) return file.includes("__") ? file.slice(0, file.indexOf("__")) : file;
  return r.dashboard ?? (r.kind === "alert" ? "(monitors)" : "(no dashboard)");
}

/** The code that says why an item is not migrated: the first whose sentence starts "Not migrated", else the first. */
export const primaryCode = (r: Pick<Row, "reasons" | "reasonPlain">) => r.reasons.find((c) => r.reasonPlain?.[c]?.startsWith("Not migrated")) ?? r.reasons[0] ?? "(no reason code)";

/** What would move the items behind a reason code (plan-10 gap tree). */
export const LEVERS = ["mapping row", "new rule", "needs a probe", "Dash0 lacks a panel type", "impossible", "nothing to translate", "not classified"] as const;
export type Lever = (typeof LEVERS)[number];
const LEVER_HINT: Record<Lever, string> = {
  "mapping row": "a row in a mapping table (Datadog metric or tag -> OpenTelemetry name and kind) would let the existing rules translate it",
  "new rule": "the semantics are known; a translation rule has to be written and proven",
  "needs a probe": "a fact about the metric (its kind, buckets or Datadog's exact semantics) has to be measured before a rule can claim anything",
  "Dash0 lacks a panel type": "Dash0 has no panel for this widget or data source yet; the original stays as a Markdown placeholder",
  impossible: "no PromQL or Dash0 counterpart exists (e.g. Datadog's anomaly and forecast models); a person rebuilds it differently",
  "nothing to translate": "the source has no usable query (empty or unreadable)",
  "not classified": "this page has no lever for the code yet",
};
/**
 * Reason code -> lever. An explicit table (the rules catalog carries no lever field); a code not listed falls back by
 * prefix in leverOf(). Tested in tests/flow/report-html.test.ts.
 */
export const LEVER_OF: Record<string, Lever> = {
  "metric.unmapped": "mapping row",
  "metric.no_equivalent": "mapping row",
  "tag.unmapped": "mapping row",
  "metric.derived": "new rule",
  "metric.approximate": "needs a probe",
  "fn.rate": "needs a probe",
  "fn.throughput": "needs a probe",
  "fn.histogram.kind": "needs a probe",
  "fn.histogram.kind-unknown": "needs a probe",
  "time.kind-unknown": "needs a probe",
  "time.kind": "new rule",
  "widget.unsupported": "Dash0 lacks a panel type",
  "widget.unknown": "Dash0 lacks a panel type",
  "logs.stream": "Dash0 lacks a panel type",
  "query.datasource": "Dash0 lacks a panel type",
  "fn.anomalies": "impossible",
  "fn.forecast": "impossible",
  "fn.outliers": "impossible",
  "fn.autosmooth": "impossible",
  "fn.ewma_3": "impossible",
  "fn.ewma_10": "impossible",
  "fn.calendar_shift": "impossible",
  "query.value-filter": "impossible",
  "time.fill": "impossible",
  "monitor.option": "impossible",
  "log.status.unknown": "impossible",
  "scope.same-key": "impossible",
  "query.empty": "nothing to translate",
  "query.parse_error": "nothing to translate",
};
/** The owner area by code prefix (who would pull the lever). */
const OWNER_OF: [string, string][] = [
  ["metric.", "mappings"],
  ["tag.", "mappings"],
  ["widget.", "panels"],
  ["panel.", "panels"],
  ["logs.", "panels"],
  ["layout.", "panels"],
  ["query.datasource", "panels"],
  ["monitor.", "monitors"],
  ["alert.", "monitors"],
  ["log.", "logs"],
  ["fn.", "query rules"],
  ["arith.", "query rules"],
  ["time.", "query rules"],
  ["scope.", "query rules"],
  ["variable.", "query rules"],
  ["query.", "query rules"],
];
export function leverOf(code: string): { lever: Lever; owner: string } {
  const owner = OWNER_OF.find(([p]) => code.startsWith(p))?.[1] ?? "not assigned";
  const lever: Lever = LEVER_OF[code] ?? (code === "(no reason code)" ? "not classified" : owner === "not assigned" ? "not classified" : "new rule");
  return { lever, owner: lever === "impossible" ? `${owner} (a person rebuilds it)` : owner };
}

export interface GapCode { code: string; plain: string; n: number; manual: number; unsupported: number; bounded: number; owner: string; key: string }
export interface GapLever { lever: Lever; n: number; codes: GapCode[]; key: string }
/**
 * The gap tree, from report rows only: every item that did not translate (manual, unsupported, bounded not approved),
 * under its primary reason code, under the lever that would move it. Sorted by count, then name.
 */
export function gapTree(rows: Row[]): GapLever[] {
  const codes = new Map<string, GapCode>();
  for (const r of rows) {
    if (r.translated) continue;
    const code = primaryCode(r);
    let g = codes.get(code);
    if (!g) codes.set(code, (g = { code, key: code, plain: r.reasonPlain?.[code] ?? "", n: 0, manual: 0, unsupported: 0, bounded: 0, owner: leverOf(code).owner }));
    g.n++;
    if (!g.plain && r.reasonPlain?.[code]) g.plain = r.reasonPlain[code]!;
    if (r.status === "manual") g.manual++;
    else if (r.status === "unsupported") g.unsupported++;
    else if (r.status === "bounded") g.bounded++;
  }
  const levers = new Map<Lever, GapLever>();
  for (const c of codes.values()) {
    const l = leverOf(c.code).lever;
    let x = levers.get(l);
    if (!x) levers.set(l, (x = { lever: l, key: l, n: 0, codes: [] }));
    x.n += c.n;
    x.codes.push(c);
  }
  for (const x of levers.values()) x.codes.sort(byCount);
  return [...levers.values()].sort(byCount);
}

/** Counts per key, most first, ties by name (deterministic). */
function countBy(rows: Row[], key: (r: Row) => string): { key: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].map(([k, n]) => ({ key: k, n })).sort(byCount);
}

/** Above this many items the per-item detail of EXACT IF rows is summarised (grouped by condition) to keep the page small. */
export const DETAIL_LIMIT = 3000;

type Group = { key: string; code?: string; id?: string; title: string; hint: string; rows: Row[] };

/** The report's inner HTML (everything inside <body>), without <html>/<head>. reportHtml() wraps it with REPORT_CSS. */
export function reportBody(score: Score, rows: Row[], facts: RunFacts): string {
  // Stable anchors: from the item id, the dashboard title, the integration and the reason code, never the row index.
  const mk = idMaker();
  // Items: a short hash of the item id (ids from integrations-core run to 80 characters and 14k items), so a link to
  // an item keeps working across runs while the item exists.
  const idOf = new Map(rows.map((r) => [r, mk(`it-${createHash("sha256").update(r.id).digest("hex").slice(0, 10)}`)]));
  const panels = rows.filter((r) => r.kind === "panel");
  const dashboards = [...new Set(panels.map((r) => r.dashboard ?? "(no dashboard)"))];
  const dashId = new Map(dashboards.map((d) => [d, mk(`d-${slug(d)}`)]));
  const intOf = new Map(rows.map((r) => [r, integrationOf(r)]));
  const integrations = [...new Set(rows.map((r) => intOf.get(r)!))];
  const intId = new Map(integrations.map((x) => [x, mk(`int-${slug(x)}`)]));
  const summarise = rows.length > DETAIL_LIMIT;
  const manyDash = panels.length > 400;
  const monitors = rows.filter((r) => r.kind === "alert");
  // Group dashboards and monitors under their integration when several files share one (folders per integration).
  const grouped = integrations.length > 1 && integrations.length < dashboards.length + monitors.length;
  const isAttention = isAttentionRow;
  const measured = score.success !== null;
  const dry = facts.mode !== "live";
  const lc = score.liveCounts;

  // ---------------------------------------------------------------- needs attention: manual and unsupported first,
  // one group per reason code (the item's first code, the one its plain sentence explains) with that code's sentence.
  const byReason = (status: "manual" | "unsupported", title: string): Group[] => {
    const m = new Map<string, Group>();
    for (const r of rows.filter((x) => x.status === status)) {
      // The first code whose sentence says why it is not migrated (a manual item can also carry codes that only bound
      // or condition it); otherwise the first code.
      const code = primaryCode(r);
      let x = m.get(code);
      if (!x) m.set(code, (x = { key: status, code, id: mk(`r-${status}-${slug(code)}`), title, hint: r.reasonPlain?.[code] ?? (status === "unsupported" ? LEGEND.unsupported : "No translation rule covers it; the original is kept so a person can rebuild it."), rows: [] }));
      x.rows.push(r);
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length || (a.code! < b.code! ? -1 : 1));
  };
  const rest: Group[] = [
    { key: "error", title: "Dash0 rejected the query", hint: "the PromQL landed but Dash0 returned an error for it", rows: [] },
    { key: "missing", title: "No data in Dash0", hint: "Datadog has data for the original, Dash0 has none in the same window", rows: [] },
    { key: "landed", title: "Did not land", hint: "not imported, or the read-back from Dash0 did not match", rows: [] },
    { key: "bounded", title: "Bounded, not approved", hint: "close to Datadog within a proven error bound, but not approved in review, so it landed as a placeholder", rows: [] },
    { key: "other", title: "Not translated", hint: "", rows: [] },
  ];
  const g = (k: string) => rest.find((x) => x.key === k)!;
  for (const r of rows) {
    if (!isAttention(r) || needsPerson(r)) continue;
    if (r.live === "error") g("error").rows.push(r);
    else if (r.live === "missing") g("missing").rows.push(r);
    else if (r.landed === false) g("landed").rows.push(r);
    else if (r.status === "bounded") g("bounded").rows.push(r);
    else g("other").rows.push(r);
  }
  const attention = [...byReason("manual", "Needs a person (manual)"), ...byReason("unsupported", "No Dash0 panel (unsupported)"), ...rest].filter((x) => x.rows.length);
  const attentionCount = attention.reduce((n, x) => n + x.rows.length, 0);

  const attLine = (r: Row, key: string, groupCode?: string) => {
    const where = r.kind === "alert" ? "monitor" : esc(r.dashboard ?? "(no dashboard)");
    // Every branch escapes its own text; detail is HTML from here on.
    const detail =
      key === "error" || key === "missing"
        ? esc(r.liveDetail ?? "")
        : key === "landed"
          ? esc(r.landedDetail)
          : key === "bounded"
            ? `decision: ${esc(r.decision)}`
            : key === "manual" || key === "unsupported"
              ? [key === "unsupported" ? r.widget : "", r.reasons.length > 1 ? `also ${r.reasons.filter((c) => c !== groupCode).join(", ")}` : "", r.landed === false ? `did not land: ${r.landedDetail}` : "", r.live === "error" || r.live === "missing" ? `${LIVE_WORDS[r.live]}${r.liveDetail ? `: ${r.liveDetail}` : ""}` : ""].filter(Boolean).map(esc).join(" · ")
              : esc(r.status);
    return `<li><a href="#${idOf.get(r)}">${esc(r.title || "(untitled)")}</a> <span class="dim">· ${where}</span>${detail ? `<div class="why">⎿ ${detail}</div>` : ""}${r.manualActions.map((a) => `<div class="why"><span class="warn">⎿ to do</span> ${esc(a)}</div>`).join("")}</li>`;
  };
  const attentionSection = `<section id="attention" aria-labelledby="h-att"><h2 id="h-att"><span class="dot" aria-hidden="true">●</span> Needs attention <span class="dim">· ${attentionCount} of ${score.total}</span></h2>
${
  attention.length
    ? `<p class="lede">Items a person has to rebuild come first, one group per reason code with its plain sentence; then anything that failed on import or in the live check. Each name links to the item below, with its Datadog query and the PromQL side by side.</p>
<div class="att">${attention
        .map(
          (x) =>
            `<details class="ag ag-${x.key}"${x.id ? ` id="${x.id}"` : ""}${x.rows.length <= 12 ? " open" : ""}><summary><span class="agt">${esc(x.title)}</span>${x.code ? ` <code class="il rc">${esc(x.code)}</code>` : ""} <span class="n">${plural(x.rows.length, "item")}</span>${x.hint ? `<span class="agh">${esc(x.hint)}</span>` : ""}</summary><ul>${x.rows.map((r) => attLine(r, x.key, x.code)).join("")}</ul></details>`,
        )
        .join("\n")}</div>`
    : `<p class="lede">⎿ Nothing: every item translated${measured ? ", landed and returns data where Datadog does" : ""}.</p>`
}</section>`;

  // ---------------------------------------------------------------- filter (radio + :has, no script)
  const claimCounts = CLAIMS.map((c) => [c, rows.filter((r) => r.status === c).length] as const).filter(([, n]) => n > 0);
  const filters: [string, string, number][] = [["all", "all", rows.length], ["att", "needs attention", attentionCount], ...claimCounts.map(([c, n]) => [c, word(c), n] as [string, string, number])];
  // Widget types, most items first (the second radio group; both filters combine).
  const widgetCounts = countBy(rows, (r) => r.widget);
  const filterBar = summarise
    ? `<div class="filter"><span class="fhint dim">${rows.length} items: filter by link, not by button (fast at this size). By claim and reason: <a href="#attention">Needs attention</a> and <a href="#stats-reason">reasons</a> · by integration: <a href="#stats-integration">integrations</a> · by widget type: <a href="#stats-widget">widget types</a> · by lever: <a href="#gaps">Top gaps</a> · search: Ctrl+F / ⌘F, which also finds text inside collapsed sections</span></div>`
    : `<div class="filter"><div class="fg" role="radiogroup" aria-label="Show items by claim">${filters.map(([k, label, n], i) => `<input type="radio" name="show" id="f-${k}" value="${k}"${i === 0 ? " checked" : ""}><label for="f-${k}">${esc(label)} <span class="n">${n}</span></label>`).join("")}</div>
<details class="fw"><summary>widget type <span class="n">${widgetCounts.length}</span></summary><div class="fg" role="radiogroup" aria-label="Show items by widget type"><input type="radio" name="widget" id="w-any" value="any" checked><label for="w-any">any widget <span class="n">${rows.length}</span></label>${widgetCounts.map((x) => `<input type="radio" name="widget" id="w-${esc(slug(x.key))}" value="${esc(slug(x.key))}"><label for="w-${esc(slug(x.key))}">${esc(x.key)} <span class="n">${x.n}</span></label>`).join("")}</div></details>
<span class="fhint dim">search: Ctrl+F / ⌘F finds text inside collapsed sections too · by integration and reason: the tables in <a href="#stats">Statistics</a></span></div>`;

  // ---------------------------------------------------------------- statistics (counts only, all from the rows)
  const claimCells = (xs: Row[]) => CLAIMS.map((c) => {
    const k = xs.filter((r) => r.status === c).length;
    return `<td class="num ${k ? claimClass(c) : "dim"}">${k ? k : "·"}</td>`;
  }).join("");
  const claimHead = CLAIMS.map((c) => `<th scope="col" class="num"><span class="${claimClass(c)}" aria-hidden="true">${SHAPE[c]}</span> ${word(c)}</th>`).join("");
  const statTable = (caption: string, first: string, groups: { label: string; rows: Row[]; extra?: string }[], extraHead = "") =>
    `<table class="stat"><caption class="sr">${esc(caption)}</caption><thead><tr><th scope="col">${first}</th><th scope="col" class="num">items</th>${claimHead}${extraHead}</tr></thead><tbody>${groups.map((g) => `<tr><th scope="row">${g.label}</th><td class="num"><b>${g.rows.length}</b></td>${claimCells(g.rows)}${g.extra ?? ""}</tr>`).join("")}</tbody></table>`;
  const notesRows = panels.filter((r) => r.widget === "note");
  const kindGroups = [
    { label: "panels (not notes)", rows: panels.filter((r) => r.widget !== "note") },
    { label: "text notes", rows: notesRows },
    { label: "monitors", rows: monitors },
    { label: "<b>all items</b>", rows },
  ];
  const intStats = countBy(rows, (r) => intOf.get(r)!);
  const intGroups = intStats.map((x) => {
    const rs = rows.filter((r) => intOf.get(r) === x.key);
    const nd = new Set(rs.filter((r) => r.kind === "panel").map((r) => r.dashboard)).size;
    const nm = rs.filter((r) => r.kind === "alert").length;
    const person = rs.filter(needsPerson).length;
    return { label: grouped ? `<a href="#${intId.get(x.key)}">${esc(x.key)}</a>` : esc(x.key), rows: rs, extra: `<td class="num">${nd}</td><td class="num">${nm}</td><td class="num ${person ? "warn" : "dim"}">${person || "·"}</td>` };
  });
  const widgetGroups = widgetCounts.map((x) => ({ label: esc(x.key), rows: rows.filter((r) => r.widget === x.key) }));
  const reasonCounts = new Map<string, { n: number; key: string; manual: number; unsupported: number; other: number; plain: string }>();
  for (const r of rows)
    for (const c of new Set(r.reasons)) {
      let x = reasonCounts.get(c);
      if (!x) reasonCounts.set(c, (x = { key: c, n: 0, manual: 0, unsupported: 0, other: 0, plain: "" }));
      x.n++;
      if (r.status === "manual") x.manual++;
      else if (r.status === "unsupported") x.unsupported++;
      else x.other++;
      if (!x.plain && r.reasonPlain?.[c]) x.plain = r.reasonPlain[c]!;
    }
  const reasonList = [...reasonCounts.values()].sort(byCount);
  const big = (n: number) => (n > 25 ? "" : " open");
  const statsSection = `<section id="stats" aria-labelledby="h-stats"><h2 id="h-stats"><span class="dot" aria-hidden="true">●</span> Statistics <span class="dim">· counts from this run, no percentages</span></h2>
<p class="lede">Every item counts once, in exactly one claim column. Reason codes can repeat: an item carries all of its codes, so the reason table counts items per code and its rows do not add up to the total.</p>
<details class="st" id="stats-kind" open><summary>By kind <span class="n">${kindGroups.length - 1} kinds</span></summary>${statTable("Items by kind and claim", "kind", kindGroups)}</details>
<details class="st" id="stats-integration"${big(intGroups.length)}><summary>By integration <span class="n">${intGroups.length}</span><span class="agh">One row per integration (folder of the input); the name links to its dashboards and monitors.</span></summary>${statTable("Items by integration and claim", "integration", intGroups, `<th scope="col" class="num">dashboards</th><th scope="col" class="num">monitors</th><th scope="col" class="num">need a person</th>`)}</details>
<details class="st" id="stats-widget"${big(widgetGroups.length)}><summary>By widget type <span class="n">${widgetGroups.length}</span><span class="agh">Panel widget types and monitor types; the filter above shows one at a time.</span></summary>${statTable("Items by widget type and claim", "widget", widgetGroups)}</details>
<details class="st" id="stats-reason"${big(reasonList.length)}><summary>By reason code <span class="n">${reasonList.length}</span><span class="agh">Each code with its plain sentence, the items that carry it, and the lever that would move them.</span></summary><table class="stat"><caption class="sr">Items by reason code</caption><thead><tr><th scope="col">code</th><th scope="col" class="num">items</th><th scope="col" class="num">manual</th><th scope="col" class="num">unsupported</th><th scope="col" class="num">translated or bounded</th><th scope="col">lever</th><th scope="col">what it means</th></tr></thead><tbody>${reasonList
    .map((x) => `<tr id="${mk(`code-${slug(x.key)}`)}"><th scope="row"><code class="il rc">${esc(x.key)}</code></th><td class="num"><b>${x.n}</b></td><td class="num ${x.manual ? "c-manual" : "dim"}">${x.manual || "·"}</td><td class="num ${x.unsupported ? "c-unsupported" : "dim"}">${x.unsupported || "·"}</td><td class="num dim">${x.other || "·"}</td><td class="lv">${esc(x.manual || x.unsupported ? leverOf(x.key).lever : "none needed")}</td><td class="dim pl">${esc(x.plain || "no plain sentence in this run")}</td></tr>`)
    .join("")}</tbody></table></details>
</section>`;

  // ---------------------------------------------------------------- gap tree: reason -> items -> lever -> owner
  const gaps = gapTree(rows);
  const gapTotal = gaps.reduce((n, g) => n + g.n, 0);
  const attGroupFor = (code: string) => attention.filter((x) => x.code === code && x.id);
  const gapSection = `<section id="gaps" aria-labelledby="h-gaps"><h2 id="h-gaps"><span class="dot" aria-hidden="true">●</span> Top gaps <span class="dim">· ${plural(gapTotal, "item")} not translated, by what would move them</span></h2>
${
  gaps.length
    ? `<p class="lede">Each item that did not translate sits under its main reason code (the one its sentence explains), and each code under the lever that would move it and the area that owns it. Built from this run's items only.</p>
<table class="stat gap"><caption class="sr">Gap tree</caption><thead><tr><th scope="col">lever</th><th scope="col">reason code</th><th scope="col" class="num">items</th><th scope="col" class="num">manual</th><th scope="col" class="num">unsupported</th><th scope="col" class="num">bounded</th><th scope="col">owner area</th></tr></thead>${gaps
        .map(
          (g) =>
            `<tbody id="${mk(`gap-${slug(g.lever)}`)}"><tr class="lvr"><th scope="rowgroup" colspan="2">${esc(g.lever)} <span class="agh">${esc(LEVER_HINT[g.lever])}</span></th><td class="num"><b>${g.n}</b></td><td colspan="4"></td></tr>${g.codes
              .map((c) => {
                const links = attGroupFor(c.code);
                return `<tr><td></td><td><code class="il rc">${esc(c.code)}</code>${links.length ? ` ${links.map((x) => `<a href="#${x.id}" class="dim">items ↓</a>`).join(" ")}` : ""}${c.plain ? `<div class="dim pl">${esc(c.plain)}</div>` : ""}</td><td class="num"><b>${c.n}</b></td><td class="num ${c.manual ? "c-manual" : "dim"}">${c.manual || "·"}</td><td class="num ${c.unsupported ? "c-unsupported" : "dim"}">${c.unsupported || "·"}</td><td class="num ${c.bounded ? "c-bounded" : "dim"}">${c.bounded || "·"}</td><td>${esc(c.owner)}</td></tr>`;
              })
              .join("")}</tbody>`,
        )
        .join("")}</table>`
    : `<p class="lede">⎿ None: every item translated.</p>`
}</section>`;

  // ---------------------------------------------------------------- where to start
  const person = rows.filter(needsPerson).length;
  const topCode = gaps.flatMap((g) => g.codes.map((c) => ({ ...c, lever: g.lever }))).sort(byCount)[0];
  const topLink = topCode ? attGroupFor(topCode.code)[0] : undefined;
  const start = `<section id="start" aria-labelledby="h-start" class="start"><h2 id="h-start"><span class="dot" aria-hidden="true">●</span> Where to start</h2><ol>
<li><span class="k">biggest gap</span> ${topCode ? `<span><code class="il rc">${esc(topCode.code)}</code> · <b>${topCode.n}</b> ${topCode.n === 1 ? "item" : "items"} · lever <a href="#gaps">${esc(topCode.lever)}</a> · ${esc(topCode.owner)}${topLink ? ` · <a href="#${topLink.id}">see the items</a>` : ""}${topCode.plain ? `<span class="dim pl">${esc(topCode.plain)}</span>` : ""}</span>` : `<span>none: every item translated</span>`}</li>
<li><span class="k">needs a person</span> <span><b>${person}</b> of ${rows.length} (manual <b>${rows.filter((r) => r.status === "manual").length}</b>, unsupported <b>${rows.filter((r) => r.status === "unsupported").length}</b>), grouped by reason in <a href="#attention">Needs attention</a>${attentionCount > person ? `; ${attentionCount - person} more need a look for other reasons` : ""}</span></li>
<li><span class="k">read the labels</span> <span>${CLAIMS.map((c) => `<span class="${claimClass(c)}"><span aria-hidden="true">${SHAPE[c]}</span> ${word(c)}</span>`).join(" · ")}: shape, word and colour say the same thing; EXACT IF is always followed by its condition. <a href="#legend">How to read this</a></span></li>
<li><span class="k">explore</span> <span><a href="#stats">Statistics</a> by kind, integration, widget type and reason · <a href="#gaps">Top gaps</a> by lever and owner · every item has a stable link (#it-…)</span></li>
</ol></section>`;

  // ---------------------------------------------------------------- per dashboard
  const itemRow = (r: Row) => {
    const plain = plainOf(r);
    return `<tbody class="item" id="${idOf.get(r)}" data-claim="${esc(r.status)}" data-w="${esc(slug(r.widget))}"${isAttention(r) ? ` data-att="1"` : ""}><tr class="main"><th scope="row">${esc(r.title || "(untitled)")}<span class="sub">${esc(r.widget)}</span></th><td data-l="claim">${pill(r.status)}</td><td data-l="decision" class="dim">${esc(r.decision)}</td><td data-l="translated">${mark(r.translated, "translated")}</td><td data-l="landed">${mark(r.landed, "landed")}</td><td data-l="live">${liveCell(r.live)}</td></tr>
<tr class="more"><td colspan="6">${exactIf(r)}${plain ? `<p class="plain">${esc(plain)}</p>` : ""}${queries(r)}${r.live === "missing" || r.live === "error" ? `<p class="bad-note">⎿ ${esc(LIVE_WORDS[r.live]!)}${r.liveDetail ? `: ${esc(r.liveDetail)}` : ""}</p>` : ""}${r.landed === false ? `<p class="bad-note">⎿ did not land: ${esc(r.landedDetail)}</p>` : ""}${todo(r)}${codes(r)}</td></tr></tbody>`;
  };
  /** Big runs: EXACT IF panels that need nothing are listed by name under their condition (shown once per group). */
  const compactRows = (rs: Row[]) => {
    const byCond = new Map<string, Row[]>();
    for (const r of rs) {
      const k = r.condition ?? "";
      byCond.set(k, [...(byCond.get(k) ?? []), r]);
    }
    return `<div class="compact">${[...byCond.entries()]
      .map(
        ([c, xs]) =>
          `<div class="cg"><p class="exactif"><b class="c-exact-under">EXACT IF</b> ${c ? esc(c) : `<span class="dim">condition not recorded in this run</span>`} <span class="dim">· ${plural(xs.length, "panel")}</span></p><ul>${xs.map((r) => `<li class="item ce" id="${idOf.get(r)}" data-w="${esc(slug(r.widget))}">${esc(r.title || "(untitled)")} <span class="dim">${esc(r.widget)}</span></li>`).join("")}</ul></div>`,
      )
      .join("")}</div>`;
  };
  const dashSection = (d: string) => {
    const ps = panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d);
    const ok = ps.filter((r) => r.success).length;
    const tr = ps.filter((r) => r.translated).length;
    const mix = CLAIMS.map((c) => [c, ps.filter((r) => r.status === c).length] as const).filter(([, k]) => k > 0);
    const att = ps.filter(isAttention).length;
    // In a big run, an EXACT IF panel with nothing to look at (no failure, no to-do) is summarised; the rest keep full detail.
    const quiet = (r: Row) => summarise && r.status === "exact-under" && !isAttention(r) && !r.manualActions.length;
    const full = ps.filter((r) => !quiet(r));
    const brief = ps.filter(quiet);
    return `<details class="dash" id="${dashId.get(d)}"${manyDash ? "" : " open"}><summary><h3><span class="dot" aria-hidden="true">●</span> ${esc(d)}</h3>
<span class="ds"><span>${plural(ps.length, "panel")}</span><span>${measured ? `success <b>${ok}</b> of ${ps.length}` : `translated <b>${tr}</b> of ${ps.length}`}</span>${att ? `<span class="warn">${att} need${att === 1 ? "s" : ""} attention</span>` : ""}</span>
<span class="mini" aria-hidden="true">${mix.map(([c, k]) => `<i class="${claimClass(c)}" style="flex:${k}"></i>`).join("")}</span>
<span class="dmix">${mix.map(([c, k]) => `<span class="${claimClass(c)}"><span aria-hidden="true">${SHAPE[c]}</span> ${word(c)} ${k}</span>`).join(" ")}</span></summary>
${full.length ? `<table class="items"><caption class="sr">Panels of ${esc(d)}</caption><thead><tr><th scope="col">panel</th><th scope="col">claim</th><th scope="col">decision</th><th scope="col">translated</th><th scope="col">landed</th><th scope="col">live</th></tr></thead>
${full.map(itemRow).join("\n")}
</table>` : ""}${brief.length ? `${full.length ? `<p class="dim cnote">⎿ ${plural(brief.length, "more panel")}, all EXACT IF with nothing to do, listed by condition (Datadog query and PromQL for each are in report.json):</p>` : ""}${compactRows(brief)}` : ""}</details>`;
  };
  // Dashboards in input order, under their integration when the input has folders per integration.
  const dashBlocks = grouped
    ? integrations
        .map((x) => {
          const ds = dashboards.filter((d) => panels.some((r) => (r.dashboard ?? "(no dashboard)") === d && intOf.get(r) === x));
          const ms = monitors.filter((r) => intOf.get(r) === x);
          if (!ds.length && !ms.length) return "";
          return `<div class="intg" id="${intId.get(x)}"><h3 class="inth"><span class="dim">integration</span> ${esc(x)} <span class="n">· ${plural(ds.length, "dashboard")} · ${plural(ms.length, "monitor")}</span>${ms.length ? ` <a class="dim" href="#${idOf.get(ms[0]!)}">monitors ↓</a>` : ""}</h3>${ds.map(dashSection).join("\n")}</div>`;
        })
        .join("\n")
    : dashboards.map(dashSection).join("\n");

  // ---------------------------------------------------------------- monitors
  const monBlock = (r: Row) => {
    const plain = plainOf(r);
    const t = r.thresholds;
    return `<article class="item mon" id="${idOf.get(r)}" data-claim="${esc(r.status)}" data-w="${esc(slug(r.widget))}"${isAttention(r) ? ` data-att="1"` : ""}><header><h3>${esc(r.title || r.id)}</h3>${pill(r.status)}</header>
<dl class="facts"><div><dt>decision</dt><dd>${esc(r.decision)}</dd></div><div><dt>landed</dt><dd>${mark(r.landed, "landed")}${r.landed !== null ? ` <span class="dim">${esc(r.landedDetail)}</span>` : ""}</dd></div>${r.enabled !== undefined ? `<div><dt>rule</dt><dd>${r.enabled ? `<span class="ok">on</span>` : `<span class="dim">off (import disabled; turn on in Dash0)</span>`}</dd></div>` : ""}${t ? `<div><dt>thresholds</dt><dd>failed <b>${t.failed}</b>${t.degraded !== undefined ? ` · degraded <b>${t.degraded}</b>` : ""}</dd></div>` : ""}${r.live !== null ? `<div><dt>live</dt><dd>${liveCell(r.live)}</dd></div>` : ""}</dl>
${exactIf(r)}${plain ? `<p class="plain">${esc(plain)}</p>` : ""}${queries(r)}${todo(r)}${codes(r)}</article>`;
  };
  const monSection = monitors.length
    ? `<section id="monitors" aria-labelledby="h-mon"><h2 id="h-mon"><span class="dot" aria-hidden="true">●</span> Monitors <span class="dim">· ${monitors.length} · ${monitors.filter((r) => r.translated).length} translated to Dash0 check rules</span></h2>
<div class="mons">${
        grouped
          ? integrations
              .filter((x) => monitors.some((r) => intOf.get(r) === x))
              .map((x) => `<h3 class="inth mint"><span class="dim">integration</span> <a href="#${intId.get(x)}">${esc(x)}</a></h3>${monitors.filter((r) => intOf.get(r) === x).map(monBlock).join("\n")}`)
              .join("\n")
          : monitors.map(monBlock).join("\n")
      }</div><p class="none-match dim">⎿ No monitor matches this filter.</p></section>`
    : "";

  // ---------------------------------------------------------------- headline
  const s = score.success;
  const notes = panels.filter((r) => r.widget === "note").length;
  const trOf = (xs: Row[]) => xs.filter((r) => r.translated).length;
  const byKind = `panels <b>${trOf(panels)}</b> of ${panels.length}${notes ? ` (${plural(notes, "text note")} included)` : ""} · monitors <b>${trOf(monitors)}</b> of ${monitors.length}`;
  const headline =
    measured && s
      ? `<h1 id="h-sum"><span class="accent">${s.count} of ${s.total}</span> items succeeded <span class="h1s">translated, landed in Dash0 and not missing data. Translated ${score.translated.count} of ${score.translated.total}: ${byKind}.</span></h1>`
      : `<h1 id="h-sum"><span class="accent">${score.translated.count} of ${score.translated.total}</span> items translated <span class="h1s">${byKind}. ${dry ? "Dry run: nothing was imported, so landed, live and success are not measured." : "Landing was not measured."}</span></h1>`;
  const mixBar = claimCounts.length
    ? `<div class="mix"><div class="mixbar" role="img" aria-label="${esc(claimCounts.map(([c, n]) => `${word(c)} ${n}`).join(", "))}">${claimCounts.map(([c, n]) => `<i class="${claimClass(c)}" style="flex:${n}"></i>`).join("")}</div>
<ul class="legend-row">${claimCounts.map(([c, n]) => `<li><span class="${claimClass(c)}" aria-hidden="true">${SHAPE[c]}</span>${word(c)} <b>${n}</b></li>`).join("")}</ul></div>`
    : "";

  // ---------------------------------------------------------------- proof: only what this run recorded
  const liveDenom = lc ? lc.live + lc.missing + lc.error : 0;
  const proofRows: [string, string, boolean][] = [
    ["landed in Dash0", score.landed ? `<b>${score.landed.count}</b> of ${score.landed.total} imported and read back from Dash0 as a match` : `Not recorded${dry ? " (dry run: nothing was imported)" : ""}`, !!score.landed],
    ["returns data", lc ? `<b>${lc.live}</b> of ${liveDenom} queries return data in Dash0 where Datadog has data (last ${facts.windowSeconds / 60} min, presence only)` : "Not checked", !!lc],
    ["values vs Datadog", "Not checked: this run does not compare values with Datadog (parity is a separate, time-dependent check and is not part of this report)", false],
  ];
  const proof = `<dl class="proof" aria-label="Proof recorded by this run">${proofRows.map(([k, v, rec]) => `<div><dt>${k}</dt><dd${rec ? "" : ' class="dim"'}>${v}</dd></div>`).join("")}</dl>`;
  const funnel = `found <b>${score.total}</b> <span class="dim">→</span> translated <b>${score.translated.count}</b>${score.landed ? ` <span class="dim">→</span> landed <b>${score.landed.count}</b>` : ""}${s ? ` <span class="dim">→</span> success <b>${s.count}</b>` : ""}`;

  // ---------------------------------------------------------------- legend
  const legend = `<section id="legend" aria-labelledby="h-leg"><h2 id="h-leg"><span class="dot" aria-hidden="true">●</span> How to read this</h2>
<div class="cols"><div><h3>Claims <span class="dim">(per item, decided by the rules, never by this page)</span></h3><dl class="claims">${CLAIMS.map((c) => `<div><dt>${pill(c)}</dt><dd>${esc(LEGEND[c])}${c === "exact-under" ? " Each such item shows EXACT IF followed by its condition." : c === "bounded" ? " The bound is a proven error bound, stated by the rule." : ""}</dd></div>`).join("")}</dl></div>
<div><h3>The four numbers</h3><dl class="claims"><div><dt>success</dt><dd>translated, landed and not missing data in Dash0.</dd></div><div><dt>translated</dt><dd>exact, EXACT IF (with its condition), or bounded (within a proven error bound) and approved in review.</dd></div><div><dt>landed</dt><dd>imported and read back from Dash0 as a match (placeholders count: they did land).</dd></div><div><dt>live</dt><dd>Dash0 returns data when Datadog does (last ${facts.windowSeconds / 60} min, presence only; values are not compared).</dd></div></dl>
<p class="dim">Every panel (text notes too) and every monitor counts, each once. Groups are containers and are not counted.</p>
<h3>Live check</h3><dl class="claims">${Object.entries(LIVE_WORDS).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${k === "missing" || k === "error" ? " <span class=\"bad\">(failure)</span>" : ""}</dd></div>`).join("")}</dl></div></div></section>`;

  // ---------------------------------------------------------------- nav
  const nav = `<nav class="toc" aria-label="Report sections"><a class="brand" href="#top"><span class="accent" aria-hidden="true">◆</span> dd2dash0</a><ol>
<li><a href="#summary">Summary</a></li>
<li><a href="#start">Where to start</a></li>
<li><a href="#attention">Needs attention <span class="n">${attentionCount}</span></a></li>
<li><a href="#gaps">Top gaps <span class="n">${gapTotal}</span></a></li>
<li><a href="#stats">Statistics</a></li>
${
  dashboards.length
    ? grouped
      ? `<li><a href="#dashboards">Integrations <span class="n">${integrations.length}</span></a><ol>${integrations.map((x) => `<li><a href="#${intId.get(x)}">${esc(x)} <span class="n">${rows.filter((r) => intOf.get(r) === x).length}</span></a></li>`).join("")}</ol></li>`
      : `<li><a href="#dashboards">Dashboards <span class="n">${dashboards.length}</span></a><ol>${dashboards.map((d) => `<li><a href="#${dashId.get(d)}">${esc(d)} <span class="n">${panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d).length}</span></a></li>`).join("")}</ol></li>`
    : ""
}
${monitors.length ? `<li><a href="#monitors">Monitors <span class="n">${monitors.length}</span></a></li>` : ""}
<li><a href="#legend">How to read this</a></li>
<li><a href="#run">Run</a></li></ol></nav>`;

  const when = esc(facts.startedAt.replace("T", " ").slice(0, 19));
  return `<a class="skip" href="#main">Skip to report</a><div class="shell">
${nav}
<main id="main">
<div class="frame"><div class="t"><span class="accent" aria-hidden="true">◆</span> <b>dd2dash0</b> <span class="dim">${esc(facts.version)} · migration report</span></div>
<dl class="hdr"><div><dt>input</dt><dd>${esc(facts.source)}</dd></div><div><dt>target</dt><dd>${esc(facts.target)}</dd></div><div><dt>mode</dt><dd>${dry ? "dry run, nothing imported" : "live import"}</dd></div><div><dt>build</dt><dd>dd2dash0 ${esc(facts.version)} · ${facts.toolCommit ? `commit ${esc(/^[0-9a-f]{13,}$/.test(facts.toolCommit) ? facts.toolCommit.slice(0, 12) : facts.toolCommit)}` : `<span class="dim">commit not stamped</span>`}</dd></div><div><dt>output</dt><dd><code class="il" title="${esc(facts.outputHash)}">${esc(facts.outputHash.slice(0, 16))}</code> <span class="dim">output hash</span></dd></div><div><dt>run</dt><dd>${when} UTC · ${plural(score.panels, "panel")} · ${plural(score.monitors, "monitor")}</dd></div></dl></div>
<nav class="jump" aria-label="Jump to"><a href="#start">where to start</a><a href="#attention">needs attention (${attentionCount})</a><a href="#gaps">top gaps (${gapTotal})</a><a href="#stats">statistics</a>${dashboards.length ? `<a href="#dashboards">dashboards (${dashboards.length})</a>` : ""}${monitors.length ? `<a href="#monitors">monitors (${monitors.length})</a>` : ""}<a href="#legend">how to read this</a></nav>
<section id="summary" aria-labelledby="h-sum">
${headline}
<div class="meters">
${meter("mk-s", "success", score.success, "translated, landed and not missing data", true)}
${meter("mk-t", "translated", score.translated, "exact, EXACT IF, or bounded (proven error bound) and approved")}
${meter("mk-l", "landed", score.landed, "imported and read back from Dash0")}
${meter("mk-v", "live", score.live, `Dash0 returns data when Datadog does (last ${facts.windowSeconds / 60} min)`)}
</div>
${mixBar}
<div class="runline"><div>⎿ ${funnel}</div>
${lc ? `<div>⎿ live check: <b>${lc.live}</b> live · <b>${lc.missing}</b> missing in Dash0 · <b>${lc.error}</b> query errors · ${lc["no-data"]} no data either side · ${lc["n/a"]} no query</div>` : ""}
${score.topGaps.length ? `<div>⎿ top gaps: ${score.topGaps.map(([c, n]) => `<code class="il">${esc(c)}</code> ×${n}`).join(" · ")}</div>` : ""}</div>
${proof}
</section>
${start}
${attentionSection}
${gapSection}
${statsSection}
${filterBar}
${dashboards.length ? `<section id="dashboards" aria-labelledby="h-dash"><h2 id="h-dash"><span class="dot" aria-hidden="true">●</span> Dashboards <span class="dim">· ${dashboards.length} · ${plural(panels.length, "panel")}</span></h2>
${dashBlocks}</section>` : ""}
${monSection}
${legend}
<footer id="run"><div><span class="accent" aria-hidden="true">◆</span> <b>${esc(facts.outputHash.slice(0, 16))}</b> · no AI in translation</div>
<div>dd2dash0 ${esc(facts.version)} · plan ${esc(facts.planHash.slice(0, 16))} · input ${esc(facts.inputHash.slice(0, 16))} · output ${esc(facts.outputHash.slice(0, 16))}</div>
<div>Translation is parsers, rules and mapping tables. To check that it repeats, run again on the same input and version and compare the output hash.</div></footer>
</main></div>`;
}

/**
 * The page's stylesheet: the deck palette tokens (dark by default, light under prefers-color-scheme), layout, small
 * screens, reduced motion and print. Static; the per-run filter rules come from reportFilterCss().
 */
export const REPORT_CSS = `:root{--bg:#13131c;--raise:#1c1b29;--fg:#ecebf4;--dim:#a3a2b5;--line:#2d2b40;--accent:#a78bfa;--ok:#5fd787;--warn:#f0a43a;--bad:#f2738f;--sel:#a78bfa40;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#ffffff;--raise:#f4f1fc;--fg:#13131c;--dim:#5c5b6b;--line:#e4dcf7;--accent:#6d28d9;--ok:#17703d;--warn:#b45309;--bad:#b4224a;--sel:#6d28d930;color-scheme:light}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:64px}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:13.5px/1.6 ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
::selection{background:var(--sel)}a{color:inherit;text-decoration-color:var(--line);text-underline-offset:3px}a:hover{text-decoration-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:12px;background:var(--bg);padding:4px 8px;z-index:2}
.dim{color:var(--dim)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.accent,.dot{color:var(--accent)}b{font-weight:600}
.shell{display:grid;grid-template-columns:1fr;max-width:1200px;margin:0 auto;padding:6vh 24px 72px;gap:0 48px}
@media (min-width:1240px){.shell{grid-template-columns:200px minmax(0,1fr);max-width:1480px}}
@media (min-width:1800px){.shell{max-width:1640px}}
.toc{display:none}.jump{display:flex;flex-wrap:wrap;gap:2px 14px;margin:-18px 0 28px;font-size:12.5px;color:var(--dim)}.jump a{color:var(--dim)}
@media (min-width:1240px){.jump{display:none}}
@media (min-width:1240px){.toc{display:block;position:sticky;top:6vh;align-self:start;max-height:88vh;overflow:auto;font-size:12.5px}}
.toc .brand{display:block;font-weight:600;text-decoration:none;margin:0 0 14px}.toc ol{list-style:none;margin:0;padding:0}.toc li{margin:0}
.toc a{display:flex;justify-content:space-between;gap:8px;padding:3px 0;color:var(--dim);text-decoration:none}.toc a:hover{color:var(--fg)}
.toc ol ol{padding-left:1.5ch;border-left:1px solid var(--line);margin:2px 0 4px 2px}.toc ol ol a{padding-left:1ch}.toch{display:block;color:var(--dim);padding:3px 0}
.n{color:var(--dim);font-weight:400}
main{min-width:0}
.frame{border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin-bottom:32px;display:inline-block;max-width:100%}
.frame .t b{font-weight:600}
h1{font-size:30px;line-height:1.15;font-weight:600;letter-spacing:-.02em;margin:0 0 22px;text-wrap:balance}
.h1s{display:block;font-size:14px;font-weight:400;letter-spacing:0;color:var(--dim);margin-top:8px;max-width:72ch;line-height:1.5}
.meters{margin:0 0 22px;max-width:980px}.m{display:grid;grid-template-columns:10ch minmax(120px,300px) 13ch 1fr;gap:14px;align-items:center;padding:4px 0}
.k{color:var(--dim)}.v{color:var(--dim)}.v b{color:var(--fg)}.m.lead .k{color:var(--fg);font-weight:600}.w{color:var(--dim);font-size:12.5px}
.bar{display:flex;height:8px;border-radius:2px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar s{display:block}.m.lead .bar{height:10px}
.bar.off{background:transparent;border:1px dashed var(--line)}
.mix{margin:0 0 18px;max-width:980px}.mixbar{display:flex;height:6px;border-radius:2px;overflow:hidden;background:var(--line);gap:2px}.mixbar i{display:block;height:100%}
.legend-row{list-style:none;display:flex;flex-wrap:wrap;gap:4px 18px;margin:8px 0 0;padding:0;font-size:12.5px}.legend-row li{display:flex;align-items:center;gap:6px}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px}
i.c-exact,.sw.c-exact{background:var(--ok)}i.c-exact-under,.sw.c-exact-under{background:color-mix(in srgb,var(--ok) 55%,var(--bg))}i.c-bounded,.sw.c-bounded{background:var(--accent)}i.c-manual,.sw.c-manual{background:var(--warn)}i.c-unsupported,.sw.c-unsupported{background:var(--bad)}i.c-other{background:var(--dim)}
.hdr{margin:4px 0 0;font-size:12.5px}.hdr div{display:grid;grid-template-columns:7ch 1fr;gap:12px}.hdr dt{color:var(--dim)}.hdr dd{margin:0;min-width:0;overflow-wrap:anywhere}
.proof{margin:14px 0 0;max-width:980px;font-size:12.5px}.proof div{display:grid;grid-template-columns:18ch 1fr;gap:12px;padding:3px 0;border-top:1px solid var(--line)}.proof dt{color:var(--dim)}.proof dd{margin:0}.proof b{color:var(--fg)}
.exactif{margin:2px 0 6px;font-size:12.5px;max-width:110ch}.exactif b{margin-right:6px}
.rc{color:var(--fg)}ul.codes{list-style:none;padding:0}ul.codes li{padding:1px 0}
.runline{color:var(--dim);margin:0;font-size:12.5px}.runline div{padding:1px 0}.runline b{color:var(--fg)}
section{margin:0 0 48px}#summary{margin-bottom:44px}
h2{font-size:15px;font-weight:600;margin:0 0 12px}h3{font-size:13.5px;font-weight:600;margin:0}
.lede{color:var(--dim);margin:-4px 0 14px;max-width:80ch}
.att{display:grid;gap:10px}
.ag{border:1px solid var(--line);border-radius:8px;padding:0 14px}.ag>summary{padding:10px 0;cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.ag>summary::-webkit-details-marker,.dash>summary::-webkit-details-marker{display:none}
.ag>summary::before,.dash>summary::before{content:"▸";color:var(--dim);display:inline-block;width:1.2ch;transition:transform 160ms cubic-bezier(.23,1,.32,1)}.ag[open]>summary::before,.dash[open]>summary::before{transform:rotate(90deg)}
.agt{font-weight:600}.ag-error .agt,.ag-missing .agt,.ag-landed .agt{color:var(--bad)}.ag-manual .agt{color:var(--warn)}.ag-unsupported .agt{color:var(--bad)}.ag-bounded .agt{color:var(--accent)}
.agh{flex-basis:100%;color:var(--dim);font-size:12.5px;padding-left:1.2ch}
.ag ul{list-style:none;margin:0;padding:0 0 10px 1.2ch;columns:2 460px;column-gap:32px}.ag li{break-inside:avoid;padding:4px 0}.why{color:var(--dim);font-size:12.5px;padding-left:1ch}
.filter{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px;position:sticky;top:0;z-index:1;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line)}
.filter input{position:absolute;opacity:0;width:1px;height:1px}
.filter label{border:1px solid var(--line);border-radius:999px;padding:2px 10px;cursor:pointer;color:var(--dim);font-size:12.5px;transition:color 120ms ease,border-color 120ms ease}
.filter label:hover{color:var(--fg)}.filter input:checked+label{color:var(--fg);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.filter input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.dash{margin:0 0 30px}.dash>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:auto 1fr;gap:2px 0;padding:6px 0 10px}
.dash>summary>*:not(h3){grid-column:2}.dash h3{display:inline;font-size:14px}
.ds{display:flex;flex-wrap:wrap;gap:0 16px;color:var(--dim);font-size:12.5px}.ds b{color:var(--fg)}
.mini{display:flex;height:4px;gap:2px;border-radius:2px;overflow:hidden;max-width:420px;margin:6px 0 2px}.mini i{display:block}
.dmix{font-size:12px}.dmix span{margin-right:10px}
.claim{font-size:12px;white-space:nowrap;border:1px solid color-mix(in srgb,currentColor 40%,transparent);border-radius:4px;padding:0 6px}
.c-exact,.c-exact-under{color:var(--ok)}.c-bounded{color:var(--accent)}.c-manual{color:var(--warn)}.c-unsupported{color:var(--bad)}.c-other{color:var(--dim)}
table{width:100%;border-collapse:collapse}
thead th{font-weight:400;color:var(--dim);text-align:left;border-bottom:1px solid var(--line);padding:4px 12px 6px 0;font-size:12.5px}
.main th,.main td{padding:9px 12px 2px 0;vertical-align:baseline;text-align:left}.main th{font-weight:600;width:42%}
.sub{display:block;font-weight:400;color:var(--dim);font-size:12px}
.more td{padding:2px 12px 12px 0;border-bottom:1px solid var(--line)}
tbody.item:target .main th{color:var(--accent)}
.plain{color:var(--dim);margin:2px 0 8px;max-width:96ch;font-size:12.5px}
.qs{display:grid;grid-template-columns:1fr;gap:4px;margin:0 0 6px}
@media (min-width:1100px){.qs{grid-template-columns:1fr 1fr;gap:12px}}
.q{background:var(--raise);border-radius:6px;padding:6px 10px;min-width:0}.ql{display:block;color:var(--dim);font-size:11.5px;margin-bottom:1px}
code{font:inherit;font-size:12.5px;white-space:pre-wrap;word-break:break-word;display:block}.codes code,.why code,code.il{display:inline;color:var(--dim)}
.codes{margin:4px 0 0;font-size:12px}.todo{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}.todo li{padding:1px 0}
.bad-note{color:var(--bad);margin:4px 0;font-size:12.5px}
.mons{display:grid;gap:0}.mon{border-top:1px solid var(--line);padding:14px 0 16px}.mon:last-child{border-bottom:1px solid var(--line)}
.mon header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin-bottom:6px}.mon:target h3{color:var(--accent)}
.facts{display:flex;flex-wrap:wrap;gap:2px 22px;margin:0 0 8px;font-size:12.5px}.facts div{display:flex;gap:8px}.facts dt{color:var(--dim)}.facts dd{margin:0}
.none-match{display:none}
.start{border:1px solid var(--line);border-radius:10px;padding:12px 16px 8px;max-width:1080px}.start h2{margin-bottom:6px}.start ol{list-style:none;margin:0;padding:0}
.start li{display:grid;grid-template-columns:16ch 1fr;gap:12px;padding:5px 0;border-top:1px solid var(--line)}.start li:first-child{border-top:0}.start .k{color:var(--dim)}.start b{color:var(--fg)}
.pl{display:block;font-size:12px;max-width:96ch}
.st{border:1px solid var(--line);border-radius:8px;padding:0 14px;margin:0 0 10px}.st>summary{padding:10px 0;cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-weight:600}
.st>summary::-webkit-details-marker,.fw>summary::-webkit-details-marker{display:none}.st>summary::before{content:"▸";color:var(--dim);display:inline-block;width:1.2ch;transition:transform 160ms cubic-bezier(.23,1,.32,1)}.st[open]>summary::before{transform:rotate(90deg)}
.st,#gaps{overflow-x:auto}.st>summary .agh{font-weight:400}.st>table{margin:0 0 12px}
table.stat{font-size:12.5px;margin:0 0 4px}.stat th,.stat td{padding:4px 12px 4px 0;text-align:left;border-bottom:1px solid var(--line);vertical-align:baseline}.stat tbody th{font-weight:400}
.stat .num{text-align:right;white-space:nowrap}.stat thead th.num{text-align:right}.stat .lv{white-space:nowrap}
.gap .lvr th,.gap .lvr td{padding-top:14px;font-weight:600;border-bottom:1px solid var(--line)}.gap .lvr .agh{display:block;font-weight:400;padding-left:0}
.intg{margin:0 0 28px;padding-top:4px}.inth{font-size:13.5px;margin:0 0 10px;padding:6px 0;border-bottom:1px dashed var(--line)}.mint{margin-top:18px}
.compact .cg{margin:0 0 10px}.compact ul{list-style:none;margin:0;padding:0 0 0 1.2ch;columns:2 420px;column-gap:28px;font-size:12.5px}.compact li{break-inside:avoid;padding:1px 0}.compact li:target{color:var(--accent)}.cnote{font-size:12.5px;margin:10px 0 6px}
.filter{flex-direction:column;align-items:stretch}.fg{display:flex;flex-wrap:wrap;gap:6px}.fw>summary{cursor:pointer;color:var(--dim);font-size:12.5px;list-style:none;display:inline-block}.fw>summary::before{content:"▸ "}.fw[open]>summary::before{content:"▾ "}.fw .fg{margin-top:6px;max-height:30vh;overflow:auto}.fhint{font-size:12px}
.cols{display:grid;gap:24px 48px}@media (min-width:900px){.cols{grid-template-columns:1fr 1fr}}
.cols h3{margin:0 0 8px}.cols h3+dl{margin-top:0}.cols p{font-size:12.5px}
.claims{margin:0 0 16px}.claims div{display:grid;grid-template-columns:13ch 1fr;gap:12px;padding:4px 0;border-bottom:1px solid var(--line)}.claims dt{color:var(--fg)}.claims dd{margin:0;color:var(--dim);font-size:12.5px}
footer{color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}footer div{padding:1px 0}
@media (max-width:760px){
 .shell{padding:28px 16px 56px}h1{font-size:24px}html{scroll-padding-top:12px}
 .filter{position:static;flex-wrap:nowrap;overflow-x:auto;margin:0 -16px 18px;padding:10px 16px}.filter label{white-space:nowrap}
 .m{grid-template-columns:10ch 1fr 11ch}.m .w{grid-column:1/-1;margin:-4px 0 4px}.proof div{grid-template-columns:1fr;gap:0}
 thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
 table,tbody,tr,th,td{display:block}.main{display:flex;flex-wrap:wrap;gap:4px 14px;padding-top:10px}
 .main th{width:100%;padding:0}.main td{padding:0;font-size:12.5px}.main td[data-l]:not([data-l=claim])::before{content:attr(data-l) " ";color:var(--dim)}
 .more td{padding:6px 0 12px}.claims div{grid-template-columns:1fr;gap:0}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
@media print{
 :root{--bg:#fff;--raise:#f4f4f2;--fg:#000;--dim:#444;--line:#ccc;--accent:#5b21b6;--ok:#0d6632;--warn:#7a4f00;--bad:#a12020;color-scheme:light}
 body{font-size:12px}.shell{display:block;padding:0;max-width:none}.toc,.jump,.filter,.skip{display:none}
 details::details-content{content-visibility:visible;display:block}details>summary::before{display:none}
 .item,.ag li,.mon{break-inside:avoid}h2,h3{break-after:avoid}a{text-decoration:none}
}`;

/** The claim-filter rules for this run's items (radio + :has, no script): one rule set per filter but "all". */
export function reportFilterCss(rows: Row[]): string {
  // Big runs get no :has() filter: re-styling 14k items per click took seconds in Chromium. They filter by anchors
  // (Statistics, Top gaps, Needs attention groups, integration sections) and find-in-page instead.
  if (rows.length > DETAIL_LIMIT) return "";
  const keys = ["att", ...CLAIMS.filter((c) => rows.some((r) => r.status === c))];
  const rule = (input: string, keep: string) =>
    `main:has(#${input}:checked) .item:not(${keep}),main:has(#${input}:checked) :is(.dash,.intg,.cg):not(:has(.item${keep})){display:none}main:has(#${input}:checked) #monitors:not(:has(.item${keep})) .none-match{display:block}`;
  const widgets = [...new Set(rows.map((r) => slug(r.widget)))].sort();
  return [
    // Summarised EXACT IF items (.ce) carry no data-claim: they are all exact-under.
    ...keys.map((k) => rule(`f-${k}`, k === "att" ? `[data-att="1"]` : k === "exact-under" ? `:is([data-claim="exact-under"],.ce)` : `[data-claim="${k}"]`)),
    ...widgets.map((w) => rule(`w-${esc(w)}`, `[data-w="${esc(w)}"]`)),
  ].join("\n");
}

/** The whole offline page: shell + REPORT_CSS + reportFilterCss(rows) + reportBody(...). */
export function reportHtml(score: Score, rows: Row[], facts: RunFacts): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0 report · ${esc(facts.startedAt.slice(0, 16).replace("T", " "))}</title><meta name="color-scheme" content="dark light">
<style>
${REPORT_CSS}
${reportFilterCss(rows)}
</style></head><body id="top">${reportBody(score, rows, facts)}</body></html>
`;
}
