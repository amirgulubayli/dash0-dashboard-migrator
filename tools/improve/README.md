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

## Jev (plan 08): optional, suggestions only
Jev is TypeSafe's decision model. It runs only when `TYPESAFE_API_KEY` is set. It never touches `src/` or
`report.json`, and `tests/improve/loop.test.ts` checks that `src/` never imports it. Jev has no seed, so every
answer is cached in `out/jev-cache/<request sha256>.json` with the model version that gave it, and a re-run with
the same input reuses it.

- **J2, `--picker jev`:** Jev chooses among the top 5 gaps of the deterministic ranking. Its probabilities go in the
  round log. If Jev fails, the loop falls back to the deterministic pick and says so.
- **J3, after the gates pass:** Jev scores the evidence of every mapping row from 0 (weak) to 3 (strong). The scores
  go into the commit message and the round log. A row is flagged when it claims `exact` on evidence below "good", or
  `none` while a match looks likely. This is a note for the reviewer, never a gate.
- **J1, for the console:** `npx tsx tools/jev/main.ts priority <out>/report.json` writes
  `report.review-priority.json`, the non-exact items ranked by review urgency and tied to the report's `outputHash`.
  Henry's console can show it as "Suggested review order (Jev)".
- `npx tsx tools/jev/main.ts evidence mappings/datadog/<x>.yaml` runs J3 on any mapping table.

First live run (jev-1.14.0, fixtures):
- **J2** picked `metric.unmapped:postgresql` with probability 0.94.
- **J3** scored the agent's 6 Postgres rows: the exact rows 2.29 to 2.66, the approximate rows about 1.4, none
  flagged.
- **J1** ranked 102 items. Average score by status: manual 2.82, unsupported 2.42, bounded 1.96, exact-under 1.52.
  Copied text notes came last.
