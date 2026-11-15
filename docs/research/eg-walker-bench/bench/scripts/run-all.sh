#!/usr/bin/env bash
# 全部重量一遍（約 1 小時）。參考實作在大情境很慢，--only 不含 ref 時請用 merge-results.mjs 併回舊的 ref 列。
set -uo pipefail
cd "$(dirname "$0")/.."
ONLY=${ONLY:-diff3,ref,dt,proto}
node --expose-gc --import tsx src/runNode.ts --only "$ONLY" --out out/node-new.json
npx tsx src/runBrowser.ts --browser chromium --throttle 4 --only "$ONLY" --cold 7 --out out/browser-chromium-x4-new.json
npx tsx src/runBrowser.ts --browser chromium --throttle 1 --only "$ONLY" --out out/browser-chromium-x1.json
node --expose-gc --import tsx src/runAblation.ts
npx tsx src/runSize.ts
npx tsx src/runCompare.ts > out/compare.log
./scripts/run-mem.sh
echo ALLDONE
