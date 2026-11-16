// Site-level settings substrate.
//
// Workspace settings (brand, accent, font, theme, nav, the site design) live
// as attributes/presentation on a dedicated content_node tagged with the
// reserved `workspace-config` supertag. Get/set goes through this service so
// every site-config change rides the same dispatcher path as other
// writes — audit and permission semantics apply uniformly.

import { randomUUID } from "node:crypto";
import { q, requireTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { insertTagRow } from "./tagWrites.js";
import type { ActorCtx } from "../types.js";
import { CONFIG_TAG_NAME } from "../spine/reservedNodes.js";
import { adoptReservedTag, reservedTagId, reservedTagPredicate, RESERVED_TAGS } from "./reservedTags.js";
import { derivedIdName, inferFromValue, parseValue, serializeValue } from "@onden/markdown";
import { newIdFor } from "./derivedIds.js";
import { claimUploadedMedia, presentationText } from "./mediaOwners.js";
import { validateDesign } from "@onden/site";
import { CodedStatusError } from "../statusError.js";
import type { SiteConfig } from "@onden/contract";
import { liveNodeSql, tagNodeSql } from "../spine/nodeSql.js";


// ── Locate / create the config node ─────────────────────────────────────────

// Every query goes through q(): called inside a mutate()/event transaction the
// reads and writes join it, so a config change commits or rolls back with its
// event; called on its own, the writes run in their own transaction.

/** The workspace config node id, or null when it does not exist yet. Read-only:
 *  for read paths (e.g. the anonymous media gate) that must not create it. */
export async function findConfigNodeId(workspaceId: string): Promise<string | null> {
  // n is the workspace_config note, t the reserved config tag (by its key,
  // migration 100 — the title is free to change). A member can tag any note
  // #workspace-config, so the Site Config note ('_workspace_config') wins and
  // the order is fixed: the same note every call.
  const found = await q<{ id: string }>(
    `SELECT n.id
     FROM content_nodes n
     JOIN node_tags nt ON nt.node_id = n.id
     JOIN content_nodes t ON t.id = nt.tag_id AND ${reservedTagPredicate("t", RESERVED_TAGS.config, { lifecycle: "live" })}
     WHERE n.workspace_id = $1
       AND ${liveNodeSql("n")}
     ORDER BY (n.slug = '_workspace_config') DESC, n.created_at, n.id
     LIMIT 1`,
    [workspaceId],
  );
  return found.rows[0]?.id ?? null;
}

/** The config node id for a READ: adopts a restored root config tag (a role
 *  record under the event lock, no user-visible change), then looks it up.
 *  Null when the workspace has no Site Config note yet; reads treat that as
 *  "no settings" and never create it (creating is a write with an author:
 *  ensureConfigNodeId, from the admin's first settings change). */
export async function readConfigNodeId(workspaceId: string): Promise<string | null> {
  // A root config tag that predates its key (a restored backup) is adopted
  // first, so its Site Config note is found instead of a second one created.
  await adoptReservedTag(workspaceId, RESERVED_TAGS.config);
  return findConfigNodeId(workspaceId);
}

/** The config node id for a WRITE, creating the Site Config note (and its tag)
 *  when missing. Reachable in production: a fresh install loads the
 *  schema-only snapshot, so migration 009's per-workspace seed never ran
 *  there, and a backup restored without the note lacks it too. Runs inside the
 *  settings change's mutate() (principal_admin), so the nested creations are
 *  attributed TAG_CREATED / NODE_CREATED events chained to that change, and
 *  refuse outside one (the cascade authority needs an enclosing mutate()). */
export async function ensureConfigNodeId(workspaceId: string, actor: ActorCtx): Promise<string> {
  const existing = await readConfigNodeId(workspaceId);
  if (existing) return existing;
  return withEventTransaction(workspaceId, async () => {
    // Re-check under the event lock: a concurrent creator has committed or waits.
    const raced = await findConfigNodeId(workspaceId);
    if (raced) return raced;

    // The config tag by its key; the reserved-key unique index guarantees one
    // live holder per workspace. A holder a past bug flipped to
    // node_type='content' (the 2026-06-27 PATCH-default bug, fixed in 36069e3)
    // is not found by reservedTagId: its role is put back, not duplicated.
    let tagId = await reservedTagId(workspaceId, RESERVED_TAGS.config);
    if (!tagId) {
      const flipped = await q<{ id: string }>(
        `UPDATE content_nodes SET ${tagNodeSql()}
          WHERE workspace_id = $1 AND reserved_key = $2 AND ${liveNodeSql()}
          RETURNING id`,
        [workspaceId, CONFIG_TAG_NAME],
      );
      tagId = flipped.rows[0]?.id ?? null;
    }
    if (!tagId) {
      const id = await newIdFor("content_nodes", derivedIdName.reservedTag(workspaceId, CONFIG_TAG_NAME));
      await mutate({
        actor, workspaceId, authority: { kind: "cascade" },
        event: {
          type: "TAG_CREATED", targetType: "tag", targetId: id,
          payload: { name: CONFIG_TAG_NAME },
          txMeta: { ui_context: "site-config.ensure" },
        },
        apply: async () => {
          await insertTagRow(workspaceId, {
            id, title: CONFIG_TAG_NAME, reservedKey: CONFIG_TAG_NAME, color: "#666666",
            slug: `tag-${CONFIG_TAG_NAME}-${id.slice(0, 6)}`,
          });
        },
      });
      tagId = id;
    }

    // The Site Config note may still be live, carrying the tag: after a
    // flip it was only invisible to findConfigNodeId's class_tag join.
    // Inserting another would hit the '_workspace_config' slug (23505) on
    // every call, so the healed tag's live Site Config note is THE config
    // node. Only that note: a stray note someone tagged #workspace-config is
    // not adopted as the settings.
    const tagged = await q<{ id: string }>(
      `SELECT n.id FROM content_nodes n JOIN node_tags nt ON nt.node_id = n.id
        WHERE nt.tag_id = $2 AND n.workspace_id = $1 AND ${liveNodeSql("n")}
          AND n.slug = '_workspace_config'
        ORDER BY n.created_at, n.id LIMIT 1`,
      [workspaceId, tagId],
    );
    if (tagged.rows[0]) return tagged.rows[0].id;

    // In the workspace's system space (migration 096): no members, so no note
    // surface serves the settings or their secrets.
    await q(
      `INSERT INTO spaces (id, workspace_id, name, kind, capabilities)
       SELECT $2, $1, 'system', 'system', '{"publish": false, "external_ai": false, "backup": false, "shared_seen": false}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM spaces WHERE workspace_id = $1 AND kind = 'system' AND deleted_at IS NULL)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, await newIdFor("spaces", derivedIdName.systemSpace(workspaceId))],
    );
    const { id: spaceId } = await db.selectFrom("spaces").select("id")
      .where("workspace_id", "=", workspaceId).where("kind", "=", "system").where("deleted_at", "is", null)
      .limit(1).executeTakeFirstOrThrow();
    const nodeId = await newIdFor("content_nodes", derivedIdName.siteConfigNote(workspaceId));
    await mutate({
      actor, workspaceId, authority: { kind: "cascade" },
      event: {
        type: "NODE_CREATED", targetType: "node", targetId: nodeId,
        payload: { title: "Site Config", space_id: spaceId },
        txMeta: { ui_context: "site-config.ensure" },
      },
      apply: async () => {
        await q(
          `INSERT INTO content_nodes
             (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, space_id)
           VALUES ($1, $2, 'system', 'content', 'Site Config', '_workspace_config', '', true, $3)`,
          [nodeId, workspaceId, spaceId],
        );
        await q(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [nodeId, tagId]);
      },
    });
    return nodeId;
  });
}

// ── Site config: read / patch ────────────────────────────────────────────────

/** Read all site-config attributes for the workspace ({} before the first change). */
export async function getSiteConfig(workspaceId: string): Promise<SiteConfig> {
  const nodeId = await readConfigNodeId(workspaceId);
  return nodeId ? siteConfigAt(nodeId) : {};
}

/** The site config stored on config node `nodeId` (from readConfigNodeId / ensureConfigNodeId).
 *  Reads only, so it runs inside a read-only snapshot; readConfigNodeId may
 *  write (adopt the tag) and must run before one. */
export async function siteConfigAt(nodeId: string): Promise<SiteConfig> {
  const attrs = await q<{ key: string; value: string; value_type: string }>(
    `SELECT key, value, value_type FROM node_attributes WHERE node_id = $1`,
    [nodeId],
  );
  const cfg: SiteConfig = {};
  for (const row of attrs.rows) {
    cfg[row.key] = parseValue(row.value, row.value_type);
  }
  return cfg;
}

/** Upsert one or more site-config attributes. Empty values are deleted. Runs
 *  inside SITE_CONFIG_UPDATED's mutate() (refuses outside a transaction). */
export async function patchSiteConfig(
  workspaceId: string,
  patch: Record<string, unknown>,
  actor: ActorCtx,
): Promise<SiteConfig> {
  requireTransaction("patchSiteConfig");
  const nodeId = await ensureConfigNodeId(workspaceId, actor);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") {
      await q(`DELETE FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key]);
      continue;
    }
    await q(
      `INSERT INTO node_attributes
         (workspace_id, node_id, key, value, value_type, source)
       VALUES ($1, $2, $3, $4, $5, 'ui')
       ON CONFLICT (node_id, key) DO UPDATE
         SET value = EXCLUDED.value, value_type = EXCLUDED.value_type, source = EXCLUDED.source`,
      [workspaceId, nodeId, key, serializeValue(value), inferFromValue(value)],
    );
    // An uploaded logo or favicon belongs to the config note
    // (services/mediaOwners.ts), not to a note that pastes its URL later.
    await claimUploadedMedia(workspaceId, nodeId, serializeValue(value));
  }

  return getSiteConfig(workspaceId);
}

