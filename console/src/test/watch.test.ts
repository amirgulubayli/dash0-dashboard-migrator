import { describe, expect, it } from "vitest";
import { fetchWatch } from "@/lib/cli-server";
import {
  currentState,
  formatDuration,
  laneSegments,
  parseWatch,
  valueRange,
  windowOf,
  type WatchEvent,
} from "@/lib/watch";

const T0 = Date.parse("2026-11-08T14:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const events: WatchEvent[] = [
  { side: "datadog", alertId: "a", from: null, to: "ok", at: at(0), method: "api" },
  { side: "dash0", alertId: "a", from: null, to: "ok", at: at(0), method: "computed", value: 61 },
  { side: "datadog", alertId: "a", from: "ok", to: "failed", at: at(120), method: "api" },
  {
    side: "dash0",
    alertId: "a",
    from: "ok",
    to: "failed",
    at: at(140),
    method: "computed",
    value: 93,
  },
];
const body = {
  timeline: {
    schema: "dd2dash0.watch/v1",
    startedAt: at(0),
    endedAt: at(300),
    events: [
      ...events,
      { side: "nope", alertId: "a", to: "ok", at: at(1) },
      { side: "dash0", alertId: "a", to: "on fire", at: at(2) },
    ],
    samples: [
      { alertId: "a", at: at(0), value: 61 },
      { alertId: "a", at: at(5), value: null },
      { alertId: "a", at: "x", value: "bad" },
    ],
  },
  parity: { results: [{ alertId: "a", verdict: "pass", fireGapMs: 20000, boundMs: 125000 }] },
};
const res = (status: number, b: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }),
  );

describe("watch data (Incident view)", () => {
  it("parses the CLI's watch files and drops malformed events and samples", () => {
    const d = parseWatch(body)!;
    expect(d.events).toHaveLength(4);
    expect(d.samples).toEqual([
      { alertId: "a", at: at(0), value: 61 },
      { alertId: "a", at: at(5), value: null },
    ]);
    expect(d.parity[0]!.verdict).toBe("pass");
    expect(d.startedAt).toBe(at(0));
    expect(parseWatch({ nope: 1 })).toBeNull();
    expect(parseWatch({ timeline: { events: [] }, parity: null })!.parity).toEqual([]);
  });

  it("builds lanes that last until the next state change, the last one until the watch's last poll", () => {
    const d = parseWatch(body)!;
    const { t0, t1 } = windowOf(d, "a");
    expect([t0, t1]).toEqual([T0, T0 + 300_000]);
    expect(laneSegments(d.events, "a", "dash0", t1)).toEqual([
      { state: "ok", from: T0, to: T0 + 140_000, value: 61 },
      { state: "failed", from: T0 + 140_000, to: T0 + 300_000, value: 93 },
    ]);
    expect(currentState(d.events, "a", "datadog")).toBe("failed");
    expect(currentState(d.events, "b", "datadog")).toBeNull();
  });

  it("the value range always shows both thresholds", () => {
    expect(valueRange([31, 40], { degraded: 70, failed: 90 }).hi).toBeGreaterThan(90);
    expect(valueRange([], undefined)).toEqual({ lo: 0, hi: 1 });
    expect(formatDuration(20_000)).toBe("20 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("GET /api/watch: live data, no watch yet (404 with the CLI's hint), or retry on a mid-write 503", async () => {
    const live = await fetchWatch(() => res(200, body));
    expect(live.state).toBe("live");
    const none = await fetchWatch(() =>
      res(404, { error: "no watch for this plan yet: run dd2dash0 watch <plan>" }),
    );
    expect(none).toEqual({
      state: "none",
      message: "no watch for this plan yet: run dd2dash0 watch <plan>",
    });
    expect(await fetchWatch(() => res(503, { error: "busy" }))).toEqual({ state: "retry" });
    expect(await fetchWatch(() => Promise.reject(new Error("offline")))).toEqual({
      state: "retry",
    });
    let called = "";
    await fetchWatch((u) => {
      called = String(u);
      return res(404, {});
    });
    expect(called).toBe("/api/watch"); // same-origin only
  });
});
