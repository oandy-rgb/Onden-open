// Integration test for migration 071 — weak referential integrity on the
// three bare-text actor-attribution columns (domain_events.actor_id,
// dispatcher_pending.actor_id, event_reviews.reviewed_by). The BEFORE INSERT
// trigger (assert_actor_ref via actor_ref_resolves) enforces exactly the
// loadActor() rule: a uuid-shaped reference MUST resolve to a real actor in
// the same workspace; any non-uuid string is a free-form sentinel and passes.
// Direct SQL against a real DB (the trigger is the unit under test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, q } from "../db.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const WS = "00000000-0000-0000-0000-0000000071fc";
const REAL = "00000000-0000-0000-0000-00000071ac01"; // seeded actor in WS
const PHANTOM = "00000000-0000-0000-0000-000000deadff"; // uuid, no such actor

async function insEvent(actorId: string, actorType = "user"): Promise<void> {
  await q(
    `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
     VALUES ($1, $2, $3, 'NODE_UPDATED', 'node', 'wfk-n', '{}')`,
    [WS, actorType, actorId],
  );
}

describe.skipIf(!isTestDb)("actor weak FK (071)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'WeakFk','weak-fk-ws') ON CONFLICT (id) DO NOTHING`, [WS]);
    await q(`DELETE FROM event_reviews WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM dispatcher_pending WHERE workspace_id = $1`, [WS]);
    await q(
      `INSERT INTO actors (id, workspace_id, name, type, external_id)
       VALUES ($1,$2,'Real','human','weak-fk-real') ON CONFLICT (id) DO NOTHING`,
      [REAL, WS],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM event_reviews WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM dispatcher_pending WHERE workspace_id = $1`, [WS]);
    await deleteWorkspaceActors(WS);
    await pool.end();
  });

  describe("domain_events.actor_id", () => {
    it("accepts a uuid that resolves to a real actor", async () => {
      await expect(insEvent(REAL)).resolves.toBeUndefined();
    });

    it("rejects a uuid-shaped actor_id with no matching actor", async () => {
      await expect(insEvent(PHANTOM)).rejects.toThrow(/resolves to no actor/);
    });

    it("rejects a real actor uuid from a DIFFERENT workspace", async () => {
      // REAL exists, but not in this throwaway workspace.
      const OTHER = "00000000-0000-0000-0000-0000007105ff";
      await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'Other','weak-fk-other') ON CONFLICT (id) DO NOTHING`, [OTHER]);
      await expect(
        q(
          `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
           VALUES ($1,'user',$2,'NODE_UPDATED','node','wfk-x','{}')`,
          [OTHER, REAL],
        ),
      ).rejects.toThrow(/resolves to no actor/);
      await q(`DELETE FROM workspaces WHERE id = $1`, [OTHER]);
    });

    it("accepts non-uuid daemon/external sentinels", async () => {
      await expect(insEvent("system-task-scheduler", "system")).resolves.toBeUndefined();
      await expect(insEvent("feed", "system")).resolves.toBeUndefined();
      await expect(insEvent("u1")).resolves.toBeUndefined(); // legacy test-shape sentinel
    });
  });

  describe("event_reviews.reviewed_by", () => {
    let evId = "";
    beforeAll(async () => {
      const r = await q<{ id: string }>(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
         VALUES ($1,'user',$2,'NODE_UPDATED','node','wfk-r','{}') RETURNING id`,
        [WS, REAL],
      );
      evId = r.rows[0]!.id;
    });

    it("rejects a uuid-shaped reviewer with no matching actor", async () => {
      await expect(
        q(`INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by) VALUES ($1,$2,'rejected',$3)`,
          [evId, WS, PHANTOM]),
      ).rejects.toThrow(/resolves to no actor/);
    });

    it("accepts a real reviewer and non-uuid sentinels", async () => {
      await expect(
        q(`INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by) VALUES ($1,$2,'approved',$3)`,
          [evId, WS, REAL]),
      ).resolves.toBeTruthy();
      // 'feed' = rss reviewer sentinel; ON CONFLICT keeps it a single-row table.
      await expect(
        q(`INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by) VALUES ($1,$2,'rejected','feed')
           ON CONFLICT (event_id) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by`,
          [evId, WS]),
      ).resolves.toBeTruthy();
    });
  });

  describe("dispatcher_pending.actor_id", () => {
    it("accepts a real actor and rejects a phantom uuid", async () => {
      await expect(
        q(`INSERT INTO dispatcher_pending (event_id, workspace_id, node_id, actor_id, label) VALUES (710001,$1,$2,$3,'t')`,
          [WS, WS, REAL]),
      ).resolves.toBeTruthy();
      await expect(
        q(`INSERT INTO dispatcher_pending (event_id, workspace_id, node_id, actor_id, label) VALUES (710002,$1,$2,$3,'t')`,
          [WS, WS, PHANTOM]),
      ).rejects.toThrow(/resolves to no actor/);
    });
  });

  describe("UPDATE guard (072) — a phantom uuid can't slip in via UPDATE", () => {
    let evId = "";
    beforeAll(async () => {
      const r = await q<{ id: string }>(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
         VALUES ($1,'user',$2,'NODE_UPDATED','node','wfk-u','{}') RETURNING id`, [WS, REAL]);
      evId = r.rows[0]!.id;
      await q(`INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by) VALUES ($1,$2,'approved',$3)
               ON CONFLICT (event_id) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by`, [evId, WS, REAL]);
    });

    it("rejects UPDATE event_reviews SET reviewed_by = phantom uuid (the 071 INSERT-only hole)", async () => {
      await expect(q(`UPDATE event_reviews SET reviewed_by = $2 WHERE event_id = $1::bigint`, [evId, PHANTOM]))
        .rejects.toThrow(/resolves to no actor/);
    });

    it("allows UPDATE event_reviews SET reviewed_by = a non-uuid sentinel", async () => {
      await expect(q(`UPDATE event_reviews SET reviewed_by = 'feed' WHERE event_id = $1::bigint`, [evId]))
        .resolves.toBeTruthy();
    });

    it("rejects UPDATE dispatcher_pending SET actor_id = phantom uuid", async () => {
      await q(`INSERT INTO dispatcher_pending (event_id, workspace_id, node_id, actor_id, label)
               VALUES (710050,$1,$2,$3,'t') ON CONFLICT (event_id) DO NOTHING`, [WS, WS, REAL]);
      await expect(q(`UPDATE dispatcher_pending SET actor_id = $1 WHERE event_id = 710050`, [PHANTOM]))
        .rejects.toThrow(/resolves to no actor/);
    });

    it("domain_events.actor_id is immutable — append-only blocks UPDATE outright (no ref guard needed)", async () => {
      await expect(q(`UPDATE domain_events SET actor_id = $2 WHERE id = $1::bigint`, [evId, PHANTOM]))
        .rejects.toThrow(/append-only/);
    });
  });

  describe("actor-deletion semantics (write-time check only)", () => {
    it("keeps existing events but rejects new writes after the actor is gone", async () => {
      const GONE = "00000000-0000-0000-0000-000000719001";
      await q(
        `INSERT INTO actors (id, workspace_id, name, type, external_id)
         VALUES ($1,$2,'Gone','agent','weak-fk-gone') ON CONFLICT (id) DO NOTHING`,
        [GONE, WS],
      );
      await q(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
         VALUES ($1,'ai_agent',$2,'NODE_UPDATED','node','wfk-g','{}')`,
        [WS, GONE],
      );
      const before = await q<{ n: string }>(
        `SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [WS, GONE]);
      expect(Number(before.rows[0]!.n)).toBeGreaterThanOrEqual(1);

      // No ON DELETE binding -> the actor deletes cleanly and the event survives.
      await q(`DELETE FROM actors WHERE id = $1`, [GONE]);
      const after = await q<{ n: string }>(
        `SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [WS, GONE]);
      expect(Number(after.rows[0]!.n)).toBeGreaterThanOrEqual(1); // historical row intact

      // A NEW event for the now-gone actor is correctly rejected.
      await expect(insEvent(GONE, "ai_agent")).rejects.toThrow(/resolves to no actor/);
    });
  });
});
