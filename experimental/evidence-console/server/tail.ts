// Reads events.jsonl safely: only complete lines, a partial last line waits for its newline, a shrinking file resets.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export class LineTailer {
  private pending = Buffer.alloc(0);
  malformed = 0;

  /** Feed raw bytes; returns parsed objects for every complete line. A trailing partial line is kept for the next push. */
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = this.pending.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = this.pending.subarray(start, nl).toString("utf8").trim();
      start = nl + 1;
      if (line === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        this.malformed += 1;
      }
    }
    this.pending = this.pending.subarray(start);
    return out;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}

export interface PollResult {
  truncated: boolean;
  events: unknown[];
}

/** Stateful poller over one file. Read-only: opens with "r". */
export class FilePoller {
  private offset = 0;
  private tailer = new LineTailer();
  constructor(private readonly path: string) {}

  get malformed(): number {
    return this.tailer.malformed;
  }

  poll(): PollResult {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { truncated: false, events: [] };
    }
    let truncated = false;
    if (size < this.offset) {
      truncated = true;
      this.offset = 0;
      this.tailer = new LineTailer();
    }
    if (size === this.offset) return { truncated, events: [] };
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      return { truncated, events: this.tailer.push(buf.subarray(0, n)) };
    } finally {
      closeSync(fd);
    }
  }
}
