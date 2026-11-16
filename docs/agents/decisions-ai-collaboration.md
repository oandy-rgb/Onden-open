# AI 協作的決定：AI 的修改先是「待審建議」

> 狀態：現行（最後確認 2026-11-01）

何時讀：改 AI（MCP、訂閱 runner、@ai）對筆記的寫入、待審建議（接受／拒絕／過時）、`write_mode`、@ai 的回覆、
AI 工作階段的整組復原，或在 `mutate` 附近加「某種操作者只能寫某些事件」的規則時。

> 2026-11-01：AI 整個是可關閉的模組 `ai`（預設關著、同意一次才開、關掉資料照留），見 [ai-is-a-module.md](../decisions/ai-is-a-module.md)。
>
> 2026-10-30 起另有「批 3＋4：API 跑法」一節，在文末。

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

## 已實作的契約

### 誰只能提建議：`write_mode`，由 `mutate` 強制

- `actors.write_mode`（`suggest`｜`apply`）是 agent 自己的設定，與 token 一起由 `spine/currentActor.ts` 讀成 `TokenScope.writeMode`
  （每次寫入都在事件鎖後重讀；請求內容、舊的 actor 快照都不能改它）。
- `mutate()` 對 `actor.type === 'agent'` 且 `writeMode === 'suggest'` 的操作者，**只允許** `AI_SUGGESTION_CREATED`，其他事件拋 `ScopeError('suggest_only')`
  （`spine/toolScope.ts` `assertWriteModeAllows`）。任何入口只要走 `mutate` 就被擋，不靠工具清單隱藏；級聯（cascade）沿用根操作者，同樣被擋。
- 工具：`updateNode` 在 `suggest` 下改為存建議（回 `status: "suggested"`，模型看得到筆記沒改）；新工具 `suggestEdit`（同參數，任何模式都能用）與
  `commentOnNote`（留言）。`createNode`／`applyTag`／`removeTag` 在 `suggest` 下被 `mutate` 拒絕，錯誤訊息要模型改用留言說明。
  既有 token 的 `allowed_tools` 是發行當時展開的清單，**不會自動多出新工具**（既有規則）；`updateNode` 仍可用並自動轉成建議。

### 建議怎麼存、怎麼接受

- 表 `ai_edit_suggestions`（一次提議：筆記、提議的 agent、session、AI 讀到的內文與標題＝合併基準）與 `ai_edit_suggestion_items`（一處：replace／insert／delete／title／comment；
  以段落為單位，用「段落文字＋第幾個相同段落」定位，不用字元位置）。`services/aiSuggestionBlocks.ts` 做段落切分、差異與套用（圍欄程式碼視為一段）。
- **接受＝一次被約束的 `updateNode`**（`services/aiSuggestions.ts` `acceptSuggestionItems`）：事件鎖內以接受者**目前**的權限，把選中的處套在 AI 讀到的內文上，
  用 `baseMarkdown` 三方合併到現在的內文；`updateNode` 新選項 `onConflict: "refuse"` 讓「雙方改了同一行」整次不寫（`BodyConflictError`），不覆蓋使用者剛寫的字。
  「全部」先整組一次；合不進去就逐處（每處 `withSavepoint`），合不進的標 `stale`（沒寫入，畫面說「這段你已經改過了」），其餘照寫。
  事件操作者是接受的人；`NODE_UPDATED` 的 `tx_meta.suggested_by = { actor_id, session_id }` 連回提議者。
- 一段被 AI 改寫、但 AI 沒寫 `^id` 時，套用會補回它原本的 `^id`（別的筆記用它連到這一段，AI 改字不該弄斷連結）；接受時的 `updateNode` 也補回區塊節點遺失的 id（`writeBlockIds: true`，和 agent 工具自己的存檔一樣）。
- 狀態只由 `UPDATE … WHERE status = 'pending'` 守衛轉移，終態不變：`accepted`／`rejected`／`stale`／`void`（筆記被移到別的空間）／`replaced`（同一 session 對同一筆記再提一組，舊的 pending 在同一交易標 `replaced`）。
  兩個裝置同時接受：一個成功，其餘回 `alreadyDecided`；同一提議重送（重試的工具呼叫）回已存在的那組，不重複建立。
- 事件：`AI_SUGGESTION_CREATED`（agent，目標是筆記）、`AI_SUGGESTION_ACCEPTED`／`AI_SUGGESTION_REJECTED`（人，與狀態同一交易）。
  失敗的嘗試（過時、沒權限）不是事件；沒權限時所有處維持 pending。建議的可見性＝能讀該筆記；只有可編輯者能接受／拒絕（`canDecide`）。
- 路由：`GET /api/ai-suggestions?node_id=`、`POST /api/ai-suggestions/:id/accept|reject`（`item_ids` 或 `"all"`；token 不能決定）、`POST /api/agent-sessions/:id/insert-reply`。

### 復原

`services/history/agentRuns.ts` 的「執行」也收 `tx_meta.suggested_by.session_id` 有值的 `NODE_UPDATED`（以提議者為 agent、session 為 run），
所以 History 的「復原這次修改」包含已被接受的處（照舊三方合併、不覆蓋後續編輯）。`revertSession`（@ai 整組復原）另把該 session 還在 pending 的處全部拒絕，
並對已接受的處走同一個 run 復原；使用者之後自己改的行保留。沒有 session 的建議（常駐 MCP token）不成為 run：已接受的處當一般編輯復原。

## 和提案文件不同之處

