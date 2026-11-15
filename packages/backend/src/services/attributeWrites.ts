// Setting one node attribute as a domain operation.
//
// PUT /api/nodes/:id/attributes/:key and node creation with initial
// attributes share this: reserved-key rule, schema field validation, the
// overwritten-state snapshot, conflict record, ATTRIBUTE_SET event and tag
// behaviour dispatch. Callers do not assemble any of these.
//
// A drawing (ink_data) is not last-writer-wins when its writer says what it
// was made from (`base_value`): the save is merged into what another device
// stored meanwhile (@onden/markdown/ink mergeInk), so an offline tablet's
// replay keeps the laptop's strokes. Only an item both sides changed is
// recorded as an ATTRIBUTE_CONFLICT.
//
// The text boxes on a page (page_text) and the pictures on it (page_images)
// merge the same way, per box / per picture (@onden/markdown/page-text
// mergePageText, page-images mergePageImages); one both sides changed is the
// conflict. Typing, pictures and drawing are separate keys, so they never meet.
//
// A conflict is reverted here too (revertAttributeConflict, the inbox's
// Revert): a drawing gets back only the items both sides changed, merged into
// the drawing as it is now; any other key its overridden value and type.

import { event, q } from "../db.js";
import { currentStampWall } from "../spine/stamps.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import { encodeSnapshot, type AttributeState } from "./eventLog/index.js";
import { canReadNode } from "./readPolicy.js";
import type { AttributeSource } from "../spine/attributeSource.js";
import { recordAttributeChange, AttributeWriteError } from "./attributeChange.js";
import { PUBLISHED_KEY, isValidSystemAttributeValue, isWritableAttributeKey } from "./systemAttributes.js";
import { requirePerson } from "../spine/authority.js";
import { dropParentSiteDefaultMark } from "./siteDefault.js";
import { nodeAttributeWriting } from "../spine/nodeHooks.js";
import { resolvePatched } from "./patchedValue.js";

import { INK_PAGE_ATTRS, type AttributeValueType } from "@onden/markdown";
import { mergeInk, revertInkConflicts, type InkMergeConflict } from "@onden/markdown/ink";
import { mergePageImages, revertPageImagesConflicts, type PageImagesConflict } from "@onden/markdown/page-images";
import { mergePageText, revertPageTextConflicts, type PageTextConflict } from "@onden/markdown/page-text";

export type { AttributeValueType } from "@onden/markdown";

export type AttributeInput = {
  key: string;
  value: string | number | boolean | null;
  /** The writer's guess; a schema field's own type wins (attributeChange.ts). */
  value_type?: AttributeValueType;
  is_inheritable?: boolean;
  /** When the client made the edit, on its own clock (propertyWriter sends the
   *  edit time, not a server updated_at it saw: the local mirror has none). Only
   *  recorded and shown with a conflict: which of two values is newer is never
   *  decided by this clock (see client_edit_age_ms). */
  client_updated_at?: string;
  /** How long before this request the client made the edit, from the client's
   *  own clock (clientClock.ts editAgeMs, so its offset cancels). The edit is
   *  dated on this write's logical clock minus that age; a stored value newer
   *  than that is recorded as an ATTRIBUTE_CONFLICT (last write still wins).
   *  Left out: nothing says the edit is old, so no conflict is recorded.
   *  Ignored when `base_value` merges the write. */
  client_edit_age_ms?: number;
  /** For a mergeable key (MERGED_KEYS): the value the writer's edit was made
   *  from ("" = none). A stored value that differs is merged with the
   *  incoming one instead of overwritten. */
  base_value?: string;
};

/** The keys of a page's layers (the text boxes, the pictures): each merges per
 *  item by id, and says what both sides changed in its own field of the
 *  conflict record / API answer. */
