// The interactive app: .env loading, the status line, and the menu driven with scripted answers. Commands run through
// the real CLI main(), so "translate" really plans the fixtures; only the browser opener and the web server are fakes.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentials, loadDotEnv, planStatus, runApp, statusLines, type AppDeps } from "../../src/app.js";
import { main } from "../../src/cli.js";
import { readLock } from "../../src/pipeline/plan-lock.js";
import { homeDir } from "../../src/home.js";

const ROOT = join(import.meta.dirname, "..", "..");

function scripted(answers: string[]) {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out,
    asked,
    io: {
      ask: async (q: string) => {
        asked.push(q);
        return answers.length ? answers.shift()! : null;
      },
      print: (l: string) => out.push(l),
    },
  };
}

function deps(cwd: string, over: Partial<AppDeps> = {}) {
  const calls: string[][] = [];
  const opened: string[] = [];
  let stopped = 0;
  const d: AppDeps = {
    run: async (argv) => {
      calls.push(argv);
      return Promise.resolve(main(argv));
    },
    startWeb: async () => ({ url: "http://127.0.0.1:4999", stop: () => void stopped++ }),
    open: (t) => void opened.push(t),
    env: {},
    cwd,
    ...over,
  };
  return { d, calls, opened, stopped: () => stopped };
}

describe(".env and credentials", () => {
  it("loads KEY=VALUE lines without overriding the environment, and reports names only", () => {
    const f = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(f, "# comment\nDD_API_KEY=abc\nexport DD_APP_KEY='q r'\nDASH0_API_URL=https://x # trailing\nDD_SITE=already\n");
    const env: NodeJS.ProcessEnv = { DD_SITE: "keep" };
    expect(loadDotEnv(f, env)).toEqual(["DD_API_KEY", "DD_APP_KEY", "DASH0_API_URL"]);
    expect(env).toMatchObject({ DD_API_KEY: "abc", DD_APP_KEY: "q r", DASH0_API_URL: "https://x", DD_SITE: "keep" });
    expect(credentials(env)).toEqual({ datadog: { ok: true, site: "keep" }, dash0: { ok: false, dataset: "default" } });
    expect(loadDotEnv(join(f, "..", "missing.env"), env)).toEqual([]);
  });
});

describe("the app menu", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "app-"));
  const plan = join(cwd, "dd2dash0-plan");

  it("translates a folder, says to review before applying, opens and stops the web UI, quits cleanly", async () => {
    const { io, out } = scripted(["1", join(ROOT, "fixtures", "datadog"), "5", "4", "4", "q"]);
    const t = deps(cwd);
    expect(await runApp(io, t.d)).toBe(0);
    expect(t.calls[0]).toEqual(["plan", "--input", join(ROOT, "fixtures", "datadog"), "--out", plan]);
    expect(out.join("\n")).toMatch(/✓ Translation done/);
    expect(out.join("\n")).toMatch(/Nothing has been reviewed yet/);
    expect(t.opened).toEqual(["http://127.0.0.1:4999"]);
    expect(out.join("\n")).toMatch(/Web UI stopped/);
    expect(t.stopped()).toBe(1);
    const st = planStatus(plan);
    expect(st).toMatchObject({ exists: true, dashboards: 4, monitors: 6, proof: false });
    expect(st.reviewed!.needed).toBeGreaterThan(0);
  });

  it("applies as a dry run once a review exists, asks before leaving items out, and needs 'import' typed for live", async () => {
    const report = JSON.parse(readFileSync(join(plan, "report.json"), "utf8")) as { items: { id: string; kind: string; target: unknown }[] };
    const decisions = report.items.filter((i) => i.kind === "alert" && i.target).map((i) => ({ id: i.id, decision: "approved", note: "" }));
    writeFileSync(join(plan, "review.json"), JSON.stringify({ schema_version: "1", plan_sha256: readLock(plan).planHash, reviewer: "t", decisions }));
    const { io, out } = scripted(["5", "y", "", "5", "y", "n", "nope", "q"]);
    const t = deps(cwd, { env: { DASH0_API_URL: "https://api.example", DASH0_AUTH_TOKEN: "t" } });
    await runApp(io, t.d);
    expect(t.calls[0]).toEqual(["apply", plan, "--approved", join(plan, "review.json"), "--allow-pending", "--dry-run"]);
    expect(out.join("\n")).toMatch(/✓ Dry-run apply done/);
    expect(out.join("\n")).toMatch(/Not imported\./); // typed "nope", not "import"
    expect(t.calls).toHaveLength(1);
    expect(planStatus(plan).applied).toMatchObject({ mode: "dry-run" });
  });

  it("writes and opens the proof card; watch refuses without both credentials; the status line names what is done", async () => {
    const { io, out } = scripted(["7", "6", "q"]);
    const t = deps(cwd);
    await runApp(io, t.d);
    expect(t.opened).toEqual([join(plan, "proof", "proof.html")]);
    expect(out.join("\n")).toMatch(/Watching needs both Datadog/);
    const lines = statusLines(plan, planStatus(plan), credentials({}), null).join("\n");
    expect(lines).toMatch(/applied as dry run \(\d+ written\) · not watched · proof card ✓/);
    expect(lines).toMatch(/Datadog ✗ .* Dash0 ✗/);
  });

  it("end of input quits; unknown choices are named; plan folder can be changed", async () => {
    const { io, out } = scripted(["zz", "p", "other-plan"]);
    await runApp(io, deps(cwd).d);
    expect(out.join("\n")).toMatch(/Unknown choice 'zz'/);
    expect(out.join("\n")).toMatch(new RegExp(`Plan folder  ${join(cwd, "other-plan").replace(/[/\\]/g, ".")}`));
    expect(out.at(-1)).toBe("Bye.");
  });
});

describe("home folder", () => {
  it("finds mappings next to a standalone executable, else the repository; DD2DASH0_HOME wins", () => {
    expect(homeDir({}, "/nowhere/bin/node", join(ROOT, "src"))).toBe(ROOT);
    expect(homeDir({}, join(ROOT, "dd2dash0"), "/$bunfs/root")).toBe(ROOT);
    expect(homeDir({ DD2DASH0_HOME: ROOT }, "/x/y", "/$bunfs/root")).toBe(ROOT);
  });
});
