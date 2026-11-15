import { q } from "../../db.js";
import { mutate } from "../../spine/mutate.js";
import { ensureConfigNodeId, patchSiteConfig, setChromeBlocks } from "../../services/siteConfig.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "./persistActor.js";

/** Fixture shorthand for what the settings route does: the workspace owner (made
 *  when the workspace has none) changes the site settings inside
 *  SITE_CONFIG_UPDATED's mutate(), which is the only place the Site Config note
 *  is created or written. */
async function ownerOf(workspaceId: string): Promise<ActorCtx> {
  const row = (await q<{ id: string; name: string; type: ActorCtx["type"] }>(
    `SELECT a.id::text, a.name, a.type FROM workspaces w JOIN actors a ON a.id = w.owner_actor_id WHERE w.id = $1`,
    [workspaceId])).rows[0];
  if (row) return { id: row.id, name: row.name, type: row.type, role: "admin" };
  return persistActor(workspaceId, { id: "site-config-fixture", name: "Site config fixture", role: "admin", type: "human" });
}

async function asSettingsChange<T>(workspaceId: string, apply: (actor: ActorCtx) => Promise<T>): Promise<T> {
  const actor = await ownerOf(workspaceId);
  let out!: T;
  await mutate({
    actor, workspaceId, authority: { kind: "principal_admin" },
    event: { type: "SITE_CONFIG_UPDATED", targetType: "workspace", targetId: workspaceId, payload: { keys: [], chrome_changed: false } },
    apply: async () => { out = await apply(actor); },
  });
  return out;
}

/** The workspace's Site Config note id, created by a settings change when missing. */
export const ensureConfigNode = (workspaceId: string) =>
  asSettingsChange(workspaceId, (actor) => ensureConfigNodeId(workspaceId, actor));

export async function setSiteConfig(workspaceId: string, patch: Record<string, unknown>): Promise<void> {
  await asSettingsChange(workspaceId, (actor) => patchSiteConfig(workspaceId, patch, actor));
}

export async function setChrome(workspaceId: string, presentation: unknown, opts?: { base?: string | null }): Promise<void> {
  await asSettingsChange(workspaceId, (actor) => setChromeBlocks(workspaceId, presentation, actor, opts));
}
