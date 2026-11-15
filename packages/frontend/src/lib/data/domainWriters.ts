import { getAppState, setData, addToast, setActiveCanvas, setSelectedId } from "../appStore";
import { tagBoardMemberIds } from "../boardLayout";
import { makeCanvasWriter, type CanvasCtx } from "./canvasWriter";
import { makePropertyWriter } from "./propertyWriter";
import { makeTaskWriter } from "./taskWriter";
import { makeFocusWriter } from "./focusWriter";
import { makeGraphPositionWriter } from "./graphPositionWriter";
import { makeNoteWriter } from "./noteWriter";
import { makeTagWriter } from "./tagWriter";
import { makeRelationWriter } from "./relationWriter";
import { makeWorkspaceWriter } from "./workspaceWriter";
import { makeViewWriter } from "./viewWriter";
import { makeTagSchemaWriter } from "./tagSchemaWriter";
import { makeTagConfigWriter } from "./tagConfigWriter";
import { makeOnlineOperation, makeOnlineWrite } from "./onlineWrite";
import { makeNoteHistoryWriter } from "./noteHistoryWriter";
import { makeBlockChildWriter } from "./blockChildWriter";
import { makeNodeMutations } from "./nodeMutations";
import { makeNodeActions } from "./nodeActions";
import { isMobileLayout } from "../mediaQuery";
import type { DataCtx } from "./types";

// The one data context every writer is bound to (W6): the live store, the
// connection, toasts — and the app lifecycle's folder sync and refresh, which
// useAppData binds at load (bindDomainLifecycle). Until then (tests, a lens
// mounted alone) they are no-ops.
const lifecycle: Pick<DataCtx, "scheduleUserFolderSync" | "refresh"> = {
  scheduleUserFolderSync: () => {}, refresh: async () => {},
};

/** useAppData hands its folder sync and refresh to every writer. */
export function bindDomainLifecycle(next: Pick<DataCtx, "scheduleUserFolderSync" | "refresh">): void {
  Object.assign(lifecycle, next);
}

/** A context over the live store. Tests pass their own toast sink or
 *  connection; the app uses `domainContext`. */
export function createDomainContext(notify: DataCtx["addToast"] = addToast, online?: boolean): DataCtx {
  return {
    get data() { return getAppState().data; },
    get online() { return online ?? getAppState().online; },
    setData, addToast: notify,
    scheduleUserFolderSync: () => lifecycle.scheduleUserFolderSync(),
    refresh: () => lifecycle.refresh(),
  };
}
export const domainContext = createDomainContext();
const context = domainContext;

export const propertyWriter = makePropertyWriter(context);
export const taskWriter = makeTaskWriter(context);
/** Focus records: begin one, end it with what was done (lib/focus/focusStore). */
export const focusWriter = makeFocusWriter(context);
export const graphPositionWriter = makeGraphPositionWriter(context);
// Notes, tag membership and relations for code outside React (capture, lenses,
// modules): one store-bound instance each, so every caller shares the same
// save/queue/rollback contract instead of building its own writer or calling
// the API directly.
export const noteWriter = makeNoteWriter(context);
export const tagWriter = makeTagWriter(context);
export const relationWriter = makeRelationWriter(context);
export const workspaceWriter = makeWorkspaceWriter(context);
export const viewWriter = makeViewWriter(context);
export const tagSchemaWriter = makeTagSchemaWriter(context);
export const tagConfigWriter = makeTagConfigWriter(context);
/** The online operation (onlineWrite.ts) for code that writes several steps
 *  itself — note structure, tag packs, pins. */
export const onlineOperation = makeOnlineOperation(context);
/** History's writes: a version restore, an agent run's undo and redo, 「還原到這時」 and its undo. */
export const historyWriter = makeNoteHistoryWriter(context);
/** A block of a note into a child note and back (hooks/useBlockChildNote.ts). */
export const blockChildWriter = makeBlockChildWriter(context);
/** Part links `[[筆記/段落]]`: bind a link to its paragraph, confirm a doubtful one, count the links to a paragraph.
 *  The writer itself is loaded the first time one of them is asked (only a note with a part link asks). */
