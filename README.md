# dash0-dashboard-migrator

`dd2dash0` migrates **Datadog dashboards and monitors into Dash0** using open standards:
- dashboards become **Perses** dashboards
- queries become **PromQL**
- monitors become **Prometheus alerting rules** with Dash0's threshold extension

Translation is **deterministic**: a Datadog query parser, rule tables and metric-name mappings do the work. No LLM rewrites configurations. Anything that can't be translated exactly is reported in the migration log, never dropped silently.

> Work in progress for the Dash0 hackathon challenge. Setup, usage and known limitations will be documented here before the PR.

## Quick start (planned CLI)
```bash
npm ci                    # installs exactly package-lock.json and never rewrites it
cp .env.example .env      # Datadog EU API + app key, Dash0 API URL + auth token
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run
npx tsx src/cli.ts migrate --from datadog --api
```

**No AI in the translation path.** `migrate` is rules and mapping tables only and makes no network calls except the Datadog API read (`--api`) and the Dash0 import. The optional voice narrator for `serve` (`@elevenlabs/client`, in `optionalDependencies`) is never loaded by `migrate`; `npm ci --omit=optional` leaves it out entirely.
