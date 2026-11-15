import type { Dispatch, SetStateAction } from "react";
import { api, ApiError, type Bootstrap, type Canvas, type CanvasData, type CanvasMeta, type CanvasNodeEntry, type ContentNode } from "../api";
import { upsertCanvas, removeCanvas, loadCanvas, loadCanvases, getPendingWrites, upsertNode, removeNode, putCanvasMemberships } from "../localDb";
import { applyCanvasMembershipChange, boardMembershipChange, type CanvasMembershipChange } from "../canvasMemberships";
import { canvasMeta } from "../canvasList";
import { isWhiteboardNote } from "../whiteboardNote";
import { addNode, dropNode, patchNode } from "./storeOps";
import { randomUUID } from "../uuid";
import { slugify } from "@onden/markdown/slug";
import { classifyWriteFailure, reportWriteFailure, WriteActionError } from "./writeErrors";
import { t } from "../i18n";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle, reconcileFields, inWriteOrder } from "./writeLifecycle";
import type { ToastFn } from "./types";
import { getRecoveryWrites } from "./writeRecovery";
import { targetIds, type TargetedWrite } from "../pendingWriteTargets";
import { diffBoard, isEmptyBoardChange, splitBoardChanges, materializeTagBoard } from "../boardLayout";
import { DEFAULT_CARD_W, SPAWN_GAP_X } from "../cardGeometry";
import { nodeOf } from "../nodeIndex";
import type { CanvasMembership } from "@onden/contract";

/** A canvas IS a note with a whiteboard tab (migration 138; before it, a node
 *  of node_type 'canvas'): the canvas list is those notes in `data`
 *  (lib/canvasList), and a canvas is renamed and trashed as the note it is
 *  (noteWriter, nodeActions). This writer owns creation, the open board and
 *  its cards. */
export type CanvasCtx = {
  online: boolean;
  data: Bootstrap;
  setData: Dispatch<SetStateAction<Bootstrap>>;
  activeCanvas: Canvas | null;
  setActiveCanvas: Dispatch<SetStateAction<Canvas | null>>;
  addToast: ToastFn;
  scheduleUserFolderSync?: () => void;
  /** A tag's canvas lens is a board too: its id is the tag id, its cards are
   *  the tag's members. Null when `id` is not a tag. */
  tagBoard?: (id: string) => { title: string; memberIds: string[] } | null;
};

/** Board layout as GET /api/boards/:id returns it. */
type BoardRead = { id: string; cards: CanvasData["nodes"]; sections: NonNullable<CanvasData["sections"]> };

