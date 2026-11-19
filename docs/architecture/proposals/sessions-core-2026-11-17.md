# 設計與清查：工作階段是臨時參與者（後端核心）

> 狀態：提案（2026-11-17）。只做後端：沒有畫面、沒有通道（配對、碰面點、QR）、沒有部署。
> 接在 `roles-spaces-sessions-2026-11-15.md`（PR #1714，尚未進 main，第 3、5、6、7、8、10 節）與 [同步哪些空間](scoped-sync-2026-11-16.md)（第 0、1、9 節）之後，不推翻它們；
> AI 的現行決定在 [AI 協作決定](../../agents/decisions-ai-collaboration.md)。
> 完成後：歸檔
> 標記：**【查過】**＝附指令與輸出；**【推論】**＝由程式推出、沒執行；**【沒做】**。

## 0. 結論

1. **設計 B 成立，沒有發現推翻它的事。** 工作階段是一個 `actors` 列（新的種類 `session`）加一列 `participant_sessions`；它能做什麼、看到什麼，由它在 `space_members` 裡的列決定，
   和所有人走同一條判斷（`spine/spaceAccess.ts`）。「不比開的人寬」寫進同一條判斷裡（`temporarySql`），所以開的人被降權或離開空間的那一刻，工作階段跟著縮。
2. **清查找到的洩漏只有一類：標籤定義。** 標籤名稱與欄位名稱全工作區共用，只在別的空間用到的標籤，名字會從 bootstrap、同步（增量與可讀集合）、標籤相關路由、事件列表送出去
   （第 1 節）。成員看到沒問題（共用詞彙）；臨時工作階段看到就是洩漏。用一個判斷關上（`tagScopeSql`），在 `spaceScopeSql` 裡，所以走這條規則的讀取一次關上。
3. **個人資料：工作階段不寫、不被送。** 寫入全走 `mutatePersonal`，它對工作階段丟拒絕；有一處（專注紀錄）不走它，另加 `requirePerson`（第 3 節）。
   **「讀你的」沒做**：工作階段目前讀不到本人的個人列（見第 6 節）。
4. **AI：工作階段不能開始任何 AI 工作。** 入口原本就要求 `type === "human"` 加 `isPerson`，工作階段自動被擋；MCP 路徑另外擋掉（第 4 節）。

## 1. A1：沒有被空間限制的讀取（清查）

【查過】做法：`src/test/sessionLeakInventory.integration.test.ts`。空間 B 放一個 A 的成員不在的空間，裡面每一種東西各放一個獨特的名字（筆記標題與內文、只用在 B 的標籤、標籤上的欄位、
只寫在 B 筆記上的屬性鍵、B 的名字、只在 B 的人、只在 B 的 AI、操作者個人空間的筆記與偏好）。然後用 A 的成員呼叫**每一條掛上的 GET 路由**（從路由器讀，不是人工列表，
一共 129 條，每條各一次不帶 id、一次帶 B 的 id＋搜尋字）與三個讀取用的 POST，在回應裡找這些名字。這是在乾淨的 main 上跑的（commit「Pin the reads…」），輸出：

```
[leak-inventory] 257 requests over 129 routes; routes that returned a name of space B:
GET /api/bootstrap ← field, tag          GET /api/events ← tag            GET /api/sync ← field, tag
GET /api/sync/membership ← field, tag    GET /api/sync/membership/digest ← field, tag
GET /api/tags ← field, tag               GET /api/tags/:id ← field, tag   GET /api/tags/:id/export ← field, tag
GET /api/tags/:tagId/delete-preview ← tag   GET /api/tags/:tagId/path ← tag   GET /api/tags/tree ← tag
POST /api/sync ← field, tag
```

| 種類 | 回傳 B 獨有的名字？ | 為什麼（位置） |
| --- | --- | --- |
| 筆記標題、內文、屬性鍵 | 否 | 讀取關卡：`require-read-gate` 把每個讀 `content_nodes` 的檔案分類（`eslint-rules/require-read-gate.js`），`services/readPolicy.ts` |
| 空間名稱 | 否 | `GET /api/spaces` 只列自己是成員的空間（`services/spaces.ts:105 spacesForActor`）；成員清單要在空間裡（`routes/spaces.ts` `/:id/members`） |
| 人、AI 的名字 | 否 | 名冊只有擁有者（`services/actors.ts listActors`）；`candidates`、`overview` 要管理權限 |
| **標籤定義名稱、欄位名稱** | **是** | `spine/spaceScope.ts` `spaceScopeSql`（舊：`tagNodeSql OR 在可讀空間`）：標籤全工作區共用；`services/tagCatalog.ts:51 readTagCatalog` 列出全部標籤；`services/tagHierarchy.ts listTagTree` 沒有操作者 |
| 標籤的事件 | **是** | `services/eventVisibility.ts:33 TAG_DEFINITION_TARGETS`：標籤定義的事件每位成員都看得到 |
| 工作區設定 | 成員讀得到（網站標題、首頁區塊） | `routes/workspace.ts:63`：不看操作者 |
| 搜尋、歷史、收件匣、版本 | 否 | `readableScopeSql`／`readableNotesSql`／`eventVisibleSql` |
| 功能清單（function_refs） | 只經標籤列送出 | `services/functionRefs.ts:144 functionIndex` 只在標籤目錄裡出現，標籤列縮小它就跟著縮 |

**所有 129 條 GET 路由與三個 POST 的逐條結果在本文最後（附錄），含檔案與行號、成員看到的狀態、是否回傳 B 的名字、臨時工作階段看到的狀態。**

**AI 工具（17 個，`services/agentTools/`）**：【查過】`test/aiToolScopeSweep.integration.test.ts` 與 `readToolsScope` 已逐一把每個工具對準另一個空間的筆記，斷言輸出不含該空間獨有的文字；
讀取工具都經 `readableAmong`／`readableScopeSql`／`spaceAccess`（`readableNote.ts`、`listChildren.ts`、`listSuggestions.ts`、`getAttachment.ts`、`queryView.ts`）。
沒有工具列出標籤定義，所以標籤名稱不經工具流出。工作階段不碰工具（`/api/mcp` 對它直接 403，第 4 節）。

## 2. A2：每一個「否」（會洩漏的）對臨時工作階段怎麼辦

