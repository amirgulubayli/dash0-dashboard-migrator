dd2dash0: migrate Datadog dashboards and monitors to Dash0
==========================================================

Run it (macOS / Linux):   ./dd2dash0
Run it (Windows):         .\dd2dash0.exe        (in PowerShell or Windows Terminal)

It asks for your Datadog API key, application key and site, and your Dash0 API URL, auth token and dataset (or
reads them from the environment or a .env file in the folder you run it from), migrates every dashboard and monitor,
and writes a report to dd2dash0-run/<time>/report.md.

  --yes              no questions (keys from the environment or .env)
  --only <what>      dashboards | monitors
  --help             all options

Keep the mappings/ folder next to the executable: it holds the metric and tag mapping tables.
Translation is deterministic (parsers, rules and mapping tables); no AI model is involved.

macOS: if you downloaded the archive in a browser and macOS says the app "cannot be opened", run once:
  xattr -d com.apple.quarantine dd2dash0
(Downloading with curl, as in the project README, avoids this.)

Source: https://github.com/amirgulubayli/dash0-dashboard-migrator
