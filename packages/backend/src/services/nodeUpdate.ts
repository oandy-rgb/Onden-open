import { withViews } from "./functionRefs.js";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { q, event } from "../db.js";
import { sqlIdentifier } from "../sqlText.js";
import type { ActorCtx } from "../types.js";
import type { DraftNode, ServerNodeRow } from "@onden/contract";
import { NODE_MARKDOWN_MAX, sha256Hex } from "../utils.js";
import { normalizeText, cutToUnits } from "@onden/markdown";
import { mutate } from "../spine/mutate.js";
import { assertAuthority } from "../spine/authority.js";
import { systemJobOf } from "../spine/systemJobs.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import { canReadNode } from "./readPolicy.js";
import { slugForTitle } from "./nodes.js";
import { makeInversePatch, mergeBody, bodyConflictPayload, type BodyConflict } from "./eventLog/index.js";
import { putBlob } from "./blobs.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { assertTagNameAvailable, assertTagNameShape } from "./tagHierarchy.js";
import { writeTagIdentity } from "./tagIdentity.js";
import { assertReparent, ReparentError } from "./nodeTree.js";
import { applyBodyChange } from "./bodySideEffects.js";
import type { EditorBodyChange } from "./blockAnchors/index.js";
import type { AdoptAnchor } from "./blockAnchors/index.js";
import { claimUploadedMedia, presentationText } from "./mediaOwners.js";
import { retypeGoverned } from "./attributeChange.js";
import { resolvePatched } from "./patchedValue.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

export class NodeUpdateError extends Error {
  /** `code`: the stable reason when the refusal came from a coded error (a move's
   *  ReparentError), so the client words it by code, not by this sentence. */
  constructor(message: string, public readonly status: 400 | 404 | 409 | 422, public readonly code?: string) {
    super(message);
    this.name = "NodeUpdateError";
  }
}

/** A save with `onConflict: "refuse"` found lines both writers changed since
 *  the base. Nothing was written; `conflicts` says which lines. */
export class BodyConflictError extends NodeUpdateError {
  constructor(public readonly conflicts: BodyConflict[]) {
    super("body_conflict", 409);
    this.name = "BodyConflictError";
  }
}

export type NodeChanges = Partial<z.infer<typeof DraftNode>>;
type StoredNode = Record<string, unknown> & {
  id: string; title: string; slug: string; markdown: string; node_type: string;
  parent_id: string | null; hidden: boolean; sort_order: number;
  presentation: Record<string, unknown> | null;
};

/** Edit exactly the supplied fields. Current policy, merge baseline, parent
 * validation and inverse history are evaluated after acquiring the event lock;
 * state, history, indexes and durable effect intents commit together.
 * baseMarkdown enables disjoint body merges; overlapping edits retain the
 * existing last-writer-wins + BODY_CONFLICT/version-history contract.
 * Ordinary edits cannot change a class tag's policy-bearing identity.
 * A class tag's new title is a tag rename (writeTagIdentity: TAG_UPDATED,
 * `tag-` slug, TagNameShapeError for a name that cannot be a tag).
 * Throws NodeUpdateError for missing/invalid targets, TagNameConflictError for
 * a currently occupied sibling tag name; authority and storage
 * errors propagate. A resolved root operation is committed; when joining an
 * outer transaction it remains subject to that owner's commit/rollback.
 * onConflict "refuse" (with baseMarkdown): lines both writers changed since
 * the base are not resolved either way: nothing is written and
 * BodyConflictError lists them (a person's accepted AI suggestion must never
 * overwrite what they wrote since: services/aiSuggestions.ts).
 * dryRun runs every check under the lock and returns the node as it would be
 * saved (eventId "(dry-run)"); it writes nothing and reserves nothing.
 * A caller saving on someone's behalf (an import update) names the event
 * (`event`) and adds its own writes to the same event and transaction (`within`, before the body's
 * derived state), as createNote takes them.
 *
 * updateNode(ws, id, { markdown }, { actor, baseMarkdown })
 */
