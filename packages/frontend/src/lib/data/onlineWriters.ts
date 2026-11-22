// The writers whose every write waits for the server, made on their first call (loadedOnFirstUse):
// none of them is used before the person does something that reaches the server, so their code
// is not in the boot JS. The workspace writer is not one of them: saveDesign changes the store at
// once, and the next design save reads that change as its base revision (D119), so it must run synchronously. Each list names the writer's methods; onlineWriters.test.ts checks it
// against the real writer, so a method added there cannot be left out here.
import { loadedOnFirstUse } from "./loadedOnFirstUse";
import type { DataCtx } from "./types";

type MadeBy<M> = M extends (ctx: DataCtx) => infer W ? W : never;
type HistoryWriter = MadeBy<typeof import("./noteHistoryWriter").makeNoteHistoryWriter>;
type BlockChildWriter = MadeBy<typeof import("./blockChildWriter").makeBlockChildWriter>;
type BlockLinkWriter = MadeBy<typeof import("./blockLinkWriter").makeBlockLinkWriter>;

const HISTORY_WRITER_METHODS = ["restoreVersion", "restoreInkVersion", "undelete", "undoAgentRun", "redoAgentRun", "rewindWorkspace", "undoRewind"] as const;
const BLOCK_CHILD_WRITER_METHODS = ["moveToChild", "moveSelectionToChild", "expand", "reassign", "undo"] as const;
/** Part links: only a note with a part link asks. */
const BLOCK_LINK_WRITER_METHODS = ["bind", "confirm", "counts"] as const;

/** Restoring a note's earlier version or bringing it back after a delete, an agent run's undo and redo, a rewind. */
export const historyWriterFor = (ctx: DataCtx) =>
  loadedOnFirstUse<HistoryWriter>(() => import("./noteHistoryWriter").then((m) => m.makeNoteHistoryWriter(ctx)), HISTORY_WRITER_METHODS);
export const blockChildWriterFor = (ctx: DataCtx) =>
  loadedOnFirstUse<BlockChildWriter>(() => import("./blockChildWriter").then((m) => m.makeBlockChildWriter(ctx)), BLOCK_CHILD_WRITER_METHODS);
export const blockLinkWriterFor = (ctx: DataCtx) =>
  loadedOnFirstUse<BlockLinkWriter>(() => import("./blockLinkWriter").then((m) => m.makeBlockLinkWriter(ctx)), BLOCK_LINK_WRITER_METHODS);

/** Fetches the code of all four (lib/offlineWarmup), so a first call also works offline. */
export const loadOnlineWriters = () =>
  Promise.all([import("./noteHistoryWriter"), import("./blockChildWriter"), import("./blockLinkWriter")]);
