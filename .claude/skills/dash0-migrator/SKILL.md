---
name: dash0-migrator
description: Working rules for the dd2dash0 Datadog -> Dash0 migrator repo (hackathon). Load before writing or changing any code under src/, mappings/ or fixtures/, before picking up a task T0-T8, or when touching IR types, CLI flags or translation rules.
---

# dash0-migrator: how to work in this repo

Read first, in this order:
1. `CLAUDE.md`: the brief's hard rules, Dash0 API facts, translation rule table.
2. `dash0-team/plans/00-architecture.md`: pipeline, task board (who owns what), module interfaces (section 4).
3. The README of the module you're working in (`src/<module>/README.md`).
4. `dash0-team/CONTRACTS.md`: recent interface changes.

## Non-negotiables
- **Deterministic translation only.** No LLM, no network calls in `src/parse`, `src/translate`,
  `src/validate`. Parsers, rule tables and mapping files only. Breaking this disqualifies the team.
- **Never drop functionality silently.** Anything not translated exactly produces a `Finding`
  (`approximate` or `manual`, with a stable `code` and the `original` fragment). Unsupported widgets
  become Markdown panels holding the original. Untranslatable alerts still produce a manual finding.
- **Don't guess Dash0 schemas.** Perses panel kinds, datasource blocks and check-rule fields come from
  the golden exports in `fixtures/dash0/` (task T0). If they're missing, stop and say so. Don't make them up.
- **The check-rule import is all-or-nothing and not idempotent.** Validate every rule (lezer-promql)
  before T7 sends a batch. Never re-run imports blindly.
- **Secrets:** `.env` only. Never commit keys, `node_modules/`, `dist/`, `out/`.

## Scope discipline (two people share this repo)
- Only edit paths in **your** task's scope (task board, plan section 2). If you need a change elsewhere,
  ask the owner or leave a stub and a note.
- **HOT files**: `src/ir/**`, `mappings/**` format, `src/cli.ts` flags, `src/targets/dash0/schema.ts`.
  Changing them needs a CONTRACT entry in `dash0-team/CONTRACTS.md` first, and one commit that updates
  all callers. Never rename shared fields silently.
- To claim a task, edit the Owner column in the plan, in its own commit.

## Code conventions
- TypeScript strict, ESM, Node ≥ 22. Relative imports end in `.js`.
- Prefer pure functions: (input IR, ctx) → {output, findings}. I/O lives only in `sources/*` and `targets/*`.
- Build PromQL as structure, then print it. Validate with `@prometheus-io/lezer-promql` in tests.
- Metric selection in Dash0: `{otel_metric_name="redis.clients.connected", ...}`. Label names use
  underscores. Unmapped metric → keep the DD name and emit `metric.unmapped` (approximate).
- Use `metadata.csv` metric_type (gauge/count/rate) to decide `rate` / `increase` / raw.

## Tests
- vitest, files in `tests/<module>/*.test.ts`. TDD from `fixtures/datadog/` (see its README for what each fixture covers).
- Each translation rule gets a test that asserts the **exact** output string plus the expected status.
- Before finishing: `npm run typecheck && npm test`. Report failures honestly.

## Run
```bash
npm install
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run --out out/
npm test
```

## Finding codes (extend, don't rename)
`parse.error`, `metric.unmapped`, `tag.unmapped`, `fn.<name>.approx`, `fn.<name>.unsupported`,
`widget.unsupported`, `datasource.unsupported` (logs, security, ...), `alert.anomalies`,
`alert.type.unsupported`, `layout.autoflow`, `variable.unsupported`.
