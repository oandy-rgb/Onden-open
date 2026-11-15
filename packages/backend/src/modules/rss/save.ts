// Saving a staged article as a note (POST /api/rss/items/:id/save, moved
// from routes.ts, depth audit D13). The note goes where the person chose (a
// destination: tags + an optional parent note) or, when they just tap 存, to
// the source's save default (destination.ts), with the article's identity
// attributes and the staging row linked to it — one event transaction, so two
// saves of the same article make one note, and an offline replay re-links
// rather than doubles. An article whose saved note is in the trash gets that
// note back when saved again (one note per article, never two).

import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { attachTagInTx } from "../../services/tagMembershipWrites.js";
import { createNote, NoteCreateError } from "../../services/noteCreate.js";
import { recordAttributeChange } from "../../services/attributeChange.js";
import { PERSON_SOURCE } from "../../spine/attributeSource.js";
import { mutatePersonal } from "../../spine/mutate.js";
import { assertAuthority, AuthorityError } from "../../spine/authority.js";
import { ScopeError } from "../../spine/toolScope.js";
import { K, findSource } from "./sources.js";
import { assertDestination, saveDefaults, DestinationError, type Destination } from "./destination.js";
import { htmlToMarkdown } from "./htmlToMarkdown.js";
import { markSeen, linkSavedNote } from "./staging.js";
import { canReadRetainedNode, readableAmong } from "../../services/readPolicy.js";
import { undeleteNode } from "../../services/nodeTrash.js";
import { gateItem, LIVE_SAVED_SQL } from "./items.js";
import { clampNoteTitle, noteSizeProblem } from "@onden/markdown";

/** Save staging item `id` as a note (`requestedNodeId`: a client-minted id,
 *  for an offline replay) at `destination`, or at the source's save default
 *  when it is left out. A chosen destination is checked first (422
 *  unknown_tag / parent_not_found / parent_not_a_note) and every chosen tag
 *  must be one the person may apply (403 otherwise); a default tag they may
 *  not apply is skipped instead, as source tags always were. Answers the
 *  status and body to send: 201 created (with where it went), 200 already
 *  saved (with its note), 200 `restored` (its note was in the trash and came
 *  back; the requested id is not used), 404 / 410 for the item, its subscription or a parent
 *  they cannot write under, 409 when the requested id is another note's,
 *  413 `too_large` when the article is over the note body cap
 *  (services/noteSize.ts; never cut). A feed title over the note title cap
 *  is cut (`title_truncated`). */
