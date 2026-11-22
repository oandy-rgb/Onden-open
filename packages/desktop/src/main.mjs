// Onden 桌面版主程序。流程：
//   單一實例 → 立刻開「正在開啟…」視窗 → 建資料夾與金鑰 → 換版就先備份（safeUpdate.mjs）
//   → 後端子程序（127.0.0.1、空的埠；內含資料庫升級）→ 等 /health，失敗就還原備份
//   → 靜態檔＋代理（127.0.0.1:固定埠）→ 視窗換成 App。關掉最後一個視窗＝退出：先請後端關好資料庫。
// 帳號走既有的建立帳號／登入畫面；桌面版沒有自己的帳號。
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AI_CHANNELS, createAiHandlers, isTrustedSender } from "./aiAnswering/bridge.mjs";
import { createAiAnsweringController, unavailableAiAnswering } from "./aiAnswering/controller.mjs";
import { createAiAnsweringStore, safeStorageCipher } from "./aiAnswering/store.mjs";
import { startBackend } from "./backendProcess.mjs";
import { dataLayout, writeSettings } from "./dataLayout.mjs";
import { shellLocale, shellMessages } from "./messages.mjs";
import { freePort, LOOPBACK } from "./ports.mjs";
import { InsufficientSpaceError, listBackups, readBuildInfo, restoreFromBackup, stampLabel, startWithSafeUpdate, readVersionStamp } from "./safeUpdate.mjs";
import { failureDialog, prepareUserDataAt, runStartup } from "./startup.mjs";
import { startWebServer } from "./webServer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();
/** 偏好的埠：瀏覽器端的本機資料綁 origin（含埠），埠固定才不會每次開都像換了一台電腦。 */
const PREFERRED_PORT = 47821;

/** 資源位置：打包後在 resources/ 下（electron-builder extraResources），開發時在 stage/ 下。 */
const resourceRoot = app.isPackaged ? process.resourcesPath : join(here, "..", "stage");
const serverRoot = join(resourceRoot, "server");
const webRoot = join(resourceRoot, "web");
/** 回答程式（packages/ai-answerer）：打包時由 stage.mjs 複製到這裡。 */
const answererEntry = join(resourceRoot, "ai-answerer", "src", "index.mjs");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void run();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ stop(): Promise<void> } | null} */
let backend = null;
/** @type {import("node:http").Server | null} */
let web = null;
let quitting = false;
/** 後端就緒前它自己結束是「啟動失敗」，由換版流程處理；就緒後才是「執行中停止」。 */
let backendReady = false;
/** @type {import("./dataLayout.mjs").DataLayout | null} */
let activeLayout = null;
/** @type {import("./safeUpdate.mjs").BuildStamp | null} */
let currentBuild = null;
/** @type {ReturnType<typeof createAiAnsweringController> | null} */
let aiAnswering = null;
const text = () => shellMessages(shellLocale(app.getLocale()));

/** @param {string} message */
function log(message) {
  process.stdout.write(`[desktop] ${message}\n`);
}

async function run() {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  await app.whenReady();
  restrictSession();
  installMenu();
  createWindow();
  const ok = await runStartup({
    boot,
    layout: () => activeLayout,
    askBackupMissing: offerOpenAnyway,
    showFailure: async (error) => {
      log(`啟動失敗：${error instanceof Error ? error.message : String(error)}`);
      await showStartupFailure(error);
    },
  });
  if (!ok) {
    quitting = true;
    await shutdown();
    app.exit(1);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    title: "Onden",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(here, "preload.cjs") },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  void mainWindow.loadFile(join(here, "loading.html"));
}

