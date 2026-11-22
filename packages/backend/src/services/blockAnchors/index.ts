// Block anchors (docs/architecture/proposals/block-anchors-2026-11-01.md): where a paragraph is, kept beside the text.
export { ANCHOR_EVENTS, anchorEventFor, type AnchorEventType, moveAnchorsForBodyChange, ensureBlockAnchor, insertAnchors, adoptAnchorsInto, anchorHolderNote, noteHoldsAnchor, noteIdsHoldingAnchors, validAnchorRangesByNote, renameAnchor, type AdoptAnchor, noteAnchorRanges, parseNoteBlocks, freeAnchorId, rehomeAnchor, carryBlockRow, takeBackStrandedAnchors, retireAnchor, anchorsByIds, anchorExcerpts, confirmAnchorCandidate, recordLinkBound, partSpanAt, listNoteAnchors, anchorRowsForNotes, anchorBackupRowsByNote, restoreBackupAnchors, type AnchorBackupRow, type AnchorWireRow, blockSpanAt, type BodyMove, type BodyMoveSummary, type StoredAnchor } from "./store.js";
export { moveAnchors, FIND_BUDGET, type AnchorState, type MovedAnchor } from "./mapping.js";
export { findQuote, dice, FIND_VALID, FIND_GUESS, KEEP_MOVED } from "./similarity.js";
export { deriveChangeSet, verifiedEditorChanges, readEditorBodyChange, type EditorBodyChange } from "./changes.js";
export { ANCHOR_RECOVER_EFFECT, enqueueAnchorRecovery } from "./recoverIntent.js";
export { recoverAnchors } from "./recover.js";
export { listNoteParagraphs } from "./paragraphs.js";
export { linkBlockNodeAnchors, reassignBlockNodeAnchor } from "./blockNodeLink.js";
