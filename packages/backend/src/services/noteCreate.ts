// Creating a note — the one place that owns it.
//
// Every path that makes a user note (the editor, the agent tool, bookmarks,
// canvases, RSS, Markdown import, collection rows) goes through
// createNote, so a new note always:
//   * lands where docs/architecture/spaces.md says ("新內容落在哪個空間",
//     newNoteSpace) and only where the creator may write;
//   * sits under a parent only the creator may read and write;
//   * gets a slug that is free in its space, picked under the event lock and
//     retried when a concurrent create took it;
//   * under a note kept off the site (「不發布」) starts kept off too (siteDefault.ts);
//   * carries the derived state the next edit would give it (inline and
//     frontmatter attributes, wikilinks both ways, block ids, backup, module
//     content hooks such as the search embedding).
// Before this module each path copied a different subset: only the editor and
// the agent tool asked newNoteSpace (the others relied on the database trigger
// that files a root note in the creator's personal space, with no write check
// and no way to name a space), and a bookmark, canvas, feed, collection row or
// imported folder got no backup, no embedding and no derived attributes.
//
// System rows (tags, the site config, task rows) are not notes and keep
// their own inserts; noteCreate.test.ts lists them.

import { withViews } from "./functionRefs.js";
import type { ServerNodeRow } from "@onden/contract";
import { assertParentKind } from "./parentKind.js";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { appendOrderKey, assertOrderKey, respaceIfTooLong, translateLegacySortOrder } from "./orderKeys.js";
import { normalizeText, slugify } from "@onden/markdown";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority, type Authority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { putBlob } from "./blobs.js";
import { uniqueSlug, retryOnSlugConflict, syncAttributesAndDispatch, syncFrontmatterAttributes } from "./nodes.js";
import { finishNewNote } from "./newNoteDerived.js";
import type { AdoptAnchor } from "./blockAnchors/index.js";
import { applyChildPrefixAttributes } from "./childAttributes.js";
import { applyParentSiteDefault } from "./siteDefault.js";
import { applyTagToNode, TagMembershipError } from "./tagMembershipWrites.js";
import { setNodeAttribute, type AttributeInput } from "./attributeWrites.js";
import { canPlaceUnder } from "./nodePlacement.js";
import { newNoteSpace } from "./spaces.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { assertNoteSize } from "./noteSize.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

/** The parent is gone or unreadable for the creator. Answers 404 at the
 *  HTTP boundary: never reveals whether the parent exists. (A readable parent
 *  the creator may not write raises AuthorityError, 403.) */
export class NoteCreateError extends Error {
  readonly status = 404 as const;
  constructor(message = "parent not found") { super(message); }
}

/** True iff `error` is a create refused because its client-minted id is
 *  already a note (the primary key): a replay after its Idempotency-Key was
 *  pruned, or a deterministic id (today's note, frontend lib/data/dayNotes.ts)
 *  whose note already exists, perhaps in the trash. Not a server fault: the
 *  note create route answers 409 note_exists so the client opens that note
 *  instead of retrying the create. */
export function isNoteIdTaken(error: unknown): boolean {
  const err = error as { code?: string; constraint?: string } | null;
  return err?.code === "23505" && err?.constraint === "content_nodes_pkey";
}

