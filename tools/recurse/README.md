# tools/recurse: plan 10 (the recursive gap protocol) as code

Build time only. `src/` never imports `tools/` and none of these tools call a model
(`tests/tools/recursive-gates.test.ts` checks both). They measure, decompose, gate and write briefs. People, or
agents that people start, do the work, and the gates decide.

```
npm run gaps     -- [--corpus <dir>] [--report <report.json>] [--include-exact-under] [--round N]   # MEASURE + DECOMPOSE
npm run gate     -- [--base-ref <ref> | --baseline <report.json>] [--allow-downgrade <item>:<reason>] [--allow-fail <test file>]
npm run recurse  -- --round N [--base <branch>] [--in-flight <lever key>] [--brief [dir]] [--post]
```

## The loop in practice
1. **Measure.** `npm run gaps` runs `dd2dash0 migrate --from datadog --input fixtures/datadog --no-import` in this
   checkout. Add `--corpus <dir>` for Ali's corpus, or `--report` to read a report someone else produced. The root
   is every item whose claim is weaker than exact-under (`--include-exact-under` adds the exact-under guesses).
2. **Decompose.** Each item's *binding causes* are the findings at its own claim level. An exact-under finding on a
   bounded item is not why it is bounded. If an item has no such finding, the cause is the certificate rule at that
   level. Causes are grouped by finding code, then by integration (metric and tag data gaps), widget type, or rule id.
   Each leaf gets a lever, read from the rule catalog (`src/rules`):
   | Lever | When | Goes to |
   |---|---|---|
   | `mapping` | metric/tag data gaps (plan 05 §7: data, not rules) | sub-agent, mapping owner reviews |
   | `rule` | a stronger catalog rule names this one (`note`/`emit`: "replaces", "uses") and its probes are answered | sub-agent, area owner reviews |
   | `probe` | the stronger rule (or this one) waits on an open probe in `src/rules/probes.ts` | the owner, on the hub |
   | `contract` | no stronger rule exists: a new rule or a claim change (plan 05 §8) | main room, catalog owner |
   | `impossible` | the rule cites maths.md §9.5 | stop: the items stay manual, with the original kept |
   Levers in one **wave** touch disjoint files, so they can run in parallel. Catalog rows (one-row edits in
   `src/rules/catalog`) are listed but don't count as overlap. `gaps.json` is fully sorted and has no timestamps,
   so the same input gives the same bytes.
3. **Delegate.** `npm run recurse -- --round N --brief` writes one brief per lever to
   `out/recurse/round-N/briefs/`. Each brief has the gap with its items, what to prove, the files, the setup
   commands, the gate command, and the two allowed returns. `--post` posts the round plan to the hub
   (`node $HUB_POST --room dash0-promql "<text>"`). `HUB_POST` defaults to the nearest `scripts/hub-post.mjs`
   above the checkout. Owners come from the workspace `NOTES.md` owners table (`NOTES_MD` overrides it). A split area
   names both owners.
4. **Gate.** `npm run gate` runs all of these and prints a pass/fail table. It exits 1 on any failure.
   - typecheck (src and tools)
   - the full suite
   - L1-L7 (`tests/ir/mappings-logic.test.ts`)
   - catalog conformance (`tests/rules/*`, `tests/cli/catalog-conformance.test.ts`)
   - **M1**: every bounded rule has an ε
   - **M2**: every ε rule is named by a fast-check test under `tests/semantics`, or listed in
     `tools/gate/m2-pending.json`. That list is reviewed and may only shrink: a new untested rule fails, and so does a
     stale entry.
   - determinism: two migrate runs, same report.json sha256
   - **per-item no-regression** against the baseline. The baseline is `--baseline`, or migrate at `--base-ref`
     (default `origin/HEAD`) in a temp worktree over the same fixtures. Every claim must stay the same or get
     stronger. A downgrade passes only with `--allow-downgrade <item id>:<reason>`.
   - the goldens and items whose output changed
   - Ali's `scripts/parity.ts` (PR #57), run as a subprocess when it exists, the DD/Dash0 keys are set and a host is
     given (`PARITY_HOST`). Otherwise it shows "skipped".

   The claim order comes from `src/ir` `worst()`, which the catalog's `compose()` uses. A placeholder
   (`unsupported`) counts as a manual claim. `--allow-fail <file>` names a test file that may fail, for example
   the two Windows-only 0600 failures in `tests/flow/flow.test.ts`. The table still lists it.