export async function updateNode(
  workspaceId: string,
  id: string,
  input: NodeChanges,
  { actor, baseMarkdown, markdownPatch, keepOnConflict, onConflict, cursorState, bodyChange, adoptAnchors, source = "ui", dryRun = false, event, keepUpdatedAt, within }: {
    actor: ActorCtx;
    baseMarkdown?: string;
    /** The body as a patch against the text it was made from (@onden/markdown
     *  textPatch), instead of `input.markdown` + `baseMarkdown`: that text is
     *  the merge base. Resolved under the lock (services/patchedValue.ts). */
    markdownPatch?: unknown;
    keepOnConflict?: NodeChangePlan["keepOnConflict"];
    onConflict?: "refuse";
    cursorState?: { anchor: number; head: number };
    /** The editor's CodeMirror ChangeSet (toJSON) for this save and its device: block anchors move with the
     *  ChangeSet when it is shown to turn the stored body into the saved one, else by a line diff
     *  (blockAnchors/mapping.ts); the device is recorded on anchor events. */
    bodyChange?: EditorBodyChange;
    /** Anchors of paragraphs that come back into this note as text (收回原文): each is put on the block whose text is
     *  `text` in the saved body, keeping its id, row and links (see applyBodyChange). */
    adoptAnchors?: AdoptAnchor[];
    /** Trace origin only; all callers use the same save and effect contract. */
    source?: "ui" | "agent";
    dryRun?: boolean;
    /** The event's ui_context, extra tx_meta and labels, instead of the edit's. */
    event?: { uiContext: string; txMeta?: Record<string, unknown>; cascadeLabel: string; backupPrefix: string };
    /** The save is housekeeping, not an edit: the note keeps its `updated_at`, so "recent" lists do not move. */
    keepUpdatedAt?: boolean;
    within?: NodeChangePlan["within"];
  },
): Promise<NodeSaveResult> {
  input = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return saveNodeChange(workspaceId, id, { actor, dryRun }, async (current) => {
    // The plan may run again if the transaction is retried: resolve into locals.
    let planned = { input, baseMarkdown };
    if (markdownPatch !== undefined) {
      if ("markdown" in input || baseMarkdown !== undefined) throw new NodeUpdateError("markdown_patch_with_markdown", 400);
      const { incoming, base } = await resolvePatched(workspaceId, id, current.markdown, markdownPatch, { maxLength: NODE_MARKDOWN_MAX });
      planned = { input: { ...input, markdown: incoming }, baseMarkdown: base };
    }
    return {
      ...planned,
      keepOnConflict,
      onConflict,
      eventType: "NODE_UPDATED",
      // title is always carried (resolved, not just when changed) so a
      // version-event is self-describing: (created_at, actor, title, body_hash)
      // is the full snapshot the events-derived version history needs. The body
      // goes by hash, not value: no reader treats the payload as a body source.
      payload: (({ markdown: _omitBody, ...meta }) => meta)(planned.input),
      txMeta: event ? { ...event.txMeta, ui_context: event.uiContext } : {
        // G5: caret position at moment of save, re-applied on restore.
        ...(cursorState ? { cursor_state: cursorState } : {}),
        ui_context: source === "agent" ? "mcp.tool.updateNode" : "node.patch",
        ...(source === "agent" ? { tool_name: "updateNode", token_id: actor.tokenScope?.tokenId } : {}),
      },
      cascadeLabel: event?.cascadeLabel ?? (source === "agent" ? "mcp.updateNode.cascade" : "node.patch.cascade"),
      backupPrefix: event?.backupPrefix ?? "NODE_UPDATED",
      keepUpdatedAt,
      bodyChange,
      adoptAnchors,
      within,
    };
  });
}

/** Put a saved version's body (and, when `restoreTitle`, its title) back on the note: the same save as
 * an edit (current policy, slug, tag-name check, inverse history, derived
 * state), recorded as NODE_RESTORED { version_id, title, body_hash } so the
 * restore is itself a version and can be undone (eventRestore treats it like
 * NODE_UPDATED). The version is looked up only after the note's write check:
 * a caller who may not edit the note learns nothing about its history.
 * Throws NodeUpdateError 404 for a missing note or version; the rest as
 * updateNode.
 *
 * `restoreTitle` defaults to true: a caller that names no choice (an old
 * client) keeps the behaviour from before the title became a separate choice.
 * With false the note keeps its title and slug, and the restore event records
 * the title the note has, not the version's.
 *
 * restoreNodeVersion(ws, nodeId, versionEventId, { actor, restoreTitle? })
 */
