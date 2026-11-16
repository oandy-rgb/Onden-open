import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { event, q, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { restoreEvent, previewEventRestore } from "../services/eventRestore/index.js";
import { recordedTagMembership } from "../services/tagMembership.js";
import * as membership from "../services/tagMembership.js";
import { createImportedRow } from "../modules/importers/notion/database.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import type { EventRow } from "../services/eventRestore/index.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import { AuthorityError } from "../spine/authority.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /(?:onden_test|\w+_test)(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let admin: ActorCtx = { id: "membership-admin", name: "Membership admin", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/nodes", nodesRouter);
async function fixture() {
  const nodeId = (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,title,slug,node_type,source_type)
    VALUES($1,'Membership test',$2,'content','manual') RETURNING id`, [workspaceId, randomUUID()])).rows[0]!.id;
  const { tagId } = await seedClassTag(workspaceId, { name: `Membership tag ${randomUUID()}`, slug: randomUUID() });
  return { nodeId, tagId };
}
type Pair = Awaited<ReturnType<typeof fixture>>;
const apply = (p: Pair) => app.request(`/nodes/${p.nodeId}/tags/${p.tagId}`, { method: "PUT" });
const remove = (p: Pair) => app.request(`/nodes/${p.nodeId}/tags/${p.tagId}`, { method: "DELETE" });
const restore = (id: string, extra = {}) => restoreEvent(id, { actor: admin, workspaceId, ...extra });
async function latest(p: Pair) {
  return (await q<EventRow>(`SELECT id::text,event_type,payload,tx_meta FROM domain_events
    WHERE target_id=$1 AND event_type IN ('TAG_APPLIED','TAG_REMOVED') ORDER BY domain_events.id DESC LIMIT 1`, [p.nodeId])).rows[0]!;
}
async function state(p: Pair) {
  return (await q<{ is_applied: boolean; state_id: string | null }>(
    `SELECT is_applied,state_id::text FROM node_tag_states WHERE node_id=$1 AND tag_id=$2`, [p.nodeId, p.tagId])).rows[0];
}
async function epoch() {
  return BigInt((await q<{ epoch: string }>(`SELECT membership_epoch::text AS epoch FROM workspaces WHERE id=$1`, [workspaceId])).rows[0]!.epoch);
}
async function countEvents(p: Pair) {
  return (await q<{ count: string }>(`SELECT count(*)::text FROM domain_events WHERE target_id=$1`, [p.nodeId])).rows[0]!.count;
}

describe.skipIf(!isTestDb)("tag membership restore lineage", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Membership restore',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    admin = await persistActor(workspaceId, admin);
  });

  it("rejects a stale apply after remove/reapply, including force and preview", async () => {
    const p = await fixture();
    expect((await apply(p)).status).toBe(200);
    const first = await latest(p);
    await remove(p); await apply(p);
    const current = await state(p);
    const count = await countEvents(p);
    const beforeEpoch = await epoch();
    expect(await restore(first.id, { force: true })).toMatchObject({ code: "state_conflict", force_available: false });
    expect(await previewEventRestore(first.id, { actor: admin, workspaceId })).toMatchObject({ preview: {
      currently_applied: true, can_apply_cleanly: false, conflict_code: "state_conflict", force_available: false,
    } });
    expect(await state(p)).toEqual(current);
    expect(await epoch()).toBe(beforeEpoch);
    expect(await countEvents(p)).toBe(count);
  });

  it("protects a later absence and permits a verified chain of undo and redo", async () => {
    const p = await fixture();
    await apply(p); const first = await latest(p);
    await remove(p); const second = await latest(p);
    await apply(p); const third = await latest(p);
    await remove(p); const fourth = await latest(p);
    expect(await restore(second.id)).toMatchObject({ code: "state_conflict" });
    for (const e of [fourth, third, second, first]) expect(await restore(e.id)).toMatchObject({ restored: true });
    expect(await state(p)).toEqual({ is_applied: false, state_id: null });
    const inverse = await latest(p);
    expect(await restore(inverse.id)).toMatchObject({ restored: true, restore_event_type: "TAG_APPLIED" });
    expect((await state(p))?.is_applied).toBe(true);
    expect(await restore((await latest(p)).id)).toMatchObject({ restored: true });
    expect((await state(p))?.is_applied).toBe(false);
  });

  it("tracks eventless SQL writes too; no-op writes keep the original identity", async () => {
    const p = await fixture();
    await apply(p); const original = await latest(p);
    const before = await state(p);
    expect(await (await apply(p)).json()).toMatchObject({ noop: true });
    expect(await state(p)).toEqual(before);
    await withTransaction(async () => {
      await seedQ(`DELETE FROM node_tags WHERE node_id=$1 AND tag_id=$2`, [p.nodeId, p.tagId]);
      await seedQ(`INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)`, [p.nodeId, p.tagId]);
    });
    expect(await restore(original.id)).toMatchObject({ code: "state_conflict" });
  });

  it("does not invalidate unrelated memberships, but rejects unprovable legacy history", async () => {
    const p = await fixture();
    await apply(p); const first = await latest(p);
    await apply(await fixture());
    expect(await restore(first.id)).toMatchObject({ restored: true });
    await apply(p);
    const legacyId = await event(workspaceId, "TAG_APPLIED", "node", p.nodeId, { tag_id: p.tagId }, "user", admin.id);
    expect(await restore(legacyId)).toMatchObject({ code: "history_incomplete", force_available: false });
    expect((await state(p))?.is_applied).toBe(true);
  });

  it("rolls back successful siblings and their state identities when a cascade conflicts", async () => {
    const p = await fixture();
    const root = await event(workspaceId, "NODE_UPDATED", "node", p.nodeId, { title: "Membership test" }, "user", admin.id,
      { txMeta: { prev_field_values: { title: "Original" } } });
    await withEventTransaction(workspaceId, async () => {
      await seedQ(`INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)`, [p.nodeId, p.tagId]);
      await event(workspaceId, "TAG_APPLIED", "node", p.nodeId,
        { tag_id: p.tagId, ...await recordedTagMembership(p.nodeId, p.tagId, true) }, "user", admin.id, { triggeredBy: root });
      await seedQ(`INSERT INTO node_attributes(workspace_id,node_id,key,value,value_type,source)
        VALUES($1,$2,'cascade-test','new','text','ui')`, [workspaceId, p.nodeId]);
      await event(workspaceId, "ATTRIBUTE_SET", "node", p.nodeId,
        { key: "cascade-test", value: "new", value_type: "text", is_inheritable: false, source: "ui" }, "user", admin.id,
        { triggeredBy: root, txMeta: { inverse_op: "attribute.deleted", prev_field_values: null } });
    });
    await remove(p); await apply(p);
    const current = await state(p); const count = await countEvents(p); const beforeEpoch = await epoch();
    expect(await restore(root, { cascade: true })).toMatchObject({ code: "state_conflict" });
    expect(await state(p)).toEqual(current);
    expect(await countEvents(p)).toBe(count);
    expect(await epoch()).toBe(beforeEpoch);
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id=$1 AND key='cascade-test'`, [p.nodeId])).rowCount).toBe(1);
  });

  it("unwinds repeated changes to the same pair within a cascade", async () => {
    const p = await fixture();
    const root = await event(workspaceId, "NODE_UPDATED", "node", p.nodeId, { title: "Membership test" }, "user", admin.id,
      { txMeta: { prev_field_values: { title: "Original" } } });
    await withEventTransaction(workspaceId, async () => {
      for (const applied of [true, false, true]) {
        await seedQ(applied ? `INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)` : `DELETE FROM node_tags WHERE node_id=$1 AND tag_id=$2`, [p.nodeId, p.tagId]);
        await event(workspaceId, applied ? "TAG_APPLIED" : "TAG_REMOVED", "node", p.nodeId,
          { tag_id: p.tagId, ...await recordedTagMembership(p.nodeId, p.tagId, applied) }, "user", admin.id, { triggeredBy: root });
      }
    });
    expect(await restore(root, { cascade: true })).toMatchObject({ restored: true,
      cascade: [{ result: "ok" }, { result: "ok" }, { result: "ok" }],
    });
    expect(await state(p)).toEqual({ is_applied: false, state_id: null });
  });

  it("serializes competing restores so only one changes membership", async () => {
    const p = await fixture();
    await apply(p); const original = await latest(p);
    const results = await Promise.all([restore(original.id), restore(original.id)]);
    expect(results.filter((r) => "restored" in r)).toHaveLength(1);
    expect(results.find((r) => "code" in r)).toMatchObject({ code: "already_in_state" });
    expect((await state(p))?.is_applied).toBe(false);
  });

  it("keeps current space permission, workspace and token-scope gates for inverses", async () => {
    const p = await fixture();
    await apply(p); const original = await latest(p); const current = await state(p);
    // A default-space viewer cannot write the note; a token whose write scope
    // excludes the note's space cannot either.
    const viewer = await persistActor(workspaceId, { ...admin, role: "viewer" });
    const scoped = await persistActor(workspaceId, { ...admin, tokenScope: {
      tokenId: "fixture", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null,
    } });
    await expect(restore(original.id, { actor: viewer })).rejects.toThrow(AuthorityError);
    await expect(restore(original.id, { actor: scoped })).rejects.toThrow(AuthorityError);
    const otherWorkspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Other membership restore',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    const otherAdmin = await persistActor(otherWorkspaceId, admin);
    expect(await restore(original.id, { workspaceId: otherWorkspaceId, actor: otherAdmin })).toMatchObject({ code: "not_found" });
    expect(await state(p)).toEqual(current);
  });

  it("rolls back an imported row when its membership event cannot be prepared", async () => {
    const p = await fixture();
    const beforeCount = (await q(`SELECT id FROM content_nodes WHERE workspace_id=$1`, [workspaceId])).rowCount;
    const beforeEpoch = await epoch();
    const capture = vi.spyOn(membership, "recordedTagMembership").mockRejectedValueOnce(new Error("injected capture failure"));
    try {
      await expect(createImportedRow(workspaceId, p.tagId, {
        title: "Must not survive", data: {}, fieldTypes: [], actor: admin,
      })).rejects.toThrow("capture failure");
    } finally { capture.mockRestore(); }
    expect((await q(`SELECT id FROM content_nodes WHERE workspace_id=$1`, [workspaceId])).rowCount).toBe(beforeCount);
    expect(await epoch()).toBe(beforeEpoch);
    expect((await q(`SELECT id FROM domain_events WHERE workspace_id=$1 AND event_type='NODE_CREATED'`, [workspaceId])).rowCount).toBe(0);
  });

  it.each(["node", "tag"])("purging the %s removes state without breaking FK cleanup", async (target) => {
    const p = await fixture(); await apply(p);
    await seedQ(`DELETE FROM content_nodes WHERE id=$1`, [target === "node" ? p.nodeId : p.tagId]);
    expect(await state(p)).toBeUndefined();
  });
});

it("cannot record membership outside the state change transaction", async () => {
  await expect(recordedTagMembership(randomUUID(), randomUUID(), true)).rejects.toThrow("transaction");
});
