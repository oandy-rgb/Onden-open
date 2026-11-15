#!/usr/bin/env bash
# Run every *.integration.test.ts file ALONE, each on a freshly rebuilt database,
# and list the files that fail. The normal `npm test` shares one database across
# all files, so a test that quietly depends on data another file left behind
# passes there and fails when run by itself (a fresh checkout, a single-file
# rerun, `--sequence.seed` landing it first). This finds those.
#
#   DATABASE_URL=postgres://…/onden_test npm run test:isolated
#   JOBS=3 npm run test:isolated                 # shards; each uses its own database
#   npm run test:isolated -- src/test/foo.integration.test.ts …   # only these files
#
# Shard N runs against <name minus _test>_isoN_test (a new name per shard so
# shards never touch each other or the database you named). globalSetup drops
# and rebuilds that database before every file, so each file starts from the
# schema snapshot alone. Per-file logs: $LOG_DIR (default: a temp directory).
# Exit status is 1 when any file fails.
set -u
cd "$(dirname "$0")/.."

[[ "${DATABASE_URL:-}" =~ ^([^?]*/)([^/?]+)_test(\?.*)?$ ]] || {
  echo "DATABASE_URL must name a database ending in _test" >&2; exit 2; }
BASE_URL="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
QUERY="${BASH_REMATCH[3]:-}"
JOBS="${JOBS:-1}"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"

if [ "$#" -gt 0 ]; then FILES=("$@"); else
  mapfile -t FILES < <(find src -name '*.integration.test.ts' | sort)
fi

run_shard() {
  local shard="$1"; shift
  export DATABASE_URL="${BASE_URL}_iso${shard}_test${QUERY}"
  local f log
  for f in "$@"; do
    log="$LOG_DIR/$(echo "$f" | tr '/' '_').log"
    if npx vitest run "$f" >"$log" 2>&1; then echo "PASS $f"; else echo "FAIL $f"; fi
  done
}

SHARD_FILES=()
for ((s = 0; s < JOBS; s++)); do SHARD_FILES[s]=""; done
for i in "${!FILES[@]}"; do
  s=$((i % JOBS)); SHARD_FILES[s]+="${FILES[i]}"$'\n'
done

RESULTS="$LOG_DIR/results.txt"; : >"$RESULTS"
for ((s = 0; s < JOBS; s++)); do
  [ -n "${SHARD_FILES[s]}" ] || continue
  mapfile -t mine <<<"${SHARD_FILES[s]%$'\n'}"
  run_shard "$s" "${mine[@]}" >>"$RESULTS" &
done
wait

echo "files: $(wc -l <"$RESULTS")  passed: $(grep -c '^PASS' "$RESULTS")  failed: $(grep -c '^FAIL' "$RESULTS")"
grep '^FAIL' "$RESULTS" | sort | sed 's/^FAIL /  fails alone: /'
echo "logs: $LOG_DIR"
! grep -q '^FAIL' "$RESULTS"
