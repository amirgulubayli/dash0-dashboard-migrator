# targets/dash0

Task **T7** · scope `src/targets/dash0/**` · Dash0 client. `schema.ts` is HOT (T5 and T6 build these shapes).

| File | What |
|---|---|
| `schema.ts` | `PrometheusAlertRule`, `CheckThresholds`, `DashboardDefinition`, `PersesPanel`, `GridLayout`, from Dash0's OpenAPI spec and the dash0-cli fixtures |
| `preflight.ts` | Pure checks before sending: `$__threshold` needs thresholds, duration format, id format, every layout `$ref` resolves, the 24-column grid, no unplaced panels, `kind: "Dashboard"` (never the CR form), the 256 KB body limit. `dash0Id(sourceId)` gives `dd-<slug>` |
| `client.ts` | `Dash0Client`: `POST /api/import/dashboard`, `POST /api/import/check-rule`, `GET /api/dashboards/{id}`, `GET /api/alerting/check-rules/{id}`. Bearer auth, `?dataset=`, retries 429/502/503/504 (honours `Retry-After`), `Dash0ApiError` with `traceId`. The token never appears in errors |
| `target.ts` | `importAll({dashboards, rules}, {dryRun, outDir, enableRules, config})`: preflight, then dry-run or import, then read back by id and compare (durations normalised, since Dash0 returns `1m0s`). Writes canonical payloads (dry run) and `import-manifest.json` with a sha256 per payload |

Decisions applied:
- Single-item endpoints only. The bulk check-rules call rejects the whole batch on one bad item (D-31).
- Ids are `dd-<source id>`, and import with an existing id overwrites, so re-runs update instead of duplicating.
- After every import the item is read back. `missing` means Dash0 didn't honour our id. That's how we settle the doc conflict about where a check rule's id lives: the import docs say `metadata.dash0Extensions.id`, the schema has a top-level `id` (D-32).
- Check rules are imported **disabled** unless `enableRules` (D-30).

Smoke test (one dashboard plus the high-memory rule; the 18:00 gate):
```
npx tsx --env-file=.env scripts/dash0-smoke.ts            # dry run into out/smoke/
npx tsx --env-file=.env scripts/dash0-smoke.ts --live     # import + read back
```
