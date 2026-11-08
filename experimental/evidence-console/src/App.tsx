import { useEffect, useMemo, useState } from "react";
import { AiState, BriefDialog, EvidencePanel, StageBar, Tile } from "./components";
import { buildBrief } from "./lib/brief";
import { countLabels, findItem, labelText, type ItemView, type ReportView } from "./lib/model";
import { stagesFrom } from "./lib/reducer";
import { viewFromEvents } from "./lib/viewFromEvents";
import { useConfig, useReport, useRun } from "./useData";

const SPEEDS = [0.5, 1, 2];

function CountChips({ counts }: { counts: { label: string; count: number; textNotes?: number }[] }) {
  return (
    <div className="chips">
      {counts.map((c) => (
        <div key={c.label} className={`chip lab-${c.label.replace(/[^a-z-]/g, "")}`}>
          <span className="chip-n">{c.count}</span>
          <span className="chip-l">{labelText(c.label === "(no label)" ? null : c.label)}</span>
          {c.textNotes ? <span className="chip-sub">incl. {c.textNotes} text note{c.textNotes === 1 ? "" : "s"}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { view: reportView, reload } = useReport();
  const cfg = useConfig();
  const run = useRun(reload);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [ai, setAi] = useState<AiState>({ status: "idle", notes: {}, rejected: 0 });

  const mode = run.replay ? "replay" : "live";
  const active = run.replay ?? run.live;
  const view: ReportView | null = useMemo(() => {
    if (reportView && reportView.ok) return reportView;
    const v = viewFromEvents(active);
    return v.ok && v.widgets.length + v.monitors.length > 0 ? v : null;
  }, [reportView, active]);

  useEffect(() => {
    if (view && (selected === null || !findItem(view, selected))) setSelected(view.defaultSelectionId);
  }, [view, selected]);

  const brief = useMemo(() => (view ? buildBrief(view) : null), [view]);
  const stages = stagesFrom(active);
  const gated = active.events.length > 0 && (mode === "replay" || active.runDone === null);
  const isWaiting = (i: ItemView) => gated && !active.itemsSeen.has(i.id);
  // While a run is arriving (or replaying) the counts cover only items whose events are in the log.
  const shownWidgets = view ? view.widgets.filter((w) => !isWaiting(w)) : [];
  const shownCounts = view ? (gated ? countLabels(shownWidgets) : view.labelCounts) : [];
  const shownMonitors = view ? view.monitors.filter((m) => !isWaiting(m)).length : 0;

  const badge =
    mode === "replay" ? { cls: "replay", text: "REPLAY", sub: run.replaying ? "playing" : "finished" }
    : { cls: "live", text: "LIVE", sub: run.conn === "connected" ? (run.live.runDone ? "connected, run complete" : run.live.events.length === 0 ? "connected, no events yet" : "connected, receiving") : run.conn === "connecting" ? "connecting" : "disconnected, retrying" };
  const stageCaption = mode === "replay" ? "" : run.live.events.length === 0 ? "No events in the log yet. Stages stay empty until they appear." : "Stages come from events.jsonl only.";

  const ask = async () => {
    setAi((a) => ({ ...a, status: "loading" }));
    try {
      const r = await fetch("/api/brief-ai", { method: "POST" });
      const body = (await r.json()) as { enabled?: boolean; notes?: { id: string; text: string }[]; rejected?: number };
      if (!r.ok || body.enabled === false || !body.notes) throw new Error("no");
      setAi({ status: "done", notes: Object.fromEntries(body.notes.map((n) => [n.id, n.text])), rejected: body.rejected ?? 0 });
    } catch {
      setAi({ status: "error", notes: {}, rejected: 0 });
    }
  };

  const dashboardName = view ? (view.dashboardNames.length > 0 ? view.dashboardNames.join(", ") : "Dashboard name not recorded") : "";
  const foundItem = view ? findItem(view, selected) : null;
  const selectedItem = foundItem && !isWaiting(foundItem) ? foundItem : null;

  let lastGroup: string | null | undefined;
  return (
    <div className="app">
      <header className="top">
        <div className="title">
          <h1>dd2dash0 / Migration Review</h1>
          <p className="sub">{view ? dashboardName : reportView && !reportView.ok ? reportView.error : "Loading"}</p>
        </div>
        <div className="top-right">
          <span className={`badge ${badge.cls}`}><b>{badge.text}</b><small>{badge.sub}</small></span>
          {view?.runMode === "dry-run" ? <span className="tag">Dry run: nothing was imported</span> : null}
          <button type="button" onClick={() => setBriefOpen(true)} disabled={!brief}>What needs my attention?</button>
        </div>
      </header>

      <section className="strip">
        <StageBar stages={stages} caption={stageCaption} />
        <div className="replay-controls">
          {mode === "replay" ? (
            <>
              <b className="replay-banner">REPLAY OF A REAL RUN</b>
              {run.plan?.hasRecordedTimestamps && run.plan.slowed ? <span className="tag">Playback slowed for visibility</span> : null}
              {run.plan && !run.plan.hasRecordedTimestamps ? <span className="tag">No timestamps recorded: playback paced for visibility</span> : null}
              <button type="button" className="ghost" onClick={run.stopReplay}>Back to live</button>
            </>
          ) : (
            <>
              <label className="speed">Speed
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select>
              </label>
              <button type="button" className="ghost" onClick={() => void run.startReplay(speed)}>Replay this run</button>
            </>
          )}
        </div>
      </section>

      {!view ? (
        <main className="empty">
          <p>{reportView && !reportView.ok ? reportView.error : "Waiting for report.json or events."}</p>
          <p className="none">Start the server with --report and --events pointing at a run folder.</p>
        </main>
      ) : (
        <>
          <section className="counts">
            <div className="total"><span className="total-n">{gated ? shownWidgets.length : view.widgetCount}</span><span className="total-l">{gated ? `widgets assessed so far (${view.widgetCount} in the report)` : "widgets assessed"}</span></div>
            <CountChips counts={shownCounts} />
            <div className="monitor-count">
              <span className="total-n m">{gated ? shownMonitors : view.monitors.length}</span>
              <span className="total-l">monitor{(gated ? shownMonitors : view.monitors.length) === 1 ? "" : "s"}, not in the widget totals</span>
            </div>
          </section>
          <main className={`main ${expanded ? "wide-evidence" : ""}`}>
            <div className="left">
              <div className="scroll">
              <div className="grid" aria-label="Widgets in source order">
                {view.widgets.map((w) => {
                  const heading = w.group !== lastGroup ? w.group : undefined;
                  lastGroup = w.group;
                  return (
                    <div className="cell" key={w.id}>
                      {heading ? <div className="group-head">{heading}</div> : null}
                      <Tile item={w} selected={selected === w.id} waiting={isWaiting(w)} onSelect={() => setSelected(w.id)} />
                    </div>
                  );
                })}
              </div>
              </div>
              <div className="monitor-row" aria-label="Monitors">
                <h3>Monitors <span className="none">(check rules, listed apart from widgets)</span></h3>
                <div className="row">
                  {view.monitors.length === 0 ? <p className="none">No monitors in this report.</p> : view.monitors.map((m) => <Tile key={m.id} item={m} selected={selected === m.id} waiting={isWaiting(m)} onSelect={() => setSelected(m.id)} />)}
                </div>
              </div>
            </div>
            <EvidencePanel item={selectedItem} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
          </main>
        </>
      )}
      {briefOpen && brief ? (
        <BriefDialog brief={brief} aiEnabled={cfg.aiEnabled} aiRequestedNoKey={cfg.aiRequestedButNoKey} ai={ai} onAsk={() => void ask()} onPick={(id) => { setSelected(id); setBriefOpen(false); }} onClose={() => setBriefOpen(false)} />
      ) : null}
    </div>
  );
}
