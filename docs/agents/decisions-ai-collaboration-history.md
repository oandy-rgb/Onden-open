# AI 協作的決定：歷史紀錄

> 狀態：歷史紀錄（寫於 2026-10-30；現行規則見 [decisions-ai-collaboration.md](decisions-ai-collaboration.md)）

從 [decisions-ai-collaboration.md](decisions-ai-collaboration.md) 搬來的原文，不改寫：分批的範圍與進度、被取代的做法（模型 SDK、美元上限、`subscription` 跑法）、當時的環境說明。
下面每一節標明它原本在哪一節。其中提到的檔案、函式、遷移編號是寫當時的樣子，現在可能已改名或刪除。

## 原「檔頭」的批次說明

> 2026-10-30 起另有「批 3＋4：API 跑法」一節，在文末。

## 原「來源與範圍」

來源與範圍：設計提案 [ai-collaboration-2026-10-27.md](../architecture/proposals/ai-collaboration-2026-10-27.md)（PR #874）。
業主 2026-10-30 說「AI 也派」，並授權第 9 節照建議做，**只做第 10 節的最小可用切片＝批 0＋1＋2**：
不需要 API 跑法、不需要新跑法；現有訂閱 runner、MCP 與 @ai 的 AI 修改改成「待審建議」，使用者在筆記裡逐處接受或拒絕。
批 0＝本文；批 1＝後端（`feat/ai-suggest-core`）；批 2＝筆記裡的畫面與 @ai 回覆（`feat/ai-suggest-ui`）。

## 第 9 節各題怎麼處理

| 題 | 決定 | 本切片 |
| --- | --- | --- |
| 1 重新引入 API 跑法 | **業主 2026-10-30 同意：「加回來，但共用 mcp 的架構」**（部分推翻 10/23）。API 跑法在 `feat/ai-runtime-api` 實作，見下方「批 3＋4」 | 本切片（批 0＋1＋2）本身仍沒有伺服器端模型呼叫；API 跑法是疊在它上面的另一個 PR |
| 2 既有角色與 MCP token 的審核規則 | **和提案建議不同**：新建立的角色（`createActor` 建的 agent）預設 `suggest`；**已存在的角色與其 MCP token 維持現行直接寫入（`apply`），不自動遷移**。原因：業主目前有 Claude Code 等工作階段用 MCP 直接寫入，不在沒告知下改變它們 | migration 把既有 agent 設為 `apply`；`actors.write_mode` 預設值是 `apply`（其他建立路徑如 System、測試不變），`createActor` 明確寫 `suggest`。角色卡上的切換屬批 3（角色卡），本切片只有資料與強制 |
| 3 誰能提建議 | 可編輯＝可提建議；可看只能讀（與之後的留言）。v1 建議只涵蓋內文、標題、留言 | 提建議要對該筆記有 `write_node`；新增筆記與標籤變更在 `suggest` 下被 `mutate` 拒絕（`suggest_only`），訊息指引改用留言 |
| 4 @ai 回覆 | (b) 回覆顯示在側欄，要寫進筆記時按「插入筆記」＝一則建議 | `suggest` 模式的 agent 完成時回覆存在 session（`reply_markdown`），不寫筆記；「插入筆記」呼叫 `insertReplyAsSuggestion` 建一則 insert 建議。`apply` 模式的既有 agent 照舊把回覆寫進筆記 |
| 10 總覽 | v1 只做筆記內逐處接受，不做收件匣總覽 | 沒有總覽 |
| 11 `[[` 參考 | v1 只限同空間 | 沒有側欄對話，無此項 |
| 13 未處理的建議 | 不刪除；30 天未處理標「較舊」，不自動拒絕 | `suggestionsForNode` 回 `older`，畫面標示 |
| 其餘（5–9、12、14） | 屬 API 跑法／角色卡／計畫門檻，本切片不涉及 | 未實作 |

## 原「和提案文件不同之處」中已過時的兩條

- **migration 編號** 147（提案寫 142–145，main 已到 146）。
- 「重試」（讓 AI 重跑）需要執行層，屬批 3；本批只有「同一 session 再提一組取代舊的」與「重送同一提議不重複」。

## 原「沒做的（之後的批次）」


角色卡與跑法層（批 3）、API 跑法（批 4，待第 1 題）、設定畫面（批 5）、「交給 AI」（批 6）、資訊欄 AI 分頁與計畫門檻（批 7）、
留言邊欄與收件匣總覽（批 8）、新增筆記／標籤變更的建議（批 9）。`write_mode` 目前只能改資料庫欄位，沒有設定畫面。

