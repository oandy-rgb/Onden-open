#!/usr/bin/env bash
# Wipe the DB back to a fresh state (next signup = owner) and restart the backend.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
stop_backend
psql_admin postgres -c "DROP DATABASE IF EXISTS onden_test WITH (FORCE)" -c "CREATE DATABASE onden_test OWNER onden" || exit 1
load_schema || { echo "FAILED: schema load, see $LOG"; exit 1; }
start_backend
wait_http $BASE/api/bootstrap '^(200|401)$' 90 && echo "RESET OK (fresh DB, backend ready)" || { echo "FAILED: backend not ready, see $RUN/backend.log"; exit 1; }
