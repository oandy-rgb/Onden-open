// Per-entity event restore (ER6).
//
// Walks a single domain_event back: dispatches on event_type + tx_meta to
// produce the inverse mutation, emits a fresh "restore event" that:
//   - has triggered_by_event_id = original.id (cascade tree)
//   - has tx_meta.restored_from = original.id (provenance for the UI)
//   - sets its OWN inverse_op so the restore is itself restorable (undo-redo)
//
// A restore appends a new event; it never rewrites the original history.
//
// Pattern references (memory/feedback_problem_solving_reference_first):
//
//   SiYuan kernel/model/history.go: RollbackDoc reads the snapshot file
//   and re-publishes its content as a new revision. Restore is a new
//   write, not a delete-newer-rows. Same shape here.
//
//   Trilium services/notes.ts: undeleteNote flips isDeleted=false +
//   appends a revision describing the restore. We do the equivalent via
//   tx_meta.restored_from on the emitted event.
//
//   NixOS nix-env --rollback: switches the profile pointer to an earlier
//   generation; older generations remain on disk. Onden's content_node_versions
//   chain is the same shape — restore points the "current" at an older
//   payload without rewriting history.
//
//   Logseq tx-log: every transaction is reversible because the tx data
//   carries both prev + new. Our tx_meta.prev_field_values is that.
//
// What restore canNOT do:
//   - external=true events (writeAndCommit FS git, pushNoteToBackup
//     GitHub) — the side effect happened outside PG. We surface this as
//     409 with a hint pointing at the backup target.
//   - NODE_PURGED events — the row is genuinely gone (CASCADE wiped 7
//     dependent tables). 410 Gone.
//   - Events whose target entity no longer exists (e.g., ATTRIBUTE_SET on
//     a node that was later purged). 410 Gone.

import { recordVersion, versionBeforeEvent } from "../../spine/noteVersions.js";
import { keyForRestore, respaceIfTooLong, translateLegacySortOrder } from "../orderKeys.js";
import { recordRestore, requireRestoreTransaction } from "./record.js";
import { alreadyInState, historyIncomplete, stateConflict } from "./refusals.js";
import { lastBodyHashBeforeSql } from "../history/index.js";
import { nodeVisibilityCommitted } from "../../spine/nodeHooks.js";
import { applyBodyChange } from "../bodySideEffects.js";
import { pool, q } from "../../db.js";
import { enqueueBackup } from "../outbox.js";
import { duplicateNote, NoteDuplicateError } from "../noteDuplicate.js";
import { putBlob } from "../blobs.js";
import { makeInversePatch, NO_INVERSE_PATCH, rebuildPreEventBody, rebuildFromUnchangedBody, mergeBody } from "../eventLog/index.js";
import { assertAuthority, AuthorityError } from "../../spine/authority.js";
import { canReadRetainedNode } from "../readPolicy.js";
import type { ActorCtx } from "../../types.js";
import { authorizeRestore } from "./policy.js";
import { restoreAttribute, previewAttributeRestore, type AttributeRestorePreview } from "./attributes.js";
import { restoreTagUpdate, previewTagUpdate, type TagUpdatePreview } from "./tags.js";
import { mutateRestore, runRestore } from "../../spine/mutate.js";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { isDeepStrictEqual } from "node:util";
import {
  restoreHandlerFor, restoreBlockedError, LEGACY_NODE_EVENT_TYPES,
  type BuiltInRestoredEventType, type EventRow, type RegisteredRestorePreview,
  type RestoreError, type RestoreHandler, type RestoreResult,
} from "../restoreContract.js";
import { moveToSpace, SpaceMoveError } from "../spaces.js";
import { followIdRewrites } from "../idRewrites.js";
import { assertReparent, ReparentError, type ReparentNode } from "../nodeTree.js";
import { ModuleTagParentError, ParentKindError } from "../parentKind.js";
import { assertTagNameAvailable, TagNameConflictError } from "../tagHierarchy.js";
import { FieldNameClashError } from "../tagFields.js";
import { eventChain } from "../eventChain.js";
import { restoreLive, restorePlan, trashLive, trashSubtreeIds } from "../nodeTrash.js";
import { applyNodeColumns, type NodeColumns } from "../nodeUpdate.js";
import { slugForTitle } from "../nodes.js";
import { ReservedTagError } from "../reservedTags.js";
import { liveNodeSql } from "../../spine/nodeSql.js";
import { isTag } from "@onden/markdown/contract";

interface RestoreOptions {
  /** NODE_UPDATED only: explicitly overwrite conflicting scalar fields and
   *  body lines later edited differently (the undo's text wins there; later
   *  edits elsewhere still stay). It never bypasses current access or tree
   *  rules, nor a missing pre-event body (history_incomplete). */
  force?: boolean;
  /** When true, also restore the triggered_by_event_id descendants, newest
   *  first. A deleted root is revived first so children can return beneath it;
   *  other root inverses run last. Reference: Trilium
   *  undeleteNote → undeleteBranch recursion (notes.ts:1008-1098).
   *  Trilium groups by deleteId; Onden walks the event graph instead. */
  cascade?: boolean;
  /** NODE_UPDATED only: instead of patching the current node, create a
   *  NEW node with the restored content and leave the live node untouched.
   *  This also leaves its caused changes untouched; cascade is ignored.
   *  Reference: Joplin RevisionService.restoreNoteById creates a new note
   *  in the "Restored Notes" folder (RevisionService.ts:280-307). Onden's
   *  twist: title prefixed with "[Restored]" so it's findable. */
  as_new_node?: boolean;
  /** Trusted authentication context: owns BOTH authorization and attribution. */
  actor: ActorCtx;
  /** Event ids never confer access across workspace boundaries. */
  workspaceId: string;
}

// These are the scalar fields written by the ordinary node PATCH. Keep the
// inverse scoped to exactly the fields this event changed: a body undo must
// not make a later title edit part of its redo metadata.
const nodeScalarFields = ["title", "parent_id", "hidden", "order_key", "presentation", "node_type", "source_type"] as const;
type NodeScalarField = typeof nodeScalarFields[number];
type NodeSnapshot = Record<NodeScalarField, unknown> & {
  title: string;
  markdown: string;
  slug: string;
  reserved_key: string | null;
  deleted_at: string | null;
  parent_id: string | null;
};

