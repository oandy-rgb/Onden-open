#!/bin/bash
# usage: snap.sh save <name> | snap.sh load <name>  — dump/restore the persona stack's DB (onden_test) with pg_dump/pg_restore.
# (CREATE DATABASE ... TEMPLATE copies the tables but NOT the PGroonga index files, so the copy fails with "pgroonga: object isn't found".)
# Dumps live in $SNAP_DIR (default /tmp/onden-snaps). Restarts the backend.
source "$(dirname "$0")/../../../scripts/persona/common.sh"
D=${SNAP_DIR:-/tmp/onden-snaps}; mkdir -p $D
export PGPASSWORD=onden
stop_backend
if [ "$1" = save ]; then
  pg_dump -h 127.0.0.1 -U onden -Fc ${3:-onden_test} -f $D/$2.dump
else
  psql_admin postgres -c "DROP DATABASE IF EXISTS onden_test WITH (FORCE)" -c "CREATE DATABASE onden_test OWNER onden"
  pg_restore -h 127.0.0.1 -U onden -d onden_test --no-owner --no-privileges $D/$2.dump 2>&1 | grep -v "^$" | head -5
fi
start_backend
wait_http $BASE/api/bootstrap '^(200|401)$' 90 && echo "ok $1 $2"
