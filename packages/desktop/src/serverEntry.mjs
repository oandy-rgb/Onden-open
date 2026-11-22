// 後端子程序的入口：先裝好「乾淨關閉」，再載入既有的後端（packages/backend/dist/server.js，一行都沒改）。
// 後端本身沒有 SIGTERM 處理；PGlite 沒關就被砍，下次要走崩潰復原。這裡在收到主程序的 shutdown 訊息時
// 先關資料庫再離開（Windows 沒有 SIGTERM，所以用訊息而不是訊號）。
// 載入 server.js（它一開始就跑 migration）之前，先看資料是不是被還原過：是就換節點編號（nodeRenewal.mjs）；換不了就不開後端。
// 用法：node serverEntry.mjs <後端 dist 資料夾>（環境變數見 backendProcess.mjs backendEnv）
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { dataLayout } from "./dataLayout.mjs";
import { recordNodeState, renewBeforeBoot } from "./nodeRenewal.mjs";

const distDir = process.argv[2];
if (!distDir) throw new Error("serverEntry.mjs needs the backend dist folder as its first argument");

const db = await import(pathToFileURL(join(distDir, "db.js")).href);
const dataDir = process.env.ONDEN_DESKTOP_DATA_DIR, renewalSqlFile = process.env.ONDEN_RENEWAL_SQL;
if (!dataDir || !renewalSqlFile) throw new Error("serverEntry.mjs needs ONDEN_DESKTOP_DATA_DIR and ONDEN_RENEWAL_SQL (backendProcess.mjs backendEnv)");
const layout = dataLayout(dataDir);
/** @type {import("./nodeRenewal.mjs").Query} */
const query = (text, params) => db.pool.query(text, params);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const hardStop = setTimeout(() => process.exit(1), 8000);
  hardStop.unref();
  try {
    // 記下編到第幾號：之後放回去的、在這之前複製的資料夾才認得出來（nodeRenewal.mjs）。記不下來只少一次認的機會，照樣關。
    await recordNodeState(layout, query).catch((error) => console.error(`[desktop] could not record the node state: ${error instanceof Error ? error.message : error}`));
    // pool.end() 先讓提交後的背景寫入做完（dbClose.ts），再關資料庫；直接 pglite.end() 會略過這一步。
    await db.pool.end();
  } finally {
    process.exit(0);
  }
}
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") void shutdown();
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

let renewal;
try {
  renewal = await renewBeforeBoot({ layout, query, renewalSql: readFileSync(renewalSqlFile, "utf8") });
} catch (error) {
  // RenewalRefused's message starts with RENEWAL_REFUSED_LOG_MARKER: the shell reads it from this log (safeUpdate.mjs isRenewalRefusedFailure)
  console.error(error instanceof Error ? error.message : String(error));
  await db.pool.end().catch(() => undefined);
  process.exit(1);
}
if (renewal.renewed && renewal.kept) console.log(`[desktop] the data was restored and could NOT take a new node id; it keeps ${renewal.before ?? "none"} (recorded in sync_restore_kept_node_id)`);
else if (renewal.renewed) console.log(`[desktop] the data was ${renewal.why === "restored" ? "restored" : "put back from an older copy"}: node id ${renewal.before ?? "-"} -> ${renewal.after ?? "(taken at the first write)"}`);

await import(pathToFileURL(join(distDir, "server.js")).href);
process.send?.({ type: "booted" });
