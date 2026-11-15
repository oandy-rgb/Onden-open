// Who may read an uploaded media file. It sits above both the read policy and
// the publishing code: an anonymous reader may see a file only where the
// served site shows it, and the site in turn asks the read policy which notes
// are public. Keeping this gate out of readPolicy.ts keeps that one-way.

import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { publicSite } from "./publicSite.js";
import { mediaReferences, mediaUpload } from "./mediaOwners.js";
import { canReadNode, canReadRetainedNode } from "./readPolicy.js";

// Read gate for a media asset served by GET /api/media/:filename. Media files
// have no DB record of their own — they are referenced from node markdown as
// `/api/media/<filename>`, so an asset's "owner" is the set of nodes that embed
// it. An asset is readable iff the caller can read AT LEAST ONE referencing node
// (mirrors how the same image is visible wherever it's embedded). Two carve-outs
// keep current behaviour intact:
//   • UNATTACHED assets (no node references them — e.g. a just-uploaded image not
//     yet saved into a body) require an authenticated actor for upload preview.
//   • An ANONYMOUS caller (actor === null, the public-site path) is allowed iff a
//     referencing node shows the file on the served site — the latest snapshot
//     minus takedowns (servedSite.servedSiteShowsMedia: published notes,
//     published collection items, the site-config node). Being readable by a
//     viewer is not publication — an unpublished note's image was anonymously
//     readable until GAP-236; nor is being marked for publishing (W38a).
//   • A SIGNED-IN caller sees at least what an anonymous one does (D107): one
//     who cannot read the owning note (not in its space) still reads a file
//     the served site shows, so a member who opens the public site is not
//     refused the images a logged-out visitor gets.
// Without this, GET /api/media/* served attachments of read-restricted nodes to
// anyone, bypassing the per-node read gate every other node endpoint enforces.
export async function canReadMedia(
  actor: ActorCtx | null,
  filename: string,
  workspaceId: string,
  /** Judge the public-site rule against this site payload instead of the
   *  served snapshot (the publish preview asks "public after this publish?"). */
  opts: { site?: Record<string, unknown> } = {},
): Promise<boolean> {
  // A claimed upload belongs to the first note saved with it
  // (services/mediaOwners.ts): that note decides, whoever has referenced the
  // file since — pasting a seen URL into another note grants nothing. Anonymous
  // readers need that note on the public site; its uploader may always read it.
  // (siteShowsMedia asks mediaOwners.anonymousMediaOwners, the same rule.)
  const onSite = () => publicSite().showsMedia(workspaceId, filename, opts.site);
  const upload = await mediaUpload(workspaceId, filename);
  if (upload?.nodeId) {
    if (actor === null) return onSite();
    return upload.uploader === actor.id || (await canReadRetainedNode(actor, upload.nodeId)) || onSite();
  }
  // An upload no note claimed is attached to none. Every save that references
  // a file claims it — body, attribute or presentation (D56) — and migrations
  // 095 and 107 claimed the files referenced before that, so what is left is
  // a fresh upload not saved into a note yet, or one whose owning note was
  // deleted for good. Its uploader alone may read it. Deliberately not the
  // oldest-reference rule below: a reference anyone adds to an older note of
  // their own would hand them, and that note's whole space, the file.
  if (upload) return actor !== null && upload.uploader === actor.id;
  // Files with no upload record — imported ones (imported_media: one copy per
  // content, shared by every note that imported it) and files from before
  // media_uploads (migration 090) — have no owner row: the rules below.

  // Nodes that reference this asset — from BOTH rails it can be embedded on:
  //   • a node's markdown body (`![](…/api/media/<file>…)`), and
  //   • a node ATTRIBUTE value (collection cover image, a media-type custom
  //     field) — stored in node_attributes, never in markdown, and
  //   • a node's `presentation` (Website-studio page designs and the
  //     site-config node's chrome blocks, e.g. a hero image).
  // A markdown-only lookup would treat attribute-embedded assets as unattached,
  // bypassing their node policy for authenticated callers in the workspace.
  // The `/api/media/` prefix (mediaUrl, the one media grammar) keeps the
  // lookup from matching an unrelated string that merely contains the filename.
  // Authorization needs a literal substring search, not the text-search index.
  // PGroonga's ILIKE index scan can omit punctuation-heavy media URLs that a
  // sequential scan matches, incorrectly turning a restricted asset into an
  // unattached one. strpos(lower(...)) preserves case-insensitive containment
  // without delegating this ownership check to a full-text operator class.
  //
  // Which reference decides (phase 0 of docs/architecture/spaces.md): the
  // OLDEST referencing node, live or trashed — for a file without an upload
  // record, the closest thing to the note it was attached to. "Any readable
  // reference" let anyone paste a URL they had once seen into their own note
  // and read the file forever. A trashed original still owns the
  // file, so trashing it cannot hand the file to a later paste. The cost: a
  // file deliberately embedded in two notes is readable through the first one
  // only, until spaces give media its own owner row.
  const refs = { rows: await mediaReferences(workspaceId, filename) };
  const live = refs.rows.filter((r) => !r.deleted);
  if (live.length === 0) {
    // Unattached / orphan: referenced by NO live node body and NO node attribute, so
    // it is on no published page either — the published site bundles its assets
    // at build time (modules/website/publishing/mediaBundle.ts rewrites /api/media/<f>
    // to a local copy) and never fetches this route anonymously; favicons/og
    // images live as site-config node ATTRIBUTES, so they resolve through the
    // attached branch below, not here. What is left is a fresh upload not yet
    // saved into a node, or a file whose every note is in the trash.
    if (actor === null) return false;
    // A trashed owner keeps the file: only those who could read it before.
    if (refs.rows.length > 0) return canReadRetainedNode(actor, refs.rows[0]!.id);
    // An imported file previews for its importer only; files from before
    // media_uploads existed keep the old "any signed-in member" rule.
    const owner = await q<{ uploader: string | null }>(
      `SELECT actor_id AS uploader FROM imported_media WHERE filename = $1 AND workspace_id = $2`,
      [filename, workspaceId],
    );
    if (owner.rows.length > 0) return owner.rows.some((r) => r.uploader === actor.id);
    // The file store is shared by every workspace and names a file by its content. A file another workspace
    // uploaded or imported is that workspace's: here it is not "from before media_uploads", so it is not readable
    // just because the caller is signed in and knows the name.
    return !(await heldByAnotherWorkspace(workspaceId, filename));
  }
  if (actor === null) return onSite();
  const first = refs.rows[0]!;
  return (first.deleted ? await canReadRetainedNode(actor, first.id) : await canReadNode(actor, first.id)) || onSite();
}

/** Whether a media record (upload or import) of another workspace names `filename`. */
async function heldByAnotherWorkspace(workspaceId: string, filename: string): Promise<boolean> {
  const upload = await db.selectFrom("media_uploads").select("filename")
    .where("filename", "=", filename).where("workspace_id", "!=", workspaceId).limit(1).executeTakeFirst();
  if (upload) return true;
  const imported = await db.selectFrom("imported_media").select("filename")
    .where("filename", "=", filename).where("workspace_id", "!=", workspaceId).limit(1).executeTakeFirst();
  return imported !== undefined;
}
