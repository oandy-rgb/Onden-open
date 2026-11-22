# 介面不放技術細節

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/frontend/src/lib/serverErrors.ts, packages/frontend/src/lib/data/writeErrors.ts, packages/frontend/src/lib/eventKinds.ts, packages/frontend/src/lib/effectKinds.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-23（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

介面不顯示 JSON、id（含截短）、token id、錯誤代碼、事件常數、毫秒耗時、堆疊與伺服器原文錯誤，也不放在收合的「技術細節」。改用一句白話。

## 為什麼

業主：「JSON 這類技術細節不應該給使用者看」。

## 例外

使用者自己設定的內容（MCP token 名稱與工具清單、輸入的網址、一次性顯示的 token 明文）。

## 相關檔案與狀態備註

- `lib/serverErrors.ts`、`writeErrors.message`、`eventTypeLabel`、`effectKindLabel`
- ESLint 擋 JSX 子節點的 `JSON.stringify`
- [AGENTS.md](../../AGENTS.md)「使用者介面文字」

> 2026-11-18：新增錯誤碼 `module_tag` 的白話訊息（`lib/serverErrors.ts`；中英文，不含代碼或標籤 id）；標籤頁選單對鎖住的標籤顯示一句白話說明，不顯示技術細節。
