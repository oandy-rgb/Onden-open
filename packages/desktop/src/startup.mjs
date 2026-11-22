// 啟動流程中不依賴 Electron 的部分：資料準備的順序、啟動失敗要說什麼、「備份不見」的出口。
// main.mjs 只負責把它接到真的對話框與視窗；test/startup.test.mjs 用假的對話框測整段流程。
import { dataLayout, ensureDataDirs, loadOrCreateSecrets, readSettings } from "./dataLayout.mjs";
import { abandonInterruptedUpdate, diagnosticsText, recoverFromInterruptedUpdate, stampLabel, UpdateFailure } from "./safeUpdate.mjs";

/**
 * 碰使用者資料的第一個動作：先補完上次沒做完的更新（升級或還原被關掉），之後才建資料夾、讀金鑰與設定。
 * 順序不能換：還原可能正要把 secrets.json 放回來，先讀會拿到一組一次性的新金鑰。
 * @param {import("./dataLayout.mjs").DataLayout} layout @param {import("./safeUpdate.mjs").BuildStamp} build
 */
export function prepareUserData(layout, build) {
  recoverFromInterruptedUpdate(layout, { to: stampLabel(build) });
  ensureDataDirs(layout);
  const secrets = loadOrCreateSecrets(layout);
  const settings = readSettings(layout);
  return { secrets, settings };
}

/** 資料夾位置 → 準備好的資料（給 main.mjs 一個呼叫）。 @param {string} userData @param {import("./safeUpdate.mjs").BuildStamp} build */
export function prepareUserDataAt(userData, build) {
  const layout = dataLayout(userData);
  return { layout, ...prepareUserData(layout, build) };
}

/**
 * 一個啟動失敗要顯示的對話框：白話主文＋補充；原始訊息與後端日誌只放在 diagnostics（按鈕複製）。
 * @param {unknown} error @param {ReturnType<typeof import("./messages.mjs").shellMessages>} t @param {import("./safeUpdate.mjs").BuildStamp | null} build
 * @returns {{ message: string, detail: string, diagnostics: string }}
 */
export function failureDialog(error, t, build) {
  if (error instanceof UpdateFailure) {
    const [message, detail] =
      error.kind === "data_newer" ? t.dataNewer
      : error.kind === "no_space" ? t.noSpace(error.neededBytes ?? 0, error.freeBytes ?? 0)
      : error.kind === "restore_failed" ? t.restoreFailed
      : error.kind === "backup_missing" ? t.backupMissing
      : t.rolledBack(error.from, error.to);
    return { message, detail, diagnostics: error.diagnostics };
  }
  const tail = error && typeof error === "object" && "tail" in error && Array.isArray(error.tail) ? /** @type {string[]} */ (error.tail) : [];
  const [message, detail] = t.startFailed;
  return { message, detail, diagnostics: diagnosticsText({ from: "-", to: build ? stampLabel(build) : "-", reason: error instanceof Error ? error.message : String(error), tail }) };
}

/**
 * 啟動，失敗時處理對話框。回傳 true＝啟動成功；false＝已經告知使用者，呼叫者直接結束。
 *   backup_missing（沒辦法自動還原）：只問一次「結束／直接開啟現有資料」，不再另跳第二個對話框；
 *   選「直接開啟」＝放棄還原（只清標記）再啟動一次；這次再失敗就照一般失敗顯示。
 * @param {{
 *   boot: () => Promise<void>, layout: () => import("./dataLayout.mjs").DataLayout | null,
 *   askBackupMissing: (error: UpdateFailure) => Promise<"quit" | "open">,
 *   showFailure: (error: unknown) => Promise<void>,
 * }} options
 */
export async function runStartup({ boot, layout, askBackupMissing, showFailure }) {
  try {
    await boot();
    return true;
  } catch (error) {
    let failure = error;
    if (error instanceof UpdateFailure && error.kind === "backup_missing") {
      if ((await askBackupMissing(error)) === "quit") return false;
      try {
        const where = layout();
        if (where) abandonInterruptedUpdate(where);
        await boot();
        return true;
      } catch (second) {
        failure = second;
      }
    }
    await showFailure(failure);
    return false;
  }
}
