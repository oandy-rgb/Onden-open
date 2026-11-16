// 網頁能向桌面外殼要求的事，只有這幾個。每個參數都在主程序驗證；沒有任何一個能執行任意命令、
// 讀任意檔案或指定要啟動哪個程式（AI 工具是哪個、怎麼啟動，是 ai-answerer 的轉接層決定的）。
// 連線碼只從網頁往主程序走一次，沒有任何回傳值帶著它。
//
// 這個檔不依賴 Electron：main.mjs 把 handlers 接到 ipcMain，preload.cjs 把同一份清單交給網頁。

/** 網頁端可呼叫的頻道，順序即 preload 的清單。改這裡要同步改 preload.cjs（bridge.test.mjs 比對）。 */
export const AI_CHANNELS = Object.freeze({
  detect: "onden:ai:detect",
  status: "onden:ai:status",
  previewAddress: "onden:ai:preview-address",
  enableOwn: "onden:ai:enable-own",
  disableOwn: "onden:ai:disable-own",
  enableRemote: "onden:ai:enable-remote",
  disableRemote: "onden:ai:disable-remote",
  statusChanged: "onden:ai:status-changed",
});

const CODE = /^ondt_[A-Za-z0-9_-]{32,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * 只接受這個桌面版自己的頁面送來的呼叫：固定的來源（App 的位址）、且不是 /api/ 底下（使用者上傳或發布的內容在那裡，
 * 同一來源但不是 App 的畫面）。 @param {string | undefined} senderUrl @param {string} trustedOrigin
 */
export function isTrustedSender(senderUrl, trustedOrigin) {
  if (!senderUrl) return false;
  try {
    const url = new URL(senderUrl);
    return url.origin === trustedOrigin && !url.pathname.startsWith("/api/");
  } catch { return false; }
}

/**
 * @param {{
 *   controller: ReturnType<typeof import("./controller.mjs").createAiAnsweringController>,
 *   parseServerAddress: (text: string) => { ok: true, baseUrl: string } | { ok: false, message: string },
 * }} options
 * @returns {Record<string, (...args: unknown[]) => Promise<unknown> | unknown>} 頻道名 → 處理函式；參數不對就丟 TypeError（網頁端看到的是被拒絕的呼叫）
 */
export function createAiHandlers({ controller, parseServerAddress }) {
  const invalid = (/** @type {string} */ what) => new TypeError(`bridge: ${what}`);
  /** 連線碼貼得不完整是使用者會遇到的事：回「碼不對」，不是丟錯。 @param {unknown} code */
  const codeOk = (code) => typeof code === "string" && CODE.test(code);
  const BAD_CODE = { ok: false, reason: "bad_code" };

  return {
    [AI_CHANNELS.detect]: () => controller.detect(),
    [AI_CHANNELS.status]: () => controller.status(),
    [AI_CHANNELS.previewAddress]: (text) => {
      if (typeof text !== "string" || text.length > 2048) throw invalid("address");
      const parsed = parseServerAddress(text);
      return parsed.ok ? { ok: true, address: parsed.baseUrl } : { ok: false };
    },
    [AI_CHANNELS.enableOwn]: (input) => {
      if (!isPlainObject(input) || typeof input.actorId !== "string" || !UUID.test(input.actorId)) throw invalid("actorId");
      if (input.codeId !== undefined && (typeof input.codeId !== "string" || !UUID.test(input.codeId))) throw invalid("codeId");
      if (!codeOk(input.code)) return BAD_CODE;
      return controller.enable("own", { code: /** @type {string} */ (input.code), actorId: input.actorId, codeId: input.codeId });
    },
    [AI_CHANNELS.disableOwn]: () => controller.disable("own"),
    [AI_CHANNELS.enableRemote]: (input) => {
      if (!isPlainObject(input) || typeof input.address !== "string" || input.address.length > 2048) throw invalid("address");
      if (!codeOk(input.code)) return BAD_CODE;
      return controller.enable("remote", { code: /** @type {string} */ (input.code), address: input.address });
    },
    [AI_CHANNELS.disableRemote]: () => controller.disable("remote"),
  };
}
