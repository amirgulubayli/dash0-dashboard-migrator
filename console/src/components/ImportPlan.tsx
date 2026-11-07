import { useEffect, useState } from "react";
import { Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReport } from "@/lib/report-store";
import { buildReviewJson, importPlan, planText } from "@/lib/review";
import { COPY } from "@/lib/status";
import {
  cliReviewJson,
  fetchCliPlan,
  saveReviewToCli,
  type CliPlan,
  type SaveResult,
} from "@/lib/cli-server";

export function PlanSummary() {
  const { report, review } = useReport();
  return (
    <code className="break-words font-mono text-xs text-body">
      {planText(importPlan(report, review))}
    </code>
  );
}

export function ExportButton() {
  const { report, review, sha } = useReport();
  const [confirming, setConfirming] = useState(false);
  const plan = importPlan(report, review);
  const noName = !review.reviewer.trim();
  const [cli, setCli] = useState<CliPlan | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [saving, setSaving] = useState(false);

  // Served by `dd2dash0 review`? Then decisions can go straight to the plan directory.
  useEffect(() => {
    let alive = true;
    fetchCliPlan().then((p) => alive && setCli(p));
    return () => {
      alive = false;
    };
  }, []);

  const saveToCli = async () => {
    if (!sha || !cli) return;
    setSaving(true);
    setSaved(await saveReviewToCli(cliReviewJson(report, sha, review, cli)));
    setSaving(false);
    setConfirming(false);
  };

  const download = () => {
    if (!sha) return;
    const blob = new Blob([JSON.stringify(buildReviewJson(report, sha, review), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setConfirming(false);
  };

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-warn-foreground">
          {plan.pending} items still pending. Export anyway?
        </span>
        {cli ? (
          <Button size="sm" onClick={saveToCli} disabled={saving}>
            Save to dd2dash0
          </Button>
        ) : (
          <Button size="sm" onClick={download}>
            Export
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  if (cli) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={noName || !sha || saving}
            title={
              noName
                ? "Enter a reviewer name on the Review page first"
                : "Save the decisions into the plan directory"
            }
            onClick={() => (plan.pending > 0 ? setConfirming(true) : saveToCli())}
          >
            <Send /> Save to dd2dash0
          </Button>
          <Button variant="ghost" size="sm" disabled={!sha} onClick={download}>
            <Download /> Download
          </Button>
        </div>
        {saved?.ok && (
          <p role="status" className="break-words text-xs text-body">
            Saved to {saved.file}. {saved.pending.length} panels still pending,{" "}
            {saved.skippedAlerts.length} alerts not approved. Next: dd2dash0 apply{" "}
            {saved.file.replace(/[\\/]review\.json$/, "") || "."} --approved {saved.file}
          </p>
        )}
        {saved && !saved.ok && (
          <div role="alert" className="break-words text-xs text-destructive">
            <p>Not saved: {saved.error}</p>
            {saved.problems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <Button
      disabled={noName || !sha}
      title={noName ? "Enter a reviewer name on the Review page first" : COPY.export}
      onClick={() => (plan.pending > 0 ? setConfirming(true) : download())}
    >
      <Download /> Export review.json
    </Button>
  );
}

export function ReviewerInput() {
  const { review, setReviewer } = useReport();
  return (
    <input
      value={review.reviewer}
      onChange={(e) => setReviewer(e.target.value)}
      placeholder="Reviewer name"
      aria-label="Reviewer name"
      className="h-9 w-44 rounded-md border border-input bg-surface px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
