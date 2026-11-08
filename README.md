# dash0-dashboard-migrator

`dd2dash0` migrates **Datadog dashboards and monitors into Dash0** using open standards:
- dashboards become **Perses** dashboards
- queries become **PromQL**
- monitors become **Prometheus alerting rules** with Dash0's threshold extension

Translation is **deterministic**: a Datadog query parser, rule tables and metric-name mappings do the work. No LLM rewrites configurations. Anything that can't be translated exactly is reported in the migration log, never dropped silently.

> Work in progress for the Dash0 hackathon challenge. Setup, usage and known limitations will be documented here before the PR.

## Download (no Node needed)
Grab the build for your machine from [Releases](https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest), or in a terminal:

```bash
# macOS, Apple silicon (M1-M4)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-arm64.tar.gz | tar xz && cd dd2dash0-macos-arm64 && ./dd2dash0
```
```bash
# macOS, Intel
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-macos-x64.tar.gz | tar xz && cd dd2dash0-macos-x64 && ./dd2dash0
```
```bash
# Linux x64 (use dd2dash0-linux-arm64 on ARM)
curl -fsSL https://github.com/amirgulubayli/dash0-dashboard-migrator/releases/latest/download/dd2dash0-linux-x64.tar.gz | tar xz && cd dd2dash0-linux-x64 && ./dd2dash0
```
Windows: download `dd2dash0-windows-x64.zip`, unzip it, and run `.\dd2dash0.exe` in PowerShell.

Each archive holds the `dd2dash0` executable, its `mappings/` folder (keep them together) and a short README. `SHA256SUMS.txt` on the release lists the checksums. If macOS refuses a browser download ("cannot be opened"), run `xattr -d com.apple.quarantine dd2dash0` once.

Maintainers: pushing a tag `v<version>` builds every target and publishes the release (`.github/workflows/release.yml`); pull requests build and smoke-test them without publishing.

## Run from source
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

Choices are arrow-key lists; the run ends with a result card and writes `report.html` (same report as a page, offline) next to `report.md`. `--browser` enters missing keys on a one-time page on this computer (127.0.0.1, secret link, closes after use; `DD2DASH0_NO_OPEN=1` prints the link without opening a browser). `--yes` runs it without prompts (keys from env/.env), `--only dashboards|monitors` narrows it. Exit codes: 0 all good, 1 something failed (see report.md), 2 refused, 3 usage or key error. Scripting commands (`plan`, `review --terminal`, `apply`, `migrate`) are listed by `--help-advanced`.

**No AI in the translation path.** Translation is rules and mapping tables only. The only network calls are the Datadog API reads, the Dash0 import and read-back, and the read-only data checks. Parked extras (the web console, live viewer and voice narrator) are in `experimental/` and are not part of the CLI.
