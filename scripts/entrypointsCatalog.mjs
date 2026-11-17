// 唯一入口清單的讀取、查詢與文件產生。資料在 scripts/entrypoints.catalog.json，一份資料同時是：
//   規則（allowlist 守門的規則 id 對到哪個入口）、錯誤訊息（entryHint）、給人與 AI 查的說明（docs/agents/entrypoints-catalog.md）。
// 改清單：編輯 JSON → npm run catalog 重新產生文件；guard 測試（entrypointsCatalog.guard.test.ts）比對兩者。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/paths.mjs";

export const CATALOG_FILE = join(repoRoot, "scripts/entrypoints.catalog.json");
export const CATALOG_DOC = "docs/agents/entrypoints-catalog.md";
export const CATALOG_DOC_FILE = join(repoRoot, CATALOG_DOC);

/**
 * @typedef {{ file: string, exports?: string[] }} CatalogFile  repo 相對路徑；結尾 "/" 是資料夾
 * @typedef {{ id: string, need: string, area: string, entry: CatalogFile[], use: string, useLang?: "ts"|"css"|"none",
 *   replaces: string, rules: string[], why: string }} CatalogEntry
 */

/** @returns {{ areas: string[], entries: CatalogEntry[] }} */
export function loadCatalog(file = CATALOG_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 守門規則 id（白名單規則如 `fe-css-color`、一般守門如 `guard:dup-owners`）對到的清單項目。 */
export function entriesForRule(rule, catalog = loadCatalog()) {
  return catalog.entries.filter((e) => e.rules.includes(rule));
}

const short = (file) => file.replace(/^packages\//, "");
const entryLine = (e) => e.entry.map((f) => (f.exports?.length ? `${short(f.file)}（${f.exports.join("、")}）` : short(f.file))).join("；");
export const locationOf = (e) => `${CATALOG_DOC} › ${e.area} › ${e.need}`;

/** 守門擋下時附在訊息後面的說明：需求、入口、寫法、清單位置。 */
export function describeEntry(e) {
  const lines = [`  需求：${e.need}`, `  請用：${entryLine(e)}`];
  if (e.use) lines.push(`  寫法：${e.use}`);
  if (e.replaces) lines.push(`  取代：${e.replaces}`);
  lines.push(`  清單：${locationOf(e)}`);
  return lines.join("\n");
}

/**
 * owner（檔案，或結尾 "/" 的資料夾；路徑從套件 `src/` 起算）有沒有被某個入口涵蓋：該入口的 `rules` 含這條規則，
 * 且入口的 file 就是這個 owner、或落在這個 owner 資料夾內。例外只能是唯一入口本身。
 * @param {string} srcPrefix 入口 file 的套件前綴，如 "packages/frontend/src/"
 * @param {boolean} stripExt 比對時忽略副檔名（後端 import 目標沒有副檔名）
 */
export function ownerCovered(owner, rules, srcPrefix, catalog = loadCatalog(), stripExt = false) {
  const norm = (f) => (stripExt ? f.replace(/\.(ts|tsx|js|mjs)$/, "") : f);
  return catalog.entries.some(
    (e) =>
      rules.some((r) => e.rules.includes(r)) &&
      e.entry.some((f) => {
        if (!f.file.startsWith(srcPrefix)) return false;
        const file = norm(f.file.slice(srcPrefix.length));
        return owner.endsWith("/") ? file.startsWith(owner) : file === norm(owner);
      }),
  );
}

/** 依規則 id 組出提示；清單裡找不到就回 null（呼叫者退回自己的訊息）。 */
export function hintForRule(rule, catalog = loadCatalog()) {
  const found = entriesForRule(rule, catalog);
  return found.length ? found.map(describeEntry).join("\n") : null;
}

/** 依項目 id 組出提示（一般守門的 expect 訊息用）。找不到就丟錯，守門才不會悄悄少了說明。 */
export function entryHint(id, catalog = loadCatalog()) {
  const e = catalog.entries.find((x) => x.id === id);
  if (!e) throw new Error(`entrypoints.catalog.json 沒有項目 ${id}`);
  return describeEntry(e);
}

/** 清單文件（docs/agents/entrypoints-catalog.md）的內容；只由資料檔產生。 */
export function renderCatalogMarkdown(catalog = loadCatalog()) {
  const out = [
    "# 唯一入口清單",
    "",
    "> 狀態：現行（由資料檔產生，內容與 scripts/entrypoints.catalog.json 永遠一致）",
    "",
    "<!-- 由 npm run catalog 從 scripts/entrypoints.catalog.json 產生，不要手改。 -->",
    "",
    "寫新的元件或共用邏輯之前，先在這裡依「需求」查；已有入口就用它。真的要新增共用入口，把它加進 `scripts/entrypoints.catalog.json` 再跑 `npm run catalog`。",
    "同一份資料也是白名單守門的規則與錯誤訊息的來源（`scripts/entrypointsCatalog.mjs`）：守門擋下時印出的「需求／請用／寫法」就是下面的內容。",
    "",
    "- 「寫法」的 import 路徑從該套件的 `src/` 起算（前端 `./lib/…`、後端 `./….js`）；在別的資料夾請改成相對路徑。",
    "- 「守門」：`fe-`／`be-` 開頭是白名單規則（現況違規次數記在 `scripts/allowlist-baseline.json`，只准減少）；`guard:名稱` 是 `src/test/guards/名稱.guard.test.ts`。",
    "- 「為什麼」只在有人寫了才顯示：為什麼只能有一個、什麼時候用。",
    "",
  ];
  for (const area of catalog.areas) {
    const list = catalog.entries.filter((e) => e.area === area);
    out.push(`## ${area}（${list.length}）`, "");
    for (const e of list) {
      out.push(`### ${e.need}`, "", `- 入口：${e.entry.map((f) => `\`${short(f.file)}\`${f.exports?.length ? `（${f.exports.map((x) => `\`${x}\``).join("、")}）` : ""}`).join("；")}　項目 \`${e.id}\``);
      if (e.use) out.push(`- 寫法：\`${e.use}\``);
      if (e.replaces) out.push(`- 取代：${e.replaces.replace(/</g, "&lt;")}`);
      if (e.rules.length) out.push(`- 守門：${e.rules.map((r) => `\`${r}\``).join("、")}`);
      if (e.why) out.push(`- 為什麼：${e.why}`);
      out.push("");
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function writeCatalogDoc() {
  writeFileSync(CATALOG_DOC_FILE, renderCatalogMarkdown());
}
