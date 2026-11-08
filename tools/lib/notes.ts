// Owners from the workspace NOTES.md "Owners" table (| Area (fork paths) | Owner | Backup |). The fork paths are the
// backticked globs in the Area cell. Used to route a lever to the person who reviews and merges it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface OwnerRow {
  area: string;
  owner: string;
  backup: string;
  /** Backticked globs from the area cell, e.g. "src/translate/query/**", "README.md". */
  paths: string[];
}

export function parseOwners(notes: string): OwnerRow[] {
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Area/i.test(l) && /Owner/i.test(l));
  if (start < 0) return [];
  const rows: OwnerRow[] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith("|")) break;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const paths = [...cells[0]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    rows.push({ area: cells[0]!, owner: cells[1]!, backup: cells[2]!, paths });
  }
  return rows;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const base = (g: string) => norm(g).replace(/\/?\*\*.*$/, "").replace(/\/\*[^/]*$/, "");

/** Whether two path globs ("dir/**", "dir/x.ts", "README.md") can name the same file. */
export function overlaps(a: string, b: string): boolean {
  const A = base(a);
  const B = base(b);
  const isDirA = norm(a).includes("*");
  const isDirB = norm(b).includes("*");
  if (A === B) return true;
  if (isDirA && (B === A || B.startsWith(A + "/"))) return true;
  if (isDirB && (A === B || A.startsWith(B + "/"))) return true;
  return false;
}

/**
 * The owner rows of a file or glob: those with the most specific matching path (longest prefix). NOTES.md splits some
 * directories by sub-area (src/translate/dashboard/** has a "log paths" row and a "rest" row); then every tied row is
 * returned, in table order, and the caller names all of them.
 */
export function ownersOf(path: string, rows: OwnerRow[]): OwnerRow[] {
  let best: OwnerRow[] = [];
  let bestLen = -1;
  for (const row of rows)
    for (const p of row.paths)
      if ((base(path) + "/").startsWith(base(p) + "/")) {
        const len = base(p).length;
        if (len > bestLen) [best, bestLen] = [[row], len];
        else if (len === bestLen && !best.includes(row)) best.push(row);
      }
  return best;
}

/** "Ali", or "Ali or Amir" when the area is split. "?" when NOTES.md has no row for it. */
export function ownerName(paths: string[], rows: OwnerRow[]): string {
  const names: string[] = [];
  for (const p of paths) for (const r of ownersOf(p, rows)) if (!names.includes(r.owner)) names.push(r.owner);
  return names.length ? names.join(" or ") : "?";
}

/** NOTES.md: $NOTES_MD, else the nearest NOTES.md in a parent directory of `from` (the workspace holds the fork). */
export function findNotes(from: string): string | null {
  if (process.env.NOTES_MD) return existsSync(process.env.NOTES_MD) ? resolve(process.env.NOTES_MD) : null;
  let d = resolve(from);
  for (let i = 0; i < 8; i++) {
    const f = join(d, "NOTES.md");
    if (existsSync(f)) return f;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export function loadOwners(from: string): { file: string | null; rows: OwnerRow[] } {
  const file = findNotes(from);
  return { file, rows: file ? parseOwners(readFileSync(file, "utf8")) : [] };
}