## 批 3＋4：API 跑法（2026-10-30，`feat/ai-runtime-api`，疊在上面的建議核心之上）

**業主決定**：提案第 9 節第 1 題，「加回來，但共用 mcp 的架構」。同意**部分**推翻 2026-10-23：伺服器可以用使用者自己的 API 金鑰呼叫模型，
但工具、權限、寫入、紀錄全部與 MCP 同一份（提案 §4.1 方案 B），不准另寫第二套工具或第二套權限。
既定：既有 MCP token 與既有角色維持直接寫入（不遷移）；**API 跑法永遠 suggest**；提案 Q12（runner 用 API key 跑）不做。

### 已實作、已測試的契約

- **跑法層** `services/agentRuntime/`：`AgentRuntime { availability(role), dispatch(session) }`。`subscription`＝既有 pull runner 包一層、`mcp`＝既有 MCP，兩者行為不變
  （`dispatch` 什麼都不做）；`chooseRuntime()` 只檢查 `api`，其餘照舊排隊。角色的跑法欄位目前放在既有的 `agent_runners`（提案的改名 `ai_roles` 與 `runner_seen_at`、
  `listPendingRequests` 屬批 3 其餘部分，沒做）。
- **API 跑法**（只在 `services/agentRuntime/api/`；唯一允許 import `@anthropic-ai/sdk`，版本固定 1.3.0；`harnessBoundary.test.ts` 擋其他處）：
  - 工具：`listTools()` registry 的每個工具轉成 `betaZodTool`，`run` 內呼叫**同一個 `callTool`**（同樣的許可檢查、限速、`AGENT_TOOL_*` 稽核）。
    用 `client.beta.messages.toolRunner`（Tool Runner 目前是 beta，SDK 升級可能改介面，所以版本寫死），`max_iterations` ＝ 12 回合。
    不給 `proposeTagPack`（它走 outbox 的待核准，不經 `mutate`，spine 的規則管不到）與 `publish` 類工具。
  - 身分：`actorForRuntimeSession(session)` 是唯一能做出 API session 身分的函式（`test/guards/aiRuntime.guard.test.ts` 鎖定呼叫者）。它是一般 session token
    （`agent_tokens.session_id`），所以空間範圍、撤權、事件鎖後重讀都沿用。
  - **只能提建議**：`agent_sessions.write_mode` 由資料庫約束——`runtime='api'` 的列一定是 `suggest`；`resolveCurrentActor` 重讀時，session 列是 `suggest` 就蓋過 agent 自己的
    `actors.write_mode`（所以設成 `apply` 的角色，它的 API session 仍是 suggest），`mutate()` 對 `suggest` 身分只放行 `AI_SUGGESTION_CREATED`（`assertWriteModeAllows`，含巢狀事件）。
    請求內容不能改它。測試：API 身分直接 `mutate` 寫 `NODE_UPDATED` 等一律拒絕；模型要 `updateNode` 得到建議、要 `createNode` 被擋。
  - 交付：@ai 提及的最終文字存在 session 的 `reply_markdown`，由人按「插入筆記」才成為一則建議（與其他 suggest 角色相同）；小動作的結果在串流結束後以一則 `replace` 建議交付
    （選取文字已變或出現多次 ⇒ `selection_changed`，不建議）。
  - 讀取：送給模型的內容只經 `harness.prompt()`（讀取政策 ∩ 空間 `external_ai`）。
  - 金鑰：`ai_credentials`，AES-256-GCM（`ONDEN_SECRET_KEY`，row id 當 AAD），只回傳標籤與後四碼；明文只能由 `loadApiKey()` 取得，且只有 `agentRuntime/api/` 能 import（守門測試）。
    沒有 `ONDEN_SECRET_KEY` 或沒有金鑰 ⇒ `GET /api/ai/roles` 不回 `api`、`/api/ai/status` 回不提供，前端不出現 API 選項（不是灰掉）。
  - 模型：**沒有預設**；清單用金鑰呼叫 `GET /v1/models`；設定時驗證該模型對這把金鑰存在且未停用；run 時 404 ⇒ `api_model_retired_at`，API 暫停、角色顯示要重選，不自動換。
  - 上限：每 session 最多 12 回合；第一次啟用 API 要答「每月上限」或「不限」（`api_cap_choice`，沒答不能跑）；每回合 `usage` 寫進 session 與紀錄。
    金額是估計（程式內單價表 `prices.ts`，2026-10-06 的公開價；表外的模型只有 token，且有設上限的角色不能用它——算不出就不放行）。
  - outbox 一次性領取：`dispatch` 在建立 session 的同一交易入列 `agent_session_run`；`perform` 只做 `queued→running` 的單一 UPDATE 然後在背景跑（不佔住 drain）；
    中途崩潰 ⇒ 每分鐘的掃描標 `failed(interrupted)`，**不自動重跑**（避免重複花錢）。失敗只留短代碼，不留供應商的錯誤文字；不重試（`maxRetries: 0`）。
  - 小動作（`kind='selection_action'`）：`POST /api/ai/selection-actions`，單次串流呼叫，結束才建立建議；`request_id` 語意冪等。**串流預覽的 SSE 與選取工具列是批 6，這批沒有。**
  - 網頁搜尋：角色欄位，預設關；只記查詢長度，不記內容。
