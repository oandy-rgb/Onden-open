// 測試跑的時候把每一次合併的輸入 (base, incoming, current) 記下來（只記錄，不改結果）。
// 由 vitest.record.config.ts 當 setupFiles 載入；輸出 JSON Lines 到 RECORD_OUT。
// 合併規則版本 2 之後有兩個入口：測試直接呼叫的 threeWayMergeBody（行級）與呼叫者用的 mergeBody；
// mergeBody 裡面再呼叫 threeWayMergeBody（逐單位合併、補救）不記，只記最外層那一次。
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, vi } from "vitest";

const out = process.env.RECORD_OUT;
const seen = new Set<string>();
let inside = 0;
const record = (base: string, incoming: string, current: string) => {
  if (!out || inside > 0) return;
  const h = createHash("sha1").update(JSON.stringify([base, incoming, current])).digest("hex");
  if (seen.has(h)) return;
  seen.add(h);
  const file = (expect.getState().testPath ?? "?").replace(/^.*\/src\//, "");
  appendFileSync(out, JSON.stringify({ file, base, incoming, current }) + "\n");
};

vi.mock("../../../../../../../packages/backend/src/services/eventLog/bodyMerge.ts", async (orig) => {
  const m = await orig<typeof import("../../../../../../../packages/backend/src/services/eventLog/bodyMerge.js")>();
  return {
    ...m,
    threeWayMergeBody: (base: string, incoming: string, current: string) => {
      record(base, incoming, current);
      return m.threeWayMergeBody(base, incoming, current);
    },
  };
});
vi.mock("../../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.ts", async (orig) => {
  const m = await orig<typeof import("../../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js")>();
  return {
    ...m,
    mergeBody: (base: string, incoming: string, current: string) => {
      record(base, incoming, current);
      inside++;
      try { return m.mergeBody(base, incoming, current); } finally { inside--; }
    },
  };
});
