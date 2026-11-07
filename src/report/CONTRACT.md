# CONTRACT-003: report.json v2, review.json, and the CLI ↔ web UI flow (DRAFT)

Owner: Michael (T8 + U2). Status: **DRAFT for review** by Henry (console), Amir (T7, merge train) and Ali (T4/T12 findings).
Nothing here is built yet. Code follows only after the team agrees.

## 1. Why
The review console (`console/`, Henry's U1, PR #23) reads `report.json` and writes `review.json`. Today:
- **Missing from the report:** the console needs groups with their layout, where the run came from (`run.source`), metric coverage, and an explanation for each reason code (Henry's #383).
- **No way back:** there's no path for the reviewer's decisions to the import (console U3), and no Dash0 link or verification result after import (U5).
- **Two UIs:** the live viewer (`dd2dash0 serve`) and the console are separate web apps.

## 2. Principles
1. **Additive only.** Every v1 field keeps its name, type and meaning. A v1 reader (the console's `src/lib/report.ts` as of `8c3e65a`) keeps working unchanged. `schema` becomes `"dd2dash0.report/v2"`.
2. **Deterministic.** Same input and options give byte-identical `report.json`: canonical JSON with sorted keys and a trailing newline, no timestamps. `report_sha256` is the SHA-256 of those exact bytes.
3. **The CLI decides, the UI displays.** Every number, label, explanation and review order comes from the CLI. The console computes nothing about translation. No AI and no network in either.
4. **No guessed links.** A field the CLI can't fill truthfully is `null` and never made up. That applies to `target.url` until its format is verified live.

## 3. report.json v2: what changes

### 3.1 `run` (new fields)
| Field | Type | Meaning |
|---|---|---|
| `run.source` | `{ kind: "api" \| "folder"; site: string \| null; path: string \| null }` | `api` with the Datadog site (`datadoghq.eu`), or `folder` with the `--input` path as given (relative paths stay relative, so the hash doesn't depend on the machine) |
| `run.toolCommit` | `string \| null` | git commit of the CLI build if known (env `DD2DASH0_COMMIT` or a build stamp), else `null`. Never read from the working tree at run time, which would break determinism across checkouts |
| `run.catalogHash` | `string` | SHA-256 of the canonical rule catalog (`src/rules` CATALOG): which rule version produced this report |

### 3.2 `summary` (new fields)
| Field | Type | Meaning |
|---|---|---|
| `summary.metrics` | `{ total; mapped; approximate; derived; needsTransform; noEquivalent; unmapped }` | Counts over **distinct Datadog metric names** referenced by metric queries in this run. `mapped + approximate + derived + needsTransform + noEquivalent + unmapped = total` (T1's `metricAvailability`, with approximate split from mapped by the entry's status) |
| `summary.groups` | `number` | Number of group items (§3.4) |
| `summary.reviewOrder` | `string[]` | Item ids in the order a person should review them (§3.6) |

### 3.3 Top level (new field)
| Field | Type | Meaning |
|---|---|---|
| `reasonCodes` | `Record<code, { label: string; explanation: string; catalogRule: string \| null }>` | One entry for **every** code that appears in `reason_codes` or `findings` in this file, and no others. `label` is 2–4 words for a chip. `explanation` is one or two sentences. Both come from the rule catalog (`match`/`emit`/`note`) or `FINDING_CODES`. `catalogRule` is the rule id when the code is a rule |

### 3.4 Group items (new item kind)
`items[].kind` adds `"group"`, one per Datadog group widget. Its fields:

| Field | Value |
|---|---|
| `id` | `dd-dash-<dashboard id>/<group widget id>`: the prefix of its panels' ids |
| `kind` | `"group"` |
| `title`, `dashboard` | group title, dashboard title |
| `widget_type` | `"group"` |
| `group` | `null` |
| `layout` | the Dash0 Grid section (24 columns) |
| `source_layout` | the Datadog group position (12 columns, dashboard-relative) |
| `status` | `"exact"` (structure only; groups need no review) |
| `source_queries`, `promql`, `reason_codes`, `findings` | `[]` (layout findings such as `layout.clamped` sit on the panels) |
| `certificate` | `{ rules: ["layout.group"], status: "exact", … }` |
| `target` | the dashboard's target |

Group items come **before** their panels in `items`, in file order.

### 3.5 Panel and alert items (new fields)
| Field | Type | Meaning |
|---|---|---|
| `source_layout` | `{x,y,w,h} \| null` | **Datadog** position (12 columns, relative to its group). The existing `layout` stays the **Dash0** position (24 columns, relative to its group section) |
| `group_id` | `string \| null` | id of the parent group item, or `null` for top-level widgets |
| `target.url` | `string \| null` | Link to the item in Dash0. `null` until a URL format is verified live (open probe; see §7) |
| `certificate.checks.returnsData` | `boolean \| null` | After a live import with `--verify-data`: every PromQL of the item returned at least one series over the last 1 h. `null` = not checked |
| `certificate.checks.parity` | `{ window: string; points: number; maxAbsErr: number; tolerance: number; ok: boolean } \| null` | Filled by the parity step (T10 compare script) when it runs; `null` otherwise. `tolerance` is the rule's stated ε, or the float bound for exact claims (maths.md T9) |

### 3.6 Review order (deterministic, replaces any model-based ranking)
`summary.reviewOrder` sorts reviewable items (all alerts, plus panels whose status isn't `exact`) by:
1. **Status:** `manual`, `unsupported`, `bounded`, `exact-under`.
2. **Alerts before panels** within the same status, because a wrong alert costs more than a wrong chart.
3. **More findings first.**
4. **`id`** as the tie-break.

The console shows it as "suggested order". It never reorders by anything else.

## 4. review.json (console → CLI), unchanged from console INTEGRATION.md §3
```json
{ "schema_version": "1", "report_sha256": "<sha256 of report.json bytes>", "reviewer": "name",
  "decisions": [{ "id": "<item id>", "decision": "approved" | "flagged" | "acknowledged", "note": "" }] }
```

## 5. The flow and the CLI surface (`src/cli.ts`, HOT)
```
dd2dash0 migrate --from datadog (--input <dir> | --api) --dry-run --out out   # 1. translate, write report + payloads
dd2dash0 serve --out out                                                        # 2. console at /, report at /report.json
                                                                                #    (live replay at /live); export review.json
dd2dash0 import --out out --approved out/review.json [--enable-rules] [--verify-data]   # 3. import what was approved
```

**`serve` (changed):**
- Serves the built console at `/`, the run's `report.json` at `/report.json` (the console's same-origin fetch, so nothing is written into `console/public`), and the current viewer at `/live`.
- `/events`, `/api/summary`, `/api/item` and `/api/el-token` are unchanged.
- If the console hasn't been built, `/` falls back to the viewer with a one-line notice.

**`import` (new):**
1. **Hash check.** Read `out/report.json` and `out/dash0/**` from a previous `--dry-run`. Refuse with a clear error if `sha256(report.json bytes) ≠ review.report_sha256`, if the report isn't a dry-run report, or if a decision isn't allowed for its item (console rules: approximate panel → approved|flagged; unsupported/no-equivalent → acknowledged; check rule → approved|flagged).
2. **Import per decision:**

   | Item | Decision | Import does |
   |---|---|---|
   | exact or exact-under panel | none needed | imports the translated panel |
   | bounded panel | `approved` | imports the translated panel |
   | bounded panel | `flagged` | a Markdown placeholder holding the original query, the reviewer's note and the reason codes |
   | bounded panel | none | refuses: lists the pending ids. `--allow-pending` imports them as translated |
   | manual / unsupported panel | any | already a placeholder; imported as-is |
   | check rule | `approved` | imports it (disabled unless `--enable-rules`) |
   | check rule | `flagged` / none | not imported, listed in the report |

   Placeholders are built by the same deterministic rule T5 uses (`widget.unknown` / placeholder text), plus the note.
3. **Rewrite the report.** Write a new `report.json` with `target`, `target.url`, `certificate.checks.importedReadBack` and, with `--verify-data`, `returnsData`. Its hash is new, so old decisions don't carry over.

**`migrate` without `--dry-run`** keeps today's behaviour: import everything, as in the live dry runs. `import --approved` is the reviewed path.

## 6. Compatibility and tests
- **Old fields:** a test pins every v1 field name and type against a v1 fixture.
- **Determinism:** `migrate` twice gives byte-identical v2 reports. `import` twice with the same review gives byte-identical post-import reports, apart from fields Dash0 returns.
- **Review gate tests:** a mismatched hash, a disallowed decision and pending bounded panels each fail with exit code 2 and a message naming the ids.
- **Console:** `src/lib/report.ts` maps the new fields, and its existing fixture (`cli-report.redis.json`, v1) must still parse.

## 7. Open questions
1. **Dash0 link format.** `/dashboards/<uuid>?org=<org id>` redirected to the list in our test. Needs a live probe, plus the org id from a new env var `DASH0_ORG_ID`. Until then `target.url = null`.
2. **`returnsData` window.** 1 h is enough for live Redis but not for dashboards whose data is sparse. Make it `--verify-window`? (default 1h)
3. **Henry:** is `source_layout` (12 columns) what the map wants, rather than `layout` (24)?
4. **Amir:** `import` reuses T7's `importAll` per item. Is a filtered `importAll({dashboards, rules})` call enough, or does T7 need a per-item entry point?
