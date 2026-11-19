// The overview editor's draft machinery (H4 keystroke isolation).
//
// Draft text / title / save status live in lib/appStore so a keystroke
// re-renders ONLY draft subscribers (OverviewEditorHost), never the whole
// BuilderApp tree. The autosave/flush logic that used to be effects inside
// useOverviewMode lives here as module functions — scheduling happens inside
// the setters (when dirty), which is exactly what the old
// `useEffect(..., [overviewDraft, overviewTitleDraft])` did one render later.
//
// ONE save path for every trigger (debounce fire, node switch, manual ⌘S,
// pagehide). The pendingSave snapshot keeps the node the edit BELONGS to, so
// a flush saves the right node even after selection moved on.

import { restoreEditorChanges, takeEditorChanges } from "../editorChangeLog";
import { type ContentNode, nodeNeedsBody } from "../api";
import { createSaveDebounce, SAVE_DEBOUNCE_MS } from "../persistScheduler";
import { noteWriter } from "./domainWriters";
import { t } from "../i18n";
import { flushLocalDbSync } from "../localDb";
import { getLocalCopyState } from "../localCopyState";
import { setBeforeChunkReload } from "../lazyWithReload";
import { WriteActionError, WriteStorageError, classifyWriteFailure } from "./writeErrors";
import { getReplayRejectionRevision } from "./writeQueue";
import { getRecoveryWrites, recoveryHolding, settleRefusedNoteText } from "./writeRecovery";
import { getPendingCount } from "./syncStatus";
import { targetsEntity } from "../pendingWriteTargets";
import {
  getAppState, setAppState, setData, addToast,
  selectOverviewSelectedNode, getNode } from "../appStore";

// The shared note writer (domainWriters: the one data context).
const writer = noteWriter;
let draftRevision = 0;

const autosave = createSaveDebounce(SAVE_DEBOUNCE_MS.overview);
let isDirty = false;
// The latest unsaved edit, snapshotted with the node it belongs to. A flush
// can then save the RIGHT node even after selection moved on (node switch)
// or the page is going away (pagehide) — the two windows where the debounce
// timer alone silently dropped up to 1.5s of typing.
type PendingSave = { node: ContentNode; title: string; draft: string };
let pendingSave: PendingSave | null = null;
// Per note: the server text its draft was derived from (GAP-186). A save sends
// it as the three-way-merge base. It is NOT the store row's current markdown:
// a sync can put another writer's newer body there while the draft still
// lacks it, and using that as the base made the server read the other
// writer's lines as "deleted by me" and drop them.
// It is read when a save is SENT, after the note's previous save has settled
// (see flushPendingSave): text typed while a save is in flight derives from
// that save, so capturing the base at keystroke time made the server re-apply
// the first save's text and duplicate it. Kept per note because a note left
// mid-save still has a save to send after the editor moved on.
const bases = new Map<string, { markdown: string; title: string }>();
// Per note: the newest text handed to a save that has not settled (in flight or
// queued behind another). The store row only carries the text of saves the
// writer applied so far, so coming back to a note mid-save seeds its draft from
// here, and a page-exit save that does not wait for them bases itself on it.
const sentText = new Map<string, { markdown: string; title: string }>();
// Per note: the newest body this tab had the server accept. A BODY_CONFLICT
// that left out text found here tells this tab its words lost (bodyConflict.ts).
const lastAcceptedBody = new Map<string, string>();
/** The newest body this tab had accepted for the note, if it saved it. */
export function ownAcceptedBody(nodeId: string): string | undefined {
  return lastAcceptedBody.get(nodeId);
}
// The note whose editor has an IME composition open (setEditorComposing). Outside text waits for its end.
let composingIn: string | null = null;
// The unsent snapshot whose save was refused. Autosave, a node switch and
// pagehide do not send it again (each retry was a new idempotency key and a new
// error); the refused input stays in recovery. Typing makes a new snapshot,
// and an explicit save (⌘S, restore, sign-out) retries it.
let rejectedSave: PendingSave | null = null;
// Per note: the title and text of the newest save the server refused. Typing
// makes a new snapshot and clears `rejectedSave`, but if the user's text comes
// back to exactly what was refused (typed and deleted again, or the refusal
// arrived after newer typing), sending it would repeat a request the server
// already decided. Dropped by an explicit retry (⌘S, restore, sign-out); a
// later accepted save does not clear it, because the refusal may be about the text itself.
const refusedText = new Map<string, { title: string; draft: string }>();
// Per note: the text of the newest save of it that failed, until a later save
// of the note succeeds. prepareEditorForReload asks whether that text sits in
// recovery; it is not kept for any other purpose.
const failedTexts = new Map<string, { markdown: string; title?: string }>();
// Saves that wait for the note's previous save before they are handed to the
// writer. A page exit cannot wait: `sendWaitingNow` hands them over.
const waitingSaves = new Set<(keepalive: boolean) => void>();
const activeSaves = new Map<string, Promise<boolean>>();
// Per note: editor draft saves started and not yet settled (queued behind
// another save or in flight). Their merge base is read when they are sent, so
// nothing else may move it underneath them (saveNoteBody).
const editorSaves = new Map<string, number>();
// Which node the editor currently shows — read at flush-response time so a
// three-way-merged body is only pushed into the visible draft if the user
// is still looking at that node.
let editorNodeId: string | null = null;
// Notes whose newer row applyRemoteNode had to skip (unsaved input or a save in flight) and has not applied
// since. The look after a save settles trusts this over the draft revision, which a reseed (body evicted and
// loaded again) bumps without any typing.
const remoteSkipped = new Set<string>();


