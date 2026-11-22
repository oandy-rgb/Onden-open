// 桌面版的資料放哪、秘密怎麼產生。不依賴 Electron，普通 Node 就能跑（test/ 直接測）。
//
//   <userData>/
//     data/            後端的工作目錄（cwd）：content/ 是筆記備份 git 與上傳檔
//       content/media/   上傳的圖片與附件
//     pgdata/          PGlite 資料庫（Postgres 的資料目錄）
//     secrets.json     自動產生的金鑰，權限 0600
//     desktop.json     視窗用的設定（上次使用的埠，讓瀏覽器端的本機資料不因埠變而失效）
//     version.json     這份資料上次是由哪個版本開的（換版時據此自動備份，見 safeUpdate.mjs）
//     backups/         換版前的自動備份，每份一個資料夾
//     update-in-progress.json  升級或還原進行中的標記（指到要還原的備份）；正常情況下不存在
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ root: string, data: string, pgdata: string, secretsFile: string, settingsFile: string, versionFile: string, backups: string, updateMarker: string }} DataLayout */

/** @param {string} userData @returns {DataLayout} */
export function dataLayout(userData) {
  return {
    root: userData,
    data: join(userData, "data"),
    pgdata: join(userData, "pgdata"),
    secretsFile: join(userData, "secrets.json"),
    settingsFile: join(userData, "desktop.json"),
    versionFile: join(userData, "version.json"),
    backups: join(userData, "backups"),
    updateMarker: join(userData, "update-in-progress.json"),
  };
}

/** 建好資料夾（已存在不動）。 @param {DataLayout} layout */
export function ensureDataDirs(layout) {
  mkdirSync(layout.data, { recursive: true, mode: 0o700 });
  mkdirSync(layout.pgdata, { recursive: true, mode: 0o700 });
}

/** 寫入同資料夾的暫存檔再改名，中途斷電不會留下半個檔。 @param {string} file @param {string} text */
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 讀出秘密；第一次啟動時產生並存起來。ONDEN_SECRET_KEY（64 個十六進位字元）加密使用者的 AI 金鑰與外部日曆網址，
 * BETTER_AUTH_SECRET 簽登入 cookie。遺失這個檔 = 已加密的內容讀不回來、要重新登入；備份時要一起帶走。
 * @param {DataLayout} layout
 * @returns {{ ONDEN_SECRET_KEY: string, BETTER_AUTH_SECRET: string }}
 */
export function loadOrCreateSecrets(layout) {
  if (existsSync(layout.secretsFile)) {
    const parsed = JSON.parse(readFileSync(layout.secretsFile, "utf8"));
    if (/^[0-9a-f]{64}$/.test(parsed?.ONDEN_SECRET_KEY) && /^[0-9a-f]{64}$/.test(parsed?.BETTER_AUTH_SECRET)) {
      chmodSync(layout.secretsFile, 0o600);
      return { ONDEN_SECRET_KEY: parsed.ONDEN_SECRET_KEY, BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET };
    }
    // 壞掉的檔不覆蓋（覆蓋會讓舊的加密內容永遠讀不回來）：讓人看到原因。
    throw new Error(`${layout.secretsFile} 內容不正確；請從備份還原，或移走它讓 Onden 重新產生（舊的加密內容會讀不回來）`);
  }
  const secrets = { ONDEN_SECRET_KEY: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex") };
  writeFileAtomic(layout.secretsFile, JSON.stringify(secrets, null, 2));
  return secrets;
}

/** @param {DataLayout} layout @returns {{ webPort?: number }} */
export function readSettings(layout) {
  try {
    const parsed = JSON.parse(readFileSync(layout.settingsFile, "utf8"));
    return { webPort: Number.isInteger(parsed?.webPort) ? parsed.webPort : undefined };
  } catch {
    return {};
  }
}

/** @param {DataLayout} layout @param {{ webPort?: number }} settings */
export function writeSettings(layout, settings) {
  writeFileAtomic(layout.settingsFile, JSON.stringify(settings, null, 2));
}
