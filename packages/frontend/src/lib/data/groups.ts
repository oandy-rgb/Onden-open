// The last groups of lib/data's entry (A2): write errors, a note's structure
// (children, reorder) and pins. The work stays in writeErrors,
// noteStructure and pointerWriter; the getters read their exports when used
// (so tests that fake part of a module load fine).
import * as errors from "./writeErrors";
import * as structure from "./noteStructure";
import * as pointer from "./pointerWriter";

/** What a failed write means to the person: report it once, word it, or ask
 *  what kind it was (WriteActionError stays a class of its own: thrown and checked). */
export const writeErrors = {
  /** Toast the failure once (no-op when it was already reported). */
  get report() { return errors.reportWriteFailure; },
  /** The failure in plain words, for inline display. */
  get message() { return errors.writeFailureMessage; },
  /** A change that is only queued on this device, in plain words (the one queued-save sentence). */
  get queuedMessage() { return errors.queuedWriteMessage; },
  /** A failed read, run or other non-write request in plain words (see requestFailureMessage). */
  get requestMessage() { return errors.requestFailureMessage; },
  /** "retryable" | "rejected" | "storage" | …: what the caller may do next. */
  get classify() { return errors.classifyWriteFailure; },
  get wasReported() { return errors.wasWriteFailureReported; },
  /** The server could not be reached (fetch failure, timeout, 502/503/504) —
   *  narrower than "retryable", which also covers a server that answered. */
  get isServerUnreachable() { return errors.isServerUnreachable; },
};

/** A note's structure: the steps operations build from (create children,
 *  delete notes) and the order of a parent's children. */
export const noteStructure = {
  get run() { return structure.runStructureOperation; },
  get createChildren() { return structure.createChildNotes; },
  /** A parent's children in display order (sort_order, then created). */
  get children() { return structure.childrenOf; },
  /** Reorder one parent's children; writes only the rows that must change. */
  get reorder() { return structure.reorderChildren; },
  /** Move a note under a parent as its last child. */
  get appendChild() { return structure.appendChild; },
};

/** Pointer clones of a note in the sidebar. */
export const pins = {
  get pin() { return pointer.pinPointer; },
  get unpin() { return pointer.unpinPointer; },
};
