// 只給 shutdown.test.mjs 用：以 `node --import` 在 serverEntry.mjs 之前載入，與它共用同一份後端 dist 的模組實例，
// 讓測試能在後端行程裡排一個提交後的派發工作、並在連線池結束之後試著再寫一次。經 IPC 與測試溝通。
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const dist = process.env.SHUTDOWN_PROBE_DIST;
const { pool, q } = await import(pathToFileURL(join(dist, "db.js")).href);
const { queueDispatcher } = await import(pathToFileURL(join(dist, "services/dispatcherQueue.js")).href);
const reply = (message) => new Promise((resolve) => process.send(message, resolve));

let releaseJob;
const jobMayRun = new Promise((resolve) => { releaseJob = resolve; });

// 結束連線池之後再寫一次：連線池若悄悄重開一個空資料庫，這一筆就會寫進沒人關的資料庫。
const end = pool.end.bind(pool);
pool.end = async () => {
  await end();
  let late;
  try {
    await q("INSERT INTO shutdown_probe (note) VALUES ('after-end')");
    late = { wrote: true };
  } catch (error) {
    late = { wrote: false, message: String(error?.message) };
  }
  await reply({ type: "late-write", ...late });
};

process.on("message", async (message) => {
  if (message?.type === "queue-job") {
    await q("CREATE TABLE IF NOT EXISTS shutdown_probe (note text)");
    // 提交後的工作：等到「關閉」開始才繼續。關閉若不等它，連線池會在它底下結束，下面的寫入就丟錯。
    void queueDispatcher({ workspaceId: "w", nodeId: "shutdown-probe", actorId: "a", label: "test.shutdown" }, async () => {
      await jobMayRun;
      await q("INSERT INTO shutdown_probe (note) VALUES ('job')");
    });
    await reply({ type: "job-queued" });
  } else if (message?.type === "read") {
    const { rows } = await q("SELECT note FROM shutdown_probe ORDER BY note");
    await reply({ type: "rows", notes: rows.map((r) => r.note) });
  } else if (message?.type === "shutdown") {
    setImmediate(releaseJob); // 排在 serverEntry 自己的 shutdown 處理之後：那時 pool.end() 已開始等
  }
});
