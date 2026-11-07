#!/usr/bin/env bash
# T10: build the throwaway demo branch `demo/dry-run` that merges every open PR head, so the live demo runs the
# whole pipeline before the PRs are merged. Never pushed, never a PR; rebuild it whenever a PR moves.
#
#   scripts/demo/build-demo-branch.sh            # worktree next to this one: ../demo
#   DEMO_DIR=/path scripts/demo/build-demo-branch.sh
#   HEADS="a/b c/d" scripts/demo/build-demo-branch.sh   # override the branch list
#
# Stops on a merge conflict and names the branches; it never resolves conflicts itself.
set -euo pipefail

BASE="${BASE:-feature/datadog-to-dash0}"
# Order matters: the catalog before T6, T4 before T8 (T8 is stacked on T5, T7, T2 and T4).
DEFAULT_HEADS="michael/claude/rule-catalog ali/claude/query-promql amir/claude/dash0-target amir/claude/datadog-ingest amir/claude/dashboard-perses amir/claude/cli-report michael/claude/monitor-check-rule"
HEADS="${HEADS:-$DEFAULT_HEADS}"
BRANCH="demo/dry-run"

REPO="$(git rev-parse --show-toplevel)"
DEMO_DIR="${DEMO_DIR:-$(cd "$REPO/.." && pwd)/demo}"

echo "== fetching origin"
git -C "$REPO" fetch --quiet origin

if [ -d "$DEMO_DIR" ]; then
  current="$(git -C "$DEMO_DIR" rev-parse --abbrev-ref HEAD)"
  if [ "$current" != "$BRANCH" ]; then
    echo "error: $DEMO_DIR exists but is on '$current', not $BRANCH; refusing to touch it" >&2
    exit 1
  fi
  if [ -n "$(git -C "$DEMO_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "error: $DEMO_DIR has uncommitted changes to tracked files; commit or discard them first" >&2
    exit 1
  fi
  echo "== resetting $BRANCH in $DEMO_DIR to origin/$BASE"
  git -C "$DEMO_DIR" reset --quiet --hard "origin/$BASE"
else
  echo "== creating worktree $DEMO_DIR on $BRANCH from origin/$BASE"
  git -C "$REPO" worktree add --quiet -B "$BRANCH" "$DEMO_DIR" "origin/$BASE"
fi

cd "$DEMO_DIR"
mkdir -p out/demo
manifest="out/demo/manifest.json"
{
  echo "{"
  echo "  \"base\": {\"ref\": \"$BASE\", \"sha\": \"$(git rev-parse "origin/$BASE")\"},"
  echo "  \"heads\": ["
} > "$manifest"

first=1
for head in $HEADS; do
  if ! git rev-parse --verify --quiet "origin/$head" >/dev/null; then
    echo "   skip $head (no such branch on origin; merged or renamed?)"
    continue
  fi
  sha="$(git rev-parse "origin/$head")"
  if git merge-base --is-ancestor "$sha" HEAD; then
    echo "   have $head (${sha:0:7})"
  else
    echo "== merging $head (${sha:0:7})"
    if ! git merge --quiet --no-edit -m "demo: merge $head" "origin/$head"; then
      echo "" >&2
      echo "error: merge conflict merging $head into $BRANCH:" >&2
      git diff --name-only --diff-filter=U >&2
      echo "Ask the PR owners to reconcile; this script does not resolve conflicts. ('git merge --abort' in $DEMO_DIR to clean up.)" >&2
      exit 1
    fi
  fi
  [ $first -eq 1 ] || echo "," >> "$manifest"
  printf '    {"ref": "%s", "sha": "%s"}' "$head" "$sha" >> "$manifest"
  first=0
done
printf '\n  ]\n}\n' >> "$manifest"

# Wire T6 into T8's AlertConverter hook until T8 does it itself (hub #195). Skipped when T8 already uses T6.
if [ -f src/pipeline/migrate.ts ] && [ -f src/translate/alerts/converter.ts ] && grep -q "o.alertConverter ?? interimAlertConverter" src/pipeline/migrate.ts; then
  echo "== wiring T6 (makeAlertConverter) into T8's AlertConverter hook"
  node - <<'EOF'
const fs = require("node:fs");
const p = "src/pipeline/migrate.ts";
let s = fs.readFileSync(p, "utf8");
s = s.replace("const convert = o.alertConverter ?? interimAlertConverter;", "const convert = o.alertConverter ?? (makeAlertConverter(translateMonitor) as unknown as AlertConverter);");
s = s.replace(/^(import \{ translateQuery)(, type TranslateContext \} from "\.\.\/translate\/query\/index\.js";)$/m, "$1, translateMonitor$2");
s = s.replace(/^(import \{ interimAlertConverter.*)$/m, '$1\nimport { makeAlertConverter } from "../translate/alerts/index.js";');
if (!s.includes("makeAlertConverter(translateMonitor)") || !s.includes("translateMonitor, type TranslateContext") || !s.includes('from "../translate/alerts/index.js"')) {
  console.error("warning: migrate.ts changed shape; T6 not wired, the interim converter stays");
  process.exit(0);
}
fs.writeFileSync(p, s);
EOF
  if ! git diff --quiet src/pipeline/migrate.ts; then git commit --quiet -am "demo: use T6 for alerts (makeAlertConverter)"; fi
fi

echo "== npm install"
npm install --no-audit --no-fund --silent
git checkout --quiet -- package-lock.json 2>/dev/null || true

echo "== typecheck + tests"
status=0
npm run -s typecheck || status=1
npx vitest run --reporter=dot 2>&1 | tail -6 || status=1

echo ""
echo "demo branch: $DEMO_DIR ($BRANCH @ $(git rev-parse --short HEAD)); heads recorded in $DEMO_DIR/$manifest"
[ -f .env ] || echo "next: create $DEMO_DIR/.env from .env.example (DD_API_KEY, DD_APP_KEY, DASH0_API_URL, DASH0_AUTH_TOKEN)"
if [ $status -ne 0 ]; then
  echo "WARNING: typecheck or tests are red on the demo branch. Read the failures before demoing." >&2
  exit 2
fi
