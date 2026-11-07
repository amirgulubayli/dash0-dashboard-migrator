// A compact, comparable view of a migrate run: what the gates and the gap picker need, nothing more.
// Built by measure.ts in a subprocess, so a candidate workspace is measured with its own code and mappings.

export interface SnapshotFinding {
  status: string;
  code: string;
  message: string;
}

export interface SnapshotItem {
  id: string;
  status: string;
  /** Hash of the item's output (null for placeholders). Untouched items must keep it. */
  outputHash: string | null;
  findings: SnapshotFinding[];
}

export interface Snapshot {
  coverageExact: number;
  coverageTranslated: number;
  /** sha256 over the report items: the determinism check (two runs, same hash). */
  outputHash: string;
  items: SnapshotItem[];
}

/** Report (dd2dash0.report/v1) -> Snapshot. Structural, so it doesn't import the migrator. */
export function snapshotOf(report: {
  summary: { coverageExact: number; coverageTranslated: number };
  run: { outputHash: string };
  items: { id: string; status: string; certificate: { outputHash: string | null }; findings: { status: string; code: string; message: string }[] }[];
}): Snapshot {
  return {
    coverageExact: report.summary.coverageExact,
    coverageTranslated: report.summary.coverageTranslated,
    outputHash: report.run.outputHash,
    items: report.items
      .map((i) => ({ id: i.id, status: i.status, outputHash: i.certificate.outputHash, findings: i.findings.map((f) => ({ status: f.status, code: f.code, message: f.message })) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