/** Replicates the old autosave effect: when dirty, snapshot the edit against
 *  the node it belongs to and (re)arm the 1.5s debounce. */
function scheduleAutosaveIfDirty(): void {
  const s = getAppState();
  // The note the editor SHOWS owns the draft. The store's selection can already
  // be another note for a moment (before resetDraftForNode runs); saving by it
  // would overwrite that other note with this note's text.
  const node = editorNodeId ? getNode(editorNodeId) : undefined;
  if (!isDirty || !node) return;
  setAppState({ saveStatus: "unsaved" });
  pendingSave = { node, title: s.overviewTitleDraft, draft: s.overviewDraft };
  draftRevision++;
  autosave.run(() => { void flushPendingSave(); });
}

function setOverviewDraft(draft: string): void {
  setAppState({ overviewDraft: draft });
  scheduleAutosaveIfDirty();
}

/** The user typed in `nodeId`'s editor: update its draft and autosave. Input
 *  tagged with a note the editor no longer shows (a change event that lands
 *  after a switch) never reaches the note now open. */
export function typeIntoDraft(nodeId: string, change: { markdown?: string; title?: string }): void {
  if (nodeId !== editorNodeId) return;
  isDirty = true;
  setAppState({
    ...(change.markdown === undefined ? {} : { overviewDraft: change.markdown }),
    ...(change.title === undefined ? {} : { overviewTitleDraft: change.title }),
  });
  scheduleAutosaveIfDirty();
}

/** Snapshot the editor's text without saving it. Null means this editor does
 * not own that note (including while a slim body is still loading). An empty
 * string is an intentional draft, not a reason to use the saved body. */
export function readOverviewDraft(nodeId: string): { title: string; markdown: string } | null {
  if (editorNodeId !== nodeId) return null;
  const state = getAppState();
  return { title: state.overviewTitleDraft, markdown: state.overviewDraft };
}

/** Node switch (or first mount): flush the PREVIOUS node's pending edit (it
 *  used to be dropped on the floor with the timer), then load the new node's
 *  content into the drafts. */
export function resetDraftForNode(node: ContentNode | null): void {
  editorNodeId = node?.id ?? null;
  if (composingIn !== editorNodeId) composingIn = null;
  void flushPendingSave();
  if (rejectedSave && rejectedSave === pendingSave && rejectedSave.node.id !== node?.id) {
    // The refused input lives in recovery; it must not keep the next note "dirty".
    autosave.cancel();
    isDirty = false;
    pendingSave = null;
    rejectedSave = null;
  }
  // Text typed in this note whose save has not settled is newer than the row.
  const newest = node && (pendingSave?.node.id === node.id
    ? { markdown: pendingSave.draft, title: pendingSave.title }
    : sentText.get(node.id));
  const inFlight = !!node && activeSaves.has(node.id);
  // A title equal to the one this draft started from was never typed: the save
  // did not send it, and the row may hold another device's newer rename.
  const typedTitle = newest && newest.title !== (bases.get(node.id)?.title ?? node.title) ? newest.title : undefined;
  if (node && !(inFlight && bases.has(node.id))) {
    bases.set(node.id, { markdown: node.markdown ?? "", title: node.title ?? "" });
  }
  // An older save finishing must not touch this draft (it checks the revision).
  draftRevision++;
  setAppState({
    saveStatus: inFlight ? "saving" : "saved",
    overviewDraft: newest?.markdown ?? node?.markdown ?? "",
    overviewTitleDraft: typedTitle ?? node?.title ?? "",
  });
}