- **表名** `ai_edit_suggestions*`，不是 `ai_suggestions*`：後者已被一張無人使用的舊表（summary／tags／edge，bootstrap 仍會讀）占用，本批不動它。
- **migration 編號** 147（提案寫 142–145，main 已到 146）。
- `AI_SUGGESTION_ACCEPTED` 由 `NODE_UPDATED` 的 `within` 在同一交易以級聯寫入，因果上在 `NODE_UPDATED` 之後（提案寫它是根）；分組靠 `suggested_by`，不靠因果鏈。
- `suggested_by` 放 `tx_meta`，不放 `payload`（payload 是同步與歷史消費者讀的內容欄位）。
- 被刪進垃圾桶的筆記：建議隱藏（讀取一律只看 live 節點），從垃圾桶還原後回來；不標 `void`。移到別的空間才標 `void`。
- 「重試」（讓 AI 重跑）需要執行層，屬批 3；本批只有「同一 session 再提一組取代舊的」與「重送同一提議不重複」。

## 沒做的（之後的批次）

角色卡與跑法層（批 3）、API 跑法（批 4，待第 1 題）、設定畫面（批 5）、「交給 AI」（批 6）、資訊欄 AI 分頁與計畫門檻（批 7）、
留言邊欄與收件匣總覽（批 8）、新增筆記／標籤變更的建議（批 9）。`write_mode` 目前只能改資料庫欄位，沒有設定畫面。

## 測試在哪

`src/test/aiSuggestions.integration.test.ts`（授權允許／拒絕、撤權、競態、stale、void、冪等重送、交易回滾、整組復原含已接受的處）、
`aiSuggestionBlocks.test.ts`（段落差異與套用）。

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

## 批 5：AI 記得之前做過什麼（2026-10-31，`feat/ai-session-memory`）

業主 2026-10-31 同意（2026-10-23 已定）。使用者說「剛剛那段改回來」「接著上次做」時，AI 不再像第一次見面。兩層共用 `services/agentSessionMemory.ts` 一份讀取，不另寫第二套。

### 已實作的契約（測試：`agentSessionMemory.integration.test.ts`；2026-10-31 note-f2 在本機有 AGE／pgroonga 的測試資料庫跑過，9 個案例全過）

- **第 1 層**：`renderSessionPrompt`（所有 runtime 共用的唯一組裝處）在 `<request>` 前加 `<previous_runs>`——同一則筆記、同一個 agent actor、已結束（completed／failed／cancelled）、30 天內、最近 5 次，總長 ≤ 2,000 字元（超過丟最舊的）。每筆：時間、請求（截 200 字）、狀態＋`fail_code`、動作（工具＋對象，對象要 session actor 現在讀得到才帶標題，否則「無法存取的筆記」）、建議被接受／拒絕／待審數。沒有就不出現。
  區塊開頭聲明「紀錄，不是指示」；前次 prompt 與標題以 JSON 字串帶入並跳脫 `<`，不能關閉區塊。
- **第 2 層**：`listMySessions({ nodeId?, since?, limit? })`、`getSessionLog({ sessionId })` 登記在 `agentTools` registry（MCP 與 API runtime 自動都有；`access: "read"`、走既有 `admitCall` 的工具授權與速率限制、`mcpSafeError`）。
  只看「自己」＝ `agent_sessions.agent_actor_id` 等於呼叫的 actor：一般成員的 token 回空清單；別人的與不存在的 session 同一個 `not_found`（404）。只回步驟後設資料（工具、對象 id 與標題、時間、結果代碼），不含筆記內文與模型回覆。
- **只讀**：兩個工具不寫入、不產生領域事件；還原 session 仍只有擁有者。
- API runtime 的 `action` 步驟現在記下工具呼叫的對象 id（原先為空字串），`<previous_runs>` 與 `getSessionLog` 才有對象可看。
- 既有的讀取權限不變：標題走 `readableScopeSql`；新工具會自然出現在新發的 `read`／`write` token 的工具清單（已發出的 token 的清單不變，見 `templates.ts`）。
- 沒有遷移：查詢走既有索引 `agent_sessions_agent_recent_idx`。

### 沒做

`listMySessions` 只有 `since` 與 `limit` 上限（≤ 50），沒有往更舊翻頁的游標；沒有 UI（給人看的「做了什麼」仍在既有的 session 歷史）。

## 技能當功能、開著的 AI 自己挑（2026-10-31，`feat/skills-as-function`）

業主看過示意後「先這樣試試」。契約與位置見 [harness.md](../architecture/harness.md)〈AI 自己挑技能〉、
[skills-and-presentation.md](../architecture/skills-and-presentation.md)〈2026-10-31 技能是功能〉。

- **技能是功能不是標籤**（判斷法：功能關掉後這個分類還有沒有意義）：`#技能` 不在任何標籤清單、選擇器、搜尋、指令面板、`{` 選單出現；
  「當成技能」開關就是加／移除模組的內部標籤，資料不變、不寫遷移。規則集中在 `isTagShown`（`lib/nodeTags.ts`），模組用 `noteSwitch` 宣告。
- **AI 自己挑取代「一律手動」**：開著「給 AI 用」的技能（`ai` 鍵沒寫＝開）才列進 `<available_skills>`；關著的只有點名才用。
  `loadSkill` 是 registry 裡唯一的載入工具，與點名技能走同一套讀取權限與外部 AI 開關；工具回 `null` 不洩漏技能存不存在。
- **不變**：AI 的結果仍是待審建議；不新增模型呼叫、預設模型、全域金鑰；API 跑法以外不 import 模型 SDK。
- **取捨**：`GET /api/skills` 列出全部並附 `aiUse`（設定頁要顯示關著的，`?for_ai=1` 才只列開著的）；MCP `prompts/list` 只列開著的，
  `prompts/get` 以名稱點名關著的照常可用（該次請求才註冊）。內建技能預設全開，可在設定頁逐一關掉（帳戶設定 `aiSkillsOff`）。
- **沒做**：AI 不能自己新增或修改技能；`<available_skills>` 不排序到每則筆記的歷史使用率；「稍後讀」「複習」尚未改成筆記開關（擴充點已留）。

## 批 6：交給 AI——選取文字與段落（2026-10-31，`feat/hand-to-ai`）

設計見提案 §5.1。**不改既有決定**：結果一律是待審建議；API 跑法永遠只能提建議；沒有預設模型；不新增 prompt 資料表。

