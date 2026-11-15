// The rules for giving a node a new parent, called directly: services/nodeTree.ts
// assertReparent, and services/parentKind.ts assertParentKind under it. The other
// reparent tests go through PATCH or undo and check the HTTP status; these check which
// rule answered (the error's code and status), in the order the rules are documented,
// and that a parent that is not changing is never judged. Found by mutation testing
// (docs/archive/research/mutation-2026-10-24.md): the error codes and the "same parent" shortcut
// could change with every test still green.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { ancestorIds, assertReparent, ReparentError, type ReparentNode } from "../services/nodeTree.js";
import { assertParentKind, ParentKindError } from "../services/parentKind.js";
import { TagNameConflictError } from "../services/tagHierarchy.js";
import { FieldNameClashError } from "../services/tagFields.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  return null;
}

describe.skipIf(!isTestDb)("assertReparent / assertParentKind", () => {
  let ws = "";
  let owner: ActorCtx, editor: ActorCtx;
  let otherSpace = "", hiddenSpace = "";

  const insert = async (title: string, type: "content" | "class_tag", opts: { parent?: string | null; trashed?: boolean; schema?: unknown } = {}) =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color, parent_id, deleted_at, tag_schema)
       VALUES ($1,'manual',$2,$3,$4,'',$5,$6,$7,$8) RETURNING id::text`,
      [ws, type, title, randomUUID(), type === "class_tag" ? "#888" : null, opts.parent ?? null,
        opts.trashed ? new Date() : null, opts.schema === undefined ? null : JSON.stringify(opts.schema)])).rows[0]!.id;
  const node = (id: string, type: "content" | "class_tag", title: string, parent: string | null = null): ReparentNode =>
    ({ id, node_type: type, title, parent_id: parent });
  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Reparent gate', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, { id: "", name: "owner", role: "admin", type: "human" });
    editor = await persistActor(ws, { id: "", name: "editor", role: "editor", type: "human" });
    // a second shared space the editor may write in, and one they are not in
    otherSpace = await makeSpace(ws, "other", [{ id: editor.id, permission: "edit" }]);
    hiddenSpace = await makeSpace(ws, "hidden", []);
  });
  afterAll(async () => {
    if (ws) {
      await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
      await deleteWorkspaceActors(ws);
    }
    await pool.end();
  });

  it("does not judge a parent that is not changing, even one that breaks every rule", async () => {
    const hiddenParent = await insert(uniq("hidden parent"), "content");
    await putInSpace(hiddenParent, hiddenSpace);
    // legacy row: in the default space under a parent in a space the editor cannot see
    const child = await insert(uniq("legacy child"), "content", { parent: hiddenParent });
    expect(await thrown(assertReparent(ws, node(child, "content", "x", hiddenParent), hiddenParent, editor))).toBeNull();
    // a root node staying at the root
    const root = await insert(uniq("root"), "content");
    expect(await thrown(assertReparent(ws, node(root, "content", "x", null), null, editor))).toBeNull();
    // a tag under a note (legacy mix) keeps that parent
    const note = await insert(uniq("note"), "content");
    const mixed = await insert(uniq("mixed tag"), "class_tag", { parent: note });
    expect(await thrown(assertReparent(ws, node(mixed, "class_tag", "x", note), note, editor))).toBeNull();
  });

  it("refuses to move a node under itself: parent_cycle, 400", async () => {
    const a = await insert(uniq("a"), "content");
    const e = await thrown(assertReparent(ws, node(a, "content", "a"), a, editor));
    expect(e).toBeInstanceOf(ReparentError);
    expect(e).toMatchObject({ code: "parent_cycle", status: 400, message: "cannot move a node under its own descendant", name: "ReparentError" });
  });

  it("refuses to move a node under its own descendant, trashed or not: parent_cycle, 400", async () => {
    const a = await insert(uniq("a"), "content");
    const b = await insert(uniq("b"), "content", { parent: a });
    const c = await insert(uniq("c"), "content", { parent: b });
    for (const under of [b, c]) {
      const e = await thrown(assertReparent(ws, node(a, "content", "a"), under, editor));
      expect(e, String(under)).toMatchObject({ code: "parent_cycle", status: 400, message: "cannot move a node under its own descendant" });
    }
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [c]);
    // c is gone, so it can't be a parent: that is parent_not_found, not a cycle
    expect(await thrown(assertReparent(ws, node(a, "content", "a"), c, editor))).toMatchObject({ code: "parent_not_found" });
    // a sibling is fine
    const d = await insert(uniq("d"), "content");
    expect(await thrown(assertReparent(ws, node(d, "content", "d"), b, editor))).toBeNull();
  });

  it("a parent the actor cannot read or write, or that is trashed or missing, is parent_not_found, 404", async () => {
    const hidden = await insert(uniq("hidden"), "content");
    await putInSpace(hidden, hiddenSpace);
    const trashed = await insert(uniq("trashed"), "content", { trashed: true });
    const child = await insert(uniq("child"), "content");
    for (const parent of [hidden, trashed, randomUUID()]) {
      const e = await thrown(assertReparent(ws, node(child, "content", "c"), parent, editor));
      expect(e, parent).toBeInstanceOf(ReparentError);
      expect(e, parent).toMatchObject({ code: "parent_not_found", status: 404, message: "parent not found" });
    }
  });

  it("a note stays in its parent's space: parent_in_other_space, 409; a move inside one space is fine", async () => {
    const inOther = await insert(uniq("in other"), "content");
    await putInSpace(inOther, otherSpace);
    const note = await insert(uniq("note"), "content"); // default space
    const e = await thrown(assertReparent(ws, node(note, "content", "n"), inOther, editor));
    expect(e).toBeInstanceOf(ReparentError);
    expect(e).toMatchObject({ code: "parent_in_other_space", status: 409, message: "parent_in_other_space" });
    const sameSpace = await insert(uniq("same space"), "content");
    expect(await thrown(assertReparent(ws, node(note, "content", "n"), sameSpace, editor))).toBeNull();
    // moving to the root needs no parent at all
    const underOther = await insert(uniq("under other"), "content", { parent: inOther });
    await putInSpace(underOther, otherSpace);
    expect(await thrown(assertReparent(ws, node(underOther, "content", "u", inOther), null, editor))).toBeNull();
  });

  it("the tag tree and the note tree are separate, in both directions, whatever space the note is in", async () => {
    const tag = await insert(uniq("tag"), "class_tag");
    const note = await insert(uniq("note"), "content");
    const noteInOther = await insert(uniq("note in other"), "content");
    await putInSpace(noteInOther, otherSpace);
    // Nesting under a tag definition is the owner's (it reaches every member), so the owner moves here.
    // a note under a tag: the kind rule answers (a tag has no space, so the space rule is skipped)
    for (const moving of [note, noteInOther]) {
      const e = await thrown(assertReparent(ws, node(moving, "content", "n"), tag, owner));
      expect(e).toBeInstanceOf(ParentKindError);
      expect(e).toMatchObject({ code: "parent_kind_mismatch", childIsTag: false, message: "a note's parent cannot be a tag" });
    }
    // a tag under a note
    const e = await thrown(assertReparent(ws, node(tag, "class_tag", "t"), note, owner));
    expect(e).toBeInstanceOf(ParentKindError);
    expect(e).toMatchObject({ childIsTag: true, message: "a tag's parent must be a tag" });
    // tag under tag is fine
    const parentTag = await insert(uniq("parent tag"), "class_tag");
    expect(await thrown(assertReparent(ws, node(tag, "class_tag", uniq("t")), parentTag, owner))).toBeNull();
  });

  it("assertParentKind: no parent and a parent that does not exist are not its business", async () => {
    expect(await thrown(assertParentKind(ws, "content", null))).toBeNull();
    expect(await thrown(assertParentKind(ws, "class_tag", null))).toBeNull();
    expect(await thrown(assertParentKind(ws, "content", randomUUID()))).toBeNull();
    expect(await thrown(assertParentKind(ws, "class_tag", randomUUID()))).toBeNull();
    // a parent of another workspace does not exist here
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Other', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    const foreignTag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color) VALUES ($1,'manual','class_tag',$2,$3,'','#888') RETURNING id::text`,
      [other, uniq("foreign"), randomUUID()])).rows[0]!.id;
    expect(await thrown(assertParentKind(ws, "content", foreignTag))).toBeNull();
    expect(await thrown(assertParentKind(other, "content", foreignTag))).toBeInstanceOf(ParentKindError);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [other]);
    await q(`DELETE FROM workspaces WHERE id = $1`, [other]);
  });

  it("a tag's name must be free under its new parent; a note's title is not unique", async () => {
    const parent = await insert(uniq("parent"), "class_tag");
    const name = uniq("same name");
    await insert(name, "class_tag", { parent });
    const mover = await insert(name, "class_tag");
    const e = await thrown(assertReparent(ws, node(mover, "class_tag", name), parent, owner));
    expect(e).toBeInstanceOf(TagNameConflictError);
    // the tag as renamed in the same save is judged under its new name
    expect(await thrown(assertReparent(ws, node(mover, "class_tag", uniq("other name")), parent, owner))).toBeNull();
    // notes may share a title under one parent
    const noteParent = await insert(uniq("note parent"), "content");
    await insert("same title", "content", { parent: noteParent });
    const note = await insert("same title", "content");
    expect(await thrown(assertReparent(ws, node(note, "content", "same title"), noteParent, editor))).toBeNull();
    // a tag moving to the root conflicts with a root tag of the same name
    const rootName = uniq("root name");
    await insert(rootName, "class_tag");
    const nested = await insert(rootName, "class_tag", { parent });
    expect(await thrown(assertReparent(ws, node(nested, "class_tag", rootName, parent), null, editor))).toBeInstanceOf(TagNameConflictError);
  });

  it("a tag does not come to declare a field its new ancestors already give", async () => {
    const book = await insert(uniq("book"), "class_tag", { schema: { fields: [{ name: "author", type: "text" }] } });
    const novel = await insert(uniq("novel"), "class_tag", { schema: { fields: [{ name: "author", type: "text" }] } });
    const e = await thrown(assertReparent(ws, node(novel, "class_tag", "novel"), book, owner));
    expect(e).toBeInstanceOf(FieldNameClashError);
    expect((e as FieldNameClashError).code).toBe("field_name_inherited");
    // a tag with a different field moves fine, and so does the move to the root
    const essay = await insert(uniq("essay"), "class_tag", { schema: { fields: [{ name: "year", type: "number" }] } });
    expect(await thrown(assertReparent(ws, node(essay, "class_tag", "essay"), book, owner))).toBeNull();
    expect(await thrown(assertReparent(ws, node(novel, "class_tag", uniq("novel")), null, owner))).toBeNull();
  });

  it("applies placement before the kind rule: an unreadable parent of the wrong kind is parent_not_found", async () => {
    const goneTag = await insert(uniq("gone tag"), "class_tag", { trashed: true });
    const note = await insert(uniq("note"), "content");
    expect(await thrown(assertReparent(ws, node(note, "content", "n"), goneTag, editor))).toMatchObject({ code: "parent_not_found" });
    // an editor may not nest under a live tag definition either; that is the owner's
    const liveTag = await insert(uniq("live tag"), "class_tag");
    const refused = await thrown(assertReparent(ws, node(note, "content", "n"), liveTag, editor));
    expect(refused).toMatchObject({ reason: "space" });
    expect(refused).not.toBeInstanceOf(ParentKindError);
  });

  it("ancestorIds lists the parents nearest first, trashed ones too, and nothing for a root or another workspace", async () => {
    const top = await insert(uniq("top"), "content");
    const mid = await insert(uniq("mid"), "content", { parent: top, trashed: true });
    const leaf = await insert(uniq("leaf"), "content", { parent: mid });
    expect(await ancestorIds(ws, leaf)).toEqual([mid, top]);
    expect(await ancestorIds(ws, mid)).toEqual([top]);
    expect(await ancestorIds(ws, top)).toEqual([]);
    expect(await ancestorIds(ws, randomUUID())).toEqual([]);
    expect(await ancestorIds(randomUUID(), leaf)).toEqual([]);
  });

  it("ancestorIds ends at the first repeated node when bad data holds a parent cycle", async () => {
    const x = await insert(uniq("x"), "content");
    const y = await insert(uniq("y"), "content", { parent: x });
    const z = await insert(uniq("z"), "content", { parent: y });
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [x, z]);
    expect((await ancestorIds(ws, z)).sort()).toEqual([x, y].sort());
    expect((await ancestorIds(ws, z))[0]).toBe(y);
  });
});
