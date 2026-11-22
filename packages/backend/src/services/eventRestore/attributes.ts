import { normalize, type AttributeValueType } from "@onden/markdown";
import { attributeEventType, storeAttributeState } from "../attributeChange.js";
import { fieldForKey } from "../schemaValidation.js";
import { isModuleOwnedAttributeKey } from "../systemAttributes.js";
import { nodeAttributeCommitted } from "../nodeCommits.js";
import type { ActorCtx } from "../../types.js";
import { q } from "../../db.js";
import { encodeSnapshot, type AttributeState, type SnapshotScope } from "../eventLog/index.js";
import { readInkValue } from "../inkChunks.js";
import type { EventRow, RestoreError, RestoreResult } from "../restoreContract.js";
import { recordRestore, requireRestoreTransaction } from "./record.js";
import { historyIncomplete } from "./refusals.js";
import { isVersionedInkKey, recordVersion, versionBeforeEvent } from "../../spine/noteVersions.js";

export type AttributeRestorePreview = {
  kind: "attribute_change";
  key: string;
  current_value: string | null;
  restored_value: string | null;
  action: "delete" | "set";
  current_metadata: Omit<AttributeState, "value"> | null;
  restored_metadata: Omit<AttributeState, "value"> | null;
  can_apply_cleanly: boolean;
  force_available: false;
  reason?: string;
  conflict_code?: "state_conflict" | "history_incomplete" | "already_in_state";
};

const scopeOf = (row: EventRow): SnapshotScope => ({ workspaceId: row.workspace_id, nodeId: row.target_id });

const valueTypes = new Set(["text", "number", "date", "bool", "node_ref"]);
const sources = new Set(["ui", "markdown", "frontmatter", "dispatcher", "explicit", "derived"]);

/** Missing fields are unknown history, not database defaults. In particular,
 * source controls whether a later derived write may replace this value.
 */
