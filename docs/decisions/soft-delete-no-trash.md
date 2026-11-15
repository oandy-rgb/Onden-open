# 沒有垃圾桶：軟刪除＋復原提示＋從歷史還原

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-19（10-30 補充）（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

刪除是軟刪除，立刻給「復原」提示；之後從歷史還原（含子樹）。刪除時樹的位置不動，正開著的筆記跳到鄰居。

## 為什麼

垃圾桶是另一個要記得清的地方；歷史本來就保存一切。

## 例外

—

## 相關檔案與狀態備註

- packages/backend/src/services/eventRestore/restore.ts
- `retained_node`／`canReadRetainedNode`（services/readPolicy.ts）
- [復原寫入契約](../architecture/restore-writes.md)