| 入口 | 工作階段今天（沒處理時）看到 | 決定 | 理由 |
| --- | --- | --- | --- |
| 標籤定義、欄位（bootstrap、同步、`/api/tags*`、事件） | 全部標籤的名稱與欄位 | **縮成「用到它的空間有一個它讀得到」；沒人用的標籤與保留／模組標籤照給** | 擁有者規則：來賓不能因標籤名稱得知別的空間存在。沒人用的標籤不指向任何空間；保留與模組標籤是產品自己的詞。標籤的子標籤或繼承它的標籤有人用，它就算有人用（和 `memberTagIds` 同一個規則），所以路徑 `a/b` 的父層看得到 |
| 標籤事件 | 所有標籤事件的內容 | **只給看得到的標籤；檢視（`collection_view`）事件整個不給** | 同上；檢視事件的對象是檢視 id，不是標籤 id，無法判斷屬於哪個標籤 |
| 工作區設定 `GET /api/workspace/config` | 網站設定 | **隱藏（403，`requirePerson`）** | 是工作區本人的設定，不是別人電腦上的臨時工作階段的 |
| 成員名冊、空間成員 | 工作階段是空間成員，本身出現在成員清單 | **名冊與成員清單排除 `session`；擁有者在成員清單另外看到「工作階段」列** | B5 |
| 備份、整個匯出、快照 | — | **拒絕（`requirePerson`）** | B3 |

**殘留（沒關，記在這裡、不假裝關了）**：
- 標籤名稱當探針：工作階段新增一個標籤，若同名標籤已存在（只在別的空間用），得到 409 `tag_name_conflict`，知道有這個名字。它得先猜中名字；成員本來就看得到所有標籤，所以今天不算洩漏，對來賓才是。
  只有「新增標籤」入口受影響。【沒做】要決定：工作階段不能新增標籤，或衝突時假裝成功並用一個它看不到的 id（兩者都改變行為）。
- 繼承：可見標籤 `extends` 一個只在別的空間用到的標籤時，「有效欄位」（`effective_fields`）含被繼承的欄位名稱。【推論】規則已讓「被繼承的標籤」算有人用（它的繼承者在可讀空間），所以標籤本身看得到，欄位也就不是祕密；沒另外測。

## 3. A3：個人資料（同一個人在陌生電腦上）

【查過】`grep` 產生的型別（`src/dbSchema.generated.ts`）裡以操作者為鍵的個人表，與它們的寫入入口：

| 表 | 寫入入口 | 工作階段寫入時 |
| --- | --- | --- |
| `actor_prefs` | `services/actorPrefs.ts`（`mutatePersonal`） | 拒絕（`own_personal`，`spine/authority.ts`） |
| `actor_module_settings`、`review_states` | `modules/review/service.ts`（`mutatePersonal`） | 拒絕（同上） |
| `rss_mutes` | `modules/rss/mutes.ts`（`mutatePersonal`） | 拒絕（同上） |
| `rss_seen` | `modules/rss/routes.ts:257`（`mutatePersonal`）；`modules/rss/save.ts` 的 `saveItem` 也整個在 `mutatePersonal` 裡 | 拒絕（兩處都是） |
| `external_calendars` | `modules/external_calendars/store.ts`（`mutatePersonal`）與 routes 的 `requirePerson` | 拒絕 |
| `push_subscriptions` | `routes/push.ts:22`（只准 `human`） | 拒絕（本來就是） |
| `focus_sessions` | `modules/tasks/focus.ts`：**走 `mutate`＋`any_space_write`，不是 `mutatePersonal`** | **原本不會被擋**；加了 `requirePerson`（3 處：start／end／edit） |
| `fresh_proofs`、`fresh_proof_attempts` | `services/freshProof.ts`（`requirePerson`） | 拒絕 |
| `agent_sessions`（發起人） | `services/aiSessionStart.ts:28`、`services/agentSessions.ts:255` | 拒絕（要求人） |

為什麼只多了專注紀錄一處：`mutatePersonal` 是寫個人資料的唯一入口（`spine/AGENTS.md`），把它的授權從 `open` 換成新的 `own_personal`（對 session 丟拒絕），一處關掉整類；
專注紀錄不走它（它同時寫事件與日記），所以現有入口沒蓋到。
**送到工作階段的同步**：`services/readPolicy.ts snapshotScope` 的 `person:` 取的是操作者的 id；工作階段的 id 不是本人的 id，所以個人列自然一列都不送（`spine/snapshotTables.json` 的 `{person:…}`）。
**RSS 存文章**：`saveItem` 整個在 `mutatePersonal` 裡，所以工作階段存文章一開始就被拒絕（`own_personal`），不會留下任何 `rss_seen` 列（測試：`participantSessions.integration.test.ts`「save an RSS article」）。先前文件寫的「殘留」是錯的，已更正。

## 4. A4：工作階段裡的 AI（第一版：不能開始）

| 入口 | 拒絕的方式 |
| --- | --- |
| `POST /api/agent-sessions`（@mention） | `services/agentSessions.ts:255` 要求 `type === "human"`（原本就有）→ 403 `human_required` |
| `POST /api/ai/panel-chat` | `services/aiSessionStart.ts:28`（原本就有）→ 403 `human_required` |
| `POST /api/ai/selection-actions` | 同上 |
| `/api/ai/roles`、`/api/ai/credentials*` | `services/aiRoles.ts` 的 `requirePerson`（原本就有） |
| `POST /api/ai-suggestions/:id/accept｜reject` | `routes/aiSuggestions.ts:22 requirePerson`（原本就有） |
| `/api/mcp/*`（AI 工具面） | **新增**：`app.ts` 對 `type === "session"` 回 403 `session_scope`。原本沒有：工作階段沒有 `tokenScope`，不會被「憑證只能用在 MCP」那條擋，反過來也沒有人擋它進 MCP |

`isPerson` 對 `session` 回 false，是上面所有 `requirePerson` 的來源；沒有為 AI 另寫判斷。

## 5. B：做了什麼

### B1 資料：新的 actor 種類，不是新的成員資格列

比較（要的是「主持者用和別人同一條判斷來評工作階段的請求」）：

