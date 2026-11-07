# Live demo runbook (team dry run)

Spec: `.plans/live-migration-demo-spec.md` in the dash0-team workspace. Owner: Michael (T10).

What it shows:
1. The Datadog Redis overview dashboard and its `high_mem` monitor, with live Redis data.
2. One command, `dd2dash0 migrate --api`: it pulls both from the Datadog API, translates them with rules only, imports them into Dash0 and prints a summary.
3. The migrated dashboard in Dash0 drawing the same Redis's live data, and the `high_mem` check rule (imported disabled).
4. The same command again: the same ids are updated, nothing is duplicated, and the output hash is unchanged.

## 0. Prerequisites (once)
| What | Who |
|---|---|
| Redis + OTel collector → Dash0 (Henry's bundle) running | Ali (running on his machine) |
| `datadog-agent` container with the redisdb check in the same bundle, `DD_SITE=datadoghq.eu`. Check: `redis.mem.used` shows in Datadog's Metrics Explorer | Ali |
| Datadog `DD_API_KEY` / `DD_APP_KEY`, sent privately (never on the hub) | Ali → Michael |
| A Dash0 auth token in `thinc_bavarian_big_ben` with import + read rights | Michael (Settings → Auth Tokens) |

## 1. Build the demo branch
```bash
scripts/demo/build-demo-branch.sh
```
This merges every open PR head into the local branch `demo/dry-run` in the worktree `../demo`, wires T6 into T8's alert hook, and runs the typecheck and tests. The merged SHAs go to `../demo/out/demo/manifest.json`. On a conflict it stops and names the branches.

Known red tests until T8 switches to T6 themselves: four tests in `tests/cli/migrate.test.ts` and `serve.test.ts`. They expect the interim converter's output (status `bounded`, codes `monitor.option.<key>`, ids `dd-<id>`). They don't block the demo.

Then, in `../demo`: `cp .env.example .env` and fill in `DD_API_KEY`, `DD_APP_KEY`, `DASH0_API_URL`, `DASH0_AUTH_TOKEN`. Never paste them into chat or the hub.

## 2. Seed Datadog (idempotent)
```bash
npx tsx --env-file=.env scripts/demo/seed-datadog.ts --dry-run
npx tsx --env-file=.env scripts/demo/seed-datadog.ts
```
It creates or updates the Redis overview dashboard and the `high_mem` monitor from the fixtures, marked `[dd2dash0-demo]` / tagged `dd2dash0-demo`. It refuses a monitor whose message has an `@handle`, so nobody gets paged. It prints both Datadog URLs and writes them to `out/demo/datadog-ids.json`.

Wait about 5 minutes after the Agent starts so the Datadog panels have data.

## 3. The run
```bash
# a. preview: translate and write payloads, import nothing
npx tsx --env-file=.env src/cli.ts migrate --from datadog --api --dry-run --out out/demo
# b. the real import (check rules go in disabled, D-30)
npx tsx --env-file=.env src/cli.ts migrate --from datadog --api --out out/demo
# c. again: everything is updated in place, and the output hash is the same
npx tsx --env-file=.env src/cli.ts migrate --from datadog --api --out out/demo
# optional: the live viewer (and voice narrator, if ELEVENLABS_* is set) over the last run
npx tsx --env-file=.env src/cli.ts serve --out out/demo
```
`--api` reads every custom dashboard and monitor in the Datadog trial. Today that's just the two seeded items.

## 4. Browser checklist (Michael drives)
1. **Datadog dashboard** (URL from step 2). The memory, clients and commands panels draw lines.
2. **Terminal:** read the summary line by line:
   - panels by status
   - alerts by status
   - coverage
   - `imported N`, `read back M`
   - the output hash
3. **Dash0:** Dashboards → the migrated Redis overview. Live lines in the memory, CPU and clients panels. Placeholders for widgets with no PromQL equivalent show the original query and the reason.
4. **Dash0:** Alerting → check rules → `[Redis] High memory consumption`:
   - disabled
   - thresholds failed 90 / degraded 70
   - the subquery expression
   - the description rewritten with `{{ $value }}`
5. **Run 3c:** same ids, no duplicate dashboard or rule, the same hash.

## 5. Pass bar
1. The Dash0 dashboard draws live data.
2. Every source widget and the monitor are in the report (nothing dropped), and every non-exact panel shows its reason.
3. `high_mem` is in Dash0, disabled, with `{failed: 90, degraded: 70}`, and the read-back matches.
4. Run 2 changes nothing: same ids, same hash.

Informational only: compare 2–3 panel values side by side. Small gaps are expected, because the Agent and the collector sample Redis at different moments (maths.md §9.1, e_D).

## 6. Reset
```bash
npx tsx --env-file=.env scripts/demo/reset-dash0.ts --out out/demo          # lists what it would delete
npx tsx --env-file=.env scripts/demo/reset-dash0.ts --out out/demo --yes    # deletes only those
```
It deletes only items the last run imported whose id starts with `dd-`, read from `out/demo/dash0/import-manifest.json`. Nothing else in the shared org is touched.

## 7. When something fails
| Symptom | First check |
|---|---|
| Check-rule import 400 `id` | Dash0 rejects `id` in the import body (hub #210); T7's id scheme is being changed. Dashboards still import |
| Check-rule import 400 template | The description must parse as a Go template. T6 escapes Mustache; is T6 wired (step 1 says "wiring T6")? |
| Datadog panels empty | `agent status` on Ali's machine: is the redisdb check OK? Template variables default `*` |
| Dash0 panels empty, data arriving | Compare the panel's PromQL metric names with what the collector sends. Post a mismatch in `dash0-promql` |
| Read-back "mismatch" on dashboards | Known (hub #210): T7's normaliser differs from what Dash0 returns. Not a demo blocker |
| Merge conflict building the branch | Ask the two PR owners; don't resolve it inside the demo branch |