5. **Return.** A lever comes back as either a PR-ready branch with the gate table and the before/after gap table, or
   a decomposition into sub-gaps, each with a brief.
6. **Recurse.** Sub-gaps become round N+1's levers. Mark levers already in progress with `--in-flight <key>`.
7. **Merge.** The lever's owner approves and the author merges (NOTES.md). Then measure again.

## Round 2, measured now (fixtures, base `amir/claude/improve-loop` @ bfcb9b9)
`npm run recurse -- --round 2 --base amir/claude/improve-loop`:

| # | Lever | Kind | Items (alone) | Owner reviews | Wave | Files |
|---|---|---|---|---|---|---|
| 1 | `mappings/datadog/postgresql.yaml` | mapping | 26 (26) | Ali | 1 | `mappings/datadog/postgresql.yaml` |
| 2 | `mappings/datadog/redisdb.yaml` | mapping | 14 (14) | Ali | 1 | `mappings/datadog/redisdb.yaml` |
| 3 | `select.metric.derived` | rule | 4 (4) | Ali | 1 | `src/translate/query/**` |
| 4 | `mappings/datadog/nginx.yaml` | mapping | 1 (1) | Ali | 1 | `mappings/datadog/nginx.yaml` |
| 5 | `widget.unsupported` | contract | 6 (6) | Michael | hub | - |
| 6 | `alert.opt.unknown` | contract | 4 (0) | Michael | hub | - |
| 7 | `alert.threshold.recovery` | contract | 4 (0) | Michael | hub | - |
| 8 | `widget.logs` | contract | 1 (1) | Michael | hub | - |
| 9 | `fn.per_unit.counter` | contract | 1 (1) | Michael | hub | - |
| 10 | `time.unmapped.counter` | contract | 1 (0) | Michael | hub | - |
| 11 | `probe:anchored` | probe | 1 (0) | Ali | hub | - |
| 12 | `fn.anomalies` | impossible | 4 (0) | - | stop | - |

Gap tree:

| Cause (binding finding) | Scope | Items | Rule (claim, state) | Lever |
|---|---|---|---|---|
| `metric.approximate` | postgresql | 24 (24 bounded) | `select.metric.approximate` (bounded, implemented) | mapping:mappings/datadog/postgresql.yaml |
| `metric.approximate` | redis | 9 (9 bounded) | `select.metric.approximate` (bounded, implemented) | mapping:mappings/datadog/redisdb.yaml |
| `metric.approximate` | nginx | 1 (1 bounded) | `select.metric.approximate` (bounded, implemented) | mapping:mappings/datadog/nginx.yaml |
| `metric.no_equivalent` | redis | 5 (5 manual) | `metric.no_equivalent` (manual, implemented) | mapping:mappings/datadog/redisdb.yaml |
| `metric.no_equivalent` | postgresql | 2 (2 manual) | `metric.no_equivalent` (manual, implemented) | mapping:mappings/datadog/postgresql.yaml |
| `widget.unsupported` | change | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `widget.unsupported` | check_status | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `widget.unsupported` | distribution | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `widget.unsupported` | event_stream | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `widget.unsupported` | hostmap | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `widget.unsupported` | manage_status | 1 (1 unsupported) | `widget.unsupported` (manual, planned) | contract:widget.unsupported |
| `fn.anomalies` |  | 4 (4 manual) | `fn.anomalies` (manual, implemented) | impossible:fn.anomalies |
| `metric.derived` | nginx | 2 (2 manual) | `metric.derived` (manual, implemented) | rule:select.metric.derived |
| `metric.derived` | postgresql | 2 (2 manual) | `metric.derived` (manual, implemented) | rule:select.metric.derived |
| `monitor.option` | alert.opt.unknown | 4 (4 manual) | `alert.opt.unknown` (manual, implemented) | contract:alert.opt.unknown |
| `monitor.option` | alert.threshold.recovery | 4 (4 manual) | `alert.threshold.recovery` (manual, implemented) | contract:alert.threshold.recovery |
| `fn.per_unit.counter` |  | 1 (1 bounded) | `fn.per_unit.counter` (bounded, implemented) | contract:fn.per_unit.counter |
| `query.datasource` | widget.logs | 1 (1 manual) | `widget.logs` (manual, planned) | contract:widget.logs |
| `time.as_count.counter` |  | 1 (1 bounded) | `time.as_count.counter` (bounded, implemented) | probe:anchored |
| `time.unmapped.counter` |  | 1 (1 bounded) | `time.unmapped.counter` (bounded, implemented) | contract:time.unmapped.counter |

