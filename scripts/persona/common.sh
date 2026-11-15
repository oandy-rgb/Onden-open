# Shared by boot.sh / reset.sh. Sourced, not executed.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERSONA="$REPO/scripts/persona"
LOG=/tmp/onden-boot.log
RUN=/tmp/onden-run; mkdir -p "$RUN"
PGV=16
DB_URL="postgres://onden:onden@127.0.0.1:5432/onden_test"
BASE=http://localhost:5099
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG" >&2; }
psql_admin() { PGPASSWORD=onden psql -h 127.0.0.1 -U onden -v ON_ERROR_STOP=1 -q "$@"; }

load_schema() {
  # schema.sql is a PG18 dump; PG16 only chokes on transaction_timeout.
  sed -E '/^SET transaction_timeout/d' "$REPO/packages/backend/db/schema.sql" > "$RUN/schema16.sql"
  psql_admin onden_test -f "$RUN/schema16.sql" >>"$LOG" 2>&1
}

stop_backend() {
  [ -f "$RUN/backend.pid" ] && kill "$(cat "$RUN/backend.pid")" 2>/dev/null
  fuser -k 8787/tcp >/dev/null 2>&1   # by port, not pkill -f (that would match the caller's own shell)
  rm -f "$RUN/backend.pid"; sleep 1
}

start_backend() {
  stop_backend
  ( cd "$REPO/packages/backend" && \
    DATABASE_URL="$DB_URL" PORT=8787 CORS_ORIGIN=$BASE BETTER_AUTH_URL=$BASE \
    BETTER_AUTH_SECRET=e2e-only-secret-not-for-production EMBEDDING_MODE=stub \
    ONDEN_SIGNUP=open NODE_ENV=e2e SAFE_FETCH_ALLOW_PRIVATE=1 \
    setsid nohup node dist/server.js >"$RUN/backend.log" 2>&1 < /dev/null & echo $! > "$RUN/backend.pid" )
}

wait_http() { # url, accepted-codes-regex, tries
  local c=000
  for _ in $(seq 1 "${3:-60}"); do
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)
    [[ "$c" =~ $2 ]] && return 0; sleep 1
  done; echo "last=$c" >&2; return 1
}
