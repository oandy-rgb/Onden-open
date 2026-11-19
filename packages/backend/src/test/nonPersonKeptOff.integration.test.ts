// 「不發布」 that a new note takes from where it is made or copied from is not a choice of the publish mark, so an AI's token and a temporary
// session write it like a person does; choosing the mark (setting 「發布」, clearing it, turning an existing note 「不發布」) stays a person's
// (services/attributeChange.ts assertActorMayWriteAttributeKey; PR #1856 review round 5, point 1: round 4 had refused the inherited 'false' too,
// so an AI or a session could not make a note under a 「不發布」 one, copy one, expand a template there or make a paragraph a child note).
// Real actors: a token resolved from its plaintext (resolveBearerActor) and a session resolved from its credential, each in its own workspace.
//
// SAFETY: only runs against a *_test database; skips otherwise. Each test makes its own workspace (shared database; tests run shuffled).
import { afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { newNoteProof } from "../services/newNoteProof.js";
import { createNote } from "../services/noteCreate.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { moveBlockToChildNote } from "../services/blockChildNote.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { resolveTemporarySessionActor } from "../services/participantSessions.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import importRouter from "../modules/importers/routes.js";
import type { ActorCtx } from "../types.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

afterAll(async () => { await pool.end(); });

const mark = async (note: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [note])).rows[0]?.value ?? null;
const BODY = "第一段。\n\n要搬出去的一段。\n";

/** Space A with an owner's note kept off the site (`off`, explicit 'false') and one put on it (`on`, 'true'); the actor under test. */
async function world(label: string, who: "token" | "session") {
  const w = await standardWorld(label);
  ownWorkspace = w.ws;
  const off = await newNote(w.ws, `${label} off`, w.spaceA, BODY);
  const on = await newNote(w.ws, `${label} on`, w.spaceA);
  await setNodeAttribute({ workspaceId: w.ws, actor: w.owner.ctx, nodeId: off, attribute: { key: "_published", value: "false" } });
  await setNodeAttribute({ workspaceId: w.ws, actor: w.owner.ctx, nodeId: on, attribute: { key: "_published", value: "true" } });
  await awaitAllDispatchers();
  let actor: ActorCtx;
  if (who === "token") {
    const token = await createToken(w.owner.id, { access: "write" });
    actor = (await resolveBearerActor(token.plaintext, w.ws))!;
    expect(actor.tokenScope, "a real token actor").toBeTruthy();
  } else {
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    actor = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
    expect(actor.type).toBe("session");
  }
  return { ...w, off, on, actor };
}

function routes(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/nodes", nodesRouter);
  hono.route("/api/import", importRouter);
  return hono;
}

/** Two notes imported earlier from one source (in space A, which publishes; unchanged since); then `who` re-imports both through the
 *  import route: `kept`'s file changed and says publish: false, `other`'s file only changed. */