- **設定畫面**（最小入口）：設定›空間與成員頂部「API 金鑰」（新增／撤銷、後四碼；只在伺服器有 `ONDEN_SECRET_KEY` 時出現）；AI 角色的「設定」裡選執行方式、金鑰、模型、每月上限。
- 部署：`ONDEN_SECRET_KEY` 與備份分管見 [deploy.md](deploy.md)。

### 為什麼和 2026-10-23 拿掉的不同（沒消除的風險要說）

被拿掉的是全域 key、預設模型、直接寫入、獨立聊天入口。這次重新引入「伺服器呼叫模型」本身，所以：模型的回答仍可能是錯的（只是不能改你的內容）；
金鑰存在伺服器（外洩面變大）；開網頁搜尋就有外送通道；費用是估計值，不是帳單。

### 還沒做

提案批 3 其餘（`ai_roles` 改名、`runner_seen_at`、MCP 的 `listPendingRequests`、隱含 session）、批 5 的新增角色流程、批 6 的選取工具列與串流預覽、批 7 計畫門檻與出處驗證。
token 用量**沒有量過**（沒有對真 API 跑過任何動作；測試全用假伺服器），所以文件與畫面不宣稱任何實際花費。

## 原「批 5：AI 記得之前做過什麼」的測試說明

### 已實作的契約（測試：`agentSessionMemory.integration.test.ts`；2026-10-31 note-f2 在本機有 AGE／pgroonga 的測試資料庫跑過，9 個案例全過）

## 原「批 6」的測試說明

- 整合測試（`aiRuntimeApi.integration.test.ts` 新增的案例）寫好了，但撰寫這批時的環境沒有 AGE／pgroonga、Postgres 版本也太舊，**沒有跑過**；前端與純函式測試有跑。

## 原「AI 角色設定補完」中被取代的兩條

- **跑法能不能用從事實算**：訂閱＝`agent_runners.runner_seen_at`（遷移 152；執行程式每次輪詢 `/api/mcp/sessions/pending` 時更新，同一角色 10 秒內不重寫，
  不產生事件）。2 分鐘內有輪詢＝在線；沒有＝`runner_offline`；從沒有＝`runner_never_seen`。MCP＝有沒有未撤銷的金鑰，加上金鑰 `last_used_at` 的最大值（有沒有收到過呼叫）。
  API 沿用原有判斷。**這只影響顯示**：訂閱角色的工作階段離線時照樣排隊（`chooseRuntime` 沒變），畫面也允許選離線的訂閱當預設。
- **本月用量**：本月（UTC）`agent_sessions` 的輸入／輸出 token 加總；金額只在「本月有 API 工作階段且每一筆都有價格」時給（價格來自 `agentRuntime/api/prices.ts` 的表），
  否則為 null、畫面不顯示金額。訂閱與 MCP 沒有金額。

## 原「加入 AI 角色只剩 API 與 MCP」中被取代的兩條

- `RuntimeKind` 只剩 `api`、`mcp`；`services/agentRuntime/subscription.ts` 刪除。遷移 `157_ai_runtime_api_or_mcp.sql` 把角色與 session 的 `subscription` 轉成 `mcp`，
  金鑰、排隊中的 session、`runner_seen_at` 都保留；`pending`／`claim` 只看 `runtime <> 'api'`，已在跑的 runner 不用改。
- `runner_never_seen`／`runner_offline` 不再是「不可用」的理由，併進 mcp 的「上次來」（`last_seen_at`＝輪詢時間與金鑰最近使用時間較晚者）。
  `chooseRuntime` 不再有「離線也照樣排隊」的例外：mcp 只在沒有金鑰或角色停用時才拒絕，其餘一律排隊等用戶端來領。

## 原「手機上的 AI」的分支說明

  （任務說明提到的 `fix/ai-settings-connection-code` 分支在 remote 不存在，所以沿用設定 › AI 頁現在的用詞；那個分支改了連線碼的說法時，只需要改 `runtimeName` 一處。）