// ── Chrome blocks (header/footer/nav) stored in node.presentation jsonb ─────

export async function getChromeBlocks(workspaceId: string): Promise<unknown> {
  const nodeId = await readConfigNodeId(workspaceId);
  return nodeId ? chromeBlocksAt(nodeId) : null;
}

/** The chrome blocks on config node `nodeId`; reads only (see siteConfigAt). */
export async function chromeBlocksAt(nodeId: string): Promise<unknown> {
  const res = await q<{ presentation: unknown }>(
    `SELECT presentation FROM content_nodes WHERE id = $1 AND ${liveNodeSql()}`,
    [nodeId],
  );
  return res.rows[0]?.presentation ?? null;
}

/** The revision of a stored chrome (`rev`), or null for none (no chrome, or
 *  one saved before revisions). Every chrome write stores a new one. */
export function chromeRevision(presentation: unknown): string | null {
  const rev = presentation && typeof presentation === "object" ? (presentation as { rev?: unknown }).rev : undefined;
  return typeof rev === "string" && rev ? rev : null;
}

/** A chrome save started from a revision that is no longer the stored one:
 *  another tab or device saved the design since (D119). */
export class ChromeStale extends CodedStatusError {
  constructor() { super(409, "design_stale", "The site design changed in another tab or on another device. The latest design is shown; your last change was not saved."); this.name = "ChromeStale"; }
}

