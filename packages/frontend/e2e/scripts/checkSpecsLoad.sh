#!/usr/bin/env bash
# Fails when any fullstack spec cannot be LOADED the way the runner container loads it.
# Playwright imports every spec file to list tests, so one unresolvable import takes the whole run down
# (it did from 0a4ec86ff to 2026-11-14: sitePages.spec.ts imported @onden/site, which only exists on the host).
# The container sees only e2e/ at /work, so this copies e2e/ (without node_modules, which is linked in)
# to a temp dir outside the repo and runs `playwright test --list` over every project there:
# anything that resolves only via ../../src, ../../../markdown or the root node_modules fails the same way.
# Cheap (seconds, no browser, no stack). Run: `npm run check:specs` in packages/frontend.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"     # …/e2e/scripts
E2E="$(cd "$HERE/.." && pwd)"
FRONTEND="$(cd "$E2E/.." && pwd)"

( cd "$FRONTEND" && npx tsx --tsconfig ../site/tsconfig.json e2e/scripts/writeHostContract.ts >/dev/null )
if [ ! -d "$E2E/node_modules/@playwright/test" ]; then
  ( cd "$E2E" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund )
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir "$SANDBOX/work"
( cd "$E2E" && tar --exclude=./node_modules --exclude='./*.png' -cf - . ) | tar -xf - -C "$SANDBOX/work"
ln -s "$E2E/node_modules" "$SANDBOX/work/node_modules"

cd "$SANDBOX/work"
# E2E_SKIP_FAULTS unset on purpose: list the faults project too. Output goes to a file so a failure shows it whole.
if ! ./node_modules/.bin/playwright test --list >"$SANDBOX/list.txt" 2>&1; then
  cat "$SANDBOX/list.txt"
  echo "✗ some e2e spec cannot be loaded in the runner layout (only e2e/ is mounted: no imports from packages/* or ../../src)."
  exit 1
fi
tail -n 2 "$SANDBOX/list.txt"
echo "✓ every e2e spec loads with only e2e/ present"
