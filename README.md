# dash0-dashboard-migrator

`dd2dash0` migrates **Datadog dashboards and monitors into Dash0** using open standards:
- dashboards become **Perses** dashboards
- queries become **PromQL**
- monitors become **Prometheus alerting rules** with Dash0's threshold extension

Translation is **deterministic**: a Datadog query parser, rule tables and metric-name mappings do the work. No LLM rewrites configurations. Anything that can't be translated exactly is reported in the migration log, never dropped silently.

> Work in progress for the Dash0 hackathon challenge. Setup, usage and known limitations will be documented here before the PR.

## Quick start
```bash
npm ci
npx tsx src/cli.ts        # or `dd2dash0` once built
```
That's the whole flow. It:
1. finds your keys in the environment or `./.env`, asks for any that are missing (Datadog API key, application key and site; Dash0 API URL, auth token and dataset), checks them, and offers to save them to `./.env` (mode 600);
2. translates every Datadog dashboard and monitor;
3. asks one question for all approximate panels and one per monitor (anything it can't translate becomes a placeholder panel holding the original query);
4. imports into Dash0 (check rules go in **disabled**);
5. reads every item back from Dash0 and checks the last hour of data against Datadog;
6. prints **translated · landed · live · success %** and writes `dd2dash0-run/<time>/report.md`, then asks whether to enable the approved rules.

`--yes` runs it without prompts (keys from env/.env), `--only dashboards|monitors` narrows it. Exit codes: 0 all good, 1 something failed (see report.md), 2 refused, 3 usage or key error. Scripting commands (`plan`, `review --terminal`, `apply`, `migrate`) are listed by `--help-advanced`.

**No AI in the translation path.** Translation is rules and mapping tables only. The only network calls are the Datadog API reads, the Dash0 import and read-back, and the read-only data checks. Parked extras (the web console, live viewer and voice narrator) are in `experimental/` and are not part of the CLI.