async function decodeSnapshot(raw: unknown, scope: SnapshotScope): Promise<{ state: AttributeState | null } | RestoreError> {
  if (raw === null) return { state: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return historyIncomplete("attribute history has no complete snapshot");
  const snapshot = raw as Record<string, unknown>;
  // The earlier writers encoded an absent row as {value:null}. Empty string
  // is a real value and must never be interpreted as absence.
  if (snapshot.value === null && snapshot.value_ref == null) return { state: null };
  if (typeof snapshot.value_type !== "string" || !valueTypes.has(snapshot.value_type) ||
      typeof snapshot.is_inheritable !== "boolean" ||
      typeof snapshot.source !== "string" || !sources.has(snapshot.source)) {
    return historyIncomplete("attribute history is missing its value type, inheritance flag, or source");
  }

  let value: string;
  if (typeof snapshot.value_ref === "string" && snapshot.value_ref) {
    const stored = await readInkValue(scope.workspaceId, scope.nodeId, snapshot.value_ref);
    if (stored === null) return historyIncomplete("the attribute history blob is unavailable");
    value = stored;
    if (typeof snapshot.value === "string" && snapshot.value !== value) return historyIncomplete("attribute history has inconsistent inline and blob values");
  } else if (typeof snapshot.value === "string" && snapshot.value_ref == null) {
    value = snapshot.value;
  } else {
    return historyIncomplete("attribute history is missing its value");
  }
  return { state: { value, value_type: snapshot.value_type, is_inheritable: snapshot.is_inheritable, source: snapshot.source } };
}

/** Compares complete states. Callers compare states typed by `typing` below,
 *  never raw rows. */
function equalState(a: AttributeState | null, b: AttributeState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.value === b.value && a.value_type === b.value_type &&
    a.is_inheritable === b.is_inheritable && a.source === b.source;
}

/** Types a recorded or current state by the value rule as of now
 *  (@onden/markdown attributeValue), with the recorded type as the hint. A
 *  key a schema field governs collapses to the field's type, so a row retyped
 *  by the rule (migration 105, a tag's field type) is still the state the
 *  history recorded and stays undoable — and an undo never brings back a type
 *  the rule replaced. A free-form key keeps a type that fits its value, so a
 *  person's own type change (the attribute panel's type picker) remains a
 *  change: undone on its own, and a conflict for an older undo. */
async function typing(workspaceId: string, nodeId: string, key: string): Promise<(state: AttributeState | null) => AttributeState | null> {
  const field = await fieldForKey(workspaceId, nodeId, key);
  return (state) => {
    if (state === null) return null;
    const stored = normalize(field, state.value, state.value_type as AttributeValueType);
    return { ...state, value_type: stored.ok ? stored.value_type : "text" };
  };
}

type AttributeInspection = {
  key: string;
  current: AttributeState | null;
  previous: AttributeState | null;
  refusal?: Extract<RestoreError, { code: "state_conflict" | "history_incomplete" | "already_in_state" }>;
};

/** Preview and mutation interpret the same before/after state. The mutation
 * also locks the existing row; restoreEvent owns the append lock and savepoint
 * protecting an absent row and rolling back its event on any failure.
 */
async function inspectAttribute(row: EventRow, lock: boolean): Promise<AttributeInspection | RestoreError> {
  const key = row.payload.key;
  if (row.target_type !== "node" || typeof key !== "string" || !key ||
      (row.event_type !== "ATTRIBUTE_SET" && row.event_type !== "ATTRIBUTE_DELETED")) {
    return historyIncomplete("attribute history has no valid node, key, or operation");
  }
  // A module-owned reserved key (a feed's _rss_url, a template child's
  // _tpl_origin) is undone with the operation that wrote it, never on its own
  // (services/systemAttributes.ts).
  if (isModuleOwnedAttributeKey(key)) {
    return { code: "unsupported", status: 422, detail: `${key} is owned by its module and is not undone on its own` };
  }

  let rawBefore = row.tx_meta?.prev_field_values;
  if (row.event_type === "ATTRIBUTE_SET") {
    const inverseOp = row.tx_meta?.inverse_op;
    if (inverseOp !== "attribute.set" && inverseOp !== "attribute.deleted") return historyIncomplete("attribute history has no valid inverse operation");
    if (inverseOp === "attribute.deleted") {
      if (rawBefore && typeof rawBefore === "object" &&
          ((rawBefore as Record<string, unknown>).value != null || (rawBefore as Record<string, unknown>).value_ref != null)) {
        return historyIncomplete("attribute inverse contradicts its previous state");
      }
      rawBefore = null;
    }
  }
  const before = await decodeSnapshot(rawBefore, scopeOf(row));
  if ("code" in before) return before;
  if (row.event_type === "ATTRIBUTE_SET" && row.tx_meta.inverse_op === "attribute.set" && before.state === null) {
    return historyIncomplete("attribute inverse contradicts its previous state");
  }

  const found = await q<AttributeState>(
    `SELECT value, value_type, is_inheritable, source FROM node_attributes
      WHERE workspace_id = $1 AND node_id = $2 AND key = $3${lock ? " FOR UPDATE" : ""}`,
    [row.workspace_id, row.target_id, key],
  );
  const current = found.rows[0] ?? null;
  const typed = await typing(row.workspace_id, row.target_id, key);
  const previous = typed(before.state);
  const inspection: AttributeInspection = { key, current, previous };
  // A historical DELETE of an absent row changed nothing, even if a new value
  // exists today. There is no inverse that could justify deleting today's row.
  if ((row.event_type === "ATTRIBUTE_DELETED" && before.state === null) || equalState(typed(current), previous)) {
    return { ...inspection, refusal: { code: "already_in_state", status: 409, detail: "this attribute change is already restored or changed no state" } };
  }

  const after = row.event_type === "ATTRIBUTE_DELETED" ? { state: null } : await decodeSnapshot(row.payload, scopeOf(row));
  if ("code" in after) {
    // The before value is still safe to preview, but an incomplete after state
    // cannot prove that overwriting the current value preserves later edits.
    return { ...inspection, refusal: historyIncomplete(after.detail) };
  }
  if (after.state === null && row.event_type === "ATTRIBUTE_SET") {
    return { ...inspection, refusal: historyIncomplete("a set event has no resulting attribute state") };
  }
  if (!equalState(typed(current), typed(after.state))) {
    return { ...inspection, refusal: {
      code: "state_conflict", status: 409,
      detail: `attribute '${key}' changed after this event; its current value and metadata were preserved`,
      force_available: false,
    } };
  }
  return inspection;
}

/** Undo exactly this attribute change, including source/type/inheritance.
 * Runs only inside restoreEvent's authorized transaction. Later changes to
 * any of those fields are a conflict; this operation has no force mode.
 */
export async function restoreAttribute(row: EventRow, actorContext: ActorCtx): Promise<RestoreResult | RestoreError> {
  requireRestoreTransaction();
  const inspection = await inspectAttribute(row, true);
  if ("code" in inspection) return inspection;
  if (inspection.refusal) return inspection.refusal;
  const { key, current, previous } = inspection;
  const scope = scopeOf(row);
  const previousSnapshot = await encodeSnapshot(key, current, scope);
  const restoredSnapshot = await encodeSnapshot(key, previous, scope);

  // the one writer of an attribute row (services/attributeChange.ts): it asks whether this actor may write the key (the publish mark is a person's)
  await storeAttributeState(actorContext, row.workspace_id, row.target_id, key, previous);
  // Undoing a drawing's event is a new version of that drawing (spine/noteVersions.ts), as undoing a body event is. The value changed (an
  // unchanged one was refused as already_in_state), so there is always one to mint. restoredFrom is the version the undone event had
  // replaced, when its content is what is back on screen (versionBeforeEvent's rule, the same as the body undo in restore.ts).
  if (isVersionedInkKey(key)) {
    const hash = typeof restoredSnapshot?.value_ref === "string" ? restoredSnapshot.value_ref : null;
    if (previous !== null && hash === null) throw new Error("a drawing's snapshot names its value by hash");
    await recordVersion({
      workspaceId: row.workspace_id, noteId: row.target_id, unit: key, contentHash: hash,
      kind: previous === null ? "removed" : "restored",
      restoredFrom: previous === null ? null : await versionBeforeEvent(row.target_id, key, String(row.id), hash),
    });
  }
  // Modules hear about it once the undo commits, as for any attribute change
  // (undoing `_published` takes the page off the website).
  await nodeAttributeCommitted({ workspaceId: row.workspace_id, nodeId: row.target_id, key, value: previous?.value ?? null, actor: actorContext });
  return recordRestore(row, actorContext, {
    eventType: attributeEventType(previous),
    payload: { key, ...restoredSnapshot },
    inverseOp: current === null ? "attribute.deleted" : "attribute.set",
    previous: previousSnapshot,
  });
}

/** Read-only preview. Missing before-state data returns history_incomplete
 * rather than displaying an invented restored value; other conflicts retain
 * the accurate before/current values and explain why application is blocked.
 */
export async function previewAttributeRestore(row: EventRow): Promise<AttributeRestorePreview | RestoreError> {
  const inspection = await inspectAttribute(row, false);
  if ("code" in inspection) return inspection;
  return {
    kind: "attribute_change", key: inspection.key,
    current_value: inspection.current?.value ?? null,
    restored_value: inspection.previous?.value ?? null,
    action: inspection.previous === null ? "delete" : "set",
    current_metadata: metadata(inspection.current),
    restored_metadata: metadata(inspection.previous),
    can_apply_cleanly: !inspection.refusal,
    force_available: false,
    ...(inspection.refusal ? { reason: inspection.refusal.detail, conflict_code: inspection.refusal.code } : {}),
  };
}

function metadata(state: AttributeState | null): Omit<AttributeState, "value"> | null {
  return state === null ? null : { value_type: state.value_type, is_inheritable: state.is_inheritable, source: state.source };
}
