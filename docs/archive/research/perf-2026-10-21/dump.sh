#!/bin/bash
# Read-only logical dumps of the three perf snapshots (pg_dump only reads).
D=${PERF_DIR:-.}
for t in onek fivek twentyk; do
  docker exec -e PGPASSWORD=onden onden-pg-test pg_dump -U onden -Fc --no-owner --no-privileges "onden_mperf_${t}_test" > "$D/$t.dump"
  ls -la "$D/$t.dump"
done