/** The note has text only the editor holds: an unsent edit, or a save that has
 *  not settled. The sync engine keeps such a note's body in memory. */
export function isBodyInUse(nodeId: string): boolean {
  return editorNodeId === nodeId || pendingSave?.node.id === nodeId
    || activeSaves.has(nodeId) || editorSaves.has(nodeId);
}

// The open note's draft save that only the offline queue accepted: the replay
// refusals counted when it was queued, to tell its outcome once the queue drains.
let queuedDraft: { nodeId: string; rejections: number; earlier: Set<string>; refused?: true } | null = null;

/** Refused writes to this note already in recovery: not this draft's outcome. */
const refusedWritesTo = (nodeId: string) => getRecoveryWrites()
  .filter((write) => write.rejection !== undefined && targetsEntity(write, "node", nodeId))
  .map((write) => write.id);

/** What a "queued" draft became once the offline queue has drained: "saved"
 *  unless a replay was refused since it was queued AND that refusal is a write
 *  to this note that was not in recovery when the draft was queued (its input
 *  is then in recovery, not on the server). A drained queue alone never means
 *  saved: refused replays leave it too. A refusal sticks: dismissing the
 *  recovery copy later does not turn it into "saved". */
export function queuedDraftOutcome(nodeId: string): "saved" | "rejected" {
  if (queuedDraft?.nodeId !== nodeId) return "rejected";
  if (queuedDraft.refused) return "rejected";
  const earlier = queuedDraft.earlier;
  if (getReplayRejectionRevision() !== queuedDraft.rejections && refusedWritesTo(nodeId).some((id) => !earlier.has(id))) {
    queuedDraft.refused = true;
    return "rejected";
  }
  return "saved";
}

/** False means a write was rejected or could not be persisted; its draft stays
 * recoverable. Also waits for the current node's already-started autosave. */