export async function restoreNodeVersion(
  workspaceId: string,
  id: string,
  versionId: string,
  { actor, restoreTitle = true }: { actor: ActorCtx; restoreTitle?: boolean },
): Promise<NodeSaveResult> {
  return saveNodeChange(workspaceId, id, { actor, dryRun: false }, async (current) => {
    // A version is any body_hash-carrying event of this note (the history
    // list in routes/nodes.ts derives versions the same way).
    if (!/^\d{1,18}$/.test(versionId)) throw new NodeUpdateError("version not found", 404);
    const version = (await q<{ title: string; markdown: string }>(
      `SELECT (e.payload->>'title') AS title, b.content AS markdown
         FROM domain_events e
         JOIN blobs b ON b.hash = e.payload->>'body_hash'
        WHERE e.id = $1::bigint AND e.target_id = $2 AND e.workspace_id = $3
          AND e.payload ? 'body_hash'`,
      [versionId, id, workspaceId],
    )).rows[0];
    if (!version) throw new NodeUpdateError("version not found", 404);
    return {
      // An unchanged title is not rewritten, so the slug stays put and the
      // inverse holds only the body (the pre-W35 restore's history shape).
      input: { markdown: version.markdown, ...(restoreTitle && version.title && version.title !== current.title ? { title: version.title } : {}) },
      eventType: "NODE_RESTORED",
      // The title the note ends up with: the version's when it comes back, else the one it has. Stated here because the
      // save's own title is not the new one for a tag (its rename is written apart).
      payload: { version_id: versionId, title: restoreTitle && version.title ? version.title : current.title },
      txMeta: { ui_context: "node.version.restore" },
      cascadeLabel: "node.version.restore.cascade",
      backupPrefix: "NODE_RESTORED",
    };
  });
}

/** The saved (or, dry run, would-be) row, its event, and the lines a
 *  three-way merge could not combine: there the body holds this writer's
 *  text and BODY_CONFLICT (the inbox) keeps the other writer's. */
export type NodeSaveResult =
  | { node: Record<string, unknown>; eventId: string; bodyConflicts: BodyConflict[]; noop?: undefined }
  /** Every supplied field already held its value: nothing was written, no event
   *  exists for it, and `node` is the row as it is. */
  | { node: Record<string, unknown>; eventId: null; bodyConflicts: []; noop: true };

/** A save that adds its own writes (`within`) is never a noop. */
export function writtenSave(saved: NodeSaveResult): Extract<NodeSaveResult, { eventId: string }> {
  if (saved.noop) throw new Error("a save with its own writes cannot be a noop");
  return saved;
}

/** The supplied fields whose value differs from the stored row. `body` is the
 *  text the save would store (after the merge and the added `^id`s). Titles
 *  compare in NFC (D58), as the save stores them. */
function differingKeys(oldRow: StoredNode, nodeInput: NodeChanges, body: string): string[] {
  const old = oldRow as Record<string, unknown>;
  return Object.keys(nodeInput).filter((key) => {
    const value = (nodeInput as Record<string, unknown>)[key];
    switch (key) {
      case "markdown": return body !== (oldRow.markdown ?? "");
      case "title": return normalizeText(String(value)) !== normalizeText(oldRow.title);
      case "parent_id": return (value === oldRow.id ? null : (value ?? null)) !== (oldRow.parent_id ?? null);
      case "hidden": return (value ?? false) !== (oldRow.hidden ?? false);
      case "sort_order": return (value ?? 0) !== (oldRow.sort_order ?? 0);
      case "presentation": return !isDeepStrictEqual(value ?? null, oldRow.presentation ?? null);
      default: return value !== old[key];
    }
  });
}

/** What one save writes and how it is recorded, decided from the row read
 *  under the event lock (an edit ignores it; a restore compares the title). */
