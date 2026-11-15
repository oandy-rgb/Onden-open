// The publish preview (W38b, docs/architecture/site-render-model.md): the
// candidate snapshot a publish would store — built by the same buildCandidate
// — with what changes against the live site, the links that will read
// "(private)", the media readers won't get, and the candidate's hash. Publish
// sends the hash back; a candidate that changed since answers 409
// (PublishPreviewStale), so what the person confirmed is what goes out.
// Read-only: nothing is stored or pushed.

import { mediaRefs } from "@onden/markdown";
import { q } from "../../../db.js";
import { siteShowsMedia } from "./servedSite.js";
import { mediaFiles } from "../../../services/mediaFiles.js";
import { buildCandidate, candidateHash, type SnapshotOpts } from "./snapshot.js";
import { nodesOf, siteDiff, type SiteDiff } from "./siteDiff.js";
import { loadServedSite } from "./servedSite.js";
import { serveDrawingEmbeds } from "./drawingEmbeds.js";
import { serveHandwritingPages, storeHandwritingPages } from "./handwritingPages.js";
import { leftOutNotes } from "./publishedSet.js";
import { takenDownSinceLastPublish } from "./takenDown.js";
import { STATIC_VIDEO_MAX_BYTES, isVideoName } from "./videoLimit.js";
import type { LeftOutNote, PreviewNote, PublishPreview, ServedSite } from "@onden/contract";

/** A note in the last publish that this one drops. `taken_down`: readers already
 *  don't see it (unpublished, hidden or moved since — takedowns apply at once). */
type RemovedNote = PreviewNote & { taken_down: boolean };
type BlockedMedia = {
  filename: string;
  /** not_public: a reader of the site can't open it (its note isn't public); missing: no file on the server. */
  reason: "not_public" | "missing";
  /** Published notes that embed it (empty: it is in the site's design). */
  node_ids: string[];
};
/** A file readers can open after this publish that they could not before: a
 *  new logo, site icon, design image or note figure. `used_as` says where it
 *  shows; `node_ids` are the published notes that embed it. */
type NewMedia = {
  filename: string;
  used_as: "logo" | "favicon" | "other";
  node_ids: string[];
};
/** A video the external static host will not carry (videoLimit.ts): readers
 *  of that copy get a link to the original site instead. */
type LargeVideo = { filename: string; size_mb: number; node_ids: string[] };

export async function buildPublishPreview(workspaceId: string, opts: SnapshotOpts): Promise<PublishPreview> {
  const candidate = await buildCandidate(workspaceId, opts);
  const served = await loadServedSite(workspaceId);
  const published = served.id !== null; // no snapshot yet: nothing is live
  // Compared with what the last publish froze (readers see that minus any
  // takedown since). A snapshot from before W38a has no settings frozen in, so
  // its first publish since reports settings_changed — the settings it freezes.
  const stored = published
    ? (await q<{ title: string; payload: Record<string, unknown> }>(`SELECT title, payload FROM publish_snapshots WHERE id = $1`, [served.id])).rows[0] ?? null
    : null;
  const readerIds = new Set(published ? nodesOf(served.payload).map((n) => n.id) : []);
  const nextNodes = nodesOf(candidate.payload);
  const changes = siteDiff(stored, candidate);
  const takenDown = published ? await takenDownSinceLastPublish(workspaceId) : new Set<string>();
  const back = (n: PreviewNote) => takenDown.has(n.id);
  const stay = (list: PreviewNote[]) => list.filter((n) => !back(n));
  const diff: PublishPreview["diff"] = {
    ...changes,
    changed: stay(changes.changed), moved: stay(changes.moved), links_changed: stay(changes.links_changed),
    removed: changes.removed.map((n) => ({ ...n, taken_down: !readerIds.has(n.id) })),
    returning: nextNodes.filter((n) => takenDown.has(n.id)).map((n) => ({ id: n.id, title: n.title ?? "", slug: n.slug ?? "" })),
  };

  // Media the candidate embeds: anywhere in the payload (notes, design). The question is "can a reader open it AFTER this publish",
  // so the media rule (siteShowsMedia: mediaAccess.canReadMedia's anonymous branch) judges
  // the candidate instead of the served snapshot: a note published for the
  // first time, a new logo or a new design image becomes public with it.
  // Handwriting pages are drawn and stored here, not at publish (a large drawing
  // takes seconds): the preview names and shows the files a publish will use,
  // by address like any image. Their upload is the note's, so only those who
  // may read the note see them until the note is on the site.
  if (opts.actor) await storeHandwritingPages(workspaceId, candidate.handwritingPages, opts.actor.id);
  const filenames = mediaRefs(JSON.stringify(candidate.payload));
  const blocked_media: BlockedMedia[] = [];
  const new_media: NewMedia[] = [];
  const large_videos: LargeVideo[] = [];
  const liveFilenames = new Set(published && stored ? mediaRefs(JSON.stringify(stored.payload)).map((f) => f.toLowerCase()) : []);
  const site = ((candidate.payload.presentation as { site?: { logo?: unknown; favicon?: unknown } } | undefined)?.site) ?? {};
  const refersTo = (value: unknown, filename: string) => typeof value === "string" && mediaRefs(value).includes(filename);
  for (const filename of filenames) {
    const embeddedBy = nextNodes.filter((n) => n.markdown && mediaRefs(n.markdown).includes(filename)).map((n) => n.id);
    const stored = await mediaFiles().info(filename);
    const reason: BlockedMedia["reason"] | null = !stored ? "missing"
      : (await siteShowsMedia(workspaceId, filename, candidate.payload)) ? null : "not_public";
    if (!reason && isVideoName(filename)) {
      const bytes = stored!.size;
      if (bytes > STATIC_VIDEO_MAX_BYTES) large_videos.push({ filename, size_mb: Math.ceil(bytes / (1024 * 1024)), node_ids: embeddedBy });
    }
    if (reason) blocked_media.push({ filename, reason, node_ids: embeddedBy });
    else if (!liveFilenames.has(filename.toLowerCase())) {
      const used_as = refersTo(site.logo, filename) ? "logo" : refersTo(site.favicon, filename) ? "favicon" : "other";
      new_media.push({ filename, used_as, node_ids: embeddedBy });
    }
  }

  // Shown as readers will get it: embedded drawings as their pictures, as
  // the served site draws them (the hash above is of the candidate as stored).
  const shownNodes = structuredClone(nextNodes);
  serveDrawingEmbeds(shownNodes);
  serveHandwritingPages(shownNodes);

  return {
    hash: candidateHash(candidate),
    site: {
      id: null, title: candidate.title, home_node_id: candidate.homeNodeId, event_cursor: candidate.eventCursor,
      payload: { ...candidate.payload, nodes: shownNodes }, artifact_ref: served.artifact_ref, created_at: new Date().toISOString(),
    },
    live: published ? { snapshot_id: served.id!, published_at: new Date(served.created_at).toISOString() } : null,
    diff,
    private_links: candidate.privateLinks.map((l) => ({ node_id: l.nodeId, node_title: l.nodeTitle, target: l.target, shown_as: l.shownAs })),
    blocked_media,
    new_media,
    large_videos,
    left_out: await leftOutNotes(workspaceId, opts.actor ?? null),
    unpublished_refs: candidate.unpublishedRefs,
    diagrams_needed: candidate.diagramsNeeded,
  };
}
