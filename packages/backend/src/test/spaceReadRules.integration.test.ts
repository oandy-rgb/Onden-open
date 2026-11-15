// What a reader may see, asked three ways that must agree: the set of node ids
// (readPolicy.readableNodeIdSet / readableTrashedNodeIds), the SQL predicate that
// list queries push down (readableScopeSql), and the one-node questions (canReadNode,
// canReadRetainedNode, canSeeTag). Plus spaceAccess for an agent session's token, the
// access explanation, and the idempotency replay error. Added after mutation testing
// (docs/archive/research/mutation-2026-10-24.md) showed the live / trashed / retained switch,
// the default lifecycle and the session token's edit condition could change unnoticed.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { canReadNode, canReadRetainedNode, canSeeTag, readableNodeIdSet, readableScopeSql, readableTrashedNodeIds, restrictRowsToScope } from "../services/readPolicy.js";
import { spaceCanRead, spaceCanWrite, spaceReadableNodeIds, spaceWritable } from "../spine/spaceScope.js";
import { explainAccess, spaceAccess, workspaceOwnerSql, type AgentAccessFacts } from "../spine/spaceAccess.js";
import { IdempotentReplay } from "../spine/idempotency.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

afterAll(async () => { await pool.end(); });

describe.skipIf(!isTestDb)("the read rule, asked as a set, as SQL and one node at a time", () => {
  let ws = "";
  let owner: ActorCtx, editor: ActorCtx, viewer: ActorCtx, stranger: ActorCtx, readAgent: ActorCtx, writeAgent: ActorCtx;
  let note = "", trashed = "", closedNote = "", closedTrashed = "", tag = "", trashedTag = "";
  let closedSpace = "";

  const insert = async (title: string, type: "content" | "class_tag", trashedAt: Date | null = null) =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color, deleted_at)
       VALUES ($1,'manual',$2,$3,$4,'',$5,$6) RETURNING id::text`,
      [ws, type, `${title} ${randomUUID().slice(0, 6)}`, randomUUID(), type === "class_tag" ? "#888" : null, trashedAt])).rows[0]!.id;
  const sqlIds = async (actor: ActorCtx | null) => {
    const params: unknown[] = [ws];
    const where = readableScopeSql(actor, "n", params);
    return new Set((await q<{ id: string }>(`SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND ${where}`, params)).rows.map((r) => r.id));
  };
  const mine = (ids: Set<string>) => new Set([note, trashed, closedNote, closedTrashed, tag, trashedTag].filter((id) => ids.has(id)));

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Space read rules', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, { id: "", name: "owner", role: "admin", type: "human" });
    editor = await persistActor(ws, { id: "", name: "editor", role: "editor", type: "human" });
    viewer = await persistActor(ws, { id: "", name: "viewer", role: "viewer", type: "human" });
    stranger = await persistActor(ws, { id: "", name: "stranger", role: "editor", type: "human" });
    readAgent = await persistActor(ws, { id: "", name: "read agent", role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null } });
    writeAgent = await persistActor(ws, { id: "", name: "write agent", role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    await q(`UPDATE spaces SET capabilities = capabilities || '{"external_ai": true}'::jsonb WHERE workspace_id = $1 AND is_default`, [ws]);
    // a shared space only the owner is in
    closedSpace = await makeSpace(ws, "closed", [{ id: owner.id, permission: "edit" }]);
    note = await insert("note", "content");
    trashed = await insert("trashed", "content", new Date());
    closedNote = await insert("closed note", "content");
    closedTrashed = await insert("closed trashed", "content", new Date());
    await putInSpace(closedNote, closedSpace);
    await putInSpace(closedTrashed, closedSpace);
    tag = await insert("tag", "class_tag");
    trashedTag = await insert("trashed tag", "class_tag", new Date());
    // `stranger` has left the default space: a member of nothing
    await q(`DELETE FROM space_members WHERE actor_id = $1 AND space_id IN (SELECT id FROM spaces WHERE workspace_id = $2 AND is_default)`, [stranger.id, ws]);
  });
  afterAll(async () => {
    if (ws) {
      await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
      await deleteWorkspaceActors(ws);
    }
  });

  it("live ids: members see live notes and every live tag, never a trashed row or a closed space", async () => {
    for (const who of [editor, viewer, readAgent, writeAgent]) {
      expect(mine(await readableNodeIdSet(who, ws)), who.name).toEqual(new Set([note, tag]));
    }
    expect(mine(await readableNodeIdSet(owner, ws))).toEqual(new Set([note, closedNote, tag]));
    // a member of no space still reads tag definitions, which belong to no space
    expect(mine(await readableNodeIdSet(stranger, ws))).toEqual(new Set([tag]));
    expect(mine(await readableNodeIdSet(null, ws))).toEqual(new Set([tag]));
  });

  it("trashed ids: only trashed rows, by the same space rule", async () => {
    expect(mine(await readableTrashedNodeIds(editor, ws))).toEqual(new Set([trashed, trashedTag]));
    expect(mine(await readableTrashedNodeIds(owner, ws))).toEqual(new Set([trashed, closedTrashed, trashedTag]));
    expect(mine(await readableTrashedNodeIds(stranger, ws))).toEqual(new Set([trashedTag]));
  });

  it("spaceReadableNodeIds: the lifecycle defaults to live; 'any' is both", async () => {
    expect(mine(await spaceReadableNodeIds(editor, ws))).toEqual(new Set([note, tag]));
    expect(mine(await spaceReadableNodeIds(editor, ws, "live"))).toEqual(new Set([note, tag]));
    expect(mine(await spaceReadableNodeIds(editor, ws, "trashed"))).toEqual(new Set([trashed, trashedTag]));
    expect(mine(await spaceReadableNodeIds(editor, ws, "any"))).toEqual(new Set([note, trashed, tag, trashedTag]));
    expect(mine(await spaceReadableNodeIds(owner, ws, "any"))).toEqual(new Set([note, trashed, closedNote, closedTrashed, tag, trashedTag]));
  });

  it("the pushed-down SQL predicate returns what the id set does, for every kind of reader", async () => {
    for (const who of [owner, editor, viewer, stranger, readAgent, writeAgent, null]) {
      expect(await sqlIds(who), who?.name ?? "nobody").toEqual(await readableNodeIdSet(who, ws));
    }
  });

  it("one node at a time: canReadNode is live only, canReadRetainedNode includes the trash, neither crosses a closed space", async () => {
    expect(await canReadNode(editor, note)).toBe(true);
    expect(await canReadNode(editor, trashed)).toBe(false);
    expect(await canReadRetainedNode(editor, note)).toBe(true);
    expect(await canReadRetainedNode(editor, trashed)).toBe(true);
    expect(await canReadNode(editor, closedNote)).toBe(false);
    expect(await canReadRetainedNode(editor, closedNote)).toBe(false);
    expect(await canReadRetainedNode(editor, closedTrashed)).toBe(false);
    expect(await canReadRetainedNode(owner, closedTrashed)).toBe(true);
    // a purged or never-existing row is denied, not an error
    expect(await canReadNode(editor, randomUUID())).toBe(false);
    expect(await canReadRetainedNode(owner, randomUUID())).toBe(false);
  });

  it("canSeeTag: a live definition, by anyone in the workspace; a trashed one is gone", async () => {
    for (const who of [owner, editor, viewer, readAgent]) expect(await canSeeTag(who, tag), who.name).toBe(true);
    expect(await canSeeTag(editor, trashedTag)).toBe(false);
    expect(await canSeeTag(owner, trashedTag)).toBe(false);
    expect(await canSeeTag(editor, randomUUID())).toBe(false);
  });

  it("spaceCanRead / spaceCanWrite / spaceWritable follow the same lifecycle and the permission", async () => {
    expect(await spaceCanRead(editor, trashed, "live")).toBe(false);
    expect(await spaceCanRead(editor, trashed, "retained")).toBe(true);
    expect(await spaceCanRead(null, note, "live")).toBe(false);
    expect(await spaceCanWrite(editor, note, "live")).toBe(true);
    expect(await spaceCanWrite(viewer, note, "live")).toBe(false);
    expect(await spaceCanWrite(editor, trashed, "live")).toBe(false);
    expect(await spaceCanWrite(editor, trashed, "retained")).toBe(true);
    expect(await spaceCanWrite(editor, tag, "live")).toBe(false); // a tag definition is in no space
    expect(await spaceCanWrite(readAgent, note, "live")).toBe(false);
    expect(await spaceCanWrite(writeAgent, note, "live")).toBe(true);
    const defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    expect(await spaceWritable(editor, defaultSpace)).toBe(true);
    expect(await spaceWritable(viewer, defaultSpace)).toBe(false);
    expect(await spaceWritable(editor, closedSpace)).toBe(false);
    expect(await spaceWritable(editor, randomUUID())).toBe(false);
  });

  it("restrictRowsToScope keeps every row for no restriction and only allowed rows otherwise", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const id = (r: { id: string }) => r.id;
    expect(restrictRowsToScope(rows, id, null)).toBe(rows);
    expect(restrictRowsToScope(rows, id, new Set(["a", "c"]))).toEqual([{ id: "a" }, { id: "c" }]);
    expect(restrictRowsToScope(rows, id, new Set())).toEqual([]);
  });

  it("workspaceOwnerSql defaults to the aliases a and w, and selects the owner and nobody else", async () => {
    expect(workspaceOwnerSql()).toBe(workspaceOwnerSql("a", "w"));
    const owners = (await q<{ id: string }>(
      `SELECT a.id::text FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE w.id = $1 AND ${workspaceOwnerSql()}`, [ws])).rows;
    expect(owners.map((r) => r.id)).toEqual([owner.id]);
  });
});

describe.skipIf(!isTestDb)("an agent session's token reaches one space, for as long as the person who sent it can", () => {
  let ws = "";
  let initiator: ActorCtx, agent: ActorCtx;
  let sessionSpace = "", otherSpace = "";
  let session = "";

  const sessionToken = async (): Promise<ActorCtx> => {
    const tokenId = (await q<{ id: string }>(
      `INSERT INTO agent_tokens (actor_id, token_hash, name, access, expires_at, issued_by, session_id)
       VALUES ($1, $2, 'session', 'write', now() + interval '1 hour', $3, $4) RETURNING id::text`,
      [agent.id, randomBytes(16).toString("hex"), initiator.id, session])).rows[0]!.id;
    return { ...agent, tokenScope: { tokenId, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null, issuedBy: initiator.id, sessionId: session } };
  };
  const setInitiator = (space: string, permission: "view" | "edit" | null) =>
    permission === null
      ? q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [space, initiator.id])
      : q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,$3) ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = EXCLUDED.permission`, [space, initiator.id, permission]);

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Session token', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    initiator = await persistActor(ws, { id: "", name: "initiator", role: "admin", type: "human" });
    agent = await persistActor(ws, { id: "", name: "agent", role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    sessionSpace = await makeSpace(ws, "session space", [{ id: initiator.id, permission: "edit" }, { id: agent.id, permission: "edit" }]);
    otherSpace = await makeSpace(ws, "other space", [{ id: initiator.id, permission: "edit" }, { id: agent.id, permission: "edit" }]);
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content','host',$2,'') RETURNING id::text`,
      [ws, randomUUID()])).rows[0]!.id;
    await putInSpace(note, sessionSpace);
    session = (await q<{ id: string }>(
      `INSERT INTO agent_sessions (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, prompt, deadline_at)
       VALUES ($1,$2,$3,$4,$5,'blk','do it', now() + interval '1 hour') RETURNING id::text`,
      [ws, agent.id, initiator.id, note, sessionSpace])).rows[0]!.id;
  });
  afterAll(async () => {
    if (ws) {
      await q(`DELETE FROM agent_sessions WHERE workspace_id = $1`, [ws]);
      await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
      await deleteWorkspaceActors(ws);
    }
  });

  it("reads and writes the session's space while the sender can edit there", async () => {
    await setInitiator(sessionSpace, "edit");
    const token = await sessionToken();
    expect(await spaceAccess(token, sessionSpace)).toMatchObject({ read: true, write: true, manage: false });
  });

  it("writes only as far as the sender can: a sender who can only view leaves the agent read-only", async () => {
    await setInitiator(sessionSpace, "view");
    const token = await sessionToken();
    expect(await spaceAccess(token, sessionSpace)).toMatchObject({ read: true, write: false });
    await setInitiator(sessionSpace, "edit");
  });

  it("loses the space when the sender is no longer in it", async () => {
    await setInitiator(sessionSpace, null);
    const token = await sessionToken();
    expect(await spaceAccess(token, sessionSpace)).toMatchObject({ read: false, write: false });
    await setInitiator(sessionSpace, "edit");
  });

  it("never reaches another space, though the agent is an editor there and the sender too", async () => {
    await setInitiator(sessionSpace, "edit");
    const token = await sessionToken();
    expect(await spaceAccess(token, otherSpace)).toMatchObject({ read: false, write: false });
    // the same agent without the session limit does reach it
    expect(await spaceAccess(agent, otherSpace)).toMatchObject({ read: true, write: true });
  });
});

