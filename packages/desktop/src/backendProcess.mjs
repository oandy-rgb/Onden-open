// 以子程序跑既有的後端（packages/backend/dist/server.js），資料庫用 PGlite。
//
// 為什麼是 child_process.fork 而不是 Electron 的 utilityProcess：
//   • fork 加 ELECTRON_RUN_AS_NODE 就是普通 Node，跟 `node serverEntry.mjs` 行為一致，
//     開發、測試、冒煙測試走同一條路，不需要 Electron 在場；
//   • 有 IPC 通道，Windows 也能「請它乾淨關閉」（沒有 SIGTERM）；
//   • 後端不需要 utilityProcess 的好處（Electron 的 MessagePort、沙箱服務）。
// 執行檔是打包進來的官方 Node（server/runtime/node），不是 Electron：見下方 execPath。
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOPBACK } from "./ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** 還原後換節點編號的 SQL（scripts/lib/renewNodeId.sql）：打包時 stage.mjs 放在 server/ 旁；沒打包（開發、測試）用 repo 裡那一份。 @param {string} [serverRoot] */
export function renewalSqlPath(serverRoot) {
  const staged = serverRoot ? join(serverRoot, "renewNodeId.sql") : "";
  return staged && existsSync(staged) ? staged : join(here, "../../../scripts/lib/renewNodeId.sql");
}

/** 後端子程序的環境變數（獨立出來好測：啟動參數有沒有只聽本機）。 @param {{ layout: import("./dataLayout.mjs").DataLayout, secrets: { ONDEN_SECRET_KEY: string, BETTER_AUTH_SECRET: string }, backendPort: number, origin: string, timezone: string, buildId?: string, serverRoot?: string }} options */
export function backendEnv({ layout, secrets, backendPort, origin, timezone, buildId, serverRoot }) {
  return {
    PATH: process.env.PATH ?? "", // 筆記備份用 git
    HOME: process.env.HOME ?? layout.root,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    ONDEN_DB_DRIVER: "pglite",
    ONDEN_PGLITE_DIR: layout.pgdata,
    // serverEntry.mjs 開後端之前看資料是不是被還原過、要不要換節點編號（nodeRenewal.mjs）
    ONDEN_DESKTOP_DATA_DIR: layout.root,
    ONDEN_RENEWAL_SQL: renewalSqlPath(serverRoot),
    PORT: String(backendPort),
    // 只聽本機：不寫的話後端會聽所有網路介面，同網段的人能繞過 webServer.mjs 直接連。
    ONDEN_LISTEN_HOST: LOOPBACK,
    ONDEN_SECRET_KEY: secrets.ONDEN_SECRET_KEY,
    BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
    // 登入 cookie、來源檢查都以視窗載入的網址為準（webServer.mjs 同源代理）。
    BETTER_AUTH_URL: origin,
    CORS_ORIGIN: origin,
    // 本機只有一個人：第一個註冊的帳號就是擁有者，之後不開放註冊（其他人用邀請連結）。
    ONDEN_SIGNUP: "first-only",
    ONDEN_TIMEZONE: timezone,
    LOG_LEVEL: "info",
    // 與視窗載入的前端同一個建置編號：網頁那套「有新版」比對才有東西可比（空＝不送，不誤報舊版）。
    ...(buildId ? { ONDEN_BUILD_ID: buildId } : {}),
  };
}

/** 後端沒能就緒（提早結束或逾時）；tail 是後端日誌最後幾十行，換版流程靠它判斷原因。 */
export class BackendStartError extends Error {
  /** @param {"exited" | "timeout"} reason @param {string} message @param {string[]} tail */
  constructor(reason, message, tail) {
    super(message);
    this.name = "BackendStartError";
    this.reason = reason;
    this.tail = tail.slice();
  }
}

/**
 * @param {{
 *   serverRoot: string, layout: import("./dataLayout.mjs").DataLayout,
 *   secrets: { ONDEN_SECRET_KEY: string, BETTER_AUTH_SECRET: string },
 *   backendPort: number, webPort: number, timezone: string, buildId?: string,
 *   onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
 *   onLog?: (line: string) => void, readyTimeoutMs?: number,
 * }} options
 */
export async function startBackend({ serverRoot, layout, secrets, backendPort, webPort, timezone, buildId, onExit, onLog, readyTimeoutMs = 180_000 }) {
  const origin = `http://${LOOPBACK}:${webPort}`;
  const bundledNode = join(serverRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const child = fork(join(here, "serverEntry.mjs"), [join(serverRoot, "packages/backend/dist")], {
    cwd: layout.data, // 後端把筆記備份與上傳檔放在 cwd/content
    // 打包版用 stage.mjs 放進來的官方 Node（Electron 內建的 Node 在 Linux 上會讓 sharp 當掉）；
    // 沒有它（開發時沒先跑 stage）才退回 Electron 本身當 Node 用。
    execPath: existsSync(bundledNode) ? bundledNode : process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: backendEnv({ layout, secrets, backendPort, origin, timezone, buildId, serverRoot }),
  });
  const tail = /** @type {string[]} */ ([]);
  const collect = (/** @type {Buffer} */ chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line) continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
      onLog?.(line);
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    onExit(code, signal);
  });

  // 第一次要跑全部遷移（PGlite 約 10 秒），給足時間；子程序提早死掉就立刻失敗。
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited) throw new BackendStartError("exited", `後端啟動時結束了\n${tail.slice(-15).join("\n")}`, tail);
    if (Date.now() > deadline) {
      // 等它真的結束再丟錯：呼叫者接著可能要還原資料庫檔案，不能還有程序握著。
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
      throw new BackendStartError("timeout", `後端 ${Math.round(readyTimeoutMs / 1000)} 秒內沒有就緒\n${tail.slice(-15).join("\n")}`, tail);
    }
    const ok = await fetch(`http://${LOOPBACK}:${backendPort}/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    pid: child.pid,
    /** 請後端先關資料庫再離開；8 秒內沒結束就強制結束。 */
    stop() {
      if (exited) return Promise.resolve();
      return /** @type {Promise<void>} */ (new Promise((resolve) => {
        child.once("exit", () => resolve(undefined));
        child.send({ type: "shutdown" }, () => {});
        setTimeout(() => child.kill("SIGKILL"), 9000).unref();
      }));
    },
    logTail: () => tail.slice(),
  };
}