/** Whether a respace rewrote the keys of one of these sibling groups (live notes under that parent; null = the top level)
 *  in an event after `eventId` (services/orderKeys.ts respaceIfTooLong records it). A place recorded before that is a key of
 *  the old numbering. */
async function groupRespacedSince(workspaceId: string, eventId: string, parentIds: Array<string | null>): Promise<boolean> {
  const named = parentIds.filter((id): id is string => id !== null);
  const result = await sql<{ found: number }>`
    SELECT 1 AS found FROM domain_events
     WHERE workspace_id = ${workspaceId} AND id > ${eventId} AND event_type = 'NODE_UPDATED'
       AND payload->'order_respaced'->>'table' = 'content_nodes'
       AND ((payload->'order_respaced'->>'parent_id') = ANY (${named}::text[])
            OR (${parentIds.includes(null)}::boolean AND payload->'order_respaced'->>'parent_id' IS NULL))
     LIMIT 1`.execute(db);
  return result.rows.length > 0;
}

/** The event with its recorded old place taken out when the sibling group's keys were all rewritten after it (a respace,
 *  services/orderKeys.ts): the old key no longer belongs to the group's current keys, and writing it back would put the note at
 *  a position no one chose. Same answer as an event from before migration 200 (which recorded an integer): the place is not
 *  restored, and an event that only moved the note says "a later edit already took this change back". */
async function withoutStalePlace(row: EventRow, current: { parent_id: string | null }): Promise<EventRow> {
  const prev = row.tx_meta?.prev_field_values as Record<string, unknown> | undefined;
  if (typeof prev?.order_key !== "string") return row;
  const parents = [current.parent_id, ...("parent_id" in prev ? [prev.parent_id as string | null] : [])];
  if (!await groupRespacedSince(row.workspace_id, String(row.id), parents)) return row;
  const { order_key: _stale, ...rest } = prev;
  return { ...row, tx_meta: { ...row.tx_meta, prev_field_values: rest } };
}

function nodeRestoreFields(row: EventRow): Record<string, unknown> {
  const { sort_order: _legacyPlace, ...fields } = (row.tx_meta?.prev_field_values as Record<string, unknown> | undefined) ?? {};
  return fields;
}

/** The edit changed the text but could not record how to undo it (a body the
 *  patch format cannot encode): not the same as an edit that left it alone. */
const noInversePatch: RestoreError = historyIncomplete("this edit did not record how to undo its text change");

/**
 * The body undoing this event's body change leaves, on top of `currentBody`
 * (D79). The inverse patch on the event's OWN post blob (payload.body_hash)
 * rebuilds the exact pre-event body; the undo is then a three-way merge —
 * base: the post body, incoming: the pre-event body, current: today's body —
 * so later edits to other lines stay, and lines both the undo and a later
 * edit changed are `conflicts`. Those lines hold the pre-event text in
 * `body`, which is what force writes. Restore and preview share this, so
 * can_apply_cleanly is exactly "restore needs no force".
 *
 * Events with no post blob (legacy) cannot be merged: they revert only while
 * the body is still what they left (rebuildFromUnchangedBody), else
 * history_incomplete — force cannot make up the missing base.
 */
async function revertedBody(
  row: EventRow, currentBody: string, inversePatch: string,
): Promise<{ body: string; conflicts: number } | RestoreError> {
  const hash = row.payload.body_hash;
  const post = typeof hash === "string" && hash
    ? (await q<{ content: string }>("SELECT content FROM blobs WHERE hash = $1", [hash])).rows[0]?.content
    : undefined;
  if (post === undefined) {
    const pre = rebuildFromUnchangedBody(currentBody, inversePatch);
    return pre !== null ? { body: pre, conflicts: 0 } : historyIncomplete("the body changed since this event, which kept no copy of the body it left; it cannot be undone without guessing");
  }
  const pre = rebuildPreEventBody(post, inversePatch);
  if (pre === null) {
    return historyIncomplete("historical body cannot be reconstructed");
  }
  const { merged, conflicts } = mergeBody(post, pre, currentBody);
  return { body: merged, conflicts: conflicts.length };
}

/** An undo of a note edit that would leave the note as it is: a later edit
 *  already took these lines (and fields) back. Refused like every other
 *  restore that has nothing to do, not answered with an edit that changes nothing. */
function nodeUpdateChangesNothing(row: EventRow, current: NodeSnapshot, nextBody: string): RestoreError | null {
  const previous = nodeRestoreFields(row);
  const fieldsDiffer = nodeScalarFields.some((field) => field in previous && !isDeepStrictEqual(current[field], previous[field]));
  return fieldsDiffer || nextBody !== (current.markdown ?? "")
    ? null
    : alreadyInState("a later edit already took this change back");
}

function conflictingNodeFields(row: EventRow, current: NodeSnapshot): string[] {
  const previous = nodeRestoreFields(row);
  return nodeScalarFields.filter((field) => {
    if (!(field in previous) || isDeepStrictEqual(current[field], previous[field])) return false;
    // Old events may lack the forward value. Without it, an overwrite cannot
    // be proven safe; the same explicit force choice handles this uncertainty.
    return !(field in row.payload) || !isDeepStrictEqual(current[field], row.payload[field]);
  });
}

/**
 * Restore one event, optionally with its caused changes, under current policy.
 * A domain refusal leaves this operation's state/events unchanged, including
 * inside a caller-owned review transaction. Authorization/storage failures
 * throw. HTTP callers map domain `status` directly; request retries share the
 * existing spine idempotency contract (including restore-as-new).
 */
/** Legacy bookmark/canvas history restores as the node event it was. */
function asNodeEvent(row: EventRow): EventRow {
  const type = LEGACY_NODE_EVENT_TYPES[row.event_type];
  return type ? { ...row, event_type: type, target_type: "node" } : row;
}

/** Load every domain restore registrant (services/restoreHandlers.ts) once,
 *  before the first restore or preview. Lazy: the registrants import their way
 *  back to this module, so a static import would be a cycle. */
let handlersLoaded: Promise<unknown> | null = null;
function loadRestoreHandlers(): Promise<unknown> {
  handlersLoaded ??= import("../restoreHandlers.js").catch((error: unknown) => {
    handlersLoaded = null;
    throw error;
  });
  return handlersLoaded;
}

