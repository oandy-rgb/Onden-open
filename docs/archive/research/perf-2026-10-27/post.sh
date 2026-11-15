#!/bin/bash
# After run-all.sh: bootstrap composition, login/site page loads, build sizes, note-create latency per tier.
cd "$(dirname "$0")"; export BASE=http://localhost:5099 PGPASSWORD=onden; mkdir -p results; cd results
for tier in 1k 5k 20k; do
  ../snap.sh load p$tier >/dev/null
  node ../bootcomp.mjs > bootcomp-$tier.txt 2>&1
  node ../create-latency.mjs $tier 10 > create-$tier.json 2>&1
done
for dev in desktop phone; do for p in / /site/; do node ../loggedout.mjs $p $dev 5 > loggedout-$(echo $p | tr / _)-$dev.json 2>&1; done; done
node ../sizes.mjs > sizes.txt
echo POSTDONE