const PAGE_LAYERS = {
  page_text: { field: "page_text_conflicts", merge: mergePageText, revert: revertPageTextConflicts },
  page_images: { field: "page_images_conflicts", merge: mergePageImages, revert: revertPageImagesConflicts },
} as const;
type PageLayerKey = keyof typeof PAGE_LAYERS;
const isPageLayerKey = (key: string): key is PageLayerKey => Object.hasOwn(PAGE_LAYERS, key);

/** Keys whose writes merge with a concurrent stored value when the writer
 *  sends its base: a note's drawing — a page, or a PDF's envelope with its
 *  highlight records (the legacy pdf_annotations key is read-only since W20) —
 *  and the text boxes and pictures on its pages. */
export const MERGED_KEYS: ReadonlySet<string> = new Set([...INK_PAGE_ATTRS, ...Object.keys(PAGE_LAYERS)]);

/** What a merge reports as changed on both sides, and the field of the
 *  ATTRIBUTE_CONFLICT record / API answer that carries it. */
type MergeConflicts =
  | { field: "ink_conflicts"; items: InkMergeConflict[] }
  | { field: (typeof PAGE_LAYERS)[PageLayerKey]["field"]; items: Array<PageTextConflict | PageImagesConflict> };

function mergeAttribute(key: string, base: string, stored: string, incoming: string): { value: string; conflicts: MergeConflicts } {
  if (isPageLayerKey(key)) {
    const layer = PAGE_LAYERS[key];
    const merged = layer.merge(base, stored, incoming);
    return { value: merged.value, conflicts: { field: layer.field, items: merged.conflicts } };
  }
  const merged = mergeInk(base, stored, incoming);
  return { value: merged.value, conflicts: { field: "ink_conflicts", items: merged.conflicts } };
}

export type AttributeConflict = {
  previous_value: string; server_updated_at: string; client_updated_at: string;
  /** A merged drawing: the items both sides changed (the incoming side's kept). */
  ink_conflicts?: InkMergeConflict[];
  /** Merged text boxes: the boxes both sides changed (the incoming side's kept). */
  page_text_conflicts?: PageTextConflict[];
  /** Merged pictures: the ones both sides changed (the incoming side's kept). */
  page_images_conflicts?: PageImagesConflict[];
};

export type AttributeWriteResult = {
  key: string;
  value: string;
  value_type: AttributeValueType;
  is_inheritable: boolean;
  source: AttributeSource;
  conflict: AttributeConflict | null;
};

export { AttributeWriteError } from "./attributeChange.js";

/** Reserved keys are derived/internal and not user-editable — except the
 *  ones the note menu writes (services/systemAttributes.ts). */
function assertWritableAttributeKey(key: string): void {
  if (!isWritableAttributeKey(key)) throw new AttributeWriteError(400, "reserved key");
}

/** What is on the website is its owner's to decide (docs/agents/agent-delegation.md: an agent has no publish tool).
 *  A connection that came in with a token (an AI role, an external agent) may therefore not set or clear the publish
 *  mark, whichever tool or route hands the attribute over — createNode's `attributes` reached this unchecked. */
export function assertActorMayWriteAttributeKey(actor: ActorCtx, key: string): void {
  if (key === PUBLISHED_KEY) requirePerson(actor, "publish_mark");
}

/** Set (create or overwrite) one attribute under the node's `set_attribute`
 *  authority. Validates against a declared schema field when the key is one;
 *  other keys stay free-form. Runs in its own event transaction, or joins the
 *  caller's (then it commits or rolls back with that transaction).
 *  Modules hear about the change once the root transaction commits
 *  (recordAttributeChange fires nodeAttributeCommitted). Use: await setNodeAttribute({ workspaceId, actor, nodeId, attribute }). */
