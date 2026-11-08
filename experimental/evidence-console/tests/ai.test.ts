import { describe, expect, it, vi } from "vitest";
import { aiConfigFromEnv, aiPayloadFromReport, explainWithAi, validateAiReply } from "../server/ai";
import { deepFreeze, smallReport } from "./helpers";

const ids = new Set(["p2", "p3", "p4", "m1"]);

describe("AI is off by default", () => {
  it("is off without the flag, even if a key is present in the environment", () => {
    expect(aiConfigFromEnv({ ANTHROPIC_API_KEY: "k" })).toEqual({ enabled: false, keyPresent: false });
  });
  it("needs both the flag and a key", () => {
    expect(aiConfigFromEnv({ ENABLE_AI_EXPLANATION: "1" })).toEqual({ enabled: true, keyPresent: false });
    expect(aiConfigFromEnv({ ENABLE_AI_EXPLANATION: "1", ANTHROPIC_API_KEY: "k" })).toEqual({ enabled: true, keyPresent: true });
    expect(aiConfigFromEnv({ ENABLE_AI_EXPLANATION: "true", ANTHROPIC_API_KEY: "k" }).enabled).toBe(false);
  });
  it("makes no request when off", async () => {
    const f = vi.fn();
    await expect(explainWithAi(smallReport(), {}, f)).rejects.toThrow(/switched off/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("what leaves the process", () => {
  it("sends only id, label, reason and condition per item", () => {
    const items = aiPayloadFromReport(smallReport());
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["condition", "id", "label", "reason"]);
    expect(JSON.stringify(items)).not.toMatch(/avg:a|avg\(a\)|Small - Dash|High mem/);
  });
});

describe("reply validation", () => {
  it("rejects ids that are not in the report", () => {
    const r = validateAiReply({ notes: [{ id: "p2", text: "Look at the bound." }, { id: "zzz", text: "Invented." }] }, ids);
    expect(r.notes.map((n) => n.id)).toEqual(["p2"]);
    expect(r.rejected).toBe(1);
  });
  it("rejects notes that declare things safe or verified, or that contain queries", () => {
    const r = validateAiReply({ notes: [
      { id: "p2", text: "This is safe to ship." },
      { id: "p3", text: "Verified against Datadog." },
      { id: "p4", text: "Run this PromQL: up" },
      { id: "m1", text: "Check the threshold and the notification route." },
    ] }, ids);
    expect(r.notes.map((n) => n.id)).toEqual(["m1"]);
    expect(r.rejected).toBe(3);
  });
  it("rejects a reply of the wrong shape and drops duplicate ids", () => {
    expect(validateAiReply("x", ids)).toEqual({ notes: [], rejected: 1 });
    expect(validateAiReply({ notes: [{ id: "p2", text: "a" }, { id: "p2", text: "b" }] }, ids).notes).toHaveLength(1);
  });
});

describe("AI never changes the report", () => {
  it("works on a frozen report and leaves it identical", async () => {
    const report = deepFreeze(smallReport());
    const before = JSON.stringify(report);
    const fetcher = vi.fn(async (_u: string, init: { body: string; headers: Record<string, string> }) => {
      expect(init.headers["x-api-key"]).toBe("test-key-not-real");
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ notes: [{ id: "p2", text: "Look at the stated bound." }, { id: "nope", text: "x" }] }) }] }) };
    });
    const r = await explainWithAi(report, { ENABLE_AI_EXPLANATION: "1", ANTHROPIC_API_KEY: "test-key-not-real" }, fetcher);
    expect(JSON.stringify(report)).toBe(before);
    expect(r.notes).toEqual([{ id: "p2", text: "Look at the stated bound." }]);
    expect(r.rejected).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/test-key-not-real/);
  });
});
