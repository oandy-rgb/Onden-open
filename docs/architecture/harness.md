# 技能 harness：技能只組 prompt；模型呼叫只在 API 跑法

> 狀態：現行（最後確認 2026-11-01）

> 2026-10-23 改寫：內建的全域 API AI（伺服器拿全域 key、有預設模型、直接寫入）已整個移除，那一套 H1–H5（模型閘道、`POST /api/ai/run`、
> 串流、工具迴圈、額度、「設定 › AI」的金鑰與模型）不存在，歷史看 git。
> **2026-10-30 業主決定「加回來，但共用 mcp 的架構」**：伺服器可以用**使用者自己的 API 金鑰**呼叫模型，但只作為 AI 角色的一種「跑法」
> （`services/agentRuntime/api/`），工具、權限、寫入、紀錄全部與 MCP 同一份。設計與決定見
> [decisions-ai-collaboration.md](../agents/decisions-ai-collaboration.md) 與
> [提案](proposals/ai-collaboration-2026-10-27.md)。技能筆記的格式、「當成技能」開關（`skills` 模組標籤）、簡報切頁規則仍以
> [skills-and-presentation.md](skills-and-presentation.md) 為準。

> **2026-10-31 業主決定：技能是功能，不是標籤；開著「給 AI 用」的技能由 AI 自己挑**（取代 2026-10-22「技能一律手動點名」）。
> 見〈AI 自己挑技能〉。

## 現況一句話

AI 在 Onden 是一個角色，只有兩種跑法：**API**（伺服器用使用者的金鑰呼叫任何服務的模型）、**MCP**（使用者自己的
AI 用戶端用限權 token 連進來；可以手動開，也可以放在某台機器上自動領排隊中的工作，見 [自動領工作](../self-host/ai-client-on-a-machine.md)）。兩者共用同一組工具（`services/agentTools` registry 與 `callTool`）、同一個寫入路徑（`spine/mutate`）與同一份
工作階段紀錄。**API 跑法永遠只能提建議，不能直接改內容**：它的 session 寫入模式 `suggest` 由資料庫欄位決定，`mutate()` 對這種身分只放行
`AI_SUGGESTION_CREATED`（`spine/writeMode.ts`）。**送給模型的筆記內容只經 `harness.prompt()`**（讀取政策 ∩ 空間 `external_ai`）；
沒有預設模型，沒有 `ONDEN_SECRET_KEY` 或沒有金鑰時 API 跑法整個不出現。

## 留下來的：`services/harness/`

harness 現在只做「把技能與範圍組成 prompt」，不執行：

```ts
// services/harness/index.ts — 對外三個函式
skills(actor, workspaceId): Promise<SkillSummary[]>;      // 技能目錄：內建技能 + 自己的技能筆記（每列有 aiUse）
skillMarkdown(actor, workspaceId, id): Promise<{ filename; markdown } | null>;  // 匯出成標準 SKILL.md
prompt({ actor, workspaceId, skill, scope, input? }): Promise<RenderedPrompt>;  // 組好的 system + messages

type Scope =
  | { kind: "search"; query: string }      // 混合檢索
  | { kind: "text"; text: string }         // 一段文字
  | { kind: "nodes"; ids: string[] }       // 指定筆記
  | { kind: "tag"; tagId: string }         // 某個標籤底下的筆記
  | { kind: "board"; boardId: string };    // 一塊白板（卡片順序 = 內容順序）
```

- **消費者只有兩個**：`routes/mcpProtocol.ts`（MCP `prompts/list`、`prompts/get`，外接 AI 自己執行 prompt），
  與 `routes/skills.ts`（`GET /api/skills` 技能目錄、`GET /api/skills/:id/skill.md` 匯出 SKILL.md）。
- **取材仍受權限管**：`scope.ts` 用讀取權限 ∩ 空間的「外部 AI」開關（`aiReadable`）；技能筆記本身也要過
  （只收自己寫的、讀得到、所在空間外部 AI 開關打開的筆記）。範圍外的筆記讀起來跟不存在一樣。
- **harness 不寫入任何東西**；筆記內容一律當資料，只有技能正文是指示。
- 內建技能（`builtinSkills.ts`）：`ask`、`outline`、`expand`、`summarize`、`fix`——現在都只是 MCP prompt 的範本。
- `backend/src/test/harnessBoundary.test.ts` 守住：後端只有 `services/agentRuntime/api/protocols/` 可以 import 模型 SDK，避免伺服器端 API AI 悄悄回來。

## 已移除（2026-10-23）

