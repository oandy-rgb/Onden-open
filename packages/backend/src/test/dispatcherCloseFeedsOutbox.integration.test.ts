// A cascade queues an outbox pass while the database is closing (dbClose.ts drains to a fixed point).
// Before: one pass in registration order, so a pass queued after the outbox was checked ran after the pool ended.
// This file ends the pool: one scenario per file. The other registration order is covered in dbClose.test.ts.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getWorkspaceId, pool, q } from "../db.js";
import { _armInstantDrainForTests, enqueueBackup } from "../services/outbox.js";
import { queueDispatcher } from "../services/dispatcherQueue.js";

describe("closing the database with a cascade that queues an outbox pass", () => {
  it("performs the outbox effects before the pool ends, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", record);

    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const workspaceId = await getWorkspaceId();
    const performed: string[] = [];
    _armInstantDrainForTests(async (kind, payload) => { performed.push(`${kind}:${(payload as { node_id?: string }).node_id ?? ""}`); }, () => workspaceId);
    const nodeId = randomUUID();

    void queueDispatcher({ workspaceId, nodeId: "feeds-outbox", actorId: "a", label: "test.close" }, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await enqueueBackup({ workspaceId, nodeId, markdown: "x", message: "m" }); // commits, then kicks an outbox pass
    });

    await pool.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 50)); // let a late rejection surface
    process.off("unhandledRejection", record);

    expect(performed).toEqual(expect.arrayContaining([`git_commit:${nodeId}`, `github_backup:${nodeId}`]));
    expect(unhandled).toEqual([]);
  });
});
