// 打包後的桌面版執行檔，複製到 repo 外面的暫存資料夾再測：在 repo 裡跑會讓 Node 一路往上找到根目錄的 node_modules，
// 少了什麼檔案也看不出來（stage.mjs 的檢查擋的就是這件事）。冒煙測試與對照測試共用。
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @param {string} desktopDir packages/desktop @returns {{ executable: string, cleanup: () => void }} */
export function copyPackagedApp(desktopDir) {
  const source = join(desktopDir, "release", "linux-unpacked");
  if (!existsSync(join(source, "onden"))) throw new Error(`${source}/onden 不存在；先跑 npm run desktop:pack`);
  const target = mkdtempSync(join(tmpdir(), "onden-desktop-app-"));
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  return { executable: join(target, "onden"), cleanup: () => rmSync(target, { recursive: true, force: true }) };
}
