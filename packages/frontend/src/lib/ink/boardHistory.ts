// 白板的手寫層怎麼進白板唯一的復原紀錄（hooks/useBoardHistory）：
// 引擎每做一個新編輯（畫、形狀、擦、移動），就在紀錄裡登記一步；退回時由紀錄叫引擎退回它自己的那一步。
// 引擎內部的 undo 堆疊與紀錄的順序一致，所以紀錄退到哪一步，引擎就退哪一步。

import type { InkEngine } from "./engine";
import type { InkOp } from "./types";

type Registers = { push: (entry: { undo: () => boolean; redo: () => boolean }) => void };

export function registerInkEdit(history: Registers, getEngine: () => InkEngine | null, op: InkOp): void {
  const entry = { undo: () => getEngine()?.undo() ?? false, redo: () => getEngine()?.redo() ?? false };
  history.push(entry);
  // 停住不動的筆畫變成形狀：退兩步（先形狀、再筆畫），與引擎自己的堆疊一致。
  if (op.type === "snap") history.push({ ...entry });
}
