#!/bin/bash
# usage: usedb.sh onden_p5k — recreate only the perf backend against that DB
cd "${REPO_ROOT:?set REPO_ROOT to the repo checkout}"
PERF_DB=$1 docker compose -p onden-perf5095 -f compose.e2e.yaml -f "${PERF_DIR:-.}/compose.perf.yaml" up -d --no-deps --force-recreate backend 2>&1 | tail -1
for i in $(seq 1 90); do
  curl -s -o /dev/null -w '%{http_code}' http://localhost:5095/api/health 2>/dev/null | grep -q -E '200|401' && break
  sleep 1
done
docker logs onden-perf5095-backend-1 2>&1 | tail -5
docker exec onden-perf5095-postgres-1 psql -U onden -d $1 -Atc "select max(version) from schema_migrations"
