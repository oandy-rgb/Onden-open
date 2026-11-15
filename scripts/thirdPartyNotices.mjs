#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: every package that ships with Onden (package-lock.json, dev-only ones left out),
// grouped by licence. Reads only the lockfile, so it gives the same file with or without node_modules.
//   node scripts/thirdPartyNotices.mjs           rewrite the file
//   node scripts/thirdPartyNotices.mjs --check   fail when the file is not what the lockfile gives (guard lane)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");

/** Packages whose lockfile entry carries no licence: read from the licence file they ship. */
const STATED_IN_LICENCE_FILE = { khroma: "MIT" };

/** Licences that ask for more than keeping the notice; each gets a line under its heading. */
const NOTES = {
  "LGPL-3.0-or-later": "libvips（影像處理，由 sharp 載入的預先編譯函式庫，也在 Docker 映像檔裡）。原始碼：https://github.com/libvips/libvips ；以動態連結使用，可以換成你自己編譯的版本。",
  "OFL-1.1": "字型（思源黑體、思源宋體、霞鶩文楷）。可以隨軟體散布，不得單獨販售字型本身。",
  "MPL-2.0": "以檔案為單位的 copyleft：改了這些套件自己的檔案才需要公開那些檔案。",
};

const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const byLicence = new Map();
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || entry.dev || entry.link) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const licence = entry.license ?? STATED_IN_LICENCE_FILE[name];
  if (!licence) {
    console.error(`${name}@${entry.version} 在 package-lock.json 沒有授權欄位。查它附的授權檔，再加進 scripts/thirdPartyNotices.mjs 的 STATED_IN_LICENCE_FILE。`);
    process.exit(1);
  }
  if (!byLicence.has(licence)) byLicence.set(licence, new Set());
  byLicence.get(licence).add(`${name} ${entry.version}`);
}

const total = [...byLicence.values()].reduce((n, set) => n + set.size, 0);
const lines = [
  "# 第三方元件與授權",
  "",
  "> 狀態：現行（由 `npm run notices` 從 `package-lock.json` 產生，不要手改）",
  "",
  "Onden 本身以 AGPL-3.0 授權（見 [LICENSE](LICENSE)）。下面是隨 Onden 一起散布的第三方套件",
  `（共 ${total} 個，只在開發時用到的不列），依授權分組。各套件的完整授權條款在它自己的套件資料夾裡。`,
  "",
];
for (const licence of [...byLicence.keys()].sort((a, b) => byLicence.get(b).size - byLicence.get(a).size || a.localeCompare(b))) {
  const names = [...byLicence.get(licence)].sort((a, b) => a.localeCompare(b));
  lines.push(`## ${licence}（${names.length}）`, "");
  const note = Object.entries(NOTES).find(([key]) => licence.includes(key))?.[1];
  if (note) lines.push(note, "");
  lines.push(names.join("、"), "");
}
const text = lines.join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== text) {
    console.error("THIRD_PARTY_NOTICES.md 和 package-lock.json 對不上：跑 `npm run notices` 後一起提交。");
    process.exit(1);
  }
  console.log(`notices:check 通過（${total} 個套件）`);
} else {
  writeFileSync(OUT, text);
  console.log(`寫入 THIRD_PARTY_NOTICES.md（${total} 個套件，${byLicence.size} 種授權）`);
}