| | 1. AI 角色的做法（`agent` ＋ 權杖） | 2. 只有 `participant_sessions` 加一張自己的成員表 | **3. `actors` 新種類 `session` ＋ `space_members`（採用）** |
| --- | --- | --- | --- |
| 判斷 | 沿用 `tokenScope`，但：權杖只能用在 MCP（`app.ts:234`）、只進 `external_ai` 開著的空間、`isPerson` 為 false | 要把 `spaceAccessSql`、`readableSpaceIdsSql`、`snapshotScope` 全改成看第二張表：新的判斷路徑 | `space_members` 是唯一的成員表，`spaceAccessSql` 多一個 EXISTS（`temporarySql`）把它限制在開的人現在的範圍內 |
| 「在裡面的行為和開的人一樣」 | 做不到：整個畫面都在 MCP 以外 | 每個讀取入口都要改 | 完全沿用 |
| 擁有者判斷 | 同左 | 同左 | 工作階段不是 `owner_actor_id`，所以 `principal_admin`、`review`、空間管理自動拒絕 |
| 代價 | — | — | `actors.type` 多一個值（CHECK 放寬）；名冊、成員清單、備份成員表要排除它（5 處，第 6 節） |

欄位：`participant_sessions(id, workspace_id, actor_id, opened_by, credential_hash, created_at, expires_at, ended_at, max_requests, request_count, max_bytes, byte_count, last_used_at)`；
顯示名稱存在 `actors.name`，固定「你（臨時）」（`SESSION_LABEL`，擁有者決定，不寫裝置或地點）。【PR #1856 第 2 輪改了】`actors.name` 不存字（`SESSION_NAME = ""`），回應不送 `label`，畫面從種類寫「臨時工作階段」（見[第二批提案](sessions-reads-own-2026-11-17.md)第 2c 節）。空間清單＝`space_members` 的列，沒有第二份。Migration 210（加法：放寬一個 CHECK、一張表、一個索引）。

### B2 開、列、結束、到期

`services/participantSessions.ts`：`openTemporarySession`、`listTemporarySessions`、`endTemporarySession`、`endTemporarySessionsOpenedBy`、`resolveTemporarySessionActor`，每個一個入口；路由在 `/api/spaces/sessions`（`routes/spaces.ts`，放在 `/:id` 之前）。
開：`requirePerson`＋`principal_admin`（擁有者）＋新用途 `open_session` 的再確認票（`consumeFreshProof`，在讀任何東西之前花掉）；只能給「開的人現在有的」權限，沒有的空間回「找不到」，同一個答案。
到期：每個請求由資料庫的時間判斷（`expires_at > statement_timestamp()`，在 `spine/currentActor.ts` 的同一個查詢裡），沒有計時器。
結束：立刻；成員資格同時刪除、`membership_epoch` 加一。

**規則（以測試釘住）**：一個進行中的請求，若它的工作階段在它拿到工作區事件鎖之前就結束，它不會提交；已經先拿到鎖並提交的，是歷史，不撤回。
實作就是已有的規則：`mutate` 在事件鎖後用 `resolveCurrentActor` 重讀操作者，工作階段已結束就是 401；`endTemporarySession` 本身也拿同一把鎖，所以先後順序是確定的。

### B3 以工作階段身分行動

憑證 `onds_` ＋ 32 個隨機位元組；只存 sha-256；只在開啟的回應裡出現一次；不進事件、日誌、網址。請求帶 `Authorization: Bearer onds_…`（`app.ts`），
變成 `ActorCtx{type:"session", sessionScope}`。**每個請求在同一條 UPDATE 裡檢查「還活著」並計數**（次數上限與請求本文位元組上限），所以搶著用不能超過上限。超過上限回 403 `session_limit_reached`（不是 401，不會被當成登出）。

「第一版角色」：開的人在那些空間的權限（view／edit），再扣掉：管理成員、開工作階段、啟動 AI、備份／匯出／快照、`requirePerson` 的一切。**每一項的拒絕都來自既有機制**；下面是我**必須新加檢查**的地方，與既有入口為什麼沒蓋到：

| 新加的檢查 | 為什麼既有入口沒蓋到 |
| --- | --- |
| `isPerson` 排除 `session`（`spine/authority.ts`） | `isPerson` 原本是 `!tokenScope`；工作階段沒有 `tokenScope` |
| `own_personal` 取代 `mutatePersonal` 的 `open` | 要讓個人資料的寫入拒絕工作階段；`open` 對誰都放行 |
| `exportZip.buildMarkdownExport` 加 `requirePerson` | 整個匯出原本沒有「只准人」，因為權杖進不來；工作階段進得來 |
| `workspaceSettings.readWorkspaceConfig` 加 `requirePerson` | 同上，原本不看操作者 |
| `modules/tasks/focus.ts` 三處 `requirePerson` | 專注紀錄不走 `mutatePersonal` |
| `app.ts`：工作階段不進 `/api/mcp` | 「只能用在 MCP」的規則只管權杖，不管反方向 |
| `newNoteSpace`／`newNoteSlugScope`：工作階段沒有個人空間 | 預設落點是「操作者的個人空間」；沒有時退回共用空間，工作階段不該退回去 |
| `spaceAccessSql` 的 `temporarySql`、`tagScopeSql`、`hiddenTagIds` | B6：關上洩漏、不比開的人寬 |

### B4 歸屬：欄位夠用，沒有第二條歸屬路徑

【查過】`domain_events.actor_id`（text）、`actor_type`、`device_id`（uuid）與 `sync_stamps.author`（text）、`device`（uuid）。工作階段的 `actors.id` 直接寫進 `actor_id` 與 `author`；
`device` 仍是請求的 `X-Onden-Device-Id`（本來就是這樣，客戶端指定）。【PR #1856 第 2 輪改了】工作階段的寫入不記它自稱的裝置（`recordedDeviceId`：null），見[第二批提案](sessions-reads-own-2026-11-17.md)第 2c 節。`actor_type` 寫 `user`（它是人的手，不是 AI）。測試 `participantSessions.integration.test.ts`
「reads and writes… attributed to itself」逐欄比對 `domain_events` 與 `sync_stamps`。**沒有發現「欄位不夠」**，所以沒有停。
附帶決定：`writesAsPerson` 對 `session` 回 true（本人的手打字，在它可寫的空間可以解決衝突）；若要改成「不算人」，工作階段寫到有衝突的單位會被拒絕（遷移 206）。**需要決定。**

