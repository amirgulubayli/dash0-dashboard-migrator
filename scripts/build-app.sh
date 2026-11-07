#!/usr/bin/env bash
# Build dd2dash0 as a standalone app for this machine: one executable (no Node needed), next to it the mapping tables
# and the built web console, plus a double-clickable launcher on macOS.
#
#   bash scripts/build-app.sh            -> dist/app/dd2dash0-<os>-<arch>/ and dist/app/dd2dash0-<os>-<arch>.zip
#
# Run it: ./dist/app/dd2dash0-<os>-<arch>/dd2dash0   (no arguments = the app menu; arguments = the plain CLI)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
[ "$os" = "darwin" ] && os="macos"
[ "$arch" = "x86_64" ] && arch="x64"
NAME="dd2dash0-${os}-${arch}"
OUT="dist/app/$NAME"

echo "== building the web console"
(cd console && npx -y bun install --frozen-lockfile >/dev/null && npx -y bun run build >/dev/null)
[ -f console/.output/public/index.html ] || { echo "console build missing (console/.output/public/index.html)" >&2; exit 1; }

echo "== compiling the executable"
rm -rf "$OUT" "dist/app/$NAME.zip"
mkdir -p "$OUT"
npx -y bun build src/bin.ts --compile --minify --outfile "$OUT/dd2dash0" >/dev/null

echo "== adding mappings and the console"
cp -R mappings "$OUT/mappings"
cp -R console/.output/public "$OUT/console"

cat > "$OUT/dd2dash0.command" <<'EOF'
#!/usr/bin/env bash
# Double-click to open dd2dash0 in Terminal. Plans and a .env with credentials live in this folder.
cd "$(dirname "$0")" && ./dd2dash0
EOF
chmod +x "$OUT/dd2dash0" "$OUT/dd2dash0.command"

cat > "$OUT/README.txt" <<'EOF'
dd2dash0: migrate Datadog dashboards and monitors to Dash0 (rules and mapping tables only, no model).

Start:   double-click dd2dash0.command (macOS), or run ./dd2dash0 in a terminal.
Menu:    translate (folder or Datadog API) -> review (terminal or web UI) -> apply (dry run or live)
         -> watch an incident -> proof card.
CLI:     ./dd2dash0 --help   (every command also works non-interactively)

Credentials: put a .env file next to dd2dash0 (or export them):
  DD_API_KEY, DD_APP_KEY, DD_SITE (default datadoghq.eu)
  DASH0_API_URL, DASH0_AUTH_TOKEN, DASH0_DATASET (default "default")
They are read locally and never printed.
EOF

(cd dist/app && zip -qr "$NAME.zip" "$NAME")
echo "== done: $OUT  ($(du -sh "$OUT" | cut -f1); zip: dist/app/$NAME.zip)"
