// Workspace settings (depth audit D10, moved from index.ts): the home note
// and the site config / chrome, each change an owner-only, audited mutate().
// Reading the config hides the owner's share and access tokens from members.

import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { canReadNode } from "./readPolicy.js";
import { StatusError } from "../statusError.js";
import { workspaceColumnsSql } from "./syncProjection.js";
import { workspaceWireRow } from "./workspaceModules.js";
import { getSiteConfig, patchSiteConfig, getChromeBlocks, setChromeBlocks } from "./siteConfig.js";

/** Set or clear (null) the home note; undefined changes nothing and returns
 *  the workspace row. WORKSPACE_UPDATED is recorded either way. */
export async function setHomeNode(authenticated: ActorCtx | null, workspaceId: string, homeNodeId: string | null | undefined) {
  const actor = requireActor(authenticated);
  // The home note is one of THIS workspace's notes the caller can read; an id from another workspace (or an
  // unreadable one) is "not found", not stored (it would make the published site name a note it does not hold).
  if (homeNodeId && !(await canReadNode(actor, homeNodeId))) throw new StatusError(404, "note not found");
  // First route through the spine: authority + event + update are now one
  // unskippable unit. Admin gate (previously absent), event emission, and
  // correct actor attribution all come from mutate() rather than by hand.
  const row = await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "WORKSPACE_UPDATED",
      targetType: "workspace",
      targetId: workspaceId,
      payload: { home_node_id: homeNodeId ?? null },
    },
    apply: async () => {
      // undefined = field not in the PATCH (no-op read-back); null = CLEAR.
      const result = homeNodeId === undefined
        ? await q<{ id: string; modules_off: unknown; modules_confirmed: unknown }>(
            `SELECT ${workspaceColumnsSql("workspaces")} FROM workspaces WHERE id = $1`,
            [workspaceId],
          )
        : await q<{ id: string; modules_off: unknown; modules_confirmed: unknown }>(
            `UPDATE workspaces SET home_node_id = $2
             WHERE id = $1
             RETURNING ${workspaceColumnsSql("workspaces")}`,
            [workspaceId, homeNodeId],
          );
      return result.rows[0];
    },
  });
  return workspaceWireRow(row);
}

/** The site config and chrome. The workspace's own settings are for the people of the workspace, not for a temporary session on someone else's computer. */
export async function readWorkspaceConfig(authenticated: ActorCtx | null, workspaceId: string) {
  requirePerson(requireActor(authenticated), "workspace_settings");
  return { config: await getSiteConfig(workspaceId), chrome: await getChromeBlocks(workspaceId) };
}

/** Patch the site config keys and/or replace the chrome (owner only); answers
 *  the whole config and chrome after the change. `chromeBase`: the chrome
 *  revision the new chrome started from (the Studio sends it); a stale one is
 *  refused with 409 design_stale (siteConfig.ts setChromeBlocks), so an old
 *  tab cannot replace a newer header with its copy (D119). */
export async function updateWorkspaceConfig(
  authenticated: ActorCtx | null, workspaceId: string,
  input: { config?: Record<string, unknown>; chrome?: unknown; chromeBase?: string | null },
) {
  const actor = requireActor(authenticated);
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "SITE_CONFIG_UPDATED",
      targetType: "workspace",
      targetId: workspaceId,
      payload: { keys: input.config ? Object.keys(input.config) : [], chrome_changed: input.chrome !== undefined },
    },
    apply: async () => {
      if (input.config !== undefined) await patchSiteConfig(workspaceId, input.config, actor);
      if (input.chrome !== undefined) await setChromeBlocks(workspaceId, input.chrome, actor, { base: input.chromeBase });
    },
  });
  const config = await getSiteConfig(workspaceId);
  const chrome = await getChromeBlocks(workspaceId);
  return { config, chrome };
}