export function flushPendingSave(opts: { keepalive?: boolean; retryRejected?: boolean } = {}): Promise<boolean> {
  // The page may be gone before the saves queued behind an in-flight one are
  // sent: the writer must hold them now (it keeps a recovery copy until they
  // are acknowledged). Each builds on the text of the save before it.
  if (opts.keepalive) for (const sendNow of [...waitingSaves]) sendNow(true);
  const unsent = pendingSave;
  if (!unsent || !isDirty) return activeSaves.get(editorNodeId ?? "") ?? Promise.resolve(true);
  if (unsent === rejectedSave && !opts.retryRejected) return Promise.resolve(false);
  rejectedSave = null;
  const pending = unsent;
  const refused = refusedText.get(pending.node.id);
  if (opts.retryRejected) refusedText.delete(pending.node.id);
  else if (refused && refused.title === pending.title && refused.draft === pending.draft) {
    // Same input the server already refused (it is in recovery): not sent again.
    autosave.cancel();
    rejectedSave = unsent;
    if (editorNodeId === pending.node.id) setAppState({ saveStatus: "rejected" });
    return Promise.resolve(false);
  }
  autosave.cancel();
  isDirty = false;
  pendingSave = null;
  const revision = draftRevision;
  const nodeId = pending.node.id;
  const stillVisible = () => editorNodeId === nodeId;
  if (stillVisible()) setAppState({ saveStatus: "saving" });
  // One save per note at a time: this one waits for the note's previous save so
  // its merge base includes what that save sent. The note's write lane orders
  // the requests anyway, so waiting here only fixes the base. A page-exit
  // (keepalive) save does not wait: the page may be gone before the previous
  // save settles, and the text is protected for exit only once the writer has
  // it. It builds on the previous save's text instead (the lane applies that
  // one first).
  const previous = activeSaves.get(nodeId);
  const earlier = sentText.get(nodeId);
  sentText.set(nodeId, { markdown: pending.draft, title: pending.title });
  editorSaves.set(nodeId, (editorSaves.get(nodeId) ?? 0) + 1);
  const send = async (early: boolean, keepalive: boolean): Promise<boolean> => {
    const base = previous && early && earlier ? earlier : bases.get(nodeId);
    let saved: ContentNode;
    let queued: boolean;
    let editorTaken: ReturnType<typeof takeEditorChanges> = null;
    try {
      // A title the draft still shares with its base is not sent: another
      // writer's rename must not be overwritten by a body autosave. Nor is an
      // empty one: it is a title not typed yet (every note has one on the
      // server), and sending it would get the body refused along with it.
      const baseTitle = base?.title ?? pending.node.title ?? "";
      const sendsTitle = pending.title !== baseTitle && pending.title.trim() !== "";
      // Typed and typed back: the draft is the text the server already has
      // (the base), so there is nothing to save, and a send would be a history
      // point whose text did not change. A forced save (⌘S) lands here too.
      if (!sendsTitle && pending.draft === (base?.markdown ?? pending.node.markdown ?? "")) {
        if (stillVisible() && draftRevision === revision && queuedDraft?.nodeId !== nodeId) setAppState({ saveStatus: "saved" });
        return true;
      }
      const baseMarkdown = base?.markdown ?? pending.node.markdown ?? "";
      editorTaken = takeEditorChanges(nodeId, baseMarkdown.length, pending.draft.length);
      const result = await writer.patch(nodeId, {
        ...(sendsTitle ? { title: pending.title } : {}), markdown: pending.draft,
      }, { baseMarkdown, keepalive, bodyChange: editorTaken?.body });
      saved = result.node;
      queued = result.status === "queued";
    } catch (error) {
      // The writer reports the cause. Keep a failed snapshot for an explicit
      // retry, but never replace a newer draft or change its save indicator.
      if (editorTaken) restoreEditorChanges(nodeId, editorTaken.taken, editorTaken.body.carried_anchors);
      failedTexts.set(nodeId, { markdown: pending.draft, title: pending.title });
      if (classifyWriteFailure(error) === "rejected") refusedText.set(nodeId, { title: pending.title, draft: pending.draft });
      if (draftRevision === revision) {
        isDirty = true;
        pendingSave = pending;
        rejectedSave = pending;
        if (stillVisible()) setAppState({ saveStatus: "rejected" });
      }
      return false;
    }
    // Only a server acknowledgement or a durable queue commit reaches here.
    // Switching away and back (resetDraftForNode) showed "saving" for this save and bumped the revision; when
    // nothing newer is unsent or in flight, this save's outcome is still the status.
    const statusIsMine = draftRevision === revision
      || (!isDirty && editorSaves.get(nodeId) === 1 && getAppState().saveStatus === "saving");
    if (stillVisible() && statusIsMine) {
      queuedDraft = queued ? { nodeId, rejections: getReplayRejectionRevision(), earlier: new Set(refusedWritesTo(nodeId)) } : null;
      setAppState({ saveStatus: queued ? "queued" : "saved" });
    }
    failedTexts.delete(nodeId);
    void settleRefusedNoteText(nodeId, { markdown: pending.draft, title: pending.title });
    // The server now holds (at least) what we sent: later edits build on it.
    bases.set(nodeId, { markdown: pending.draft, title: pending.title });
    if (!queued) {
      lastAcceptedBody.set(nodeId, pending.draft);
    }
    // A three-way merge may return a body that includes ANOTHER writer's
    // changes — reflect it so the editor doesn't silently diverge. Only if
    // the user is still on this node and hasn't typed again since.
    if (!keepalive && stillVisible() && !isDirty && draftRevision === revision &&
      saved && typeof saved.markdown === "string" && saved.markdown !== pending.draft && composingIn === nodeId) {
      // An IME composition is open: the merged text waits for its end like any outside text (setEditorComposing);
      // the store row already holds it (the writer settled the field with the answer).
      remoteSkipped.add(nodeId);
      addToast(t("This note also changed somewhere else while you were typing. Both changes are kept; please check the result."), "info");
    } else if (!keepalive && stillVisible() && !isDirty && draftRevision === revision &&
      saved && typeof saved.markdown === "string" && saved.markdown !== pending.draft) {
      const merged = saved.markdown;
      setOverviewDraft(merged);
      bases.set(nodeId, { markdown: merged, title: pending.title });
      setData((current) => ({
        ...current,
        nodes: current.nodes.map((n) => n.id === nodeId ? { ...n, markdown: merged } : n),
      }));
      // P0-4 conflict UX: the server replayed our edit onto ANOTHER
      // writer's copy — say so instead of silently morphing the text.
      addToast(t("This note also changed somewhere else while you were typing. Both changes are kept; please check the result."), "info");
    }
    return true;
  };
  const saving = !previous || opts.keepalive ? send(!!previous, !!opts.keepalive) : new Promise<boolean>((resolve) => {
    let started = false;
    const start = (keepalive: boolean) => {
      if (started) return;
      started = true;
      waitingSaves.delete(start);
      // Released by a page exit: built on the previous save's text, like a keepalive save.
      resolve(send(keepalive, keepalive));
    };
    waitingSaves.add(start);
    void previous.then(() => start(false), () => start(false));
  });
  void saving.finally(() => {
    const left = (editorSaves.get(nodeId) ?? 1) - 1;
    if (left > 0) editorSaves.set(nodeId, left); else { editorSaves.delete(nodeId); sentText.delete(nodeId); }
  }).catch(() => {});
  const tracked = trackSave(nodeId, saving);
  // applyRemoteNode skips a note that is dirty or mid-save, so a body another
  // device saved meanwhile never reached the draft. Look again once this save
  // has settled (after trackSave released the note), if nothing was typed since, or a newer row was skipped
  // (a reseed bumps the revision without typing).
  // A page-exit (keepalive) save too: the page may stay (background, bfcache) and still shows the old row.
  void saving.then((ok) => {
    if (ok && stillVisible() && !isDirty && (draftRevision === revision || remoteSkipped.has(nodeId))) applyRemoteNode(getNode(nodeId) ?? null);
  }).catch(() => {});
  return tracked;
}

