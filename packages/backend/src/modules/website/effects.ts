import { enqueueEffect, requireString, type OutboxEffect } from "../../services/outbox.js";
import { recordTakedowns } from "./publishing/takenDown.js";
import { performPagesPush, ensureSiteBundle, republishSite } from "./publishing/index.js";
import type { ActorCtx } from "../../types.js";

/** Deploy the static copy of the site (the zip's files) to the external
 *  host. Returns harmlessly when no host is configured; a throw retries. */
export const pagesPushEffect: OutboxEffect<{ workspaceId: string; snapshotId: string }> = {
  kind: "pages_push",
  // A large site's push takes minutes; a shorter limit would time out
  // every attempt (outbox.ts holds a timed-out row until its attempt settles).
  timeoutMs: 10 * 60_000,
  parse: (p) => ({ workspaceId: requireString(p, "workspaceId"), snapshotId: requireString(p, "snapshotId") }),
  perform: async (p) => { await performPagesPush(p); },
};

/** Make the stored static copy of the site as it is now (siteBundle.ts): the
 *  crawl, the search index, the atomic store. Queued with every pages_push, off
 *  the publish response; a failure (the frontend not up yet) retries. A copy
 *  that is already stored makes this a no-op. */
export const siteBundleEffect: OutboxEffect<{ workspaceId: string; snapshotId: string }> = {
  kind: "site_bundle",
  timeoutMs: 10 * 60_000, // crawls every page and indexes them
  parse: (p) => ({ workspaceId: requireString(p, "workspaceId"), snapshotId: requireString(p, "snapshotId") }),
  perform: async (p) => { await ensureSiteBundle({ workspaceId: p.workspaceId }); },
};

/** Take down from the static host what the workspace removed (republishSite:
 *  the latest snapshot pushed again, minus takedowns — no new snapshot, so
 *  nothing is added before the owner publishes); a site never published stays
 *  unpublished. Requested in the transaction of the change that may remove
 *  something from the site (requestSiteRebuild), so a crash after that commit
 *  cannot lose it; one pending rebuild per workspace takes a burst of changes. */
export const siteRebuildEffect: OutboxEffect<{ workspaceId: string; actorId: string; actorType: ActorCtx["type"] }> = {
  kind: "site_rebuild",
  timeoutMs: 60_000, // enqueues the push
  parse: (p) => ({
    workspaceId: requireString(p, "workspaceId"), actorId: requireString(p, "actorId"),
    actorType: p.actorType === "agent" ? "agent" : "human",
  }),
  perform: async (p) => { await republishSite(p.workspaceId, { id: p.actorId, type: p.actorType }); },
};

/** Call inside the writing transaction: the site rebuilds once it commits. */
export async function requestSiteRebuild(workspaceId: string, actor: ActorCtx): Promise<void> {
  // What this change took off the site is recorded now, in the same
  // transaction, so putting it back later cannot serve its old text (takenDown.ts).
  await recordTakedowns(workspaceId);
  await enqueueEffect({
    workspaceId, kind: "site_rebuild", dedupKey: `site_rebuild:${workspaceId}`,
    payload: { workspaceId, actorId: actor.id, actorType: actor.type },
  });
}
