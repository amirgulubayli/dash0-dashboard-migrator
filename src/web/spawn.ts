// How the web UI runs the real CLI as a child process, from source and from a build alike:
//   from source  `tsx src/cli.ts ui`   -> node + tsx's loader flags (process.execArgv) + src/cli.ts + args
//   npm build    `node dist/bin.js ui` -> node + dist/bin.js + args
//   one binary   `dd2dash0 ui` (bun --compile) -> the binary itself + args (its argv[1] is a virtual path)
import { existsSync } from "node:fs";

export interface CliInvocation {
  cmd: string;
  /** Arguments that come before the CLI's own arguments (loader flags, entry script). */
  prefix: string[];
}

export function currentCli(argv: string[] = process.argv, execArgv: string[] = process.execArgv, execPath: string = process.execPath): CliInvocation {
  const entry = argv[1] ?? "";
  if (entry && /\.(?:[cm]?[jt]s)$/.test(entry) && existsSync(entry)) return { cmd: execPath, prefix: [...execArgv, entry] };
  return { cmd: execPath, prefix: [] };
}

/** The command line as a person would type it (shown above the terminal output). */
export function displayCommand(args: string[]): string {
  const q = (a: string) => (/^[\w./:@=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  return ["dd2dash0", ...args].map(q).join(" ");
}