### 已實作的契約

- **技能**：內建 `rewrite`／`shorten`／`translate`／`explain`（`harness/builtinSkills.ts`，與 `expand`／`fix` 同為文字技能，預設全開，可在設定逐一關掉）。
  「解釋」沒有在任務清單裡，但預設動作要有，所以補了：回傳原文＋一則引用區塊的說明，結果仍是替換選取文字的建議。
  選單列出的動作＝「內建技能存在且對 AI 開著」（`offeredActions`）；關掉的不出現。
- **入口**：選取工具列新增圖示按鈕 `ai`（和其他格式一樣可在設定›工具列調整；用圖示不用字，這樣手機列只標兩個 Onden 按鈕的限制不會把它擠進「更多」）；
  「這段」選單新增一項「AI」（桌面段落把手與手機底部列的「這段」是同一份選單，所以手機也有，沒另做長按）。
  段落對象＝該段文字去掉結尾的 `{標籤}` 與 `^id`（模型改寫時不會弄丟）。只在能編輯的筆記出現（唯讀不畫）；離線時選單只顯示原因。
- **用哪個角色、哪種跑法**：`GET /api/ai/hand-to-ai?node_id=` 回傳 `can_hand_off`（沒有該筆記的 `write_node` 就是 false）與每個角色現在可用的跑法
  （誰能送沿用 @ 提及的 `mentionablesFor` 規則；只列目前能用的）。`POST /api/ai/selection-actions` 多一個 `runtime`，只管這一次；沒給＝角色的預設跑法。
  - API：單次串流，結束才建立建議（原有）。
  - 訂閱／MCP：`kind='selection_action'` 的 session 排隊等領取，由 runner／使用者的 Claude 用同一個 `finish()` 回覆；`finish` 對選取動作改為建立同一種「替換選取文字」建議
    （`services/selectionDelivery.ts`，API 與這條路共用）。MCP 沒有可用 token 時拒絕（`runtime_unavailable`）。
- **串流預覽**：`GET /api/ai/selection-actions/:id/stream`（SSE，只有發起人或擁有者）送 `{kind:"text"}` 片段，最後一個 `{kind:"end", status, fail_code}`。
  預覽只存在這個 process 的記憶體（`agentRuntime/api/liveRun.ts`），不寫資料庫；建議的內容來自串流結束後的完整文字，所以預覽與建議一致。
- **取消**：`cancel()` 結束 session 後呼叫 `abortLive`，中止模型呼叫（不再計費）；交付前再檢查 session 還在執行，已取消就不建立建議。
  取消與完成同時發生時以先到者為準（取消回 `session_ended`＝建議已經產生，這是完成的結果，不是半則建議）。
- **畫面**：結果浮動卡用 `ui/Popover`；訂閱／MCP 沿用 @ai 狀態卡的文字（`sessionCard`），輪詢同一個 session；失敗只顯示一句白話，不顯示代碼。
  完成後重新讀取建議列表，差異就在原位出現，接受／拒絕沿用 `AiSuggestionBar`。

### 取捨與沒做

- 卡片上的「再試一次」只在失敗或取消時出現；已產生的建議要重試，用既有建議列的做法（拒絕後再交給 AI；原文被改過時有「讓 AI 重試」）。
- 預覽在單一 process 內；多 process 部署時，連到另一個 process 的 SSE 看不到片段（只會等到結束訊息），結果仍會出現在筆記。
- 離開筆記時進行中的 API 請求不會自動取消，結果仍會變成那篇筆記的建議。
- MCP 跑法沒有「列出待領取請求」的工具（批 3 其餘部分），請求等使用者的 Claude 經 runner 介面領取。
- 整合測試（`aiRuntimeApi.integration.test.ts` 新增的案例）寫好了，但撰寫這批時的環境沒有 AGE／pgroonga、Postgres 版本也太舊，**沒有跑過**；前端與純函式測試有跑。

## AI 角色設定補完：審核規則、跑法狀態、本月用量（2026-10-31，`feat/ai-role-settings`，提案 §5.6、批 5）

業主「AI 下一步也要」。端點沿用 `/api/ai/roles`（`routes/aiRuntime.ts`、`services/aiRoles.ts`），不新增第二個 `/api/ai-roles`。

- **審核規則＝既有的 `actors.write_mode`**：`suggest`＝「先給我看（建議）」、`apply`＝「直接改（之後可以復原）」。`PATCH /api/ai/roles/:actor_id`
  可改 `review_rule`、`default_runtime`、`enabled`；每一項各自是一筆領域事件（`AI_ROLE_REVIEW_RULE_SET`、`AI_ROLE_RUNTIME_SET`、`AGENT_RUNNER_TOGGLED`），
  寫入走 `mutate` 的 `principal_admin`，所以直接改的內容仍進歷史、可復原。不能做的（API 沒有金鑰或模型）在寫任何一項之前就拒絕。
- **API 跑法永遠只能提建議**：回應帶 `review_rule_locked`（預設跑法是 API 時為真），畫面顯示「先給我看」並停用開關、寫一句原因；
  存的值仍保留（角色的 MCP 金鑰照它）。從「先給我看」改成「直接改」前畫面確認一次，說明後果（修改馬上進筆記、不等接受、可從歷史復原）；反方向不用確認。
- **只有擁有者、不收委派 token**：`GET`／`PATCH`／`PUT runtime` 先 `requirePerson`（403），再 `isWorkspaceOwner`；路徑 id 不是 uuid 回 400；
  body 不認識的欄位（含想直接傳 `write_mode`）回 400。
- **跑法能不能用從事實算**：訂閱＝`agent_runners.runner_seen_at`（遷移 152；執行程式每次輪詢 `/api/mcp/sessions/pending` 時更新，同一角色 10 秒內不重寫，
  不產生事件）。2 分鐘內有輪詢＝在線；沒有＝`runner_offline`；從沒有＝`runner_never_seen`。MCP＝有沒有未撤銷的金鑰，加上金鑰 `last_used_at` 的最大值（有沒有收到過呼叫）。
  API 沿用原有判斷。**這只影響顯示**：訂閱角色的工作階段離線時照樣排隊（`chooseRuntime` 沒變），畫面也允許選離線的訂閱當預設。