/** Register `saving` as the note's latest save: the next save of the same
 *  note waits for it (and so reads the base it leaves behind). */
function trackSave(nodeId: string, saving: Promise<boolean>): Promise<boolean> {
  activeSaves.set(nodeId, saving);
  void saving.finally(() => {
    if (activeSaves.get(nodeId) !== saving) return;
    activeSaves.delete(nodeId);
    // A note the editor left keeps its base only while it still has a save to send.
    if (nodeId !== editorNodeId && pendingSave?.node.id !== nodeId) bases.delete(nodeId);
  }).catch(() => {});
  return saving;
}

/** A piece of work on one note that may finish after the user moved on (an
 *  upload, a created page, a split, a restore). Begin it before the first
 *  await; afterwards it says whether the editor still shows the note and
 *  whether anything was typed since, and lands the result in the right note. */
export type NoteSession = {
  readonly nodeId: string;
  /** The editor still shows this note. */
  shown(): boolean;
  /** The editor still shows this note, nothing was typed since the session
   *  began, and it holds no unsaved input. */
  untouched(): boolean;
  /** Change the note's text wherever it is now (editNoteText). */
  edit(change: (body: string) => string): Promise<NoteTextEdit>;
  /** The server now holds `markdown` (and `title`) for this note: show it in the
   *  editor only if untouched(). Text typed meanwhile stays, and its next save
   *  merges onto it. Another note in the editor is never touched. */
  adopt(markdown: string, title?: string): void;
};

export function beginNoteSession(nodeId: string): NoteSession {
  const revision = draftRevision;
  const shown = () => editorNodeId === nodeId;
  const untouched = () => shown() && draftRevision === revision && !isDirty;
  return {
    nodeId, shown, untouched,
    edit: (change) => editNoteText(nodeId, change),
    adopt(markdown, title) {
      if (untouched()) applyRestoredDraft(markdown, title ?? getAppState().overviewTitleDraft);
    },
  };
}

/** Change a note's text wherever it is. When the editor shows the note, the
 *  edit goes into its draft and autosaves like typing. Otherwise it is saved
 *  directly, after the note's earlier saves, merged onto the server's copy.
 *  For work that finishes after the user moved on (an upload, a created
 *  page): its result still belongs in the note it was started from.
 *
 *  "applied": in the draft, or accepted / durably queued (an edit that
 *  changes nothing writes nothing). "missing": the note's text is not here to
 *  edit (removed, or a body never loaded) — nothing was reported yet.
 *  "refused": the save was refused; the writer has already reported it. */
export type NoteTextEdit = "applied" | "missing" | "refused";
export function editNoteText(nodeId: string, edit: (body: string) => string): Promise<NoteTextEdit> {
  if (editorNodeId === nodeId) {
    const state = getAppState();
    const next = edit(state.overviewDraft);
    if (next !== state.overviewDraft) typeIntoDraft(nodeId, { markdown: next });
    return Promise.resolve("applied");
  }
  const previous = activeSaves.get(nodeId);
  const editing = (async (): Promise<NoteTextEdit> => {
    if (previous) await previous;
    const node = getNode(nodeId);
    const base = bases.get(nodeId)?.markdown ?? (node && !nodeNeedsBody(node) ? node.markdown ?? "" : null);
    if (base === null) return "missing";
    const edited = edit(base);
    if (edited === base) return "applied";
    const markdown = edited;
    try {
      const saved = await writer.patch(nodeId, { markdown }, { baseMarkdown: base });
      failedTexts.delete(nodeId);
      if (bases.has(nodeId)) bases.set(nodeId, { markdown, title: saved.node.title ?? "" });
      return "applied";
    } catch {
      failedTexts.set(nodeId, { markdown });
      return "refused"; // the writer reported it
    }
  })();
  void trackSave(nodeId, editing.then((result) => result === "applied"));
  return editing;
}