export type NewNote = {
  actor: ActorCtx;
  workspaceId: string;
  /** A client-minted id (offline replay); a fresh one otherwise. */
  id?: string;
  title: string;
  markdown?: string;
  nodeType?: "content" | "canvas";
  /** Provenance column: "manual" (default), "ai", "rss". */
  sourceType?: string;
  /** Under this note (its space), or under a tag / at the top level. */
  parentId?: string | null;
  /** The space for a note not under a note; default the creator's personal
   *  space (newNoteSpace). */
  spaceId?: string | null;
  hidden?: boolean;
  /** Where among its siblings: a key between its neighbours' keys. Default: last. */
  orderKey?: string;
  /** LEGACY integer from an older client (translated, services/orderKeys.ts). `orderKey` wins when both are given. */
  legacySortOrder?: number;
  /** A fixed slug instead of one from the title (a canvas: canvas-<id>). */
  slug?: string;
  /** The slug the note had (a restore): used when free in its space, else the
   *  usual suffix (`-2`) follows it, as for a slug made from a title. */
  preferredSlug?: string;
  /** How the creation is recorded. NODE_CREATED unless a caller kept its own
   *  history type; payload fields are added to { title, body_hash }. */
  event: {
    type?: "NODE_CREATED" | "BOOKMARK_CREATED" | "CANVAS_CREATED";
    targetType?: "node" | "canvas";
    uiContext: string;
    payload?: Record<string, unknown>;
    txMeta?: Record<string, unknown>;
  };
  /** Checked on top of the space write (the agent's tag-scoped create). */
  authority?: Authority;
  /** Tags applied right after the note, each its own TAG_APPLIED (chained to
   *  NODE_CREATED) under the same tag-apply policy as the tag endpoint; a
   *  refusal fails the create. */
  tagIds?: string[];
  /** Attributes set right after the tags (validated against their schema
   *  fields); modules hear about each once the root transaction commits. */
  attributes?: AttributeInput[];
  /** Run the module content hooks (search embedding, media ownership).
   *  Default true; an RSS save embeds only when its feed asks. */
  index?: boolean;
  /** The caller's own rows, written in the NODE_CREATED transaction before
   *  the derived state (module attributes, an import stamp, a staging
   *  pointer). `current` is the creator re-read under the event lock. */
  within?: (ctx: { nodeId: string; eventId: string; current: ActorCtx }) => Promise<void>;
  /** Rows that must see the finished note, derived state included (an
   *  import's baseline hash), in the same transaction. */
  afterDerived?: (ctx: { nodeId: string; eventId: string }) => Promise<void>;
  /** Anchors the new note's blocks take with ids already promised (an import keeping a vault's `^id`s). */
  adoptAnchors?: AdoptAnchor[];
  /** Give the note the site default of its parent (siteDefault.ts). Default true; false for a note that is
   *  reconstructed, not new (a restored backup, a projection of another device's note): what it carries is
   *  written by that path, and its place on the site must not be re-judged. */
  siteDefault?: boolean;
  /** Run the placement, space and tag-apply checks and pick the slug, then
   *  stop: nothing is written (attribute values are checked only on write). */
  dryRun?: boolean;
};

export type CreatedNote = { node: ServerNodeRow; eventId: string };
/** What a dry run reports: where the note would land, nothing was written. */
export type DryRunNote = { node: Pick<ServerNodeRow, "id" | "slug" | "title">; eventId: "(dry-run)" };

/** Create one note (see the module comment for what that guarantees). Joins
 *  the caller's transaction when there is one, so the caller's later writes
 *  commit with it. Throws NoteCreateError for an unavailable parent,
 *  AuthorityError when the creator may not write where it would land and
 *  NoteSizeError for a note over a size cap (a derived title is the caller's
 *  to shorten: clampNoteTitle).
 *  Example: createNote({ actor, workspaceId, title: "Plan", markdown: "",
 *    event: { uiContext: "node.create" } }). */
/** The key a new note takes under `parentId`: the one the caller chose, an older client's integer translated, or last. */
async function newNoteOrderKey(workspaceId: string, parentId: string | null, id: string, input: Pick<NewNote, "orderKey" | "legacySortOrder">): Promise<string> {
  if (input.orderKey !== undefined) { assertOrderKey(input.orderKey); return input.orderKey; }
  if (input.legacySortOrder !== undefined) return translateLegacySortOrder("content_nodes", workspaceId, parentId, id, input.legacySortOrder);
  return appendOrderKey("content_nodes", workspaceId, parentId);
}

