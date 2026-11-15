# 內文合併是以行為單位的三方合併

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-17（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

兩邊同時改同一篇內文時，用逐行 diff3；同一行兩邊改得不同才是衝突，不做模糊比對。

## 為什麼

模糊比對可能把修改套到沒看過的文字上；逐行精確比對可預期。

## 例外

—

## 相關檔案與狀態備註

- packages/backend/src/services/eventLog/bodyMerge.ts
- [只送差異的寫入](../architecture/patch-writes.md)
- [同步協定](../architecture/sync-protocol.md)
