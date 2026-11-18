// Closing the database while a cascade waits to retry a transient failure (dbClose.ts + services/dispatcherQueue.ts).
// The cascade is not re-run and not audited as failed: its dispatcher_pending intent row stays, and the next
// start's catch-up does it. Red if the close path is removed: the retry then runs on, fails 4 times and audits
// DISPATCHER_FAILED (after ~4 s of real backoff, so the test times out too).
// closeDatabase gets a no-op "end" so the same database can run the catch-up after it, as a restart would.

import { describe, expect, it } from "vitest";
import { event, getWorkspaceId, q } from "../db.js";
import { closeDatabase } from "../dbClose.js";
import { enqueueCascadeIntent, queueDispatcher, runDispatcherCatchup } from "../services/dispatcherQueue.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const stamp = Date.now();

describe.skipIf(!isTestDb)("closing the database in the middle of a transient failure", () => {
  it("keeps the intent row, writes no DISPATCHER_FAILED, and the boot catch-up does the job", async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const ws = await getWorkspaceId();
    const actor = (await q<ActorCtx>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, 'human') RETURNING id, name, type`,
      [ws, `cmr admin ${stamp}`],
    )).rows[0]!;
    await joinDefaultSpace(ws, actor.id, "admin");
    const { tagId } = await seedClassTag(ws, {
      name: `cmr-${stamp}`, slug: `cmr-${stamp}`, title: `cmr-tag-${stamp}`, nodeSlug: `cmr-tag-${stamp}`,
    });
    const nodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1, 'manual', 'content', $2, $3, $4, false) RETURNING id`,
      [ws, `cmr ${stamp}`, `cmr-${stamp}`, "work to do\n\nstatus:: done"],
    )).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [nodeId, tagId]);
    const eventId = await event(ws, "NODE_UPDATED", "node", nodeId, { title: "cmr" }, "user", actor.id, { txMeta: { ui_context: "test.close_mid_retry" } });
    await enqueueCascadeIntent({ workspaceId: ws, nodeId, actor, label: "node.patch.cascade", eventId });

    const intentRows = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM dispatcher_pending WHERE node_id = $1`, [nodeId])).rows[0]!.n);
    const failedEvents = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE target_id = $1 AND event_type = 'DISPATCHER_FAILED'`, [nodeId])).rows[0]!.n);

    // The live cascade: its first attempt fails with a transient error, so it is about to wait 200 ms to retry.
    let attempts = 0;
    let firstFailed!: () => void;
    const failedOnce = new Promise<void>((resolve) => { firstFailed = resolve; });
    const queued = queueDispatcher(
      { workspaceId: ws, nodeId, actorId: actor.id, label: "node.patch.cascade", triggerEventId: eventId },
      async () => { attempts++; firstFailed(); throw Object.assign(new Error("could not serialize access"), { code: "40001" }); },
    );
    await failedOnce;
    await closeDatabase(async () => {});
    await queued;

    expect(attempts).toBe(1);
    expect(await intentRows()).toBe(1);
    expect(await failedEvents()).toBe(0);

    // The next start.
    await runDispatcherCatchup();
    const done = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'status' AND value = 'done'`, [nodeId]);
    expect(done.rows.length).toBe(1);
    expect(await intentRows()).toBe(0);
    expect(await failedEvents()).toBe(0);
  });
});
