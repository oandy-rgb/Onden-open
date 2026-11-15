#!/usr/bin/env bash
# One command from a fresh cloud sandbox to a ready http://localhost:5099 stack.
# Idempotent: every step is skipped when already done. Services run detached
# (setsid) and survive this script. Log: /tmp/onden-boot.log. Last line: READY | FAILED.
# Native path (no docker): Postgres 16 + pgvector + pgroonga built from source,
# backend + Astro SSR via node, nginx on :5099. See README.md for why not docker.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
T0=$(date +%s)
fail() { log "FAILED: $*"; echo "FAILED: $* (see $LOG)"; exit 1; }
step() { log "▸ $*"; }
cd "$REPO" || exit 1
export DEBIAN_FRONTEND=noninteractive
SUDO=""; [ "$(id -u)" != 0 ] && SUDO="sudo"
pgsu() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }

# 1. apt packages (postgres 16, build deps, groonga, nginx)
if ! dpkg -s postgresql-server-dev-16 libgroonga-dev nginx >/dev/null 2>&1; then
  step "apt install postgres/groonga/nginx"
  $SUDO apt-get update -qq >>"$LOG" 2>&1
  $SUDO apt-get install -y -qq postgresql-16 postgresql-server-dev-16 build-essential flex bison \
    libreadline-dev zlib1g-dev libgroonga-dev libmsgpack-dev pkg-config nginx >>"$LOG" 2>&1 || fail "apt install"
  $SUDO service nginx stop >>"$LOG" 2>&1 || true   # default site would sit on :80; we run our own
fi

# 2. extensions built from source (pgvector 0.8.2, PGroonga 3.1.0 vs apt groonga 13.1)
EXT=$(pg_config --pkglibdir 2>/dev/null || /usr/lib/postgresql/$PGV/bin/pg_config --pkglibdir)
SRC=/tmp/onden-ext-src; mkdir -p $SRC
PGC=/usr/lib/postgresql/$PGV/bin/pg_config
[ -f "$EXT/vector.so" ] || { step "build pgvector"
  [ -d $SRC/pgvector ] || git clone -q --depth 1 --branch v0.8.2 https://github.com/pgvector/pgvector $SRC/pgvector >>"$LOG" 2>&1
  (cd $SRC/pgvector && make -j4 PG_CONFIG=$PGC && $SUDO make install PG_CONFIG=$PGC) >>"$LOG" 2>&1 || fail "pgvector build"; }
[ -f "$EXT/pgroonga.so" ] || { step "build PGroonga"
  [ -d $SRC/pgroonga ] || git clone -q --depth 1 --branch 3.1.0 --recurse-submodules --shallow-submodules https://github.com/pgroonga/pgroonga $SRC/pgroonga >>"$LOG" 2>&1
  (cd $SRC/pgroonga && make -j4 HAVE_MSGPACK=1 PG_CONFIG=$PGC && $SUDO make install PG_CONFIG=$PGC) >>"$LOG" 2>&1 || fail "pgroonga build"; }

# 3. Postgres cluster: preload pg_stat_statements, role onden/onden, DB onden_test + schema
step "postgres"
if ! pg_conftool $PGV main show shared_preload_libraries 2>/dev/null | grep -q '^pg_stat_statements$'; then
  $SUDO pg_conftool $PGV main set shared_preload_libraries 'pg_stat_statements' >>"$LOG" 2>&1
  $SUDO pg_ctlcluster $PGV main stop >>"$LOG" 2>&1 || true
fi
pg_lsclusters | grep -q online || $SUDO pg_ctlcluster $PGV main start >>"$LOG" 2>&1 || fail "postgres start"
for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
pgsu psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='onden'" | grep -q 1 || \
  pgsu psql -q -c "CREATE ROLE onden SUPERUSER LOGIN PASSWORD 'onden'" >>"$LOG" 2>&1
pgsu psql -qtAc "SELECT 1 FROM pg_database WHERE datname='onden_test'" | grep -q 1 || \
  pgsu psql -q -c "CREATE DATABASE onden_test OWNER onden" >>"$LOG" 2>&1
if [ "$(psql_admin onden_test -tAc "SELECT to_regclass('public.actors') IS NOT NULL")" != t ]; then
  step "load schema.sql"; load_schema || fail "schema load"
fi

# 4. node deps + builds (skipped when outputs exist; delete dist/ to force)
[ -d node_modules/.package-lock.json ] || [ -f node_modules/.package-lock.json ] || { step "npm ci"; npm ci --no-audit --no-fund >>"$LOG" 2>&1 || fail "npm ci"; }
[ -f packages/markdown/dist/index.js ] || { step "build markdown"; npm run build --workspace=packages/markdown >>"$LOG" 2>&1 || fail "markdown build"; }
[ -f packages/backend/dist/server.js ] || { step "build backend"; npm run build --workspace=packages/backend >>"$LOG" 2>&1 || fail "backend build"; }
[ -f packages/frontend/dist/server/entry.mjs ] || { step "build frontend (PUBLIC_API_BASE_URL empty = same-origin)"
  PUBLIC_API_BASE_URL= npm run build --workspace=packages/frontend >>"$LOG" 2>&1 || fail "frontend build"; }

# 5. services
step "services"
if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:8787/api/bootstrap; then start_backend; fi
if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:4321/; then
  ( cd "$REPO/packages/frontend" && HOST=127.0.0.1 PORT=4321 SSR_API_URL=http://localhost:8787 \
    setsid nohup node dist/server/entry.mjs >"$RUN/frontend.log" 2>&1 < /dev/null & echo $! > "$RUN/frontend.pid" )
fi
if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:5099/api/bootstrap; then
  [ -f "$RUN/nginx.pid" ] && kill "$(cat "$RUN/nginx.pid")" 2>/dev/null
  mkdir -p $RUN/nginx-body; nginx -c "$PERSONA/nginx.conf" >>"$LOG" 2>&1 || fail "nginx start"
fi
wait_http $BASE/api/bootstrap '^401$' 120 || fail "backend/nginx not ready (GET /api/bootstrap != 401); see $RUN/backend.log"
wait_http $BASE/ '^200$' 60 || fail "frontend not serving / through nginx; see $RUN/frontend.log"

# 6. playwright (pinned like e2e) + chromium
if [ ! -d "$PERSONA/node_modules/playwright" ]; then
  # Match the sandbox's preinstalled browser build (/opt/pw-browsers); cdn.playwright.dev is blocked.
  PWV=$(playwright --version 2>/dev/null | awk '{print $2}'); PWV=${PWV:-1.63.0}
  step "npm i playwright@$PWV"; (cd "$PERSONA" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save --no-audit --no-fund playwright@$PWV) >>"$LOG" 2>&1 || fail "playwright install"
fi
if ! (cd "$PERSONA" && node -e "import('playwright').then(async p=>{const b=await p.chromium.launch();await b.close()})") >>"$LOG" 2>&1; then
  step "playwright install chromium --with-deps"
  (cd "$PERSONA" && npx playwright install --with-deps chromium) >>"$LOG" 2>&1 || fail "chromium install"
fi

log "READY in $(( $(date +%s) - T0 ))s"
echo "READY  http://localhost:5099  (fresh DB: first signup = owner)  boot took $(( $(date +%s) - T0 ))s"
