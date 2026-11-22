#!/usr/bin/env bash
# Full-stack e2e — real browser → nginx → Astro SSR → Hono API → Postgres,
# against an isolated, ephemeral stack (compose.e2e.yaml) whose Postgres is
# onden_test. NEVER touches the real onden. Self-provisions a user (open
# signup), creates a node through the wired stack, and asserts the
# events->hash->blobs version + the S2 URL location — then tears the stack down.
#
# Usage:  packages/frontend/e2e/fullstack/run.sh [playwright-args…]
#         Extra args go straight to `playwright test` — e.g.
#           run.sh fullstack/dailyDriver.spec.ts        (one spec)
#           run.sh --grep @critical                     (the CI PR subset)
#         TOUR=1, USERTOUR=1, PROBE=1, PROBE_SCALE=1 (and SCALE_TIERS) reach
#         the runner, enabling the ad-hoc tour and probe specs.
#         E2E_REQUIRE_ADMIN=1 turns the "needs admin; reset the stack" skips
#         into hard failures (CI mode; see fullstack/helpers.ts requireAdmin).
#         With no args the whole suite runs INCLUDING the fault-injection
#         project (`@faults`, minutes long); E2E_SKIP_FAULTS=1 leaves it out.
#         `--grep @critical` and other subsets never pull faults in.
# Env:    E2E_PROJECT  compose project name (default onden-e2e)
#         E2E_PORT     host port of the nginx entrypoint (default 5099)
#         E2E_HOST_OUT host dir for failure screenshots (default /tmp/pw-host-out;
#                      suffixed with the project when E2E_PROJECT is not default)
#         E2E_STALE_HOURS  age after which a still-running runner left behind by
#                      an interrupted run counts as orphaned (default 6)
#         Two sessions on one host need DIFFERENT E2E_PROJECT and E2E_PORT, e.g.
#         E2E_PROJECT=onden-e2e-b E2E_PORT=5100 run.sh (see e2e/README.md).
#
# Runner containers — ownership rules (this host is shared by several sessions):
#   * Every runner this script starts carries two labels:
#       onden-e2e-owner=run.sh          (fixed: "started by this script")
#       onden-e2e-run=<pid>-<epoch>     (unique per execution)
#   * On exit/interrupt we remove ONLY containers with this execution's
#     onden-e2e-run label.
#   * At start we also sweep leftovers of earlier, killed executions: containers
#     labelled onden-e2e-owner=run.sh that are stopped (exited/dead/created) or
#     have been running longer than E2E_STALE_HOURS. A younger running one may
#     be another session's live run and is left alone.
#   * Unlabelled containers (other tools, other people's Playwright images,
#     runners from before this labelling) are never touched.
#         Specs and helpers must not import packages/* or ../../src (only e2e/ is mounted at /work);
#         `npm run check:specs` (packages/frontend) lists every spec in that layout and fails if one cannot load.
# Needs:  docker + node/npm. Writes e2e/fullstack.png (gitignored). ~minutes
#         on first run (image builds); cached after.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"     # …/e2e/fullstack
E2E="$(cd "$HERE/.." && pwd)"             # …/e2e
REPO="$(cd "$E2E/../../.." && pwd)"       # repo root
COMPOSE="$REPO/compose.e2e.yaml"
PROJECT="${E2E_PROJECT:-onden-e2e}"
PORT="${E2E_PORT:-5099}"
IMAGE="mcr.microsoft.com/playwright:v1.60.0-noble"
BASE="http://localhost:$PORT"
STALE_HOURS="${E2E_STALE_HOURS:-6}"
RUN_ID="$$-$(date +%s)"
OWNER_LABEL="onden-e2e-owner=run.sh"
RUN_LABEL="onden-e2e-run=$RUN_ID"
# compose.e2e.yaml reads these (host port + the origins auth checks against).
export E2E_PORT="$PORT"

# Remove the runner(s) THIS execution started (matched by its unique run label).
remove_own_runners() {
  local ids
  ids="$(docker ps -aq --filter "label=$RUN_LABEL" 2>/dev/null || true)"
  [ -z "$ids" ] && return 0
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null 2>&1 || true
}

# Sweep runners left by earlier, killed executions of this script (see the
# ownership rules at the top). Best-effort: a clean host is a no-op.
sweep_orphaned_runners() {
  local now line id state started started_epoch victims=""
  now="$(date +%s)"
  while IFS=' ' read -r id state; do
    [ -z "$id" ] && continue
    case "$state" in
      running|restarting|paused)
        started="$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || true)"
        # GNU date parses the RFC3339 timestamp; if it cannot, keep the container.
        started_epoch="$(date -d "$started" +%s 2>/dev/null || true)"
        [ -z "$started_epoch" ] && continue
        [ $(( now - started_epoch )) -gt $(( STALE_HOURS * 3600 )) ] || continue
        ;;
    esac
    victims="$victims $id"
  done < <(docker ps -a --filter "label=$OWNER_LABEL" --format '{{.ID}} {{.State}}' 2>/dev/null || true)
  [ -z "$victims" ] && return 0
  echo "▸ removing orphaned e2e runner container(s) from earlier runs:$victims"
  # shellcheck disable=SC2086
  docker rm -f $victims >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  # A failed run prints what the server itself reported as unexpected: a test that got a 500 shows only
  # {"error":"internal"}, and the stack (with its log) is gone a line later.
  if [ "$status" -ne 0 ]; then
    echo "▸ server errors during this run (unhandled route errors, at most 200 lines):"
    docker compose -f "$COMPOSE" -p "$PROJECT" logs --no-color 2>/dev/null | grep -A 14 "unhandled route error" | head -200 || true
  fi
  remove_own_runners
  docker compose -f "$COMPOSE" -p "$PROJECT" down -v >/dev/null 2>&1 || true
}
# Robust teardown even on failure / Ctrl-C: EXIT covers normal + `set -e` exits;
# INT/TERM cover an interrupted run so a killed script still tears down + cleans its runner.
trap cleanup EXIT INT TERM

