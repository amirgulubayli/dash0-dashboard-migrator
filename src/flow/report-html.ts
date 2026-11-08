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

type Group = { key: string; code?: string; title: string; hint: string; rows: Row[] };

/** The report's inner HTML (everything inside <body>), without <html>/<head>. reportHtml() wraps it with REPORT_CSS. */
export function reportBody(score: Score, rows: Row[], facts: RunFacts): string {
  const idOf = new Map(rows.map((r, i) => [r, `i${i + 1}`]));
  const panels = rows.filter((r) => r.kind === "panel");
  const dashboards = [...new Set(panels.map((r) => r.dashboard ?? "(no dashboard)"))];
  const monitors = rows.filter((r) => r.kind === "alert");
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
      const code = r.reasons.find((c) => r.reasonPlain?.[c]?.startsWith("Not migrated")) ?? r.reasons[0] ?? "(no reason code)";
      let x = m.get(code);
      if (!x) m.set(code, (x = { key: status, code, title, hint: r.reasonPlain?.[code] ?? (status === "unsupported" ? LEGEND.unsupported : "No translation rule covers it; the original is kept so a person can rebuild it."), rows: [] }));
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
            `<details class="ag ag-${x.key}"${x.rows.length <= 12 ? " open" : ""}><summary><span class="agt">${esc(x.title)}</span>${x.code ? ` <code class="il rc">${esc(x.code)}</code>` : ""} <span class="n">${plural(x.rows.length, "item")}</span>${x.hint ? `<span class="agh">${esc(x.hint)}</span>` : ""}</summary><ul>${x.rows.map((r) => attLine(r, x.key, x.code)).join("")}</ul></details>`,
        )
        .join("\n")}</div>`
    : `<p class="lede">⎿ Nothing: every item translated${measured ? ", landed and returns data where Datadog does" : ""}.</p>`
}</section>`;

  // ---------------------------------------------------------------- filter (radio + :has, no script)
  const claimCounts = CLAIMS.map((c) => [c, rows.filter((r) => r.status === c).length] as const).filter(([, n]) => n > 0);
  const filters: [string, string, number][] = [["all", "all", rows.length], ["att", "needs attention", attentionCount], ...claimCounts.map(([c, n]) => [c, word(c), n] as [string, string, number])];
  const filterBar = `<div class="filter" role="radiogroup" aria-label="Show items">${filters.map(([k, label, n], i) => `<input type="radio" name="show" id="f-${k}" value="${k}"${i === 0 ? " checked" : ""}><label for="f-${k}">${esc(label)} <span class="n">${n}</span></label>`).join("")}</div>`;

  // ---------------------------------------------------------------- per dashboard
  const dashSection = (d: string, n: number) => {
    const ps = panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d);
    const ok = ps.filter((r) => r.success).length;
    const tr = ps.filter((r) => r.translated).length;
    const mix = CLAIMS.map((c) => [c, ps.filter((r) => r.status === c).length] as const).filter(([, k]) => k > 0);
    const att = ps.filter(isAttention).length;
    return `<details class="dash" id="d${n}" open><summary><h3><span class="dot" aria-hidden="true">●</span> ${esc(d)}</h3>
<span class="ds"><span>${plural(ps.length, "panel")}</span><span>${measured ? `success <b>${ok}</b> of ${ps.length}` : `translated <b>${tr}</b> of ${ps.length}`}</span>${att ? `<span class="warn">${att} need${att === 1 ? "s" : ""} attention</span>` : ""}</span>
<span class="mini" aria-hidden="true">${mix.map(([c, k]) => `<i class="${claimClass(c)}" style="flex:${k}"></i>`).join("")}</span>
<span class="dmix">${mix.map(([c, k]) => `<span class="${claimClass(c)}"><span aria-hidden="true">${SHAPE[c]}</span> ${word(c)} ${k}</span>`).join(" ")}</span></summary>
<table class="items"><caption class="sr">Panels of ${esc(d)}</caption><thead><tr><th scope="col">panel</th><th scope="col">claim</th><th scope="col">decision</th><th scope="col">translated</th><th scope="col">landed</th><th scope="col">live</th></tr></thead>
${ps
  .map((r) => {
    const plain = plainOf(r);
    return `<tbody class="item" id="${idOf.get(r)}" data-claim="${esc(r.status)}"${isAttention(r) ? ` data-att="1"` : ""}><tr class="main"><th scope="row">${esc(r.title || "(untitled)")}<span class="sub">${esc(r.widget)}</span></th><td data-l="claim">${pill(r.status)}</td><td data-l="decision" class="dim">${esc(r.decision)}</td><td data-l="translated">${mark(r.translated, "translated")}</td><td data-l="landed">${mark(r.landed, "landed")}</td><td data-l="live">${liveCell(r.live)}</td></tr>
