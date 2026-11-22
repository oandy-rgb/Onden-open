// A module's own tag (tag_schema.module = <module id>) cannot be deleted, merged away or be a merge target while
// the module is on; with the module off the ordinary flow stays (the owner clears it from RemovedModuleTags).
// Owner report 2026-11-18: 「我不應該能刪掉收件夾的」 — only the tasks module's tag was protected
// (reservedTags.assertTagDefinitionChange was written for one module, not the class).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import nodes from "../routes/nodes.js";
import tags from "../routes/tags.js";
import captureRouter from "../modules/capture/routes.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { setModuleImported } from "../services/workspaceModules.js";
import type { ActorCtx } from "../types.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

function call(actor: ActorCtx, method: string, path: string, body?: unknown) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await withIdempotencyKey(c.req.header("Idempotency-Key") ?? randomUUID(), next);
  });
  app.route("/api/capture", captureRouter);
  app.route("/api/nodes", nodes);
  app.route("/api/tags", tags);
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const inboxId = async (actor: ActorCtx) =>
  ((await (await call(actor, "POST", "/api/capture/inbox", {})).json()) as { tag_id: string }).tag_id;
const liveModuleTags = async (module: string) => (await q<{ id: string }>(
  `SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL AND tag_schema->>'module' = $2`,
  [ws, module])).rows.map((r) => r.id);
const trashed = async (id: string) => (await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NOT NULL`, [id])).rowCount === 1;
const capture = async (actor: ActorCtx, tagId: string, title: string) => {
  const id = randomUUID();
  const res = await call(actor, "POST", "/api/nodes", { id, title, markdown: title, parent_id: null, tag_ids: [tagId], attributes: [{ key: "_captured", value: "true" }] });
  expect(res.status).toBe(201);
  return id;
};
const hasTag = async (noteId: string, tagId: string) =>
  (await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [noteId, tagId])).rowCount === 1;

// The state of a workspace that deleted its module tag before this rule: the real delete route, which the rule now refuses,
// so the module mark is taken off for that one call (the state before the rule), then put back.
async function deleteAsBefore(actor: ActorCtx, id: string): Promise<void> {
  await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema - 'module' WHERE id = $1`, [id]);
  expect((await call(actor, "DELETE", `/api/nodes/${id}`)).status).toBe(200);
  await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"capture"}'::jsonb WHERE id = $1`, [id]);
  expect(await trashed(id)).toBe(true);
}

