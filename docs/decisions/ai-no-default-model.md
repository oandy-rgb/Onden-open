# AI 不預設模型

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/agentRuntime/api/models.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-14（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

設定頁不預設任何模型；模型清單只來自服務商即時回傳（向使用者自己的金鑰查詢），Onden 不維護模型清單。

## 為什麼

模型更新很快，寫死的預設會過時，也等於替使用者選了付費對象。選中的模型被服務商下架時，角色暫停並等使用者重選，不自動換。

## 例外

—

## 相關檔案與狀態備註

- packages/backend/src/services/agentRuntime/api/models.ts（`listModels`、`markModelRetired`）
- [AI 協作的決定](../agents/decisions-ai-collaboration.md)
