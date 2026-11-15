// Tag automation is gone (owner decision 2026-11-15). What a person or an agent can still do, pinned on real routes:
//   * a schema PATCH, a pack import and an agent's proposal that carry on_apply / on_remove / on_attribute_change
//     succeed and store a tag WITHOUT those keys (nothing is refused, nothing runs);
//   * a rule an old tag still holds stays stored, inert, and an unrelated schema edit leaves it alone;
//   * applying and removing a tag still records TAG_APPLIED / TAG_REMOVED, seeds field defaults and expands the template;
//   * an old backup whose tag carries rules restores, and the report counts the rules left out.
// The random version of "no extra event, no extra attribute" is properties/tagAutomationRemoved.property.integration.test.ts.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import tagsRouter from "../routes/tags.js";
import nodesRouter from "../routes/nodes.js";
import backupRouter from "../routes/backup.js";
import { proposeTagPack } from "../services/agentTools/proposeTagPack.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { rawZip } from "./helpers/rawZip.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import type { ActorCtx } from "../types.js";

registerShippedModules();

let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
let owner: ActorCtx;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
app.route("/api/tags", tagsRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/backup", backupRouter);
const send = (url: string, method: string, body?: unknown) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

/** The query the PR body gives the owner: counts only, no titles or ids. */
const PREVIEW_QUERY = `
  SELECT hook.key AS hook, COALESCE(hook.value->>'type', '(not an object)') AS handler_kind, count(*) AS live_tags
    FROM content_nodes t
   CROSS JOIN LATERAL jsonb_each(t.tag_schema->'behaviour') AS hook
   WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL
     AND jsonb_typeof(t.tag_schema->'behaviour') = 'object'
     AND hook.key IN ('on_apply', 'on_remove', 'on_attribute_change')
     AND hook.value <> 'null'::jsonb
   GROUP BY 1, 2
   ORDER BY 1, 2`;
const ON_APPLY = { type: "set_attribute", key: "status", value: "todo" };
const RULES = { on_apply: ON_APPLY, on_remove: { type: "notify", message: "bye" }, on_attribute_change: { type: "set_attribute", key: "x", value: "1" } };
const storedBehaviour = async (tagId: string) => (await db.q<{ behaviour: Record<string, unknown> | null }>(
  `SELECT tag_schema->'behaviour' AS behaviour FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.behaviour;
const attrs = async (nodeId: string) => Object.fromEntries((await db.q<{ key: string; value: string }>(
  `SELECT key, value FROM node_attributes WHERE node_id = $1`, [nodeId])).rows.map((r) => [r.key, r.value]));
const eventTypes = async (nodeId: string) => (await db.q<{ event_type: string }>(
  `SELECT event_type FROM domain_events WHERE target_id = $1 ORDER BY id`, [nodeId])).rows.map((r) => r.event_type);
async function note() {
  const res = await send("/api/nodes", "POST", { title: `Auto gone ${randomUUID().slice(0, 6)}`, markdown: "body" });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe.skipIf(!isTestDatabase())("tag automation is removed (real routes)", () => {
  beforeAll(async () => {
    workspaceId = (await db.q<{ id: string }>(`INSERT INTO workspaces(name, slug) VALUES ('Automation gone', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, { id: "ag-fixed-owner", name: "Owner", role: "admin", type: "human" });
    await setWorkspaceOwner(workspaceId, owner.id);
  });
  afterAll(async () => {
    if (!workspaceId) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id = $1", [workspaceId]);
    await db.pool.end();
  });

  it("a schema PATCH with automation keys succeeds and stores the other keys only", async () => {
    const { tagId } = await seedClassTag(workspaceId, { name: `patch-${randomUUID()}`, fields: [{ name: "status", type: "text" }] });
    const res = await send(`/api/tags/${tagId}/schema`, "PATCH", { behaviour: { ...RULES, review: { new_per_day: 5 } } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await storedBehaviour(tagId)).toEqual({ review: { new_per_day: 5 } });
    // Malformed rules used to answer 400 invalid_behaviour; they are ignored like any other.
    const malformed = await send(`/api/tags/${tagId}/schema`, "PATCH", { behaviour: { on_apply: { type: "explode" } } });
    expect(malformed.status).toBe(200);
  });

  it("a rule an old tag still holds stays stored and never runs; an unrelated edit keeps it", async () => {
    const { tagId } = await seedClassTag(workspaceId, { name: `old-${randomUUID()}`, fields: [{ name: "status", type: "text" }], behaviour: RULES });
    const patched = await send(`/api/tags/${tagId}/schema`, "PATCH", { fields: [{ name: "status", type: "text" }, { name: "note", type: "text" }] });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await storedBehaviour(tagId)).toEqual(RULES);
    // Writing the keys neither changes nor removes what is stored.
    expect((await send(`/api/tags/${tagId}/schema`, "PATCH", { behaviour: { on_apply: { type: "notify", message: "new" } } })).status).toBe(200);
    expect(await storedBehaviour(tagId)).toEqual(RULES);
    const id = await note();
    expect((await send(`/api/nodes/${id}/tags/${tagId}`, "PUT")).status).toBe(200);
    expect(await attrs(id)).toEqual({});
    expect((await send(`/api/nodes/${id}/attributes/status`, "PUT", { value: "done" })).status).toBe(200);
    expect(await attrs(id)).toEqual({ status: "done" });
    expect((await send(`/api/nodes/${id}/tags/${tagId}`, "DELETE")).status).toBe(200);
    expect(await eventTypes(id)).not.toContain("NOTIFICATION");
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(["TAG_APPLIED", "TAG_REMOVED", "ATTRIBUTE_SET"]));
  });

  it("shipped behaviour still happens on apply: TAG_APPLIED, field default, template child, then TAG_REMOVED", async () => {
    const { tagId } = await seedClassTag(workspaceId, {
      name: `fn-${randomUUID()}`, fields: [{ name: "stage", type: "text", default: "todo" }],
      templateChildren: [{ title: "Checklist item", body: "do" }], behaviour: RULES,
    });
    const id = await note();
    expect((await send(`/api/nodes/${id}/tags/${tagId}`, "PUT")).status).toBe(200);
    expect(await attrs(id)).toEqual({ stage: "todo" }); // the default, not the rule's status
    expect((await db.q(`SELECT 1 FROM content_nodes WHERE parent_id = $1 AND title = 'Checklist item' AND deleted_at IS NULL`, [id])).rowCount).toBe(1);
    const types = await eventTypes(id);
    expect(types).toContain("TAG_APPLIED");
    expect(types).not.toContain("NOTIFICATION");
    expect((await send(`/api/nodes/${id}/tags/${tagId}`, "DELETE")).status).toBe(200);
    expect(await eventTypes(id)).toContain("TAG_REMOVED");
  });

  it("the read-only preview query in the PR counts live tags by hook and handler kind", async () => {
    const { rows: before } = await db.q<{ hook: string; handler_kind: string; live_tags: string }>(PREVIEW_QUERY);
    const kinds = (rows: typeof before) => Object.fromEntries(rows.map((r) => [`${r.hook}/${r.handler_kind}`, Number(r.live_tags)]));
    await seedClassTag(workspaceId, { name: `preview-${randomUUID()}`, behaviour: RULES });
    const trashed = await seedClassTag(workspaceId, { name: `preview-trashed-${randomUUID()}`, behaviour: RULES });
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed.tagId]);
    const after = kinds((await db.q<{ hook: string; handler_kind: string; live_tags: string }>(PREVIEW_QUERY)).rows);
    const was = kinds(before);
    const grew = (key: string) => (after[key] ?? 0) - (was[key] ?? 0);
    expect([grew("on_apply/set_attribute"), grew("on_remove/notify"), grew("on_attribute_change/set_attribute")]).toEqual([1, 1, 1]);
  });

  it("a tag pack with rules installs without them", async () => {
    const name = `pack-${randomUUID().slice(0, 8)}`;
    const res = await send("/api/tags/import", "POST", {
      name, fields: [{ name: "status", type: "text" }], behaviour: { ...RULES, on_apply: { type: "explode" } },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const tagId = ((await res.json()) as { id: string }).id;
    expect(await storedBehaviour(tagId)).toEqual({});
    const id = await note();
    await send(`/api/nodes/${id}/tags/${tagId}`, "PUT");
    expect(await attrs(id)).toEqual({});
  });

  it("an agent's proposal leaves the rules out of the pack it files", async () => {
    const name = `prop-${randomUUID().slice(0, 8)}`;
    const result = await proposeTagPack.handler(
      { name, fields: [], behaviour: { ...RULES, review: { new_per_day: 3 } } } as never,
      { actor: owner, workspaceId, dryRun: false } as never,
    );
    expect(result).toMatchObject({ status: "pending_approval" });
    const queued = (await db.q<{ payload: { pack: { behaviour?: Record<string, unknown> } } }>(
      `SELECT payload FROM outbox WHERE workspace_id = $1 AND payload::text LIKE $2`, [workspaceId, `%${name}%`])).rows[0];
    expect(queued?.payload.pack.behaviour).toEqual({ review: { new_per_day: 3 } });
  });

  it("an old backup whose tag carries rules restores, and the report counts the rules left out", async () => {
    const space = await makeSpace(workspaceId, `restore target ${randomUUID()}`, [{ id: owner.id, permission: "edit" }]);
    const now = new Date().toISOString();
    const tagId = randomUUID();
    const title = `Old rules ${randomUUID().slice(0, 6)}`;
    const base = { slug: null, parent_id: null, space_id: null, hidden: false, sort_order: 0, source_type: "manual", created_at: now, updated_at: now, deleted_at: null, attributes: [], file: null, media: [] };
    const tag = {
      ...base, id: tagId, node_type: "class_tag", title, markdown: "", tags: [],
      tag: { path: title, color: null, views: null, reserved_key: null,
        schema: { name: title, slug: "old-rules", publish_collection: false, fields: [{ name: "status", type: "text" }], behaviour: { ...RULES, on_apply: { type: "explode" } } } },
    };
    const zip = rawZip([
      { name: `.onden/notes/${tagId}.json`, data: JSON.stringify(tag), deflate: true },
      { name: ".onden/manifest.json", data: JSON.stringify({ format: "onden-backup", version: 1, created_at: now, counts: {} }) },
    ]);
    const uploadRes = await app.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(uploadRes.status, await uploadRes.clone().text()).toBe(200);
    const uploadId = ((await uploadRes.json()) as { upload_id: string }).upload_id;
    const res = await applyAndWait(app, uploadId, space, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as { skipped: Record<string, number> };
    expect(report.skipped.tag_automation).toBe(3);
    expect(report.skipped.tag_settings).toBe(0);
    const restored = (await db.q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = $2 AND deleted_at IS NULL`, [workspaceId, title])).rows;
    expect(restored).toHaveLength(1);
    expect(await storedBehaviour(restored[0]!.id)).toEqual({});
  });
});