type NodeChangePlan = {
  input: NodeChanges;
  baseMarkdown?: string;
  /** Which side keeps a line both changed when baseMarkdown merges. Default
   *  "incoming": the text being saved. "current": the note's text stays and
   *  the saved text is what BODY_CONFLICT keeps (an undo must not overwrite
   *  what a person wrote since). */
  keepOnConflict?: "incoming" | "current";
  /** "refuse": a conflicting merge throws BodyConflictError instead of choosing a side. */
  onConflict?: "refuse";
  eventType: "NODE_UPDATED" | "NODE_RESTORED";
  /** Event payload; title (resolved) and body_hash are added. */
  payload: Record<string, unknown>;
  /** Added to the inverse_patch / prev_field_values every save records. */
  txMeta: Record<string, unknown>;
  cascadeLabel: string;
  backupPrefix: string;
  keepUpdatedAt?: boolean;
  bodyChange?: EditorBodyChange;
  adoptAnchors?: AdoptAnchor[];
  /** The caller's own writes in this event's transaction, after the node's
   *  row and before its body's derived state. */
  within?: (ctx: { nodeId: string; eventId: string }) => Promise<void>;
};

/** The columns of a note's row that a save or an undo writes (the column
 *  names are these literals, never request text). */
export type NodeColumns = Partial<{
  title: string; slug: string; markdown: string; node_type: string; source_type: string;
  parent_id: string | null; hidden: boolean; sort_order: number; presentation: Record<string, unknown> | null;
}>;
const NODE_COLUMNS = ["title", "slug", "markdown", "node_type", "source_type", "parent_id", "hidden", "sort_order", "presentation"] as const;

/** The one write of a note's row, shared by the ordinary save (saveNodeChange)
 *  and the event-history undo (eventRestore/restore.ts), so what rides on a
 *  column follows it from either: only the supplied columns are written; a tag
 *  that moved to another parent retypes its notes' values (D94); a page design
 *  claims the uploads no note owns yet (services/mediaOwners.ts). The caller
 *  decides what a column becomes (an NFC title, the slug that follows a title,
 *  the previous value of an undo), holds the event lock and records the event.
 *  `touchUpdatedAt` false keeps "modified" (a reorder, housekeeping saves).
 *  Returns the stored row. The visibility hook and the body's derived state
 *  stay with the caller.
 *
 *  applyNodeColumns(ws, id, { title, slug }, { before: { isTag, parentId }, touchUpdatedAt: true }) */
export async function applyNodeColumns(
  workspaceId: string,
  id: string,
  columns: NodeColumns,
  { before, touchUpdatedAt }: { before: { isTag: boolean; parentId: string | null }; touchUpdatedAt: boolean },
): Promise<ServerNodeRow> {
  const sets: string[] = [];
  const vals: unknown[] = [workspaceId, id];
  for (const column of NODE_COLUMNS) {
    if (!(column in columns)) continue;
    vals.push(columns[column]);
    sets.push(`${sqlIdentifier(column)} = $${vals.length}`);
  }
  const r = await q<ServerNodeRow>(
    `UPDATE content_nodes
     SET ${(touchUpdatedAt ? [...sets, "updated_at = now()"] : sets).join(", ")}
     WHERE workspace_id = $1 AND id = $2
     RETURNING *`,
    vals,
  );
  if (before.isTag && "parent_id" in columns && (columns.parent_id ?? null) !== before.parentId) {
    await retypeGoverned(workspaceId, { tagIds: [id] });
  }
  if ("presentation" in columns) await claimUploadedMedia(workspaceId, id, presentationText(columns.presentation));
  return r.rows[0]!;
}

