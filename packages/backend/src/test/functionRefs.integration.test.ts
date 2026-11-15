// services/functionRefs.ts (function references B1): add / remove / settings, who may, what is recorded,
// restore, and that the two reads (functionsOf, functionIndex) agree.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { giveFunction, seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { registerStandInFunction } from "./helpers/registerStandInFunction.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import {
  addFunction, FunctionRefError, functionIndex, functionsOf, removeFunction, setFunctionConfig,
} from "../services/functionRefs.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { readTagCatalog } from "../services/tagCatalog.js";
import { seedQ } from "./helpers/seedQ.js";
import { createTaskNode } from "../services/tasksStore.js";

registerShippedModules();
registerStandInFunction();

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("function references", () => {
  let ws = "";
  let admin: ActorCtx;
  let editor: ActorCtx;
  const workspaces: string[] = [];
  const tag = async (name = `fn-${randomUUID().slice(0, 8)}`) => (await seedClassTag(ws, { name })).tagId;
  const moduleTag = async (module: string) => {
    const id = await tag(`${module}-${randomUUID().slice(0, 6)}`);
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', $2::text) WHERE id = $1`, [id, module]);
    await giveFunction(ws, id, module);
    return id;
  };
  const holder = (id: string) => ({ kind: "node" as const, id });
  const add = (tagId: string, functionId: string, who = admin) => addFunction({ actor: who, workspaceId: ws, holder: holder(tagId), functionId });
  const events = async (tagId: string) => (await q<{ id: string; event_type: string; payload: Record<string, unknown> }>(
    `SELECT id::text, event_type, payload FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type LIKE 'FUNCTION_REF_%' ORDER BY domain_events.id`, [ws, tagId],
  )).rows;
  const ids = async (tagId: string) => (await functionsOf(admin, holder(tagId)))!.map((use) => use.functionId).sort();

  beforeEach(async () => {
    ws = context.workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Function refs', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    workspaces.push(ws);
    admin = await persistActor(ws, { id: "fn-admin", name: "Admin", role: "admin", type: "human" });
    editor = await persistActor(ws, { id: "fn-editor", name: "Editor", role: "editor", type: "human" });
  });
  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await deleteWorkspaceActors(workspaces);
  });

  it("adds a function once: a reference, one FUNCTION_REF_ADDED event on the tag, a second add changes nothing", async () => {
    const t = await tag();
    const first = await add(t, "review");
    expect(first.added).toBe(true);
    expect(await ids(t)).toEqual(["review"]);
    expect(await add(t, "review")).toEqual({ refId: first.refId, added: false });
    const recorded = await events(t);
    expect(recorded.map((e) => e.event_type)).toEqual(["FUNCTION_REF_ADDED"]);
    expect(recorded[0]!.payload).toMatchObject({ ref_id: first.refId, function_id: "review" });
  });

  it("points its settings at the function's module tag and keeps the tag's membership link in step", async () => {
    const m = await moduleTag("review");
    const t = await tag();
    const { refId } = await add(t, "review");
    const [use] = (await functionsOf(admin, holder(t)))!;
    expect(use).toMatchObject({ refId, functionId: "review", sourceTagId: m });
    const extendsOf = async () => (await q<{ e: string[] }>(`SELECT tag_schema->'extends' AS e FROM content_nodes WHERE id = $1`, [t])).rows[0]!.e;
    expect(await extendsOf()).toEqual([m]);
    await removeFunction({ actor: admin, workspaceId: ws, refId });
    expect(await extendsOf()).toEqual([]);
    expect(await ids(t)).toEqual([]);
  });

  it("only the workspace owner changes a tag's functions (an editor is refused, nothing is written)", async () => {
    const t = await tag();
    await expect(add(t, "review", editor)).rejects.toMatchObject({ name: "AuthorityError" });
    const { refId } = await add(t, "review");
    await expect(removeFunction({ actor: editor, workspaceId: ws, refId })).rejects.toMatchObject({ name: "AuthorityError" });
    await expect(setFunctionConfig({ actor: editor, workspaceId: ws, refId, config: { a: 1 } })).rejects.toMatchObject({ name: "AuthorityError" });
    expect(await ids(t)).toEqual(["review"]);
    expect(await events(t)).toHaveLength(1);
  });

  it("a delegated token is refused even with the admin role", async () => {
    const t = await tag();
    const token = await persistActor(ws, { ...admin, tokenScope: { tokenId: "fn-token", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    await expect(add(t, "review", token)).rejects.toMatchObject({ name: "AuthorityError" });
    expect(await ids(t)).toEqual([]);
  });

  it("refuses an unknown function, a view, a space holder and a tag of another workspace", async () => {
    const t = await tag();
    await expect(add(t, "no_such_function")).rejects.toMatchObject({ status: 400 });
    await expect(add(t, "calendar")).rejects.toMatchObject({ status: 400 });
    await expect(addFunction({ actor: admin, workspaceId: ws, holder: { kind: "space", id: randomUUID() }, functionId: "review" })).rejects.toBeInstanceOf(FunctionRefError);
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Other', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    workspaces.push(other);
    const foreign = (await seedClassTag(other, { name: `foreign-${randomUUID().slice(0, 6)}` })).tagId;
    await expect(add(foreign, "review")).rejects.toMatchObject({ status: 404 });
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1`, [foreign])).rowCount).toBe(0);
  });

  it("rolls the reference back with its event, and a retry under the same key lands once", async () => {
    const t = await tag();
    await expect(withEventTransaction(ws, async () => { await add(t, "review"); throw new Error("later step failed"); })).rejects.toThrow("later step failed");
    expect(await ids(t)).toEqual([]);
    expect(await events(t)).toHaveLength(0);
    const key = randomUUID();
    await withIdempotencyKey(key, () => add(t, "review"));
    await expect(withIdempotencyKey(key, () => add(t, "skills"))).rejects.toMatchObject({ name: "IdempotentReplay" });
    expect(await ids(t)).toEqual(["review"]);
    expect(await events(t)).toHaveLength(1);
  });

  it("a module tag keeps its own function; removing it is refused, and a tag's own settings change is recorded and undoable", async () => {
    const m = await moduleTag("skills");
    const own = (await functionsOf(admin, holder(m)))![0]!;
    await expect(removeFunction({ actor: admin, workspaceId: ws, refId: own.refId! })).rejects.toMatchObject({ status: 400 });
    const t = await tag();
    const { refId } = await add(t, "review");
    expect(await setFunctionConfig({ actor: admin, workspaceId: ws, refId, config: { new_per_day: 5 } })).toEqual({ config: { new_per_day: 5 } });
    await setFunctionConfig({ actor: admin, workspaceId: ws, refId, config: { new_per_day: 5 } }); // no difference: no event
    expect((await events(t)).map((e) => e.event_type)).toEqual(["FUNCTION_REF_ADDED", "FUNCTION_REF_CONFIG_CHANGED"]);
    const changed = (await events(t))[1]!;
    const undone = await restoreEvent(changed.id, { actor: admin, workspaceId: ws });
    expect(undone).toMatchObject({ restored: true });
    expect((await functionsOf(admin, holder(t)))![0]!.config).toEqual({});
  });

  it("restores an add (removes it) and a remove (brings it back, link included); later edits are kept, not overwritten", async () => {
    const m = await moduleTag("review");
    const t = await tag();
    const { refId } = await add(t, "review");
    const addEvent = (await events(t))[0]!;
    // A later settings edit stops the add from being undone: the settings were changed after it.
    await setFunctionConfig({ actor: admin, workspaceId: ws, refId, config: { new_per_day: 9 } });
    const refused = await restoreEvent(addEvent.id, { actor: admin, workspaceId: ws });
    expect(refused).toMatchObject({ code: "state_conflict" });
    expect(await ids(t)).toEqual(["review"]);
    await setFunctionConfig({ actor: admin, workspaceId: ws, refId, config: {} });
    const undone = await restoreEvent(addEvent.id, { actor: admin, workspaceId: ws });
    expect(undone).toMatchObject({ restored: true });
    expect(await ids(t)).toEqual([]);
    expect((await q<{ e: string[] }>(`SELECT tag_schema->'extends' AS e FROM content_nodes WHERE id = $1`, [t])).rows[0]!.e).toEqual([]);
    // Undo the undo (a FUNCTION_REF_REMOVED event) brings the reference and the link back.
    const removed = (await events(t)).filter((e) => e.event_type === "FUNCTION_REF_REMOVED").at(-1)!;
    expect(await restoreEvent(removed.id, { actor: admin, workspaceId: ws })).toMatchObject({ restored: true });
    expect((await functionsOf(admin, holder(t)))![0]).toMatchObject({ functionId: "review", sourceTagId: m });
    // The same event again: the function is there already.
    expect(await restoreEvent(removed.id, { actor: admin, workspaceId: ws })).toMatchObject({ code: "already_in_state" });
    // An editor cannot restore a tag definition change.
    await expect(restoreEvent((await events(t)).at(-1)!.id, { actor: editor, workspaceId: ws })).rejects.toMatchObject({ name: "AuthorityError" });
  });

  it("functionsOf, functionIndex and the catalog agree for every tag", async () => {
    const m = await moduleTag("review");
    const a = await tag(); const b = await tag(); const c = await tag();
    await add(a, "review"); await add(a, "skills"); await add(b, "review");
    const index = await functionIndex(admin, ws);
    const catalog = await readTagCatalog(admin, ws);
    for (const id of [a, b, c, m]) {
      const one = (await functionsOf(admin, holder(id)))!.map((use) => `${use.functionId}:${use.sourceTagId}`).sort();
      const batch = (index.byTag.get(id) ?? []).map((use) => `${use.functionId}:${use.sourceTagId}`).sort();
      expect(one, id).toEqual(batch);
      const row = catalog.find((entry) => entry.id === id) as { effective_modules: string[]; functions: Array<{ id: string; source_tag_id: string }> };
      expect(row.functions.map((fn) => `${fn.id}:${fn.source_tag_id}`).sort(), id).toEqual(batch);
      expect([...row.effective_modules].sort(), id).toEqual([...new Set((index.byTag.get(id) ?? []).map((use) => use.functionId))].sort());
    }
    expect(index.tagsWith("review").sort()).toEqual([a, b, m].sort());
    expect(index.tagsWith("skills")).toEqual([a]);
  });

  it("a trashed settings tag stops providing the function, as a missing extends target did", async () => {
    const m = await moduleTag("review");
    const t = await tag();
    await add(t, "review");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [m]);
    expect(await ids(t)).toEqual([]);
    expect((await functionIndex(admin, ws)).has(t, "review")).toBe(false);
  });

  // B3: a note can hold a function. A task node references 'tasks' (services/tasksStore createTaskNode); people never
  // add or remove that reference, and it never shows in the tag catalog.
  describe("a note as the holder (task nodes)", () => {
    const hostNote = async () => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', 'Host', $2, '') RETURNING id::text`,
      [ws, `fn-host-${randomUUID()}`])).rows[0]!.id;
    const makeTask = async () => createTaskNode({ workspaceId: ws, actor: admin, hostId: await hostNote(), title: "A task" });

    it("functionsOf lists the task node's tasks reference for a reader, with the note itself as the source", async () => {
      const task = await makeTask();
      const uses = await functionsOf(admin, holder(task));
      expect(uses).toEqual([expect.objectContaining({ functionId: "tasks", instance: "", holder: holder(task), sourceTagId: task })]);
      expect(await functionsOf(admin, holder(randomUUID()))).toBeNull();
      expect(await functionsOf(admin, holder("not-an-id"))).toBeNull();
    });

    it("a plain note has no functions, and a trashed one is not found", async () => {
      const note = await hostNote();
      expect(await functionsOf(admin, holder(note))).toEqual([]);
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [note]);
      expect(await functionsOf(admin, holder(note))).toBeNull();
    });

    it("nobody can add, remove or configure a function on a note through the tag-level operations", async () => {
      const task = await makeTask();
      const ref = (await q<{ id: string }>(`SELECT id::text FROM function_refs WHERE holder_node_id = $1`, [task])).rows[0]!.id;
      await expect(add(task, "review")).rejects.toMatchObject({ status: 404 });
      await expect(removeFunction({ actor: admin, workspaceId: ws, refId: ref })).rejects.toMatchObject({ status: 404 });
      await expect(setFunctionConfig({ actor: admin, workspaceId: ws, refId: ref, config: { a: 1 } })).rejects.toMatchObject({ status: 404 });
      expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'tasks'`, [task])).rowCount).toBe(1);
    });

    it("tags' own readers never list a note's reference", async () => {
      const task = await makeTask();
      expect((await functionIndex(admin, ws)).tagsWith("tasks")).not.toContain(task);
    });
  });
});
