import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import type { ActorCtx } from "../types.js";
import { withToolAuthority } from "../spine/toolScope.js";
import { syncAuthorizedNodeAttributes } from "../services/nodes.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("write authority after the event lock", () => {
  let workspaceId: string, actor: ActorCtx, nodeId: string;
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Write authority',$1) RETURNING id", [randomUUID()])).rows[0].id;
    // The workspace's first actor becomes its owner, whose row cannot be deleted
    // (migration 128): an owner of its own keeps every per-test Writer deletable,
    // whichever test the shuffled order runs first.
    await q("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Owner','human')", [workspaceId]);
  });
  beforeEach(async () => {
    actor = (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Writer','human') RETURNING id,name,type", [workspaceId])).rows[0];
    // Membership is explicit (097); every per-test Writer must be able to edit
    // the default space for the refusals to mean anything
    await joinDefaultSpace(workspaceId, actor.id, "editor");
    nodeId = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Write authority',($1::uuid)::text,'before')`, [nodeId,workspaceId]);
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
  });

  async function write(identity = actor, key = randomUUID()) {
    return mutate({ actor: identity, workspaceId, idempotencyKey: key,
      authority: { kind: "node", nodeId, op: "write_node" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: nodeId },
      apply: async () => { await seedQ("UPDATE content_nodes SET markdown='after' WHERE id=$1", [nodeId]); },
    });
  }

  // A real second connection owns the exact workspace lock. Wait until the
  // writer is blocked on it, change authority, then release by COMMIT.
  async function whileWaiting(change: (client: import("pg").PoolClient) => Promise<unknown>, identity = actor) {
    const blocker = await pool.connect();
    const key = randomUUID();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${workspaceId}`]);
    const pending = write(identity, key).then(() => null, error => error);
    try {
      await waitForEventLockWaiter(blocker, workspaceId);
      await change(blocker);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      // Settle the write before leaving, also when `change` threw: left running,
      // it would land in the next test's note.
      await pending;
    }
    return { error: await pending, key };
  }

  async function expectRefused(error: unknown, key: string, name: string) {
    expect(error).toMatchObject({ name });
    expect((await q("SELECT markdown FROM content_nodes WHERE id=$1", [nodeId])).rows[0].markdown).toBe("before");
    expect((await q("SELECT id FROM domain_events WHERE target_id=$1", [nodeId])).rows).toEqual([]);
    expect((await q("SELECT key FROM idempotency_keys WHERE key=$1", [key])).rows).toEqual([]);
  }

  // The node sits in the default space, where the writer has edit; the write
  // authority is that space permission.
  it.skipIf(needsSecondConnection).each(["permission", "deleted"] as const)("refuses an actor whose %s changed while waiting", async kind => {
    const before = { ...actor };
    const { error, key } = await whileWaiting(client => kind === "deleted"
      ? client.query("DELETE FROM actors WHERE id=$1", [actor.id])
      : client.query("UPDATE space_members SET permission='view' WHERE actor_id=$1", [actor.id]));
    await expectRefused(error, key, kind === "deleted" ? "UnauthorizedError" : "AuthorityError");
    expect(actor).toEqual(before); // the request's object is never mutated
  });

  it.skipIf(needsSecondConnection).each(["revoked", "access", "expired"] as const)("refuses a token whose %s changed while waiting", async kind => {
    const token = await createToken(actor.id, { access: "write" });
    const identity = (await resolveBearerActor(token.plaintext, workspaceId))!;
    const { error, key } = await whileWaiting(client => client.query(
      kind === "revoked" ? "UPDATE agent_tokens SET revoked_at=now() WHERE id=$1"
        : kind === "access" ? "UPDATE agent_tokens SET access='read' WHERE id=$1"
          : "UPDATE agent_tokens SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1", [token.id]), identity);
    await expectRefused(error, key, kind === "access" ? "AuthorityError" : "UnauthorizedError");
  });

  it("uses current grants without mutating the captured identity", async () => {
    // The captured identity carries no grants: a stale copy still writes on the
    // strength of the current membership, and is left untouched.
    const captured = { ...actor, name: "stale-name" };
    await write(captured);
    expect(captured).toEqual({ ...actor, name: "stale-name" });
    expect((await q("SELECT markdown FROM content_nodes WHERE id=$1", [nodeId])).rows[0].markdown).toBe("after");
  });

  it.skipIf(needsSecondConnection)("rechecks the invoked MCP tool after waiting, not only its space scope", async () => {
    const token = await createToken(actor.id, { access: "write", allowedTools: ["updateNode"] });
    const identity = (await resolveBearerActor(token.plaintext, workspaceId))!;
    const { error, key } = await withToolAuthority("updateNode", () => whileWaiting(
      client => client.query("UPDATE agent_tokens SET allowed_tools='{}'::text[] WHERE id=$1", [token.id]), identity));
    await expectRefused(error, key, "ScopeError");
  });

  it("live queued derivation refuses a lowered space permission before either attribute rail writes", async () => {
    await q("UPDATE space_members SET permission='view' WHERE actor_id=$1", [actor.id]);
    await expect(syncAuthorizedNodeAttributes(workspaceId, nodeId, "---\npriority: high\n---\nstatus:: done", actor))
      .rejects.toMatchObject({ name: "AuthorityError" });
    expect((await q("SELECT key FROM node_attributes WHERE node_id=$1", [nodeId])).rows).toEqual([]);
    expect((await q("SELECT id FROM domain_events WHERE target_id=$1", [nodeId])).rows).toEqual([]);
  });
});
