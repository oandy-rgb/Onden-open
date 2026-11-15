// The word that marks a checkbox line as a task (`{task}`) follows the tasks module's tag while that tag node
// exists (tasksStore.taskLineWord), so a workspace whose tag is not titled `task` — renamed, or named `任務` because a
// plain `task` tag was there first — keeps its tasks on the next save, as on main where the line was found by that tag.
// And the word is never resolved to a tag, so a save makes no `task` tag.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { searchNodes } from "../services/nodeSearch.js";
import { taskLineWord } from "../services/tasksStore.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "line-word-admin", name: "Line word", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SCHEMA = (name: string) => JSON.stringify({ name, slug: `module-${name}-${randomUUID().slice(0, 6)}`, fields: [], module: "tasks", publish_collection: false });

describe.skipIf(!isTestDb)("the task word follows the tasks module's tag", () => {
  // A workspace per test: the tests run in a random order and one makes the module tag.
  const fresh = async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Line word',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, { id: "line-word-admin", name: "Line word", role: "admin", type: "human" });
  };

  /** A tag; with a schema it is the module's tag, which holds the tasks function itself (migration 166). */
  const tag = async (title: string, schema?: string) => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
       VALUES ($1,'manual','class_tag',$2,$3,'',$4::jsonb) RETURNING id::text`, [workspaceId, title, `lw-${randomUUID()}`, schema ?? null])).rows[0]!.id;
    if (schema) await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2)`, [workspaceId, id]);
    return id;
  };
  const note = async (markdown: string) => {
    const res = await send("/nodes", "POST", { title: `lw ${randomUUID().slice(0, 6)}`, markdown });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const tasksOf = async (noteId: string) => (await q<{ id: string; deleted: boolean }>(
    `SELECT t.id::text, t.deleted_at IS NOT NULL AS deleted FROM content_nodes t
      WHERE t.parent_id = $1 AND EXISTS (SELECT 1 FROM function_refs r WHERE r.holder_node_id = t.id AND r.function_id = 'tasks')`, [noteId])).rows;
  const blockTags = async (noteId: string) => (await q<{ tag_id: string }>(
    `SELECT bt.tag_id::text FROM block_node_tags bt JOIN block_nodes b ON b.id = bt.block_node_id WHERE b.note_id = $1`, [noteId])).rows.map((r) => r.tag_id);

  it("with no tag node the word is task, and saving makes no task tag", async () => {
    await fresh();
    expect(await taskLineWord(workspaceId)).toBe("task");
    const id = await note("- [ ] first {task}\n");
    expect(await tasksOf(id)).toHaveLength(1);
    expect((await q("SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND lower(title) = 'task'", [workspaceId])).rowCount).toBe(0);
  });

  it("a module tag titled 任務 (a plain task tag was there first): {任務} lines stay tasks across a save, {task} stays an ordinary tag", async () => {
    await fresh();
    const plain = await tag("task");
    const module = await tag("任務", SCHEMA("任務"));
    expect(await taskLineWord(workspaceId)).toBe("任務");
    const id = await note("- [ ] kept {任務}\n\nplain {task}\n");
    const [made] = await tasksOf(id);
    expect(made).toBeTruthy();
    // Save the note again with an edit: the task is the same one and is not trashed.
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: "- [ ] kept {任務}\n\nplain {task}\n\nmore text\n" })).status).toBe(200);
    expect(await tasksOf(id)).toEqual([{ id: made!.id, deleted: false }]);
    // {task} is the user's own tag here: the paragraph keeps it; {任務} is the word, so it is on no block as a tag.
    const onBlocks = await blockTags(id);
    expect(onBlocks).toContain(plain);
    expect(onBlocks).not.toContain(module);
    // A checkbox line with the user's {task} tag is not a task.
    const other = await note("- [ ] not a task {task}\n");
    expect(await tasksOf(other)).toHaveLength(0);
    expect(await blockTags(other)).toContain(plain);
  });

  it("searching `#task` with tasks included still finds a task node, which carries no tag row now", async () => {
    await fresh();
    const module = await tag("task", SCHEMA("task"));
    const id = await note("- [ ] findable zebra {task}\n");
    const [made] = await tasksOf(id);
    expect(made).toBeTruthy();
    const found = await searchNodes(workspaceId, "#task", actor, 20, { tasks: true });
    expect(found.map((r) => r.id)).toContain(made!.id);
    expect((await searchNodes(workspaceId, "#task", actor, 20)).map((r) => r.id)).not.toContain(made!.id);
    void module;
  });

  it("a user's own task tag and no module tag: {task} stays that tag, the new-line word is 任務 and makes tasks", async () => {
    await fresh();
    const plain = await tag("task");
    expect(await taskLineWord(workspaceId)).toBe("任務");
    const id = await note("- [ ] by the other word {任務}\n\n- [ ] user tag {task}\n");
    expect(await tasksOf(id)).toHaveLength(1);
    expect(await blockTags(id)).toContain(plain);
    // No tag was made for the word.
    expect((await q("SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = '任務'", [workspaceId])).rowCount).toBe(0);
  });
});
