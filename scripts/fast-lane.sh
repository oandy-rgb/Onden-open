#!/usr/bin/env bash
# The fast lane for a small frontend change (docs/agents/deploy.md): what must pass before it is deployed without the
# full suite. The full suite then covers it in the next batch.
#   scripts/fast-lane.sh [base]        base defaults to origin/main
# Runs: frontend tsc and eslint, the frontend tests that import a changed file (vitest --changed follows the module
# graph), and the markdown package's tests, whose guards scan frontend and backend source (textCut, crossPackage…).
# Not for: backend or migration changes, a change to a shared primitive (Modal, Popover, the editor core, sync), or
# one that moves an export between modules (vi.mock'ed tests break where tsc does not). Those take the full suites.
set -euo pipefail
base=${1:-origin/main}
cd "$(dirname "$0")/.."
git fetch -q origin
changed=$(git diff --name-only "$base"...HEAD)
[ -n "$changed" ] || { echo "fast-lane: nothing changed against $base"; exit 1; }
if grep -qE '^packages/backend/' <<< "$changed"; then
  echo "fast-lane: backend files changed; this needs the full backend suite:"; grep '^packages/backend/' <<< "$changed"; exit 1
fi
step() { echo "== $1"; }
cd packages/frontend
step "tsc"; NODE_OPTIONS=--max-old-space-size=5120 npx tsc --noEmit -p .
step "eslint"; npm run -s lint
# A file many modules import (lib/hex.ts) reaches most of the suite; the full suite is then the honest check.
reach=$(npx vitest list --changed "$base" --filesOnly 2> /dev/null | grep -c . || true)
if [ "$reach" -gt 150 ]; then
  echo "fast-lane: the change reaches $reach test files, which is not a small change: run the full suite (npx vitest run)"; exit 1
fi
# A frontend-only lane has no database: an explicit no-database run (scripts/lib/skipGateReporter.mjs).
step "tests importing a changed file ($reach files, no-database run)"; ONDEN_TESTS_WITHOUT_DATABASE=1 npx vitest run --changed "$base" --passWithNoTests
cd ../markdown
step "markdown + cross-package guards"; npx vitest run
echo "fast lane passed against $base"
