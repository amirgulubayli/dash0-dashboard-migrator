import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  HelpCircle,
  XOctagon,
  type LucideIcon,
} from "lucide-react";
import { fetchWatch } from "@/lib/cli-server";
import { useReport } from "@/lib/report-store";
import {
  currentState,
  formatDuration,
  hhmmss,
  laneSegments,
  valueRange,
  windowOf,
  type AlertState,
  type ParityResult,
  type WatchData,
} from "@/lib/watch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/incident")({
  head: () => ({
    meta: [
      { title: "Incident · Migration Review Console" },
      {
        name: "description",
        content:
          "The Datadog monitor and the Dash0 check rule migrated from it, watched side by side during a real incident.",
      },
    ],
  }),
  component: IncidentPage,
});

const POLL_MS = 2000;

/** Alert states in the console's own status tokens, always with an icon and a word. */
const STATE_UI: Record<
  AlertState,
  { label: string; icon: LucideIcon; fill: string; ink: string; chip: string }
> = {
  ok: {
    label: "ok",
    icon: CheckCircle2,
    fill: "var(--status-exact-edge)",
    ink: "#ffffff",
    chip: "text-status-exact",
  },
  degraded: {
    label: "degraded",
    icon: AlertTriangle,
    fill: "var(--status-approx-edge)",
    ink: "#1c1917",
    chip: "text-status-approx",
  },
  failed: {
    label: "failed",
    icon: XOctagon,
    fill: "var(--status-failed-edge)",
    ink: "#ffffff",
    chip: "text-status-failed",
  },
  nodata: {
    label: "no data",
    icon: CircleSlash,
    fill: "var(--status-nodata-edge)",
    ink: "#ffffff",
    chip: "text-status-nodata",
  },
  unknown: {
    label: "unknown",
    icon: HelpCircle,
    fill: "var(--status-nodata-edge)",
    ink: "#ffffff",
    chip: "text-status-nodata",
  },
};

