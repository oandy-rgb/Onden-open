#!/bin/bash
# Restore the dumped snapshots into the perf stack's own postgres (onden-perf5095).
D=${PERF_DIR:-.}
PG=onden-perf5095-postgres-1
for pair in onek:onden_p1k fivek:onden_p5k twentyk:onden_p20k; do
  src=${pair%%:*}; db=${pair##*:}
  docker exec $PG psql -q -U onden -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
  docker exec -i $PG pg_restore -U onden -d $db --no-owner --no-privileges < "$D/$src.dump" 2>&1 | grep -v -E "^$" | head -5
  docker exec $PG psql -U onden -d $db -Atc "select count(*) from content_nodes; select max(version) from schema_migrations"
done
