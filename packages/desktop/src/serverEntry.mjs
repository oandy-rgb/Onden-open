// 後端子程序的入口：先裝好「乾淨關閉」，再載入既有的後端（packages/backend/dist/server.js，一行都沒改）。
// 後端本身沒有 SIGTERM 處理；PGlite 沒關就被砍，下次要走崩潰復原。這裡在收到主程序的 shutdown 訊息時
// 先關資料庫再離開（Windows 沒有 SIGTERM，所以用訊息而不是訊號）。
// 用法：node serverEntry.mjs <後端 dist 資料夾>
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const distDir = process.argv[2];
if (!distDir) throw new Error("serverEntry.mjs needs the backend dist folder as its first argument");

const db = await import(pathToFileURL(join(distDir, "db.js")).href);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const hardStop = setTimeout(() => process.exit(1), 8000);
  hardStop.unref();
  try {
    await db.pglite?.end();
  } finally {
    process.exit(0);
  }
}
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") void shutdown();
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await import(pathToFileURL(join(distDir, "server.js")).href);
process.send?.({ type: "booted" });