// Capture is a built-in module (no switch, always on): its tag is protected for good. Skills is a library module:
// protected while on, an ordinary tag while off. Tasks keeps its own, unconditional rule (reservedTagDefinition test).
describe.skipIf(!isTestDb)("a module's own tag survives while the module is on", () => {
  let owner: ActorCtx = { id: "", name: "Owner", role: "owner", type: "human" };
  const skillsTag = async () => (await liveModuleTags("skills"))[0];
  const turnSkills = (imported: boolean) => setModuleImported({ actor: owner, workspaceId: ws, module: "skills", imported, tagName: "skill" });

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('module tag', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, owner);
    await setModulesOn(ws, null);
  });

  it("deleting the inbox is refused: 409 module_tag, nothing changed, and the message does not call it #task", async () => {
    const id = await inboxId(owner);
    const eventsBefore = (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1`, [ws])).rowCount;
    const res = await call(owner, "DELETE", `/api/nodes/${id}`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("module_tag");
    expect(body.detail).not.toContain("#task");
    expect(await trashed(id)).toBe(false);
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1`, [ws])).rowCount).toBe(eventsBefore);
  });

  it("merging the inbox away, or merging another tag into it, is refused and nothing changes", async () => {
    const id = await inboxId(owner);
    const other = ((await (await call(owner, "POST", "/api/tags/import", { name: `plain-${randomUUID()}`, fields: [] })).json()) as { id: string }).id;
    const asSource = await call(owner, "POST", `/api/tags/${id}/merge`, { target_id: other });
    expect(asSource.status).toBe(409);
    expect(((await asSource.json()) as { error: string }).error).toBe("module_tag");
    const asTarget = await call(owner, "POST", `/api/tags/${other}/merge`, { target_id: id });
    expect(asTarget.status).toBe(409);
    expect(((await asTarget.json()) as { error: string }).error).toBe("merge_into_module_tag"); // tagMerge.assertMergeTarget, on or off
    expect(await trashed(id)).toBe(false);
    expect(await trashed(other)).toBe(false);
  });

  it("an ordinary tag can still be deleted", async () => {
    const other = ((await (await call(owner, "POST", "/api/tags/import", { name: `plain-${randomUUID()}`, fields: [] })).json()) as { id: string }).id;
    expect((await call(owner, "DELETE", `/api/nodes/${other}`)).status).toBe(200);
    expect(await trashed(other)).toBe(true);
  });

  it("a library module's tag: refused while the module is on, deletable while off, and turning it on makes a live one", async () => {
    await turnSkills(true);
    const id = (await skillsTag())!;
    expect(id).toBeTruthy();
    const refused = await call(owner, "DELETE", `/api/nodes/${id}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("module_tag");
    const other = ((await (await call(owner, "POST", "/api/tags/import", { name: `plain-${randomUUID()}`, fields: [] })).json()) as { id: string }).id;
    expect((await call(owner, "POST", `/api/tags/${id}/merge`, { target_id: other })).status).toBe(409);
    expect((await call(owner, "POST", `/api/tags/${other}/merge`, { target_id: id })).status).toBe(409);

    await turnSkills(false);
    expect((await call(owner, "DELETE", `/api/nodes/${id}`)).status).toBe(200);
    expect(await trashed(id)).toBe(true);

    // Turning it on again makes the module's tag (not revived: only the inbox is, see moduleTagRevive.ts).
    await turnSkills(true);
    expect(await liveModuleTags("skills")).toHaveLength(1);
  });

  it("an inbox deleted before it was protected comes back at the next capture, with the notes filed in it, and not twice", async () => {
    const id = await inboxId(owner);
    const note = await capture(owner, id, "buy milk");
    // The owner's state, made the way it was: the delete route, which the rule now refuses — so the module mark is taken off
    // for that one call (the state before this rule), then put back.
    await deleteAsBefore(owner, id);
    expect(await liveModuleTags("capture")).toEqual([]);
    const eventsBefore = (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_UNDELETED' AND target_id = $2`, [ws, id])).rowCount;

    expect(await inboxId(owner)).toBe(id);
    expect(await liveModuleTags("capture")).toEqual([id]);
    expect(await hasTag(note, id)).toBe(true);
    // It came back through an event (History shows it), exactly once; asking again changes nothing.
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_UNDELETED' AND target_id = $2`, [ws, id])).rowCount).toBe(eventsBefore! + 1);
    expect(await inboxId(owner)).toBe(id);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND tag_schema->>'module' = 'capture'`, [ws])).rowCount).toBe(1);
    // And it is protected again — from History too: undoing the bring-back would trash it.
    expect((await call(owner, "DELETE", `/api/nodes/${id}`)).status).toBe(409);
    const revived = (await q<{ id: string }>(`SELECT e.id::text AS id FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.event_type = 'NODE_UNDELETED' ORDER BY e.id DESC`, [ws, id])).rows[0]!.id;
    expect(await restoreEvent(revived, { actor: owner, workspaceId: ws })).toMatchObject({ code: "module_tag", status: 409 });
    expect(await liveModuleTags("capture")).toEqual([id]);
  });

  it("when a live tag already took the inbox's name meanwhile, nothing is brought back and a new inbox is made as before", async () => {
    const saved = ws;
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('module tag taken', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    try {
      const member = await persistActor(ws, { id: "", name: "Owner", role: "owner", type: "human" });
      const id = await inboxId(member);
      await deleteAsBefore(member, id);
      const title = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title;
      await call(member, "POST", "/api/tags/import", { name: title, fields: [] });
      const next = await inboxId(member);
      expect(next).not.toBe(id);
      expect(await trashed(id)).toBe(true);
    } finally { ws = saved; }
  });
});
