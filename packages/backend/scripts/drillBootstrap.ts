// Restore drill (optional --bootstrap): prove the app can read the migrated
// database as its owner. Imports the app from <repo-root> in-process (no port,
// NODE_ENV=test so index.ts does not boot a server) and runs buildBootstrap —
// the function behind GET /api/bootstrap — for the workspace owner.
//
//   DATABASE_URL=… NODE_ENV=test tsx drillBootstrap.ts <repo-root>
//
// Prints counts only. Not an HTTP request: sessions are better-auth cookies the
// drill cannot mint, and a bearer token is confined to /api/mcp.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertDrillDatabase } from "./drillInvariants.js";

assertDrillDatabase(process.env.DATABASE_URL);
const root = process.argv[2];
if (!root) { console.error("用法：drillBootstrap.ts <repo-root>"); process.exit(2); }
const src = (p: string) => import(pathToFileURL(join(root, "packages/backend/src", p)).href);

let code = 0;
const db = await src("db.ts") as typeof import("../src/db.js");
try {
  await src("app.ts"); // assembles the app (no port, no migrations): route modules must load against this schema
  const { buildBootstrap } = await src("services/sync/index.ts") as typeof import("../src/services/sync/index.js");
  const { resolveCurrentActor } = await src("spine/currentActor.ts") as typeof import("../src/spine/currentActor.js");
  const ws = (await db.pool.query<{ id: string; owner_actor_id: string | null }>(`SELECT id, owner_actor_id FROM workspaces ORDER BY created_at LIMIT 1`)).rows[0];
  if (!ws?.owner_actor_id) throw new Error("no-owner");
  const owner = await resolveCurrentActor({ id: ws.owner_actor_id }, ws.id);
  const boot = await buildBootstrap(owner, ws.id, { slimBodies: false }) as unknown as Record<string, unknown>;
  const nodes = boot.nodes;
  const n = Array.isArray(nodes) ? nodes.length : nodes && typeof nodes === "object" ? Object.keys(nodes).length : -1;
  console.log(`bootstrap 讀取成功：${Object.keys(boot).length} 個欄位，${n} 個節點`);
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`bootstrap 失敗：${err.code ?? (err.message === "no-owner" ? "工作區沒有擁有者" : "讀取錯誤")}`);
  code = 1;
} finally {
  await db.pool.end();
}
process.exit(code);