export async function restoreEvent(
  eventId: string,
  opts: RestoreOptions,
): Promise<RestoreResult | RestoreError> {
  await loadRestoreHandlers();
  try {
    return await runRestore(opts, async (actor) => {
      const result = await restoreWithinTransaction(eventId, { ...opts, actor });
      // Catch only after rollback: the helper uses a savepoint when an
      // inbox review owns the outer transaction, and discards failed hooks.
      if ("code" in result) throw new RestoreRejected(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RestoreRejected) return error.result;
    // A domain refusal like the others (and already rolled back): undoing a
    // create or undelete of a reserved tag would trash it. As a RestoreError,
    // a review batch or chain skips this one instead of aborting.
    if (error instanceof ReservedTagError) return { code: error.body.error, status: 409, detail: error.message };
    throw error;
  }
}

class RestoreRejected extends Error {
  constructor(readonly result: RestoreError) {
    super(result.detail);
    this.name = "RestoreRejected";
  }
}

async function restoreWithinTransaction(
  eventId: string,
  opts: RestoreOptions,
): Promise<RestoreResult | RestoreError> {
  const evt = await q<EventRow>(
    `SELECT id::text, workspace_id, event_type, target_type, target_id,
            payload, tx_meta, external
       FROM domain_events
      WHERE id = $1::bigint
        AND workspace_id = $2::uuid`,
    [eventId, opts.workspaceId],
  );
  const row = evt.rows[0] && asNodeEvent(await followIdRewrites(evt.rows[0]));
  if (!row) return { code: "not_found", status: 404, detail: `event ${eventId} not found` };

  await authorizeRestore(opts.actor, row, opts.as_new_node ?? false);

  if (opts.as_new_node && row.event_type !== "NODE_UPDATED") {
    return { code: "unsupported", status: 422, detail: "restore-as-new is only available for node updates" };
  }

  // The same rule the event lists send as `restorable` (D33), before any
  // cascade or state change.
  const blocked = restoreBlockedError(row);
  if (blocked) return blocked;

  const txMeta = row.tx_meta ?? {};

  // The public operation owns atomicity, including domain-error results. An
  // individual unsupported descendant may be skipped under the existing
  // cascade contract; failure of the PRIMARY event rolls back all descendants.
  // A merge/delete can have moved children away from the now-deleted root.
  // Revive that root before inverse reparenting: parent validation remains the
  // same live/readable/cycle gate as any ordinary move, without a bypass flag.
  // This is still inside the operation's savepoint; a failed inverse rolls back.
  let revivedRoot: RestoreResult | undefined;

  // Descendants run newest first. Unsupported observations and already-undone
  // changes may be skipped. A refused state change aborts the whole unit:
  // otherwise undoing a parent could delete data a child just protected.
  let cascadeReport: RestoreResult["cascade"] = undefined;
  // Copy is a separate operation: preserving the source includes preserving
  // its caused changes. A client may also send its selected cascade=true here;
  // the explicit copy intent takes precedence rather than mutating children.
  if (opts.cascade && !opts.as_new_node) {
    // Newest first, so a child is undone before the change it built on.
    const chain = await eventChain(opts.workspaceId, eventId);
    const descendants = await q<{ id: string; event_type: string }>(
      `SELECT e.id::text, e.event_type FROM domain_events e WHERE e.id = ANY($1::bigint[]) ORDER BY e.id DESC`,
      [chain.map((e) => e.id)],
    );
    // Snapshot descendants BEFORE appending the revival event; otherwise this
    // operation would discover its own new event and immediately undo itself.
    if (row.event_type === "NODE_DELETED" || row.event_type === "TAG_MERGED") {
      const revival = await restoreNodeDeleted(row, opts.actor);
      if ("code" in revival) return revival;
      revivedRoot = revival;
    }
    cascadeReport = [];
    for (const d of descendants.rows) {
      const childResult = await restoreEvent(d.id, { ...opts, cascade: false });
      if ("restored" in childResult) {
        cascadeReport.push({ event_id: d.id, event_type: d.event_type, result: "ok" });
      } else {
        if (childResult.code !== "unsupported" && childResult.code !== "already_in_state") {
          return { ...childResult, detail: `cascade event ${d.id}: ${childResult.detail}` };
        }
        cascadeReport.push({
          event_id: d.id, event_type: d.event_type,
          result: "skipped", detail: childResult.detail,
        });
      }
    }
  }

  // Helper to attach the cascade report to the primary result.
  const withCascade = <R extends RestoreResult | RestoreError>(r: R): R =>
    "restored" in r && cascadeReport
      ? ({ ...r, cascade: cascadeReport } as R)
      : r;

  // Keyed by BUILT_IN_RESTORED_EVENT_TYPES (restoreContract.ts), the list the
  // `restorable` rule reads: a type cannot be offered without an inverse here.
  const builtInInverses: Record<BuiltInRestoredEventType, () => Promise<RestoreResult | RestoreError>> = {
    NODE_DELETED: () => restoreNodeDeleted(row, opts.actor),
    NODE_UNDELETED: () => restoreNodeUndeleted(row, opts.actor),
    // Inverse of create is soft delete. Same path as NODE_UNDELETED's
    // inverse, just rooted at a different original event.
    NODE_CREATED: () => restoreNodeUndeleted(row, opts.actor),
    NODE_UPDATED: () => opts.as_new_node
      ? restoreNodeUpdatedAsNew(row, opts.actor)
      : restoreNodeUpdated(row, opts.actor, opts.force ?? false),
    // A version restore without its recorded inverse was refused above
    // (history_incomplete).
    NODE_RESTORED: () => restoreNodeUpdated(row, opts.actor, opts.force ?? false),
    ATTRIBUTE_SET: () => restoreAttribute(row, opts.actor),
    ATTRIBUTE_DELETED: () => restoreAttribute(row, opts.actor),
    TAG_UPDATED: () => restoreTagUpdate(row, opts.actor),
    TAG_SCHEMA_UPDATED: () => restoreTagUpdate(row, opts.actor),
    NODE_MOVED_SPACE: () => restoreNodeMovedSpace(row, opts.actor),
    // The merge soft-deleted the SOURCE tag (target_id) and chained every
    // side effect (each member's TAG_APPLIED, seeded ATTRIBUTE_SETs,
    // template-child NODE_CREATEDs) as triggered_by descendants. The root
    // inverse is exactly a NODE_DELETED restore (undelete the tag node);
    // cascade:true walks the chain deepest-first and inverses the rest —
    // a FULL merge undo via the standard machinery.
    TAG_MERGED: () => restoreNodeDeleted(row, opts.actor),
  };

  const dispatch = async (): Promise<RestoreResult | RestoreError> => {
    if (Object.hasOwn(builtInInverses, row.event_type)) {
      return withCascade(await builtInInverses[row.event_type as BuiltInRestoredEventType]());
    }
    const handler = restoreHandlerFor(row.event_type);
    if (handler) return withCascade(await restoreRegistered(handler, row, opts.actor));
    // Unreachable while restoreBlockedError holds: a DOMAIN_RESTORED type
    // whose registrant failed to load would land here.
    return { code: "unsupported", status: 422, detail: `restore not implemented for event_type=${row.event_type}` };
  };

  return revivedRoot ? withCascade(revivedRoot) : dispatch();
}

/** A registered inverse joins this restore's transaction; the standalone
 *  guard keeps a misuse from emitting a partial restore. */
async function restoreRegistered(
  handler: RestoreHandler,
  row: EventRow,
  actorContext: ActorCtx,
): Promise<RestoreResult | RestoreError> {
  requireRestoreTransaction();
  return handler.restore(row, {
    actorContext,
    record: (change) => recordRestore(row, actorContext, change),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Preview (G3) — runs the same logic as restore but writes nothing.
// Used by the diff-preview modal before the user confirms.
// ─────────────────────────────────────────────────────────────────────────

/** What restoring a delete brings back (nodeTrash.ts restoreLive): the
 *  deleted notes above it and the notes deleted together with it. Counts are
 *  every note; the lists name only those the reader may read (at most 20
 *  each). Empty while the note is live: nothing would change. */
type NodeUndeletePreview = {
  kind: "node_undelete"; title: string; currently_deleted: boolean;
  ancestors: Array<{ id: string; title: string }>; ancestor_count: number;
  subtree: Array<{ id: string; title: string }>; subtree_count: number;
};

const PREVIEW_NAMES = 20;

async function readableNames(actor: ActorCtx, nodes: Array<{ id: string; title: string }>): Promise<Array<{ id: string; title: string }>> {
  const named: Array<{ id: string; title: string }> = [];
  for (const node of nodes) {
    if (named.length >= PREVIEW_NAMES) break;
    if (await canReadRetainedNode(actor, node.id)) named.push(node);
  }
  return named;
}

interface PreviewResult {
  event_id: string;
  event_type: string;
  /** The entity the restore acts on. UI uses this to wire post-restore
   *  effects like the G5 cursor handoff (sessionStorage key by node id). */
  target_type: string;
  target_id: string;
  /** Type-specific preview payload. Shape varies per event_type. */
  preview:
    | { kind: "node_update"; current_title: string; current_body: string;
        restored_title: string; restored_body: string;
        can_apply_cleanly: boolean;
        cursor_state?: { anchor: number; head: number } }
    | NodeUndeletePreview
    | { kind: "node_delete"; title: string; currently_deleted: boolean;
        /** Live notes under it that are deleted with it (trashLive). */
        subtree_count: number }
    | RegisteredRestorePreview
    | AttributeRestorePreview
    | TagUpdatePreview;
}

export async function previewEventRestore(
  eventId: string,
  opts: Pick<RestoreOptions, "actor" | "workspaceId">,
): Promise<PreviewResult | RestoreError> {
  await loadRestoreHandlers();
  const evt = await pool.query<EventRow>(
    `SELECT id::text, workspace_id, event_type, target_type, target_id,
            payload, tx_meta, external
       FROM domain_events
      WHERE id = $1::bigint
        AND workspace_id = $2::uuid`,
    [eventId, opts.workspaceId],
  );
  const row = evt.rows[0] && asNodeEvent(await followIdRewrites(evt.rows[0]));
  if (!row) return { code: "not_found", status: 404, detail: `event ${eventId} not found` };
  // Preview surfaces the node's current + restored content, so it needs read
  // authority on the target (mirrors the restore write-gate, read op).
  // An unreadable target answers exactly like a missing event (no probe).
  if (row.target_type === "node") {
    try {
      await assertAuthority(opts.actor, { kind: "retained_node", nodeId: row.target_id, op: "read" });
    } catch (e) {
      if (e instanceof AuthorityError) return { code: "not_found", status: 404, detail: `event ${eventId} not found` };
      throw e;
    }
  }
  if (row.target_type === "tag") {
    // Schema history can contain policy. Use the same admin gate as the
    // corresponding write instead of introducing a historical read bypass.
    await authorizeRestore(opts.actor, row, false);
  }
  // The list rule (D33): preview refuses exactly what restore refuses up front.
  const blocked = restoreBlockedError(row);
  if (blocked) return blocked;

  const txMeta = row.tx_meta ?? {};

  // A version restore inverts like an edit (same restoreNodeUpdated path).
  if (row.event_type === "NODE_UPDATED" || row.event_type === "NODE_RESTORED") {
    const inversePatch = (txMeta.inverse_patch as string | undefined) ?? "";
    if (inversePatch === NO_INVERSE_PATCH) return noInversePatch;
    const prevFields = (txMeta.prev_field_values as Record<string, unknown> | undefined) ?? {};
    const node = await pool.query<NodeSnapshot>(
      `SELECT title, markdown, deleted_at, parent_id, hidden, order_key, presentation, node_type, source_type FROM content_nodes
        WHERE workspace_id = $1 AND id = $2`,
      [row.workspace_id, row.target_id],
    );
    if (!node.rows[0]) return { code: "target_gone", status: 410, detail: "node gone" };
    if (node.rows[0].deleted_at !== null) {
      return { code: "target_gone", status: 410, detail: "node is currently soft-deleted" };
    }
    const current = node.rows[0];
    const placed = await withoutStalePlace(row, current);
    const reverted = inversePatch
      ? await revertedBody(row, current.markdown ?? "", inversePatch)
      : { body: current.markdown ?? "", conflicts: 0 };
    if ("code" in reverted) return reverted;
    const unchanged = nodeUpdateChangesNothing(placed, current, reverted.body);
    if (unchanged) return unchanged;
    const restoredTitle = typeof prevFields.title === "string" ? (prevFields.title as string) : current.title;
    const cursorState = (txMeta.cursor_state as { anchor: number; head: number } | undefined) ?? undefined;
    return {
      event_id: row.id,
      event_type: row.event_type,
      target_type: row.target_type,
      target_id: row.target_id,
      preview: {
        kind: "node_update",
        current_title: current.title,
        current_body: current.markdown ?? "",
        restored_title: restoredTitle,
        restored_body: reverted.body,
        can_apply_cleanly: reverted.conflicts === 0 && conflictingNodeFields(placed, current).length === 0,
        ...(cursorState ? { cursor_state: cursorState } : {}),
      },
    };
  }

  // A merge's root inverse is undeleting the source tag node.
  if (row.event_type === "NODE_DELETED" || row.event_type === "TAG_MERGED") {
    const node = await pool.query<{ title: string; deleted_at: string | null }>(
      `SELECT title, deleted_at FROM content_nodes WHERE id = $1`, [row.target_id],
    );
    if (!node.rows[0]) return { code: "target_gone", status: 410, detail: "node gone" };
    const currentlyDeleted = node.rows[0].deleted_at !== null;
    const plan = currentlyDeleted ? await restorePlan(row.workspace_id, row.target_id) : { ancestors: [], subtree: [] };
    return {
      event_id: row.id, event_type: row.event_type, target_type: row.target_type, target_id: row.target_id,
      preview: {
        kind: "node_undelete", title: node.rows[0].title, currently_deleted: currentlyDeleted,
        ancestors: await readableNames(opts.actor, plan.ancestors), ancestor_count: plan.ancestors.length,
        subtree: await readableNames(opts.actor, plan.subtree), subtree_count: plan.subtree.length,
      },
    };
  }

  if (row.event_type === "NODE_UNDELETED" || row.event_type === "NODE_CREATED") {
    const node = await pool.query<{ title: string; deleted_at: string | null }>(
      `SELECT title, deleted_at FROM content_nodes WHERE id = $1`, [row.target_id],
    );
    if (!node.rows[0]) return { code: "target_gone", status: 410, detail: "node gone" };
    return {
      event_id: row.id, event_type: row.event_type, target_type: row.target_type, target_id: row.target_id,
      preview: {
        kind: "node_delete", title: node.rows[0].title, currently_deleted: node.rows[0].deleted_at !== null,
        subtree_count: node.rows[0].deleted_at !== null ? 0 : (await trashSubtreeIds(row.workspace_id, row.target_id)).length,
      },
    };
  }

  const handler = restoreHandlerFor(row.event_type);
  if (handler) {
    const preview = await handler.preview(row);
    if ("code" in preview) return preview;
    return {
      event_id: row.id, event_type: row.event_type, target_type: row.target_type, target_id: row.target_id,
      preview,
    };
  }

  if (row.event_type === "ATTRIBUTE_SET" || row.event_type === "ATTRIBUTE_DELETED" ||
      row.event_type === "TAG_UPDATED" || row.event_type === "TAG_SCHEMA_UPDATED") {
    const preview = row.event_type.startsWith("ATTRIBUTE_")
      ? await previewAttributeRestore(row)
      : await previewTagUpdate(row);
    if ("code" in preview) return preview;
    return {
      event_id: row.id, event_type: row.event_type, target_type: row.target_type, target_id: row.target_id,
      preview,
    };
  }

  return { code: "unsupported", status: 422, detail: `preview not implemented for ${row.event_type}` };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-event-type handlers
// ─────────────────────────────────────────────────────────────────────────

async function restoreNodeDeleted(row: EventRow, actorContext: ActorCtx): Promise<RestoreResult | RestoreError> {
  // Idempotency: refuse if the node is already live.
  const node = await q<{ deleted_at: string | null; title: string }>(
    `SELECT deleted_at, title FROM content_nodes
      WHERE workspace_id = $1 AND id = $2`,
    [row.workspace_id, row.target_id],
  );
  if (!node.rows[0]) {
    return { code: "target_gone", status: 410, detail: "node row no longer exists (possibly purged)" };
  }
  if (node.rows[0].deleted_at === null) {
    return { code: "already_in_state", status: 409, detail: "node is already not deleted" };
  }

  // Event + mutation in one transaction: the restore event and the state it
  // claims must commit together, else a failed UPDATE leaves "log says undone,
  // node still deleted". q() inside picks up the tx client (see db.ts).
  const restoreEventId = await mutateRestore({
    actor: actorContext,
    original: row,
    event: {
      type: "NODE_UNDELETED", targetType: "node", targetId: row.target_id,
      payload: { title: node.rows[0].title },
      txMeta: { inverse_op: "node.deleted" },
    },
    apply: async ({ eventId }) => {
      // The note comes back whole (D111): with what was deleted together with
      // it and with any deleted note above it, never as an orphan. Re-slugs when
      // another note took the slug meanwhile (scan P2 #31).
      await restoreLive(actorContext, row.workspace_id, row.target_id, { causeEventId: eventId, uiContext: "event.restore" });
      return eventId;
    },
  });
  return {
    restored: true,
    original_event_id: row.id,
    original_event_type: row.event_type,
    restore_event_id: restoreEventId,
    restore_event_type: "NODE_UNDELETED",
  };
}

async function restoreNodeUndeleted(row: EventRow, actorContext: ActorCtx): Promise<RestoreResult | RestoreError> {
  // Inverse of "node is live" is soft delete. Used for NODE_UNDELETED AND
  // NODE_CREATED (the create's inverse is to remove from view).
  const node = await q<{ deleted_at: string | null; title: string }>(
    `SELECT deleted_at, title FROM content_nodes
      WHERE workspace_id = $1 AND id = $2`,
    [row.workspace_id, row.target_id],
  );
  if (!node.rows[0]) {
    return { code: "target_gone", status: 410, detail: "node row no longer exists (possibly purged)" };
  }
  if (node.rows[0].deleted_at !== null) {
    return { code: "already_in_state", status: 409, detail: "node is already deleted" };
  }
  // Atomic event + soft-delete: the UPDATE also stamps deleted_by_event_id
  // with the restore event's own id, so both must land in the same tx.
  const restoreEventId = await mutateRestore({
    actor: actorContext,
    original: row,
    event: {
      type: "NODE_DELETED", targetType: "node", targetId: row.target_id,
      payload: { title: node.rows[0].title },
      txMeta: { inverse_op: "node.undeleted" },
    },
    apply: async ({ eventId }) => {
      // Like any delete, the live subtree goes with it (D111): undoing "created
      // P" also deletes a child written under P since, chained to this event, so
      // restoring this restore brings both back.
      await trashLive(actorContext, row.workspace_id, row.target_id, { causeEventId: eventId, uiContext: "event.restore" });
      return eventId;
    },
  });
  return {
    restored: true,
    original_event_id: row.id,
    original_event_type: row.event_type,
    restore_event_id: restoreEventId,
    restore_event_type: "NODE_DELETED",
  };
}

async function restoreNodeUpdated(
  row: EventRow,
  actorContext: ActorCtx,
  force: boolean,
): Promise<RestoreResult | RestoreError> {
  // tx_meta carries: inverse_patch (markdown delta) + prev_field_values
  // (literal title etc.). For markdown reverts we apply the patch on the
  // current body; for title we restore the literal prev_field_values.title.
  const txMeta = row.tx_meta ?? {};
  const inversePatch = (txMeta.inverse_patch as string | undefined) ?? "";
  if (inversePatch === NO_INVERSE_PATCH) return noInversePatch;
  // An event made before migration 200 recorded the place as the integer `sort_order`; it is turned into a key below.
  const { sort_order: legacyPlace, ...prevFields } = (txMeta.prev_field_values as Record<string, unknown> | undefined) ?? {};

  const unsupported = Object.keys(prevFields).filter((field) => !nodeScalarFields.includes(field as NodeScalarField));
  if (unsupported.length) {
    return { code: "unsupported", status: 422, detail: `node inverse contains unsupported fields: ${unsupported.join(", ")}` };
  }

  const node = await q<NodeSnapshot>(
    `SELECT title, markdown, slug, reserved_key, deleted_at, parent_id, hidden, order_key, presentation, node_type, source_type FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [row.workspace_id, row.target_id],
  );
  if (!node.rows[0]) {
    return { code: "target_gone", status: 410, detail: "node row no longer exists" };
  }
  if (node.rows[0].deleted_at !== null) {
    return {
      code: "target_gone",
      status: 410,
      detail: "node is currently soft-deleted; restore the node first",
    };
  }

  // Legacy NODE_UPDATED history can contain a tag identity transition. Undo
  // must not let an editor/agent activate or disable policies through history,
  // including force=true. Check actual current and inverse target identities.
  if ("node_type" in prevFields && prevFields.node_type !== node.rows[0].node_type &&
      (isTag(prevFields) || isTag(node.rows[0]))) {
    await assertAuthority(actorContext, { kind: "principal_admin" });
  }

  // Idempotency (M3): if THIS event was already restored in place — an in-place
  // restore emits a NODE_UPDATED on the same node carrying restored_from = this
  // event's id — re-running would merge the same undo again; any of its
  // lines edited since would read as conflicts, and force would overwrite
  // them. Treat a second restore as a no-op, mirroring the
  // deleted_at guard in restoreNodeDeleted/Undeleted. (restore-as-new targets a
  // NEW node id, so it never matches this same-target NODE_UPDATED probe.)
  const priorRestore = await q(
    `SELECT 1 FROM domain_events
      WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'NODE_UPDATED'
        AND tx_meta->>'restored_from' = $3 LIMIT 1`,
    [row.workspace_id, row.target_id, String(row.id)],
  );
  if (priorRestore.rows[0]) {
    return { code: "already_in_state", status: 409, detail: "this event was already restored" };
  }

  row = await withoutStalePlace(row, node.rows[0]);
  if (typeof prevFields.order_key === "string" && typeof (row.tx_meta?.prev_field_values as Record<string, unknown> | undefined)?.order_key !== "string") delete prevFields.order_key;

  const currentBody = node.rows[0].markdown ?? "";
  const currentTitle = node.rows[0].title;

  const conflicts = conflictingNodeFields(row, node.rows[0]);
  if (conflicts.length && !force) {
    return {
      code: "patch_conflict", status: 409,
      detail: `fields changed after this event: ${conflicts.join(", ")}; pass force=true to overwrite them`,
      force_available: true,
    };
  }

  let nextBody = currentBody;
  let overwroteLaterEdits = false;
  if (inversePatch) {
    const reverted = await revertedBody(row, currentBody, inversePatch);
    if ("code" in reverted) return reverted;
    if (reverted.conflicts > 0 && !force) {
      return {
        code: "patch_conflict",
        status: 409,
        detail: `${reverted.conflicts} part(s) of the body were edited again after this event; pass force=true to overwrite them with the pre-event text`,
        force_available: true,
      };
    }
    nextBody = reverted.body;
    overwroteLaterEdits = reverted.conflicts > 0;
  }
  const unchanged = nodeUpdateChangesNothing(row, node.rows[0], nextBody);
  if (unchanged) return unchanged;

  const nextTitle = typeof prevFields.title === "string" ? (prevFields.title as string) : currentTitle;
  // parent_id is a reversible scalar field too (a PATCH reparent / a tag-merge
  // child move stores it in prev_field_values). Without restoring it, undoing a
  // reparent left the node where it was moved TO — e.g. a merged tag's children
  // stayed orphaned on the target after the merge was undone (M8).
  const currentParentId = node.rows[0].parent_id;
  const hasPrevParent = "parent_id" in prevFields;
  const nextParentId = hasPrevParent ? (prevFields.parent_id as string | null) : currentParentId;
  // The place it had: its own key when that is free among the siblings now, else a fresh key just before the one that
  // took it (never two rows on one key, never a move of anyone else); an old integer is translated.
  if (typeof prevFields.order_key === "string") {
    prevFields.order_key = await keyForRestore("content_nodes", row.workspace_id, nextParentId, row.target_id, prevFields.order_key);
  } else if (typeof legacyPlace === "number" && Object.keys(prevFields).length > 0) {
    prevFields.order_key = await translateLegacySortOrder("content_nodes", row.workspace_id, nextParentId, row.target_id, legacyPlace);
  }

  if (hasPrevParent && nextParentId !== currentParentId) {
    // Putting the node back under its previous parent is a move like any
    // other (nodeTree.assertReparent, D102): the tree's rules hold at undo
    // time too, with force or not. A refusal is a state conflict, its
    // specific code kept as `reason`; a parent that is gone is target_gone.
    const refusal = await reparentRefusal(row.workspace_id, {
      id: row.target_id,
      node_type: typeof prevFields.node_type === "string" ? prevFields.node_type : String(node.rows[0].node_type),
      title: nextTitle,
      parent_id: currentParentId,
    }, nextParentId, actorContext);
    if (refusal) return refusal;
  }

  // A tag back under its old name must still be unique among its siblings
  // (tagHierarchy.ts): the unique index would otherwise answer a 500.
  if (isTag(node.rows[0]) && ("title" in prevFields || (hasPrevParent && nextParentId !== currentParentId))) {
    try {
      await assertTagNameAvailable(row.workspace_id, row.target_id, { title: nextTitle, parentId: nextParentId });
    } catch (error) {
      if (!(error instanceof TagNameConflictError)) throw error;
      return { code: "state_conflict", status: 409, force_available: false, reason: "tag_name_conflict",
        detail: "another tag now has this name; rename one of them first" };
    }
  }

  // events->hash->blobs: when the body is reverted, content-address it and
  // carry body_hash (not raw markdown) so this restore is a real version
  // pointing into the blob store, like every other body-changing event.
  // Same rule as a normal save (nodeUpdate.ts): the text or the title moving makes
  // a version, and point-in-time reads take the title from the latest version event.
  const bodyHash = inversePatch || "title" in prevFields ? await putBlob(nextBody) : null;
  // Undoing a node_type change moves a readable set (under spaces only a
  // node_type revert does: a tag definition is readable by every member, a note
  // only in its space; a reparent stays inside its space), so mutate bumps the
  // membership epoch in this transaction. Version restores (NODE_RESTORED) stay
  // as they were: their inverse never carried it.
  const affectsMembership = row.event_type === "NODE_UPDATED" && "node_type" in prevFields;
  const restoreEventId = await mutateRestore({
    actor: actorContext,
    original: row,
    affectsMembership,
    event: {
      type: "NODE_UPDATED", targetType: "node", targetId: row.target_id,
      // Emit only the fields actually being restored so downstream consumers
      // (sync, dispatcher) don't think unrelated fields changed.
      payload: {
        ...(bodyHash ? { body_hash: bodyHash } : {}),
        ...(node.rows[0].node_type === "content" ? { title: nextTitle } : {}),
        ...prevFields,
      },
      txMeta: {
        // Re-make inverse_patch so the restore itself can be reverted:
        // applied on the post-restore body (nextBody) it gets back to
        // currentBody. Same maker as every other body edit, so an emoji
        // change gets the same encodable fallback instead of a 500.
        inverse_patch: inversePatch ? makeInversePatch(currentBody, nextBody) : "",
        prev_field_values: Object.fromEntries(Object.keys(prevFields).map((field) => [field, node.rows[0][field as NodeScalarField]])),
        ...(overwroteLaterEdits ? { overwrote_later_edits: true } : {}),
      },
    },
    apply: async ({ eventId }) => {
      // The same write as a save of these values (nodeUpdate.applyNodeColumns).
      // The slug follows the restored title: the event never recorded the slug,
      // and a title back over a later one's slug made a second note of that
      // name link both. Named for the node_type the undo leaves.
      const columns: NodeColumns = Object.fromEntries(nodeScalarFields.filter((field) => field in prevFields).map((field) => [field, prevFields[field]]));
      if ("title" in prevFields) {
        const slugNode = { id: row.target_id, node_type: String(columns.node_type ?? node.rows[0].node_type), slug: node.rows[0].slug, reserved_key: node.rows[0].reserved_key };
        columns.slug = await slugForTitle(row.workspace_id, slugNode, nextTitle);
      }
      if (inversePatch) columns.markdown = nextBody;
      await applyNodeColumns(row.workspace_id, row.target_id, columns, {
        before: { isTag: isTag(node.rows[0]), parentId: currentParentId },
        touchUpdatedAt: true,
        actor: actorContext,
      });
      // The undo is a new version of the note (spine/noteVersions.ts), naming the version it puts back when this node knows it. An undo
      // that writes back what the note already holds still records its event, but no new version (review round 2, point 10).
      if (bodyHash && (nextBody !== currentBody || nextTitle !== currentTitle)) {
        await recordVersion({
          workspaceId: row.workspace_id, noteId: row.target_id, unit: "body", contentHash: bodyHash, kind: "updated", title: nextTitle,
          restoredFrom: await versionBeforeEvent(row.target_id, "body", String(row.id), bodyHash),
        });
      }
      // Undoing a hide or show moves who may see the note (the website).
      if ("hidden" in prevFields) {
        await nodeVisibilityCommitted({ workspaceId: row.workspace_id, actor: actorContext, nodeIds: [row.target_id] });
      }
      if (inversePatch || "title" in prevFields) {
        // Undoing an edit is a body change: backlinks, block ids, embeddings,
        // inline attributes and the backup follow the restored text, exactly as
        // after an edit (services/bodySideEffects.ts).
        await applyBodyChange({
          workspaceId: row.workspace_id, nodeId: row.target_id, title: nextTitle, markdown: nextBody, previousMarkdown: currentBody,
          renamed: "title" in prevFields,
          eventId, actor: actorContext, cascadeLabel: "event.restore.cascade", backupPrefix: "RESTORE NODE_UPDATED",
        });
      } else {
        // Only placement or presentation changed; still re-converge the backup.
        await enqueueBackup({
          workspaceId: row.workspace_id, nodeId: row.target_id, markdown: nextBody,
          message: `RESTORE NODE_UPDATED: ${nextTitle}`, triggeredByEventId: eventId,
        });
      }
      return eventId;
    },
  });

  return {
    restored: true,
    original_event_id: row.id,
    original_event_type: row.event_type,
    restore_event_id: restoreEventId,
    restore_event_type: "NODE_UPDATED",
    ...(overwroteLaterEdits ? { overwrote_later_edits: true } : {}),
  };
}

// G4: restore-as-new-node. Joplin's RevisionService.restoreNoteById
// creates the restored content as a NEW note instead of overwriting the
// live one (RevisionService.ts:280-307). Onden's twist: title is
// prefixed with "[Restored]" so the user can find it after the fact.
// The live node is untouched — no patch_conflict concern, no force flag.
async function restoreNodeUpdatedAsNew(
  row: EventRow,
  actor: ActorCtx,
): Promise<RestoreResult | RestoreError> {
  const txMeta = row.tx_meta ?? {};
  const inversePatch = (txMeta.inverse_patch as string | undefined) ?? "";
  if (inversePatch === NO_INVERSE_PATCH) return noInversePatch;
  const prevFields = (txMeta.prev_field_values as Record<string, unknown> | undefined) ?? {};

  const node = await q<{ id: string }>(
    `SELECT id FROM content_nodes
      WHERE workspace_id = $1 AND id = $2`,
    [row.workspace_id, row.target_id],
  );
  if (!node.rows[0]) {
    return { code: "target_gone", status: 410, detail: "source node no longer exists" };
  }
  // Soft-deleted source is OK; duplicateNote reads its retained policy and
  // current parent/tags under the same event lock before creating anything.
  // Reconstruct against THIS event's post-edit blob. Applying the inverse to
  // today's body would silently mix later edits into an alleged old version.
  // An event that changed no text (a move, a hidden flag, a page design) carries
  // no body_hash: the text it left is the one the note's last save before it left.
  const own = row.payload.body_hash;
  const hash = typeof own === "string" && own ? own : (await q<{ hash: string | null }>(
    `SELECT ${lastBodyHashBeforeSql("$1", "$2", { eventId: "$3::bigint" })} AS hash`,
    [row.workspace_id, row.target_id, row.id],
  )).rows[0]?.hash;
  if (!hash) {
    return historyIncomplete("historical body snapshot is unavailable");
  }
  const body = (await q<{ content: string }>("SELECT content FROM blobs WHERE hash=$1", [hash])).rows[0];
  const restoredBody = body ? rebuildPreEventBody(body.content, inversePatch) : null;
  if (restoredBody === null) {
    return historyIncomplete("historical body cannot be reconstructed");
  }
  const originalTitle = typeof prevFields.title === "string" ? prevFields.title
    : typeof row.payload.title === "string" ? row.payload.title : null;
  if (originalTitle === null) {
    return historyIncomplete("historical title is unavailable");
  }
  const newTitle = `[Restored] ${originalTitle}`;

  let result: Awaited<ReturnType<typeof duplicateNote>>;
  try {
    result = await duplicateNote({ workspaceId: row.workspace_id, actor, sourceId: row.target_id,
      historical: { title: newTitle, markdown: restoredBody, eventId: row.id } });
  } catch (error) {
    if (!(error instanceof NoteDuplicateError)) throw error;
    if (error.status === 404) return { code: "target_gone", status: 410, detail: error.message };
    if (error.status === 422) return { code: "unsupported", status: 422, detail: error.message };
    return stateConflict(error.message);
  }

  return {
    restored: true,
    original_event_id: row.id,
    original_event_type: row.event_type,
    restore_event_id: result.eventId,
    restore_event_type: "NODE_CREATED",
    new_node_id: result.node.id as string,
    new_node_slug: result.node.slug as string,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────

/** Why undoing a move may not put `node` back under `previousParentId`, as
 *  the restore answer, or null when it may. The rules are every move's
 *  (nodeTree.assertReparent); a refusal is a state conflict (not force-able:
 *  the tree changed since) with the rule's own code as `reason`. A previous
 *  parent that is gone or unreadable is target_gone. Authority errors (an
 *  unwritable parent) propagate like every restore's. */
async function reparentRefusal(
  workspaceId: string, node: ReparentNode, previousParentId: string | null, actor: ActorCtx,
): Promise<RestoreError | null> {
  const conflict = (reason: string, detail: string): RestoreError =>
    ({ code: "state_conflict", status: 409, force_available: false, reason, detail });
  try {
    await assertReparent(workspaceId, node, previousParentId, actor);
    return null;
  } catch (error) {
    if (error instanceof ReparentError) {
      if (error.code === "parent_not_found") return { code: "target_gone", status: 410, detail: "the previous parent no longer exists" };
      if (error.code === "parent_cycle") return conflict(error.code, "restoring the previous parent would create a cycle");
      return conflict(error.code, "the previous parent is now in another space; move the note to that space first");
    }
    if (error instanceof ParentKindError || error instanceof ModuleTagParentError) return conflict(error.code, `the previous parent cannot hold it now: ${error.message}`);
    if (error instanceof TagNameConflictError) {
      return conflict("tag_name_conflict", "a tag with this name is now under the previous parent; rename one first");
    }
    if (error instanceof FieldNameClashError) return conflict(error.code, error.message);
    throw error;
  }
}

// Inverse of a space move: move the note (and its subtree) back to the space
// it came from, re-attaching it under its old parent when that parent is
// still there. Goes through moveToSpace itself, so the same rights apply at
// undo time (an editor cannot "undo" a colleague's move into their own
// private space) and the membership epoch is bumped there.
async function restoreNodeMovedSpace(row: EventRow, actor: ActorCtx): Promise<RestoreResult | RestoreError> {
  const prev = (row.tx_meta as { prev_field_values?: { space_id?: string; parent_id?: string | null } } | null)?.prev_field_values;
  if (!prev?.space_id) return historyIncomplete("the move did not record its source space");
  const current = await q<{ space_id: string | null }>(`SELECT space_id::text FROM content_nodes WHERE id = $1 AND ${liveNodeSql()}`, [row.target_id]);
  if (!current.rows[0]) return { code: "target_gone", status: 410, detail: "the note is no longer live" };
  if (current.rows[0].space_id === prev.space_id) return { code: "already_in_state", status: 409, detail: "the note is already back in that space" };
  try {
    const r = await moveToSpace(actor, row.workspace_id, row.target_id, prev.space_id, null,
      { reattachTo: prev.parent_id ?? null, triggeredBy: row.id });
    return {
      restored: true, original_event_id: row.id, original_event_type: row.event_type,
      restore_event_id: r.event_id, restore_event_type: "NODE_MOVED_SPACE",
    };
  } catch (e) {
    if (e instanceof SpaceMoveError) return stateConflict(e.message);
    throw e;
  }
}
