// A cascade queues an outbox pass while the database is closing (dbClose.ts drains to a fixed point).
// Before: one pass in registration order, so a pass queued after the outbox was checked ran after the pool ended.
// This file ends the pool: one scenario per file. The other registration order is covered in dbClose.test.ts.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { _armInstantDrainForTests, enqueueBackup } from "../services/outbox.js";
import { queueDispatcher } from "../services/dispatcherQueue.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

describe.skipIf(!isTestDatabase())("closing the database with a cascade that queues an outbox pass", () => {
  it("performs the outbox effects before the pool ends, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", record);

    // The test's own workspace: the pass is scoped to it, so rows other files left in the shared 'default' workspace
    // (a drain performs 20 per pass, oldest first) cannot crowd this test's rows out of what the pass performs.
    const workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Close feeds outbox', $1) RETURNING id::text`, [`close-outbox-${randomUUID()}`])).rows[0]!.id;
    // Rows another file left behind, in another workspace: more than one pass performs (20 each, oldest first).
    // Red if the pass is not scoped to this test's workspace: it performs those 40 and never reaches this test's rows.
    const otherWorkspace = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Close feeds outbox, left rows', $1) RETURNING id::text`, [`close-outbox-left-${randomUUID()}`])).rows[0]!.id;
    await q(`INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload)
             SELECT $1::uuid, 'git_commit', 'left:' || $2 || ':' || g, jsonb_build_object('node_id', gen_random_uuid()::text, 'markdown', 'x', 'message', 'm')
             FROM generate_series(1, 40) g`, [otherWorkspace, randomUUID()]);
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
