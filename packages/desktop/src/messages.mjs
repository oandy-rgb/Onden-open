// 桌面外殼（視窗之外的對話框與選單）的文字，英文與繁體中文各一份；網頁內的文字走前端自己的 i18n。
// 白話、不放代碼與 id；診斷資訊只放在「複製診斷資訊」按鈕裡。

/** @typedef {"en" | "zh-TW"} ShellLocale */

/** @param {string | undefined} locale 例如 app.getLocale() 的 "zh-TW"、"en-US" @returns {ShellLocale} */
export function shellLocale(locale) {
  return /^zh/i.test(locale ?? "") ? "zh-TW" : "en";
}

/** @param {number} bytes */
function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

const zh = {
  openFailedTitle: "Onden 無法啟動",
  backendStopped: ["Onden 的後端停止了", "資料已存在電腦裡，請重新開啟 Onden。"],
  copyDiagnostics: "複製診斷資訊",
  ok: "好",
  cancel: "取消",
  dataNewer: ["這份資料是較新版的 Onden 寫的", "請用較新的版本開啟。你的資料沒有被更動。"],
  /** @param {string} from @param {string} to */
  rolledBack: (from, to) => ["這個新版本無法開啟你的資料", `資料已經還原成更新前的樣子（${from}），沒有遺失。請改回舊版的 Onden 程式，或把下面的診斷資訊回報給開發者（新版：${to}）。`],
  restoreFailed: ["更新沒有完成，資料還在還原的途中", "更新前的備份還在，請不要刪除備份資料夾。重新開啟 Onden 會繼續完成還原；如果一直這樣，請把診斷資訊回報給開發者。"],
  backupMissing: ["上次更新沒有做完，而且沒辦法自動還原", "更新前的備份找不到，或還原用的紀錄損毀了；你的資料可能停在更新到一半的狀態。建議先把整個 Onden 資料夾另外複製一份，再選「直接開啟現有資料」；如果開不起來，請回報給開發者。"],
  quitButton: "結束",
  openAnyway: "直接開啟現有資料",
  startFailed: ["Onden 無法啟動", "請重新開啟 Onden；如果還是不行，請按「複製診斷資訊」回報給開發者。"],
  restoreNoSpace: ["磁碟空間不足，沒有還原", "還原前要先另存目前的資料，空間不夠。請清出空間後再試；你的資料沒有被更動。"],
  /** @param {number} needed @param {number} free */
  noSpace: (needed, free) => ["磁碟空間不足，沒有更新", `更新前要先備份資料，約需要 ${formatBytes(needed)}，目前只剩 ${formatBytes(free)}。請清出空間後再開啟 Onden；你的資料沒有被更動。`],
  menuApp: "Onden",
  menuAbout: "關於 Onden",
  menuRestore: "還原到更新前的備份…",
  menuQuit: "結束",
  aboutTitle: "關於 Onden",
  /** @param {string} version @param {string} buildId */
  aboutDetail: (version, buildId) => `版本 ${version}\n建置編號 ${buildId || "（開發版）"}`,
  restoreNoBackups: ["沒有可還原的備份", "更新 Onden 時才會自動備份；目前還沒有備份。"],
  restorePick: "要還原到哪一份？",
  restorePickDetail: "還原後，備份之後新增或修改的內容會消失（系統會先另存目前的資料，還是能再還原回來）。",
  /** @param {string} from @param {string} to @param {string} when */
  backupLabel: (from, to, when) => `${when}　${from} → ${to}`,
  restoreRestoreLabel: "還原前的資料",
  /** @param {string} when */
  restoreConfirm: (when) => [`確定還原到「${when}」的備份嗎？`, "Onden 會關閉，資料換回備份當時的樣子。"],
  restoreConfirmButton: "還原並關閉",
  restoreDone: ["已還原", "請用與那份備份相符的舊版 Onden 程式重新開啟。"],
  restoreError: ["還原沒有做完", "請重新開啟 Onden，會繼續完成還原；如果還是有問題，請回報給開發者。"],
};
/** @type {typeof zh} */
const en = {
  openFailedTitle: "Onden can't start",
  backendStopped: ["Onden's background service stopped", "Your data is safe on this computer. Please open Onden again."],
  copyDiagnostics: "Copy diagnostics",
  ok: "OK",
  cancel: "Cancel",
  dataNewer: ["This data was written by a newer version of Onden", "Please open it with a newer version. Your data was not changed."],
  rolledBack: (from, to) => ["This new version can't open your data", `Your data was restored to how it was before the update (${from}); nothing was lost. Please go back to the older Onden app, or send the diagnostics below to the developer (new version: ${to}).`],
  restoreFailed: ["The update didn't finish and your data is partway through being restored", "Your pre-update backup is still there; please don't delete the backups folder. Opening Onden again will finish the restore. If this keeps happening, send the diagnostics to the developer."],
  backupMissing: ["The last update didn't finish, and it can't be restored automatically", "The backup from before the update can't be found, or the record needed to restore it is damaged, so your data may be stuck partway through the update. Before going on, copy the whole Onden folder somewhere else, then choose \"Open my current data\". If it won't open, tell the developer."],
  quitButton: "Quit",
  openAnyway: "Open my current data",
  startFailed: ["Onden can't start", "Please open Onden again. If it still doesn't start, press \"Copy diagnostics\" and send them to the developer."],
  restoreNoSpace: ["Not enough disk space, so nothing was restored", "Onden saves your current data before restoring, and there isn't room. Free up some space and try again; your data was not changed."],
  noSpace: (needed, free) => ["Not enough disk space, so Onden was not updated", `Onden backs up your data before updating, which needs about ${formatBytes(needed)}; only ${formatBytes(free)} is free. Free up some space and open Onden again. Your data was not changed.`],
  menuApp: "Onden",
  menuAbout: "About Onden",
  menuRestore: "Restore the backup from before an update…",
  menuQuit: "Quit",
  aboutTitle: "About Onden",
  aboutDetail: (version, buildId) => `Version ${version}\nBuild ${buildId || "(development)"}`,
  restoreNoBackups: ["No backups to restore", "Onden backs up automatically when it updates; there is none yet."],
  restorePick: "Which backup do you want to restore?",
  restorePickDetail: "Anything added or changed after that backup will be gone (your current data is saved first, so you can still switch back).",
  backupLabel: (from, to, when) => `${when}  ${from} → ${to}`,
  restoreRestoreLabel: "Data before a restore",
  restoreConfirm: (when) => [`Restore the backup from ${when}?`, "Onden will close and your data will go back to how it was then."],
  restoreConfirmButton: "Restore and close",
  restoreDone: ["Restored", "Please open Onden again with the older app version that matches that backup."],
  restoreError: ["The restore didn't finish", "Please open Onden again; it will finish the restore. If something still looks wrong, tell the developer."],
};

/** @param {ShellLocale} locale */
export function shellMessages(locale) {
  return locale === "zh-TW" ? zh : en;
}
