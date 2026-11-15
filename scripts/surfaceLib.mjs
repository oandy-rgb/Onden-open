// 「入口寬度」基準：scripts/surface-baseline.json（{ 名稱: 數字 }），數字只准往下。
// 給整個程式一個總數的守門用（逐檔計數的規則走 allowlist-baseline.json，見 allowlistLib.mjs）：
//   @onden/markdown 根入口匯出幾個名稱、前後端實際用了其中幾個、前端有幾個 window 事件名稱。
// 比 allowlist 規則粗，因為要降的是「入口的寬度」，不是某個檔案。提案與目標：
// docs/architecture/proposals/markdown-surface-and-app-store-2026-11-14.md
//   SURFACE_WRITE=lower  把目前數字寫回基準（任何上升就拒絕）；SURFACE_WRITE=init  另外允許建立新的名稱。
//   npm run surface:baseline 兩個守門都以 lower 模式跑一遍。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SURFACE_FILE = join(dirname(fileURLToPath(import.meta.url)), "surface-baseline.json");

const read = (file) => JSON.parse(readFileSync(file, "utf8"));

/** @param {string} key 基準名稱 @param {number} actual 現在的數字 @param {string} what 這個數字量的是什麼（失敗訊息用）
 *  @returns {{ ok: boolean, errors: string[], notes: string[] }} */
export function checkSurface(key, actual, what, file = SURFACE_FILE, mode = process.env.SURFACE_WRITE ?? "") {
  const baseline = read(file);
  const base = baseline[key];
  if (mode) {
    if (base === undefined && mode !== "init") throw new Error(`${key}：沒有基準可以降；第一次建立用 SURFACE_WRITE=init`);
    if (base !== undefined && actual > base) throw new Error(`${key}：基準只准往下，拒絕寫入（基準 ${base}，現在 ${actual}）`);
    baseline[key] = actual;
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
    return { ok: true, errors: [], notes: [`${key}：基準已寫成 ${actual}`] };
  }
  if (base === undefined) return { ok: false, errors: [`${key}：scripts/surface-baseline.json 沒有這個基準（SURFACE_WRITE=init）`], notes: [] };
  if (actual > base) {
    return { ok: false, errors: [`${key}：${what}現在是 ${actual}，基準是 ${base}，只准減不准增。\n  新程式請用已有的窄入口；真的需要新入口，先把舊的收掉一個。提案：docs/architecture/proposals/markdown-surface-and-app-store-2026-11-14.md`], notes: [] };
  }
  return { ok: true, errors: [], notes: actual < base ? [`${key}：從 ${base} 降到 ${actual}，可以降基準（npm run surface:baseline）`] : [] };
}
