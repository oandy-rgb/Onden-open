#!/bin/bash
# Full run: for each tier restore the snapshot, then eventloop → measure (desktop, phone) → measure2 (desktop, phone), keeping
# the backend log and pg_stat_statements per tier. usage: run-all.sh [tiers...]  (default: 1k 5k 20k; needs snapshots from seed/clone)
cd "$(dirname "$0")"; export BASE=http://localhost:5099 PGPASSWORD=onden
RUNS=${RUNS:-5}; DEVICES=${DEVICES:-"desktop phone"}; SUF=${DEVICES// /-}
for tier in ${@:-1k 5k 20k}; do
  echo "=== $tier $(date +%T)"
  ./snap.sh load p$tier || exit 1
  PSQL="psql -h 127.0.0.1 -U onden onden_test -q"
  $PSQL -c "create extension if not exists pg_stat_statements" -c "analyze" -c "select pg_stat_statements_reset()" >/dev/null
  mkdir -p results; [ "$DEVICES" = "desktop phone" ] && (cd results && node ../eventloop.mjs $tier 7 > eventloop-$tier.log 2>&1)
  for dev in $DEVICES; do
    (cd results && node ../measure.mjs $tier $dev $RUNS 2>&1 | tail -n $((RUNS+2)) > measure-$tier-$dev.log)
    (cd results && node ../measure2.mjs $tier $dev $RUNS 2>&1 | tail -n $((RUNS+2)) > measure2-$tier-$dev.log)
  done
  cp /tmp/onden-run/backend.log results/backend-$tier-$SUF.log
  $PSQL -At -F '|' -c "select calls, round(mean_exec_time::numeric,1), round(total_exec_time::numeric), left(regexp_replace(query,'\s+',' ','g'),200) from pg_stat_statements where calls>0 order by total_exec_time desc limit 12" > results/pgstat-$tier-$SUF.txt
  echo "=== $tier done $(date +%T)"
done