### B5 成員清單

`GET /api/spaces/:id/members` 回 `{ members, sessions }`；`sessions` 只給擁有者（標籤、剩餘秒數、可結束），其他人與工作階段自己拿到空陣列；`members` 不含工作階段。

### B6 關上洩漏

第 2 節：標籤、標籤事件、工作區設定。**一個機制**：`tagScopeSql`（`spine/spaceScope.ts`）一個判斷，`spaceScopeSql`、`readTagCatalog`、`listTagTree` 與事件可見度（`hiddenTagIds`）用它；
對成員與其他操作者，它回傳和以前一樣的 SQL（`tagNodeSql`）。**被釘住的測試翻過來了**：commit「Pin the reads…」裡的兩個 `it.fails`（標籤名稱、欄位名稱）現在是對臨時工作階段的普通斷言；
成員那一邊改成「確實看得到（不變）」的普通斷言。

## 6. 沒做、需要決定

**沒做**
- 通道、配對、碰面點、QR；前端；來賓角色（別人）與人的「只能提建議」；即時打字；範圍化的修改包（`packages/backend/src/spine/stamped*` 沒動）。
- **「讀你的」**（**已在第二批做完**：[工作階段第二批](sessions-reads-own-2026-11-17.md)；下面是當時的說明）（擁有者回答：陌生電腦讀本人的個人列）：工作階段目前讀不到本人的個人列（個人表以操作者 id 為鍵，工作階段是另一個 id）。要做得補一個「個人資料的主人」函式（`openedBy`），
  再改 8 個讀取點（偏好、複習設定與進度、專注、RSS 已讀與靜音、外部行事曆）。不在這批：做一半比不做更糟（有的讀得到有的讀不到）。
- 位元組上限算伺服器**實際讀到**的請求本文（`readTemporarySessionBody`，邊讀邊計），不看 `Content-Length`；單一請求另有本文上限（第 10 節），上限與剩餘額度都是**精確**的：放不進剩餘額度的請求被拒、不計；回應大小不算。
- 清掉已到期工作階段留下的 `space_members` 列：下一次「開啟」時順便清（沒有計時器）；它們不影響任何判斷（工作階段已不能行動），只是資料庫裡還在。

**需要決定**（每一項我選了預設，列在這裡讓你改）
1. 標籤名稱當探針（第 2 節）：工作階段新增標籤遇到同名衝突時怎麼辦。
2. `writesAsPerson`：工作階段的寫入算不算「人的寫入」（B4）。我選算。
3. 「讀你的」要不要做、先做哪幾個（第 6 節）。
4. 非開啟者的成員要不要看到「有人在連著」（我選不給，B5）；歷史上其他人看到的顯示名稱仍是「你（臨時）」，要換成相對於讀者的字樣得等來賓那批。
6. 次數與位元組的預設與上限（2 萬次、256 MiB；上限 10 萬次、1 GiB；最久 24 小時）是具名常數 `SESSION_LIMITS`，是我選的數字，**沒有量測**；擁有者 2026-11-17 同意先用。

> 第二批之後（[sessions-reads-own-2026-11-17.md](sessions-reads-own-2026-11-17.md)）：「讀你的」做完、工作階段的標記不離開那台、`NO_VALID_PROBE` 由 25 條縮到 15 條、一般登入的本文上限寫進第 6 節；下面第 8、9 節的 25 條與 `it.fails` 描述是當時的狀態。

## 7. 沒驗證的

- 沒有在真的 Postgres 上跑 pgvector（見 PR 說明）；沒有量測 `tagScopeSql` 在大工作區的成本（它只在工作階段的查詢裡，用遞迴子查詢；成員的 SQL 沒有變）。
- 位元組上限、回應大小、並行的「進行中」競爭只用 PGlite（單一連線）的決定性做法測：先把操作者解析好，結束，再用舊的操作者寫（`participantSessions.integration.test.ts`）。
  需要兩條連線才能重現的真實競爭，沒有新增測試（PGlite 跳過清單只准減，不能新增項目）。

## 8. 驗收第 1 輪之後（2026-11-17）

