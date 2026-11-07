# dash0-dashboard-migrator

`dd2dash0` migrates **Datadog dashboards and monitors into Dash0** using open standards:
- dashboards become **Perses** dashboards
- queries become **PromQL**
- monitors become **Prometheus alerting rules** with Dash0's threshold extension

Translation is **deterministic**: a Datadog query parser, rule tables and metric-name mappings do the work. No LLM rewrites configurations. Anything that can't be translated exactly is reported in the migration log, never dropped silently.

> Work in progress for the Dash0 hackathon challenge. Setup, usage and known limitations will be documented here before the PR.

## Run it as an app
```bash
npm ci && npm run app             # the app menu, from source
bash scripts/build-app.sh         # or: one standalone executable, no Node needed
./dist/app/dd2dash0-macos-arm64/dd2dash0
```
With no arguments, `dd2dash0` opens a menu:
1. translate a folder of exports, or the Datadog API;
2. review in the terminal, or open the web UI (the review console, served locally);
3. apply (a dry run, or a live import confirmed by typing `import`);
4. watch an incident;
5. write the proof card.

It shows which credentials it found (from `.env` in the current folder; names only, never values) and where the plan stands. With arguments it's the plain CLI below. `build-app.sh` puts the executable next to `mappings/`, the built console and a double-clickable `dd2dash0.command` for macOS, and zips them.

## Quick start (planned CLI)
```bash
npm ci                    # installs exactly package-lock.json and never rewrites it
cp .env.example .env      # Datadog EU API + app key, Dash0 API URL + auth token
npx tsx src/cli.ts migrate --from datadog --input fixtures/datadog --dry-run
npx tsx src/cli.ts migrate --from datadog --api
```

**No AI in the translation path.** `migrate` is rules and mapping tables only and makes no network calls except the Datadog API read (`--api`) and the Dash0 import. The optional voice narrator for `serve` (`@elevenlabs/client`, in `optionalDependencies`) is never loaded by `migrate`; `npm ci --omit=optional` leaves it out entirely.
