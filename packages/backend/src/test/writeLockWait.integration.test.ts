import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { pool, q, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import { WorkspaceBusyError } from "../spine/eventLock.js";
import { mutate } from "../spine/mutate.js";
import { lockEventAppend } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

// The workspace write lock has its own, shorter wait limit (ONDEN_WRITE_LOCK_WAIT_MS): a writer
// that cannot get it in time is refused with 503 workspace_busy and writes nothing.
describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("waiting for the workspace write lock", () => {
  let workspaceId: string, actor: ActorCtx, nodeId: string;
  const savedWait = process.env.ONDEN_WRITE_LOCK_WAIT_MS;
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Lock wait',$1) RETURNING id", [randomUUID()])).rows[0].id;
    await q("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Owner','human')", [workspaceId]);
  });
  beforeEach(async () => {
    process.env.ONDEN_WRITE_LOCK_WAIT_MS = "300";
    actor = (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Writer','human') RETURNING id,name,type", [workspaceId])).rows[0];
    await joinDefaultSpace(workspaceId, actor.id, "editor");
    nodeId = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Lock wait',($1::uuid)::text,'before')`, [nodeId, workspaceId]);
  });
  afterEach(() => {
    if (savedWait === undefined) delete process.env.ONDEN_WRITE_LOCK_WAIT_MS;
    else process.env.ONDEN_WRITE_LOCK_WAIT_MS = savedWait;
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
  });

  const write = (key: string) => mutate({
    actor, workspaceId, idempotencyKey: key,
    authority: { kind: "node", nodeId, op: "write_node" },
    event: { type: "NODE_UPDATED", targetType: "node", targetId: nodeId },
    apply: async () => { await seedQ("UPDATE content_nodes SET markdown='after' WHERE id=$1", [nodeId]); },
  });
  const markdown = async () => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id=$1", [nodeId])).rows[0].markdown;
  const events = async () => (await q("SELECT id FROM domain_events WHERE target_id=$1", [nodeId])).rows.length;

  it("answers 503 workspace_busy with Retry-After and no internal words", async () => {
    const app = new Hono();
    app.onError(apiOnError);
    app.get("/", () => { throw new WorkspaceBusyError(5); });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ error: "workspace_busy", retry_after_seconds: 5 });
  });

  it("writes as before, with the lock limit put back, when nobody holds the lock", async () => {
    await write(randomUUID());
    expect(await markdown()).toBe("after");
    expect(await events()).toBe(1);
    await withTransaction(async () => {
      await lockEventAppend(workspaceId);
      expect((await q<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
    });
  });

  it("does not apply the lock limit to statements after the lock was taken", async () => {
    await withTransaction(async () => {
      await lockEventAppend(workspaceId);
      await q("SELECT pg_sleep(0.6)"); // longer than the 300 ms lock limit, far below statement_timeout
    });
  });

  it.skipIf(needsSecondConnection)("refuses the writer after the lock limit, writes nothing, and the same key goes through once the lock is free", async () => {
    const key = randomUUID();
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${workspaceId}`]);
      const started = Date.now();
      const refused = await write(key).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(WorkspaceBusyError);
      expect(refused).toMatchObject({ code: "workspace_busy", retryAfterSeconds: 1 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await markdown()).toBe("before");
      expect(await events()).toBe(0);
      expect((await q("SELECT key FROM idempotency_keys WHERE key=$1", [key])).rows).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await write(key);
    expect(await markdown()).toBe("after");
    expect(await events()).toBe(1);
    // A lost answer makes the client send it a third time: still one change.
    await write(key).catch(() => undefined);
    expect(await events()).toBe(1);
  });

  it.skipIf(needsSecondConnection)("a writer queued behind a short holder waits for it instead of being refused", async () => {
    process.env.ONDEN_WRITE_LOCK_WAIT_MS = "5000";
    const blocker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${workspaceId}`]);
      pending = write(randomUUID()).then(() => "done", (error: unknown) => error);
      await waitForEventLockWaiter(blocker, workspaceId);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect(await pending).toBe("done");
    expect(await markdown()).toBe("after");
  });
});