/** A chrome of the site design (@onden/site SiteDesign, v3; a v2 one is moved to v3 here): cleaned by
 *  validateDesign on write, so what is stored always satisfies the box rules
 *  and the nesting rules of the old home page. `studio_draft` and `rev` stay as the writer sent
 *  them. A chrome without `v: 2` or `v: 3` is stored as sent and never rendered
 *  (modules/website/publishing/frozenDesign.ts savedDesign). */
export function cleanedChrome(presentation: unknown): unknown {
  const version = presentation && typeof presentation === "object" ? (presentation as { v?: unknown }).v : undefined;
  if (version !== 2 && version !== 3) return presentation;
  const { design } = validateDesign(presentation);
  const { studio_draft: _draft, ...rest } = design;
  return (presentation as { studio_draft?: unknown }).studio_draft === true ? design : rest;
}

/** Replace the chrome. `base` (optional): the revision the change started
 *  from; when the stored chrome has another one the write is refused
 *  (ChromeStale) instead of replacing a newer design with an older copy.
 *  The stored chrome always gets a revision: the writer's own `rev` when it
 *  sent a new one (so its next save can name it as the base before the reply
 *  arrives), else a fresh one. The same guarded save sent twice (its `rev`
 *  already stored) is not stale and keeps that revision; an unguarded write
 *  that copies the stored `rev` gets a fresh one, so tabs holding the old
 *  revision are refused. Run inside the change's transaction: the config row
 *  is locked from the check to the write. */
export async function setChromeBlocks(
  workspaceId: string,
  presentation: unknown,
  actor: ActorCtx,
  { base }: { base?: string | null } = {},
): Promise<void> {
  requireTransaction("setChromeBlocks");
  const nodeId = await ensureConfigNodeId(workspaceId, actor);
  const locked = await q<{ presentation: unknown }>(
    `SELECT presentation FROM content_nodes WHERE id = $1 FOR UPDATE`,
    [nodeId],
  );
  const current = chromeRevision(locked.rows[0]?.presentation);
  const sent = chromeRevision(presentation);
  if (base !== undefined && base !== current && (sent === null || sent !== current)) throw new ChromeStale();
  const cleaned = cleanedChrome(presentation);
  const stored = cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
    ? { ...cleaned as Record<string, unknown>, rev: sent !== null && (sent !== current || base !== undefined) ? sent : randomUUID() }
    : presentation;
  await q(
    `UPDATE content_nodes SET presentation = $1::jsonb, updated_at = now() WHERE id = $2`,
    [stored == null ? null : JSON.stringify(stored), nodeId],
  );
  await claimUploadedMedia(workspaceId, nodeId, presentationText(stored));
}