export async function setNodeAttribute(input: {
  workspaceId: string;
  actor: ActorCtx;
  nodeId: string;
  attribute: AttributeInput;
  /** The value as a patch against the text it was made from (@onden/markdown
   *  textPatch) instead of `attribute.value` + `base_value`; that text is the
   *  merge base. Only for a MERGED_KEY; resolved under the row lock below
   *  (services/patchedValue.ts). */
  valuePatch?: unknown;
  triggeredBy?: string;
  /** The attribute already exists elsewhere under this key (a backup's copy of
   *  one stored before the key grammar, such as a CSV column "Due Date"):
   *  bringing it back is not adding a new odd key, so the grammar check is
   *  skipped, as it is for a key the node already has. */
  existingKey?: boolean;
}): Promise<AttributeWriteResult> {
  const { workspaceId, actor, nodeId, valuePatch } = input;
  const { key, client_updated_at, client_edit_age_ms } = input.attribute;
  assertWritableAttributeKey(key);
  assertActorMayWriteAttributeKey(actor, key);
  const patched = valuePatch !== undefined;
  if (patched && !MERGED_KEYS.has(key)) throw new AttributeWriteError(400, "invalid_patch", `${key} is not saved as a patch`);
  let incomingValue = input.attribute.value == null ? "" : String(input.attribute.value);
  let base_value = input.attribute.base_value;
  if (!patched && !isValidSystemAttributeValue(key, incomingValue)) throw new AttributeWriteError(400, "invalid_value", `invalid value for ${key}`);
  const source: AttributeSource = actor.type === "human" ? "ui" : "dispatcher";
  const merging = (base_value !== undefined || patched) && MERGED_KEYS.has(key);

  return withEventTransaction(workspaceId, async () => {
    // The stored value, locked until this transaction ends (recordAttributeChange
    // locks the same row again): what the merge combines with is what the
    // write replaces. Unchanged since the writer's base (or already equal to
    // the incoming value), the incoming value is stored as sent.
    let stringValue = incomingValue;
    let mergeConflicts: MergeConflicts | null = null;
    if (merging) {
      const stored = (await q<{ value: string }>(
        `SELECT value FROM node_attributes WHERE workspace_id = $1 AND node_id = $2 AND key = $3 FOR UPDATE`,
        [workspaceId, nodeId, key],
      )).rows[0]?.value ?? null;
      if (patched) {
        ({ incoming: incomingValue, base: base_value } = await resolvePatched(workspaceId, nodeId, stored, valuePatch));
        stringValue = incomingValue;
        if (!isValidSystemAttributeValue(key, incomingValue)) throw new AttributeWriteError(400, "invalid_value", `invalid value for ${key}`);
      }
      if (stored !== null && stored !== (base_value ?? "") && stored !== incomingValue) {
        const merged = mergeAttribute(key, base_value ?? "", stored, incomingValue);
        stringValue = merged.value;
        mergeConflicts = merged.conflicts;
      }
    }
    // A module's rule on its key (a unique key), under the same lock
    // as the write: two writes of one key serialize, the second is refused.
    await nodeAttributeWriting({ workspaceId, nodeId, key, value: stringValue, actor });
    // services/attributeChange.ts: the row, its snapshots and ATTRIBUTE_SET,
    // validated inside the transaction so a node created in this same
    // transaction (with its tags) is seen with its schema fields.
    let conflict: AttributeConflict | null = null;
    let value_type: AttributeValueType = "text";
    let is_inheritable = false;
    await recordAttributeChange({
      workspaceId, nodeId, key, actor,
      next: { value: stringValue, value_type: input.attribute.value_type, is_inheritable: input.attribute.is_inheritable, source },
      rule: "always",
      validate: true,
      keepStoredKey: input.existingKey,
      authority: { kind: "node", nodeId, op: "set_attribute" },
      uiContext: "node.attribute.set",
      triggeredBy: input.triggeredBy,
      within: async ({ eventId, previous, previousUpdatedAt: updatedAt, row, previousStampWall }) => {
        value_type = row!.value_type as AttributeValueType; // as stored: the field's type, else the hint
        is_inheritable = row!.is_inheritable; // as stored: the sent flag, else the row's own
        if (key === PUBLISHED_KEY) await dropParentSiteDefaultMark(workspaceId, nodeId, actor);
        // LWW still accepts the incoming value; a newer stored one the client
        // had not seen is recorded. A merged drawing is recorded only when
        // both sides changed the same item (incoming_value is what was stored:
        // the merge). The record is genuine non-actor automation (detected by
        // the server), so it stays a raw event with actor_type='system',
        // linked triggered_by the ATTRIBUTE_SET.
        // Both sides are read off the logical clock: the stored side is the replaced value's own stamp (previousStampWall);
        // the edit's side is this write's stamp minus the edit's age. The database's now() (updated_at) is not used here:
        // once a stamp from another node has pushed the logical clock ahead of real time, comparing the two clocks
        // under-recorded conflicts. The later of the two is used: updated_at is real time, never ahead of the logical clock, so
        // it adds nothing while the stamp is current, and covers a value changed by a source that leaves no stamp (text-produced,
        // derived) or a row written before stamps.
        const overlooked = merging
          ? (mergeConflicts?.items.length ?? 0) > 0
          : client_edit_age_ms !== undefined && !!updatedAt
            && Math.max(previousStampWall ?? 0, new Date(updatedAt).getTime()) - ((await currentStampWall(workspaceId) ?? Date.now()) - client_edit_age_ms) > 500;
        if (previous && row && updatedAt && overlooked) {
          const seen = client_updated_at ?? "";
          conflict = {
            previous_value: previous.value, server_updated_at: updatedAt, client_updated_at: seen,
            ...(merging && mergeConflicts ? { [mergeConflicts.field]: mergeConflicts.items } : {}),
          };
          await event(
            workspaceId, "ATTRIBUTE_CONFLICT", "node", nodeId,
            {
              ...await conflictRecord(key, row, previous),
              server_updated_at: updatedAt, client_updated_at: seen, actor_id: actor.id,
              ...(merging && mergeConflicts ? { [mergeConflicts.field]: mergeConflicts.items } : {}),
            },
            "system", actor.id, { triggeredBy: eventId },
          );
        }
      },
    });
    return { key, value: stringValue, value_type, is_inheritable, source, conflict };
  });
}