/** Preserve this note's pre-restore edits as an acknowledged save before restore;
 * an unrelated note's draft is left alone.
 * New input while that save is pending cancels preparation. New input after
 * restore starts remains editable and must never be replaced by its response. */
export async function restoreOverviewDraft(nodeId: string, restore: () => Promise<ContentNode | void>): Promise<boolean> {
  const before = beginNoteSession(nodeId);
  const editingTarget = before.shown();
  // The workspace history may restore a different note. Its operation must not
  // depend on saving an unrelated editor's draft (which may be rejected/offline).
  const saved = pendingSave?.node.id === nodeId
    ? await flushPendingSave({ retryRejected: true })
    : await (activeSaves.get(nodeId) ?? Promise.resolve(true));
  if (!saved) return false;
  if (editingTarget && !before.untouched()) {
    addToast(t("The draft changed while preparing the restore. Keep your edits and try again."), "info");
    return false;
  }
  const restored = await restore();
  if (restored && getAppState().selectedId === nodeId) before.adopt(restored.markdown, restored.title);
  return true;
}

/** An operation that rewrites a note's whole body (split, merge, send
 *  checklist to Tasks), started by `beginBodyRewrite`. */
export type BodyRewrite = NoteSession & {
  /** The text to transform: the note's draft when the editor shows it,
   *  otherwise its stored body. Already saved. Call `adopt(final)` once the
   *  server accepted the rewrite and holds `final`. */
  body: string;
};

/** Start rewriting `node`'s body: save its pending edit first, then return the
 *  text to transform. Null when that save was refused (the writer has reported
 *  it); the operation must not run on text the server never accepted.
 *
 *  const rewrite = await beginBodyRewrite(node);
 *  if (!rewrite) return;
 *  const final = await rewriteBody(submit, node.id, transform(rewrite.body), rewrite.body);
 *  rewrite.adopt(final);
 */
export async function beginBodyRewrite(node: ContentNode): Promise<BodyRewrite | null> {
  const saved = pendingSave?.node.id === node.id
    ? await flushPendingSave({ retryRejected: true })
    : await (activeSaves.get(node.id) ?? Promise.resolve(true));
  if (!saved) return null;
  const session = beginNoteSession(node.id);
  const body = readOverviewDraft(node.id)?.markdown
    ?? getNode(node.id)?.markdown
    ?? node.markdown ?? "";
  return { ...session, body };
}

/** Save a body edited outside the overview editor (a canvas card) as one of
 *  the note's saves: after its earlier saves, merged onto the server's copy
 *  from `base` — the text that editor started from — so another writer's
 *  newer lines are kept rather than overwritten. Rejects when refused; the
 *  writer has reported it. */
export function saveNoteBody(nodeId: string, markdown: string, base: string, options: { keepalive?: boolean } = {}): Promise<void> {
  const session = beginNoteSession(nodeId);
  // Hand the write to the writer now, not after the note's earlier saves: its
  // lane orders the requests anyway, and a page-exit (keepalive) save is
  // protected for exit only once the writer has it. The card brings its own
  // base, so it needs nothing from those saves.
  const writing = writer.patch(nodeId, { markdown }, { baseMarkdown: base, keepalive: options.keepalive });
  const saving = (async () => {
    let saved: Awaited<typeof writing>;
    try { saved = await writing; }
    catch (error) { failedTexts.set(nodeId, { markdown }); throw error; }
    failedTexts.delete(nodeId);
    // The overview editor showing this note with a clean draft shows the
    // merged body. Never while one of its own saves is still to be sent or in
    // flight: that save reads its base when sent, and moving the base (or the
    // draft) under it would make the server read the card's lines as deleted
    // by the editor. Then the editor's save merges onto this one instead.
    if (session.untouched() && !editorSaves.get(nodeId)) session.adopt(saved.node.markdown ?? markdown, saved.node.title ?? undefined);
  })();
  void trackSave(nodeId, saving.then(() => true, () => false));
  return saving;
}

/** Before ending this page's account session, wait for the editor's current
 * draft and already-started saves, then confirm the local snapshot. The caller
 * keeps editing/navigation blocked until sign-out settles. False means the
 * writer already reported a refused save; newer input cancels this attempt. */
