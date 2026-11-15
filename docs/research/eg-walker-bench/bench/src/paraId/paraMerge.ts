// 原型的測試台外殼。邏輯本身（切單位、認身分、逐單位合併）已經搬進產品：
// packages/backend/src/services/eventLog/bodyMergeMoves.ts 的 mergeUnits，這裡只把它包成研究報告用的回傳形狀：
// 順序對不起來時，文字交回產品的行級合併（不丟任何一邊的修改），另外標一個衝突讓使用者知道順序要看一下。
// 產品實際的入口是 mergeBody（行級為主，衝突時才補救）；這裡是「整個原型」，量測報告拿它當對照。
import { threeWayMergeBody, type BodyConflict, type BodyMerge } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { mergeUnits } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js";

type UnitMode = "block" | "line";
export type ParaConflictKind = "edit-edit" | "edit-delete" | "move-delete" | "move-move" | "cycle";
export type ParaMerge = BodyMerge & {
  /** 沒有經過段落身分（單位太多等），整個交回產品的合併。 */
  fellBack?: boolean;
  /** 每個衝突的種類（和 conflicts 同序）。 */
  kinds: ParaConflictKind[];
};

/** 認段落身分的三方合併。簽名與 threeWayMergeBody 相同：incoming＝正在存的那邊、current＝伺服器上的。 */
export function paraMergeBody(base: string, incoming: string, current: string, mode: UnitMode = "block"): ParaMerge {
  const line = () => threeWayMergeBody(base, incoming, current);
  if (incoming === current || current === base) return { merged: incoming, clean: true, conflicts: [], kinds: [] };
  if (incoming === base) return { merged: current, clean: true, conflicts: [], kinds: [] };
  const r = mergeUnits(base, incoming, current, mode);
  if (r === null) return { ...line(), fellBack: true, kinds: [] };
  if ("order" in r) {
    const fb = line();
    const whole: BodyConflict = { base, incoming, current, before: "", after: "" };
    return { merged: fb.merged, clean: false, conflicts: [...fb.conflicts, whole], kinds: [...fb.conflicts.map(() => "edit-edit" as const), r.order], fellBack: true };
  }
  return { merged: r.merged, clean: r.conflicts.length === 0, conflicts: r.conflicts, kinds: r.kinds };
}
