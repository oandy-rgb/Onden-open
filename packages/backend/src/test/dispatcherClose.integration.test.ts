// Closing the database waits for post-commit cascades (services/dispatcherQueue.ts closeDispatcher,
// registered through dbClose.ts onBeforePoolEnd). Before: pool.end() ended the pool under a running cascade,
// whose failure audit then rejected a promise nobody awaited, reported in a later test file
// (public CI run 44083441388: "Cannot use a pool after calling end on the pool").
// Runs on PGlite and on the test database; this file ends the pool, so it holds one scenario per file.

import { describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { inflightNodeIds, queueDispatcher } from "../services/dispatcherQueue.js";

describe("closing the database with a cascade still queued", () => {
  it("finishes the cascade (and the one it queues) before the pool ends, and never rejects unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", record);

    const ran: string[] = [];
    // A cascade that is still in flight at pool.end(): it queries after a tick, as a derived-attribute write does.
    void queueDispatcher({ workspaceId: "w", nodeId: "close-a", actorId: "a", label: "test.close" }, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await q("SELECT 1");
      ran.push("first");
      void queueDispatcher({ workspaceId: "w", nodeId: "close-b", actorId: "a", label: "test.close" }, async () => {
        await q("SELECT 1");
        ran.push("queued by the first");
      });
    });

    await pool.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 50)); // let a late rejection surface
    process.off("unhandledRejection", record);

    expect(ran).toEqual(["first", "queued by the first"]);
    expect(inflightNodeIds()).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
