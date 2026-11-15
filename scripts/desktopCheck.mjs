#!/usr/bin/env node
// `npm run desktop:check`：桌面版進測試流程，一個指令、一個結果。
//   1. 裝桌面依賴（packages/desktop 自己的 npm ci；Electron 不在根目錄 workspaces 裡）
//   2. 打包（stage.mjs 建 markdown／site／contract／backend／frontend → electron-builder 只產 release/linux-unpacked）
//   3. desktop:test（node --test，不需要 Electron）
//   4. 對「打包後、複製到 repo 外」的執行檔跑 test/smoke.mjs --app（沒有螢幕就用 xvfb-run）
// 前提：根目錄已 npm ci。Linux x64 專用（stage.mjs 的 Node 雜湊只有 linux-x64）。
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "packages/desktop");
const sh = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, stdio: "inherit" }).status === 0;
const results = [];
const step = (name, fn) => {
  const started = Date.now();
  console.log(`\n▸ ${name}`);
  let ok = false;
  try { ok = fn(); } catch (error) { console.error(String(error?.message ?? error)); }
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  return ok;
};

const { copyPackagedApp } = await import(pathToFileURL(join(desktop, "test/packagedApp.mjs")).href);

if (!existsSync(join(root, "node_modules"))) { console.error("根目錄還沒 npm ci"); process.exit(1); }

const installed = step("裝桌面依賴", () => {
  const marker = join(desktop, "node_modules/.package-lock.json");
  const stale = !existsSync(marker) || statSync(marker).mtimeMs < statSync(join(desktop, "package-lock.json")).mtimeMs;
  if (stale && !sh("npm", ["ci", "--no-audit", "--no-fund", "--prefix", "packages/desktop"])) return false;
  // Electron 的執行檔是 postinstall 下載的，不存在就補（npm ci 被略過 script 時會發生）。
  if (!existsSync(join(desktop, "node_modules/electron/dist"))) return sh("node", ["node_modules/electron/install.js"], desktop);
  return true;
});
const packed = installed && step("打包（stage + electron-builder，只產 linux-unpacked）", () => sh("npm", ["run", "pack", "--prefix", "packages/desktop"]));
step("desktop:test（資料夾與金鑰、找埠、靜態檔與代理）", () => sh("npm", ["run", "test", "--prefix", "packages/desktop"]));
if (packed) {
  step("冒煙測試：打包後的執行檔（複製到 repo 外）", () => {
    const app = copyPackagedApp(desktop);
    try {
      const smoke = [join(desktop, "test/smoke.mjs"), "--app", app.executable];
      return process.env.DISPLAY ? sh("node", smoke) : sh("xvfb-run", ["-a", "node", ...smoke]);
    } finally { app.cleanup(); }
  });
}

console.log("\n══ desktop:check ══");
for (const r of results) console.log(`${r.ok ? "通過" : "失敗"}  ${r.name}（${r.seconds} 秒）`);
if (!packed) console.log("略過  冒煙測試（沒有打包成功）");
const ok = results.every((r) => r.ok) && packed;
console.log(ok ? "\ndesktop:check 通過" : "\ndesktop:check 失敗");
process.exit(ok ? 0 : 1);
