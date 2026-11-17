#!/usr/bin/env node
// The one licence check. It writes THIRD_PARTY_NOTICES.md — every package that ships with Onden (package-lock.json,
// dev-only ones left out) and every third-party file kept in the repo itself — grouped by licence, and it refuses
// what the policy (scripts/licence-policy-baseline.json) does not allow:
//   - a shipped package whose licence is not `allowed`, and is not a `conditional` licence that names that package
//     (a licence with conditions is judged per package: how it is linked, whether we change it, whether it ships);
//   - a font, a wasm file or a `vendor/` folder in the repo that `bundled` does not list, or whose notice file is missing;
//   - one of our own packages that does not say AGPL-3.0-only, or a LICENSE that is not the AGPL.
// The policy file only shrinks (ratchet:check, it is a *baseline*.json): a new licence, a new package under a
// conditional licence, or a new bundled folder is the owner's decision (`ratchet-override:` in the commit).
// Reads the lockfile and the tracked file list, so it gives the same answer with or without node_modules.
//   node scripts/thirdPartyNotices.mjs           check the policy, then rewrite the file
//   node scripts/thirdPartyNotices.mjs --check   check the policy and fail when the file is not what they give (guard lane)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allows } from "./licenceLib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");

/** Packages whose lockfile entry carries no licence: read from the licence file they ship. */
const STATED_IN_LICENCE_FILE = { khroma: "MIT" };

const OWN_LICENCE = "AGPL-3.0-only";
const POLICY_FILE = "scripts/licence-policy-baseline.json";
const policy = JSON.parse(readFileSync(join(ROOT, POLICY_FILE), "utf8"));
const licenceAllows = (licence, name) => allows(policy, licence, name);

const problems = [];
const ASK = `先查條款與我們怎麼用它（怎麼連結、有沒有改它、會不會隨軟體散布），再問擁有者；${POLICY_FILE} 只准減少，新增要擁有者同意。`;

// Our own packages.
const ownManifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((dir) => `packages/${dir}/package.json`).filter((file) => existsSync(join(ROOT, file)))];
for (const file of ownManifests) {
  const licence = JSON.parse(readFileSync(join(ROOT, file), "utf8")).license;
  if (licence !== OWN_LICENCE) problems.push(`${file} 的 license 是 ${JSON.stringify(licence)}，應該是 ${OWN_LICENCE}。`);
}
const ownText = readFileSync(join(ROOT, "LICENSE"), "utf8");
if (!/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/.test(ownText) || !ownText.includes("Remote Network Interaction")) problems.push("LICENSE 不是完整的 GNU AGPL 第 3 版條款。");
if (!/##\s*License\s*\n+[^\n]*AGPL-3\.0/.test(readFileSync(join(ROOT, "README.md"), "utf8"))) problems.push("README.md 的 ## License 一節沒有寫 AGPL-3.0。");

// Third-party files kept in the repo itself: fonts, wasm, vendor folders.
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
const bundledPaths = Object.keys(policy.bundled);
for (const file of tracked) {
  if (!/\.(woff2?|ttf|otf|wasm)$/i.test(file) && !/(^|\/)vendor\//.test(file)) continue;
  if (!bundledPaths.some((path) => file === path || file.startsWith(`${path}/`))) problems.push(`${file} 是放在 repo 裡的第三方檔案（字型、wasm 或 vendor 資料夾），但沒有登記在 ${POLICY_FILE} 的 bundled。${ASK}`);
}
for (const [path, entry] of Object.entries(policy.bundled)) {
  if (!tracked.some((file) => file === path || file.startsWith(`${path}/`))) problems.push(`bundled 的 ${path} 已經不在 repo 裡：刪掉那一項。`);
  if (entry.licence !== OWN_LICENCE && !licenceAllows(entry.licence, path)) problems.push(`bundled 的 ${path} 授權是 ${entry.licence}，不在允許清單。${ASK}`);
  if (!tracked.includes(entry.notice)) problems.push(`bundled 的 ${path} 指的授權聲明檔 ${entry.notice} 不存在：授權條款要跟著檔案。`);
}

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
  if (!licenceAllows(licence, name)) problems.push(`${name}@${entry.version} 的授權是 ${licence}，不在允許清單（或這個套件沒有被點名在那個有條件的授權底下）。${ASK}`);
  if (!byLicence.has(licence)) byLicence.set(licence, new Set());
  byLicence.get(licence).add(`${name} ${entry.version}`);
}

if (problems.length > 0) {
  console.error(`授權檢查沒過（${problems.length}）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const total = [...byLicence.values()].reduce((n, set) => n + set.size, 0);
const lines = [
  "# 第三方元件與授權",
  "",
  "> 狀態：現行（由 `npm run notices` 從 `package-lock.json` 產生，不要手改）",
  "",
  "<!-- 由 npm run notices 從 package-lock.json 產生，不要手改。 -->",
  "",
  "Onden 本身以 AGPL-3.0 授權（見 [LICENSE](LICENSE)）。下面是隨 Onden 一起散布的第三方套件",
  `（共 ${total} 個，只在開發時用到的不列），依授權分組。各套件的完整授權條款在它自己的套件資料夾裡。`,
  "",
];
for (const licence of [...byLicence.keys()].sort((a, b) => byLicence.get(b).size - byLicence.get(a).size || a.localeCompare(b))) {
  const names = [...byLicence.get(licence)].sort((a, b) => a.localeCompare(b));
  lines.push(`## ${licence}（${names.length}）`, "");
  for (const [key, { how }] of Object.entries(policy.conditional)) if (licence.includes(key)) lines.push(how, "");
  lines.push(names.join("、"), "");
}
lines.push("## 放在 repo 裡、不經 npm 的第三方檔案", "");
for (const [path, entry] of Object.entries(policy.bundled)) {
  if (entry.licence !== OWN_LICENCE) lines.push(`- \`${path}\`：${entry.what}。授權 ${entry.licence}，聲明在 \`${entry.notice}\`。`);
}
lines.push("");
const text = lines.join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== text) {
    console.error("THIRD_PARTY_NOTICES.md 和 package-lock.json／授權清單對不上：跑 `npm run notices` 後一起提交。");
    process.exit(1);
  }
  console.log(`notices:check 通過（${total} 個套件、${bundledPaths.length} 處放在 repo 裡的檔案、${ownManifests.length} 個自己的套件）`);
} else {
  writeFileSync(OUT, text);
  console.log(`寫入 THIRD_PARTY_NOTICES.md（${total} 個套件，${byLicence.size} 種授權）`);
}
