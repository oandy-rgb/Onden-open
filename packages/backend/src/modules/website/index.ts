import type { ModuleDefinition } from "../types.js";
import { q } from "../../db.js";
import type { AgentTool } from "../../services/agentTools/index.js";
import { PUBLISHED_KEY } from "../../services/systemAttributes.js";
import publishRouter from "./routes.js";
import { pagesPushEffect, siteBundleEffect, siteRebuildEffect, requestSiteRebuild } from "./effects.js";
import { scrubStoredSnapshot, siteShowsMedia, singleNoteExport } from "./publishing/index.js";
import { liveNodeSql, tagNodeSql } from "../../spine/nodeSql.js";

/** Whether any of these nodes may be something the site serves: a note in a
 *  space that publishes or one marked 「發布」 (publishing/publishedSet.ts), or
 *  a tag (it has a page of its own when shown). A note its own 「不發布」 or its
 *  source keeps off (a feed's saved article, unless marked 「發布」) is not: hiding
 *  or trashing it changes nothing the site shows. A blank note is NOT told apart
 *  here: its notes underneath may be trashed with it, and a missed takedown costs
 *  more than one extra push. Read in the writing transaction, so it sees the change. */
async function touchesSite(nodeIds: string[]): Promise<boolean> {
  const r = await q(
    `SELECT 1 FROM content_nodes n LEFT JOIN spaces s ON s.id = n.space_id
       LEFT JOIN node_attributes flag ON flag.node_id = n.id AND flag.key = $2
      WHERE n.id = ANY($1::uuid[])
        AND (flag.value = 'true'
             OR (s.capabilities->>'publish' = 'true' AND flag.value IS DISTINCT FROM 'false' AND n.source_type <> 'rss')
             OR ${tagNodeSql("n")})
      LIMIT 1`,
    [nodeIds, PUBLISHED_KEY],
  );
  return (r.rowCount ?? 0) > 0;
}

// The published website: the publish, site and export routes; the
// deploy effects (site_bundle, pages_push, site_rebuild); and the re-push when a note's 「發布／不發布」 changes, a published note
// is trashed or brought back, or a space move or publish switch changes which
// notes may be public, so the static copy drops a taken-down note now
// as /api/site already does. Nothing is ADDED before the next Publish: every
// surface serves the latest snapshot minus takedowns (servedSite.ts). The pages
// themselves are the frontend's; the static copy (modules/website/publishing/staticSite.ts)
// saves what it serves.
export const websiteModule: ModuleDefinition = {
  id: "website",
  registerRoutes: (app) => { app.route("/api", publishRouter); },
  outboxEffects: [pagesPushEffect, siteBundleEffect, siteRebuildEffect],
  publicSite: { showsMedia: siteShowsMedia, singleNoteExport },
  // Writes that put content out (publish, include, preview) answer 409 while the
  // module is off. Reads are never gated, so a live site keeps being served.
  // /api/site*, /api/snapshots and /api/export-static are reads and stay open.
  routePrefixes: ["/api/publish", "/api/preview"],
  // The hooks below only request a re-push of the latest snapshot minus takedowns
  // (republishSite adds nothing), so they also run with the module off: taking
  // content down must never depend on the switch.
  nodeHooksWhenOff: true,
  // ... and for a change taken from another node: a note unpublished, hidden or trashed there must leave this node's static copy too (a leak otherwise).
  nodeHooksOnReceive: true,
  // Each hook runs inside the writing transaction and only requests a
  // rebuild (an outbox intent that runs after commit, spine/nodeHooks.ts).
  nodeHooks: {
    // A note deleted for good leaves no title in any stored snapshot.
    snapshotPurged: scrubStoredSnapshot,
    // A note opted in or out changes what the site serves.
    attributeCommitted: async ({ workspaceId, key, actor }) => {
      if (key === PUBLISHED_KEY) await requestSiteRebuild(workspaceId, actor);
    },
    // A served note hidden or shown, a tag shown or hidden.
    visibilityCommitted: async ({ workspaceId, actor, nodeIds }) => {
      if (await touchesSite(nodeIds)) await requestSiteRebuild(workspaceId, actor);
    },
    spaceAudienceCommitted: async ({ workspaceId, actor }) => { await requestSiteRebuild(workspaceId, actor); },
    // A served note or a tag trashed or brought back.
    lifecycleCommitted: async ({ workspaceId, actor, nodeIds }) => {
      if (await touchesSite(nodeIds)) await requestSiteRebuild(workspaceId, actor);
    },
  },
  // In use once the site was published or a note is marked for publishing.
  // Publishes to the web: on only after the owner agrees once.
  library: { confirmOnce: true, inUse: async (workspaceId) => (await q(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM publish_snapshots WHERE workspace_id = $1)
                 OR EXISTS (SELECT 1 FROM node_attributes a JOIN content_nodes n ON n.id = a.node_id AND ${liveNodeSql("n")}
                             WHERE n.workspace_id = $1 AND a.key = $2 AND a.value = 'true')`, [workspaceId, PUBLISHED_KEY],
  )).rowCount! > 0 },
};
