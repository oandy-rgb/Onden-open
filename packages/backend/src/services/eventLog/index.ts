// The event log's one entry: an attribute's before/after snapshot for its
// event, and a body change as an inverse patch (undo, restore, import, merge).
// Files inside import each other directly.
export { encodeSnapshot, type AttributeState } from "./attributeSnapshot.js";
export { makeInversePatch, NO_INVERSE_PATCH, rebuildPreEventBody, rebuildFromUnchangedBody } from "./bodyPatch.js";
export { bodyConflictPayload, type BodyConflict } from "./bodyMerge.js";
export { mergeBody } from "./bodyMergeMoves.js";
