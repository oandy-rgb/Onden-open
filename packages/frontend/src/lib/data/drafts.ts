// The open note's draft, as one name for everything outside the data layer
// (A2): reading it, typing, saving and flushing it, sessions, remote changes
// and rewrites. The work is in draftActions.ts; the getters read its exports
// when used (so a test that fakes part of draftActions loads fine).
import * as actions from "./draftActions";

export const drafts = {
  /** The editor's unsaved title and text for `nodeId`, or null when it isn't open. */
  get read() { return actions.readOverviewDraft; },
  /** Start editing a note: its draft session. */
  get beginSession() { return actions.beginNoteSession; },
  get type() { return actions.typeIntoDraft; },
  get save() { return actions.saveDraft; },
  get saveBody() { return actions.saveNoteBody; },
  /** Send the pending save now; resolves false if it could not be saved. */
  get flush() { return actions.flushPendingSave; },
  /** Change the saved body of a note (open or not) through one edit function. */
  get editText() { return actions.editNoteText; },
  get beginRewrite() { return actions.beginBodyRewrite; },
  /** The newest body this tab had the server accept for `nodeId` (undefined: never saved here). */
  get acceptedBody() { return actions.ownAcceptedBody; },
  get applyRemote() { return actions.applyRemoteNode; },
  get queuedOutcome() { return actions.queuedDraftOutcome; },
  get reset() { return actions.resetDraftForNode; },
  get restore() { return actions.restoreOverviewDraft; },
  get prepareExit() { return actions.prepareEditorForExit; },
  /** Before a page reload that is not a sign-out: only text that lives in memory alone blocks it. */
  get prepareReload() { return actions.prepareEditorForReload; },
};
