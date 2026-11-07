// The scattered rule tables point at the catalog: T4's RULES / ASSUMPTIONS must equal the catalog's T4 slice.
// Runs against src/translate/query/rules.ts when it exists (PR #3); skipped before that.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSUMPTIONS_T4, RULES_T4, T4_TABLE_IDS, rule } from "../../src/rules/index.js";
import { renderMarkdown } from "../../src/rules/render.js";

const t4Path = fileURLToPath(new URL("../../src/translate/query/rules.ts", import.meta.url));
const docPath = fileURLToPath(new URL("../../docs/rules.md", import.meta.url));

describe("T4 rule table ↔ catalog", () => {
  it("the catalog's T4 slice has every T4 id, owned by T4 and implemented", () => {
    for (const id of T4_TABLE_IDS) {
      const r = rule(id);
      expect(r.owner, id).toBe("T4");
      expect(r.state, id).toBe("implemented");
    }
  });

  it.skipIf(!existsSync(t4Path))("src/translate/query/rules.ts matches the catalog id for id", async () => {
    const t4 = (await import(t4Path)) as { RULES: Record<string, { status: string; assumptions: string[] }>; ASSUMPTIONS: Record<string, string> };
    expect(Object.keys(t4.RULES)).toEqual([...T4_TABLE_IDS]);
    for (const [id, r] of Object.entries(t4.RULES)) {
      const c = RULES_T4[id as keyof typeof RULES_T4];
      expect(r.status, id).toBe(c.status);
      expect([...r.assumptions].sort(), id).toEqual([...c.assumptions].sort());
    }
    expect(t4.ASSUMPTIONS).toEqual(ASSUMPTIONS_T4);
  });
});

describe("docs/rules.md", () => {
  it("is generated from the catalog and up to date", () => {
    expect(renderMarkdown()).toBe(renderMarkdown());
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, "utf8"), "run: npx tsx src/rules/write-doc.ts").toBe(renderMarkdown());
  });
});