Reading it:
- The big rows are `metric.approximate`: rows the mapping tables mark approximate. That's 34 items. The mapping
  owner decides whether a row can become exact, can use a transform (R1-transform), or stays bounded honestly.
- `redisdb.yaml` is generated (`dash0-team/scripts/build-redis-mapping.mjs`), so that lever changes the
  generator, not the YAML.
- The round-1 levers don't show up here because their items are exact-under, below this root:
  - R1-topwindow: toplists are `widget.toplist.unranked`, exact-under.
  - R1-hostmetrics: the `system.*` guesses are `metric.unmapped`, exact-under.

  `npm run gaps -- --include-exact-under` shows them, as `rule:widget.toplist` and
  `mapping:mappings/datadog/system.yaml` (pass `--in-flight <key>` so they stay out of the waves).
- `probe:anchored` holds back one item here, together with another cause. On the corpus it is the counter-rule
  upgrade (maths T4).
- The contract rows are where no stronger catalog rule exists yet. They go to the catalog owner as proposals, not to
  sub-agents.

## Gate on this branch (real run)
`npm run gate -- --base-ref origin/amir/claude/improve-loop --allow-fail tests/flow/flow.test.ts`:

| Gate | Result | Detail |
|---|---|---|
| typecheck (src) | PASS | clean |
| typecheck (tools) | PASS | clean |
| full suite | PASS | 45 file(s), 684 test(s) green; allowed to fail (--allow-fail): tests/flow/flow.test.ts (2 failing: keys parses .env, env wins, merges without losing other lines, saves 0600; keys asks for missing keys, re-asks a rejected one, refuses the ingress URL, saves to .env; secrets never printed) |
| L1-L7 mapping logic | PASS | 1 file(s), 4 test(s) green |
| catalog conformance | PASS | 5 file(s), 29 test(s) green |
| M1 epsilon-attached | PASS | every bounded rule states its ε (22 rules) |
| M2 bound-tested | PASS | 1 ε rule(s) named by a property test (time.rollup.counter); 21 pending in tools/gate/m2-pending.json |
| determinism | PASS | two migrate runs, same sha256 bfe8d07fccc64992 |
| no-regression (per item) | PASS | vs origin/amir/claude/improve-loop (temp worktree, same fixtures); 0 upgraded, 0 downgraded, 0 missing, 0 new |
| goldens changed | PASS | 0 golden file(s) changed vs origin/amir/claude/improve-loop; 0 item(s) changed output |
| parity (scripts/parity.ts) | skip | skipped (scripts/parity.ts not in this checkout; Ali's PR #57) |
