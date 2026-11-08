# tools/improve: the build-time improvement loop

Plan 06 §6. The migrator stays deterministic, with no model in the translation path. This tool uses a model at
**build time** to close coverage gaps. A change it makes is accepted only if mechanical gates pass, and then a
person reviews it. `src/` never imports anything from here; `tests/improve/loop.test.ts` checks that.

```
npm run improve -- --dry-run                 # measure, rank gaps, show what round 1 would work on (no API call)
npm run improve -- --rounds 1 --budget-usd 5 # one real round (needs ANTHROPIC_API_KEY in the environment)
npm run improve -- --gap metric.unmapped:nginx
```

## One round
1. **Measure.** Run the migrator over `fixtures/datadog` (offline) and build a snapshot: per-item status, output
   hash and findings.
2. **Pick a gap.** Findings are grouped into gaps (`metric.unmapped:<integration>`, `tag.unmapped`, ...). Each gap is
   ranked by affected items, weighted by how bad their status is. The ranking is deterministic. In v0 only
   mapping-table gaps are actionable.
3. **Agent.** One Claude Opus 5.5 agent works in a fresh git worktree. It has tools to:
   - read and grep the repo;
   - fetch the upstream sources registered for the integration (Datadog `metadata.csv`, OTel receiver
     `metadata.yaml`);
   - write `mappings/datadog/<integration>.yaml`, `mappings/tags.yaml` and `tests/improve/gen-*.test.ts`, and
     nothing else;
   - measure its change and run the tests;
   - submit.
4. **Gates.** All must pass:

   | Gate | Rule |
   |---|---|
   | scope | at least one file changed, and only allowed files |
   | typecheck | `tsc --noEmit` clean |
   | tests | the whole suite is green |
   | determinism | two migrate runs give the same output hash |
   | no-regression | no item gets a worse status (see the exception below) |
   | untouched-stable | items outside the gap are byte-identical |
   | progress | the gap has fewer findings |
   | coverage | coverage doesn't drop (see the exception below) |

   The one exception: an item in the gap rested on a guess (that the Datadog name exists in Dash0 as a gauge), so
   it may drop when that guess is replaced honestly. It may drop to bounded when a researched approximate row
   replaces the guess, or further when the item now says why (`metric.no_equivalent`, `metric.derived`). Those
   items are listed in the round log for the reviewer.
5. **Pass:** commit on a local branch `improve/<gap>-<date>`. Nothing is pushed: review it, then push and open a
   draft PR. **Fail:** discard the worktree and record why in `out/improve/round-N-<gap>.json`.

The loop stops at `--rounds`, at `--budget-usd` (estimated from token usage at Opus 5.5 list prices), or after
`--patience` rounds without progress. `--keep` keeps a failed workspace for inspection.

## Not in v0
- `--depth > 1`: an agent splitting a gap across sub-agents.
- Gaps that need new translation rules (`fn.*`, `widget.*`). Those need a catalog row, a proof and evaluator
  property tests, and stay with people for now.
- Requests use server-side refusal fallbacks (`fallbacks: "default"`). Set `--max-turns` lower to cap a round
  tighter than the budget does.

## Jev (plans 08, 09 §5): off by default, suggestions only
**Status: OFF by default, pending the organisers' answer to O-15** (does using Jev at build time count against us?).
Do not switch it on for the upstream PR before that answer.

Jev is TypeSafe's decision model (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`). It lives in
`tools/jev/` and never touches the translation path: `src/` never imports `tools/` (checked by
`tests/improve/jev.test.ts` and `tests/improve/loop.test.ts`), so `migrate` output and `report.json` are
byte-identical with or without it. Everything Jev produces is labelled **suggestion (Jev)**.

Jev runs only when **all** of these hold, otherwise the loop takes the deterministic path and logs one line saying why:
- you pass `--picker jev` (J2) and/or `--jev-review` (J3), or run the `tools/jev/main.ts` CLI (J1);
- `TYPESAFE_API_KEY` is set in the environment (never in a file, never in git);
- `JEV_DISABLED` is not `1` (kill switch: `JEV_DISABLED=1` turns it off whatever the flags say).

What it does:
- **J2 planner, `--picker jev`:** Jev chooses (choice question) among the top 5 actionable gaps of the deterministic
  ranking. Pick, confidence and probabilities go in the log and in `pickedBy` of the round record.
- **J3 evidence reviewer, `--jev-review`:** after the gates pass, Jev scores (0 to 3) the evidence of every new or
  changed mapping row. Rows below 1.5 are flagged in the round result (`jevReview` in
  `out/improve/round-N-<gap>.json`, the log, and the commit message). Since the gates already passed, a flag means
  Jev and the gates disagree: worth a human look. Never a gate.
- **J1 review priority:** `npx tsx tools/jev/main.ts priority <out>/report.json [dest]` writes
  `review-priority.json` next to the report: `scores` (item id -> 0..3 urgency), the same items ranked, the model,
  and the report's `outputHash` (a different hash means stale suggestions). Exact items are skipped.
- `npx tsx tools/jev/main.ts evidence mappings/datadog/<x>.yaml` runs the J3 scoring on a whole table.

Robustness: every answer is cached in `.jev-cache/<sha256>.json` (gitignored), keyed by sha256 of
`{model, question, state}` and stored as `{model, inputHash, answeredAt, answer}`, since Jev has no seed. Re-runs
reuse the cache and ask only uncached questions. Network errors, HTTP errors, malformed answers and timeouts (30 s)
fall back to the deterministic choice (J2) or a skipped review (J3); they never stop the loop.