async function boot() {
  const userData = app.getPath("userData");
  activeLayout = dataLayout(userData);
  const build = readBuildInfo(serverRoot, app.getVersion());
  currentBuild = build;
  // 先補完上次沒做完的更新，再建資料夾、讀金鑰（順序見 startup.mjs）。
  const { layout, secrets, settings } = prepareUserDataAt(userData, build);
  const webPort = await freePort(settings.webPort ?? PREFERRED_PORT);
  if (webPort !== settings.webPort) writeSettings(layout, { ...settings, webPort });
  const backendPort = await freePort();
  await startAiAnswering(layout, backendPort, webPort);

  const t0 = Date.now();
  const started = await startWithSafeUpdate({
    layout, current: build, stopBackend: (running) => running.stop(), onWarn: (message) => log(`換版收尾：${message}`),
    startBackend: () => startBackend({
      serverRoot, layout, secrets, backendPort, webPort, buildId: build.buildId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      onLog: (line) => log(`backend: ${line}`),
      onExit: (code, signal) => {
        if (quitting || !backendReady) return;
        log(`後端結束了 code=${code} signal=${signal}`);
        const [title, detail] = text().backendStopped;
        dialog.showErrorBox(title, detail);
        quitting = true;
        void shutdown().finally(() => app.exit(1));
      },
    }),
  });
  backend = started.backend;
  backendReady = true;
  aiAnswering?.restore(); // 關掉 App 前開著的「用這台電腦上的 AI 回答」接回來
  if (started.backup) log(`換版前已備份：${started.backup.name}`);
  log(`backend ready in ${Date.now() - t0} ms`);

  web = await startWebServer({ webRoot, webPort, backendPort });
  const url = `http://${LOOPBACK}:${webPort}/`;
  guardNavigation(url);
  await mainWindow?.loadURL(url);
  log(`window ready ${Date.now() - startedAt} ms after main started; ${url}`);
}

/** 沒辦法自動還原：讓使用者選「結束」或「直接開啟現有資料」；複製診斷資訊後回到同一個對話框。 @param {import("./safeUpdate.mjs").UpdateFailure} error @returns {Promise<"quit" | "open">} */
async function offerOpenAnyway(error) {
  const t = text();
  const { message, detail } = failureDialog(error, t, currentBuild);
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "warning", title: t.openFailedTitle, message, detail,
      buttons: [t.quitButton, t.openAnyway, t.copyDiagnostics], defaultId: 0, cancelId: 0,
    });
    if (response === 2) { clipboard.writeText(error.diagnostics); continue; }
    return response === 1 ? "open" : "quit";
  }
}

/** 啟動失敗用白話說明；另附「複製診斷資訊」（複製完回到同一個對話框）。 @param {unknown} error */
async function showStartupFailure(error) {
  const t = text();
  const { message, detail, diagnostics } = failureDialog(error, t, currentBuild);
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "error", title: t.openFailedTitle, message, detail,
      buttons: [t.ok, t.copyDiagnostics], defaultId: 0, cancelId: 0,
    });
    if (response !== 1) return;
    clipboard.writeText(diagnostics);
  }
}

/** 選單：關於、還原到更新前的備份。 */
function installMenu() {
  const t = text();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: t.menuApp,
      submenu: [
        { label: t.menuAbout, click: () => void showAbout() },
        { label: t.menuRestore, click: () => void restoreFromMenu() },
        { type: "separator" },
        { label: t.menuQuit, role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ]));
}

async function showAbout() {
  const t = text();
  const build = currentBuild ?? readBuildInfo(serverRoot, app.getVersion());
  await dialog.showMessageBox({ type: "info", title: t.aboutTitle, message: "Onden", detail: t.aboutDetail(build.version, build.buildId), buttons: [t.ok] });
}

