// 瀏覽器 worker 的入口：開機 → 跑情境 → 回報數字。正式版會改成「攔截前端 fetch('/api/*') 並轉給 app.fetch」（README §2）。
import { app, auth, boot, stats, createBridge } from "./entry.js";
import { pgliteInstance } from "../pgShim.mjs";
// @ts-expect-error 純 JS 情境，Node 與瀏覽器共用
import { runScenario } from "../scenario.mjs";

const dir = new URL(self.location.href).searchParams.get("dir");
const relaxed = new URL(self.location.href).searchParams.get("relaxed");
if (relaxed) (globalThis as unknown as { __ONDEN_RELAXED: string }).__ONDEN_RELAXED = relaxed;
if (dir) (globalThis as unknown as { __ONDEN_PGLITE_DIR: string }).__ONDEN_PGLITE_DIR = dir;
const lines: string[] = [];
const log = (s: string) => { lines.push(s); };
(async () => {
  try {
    const t0 = performance.now();
    const b = await boot();
    const bootMs = Math.round(performance.now() - t0);
    const mem0 = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const bridge = createBridge(app, auth.api as never, { email: "trial@onden.local", password: "experiment-only-fixed-password-0123456789" /* 正式版：隨機產生並存起來 */, name: "試用者" });
    const r = await runScenario(bridge, log);
    // 打包「已套完遷移」的資料庫要多大（可當成品附在安裝包裡，跳過首次的 initdb＋150 支遷移）
    const ts = performance.now();
    await (await pgliteInstance()).syncToFs(); // relaxedDurability 時，關閉頁面前一定要呼叫（正式版接在 pagehide / visibilitychange）
    const syncMs = Math.round(performance.now() - ts);
    const td = performance.now();
    const dump = await (await pgliteInstance()).dumpDataDir("gzip");
    const dumpKiB = Math.round(dump.size / 1024), dumpMs = Math.round(performance.now() - td);
    const noteCount = await (await pgliteInstance()).query<{ n: string }>("SELECT count(*)::text AS n FROM content_nodes");
    self.postMessage({ ok: true, dumpKiB, dumpMs, syncMs, dir, notes: noteCount.rows[0].n, bootMs, migrationsMs: Math.round(b.migrationsMs), applied: b.applied, results: r.results, parallel: r.parallel, lines, stats, jsHeapMB: Math.round(mem0 / 1048576) });
  } catch (e) {
    self.postMessage({ ok: false, error: String((e as Error)?.stack ?? e), lines });
  }
})();