// ── Attribute conflicts: the record and its revert ──────────────────────────

/** An ATTRIBUTE_CONFLICT's two values: `incoming` (what the write stored —
 *  for a drawing, the merge) and `overridden` (what it replaced), each with
 *  its stored type. A value is inline (`incoming_value`), or for a drawing a
 *  blob reference (`incoming_value_ref` + `_len`, eventLog encodeSnapshot):
 *  the inbox polls these events every few seconds and must never download two
 *  drawings each time. The blob GC keeps what they reference
 *  (maintenance/prune.ts). */
async function conflictRecord(key: string, incoming: AttributeState, overridden: AttributeState): Promise<Record<string, unknown>> {
  const side = async (name: "incoming" | "overridden", state: AttributeState) => {
    const snapshot = await encodeSnapshot(key, state);
    return "value_ref" in snapshot
      ? { [`${name}_value_ref`]: snapshot.value_ref, [`${name}_value_len`]: snapshot.value_len }
      : { [`${name}_value`]: snapshot.value };
  };
  return {
    key, value_type: incoming.value_type, overridden_value_type: overridden.value_type,
    ...await side("incoming", incoming), ...await side("overridden", overridden),
  };
}

/** One side's value as the record holds it (records before D90: inline). */
async function recordedValue(payload: Record<string, unknown>, name: "incoming" | "overridden"): Promise<string> {
  const ref = payload[`${name}_value_ref`];
  const inline = payload[`${name}_value`];
  if (typeof ref === "string") {
    const blob = await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [ref]);
    if (blob.rows[0]) return blob.rows[0].content;
  } else if (typeof inline === "string") {
    return inline;
  }
  throw new AttributeWriteError(409, "history_incomplete", "this conflict no longer has the values it recorded");
}

