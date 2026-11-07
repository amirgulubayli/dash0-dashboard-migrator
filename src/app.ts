// dd2dash0 as an app: run `dd2dash0` with no arguments in a terminal and it opens this menu. Every action is one of
// the CLI commands (plan, review, apply, watch, proof, migrate), so the app adds no translation logic of its own; the
// web UI is the console, served by `dd2dash0 review` in the background.
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homeDir } from "./home.js";

// ------------------------------------------------------------------ environment

/** Load KEY=VALUE lines from a .env file into env, never overriding what is already set. Returns the names loaded. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith("#")) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (env[m[1]!] === undefined) {
      env[m[1]!] = v;
      loaded.push(m[1]!);
    }
  }
  return loaded;
}

export interface Credentials {
  datadog: { ok: boolean; site: string };
  dash0: { ok: boolean; dataset: string };
}

export function credentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  return {
    datadog: { ok: !!(env.DD_API_KEY?.trim() && env.DD_APP_KEY?.trim()), site: env.DD_SITE?.trim() || "datadoghq.eu" },
    dash0: { ok: !!(env.DASH0_API_URL?.trim() && env.DASH0_AUTH_TOKEN?.trim()), dataset: env.DASH0_DATASET?.trim() || "default" },
  };
}

// ------------------------------------------------------------------ plan status

export interface PlanStatus {
  exists: boolean;
  dashboards?: number;
  monitors?: number;
  coverageTranslated?: number;
  /** Decisions saved vs items that need one. */
  reviewed?: { decided: number; needed: number };
  applied?: { mode: string; imported: number; written: number; failed: number };
  watch?: string[];
  proof?: boolean;
}

