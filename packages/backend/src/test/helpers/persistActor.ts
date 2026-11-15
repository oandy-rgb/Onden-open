import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { createToken } from "../../services/agentTokens.js";
import type { ActorCtx } from "../../types.js";
import { setWorkspaceOwner } from "./setOwner.js";

/** Explicit fixture setup, never request middleware: persist a fresh actor and
 * optional real token, returning the context the test should authenticate as.
 * The actor joins the workspace's default space (view for the fixture shorthand
 * role "viewer", edit otherwise) and, for a human, gets a personal space
 * (trigger). A human fixture with the shorthand role "admin" becomes the
 * workspace owner, as the first human does in production; a test that needs a
 * different owner sets owner_actor_id itself. The shorthand `role` is
 * test-only (fixtureActorRole.d.ts). Later membership changes must be written
 * explicitly by the test so stale captured contexts remain stale. */
export async function persistActor(workspaceId: string, fixture: ActorCtx): Promise<ActorCtx> {
  const id = randomUUID();
  await q(
    `INSERT INTO actors (id,workspace_id,name,type) VALUES ($1,$2,$3,$4)`,
    [id, workspaceId, fixture.name, fixture.type],
  );
  // Membership is explicit (migration 097); fixtures join the default space.
  await q(
    `INSERT INTO space_members (space_id, actor_id, permission)
     SELECT s.id, $2, CASE $3 WHEN 'viewer' THEN 'view' ELSE 'edit' END
       FROM spaces s WHERE s.workspace_id = $1 AND s.is_default
     ON CONFLICT (space_id, actor_id) DO NOTHING`,
    [workspaceId, id, fixture.role ?? "editor"],
  );
  const actor: ActorCtx = { ...fixture, id };
  if (fixture.role === "admin" && fixture.type === "human" && !fixture.tokenScope) {
    await setWorkspaceOwner(workspaceId, id);
  }
  if (fixture.tokenScope) {
    const token = await createToken(id, {
      access: fixture.tokenScope.access,
      allowedTools: fixture.tokenScope.allowedTools,
      expiresAt: fixture.tokenScope.expiresAt,
    });
    actor.tokenScope = { ...fixture.tokenScope, tokenId: token.id };
  }
  return actor;
}

/** The native app's owner: the workspace's System actor (external_id 'system',
 *  no token), created when the workspace has none. */
export async function nativeOwnerActor(workspaceId: string): Promise<ActorCtx> {
  const existing = await q<{ id: string }>(
    `SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId]);
  const id = existing.rows[0]?.id ?? (await q<{ id: string }>(
    `INSERT INTO actors (workspace_id, name, type, external_id)
     VALUES ($1, 'System', 'agent', 'system') RETURNING id::text`, [workspaceId])).rows[0]!.id;
  // As in production (the 093 seed), it edits the default space.
  await q(
    `INSERT INTO space_members (space_id, actor_id, permission)
     SELECT s.id, $2, 'edit' FROM spaces s WHERE s.workspace_id = $1 AND s.is_default
     ON CONFLICT (space_id, actor_id) DO NOTHING`,
    [workspaceId, id],
  );
  return { id, name: "System", type: "agent" };
}