export function makeCanvasWriter(ctx: CanvasCtx) {
  const commit = makeWriteLifecycle(ctx);
  const layouts = new Map<string, CanvasData>();
  const placements = new Map<string, Promise<void>>();
  let selection = 0;
  // A selected board may not have a local snapshot yet. Keep the read intent
  // so reconnect can open it even when the initial offline read found nothing.
  let selectedCanvasId = ctx.activeCanvas?.id ?? null;
  const revisions = new Map<string, number>();
  const revise = (id: string) => revisions.set(id, (revisions.get(id) ?? 0) + 1);

  const tagBoard = (id: string) => ctx.tagBoard?.(id) ?? null;
  const metaOf = (id: string) => canvasMeta(ctx.data.nodes, id);
  // Tag boards share the local canvases table under their own key, so they
  // never show up in the canvas list read from it.
  const localKey = (id: string) => tagBoard(id) ? `tag-board:${id}` : id;
  async function loadLocal(id: string): Promise<Canvas | null> {
    const row = await loadCanvas(localKey(id));
    return row ? { ...row, id } : null;
  }
  function saveLocal(canvas: { id: string; title: string; created_at?: string; updated_at?: string; data?: CanvasData }) {
    return upsertCanvas({ ...canvas, id: localKey(canvas.id) });
  }
  /** A tag board always shows the tag's current members. */
  function shown(id: string, data: CanvasData): CanvasData {
    const tag = tagBoard(id);
    return tag ? materializeTagBoard(data, tag.memberIds) : data;
  }
  async function fetchBoard(id: string): Promise<Canvas> {
    const tag = tagBoard(id);
    if (!tag) {
      // A note that holds a whiteboard is read whole, with its title, as it has
      // always been. A note not known to have one here (its tab may not have
      // reached this device yet) is read as a layout, as a tag's board is.
      const node = nodeOf(ctx.data, id);
      if (!node || isWhiteboardNote(node)) return api<Canvas>(`/api/canvases/${id}`);
      const board = await api<BoardRead>(`/api/boards/${id}`);
      return { id, title: node.title, created_at: node.created_at ?? "", updated_at: node.updated_at ?? "", data: { nodes: board.cards, sections: board.sections } };
    }
    const board = await api<BoardRead>(`/api/boards/${id}`);
    return { id, title: tag.title, created_at: "", updated_at: "", data: { nodes: board.cards, sections: board.sections } };
  }

  const targetsCanvas = (id: string, write: TargetedWrite) =>
    targetIds(write, "canvas").includes(id) || targetIds(write, "board").includes(id);
  const hasUnconfirmedInput = (id: string) => getRecoveryWrites()
    .some(write => write.rejection === undefined && targetsCanvas(id, write));
  async function hasLocalIntent(id: string): Promise<boolean> {
    // A failed durable save still owns recoverable input. Rejected input is
    // different: its copy stays in recovery, not in the accepted board layout.
    return (await getPendingWrites()).some(write => targetsCanvas(id, write)) || hasUnconfirmedInput(id);
  }

  /** Reconfirm the selected board after replay/reconnect without navigating,
   * including an initial selection whose local snapshot was unavailable.
   * Pending or unconfirmed local intent is retained; a read overtaken by an
   * edit/selection is discarded. Failure propagates so sync cannot claim this
   * check succeeded. A missing/unreadable board loses its local canvas copy,
   * never its note bodies. Only the selected board is fetched, not the whole list. */
  async function refreshOpenCanvas(): Promise<void> {
    const id = selectedCanvasId;
    if (!id) return;
    const ticket = selection;
    await inWriteOrder(`canvas:${id}`, async () => {
      if (ticket !== selection || selectedCanvasId !== id) return;
      const revision = revisions.get(id);
      const current = () => ticket === selection && selectedCanvasId === id && revision === revisions.get(id);
      if (await hasLocalIntent(id)) return;
      let canvas: Canvas | null;
      try { canvas = await fetchBoard(id); }
      catch (error) {
        if (!current()) return;
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        canvas = null;
      }
      if (await hasLocalIntent(id)) return;
      if (!current()) return;
      if (canvas) {
        const board: Canvas = { ...canvas, data: shown(id, canvas.data) };
        await saveLocal(board);
        if (!current()) return;
        layouts.set(id, board.data);
        ctx.setActiveCanvas(board);
      } else {
        await removeCanvas(localKey(id));
        if (!current()) return;
        layouts.delete(id);
        selectedCanvasId = null;
        ctx.setActiveCanvas(null);
      }
    });
  }

  async function select(id: string | null) {
    const ticket = ++selection;
    selectedCanvasId = id;
    // Selection changes immediately retire the old editable surface. Keep its
    // latest input here: an unconfirmed save may be newer than the local mirror.
    if (ctx.activeCanvas) layouts.set(ctx.activeCanvas.id, ctx.activeCanvas.data);
    if (!id) { ctx.setActiveCanvas(null); return; }
    if (ctx.activeCanvas?.id !== id) ctx.setActiveCanvas(null);
    const revision = revisions.get(id);
    return inWriteOrder(`canvas:${id}`, async () => {
      try {
        let canvas: Canvas | null = null;
        const local = !ctx.online || await hasLocalIntent(id);
        if (local) {
          // Confirmed queued input belongs to the durable mirror. Only input
          // whose local persistence failed needs the newer in-memory layout.
          const layout = hasUnconfirmedInput(id) ? layouts.get(id) : undefined;
          const tag = tagBoard(id);
          const meta = tag ? { id, title: tag.title, created_at: "", updated_at: "" } : metaOf(id);
          canvas = layout && meta ? { ...meta, data: layout } : await loadLocal(id);
        }
        // A cold-start selection can begin offline and finish after reconnect
        // sync has already run (while no canvas was open yet). Recheck here.
        if (!local || (ctx.online && !await hasLocalIntent(id))) {
          try { canvas = await fetchBoard(id); }
          catch (error) {
            if (classifyWriteFailure(error) !== "retryable") throw error;
            canvas = await loadLocal(id);
            if (!canvas) throw error;
          }
        }
        if (ticket !== selection) return;
        if (revision !== revisions.get(id)) {
          const tag = tagBoard(id);
          const meta = tag ? { id, title: tag.title, created_at: "", updated_at: "" } : metaOf(id);
          const data = layouts.get(id);
          if (meta && data) ctx.setActiveCanvas({ ...meta, data });
          return;
        }
        if (!canvas) {
          ctx.addToast(t("This canvas is not available on this device. Reconnect and reopen it."), "error");
          return;
        }
        canvas = { ...canvas, data: shown(id, canvas.data) };
        layouts.set(id, canvas.data);
        ctx.setActiveCanvas(canvas);
        try { await saveLocal(canvas); }
        catch { ctx.addToast(t("The canvas is open, but its local copy could not be updated."), "error"); }
      } catch (error) {
        if (ticket !== selection) return;
        reportWriteFailure(error, ctx.addToast);
        throw error;
      }
    });
  }

  /** A new board: its node joins the store (and so the canvas list) at once,
   *  online or not; POST /api/canvases creates it with this id. */
  async function create(title: string, options: { spaceId?: string } = {}): Promise<Canvas> {
    const id = randomUUID();
    revise(id);
    const now = new Date().toISOString();
    const fresh: Canvas = { id, title, created_at: now, updated_at: now, data: { nodes: [] } };
    // A plain note that opens on its whiteboard tab, as POST /api/canvases makes it.
    const node: ContentNode = {
      id, title, slug: slugify(title), markdown: "", source_type: "manual", node_type: "content", created_at: now, updated_at: now,
      collection_views: [{ id: randomUUID(), layout: "canvas", layout_config: { opens_first: true } }],
      ...(options.spaceId ? { space_id: options.spaceId } : {}),
    };
    const previousSelection = ctx.activeCanvas;
    const previousSelectedId = selectedCanvasId;
    const ticket = ++selection;
    selectedCanvasId = id;
    layouts.set(id, fresh.data);
    ctx.setData((state) => state.nodes.some((row) => row.id === id) ? state : addNode(state, node));
    ctx.setActiveCanvas(fresh);
    await commit<CanvasMeta>(`canvas:${id}`, { method: "POST", path: "/api/canvases", body: JSON.stringify({ id, title, ...(options.spaceId ? { space_id: options.spaceId } : {}) }), idemKey: id }, {
      mirror: async () => {
        const current = nodeOf(ctx.data, id);
        if (current) {
          await upsertNode(current);
          await upsertCanvas({ id, title: current.title, created_at: current.created_at, updated_at: current.updated_at, data: layouts.get(id) });
        } else {
          await removeNode(id);
          await removeCanvas(id);
        }
      },
      accepted: (saved) => {
        if (saved.status !== "synced" || saved.value?.id !== id) return;
        const { title: savedTitle, created_at, updated_at } = saved.value;
        const replacement = { title: savedTitle, created_at, updated_at };
        ctx.setData((state) => {
          const current = state.nodes.find((row) => row.id === id);
          return current ? patchNode(state, id, reconcileFields<Partial<ContentNode>>(current, node, replacement)) : state;
        });
        ctx.setActiveCanvas((current) => current?.id === id ? reconcileFields(current, fresh, saved.value) : current);
      },
      rejected: () => {
        ctx.setData((state) => dropNode(state, id));
        if (selection === ticket) {
          selectedCanvasId = previousSelectedId;
          ctx.setActiveCanvas((current) => current?.id === id ? previousSelection : current);
        }
        layouts.delete(id);
      },
    });
    return { ...fresh, ...metaOf(id), data: layouts.get(id) ?? fresh.data };
  }

  /** Re-layout a board. A layout is sent as the cards and sections that
   * differ from the latest local layout, so the server merges it instead of
   * replacing the board. (Its title is the canvas node's: noteWriter.) */
  async function change(id: string, changes: { data: CanvasData }) {
    const previousActive = ctx.activeCanvas?.id === id ? ctx.activeCanvas : null;
    const previousData = layouts.get(id) ?? previousActive?.data ?? (await loadLocal(id))?.data;
    const boardChanges = diffBoard(previousData, changes.data);
    if (isEmptyBoardChange(boardChanges)) {
      // Nothing the server stores changed (e.g. a tag member's grid slot).
      const data = changes.data;
      layouts.set(id, data);
      ctx.setActiveCanvas((current) => current?.id === id ? { ...current, data } : current);
      return;
    }
    revise(id);
    const boards = membershipEdit(id, previousData, changes.data);
    const settle = optimisticFields<{ data?: CanvasData }>(`canvas:${id}`, { data: previousData }, changes);
    const finish = (accepted: boolean) => {
      const { expected, replacement } = settle(accepted);
      if (Object.hasOwn(replacement, "data") && layouts.get(id) === expected.data) {
        if (replacement.data) layouts.set(id, replacement.data);
        else layouts.delete(id);
      }
      ctx.setActiveCanvas((current) => current?.id === id ? reconcileFields<Canvas>(current, expected, replacement) : current);
    };
    layouts.set(id, changes.data);
    ctx.setActiveCanvas((current) => current?.id === id ? { ...current, ...changes } : current);
    boards?.apply();
    // One request per run of at most the server's cap. All are queued now, in order, on this
    // board's lane, so a later change cannot land between two runs. The layout is accepted once
    // the last run is, and rolled back (once) if a run is refused.
    let refused = false;
    const results = splitBoardChanges(boardChanges).map((part, index, all) =>
      commit(`canvas:${id}`, { method: "PATCH", path: `/api/boards/${id}`, body: JSON.stringify(part) }, {
        mirror: async () => {
          const title = metaOf(id)?.title ?? previousActive?.title ?? tagBoard(id)?.title ?? "";
          await saveLocal({ id, title, data: layouts.get(id) });
          await boards?.mirror();
        },
        accepted: index === all.length - 1 ? () => finish(true) : undefined,
        rejected: () => { if (refused) return; refused = true; finish(false); boards?.undo(); },
        unconfirmed: () => { settle(true); },
      }));
    const settled = await Promise.allSettled(results);
    const failure = settled.find((r) => r.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return (settled[settled.length - 1] as PromiseFulfilledResult<Awaited<(typeof results)[number]>>).value;
  }

  /** "Appears on canvases" for a canvas layout change (D98): notes placed on
   *  board `id` join it in `data.canvas_memberships` at once, notes taken off
   *  leave it; `undo` puts back what this change replaced (a refusal), and
   *  `mirror` copies the touched rows from the store to the local mirror.
   *  Null for a tag board (its cards are its members, not placements) or a
   *  change that places or removes nothing. The next delta re-ships the
   *  canvas with the server's list, which then wins. */
  function membershipEdit(id: string, before: CanvasData | undefined, after: CanvasData) {
    if (tagBoard(id)) return null;
    const was = new Set((before?.nodes ?? []).map((card) => card.nodeId));
    const now = new Set(after.nodes.map((card) => card.nodeId));
    const isNote = (nodeId: string) => !!nodeOf(ctx.data, nodeId);
    const placed = [...now].filter((nodeId) => !was.has(nodeId) && isNote(nodeId));
    const removed = [...was].filter((nodeId) => !now.has(nodeId));
    if (placed.length === 0 && removed.length === 0) return null;
    const touched = [...placed, ...removed];
    const rowsOf = (list: readonly CanvasMembership[] | undefined) =>
      (list ?? []).filter((m) => m.canvas_id === id && touched.includes(m.node_id));
    const replaced = rowsOf(ctx.data.canvas_memberships);
    const title = metaOf(id)?.title ?? "";
    const set = (change: CanvasMembershipChange) =>
      ctx.setData((state) => ({ ...state, canvas_memberships: applyCanvasMembershipChange(state.canvas_memberships, change) }));
    return {
      apply: () => set(boardMembershipChange(id, title, placed, removed)),
      undo: () => set({
        upsert: replaced,
        delete: touched.filter((nodeId) => !replaced.some((m) => m.node_id === nodeId)).map((node_id) => ({ canvas_id: id, node_id })),
      }),
      mirror: () => putCanvasMemberships(id, touched, rowsOf(ctx.data.canvas_memberships)),
    };
  }

  /** Run `apply` on the named board's latest layout — what a change made now
   * must build on, never a snapshot captured before an await: the layout in
   * memory, else this device's copy, else (online) the server's. When the
   * layout is in memory `apply` runs synchronously, so a second change started
   * right after already sees this one. Throws when the board is gone or cannot
   * be read. */
  async function withLatestLayout<T>(id: string, apply: (data: CanvasData) => Promise<T>): Promise<T> {
    const latest = () => layouts.get(id) ?? (ctx.activeCanvas?.id === id ? ctx.activeCanvas.data : undefined);
    const known = () => !!tagBoard(id) || !!metaOf(id);
    let data = latest();
    if (!data) {
      const cached = await loadLocal(id);
      data = latest() ?? cached?.data;
    }
    // A board never opened on this device has no local copy yet.
    if (!data && known() && ctx.online) {
      const fetched = await fetchBoard(id).catch(() => null);
      data = latest() ?? (fetched ? shown(id, fetched.data) : undefined);
    }
    if (!data || !known()) {
      throw new WriteActionError(t("The canvas is no longer available. Your note has been kept."));
    }
    return apply(data);
  }

  /** Set fields of one card on the named board's latest local layout (its
   * sub-canvas link, …). A card no longer on the board is left alone. Resolves
   * after server/durable queue acceptance. */
  function updateCard(id: string, nodeId: string, fields: Partial<Omit<CanvasNodeEntry, "nodeId">>): Promise<void> {
    return withLatestLayout(id, async (data) => {
      if (!data.nodes.some(card => card.nodeId === nodeId)) return;
      layouts.set(id, data);
      await change(id, { data: { ...data, nodes: data.nodes.map(card => card.nodeId === nodeId ? { ...card, ...fields } : card) } });
    });
  }

  /** Place an absent note on the named board's latest local layout. Omitted
   * position appends to the right; explicit coordinates (including 0,0) are
   * rounded canvas units. Existing placements keep their geometry. Resolves
   * after server/durable queue acceptance, without changing board selection.
   * This composes local additions, not concurrent snapshots from other tabs. */
  function place(id: string, nodeId: string, position?: { x: number; y: number; width?: number }): Promise<void> {
    const key = `${id}:${nodeId}`;
    const pending = placements.get(key);
    if (pending) return pending;
    const result = append();
    placements.set(key, result);
    const finish = () => { placements.delete(key); };
    void result.then(finish, finish);
    return result;

    function append() {
      return withLatestLayout(id, async (data) => {
        if (data.nodes.some(card => card.nodeId === nodeId)) return;
        const right = data.nodes.reduce((edge, card) => Math.max(edge, card.x + (card.width ?? DEFAULT_CARD_W)), 0);
        const top = data.nodes.reduce((edge, card) => Math.min(edge, card.y), Infinity);
        const point = position ?? (data.nodes.length ? { x: right + SPAWN_GAP_X, y: top } : { x: 100, y: 100 });
        // Publish the read baseline before change(), so it needn't yield for a
        // second cache read between reading and optimistically appending the card.
        layouts.set(id, data);
        const width = position?.width ? { width: Math.round(position.width) } : {};
        await change(id, { data: { ...data, nodes: [...data.nodes, { nodeId, x: Math.round(point.x), y: Math.round(point.y), ...width }] } });
      });
    }
  }

  /** The board's 白板 tab was hidden (`listed` false) or shown again: the
   * notes on it stop or start appearing under "Appears on canvases" at once.
   * The placements themselves are kept (server: services/boardStore
   * whiteboardShownSql), so showing the tab brings the old cards back. The
   * next delta re-ships the board with the server's list, which then wins. A
   * board that cannot be read here is left to that delta. */
  async function setListed(id: string, listed: boolean): Promise<void> {
    if (tagBoard(id)) return;
    const set = (change: CanvasMembershipChange) =>
      ctx.setData((state) => ({ ...state, canvas_memberships: applyCanvasMembershipChange(state.canvas_memberships, change) }));
    if (!listed) {
      const rows = (ctx.data.canvas_memberships ?? []).filter((m) => m.canvas_id === id);
      if (rows.length === 0) return;
      set({ upsert: [], delete: rows });
      await putCanvasMemberships(id, rows.map((m) => m.node_id), []);
      return;
    }
    const layout = await withLatestLayout(id, async (data) => data).catch(() => null);
    const edit = layout && membershipEdit(id, undefined, layout);
    if (!edit) return;
    edit.apply();
    await edit.mirror();
  }

  /** Keep an open tag board in step with the tag's members: newly tagged
   * notes appear in the grid, untagged ones leave the view. Nothing is saved;
   * a card is stored once it is moved, resized or styled. */
  function reconcileTagBoard() {
    const active = ctx.activeCanvas;
    if (!active || !tagBoard(active.id)) return;
    const base = layouts.get(active.id) ?? active.data;
    const next = shown(active.id, base);
    if (next === base && base === active.data) return;
    layouts.set(active.id, next);
    ctx.setActiveCanvas((current) => current?.id === active.id ? { ...current, data: next } : current);
  }

  /** The canvas list changed (`ids`: every canvas node's id). A board whose
   *  node left it — trashed here, from its note or on another device, or no
   *  longer readable — closes, and no read or layout of it lands later. */
  let listed = new Set<string>();
  function followList(ids: readonly string[]) {
    const next = new Set(ids);
    for (const id of listed) {
      if (next.has(id) || tagBoard(id)) continue;
      revise(id);
      layouts.delete(id);
      if (selectedCanvasId === id) { selectedCanvasId = null; selection++; }
      ctx.setActiveCanvas((current) => current?.id === id ? null : current);
    }
    listed = next;
  }

  /** Drop boards the server no longer lists from the offline mirror, so a
   *  board deleted on another device does not come back offline. Keeps any
   *  board with local intent now or when the list was requested (an offline
   *  create that flushed while the list was in flight is in neither the list
   *  nor the queue), and any row made after `listedAt`. Tag boards live under
   *  their own key and are never listed. */
  async function pruneMirror(listed: readonly CanvasMeta[], listedAt: string, queuedAtList: readonly TargetedWrite[] = []): Promise<void> {
    const keep = new Set(listed.map((row) => row.id));
    for (const row of await loadCanvases()) {
      if (keep.has(row.id)) continue;
      if ((row.created_at ?? "") >= listedAt) continue;
      if (queuedAtList.some((write) => targetsCanvas(row.id, write))) continue;
      if (await hasLocalIntent(row.id)) continue;
      await removeCanvas(row.id);
    }
  }

  return { select, refreshOpenCanvas, pruneMirror, followList, reconcileTagBoard, create, place, updateCard, setListed, save: (id: string, data: CanvasData) => change(id, { data }) };
}
