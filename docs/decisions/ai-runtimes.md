# 加入 AI 角色只有 API 與 MCP 兩種；API 只能提建議

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

AI 角色的跑法只有兩條：使用者自己的 Claude 透過 MCP／訂閱執行，或伺服器用**使用者自己的 API 金鑰**呼叫模型。兩條都受同一套工具、權限、寫入與紀錄約束；API 跑法只能提出修改建議（待審），由人接受。

## 為什麼

不新增全域金鑰、預設模型、直接寫入的模型迴圈（推翻 2026-10-23 的「不呼叫任何模型」，業主 2026-10-30 同意「加回來，但共用 MCP 架構」）。

## 例外

模型 SDK 只能在 `services/agentRuntime/api/` 內 import（`harnessBoundary.test.ts` 擋）。

## 相關檔案與狀態備註

- packages/backend/src/services/agentRuntime/api/
- [AI 協作的決定](../agents/decisions-ai-collaboration.md)
- [harness](../architecture/harness.md)
- [交給 AI 代理](../architecture/agent-delegation.md)