- **本月用量**：本月（UTC）`agent_sessions` 的輸入／輸出 token 加總；金額只在「本月有 API 工作階段且每一筆都有價格」時給（價格來自 `agentRuntime/api/prices.ts` 的表），
  否則為 null、畫面不顯示金額。訂閱與 MCP 沒有金額。
- **沒做**：新增角色精靈沒改（已有）；本機沒有顯示 API 的「模型顯示名稱」（只存模型字串，要顯示得再用金鑰查一次清單）；`GET` 的 `spaces` 目前只有後端回，畫面仍用既有的名冊。

## 資訊欄「AI」分頁（2026-10-31，`feat/info-panel-ai`，提案 §5.3、批 7 的前半）

業主決定：要一個能「隨口問 AI」的地方，不用寫 `@ai` 進筆記；不另開側欄，放進筆記右邊的資訊欄當第 4 個分頁「AI」。
**不改既有決定**：API 跑法永遠只能提建議；沒有預設模型；既有 MCP token 維持直接寫入；不新增全域 API key；模型 SDK 仍只在 `agentRuntime/api/`。

### 三個入口各管什麼（底層共用同一套 session、角色、跑法、工具、紀錄）

| 入口 | 用途 | 結果去哪 |
|---|---|---|
| 選字或 ¶ →「交給 AI」 | 對一段文字做一個動作 | 一則待審建議（替換那段文字） |
| 資訊欄的「AI」分頁 | 問問題、討論、找資料 | 回答留在分頁；要改筆記時才變成待審建議 |
| 內文的 `@ai` | 把 AI 叫進筆記做事，留下紀錄 | 回覆區塊（或建議） |

### 一則筆記的一段對話怎麼用現有的 session 表達（兩案比較，選 A）

- **A（採用）**：一次提問＝一個 `agent_sessions`，`kind='panel_chat'`（遷移 150 早就保留了這個值）。
  對話＝同一個人在同一則筆記上、尚未清除的 `panel_chat` sessions 依建立時間排列；新一則的 `parent_session_id` 指向上一則。
  優點：成本、用量、上限、取消、逾時、session token、工具稽核、`<previous_runs>`（#1053 的執行摘要）全部不用另寫；`request_id` 的冪等語意（網路失敗後重送同一個問題不會問兩次）原樣沿用；不增加表。
  代價：「一段對話」沒有自己的 id，是查詢的結果；每一則回答都是一次獨立的模型呼叫，前面的問答由伺服器每次重新帶進去（最近 8 則完成的往返）。
- **B（不採用）**：新增 `ai_conversations`／`ai_messages` 表。對話會有穩定 id，可以分享或命名，但要重做用量、取消、逾時與稽核，
  而且「這是不是 AI 做的事」會有兩個來源。目前沒有需要對話本身有 id 的功能；若之後要多條對話或分享，再從 A 遷移（`parent_session_id` 已經把序列存下來了）。
- **存哪裡**：`agent_sessions`（遷移 153 加 `scope_node_ids`、`scope_tag_ids`、`chat_cleared_at`）。跟著筆記與提問者，不跟裝置，所以換裝置或下次打開都在。
  這些欄位是顯示與帳務用的事實，不是領域事件：不同步、不復原。`AGENT_SESSION_STARTED`／`ENDED` 仍照 session 的規則記一筆（只有 node_id 與 kind，不含問題文字）。
- **清除這段對話**：`DELETE /api/ai/panel-chat/:nodeId` 只設 `chat_cleared_at`（session 與用量留著，帳要算得清楚）；之後的提問不接這些 session、模型也不再看到。
  有回答還在寫時拒絕（`chat_busy`），要先按停止。清除只影響自己的對話。

### 契約

- `GET /api/ai/panel-chat/:nodeId/roles`（誰能回答、各跑法現在能不能用與原因；和「交給 AI」同一份角色邏輯 `handToAiRoles`，但**唯讀的人也能問**：他們要的修改只是建議，要有編輯權才能接受）。
  `GET /api/ai/panel-chat/:nodeId` 讀對話；`POST /api/ai/panel-chat` 提問（`request_id` 冪等）。串流沿用 `GET /api/ai/selection-actions/:id/stream`，多了 `step`（正在讀〈某筆記〉、搜尋）與 `restart`（工具回合結束，前面串的不是答案）兩種片段。
- **誰能問**：必須是人（不是 token）、能讀該筆記、是這個 AI 的擁有者（`mayDirect`，和 `@ai`、交給 AI 相同）、AI 在該空間有編輯權且空間允許外部 AI。
  設成「API 只做小動作」的角色不接對話（`runtime_not_allowed`），畫面會先在跑法清單看到原因。
- **範圍**：預設＝目前這則筆記（不存）。`@` 加進來的筆記與標籤存在該則提問上；筆記必須是提問者讀得到、**同一個空間**的（session token 一次只到一個空間，`scope_other_space`），標籤要看得到；最多 8 個。
  標籤展開成它底下最近編輯的筆記，整個提問最多帶 20 則（沿用 harness 的上限）。讀取一律過「提問者的讀取範圍 ∩ 角色權限 ∩ 空間的外部 AI 開關」（harness `gatherNodes`），不另判斷。
- **出處**：只列 session 紀錄裡「讀過」的筆記（一開始帶進提示的筆記，加上工具呼叫讀的），而且提問者現在讀得到。回答裡的 `[[標題#^區塊id]]` 只有在該筆記真的讀過、而且真的有那個區塊 id 時才附上區塊，
  否則只列筆記，不假裝有依據。