function StateChip({ state, suffix }: { state: AlertState | null; suffix?: string | undefined }) {
  if (!state) return <span className="console-chip text-muted-foreground">not polled yet</span>;
  const s = STATE_UI[state];
  const Icon = s.icon;
  return (
    <span className={cn("console-chip", s.chip)}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
      {suffix ? <span className="text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

function IncidentPage() {
  const { report } = useReport();
  const [data, setData] = useState<WatchData | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await fetchWatch();
      if (!alive) return;
      if (r.state === "live") {
        setData(r.data);
        setMissing(null);
        setLastOk(Date.now());
        setStale(false);
      } else if (r.state === "none") {
        setData(null);
        setMissing(r.message);
      } else setStale(true);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const titleOf = useMemo(
    () => new Map(report.items.map((i) => [i.id, i.title ?? i.id])),
    [report],
  );
  const thresholdsOf = useMemo(
    () => new Map(report.items.map((i) => [i.id, i.thresholds])),
    [report],
  );
  const alertIds = useMemo(() => {
    if (!data) return [];
    const ids = [...data.parity.map((p) => p.alertId), ...data.events.map((e) => e.alertId)];
    return [...new Set(ids)];
  }, [data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 pt-4 pb-3">
        <div className="section-label mb-2">Live incident · dd2dash0 watch</div>
        <h2 className="text-[32px] font-semibold leading-tight">Same incident, both alerts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {data
            ? `Last poll ${data.endedAt ? hhmmss(data.endedAt) + " UTC" : "unknown"} · refreshing every ${POLL_MS / 1000} s${stale ? " · waiting for the next update" : ""}`
            : missing
              ? "No watch is running for this plan yet."
              : "Looking for a running watch…"}
          {lastOk === null && data === null && stale
            ? " (this page needs dd2dash0 review to serve it)"
            : ""}
        </p>
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-5">
        {!data ? (
          <section className="max-w-2xl rounded-lg border bg-card p-5">
            <h3 className="mb-2 font-semibold">Start a watch</h3>
            <p className="text-sm text-muted-foreground">
              {missing ??
                "This view shows what dd2dash0 watch records, while dd2dash0 review serves this console."}
            </p>
            <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
              dd2dash0 watch &lt;plan dir&gt; --until-recovered
            </pre>
            <p className="mt-3 text-sm text-muted-foreground">
              Run it in a second terminal. This page picks it up within {POLL_MS / 1000} seconds.
            </p>
          </section>
        ) : (
          alertIds.map((id) => (
            <AlertCard
              key={id}
              data={data}
              alertId={id}
              title={titleOf.get(id) ?? id}
              thresholds={thresholdsOf.get(id)}
              parity={data.parity.find((p) => p.alertId === id)}
            />
          ))
        )}
        {data && data.events.some((e) => e.method === "computed") ? (
          <p className="max-w-3xl rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            The Dash0 lane is <b>computed</b>: Dash0 has no API for a rule&rsquo;s live state, so
            dd2dash0 runs the migrated rule&rsquo;s own query and compares it with the rule&rsquo;s
            own thresholds. The Datadog lane is the monitor&rsquo;s state from the Datadog API.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Verdict({ p }: { p: ParityResult | undefined }) {
  if (!p || p.verdict === "no-incident")
    return (
      <div>
        <span className="console-chip text-muted-foreground">
          <CircleSlash className="size-3.5" aria-hidden /> watching
        </span>
        <div className="mt-2 text-sm text-muted-foreground">Nothing has fired yet.</div>
      </div>
    );
  const pass = p.verdict === "pass";
  const Icon = pass ? CheckCircle2 : XOctagon;
  return (
    <div>
      <span className={cn("console-chip", pass ? "text-status-exact" : "text-status-failed")}>
        <Icon className="size-3.5" aria-hidden /> {pass ? "PASS" : "FAIL"}
      </span>
      {p.fireGapMs !== null ? (
        <>
          <div className="mt-2 text-[40px] font-semibold leading-none" data-testid="gap">
            {formatDuration(p.fireGapMs)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            between the two firings · bound {formatDuration(p.boundMs)}
            {p.recoverGapMs !== null ? ` · recovered ${formatDuration(p.recoverGapMs)} apart` : ""}
          </div>
        </>
      ) : null}
      {p.reasons.length ? (
        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const L = 96;
const R = 12;

/**
 * The charts draw in real pixels: the viewBox follows the container's measured width, so 12 px text stays 12 px on a
 * laptop and on a projector instead of scaling with the SVG.
 */
function useWidth(ref: React.RefObject<HTMLDivElement | null>, fallback = 760): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const next = Math.max(360, Math.round(e?.contentRect.width ?? fallback));
      setW((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}

function AlertCard({
  data,
  alertId,
  title,
  thresholds,
  parity,
}: {
  data: WatchData;
  alertId: string;
  title: string;
  thresholds: { degraded?: number | undefined; failed?: number | undefined } | undefined;
  parity: ParityResult | undefined;
}) {
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const { t0, t1 } = windowOf(data, alertId);
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const dd = currentState(data.events, alertId, "datadog");
  const d0 = currentState(data.events, alertId, "dash0");
  const samples = data.samples.filter((s) => s.alertId === alertId);
  const lastValue = [...samples].reverse().find((s) => s.value !== null)?.value ?? null;

  return (
    <section className="rounded-lg border bg-card p-5" aria-label={title}>
      <h3 className="mb-4 text-lg font-semibold">{title}</h3>
      <div className="grid gap-5 md:grid-cols-[1fr_1fr_1.4fr]">
        <div>
          <div className="section-label mb-2">Datadog now</div>
          <StateChip state={dd} />
          <div className="mt-1 text-xs text-muted-foreground">
            monitor state from the Datadog API
          </div>
        </div>
        <div>
          <div className="section-label mb-2">Dash0 now</div>
          <StateChip
            state={d0}
            suffix={lastValue !== null ? ` · ${+lastValue.toFixed(2)}` : undefined}
          />
          <div className="mt-1 text-xs text-muted-foreground">computed from the migrated rule</div>
        </div>
        <Verdict p={parity} />
      </div>
      <div ref={box}>
        <Lanes data={data} alertId={alertId} t0={t0} t1={t1} X={X} W={W} parity={parity} />
        <ValueChart samples={samples} thresholds={thresholds} t0={t0} t1={t1} X={X} W={W} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Table view ({data.events.filter((e) => e.alertId === alertId).length} state changes)
        </summary>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">time (UTC)</th>
              <th className="py-1 pr-3 font-medium">side</th>
              <th className="py-1 pr-3 font-medium">method</th>
              <th className="py-1 pr-3 font-medium">change</th>
              <th className="tabular py-1 text-right font-medium">value</th>
            </tr>
          </thead>
          <tbody>
            {data.events
              .filter((e) => e.alertId === alertId)
              .map((e, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1 pr-3 font-mono">{hhmmss(e.at)}</td>
                  <td className="py-1 pr-3">{e.side === "datadog" ? "Datadog" : "Dash0"}</td>
                  <td className="py-1 pr-3">{e.method}</td>
                  <td className="py-1 pr-3">
                    {e.from ? STATE_UI[e.from].label : "–"} → {STATE_UI[e.to].label}
                  </td>
                  <td className="tabular py-1 text-right">
                    {e.value !== undefined ? +e.value.toFixed(2) : ""}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function Lanes({
  data,
  alertId,
  t0,
  t1,
  X,
  W,
  parity,
}: {
  data: WatchData;
  alertId: string;
  t0: number;
  t1: number;
  X: (t: number) => number;
  W: number;
  parity: ParityResult | undefined;
}) {
  const laneY = { datadog: 34, dash0: 74 } as const;
  const LH = 28;
  const fired = { datadog: parity?.datadog.firedAt ?? null, dash0: parity?.dash0.firedAt ?? null };
  return (
    <svg
      className="mt-5 block h-auto w-full"
      viewBox={`0 0 ${W} 130`}
      role="img"
      aria-label={`Alert states over time, Datadog and Dash0`}
    >
      {(["datadog", "dash0"] as const).map((side) => {
        const segs = laneSegments(data.events, alertId, side, t1);
        const y = laneY[side];
        return (
          <g key={side}>
            <text x={0} y={y + 18} className="fill-foreground text-[12px] font-semibold">
              {side === "datadog" ? "Datadog" : "Dash0"}
            </text>
            {side === "dash0" ? (
              <text x={0} y={y + 30} className="fill-muted-foreground text-[11px]">
                computed
              </text>
            ) : null}
            {segs.map((s, i) => {
              const x0 = X(s.from);
              const w = Math.max(1, X(s.to) - x0 - (i + 1 < segs.length ? 2 : 0));
              const ui = STATE_UI[s.state];
              return (
                <g key={i}>
                  <rect x={x0} y={y} width={w} height={LH} rx={4} style={{ fill: ui.fill }}>
                    <title>
                      {`${side === "datadog" ? "Datadog" : "Dash0 (computed)"}: ${ui.label} from ${hhmmss(s.from)} UTC${s.value !== undefined ? `, value ${+s.value.toFixed(2)}` : ""}`}
                    </title>
                  </rect>
                  {w > 72 ? (
                    <text
                      x={x0 + 8}
                      y={y + 18.5}
                      className="text-[12px] font-semibold"
                      style={{ fill: ui.ink }}
                    >
                      {ui.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
      {(["datadog", "dash0"] as const).map((side) =>
        fired[side] ? (
          <line
            key={side}
            x1={X(Date.parse(fired[side]!))}
            x2={X(Date.parse(fired[side]!))}
            y1={laneY[side] - 4}
            y2={laneY[side] + LH + 4}
            className="stroke-foreground"
            strokeWidth={2}
          />
        ) : null,
      )}
      {fired.datadog && fired.dash0 && parity?.fireGapMs !== null && parity ? (
        <g>
          <path
            d={`M${Math.min(X(Date.parse(fired.datadog)), X(Date.parse(fired.dash0)))},28 V22 H${Math.max(X(Date.parse(fired.datadog)), X(Date.parse(fired.dash0)))} V28`}
            className="fill-none stroke-muted-foreground"
            strokeWidth={1.5}
          />
          <text
            x={(X(Date.parse(fired.datadog)) + X(Date.parse(fired.dash0))) / 2}
            y={16}
            textAnchor="middle"
            className="fill-foreground text-[12px] font-semibold"
          >
            {formatDuration(parity.fireGapMs!)} apart
          </text>
        </g>
      ) : null}
      {[t0, (t0 + t1) / 2, t1].map((t, i) => (
        <text
          key={i}
          x={X(t)}
          y={124}
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          className="fill-muted-foreground text-[11px]"
        >
          {hhmmss(Math.round(t))} UTC
        </text>
      ))}
    </svg>
  );
}

function ValueChart({
  samples,
  thresholds,
  t0,
  t1,
  X,
  W,
}: {
  samples: { at: string; value: number | null }[];
  thresholds: { degraded?: number | undefined; failed?: number | undefined } | undefined;
  t0: number;
  t1: number;
  X: (t: number) => number;
  W: number;
}) {
  const H = 168;
  const plotW = W - L - R;
  const top = 10;
  const bottom = H - 40;
  const pts = samples
    .filter((s): s is { at: string; value: number } => s.value !== null)
    .map((s) => ({ t: Date.parse(s.at), v: s.value }));
  const th = {
    ...(thresholds?.degraded !== undefined ? { degraded: thresholds.degraded } : {}),
    ...(thresholds?.failed !== undefined ? { failed: thresholds.failed } : {}),
  };
  const { lo, hi } = valueRange(
    pts.map((p) => p.v),
    th,
  );
  const Y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const [hover, setHover] = useState<{ t: number; v: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (!pts.length)
    return <p className="mt-3 text-xs text-muted-foreground">No Dash0 values recorded yet.</p>;
  const path = pts
    .map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`)
    .join(" ");
  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    let best = pts[0]!;
    for (const p of pts) if (Math.abs(X(p.t) - x) < Math.abs(X(best.t) - x)) best = p;
    setHover(best);
  };
  return (
    <div className="mt-4">
      <div className="section-label mb-1">Dash0 rule value (computed)</div>
      <svg
        ref={svgRef}
        className="block h-auto w-full"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="The migrated rule's value over time, with its thresholds"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={L} x2={W - R} y1={bottom} y2={bottom} className="stroke-border" strokeWidth={1} />
        <text
          x={L - 8}
          y={Y(hi) + 4}
          textAnchor="end"
          className="fill-muted-foreground text-[11px] tabular"
        >
          {+hi.toFixed(1)}
        </text>
        <text
          x={L - 8}
          y={bottom + 4}
          textAnchor="end"
          className="fill-muted-foreground text-[11px] tabular"
        >
          {+lo.toFixed(1)}
        </text>
        {(
          [
            ["degraded", th.degraded, "var(--status-approx-edge)"],
            ["failed", th.failed, "var(--status-failed-edge)"],
          ] as const
        ).map(([name, v, color]) =>
          v !== undefined ? (
            <g key={name}>
              <line
                x1={L}
                x2={W - R}
                y1={Y(v)}
                y2={Y(v)}
                style={{ stroke: color }}
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
              <text
                x={L + 6}
                y={Y(v) - 4}
                textAnchor="start"
                className="fill-foreground text-[11px]"
              >
                {name} {v}
              </text>
            </g>
          ) : null,
        )}
        <path
          d={path}
          className="fill-none stroke-foreground"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {hover ? (
          <g pointerEvents="none">
            <line
              x1={X(hover.t)}
              x2={X(hover.t)}
              y1={top}
              y2={bottom}
              className="stroke-muted-foreground"
              strokeWidth={1}
            />
            <circle
              cx={X(hover.t)}
              cy={Y(hover.v)}
              r={4}
              className="fill-foreground stroke-card"
              strokeWidth={2}
            />
            <text
              x={Math.min(X(hover.t) + 8, W - R - 120)}
              y={top + 12}
              className="fill-foreground text-[12px] font-semibold tabular"
            >
              {hhmmss(hover.t)} UTC · {+hover.v.toFixed(2)}
            </text>
          </g>
        ) : null}
        {[t0, t1].map((t, i) => (
          <text
            key={i}
            x={X(t)}
            y={H - 22}
            textAnchor={i === 0 ? "start" : "end"}
            className="fill-muted-foreground text-[11px]"
          >
            {hhmmss(t)} UTC
          </text>
        ))}
        {/* Wide transparent hit area so the crosshair follows the pointer anywhere in the plot. */}
        <rect x={L} y={top} width={plotW} height={bottom - top} fill="transparent" />
      </svg>
    </div>
  );
}
