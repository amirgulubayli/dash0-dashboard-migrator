import { useState } from "react";
import type { Brief } from "./lib/brief";
import { labelText, NO_PROMQL, NOT_RECORDED, type EvidenceField, type ItemView } from "./lib/model";
import type { Stage } from "./lib/reducer";

export const labelClass = (label: string | null) => `lab-${(label ?? "none").replace(/[^a-z-]/g, "")}`;

export function LabelPill({ label, small }: { label: string | null; small?: boolean }) {
  return <span className={`pill ${labelClass(label)} ${small ? "small" : ""}`}>{labelText(label)}</span>;
}

export function Tile({ item, selected, waiting, onSelect }: { item: ItemView; selected: boolean; waiting: boolean; onSelect: () => void }) {
  if (waiting) {
    return (
      <div className="tile waiting" aria-label="waiting for event">
        <span className="tile-label">WAITING</span>
        <span className="tile-title">not in the log yet</span>
      </div>
    );
  }
  return (
    <button type="button" className={`tile ${labelClass(item.label)} ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected} title={`${item.title} (${item.id})`}>
      <span className="tile-label">
        {labelText(item.label)}
        {item.isTextNote ? <em className="note-mark">text note</em> : null}
      </span>
      <span className="tile-title">{item.title}</span>
    </button>
  );
}

export function StageBar({ stages, caption }: { stages: Stage[]; caption: string }) {
  return (
    <div className="stages" role="list" aria-label="Pipeline stages from the event log">
      {stages.map((s) => (
        <div key={s.key} role="listitem" className={`stage ${s.status}`}>
          <span className="mark" aria-hidden="true">{s.status === "done" ? "\u2713" : s.status === "active" ? "\u2026" : "\u25CB"}</span>
          <span className="stage-name">{s.label}</span>
          <span className="sr-only">{s.status === "done" ? "seen in log" : s.status === "active" ? "in progress" : "not seen"}</span>
          {s.detail ? <span className="stage-detail">{s.detail}</span> : null}
        </div>
      ))}
      <span className="stage-caption">{caption}</span>
    </div>
  );
}

function Evidence({ title, field }: { title: string; field: EvidenceField }) {
  return (
    <div className={`ev ${field.recorded ? "recorded" : "missing"}`}>
      <dt>{title}</dt>
      <dd>{field.text}</dd>
    </div>
  );
}

function Code({ lines, empty }: { lines: string[]; empty: string }) {
  if (lines.length === 0) return <p className="none">{empty}</p>;
  return (
    <>
      {lines.map((l, i) => (
        <pre key={i} className="code">
          {l}
        </pre>
      ))}
    </>
  );
}

export function EvidencePanel({ item, expanded, onToggle }: { item: ItemView | null; expanded: boolean; onToggle: () => void }) {
  if (!item) return <aside className="panel evidence"><p className="none panel-pad">Select an item that has appeared in the log.</p></aside>;
  const explainBlock =
    item.label === "exact-under" ? { head: "Exact if (full condition)", body: item.condition ?? item.plain ?? NOT_RECORDED }
    : item.label === "bounded" ? { head: "Bounded difference from Datadog", body: item.plain ?? NOT_RECORDED }
    : item.label === "manual" || item.label === "unsupported" ? { head: "Why it was not translated", body: item.plain ?? NOT_RECORDED }
    : { head: "Claim", body: item.plain ?? item.condition ?? NOT_RECORDED };
  return (
    <aside className={`panel evidence ${expanded ? "expanded" : ""}`} aria-label="Evidence for the selected item">
      <header className="ev-head">
        <div>
          <h2>{item.title}</h2>
          <code className="id">{item.id}</code>
        </div>
        <div className="ev-actions">
          <LabelPill label={item.label} />
          <button type="button" className="ghost" onClick={onToggle} aria-expanded={expanded}>{expanded ? "Collapse" : "Expand"}</button>
        </div>
      </header>
      <div className="ev-body">
        {item.isTextNote ? <p className="banner-note">TEXT NOTE: copied text from the dashboard, not a translated query.</p> : null}
        {item.malformed.length > 0 ? <p className="banner-warn">Unexpected values in the report for: {[...new Set(item.malformed)].join(", ")}. They are ignored.</p> : null}
        <h3>Original Datadog query</h3>
        <Code lines={item.sourceQueries} empty={item.isTextNote ? "A text note has no query." : NOT_RECORDED} />
        <h3>Generated PromQL</h3>
        <Code lines={item.promql} empty={NO_PROMQL} />
        <h3>{explainBlock.head}</h3>
        <p className="prose">{explainBlock.body}</p>
        <h3>Reason codes</h3>
        {item.reasons.length === 0 ? <p className="none">{NOT_RECORDED}</p> : (
          <ul className="reasons">
            {item.reasons.map((r) => (
              <li key={r.code}>
                <code>{r.code}</code>
                <span>{r.explanation ?? "No explanation recorded for this code."}</span>
              </li>
            ))}
          </ul>
        )}
        <h3>Evidence the report records</h3>
        <dl className="evlist">
          <Evidence title="Import" field={item.importStatus} />
          {item.checkRuleState ? <Evidence title="Check rule state" field={item.checkRuleState} /> : null}
          <Evidence title="Live data in Dash0" field={item.liveData} />
          <Evidence title="Parity with Datadog" field={item.parity} />
          <div className={`ev ${item.dash0Link ? "recorded" : "missing"}`}>
            <dt>Dash0 link</dt>
            <dd>{item.dash0Link ? <a href={item.dash0Link} target="_blank" rel="noreferrer noopener">{item.dash0Link}</a> : NOT_RECORDED}</dd>
          </div>
        </dl>
        {item.manualActions.length > 0 ? (
          <>
            <h3>Actions the report lists</h3>
            <ul className="reasons">{item.manualActions.map((a, i) => <li key={i}><span>{a}</span></li>)}</ul>
          </>
        ) : null}
        <details>
          <summary>Rule chain and assumptions</summary>
          <p className="prose mono">{item.technical ?? NOT_RECORDED}</p>
          <p className="prose">{item.assumptions.length > 0 ? item.assumptions.join(", ") : "No assumptions recorded."}</p>
        </details>
      </div>
    </aside>
  );
}

export interface AiState {
  status: "idle" | "loading" | "done" | "error";
  notes: Record<string, string>;
  rejected: number;
}

function Entries({ entries, ai, onPick }: { entries: { id: string; title: string; label: string | null; codes?: string[]; extra?: string | null }[]; ai: AiState; onPick: (id: string) => void }) {
  return (
    <ul className="brief-list">
      {entries.map((e) => (
        <li key={e.id}>
          <button type="button" className="linklike" onClick={() => onPick(e.id)}>
            <LabelPill label={e.label} small /> {e.title}
          </button>
          {e.codes && e.codes.length > 0 ? <span className="codes">{e.codes.join(", ")}</span> : null}
          {e.extra ? <span className="codes">{e.extra}</span> : null}
          {ai.notes[e.id] ? <p className="ai-note"><b>AI explanation:</b> {ai.notes[e.id]}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function BriefDialog({ brief, aiEnabled, aiRequestedNoKey, ai, onAsk, onPick, onClose }: { brief: Brief; aiEnabled: boolean; aiRequestedNoKey: boolean; ai: AiState; onAsk: () => void; onPick: (id: string) => void; onClose: () => void }) {
  const [openCond, setOpenCond] = useState<number | null>(null);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="What needs my attention">
      <div className="dialog">
        <header className="dialog-head">
          <h2>What needs my attention?</h2>
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </header>
        <p className="prose">A checklist built from the report only. {brief.total === 0 ? "Nothing is listed." : `${brief.total} entries.`}</p>
        <div className="dialog-body">
          <h3>Not translated: manual or unsupported ({brief.manualOrUnsupported.length})</h3>
          <Entries entries={brief.manualOrUnsupported.map((e) => ({ id: e.id, title: e.title, label: e.label, codes: e.reasonCodes }))} ai={ai} onPick={onPick} />
          <h3>Bounded: check the difference ({brief.bounded.length})</h3>
          <Entries entries={brief.bounded.map((e) => ({ id: e.id, title: e.title, label: e.label, codes: e.reasonCodes }))} ai={ai} onPick={onPick} />
          <h3>Exact if: conditions to confirm ({brief.conditions.length} distinct)</h3>
          <ul className="brief-list">
            {brief.conditions.map((c, i) => (
              <li key={i}>
                <p className="prose">{c.condition}</p>
                <button type="button" className="linklike" onClick={() => setOpenCond(openCond === i ? null : i)}>{c.ids.length} widget{c.ids.length === 1 ? "" : "s"} {openCond === i ? "(hide)" : "(show)"}</button>
                {openCond === i ? <p className="codes">{c.ids.join("  ")}</p> : null}
              </li>
            ))}
          </ul>
          {brief.textNotesExcluded > 0 ? <p className="none">{brief.textNotesExcluded} text note{brief.textNotesExcluded === 1 ? "" : "s"} left out of this list (copied text, no query).</p> : null}
          <h3>Monitors, listed separately ({brief.monitorIssues.length})</h3>
          <Entries entries={brief.monitorIssues.map((m) => ({ id: m.id, title: m.title, label: m.label, extra: [m.checkRuleState, ...m.notes].filter(Boolean).join(" | ") }))} ai={ai} onPick={onPick} />
        </div>
        <footer className="dialog-foot">
          {aiEnabled ? (
            <>
              <button type="button" onClick={onAsk} disabled={ai.status === "loading"}>{ai.status === "loading" ? "Asking..." : "Add AI explanation"}</button>
              <span className="none">{ai.status === "done" ? `AI explanation added to ${Object.keys(ai.notes).length} entries; ${ai.rejected} suggestions dropped by the checks.` : ai.status === "error" ? "AI explanation unavailable. The checklist above is unchanged." : "Sends only id, label, reason and condition per item."}</span>
            </>
          ) : (
            <span className="none">{aiRequestedNoKey ? "AI explanation is switched off. It was requested but no key is set in the shell." : "AI explanation is switched off."}</span>
          )}
        </footer>
      </div>
    </div>
  );
}