# Sweep orphaned runners from a prior aborted run BEFORE we start, so they
# aren't competing for CPU with this run's stack build + suite.
sweep_orphaned_runners

echo "▸ building + starting the isolated full-stack (onden_test)…"
# Start from a CLEAN volume: a leftover stack (e.g. an interrupted ad-hoc run)
# carries its signed-up users, so the suite's global-setup user would not be
# the FIRST human → editor role → every owner-gated call 403s across 7 specs.
docker compose -f "$COMPOSE" -p "$PROJECT" down -v >/dev/null 2>&1 || true
# Something still answering on our port after our own stack is down belongs to
# someone else (another session's stack, a dev server): fail with a pointer
# instead of an opaque "port is already allocated" from compose.
if curl -s -o /dev/null --max-time 2 "$BASE/"; then
  echo "port $PORT is already serving something that is not this project ($PROJECT)."
  echo "Pick another: E2E_PROJECT=onden-e2e-b E2E_PORT=5100 $0 …"
  exit 1
fi
docker compose -f "$COMPOSE" -p "$PROJECT" up -d --build

# Wait for /api/bootstrap == 200, which is true only once the backend has
# finished migrate() — including the default-workspace seed migrate() now
# reconciles every boot. No manual seed here: the e2e exercises the SAME boot
# path as a real `docker compose up`, so a regression in that seed fails here.
# Readiness via /api/bootstrap (nginx proxies /api/*; /health is not proxied).
# The server only starts listening AFTER migrate() runs (index.ts: migrate()
# precedes serve()), so any backend HTTP response implies schema + default-
# workspace seed are done. Accept 200 OR 401: bootstrap now requires auth, and
# a 401 still proves the backend is up + migrated (the gate is responding).
echo "▸ waiting for the backend (GET /api/bootstrap responds 200/401)…"
code=000
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$BASE/api/bootstrap" || true)
  { [ "$code" = "200" ] || [ "$code" = "401" ]; } && break
  sleep 2
done
[ "$code" = "200" ] || [ "$code" = "401" ] && code="200" # normalize for the check below
[ "$code" = "200" ] || { echo "backend never became ready (last: $code)"; docker compose -f "$COMPOSE" -p "$PROJECT" logs --tail 60; exit 1; }

if [ ! -d "$E2E/node_modules/@playwright/test" ]; then
  echo "▸ installing pinned playwright + @playwright/test from lockfile (browsers come from the image)…"
  ( cd "$E2E" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund )
fi

# Specs import nothing from packages/*: the container mounts only e2e/. The few workspace values they need
# (client protocol, default site design) are generated here on the host, from source, into e2e/fullstack/generated/.
( cd "$E2E/.." && npx tsx --tsconfig ../site/tsconfig.json e2e/scripts/writeHostContract.ts >/dev/null )

if [ -n "${E2E_SKIP_FAULTS:-}" ]; then FAULTS_NOTE="skipped (E2E_SKIP_FAULTS)"; else FAULTS_NOTE="in the default selection"; fi
echo "▸ running the full-stack suite on $BASE (compose project $PROJECT; @faults project: $FAULTS_NOTE)…"
# global-setup self-provisions a user (open signup) + dismisses onboarding;
# specs reuse that storageState. Browsers come from the image; outputs go to
# /tmp (the bind mount runs under a non-root --user).
# Mirror the in-container outputDir (/tmp/pw-output) to the host so failure
# screenshots + DOM snapshots survive the container exit — otherwise they vanish
# with it and a failure can't be inspected after the fact.
if [ "$PROJECT" = "onden-e2e" ]; then HOSTOUT_DEFAULT="/tmp/pw-host-out"; else HOSTOUT_DEFAULT="/tmp/pw-host-out-$PROJECT"; fi
HOSTOUT="${E2E_HOST_OUT:-$HOSTOUT_DEFAULT}"; rm -rf "$HOSTOUT" 2>/dev/null || true; mkdir -p "$HOSTOUT"
docker run --rm --network host \
  --label "$OWNER_LABEL" --label "$RUN_LABEL" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_BASE="$BASE" -e E2E_SKIP_FAULTS="${E2E_SKIP_FAULTS:-}" \
  -e E2E_REQUIRE_ADMIN="${E2E_REQUIRE_ADMIN:-}" \
  -e TOUR="${TOUR:-}" -e USERTOUR="${USERTOUR:-}" \
  -e PROBE="${PROBE:-}" -e PROBE_SCALE="${PROBE_SCALE:-}" -e SCALE_TIERS="${SCALE_TIERS:-}" \
  -v "$E2E:/work" -w /work \
  -v "$HOSTOUT:/tmp/pw-output" \
  "$IMAGE" ./node_modules/.bin/playwright test "$@"