<tr class="more"><td colspan="6">${exactIf(r)}${plain ? `<p class="plain">${esc(plain)}</p>` : ""}${queries(r)}${r.live === "missing" || r.live === "error" ? `<p class="bad-note">⎿ ${esc(LIVE_WORDS[r.live]!)}${r.liveDetail ? `: ${esc(r.liveDetail)}` : ""}</p>` : ""}${r.landed === false ? `<p class="bad-note">⎿ did not land: ${esc(r.landedDetail)}</p>` : ""}${todo(r)}${codes(r)}</td></tr></tbody>`;
  })
  .join("\n")}
</table></details>`;
  };

  // ---------------------------------------------------------------- monitors
  const monBlock = (r: Row) => {
    const plain = plainOf(r);
    const t = r.thresholds;
    return `<article class="item mon" id="${idOf.get(r)}" data-claim="${esc(r.status)}"${isAttention(r) ? ` data-att="1"` : ""}><header><h3>${esc(r.title || r.id)}</h3>${pill(r.status)}</header>
<dl class="facts"><div><dt>decision</dt><dd>${esc(r.decision)}</dd></div><div><dt>landed</dt><dd>${mark(r.landed, "landed")}${r.landed !== null ? ` <span class="dim">${esc(r.landedDetail)}</span>` : ""}</dd></div>${r.enabled !== undefined ? `<div><dt>rule</dt><dd>${r.enabled ? `<span class="ok">on</span>` : `<span class="dim">off (import disabled; turn on in Dash0)</span>`}</dd></div>` : ""}${t ? `<div><dt>thresholds</dt><dd>failed <b>${t.failed}</b>${t.degraded !== undefined ? ` · degraded <b>${t.degraded}</b>` : ""}</dd></div>` : ""}${r.live !== null ? `<div><dt>live</dt><dd>${liveCell(r.live)}</dd></div>` : ""}</dl>
${exactIf(r)}${plain ? `<p class="plain">${esc(plain)}</p>` : ""}${queries(r)}${todo(r)}${codes(r)}</article>`;
  };
  const monSection = monitors.length
    ? `<section id="monitors" aria-labelledby="h-mon"><h2 id="h-mon"><span class="dot" aria-hidden="true">●</span> Monitors <span class="dim">· ${monitors.length} · ${monitors.filter((r) => r.translated).length} translated to Dash0 check rules</span></h2>
<div class="mons">${monitors.map(monBlock).join("\n")}</div><p class="none-match dim">⎿ No monitor matches this filter.</p></section>`
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
<li><a href="#attention">Needs attention <span class="n">${attentionCount}</span></a></li>
${dashboards.length ? `<li><span class="toch">Dashboards</span><ol>${dashboards.map((d, i) => `<li><a href="#d${i + 1}">${esc(d)} <span class="n">${panels.filter((r) => (r.dashboard ?? "(no dashboard)") === d).length}</span></a></li>`).join("")}</ol></li>` : ""}
${monitors.length ? `<li><a href="#monitors">Monitors <span class="n">${monitors.length}</span></a></li>` : ""}
<li><a href="#legend">How to read this</a></li>
<li><a href="#run">Run</a></li></ol></nav>`;

  const when = esc(facts.startedAt.replace("T", " ").slice(0, 19));
  return `<a class="skip" href="#main">Skip to report</a><div class="shell">
${nav}
<main id="main">
<div class="frame"><div class="t"><span class="accent" aria-hidden="true">◆</span> <b>dd2dash0</b> <span class="dim">${esc(facts.version)} · migration report</span></div>
<dl class="hdr"><div><dt>input</dt><dd>${esc(facts.source)}</dd></div><div><dt>target</dt><dd>${esc(facts.target)}</dd></div><div><dt>mode</dt><dd>${dry ? "dry run, nothing imported" : "live import"}</dd></div><div><dt>build</dt><dd>dd2dash0 ${esc(facts.version)} · ${facts.toolCommit ? `commit ${esc(/^[0-9a-f]{13,}$/.test(facts.toolCommit) ? facts.toolCommit.slice(0, 12) : facts.toolCommit)}` : `<span class="dim">commit not stamped</span>`}</dd></div><div><dt>output</dt><dd><code class="il" title="${esc(facts.outputHash)}">${esc(facts.outputHash.slice(0, 16))}</code> <span class="dim">output hash</span></dd></div><div><dt>run</dt><dd>${when} UTC · ${plural(score.panels, "panel")} · ${plural(score.monitors, "monitor")}</dd></div></dl></div>
<nav class="jump" aria-label="Jump to"><a href="#attention">needs attention (${attentionCount})</a>${dashboards.length ? `<a href="#dashboards">dashboards (${dashboards.length})</a>` : ""}${monitors.length ? `<a href="#monitors">monitors (${monitors.length})</a>` : ""}<a href="#legend">how to read this</a></nav>
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
${attentionSection}
${filterBar}
${dashboards.length ? `<section id="dashboards" aria-labelledby="h-dash"><h2 id="h-dash"><span class="dot" aria-hidden="true">●</span> Dashboards <span class="dim">· ${dashboards.length} · ${plural(panels.length, "panel")}</span></h2>
${dashboards.map((d, i) => dashSection(d, i + 1)).join("\n")}</section>` : ""}
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
  const keys = ["att", ...CLAIMS.filter((c) => rows.some((r) => r.status === c))];
  return keys
    .map((k) => {
      const keep = k === "att" ? `[data-att="1"]` : `[data-claim="${k}"]`;
      return `main:has(#f-${k}:checked) .item:not(${keep}),main:has(#f-${k}:checked) .dash:not(:has(.item${keep})){display:none}main:has(#f-${k}:checked) #monitors:not(:has(.item${keep})) .none-match{display:block}`;
    })
    .join("\n");
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