- **AI 要改筆記**：session 的 `write_mode` 固定是 `suggest`，`updateNode`／`suggestEdit` 一律變成待審建議（既有的 `services/aiSuggestions.ts`），其他領域事件被 spine 擋下。
  回答下方顯示「提了 N 處修改」（來自該 session 的建議項目），可以「全部接受」「全部捨棄」（走既有 `/api/ai-suggestions/:id/accept|reject`，接受前先儲存筆記），或「到筆記裡看」捲到筆記頂端既有的建議列。
  訂閱／MCP 跑法的 `finish()` 對 `panel_chat` 一律把回答存在 session（`reply_markdown`），不管角色設成直接改還是建議：這不是 @ 回覆，不會寫進筆記。
- **「放進筆記」不走待審**：這是擁有者自己對自己的筆記做的編輯（他按了、他看到了內容），不是 AI 的寫入。所以走一般的草稿寫入（`drafts.editText`／編輯器游標），像打字一樣自動儲存、進版本歷史、可以復原；
  待審建議是給「AI 自己想改」的把關，用在這裡只會多一道沒有意義的確認。可以只選回答的一部分放進去；游標一直沒放進文字裡（還在最前面且沒有焦點）就放在文末。
  復原＝把剛放進去的那段文字拿掉，只有它還原封不動在原處才做，之後被改過就保留現況並說明，不假成功（版本紀錄仍可回到先前的樣子）。
- **沒有跑法時**：分頁說明原因（無角色、角色關著、沒有金鑰…沿用設定頁 `useRuntimeText` 的白話），並有「打開 AI 設定」。離線時說需要連線。
- **載入**：分頁的程式（`components/infoAi/`）在點到「AI」分頁時才載入，不在開機 JS 內。預設分頁：筆記沒有標籤、功能、段落標題、關係時預設開「AI」，擁有者自己點過的分頁照舊優先。

### 取捨與沒做

- `@` 的選單用 `rankByTitle`（和 `[[` 同一個排序）自己畫一個小清單，沒有直接重用編輯器的 CodeMirror 補完元件：那個元件綁在編輯器的文件與游標上，輸入框是一般 `<textarea>`。
- 回答用純文字顯示（保留換行，`[[連結]]` 去掉括號，出處另列在下面），沒有排版 Markdown；「放進筆記」放進去的是原始 Markdown。
- 串流片段只存在跑這個請求的 process 記憶體（和「交給 AI」相同）；多 process 部署時另一個 process 看不到片段，只會等到結束訊息，回答仍會在結束後讀出來。
- 自動觸發（AI 自己決定回答）、計畫門檻、AI 留言不在這批。

## AI 中立：任何服務都能接（2026-11-01，`feat/ai-vendor-neutral`）

業主決定：Onden 的 AI 是中立的，介面、文件、程式註解與設定都不出現商家或產品名；「不要預設模型」。

- **稱呼**：繁中 AI 不再翻成特定品牌；`aiVendorNames.guard.test.ts`（前後端各一）守住產品程式、字串檔、`.env.example`、
  `docs/self-host/`、`changes/`。唯一例外是 `services/agentRuntime/api/protocols/`，由 catalog 入口 `ai-protocol-client` 指出。
- **協定轉接層**：`protocols/` 對外是 `ProtocolClient`（`turn`、`listModels`）。兩種格式：`/v1/messages`、`/v1/chat/completions`；
  不再用任何模型 SDK，工具迴圈由 `api/run.ts` 自己跑（`MAX_TURNS`、`assertMayContinue`、token 上限沿用）。
  新增格式＝加一個轉接檔並列入 `protocols/index.ts`。
- **金鑰屬於一個服務**：`ai_credentials.base_url`＋`protocol`（新增時自動偵測 `{base}/models` 的形狀，偵測不出來才請使用者選）。
  模型清單只來自服務即時回傳。價格是使用者在金鑰上自己填的每百萬 token 價格（可留白，留白就只顯示 token）。
- **上限以 token 為準**（`agent_runners.monthly_cap_tokens`）。舊的美元上限遷移時以最貴舊價格保守換算。
- **網路搜尋**：服務的模型清單回報支援才提供開關，不用模型名稱判斷。
- **環境變數**：`ONDEN_AI_BASE_URL_OVERRIDE`（舊名 `ONDEN_ANTHROPIC_BASE_URL` 仍讀）把所有金鑰導向同一個服務，測試用。
- 遷移：`156_ai_any_service.sql`；既有金鑰補上當時固定的網址與格式，已存的金鑰與角色設定照樣能用。
- 伺服器會連使用者填的網址（包含本機網路上的模型伺服器）；只有工作區擁有者能新增金鑰。

## 加入 AI 角色只剩 API 與 MCP（2026-11-01，`feat/ai-vendor-neutral`）

業主決定：跑法只剩兩種。原本的 `subscription`（執行程式用角色金鑰長輪詢 `/api/mcp/sessions/pending` 領工作）本質上就是一個自動跑的 MCP 用戶端，併進 `mcp`。

- `RuntimeKind` 只剩 `api`、`mcp`；`services/agentRuntime/subscription.ts` 刪除。遷移 `157_ai_runtime_api_or_mcp.sql` 把角色與 session 的 `subscription` 轉成 `mcp`，
  金鑰、排隊中的 session、`runner_seen_at` 都保留；`pending`／`claim` 只看 `runtime <> 'api'`，已在跑的 runner 不用改。
- `runner_never_seen`／`runner_offline` 不再是「不可用」的理由，併進 mcp 的「上次來」（`last_seen_at`＝輪詢時間與金鑰最近使用時間較晚者）。
  `chooseRuntime` 不再有「離線也照樣排隊」的例外：mcp 只在沒有金鑰或角色停用時才拒絕，其餘一律排隊等用戶端來領。
