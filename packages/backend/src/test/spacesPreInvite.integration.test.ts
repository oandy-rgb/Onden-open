// Before a second person is invited (docs/archive/research/integration-audit-2026-10-13.md §4):
// membership is explicit, a token reaches only its agent's own spaces, a move
// preview only names a space the caller could move into, and a new note's
// space follows one rule (services/spaces.ts newNoteSpace).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { canReadNode } from "../services/readPolicy.js";
import { writableSpaceIds } from "../spine/spaceAccess.js";
import { canWriteSomewhere, moveToSpace, newNoteSpace, previewMove, spacesForActor } from "../services/spaces.js";
import { syncWikilinkEdges, uniqueSlug } from "../services/nodes.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";


describe.skipIf(!isTestDatabase())("spaces before inviting a second person", () => {
  let ws = "";
  let defaultSpace = "";
  let owner: ActorCtx;
  let member: ActorCtx;
  let agent: ActorCtx;

  const insertActor = async (name: string, type: "human" | "agent", inWs = ws): Promise<ActorCtx> => {
    const id = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1,$2,$3,$4) RETURNING id::text`,
      [inWs, name, type, randomUUID()])).rows[0]!.id;
    return { id, name, type };
  };
  // A fresh workspace: the first human becomes the owner.
  const freshWorkspace = async () => {
    const id = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('pre-invite', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [id])).rows[0]!.id;
    return {
      ws: id, defaultSpace: space,
      owner: await insertActor("Owner", "human", id),
      member: await insertActor("Member", "human", id),
      agent: await insertActor("Agent", "agent", id),
    };
  };
  const note = async (title: string, spaceId: string) => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'x') RETURNING id::text`, [ws, title, randomUUID()])).rows[0]!.id;
    await putInSpace(id, spaceId);
    return id;
  };

  beforeAll(async () => {
    ({ ws, defaultSpace, owner, member, agent } = await freshWorkspace());
  });

  it("the owner joins the shared space; a new member and an agent do not", async () => {
    // Its own workspace: the other tests add the agent to spaces.
    const { ws, defaultSpace, owner, member, agent } = await freshWorkspace();
    const note = async (title: string, spaceId: string) => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'x') RETURNING id::text`, [ws, title, randomUUID()])).rows[0]!.id;
      await putInSpace(id, spaceId);
      return id;
    };
    const permissions = await q<{ actor_id: string; permission: string }>(
      `SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [defaultSpace]);
    expect(permissions.rows).toEqual([{ actor_id: owner.id, permission: "edit" }]);
    expect((await q<{ owner: string }>(`SELECT owner_actor_id::text AS owner FROM workspaces WHERE id = $1`, [ws])).rows[0]!.owner).toBe(owner.id);
    const shared = await note("Owner's old note", defaultSpace);
    expect(await canReadNode(member, shared)).toBe(false);
    // The member still has their own space, and writes there.
    expect(await canWriteSomewhere(member)).toBe(true);
    expect(await canWriteSomewhere(agent)).toBe(false);
  });

  it("a token reaches only its agent's own spaces: viewing is not writing, and a closed external-AI switch hides a space", async () => {
    const lab = await makeSpace(ws, `Lab ${randomUUID()}`, [{ id: agent.id, permission: "view" }]);
    const closed = await makeSpace(ws, `Closed ${randomUUID()}`, [{ id: agent.id, permission: "edit" }],
      { publish: false, external_ai: false, backup: true });
    const labNote = await note("Lab note", lab);
    const closedNote = await note("Closed note", closed);
    const sharedNote = await note("Shared note", defaultSpace);
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'edit')`, [defaultSpace, agent.id]);
    // The owner issued it and is in none of these spaces but the shared one:
    // the token's reach is the agent's membership, not the issuer's.
    const issued = await createToken(agent.id, { access: "write", issuedBy: owner.id });
    const bearer = (await resolveBearerActor(issued.plaintext, ws))!;
    expect(await canReadNode(bearer, sharedNote)).toBe(true);
    expect(await canReadNode(bearer, labNote)).toBe(true);
    expect(await canReadNode(bearer, closedNote)).toBe(false);
    const writable = await writableSpaceIds(bearer);
    expect(writable).toContain(defaultSpace);
    expect(writable).not.toContain(lab);
    expect(writable).not.toContain(closed);
    // A read token never writes, even where its agent edits.
    const readOnly = (await resolveBearerActor((await createToken(agent.id, { access: "read", issuedBy: owner.id })).plaintext, ws))!;
    expect(await canReadNode(readOnly, sharedNote)).toBe(true);
    expect(await writableSpaceIds(readOnly)).toEqual([]);
    // An agent in no space: its token reaches nothing.
    const loner = await insertActor("Loner", "agent");
    const none = (await resolveBearerActor((await createToken(loner.id, { access: "write", issuedBy: owner.id })).plaintext, ws))!;
    expect(await canReadNode(none, sharedNote)).toBe(false);
    expect(await writableSpaceIds(none)).toEqual([]);
  });

  it("a move preview only names a space the caller could move into", async () => {
    const secret = await makeSpace(ws, `Secret ${randomUUID()}`, [{ id: owner.id, permission: "edit" }]);
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [member.id])).rows[0]!.id;
    const memberNote = await note("Member's note", personal);
    await expect(previewMove(member, ws, memberNote, secret)).rejects.toMatchObject({ status: 404 });
    // Into a space they edit, the preview answers and names who gains access.
    const shared = await makeSpace(ws, `Shared ${randomUUID()}`, [{ id: member.id, permission: "edit" }, { id: owner.id, permission: "edit" }]);
    const preview = await previewMove(member, ws, memberNote, shared);
    expect(preview.gain.map((m) => m.name)).toEqual(["Owner"]);
  });

  it("a new top-level note: personal space for a person, a named space for a token", async () => {
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [member.id])).rows[0]!.id;
    expect(await newNoteSpace(member, ws)).toBe(personal);
    // A token that may write two spaces must name one — no fallback into 共用.
    await makeSpace(ws, `First ${randomUUID()}`, [{ id: agent.id, permission: "edit" }, { id: owner.id, permission: "edit" }]);
    const second = await makeSpace(ws, `Second ${randomUUID()}`, [{ id: agent.id, permission: "edit" }, { id: owner.id, permission: "edit" }]);
    const bearer = (await resolveBearerActor((await createToken(agent.id, { access: "write", issuedBy: owner.id })).plaintext, ws))!;
    await expect(newNoteSpace(bearer, ws)).rejects.toThrow(/name the space/);
    expect(await newNoteSpace(bearer, ws, { spaceId: second })).toBe(second);
    // A space it cannot write is refused even when named.
    await expect(newNoteSpace(member, ws, { spaceId: defaultSpace })).rejects.toThrow();
  });

  const membershipEpoch = async () =>
    (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [ws])).rows[0]!.e;
  const slugOf = async (id: string) => (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id])).rows[0]!.slug;

  it("slugs and [[title]] links live within a space", async () => {
    const a = await makeSpace(ws, `A ${randomUUID()}`, [{ id: owner.id, permission: "edit" }]);
    const b = await makeSpace(ws, `B ${randomUUID()}`, [{ id: owner.id, permission: "edit" }]);
    const base = `plan-${randomUUID().slice(0, 6)}`;
    // The same slug is free in each space: no "-2" that would reveal the other.
    expect(await uniqueSlug(ws, base, { spaceId: a })).toBe(base);
    const planA = await note("Plan", a);
    await seedQ(`UPDATE content_nodes SET slug = $2 WHERE id = $1`, [planA, base]);
    expect(await uniqueSlug(ws, base, { spaceId: b })).toBe(base);
    expect(await uniqueSlug(ws, base, { spaceId: a })).toBe(`${base}-2`);
    const planB = await note("Plan", b);
    await seedQ(`UPDATE content_nodes SET slug = $2 WHERE id = $1`, [planB, base]);
    // [[Plan]] from a note in B resolves to B's Plan only.
    const linker = await note("Linker", b);
    await seedQ(`UPDATE content_nodes SET markdown = 'see [[Plan]]' WHERE id = $1`, [linker]);
    const targets = await withTransaction(() => syncWikilinkEdges(ws, linker, "see [[Plan]]"));
    expect(targets.map((t) => t.id)).toEqual([planB]);
    // Moving A's Plan into B: its slug is taken there, so it gets the next one,
    // and the link from B now has two candidates in its space.
    await moveToSpace(owner, ws, planA, b, await membershipEpoch());
    expect(await slugOf(planA)).toBe(`${base}-2`);
    const after = await q<{ target_node_id: string }>(
      `SELECT target_node_id::text FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink' ORDER BY target_node_id`, [linker]);
    expect(after.rows.map((r) => r.target_node_id).sort()).toEqual([planA, planB].sort());
    // Moving it back out drops the now cross-space edge.
    await moveToSpace(owner, ws, planA, a, await membershipEpoch());
    const back = await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [linker, planA]);
    expect(back.rows).toHaveLength(0);
  });

  it("a removed member's personal space waits for the owner, unreadable until someone is added", async () => {
    const leaving = await insertActor("Leaving", "human");
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [leaving.id])).rows[0]!.id;
    const diary = await note("Diary", personal);
    // What DELETE /api/actors/:id does to the space (routes/actors.ts).
    await q(`UPDATE spaces SET kind = 'shared', owner_actor_id = NULL, name = 'Leaving (left)',
               capabilities = capabilities || '{"publish": false, "external_ai": false, "backup": false}'::jsonb
              WHERE owner_actor_id = $1 AND kind = 'personal'`, [leaving.id]);
    await q(`DELETE FROM actors WHERE id = $1`, [leaving.id]);
    expect(await canReadNode(owner, diary)).toBe(false);
    const listed = await spacesForActor(owner, ws);
    expect(listed.find((sp) => sp.id === personal)).toMatchObject({ kind: "shared", name: "Leaving (left)", permission: null, can_manage: true });
    expect((await spacesForActor(member, ws)).some((sp) => sp.id === personal)).toBe(false);
  });
});
