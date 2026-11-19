// What a temporary session does when the person who opened it hands the workspace to someone else (docs/architecture/proposals/sessions-reads-own-2026-11-17.md §7).
// WRITTEN DOWN AS IT IS TODAY, not as a decision: nothing ends the session at a handover (only removing the opener does: endTemporarySessionsOpenedBy), so
//   - it keeps working until its own end time;
//   - it still reads the personal data of the person who opened it (they are still a person of the workspace), not the new owner's;
//   - its reach is still the spaces it was given, no wider than what the opener still holds there;
//   - the NEW owner may end it (principal_admin), and the old opener may not (no longer the owner).
// Whoever changes any of these changes this test and says so.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { endTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { transferOwnership } from "../services/ownerTransfer.js";
import { readPref } from "../services/actorPrefs.js";
import { canReadNode } from "../services/readPolicy.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

describe.skipIf(!isTestDatabase())("a session after its opener handed the workspace over", () => {
  let w: Awaited<ReturnType<typeof standardWorld>>;
  let credential = "", secondCredential = "", secondId = "", noteA = "";
  beforeAll(async () => {
    w = await standardWorld("handover");
    ownWorkspace = w.ws;
    noteA = await newNote(w.ws, "in A", w.spaceA, "body");
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'nav', '{"order":["notes"],"phone":1}'::jsonb), ($2, 'nav', '{"order":["tasks"],"phone":2}'::jsonb)`, [w.owner.id, w.member.id]);
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] });
    credential = opened.credential;
    const second = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] }); // one session per test: the second ends it
    secondCredential = second.credential; secondId = second.sessionId;
    await q(`UPDATE actors SET name = 'Member' WHERE id = $1`, [w.member.id]);
    await transferOwnership(w.owner.ctx, w.ws, { toActorId: w.member.id, confirmName: "Member" });
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it("is still live, still reads the original opener's data (not the new owner's), and its reach is unchanged", async () => {
    const session = (await resolveTemporarySessionActor(credential, w.ws))!;
    expect(session).not.toBeNull();
    expect(session.sessionScope?.openedBy).toBe(w.owner.id);
    expect(await readPref(session, "nav")).toEqual({ order: ["notes"], phone: 1 }); // the old owner's, not the member's
    expect(await canReadNode(session, noteA)).toBe(true);
  });

  it("the new owner can end it; the old owner, no longer the owner, cannot", async () => {
    await expect(endTemporarySession(w.owner.ctx, w.ws, secondId)).rejects.toThrow();
    expect(await endTemporarySession(w.member.ctx, w.ws, secondId)).toEqual({ ended: true });
    expect(await resolveTemporarySessionActor(secondCredential, w.ws)).toBeNull();
  });
});