- 前端「加入 AI 角色」兩個選項：API（選金鑰、模型、token 上限；建好後直接設成 API）、MCP（發金鑰，顯示一次）。兩者都設 @名稱並啟用。
- 自動領工作的做法：`docs/self-host/ai-client-on-a-machine.md`；程式是 `packages/ai-answerer`（2026-11-15 起取代手寫輪詢腳本）。AI 命令列工具一律被關起來執行（無內建工具、不讀個人設定、空資料夾、只用 session 金鑰連 Onden 的 MCP），旗標由 `adapters/safety.guard.test.ts` 鎖住。
- 桌面版的「用這台電腦上的 AI 回答」按鈕（2026-11-15）：設計見 [desktop-ai-answering-2026-11-15.md](../architecture/proposals/desktop-ai-answering-2026-11-15.md)；連線碼只存在桌面版的加密儲存，網頁只能經 `window.ondenDesktop.ai` 那幾個動作要求開／關。

## AI 建議多一個「比較」看法（2026-11-02，`feat/text-compare`）

筆記上方 AI 建議列多一個「比較」：左邊目前內文，右邊（手機是單欄）套用全部建議後的內文，每一處可接受／退回。筆記內的既有顯示照舊。

- 元件是共用的 `components/compare` 的 `TextCompare`（契約在 `comparePlaces.ts`）。它**只顯示**：不改文件、不用 `acceptChunk`。每一處的按鈕由呼叫者給（`placeActions`）。
- 「處」不靠重新 diff 猜：`lib/aiSuggestionCompare.ts` 依 `layoutSuggestions` 的 `Place` 自己切（replace 換掉段落、delete 連同後面的空行拿掉、insert 接在段落後，與伺服器 `applyItems` 同一種切法），
  經 `diffConfig.override` 交給比較元件，所以畫面上一處＝一則建議。同一段落上的兩則建議合成一處、一起決定；comment 不改文字，不在比較裡（仍在建議列）。
- 按鈕呼叫 `useAiSuggestions.decidePlaces`（一個建議一次 `decide`，第一個被拒就停）：伺服器答應前只是處理中（按鈕停用），失敗保留原狀，成功後重讀清單，畫面才少一處。這是預覽：實際寫入以伺服器的 `applyItems` 為準（例如伺服器會保留段落原有的 `^id`，預覽不顯示這點）。

## 接受建議要得到 AI 送出的原文；審核卡片只列還沒決定的（2026-11-11，`fix/ai-suggestion-apply-and-card`）

- 一處（段落）的 `new_text` 現在帶著「它在新版後面接的分隔」（`text + after`，`aiSuggestionBlocks.ts` 的 `encodeUnit`／`decodeUnit`）。
  全部接受＝新版逐字；部分接受時每個區塊的分隔來自它所屬的版本，不會替別的區塊補空行、也不會把緊密清單拆成鬆散清單。
  最後一段沒有後面的分隔，存的是裸文字，套用時退回它所接的原段落的分隔（舊資料同樣）。對前端 `suggestionsForNode` 會去掉分隔，畫面看到的字不變。
- 什麼算「一處」：段落的字、縮排、硬換行（行尾兩個空白）不同；或同一段後面的空行出現／消失（清單緊密↔鬆散、標題後加空行，即使畫面看不出差別也寫進去，因為全部接受要得到 AI 的原文）。
  一個空行改兩個空行、單行行尾一個空白、筆記最前最後的空白不算。只改間距的處前端寫「只改了這一段前後的間距」，只改縮排或行尾的處寫「只改了這一段的縮排或行尾」（由伺服器在每一處的 `change` 欄位說，前端不自己推）；不畫成「X → X」。
  AI 送來的換行字元改成筆記原本的（CRLF 筆記維持 CRLF）。接在筆記最後一段之後的第一個新段落，自己帶著它前面的分隔（最後一段沒有可比較的分隔）。
- 一處一處接受：要寫入的文字＝這份建議**已接受的處＋這次選的處**套在 AI 讀到的文字上；合併的起點（base）是「已接受的處套上之後的文字」，所以筆記那側只剩使用者自己後來寫的。
  順序、空行、緊密清單都和一次全部接受相同（整合測試與隨機測試：任意順序逐一接受＝全部接受）。
- 每一處在目前筆記的位置由伺服器回傳（`place`：它現在是哪一段，已接受的處改寫了錨點段落也找得到；`null`＝找不到，前端列成「已改過」）。前端不再用 `base_text` 自己搜尋。
- 清單項目或引用後面直接接的文字（lazy 行）：提案自己這樣寫就照寫（儲存的文字帶一個看不見的記號 `LAZY`，只存在內部）；補空行只在部分接受後兩段變成新鄰居、而提案裡它們本來不相鄰時，
  並且筆記自己沒有這種寫法時才做。補的空行用筆記原本的換行。只改縮排或行尾的處，編輯器的卡片寫「只改了這一段的縮排或行尾」；只改間距的處，編輯器與對照檢視都寫「只改了這一段前後的間距」（對照檢視把它列在文字比較下方，不畫兩份相同文字）。
- 先接受搬動的新處、再接受刪除原處：`^id` 這串字會不見，但連結靠的是段落錨點（跟著文字走，見 `blockAnchors`），不是這串字，所以不會斷；同時接受兩者時 `^id` 留在新處（原處已刪，沒有重複）。
- 段落搬位置（兩版順序不同）：搬走的那段是「原處刪除＋新處插入」兩處，因為一處只能說出內容、不能說出順序。插入一律接在新版中它前面「沒動的」那一段後面。
  只接受新處、不刪原處時，新處的 `^id` 不寫（一個 id 只屬於一個區塊）；開頭新增的段落落在前言（frontmatter）之後。
- 刪掉兩個區塊之間的區塊後，若剩下的分隔是單一換行會讓兩段併成一段、或讓文字變成上方清單項目／引用的延續行，套用時補一個空行（最小限度，保持區塊分開）；兩段在原筆記本來就相鄰時分隔照舊。
- 收件匣的 `AI_SUGGESTION_CREATED`：只在它的建議還有 pending／stale 的處時列出（`inboxQueue.suggestionStillWaitingSql`，以事件記的 `suggestion_id` 找，不需要新索引）；全部決定完自動離開，不需要為它寫 `event_reviews`。stale 的處由人「忽略」（reject）結掉，`rejectSuggestionItems` 接受 stale。
  前端在決定之後經 `aiSuggestionsBus` 讓收件匣重讀。審核卡片的動詞走 `eventVerb`，找不到時退回 `eventTypeLabel`，不再顯示事件代碼。
