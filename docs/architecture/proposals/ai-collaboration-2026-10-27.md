# 提案：AI 協作（一個角色、多種跑法、待審建議）

> 狀態：現行（最後確認 2026-11-01）

> 2026-10-27。**設計提案**；只寫文件，不含程式。實作前由使用者決定第 9 節的問題。
> **2026-10-30 起：批 0＋1＋2（待審建議）已動工**，決定與和本文不同之處見 [decisions-ai-collaboration.md](../../agents/decisions-ai-collaboration.md)；其餘批次（角色與跑法層、API 跑法等）仍是提案。
> 前置閱讀：[交給 AI 代理](../agent-delegation.md)、[harness](../harness.md)、[空間](../spaces.md)、
> [提案：在筆記裡 @提及 AI 代理](../../archive/architecture/agent-mentions-2026-10-22.md)（已實作大半）、[提案：擁有者／成員](roles-owner-member-2026-10-22.md)（後端已實作）。
> 標示：**〔現況〕** 附檔案；**〔建議〕** 是本提案；**〔待驗證〕／〔未確認〕** 是我沒能確認的事。
> 引用的程式皆為 2026-10-27 `origin/main`（`5d16ad5d`）；後端路徑省略 `packages/backend/src/`，前端省略 `packages/frontend/src/`。
> **這份文件會推翻 2026-10-23 的一部分決定**（內建 API AI 整個移除）。AGENTS.md 與 harness.md 的對應修訂列在批 0，
> **使用者同意第 9 節第 1 題之前不改**。

## 0. 一句話結論

**AI 在 Onden 是一個「角色」（名字＋權限＋能進的空間＋技能＋紀錄＋審核規則），它可以用三種「跑法」做事——API、訂閱執行程式、MCP；
三種跑法共用同一組工具、同一個 mutate 寫入路徑、同一個待審建議流程、同一份工作階段紀錄，AI 對內容的修改一律先存成「建議」，由人逐段接受或拒絕。**
API 跑法和 10/23 拿掉的不同：它**不能直接改內容**（只能提建議或留言）、沒有預設模型、沒有 API key 就不出現、每次執行都是有上限與紀錄的工作階段（第 7.1 節）。

## 1. 名詞

| 名詞 | 意思 | 在資料裡是什麼 |
| --- | --- | --- |
| **角色**（AI role） | 一個 AI 成員：名字、能進哪些空間（不在／可看／可編輯）、技能、審核規則、預設跑法、紀錄 | 既有的 `actors`（`type='agent'`）＋`agent_runners` 那一列（本提案把它改名為 `ai_roles` 並加欄位，§3.1） |
| **跑法**（runtime） | 角色「怎麼被執行」：`api`／`subscription`／`mcp`。角色建立時選預設，之後可換；單一動作可指定別的跑法 | `agent_sessions.runtime`；角色的 `default_runtime` |
| **建議**（suggestion） | AI 對一篇筆記提出、**尚未生效**的修改或留言。由人接受（才寫入）或拒絕 | 新表 `ai_suggestions`＋`ai_suggestion_items`（§3.2） |
| **工作階段**（session） | 一次 AI 執行：誰要求、哪個角色、哪個跑法、做了哪些步驟、花多少、產出哪些建議 | 既有 `agent_sessions`＋`agent_session_events`（§3.3） |
| **審核規則**（review rule） | 角色的修改要不要先經過人：`suggest`（預設；先存成建議）／`apply_then_review`（先套用、收件匣事後審；**API 跑法不允許**） | `ai_roles.review_rule` |
| **小動作**（small action） | 一次呼叫、不需要工具循環的 AI 動作：選一段文字改寫、縮短、翻譯 | `agent_sessions.kind='selection_action'` |

**角色 ≠ token ≠ 跑法。** 角色是「誰」（權限與歸屬的主體，事件裡的 `actor_id`）；跑法是「用什麼引擎」（只影響速度、費用、可觀察性）；
token 只是 MCP／訂閱跑法連進 Onden 的憑證。換跑法不改變角色能做什麼——這是本設計最重要的不變條件。

## 2. 現況（本提案接上的東西）

- **〔現況〕@ai 工作階段已實作。** `services/agentSessions.ts`（857 行）：`startSession`（冪等）、`claimSession`（pull）、`appendEvent`、`finish`（伺服器把回覆寫在提及下方）、
  `cancel`、`expireOverdue`、`revertSession`（整組復原）、`mentionablesFor`；表 `agent_runners`／`agent_sessions`／`agent_session_events`（migration 125）。
  runner 是 VPS 上用擁有者訂閱跑 `claude -p` 的容器（2026-10-23 決定在 VPS 登入訂閱）。
- **〔現況〕寫入走 mutate。** `spine/mutate.ts`：事件與寫入同一交易；session token 的寫入會在事件 payload 蓋 `agent_run_id`（`withAgentRun`，`mutate.ts:185`）。
  `services/history/agentRuns.ts` 用它把代理的寫入分組成「一次執行」，`agentRunUndo.ts` 整組復原。
- **〔現況〕MCP 工具**：`getNode`、`searchNodes`、`queryView`、`getAttachment`、`createNode`、`updateNode`、`applyTag`、`removeTag`、`proposeTagPack`
  （`services/agentTools/*.ts`）；`callTool` 負責工具許可、限速（`checkRateLimit`）、稽核事件（`AGENT_TOOL_CALLED`）。`updateNode` 要帶 `base_markdown` 走三方合併。
- **〔現況〕沒有「建議」或「留言」功能**：後端 `services/` 沒有 comment 模型；AI 的修改一律是「先套用、事後審核」（收件匣）。
- **〔現況〕沒有任何模型呼叫程式**：`test/harnessBoundary.test.ts` 規定後端不得 import `@anthropic-ai/sdk`；`app_settings` 表（API key、模型）已由 migration 126 刪除；
  `services/` 也沒有加密保存機密的工具（我 grep `createCipheriv` 沒有結果）。**API 跑法要新增這兩樣。**
- **〔現況〕前端「空間與成員」**：`settings/spacesAndMembers/`（`SpacesAndMembers.tsx`、`PersonRow.tsx`、`PermissionControl.tsx`、`HelperKeys.tsx`、`HelperMention.tsx`、`AddMemberForm.tsx`、`roster.ts`）。
  AI 助手是列（`RosterPerson.type === "agent"`），每個空間顯示 不在／可看／可編輯；金鑰（MCP token）在那一列。
  **〔待驗證〕** 你說前端正在 `fix/spaces-members-clearer` 分支改版（AI 角色卡、一步一步新增）；我這次 `git fetch` 在 origin 找不到這個分支
  （`couldn't find remote ref`），所以**沒讀到它的程式**。本文對前端只定「畫面需要從後端拿到什麼、每一步放什麼」，接合點見 §5.6。

## 3. 資料模型

### 3.1 角色與跑法

比較兩種放法：

| | 草圖 A：三種跑法各一套表與設定 | 草圖 B（採用）：一個角色、跑法是它的屬性 |
| --- | --- | --- |
| 呼叫者要知道的事 | 要分辨「這是 API 角色還是 MCP 角色」，權限、空間、紀錄各查一次 | 只看角色；跑法只在「啟動工作階段」與「顯示成本」時出現 |
| 換跑法 | 重建角色，歷史事件的 `actor_id` 斷掉 | 改一個欄位；歷史、權限、空間設定不變 |
| 權限判斷 | 三處各寫 | 一處（`spine/spaceAccess.ts`＋ token scope），跑法不參與 |

migration（起草時寫 142；實作時 main 已到 146，用下一個空號），**改名並擴充既有表，不新增平行的表**：

```sql
ALTER TABLE agent_runners RENAME TO ai_roles;           -- 「runner」現在只是三種跑法之一，名稱改成角色
ALTER TABLE ai_roles
  ADD COLUMN default_runtime  text NOT NULL DEFAULT 'subscription'
              CHECK (default_runtime IN ('api','subscription','mcp')),
  ADD COLUMN review_rule      text NOT NULL DEFAULT 'suggest'
              CHECK (review_rule IN ('suggest','apply_then_review')),
  ADD COLUMN api_credential_id uuid REFERENCES ai_credentials(id) ON DELETE SET NULL,
  ADD COLUMN api_model        text,                       -- 沒有預設值：api 跑法一定由使用者選
  ADD COLUMN api_small_actions_only boolean NOT NULL DEFAULT false,   -- 「只用在小動作」
  ADD COLUMN api_web_search   boolean NOT NULL DEFAULT false,
  ADD COLUMN monthly_cap_micro_usd bigint,                -- 角色每月 API 花費上限（NULL＝不設）
  ADD COLUMN runner_seen_at   timestamptz,                -- 訂閱執行程式最後一次輪詢（顯示在線／離線）
  ADD CONSTRAINT ai_roles_api_needs_model
    CHECK (default_runtime <> 'api' OR (api_credential_id IS NOT NULL AND api_model IS NOT NULL));

-- 使用者自己的 Anthropic API key。一個 workspace 可有多把；不回傳明文，只回後四碼。
CREATE TABLE ai_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  label text NOT NULL,
  secret_ciphertext bytea NOT NULL,            -- AES-256-GCM；金鑰來自部署環境變數 ONDEN_SECRET_KEY
  secret_last4 text NOT NULL,
  created_by uuid NOT NULL REFERENCES actors(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
```