1. **清查的探測力**：每條帶參數的 GET 路由現在探兩次。(a) 用空間 A 裡真的東西：成員與工作階段都得 200 的路由不列；其餘 25 條逐條寫在 `NO_VALID_PROBE`（`sessionLeakInventory.integration.test.ts`，`// ratchet:list sessionProbeNo200`，只准減；一條改成 200 就要拿掉，新路由不是 200 也要寫理由）。理由分四類：擁有者專用（成員也 403）、探測世界沒種那種物件（404）、要另外的查詢參數（400）、回 409（有效但沒東西可做）。(b) 用空間 B 裡真的東西：工作階段得到的狀態與本文必須和「不存在的 id」完全相同（id 遮掉）；這個測試**找到並修掉一個真洩漏**：`/api/spaces/:id/members`、`candidates`、`delete-preview` 對「存在但不是成員」與「不存在」的訊息或狀態不同，工作階段可以用來試探空間 id 是否存在。現在 `assertAuthority` 的 `space` 情況對「完全讀不到的空間」一律回「space not found」（對所有人，只有訊息變了、狀態沒變；`authorityDecisions` 的正規表示式放寬成不含 id），`deletableSpace` 只對工作階段再回 404（成員仍是原本的 403，`spacesMove.integration.test.ts` 釘著）。
2. **工作階段的列會不會被複製**：`participant_sessions` 是只屬於這台的（`syncClasses.json` 的 `node-local`）。工作階段的 `actors` 列與 `space_members` 列**不複製**：`spine/snapshotTables.json` 的 `actors.where` 與 `space_members.where` 排除 `type = 'session'`（測試：快照讀出的頁不含它的 actor id、`participant_sessions` 字樣與工作階段 id；變異檢查：拿掉排除，測試失敗）。別台因此沒有「有成員資格卻沒有 `participant_sessions` 的工作階段」；就算有（資料庫被複製過去），`resolveCurrentActor` 要求 `participant_sessions` 列存在、未結束、未到期，否則 401（測試：刪掉列後用舊的操作者寫入被拒絕；成員清單、名冊、候選人、空間總覽都不含它）。到期後留下的 `space_members` 列同理（不能行動；下一次開啟時清掉；`members()`、`memberCandidates`、`listActors`、`spaceOverview`、`backupArchive` 的成員查詢都排除 `session`）。標記的 `author` 在別台是一個沒有 `actors` 列的 id（`sync_stamps.author` 是 text，沒有外鍵），顯示成沒有名字的作者。讀 `space_members`／`actors` 的地方：`git grep -nE "FROM space_members|JOIN space_members|FROM actors|JOIN actors|selectFrom\(\"(space_members|actors)\"" -- ':!test'`，與名單、人數、通知、`@` 選單有關、會列人的是：`services/spaces.ts members()`、`memberCandidates`、`services/actors.ts listActors`、`services/spaceOverview.ts`（兩處）、`services/backupArchive.ts`（成員表）、`modules/tasks/pushReminders.ts`（只有推播訂閱的人，工作階段不能訂閱）；都已排除或本來就不會有工作階段。**還沒處理、要另一條線決定**：`distributedSync/bridge/{genesis,project,replica,view}.ts` 也讀 `actors` 與 `space_members`（`ONDEN_DISTRIBUTED_SYNC=1` 才跑，預設關）。它們屬於分散式引擎那一條線，我沒有動；開啟那個旗標前要先讓它們排除 `session`。
3. **`spineGate` 那一行能不能不加**：活著與否的檢查是讀（同一個 UPDATE 的 WHERE），但次數上限需要每個請求一次寫。可以省寫的做法（只在跨門檻時寫、在行程內累計再批次寫）都會讓上限變成「大約」，多行程或重啟時超出；我沒做。成本（PGlite，同一台機器上 300 次 `GET /api/spaces` 的平均）：工作階段 3.35 ms／請求，成員 1.88 ms／請求（差約 1.5 ms，含憑證查詢與計數的 UPDATE）。**真 Postgres 沒量**（本機沒有 pgroonga）。我沒有加 `SERVICE_WRITE_HELPERS`。
4. **「讀你的」下一批的形狀**：一個函式（個人資料的主人＝`sessionScope.openedBy`，其他人是自己的 id）、八個讀取點一次改完（偏好 `actorPrefs.readPref`、複習設定 `modules/review/settings.ts`、複習進度 `modules/review/state.ts` 與 `cards.ts`、專注 `modules/tasks/focus.ts`（只讀）、RSS 已讀與靜音 `modules/rss/items.ts`／`mutes.ts`、外部行事曆 `modules/external_calendars/store.ts`）、寫入仍然拒絕（`own_personal`）。已釘 `it.fails`：「a session reads the preferences of the person who opened it」。
5. **決定**：(1) 標籤名稱當探針：對**本人**的工作階段，用按鈕新增遇到看不見的同名標籤，照實回 409「已有這個名稱」；在內文打 `{名稱}` 不是同一條規則：存檔成功、不新增標籤、不附上、也不說名稱存在（測試固定這兩個行為）。**來賓那一批必須重新決定**（對別人不能照實回）。(2) `writesAsPerson` 算人的寫入（同意）。(4) 別的成員看不到「有人連著」（同意）。(5) 存 RSS 文章：整個被拒絕（上面第 3 節已更正）。(6) 具名常數 `SESSION_LIMITS`，數字沒有量測。
6. **憑證在哪些地方**：只認 `Authorization: Bearer` 標頭；放在網址參數（`token`、`authorization`、`access_token`、`credential`）一律被忽略，請求當作匿名（401，有測試）。錯誤回應、被拒絕的本文、`log` 與 `console` 的輸出都不含它（測試：壞本文、404、被拒絕的路由、不存在的路由、超過次數）；事件 payload、`participant_sessions`、`actors.name` 不含它（先前的測試）。
7. **真的並行測試**：`participantSessionsConcurrent.integration.test.ts`（真 Postgres 兩條連線：一條持有工作區鎖，工作階段的寫入排在後面，同一條連線結束工作階段並提交，之後寫入得到 401、筆記與事件日誌不變）。PGlite 上**不註冊**（不是跳過，沒有加跳過清單）；帶 `realPostgresAlso` 標記讓 `npm run test:real-pg` 找得到。**我沒有在真 Postgres 上跑過它**（本機沒有 pgroonga）。
8. **`tagScopeSql` 的成本**（PGlite，三次的中位數）。第一版（每個標籤一個相關子查詢）很貴：10,000 則筆記、300 個標籤：bootstrap 成員 6.1 s、工作階段 17.9 s；`/api/sync/membership` 0.14 s、10.6 s；`/api/tags` 0.12 s、7.6 s。改成兩個「用到的標籤集合」各算一次（非相關子查詢，連同往上的父標籤）後：

| 規模 | 路由 | 成員 | 工作階段 |
| --- | --- | --- | --- |
| 1,000 則 | `/api/bootstrap` | 905 ms（741 KB） | 807 ms（555 KB） |
| 1,000 則 | `/api/sync/membership` | 42 ms（212 KB） | 43 ms（115 KB） |
| 1,000 則 | `/api/tags` | 35 ms（181 KB） | 31 ms（91 KB） |
| 10,000 則 | `/api/bootstrap` | 3,660 ms（3,891 KB） | 3,889 ms（3,820 KB） |
| 10,000 則 | `/api/sync?since=0` | 20 ms | 78 ms |
| 10,000 則 | `/api/sync/membership` | 147 ms（220 KB） | 210 ms（148 KB） |
| 10,000 則 | `/api/tags` | 119 ms（181 KB） | 146 ms（110 KB） |

一半的筆記在 A、一半在 B，300 個標籤輪流套在筆記上。我只量時間與回應大小，沒有逐查詢數「讀幾列」；真 Postgres 沒量。

## 9. 驗收第 2 輪之後（2026-11-17）

