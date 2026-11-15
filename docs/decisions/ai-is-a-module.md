# AI 整個是可以關掉的模組

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定：「把 AI 整個做成可以關掉的模組」） |
| 實作狀態 | **已實作**（整合測試需資料庫，見 PR 說明） |

## 決定

AI 是模組 `ai`（前後端各一個），屬於「第一次要同意」的類別（`library.confirmOnce`）：
新工作區預設關著，擁有者同意一次才開；既有工作區若已經有 AI 角色、沒撤銷的 API 金鑰或 MCP 金鑰，
遷移 159 記為已同意（開著），否則關著。技能（`skills`）依賴它（`library.requires`）：AI 關掉，技能一併不提供。

## 關掉的意思

- 介面全部消失：資訊欄 AI 分頁、`@` 提及與「交給 AI」、選取文字與段落選單的 AI 項、「等你決定」裡 AI 的修改與待核可請求、
  設定裡的 AI 角色與 API 金鑰、筆記上的「AI 改過」。
- 後端：`/api/agent-sessions`、`/api/ai-suggestions`、`/api/ai`、`/api/mcp`（含 `/api/mcp/protocol`、角色金鑰）的寫入回 409 `module_not_imported`；
  內建的筆記工具（`getNode`、`updateNode` 等）不列出、呼叫被拒；跑腿用戶端查詢排隊工作得到空清單，所以排隊中的 AI 工作不會被領取。
- 資料不刪：角色、金鑰、歷史、建議、工作階段重新打開後照舊。

## 為什麼

同意立場：AI 相關的一切預設不偷偷開啟；每個功能都是可關的模組（[沒有功能凍結](no-feature-freeze.md)）。

## 例外

- 讀取端點仍可讀（關掉模組保留資料的共同做法）；介面不再呼叫它們。
- 逾時工作階段的清掃仍在跑（只結束已逾期的紀錄，不執行任何 AI 工作）。
- 後端「AI 的背景工作」目前只有這個清掃；API 跑法的工作階段由使用者操作當下開始，關掉後無法開始。

## 相關檔案與狀態備註

- packages/backend/src/modules/ai/index.ts、packages/frontend/src/modules/ai/index.ts
- packages/backend/db/migrations/159_ai_module.sql
- [AI 協作的決定](../agents/decisions-ai-collaboration.md)、[核心與模組](../architecture/core-vs-modules.md)
