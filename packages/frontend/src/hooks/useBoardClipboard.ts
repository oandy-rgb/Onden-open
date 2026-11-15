// 白板的複製／貼上／複製一份（⌘C ⌘V ⌘D，手機選取列 ⋯ 的「複製一份」）。
//
// 貼上卡片＝每張卡片建立一則新筆記（既有的「複製筆記」入口：標題、內文、標籤、屬性照它的規則，
// 子筆記不複製），放在畫面上；兩端都在選取裡的手畫連線畫在新卡片之間；筆跡換新 id 加進筆跡層。
// 整個貼上在白板唯一的復原紀錄（useBoardHistory）裡是一步：復原＝新卡片離開白板、新筆記進垃圾桶、
// 新筆跡退回；重做反過來。選取、工具、復原都沿用白板現有的，這裡不另存一份。
//
// 文字輸入（卡片內文的編輯器、任何輸入框）有焦點時，按鍵屬於文字，白板不攔截。

import { useEffect, useRef, type RefObject } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { addToast } from "../lib/appStore";
import type { CanvasData, ContentNode, NodeEdge } from "../lib/api";
import {
  buildBoardClip, cardFromText, DUPLICATE_OFFSET, heldBoardClip, holdBoardClip, isEmptyBoardClip,
  registerBoardDuplicate, shiftToAnchor, type BoardClip,
} from "../lib/boardClipboard";
import { runBackgroundWrite } from "../lib/data";
import { isBody } from "../lib/documentAccess";
import { onDocument, onWindow } from "../lib/globalEvents";
import { t } from "../lib/i18n";
import type { InkClip } from "../lib/ink";
import type { BoardHistory } from "./useBoardHistory";
import { useStableCallback } from "./useStableCallback";

/** The part of the board's ink layer (components/CanvasInkLayer's handle) that copying needs. */
export type InkClipboardHandle = {
  copySelection: () => InkClip | null;
  pasteClip: (clip: InkClip, dx: number, dy: number) => boolean;
};

/** What pasting writes: every step is the app's own domain write (they report their own failures). */
export type BoardClipboardOps = {
  /** A new note copied from `nodeId` (the existing duplicate rule); null when refused. */
  duplicateNote: (nodeId: string) => Promise<ContentNode | null>;
  /** A new note from text copied elsewhere; null when refused. */
  createNote: (title: string, markdown: string) => Promise<ContentNode | null>;
  placeCard: (nodeId: string, at: { x: number; y: number; width?: number }) => Promise<void>;
  /** The arrow it drew, or null. */
  connect: (sourceId: string, targetId: string) => Promise<NodeEdge | null>;
  /** Take cards off the board (their notes stay). */
  removeCards: (nodeIds: string[]) => Promise<unknown>;
  trashNote: (nodeId: string) => Promise<boolean>;
  untrashNote: (nodeId: string) => Promise<boolean>;
  insertImages: (files: File[], at: { x: number; y: number }) => Promise<void>;
};

type Options = {
  /** The board is on screen and editable (not a tag's board, not centred on another note). */
  enabled: boolean;
  boardId: string | null;
  panelRef: RefObject<HTMLElement | null>;
  rfInstance: ReactFlowInstance | null;
  history: BoardHistory;
  inkRef: RefObject<InkClipboardHandle | null>;
  ops: BoardClipboardOps;
  layout: () => CanvasData | undefined;
  notes: () => readonly ContentNode[];
  edges: () => readonly NodeEdge[];
  /** The selected cards, ids of notes on the board. */
  selectedCardIds: () => readonly string[];
  /** Called with the new cards once pasted, so the board selects them (and the pasted ink, which the layer selects itself). */
  onPasted: (cardIds: string[]) => void;
};

const TEXT_INPUT = "input, textarea, select, [contenteditable=''], [contenteditable='true'], .cm-editor";

/** A copy/paste/key aimed at the board itself: focus on the page or in the board's panel, not in a field. */
function aimedAtBoard(event: Event, panel: HTMLElement | null): boolean {
  const target = event.target instanceof Node ? event.target : null;
  if (target instanceof Element && target.closest(TEXT_INPUT)) return false;
  return !target || isBody(target) || !!panel?.contains(target);
}

