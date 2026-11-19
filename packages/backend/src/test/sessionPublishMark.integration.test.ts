// The publish mark (`_published`) is a person's to set or clear, whichever path hands it over (services/attributeChange.ts storeAttributeState, the one
// writer of an attribute row). PR #1856 review round 4: a temporary session could restore an attribute event (POST /api/events/:event_id/restore is a
// kind of write it may do) and so put a note on the website, or take one off, around the earlier checks. Now it is refused, the mark stays as it was,
// and the person's own restore works as before.
//
// SAFETY: only runs against a *_test database; skips otherwise. Each test makes its own workspace (shared database; tests run shuffled).
import { afterAll, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { resolveTemporarySessionActor } from "../services/participantSessions.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

afterAll(async () => { await pool.end(); });

const mark = async (ws: string, note: string) =>
  (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE workspace_id = $1 AND node_id = $2 AND key = '_published'`, [ws, note])).rows[0]?.value ?? null;
const takenDown = async (ws: string) =>
  (await q<{ gone: string[] }>(`SELECT ARRAY(SELECT jsonb_array_elements_text(coalesce(payload->'taken_down', '[]'::jsonb))) AS gone FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [ws])).rows[0]!.gone;
/** The site as served: the latest snapshot carries the note (what a publish stored; modules/website/publishing/takenDown.ts subtracts `taken_down`). */
const servedWith = (ws: string, note: string) =>
  q(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload, artifact_ref) VALUES ($1, 'site', 0, $2, '/site/')`, [ws, JSON.stringify({ nodes: [{ id: note }], taken_down: [] })]);
const lastEvent = async (ws: string, note: string, type: string) =>
  (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = $3`, [ws, note, type])).rows[0]!.id;

/** A note in space A that the owner published (`set`), and one the owner published and then took off (`cleared`); a session on space A. */
async function world(label: string) {
  const w = await standardWorld(label);
  ownWorkspace = w.ws;
  const set = await newNote(w.ws, `${label} set`, w.spaceA);
  const cleared = await newNote(w.ws, `${label} cleared`, w.spaceA);
  for (const note of [set, cleared]) await setNodeAttribute({ workspaceId: w.ws, actor: w.owner.ctx, nodeId: note, attribute: { key: "_published", value: "true" } });
  await recordAttributeChange({ workspaceId: w.ws, nodeId: cleared, key: "_published", actor: w.owner.ctx, next: null, rule: "always",
    authority: { kind: "node", nodeId: cleared, op: "delete_attribute" }, uiContext: "test.publish" });
  await awaitAllDispatchers();
  const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
  const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
  return { ...w, set, cleared, session, setEvent: await lastEvent(w.ws, set, "ATTRIBUTE_SET"), clearEvent: await lastEvent(w.ws, cleared, "ATTRIBUTE_DELETED") };
}

describe.skipIf(!isTestDatabase())("the publish mark through the restore of an event", () => {
  it("a session restoring the owner's publishing (which would take the page off the site) is refused, and the mark stays", async () => {
    const w = await world("markRestoreSet");
    expect(await mark(w.ws, w.set)).toBe("true");
    await expect(restoreEvent(w.setEvent, { actor: w.session, workspaceId: w.ws })).rejects.toMatchObject({ name: "AuthorityError", reason: "publish_mark" });
    expect(await mark(w.ws, w.set)).toBe("true");
  });

  it("a session restoring the owner's taking-off (which would put the note on the site at the next publish) is refused, and the mark stays off", async () => {
    const w = await world("markRestoreClear");
    expect(await mark(w.ws, w.cleared)).toBeNull();
    await expect(restoreEvent(w.clearEvent, { actor: w.session, workspaceId: w.ws })).rejects.toMatchObject({ name: "AuthorityError", reason: "publish_mark" });
    expect(await mark(w.ws, w.cleared)).toBeNull();
    // and nothing the session did is recorded for the note's mark
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND actor_id = $3`,
      [w.ws, w.cleared, w.session.id])).rows[0]!.n)).toBe(0);
  });

  it("the page on the website stays: the session's refused restore of the publishing records no take-down; the owner's same restore does", async () => {
    const w = await world("markRestoreSite");
    await servedWith(w.ws, w.set);
    await expect(restoreEvent(w.setEvent, { actor: w.session, workspaceId: w.ws })).rejects.toMatchObject({ reason: "publish_mark" });
    expect(await takenDown(w.ws)).toEqual([]);
    // control: the same restore by the owner takes the page off at once (so an empty list above is the refusal, not a hook that never runs)
    const undone = await restoreEvent(w.setEvent, { actor: w.owner.ctx, workspaceId: w.ws });
    expect("restored" in undone, JSON.stringify(undone)).toBe(true);
    expect(await takenDown(w.ws)).toEqual([w.set]);
  });

  it("through the route: the session's PUT and DELETE of the mark answer 403, and the mark stays", async () => {
    const w = await world("markRoute");
    const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
    hono.onError(apiOnError);
    hono.use("*", async (c, next) => { c.set("actor", w.session); await next(); });
    hono.route("/api/nodes", nodesRouter);
    const send = (note: string, method: string, body?: unknown) => hono.request(`/api/nodes/${note}/attributes/_published`,
      { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send(w.cleared, "PUT", { value: "true" })).status).toBe(403);
    expect((await send(w.set, "DELETE")).status).toBe(403);
    expect([await mark(w.ws, w.cleared), await mark(w.ws, w.set)]).toEqual([null, "true"]);
  });

  it("control: the owner's own restore of the same events works as before", async () => {
    const w = await world("markRestoreOwner");
    const undone = await restoreEvent(w.clearEvent, { actor: w.owner.ctx, workspaceId: w.ws });
    expect("restored" in undone, JSON.stringify(undone)).toBe(true);
    expect(await mark(w.ws, w.cleared)).toBe("true");
  });
});
