// A folder with Chinese (and decomposed, spaced, bracketed) file and folder names imports: the
// notes keep their folder tree, titles come from the file names in NFC, and one odd name
// does not refuse the whole upload.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();
const actor: ActorCtx = { id: "import-zh", name: "Import zh", type: "human", role: "admin" };

describe.skipIf(!isTestDatabase())("folder import with Chinese and unusual file names", () => {
  let ws = "";
  const stamp = randomUUID().slice(0, 8);
  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('zh', $1) RETURNING id::text`, [`import-zh-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
  });

  it("imports names in Chinese, NFD, with spaces, brackets and a colon, under their folders", async () => {
    const nfd = "Café 筆記".normalize("NFD"); // a macOS file name: decomposed
    const files = [
      [`資料夾 (一)/筆記 一 ${stamp}.md`, "內容 [[筆記 二 " + stamp + "]]"],
      [`資料夾 (一)/子層/筆記 二 ${stamp}.md`, "第二篇"],
      [`${nfd} ${stamp}.md`, "decomposed"],
      [`Note: 含冒號 ${stamp}.md`, "colon in the name"],
      [`第一章：入門 ${stamp}.md`, "full-width colon"],
      [`[草稿] #1 ${stamp}.md`, "brackets and hash"],
    ].map(([path, content]) => ({ path: path!, content: content! }));
    const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
    hono.onError(apiOnError);
    hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    hono.route("/api/import", importRouter);
    const res = await hono.request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: randomUUID(), name: "zh" }, files, upsert: true }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 6, skipped: 0, conflicts: [] });
    const titles = (await q<{ title: string; parent: string | null }>(
      `SELECT c.title, p.title AS parent FROM content_nodes c LEFT JOIN content_nodes p ON p.id = c.parent_id
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.title LIKE $2`, [ws, `%${stamp}`])).rows;
    expect(titles.map((r) => r.title).sort()).toEqual([
      `Café 筆記 ${stamp}`, `Note: 含冒號 ${stamp}`, `[草稿] #1 ${stamp}`, `第一章：入門 ${stamp}`, `筆記 一 ${stamp}`, `筆記 二 ${stamp}`,
    ].sort());
    expect(titles.find((r) => r.title === `筆記 二 ${stamp}`)!.parent).toBe("子層");
  });
});