1. **別的節點上的工作階段寫入，這個節點的讀取端怎麼辦**（`test/unknownAuthor.integration.test.ts`）。**【查過】** 這個節點收到一個它不認識的操作者 id 時：
   - 事件**進不來**：`domain_events.actor_id` 是 uuid 形狀但不指向任何 actor 時，migration 071 的 `domain_events_actor_ref` 觸發器在 INSERT 就拒絕（`resolves to no actor`）。所以沒有「讀取端遇到不明作者會不會丟錯」的問題，壞的是**收進來**那一步。用 `it.fails("WANTED: an event naming an unknown operator is taken in")` 釘住。修的批次：變更包帶工作階段的顯示名稱（接收端先建 actor 列再收事件），或收進來時用固定的後備 actor；不在本 PR 修。
   - 戳記（`sync_stamps.author`）是純文字，沒有這種檢查：快照讀取帶著不明作者的戳記照常讀完、不丟錯（測試釘著）；歷史、版本、事件列表對這種筆記照常回 200。
2. **`NO_VALID_PROBE` 的 25 條依「填起來要什麼」分組**（測試檔裡同樣分組，由易到難；歸類是看每條路由的程式判斷的，沒有逐條試）：
   | 組 | 條數 | 要做什麼 |
   | --- | --- | --- |
   | 1. 狀態 | 2 | 把世界排成對的狀態（一個有前一版的編輯事件；一篇在垃圾桶的筆記） |
   | 2. 輸入 | 2 | 多帶一個查詢參數 |
   | 3. 種資料 | 6 | 多種一個東西（刪除的筆記、墨跡變更、檢視、媒體檔、複習設定） |
   | 4. 要開模組 | 5 | 先開對應模組（白板、複習、RSS、技能） |
   | 5. 要外部服務 | 1 | 代理工作階段需要執行者／外部 AI 服務 |
   | 6. 不用填 | 9 | 成員也被拒，或設計上對工作階段關閉：拒絕本身就是答案 |

## 10. 驗收第 3 輪之後（2026-11-17）

1. **請求本文先整個讀進記憶體才計量（已修）。** 原本 `app.ts` 對工作階段的寫入 `await c.req.arrayBuffer()` 之後才計位元組：持有效憑證的陌生電腦可以先佔滿伺服器記憶體。現在 `services/participantSessions.ts` 的 `readTemporarySessionBody` 邊讀邊計：
   - **單一請求的本文上限**是 `temporarySessionBodyCap(path)`：`/api/media` 用 `MAX_MEDIA_REQUEST_BYTES`（今天附件上傳接受的最大值，影片 500 MB ＋ 1 MB），其餘用 `MAX_REQUEST_BYTES`（20 MiB）；兩個都是 nginx 對任何人在同一路徑上已有的上限（`docker/nginx/nginx.conf`），工作階段不會拿到比它的人更大的本文。超過回 413 `body_too_large`。
   - 有 `Content-Length` 時先和「單一請求上限」「這個工作階段還剩多少」比，超過就在讀之前拒絕（413／403 `session_limit_reached`）；沒有時串流計數，過了任一個上限的那個區塊就取消讀取，後面的不收。伺服器最多持有「單一請求上限與剩餘額度的較小者」加一個區塊。
   - 計量改成一個條件式 UPDATE（`byte_count + n <= max_bytes`），所以**不再有超出**：舊的「最多超出一個本文」改成「不超出」（並行的請求也不能一起超出）。放不進剩餘額度的請求被拒、不計、不寫。
   - 被拒的請求不服務、不寫任何東西（測試比對筆記標題與 `byte_count`），之後工作階段仍可用。
2. **一般人的登入今天有沒有本文大小上限？** 只在 nginx：`/api/` 是 `client_max_body_size 20m`、`/api/media` 是 501m；後端自己只有 `routes/media.ts` 的 `bodyLimit`。**發現**：直接打到後端（不經 nginx）的一般請求沒有上限，也就是 nginx 以外沒有第二道。不在這個 PR 修；若要，一個放在 `app.ts` 的全站 `bodyLimit`（沿用同一對常數）可以收掉，工作階段的函式就只剩剩餘額度的比對。

## 附錄：每一條 GET 路由與讀取用 POST 的結果

表頭：入口、位置、成員（A 空間）看到的 HTTP 狀態、回傳 B 獨有名字的種類、臨時工作階段（A 空間）看到的狀態。
產生方式：`SESSION_INVENTORY_OUT=<檔案> npx vitest run src/test/sessionLeakInventory.integration.test.ts`（每次執行重新產生；位置欄由腳本從路由檔推出，
website 與 tasks 模組的 9 條在下表手填）。