async function reimport(w: Awaited<ReturnType<typeof world>>, who: ActorCtx) {
  const source = { id: randomUUID(), name: "re-import" };
  const first = async (path: string) => {
    const answer = await importMarkdownNote({ actor: w.owner.ctx, workspaceId: w.ws, source, file: { path, content: `---\ntitle: ${path}\n---\nfirst body` }, parentId: w.on, reuse: false });
    expect(answer.status).toBe("imported");
    return (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [w.ws, path])).rows[0]!.id;
  };
  const keptPath = `kept-${randomUUID().slice(0, 6)}.md`, otherPath = `other-${randomUUID().slice(0, 6)}.md`;
  const kept = await first(keptPath), other = await first(otherPath);
  // on the website because its space publishes (no mark of its own: the note is as imported, so the re-import may update it)
  await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE id = $1`, [w.spaceA]);
  await awaitAllDispatchers();
  const res = await routes(who).request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    source, upsert: true, files: [
      { path: keptPath, content: `---\ntitle: ${keptPath}\npublish: false\n---\nchanged body` },
      { path: otherPath, content: `---\ntitle: ${otherPath}\n---\nchanged body` },
    ] }) });
  const answer = await res.json() as { conflicts?: Array<{ path: string; reason: string }>; updated?: number };
  const body = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  return { status: res.status, answer, kept: { mark: await mark(kept), body: await body(kept) }, other: { body: await body(other) }, keptPath };
}

describe.skipIf(!isTestDatabase()).each(["token", "session"] as const)("「不發布」 a new note takes is written for an AI's token and a session too (%s)", (who) => {
  it("a note made under a 「不發布」 note starts 「不發布」", async () => {
    const w = await world(`keptOffCreate${who}`, who);
    const made = await createNote({ actor: w.actor, workspaceId: w.ws, title: "child", markdown: "x", parentId: w.off, event: { uiContext: "test" } });
    expect(await mark(String(made.node.id))).toBe("false");
  });

  it("a copy of a 「不發布」 note stays 「不發布」", async () => {
    const w = await world(`keptOffCopy${who}`, who);
    const copy = await duplicateNote({ workspaceId: w.ws, actor: w.actor, sourceId: w.off });
    expect(await mark(String(copy.node.id))).toBe("false");
  });

  it("a paragraph of a 「不發布」 note made a child note starts 「不發布」", async () => {
    const w = await world(`keptOffBlock${who}`, who);
    const anchor = await ensureBlockAnchor(w.ws, w.off, BODY, BODY.indexOf("要搬出去"), { actor: w.actor });
    const moved = await moveBlockToChildNote({ workspaceId: w.ws, actor: w.actor, noteId: w.off, blockRef: anchor!, fallbackTitle: "moved", keepIdentity: false });
    expect(await mark(String(moved.childId))).toBe("false");
  });

  it("a template's notes made under a 「不發布」 note start 「不發布」", async () => {
    const w = await world(`keptOffTpl${who}`, who);
    const { tagId } = await seedClassTag(w.ws, { name: `tpl ${randomUUID().slice(0, 6)}`, templateChildren: [{ title: "Slot", body: "" }] });
    const res = await routes(w.actor).request(`/api/nodes/${w.off}/tags/${tagId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status, await res.clone().text()).toBe(200);
    const slots = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1 AND title = 'Slot'`, [w.off])).rows;
    expect(slots).toHaveLength(1);
    expect(await mark(slots[0]!.id)).toBe("false");
  });

  it("an imported file that says publish: false, made a new note, starts 「不發布」", async () => {
    const w = await world(`keptOffImport${who}`, who);
    const title = `Imported ${randomUUID().slice(0, 6)}`;
    const answer = await importMarkdownNote({ actor: w.actor, workspaceId: w.ws, source: { id: randomUUID(), name: "kept-off" } as never,
      file: { path: `${randomUUID()}.md`, content: `---\ntitle: ${title}\npublish: false\n---\nbody` }, parentId: w.on, reuse: false });
    expect(answer.status, JSON.stringify(answer)).toBe("imported");
    const id = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [w.ws, title])).rows[0]!.id;
    expect(await mark(id)).toBe("false");
  });

  it("choosing the mark stays a person's: setting 「發布」, clearing 「不發布」, and turning an existing note 「不發布」 are refused, and nothing changes", async () => {
    const w = await world(`keptOffChoice${who}`, who);
    await expect(setNodeAttribute({ workspaceId: w.ws, actor: w.actor, nodeId: w.off, attribute: { key: "_published", value: "true" } }))
      .rejects.toMatchObject({ name: "AuthorityError", reason: "publish_mark" });
    await expect(recordAttributeChange({ workspaceId: w.ws, nodeId: w.off, key: "_published", actor: w.actor, next: null, rule: "always",
      authority: { kind: "node", nodeId: w.off, op: "delete_attribute" }, uiContext: "test" })).rejects.toMatchObject({ reason: "publish_mark" });
    await expect(setNodeAttribute({ workspaceId: w.ws, actor: w.actor, nodeId: w.on, attribute: { key: "_published", value: "false" } }))
      .rejects.toMatchObject({ reason: "publish_mark" });
    expect([await mark(w.off), await mark(w.on)]).toEqual(["false", "true"]);
  });

  it("a re-import through the import route that would take an existing note off the website: that file is refused with why, the mark and its text stay, the other file goes on", async () => {
    const w = await world(`keptOffReimport${who}`, who);
    const r = await reimport(w, w.actor);
    expect(r.status).toBe(200);
    expect(r.answer.conflicts).toEqual([{ path: r.keptPath, reason: "site_mark" }]);
    expect(r.kept).toEqual({ mark: null, body: expect.stringContaining("first body") });
    expect(r.other.body).toContain("changed body");
  });

  it("a note that is already 「不發布」 is updated by its re-import that still says publish: false (left as it is: not a choice, nothing to refuse)", async () => {
    const w = await world(`keptOffKeep${who}`, who);
    const source = { id: randomUUID(), name: "keep" };
    const path = `keep-${randomUUID().slice(0, 6)}.md`;
    const first = await importMarkdownNote({ actor: w.actor, workspaceId: w.ws, source, file: { path, content: `---\ntitle: ${path}\npublish: false\n---\nfirst body` }, parentId: w.on, reuse: false });
    expect(first.status).toBe("imported");
    const id = (first as { nodeId: string }).nodeId;
    expect(await mark(id)).toBe("false");
    const res = await routes(w.actor).request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, upsert: true, files: [{ path, content: `---\ntitle: ${path}\npublish: false\n---\nchanged body` }] }) });
    const answer = await res.json() as { conflicts?: unknown[]; updated?: number };
    expect([res.status, answer.conflicts ?? [], answer.updated]).toEqual([200, [], 1]);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown).toContain("changed body");
    expect(await mark(id)).toBe("false");
  });

  it("control: the person's same re-import takes the note off the website and updates both", async () => {
    const w = await world(`keptOffReimportOwner${who}`, who);
    const r = await reimport(w, w.owner.ctx);
    expect(r.answer.conflicts ?? []).toEqual([]);
    expect(r.kept).toEqual({ mark: "false", body: expect.stringContaining("changed body") });
    expect(r.other.body).toContain("changed body");
  });

  it("only 「不發布」 is carried: a new note's 「發布」 is refused even with its proof, and a proof does not reach another note", async () => {
    const w = await world(`keptOffTrue${who}`, who);
    const made = await createNote({ actor: w.actor, workspaceId: w.ws, title: "child of on", markdown: "x", parentId: w.on, event: { uiContext: "test" } });
    const child = String(made.node.id);
    const write = (nodeId: string, value: string, proofFor: string) => recordAttributeChange({ workspaceId: w.ws, nodeId, key: "_published", actor: w.actor, rule: "always",
      newNote: newNoteProof(proofFor), next: { value, value_type: "text", is_inheritable: false, source: "derived" }, authority: { kind: "node", nodeId, op: "set_attribute" }, uiContext: "test" });
    await expect(write(child, "true", child)).rejects.toMatchObject({ reason: "publish_mark" });
    expect(await mark(child)).toBeNull();
    // and a proof is for its own note: one for the new note does not let 'false' onto another, existing note
    await expect(write(w.on, "false", child)).rejects.toMatchObject({ reason: "publish_mark" });
    expect(await mark(w.on)).toBe("true");
  });

  it("a tag whose field defaults `_published` to false, applied to an existing published note, leaves the mark as it is (a system key is never a default)", async () => {
    const w = await world(`keptOffFieldDefault${who}`, who);
    const { tagId } = await seedClassTag(w.ws, { name: `kept ${randomUUID().slice(0, 6)}`, fields: [{ name: "_published", type: "text", default: "false" }] });
    // a note on the website through its space, with no mark of its own (so a default, written only where the key is absent, would land)
    await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE id = $1`, [w.spaceA]);
    const plain = await newNote(w.ws, `${who} plain`, w.spaceA);
    const res = await routes(w.actor).request(`/api/nodes/${plain}/tags/${tagId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await mark(plain)).toBeNull();
  });
});