- **「可用的跑法」是從事實算出來的，不另存旗標**：`api` 可用＝有未撤銷的 key 且選了模型且該角色的空間 `external_ai` 開；
  `subscription` 可用＝部署有 runner 且最近有輪詢（`runner_seen_at`）；`mcp` 可用＝角色有未撤銷的 token。
  `default_runtime` 指到不可用的跑法時，啟動工作階段回 409 `runtime_unavailable`（前端顯示白話原因與換法）。
- **沒有 `ONDEN_SECRET_KEY` 或沒有 key ⇒ API 跑法整個不出現**（`availableRuntimes()` 不回 `api`），不是灰掉。
- 模型只存字串 id；選項來自 `GET /v1/models`（用該 key 呼叫；回傳 `display_name`、`lifecycle`、`capabilities.server_tools.web_search`，
  官方文件 [List Models](https://platform.claude.com/docs/en/api/models-list)），所以 Onden 不維護模型清單、也不寫死預設。
  模型 `lifecycle` 變 `retired` ⇒ 角色顯示「模型已停用，請重選」，API 跑法不可用。
- 審核規則的不變條件：**`runtime = 'api'` 的工作階段一律當 `suggest`**，不看角色欄位（§4.3、§7.2）。

### 3.2 待審建議的存法

比較三種存法：

| | A：只存「提議後的全文」，讀取時比對 | B：存「逐處修改」＋ 接受時才套用（採用） | C：先套用、事後在收件匣撤銷（現況） |
| --- | --- | --- | --- |
| 接受一處 | 要從全文切出那一處，容易切錯 | 一列一處，接受＝套用那一處 | 不適用 |
| 使用者之後又改了筆記 | 全文已過時，只能整份作廢 | 每處帶原文，用三方合併套用在**目前**內容，只有真的重疊的那處失效 | 撤銷時遇到後續編輯回 `state_conflict` |
| 「寫入歸誰」 | — | 接受者寫入；建議帶提議者 | 代理寫入，人事後審 |
| 與「AI 不能直接改」相容 | 是 | 是 | **否** |

採 B。兩張表（實作為 migration 149，表名 `ai_edit_suggestions`／`ai_edit_suggestion_items`——`ai_suggestions` 已被一張無人使用的舊表占用；以下 SQL 保留起草時的名稱）：

```sql
CREATE TABLE ai_suggestions (               -- 一次工作階段對一篇筆記的一組建議
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  space_id        uuid NOT NULL,            -- 提議時筆記所在空間
  node_id         uuid NOT NULL REFERENCES content_nodes(id),
  agent_actor_id  uuid NOT NULL REFERENCES actors(id),     -- 提議的角色
  session_id      uuid NOT NULL REFERENCES agent_sessions(id),
  base_markdown   text NOT NULL,            -- 提議時 AI 讀到的內文（三方合併的基準）
  base_title      text NOT NULL,
  superseded_by   uuid REFERENCES ai_suggestions(id),      -- 「重試」產生新的一組時指向它
  created_event_id bigint NOT NULL,         -- AI_SUGGESTION_CREATED
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_suggestion_items (          -- 一處修改或一則留言
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id   uuid NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  seq             int  NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('replace','insert','delete','title','comment')),
  base_text       text NOT NULL,            -- 修改前的那段（段落為單位，用 @onden/markdown 切段）；insert 為前一段
  base_occurrence int  NOT NULL DEFAULT 0,  -- 同一段文字在 base_markdown 出現的第幾次（定位用，不用字元位置）
  new_text        text,                     -- 修改後；comment 為留言內文；delete 為 NULL
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','stale','void','replaced')),
  decided_by      uuid REFERENCES actors(id),
  decided_at      timestamptz,
  decided_event_id bigint,                  -- AI_SUGGESTION_ACCEPTED／REJECTED
  UNIQUE (suggestion_id, seq)
);
CREATE INDEX ai_suggestion_items_pending_idx ON ai_suggestion_items (suggestion_id) WHERE status = 'pending';
CREATE INDEX ai_suggestions_node_idx ON ai_suggestions (node_id, created_at DESC);
```

- **留言是沒有替換文字的建議**（`kind='comment'`，「接受」＝標為已讀／解決），不另建留言系統；`new_text` 是留言內容。這樣事件、權限、紀錄、UI 清單全部共用。
- **段落為單位，不用字元位置**：位置會隨編輯漂移；`base_text`＋`base_occurrence` 在 `base_markdown` 內找得到，在目前內容也用同法找（找不到＝原處已改，§3.2.2）。
  不在本文裡寫 `^id`（避免為了建議而改使用者的筆記）。
- **狀態**：`pending` 待審；`accepted`／`rejected` 人決定；`stale` 想接受但原處已被改而無法安全套用（保留現況、回明確拒絕，不假成功）；
  `void` 筆記被刪、被移出角色可及的空間；`replaced` 被「重試」產生的新一組取代。轉移只由一個守衛 `UPDATE … WHERE status = 'pending'` 決定（競態由資料庫裁決）。
  終態不變。

**操作（領域層，`services/aiSuggestions.ts`，路由與 agent 工具都只呼叫這些）：**

```ts
createSuggestions(ws, { actor /* 提議的角色，session 身分 */, sessionId, nodeId, proposedMarkdown?, proposedTitle?, comments? })
  → { suggestionId, itemCount }          // 內部：以 base 與提議全文做段落 diff 產生 items；同一交易寫 AI_SUGGESTION_CREATED
acceptSuggestionItems(ws, { actor /* 人 */, suggestionId, itemIds | "all" })
  → { accepted: ItemId[], stale: ItemId[] }   // 用「接受者目前的權限」走 updateNode；一次交易
rejectSuggestionItems(ws, { actor, suggestionId, itemIds | "all" })
retrySuggestion(ws, { actor, suggestionId })  → 新 sessionId   // 以相同請求再跑一次；舊的 pending 在新一組產生時標 replaced
```

呼叫範例（接受「全部」）：

```ts
const r = await acceptSuggestionItems(ws, { actor, suggestionId, itemIds: "all" });
// r.stale 不為空：這些處原文已被改過，沒有寫入，UI 顯示「X 處原文已變，請重試」
```

#### 3.2.1 接受＝一次被約束的 `updateNode`

1. 先取工作區事件鎖（沿用 `updateNode` 的規則：先鎖、再讀狀態、查政策、保存）。
2. 以**接受者目前的 actor**（人）呼叫 `updateNode`：`markdown` ＝ 把要接受的 items 套在 `base_markdown` 上得到的全文，`baseMarkdown` ＝ `base_markdown`。
   既有的三方合併會把使用者之後的編輯保留下來。
3. **需要 `nodeUpdate` 新增一個選項 `onConflict: "refuse"`**（〔建議〕批 1 的唯一核心改動）：現在遇到「雙方改了同一行」是用寫入者的文字、並把對方文字送進收件匣
   （`BODY_CONFLICT`，`nodeUpdate.ts` 說明）；接受建議時不能這樣做（會覆蓋使用者剛寫的字）。`refuse` ＝ 整次不寫、回衝突清單。
4. `all`：先整組一次合併；被拒絕就退回逐項（每項 `withSavepoint`），無法套用的項目標 `stale`，其餘照寫。成功者在同一交易標 `accepted`＋寫 `AI_SUGGESTION_ACCEPTED`。
5. 寫入事件的 payload 帶 `suggested_by: { actor_id, session_id }`（§3.4），所以**事件操作者是接受的人，並連回提議的角色**。

#### 3.2.2 衝突與例外（逐一）

| 情況 | 結果 |
| --- | --- |
| AI 工作期間，使用者改了**別段** | 無事：items 帶原文，接受時三方合併 |
| 使用者改了**同一段** | 該 item 接受時衝突 → `stale`，不寫；UI「這段你已經改過了」＋〔讓 AI 依目前內容重試〕 |
| 兩個建議（同或不同角色）改同一段 | 都保持 `pending`；接受第一個後，第二個重疊的處在接受時變 `stale`（不事先猜） |
| 筆記刪除／移到角色看不到的空間 | 相關 items → `void`；懸空的不顯示在編輯器，仍在「AI 活動」可查 |
| 提議後角色被撤銷或降權 | 已存在的建議**照樣可由人接受**（接受用接受者的權限，不看提議者現在的權限）；但在介面標「提議者已停用」 |
| 接受者沒有該筆記的寫入權 | 回授權失敗，不改任何 item 狀態 |
| 重複點擊／兩個裝置同時接受 | 守衛 UPDATE：只有一個成功，另一個得到 `already_decided`（冪等鍵沿用 `spine/idempotency.ts`） |
| 重試 | 新 session（`parent_session_id` ＝ 原 session）、新一組；舊組 `pending` 項在**新一組建立成功的同一交易**標 `replaced`；新的失敗則舊的保留 |
| 離線 | 接受／拒絕需要連線，不進離線佇列、不顯示「已接受」（AGENTS：保存確認必須是伺服器接受）；建議本身不進離線同步 |

### 3.3 工作階段擴充

migration（下一個空號），在既有 `agent_sessions`／`agent_session_events` 上加欄位（**不新增第二種 session**）：

```sql
ALTER TABLE agent_sessions
  ADD COLUMN runtime  text NOT NULL DEFAULT 'subscription' CHECK (runtime IN ('api','subscription','mcp')),
  ADD COLUMN kind     text NOT NULL DEFAULT 'mention'
              CHECK (kind IN ('mention','selection_action','panel_chat')),
  ADD COLUMN model    text,                          -- 啟動當下解析出的模型（api）；快照，之後換模型不影響
  ADD COLUMN write_mode text NOT NULL DEFAULT 'suggest' CHECK (write_mode IN ('suggest','apply')),
  ADD COLUMN plan     jsonb,                         -- 計畫（§4.5）：{ summary, notes: [{node_id, intent}] }
  ADD COLUMN plan_decided_at timestamptz,
  ADD COLUMN input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN output_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN cost_estimate_micro_usd bigint,         -- 估計；模型單價未知則 NULL
  ALTER COLUMN anchor_block_id DROP NOT NULL;        -- 側欄對話、選取動作沒有提及錨點
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_status_check,
  ADD CONSTRAINT agent_sessions_status_check CHECK (status IN
    ('queued','delivered','running','awaiting_plan','completed','failed','cancelled'));
-- 沒有錨點的 session 用 client 產生的 request_id 做語意層冪等（取代 UNIQUE(workspace,node,anchor,revision)）
ALTER TABLE agent_sessions ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX agent_sessions_request_uidx ON agent_sessions (workspace_id, initiator_id, request_id) WHERE request_id IS NOT NULL;
ALTER TABLE agent_session_events DROP CONSTRAINT agent_session_events_kind_check,
  ADD CONSTRAINT agent_session_events_kind_check CHECK (kind IN
    ('ack','thought','action','message','error','result','read','search','thinking_summary','usage','plan'));
```

- `awaiting_plan`：AI 提出多篇修改的計畫、等人批准（§4.5）。它是開放狀態（逾時照 `deadline_at` 失敗）。
- `read`（讀了哪篇：`{node_id}`）、`search`（`{query_length}`、網頁搜尋）、`thinking_summary`（模型的思考摘要，只有 API 跑法拿得到；訂閱只有粗略 `thought`）、
  `usage`（每回合 token）——都是**診斷日誌**（沿用 agent-mentions §2.1：不是領域事件、不同步、不復原、有保留期限）。
- **每步可記是 API 的優點，其他跑法照既有協定盡力記**：同一張日誌表、同一組 `kind`，沒有的就沒有（MCP 跑法只有每次工具呼叫的 `action`／`read`）。
- **MCP 跑法也要有 session**：使用者自己的 Claude 用角色 token 連進來時沒有人按「送出」。做法〔建議〕：**不新增 kind**。token 沒帶 session 時，伺服器依 `(token, 30 分鐘閒置)` 隱含開一個
  `runtime='mcp'`、`kind='panel_chat'`（它是開放式對話）的 session（`initiator` ＝ 發 token 的人），閒置超過就結束；
  它的建議、讀取、用量都掛在這個 session 上。

### 3.4 事件類型

沿用既有：`AGENT_SESSION_STARTED`／`AGENT_SESSION_ENDED`、`AGENT_TOOL_CALLED`／`AGENT_TOOL_FAILED`（`tx_meta` 已帶 `session_id`）。新增四種（目標都是**筆記**，所以可見性＝能讀該筆記的人，沿用 `services/eventVisibility.ts`）：

| 事件 | 操作者 | 時機 | payload（不含全文，只含用途所需） |
| --- | --- | --- | --- |
| `AI_SUGGESTION_CREATED` | 角色（`ai_agent`） | `createSuggestions` 同一交易 | `suggestion_id`、`session_id`、`agent_run_id`、項目數、各 kind 數量 |
| `AI_SUGGESTION_ACCEPTED` | **接受的人** | `acceptSuggestionItems` 同一交易，且是同一次 `NODE_UPDATED` 的因果根 | `suggestion_id`、`item_ids`、`proposed_by_actor_id`、`proposed_by_session_id` |
| `AI_SUGGESTION_REJECTED` | 人 | `rejectSuggestionItems` | 同上（無寫入） |
| `AI_PLAN_DECIDED` | 人 | 計畫批准／拒絕（§4.5） | `session_id`、`approved_node_ids` |

- 接受時的 `NODE_UPDATED` payload 另帶 `suggested_by: { actor_id, session_id }`。**〔建議〕`services/history/agentRuns.ts` 的 `runEvents`**
  現在只收 `actor_type='ai_agent'` 的事件；改為也收「`suggested_by.session_id` 有值」的事件並以它當 `run_id`，
  這樣「整組復原這次 AI 執行」會包含已被接受的修改（它們由人寫入，但屬於這次 AI 執行）。復原仍走 `restoreEvent`、依目前權限、不覆蓋後續編輯。
- **被拒絕的是事實也是事件**：`AI_SUGGESTION_REJECTED` 是已提交的事實（誰在何時拒絕），不是診斷日誌；它不改任何筆記，所以同步與復原都忽略它。
- 事件格式新增，要檢查歷史列表（`eventKinds.ts` 的 `eventTypeLabel`／`eventVerb`）、收件匣、同步消費者；不認得的新事件要有白話預設（AGENTS「UI 不顯示事件常數」）。
- 「被拒絕的嘗試」（例如 API 工作階段想直接寫入被擋）→ `AGENT_TOOL_FAILED` 診斷事件，不是 `AI_SUGGESTION_*`。

## 4. 三種跑法：共用層與差異

```
                       ┌────────────── 共用層（跑法無關）──────────────┐
 使用者動作 ──►        │ startSession  ─ 權限／external_ai／冪等／限速  │
 (@ai／交給 AI／       │ 工具：agentTools registry（同一組實作）        │
  側欄對話)            │ 寫入：suggestEdit／comment → mutate            │
                       │ 紀錄：agent_session_events、用量               │
                       │ 建議：ai_suggestions → 人接受 → updateNode     │
                       └───────┬─────────────┬─────────────┬────────────┘
                          dispatch()     (runner 輪詢)   (客戶端自己來)
                       ┌──────▼──────┐ ┌────▼─────────┐ ┌──▼─────────────┐
                       │ api         │ │ subscription │ │ mcp            │
                       │ 伺服器內    │ │ VPS 容器     │ │ 使用者的 Claude│
                       │ Tool Runner │ │ claude -p /  │ │ (Code／桌面)   │
                       │             │ │ Agent SDK    │ │ + 角色 token   │
                       └─────────────┘ └──────────────┘ └────────────────┘
```

### 4.1 共用層（一個介面，三個實作）

比較兩種切法：

| | A：三條各自的流程 | B（採用）：一個 `AgentRuntime`，工具與寫入共用 |
| --- | --- | --- |
| 新增一個動作（例如「縮短」） | 三處各接 | 只在共用層定義；跑法只決定誰執行 |
| 權限／審核規則 | 三處各寫 | 只在工具與 `spine` |
| 紀錄 | 三種格式 | 一張日誌表 |

```ts
// services/agentRuntime/types.ts  〔建議〕
export type RuntimeKind = "api" | "subscription" | "mcp";
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  /** 現在能不能用；不能時給白話可對應的原因碼（前端轉成一句話，不顯示碼）。 */
  availability(role: AiRole): Promise<{ ok: true } | { ok: false; reason: "no_key" | "no_model" | "model_retired" | "runner_offline" | "no_token" | "external_ai_off" }>;
  /** 把已持久化（queued）的 session 交出去。回傳＝已交出，不是已完成。 */
  dispatch(session: AgentSession): Promise<void>;
}
```

| | `dispatch` 做什麼 | 誰呼叫工具 | 完成怎麼回報 |
| --- | --- | --- | --- |
| `api` | 入列 outbox 效果 `agent_session_run`（外部副作用走既有 outbox；`services/outbox.ts`），執行時在伺服器內跑 Tool Runner | 伺服器內以角色身分呼叫 `callTool`（同一個 registry，不經 HTTP） | 伺服器自己 `finish` |
| `subscription` | 什麼都不做；runner 長輪詢 `/api/mcp/sessions/pending` → `claim`（**〔現況〕已實作**） | runner 內的 `claude -p` 經 MCP 呼叫 | runner 呼叫 `/finish`（**〔現況〕**） |
| `mcp` | 什麼都不做；沒有 queued 階段，session 由第一次工具呼叫隱含建立（§3.3） | 使用者的 Claude 經 MCP | 閒置逾時結束 |

- **工具是同一份**：`api` 跑法把 `listTools()` 的每個工具轉成 Tool Runner 的工具（官方 TypeScript SDK 的 `betaZodTool`＋`client.beta.messages.toolRunner`，
  [Tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)，目前為 beta；本專案工具已用 zod 定義，`inputSchema` 直接可用），
  `run` 內呼叫同一個 `callTool`。**不另寫第二份工具實作。** `max_iterations` 用來限制回合數。
- **角色身分如何在伺服器內成立**：`api` 跑法在程序內不經 bearer token，需要一個 `ActorCtx`。比照 `spine/systemJobs.ts` 的做法：
  `actorForRuntimeSession(session)` 是**唯一**能做出這種 ActorCtx 的函式（以私有登記表認身分，不是形狀），呼叫者由 `test/guards/*.guard.test.ts` 鎖定為 `apiRuntime`；
  它帶的 `tokenScope` 和 session token 同形（`sessionId`、單一空間、`writeMode`），所以 `mutate` 與 `readPolicy` 不需要知道它是哪種跑法。
- **可見性與外部 AI 開關**：任何跑法送給模型的內容都先過讀取政策 ∩ 空間 `external_ai`（`harness.prompt()` 已做；API 跑法同樣用它組 prompt，**這是模型能看到什麼的唯一入口**）。

### 4.2 API 跑法（`api`）

- 在伺服器內用使用者的 key、使用者選的模型，跑工具循環（Tool Runner）。**每步都能記**：每個 tool_use 記 `action`／`read`，每回合 `usage`，
  思考摘要記 `thinking_summary`（API 回傳的 thinking 區塊；是否可得依模型，〔待驗證〕）。
- **小動作用單次串流呼叫**：「選一段改寫」不需要工具與循環。`kind='selection_action'` 的 session：伺服器組 prompt（選取文字＋前後各一段脈絡＋動作技能），
  一次串流呼叫，串流文字以 SSE 推到前端預覽卡；**結束時才建立建議**（`createSuggestions`），串流中途斷線不留半截建議。仍然有 session（費用、紀錄一致）。
- **網頁搜尋**：官方伺服器端工具，由角色欄位 `api_web_search` 開關（預設關）。模型是否支援看 `capabilities.server_tools.web_search`。
  風險：查詢字詞會帶出筆記內容（外送通道，§7.3）；開啟時設定畫面白話說明「會把查詢字詞送到網路」。
- **「只用在小動作」**（`api_small_actions_only`）：開啟時，這個角色的 API 跑法只接受 `kind='selection_action'`；`@ai` 提及與側欄對話選到 API 時回 `runtime_not_allowed`，
  前端改提示換別的跑法。這是**政策欄位，不是 UI 隱藏**：檢查在 `startSession`。
- 執行失敗語意：outbox 重試會**重複花錢**，所以 `agent_session_run` 的 `perform` 不是「冪等重跑」而是「一次性領取」：
  `UPDATE agent_sessions SET status='running', attempt=attempt+1 WHERE id=$1 AND status='queued'`；領到才跑；
  程序在跑到一半崩潰、重啟後看到 `running` 且無人在跑 → 標 `failed(interrupted)`，**不自動重跑**（使用者看到「中斷了，要重試嗎」）。
  這是 agent-mentions §4.3「額度耗盡不自動重試」同一原則。

### 4.3 訂閱執行程式（`subscription`）

- 就是 **〔現況〕** 的 VPS runner（`agent-runner` 容器，`claude -p`，用擁有者訂閱的一年期 OAuth token，2026-10-23 決定；
  不得放 `ANTHROPIC_API_KEY`，否則會蓋過訂閱改走計費，agent-mentions §4.3）。本提案**不改它的協定**，只做：
  (1) session 帶 `runtime='subscription'`；(2) runner 輪詢時更新 `ai_roles.runner_seen_at`（健康顯示）；(3) 它的工具寫入也走 `suggest`（§4.3.1）；
  (4) 讓同一個 runner 容器也能用 API key 跑（環境變數換成 `ANTHROPIC_API_KEY`，計費走 API／Console 額度，見 §8）——**可選**，列批 3 尾端。
- **Agent SDK 與 `claude -p`**：兩者同屬 Claude Code 的程式化介面。本提案的 runner 維持 `claude -p`（未修改的官方執行檔＋使用者自己的訂閱＝條款最貼近
  「終端使用者以自己的訂閱登入未修改的 Claude Code」，[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)）。
  「在伺服器用 **Agent SDK 函式庫**搭訂閱憑證」該文件**沒有明說**允許，且說「開發者（含用 Agent SDK 者）應使用 API key」→ **〔未確認〕**，本提案不採用，只在用 API key 時才用 Agent SDK。
- 優點：不另付費（花訂閱額度）、完整 Claude Code 能力、離開電腦也運作。缺點：啟動較慢、步驟紀錄較粗（只有 `claude -p --output-format stream-json` 給的）、無思考摘要保證。

#### 4.3.1 審核規則在 MCP／訂閱怎麼落實

工具層一個判斷，三種跑法一致：`updateNode`／`createNode`／`applyTag`／`removeTag` 在 `writeMode='suggest'` 的 token／身分下，**不寫入，改呼叫 `createSuggestions`**
並回傳「已存成建議（待使用者審核）」給模型（模型看得到，不會以為已改好）。`writeMode` 來源：session 的 `write_mode`；
`write_mode = (runtime === 'api') ? 'suggest' : role.review_rule 對應值`。
**〔v1 範圍〕** 建議只涵蓋內文與標題修改、留言；`createNode`／標籤變更在 `suggest` 下回 `suggestion_not_supported`，讓模型改用留言說明
（避免一次做完整套；批 9 再補「新增筆記」建議）。這點在第 9 節第 3 題請你確認。

### 4.4 MCP（`mcp`）

- 使用者自己的 Claude（Code／桌面）用**這個角色的 token** 連 Onden MCP（`routes/mcpProtocol.ts`，**〔現況〕**）。Onden 在 Tailscale 內網、不開 Funnel，
  所以**不用** Anthropic API 的遠端 MCP connector（它要從 Anthropic 端連進來）；連線永遠由使用者端往內。
- token 仍是「唯讀／可寫」二選一（agent-delegation 2026-10-23）；新增的只有：token 解析出的 ActorCtx 帶角色的 `writeMode`，並隱含 session（§3.3）。
- 優點：不另付費、使用者自己的連接器與完整能力、技能 prompts 直接可用。缺點：要使用者自己開著 Claude 才會動；Onden 看不到模型每步想什麼（只看到工具呼叫）。
- **不能被 Onden 觸發**：MCP 是被動的。「交給 AI」選到只有 MCP 跑法的角色時，建立的是 `queued` 的**待領取請求**，
  由使用者的 Claude 透過一個 MCP 工具 `listPendingRequests`／技能 prompt 拿（見批 3），不是 Onden 呼叫它。UI 誠實顯示「等你的 Claude 來領取」。

### 4.5 計畫（多篇修改先給計畫）

- 規則：session 的**第一篇筆記**（提及所在、或選取所在）可直接提建議；**要對第二篇以上的筆記提建議，必須先有已批准的計畫**。
- 流程：模型呼叫新工具 `proposePlan({ summary, notes:[{node_id, intent}] })` → session 轉 `awaiting_plan`、`plan` 存入 → UI 顯示計畫卡
  （「AI 想修改這 3 篇：…」，可取消勾選某篇）→ 人批准寫 `AI_PLAN_DECIDED`（`approved_node_ids`）→ session 回 `running`。
- **強制點在 `createSuggestions`**（伺服器），不靠模型自律：對不在「錨點筆記＋已批准清單」內的筆記提建議 → `plan_required`（工具結果會告訴模型先呼叫 `proposePlan`）。
  三種跑法都適用（MCP 的使用者 Claude 也會收到同一個工具錯誤）。
- 這是軟範圍（按筆記），不是新權限；真正的權限邊界仍是 session token／角色的空間（§7）。

## 5. 前端入口與畫面（文字描述）

總原則：手機、桌面、不同檢視共用保存與錯誤契約，只有布局不同（AGENTS）；UI 不出現 JSON／id／錯誤碼／毫秒／堆疊（業主 2026-10-23 規則），
錯誤文字只走 `lib/serverErrors.ts`、`writeErrors`。參考的產品做法：Google 文件的 Refine／建議、Word Copilot 的追蹤修訂、Notion 的變更標示與計畫模式、
Cursor 的逐處接受、Obsidian Copilot 的引用出處、Linear 的工作階段狀態——**只借概念，細節以 Onden 的契約為準；我沒有重新查閱它們的原文**。

### 5.1 選取／段落「交給 AI」

- **選取文字**時浮出工具列多一顆「AI」：點開是預設動作（改寫、縮短、展開、修文法、翻譯、解釋）＋「自訂…」。
  預設動作就是內建技能（`harness/builtinSkills.ts`：現有 `ask/outline/expand/summarize/fix`，新增 `rewrite/shorten/translate`）；
  「自訂」＝挑一篇自己的 `#技能` 筆記，或輸入一句話（單次，不存）。**不新增「預設 prompt」資料**（agent-mentions §1.2 的決定：技能就是預設 prompt）。
- **段落**：滑鼠移到段落左側邊欄出現「AI」圖示（手機：長按段落的選單裡一項），同一份動作清單，對象是整段。
- 動作右邊小字顯示用哪個角色與跑法（例如「小助手 · API」）；「⋯」可改選角色與**這一次**用哪個跑法（只列該角色目前可用的）。
  預設＝角色的 `default_runtime`；動作是 `api_small_actions_only` 的角色時，小動作優先選 API。
- 結果：API 小動作串流到浮動預覽卡，結束時變成**一則建議**（原位 diff＋接受／拒絕／重試）。訂閱／MCP 沒有串流，顯示「AI 處理中」狀態列（§5.5）。

### 5.2 待審建議：筆記裡怎麼看（Notion／Word 追蹤修訂／Cursor 的綜合）

- 編輯器用 CodeMirror 裝飾（不改本文）：刪除的文字劃線淡紅底、新增文字淡綠底，**不只靠顏色**（刪除線／底線＋圖示）。
- 每處右側（手機：下方一列）：**接受**／**拒絕**；頂部固定列「這篇有 N 處 AI 建議 · 全部接受 · 全部拒絕 · 逐處檢視（上一處／下一處）」。
- 不同角色的建議各自標示角色名；`stale` 的處顯示「這段你已經改過了」＋「讓 AI 重試」；`void` 不顯示。
- 接受、拒絕都要連線；按下到伺服器回覆前按鈕顯示處理中且不可重按；失敗保留建議不動並說原因（走 `writeErrors`）。
- 建議存在時，使用者仍可正常編輯；改到被建議的那段時該處立刻顯示「原文已變」（前端用 `base_text` 與目前內容比對，伺服器接受時仍會再核對）。
- **Obsidian Copilot 式出處**用於對話回答（§5.3），不用於建議。

### 5.3 資訊欄「AI」分頁（每篇一條對話）

- 沿用 agent-mentions §1.4 規劃的「AI 對話」容器（與資訊欄的歷史分頁同一個容器）。**每篇筆記一條對話**：
  對話＝這篇筆記上 `kind='panel_chat'` 的 sessions 依 `parent_session_id` 串成的序列（不另建 conversation 表；歷史＝session 的 prompt＋結果）。
- 輸入框打 `[[` 可指定參考筆記（沿用 `[[` 完成選單）；以 chip 顯示。**v1 只能挑同空間的筆記**（session token 限單一空間，agent-mentions D3；第 9 節第 11 題）。
  參考筆記讀取一律過「你的讀取權限 ∩ 角色權限 ∩ external_ai」。
- **回答附出處**：回答中的出處用既有 wikilink／區塊連結 `[[標題#^id]]` 寫成，顯示為可點的小標籤。**伺服器驗證**：出處的筆記必須在這個 session 的 `read` 紀錄裡
  （AI 真的讀過）；沒讀過的出處標成「未驗證」或移除，不假裝有依據。
- 回答下方：「讀了 4 篇」可展開（列標題）、「建議 2 處」可跳到編輯器、用量一行小字（「約 3.2 千字元輸出」之類白話；**不顯示耗時／毫秒**）。
- **多篇修改先給計畫**（§4.5）：計畫卡直接在對話裡，批准／調整／拒絕。
- 跑法選擇器在輸入框旁（預設角色的預設跑法）；只有角色目前可用的跑法才列。

### 5.4 AI 留言

- AI 想指出問題但不改字：以 `kind='comment'` 的建議存在段落旁（邊欄小泡泡，手機為段落尾的小圖示）；點開看內容、可「已讀」或「請 AI 改」（＝以這則留言為上下文開一個小動作）。
- 與人類留言**不同系統**（Onden 目前沒有人類留言，本提案不新增通用留言功能）；v1 只有 AI 能產生，所以版面上叫「AI 留言」。

### 5.5 看得到它的狀態與步驟

- 沿用 agent-mentions §1.4 的狀態列（⏳已排入／●執行中／⚠尚未回應／✓完成／✕失敗／⏹已取消），新增兩個：「等你批准計畫」與（MCP）「等你的 Claude 來領取」。
- 展開＝步驟日誌：「讀了〈某筆記〉」「搜尋了網頁」「想了一下：（思考摘要）」「提出 3 處修改建議」。**不顯示 id、JSON、毫秒**；
  找不到名稱時顯示「未命名」。API 跑法步驟最細；MCP 只有讀與提建議。
- 失敗原因白話：額度用完、金鑰失效、模型已停用、連不到執行程式、中斷了（可重試）、超過回合上限。

### 5.6 設定›空間與成員：AI 角色與新增流程

**列表（接上分支的「AI 角色卡」）。** 每個 AI 角色一張卡，需要的資料（後端 `GET /api/ai-roles`，**契約，不是畫面規格**）：

```
{ actor_id, name, handle, enabled, default_runtime,
  runtimes: [{ kind, available, unavailable_reason? }],     // 從事實算出，不是存的旗標
  review_rule, api: { model_name?, small_actions_only, web_search, key_label? },
  spaces: { <space_id>: "none" | "view" | "edit" },          // 既有 permissions
  usage_this_month: { input_tokens, output_tokens, cost_estimate_micro_usd? },
  runner_seen_at? }
```

卡上顯示：名字、跑法標籤（「API · 模型名」「訂閱」「MCP」）、可用狀態（在線／離線／缺金鑰）、各空間 不在／可看／可編輯（沿用 `PermissionControl`）、本月用量、停用開關（既有 kill switch）。
既有 `HelperKeys`（MCP token）只在角色有 MCP 跑法時顯示。**接合點：** `roster.ts` 的 `RosterPerson` 加 `runtimes`／`defaultRuntime`／`reviewRule`；
`PersonRow`／新的角色卡顯示標籤；`AddMemberForm` 的 agent 分支換成下面的流程。**〔待驗證〕** 分支上這些檔案可能已改動，批 5 開頭先 rebase 並對照。

**新增 AI 角色流程（一步一步，每步可回上一步，離開不留半成品）：**

| 步驟 | 畫面 | 做什麼 |
| --- | --- | --- |
| 1 名字 | 一個輸入框＋可選的 `@` 名稱（預設由名字產生，檢查空間內唯一） | 只在最後一步才建立角色（失敗不留半個角色） |
| 2 選跑法 | 三張卡，每張一句白話優缺點（見下）；只有「目前能用的」才列；**API 卡在沒設金鑰時不出現**，卡片下方只有一行小字連結「要用 API？先加入金鑰」 | 選一個當預設；之後可在卡上換 |
| 3 對應設定 | **API**：貼 API key（只顯示一次、之後只剩後四碼）→ 系統用該 key 查可用模型 → 必選一個模型（沒有預設）→ 兩個開關（只用在小動作／網頁搜尋，預設關）→ 可選每月上限。**訂閱**：顯示「執行程式在線／離線」；離線時給登入步驟（在伺服器上執行官方登入指令、把一年期憑證放進執行程式容器——**Onden 不經手憑證**，agent-mentions §4.4）。**MCP**：產生這個角色的金鑰（只顯示一次）＋「在你的 Claude 裡這樣連」的連線資訊（網址、金鑰；說明在 Tailscale 內才連得到） | 每種都有「測試」按鈕（API：用 key 列模型；訂閱：看輪詢；MCP：看是否收到過呼叫） |
| 4 能進哪些空間 | 每個共用空間一列：不在／可看／可編輯；旁邊一句「可編輯＝可以提出修改建議，要你接受才生效」 | 沿用既有空間成員寫入 |
| 5 完成 | 摘要（名字、跑法、模型、空間）；MCP 再次提示金鑰已顯示過 | 角色此時才建立；有一個「試一下」連結到某篇筆記 |

三張跑法卡的白話（草稿，文字實作時再潤）：

- **API**：回應最快、每一步都看得到、可以上網搜尋。要用你自己的 API 金鑰，按用量計費（Max／Team 方案另附每月 API 額度可抵，見 §8）。**AI 不能直接改你的筆記，只能提建議。**
- **訂閱執行程式**：不另外付費（用你的 Claude 訂閱額度），能力完整，你不在電腦前也會跑。啟動稍慢、步驟紀錄較粗。
- **MCP**：用你自己的 Claude（Code 或桌面版）連進來，不另外付費，能用你自己的連接器。要你的 Claude 開著才會動，Onden 看不到它每一步想什麼。

### 5.7 「待審建議」總覽〔建議〕

收件匣新增「AI 建議」一區（依筆記分組、可批次全部接受／拒絕、可只看某角色）。這是看全局的地方；逐處決定仍在筆記裡。放批 8（第 9 節第 10 題）。

### 5.8 現有 @ai 改走待審建議

- 提及的**回覆**（今天 `finish` 由伺服器把 `> **名字**` 區塊寫在提及下方並直接 `completed`，`agentSessions.ts:545-610`）改為：
  `finish` 把回覆存成一則 `insert` 建議（錨點＝提及所在段落）；session 在**建議建立成功**時 `completed`（不再等於「回覆已在筆記裡」，
  所以 status 契約要改寫：`completed` ＝ AI 的產出已全部交出——寫入或存成建議）。使用者接受後才出現在本文。
- 提及 chip 在完成後顯示「AI 回覆待你接受」（有 pending 項時）。`revertSession`（整組復原）改為：pending 的建議全部 `rejected`＋已接受的寫入逆向（走 `restoreEvent`）。
- agent-mentions §8 第 4 題「只有回覆的 session 自動標為已審核」不再需要（回覆本身就是建議）；**〔待你決定〕Q&A 型回覆每次都要按接受是否太煩**（第 9 節第 4 題，我的建議是：回覆在側欄對話顯示、不進本文，要寫進筆記時按「插入筆記」＝一則建議）。

## 6. 三種跑法差異一覽

| | API | 訂閱執行程式 | MCP |
| --- | --- | --- | --- |
| 誰出錢 | 你的 API 金鑰（Max／Team 有每月額度可抵，§8） | 你的 Claude 訂閱額度 | 你的 Claude 訂閱額度（互動使用） |
| 啟動 | Onden 伺服器直接跑，數秒內開始 | runner 輪詢領取，秒級＋啟動 | 要你的 Claude 自己來 |
| 每步紀錄 | 完整（讀了什麼、思考摘要、token、費用） | 粗（工具呼叫、文字段落；token 只有結果事件） | 只有工具呼叫 |
| 網頁搜尋 | 可開（官方伺服器端工具） | 不開（allowlist 只含 Onden 工具） | 看使用者自己的 Claude 設定 |
| 使用者自己的連接器 | 沒有 | 沒有（乾淨設定） | 有 |
| 能不能直接寫入 | **不能**（只提建議／留言） | 依審核規則（預設建議） | 依審核規則（預設建議） |
| 離開電腦 | 可 | 可 | 不可 |
| 啟動來源 | Onden | Onden（等 runner 領） | 使用者 |
| 可用條件 | 有金鑰＋選了模型＋`ONDEN_SECRET_KEY` | 部署了 runner 且在線 | 角色有未撤銷 token |

## 7. 安全與權限

### 7.1 為什麼這次和 2026-10-23 拿掉的不同（要誠實寫）

10/23 的理由是「開放式、不可預測」（harness.md 第 4 行）。移除的是：伺服器拿全域 API key 呼叫模型、有預設模型、有直接寫入的工具迴圈、獨立的「問你的筆記」入口、`app_settings` 裡的全域設定。
本提案**重新引入的**是「伺服器呼叫模型」這件事本身，所以不能說兩者無關。差別，以及仍然存在的風險：

| 10/23 之前 | 本提案 | 風險是否消除 |
| --- | --- | --- |
| API AI 可直接寫入、先套用 | **API 不能直接改內容，只能提建議或留言**；強制點在 spine（§7.2），不是 UI | 內容被錯誤改寫：消除（人接受才生效） |
| 全域 key、全域預設模型 | key 與模型綁在角色；**沒有預設模型**；沒有 key 這個跑法不出現 | 「悄悄花錢／悄悄換模型」：消除 |
| 一個全域聊天入口 | 動作綁在筆記與段落（選取、段落、側欄每篇一條） | 部分：側欄對話仍是開放式提問 |
| 沒有上限與紀錄 | 每次都是 session：回合數、token、月上限、每步紀錄、整組復原 | 花費失控：降低（有硬上限） |
| 回答無依據 | 出處由伺服器驗證是否真的讀過 | 幻覺：降低，不是消除 |
| 另一套工具 | 與 MCP 同一組工具與權限 | 「第二套權限」：消除 |

**沒有消除的**：側欄對話仍可能給出錯的回答（只是它不能改你的內容）；金鑰存在伺服器（外洩面變大，§7.3）；開了網頁搜尋就有外送通道。
這些在第 9 節第 1 題請你明確接受；若不接受，仍可只做建議流程（批 1、2）＋訂閱／MCP 跑法，API 跑法（批 4）整批不做，其餘不受影響。

### 7.2 「API 不能直接寫」怎麼保證

比較兩種強制點：

| | A：UI／工具清單隱藏寫入工具 | B（採用）：spine 的宣告式許可 |
| --- | --- | --- |
| 被繞過的情況 | 新增一個工具忘了排除、或注入讓模型呼叫別的入口 | 不論哪個入口，只要走 `mutate` 就被檢查 |
| 位置 | 每個跑法各寫一份 | `spine/`，不得 import `services/`（ESLint 擋） |
| 先例 | — | `spine/systemJobs.ts`：系統工作的事件／目標／模組宣告，`mutate` 逐事件檢查 |

B：`TokenScope`（`spine/toolScope.ts`）加 `writeMode: 'suggest' | 'apply'`。`mutate()` 對 `actor.type === 'agent'` 且 `writeMode === 'suggest'` 的身分，
**只允許** `AI_SUGGESTION_CREATED`（及既有稽核事件 `AGENT_TOOL_*`、`AGENT_SESSION_*`）；其他事件 → `AuthorityError`。
工具清單也不給 API 跑法寫入工具（`toolsForRuntime`），但那只是不浪費模型回合，**安全不依賴它**。對應測試：以 `suggest` 身分直接呼叫 `mutate` 寫 `NODE_UPDATED` 必拒絕；
`updateNode` 工具在 `suggest` 下產生建議而非寫入；API 工作階段中 `writeMode` 無法被請求內容改變（它從 session 列推導，不接受客戶端指定，AGENTS 權限規則）。

### 7.3 其他威脅與界線

- **提示注入**：沿用 agent-mentions §5.2 全部界線（只有人能起 session；筆記內容是資料、只有自己的技能是指示；session 限單一空間；每次呼叫用目前政策重查）。
  API 與訂閱／MCP 相同：注入成功後最壞＝產生一堆壞建議（人可整批拒絕），不能改內容。
- **外送通道**：訂閱 runner 無 WebFetch／WebSearch；MCP 看使用者自己的 Claude；**API 開網頁搜尋＝新的外送通道**（查詢字詞可夾帶筆記內容）。
  所以預設關、角色層級、設定畫面白話說明；開啟時事件記錄 `search` 長度（不記內容）。
- **API 金鑰**：AES-256-GCM 加密保存，金鑰 `ONDEN_SECRET_KEY` 只來自部署環境（不在資料庫、不在設定畫面）；API 只回後四碼；不寫進日誌、事件、錯誤訊息；
  可撤銷（`revoked_at`），撤銷後進行中的 session 在下一次呼叫失敗。**資料庫備份含密文**，所以備份與 `ONDEN_SECRET_KEY` 必須分開保管（deploy.md 要補）。
  〔建議〕為這個 key 在 Console 建**專用 workspace 並設花費上限**（[官方說明](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)：同一 Console 組織的所有 key 共用同一餘額，要限制某專案就給它獨立 workspace 並設 spend limit），這是 Onden 外的最後一道保險。
- **花費上限（Onden 側）**：每 session 最大回合（`max_iterations`，預設 12）與最大輸出 token；每角色每月上限 `monthly_cap_micro_usd`（超過 → API 跑法不可用，白話顯示）；
  `max_per_hour`／`max_concurrent`（既有）照用。費用是**估計**：token 是真實用量；金額來自程式內的單價表、模型不在表內則只顯示 token。
- **權限**：角色的空間存取不變（不在／可看／可編輯 ＝ `spine/spaceAccess.ts`）。提建議需要角色對該空間為**可編輯**（理由：提議修改內容等同「想編輯」；第 9 節第 3 題）；
  接受者需要對該筆記的寫入權，以**接受當下**的權限判斷（人被降權就不能接受）。讀取：建議與其事件的可見性＝能讀該筆記。
- **撤權與政策改變**：角色被移出空間或停用 → 新建議被拒絕；已存在的建議仍可由有權的人處理（§3.2.2）；子樹／空間政策改變沿用 `membership_epoch`，不新增版本機制。
- **建議不是秘密通道**：建議內容（含 `base_markdown` 快照）可讀範圍＝該筆記可讀範圍；筆記之後改為更私密時（移到只有擁有者的空間），建議隨 `space_id` 重新判斷（讀取時用 `readPolicy`，不快取可見性）。
- **kill switch**：既有 `setRunnerEnabled`（停用角色）涵蓋三種跑法：停用 → queued 取消、token 撤銷、API 的進行中 session 於下一回合檢查旗標而中止。

## 8. 費用

**結論（已查證，附來源）**

1. **訂閱額度不能直接給「API 跑法」用。** 訂閱（Pro／Max／Team）的 OAuth 憑證用於 Claude Code 與 Anthropic 自家應用；官方法務頁說
   「開發者（含用 Agent SDK 者）應使用 API key」，且不允許第三方「經由 Free／Pro／Max 憑證路由請求」、不得收集或保存 Claude.ai 憑證。API 跑法因此**只用 API key**。
   來源：[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)（2026-10-27 讀取）。
2. **Max／Team 附一份「每月 API 額度」，可以用在 API 跑法與（用 API key 的）Agent SDK。** Max 5x $100、Max 20x $200；Team 每個 Standard 席 $20、Premium 席 $100，合併一個餘額、上限 $500；
   Pro 與 Enterprise **沒有**。要領取：在 claude.ai 的 Billing 把一個 Claude Console 組織連到方案，額度進該組織；用該組織建的 API key 呼叫即扣抵；
   涵蓋 Claude API、Managed Agents、Agent SDK、Console Playground，**不涵蓋 Claude Code**；每個計費週期結束作廢、不累積；用完且無其他餘額時 API 請求停止、**不會改扣訂閱**。
   來源：[API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)、
   [Help Center 版](https://support.claude.com/en/articles/17154008-api-credits-for-max-and-team-plans)（2026-10-27 讀取）。
   Help Center 版還明說：`claude -p` 與 Agent SDK 只有「用那個組織的 API key 自己跑」才扣這份額度，**用方案登入跑則算在方案用量**。
3. **訂閱執行程式（`claude -p`＋訂閱登入）花的是訂閱用量上限，不是上面那份 API 額度。** 官方文章
   [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)（2026-10-27 讀取）寫：
   先前宣布的 Agent SDK 使用變更**已暫停（原訂 2026-06-15）**，Agent SDK、`claude -p` 以方案登入時**仍計入訂閱用量上限**。
4. **MCP 跑法**：使用者自己的 Claude（Code／桌面）互動使用，算在使用者自己的方案；Onden 不花任何錢。

**〔未確認〕與矛盾，請你以自己的帳號為準：**

- 我用搜尋時有一個摘要說「2026-06-15 起 Agent SDK 與 `claude -p` 不再計入方案上限，改領獨立的月額度（Pro $20、Max 5x $100、Max 20x $200）」。
  這和上面第 3 點官方文章（「已暫停」）**互相矛盾**，我沒讀到該摘要的原始頁面，所以**不採信**。結論：你的方案目前是哪一種，請看 claude.ai 的 Settings／Billing 實際顯示什麼。
- 你的方案是 Pro、Max 還是 Team？（Pro 沒有 API 額度；這決定 API 跑法是否「幾乎免費」。）
- 「在伺服器用 Agent SDK 函式庫搭訂閱憑證」是否被允許：官方頁沒有明說（§4.3）。**〔未確認〕**，不採用。
- 實際每次花多少：我沒有量測過本專案任何動作的 token 用量；批 4 完成時先量再宣稱（AGENTS「效能」規則同樣適用於成本）。

| | 付費來源 | 額度用完時 |
| --- | --- | --- |
| API | API key 所屬 Console 組織的餘額（Max／Team 有每月額度可抵；其餘為預付／自動儲值） | 請求失敗 → session 失敗 `額度已用完`，**不自動重試** |
| 訂閱 | 訂閱用量上限 | runner 回 `rate_limited`／`billing_error`（既有 agent-mentions §4.3），不自動重試 |
| MCP | 使用者自己的方案 | 使用者的 Claude 自己處理 |

## 9. 需要你決定的事（每題附建議）

1. **同意部分推翻 10/23 嗎？**（重新引入伺服器端的模型呼叫，但只作為「只能提建議、沒有預設模型、沒 key 不出現、有上限與紀錄」的 API 跑法。）
   **建議：同意**，並在批 0 修訂 AGENTS.md「Onden 不呼叫任何語言模型」那一條、`harness.md`、`harnessBoundary.test.ts`
   （改為只允許 `services/agentRuntime/api/` 匯入 SDK，其他處仍禁止，守門測試留著）。**不同意**：批 4、批 5 的 API 部分整批不做，其餘照常。
2. **既有的 AI 角色（`@ai`）與既有 MCP token 的審核規則要遷移成 `suggest` 嗎？** 這會改變你現在用 Claude Code 連 MCP 時「直接生效」的習慣。
   **建議：遷移成 `suggest`**（行為一致、規則簡單），需要直接生效的角色你自己在卡上切回 `apply_then_review`（API 跑法不允許切）。
3. **「可編輯」是否等於「可以提修改建議」？** 替代：可看就能提建議。**建議：可編輯**（不改 `spaceAccess` 語意；「可看」的 AI 只能讀與留言，留言要不要放寬到可看另議）。
   另外：v1 的建議只涵蓋內文與標題、留言；新增筆記與標籤變更不做成建議（建議：先這樣，批 9 再補）。
4. **@ai 提及的回覆怎麼處理？** （a）當一則 insert 建議，要按接受才進筆記；（b）顯示在側欄、要寫進筆記時按「插入筆記」（＝一則建議）。**建議 (b)**：問答不污染本文，寫入仍要你點頭。
5. **API 金鑰的入口與 API 卡的呈現。** 建議：設定›空間與成員頁頂部一個「API 金鑰」小區塊（也是新增流程第 2 步的小字連結目標）；沒有金鑰時 API 卡不出現（照你的規定）。
6. **模型**：沒有預設，一定由你在角色上選；清單來自金鑰呼叫 `GET /v1/models`。**建議**照辦；模型停用時角色顯示警示、API 跑法暫停，不自動換模型。
7. **網頁搜尋預設關**，只能在角色上開（外送通道）。**建議**同意。
8. **上限預設值**：每 session 最多 12 個回合；每角色每月預設**不設** Onden 側上限（改建議你在 Console 專用 workspace 設 spend limit），但設定畫面提醒；
   或預設設一個你定的美元數？**建議：先不設預設上限，但畫面第一次開 API 時要求你選一個「每月上限」或明確選「不限」**。
9. **計畫門檻**：碰到第二篇以上筆記就要先批准計畫。**建議**同意（也可改成「超過 N 篇」）。
10. **待審建議總覽**放收件匣新分頁（批 8）？**建議**同意，但 v1 先只做筆記內逐處接受。
11. **`[[` 參考是否只限同空間？** v1 session token 限單一空間；跨空間要另一個明確的使用者操作。**建議：v1 只限同空間**，側欄挑選器只列同空間筆記。
12. **訂閱 runner 要不要也支援用 API key 跑**（同一容器換環境變數，用 Max 的每月額度）？**建議**批 3 尾端做成可選，先不阻擋主線。
13. **未處理的建議保留多久？** 建議：不刪除，30 天未處理的標示「較舊」、在總覽排後面；不自動拒絕。
14. **費用顯示**：token 是精確值；金額是估計（程式內單價表，未知模型只顯示 token）。**建議**同意。你的方案是 Pro／Max／Team？（§8 的矛盾要靠你確認。）

## 10. 分批實作計畫

每個 PR 都要通過相關 `npm test -- <路徑>`、`npx tsc --noEmit`、`npm run lint`；影響前端時 `npm run build`；整合測試用隔離資料庫並確認沒被跳過；
影響介面的批次用瀏覽器檢查桌面與手機尺寸（手機標示為 viewport 模擬，不是真機）。收斂重複時同一 PR 加守門測試。大小為含測試的概估變動行數，未量測。

| 批 | 範圍 | 主要檔案 | 預估 | 依賴 |
| --- | --- | --- | --- | --- |
| **0** | **決定紀錄（純文件）**：依第 9 題結果修訂 AGENTS.md、`harness.md`、`agent-delegation.md`、`agent-mentions` 的狀態契約；`docs/agents/` 新增 `decisions-ai-collaboration.md` | 文件 | ~150 | 第 9 節 1、2 |
| **1** | **建議核心（後端）**：migration 149；`services/aiSuggestions.ts`（建立／接受／拒絕／重試）；`nodeUpdate` 加 `onConflict:"refuse"`；`TokenScope.writeMode`＋`mutate` 宣告式許可；事件四種；`agentRuns` 納入 `suggested_by`；工具 `suggestEdit`／`comment` 與 `updateNode` 在 suggest 下改存建議；測試（授權允許／拒絕、競態、stale、交易回滾、重試去重、整組復原含已接受的處） | `services/aiSuggestions.ts`、`spine/mutate.ts`、`spine/toolScope.ts`、`services/nodeUpdate.ts`、`services/agentTools/`、`services/history/agentRuns.ts` | ~1,200 | 0 |
| **2** | **建議 UI**：編輯器 diff 裝飾、逐處／全部接受拒絕、stale 與 void 顯示、`eventTypeLabel` 新事件、離線時停用；**@ai 回覆改走建議**（`agentSessions.finish` 與 status 契約） | `components/MarkdownEditor*`、`lib/data` writer、`agentSessions.ts`、`lib/eventKinds.ts` | ~900 | 1 |
| **3** | **角色與跑法層**：migration（下一個空號；改名 `ai_roles` 與欄位、session 欄位）；`services/agentRuntime/`（介面、`subscription`＝現有 pull、`mcp`＝隱含 session）；`GET/PATCH /api/ai-roles`；`runner_seen_at`；MCP 的 `listPendingRequests`；可選：runner 支援 API key | `services/agentRuntime/`、`services/agentSessions.ts`、`routes/aiRoles.ts` | ~900 | 1 |
| **4** | **API 跑法**：migration（下一個空號；`ai_credentials`）；加密保存與 `ONDEN_SECRET_KEY`；模型清單；Tool Runner 迴圈（`betaZodTool` 轉 registry 工具）；小動作串流；用量與上限；`actorForRuntimeSession`＋守門測試；`harnessBoundary` 改為目錄白名單；outbox 一次性領取與 `interrupted`；量測 token | `services/agentRuntime/api/`、`services/aiCredentials.ts`、`test/harnessBoundary.test.ts`、`test/guards/` | ~1,100 | 0（同意）、1、3 |
| **5** | **設定畫面：AI 角色卡＋新增流程**（接分支 `fix/spaces-members-clearer`；開頭先 rebase 並對照 §5.6 接合點）；API 金鑰區塊 | `settings/spacesAndMembers/*`、`lib/data` | ~800 | 3（API 部分需 4） |
| **6** | **「交給 AI」**：選取工具列、段落邊欄、預設動作（內建技能 `rewrite/shorten/translate`）、自訂、每次指定跑法、串流預覽卡 | `components/MarkdownEditor*`、`services/harness/builtinSkills.ts` | ~800 | 2、3（串流需 4） |
| **7** | **資訊欄 AI 分頁**：每篇一條對話、`[[` 參考、出處驗證與顯示、讀取紀錄、計畫卡；`proposePlan` 工具與 `createSuggestions` 的計畫強制、`awaiting_plan`、`AI_PLAN_DECIDED` | `components/Inspector*`、`services/aiSuggestions.ts`、`services/agentTools/` | ~1,000 | 2、3 |
| **8** | **AI 留言邊欄＋收件匣「AI 建議」總覽** | 前端為主 | ~600 | 2 |
| **9** | **補完**：新增筆記／標籤變更的建議；e2e（假 API 伺服器、假 runner）、桌面與手機 viewport 檢查、成本量測報告；`docs/architecture/ai-collaboration.md`（把本提案轉成已實作契約）、`deploy.md`（`ONDEN_SECRET_KEY` 與備份分管） | — | ~700 | 1–8 |

- **最小可用切片＝批 0＋1＋2**：不需要 API、不需要新跑法；現有訂閱 runner 與 MCP 的 AI 修改全部先變成建議，使用者可逐處接受。即使最後不做 API 跑法，這個切片本身有價值。
- 批 3、4 可平行（4 依賴 1 與 3 的介面定義，介面在批 3 的第一個 commit 先落地）。
- 每批的「完成」：說明遷移了哪些入口、呼叫者少理解什麼、保留什麼行為、測試結果與剩餘限制（AGENTS 驗證規則）。

## 11. 非目標與已知限制

- 不做：AI 直接寫入的 API 路徑；Onden 內建的 Claude 登入；Onden 選模型；遠端 MCP connector／Funnel；通用的人類留言系統；多角色協作編排；
  離線接受／拒絕建議；建議跨空間；自動接受規則。
- 不宣稱：出處驗證等於回答正確（只證明 AI 讀過那篇）；費用估計等於帳單；訂閱跑法一定在條款允許範圍（§4.3、`agent-mentions` §4.4 的灰色地帶沿用）；
  思考摘要每個模型都有（〔待驗證〕）。
- 〔待驗證〕：Tool Runner 目前是 beta、`@anthropic-ai/sdk` 升級可能改介面（批 4 固定版本）；`betaZodTool` 與現有 zod 版本的相容（批 4 開頭先試）；
  `fix/spaces-members-clearer` 的實際元件結構；API 回應中思考區塊的可得性；`outbox` 是否能表達「一次性領取」（若不能，`agent_session_run` 的 `perform` 內自己守衛，不改 outbox 核心）。
- 還沒量測：API 小動作的端到端延遲、Tool Runner 單次側欄問答的 token／金額、訂閱 runner 啟動到 ack 時間。批 4、9 先量再宣稱。

## 參考

- 現況程式：見各節檔案；工作階段 `services/agentSessions.ts`，整組復原 `services/history/agentRuns.ts`／`agentRunUndo.ts`，寫入 `spine/mutate.ts`，系統工作宣告先例 `spine/systemJobs.ts`，工具 `services/agentTools/`，前端設定 `settings/spacesAndMembers/`。
- Anthropic 文件（2026-10-27 讀取）：[API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)、
  [Help Center：API credits](https://support.claude.com/en/articles/17154008-api-credits-for-max-and-team-plans)、
  [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)、
  [Legal and compliance（Claude Code）](https://code.claude.com/docs/en/legal-and-compliance)、
  [Tool runner (SDK)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)、[List Models](https://platform.claude.com/docs/en/api/models-list)。
- 相關架構：[agent-delegation](../agent-delegation.md)、[harness](../harness.md)、[spaces](../spaces.md)、[restore-writes](../restore-writes.md)、[block-nodes](../block-nodes.md)。


## 實作狀態補記（2026-10-31）：AI 記得之前做過什麼

`<previous_runs>`（同一則筆記、同一 agent、最近 5 次、30 天、約 2,000 字元，標成紀錄而非指示）與 MCP 唯讀工具 `listMySessions`／`getSessionLog` 已實作；契約與限制見 [decisions-ai-collaboration.md](../../agents/decisions-ai-collaboration.md) 批 5。