/** The one save path behind updateNode and restoreNodeVersion. */
async function saveNodeChange(
  workspaceId: string,
  id: string,
  { actor: authenticated, dryRun }: { actor: ActorCtx; dryRun: boolean },
  plan: (current: StoredNode) => Promise<NodeChangePlan>,
): Promise<NodeSaveResult> {
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    // A system job (spine/systemJobs.ts) has no row in `actors` to reload; it holds only `system` authority.
    const fromSystemJob = systemJobOf(authenticated) !== null;
    const actor = fromSystemJob ? authenticated : await resolveCurrentActor(authenticated, workspaceId);
    const writeAuthority = fromSystemJob ? { kind: "system" } as const : { kind: "node", nodeId: id, op: "write_node" } as const;
    const current = await q<StoredNode>(
      `SELECT * FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()} FOR UPDATE`,
      [workspaceId, id],
    );
    if (!current.rows[0]) throw new NodeUpdateError("node not found", 404);
    const oldRow = await withViews(workspaceId, current.rows[0]);
    await assertAuthority(actor, writeAuthority);
    const { input: planned, baseMarkdown, ...record } = await plan(oldRow);
    // Titles are stored in NFC (D58), as createNote stores them.
    const input = planned.title != null ? { ...planned, title: normalizeText(planned.title) } : planned;
    // A tag's identity activates policies on its members. Ordinary note editing
    // cannot disable those policies, even for admins; schema administration owns it.
    if (oldRow.node_type === TAG_NODE_TYPE && input.node_type !== undefined) {
      throw new NodeUpdateError("tag identity cannot be changed through a node edit", 422);
    }
    // A tag's title is its name. Renaming it is the tag's own write
    // (services/tagIdentity.ts: TAG_UPDATED, the `tag-` slug, an undo that puts
    // both back), the same as PATCH /api/tags/:id, never a NODE_UPDATED title.
    // The edit's other fields are saved here first; an unchanged title is dropped.
    const isTag = oldRow.node_type === TAG_NODE_TYPE;
    // Compared in NFC (D58): a save that re-sends a tag's title stored
    // decomposed before D58 is no rename.
    const tagRename = isTag && input.title !== undefined && input.title !== normalizeText(oldRow.title) ? input.title : null;
    const nodeInput: NodeChanges = isTag ? (({ title: _name, ...rest }) => rest)(input) : input;
    const changedKeys = Object.keys(nodeInput);
    const next = { ...oldRow, ...nodeInput, title: nodeInput.title ?? oldRow.title };
    const nextParentId = "parent_id" in nodeInput ? (nodeInput.parent_id === id ? null : (nodeInput.parent_id ?? null)) : (oldRow.parent_id ?? null);
    const nextHidden = "hidden" in nodeInput ? (nodeInput.hidden ?? false) : (oldRow.hidden ?? false);
    // Only a tag can be hidden (the user's decision, D104): a note is trashed
    // or kept private, never hidden. Showing a note again stays allowed, and
    // a row already hidden (system machinery: task nodes, Site Config) may
    // re-send its flag unchanged.
    if (!isTag && nextHidden && !(oldRow.hidden ?? false)) {
      throw new NodeUpdateError("only_tags_can_be_hidden", 400);
    }
    const nextSortOrder = "sort_order" in nodeInput ? (nodeInput.sort_order ?? 0) : (oldRow.sort_order ?? 0);
    const nextPresentation = "presentation" in nodeInput ? (nodeInput.presentation ?? null) : (oldRow.presentation ?? null);
    // Only recalculate slug when title actually changes to avoid concurrent-PATCH race conditions.
    // Every autosave re-sends the title, so "changes" is compared in NFC (D58):
    // an unchanged title keeps the slug an older slug rule gave it.
    const titleChanged = "title" in nodeInput && next.title !== normalizeText(oldRow.title);
    const nextSlug = titleChanged ? await slugForTitle(workspaceId, oldRow, next.title) : oldRow.slug;

    const isContentUpdate = changedKeys.some((k) => k === "title" || k === "markdown");
    // A position among siblings (D64) is not an edit of the note: it keeps its
    // updated_at ("modified", the site's dates, recent lists) and its event
    // carries no body_hash, so it is no version in the note's history. The event
    // still syncs the move and undoes it (prev_field_values).
    const positionOnly = changedKeys.length > 0 && changedKeys.every((k) => k === "sort_order");

    // Capture the actual predecessor under the event lock: both merge and undo
    // must describe the state this write replaces, including earlier queued edits.
    const oldBody = (oldRow.markdown as string) ?? "";
    let newBody = "markdown" in nodeInput ? ((nodeInput.markdown as string) ?? oldBody) : oldBody;
    // Concurrent-edit merge (services/eventLog/bodyMerge.ts, line-based like
    // git). When the client supplies the body it BASED its edit on and the
    // server has moved since, both writers' changes to different lines land.
    // Lines both changed differently are conflicts: the merged body keeps this
    // writer's text there, and BODY_CONFLICT keeps the other writer's text so
    // the inbox can offer it back.
    let bodyConflicts: BodyConflict[] = [];
    if (
      "markdown" in nodeInput && baseMarkdown !== undefined &&
      oldBody !== baseMarkdown && oldBody !== newBody
    ) {
      // incoming === base (a title-only save re-sends the body it started
      // from) merges to the server's body: skipping it wrote the stale body back.
      const { merged, conflicts } = record.keepOnConflict === "current"
        ? mergeBody(baseMarkdown, oldBody, newBody)
        : mergeBody(baseMarkdown, newBody, oldBody);
      if (record.onConflict === "refuse" && conflicts.length > 0) throw new BodyConflictError(conflicts);
      newBody = merged;
      next.markdown = merged;
      bodyConflicts = conflicts;
    }
    // Nothing to save: the note already holds every field sent (typed and typed
    // back, a rename to the same name, a move to where it is). No event, so no
    // history point; the idempotency key is still claimed so a retry of this
    // request is a replay, not a second look at a note that may have moved on.
    // Not when the caller adds its own writes to this event (`within`), nor when
    // the merge left conflicts: BODY_CONFLICT keeps the text the body now lacks.
    const changed = differingKeys(oldRow, nodeInput, newBody);
    if (!dryRun && tagRename === null && changed.length === 0 && bodyConflicts.length === 0 && !record.within) {
      await claim();
      return { node: oldRow, eventId: null, bodyConflicts: [], noop: true };
    }
    const inversePatch = "markdown" in nodeInput ? makeInversePatch(oldBody, newBody) : "";
    const prevFieldValues: Record<string, unknown> = {};
    for (const k of changedKeys) {
      if (k === "markdown") continue; // markdown's inverse is the patch above
      prevFieldValues[k] = (oldRow as Record<string, unknown>)[k];
    }

    if (tagRename !== null) assertTagNameShape(tagRename);
    if (nextParentId !== (oldRow.parent_id ?? null)) {
      // A move: placement, space, kind, cycle, tag name and field clash, the
      // rules every move shares (nodeTree.assertReparent), under the new name
      // when the tag is renamed in the same save.
      try {
        await assertReparent(workspaceId, { id, node_type: next.node_type, title: tagRename ?? oldRow.title, parent_id: oldRow.parent_id ?? null }, nextParentId, actor);
      } catch (error) {
        if (error instanceof ReparentError) throw new NodeUpdateError(error.message, error.status, error.code);
        throw error;
      }
    } else if (tagRename !== null) {
      await assertTagNameAvailable(workspaceId, id, { title: tagRename, parentId: nextParentId });
    }
    if (dryRun) {
      const renamed = tagRename !== null ? { title: tagRename, slug: await slugForTitle(workspaceId, oldRow, tagRename) } : { slug: nextSlug };
      return { node: { ...next, ...renamed, markdown: newBody, parent_id: nextParentId }, eventId: "(dry-run)", bodyConflicts };
    }
    // events->hash->blobs: content-address the post-edit body; the event carries
    // body_hash, the single retained copy of this version's content.
    await claim();
    // Only a change of the text or the title is a version (carries body_hash):
    // a move, a hidden flag, a page design or a position changes neither.
    const bodyHash = changed.some((k) => k === "markdown" || k === "title")
      ? await putBlob(newBody) : null;
    // The event (NODE_UPDATED / NODE_RESTORED) + the UPDATE + the in-tx sync are one atomic,
    // attributed unit through the spine. A reparent stays inside the note's
    // space (a parent in another space is refused above), so nobody's readable
    // set moves: no membership epoch bump.
    // A tag rename alone records only its TAG_UPDATED (below).
    const result = tagRename !== null && changedKeys.length === 0 ? null : await mutate<{ node: Record<string, unknown>; eventId: string }>({
      actor,
      workspaceId,
      authority: writeAuthority,
      // Hiding or showing a note moves who may see it (the website).
      visibilityChanged: nextHidden !== (oldRow.hidden ?? false) ? [id] : undefined,
      event: {
        type: record.eventType,
        targetType: "node",
        targetId: id,
        payload: { title: next.title, ...record.payload, ...(bodyHash !== null ? { body_hash: bodyHash } : {}) },
        txMeta: { inverse_patch: inversePatch, prev_field_values: prevFieldValues, ...record.txMeta },
        // The body the editor started from; without one the write is based on the body it replaced.
        ...(bodyHash !== null && baseMarkdown !== undefined ? { baseHash: sha256Hex(baseMarkdown) } : {}),
      },
      apply: async ({ eventId }) => {
        // PATCH changes only explicitly supplied columns; other fields retain
        // the state read inside this transaction.
        const updated = await withViews(workspaceId, await applyNodeColumns(workspaceId, id, {
          ...("title" in nodeInput ? { title: next.title, slug: nextSlug } : {}),
          ...("markdown" in nodeInput ? { markdown: next.markdown as string } : {}),
          ...("node_type" in nodeInput ? { node_type: next.node_type } : {}),
          ...("source_type" in nodeInput ? { source_type: next.source_type } : {}),
          ...("parent_id" in nodeInput ? { parent_id: nextParentId } : {}),
          ...("hidden" in nodeInput ? { hidden: nextHidden } : {}),
          ...("sort_order" in nodeInput ? { sort_order: nextSortOrder } : {}),
          ...("presentation" in nodeInput ? { presentation: nextPresentation } : {}),
        }, { before: { isTag, parentId: oldRow.parent_id ?? null }, touchUpdatedAt: !(positionOnly || record.keepUpdatedAt) }));
        // Overlapping concurrent edits: what each conflict left out, for the
        // inbox (the whole overridden body is also a version in history).
        if (bodyConflicts.length > 0) {
          await event(
            workspaceId, "BODY_CONFLICT", "node", id,
            {
              ...bodyConflictPayload(bodyConflicts),
              overridden_preview: cutToUnits(oldBody, 500),
              server_updated_at: String(oldRow.updated_at),
              incoming_actor_id: actor.id,
            },
            "system", actor.id, { triggeredBy: eventId },
          );
        }
        await record.within?.({ nodeId: id, eventId });
        if (isContentUpdate) {
          // Edges, block ids, backup, module hooks and the cascade, in-tx and
          // after commit (services/bodySideEffects.ts). Because restore is
          // itself a body change, it runs the same chain.
          await applyBodyChange({
            workspaceId, nodeId: updated.id as string, title: updated.title as string,
            markdown: updated.markdown as string, previousMarkdown: oldBody, bodyChange: record.bodyChange, adoptAnchors: record.adoptAnchors, eventId, actor,
            renamed: updated.title !== oldRow.title || updated.slug !== oldRow.slug,
            cascadeLabel: record.cascadeLabel, backupPrefix: record.backupPrefix,
          });
        }
        return { node: updated, eventId };
      },
    });
    if (tagRename === null) return { ...result!, bodyConflicts };
    // After the edit, so a move in the same request is already in place when
    // the rename checks the name under the tag's (new) parent. Still one
    // write: both run in this withEventTransaction (one savepoint, the
    // workspace's event-append lock held throughout), so no other rename can
    // take the name in between, and a refused rename rolls the edit back too.
    const renamed = await writeTagIdentity(actor, workspaceId, id, { name: tagRename }, {
      authority: { kind: "node", nodeId: id, op: "write_node" }, uiContext: String(record.txMeta.ui_context),
    });
    const node = await withViews(workspaceId, (await q<ServerNodeRow>(
      "SELECT * FROM content_nodes WHERE workspace_id = $1 AND id = $2", [workspaceId, id],
    )).rows[0]!);
    return { node, eventId: renamed!.eventId ?? result!.eventId, bodyConflicts };
  }));
}
