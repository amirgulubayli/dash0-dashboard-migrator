import { useCallback, useEffect, useRef, useState } from "react";
import { buildReportView, type ReportError, type ReportView } from "./lib/model";
import { emptyEventState, isRunEvent, planReplay, reduceEvent, type EventState, type ReplayPlan, type RunEvent } from "./lib/reducer";

export type Conn = "connecting" | "connected" | "disconnected";

export interface Config {
  aiEnabled: boolean;
  aiRequestedButNoKey: boolean;
}

export function useReport(): { view: ReportView | ReportError | null; reload: () => void } {
  const [view, setView] = useState<ReportView | ReportError | null>(null);
  const reload = useCallback(() => {
    fetch("/api/report")
      .then(async (r) => (r.ok ? buildReportView(await r.json()) : ({ ok: false, error: "No report.json found yet" } as ReportError)))
      .catch(() => ({ ok: false, error: "Could not read report.json" }) as ReportError)
      .then(setView);
  }, []);
  useEffect(reload, [reload]);
  return { view, reload };
}

export function useConfig(): Config {
  const [cfg, setCfg] = useState<Config>({ aiEnabled: false, aiRequestedButNoKey: false });
  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c: Config) => setCfg({ aiEnabled: c.aiEnabled === true, aiRequestedButNoKey: c.aiRequestedButNoKey === true })).catch(() => undefined);
  }, []);
  return cfg;
}

/** Live stream and replay share one reducer (reduceEvent). */
export function useRun(onRunDone: () => void) {
  const [live, setLive] = useState<EventState>(emptyEventState());
  const [conn, setConn] = useState<Conn>("connecting");
  const [replay, setReplay] = useState<EventState | null>(null);
  const [plan, setPlan] = useState<ReplayPlan | null>(null);
  const [replaying, setReplaying] = useState(false);
  const timers = useRef<number[]>([]);
  const doneRef = useRef(onRunDone);
  doneRef.current = onRunDone;

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConn("connected");
    es.onerror = () => setConn("disconnected");
    es.onmessage = (m) => {
      try {
        const v: unknown = JSON.parse(m.data as string);
        setLive((s) => {
          const n = reduceEvent(s, v);
          if (isRunEvent(v) && v.type === "run.done" && s.runDone === null && n.runDone !== null) setTimeout(() => doneRef.current(), 0);
          return n;
        });
      } catch {
        /* a malformed message is ignored, never shown as an event */
      }
    };
    es.addEventListener("reset", () => {
      setLive(emptyEventState());
      doneRef.current();
    });
    return () => es.close();
  }, []);

  const stop = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setReplaying(false);
    setReplay(null);
    setPlan(null);
  }, []);

  const startReplay = useCallback(
    async (speed: number) => {
      stop();
      const r = await fetch("/api/replay-data");
      const body = (await r.json()) as { events: unknown[] };
      const events = body.events.filter(isRunEvent).sort((a: RunEvent, b: RunEvent) => a.seq - b.seq);
      const p = planReplay(events, speed);
      setPlan(p);
      setReplay(emptyEventState());
      setReplaying(true);
      let at = 0;
      events.forEach((e, i) => {
        at += p.delaysMs[i] ?? 0;
        timers.current.push(
          window.setTimeout(() => {
            setReplay((s) => (s ? reduceEvent(s, e) : s));
            if (i === events.length - 1) setReplaying(false);
          }, at),
        );
      });
    },
    [stop],
  );

  useEffect(() => stop, [stop]);
  return { live, conn, replay, plan, replaying, startReplay, stopReplay: stop };
}