- 尚未做：審核卡片沒有「全部接受／全部退回」，也不顯示改了什麼；逐處決定仍在筆記內。要不要在卡片上做是介面決定，另議。

## 設定 › AI（擁有者 2026-11-10，`feat/settings-ai-page`，第 1 步）

業主決定：AI 的金鑰、AI 角色精靈、連線碼、統計不再藏在「設定 › 空間與成員」裡，搬到獨立的「設定 › AI」頁（左欄「工作區」，排在「空間與成員」後面，只有擁有者看得到，AI 模組關閉時仍在，因為它就是打開 AI 的入口）。資料表本來就把金鑰（`ai_credentials`）和 AI 身分（角色上的 `api_credential_id`、`api_model`）分開，所以**不動資料表、不做 migration**。分兩步：第 1 步＝新頁面、舊入口先留；第 2 步＝「空間與成員」改版並拿掉舊入口。

- **連線與 AI 身分分開**。連線＝一把 API 金鑰，或一組連線碼（`agent_tokens`，屬於一個 AI）；AI＝用某條連線的那個角色。連線不見了（金鑰被刪、或沒選過）的 AI 仍在，頁面顯示「停用中」＋原因＋「換連線」。目前沒有「停用金鑰」狀態，只有刪除（撤銷）；要加停用得動資料表，這次不做。
- **一條連線＋一個 AI（最常見）畫成一張合併卡**；連線或 AI 超過一個才分「連線」「你的 AI」兩區。兩種排法用同一批卡片元件（`settings/ai/AiCard`、`ConnectionCards`），版面由 `model.ts` 的 `aiPageLayout` 只看數量決定：`first-use`／`merged`／`split`；一變多、多變一時畫面自然切換。
- **金鑰先「測試」才能儲存**：`POST /api/ai/credentials/test`（未儲存的金鑰）與 `POST /api/ai/credentials/:id/test`（已儲存的）回格式與該金鑰回報的模型清單；失敗分「金鑰不被接受」（`credential_rejected`）與「連不上」（`service_unreachable`）。模型只來自這份清單，沒有預設模型，整頁不出現廠商或模型品牌名（`aiSettingsPage.guard.test.ts`）。
- **第一條連線自動建 `@ai`**：`POST /api/ai/roles`（`services/aiSetup.ts` 的 `setUpAi`）在**一個交易**裡依序呼叫既有的領域操作——存金鑰（要的話）、`createActor`、`configureRunner`、`setRoleRuntime`、`setMember`、`setRunnerEnabled`、`mintToken`（連線碼）——任何一步被拒就全部回滾，不會留下沒有連線的 AI 或沒人用的金鑰。查服務（偵測格式）在交易之前，不佔事件鎖。`@ai` 被用了就取第一個沒被用的 `ai2`、`ai3`…（自己指定的代號撞名則回 `handle_taken`，不默默改）。新 AI 一律「先給我審」（`createActor` 本來就讓 agent 從 `suggest` 開始）。前端在建好 AI 後用 `changeModuleImport("ai", true)` 把 AI 模組打開。
- **空間權限跟著「讓 AI 讀」，而且這個流程絕不打開它**：新 AI 只在「讓 AI 讀」已經開著的共用空間得到「可看」，關著的空間不在。任何流程（第一次使用、新增連線、新增 AI、換連線）都沒有寫空間的程式路徑；`aiSetup.integration.test.ts` 與 `AiSettings.test.tsx` 各自鎖住這點。已知後果：API 跑法要在「讓 AI 讀」開著的空間有「可編輯」才可用（`apiAvailability.reachesAnySpace`），所以新建的 AI 一開始會顯示「在一個讓 AI 讀的空間給它『可編輯』，它才能提建議」，由擁有者在「編輯 AI」的空間列調整。
- **空間權限只有一份元件與一條寫入路徑**：`settings/ai/standing.tsx` 的 `useStandingWriter`（`setMember`＋復原提示）、`useAllowAiRead`（先確認再開關）、`StandingCell`（一個空間一列；「讓 AI 讀」關著的空間，選單停用並寫明「這個空間不讓 AI 讀」，旁邊一顆「打開讓 AI 讀」）。這次接「AI 看各空間」（編輯 AI）與「空間與成員」原本的「人看各空間」；第 2 步「空間看各 AI」直接用同一個 hook 與 cell，不另寫。`PermissionControl` 也搬到 `settings/ai/`。
- **舊入口先留著但同一批元件**：「空間與成員」的金鑰區塊改用同一組金鑰卡與新增表單（含「測試」），上方加一行提示與「前往 AI 設定」；連線碼、`FreshKey`（只顯示一次）、AI 統計（`AiActivity`）、暫停（`toggleMention`）、`ApiSettingsFields`／`ApiRuntimeSetup`／`AiRoleStatus`／`HelperMention` 都搬到 `settings/ai/` 並由舊位置 import。加入 AI 角色精靈暫時保留它自己「逐空間挑選」的建立順序（第 2 步一起拿掉）。
- **API 契約**：`GET /api/ai/roles` 的 `api` 多了 `credential_id`（只回還有效的金鑰；金鑰名與末四碼不變）；新增 `/credentials/test`、`/credentials/:id/test`、`POST /roles`。型別在 `@onden/contract` 的 `ai.ts`（前端 `aiRoleInfo.ts` 用它，不再各寫一份）。呼叫端只有 `packages/frontend`（瀏覽器版 browser-app 與 MCP 都不呼叫這些路徑）。
- **第 2 步（之後）**：「空間與成員」每個空間改「成員｜設定」分頁，用 `useStandingWriter`／`StandingCell` 畫「空間看各 AI」，並拿掉舊的金鑰、精靈、連線碼、AI 詳情入口。

