// 測試台共用型別。位置單位：合成筆記用 UTF-16 code unit（與 CodeMirror 一致）；
// 論文的 trace 用檔案自己的單位（unicode 字元），見 traces.ts。

/** [位置, 刪除長度, 插入文字]；刪除與插入不會同時出現（與 diamond-types 匯出格式一致）。 */
export type PatchOp = [pos: number, del: number, ins: string];

/** 一筆交易：同一人連續做的一串編輯，parents 是版本編號（LV），LV＝每個單位操作一號。 */
export interface Txn {
  agent: string;
  /** 這筆交易第一個單位操作的 LV */
  start: number;
  /** 父版本 LV 清單（空＝從空文件開始） */
  parents: number[];
  ops: PatchOp[];
}

export const opUnits = (op: PatchOp): number => (op[1] > 0 ? op[1] : op[2].length);
export const txnUnits = (t: Txn): number => t.ops.reduce((n, o) => n + opUnits(o), 0);

/** 一份可重放的編輯歷史。 */
export interface History {
  txns: Txn[];
  /** 全部合併後的預期文字（若來源有提供） */
  endContent?: string;
}

/** 合成情境：從共同版本分兩支再合併。 */
export interface ForkScenario {
  id: string;
  sizeBytes: number;
  edits: number;
  seed: number;
  base: string;
  /** A、B 各自改完的文字（用於 diff3） */
  textA: string;
  textB: string;
  /** 歷史：base → A 支 → B 支（LV 連續，B 的 parent 與 A 相同，皆為 base 的最後一個 LV） */
  history: History;
  /** base 最後一個 LV */
  baseHead: number;
  /** 兩支的單位操作範圍 [start,end) */
  rangeA: [number, number];
  rangeB: [number, number];
  /** 各自的編輯數與種類統計（報告用） */
  kinds: Record<string, number>;
}
