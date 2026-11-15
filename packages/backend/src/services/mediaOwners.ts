// Which note owns an uploaded file (migrations 095 and 107). The first note
// saved with a reference to `/api/media/<file>` owns it, and canReadMedia
// (mediaAccess.ts) asks that note: a reference added later from another note
// never takes the file over, so pasting a URL one has seen elsewhere grants
// nothing.
//
// "Saved with a reference" is every place a note can hold one, and each write
// claims with the same function: its title or body (nodeCommits
// nodeContentCommitted), an attribute value (nodeCommits nodeAttributeCommitted;
// the site config's raw writes in siteConfig.ts) and its presentation
// (nodeUpdate.ts, siteConfig.ts setChromeBlocks, the undo of either). Before
// D56 only title and body claimed, so a cover uploaded into a media field of a
// private note stayed unclaimed until someone pasted its URL into a note of
// their own, whose save then claimed it for that note's whole space.

import { mediaRefs, mediaUrl } from "@onden/markdown";
import { q } from "../db.js";

/** Claim the not-yet-owned uploads that `text` references for note `nodeId`.
 *  Call inside the transaction that saved the text (the note's title and
 *  body, an attribute value, or presentationText of its presentation). */
export async function claimUploadedMedia(workspaceId: string, nodeId: string, text: string): Promise<void> {
  const files = mediaRefs(text);
  if (files.length === 0) return;
  await q(
    `UPDATE media_uploads SET node_id = $3
      WHERE workspace_id = $1 AND node_id IS NULL AND filename = ANY($2::text[])`,
    [workspaceId, files, nodeId],
  );
}

/** The strings in a stored presentation (any JSON), one per line, for
 *  claimUploadedMedia. Each string is read on its own: in the serialised JSON
 *  an escaped `\n` right before a URL would hide it from the reference
 *  grammar. */
export function presentationText(presentation: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(presentation);
  return out.join("\n");
}

/** The upload record of `filename`: who uploaded it and the note that owns
 *  it (null until one claims it); null for a file that was not uploaded
 *  through POST /api/media (an imported file, or one from before 090). */
export async function mediaUpload(workspaceId: string, filename: string): Promise<{ nodeId: string | null; uploader: string } | null> {
  const r = await q<{ node_id: string | null; uploader: string }>(
    `SELECT node_id::text, uploader_actor_id AS uploader FROM media_uploads
      WHERE workspace_id = $1 AND filename = $2`,
    [workspaceId, filename],
  );
  return r.rows[0] ? { nodeId: r.rows[0].node_id, uploader: r.rows[0].uploader } : null;
}

/** Every note that references `filename` — body, attribute or page design —
 *  live or trashed, oldest first (the oldest decides who may read an
 *  unclaimed file: services/mediaAccess.ts). */
export async function mediaReferences(workspaceId: string, filename: string): Promise<Array<{ id: string; deleted: boolean }>> {
  const refs = await q<{ id: string; deleted: boolean }>(
    `WITH refs AS (
       SELECT id FROM content_nodes
        WHERE workspace_id = $1
          AND markdown IS NOT NULL
          AND strpos(lower(markdown), lower($2)) > 0
       UNION
       SELECT n.id FROM node_attributes na
         JOIN content_nodes n ON n.id = na.node_id
        WHERE na.workspace_id = $1
          AND strpos(lower(na.value), lower($2)) > 0
       UNION
       SELECT id FROM content_nodes
        WHERE workspace_id = $1
          AND presentation IS NOT NULL
          AND strpos(lower(presentation::text), lower($2)) > 0
     )
     SELECT n.id, n.deleted_at IS NOT NULL AS deleted
       FROM refs JOIN content_nodes n ON n.id = refs.id
      ORDER BY n.created_at, n.id`,
    [workspaceId, mediaUrl(filename)],
  );
  return refs.rows;
}

/** The notes a site visitor's access to `filename` depends on, by the rule
 *  canReadMedia applies (services/mediaAccess.ts): an upload's claimed owner;
 *  none for an upload no note claimed (its uploader's alone); for a file with
 *  no upload record (imported, or from before 090), every live note that
 *  references it ([] when none does). */
export async function anonymousMediaOwners(workspaceId: string, filename: string): Promise<string[]> {
  const upload = await mediaUpload(workspaceId, filename);
  if (upload) return upload.nodeId ? [upload.nodeId] : [];
  return (await mediaReferences(workspaceId, filename)).filter((r) => !r.deleted).map((r) => r.id);
}

/** The space of the note that decides who reads `filename` (canReadMedia):
 *  an upload's claimed note, else the oldest note referencing the file, live
 *  or trashed. undefined when no note owns it yet. An import reuses an
 *  earlier copy only when this is the space its notes land in (D107). */
export async function mediaOwnerSpace(workspaceId: string, filename: string): Promise<string | null | undefined> {
  const upload = await mediaUpload(workspaceId, filename);
  const ownerId = upload ? upload.nodeId : (await mediaReferences(workspaceId, filename))[0]?.id;
  if (!ownerId) return undefined;
  const r = await q<{ space_id: string | null }>(
    `SELECT space_id::text FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, ownerId]);
  return r.rows[0]?.space_id ?? null;
}
