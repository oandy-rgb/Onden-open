// D55: a note's slug follows its title on every path that writes the title
// or brings a note back (services/nodes.ts slugFor / slugForTitle):
//   (a) an event-history undo of a rename puts the slug back with the title;
//   (b) Trash › Restore keeps a tag's `tag-` slug (it used to make it `book`);
//   (c) an event-history undo of a delete gives the same slug as (b);
//   (d) a Markdown re-import that renames the note renames its slug.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { mergeTags } from "../services/tagMerge.js";
import { slugFor } from "../services/nodes.js";
import tags from "../routes/tags.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const admin: ActorCtx = { id: "slug-follows-title-admin", name: "Test", type: "human", role: "admin" };
let ws: string;
const ids: string[] = [];

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => {
  c.set("actor", admin);
  await withIdempotencyKey(randomUUID(), next);
});
app.route("/api/tags", tags);

const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}`;

async function note(title: string, markdown = ""): Promise<string> {
  const { node } = await createNote({ actor: admin, workspaceId: ws, title, markdown, event: { uiContext: "node.create" } });
  ids.push(node.id as string);
  return node.id as string;
}
async function tag(name: string): Promise<string> {
  const response = await app.request("/api/tags", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  ids.push(id);
  return id;
}
async function row(id: string) {
  return (await q<{ title: string; slug: string }>("SELECT title, slug FROM content_nodes WHERE id = $1", [id])).rows[0]!;
}
async function lastEvent(id: string, type: string): Promise<string> {
  return (await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = $2 ORDER BY domain_events.id DESC LIMIT 1`, [id, type],
  )).rows[0]!.id;
}
async function linkTargets(id: string): Promise<string[]> {
  return (await q<{ target_node_id: string }>(
    `SELECT target_node_id::text FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink' ORDER BY 1`, [id],
  )).rows.map((r) => r.target_node_id);
}

describe("slugFor (D55)", () => {
  it("a note's slug is its title's, a tag's is tag- + its name's, a row-named slug stays", () => {
    const id = randomUUID();
    expect(slugFor({ node_type: "content" }, "Road Map")).toBe("road-map");
    expect(slugFor({ node_type: "class_tag" }, "Book")).toBe("tag-book");
    expect(slugFor({ id, node_type: "content", slug: `task-${id}` }, "Buy milk")).toBe(`task-${id}`);
    expect(slugFor({ id, node_type: "canvas", slug: "old" }, "Board")).toBe(`canvas-${id}`);
    expect(slugFor({ node_type: "class_tag", slug: "tag-config-abc123", reserved_key: "config" }, "x")).toBe("tag-config-abc123");
    expect(slugFor({ node_type: "content", slug: "_workspace_config" }, "Site Config")).toBe("_workspace_config");
  });
});

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("the slug follows the title (D55)", () => {
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => {
    await awaitAllDispatchers();
    await seedQ("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [ids]);
  });

  it("(a) undoing a rename from event history puts the slug back, so a new note of that name links alone", async () => {
    const plan = unique("Plan");
    const roadmap = unique("Roadmap");
    const id = await note(plan);
    await updateNode(ws, id, { title: roadmap }, { actor: admin });
    expect((await row(id)).slug).toBe(roadmap.toLowerCase());
    expect(await restoreEvent(await lastEvent(id, "NODE_UPDATED"), { actor: admin, workspaceId: ws })).toMatchObject({ restored: true });
    expect(await row(id)).toEqual({ title: plan, slug: plan.toLowerCase() });

    const second = await note(roadmap);
    expect((await row(second)).slug).toBe(roadmap.toLowerCase());
    const linker = await note(unique("linker"), `see [[${roadmap}]]`);
    await awaitAllDispatchers();
    expect(await linkTargets(linker)).toEqual([second]);
  });

  it("(a) undoing a rename whose old slug was taken meanwhile suffixes it", async () => {
    const plan = unique("Plan");
    const id = await note(plan);
    await updateNode(ws, id, { title: unique("Roadmap") }, { actor: admin });
    const other = await note(plan);
    expect((await row(other)).slug).toBe(plan.toLowerCase());
    await restoreEvent(await lastEvent(id, "NODE_UPDATED"), { actor: admin, workspaceId: ws });
    expect(await row(id)).toEqual({ title: plan, slug: `${plan.toLowerCase()}-2` });
  });

  it("(b) Trash › Restore of a merged tag keeps its tag- slug", async () => {
    const name = unique("book");
    const source = await tag(name);
    const target = await tag(unique("livre"));
    expect((await row(source)).slug).toBe(`tag-${name}`);
    await mergeTags(admin, ws, source, target);
    await undeleteNode(admin, ws, source);
    expect(await row(source)).toEqual({ title: name, slug: `tag-${name}` });
  });

  it("(c) undoing a tag merge from event history keeps the tag- slug too", async () => {
    const name = unique("novel");
    const source = await tag(name);
    const target = await tag(unique("roman"));
    const { mergeEventId } = await mergeTags(admin, ws, source, target);
    expect(await restoreEvent(mergeEventId, { actor: admin, workspaceId: ws, cascade: true })).toMatchObject({ restored: true });
    expect(await row(source)).toEqual({ title: name, slug: `tag-${name}` });
  });

  it("(b)(c) Trash › Restore and an event-history undo of a delete give a note the same slug", async () => {
    const title = unique("Notes");
    const viaTrash = await note(title);
    await trashNode(admin, ws, viaTrash);
    const occupant = await note(title);
    await undeleteNode(admin, ws, viaTrash);
    expect((await row(viaTrash)).slug).toBe(`${title.toLowerCase()}-2`);

    await trashNode(admin, ws, occupant);
    await trashNode(admin, ws, viaTrash);
    const viaHistory = await note(title);
    await restoreEvent(await lastEvent(viaTrash, "NODE_DELETED"), { actor: admin, workspaceId: ws });
    expect((await row(viaTrash)).slug).toBe(`${title.toLowerCase()}-2`);
    expect((await row(viaHistory)).slug).toBe(title.toLowerCase());
  });

  it("(b) Trash › Restore keeps a task's task-<uuid> slug", async () => {
    const id = randomUUID();
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, space_id)
       SELECT $1, $2, 'manual', 'content', 'Buy milk', $3, '', true, id FROM spaces WHERE workspace_id = $2 AND is_default`,
      [id, ws, `task-${id}`],
    );
    ids.push(id);
    await trashNode(admin, ws, id);
    await undeleteNode(admin, ws, id);
    expect((await row(id)).slug).toBe(`task-${id}`);
  });

  it("(d) a Markdown re-import that renames the note renames its slug", async () => {
    const source = { id: randomUUID(), name: "d55" };
    const path = `${unique("file")}.md`;
    const before = unique("Draft");
    const after = unique("Final");
    const file = (title: string) => ({ path, content: `---\ntitle: ${title}\n---\nbody` });
    expect(await importMarkdownNote({ actor: admin, workspaceId: ws, source, file: file(before), parentId: null, reuse: true }))
      .toEqual({ status: "imported", nodeId: expect.any(String) });
    const id = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [ws, before])).rows[0]!.id;
    ids.push(id);
    expect((await row(id)).slug).toBe(before.toLowerCase());
    expect(await importMarkdownNote({ actor: admin, workspaceId: ws, source, file: file(after), parentId: null, reuse: true }))
      .toEqual({ status: "updated", nodeId: expect.any(String) });
    expect(await row(id)).toEqual({ title: after, slug: after.toLowerCase() });
  });
});
