import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("MCP create authority after the event lock", () => {
  let workspaceId: string, actor: ActorCtx, allowedTag: string, parentId: string, defaultSpace: string;
  let foreignWorkspaceId: string, foreignParentId: string, foreignTagId: string;
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      "INSERT INTO workspaces(name,slug) VALUES('Create authority',$1) RETURNING id", [randomUUID()],
    )).rows[0].id;
    foreignWorkspaceId = (await q<{ id: string }>(
      "INSERT INTO workspaces(name,slug) VALUES('Other create workspace',$1) RETURNING id", [randomUUID()],
    )).rows[0].id;
    foreignParentId = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Foreign parent',($1::uuid)::text,'')`, [foreignParentId,foreignWorkspaceId]);
    foreignTagId = (await seedClassTag(foreignWorkspaceId, { name: randomUUID() })).tagId;
    defaultSpace = (await q<{ id: string }>(
      "SELECT id FROM spaces WHERE workspace_id=$1 AND is_default", [workspaceId])).rows[0].id;
  });
  beforeEach(async () => {
    actor = await persistActor(workspaceId, { id: "fixture", name: "Creator", type: "human", role: "editor" });
    allowedTag = (await seedClassTag(workspaceId, { name: randomUUID() })).tagId;
    parentId = randomUUID();
    // A raw insert lands in the default space, where the editor is an editor.
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Parent',($1::uuid)::text,'')`, [parentId,workspaceId]);
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [parentId,allowedTag]);
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [foreignWorkspaceId]);
  });

  // A write token reaches the spaces its actor is a member of (and only those
  // with external_ai on); it carries no space list of its own.
  async function tokenIdentity() {
    const token = await createToken(actor.id, { allowedTools: ["createNode"], access: "write" });
    return { token, identity: (await resolveBearerActor(token.plaintext, workspaceId))! };
  }

  async function totals() {
    return (await q<{ nodes: number; events: number; effects: number }>(`SELECT
      (SELECT count(*)::int FROM content_nodes WHERE workspace_id=$1) AS nodes,
      (SELECT count(*)::int FROM domain_events WHERE workspace_id=$1 AND event_type <> 'AGENT_TOOL_FAILED') AS events,
      (SELECT count(*)::int FROM outbox WHERE workspace_id=$1) AS effects`, [workspaceId])).rows[0];
  }

  async function whileWaiting(
    identity: ActorCtx,
    dryRun: boolean,
    change: (client: PoolClient) => Promise<unknown>,
    extra: { parent_id?: string; tag_id?: string } = {},
  ) {
    const blocker = await pool.connect();
    const key = randomUUID(), title = randomUUID(), before = await totals();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${workspaceId}`]);
    let settled = false;
    const pending = withIdempotencyKey(key, () => callTool("createNode", { title, ...extra }, { actor: identity, workspaceId, dryRun }))
      .then(value => { settled = true; return { value, error: null }; }, (error: unknown) => { settled = true; return { value: null, error }; });
    let waiting = false;
    try {
      for (let i = 0; i < 100 && !settled; i++) {
        const locks = await blocker.query(`SELECT 1 FROM pg_locks waiting JOIN pg_locks held
          ON waiting.locktype=held.locktype AND waiting.database=held.database
          AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
          WHERE waiting.locktype='advisory' AND NOT waiting.granted AND held.granted AND held.pid=pg_backend_pid()`);
        if (locks.rows.length) { waiting = true; break; }
        await pause(10);
      }
      await change(blocker);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    return { ...await pending, waiting, key, title, before };
  }

  async function expectRefused(result: Awaited<ReturnType<typeof whileWaiting>>, name: string) {
    expect(result.waiting, "creation checks use the workspace event lock, including dry-run").toBe(true);
    expect(result.error).toMatchObject({ name });
    expect(await totals()).toEqual(result.before);
    expect((await q("SELECT key FROM idempotency_keys WHERE key=$1", [result.key])).rows).toEqual([]);
  }

  it.skipIf(needsSecondConnection).each([false, true])("refuses top-level creation when the token drops to read-only while waiting (dry-run %s)", async dryRun => {
    const { token, identity } = await tokenIdentity();
    const result = await whileWaiting(identity, dryRun, client => client.query(
      "UPDATE agent_tokens SET access='read' WHERE id=$1", [token.id],
    ));
    await expectRefused(result, "AuthorityError");
    expect(identity.tokenScope?.access).toBe("write");
  });

  it.skipIf(needsSecondConnection).each([false, true])("refuses top-level creation when the human loses every space write permission while waiting (dry-run %s)", async dryRun => {
    const result = await whileWaiting(actor, dryRun, client => client.query(
      "UPDATE space_members SET permission='view' WHERE actor_id=$1::uuid", [actor.id],
    ));
    await expectRefused(result, "AuthorityError");
  });

  it.skipIf(needsSecondConnection).each(["read", "write"] as const)("rechecks parent space %s access after waiting before creating anything", async access => {
    const result = await whileWaiting(actor, false, client => client.query(
      access === "read"
        ? "DELETE FROM space_members WHERE actor_id=$1::uuid AND space_id=$2"
        : "UPDATE space_members SET permission='view' WHERE actor_id=$1::uuid AND space_id=$2",
      [actor.id, defaultSpace],
    ), { parent_id: parentId });
    await expectRefused(result, "AuthorityError");
  });

  it.skipIf(needsSecondConnection)("dry-run refuses an unreadable parent and leaves no node or history", async () => {
    await q("DELETE FROM space_members WHERE actor_id=$1::uuid AND space_id=$2", [actor.id, defaultSpace]);
    const before = await totals();
    await expect(callTool("createNode", { title: randomUUID(), parent_id: parentId }, { actor, workspaceId, dryRun: true }))
      .rejects.toMatchObject({ name: "AuthorityError" });
    expect(await totals()).toEqual(before);
  });

  it.skipIf(needsSecondConnection).each(["parent", "tag"] as const)("refuses a %s from another workspace even when its policy allows creation", async target => {
    const before = await totals();
    const args = target === "parent" ? { parent_id: foreignParentId } : { tag_id: foreignTagId };
    // A foreign tag is "tag not found" (404), as REST POST /api/nodes answers
    // since the tool uses the same createNote tags (W35).
    await expect(callTool("createNode", { title: randomUUID(), ...args }, { actor, workspaceId }))
      .rejects.toMatchObject(target === "parent" ? { name: "AuthorityError" } : { name: "TagMembershipError", status: 404 });
    expect(await totals()).toEqual(before);
  });

  it.skipIf(needsSecondConnection)("creates a first note with its tag and authorized parent under both the human's and the token's space access", async () => {
    const { identity } = await tokenIdentity();
    const result = await callTool("createNode", { title: randomUUID(), tag_id: allowedTag, parent_id: parentId },
      { actor: identity, workspaceId }) as { id: string; event_id: string };
    expect((await q("SELECT parent_id FROM content_nodes WHERE id=$1", [result.id])).rows[0].parent_id).toBe(parentId);
    expect((await q("SELECT tag_id FROM node_tags WHERE node_id=$1", [result.id])).rows).toEqual([{ tag_id: allowedTag }]);
    expect((await q("SELECT actor_id FROM domain_events WHERE id=$1::bigint", [result.event_id])).rows[0].actor_id).toBe(actor.id);
  });

  it.skipIf(needsSecondConnection).each(["human", "token"] as const)("refuses a child of a parent the %s may not write even when the other allows it", async deniedScope => {
    // The token is the human's own (it reaches the human's memberships), so the
    // two can only differ where a token-only gate applies: external_ai off.
    if (deniedScope === "human") {
      await q("UPDATE space_members SET permission='view' WHERE actor_id=$1::uuid AND space_id=$2", [actor.id, defaultSpace]);
    }
    const aiWas = (await q<{ ai: boolean }>(
      "SELECT (capabilities->>'external_ai')::boolean AS ai FROM spaces WHERE id=$1", [defaultSpace])).rows[0]!.ai;
    if (deniedScope === "token") {
      await q(`UPDATE spaces SET capabilities = jsonb_set(capabilities,'{external_ai}','false') WHERE id=$1`, [defaultSpace]);
    }
    try {
      const { identity } = await tokenIdentity();
      const before = await totals();
      await expect(callTool("createNode", { title: randomUUID(), tag_id: allowedTag, parent_id: parentId }, { actor: identity, workspaceId }))
        .rejects.toMatchObject({ name: "AuthorityError" });
      expect(await totals()).toEqual(before);
    } finally {
      await q(`UPDATE spaces SET capabilities = jsonb_set(capabilities,'{external_ai}',$2::jsonb) WHERE id=$1`, [defaultSpace, String(aiWas ?? false)]);
    }
  });
});