## 手機上的 AI：筆記上方的底部面板；對話的版面與用詞（業主 2026-11-15，`feat/note-ai-phone-sheet`）

業主在 400px 手機上用過資訊欄的「AI」分頁後決定：手機上問 AI 不該要離開筆記（資訊畫面會取代筆記內容，每問一次就得切過去再切回來），而且那個分頁看起來沒做完。

- **一個對話元件，兩個框**。`components/infoAi/NoteAiConversation.tsx`（誰回答、對話、空白開頭、AI 會讀的內容、輸入框）是唯一的對話畫面；對話狀態由框擁有（`useNoteAi`），框只決定放在哪裡：
  資訊欄在筆記旁邊時（既有判斷：`useIsMobile`，≤900px 資訊畫面取代內容；沒有新增斷點）＝右欄的「AI」分頁（`InfoAiTab`）；資訊畫面取代內容時＝**沒有 AI 分頁**，改成筆記上方的底部面板（`PhoneAiPanel`）。對話仍是同一段伺服器端對話（每則筆記一段），換寬度後同一批問答都在。
- **面板三種高度**（`lib/notePhoneAi.ts` 只記這個；程式碼首次打開才載入，開機只有頂欄按鈕與 `NotePhoneAiHost` 的殼）：
  - 一列（bar）：貼在底部導覽上方（編輯器開著鍵盤時貼在鍵盤與格式列上方），用幾個字說現在的狀態——「AI 正在回答…」「等你的電腦…」、上一則回答的開頭、或「問問這則筆記」；筆記維持可捲動、**可編輯**（不是 modal：沒有 `<dialog>`、背景沒有 inert、頁面沒有鎖捲動）。點一列＝半版。這一列只在這次造訪、這則筆記打開過面板後才有，或有回答在等時出現（等的時候不給收掉）；可以用 ✕ 收起來，頂欄按鈕再叫回來。
  - 半版：約半個螢幕，上面的筆記看得到也能捲；往下拖＝一列、往上拖＝全版（拖曳在 `ui/SheetHandle` 的 `SheetDockHandle`）。
  - 全版：長回答用。
  - 輸入框有焦點且鍵盤開著時，面板佔滿鍵盤上方的空間（這時看不到筆記，是已知限制）。
  - 上一層：全版 → 半版 → 一列 →（一列時不再接手）離開筆記照舊。走既有的 `useDismiss`（Esc 與系統返回同一個堆疊，`hooks/useEscapeKey.ts`）：全版與半版各登記一次，一列時不登記，所以返回會離開筆記；輸入框有鍵盤時，第一次返回／Esc 只收鍵盤。換筆記時舊筆記的面板不留在畫面上。
  - 「放進筆記」與「到筆記裡看」會先縮成一列，再把位置顯示出來。
- **Sheet 只有一個主人（`components/ui`）**：非 modal 的底部面板是同資料夾的 `DockedSheet`（`SheetDock.tsx`，三種高度），`ui/Sheet` 原本 modal 的路徑沒動。獨立成檔是為了開機預算：它跟著面板的程式載入，不進第一個畫面。面板把自己的高度發佈成 `--ui-dock-clearance`，頁面底部留出同樣的空間，筆記最後幾行不會被蓋住。
- **用詞**：不出現 MCP。`runtimeName`／`targetLine`（`lib/handToAi.ts`）改用設定頁的白話：「API 金鑰」「你自己的 AI」；一個 AI 只有一種跑法時只顯示 AI 的名字，真的有選擇（一個 AI 有兩種跑法）才顯示「名字 · 跑法」。「交給 AI」選單與 @ 提及共用同一組字。
  （任務說明提到的 `fix/ai-settings-connection-code` 分支在 remote 不存在，所以沿用設定 › AI 頁現在的用詞；那個分支改了連線碼的說法時，只需要改 `runtimeName` 一處。）
- **等待**：不串流的跑法（連線碼）等待時用 session 真的回報的狀態說話：排隊中＝「等你的電腦來接這個問題…」、已送達＝「你的 AI 收到了，正要開始…」、執行中＝「你的 AI 正在處理…」；排隊超過 45 秒沒人接＝「負責回答的電腦可能沒開機，或沒有連上網路」。「取消」呼叫既有的 `/api/agent-sessions/:id/cancel`。伺服器沒有回報「用了某個工具」，所以這裡不編造那個狀態（只有 API 串流有步驟）。一列的高度說同樣的狀態（短版）。
- **輸入框**：空的時候一行高，長到約六行再捲動，沒有縮放把手；送出是框內右邊的箭頭圖示按鈕（有名稱，手機 44px，可送／不可送看得出來）。桌面 Enter 送出、Shift+Enter 換行；手機 Enter 換行、⌘/Ctrl+Enter 送出；輸入法選字的 Enter 永遠不送（`lib/keys.ts` 的 `isImeComposing`，`imeKeys.guard.test.ts` 的掃描與 `e2e/fullstack/imeInputs.spec.ts` 都涵蓋）。
- **空白狀態**：一句話（它是做什麼的；你同意之前 AI 不改任何內容）加三個可以直接點的開頭（摘要這則筆記、找相關筆記、建議怎麼改），點了就送出，輸入框裡打到一半的字不動。沒有插圖。
- **AI 會讀的內容**：輸入框上方的小標籤：這則筆記（固定，沒有 ✕）、用 `@` 加進來的筆記與標籤（可以移除）。`ScopeBox` 改樣式，沒有重做。
- **沒變的**：送到伺服器的內容、回答怎麼存、`write_mode`（一律只提建議）、離線時的行為都沒動。`onShowContent` 只剩「功能」分頁的導覽還在用，AI 這條手機路徑（先切回內容再跳轉）已移除。
