// The one-time key page's markup: per-key help, inline states, CSP-safe (nonce'd style/script, no inline style
// attributes, nothing external), and secrets never echoed (a known secret shows only its 4-character fingerprint).
import { describe, expect, it } from "vitest";
import { _keysPage } from "../../src/flow/keys-web.js";

const html = _keysPage({ need: { datadog: true, dash0: true }, known: { DD_SITE: "datadoghq.eu", DASH0_AUTH_TOKEN: "auth_supersecret_value_9z9z" }, cwd: "/w", onReady: () => {} }, "NONCE");

describe("key page markup", () => {
  it("says where to find every key", () => {
    expect(html).toContain("Organization Settings → API Keys");
    expect(html).toContain("Organization Settings → Application Keys");
    expect(html).toContain("Settings → Endpoints → API");
    expect(html).toContain("Settings → Auth Tokens");
    for (const k of ["DD_SITE", "DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL", "DASH0_AUTH_TOKEN", "DASH0_DATASET"]) expect(html).toContain(`aria-describedby="${k}-msg ${k}-hint"`);
  });

  it("never echoes a secret, only its fingerprint", () => {
    expect(html).not.toContain("supersecret");
    expect(html).toContain("…9z9z");
    expect(html).toMatch(/id="DASH0_AUTH_TOKEN" name="DASH0_AUTH_TOKEN" type="password" value=""/);
  });

  it("is CSP-safe: nonce'd style and script only, no inline style attributes, nothing external", () => {
    expect(html).toContain('<style nonce="NONCE">');
    expect(html).toContain('<script nonce="NONCE">');
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/src=|href="http|<link|@import|url\(/);
  });

  it("keeps the page script's regular expressions intact (raw string)", () => {
    expect(html).toContain(String.raw`/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/`);
    expect(html).toContain(String.raw`/^(['"]).*\1$/`);
  });

  it("has inline states for ok, bad, format warnings and checking", () => {
    for (const s of [".row.ok", ".row.bad", ".row.warn", ".row.checking"]) expect(html).toContain(s);
    expect(html).toContain('id="status" role="status"');
  });
});
