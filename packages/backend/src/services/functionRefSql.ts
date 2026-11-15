import { tagNodeSql } from "../spine/nodeSql.js";
// 功能引用表的 SQL 片段（沒有 import 的葉節點）：節點列的投影（nodeRowProjection）不必把整個 functionRefs 入口拉進來。

/** SQL：節點 `holderAlias`（content_nodes 的別名）的檢視陣列，依建立順序；沒有檢視時是 NULL。
 *  同步用的節點列（nodeRowProjection）與其他需要整個陣列的讀取共用這一段，
 *  所以客戶端與搬遷前拿到同樣形狀（離線的本機副本也是）。 */
export const holderViewsSql = (holderAlias: string): string => `(
  SELECT jsonb_agg(
           r.config || jsonb_build_object('id', r.instance, 'layout', r.function_id,
             CASE WHEN ${tagNodeSql(holderAlias)} THEN 'tag_id' ELSE 'node_id' END, ${holderAlias}.id)
           ORDER BY r.created_at, r.id)
    FROM function_refs r WHERE r.holder_node_id = ${holderAlias}.id AND r.instance <> '')`;

/** SQL: the note (`holder: "node"`) or paragraph (`"block"`) whose id is `idExpr` holds `functionId` itself — a function reference
 *  of its own (review cards, tasks), not one it gets from a tag. `functionId` is a code constant, never input. */
export const ownRefSql = (holder: "node" | "block", idExpr: string, functionId: string): string => {
  if (!/^[a-z_]+$/.test(functionId)) throw new Error(`function id ${functionId} cannot be written into SQL`);
  return `EXISTS (SELECT 1 FROM function_refs own_ref WHERE own_ref.${holder === "block" ? "holder_block_id" : "holder_node_id"} = ${idExpr}`
    + ` AND own_ref.function_id = '${functionId}' AND own_ref.instance = '')`;
};
