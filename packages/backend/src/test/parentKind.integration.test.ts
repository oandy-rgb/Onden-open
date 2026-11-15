// The tag tree and the note tree are separate (audit T12,
// services/parentKind.ts): a tag's parent is a tag or none, a note's parent is
// not a tag. New writes that would mix them are refused with 409
// parent_kind_mismatch; rows that already mix them still save and trash.
// Trashing a note never takes a tag along.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import pointersRouter from "../routes/pointers.js";
import { createTag } from "../services/tagHierarchy.js";
import { ParentKindError } from "../services/parentKind.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A workspace of the file's own (its owner is this file's actor, not a change
// to the shared 'default' workspace); the routes find it through getWorkspaceId.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/pointers", pointersRouter);

const J = { "content-type": "application/json" };
const send = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(path, { method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) }));
const row = async (id: string) =>
  (await q<{ parent_id: string | null; title: string; deleted_at: Date | null }>(
    `SELECT parent_id::text, title, deleted_at FROM content_nodes WHERE id = $1`, [id])).rows[0]!;

describe.skipIf(!isTestDb)("tag tree and note tree are separate (T12)", () => {
  const stamp = Date.now();
  let owner: ActorCtx = { id: "pk-owner", name: "Owner", role: "admin", type: "human" };
  let tag = "", note = "", otherNote = "";

  const mk = async (label: string, kind: "content" | "class_tag", parent: string | null): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_color)
       VALUES ($1,'manual',$2,$3,$4,'body',$5,$6) RETURNING id::text`,
      [WS, kind, `pk${label}${stamp}`, `pk-${label}-${stamp}`, parent, kind === "class_tag" ? "#888" : null])).rows[0]!.id;
  const expectRefused = async (res: Response, detail: string) => {
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "parent_kind_mismatch", detail });
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Parent kind', $1) RETURNING id::text`,
      [`parent-kind-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, owner); // a human admin: it owns this workspace
    currentActor = owner;
    tag = await mk("tag", "class_tag", null);
    note = await mk("note", "content", null);
    otherNote = await mk("other", "content", null);
  });

  it("creating a note under a tag is refused; under a note it works", async () => {
    await expectRefused(await send("POST", "/api/nodes", { title: `pk new ${stamp}`, markdown: "", parent_id: tag }),
      "a note's parent cannot be a tag");
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [`pk new ${stamp}`])).rowCount).toBe(0);
    expect((await send("POST", "/api/nodes", { title: `pk child ${stamp}`, markdown: "", parent_id: note })).status).toBe(201);
  });

  it("creating a tag under a note is refused; under a tag it works", async () => {
    await expect(createTag({ actor: owner, workspaceId: WS, name: `pkbad${stamp}`, parentId: note })).rejects.toBeInstanceOf(ParentKindError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [`pkbad${stamp}`])).rowCount).toBe(0);
    const child = await createTag({ actor: owner, workspaceId: WS, name: `pkgood${stamp}`, parentId: tag });
    expect((await row(child.id)).parent_id).toBe(tag);
  });

  it("reparenting is refused both ways, and allowed within each tree", async () => {
    await expectRefused(await send("PATCH", `/api/nodes/${note}`, { parent_id: tag }), "a note's parent cannot be a tag");
    expect((await row(note)).parent_id).toBeNull();
    await expectRefused(await send("PATCH", `/api/nodes/${tag}`, { parent_id: note }), "a tag's parent must be a tag");
    expect((await row(tag)).parent_id).toBeNull();
    expect((await send("PATCH", `/api/nodes/${otherNote}`, { parent_id: note })).status).toBe(200);
    expect((await send("PATCH", `/api/nodes/${otherNote}`, { parent_id: null })).status).toBe(200);
  });

  // D101: a pin (note_pointers) under a tag was accepted and never shown — the
  // notes tree has no tag rows. It is refused like every other new parent.
  it("pinning a note under a tag is refused (no row, no event); under a note it works", async () => {
    const pinned = await mk("pinned", "content", null);
    const pointers = async () => (await q<{ parent_id: string }>(
      `SELECT parent_id::text FROM note_pointers WHERE workspace_id = $1 AND target_id = $2 ORDER BY parent_id`, [WS, pinned])).rows;
    const events = async () => (await q(
      `SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'POINTER_CREATED' AND target_id = $2`, [WS, pinned])).rowCount;
    await expectRefused(await send("POST", "/api/pointers", { target_id: pinned, parent_id: tag }), "a note's parent cannot be a tag");
    expect(await pointers()).toEqual([]);
    expect(await events()).toBe(0);
    const ok = await send("POST", "/api/pointers", { target_id: pinned, parent_id: note });
    expect(ok.status).toBe(201);
    expect(await pointers()).toEqual([{ parent_id: note }]);
    expect(await events()).toBe(1);
    // A tag is not pinned under a note either; the kinds are compared both ways.
    const tagTarget = await mk("pintag", "class_tag", null);
    await expectRefused(await send("POST", "/api/pointers", { target_id: tagTarget, parent_id: note }), "a tag's parent must be a tag");
  });

  it("an existing mixed row still saves when its parent is kept, and trashes", async () => {
    const underTag = await mk("legacy-note", "content", tag);
    const tagUnderNote = await mk("legacytag", "class_tag", note);
    expect((await send("PATCH", `/api/nodes/${underTag}`, { title: `pk renamed ${stamp}`, markdown: "edited" })).status).toBe(200);
    expect((await row(underTag)).title).toBe(`pk renamed ${stamp}`);
    // Sending the same parent again is not a new parent.
    expect((await send("PATCH", `/api/nodes/${underTag}`, { parent_id: tag, markdown: "again" })).status).toBe(200);
    expect((await send("PATCH", `/api/nodes/${tagUnderNote}`, { parent_id: note, sort_order: 3 })).status).toBe(200);
    // Moving it out to the root is always allowed.
    expect((await send("PATCH", `/api/nodes/${underTag}`, { parent_id: null })).status).toBe(200);
    // A legacy note can still go to the trash.
    const another = await mk("legacy-note2", "content", tag);
    expect((await send("DELETE", `/api/nodes/${another}`)).status).toBeLessThan(300);
    expect((await row(another)).deleted_at).not.toBeNull();
  });

  it("trashing a note does not take a tag under it along (nor what is below that tag)", async () => {
    const parentNote = await mk("host", "content", null);
    const childNote = await mk("host-child", "content", parentNote);
    const legacyTag = await mk("hosttag", "class_tag", parentNote);
    const subTag = await mk("hostsubtag", "class_tag", legacyTag);
    await trashNode(owner, WS, parentNote);
    expect((await row(parentNote)).deleted_at).not.toBeNull();
    expect((await row(childNote)).deleted_at, "a child note goes with it").not.toBeNull();
    expect((await row(legacyTag)).deleted_at, "the tag is global and stays").toBeNull();
    expect((await row(subTag)).deleted_at).toBeNull();
    await undeleteNode(owner, WS, parentNote);
    expect((await row(childNote)).deleted_at).toBeNull();
    expect((await row(legacyTag)).deleted_at).toBeNull();
  });

  it("trashing a tag still takes its sub-tags and the notes filed under it (T7)", async () => {
    const top = await mk("toptag", "class_tag", null);
    const sub = await mk("subtag", "class_tag", top);
    const filed = await mk("filed", "content", top);
    await trashNode(owner, WS, top);
    expect((await row(sub)).deleted_at).not.toBeNull();
    expect((await row(filed)).deleted_at).not.toBeNull();
  });
});