export function useBoardClipboard(options: Options) {
  const o = useRef(options);
  o.current = options;
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pasting = useRef(false);

  /** Where a paste lands: the pointer if it is over the board, else the middle of what is on screen. */
  const anchor = (): { x: number; y: number } | null => {
    const { rfInstance, panelRef } = o.current;
    if (!rfInstance) return null;
    const at = pointer.current;
    if (at) return rfInstance.screenToFlowPosition(at);
    const wrap = panelRef.current?.querySelector(".kw-canvas-wrap")?.getBoundingClientRect();
    if (!wrap) return null;
    return rfInstance.screenToFlowPosition({ x: wrap.left + wrap.width / 2, y: wrap.top + wrap.height / 2 });
  };

  const clipOf = (cardIds: readonly string[], withInk: boolean): BoardClip | null => {
    const { layout, notes, edges, inkRef } = o.current;
    const clip = buildBoardClip({
      cardIds, cards: layout()?.nodes ?? [], notes: notes(), edges: edges(),
      ink: withInk ? inkRef.current?.copySelection() ?? null : null,
    });
    return isEmptyBoardClip(clip) ? null : clip;
  };

  /** One paste = one step of the board's history. Resolves once the cards are placed and recorded. */
  const pasteClip = useStableCallback(async (clip: BoardClip, shift: { dx: number; dy: number }) => {
    const { ops, history, inkRef, boardId } = o.current;
    if (pasting.current) return;
    pasting.current = true;
    try {
      const fresh = new Map<string, string>(); // original note id → its copy
      const placed: Array<{ nodeId: string; x: number; y: number; width?: number }> = [];
      for (const card of clip.cards) {
        const note = await ops.duplicateNote(card.nodeId);
        if (!note) continue;
        const at = { x: card.x + shift.dx, y: card.y + shift.dy, ...(card.width ? { width: card.width } : {}) };
        await ops.placeCard(note.id, at);
        fresh.set(card.nodeId, note.id);
        placed.push({ nodeId: note.id, ...at });
      }
      const arrows: Array<{ source: string; target: string }> = [];
      for (const link of clip.links) {
        const source = fresh.get(link.source), target = fresh.get(link.target);
        const edge = source && target ? await ops.connect(source, target) : null;
        if (source && target && edge) arrows.push({ source, target });
      }
      // The person went to another board meanwhile: the cards are on the board they were pasted to; nothing is recorded here.
      if (o.current.boardId !== boardId) return;
      history.batch(() => {
        if (clip.ink && !inkRef.current?.pasteClip(clip.ink, shift.dx, shift.dy)) {
          addToast(t("The drawing could not be pasted here. Pick the pen once on this board, then paste again."), "info");
        }
        if (placed.length) history.push(pasteStep(placed, arrows, ops));
      });
      o.current.onPasted(placed.map((card) => card.nodeId));
    } finally {
      pasting.current = false;
    }
  });

  const pasteAtAnchor = (clip: BoardClip) => {
    const at = anchor();
    if (at) runBackgroundWrite(pasteClip(clip, shiftToAnchor(clip, at)));
  };

  const pasteText = useStableCallback(async (text: string) => {
    const card = cardFromText(text);
    const at = anchor();
    if (!card || !at) return;
    const { ops, history, boardId } = o.current;
    const note = await ops.createNote(card.title, card.markdown);
    if (!note) return;
    const place = { x: Math.round(at.x), y: Math.round(at.y) };
    await ops.placeCard(note.id, place);
    if (o.current.boardId !== boardId) return;
    history.push(pasteStep([{ nodeId: note.id, ...place }], [], ops));
    o.current.onPasted([note.id]);
  });

  const duplicate = (cardIds: readonly string[], withInk: boolean) => {
    const clip = clipOf(cardIds, withInk);
    if (clip) runBackgroundWrite(pasteClip(clip, { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET }));
  };

  const copy = (event: ClipboardEvent) => {
    const clip = clipOf(o.current.selectedCardIds(), true);
    if (!clip) return;
    const text = holdBoardClip(clip);
    // Written by the page's own copy event: no permission prompt, and the cards' text reaches other apps as Markdown.
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };

  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    const text = data.getData("text/plain");
    const held = heldBoardClip(text);
    if (held) { event.preventDefault(); pasteAtAnchor(held); return; }
    const images = [...data.files].filter((file) => file.type.startsWith("image/"));
    const at = anchor();
    if (images.length && at) { event.preventDefault(); runBackgroundWrite(o.current.ops.insertImages(images, at)); return; }
    if (text.trim()) { event.preventDefault(); runBackgroundWrite(pasteText(text)); }
  };

  useEffect(() => {
    if (!options.enabled) return;
    const panel = options.panelRef.current;
    const onMove = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const onLeave = () => { pointer.current = null; };
    panel?.addEventListener("pointermove", onMove);
    panel?.addEventListener("pointerleave", onLeave);
    // Text the person selected on the page is theirs to copy.
    const pageSelection = () => !!window.getSelection()?.toString();
    const stops = [
      onDocument("copy", (e) => { if (aimedAtBoard(e, panel) && !pageSelection()) copy(e); }),
      onDocument("paste", (e) => { if (aimedAtBoard(e, panel)) paste(e); }),
      onWindow("keydown", (e) => {
        if (e.key.toLowerCase() !== "d" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.defaultPrevented) return;
        if (!aimedAtBoard(e, panel)) return;
        const ids = o.current.selectedCardIds();
        if (!ids.length && !o.current.inkRef.current?.copySelection()) return;
        e.preventDefault(); // not the browser's bookmark
        duplicate(ids, true);
      }),
      registerBoardDuplicate((nodeId) => duplicate([nodeId], false)),
    ];
    return () => {
      panel?.removeEventListener("pointermove", onMove);
      panel?.removeEventListener("pointerleave", onLeave);
      for (const stop of stops) stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read the latest options through `o`
  }, [options.enabled, options.panelRef]);
}

/** The history step of one paste: undo takes the cards off the board and the new notes to the trash; redo brings them back. */
function pasteStep(
  placed: ReadonlyArray<{ nodeId: string; x: number; y: number; width?: number }>,
  arrows: ReadonlyArray<{ source: string; target: string }>,
  ops: BoardClipboardOps,
) {
  return {
    undo: async () => {
      await ops.removeCards(placed.map((card) => card.nodeId));
      for (const card of placed) await ops.trashNote(card.nodeId);
      return true;
    },
    redo: async () => {
      const back = new Set<string>();
      for (const card of placed) if (await ops.untrashNote(card.nodeId)) back.add(card.nodeId);
      for (const card of placed) if (back.has(card.nodeId)) await ops.placeCard(card.nodeId, card);
      for (const arrow of arrows) {
        if (back.has(arrow.source) && back.has(arrow.target)) await ops.connect(arrow.source, arrow.target);
      }
      return back.size > 0;
    },
  };
}
