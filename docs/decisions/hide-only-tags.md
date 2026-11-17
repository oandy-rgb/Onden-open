# 「隱藏」只用在標籤

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/backend/src/routes/nodes.ts, packages/backend/src/services/nodeUpdate.ts, packages/frontend/src/lib/sidebarTidy.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-19（業主決定，2026 年） |
| 實作狀態 | **已實作**（2026-11-17 對照程式：見「相關檔案」） |

## 決定

只有標籤有「隱藏」。app 自動建的節點（例如任務、段落節點）不靠隱藏旗標，而由側欄整理規則排除。

## 為什麼

隱藏若到處都有，使用者分不清「不見了」是被刪還是被藏。

## 例外

—

## 相關檔案與狀態備註

- packages/frontend/src/lib/sidebarTidy.ts
- 標籤和筆記是同一張表（`content_nodes`）的列，所以那張表有 `hidden` 欄；它是標籤的隱藏。寫入這一側擋住筆記：建立時 `packages/backend/src/routes/nodes.ts` 回 `only_tags_can_be_hidden`，修改時 `packages/backend/src/services/nodeUpdate.ts` 只允許標籤設成隱藏（已經是隱藏的系統列，例如任務節點、網站設定，可以維持；把筆記重新顯示永遠允許）。
- [段落節點](../architecture/block-nodes.md)
