import { describe, expect, it } from "vitest";
import { emptyEventState, parseEventLines, planReplay, reduceEvent, stagesFrom, type RunEvent } from "../src/lib/reducer";
import { smallEventsText } from "./helpers";

const events = () => parseEventLines(smallEventsText()).events;
const fold = (es: unknown[]) => es.reduce<ReturnType<typeof emptyEventState>>((s, e) => reduceEvent(s, e), emptyEventState());

describe("reducer", () => {
  it("replays the log in seq order even when events arrive shuffled", () => {
    const shuffled = [...events()].reverse();
    expect(fold(shuffled).events.map((e) => e.seq)).toEqual(events().map((e) => e.seq));
  });
  it("ignores a duplicate event and counts it", () => {
    const e = events();
    const s = fold([...e, e[3], e[3]]);
    expect(s.events).toHaveLength(e.length);
    expect(s.duplicates).toBe(2);
    expect(s.itemsSeen.size).toBe(5);
  });
  it("ignores things that are not events", () => {
    const s = fold([{ nope: true }, null, "x", { seq: "1", type: "a" }]);
    expect(s.events).toHaveLength(0);
    expect(s.ignored).toBe(4);
  });
  it("gives the same state for live and replay (same function, same events)", () => {
    expect(fold(events())).toEqual(fold(events()));
  });
});

describe("no fabricated events", () => {
  it("shows every stage as pending when the log is empty", () => {
    expect(stagesFrom(emptyEventState()).every((s) => s.status === "pending")).toBe(true);
  });
  it("does not mark the run finished or the import done without those events", () => {
    const upToItems = events().filter((e) => e.seq <= 5);
    const st = Object.fromEntries(stagesFrom(fold(upToItems)).map((s) => [s.key, s.status]));
    expect(st.start).toBe("done");
    expect(st.import).toBe("pending");
    expect(st.done).toBe("pending");
  });
  it("has no per-item entry for an item whose event is absent", () => {
    const s = fold(events().filter((e) => e.id !== "p3"));
    expect(s.itemsSeen.has("p3")).toBe(false);
    expect(s.itemsSeen.size).toBe(4);
  });
  it("marks every stage done only when the whole log is present", () => {
    expect(stagesFrom(fold(events())).every((s) => s.status === "done")).toBe(true);
  });
});

describe("partial last line", () => {
  it("does not parse an unfinished last line", () => {
    const text = smallEventsText() + '{"seq":10,"type":"item.do';
    const r = parseEventLines(text);
    expect(r.events).toHaveLength(10);
    expect(r.malformed).toBe(0);
  });
  it("counts a malformed complete line instead of crashing", () => {
    const r = parseEventLines('{"seq":0,"type":"run.start"}\nnot json\n');
    expect(r.events).toHaveLength(1);
    expect(r.malformed).toBe(1);
  });
});

describe("replay plan", () => {
  it("says so when the log has no timestamps", () => {
    const p = planReplay(events(), 1);
    expect(p.hasRecordedTimestamps).toBe(false);
    expect(p.note).toMatch(/No timestamps recorded/);
    expect(p.slowed).toBe(false);
  });
  it("uses recorded gaps when timestamps exist and flags slowed playback", () => {
    const timed: RunEvent[] = [{ seq: 0, type: "a", ts: 1000 }, { seq: 1, type: "b", ts: 1500 }, { seq: 2, type: "c", ts: 3500 }];
    const normal = planReplay(timed, 1);
    expect(normal.delaysMs).toEqual([0, 500, 2000]);
    expect(normal.slowed).toBe(false);
    const slow = planReplay(timed, 0.5);
    expect(slow.delaysMs).toEqual([0, 1000, 4000]);
    expect(slow.slowed).toBe(true);
    expect(slow.note).toBe("Playback slowed for visibility");
  });
});