type BlockLinkWriter = ReturnType<typeof import("./blockLinkWriter").makeBlockLinkWriter>;
let blockLinkWriterLoaded: Promise<BlockLinkWriter> | null = null;
const blockLinkWriterOf = () => blockLinkWriterLoaded ??= import("./blockLinkWriter").then((m) => m.makeBlockLinkWriter(context));
export const blockLinkWriter: BlockLinkWriter = {
  bind: async (...args) => (await blockLinkWriterOf()).bind(...args),
  confirm: async (...args) => (await blockLinkWriterOf()).confirm(...args),
  counts: async (...args) => (await blockLinkWriterOf()).counts(...args),
};
const mutations = makeNodeMutations(context);
/** Note creation, the home page, versions and extraction (a body is saved on
 *  its base through `drafts`). A note's lifecycle actions (delete, duplicate,
 *  hide, …) are `nodeActions`. */
export const nodeMutations = {
  createNode: mutations.createNode,
  setHomeNode: mutations.setHomeNode,
  restoreVersion: mutations.restoreVersion,
  restoreInkVersion: mutations.restoreInkVersion,
  undeleteNode: mutations.undeleteNode,
  extractToEntity: mutations.extractToEntity,
};
/** A note's lifecycle actions by id, for every surface (nodeActions.ts). */
export const nodeActions = makeNodeActions(context, mutations, {
  get selectedId() { return getAppState().selectedId; },
  clear: () => setSelectedId(null),
  select: (id) => setSelectedId(id),
  get listIsSeparateScreen() { return isMobileLayout(); },
});

/** What a caller may change about the context its own writers use. */
export type WriterOptions = {
  /** Where failures are told (default: the app's toasts); `() => {}` to stay quiet
   *  when the caller reports them itself. */
  notify?: DataCtx["addToast"];
  /** The caller's own view of the connection (default: the store's). */
  online?: boolean | (() => boolean);
  /** What runs after a write that needs a reload (default: the app's refresh). */
  refresh?: () => Promise<void>;
};

/** Writers bound to a context of their own — for callers that report
 *  failures themselves, keep their own connection state or refresh — sharing
 *  every save/queue/rollback rule with the app's writers. Each writer is made
 *  on first use. The app's own writers are the exported singletons above. */
export function writersFor(options: WriterOptions = {}) {
  const { notify = addToast, online, refresh } = options;
  const ctx: DataCtx = {
    get data() { return getAppState().data; },
    get online() { return typeof online === "function" ? online() : online ?? getAppState().online; },
    setData, addToast: notify,
    scheduleUserFolderSync: () => lifecycle.scheduleUserFolderSync(),
    refresh: refresh ?? (() => lifecycle.refresh()),
  };
  const made = new Map<string, unknown>();
  const once = <T>(key: string, make: () => T): T => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key) as T;
  };
  return {
    get note() { return once("note", () => makeNoteWriter(ctx)); },
    get tag() { return once("tag", () => makeTagWriter(ctx)); },
    get task() { return once("task", () => makeTaskWriter(ctx)); },
    get focus() { return once("focus", () => makeFocusWriter(ctx)); },
    get relation() { return once("relation", () => makeRelationWriter(ctx)); },
    get workspace() { return once("workspace", () => makeWorkspaceWriter(ctx)); },
    /** Restoring a note's earlier version or bringing it back right after a delete (the undo toast). */
    get history() { return once("history", () => makeNoteHistoryWriter(ctx)); },
    /** One online write (a decision the server must accept first): resource, path, body, offline message. */
    get online() { return once("online", () => makeOnlineWrite(ctx)); },
  };
}

const canvasContext: CanvasCtx = {
  get online() { return getAppState().online; },
  get data() { return getAppState().data; },
  setData,
  get activeCanvas() { return getAppState().activeCanvas; },
  setActiveCanvas,
  addToast,
  scheduleUserFolderSync: () => lifecycle.scheduleUserFolderSync(),
  tagBoard(id) {
    const { data } = getAppState();
    const tag = data.tags?.find((row) => row.id === id);
    return tag ? { title: tag.name, memberIds: tagBoardMemberIds(data.nodes, id) } : null;
  },
};
/** Canvas creation, the open board and its cards. The canvas list is the
 *  canvas nodes (selectCanvases); a canvas is renamed and trashed as a note. */
export const canvasWriter = makeCanvasWriter(canvasContext);