describe("explainAccess says why an agent cannot, and only where the gate says no", () => {
  const facts = (over: Partial<AgentAccessFacts> = {}): AgentAccessFacts =>
    ({ liveTokens: 1, writeTokens: 1, externalAi: true, permission: "edit", ...over });
  const open = { read: true, write: true };

  it("gives no reason when the gate lets the agent through", () => {
    expect(explainAccess(facts(), open)).toEqual({ readBlockedBy: null, writeBlockedBy: null });
    // facts that look bad do not matter once the gate has said yes: the explanation never contradicts the rule
    expect(explainAccess(facts({ liveTokens: 0, permission: null, externalAi: false }), open)).toEqual({ readBlockedBy: null, writeBlockedBy: null });
  });

  it("explains a refused read in the order: no token, not a member, external AI off", () => {
    const shut = { read: false, write: false };
    expect(explainAccess(facts({ liveTokens: 0, permission: null, externalAi: false }), shut).readBlockedBy).toBe("no_live_token");
    expect(explainAccess(facts({ permission: null, externalAi: false }), shut).readBlockedBy).toBe("not_member");
    expect(explainAccess(facts({ externalAi: false }), shut).readBlockedBy).toBe("external_ai_off");
    // all three facts fine yet the gate says no: it cannot be explained, and says "not_member"
    expect(explainAccess(facts(), shut).readBlockedBy).toBe("not_member");
  });

  it("a refused read also blocks writing, for the same reason", () => {
    const shut = { read: false, write: false };
    for (const f of [facts({ liveTokens: 0 }), facts({ permission: null }), facts({ externalAi: false })]) {
      const r = explainAccess(f, shut);
      expect(r.writeBlockedBy).toBe(r.readBlockedBy);
    }
  });

  it("explains a refused write where reading works: view-only permission, or only read tokens", () => {
    const readOnly = { read: true, write: false };
    expect(explainAccess(facts({ permission: "view" }), readOnly)).toEqual({ readBlockedBy: null, writeBlockedBy: "view_only" });
    expect(explainAccess(facts({ permission: "view", writeTokens: 0 }), readOnly).writeBlockedBy).toBe("view_only");
    expect(explainAccess(facts({ writeTokens: 0 }), readOnly).writeBlockedBy).toBe("token_read_only");
    // an editor with a write token that the gate still refuses: reported as view_only (unreachable while gate and facts agree)
    expect(explainAccess(facts(), readOnly).writeBlockedBy).toBe("view_only");
  });
});

describe("IdempotentReplay", () => {
  it("names itself, carries the key it replays and has a stable message callers can match", () => {
    const e = new IdempotentReplay("key-1");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("IdempotentReplay");
    expect(e.message).toBe("idempotent_replay");
    expect(e.key).toBe("key-1");
  });
});
