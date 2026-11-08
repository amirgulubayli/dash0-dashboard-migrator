import { appendFileSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilePoller, LineTailer } from "../server/tail";

describe("LineTailer", () => {
  it("returns only complete lines and keeps the partial one", () => {
    const t = new LineTailer();
    expect(t.push(Buffer.from('{"seq":0}\n{"seq":1'))).toEqual([{ seq: 0 }]);
    expect(t.push(Buffer.from("}\n"))).toEqual([{ seq: 1 }]);
  });
  it("does not split a multi-byte character across chunks", () => {
    const t = new LineTailer();
    const line = Buffer.from('{"t":"é"}\n');
    expect(t.push(line.subarray(0, 7))).toEqual([]);
    expect(t.push(line.subarray(7))).toEqual([{ t: "é" }]);
  });
  it("counts malformed complete lines and carries on", () => {
    const t = new LineTailer();
    expect(t.push(Buffer.from('oops\n{"seq":2}\n'))).toEqual([{ seq: 2 }]);
    expect(t.malformed).toBe(1);
  });
});

describe("FilePoller", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "evtail-")), "events.jsonl");
  it("reads new lines, waits for a partial last line, and resets on truncation", () => {
    const p = tmp();
    writeFileSync(p, '{"seq":0}\n{"seq":1');
    const poller = new FilePoller(p);
    expect(poller.poll().events).toEqual([{ seq: 0 }]);
    expect(poller.poll().events).toEqual([]);
    appendFileSync(p, '}\n{"seq":2}\n');
    expect(poller.poll().events).toEqual([{ seq: 1 }, { seq: 2 }]);
    truncateSync(p, 0);
    writeFileSync(p, '{"seq":0}\n');
    const r = poller.poll();
    expect(r.truncated).toBe(true);
    expect(r.events).toEqual([{ seq: 0 }]);
  });
  it("returns nothing for a file that does not exist yet", () => {
    expect(new FilePoller(tmp()).poll()).toEqual({ truncated: false, events: [] });
  });
});