export async function saveItem(
  actor: ActorCtx, workspaceId: string, id: string, requestedNodeId: string | undefined,
  destination?: Destination,
): Promise<{ status: 200 | 201 | 404 | 409 | 410 | 413 | 422; body: Record<string, unknown> }> {
  const gated = await gateItem(actor, workspaceId, id);
  if (!gated.ok) return { status: gated.status, body: { error: gated.error } };
  const row = gated.row;
  if (row.saved_node_id) return { status: 200, body: { id: row.id, node_id: row.saved_node_id, already_saved: true } };
  const nodeId = requestedNodeId ?? randomUUID();
  const markdown = htmlToMarkdown(row.body ?? "", row.url);
  if (noteSizeProblem({ markdown }) === "too_large") return { status: 413, body: { error: "too_large", detail: "article exceeds the note size limit" } };
  const title = clampNoteTitle(row.title);
  const applied: string[] = [];

  const source = await findSource(workspaceId, { id: row.subscription_id });
  const chosen = destination !== undefined;
  if (destination) {
    try {
      await assertDestination(workspaceId, destination);
    } catch (error) {
      if (error instanceof DestinationError) return { status: 422, body: { error: error.code, detail: error.message } };
      throw error;
    }
  }
  const dest: Destination = destination
    ?? (source ? (await saveDefaults(actor, workspaceId, [source])).get(source.id)! : { tagIds: [], parentId: null });
  const tagIds = [...new Set(dest.tagIds)];

  // services/noteCreate.ts checks the parent is readable and writable for the
  // current actor, under the event lock together with the create.
  try {
    const outcome = await mutatePersonal({ actor, workspaceId, apply: async ({ actor }) => { // the actor re-read under the lock
      // Under the event lock: a concurrent save of this article has committed
      // or waits, so two saves make one note.
      const current = (await q<{ saved_node_id: string | null }>(
        `SELECT ${LIVE_SAVED_SQL} AS saved_node_id FROM rss_staging WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [id, workspaceId],
      )).rows[0];
      // Someone else's private save is not this reader's: they get a note of their own.
      if (current?.saved_node_id && (await readableAmong(actor, workspaceId, [current.saved_node_id])).has(current.saved_node_id)) return { already: current.saved_node_id };
      // One note per article: when the article's saved note is in the trash, saving again
      // brings that note back (the undo path, same id and body) instead of making a second one.
      // A note this reader cannot read is not theirs to restore: they get a note of their own.
      const trashed = (await q<{ saved_node_id: string | null }>(
        `SELECT s.saved_node_id FROM rss_staging s JOIN content_nodes n ON n.id = s.saved_node_id
          WHERE s.id = $1 AND s.workspace_id = $2 AND n.deleted_at IS NOT NULL`,
        [id, workspaceId],
      )).rows[0]?.saved_node_id;
      if (trashed && await canReadRetainedNode(actor, trashed)) {
        await undeleteNode(actor, workspaceId, trashed, { uiContext: "rss.save" });
        await markSeen([id], actor.id, true);
        return { restored: trashed };
      }
      // Offline-drain replay: the note may exist from an attempt that died
      // between the create and the response. Re-link only the note that IS this
      // article's save (same guid and source); any other note's id is refused.
      const existing = (await q<{ ws: string; trashed: boolean; guid: string | null; src: string | null }>(
        `SELECT n.workspace_id::text AS ws, n.deleted_at IS NOT NULL AS trashed,
                (SELECT value FROM node_attributes WHERE node_id = n.id AND key = $2) AS guid,
                (SELECT value FROM node_attributes WHERE node_id = n.id AND key = $3) AS src
           FROM content_nodes n WHERE n.id = $1`,
        [nodeId, K.guid, K.source],
      )).rows[0];
      if (existing) {
        // A live note that is this article's save: re-link. Anything else
        // (another note, another workspace, or this save already in the
        // trash) keeps its id: the client must mint a new one.
        if (existing.ws !== workspaceId || existing.trashed
          || existing.guid !== row.guid || existing.src !== row.subscription_id) return { conflict: true as const };
        await linkSavedNote(id, workspaceId, nodeId);
        await markSeen([id], actor.id, true);
        return { already: nodeId };
      }
      await createNote({
        actor, workspaceId, id: nodeId, title, markdown,
        sourceType: "rss", parentId: dest.parentId,
        event: {
          uiContext: "rss.save",
          payload: {
            subscription_id: row.subscription_id, rss_url: row.url, rss_guid: row.guid,
            destination: { tag_ids: tagIds, parent_id: dest.parentId, chosen },
          },
        },
        // Embed at save, not at ingest, and only when the feed asks: compute
        // belongs to what you CHOSE.
        index: source?.embed === true,
        within: async ({ nodeId: savedId, eventId, current }) => {
          const attrs: Array<[string, string]> = [
            [K.guid, row.guid],
            [K.source, row.subscription_id],
          ];
          if (row.url) attrs.push([K.itemUrl, row.url]);
          if (row.published_at) attrs.push([K.publishedAt, new Date(row.published_at).toISOString()]);
          for (const [key, value] of attrs) {
            await recordAttributeChange({
              workspaceId, nodeId: savedId, key, actor, next: { value, source: PERSON_SOURCE }, rule: "always",
              authority: { kind: "cascade" }, uiContext: "rss.save",
            });
          }
          for (const tagId of tagIds) {
            // A chosen tag must be one this reader may apply (the refusal fails
            // the save); a default tag they may not apply is skipped instead.
            try {
              await assertAuthority(current, { kind: "tag_membership", nodeId: savedId, tagId, op: "apply" });
            } catch (error) {
              if (!chosen && (error instanceof AuthorityError || error instanceof ScopeError)) continue;
              throw error;
            }
            await attachTagInTx({ workspaceId, nodeId: savedId, tagId, actor, causeEventId: eventId });
            applied.push(tagId);
          }
          // The staging row becomes the save's tombstone-with-a-pointer.
          await linkSavedNote(id, workspaceId, savedId);
          await markSeen([id], actor.id, true);
        },
      });
      return { created: true as const };
    } });
    if ("conflict" in outcome) return { status: 409, body: { error: "node id is taken; mint a new one" } };
    if ("restored" in outcome) return { status: 200, body: { id: row.id, node_id: outcome.restored, restored: true } };
    if ("already" in outcome) return { status: 200, body: { id: row.id, node_id: outcome.already, already_saved: true } };
  } catch (error) {
    if (error instanceof NoteCreateError) return { status: 404, body: { error: "parent note not found" } };
    throw error;
  }
  return { status: 201, body: { id: row.id, node_id: nodeId, parent_id: dest.parentId, tag_ids: applied, ...(title !== row.title ? { title_truncated: true } : {}) } };
}