export async function prepareEditorForExit(): Promise<boolean> {
  const revision = draftRevision;
  const saves = [...activeSaves.values(), flushPendingSave({ retryRejected: true })];
  if (!(await Promise.all(saves)).every(Boolean)) return false;
  try { await flushLocalDbSync(); }
  catch (cause) { throw new WriteStorageError(cause); }
  if (draftRevision !== revision) {
    throw new WriteActionError(t("Your note changed while preparing to sign out. Review it and try again."));
  }
  return true;
}

/** What may happen to the page after the editor's text was made safe, for a
 *  reload the person asked for (the new-version button) or a stale-chunk
 *  reload. The question is "does any text live ONLY in memory?":
 *  - safe: every save the server (or the durable offline queue) accepted, or
 *    its text sits in recovery, which a reload keeps (`recovered`: titles of
 *    the notes whose text is there, for one plain sentence to the person);
 *  - memory-only: a save failed and no recovery entry that survives a reload
 *    holds its text (`text` is null when the writer kept it elsewhere);
 *  - local-queue: the local copy does not answer while changes still wait in
 *    its queue;
 *  - typing: the note changed while this was checking.
 *  Sign-out keeps the stricter prepareEditorForExit. */
export type ReloadGate =
  | { kind: "safe"; recovered: string[] }
  | { kind: "memory-only"; notes: { title: string; text: string | null }[] }
  | { kind: "local-queue"; waiting: number }
  | { kind: "typing" };

export async function prepareEditorForReload(): Promise<ReloadGate> {
  const revision = draftRevision;
  const started = [...activeSaves];
  // A refused draft is not sent again (flushPendingSave without retryRejected):
  // the server already said no, and its text is judged by recovery below.
  const draftNodeId = pendingSave?.node.id;
  const draftSaved = flushPendingSave().catch(() => false);
  const results = await Promise.all(started.map(([nodeId, saving]) =>
    saving.then((ok) => ({ nodeId, ok }), () => ({ nodeId, ok: false }))));
  if (draftNodeId && !await draftSaved) results.push({ nodeId: draftNodeId, ok: false });
  // Typed (or switched notes) meanwhile: what is unsent now is not a verdict.
  if (draftRevision !== revision) {
    console.warn("[reload] blocked: the open note changed while preparing");
    return { kind: "typing" };
  }

  const unsaved = new Map<string, { markdown: string; title?: string }>();
  for (const { nodeId, ok } of results) {
    const text = failedTexts.get(nodeId);
    if (!ok) unsaved.set(nodeId, text ?? { markdown: "" });
  }
  if (pendingSave && isDirty) unsaved.set(pendingSave.node.id, { markdown: pendingSave.draft, title: pendingSave.title });

  const recovered: string[] = [];
  const lost: { title: string; text: string | null }[] = [];
  for (const [nodeId, text] of unsaved) {
    const title = getNode(nodeId)?.title || text.title || "";
    if (text.markdown !== "" && recoveryHolding(nodeId, text)) { recovered.push(title); continue; }
    console.warn("[reload] blocked: note text exists only in memory", { noteId: nodeId });
    lost.push({ title, text: text.markdown === "" && !text.title ? null : text.markdown });
  }
  if (lost.length) return { kind: "memory-only", notes: lost };

  // The local copy is only a cache of what the server holds plus the queue of
  // offline changes. Without a copy (or while it restarts) there is no queue
  // to be behind, so a failed flush matters only when changes wait in it.
  if (getLocalCopyState() !== "none") {
    try { await flushLocalDbSync(); }
    catch (cause) {
      const waiting = getPendingCount();
      if (waiting > 0) {
        console.warn("[reload] blocked: local copy did not answer while changes wait in its queue", { waiting, cause });
        return { kind: "local-queue", waiting };
      }
    }
  }
  if (draftRevision !== revision) {
    console.warn("[reload] blocked: the open note changed while preparing");
    return { kind: "typing" };
  }
  return { kind: "safe", recovered };
}

// Registered when this module loads, not fetched at reload time: after a
// deploy the page's own code-split files are gone from the server, so an
// import() then resolves empty (lazyWithReload takes the preload error over)
// and the gate could never answer. A page without this module has no draft.
setBeforeChunkReload(prepareEditorForReload);

/** Manual save (⌘S / button) of `nodeId`'s editor forces a flush of its
 *  state through the same single save path as autosave/switch/pagehide. */
