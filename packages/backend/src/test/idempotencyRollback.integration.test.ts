import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, getWorkspaceId, withTransaction, withSavepoint } from "../db.js";
import { mutate } from "../spine/mutate.js";
import { withIdempotencyKey, IdempotentReplay } from "../spine/idempotency.js";
import { afterCommit, afterRollback } from "../spine/txHooks.js";
import { updateNode } from "../services/nodeUpdate.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

let actor: ActorCtx = { id: "rollback-test-admin", name: "Test", type: "human", role: "admin" };
const created: string[] = [];
let ws: string;
async function seed() {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1::uuid,$2,'manual','content','original',($1::uuid)::text,'body')`, [id,ws]);
  created.push(id);
  return id;
}
function bump(id: string, notifications: string[], label: string) {
  return mutate({
    actor, workspaceId: ws, authority: { kind: "node", nodeId: id, op: "write_node" },
    event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { label } },
    apply: async () => {
      await seedQ("UPDATE content_nodes SET title=title || '!' WHERE id=$1", [id]);
      afterCommit(() => { notifications.push(label); });
    },
  });
}
async function keyCount(key: string) {
  return (await q<{ n: number }>("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [key])).rows[0].n;
}
async function title(id: string) {
  return (await q<{ title: string }>("SELECT title FROM content_nodes WHERE id=$1", [id])).rows[0].title;
}
async function eventCount(id: string) {
  return (await q<{ n: number }>("SELECT count(*)::int AS n FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED'", [id])).rows[0].n;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("request claims follow enclosing rollback", () => {
  beforeAll(async () => { ws = await getWorkspaceId(); actor = await persistActor(ws, actor); });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE id=ANY($1::uuid[])", [created]); });

  for (const scope of ["root transaction", "savepoint", "released child savepoint"] as const) {
    it(`reclaims after a late ${scope} rollback and dedupes the next request`, async () => {
      const id = await seed(), key = randomUUID(), notifications: string[] = [];
      const run = async () => {
        const outer = scope === "root transaction" ? withTransaction : withSavepoint;
        await expect(outer(async () => {
          if (scope === "released child savepoint") await withSavepoint(() => bump(id, notifications, "rolled back"));
          else await bump(id, notifications, "rolled back");
          // The inner claim wrapper has already returned successfully.
          expect(await keyCount(key)).toBe(1);
          throw new Error("outer operation rejected");
        })).rejects.toThrow("outer operation rejected");
        expect(await title(id)).toBe("original");
        expect(await keyCount(key)).toBe(0);
        expect(await eventCount(id)).toBe(0);
        expect(notifications).toEqual([]);
        await bump(id, notifications, "accepted retry");
        expect(await keyCount(key)).toBe(1);
      };
      await withIdempotencyKey(key, () => scope === "root transaction" ? run() : withTransaction(run));
      expect(notifications).toEqual(["accepted retry"]);
      await expect(withIdempotencyKey(key, () => bump(id, notifications, "duplicate"))).rejects.toBeInstanceOf(IdempotentReplay);
      expect(await title(id)).toBe("original!");
      expect(await eventCount(id)).toBe(1);
    });
  }

  it("does not release a parent's claim when a later child rolls back", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    await withIdempotencyKey(key, () => withTransaction(async () => {
      await bump(id, notifications, "parent");
      await expect(withSavepoint(async () => {
        await bump(id, notifications, "child");
        throw new Error("child rejected");
      })).rejects.toThrow("child rejected");
      await bump(id, notifications, "sibling");
    }));
    expect(await keyCount(key)).toBe(1);
    expect(await title(id)).toBe("original!!");
    expect(await eventCount(id)).toBe(2);
    expect(notifications).toEqual(["parent", "sibling"]);
  });

  it("retries after PostgreSQL rejects COMMIT on a deferred constraint", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    await withIdempotencyKey(key, async () => {
      await expect(withTransaction(async () => {
        await bump(id, notifications, "failed commit");
        await q("CREATE TEMP TABLE late_conflict(value integer UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP");
        await q("INSERT INTO late_conflict VALUES(1),(1)");
      })).rejects.toMatchObject({ code: "23505" });
      expect(await title(id)).toBe("original");
      expect(notifications).toEqual([]);
      await bump(id, notifications, "retry");
      expect(await keyCount(key)).toBe(1);
    });
    expect(await title(id)).toBe("original!");
    expect(await eventCount(id)).toBe(1);
    expect(notifications).toEqual(["retry"]);
  });

  it("does not acknowledge COMMIT when PostgreSQL actually answers ROLLBACK", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    await withIdempotencyKey(key, async () => {
      await expect(withTransaction(async () => {
        await bump(id, notifications, "aborted");
        // Model a caller that swallowed a SQL failure without a savepoint.
        await expect(q("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
      })).rejects.toThrow("transaction was aborted before commit");
      expect(await keyCount(key)).toBe(0);
      expect(await eventCount(id)).toBe(0);
      expect(notifications).toEqual([]);
      await bump(id, notifications, "retry");
    });
    expect(await keyCount(key)).toBe(1);
    expect(await title(id)).toBe("original!");
    expect(notifications).toEqual(["retry"]);
  });

  it("asks PostgreSQL on retry when the COMMIT response is lost after a real commit", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    const client = await pool.connect();
    const connection = Object.create(client) as typeof client;
    connection.query = (async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (sql === "COMMIT") throw new Error("injected lost COMMIT response");
      return result;
    }) as typeof client.query;
    connection.release = () => client.release();
    const connect = vi.spyOn(pool, "connect");
    // Only substitute the root owner's checkout; later q()/pool queries use
    // the real pool. SQL commit itself remains real, only its response is lost.
    connect.mockImplementation((() => {
      connect.mockRestore();
      return Promise.resolve(connection);
    }) as typeof pool.connect);
    try {
      await withIdempotencyKey(key, async () => {
        await expect(bump(id, notifications, "ambiguous")).rejects.toThrow("lost COMMIT response");
        expect(await keyCount(key)).toBe(1);
        await expect(bump(id, notifications, "must not duplicate")).rejects.toBeInstanceOf(IdempotentReplay);
      });
    } finally { connect.mockRestore(); }
    expect(await title(id)).toBe("original!");
    expect(await eventCount(id)).toBe(1);
    expect(notifications).toEqual([]);
  });

  it("keeps an earlier committed claim when a later separate transaction fails", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    await withIdempotencyKey(key, async () => {
      await bump(id, notifications, "committed first");
      await expect(withTransaction(async () => {
        await bump(id, notifications, "rolled back second");
        throw new Error("second failed");
      })).rejects.toThrow("second failed");
      await bump(id, notifications, "third in same request");
    });
    expect(await keyCount(key)).toBe(1);
    expect(await title(id)).toBe("original!!");
    expect(notifications).toEqual(["committed first", "third in same request"]);
  });

  it.skipIf(needsPostgresServer)("evicts a connection with failed cleanup and invalidates its cached claim for a safe retry", async () => {
    const id = await seed(), key = randomUUID(), notifications: string[] = [];
    const client = await pool.connect();
    const connection = Object.create(client) as typeof client;
    const failure = new Error("operation rejected before cleanup");
    let releasedWith: Error | boolean | undefined;
    connection.query = (async (sql: string, params?: unknown[]) => {
      if (sql === "ROLLBACK") throw new Error("injected broken rollback connection");
      return client.query(sql, params);
    }) as typeof client.query;
    connection.release = error => { releasedWith = error; client.release(error); };
    const connect = vi.spyOn(pool, "connect");
    connect.mockImplementation((() => {
      connect.mockRestore();
      return Promise.resolve(connection);
    }) as typeof pool.connect);
    try {
      await withIdempotencyKey(key, async () => {
        await expect(withTransaction(async () => {
          await bump(id, notifications, "discarded connection");
          throw failure;
        })).rejects.toBe(failure);
        expect(releasedWith).toBeInstanceOf(Error);
        await bump(id, notifications, "retry on healthy connection");
        expect(await keyCount(key)).toBe(1);
      });
    } finally { connect.mockRestore(); }
    expect(await title(id)).toBe("original!");
    expect(await eventCount(id)).toBe(1);
    expect(notifications).toEqual(["retry on healthy connection"]);
  });

  for (const operation of ["node edit", "event restore"] as const) {
    it(`${operation} observes rollback after its own event savepoint was released`, async () => {
      const id = await seed(), key = randomUUID();
      const original = await updateNode(ws, id, { title: "edited" }, { actor });
      await awaitAllDispatchers();
      const write = () => operation === "node edit"
        ? updateNode(ws, id, { title: "retried edit" }, { actor })
        : restoreEvent(original.eventId!, { actor, workspaceId: ws });
      await withIdempotencyKey(key, async () => {
        await expect(withTransaction(async () => {
          const result = await write();
          expect(result).not.toHaveProperty("code");
          throw new Error("later batch failure");
        })).rejects.toThrow("later batch failure");
        expect(await title(id)).toBe("edited");
        expect(await keyCount(key)).toBe(0);
        expect(await eventCount(id)).toBe(1);
        expect(await write()).not.toHaveProperty("code");
      });
      expect(await keyCount(key)).toBe(1);
      await expect(withIdempotencyKey(key, write)).rejects.toBeInstanceOf(IdempotentReplay);
      expect(await title(id)).toBe(operation === "node edit" ? "retried edit" : "original");
      expect(await eventCount(id)).toBe(2);
    });
  }

  it("runs rollback invalidation after SQL cleanup and before the caller catches", async () => {
    const key = randomUUID(), order: string[] = [];
    let visibleAfterCleanup: Promise<number> | undefined;
    await withTransaction(async () => {
      await expect(withSavepoint(async () => {
        await q("INSERT INTO idempotency_keys(key,workspace_id) VALUES($1,$2)", [key,ws]);
        afterRollback(() => { order.push("invalidated"); visibleAfterCleanup = keyCount(key); });
        throw new Error("reject unit");
      })).rejects.toThrow("reject unit");
      order.push("caller recovered");
      expect(await visibleAfterCleanup).toBe(0);
      expect(order).toEqual(["invalidated", "caller recovered"]);
    });
  });
});
