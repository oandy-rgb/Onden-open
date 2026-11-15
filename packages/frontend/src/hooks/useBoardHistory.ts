// 白板上唯一的復原紀錄（只在這次開啟的白板內有效，不跨工作階段；
// 跨工作階段的復原是事件紀錄的 restoreEvent）。
//
// 卡片層（移動、移除、連線）與手寫層（筆畫、形狀、橡皮擦、移動）各自把「可復原的動作」
// 登記成一個項目；⌘Z／⌘⇧Z 不管在哪個模式，都照時間順序退回上一個動作。
// 項目的 undo／redo 回傳 false ＝ 這個動作已無事可做（例如卡片之後又被移動過），項目從紀錄移除。
// 回傳 true 才算完成，項目換到另一邊；丟出錯誤＝被拒絕，項目留在原處可再試。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runBackgroundWrite } from "../lib/data";

const STACK_CAP = 50;

export type BoardHistoryEntry = {
  undo: () => Promise<boolean> | boolean;
  redo: () => Promise<boolean> | boolean;
};

export type BoardHistory = {
  /** 登記一個剛完成的動作。新動作會讓「已退回」的那一邊失效。 */
  push: (entry: BoardHistoryEntry) => void;
  /** 一個手勢同時動到兩層（例如拖動框選的卡片與筆畫）：`fn` 裡同步登記的動作合成一步，
   *  復原時整組一起退回。`fn` 不可以等待。 */
  batch: (fn: () => void) => void;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  canUndo: boolean;
  canRedo: boolean;
};

export function useBoardHistory({ canvasId }: { canvasId: string | null }): BoardHistory {
  const undoStack = useRef<BoardHistoryEntry[]>([]);
  const redoStack = useRef<BoardHistoryEntry[]>([]);
  const busy = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // 換一張白板就是另一份紀錄。
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    busy.current = false;
    setCanUndo(false);
    setCanRedo(false);
  }, [canvasId]);

  const refresh = useCallback(() => {
    setCanUndo(!busy.current && undoStack.current.length > 0);
    setCanRedo(!busy.current && redoStack.current.length > 0);
  }, []);

  const batching = useRef<BoardHistoryEntry[] | null>(null);

  const push = useCallback((entry: BoardHistoryEntry) => {
    if (batching.current) { batching.current.push(entry); return; }
    undoStack.current.push(entry);
    if (undoStack.current.length > STACK_CAP) undoStack.current.shift();
    redoStack.current = [];
    refresh();
  }, [refresh]);

  const batch = useCallback((fn: () => void) => {
    const collected: BoardHistoryEntry[] = [];
    const outer = batching.current;
    batching.current = collected;
    try { fn(); } finally { batching.current = outer; }
    if (collected.length === 0) return;
    if (collected.length === 1) { push(collected[0]!); return; }
    push({
      // 後做的先退回；其中一項已無事可做（回傳 false）不擋住其他項。
      undo: async () => {
        let any = false;
        for (const entry of [...collected].reverse()) any = (await entry.undo()) || any;
        return any;
      },
      redo: async () => {
        let any = false;
        for (const entry of collected) any = (await entry.redo()) || any;
        return any;
      },
    });
  }, [push]);

  const step = useCallback(async (direction: "undo" | "redo"): Promise<boolean> => {
    const undoing = direction === "undo";
    const from = undoing ? undoStack.current : redoStack.current;
    const entry = from.at(-1);
    if (!entry || busy.current) return false;
    // 等待期間若有新動作，「已退回」那一邊會被換成新的一份；舊的動作不能放進去。
    const target = undoing ? redoStack.current : undoStack.current;
    busy.current = true;
    setCanUndo(false);
    setCanRedo(false);
    try {
      const done = await (undoing ? entry.undo() : entry.redo());
      // 等待期間若換了白板，或有新動作，只移除這一筆，不動較新的紀錄。
      const index = from.indexOf(entry);
      if (index >= 0) from.splice(index, 1);
      const sameBoard = from === (undoing ? undoStack.current : redoStack.current);
      if (done && sameBoard && target === (undoing ? redoStack.current : undoStack.current)) target.push(entry);
      return done;
    } finally {
      if (from === (undoing ? undoStack.current : redoStack.current)) {
        busy.current = false;
        refresh();
      }
    }
  }, [refresh]);

  const undo = useCallback(() => step("undo"), [step]);
  const redo = useCallback(() => step("redo"), [step]);

  // 白板開著時的 ⌘Z／⌘⇧Z；文字欄位、編輯器自己的復原不搶。筆模式也一樣：同一個按鍵、同一條紀錄。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // 更近的地方已經處理了這次按鍵（例如 PDF 卡片的筆畫）：一次按鍵只復原一次。
      if (e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest(".cm-editor"))) return;
      const redoing = e.shiftKey;
      if ((redoing ? redoStack : undoStack).current.length) {
        e.preventDefault();
        runBackgroundWrite(redoing ? redo() : undo());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  return useMemo(() => ({ push, batch, undo, redo, canUndo, canRedo }), [push, batch, undo, redo, canUndo, canRedo]);
}