| 移除的 | 說明 |
| --- | --- |
| `POST /api/ai/run`、`GET/PUT /api/ai/settings`、`GET /api/ai/models` | 後端 `routes/ai.ts`；技能目錄搬到 `routes/skills.ts`（`/api/skills`） |
| `services/aiRun.ts`、`harness/gateway.ts`、`harness/tools.ts`、`harness/sources.ts`、`run()` | 模型閘道、H5 工具迴圈、額度計量、串流 |
| app setting 舊的 API 金鑰與模型設定 與 `app_settings` 表 | migration `126_drop_app_settings.sql` 把整張表刪掉（它只存過這兩個值） |
| 環境變數 `AI_PROVIDER`、`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`ASK_*`、`ASK_MODE` | 不再讀取；模型 SDK 依賴一併移除 |
| 技能筆記 frontmatter 的 `tools:`（`notes`、`web`） | 工具迴圈沒了，這個鍵現在視為不認得的鍵（匯入時列入 `ignoredKeys`） |
| 前端「問你的筆記」頁（`AskPanel`）與導覽、⌘K 的 「Ask notes」 | 導覽位置直接移除，沒有替代品 |
| 前端「設定 › AI」分頁（金鑰、模型）、`lib/aiRun.ts`、`lib/aiErrors.ts`、SSE helper、`reads.ai` | |
| 「用技能…」（`SkillRunDialog`）、技能 applies_to 標籤上的 header 按鈕（`SkillHeaderButtons`） | 暫時隱藏；之後由 @ai 提及功能以「交給 AI」接回 |
| 「做成簡報」（`MakeDeckDialog`，AI 生成大綱）與 sidebar「+」入口 | 簡報**播放**（`PresentationPlayer`）保留 |
| 問答面板的「存成技能」（`saveAsSkill`） | 隨面板移除；`createSkillNote` 與 SKILL.md 匯入保留 |

## AI 自己挑技能（2026-10-31）

像 Agent Skills 的做法：先只給名稱和「什麼時候用」，AI 覺得合適才載入全文。

- **開關**：每個技能一個「給 AI 用」。技能筆記存在自己的 frontmatter（`ai: auto|manual`，沒有這個鍵＝開，舊技能不用遷移）；
  內建技能存在帳戶設定 `aiSkillsOff`（`services/harness/aiSkills.ts` 的 `builtinSkillsOffForAi`）。
- **提示**：沒有點名技能的 mention session，`renderSessionPrompt` 在 `<request>` 前多一個 `<available_skills>` 區塊
  （`agentSessionPrompt.ts` 的 `skillsListBlock`，由 `availableSkills` 供料）。只列：開著「給 AI 用」、session actor 讀得到、
  所在空間的「外部 AI」開著的技能；每個只有 id、名稱、什麼時候用；套用在本筆記標籤（`applies_to`）的標成「適合這則筆記」並排前面。
  最多 20 個、約 4000 字，超過就截掉後面的；區塊宣告自己是資料不是指示，名稱與說明裡的 `<` `>` 會被拿掉，所以關不掉區塊。
  點名技能的 session（`@ai /[[技能]]`）、選取文字動作不加這個區塊。
- **載入**：唯讀工具 `loadSkill({ skillId, reason? })`（`services/agentTools/loadSkill.ts`，工具只有 registry 這一份，MCP 與 API 跑法共用）。
  走 `loadNoteSkill`／內建，同一套讀取權限與外部 AI 開關；**關著的技能、別人的技能、讀不到或不准送出的技能都回 `null`**。
  在 session 裡載入會記到 `agent_sessions.picked_skill_*`（技能名稱快照＋AI 自己給的一句理由），這是建議卡標頭的來源。
- **只有點名才用**：關著的技能不在 `<available_skills>`、不在 MCP `prompts/list` 與 `GET /api/skills?for_ai=1`，但用 id 點名
  （`@ai /[[技能]]`、`prompts/get skill-<id>`）照常可用。`GET /api/skills` 本身列出全部，每列有 `aiUse`（設定頁要顯示關著的）。
- **建議卡**：「AI 建議 · 用了「X」」（點名）或「AI 建議 · 自己挑了「X」」＋AI 的一句理由（`suggestionsForNode` 的 `skill`；只有發出請求的人看得到，
  技能是他的）。不顯示 id 或代碼。
- 不變的：AI 的結果仍是待審建議（API 跑法 `suggest`）；Onden 不新增模型呼叫、預設模型或全域金鑰。

## 留下來、與 AI 有關但不屬於這次移除的

- 技能筆記（「當成技能」開著，內部是 `skills` 模組標籤，介面不顯示）；MCP prompts；SKILL.md 匯出與匯入（保留 `ai` 鍵）。
- 前端技能目錄（`modules/skills/catalogue.ts`；前端呼叫 API 列技能的函式已在清除死碼時刪掉）：目前沒有畫面使用，等「交給 AI」的技能挑選器接回。
- MCP 工具與 token（`services/agentTools/`、`/api/mcp/*`）原封不動。
- semantic 模組（獨立的嵌入模型，預設關閉）原封不動。
- 資料上 `source_type = "ai"` 的既有筆記照舊顯示（舊的「存成筆記」產物）。

## 之後

@ai 提及功能（`docs/archive/architecture/agent-mentions-2026-10-22.md`，開發中於 `feat/agent-sessions-*`）會把
「套用技能」「做成簡報」以「交給 AI」接回：由使用者自己的 AI 執行，結果走 MCP 寫回並經過權限檢查，此路徑 Onden 不呼叫模型。另一條路是 `services/agentRuntime/api` 用使用者自己的 API 金鑰呼叫模型（只能提建議）；harness 本身仍只組提示、不寫入。

## 參考

- [The anatomy of an agent harness](https://langchain.com/blog/the-anatomy-of-an-agent-harness)
- [MCP prompts, resources, and sampling](https://archestra.ai/blog/underused-mcp-primitives)
