#!/usr/bin/env bash
# Run every test file this branch added or changed ALONE, N times in a row, and stop at the first failure.
#   scripts/repeat-changed-tests.sh [N]          # N defaults to 5 (or $REPEAT)
#   BASE=origin/main scripts/repeat-changed-tests.sh 10
# Finds *.test.ts(x) files that differ from `git merge-base HEAD $BASE` (committed, staged, unstaged or untracked)
# in packages/{backend,frontend,markdown,site,contract}. A flaky test passes some runs and fails others, so one
# green run proves little; this catches it before merge (docs/agents/testing.md).
# Backend tests need a database: DATABASE_URL must name a *_test database; with ONDEN_DB_DRIVER unset the script
# uses PGlite, like the cloud verification runs.
# Needs bash 4 (mapfile). Skipped on purpose: *.fuzz.test.ts (vitest's default config excludes them; `npm run test:fuzz`
# runs them), and anything outside packages/{backend,frontend,markdown,site,contract}. packages/frontend/test-astro
# files run with their own config (vitest.astro.config.ts). vitest filters by substring, so `a.test.ts` also runs a
# sibling `a.test.tsx`; the script says so when that happens.
set -uo pipefail
(( BASH_VERSINFO[0] >= 4 )) || { echo "bash 4 or newer is needed (mapfile); on macOS: brew install bash" >&2; exit 2; }
cd "$(dirname "$0")/.."
runs=${1:-${REPEAT:-5}}
[[ "$runs" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 [runs>=1]" >&2; exit 2; }
base_ref=${BASE:-origin/main}
base=$(git merge-base HEAD "$base_ref") || { echo "no merge base with $base_ref (git fetch origin?)" >&2; exit 2; }

mapfile -t files < <({ git diff --name-only --diff-filter=AMR "$base"; git ls-files --others --exclude-standard; } \
  | grep -E '^packages/(backend|frontend|markdown|site|contract)/.*\.test\.tsx?$' | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)

kept=()
for f in "${files[@]}"; do
  if [[ "$f" == *.fuzz.test.* ]]; then echo "skip $f (a fuzz test: run it with npm run test:fuzz)"; else kept+=("$f"); fi
done
files=("${kept[@]+"${kept[@]}"}")

if [ ${#files[@]} -eq 0 ]; then echo "No test files changed since $base_ref; nothing to repeat."; exit 0; fi
echo "Repeating ${#files[@]} changed test file(s) $runs times each (base ${base:0:9})"

export ONDEN_DB_DRIVER=${ONDEN_DB_DRIVER:-pglite}
export DATABASE_URL=${DATABASE_URL:-postgres://x@localhost/onden_cloud_test}
for f in "${files[@]}"; do
  pkg=${f#packages/}; pkg=${pkg%%/*}; rel=${f#packages/$pkg/}
  config=()
  [[ "$rel" == test-astro/* ]] && config=(--config vitest.astro.config.ts)
  [ -f "${f}x" ] && echo "note: $rel also runs ${rel}x (vitest matches by substring)"
  for ((i = 1; i <= runs; i++)); do
    echo "== $f  run $i/$runs"
    if ! (cd "packages/$pkg" && npx vitest run "${config[@]+"${config[@]}"}" "$rel"); then
      echo "FAILED: $f on run $i of $runs (passed $((i - 1)) before it) - a flaky test needs its cause found, not a rerun" >&2
      exit 1
    fi
  done
done
echo "All ${#files[@]} changed test file(s) passed $runs times each."
