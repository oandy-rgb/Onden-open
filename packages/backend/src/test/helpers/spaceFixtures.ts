import { q } from "../../db.js";
import { seedQ } from "./seedQ.js";

// Spaces fixtures (docs/architecture/spaces.md). The old way to hide a note
// from someone was an access policy on a tag; now it is a space they are not
// in. These helpers build that situation directly.

/** A member of a fixture space. `permission` is the real vocabulary; `role`
 *  is the shorthand most older fixtures still write (viewer = view, editor and
 *  manager = edit; nobody is a "manager" any more: the owner manages shared
 *  spaces). TODO(roles PR 7): migrate fixtures to `permission`, drop `role`. */
export type FixtureMember = { id: string; permission?: "view" | "edit"; role?: "viewer" | "editor" | "manager" };
const permissionOf = (m: FixtureMember): "view" | "edit" => m.permission ?? (m.role === "viewer" ? "view" : "edit");

/** A shared space with exactly these members. */
export async function makeSpace(
  workspaceId: string, name: string, members: FixtureMember[],
  capabilities: Record<string, boolean> = { publish: false, external_ai: true, backup: true },
): Promise<string> {
  const id = (await q<{ id: string }>(
    `INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, $2, 'shared', $3) RETURNING id::text`,
    [workspaceId, name, JSON.stringify(capabilities)])).rows[0]!.id;
  for (const m of members) {
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, $3)`, [id, m.id, permissionOf(m)]);
  }
  return id;
}

/** Move a note (and its subtree, trashed descendants included) into a space,
 *  detaching it from a parent left behind. Test setup only — the product path
 *  is services/spaces.ts moveToSpace. */
export async function putInSpace(nodeId: string, spaceId: string): Promise<void> {
  await seedQ(`UPDATE content_nodes SET parent_id = NULL WHERE id = $1
            AND parent_id IS NOT NULL
            AND (SELECT space_id FROM content_nodes p WHERE p.id = content_nodes.parent_id) IS DISTINCT FROM $2::uuid`,
    [nodeId, spaceId]);
  await seedQ(`WITH RECURSIVE sub AS (
             SELECT id FROM content_nodes WHERE id = $1
             UNION SELECT c.id FROM content_nodes c JOIN sub ON c.parent_id = sub.id WHERE c.node_type <> 'class_tag')
           UPDATE content_nodes SET space_id = $2 WHERE id IN (SELECT id FROM sub)`, [nodeId, spaceId]);
}

/** A space only `adminIds` are in (editing): the replacement for the old
 *  "admin-read tag" fixture. Returns the space id. */
export async function adminOnlySpace(workspaceId: string, name: string, adminIds: string[]): Promise<string> {
  return makeSpace(workspaceId, name, adminIds.map((id) => ({ id, permission: "edit" as const })));
}

/** Add an actor to the workspace's default space (membership is explicit
 *  since migration 097). The shorthand role "viewer" gets view, anything else
 *  edit. */
export async function joinDefaultSpace(workspaceId: string, actorId: string, workspaceRole = "editor"): Promise<void> {
  await q(
    `INSERT INTO space_members (space_id, actor_id, permission)
     SELECT s.id, $2::uuid, CASE $3 WHEN 'viewer' THEN 'view' ELSE 'edit' END
       FROM spaces s WHERE s.workspace_id = $1 AND s.is_default
     ON CONFLICT (space_id, actor_id) DO NOTHING`,
    [workspaceId, actorId, workspaceRole]);
}

/** Turn on 「發布到網站」 for the workspace's default space: a new workspace's starts off (migration 186), and with it
 *  on every note there is on the site unless kept off (modules/website/publishing/publishedSet.ts). */
export async function publishDefaultSpace(workspaceId: string): Promise<void> {
  await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE workspace_id = $1 AND is_default`, [workspaceId]);
}