/** 列出備份 → 選一份 → 確認 → 關掉後端 → 先另存目前資料再還原 → 結束（要改用舊版程式開，所以不自動重開）。 */
async function restoreFromMenu() {
  const layout = activeLayout;
  if (!layout || quitting || !backendReady) return;
  const t = text();
  const locale = shellLocale(app.getLocale());
  const backups = listBackups(layout).slice(0, 6);
  if (backups.length === 0) {
    await dialog.showMessageBox({ type: "info", message: t.restoreNoBackups[0], detail: t.restoreNoBackups[1], buttons: [t.ok] });
    return;
  }
  const when = (/** @type {string} */ iso) => new Date(iso).toLocaleString(locale);
  const labels = backups.map((b) => (b.kind === "restore" ? `${when(b.createdAt)}　${t.restoreRestoreLabel}` : t.backupLabel(b.from, b.to, when(b.createdAt))));
  const pick = await dialog.showMessageBox({ type: "question", message: t.restorePick, detail: t.restorePickDetail, buttons: [...labels, t.cancel], cancelId: labels.length });
  const chosen = backups[pick.response];
  if (!chosen) return;
  const [confirmMessage, confirmDetail] = t.restoreConfirm(when(chosen.createdAt));
  const confirm = await dialog.showMessageBox({ type: "warning", message: confirmMessage, detail: confirmDetail, buttons: [t.restoreConfirmButton, t.cancel], defaultId: 1, cancelId: 1 });
  if (confirm.response !== 0) return;

  quitting = true;
  await shutdown();
  try {
    // 先另存目前資料（按錯了還能還原回來）、寫標記、還原、清標記；中途被關掉，下次啟動會把還原做完。
    const now = readBuildInfo(serverRoot, app.getVersion());
    restoreFromBackup(layout, chosen, { from: stampLabel(readVersionStamp(layout) ?? now) });
  } catch (error) {
    log(`還原失敗：${error instanceof Error ? error.message : String(error)}`);
    const [errorTitle, errorDetail] = error instanceof InsufficientSpaceError ? t.restoreNoSpace : t.restoreError;
    dialog.showErrorBox(errorTitle, errorDetail);
    app.exit(1);
    return;
  }
  await dialog.showMessageBox({ type: "info", message: t.restoreDone[0], detail: t.restoreDone[1], buttons: [t.ok] });
  app.exit(0);
}

/** 視窗只該待在自己的網址；外部連結交給系統瀏覽器。 @param {string} appUrl */
function guardNavigation(appUrl) {
  const origin = new URL(appUrl).origin;
  const contents = mainWindow?.webContents;
  if (!contents) return;
  const openOutside = (/** @type {string} */ target) => {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") void shell.openExternal(target);
    } catch { /* 不是網址就不開 */ }
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: "allow" };
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    openOutside(url);
  });
}

/** Electron 預設放行所有權限（相機、麥克風、定位…）；只放行 App 現有功能要用的。 */
function restrictSession() {
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/** 「用這台電腦上的 AI 回答」：控制器＋網頁能呼叫的幾個動作（bridge.mjs）。回答迴圈在後端就緒後才開始。 @param {import("./dataLayout.mjs").DataLayout} layout @param {number} backendPort */
async function startAiAnswering(layout, backendPort, webPort) {
  // 選用功能：載入失敗不能讓 App 開不起來，按鈕只會說「現在不能用」。
  /** @type {ReturnType<typeof createAiAnsweringController> | ReturnType<typeof unavailableAiAnswering>} */
  let controller;
  let parseServerAddress = (/** @type {string} */ _text) => /** @type {{ ok: false, message: string }} */ ({ ok: false, message: "unavailable" });
  try {
    const answerer = await import(pathToFileURL(answererEntry).href);
    const store = createAiAnsweringStore({ file: join(layout.root, "ai-answering.json"), cipher: safeStorageCipher(safeStorage) });
    controller = createAiAnsweringController({ store, answerer, ownBaseUrl: () => `http://${LOOPBACK}:${backendPort}`, log: (line) => log(`ai-answering: ${line}`) });
    parseServerAddress = answerer.parseServerAddress;
  } catch (error) {
    log(`ai-answering 無法載入，按鈕停用：${error instanceof Error ? error.message : String(error)}`);
    controller = unavailableAiAnswering();
  }
  aiAnswering = /** @type {never} */ (controller);
  const handlers = createAiHandlers({ controller: /** @type {never} */ (controller), parseServerAddress });
  const trustedOrigin = `http://${LOOPBACK}:${webPort}`; // 固定：App 自己的位址，不看視窗現在在哪
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      // 只回應 App 自己的畫面的主框架（不是 loading 畫面、別的網址、子框架或 /api/ 底下的使用者內容）。
      if (event.senderFrame !== event.sender.mainFrame || !isTrustedSender(event.senderFrame?.url, trustedOrigin)) throw new Error("bridge: untrusted sender");
      return handler(...args);
    });
  }
  controller.subscribe((status) => mainWindow?.webContents.send(AI_CHANNELS.statusChanged, status));
}

async function shutdown() {
  await aiAnswering?.stopAll();
  web?.close();
  web = null;
  await backend?.stop();
  backend = null;
}
