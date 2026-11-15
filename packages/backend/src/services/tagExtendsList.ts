import { isUuid } from "@onden/markdown";

/** 標籤的 tag_schema.extends 清單；任何不合格式的當作沒有。成員查詢、欄位繼承與功能引用共用這個解析。
 *  獨立成葉節點檔案：functionRefs ↔ tagWrites ↔ tagFields 都要它，放在任何一邊都會形成 import 循環。 */
export function extendsIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && isUuid(id)))];
}
