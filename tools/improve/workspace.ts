// Candidate workspaces: a detached git worktree per round, so an agent never edits the checkout you're working in.
// node_modules is linked (a junction on Windows), not copied.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "./snapshot.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Run {
  ok: boolean;
  out: string;
}

/** Run a command; output is captured and trimmed to the tail (enough to show a failure). */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Run {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  return { ok: r.status === 0, out };
}

export const tail = (s: string, n = 2500) => (s.length > n ? "…" + s.slice(-n) : s);

export function measure(cwd: string): Snapshot {
  const dir = mkdtempSync(join(tmpdir(), "improve-snap-"));
  try {
    const file = join(dir, "snapshot.json");
    const r = run("npx", ["tsx", join(HERE, "measure.ts"), file], cwd);
    if (!r.ok) throw new Error(`measure failed in ${cwd}:\n${tail(r.out)}`);
    return JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Workspace {
  dir: string;
  remove(): void;
}

/** A detached worktree of `base` at HEAD (committed state only; your uncommitted edits are not in it). */
export function createWorkspace(baseDir: string): Workspace {
  const base = resolve(baseDir);
  const dir = join(mkdtempSync(join(tmpdir(), "improve-ws-")), "ws");
  const r = run("git", ["worktree", "add", "--detach", dir, "HEAD"], base);
  if (!r.ok) throw new Error(`git worktree add failed:\n${tail(r.out)}`);
  const nm = join(base, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dir, "node_modules"), "junction");
  return {
    dir,
    remove() {
      removeWorkspace(base, dir);
    },
  };
}

/**
 * Remove a workspace. The node_modules link goes first: `git worktree remove --force` follows a junction and
 * deletes the real node_modules behind it.
 */
export function removeWorkspace(baseDir: string, dir: string): void {
  const link = join(dir, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // no link
  }
  if (existsSync(link)) throw new Error(`refusing to remove ${dir}: node_modules is not a link we created`);
  run("git", ["worktree", "remove", "--force", dir], resolve(baseDir));
  rmSync(dirname(dir), { recursive: true, force: true });
}

/** Files changed in the workspace (tracked and untracked), repo-relative with forward slashes. */
export function changedFiles(dir: string): string[] {
  const r = run("git", ["status", "--porcelain", "--untracked-files=all"], dir);
  return r.out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p && p !== "node_modules")
    .map((p) => p.replace(/\\/g, "/"))
    .sort();
}