export async function createNote(input: NewNote & { dryRun: true }): Promise<DryRunNote>;
export async function createNote(input: NewNote & { dryRun?: false }): Promise<CreatedNote>;
export async function createNote(input: NewNote): Promise<CreatedNote | DryRunNote>;
export async function createNote(input: NewNote): Promise<CreatedNote | DryRunNote> {
  const { actor, workspaceId } = input;
  const id = input.id ?? randomUUID();
  // Titles are stored in NFC (D58), so a title from a macOS zip (NFD) and a
  // [[link]] typed elsewhere name the same note.
  const title = normalizeText(input.title);
  // A client-minted id can arrive with parent_id === id: a self-parent row
  // satisfies its own FK and makes a cycle.
  const parentId = input.parentId && input.parentId !== id ? input.parentId : null;
  // The caps REST holds every note to (services/noteSize.ts): refused before
  // anything is written.
  assertNoteSize({ title: input.title, markdown: input.markdown });
  const markdown = input.markdown ?? "";
  // A dry run writes nothing, not even the content-addressed blob.
  const bodyHash = input.dryRun ? "" : await putBlob(markdown);
  const event = input.event;
  const created = await retryOnSlugConflict(() => withEventTransaction(workspaceId, async () => {
    const current = await resolveCurrentActor(actor, workspaceId);
    if (parentId && !(await canPlaceUnder(current, workspaceId, parentId))) throw new NoteCreateError();
    // A note or board is never placed under a tag (services/parentKind.ts).
    await assertParentKind(workspaceId, input.nodeType ?? "content", parentId);
    const spaceId = await newNoteSpace(current, workspaceId, { parentId, spaceId: input.spaceId });
    const slug = input.slug ?? await uniqueSlug(
      workspaceId, input.preferredSlug || slugify(title),
      spaceId ? { spaceId } : { parentId },
    );
    if (input.dryRun) {
      // The note does not exist, so the two-sided membership check cannot run;
      // the tag side can (a live tag the creator may apply), and the note side
      // is the space write newNoteSpace just checked.
      for (const tagId of input.tagIds ?? []) {
        const tag = await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND workspace_id = $2
          AND ${liveTagNodeSql()}`, [tagId, workspaceId]);
        if (!tag.rows.length) throw new TagMembershipError("tag not found");
        await assertAuthority(current, { kind: "tag", tagId, op: "apply" });
      }
      return { node: { id, slug, title }, eventId: "(dry-run)" as const };
    }
    const result = await mutate<CreatedNote>({
      actor,
      workspaceId,
      authority: input.authority ?? { kind: "any_space_write" },
      event: {
        type: event.type ?? "NODE_CREATED",
        targetType: event.targetType ?? "node",
        targetId: id,
        payload: { title, body_hash: bodyHash, ...event.payload },
        txMeta: { inverse_op: "node.deleted", ui_context: event.uiContext, ...event.txMeta },
      },
      apply: async ({ eventId }) => {
        const orderKey = await newNoteOrderKey(workspaceId, parentId, id, input);
        const node = (await q<ServerNodeRow>(
          `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, order_key, space_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [id, workspaceId, input.sourceType ?? "manual", input.nodeType ?? "content", title, slug, markdown,
            parentId, input.hidden ?? false, orderKey, spaceId],
        )).rows[0]!;
        await respaceIfTooLong("content_nodes", workspaceId, parentId, orderKey, { actor, nodeId: id });
        if (parentId) {
          await applyChildPrefixAttributes(workspaceId, parentId, id, actor);
          if (input.siteDefault !== false) await applyParentSiteDefault(workspaceId, parentId, id, actor, eventId);
        }
        await input.within?.({ nodeId: id, eventId, current });
        // The derived state an edit would give the same text. Every helper
        // threads eventId, so what it records chains to this NODE_CREATED.
        await syncAttributesAndDispatch(workspaceId, id, markdown, actor, eventId);
        await syncFrontmatterAttributes(workspaceId, id, markdown, actor, eventId);
        await finishNewNote({ workspaceId, nodeId: id, title, slug, markdown }, { eventId, actor, index: input.index, adoptAnchors: input.adoptAnchors });
        await input.afterDerived?.({ nodeId: id, eventId });
        // After the derived state, so a whiteboard tab written by `within` is in the row.
        return { node: await withViews(workspaceId, node), eventId };
      },
    });
    // Each TAG_APPLIED chains to the NODE_CREATED: rejecting or undoing the
    // create (inbox, eventRestore cascade) reverts the tags it came with.
    for (const tagId of input.tagIds ?? []) {
      await applyTagToNode({ workspaceId, actor, nodeId: id, tagId, causeEventId: result.eventId });
    }
    for (const attribute of input.attributes ?? []) await setNodeAttribute({ workspaceId, actor, nodeId: id, attribute });
    return result;
  }));
  return created;
}