const readJson = <T>(f: string): T | null => {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

export function planStatus(planDir: string): PlanStatus {
  const report = readJson<{ summary?: { dashboards?: number; alerts?: number; coverageTranslated?: number; reviewOrder?: string[] } }>(join(planDir, "report.json"));
  if (!report) return { exists: false };
  const s = report.summary ?? {};
  const review = readJson<{ decisions?: unknown[] }>(join(planDir, "review.json"));
  const applied = readJson<{ summary?: { import?: { mode: string; imported: number; written: number; failed: number } } }>(join(planDir, "apply", "report.json"));
  const parity = readJson<{ results?: { verdict: string }[] }>(join(planDir, "watch", "parity.json"));
  return {
    exists: true,
    ...(s.dashboards !== undefined ? { dashboards: s.dashboards } : {}),
    ...(s.alerts !== undefined ? { monitors: s.alerts } : {}),
    ...(s.coverageTranslated !== undefined ? { coverageTranslated: s.coverageTranslated } : {}),
    reviewed: { decided: review?.decisions?.length ?? 0, needed: s.reviewOrder?.length ?? 0 },
    ...(applied?.summary?.import ? { applied: applied.summary.import } : {}),
    ...(parity?.results ? { watch: parity.results.map((r) => r.verdict) } : {}),
    proof: existsSync(join(planDir, "proof", "proof.html")),
  };
}

export function statusLines(planDir: string, st: PlanStatus, cred: Credentials, web: string | null): string[] {
  const yes = (b: boolean) => (b ? "✓" : "✗");
  const lines = [
    `Credentials  Datadog ${yes(cred.datadog.ok)} (${cred.datadog.site})   Dash0 ${yes(cred.dash0.ok)} (dataset ${cred.dash0.dataset})`,
    `Plan folder  ${planDir}`,
  ];
  if (!st.exists) lines.push("Plan         none yet: start with 1 or 2");
  else {
    const steps = [
      `${st.dashboards ?? "?"} dashboards, ${st.monitors ?? "?"} monitors, ${st.coverageTranslated !== undefined ? `${(Math.floor(st.coverageTranslated * 1000) / 10).toFixed(1)}% translated` : ""}`,
      `reviewed ${st.reviewed?.decided ?? 0}/${st.reviewed?.needed ?? 0}`,
      st.applied ? (st.applied.mode === "live" ? `imported ${st.applied.imported} (failed ${st.applied.failed})` : `applied as dry run (${st.applied.written} written)`) : "not applied",
      st.watch ? `watch: ${st.watch.join(", ")}` : "not watched",
      st.proof ? "proof card ✓" : "no proof card",
    ];
    lines.push(`Plan         ${steps.join(" · ")}`);
  }
  lines.push(`Web UI       ${web ? `${web} (running)` : "off"}`);
  return lines;
}

// ------------------------------------------------------------------ the menu

export interface AppIO {
  /** One line of input; null at end of input. */
  ask(question: string): Promise<string | null>;
  print(line: string): void;
}

export interface AppDeps {
  /** Run a CLI command (the same argv as the command line); resolves to its exit code. */
  run(argv: string[]): Promise<number>;
  /** Start the review web UI for a plan; returns its URL and a stop function. */
  startWeb(planDir: string): Promise<{ url: string; stop: () => void }>;
  open(target: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const MENU = [
  ["1", "Translate a folder of Datadog exports"],
  ["2", "Translate from the Datadog API"],
  ["3", "Review the plan in this terminal"],
  ["4", "Open the web UI (review, dashboard map, incident)"],
  ["5", "Apply to Dash0 (dry run or live)"],
  ["6", "Watch an incident (Datadog vs Dash0)"],
  ["7", "Proof card"],
  ["8", "One-shot migrate, no review"],
  ["p", "Change the plan folder"],
  ["h", "All commands (CLI help)"],
  ["q", "Quit"],
] as const;

export async function runApp(io: AppIO, deps: AppDeps): Promise<number> {
  let planDir = resolve(deps.cwd, deps.env.DD2DASH0_PLAN ?? "dd2dash0-plan");
  let web: { url: string; stop: () => void } | null = null;
  const say = (l = "") => io.print(l);
  const askDefault = async (q: string, def: string) => {
    const a = await io.ask(`${q}${def ? ` [${def}]` : ""}: `);
    return a === null ? null : a.trim() || def;
  };
  const yesNo = async (q: string, def: boolean) => {
    const a = await io.ask(`${q} [${def ? "Y/n" : "y/N"}]: `);
    if (a === null) return null;
    const t = a.trim().toLowerCase();
    return t === "" ? def : t === "y" || t === "yes";
  };
  const needPlan = () => {
    if (planStatus(planDir).exists) return true;
    say(`No plan in ${planDir} yet. Translate first (1 or 2).`);
    return false;
  };
  const report = (code: number, what: string) => say(code === 0 ? `✓ ${what} done.` : `✗ ${what} ended with exit code ${code} (see above).`);

  say("dd2dash0 · Datadog → Dash0 migration. Rules and mapping tables only: no model translates anything.");
  for (;;) {
    say();
    for (const l of statusLines(planDir, planStatus(planDir), credentials(deps.env), web?.url ?? null)) say(l);
    say();
    for (const [k, label] of MENU) say(`  ${k}  ${k === "4" && web ? "Stop the web UI" : label}`);
    const choice = await io.ask("\nChoose: ");
    if (choice === null) break;
    const c = choice.trim().toLowerCase();
    say();
    if (c === "q" || c === "quit" || c === "exit") break;
    if (c === "1") {
      const def = existsSync(resolve(deps.cwd, "exports")) ? "exports" : "";
      const dir = await askDefault("Folder of Datadog dashboard and monitor exports (JSON or YAML)", def);
      if (!dir) continue;
      const abs = resolve(deps.cwd, dir);
      if (!existsSync(abs)) {
        say(`✗ ${abs} does not exist.`);
        continue;
      }
      report(await deps.run(["plan", "--input", abs, "--out", planDir]), "Translation");
    } else if (c === "2") {
      if (!credentials(deps.env).datadog.ok) {
        say("✗ DD_API_KEY and DD_APP_KEY are needed (put them in a .env file here, or in the environment).");
        continue;
      }
      report(await deps.run(["plan", "--api", "--out", planDir]), "Translation from the Datadog API");
    } else if (c === "3") {
      if (!needPlan()) continue;
      report(await deps.run(["review", planDir, "--terminal"]), "Review");
    } else if (c === "4") {
      if (web) {
        web.stop();
        web = null;
        say("Web UI stopped.");
        continue;
      }
      if (!needPlan()) continue;
      try {
        web = await deps.startWeb(planDir);
        say(`Web UI: ${web.url}  (opening it in your browser; decisions you save there go to ${join(planDir, "review.json")})`);
        deps.open(web.url);
      } catch (e) {
        say(`✗ Could not start the web UI: ${(e as Error).message}`);
      }
    } else if (c === "5") {
      if (!needPlan()) continue;
      const reviewFile = join(planDir, "review.json");
      if (!existsSync(reviewFile)) {
        say("Nothing has been reviewed yet. Review first (3 in the terminal, or 4 in the web UI): apply imports only what was decided.");
        continue;
      }
      const args = ["apply", planDir, "--approved", reviewFile];
      const st = planStatus(planDir);
      if (st.reviewed && st.reviewed.decided < st.reviewed.needed) {
        say(`${st.reviewed.needed - st.reviewed.decided} item(s) still have no decision.`);
        const go = await yesNo("Apply anyway, leaving the undecided items out", false);
        if (go === null) break;
        if (!go) continue;
        args.push("--allow-pending");
      }
      const dry = await yesNo("Dry run (write the Dash0 payloads, import nothing)", true);
      if (dry === null) break;
      if (dry) args.push("--dry-run");
      else {
        if (!credentials(deps.env).dash0.ok) {
          say("✗ DASH0_API_URL and DASH0_AUTH_TOKEN are needed for a live import.");
          continue;
        }
        const confirm = await io.ask(`This imports into Dash0 dataset ${credentials(deps.env).dash0.dataset}. Type "import" to go on: `);
        if (confirm?.trim() !== "import") {
          say("Not imported.");
          continue;
        }
      }
      report(await deps.run(args), dry ? "Dry-run apply" : "Import");
    } else if (c === "6") {
      if (!needPlan()) continue;
      const cr = credentials(deps.env);
      if (!cr.datadog.ok || !cr.dash0.ok) {
        say("✗ Watching needs both Datadog (DD_API_KEY, DD_APP_KEY) and Dash0 (DASH0_API_URL, DASH0_AUTH_TOKEN) credentials.");
        continue;
      }
      say("Watching until both alerts have fired and recovered. Press Ctrl-C to stop early.");
      if (web) say(`Live view: ${web.url}/incident`);
      report(await deps.run(["watch", planDir, "--until-recovered"]), "Watch");
    } else if (c === "7") {
      if (!needPlan()) continue;
      const code = await deps.run(["proof", planDir]);
      report(code, "Proof card");
      if (code === 0) deps.open(join(planDir, "proof", "proof.html"));
    } else if (c === "8") {
      const src = await askDefault("Source: a folder path, or 'api'", existsSync(resolve(deps.cwd, "exports")) ? "exports" : "api");
      if (!src) continue;
      const out = resolve(deps.cwd, "dd2dash0-out");
      const dry = await yesNo("Dry run (import nothing)", true);
      if (dry === null) break;
      if (!dry && !credentials(deps.env).dash0.ok) {
        say("✗ DASH0_API_URL and DASH0_AUTH_TOKEN are needed for a live import.");
        continue;
      }
      const from = src === "api" ? ["--api"] : ["--input", resolve(deps.cwd, src)];
      report(await deps.run(["migrate", "--from", "datadog", ...from, "--out", out, ...(dry ? ["--dry-run"] : [])]), "Migrate");
    } else if (c === "p") {
      const next = await askDefault("Plan folder", planDir);
      if (next) planDir = resolve(deps.cwd, next);
    } else if (c === "h" || c === "help") {
      await deps.run(["--help"]);
    } else if (c) say(`Unknown choice '${c}'.`);
  }
  web?.stop();
  say("Bye.");
  return 0;
}

// ------------------------------------------------------------------ the real terminal

export function openTarget(target: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No opener available: the URL or path is printed anyway.
  }
}

/** The interactive app on the real terminal. `run` is the CLI's main(). */
export async function startApp(run: (argv: string[]) => number | Promise<number>): Promise<number> {
  const cwd = process.cwd();
  const loaded = loadDotEnv(join(cwd, ".env"));
  // One readline for the whole menu (a readline per question would drop typed-ahead or pasted lines). It is released
  // while a command runs, because some commands read the terminal themselves (review --terminal) or take Ctrl-C
  // (watch), and recreated afterwards. Ctrl-C or Ctrl-D at the menu quits.
  let closedByUser = false;
  const make = () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      closedByUser = true;
      rl.close();
    });
    rl.on("close", () => {
      if (!released) closedByUser = true;
    });
    return rl;
  };
  let released = false;
  let rl = make();
  const io: AppIO = {
    async ask(q) {
      if (closedByUser) return null;
      return new Promise<string | null>((res) => {
        const onClose = () => res(null);
        rl.once("close", onClose);
        rl.question(q).then(
          (a) => {
            rl.off("close", onClose);
            res(a);
          },
          () => res(null),
        );
      });
    },
    print: (l) => console.log(l),
  };
  const withTerminal = async <T>(f: () => Promise<T>): Promise<T> => {
    released = true;
    rl.close();
    try {
      return await f();
    } finally {
      released = false;
      rl = make();
    }
  };
  if (loaded.length) console.log(`Loaded ${loaded.length} setting(s) from ${join(cwd, ".env")} (names only: ${loaded.join(", ")})`);
  const { startReviewServer, findConsoleDir } = await import("./serve/review.js");
  const code = await runApp(io, {
    run: (argv) => withTerminal(async () => Promise.resolve(run(argv))),
    startWeb: async (planDir) => {
      const consoleDir = findConsoleDir(join(homeDir(), "src"));
      const { server, url } = await startReviewServer({ planDir, port: 0, ...(consoleDir ? { consoleDir } : {}) });
      return { url: url.replace(/\/$/, ""), stop: () => server.close() };
    },
    open: openTarget,
    env: process.env,
    cwd,
  });
  released = true;
  rl.close();
  return code;
}