/** Revert what an ATTRIBUTE_CONFLICT overrode, as a new attribute write by
 *  `actor`: the note's set_attribute authority, an ATTRIBUTE_SET event, the
 *  attribute's inheritance flag kept; a retry with the request's idempotency
 *  key applies once.
 *   - A drawing (MERGED_KEYS) gets back only the items both sides changed
 *     (@onden/markdown/ink revertInkConflicts), merged into the drawing as it
 *     is now with the recorded merge as base: strokes either device drew,
 *     then or since, stay. A record without the item list (before D88) takes
 *     back the whole overridden drawing, still merged into today's.
 *   - Any other key gets the overridden value back with its recorded type (a
 *     number stays a number), only while the attribute still holds the value
 *     the conflict left. Edited or removed since → 409 attribute_changed, and
 *     that edit is kept.
 *  404 not_found when the event is not an attribute conflict on a note the
 *  actor can read; 409 history_incomplete when its values are gone.
 *  Use: await revertAttributeConflict({ workspaceId, actor, eventId }). */
export async function revertAttributeConflict(input: {
  workspaceId: string;
  actor: ActorCtx;
  eventId: string;
}): Promise<AttributeWriteResult> {
  const { workspaceId, actor, eventId } = input;
  const found = (await q<{ target_type: string; target_id: string; payload: Record<string, unknown> }>(
    `SELECT target_type, target_id, payload FROM domain_events
      WHERE workspace_id = $1 AND id = $2::bigint AND event_type = 'ATTRIBUTE_CONFLICT'`,
    [workspaceId, eventId],
  )).rows[0];
  const key = found?.payload.key;
  if (!found || found.target_type !== "node" || typeof key !== "string" || !(await canReadNode(actor, found.target_id))) {
    throw new AttributeWriteError(404, "not_found", "no such attribute conflict");
  }
  const nodeId = found.target_id;
  const incoming = await recordedValue(found.payload, "incoming");
  const overridden = await recordedValue(found.payload, "overridden");

  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    // Claimed first: a retry of a revert that committed is answered as a
    // replay, not refused because the attribute no longer holds `incoming`.
    await claim();
    const current = (await q<AttributeState>(
      `SELECT value, value_type, is_inheritable, source FROM node_attributes
        WHERE workspace_id = $1 AND node_id = $2 AND key = $3 FOR UPDATE`,
      [workspaceId, nodeId, key],
    )).rows[0];
    if (!current) throw new AttributeWriteError(409, "attribute_changed", `${key} was removed after this conflict`);
    const keep = { key, is_inheritable: current.is_inheritable };
    if (isPageLayerKey(key)) {
      const layer = PAGE_LAYERS[key];
      const recorded = found.payload[layer.field];
      const items = Array.isArray(recorded) ? recorded as PageTextConflict[] & PageImagesConflict[] : [];
      const value = layer.revert(incoming, overridden, items);
      return setNodeAttribute({ workspaceId, actor, nodeId, attribute: { ...keep, value, base_value: incoming } });
    }
    if (MERGED_KEYS.has(key)) {
      const recorded = found.payload.ink_conflicts;
      const items: InkMergeConflict[] = Array.isArray(recorded) ? recorded as InkMergeConflict[] : [{ kind: "format" }];
      const value = revertInkConflicts(incoming, overridden, items);
      return setNodeAttribute({ workspaceId, actor, nodeId, attribute: { ...keep, value, base_value: incoming } });
    }
    if (current.value !== incoming) {
      throw new AttributeWriteError(409, "attribute_changed", `${key} was changed after this conflict; that change was kept`);
    }
    const recordedType = found.payload.overridden_value_type;
    return setNodeAttribute({
      workspaceId, actor, nodeId,
      attribute: {
        ...keep, value: overridden,
        // Older records have no type: the key's stored type then (attributeChange).
        ...(typeof recordedType === "string" ? { value_type: recordedType as AttributeValueType } : {}),
      },
    });
  }));
}
