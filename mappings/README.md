# mappings (T1, HOT)

Schema and loader: `src/ir/mappings.ts`. Format changes need a CONTRACT.

- `datadog/<integration>.yaml`: Datadog metric → `{otel, labels, ddKind, otelKind, unit, status, derived?, note}`.
  - `status`: `exact` | `approximate` | `none` (no equivalent: the panel becomes a placeholder with a finding).
  - `ddKind` says how **Datadog stores** the metric (gauge | rate | count | distribution).
  - `otelKind` says how the **OTel receiver emits** it (gauge | counter | updowncounter | histogram).
  - A kind change (Datadog `rate` → OTel `counter`) makes the translator insert `rate()` (D-18).
  - `labels` selects series of a shared OTel metric, e.g. `redis.cpu.sys` → `redis.cpu.time{state="sys"}`.
- `tags.yaml`: Datadog tag → Dash0 PromQL label (OTel attribute, dots → underscores).

`datadog/redisdb.yaml` is **generated**. Don't edit it by hand. Regenerate from the dash0-team workspace:
```
node scripts/build-redis-mapping.mjs <fork>/mappings/datadog/redisdb.yaml
```
Its sources (Datadog check constants, metadata.csv, OTel receiver metadata v0.164.0, the research crosswalk) are in the workspace at `docs/research/sources/redisdb/`. Current totals: 271 metrics: 39 exact, 22 approximate, 5 derived, 205 no equivalent. All 24 metrics used by the Redis overview dashboard and the high-memory monitor are covered, and 18 of them have an equivalent.
