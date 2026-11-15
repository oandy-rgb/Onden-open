// The tasks module's line word is the module tag's CURRENT name (it was the tag, found by id, before migration 191):
// a workspace whose module tag is called `任務` writes `{任務}`, and those lines stay tasks through migration 191 and the
// next save of their note. `{task}` is the reserved word either way (it never makes a plain `task` tag), unless the
// workspace already has an ordinary tag called `task` — then `{task}` is that tag, as it was before 191.
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { migration191Sql } from "./helpers/migration191.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "task-word-admin", name: "Words", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (id: string) => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!.markdown;
const liveTasksOf = async (noteId: string): Promise<string[]> => (await q<{ title: string }>(
  `SELECT t.title FROM content_nodes t JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
    WHERE t.parent_id = $1 AND t.deleted_at IS NULL ORDER BY t.title`, [noteId])).rows.map((r) => r.title);
const createNote = async (markdown: string) => {
  const res = await send("/nodes", "POST", { title: `筆記 ${randomUUID().slice(0, 6)}`, markdown });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
// A module tag as the app makes it: marked with the module, and holding the module's own function.
const moduleTag = async (name: string, slug: string) => {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '', $4) RETURNING id::text`,
    [workspaceId, name, slug, JSON.stringify({ name, slug, fields: [], module: "tasks" })])).rows[0]!.id;
  await seedQ("INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2)", [workspaceId, id]);
  return id;
};
const newWorkspace = async (name: string) => {
  workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id", [name, randomUUID()])).rows[0]!.id;
  actor = await persistActor(workspaceId, actor);
};

describe.skipIf(!isTestDb)("the tasks line word follows the module tag's name", () => {
  describe("module tag renamed to 任務", () => {
    let tagId = "";
    beforeAll(async () => {
      await newWorkspace("Task word renamed");
      tagId = await moduleTag("任務", "module-task-word");
    });

    it("existing `{任務}` line tasks survive migration 191 and a re-save, and a new `{任務}` line becomes a task", async () => {
      const noteId = await createNote("- [ ] 舊任務 {任務}\n");
      expect(await liveTasksOf(noteId)).toEqual(["舊任務"]);
      // Put the task back into its pre-191 shape: tagged, the line's block carrying the tag.
      const [task] = (await q<{ task_id: string; id: string }>("SELECT task_id::text, id::text FROM block_nodes WHERE note_id = $1 AND task_id IS NOT NULL", [noteId])).rows;
      expect(task).toBeTruthy();
      await seedQ("DELETE FROM function_refs WHERE holder_node_id = $1", [task!.task_id]);
      await seedQ("INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)", [task!.task_id, tagId]);
      await seedQ("INSERT INTO block_node_tags (workspace_id, block_node_id, tag_id) VALUES ($1, $2, $3)", [workspaceId, task!.id, tagId]);
      await seedQ(migration191Sql());
      expect((await q("SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'tasks'", [task!.task_id])).rows).toHaveLength(1);
      // Re-save: nothing about the line changed, so its task must not go to the trash.
      expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: `${await bodyOf(noteId)}\n- [ ] 新任務 {任務}\n` })).status).toBe(200);
      expect(await liveTasksOf(noteId)).toEqual(["新任務", "舊任務"]);
      expect((await q("SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NOT NULL", [task!.task_id])).rows).toHaveLength(0);
    });

    it("`{task}` is still the reserved word: it is a task line there and makes no `task` tag", async () => {
      const noteId = await createNote("- [ ] 用保留字 {task}\n");
      expect(await liveTasksOf(noteId)).toEqual(["用保留字"]);
      expect((await q("SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND lower(title) = 'task'", [workspaceId])).rows).toHaveLength(0);
    });
  });

  describe("an ordinary tag called `task` next to a module tag called 任務", () => {
    beforeAll(async () => {
      await newWorkspace("Task word ordinary tag");
      await seedQ(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1, 'manual', 'class_tag', 'task', $2, '', $3)`,
        [workspaceId, `plain-task-${randomUUID()}`, JSON.stringify({ name: "task", slug: "plain-task", fields: [] })]);
      await moduleTag("任務", "module-task-word-2");
    });

    it("`{task}` stays the user's tag on a paragraph and on a box (no task); `{任務}` is the task word", async () => {
      const noteId = await createNote("一段文字 {task}\n\n- [ ] 只是帶標籤的勾選行 {task}\n\n- [ ] 真的任務 {任務}\n");
      await send(`/nodes/${noteId}`, "PATCH", { markdown: `${await bodyOf(noteId)}\n加一句\n` });
      expect(await liveTasksOf(noteId)).toEqual(["真的任務"]);
      const kept = (await q<{ label: string }>(
        `SELECT b.label FROM block_node_tags bt JOIN block_nodes b ON b.id = bt.block_node_id JOIN content_nodes t ON t.id = bt.tag_id
          WHERE b.note_id = $1 AND t.title = 'task' ORDER BY b.label`, [noteId])).rows;
      expect(kept).toHaveLength(2);
    });
  });
});
