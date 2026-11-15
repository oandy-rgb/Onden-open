#!/usr/bin/env bash
# The guard lane: the cheap checks every merge must pass, whatever else it ran (docs/agents/deploy.md).
#   scripts/guard-lane.sh
# Runs, one at a time: the markdown package's tests (its guards scan frontend and backend source), the site
# package's tests, the backend lint (the promise rules and the route-input rule only fail a PR here), the backend and frontend guard folders, the unused-code check (scripts/unusedCode.mjs: a production file nobody imports,
# an export nobody uses; about two seconds), the third-party notices check (THIRD_PARTY_NOTICES.md matches the lockfile),
# and the ratchet and change-note checks.
# A PR that ran only its own package's suite can still break these: on 2026-11-10 main carried a stale generated
# types file, five red markdown guards and a red site test, each merged by a PR whose own suite was green.
# Not a replacement for the full suites: it checks that nobody's rules were broken, not that the change works.
set -uo pipefail
cd "$(dirname "$0")/.."
failed=()
step() {
  local name=$1; shift
  echo "== $name"
  local started=$SECONDS
  if "$@"; then echo "-- $name: passed ($((SECONDS - started))s)"; else echo "-- $name: FAILED ($((SECONDS - started))s)"; failed+=("$name"); fi
}
in_package() { local dir=$1; shift; (cd "packages/$dir" && "$@"); }
step "markdown tests + cross-package guards" in_package markdown npx vitest run
step "site tests" in_package site npx vitest run
step "pairing typecheck + tests" in_package pairing sh -c "npx tsc --noEmit && npx vitest run"
step "relay typecheck + tests" in_package relay sh -c "npx tsc --noEmit && npx vitest run"
step "backend lint" in_package backend npm run -s lint
# The guard folders need no database: say so, or the skip gate (scripts/lib/skipGateReporter.mjs) fails the run.
NO_DB=ONDEN_TESTS_WITHOUT_DATABASE=1
step "backend guards (no-database run)" in_package backend env $NO_DB npx vitest run src/test/guards
step "frontend guards (no-database run)" in_package frontend env $NO_DB npx vitest run src/test/guards
step "unused code" npm run -s unused:check
step "third-party notices" npm run -s notices:check
step "ratchet" npm run -s ratchet:check
step "change notes" npm run -s changes:check
if [ ${#failed[@]} -gt 0 ]; then
  echo "guard lane FAILED: ${failed[*]}"; exit 1
fi
echo "guard lane passed"