export async function saveDraft(nodeId: string): Promise<void> {
  const s = getAppState();
  const node = selectOverviewSelectedNode(s);
  if (!node || node.id !== nodeId || editorNodeId !== nodeId) return;
  pendingSave = { node, title: s.overviewTitleDraft, draft: s.overviewDraft };
  isDirty = true;
  draftRevision++;
  await flushPendingSave({ retryRejected: true });
}

/** A restore changes the body in place (same node id), so the draft-reset
 *  path — keyed on id — never fires. Push the restored content into the
 *  editor drafts explicitly, dropping any stale pre-restore snapshot. */
function applyRestoredDraft(markdown: string, title: string): void {
  draftRevision++;
  autosave.cancel();
  isDirty = false;
  pendingSave = null; // a stale pre-restore snapshot must not flush over the restore
  if (editorNodeId) bases.set(editorNodeId, { markdown, title });
  setAppState({
    overviewDraft: markdown,
    overviewTitleDraft: title,
    saveStatus: "saved",
  });
}

/** The editor of `nodeId` opened (true) or closed (false) an IME composition. While it is open no outside text
 *  reaches the draft (applyRemoteNode, a merged answer): replacing text under a composition cuts it, and the
 *  composing keystrokes would then write the draft over the outside text. A text that had to wait is offered again
 *  the moment the composition ends, the way a row skipped during a save is offered once the save settles. */
export function setEditorComposing(nodeId: string, composing: boolean): void {
  if (composing) { if (nodeId === editorNodeId) composingIn = nodeId; return; }
  if (composingIn !== nodeId) return;
  composingIn = null;
  if (remoteSkipped.has(nodeId) && !isDirty && !activeSaves.has(nodeId)) applyRemoteNode(getNode(nodeId) ?? null);
}

/** The open note's row changed in the store (sync delta, SSE, another tab, an
 *  agent). With no unsaved input, show the newer server text instead of
 *  keeping a stale copy (GAP-186). With unsaved input, keep the draft: its save
 *  carries the right base, and a merged reply is pushed in by flushPendingSave.
 *
 *  The one rule for outside text at the editor (owner report 2026-11-19): text older than what this editor has
 *  sent or had accepted for the note never reaches the draft. Sent: while a save is unanswered nothing outside is
 *  taken. Accepted: the save's answer carries its event position, and from the moment its headers arrive no answer read
 *  before it reaches the store (lib/data/writePositions.ts takeAnswer, by position, not by the server's clock); on the
 *  ways in that go through that door (a sync answer, a whole or slim bootstrap, a single read), a field with an edit
 *  still waiting for its answer is kept over the copy (storeOps.serverCopyOver). A block restore and a version restore
 *  (blockChildWriter, noteHistoryWriter) put the server's row in the store without the door: a known limit, listed in
 *  docs/agents/decisions-core-sync.md. */
export function applyRemoteNode(node: ContentNode | null): void {
  const base = node ? bases.get(node.id) : undefined;
  if (!node || node.id !== editorNodeId || !base) return;
  const markdown = node.markdown ?? "";
  const title = node.title ?? "";
  if (isDirty || composingIn === node.id || activeSaves.has(node.id) || nodeNeedsBody(node)) {
    if (!nodeNeedsBody(node) && (markdown !== base.markdown || title !== base.title)) remoteSkipped.add(node.id);
    else remoteSkipped.delete(node.id);
    return;
  }
  remoteSkipped.delete(node.id);
  const state = getAppState();
  // The shown draft decides, not the base: a draft that fell behind its base
  // (the base follows the saves, the draft followed the editor) is healed here,
  // otherwise the next save would send the old text over the newer one.
  if (markdown === state.overviewDraft && title === state.overviewTitleDraft) {
    bases.set(node.id, { markdown, title });
    return;
  }
  if (markdown === base.markdown && title === base.title) return;
  bases.set(node.id, { markdown, title });
  draftRevision++;
  setAppState({ overviewDraft: markdown, overviewTitleDraft: title, saveStatus: "saved" });
}

/** Test seam — module state would otherwise leak between tests in a file. */
export function __resetDraftStateForTests(): void {
  draftRevision++;
  autosave.cancel();
  isDirty = false;
  pendingSave = null;
  editorNodeId = null;
  remoteSkipped.clear();
  queuedDraft = null;
  bases.clear();
  sentText.clear();
  lastAcceptedBody.clear();
  composingIn = null;
  refusedText.clear();
  failedTexts.clear();
  waitingSaves.clear();
  rejectedSave = null;
  activeSaves.clear();
  editorSaves.clear();
}
