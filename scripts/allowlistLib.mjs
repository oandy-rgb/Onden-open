// 允許清單守門的共用棘輪：規則宣告「誰可以用」，其他一律失敗。
// 嚴格模式（2026-10-31 清零後）：scripts/allowlist-baseline.json（{ 規則: { 檔案: 次數 } }）每條規則必須是空的，
// 守門測試經 checkRule 看到任何基準項目就失敗，任何違規直接失敗；不再有「現況違規」可記。
// 下面的 compareToBaseline／lowerBaseline 仍保留逐檔比對機制（有自我測試），只是正式基準已為空。
//   某檔次數高於基準、或出現基準沒有的檔 → 失敗，訊息寫「這個檔不准用 X」，並帶出唯一入口清單中對應項目的需求、入口、寫法與文件位置。
//   次數低於基準 → 通過，只提示「可以降基準」（別的 PR 會讓數字下降，不能因此紅）。
// 降基準：npm run allowlist:baseline（任何次數上升就拒絕寫）；第一次建立某條規則用 -- --init。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hintForRule } from "./entrypointsCatalog.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = join(root, "scripts/allowlist-baseline.json");

/** 唯一允許「逐檔計數、只減不增」基準的規則（其餘規則維持空）。be-raw-sql：後端手寫 SQL 還在逐檔遷移到 `db`（Kysely）；fe-app-store-reach：直接讀寫整個 store 狀態的前端檔案逐步改用具名 hook；fe-store-inline-selector、fe-store-write 是它的子集（就地寫的 selector、直接寫 store），fe-literal-api-write 是畫面自己寫出 /api 路徑的 sendWrite，逐檔只減不增（提案：docs/architecture/proposals/markdown-surface-and-app-store-2026-11-14.md）。 */
export const RATCHET_RULES = new Set([
  "be-raw-sql", "fe-app-store-reach", "fe-store-inline-selector",
  // 外觀種類的守門（2026-11-17，docs/agents/appearance-rules.md）：今天的寫死值逐檔計數，只減不增；清到 0 就從這裡拿掉。
  "fe-css-spacing", "fe-css-line-height", "fe-css-font-weight", "fe-css-letter-spacing", "fe-css-font-family", "fe-css-border-width",
  "fe-css-opacity", "fe-css-duration", "fe-css-easing", "fe-css-control-height", "fe-css-max-width", "fe-css-focus-ring",
  "fe-icon-size", "fe-icon-stroke",
]);

/** "off" 正常檢查；"lower" 重寫基準（只准往下）；"init" 另外允許建立還沒有基準的規則。 */
export function writeMode() {
  const v = process.env.ALLOWLIST_WRITE;
  return v === "init" ? "init" : v ? "lower" : "off";
}

export function readBaseline(file = BASELINE_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * @param {Record<string, number>} actual 每個檔案目前的違規次數
 * @param {{ what: string, owner?: string }} meta `what` 是被擋的寫法；該改用什麼從唯一入口清單讀（scripts/entrypoints.catalog.json，
 *   項目的 `rules` 含這條規則 id）。`owner` 只給清單沒有這條規則時備用（守門的自我測試用假規則）。
 */
export function compareToBaseline(rule, actual, { what, owner }, baseline = readBaseline(), catalog) {
  const hint = () => hintForRule(rule, catalog) ?? (owner ? `  請改用 ${owner}` : "  （唯一入口清單沒有這條規則：請在 scripts/entrypoints.catalog.json 的項目 rules 加上它）");
  const base = baseline[rule];
  const errors = [];
  const notes = [];
  if (!base) errors.push(`${rule}：scripts/allowlist-baseline.json 沒有這條規則的基準（第一次建立請用 ALLOWLIST_WRITE=init）`);
  for (const [file, n] of Object.entries(actual)) {
    const allowed = base?.[file] ?? 0;
    if (n > allowed) {
      errors.push(`${file}：這個檔不准用 ${what}（${n} 處，基準 ${allowed}）。\n${hint()}\n  規則：${rule}`);
    }
  }
  for (const [file, allowed] of Object.entries(base ?? {})) {
    const n = actual[file] ?? 0;
    if (n < allowed) notes.push(`${rule}：${file} 從 ${allowed} 降到 ${n}，可以降基準（npm run allowlist:baseline）`);
  }
  return { ok: errors.length === 0, errors, notes };
}

/** 把 actual 寫成這條規則的新基準；任何上升（或沒有基準的規則，除非 init）就拒絕。 */
export function lowerBaseline(rule, actual, mode = writeMode(), file = BASELINE_FILE) {
  const baseline = readBaseline(file);
  const base = baseline[rule];
  if (!base && mode !== "init") throw new Error(`${rule}：沒有基準可以降；第一次建立用 npm run allowlist:baseline -- --init`);
  const rises = Object.entries(actual).filter(([f, n]) => n > (base?.[f] ?? (mode === "init" && !base ? Infinity : 0)));
  if (rises.length) {
    throw new Error(`${rule}：基準只准往下，拒絕寫入。上升的檔案：${rises.map(([f, n]) => `${f}（基準 ${base?.[f] ?? 0}，現在 ${n}）`).join("、")}`);
  }
  baseline[rule] = sortKeys(Object.fromEntries(Object.entries(actual).filter(([, n]) => n > 0)));
  writeFileSync(file, `${JSON.stringify(sortKeys(baseline), null, 2)}\n`);
}

/** 守門測試的單一入口：寫入模式下降基準，否則比對。回傳 { ok, errors, notes }。 */
export function checkRule(rule, actual, meta) {
  const mode = writeMode();
  if (mode !== "off") {
    lowerBaseline(rule, actual, mode);
    return { ok: true, errors: [], notes: [`${rule}：基準已更新`] };
  }
  const result = compareToBaseline(rule, actual, meta);
  const listed = Object.keys(readBaseline()[rule] ?? {});
  if (listed.length && !RATCHET_RULES.has(rule)) {
    result.errors.push(`${rule}：scripts/allowlist-baseline.json 必須是空的（嚴格模式），但列了 ${listed.join("、")}；請改用主人入口，不要記基準。`);
    result.ok = false;
  }
  return result;
}

/** 把「每筆違規一個檔案路徑」的清單數成每檔次數。 */
export function countByFile(files) {
  const counts = {};
  for (const f of files) counts[f] = (counts[f] ?? 0) + 1;
  return counts;
}
