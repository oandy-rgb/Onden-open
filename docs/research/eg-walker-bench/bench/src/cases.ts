// 要跑哪些情境（Node 與瀏覽器共用）。
import { EDIT_COUNTS, SIZES, makeFork } from "./genFork.js";
import type { ForkScenario } from "./types.js";

export const SEED = 20261101;

export function forkScenarios(quick: boolean): ForkScenario[] {
  const sizes = quick ? [SIZES[0], SIZES[2]] : SIZES;
  const edits = quick ? [EDIT_COUNTS[1], EDIT_COUNTS[2]] : EDIT_COUNTS;
  const out: ForkScenario[] = [];
  for (const sz of sizes) for (const k of edits) out.push(makeFork(sz, k, SEED));
  return out;
}

/** 參考實作每個操作都要線性掃整份，太大的情境只量一次或跳過。 */
export const REF_MAX_BASE_FOR_FULL_REPLAY = 150_000;
