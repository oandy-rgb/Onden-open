// 試用版的「後端入口」：真正的 Hono app＋PGlite。取代 packages/backend/src/index.ts 底部那段 `if (!isTest()) {…}` 的開機流程。
// 只做到最小：套遷移 → 載入工作區時鐘 → better-auth 的表 → 不啟動任何定時工作（試用版沒有背景伺服器；見 README §1）。
import { app } from "../../../../packages/backend/src/index.js";
import { migrate, getWorkspaceId } from "../../../../packages/backend/src/db.js";
import { loadWorkspaceClock } from "../../../../packages/backend/src/services/workspaceTime.js";
import { auth } from "../../../../packages/backend/src/auth.js";
import { applyMigrations } from "./migrations.js";

export { app };
export { stats } from "../pgShim.mjs";

export async function boot(): Promise<{ migrationsMs: number; applied: number }> {
  const t0 = performance.now();
  const applied = await applyMigrations(); // 取代 db.ts 的 readdir/readFile（瀏覽器沒有檔案系統）
  const migrationsMs = performance.now() - t0;
  await migrate({ seedNativeActor: false }); // 這支會看到「全部已套用」，只做種子資料
  await loadWorkspaceClock(await getWorkspaceId());
  await (await auth.$context).runMigrations();
  return { migrationsMs, applied };
}

export { auth };
export { createBridge } from "./bridge.js";