| 入口 | 位置 | 成員看到的回應 | 回傳 B 空間獨有的名字 | 臨時工作階段看到的回應 |
| --- | --- | --- | --- | --- |
| `GET /api/actors` | `routes/actors.ts:33` | 403 | 否 | 403 |
| `GET /api/actors/:id/stats` | `routes/actors.ts:46` | 403 | 否 | 403 |
| `GET /api/actors/:id/tokens` | `routes/actors.ts:41` | 403 | 否 | 403 |
| `GET /api/agent-sessions` | `routes/agentSessions.ts:43` | 400 | 否 | 400 |
| `GET /api/agent-sessions/:id` | `routes/agentSessions.ts:77` | 404 | 否 | 404 |
| `GET /api/agent-sessions/runners` | `routes/agentSessions.ts:50` | 403 | 否 | 403 |
| `GET /api/ai-suggestions` | `routes/aiSuggestions.ts:27` | 400 | 否 | 400 |
| `GET /api/ai/credentials` | `routes/aiRuntime.ts:34` | 403 | 否 | 403 |
| `GET /api/ai/credentials/:id/models` | `routes/aiRuntime.ts:73` | 403 | 否 | 403 |
| `GET /api/ai/hand-to-ai` | `routes/aiRuntime.ts:175` | 400 | 否 | 400 |
| `GET /api/ai/panel-chat/:nodeId` | `routes/aiPanelChat.ts:21` | 404 | 否 | 404 |
| `GET /api/ai/panel-chat/:nodeId/roles` | `routes/aiPanelChat.ts:17` | 404 | 否 | 404 |
| `GET /api/ai/roles` | `routes/aiRuntime.ts:86` | 403 | 否 | 403 |
| `GET /api/ai/status` | `routes/aiRuntime.ts:29` | 200 | 否 | 200 |
| `GET /api/auth/*` | `app.ts:174` | 200 | 否 | 200 |
| `GET /api/auth/providers` | `app.ts:174` | 200 | 否 | 200 |
| `GET /api/backup/full.zip` | `routes/backup.ts:67` | 200 | 否 | 403 |
| `GET /api/backup/history-size` | `routes/backup.ts:59` | 200 | 否 | 403 |
| `GET /api/backup/restore/:id/preview` | `routes/backup.ts:103` | 400 | 否 | 403 |
| `GET /api/backup/restore/jobs/:job` | `routes/backup.ts:119` | 404 | 否 | 403 |
| `GET /api/backup/restore/limit` | `routes/backup.ts:65` | 200 | 否 | 403 |
| `GET /api/backup/size` | `routes/backup.ts:62` | 200 | 否 | 403 |
| `GET /api/boards/:id` | `routes/boards.ts:69` | 404 | 否 | 404 |
| `GET /api/bootstrap` | `routes/bootstrap.ts:13` | 200 | 標籤名稱、欄位名稱 | 200 |
| `GET /api/canvases` | `routes/canvases.ts:46` | 200 | 否 | 200 |
| `GET /api/canvases/:id` | `routes/canvases.ts:70` | 404 | 否 | 404 |
| `GET /api/day/:date/lens` | `routes/day.ts:15` | 400 | 否 | 400 |
| `GET /api/edges/manifest` | `routes/manifests.ts:12` | 200 | 否 | 200 |
| `GET /api/events` | `routes/events.ts:74` | 200 | 標籤名稱 | 200 |
| `GET /api/events/:event_id/cascade-preview` | `routes/events.ts:113` | 400 | 否 | 400 |
| `GET /api/events/:event_id/preview` | `routes/events.ts:126` | 400 | 否 | 400 |
| `GET /api/export-static` | `modules/website/routes.ts:251` | 403 | 否 | 403 |
| `GET /api/export/markdown.zip` | `routes/export.ts:16` | 200 | 否 | 403 |
| `GET /api/external-calendars` | `modules/external_calendars/routes.ts:36` | 200 | 否 | 403 |
| `GET /api/external-calendars/events` | `modules/external_calendars/routes.ts:83` | 400 | 否 | 403 |
| `GET /api/git/diff/:hash` | `modules/website/routes.ts:168` | 403 | 否 | 403 |
| `GET /api/history/activity` | `routes/history.ts:40` | 200 | 否 | 200 |
| `GET /api/history/at` | `routes/history.ts:135` | 400 | 否 | 400 |
| `GET /api/history/at/:id` | `routes/history.ts:142` | 400 | 否 | 400 |
| `GET /api/history/day` | `routes/history.ts:61` | 200 | 否 | 200 |
| `GET /api/history/day/notes` | `routes/history.ts:74` | 200 | 否 | 200 |
| `GET /api/history/deleted` | `routes/history.ts:91` | 200 | 否 | 200 |
| `GET /api/history/deleted/:id` | `routes/history.ts:100` | 404 | 否 | 404 |
| `GET /api/history/feed` | `routes/history.ts:48` | 200 | 否 | 200 |
| `GET /api/import/sources` | `modules/importers/routes.ts:11` | 200 | 否 | 200 |
| `GET /api/inbox` | `routes/inbox.ts:221` | 200 | 否 | 200 |
| `GET /api/inbox/approvals` | `routes/inbox.ts:68` | 200 | 否 | 200 |
| `GET /api/inbox/failed-effects` | `routes/inbox.ts:148` | 200 | 否 | 200 |
| `GET /api/mcp/sessions/:id` | `routes/mcpSessions.ts:75` | 404 | 否 | 403 |
| `GET /api/mcp/sessions/pending` | `routes/mcpSessions.ts:45` | 200 | 否 | 403 |
| `GET /api/mcp/tools` | `routes/mcp.ts:29` | 200 | 否 | 403 |
| `GET /api/me/prefs/:key` | `routes/me.ts:30` | 404 | 否 | 404 |
| `GET /api/media/:filename` | `routes/media.ts:69` | 404 | 否 | 404 |
| `GET /api/nodes/:id` | `routes/nodes.ts:405` | 404 | 否 | 404 |
| `GET /api/nodes/:id/attributes` | `routes/nodes.ts:490` | 404 | 否 | 404 |
| `GET /api/nodes/:id/block-citations` | `routes/nodes.ts:431` | 200 | 否 | 200 |
| `GET /api/nodes/:id/block-home/:ref` | `routes/nodes.ts:421` | 200 | 否 | 200 |
| `GET /api/nodes/:id/block-link-counts` | `routes/blockLinks.ts:40` | 200 | 否 | 200 |
| `GET /api/nodes/:id/export.html` | `routes/nodes.ts:352` | 404 | 否 | 404 |
| `GET /api/nodes/:id/history` | `routes/nodes.ts:337` | 404 | 否 | 404 |
| `GET /api/nodes/:id/inherited-attributes` | `routes/nodes.ts:508` | 404 | 否 | 404 |
| `GET /api/nodes/:id/ink-change` | `routes/nodes.ts:308` | 404 | 否 | 404 |
| `GET /api/nodes/:id/ink-edits` | `routes/nodes.ts:300` | 404 | 否 | 404 |
| `GET /api/nodes/:id/ink-versions` | `routes/nodes.ts:289` | 404 | 否 | 404 |
| `GET /api/nodes/:id/mentionables` | `routes/nodes.ts:394` | 404 | 否 | 404 |
| `GET /api/nodes/:id/paragraphs` | `routes/nodes.ts:643` | 404 | 否 | 404 |
| `GET /api/nodes/:id/purge-preview` | `routes/nodes.ts:194` | 404 | 否 | 404 |
| `GET /api/nodes/:id/rollup-attributes` | `routes/nodes.ts:500` | 404 | 否 | 404 |
| `GET /api/nodes/:id/versions` | `routes/nodes.ts:272` | 404 | 否 | 404 |
| `GET /api/nodes/:id/views` | `routes/nodes.ts:445` | 404 | 否 | 404 |
| `GET /api/nodes/:id/views/:viewId/exec` | `routes/nodes.ts:470` | 404 | 否 | 404 |
| `GET /api/nodes/search` | `routes/nodes.ts:58` | 200 | 否 | 200 |
| `GET /api/push/key` | `routes/push.ts:31` | 404 | 否 | 404 |
| `POST /api/query` | `routes/query.ts:38` | 400 | 否 | 400 |
| `GET /api/review/:nodeId/state` | `modules/review/routes.ts:125` | 404 | 否 | 404 |
| `GET /api/review/:nodeId/stopped` | `modules/review/routes.ts:131` | 404 | 否 | 404 |
| `GET /api/review/blocks/:blockId/state` | `modules/review/routes.ts:98` | 404 | 否 | 404 |
| `GET /api/review/cards/:nodeId` | `modules/review/routes.ts:109` | 404 | 否 | 404 |
| `GET /api/review/decks` | `modules/review/routes.ts:41` | 200 | 否 | 200 |
| `GET /api/review/groups` | `modules/review/routes.ts:36` | 400 | 否 | 400 |
| `GET /api/review/queue` | `modules/review/routes.ts:30` | 200 | 否 | 200 |
| `GET /api/review/settings/:tagId` | `modules/review/routes.ts:141` | 404 | 否 | 404 |
| `GET /api/review/stats` | `modules/review/routes.ts:51` | 200 | 否 | 200 |
| `GET /api/review/status` | `modules/review/routes.ts:46` | 200 | 否 | 200 |
| `GET /api/rss/items` | `modules/rss/routes.ts:205` | 200 | 否 | 200 |
| `GET /api/rss/items/:id` | `modules/rss/routes.ts:222` | 404 | 否 | 404 |
| `GET /api/rss/items/:id/link` | `modules/rss/routes.ts:235` | 404 | 否 | 404 |
| `GET /api/rss/mutes` | `modules/rss/routes.ts:266` | 200 | 否 | 200 |
| `GET /api/rss/opml` | `modules/rss/routes.ts:349` | 200 | 否 | 200 |
| `GET /api/rss/source-space/preview` | `modules/rss/routes.ts:133` | 403 | 否 | 403 |
| `GET /api/rss/sources` | `modules/rss/routes.ts:196` | 200 | 否 | 200 |
| `GET /api/semantic/search` | `modules/semantic/routes.ts:38` | 200 | 否 | 200 |
| `GET /api/semantic/status` | `modules/semantic/routes.ts:30` | 200 | 否 | 200 |
| `GET /api/site` | `modules/website/routes.ts:189` | 200 | 否 | 200 |
| `GET /api/site/search.idx/*` | `modules/website/routes.ts:219` | 404 | 否 | 404 |
| `GET /api/site/status/:nodeId` | `modules/website/routes.ts:246` | 200 | 否 | 200 |
| `GET /api/site/url/:nodeId` | `modules/website/routes.ts:239` | 200 | 否 | 200 |
| `GET /api/skills` | `routes/skills.ts:13` | 200 | 否 | 200 |
| `GET /api/skills/:id/skill.md` | `routes/skills.ts:24` | 404 | 否 | 404 |
| `GET /api/snapshot` | `routes/stampedSnapshot.ts:29` | 403 | 否 | 403 |
| `GET /api/snapshot/readiness` | `routes/stampedSnapshot.ts:24` | 403 | 否 | 403 |
| `GET /api/snapshots` | `modules/website/routes.ts:181` | 403 | 否 | 403 |
| `GET /api/spaces` | `routes/spaces.ts:24` | 200 | 否 | 200 |
| `GET /api/spaces/:id/candidates` | `routes/spaces.ts:123` | 403 | 否 | 403 |
| `GET /api/spaces/:id/delete-preview` | `routes/spaces.ts:85` | 403 | 否 | 403 |
| `GET /api/spaces/:id/members` | `routes/spaces.ts:114` | 403 | 否 | 403 |
| `GET /api/spaces/move-preview` | `routes/spaces.ts:146` | 400 | 否 | 400 |
| `GET /api/spaces/overview` | `routes/spaces.ts:33` | 403 | 否 | 403 |
| `GET /api/spaces/sessions` | `routes/spaces.ts:59` | 200 | 否 | 403 |
| `GET /api/sync` | `routes/sync.ts:28` | 200 | 標籤名稱、欄位名稱 | 200 |
| `POST /api/sync` | `routes/sync.ts:38` | 200 | 標籤名稱、欄位名稱 | 200 |
| `GET /api/sync/drawings` | `routes/sync.ts:98` | 200 | 否 | 200 |
| `GET /api/sync/membership` | `routes/sync.ts:56` | 200 | 標籤名稱、欄位名稱 | 200 |
| `GET /api/sync/membership/digest` | `routes/sync.ts:72` | 200 | 標籤名稱、欄位名稱 | 200 |
| `GET /api/tags` | `routes/tags.ts:118` | 200 | 標籤名稱、欄位名稱 | 200 |
| `GET /api/tags/:id` | `routes/tags.ts:144` | 200 | 標籤名稱、欄位名稱 | 404 |
| `GET /api/tags/:id/export` | `routes/tags.ts:130` | 200 | 標籤名稱、欄位名稱 | 404 |
| `GET /api/tags/:sourceId/merge-preview` | `routes/tags.ts:319` | 400 | 否 | 400 |
| `GET /api/tags/:tagId/blocks` | `routes/tags.ts:276` | 200 | 否 | 404 |
| `GET /api/tags/:tagId/delete-preview` | `routes/tags.ts:344` | 200 | 標籤名稱 | 404 |
| `GET /api/tags/:tagId/descendants` | `routes/tags.ts:262` | 200 | 否 | 404 |
| `GET /api/tags/:tagId/path` | `routes/tags.ts:250` | 200 | 標籤名稱 | 404 |
| `GET /api/tags/:tagId/views` | `routes/tags.ts:284` | 200 | 否 | 404 |
| `GET /api/tags/:tagId/views/:viewId/exec` | `routes/tags.ts:304` | 404 | 否 | 404 |
| `GET /api/tags/tree` | `routes/tags.ts:63` | 200 | 標籤名稱 | 200 |
| `GET /api/tasks/agenda` | `modules/tasks/routes.ts:43` | 200 | 否 | 200 |
| `GET /api/tasks/focus` | `modules/tasks/routes.ts:53` | 200 | 否 | 200 |
| `GET /api/versions/recent` | `routes/versions.ts:15` | 200 | 否 | 200 |
| `GET /api/workspace/config` | `routes/workspace.ts:63` | 200 | 否 | 403 |
| `GET /health` | `app.ts:330` | 200 | 否 | 200 |

