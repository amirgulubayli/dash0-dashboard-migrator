// Terminal presentation for the CLI: claim words in the same colours as the console's legend, only on a TTY.
// NO_COLOR (no-color.org) always wins; FORCE_COLOR forces colour (e.g. in a recorded demo). Pure string helpers,
// so summary lines stay plain text everywhere else (report.md, tests, pipes).

const ESC = "\u001b[";
type Paint = (s: string) => string;

export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

const sgr = (open: number, close: number): Paint => (s) => `${ESC}${open}m${s}${ESC}${close}m`;
const STYLE = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  green: sgr(32, 39),
  cyan: sgr(36, 39),
  yellow: sgr(33, 39),
  magenta: sgr(35, 39),
  red: sgr(31, 39),
};

/** The five claims plus failed, each with its colour. Order is the strength of the claim. */
const CLAIM_PAINT: Record<string, Paint> = {
  exact: STYLE.green,
  "exact-under": STYLE.cyan,
  bounded: STYLE.yellow,
  manual: STYLE.magenta,
  unsupported: STYLE.red,
  failed: STYLE.red,
};

export interface Styler {
  bold: Paint;
  dim: Paint;
  ok: Paint;
  warn: Paint;
  bad: Paint;
  /** Colour every claim word (exact, exact-under, bounded, manual, unsupported, failed) in a line. */
  claims: Paint;
}

export function styler(on = colorEnabled()): Styler {
  const id: Paint = (s) => s;
  if (!on) return { bold: id, dim: id, ok: id, warn: id, bad: id, claims: id };
  return {
    bold: STYLE.bold,
    dim: STYLE.dim,
    ok: STYLE.green,
    warn: STYLE.yellow,
    bad: STYLE.red,
    // exact-under before exact so the longer word wins; word boundaries keep "exactly" etc. untouched.
    claims: (s) => s.replace(/\b(exact-under|exact|bounded|manual|unsupported|failed)\b/g, (w) => CLAIM_PAINT[w]!(w)),
  };
}
