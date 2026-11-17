# AI 動作對照盤點：畫面上做得到、工具做不到的事

> 狀態：歷史紀錄（研究；寫於 2026-11-15）。只讀程式碼的盤點，沒有改任何產品程式、沒有跑測試或執行驗證；
> 每個判斷附檔案與函式，沒看到的寫「未確認」。證據範圍是 2026-11-14 的 `origin/main`（`dc25ac35`）。
> 2026-11-16 更新：#1697 已修掉三處（`queryView` 改呼叫 `executeTagView`、`createEdge` 的目標可讀檢查搬進服務、`createNode` 寫發布旗標要求是人）；下文相關列已改成現況，其餘各節仍是 11-14 的證據。

## 1. 一句話結論

業主的看法成立，而且比預期乾淨：**底層服務大多已經有權限、事件、交易，缺的是工具**。
AI 的整個能力＝ `services/agentTools/registry.ts` 登記的 22 個工具（bearer token 被 `app.ts` 限在 `/api/mcp/*`，碰不到其他路由）。
使用者在畫面做得到、工具沒有的動作，絕大多數底層函式已在、權限已寫在服務裡（不是在路由或畫面），補工具多半是「小」。

真正「邏輯只在前端」的只有四塊，它們才是會同時卡住 AI、同步與匯入的底層缺口：

1. **排序與搬移的計算**：`planSiblingOrder`（`frontend/src/lib/childOrder.ts`）算出要改哪幾列的 `sort_order`，再逐筆 PATCH；後端只收原始整數。
2. **白板排版**：`arrangedSlot`、`APPEND_GRID`、`SPAWN_GAP_X`、`alignCanvasCards`（`frontend/src/lib/cardGeometry.ts`、`canvasAlignment.ts`）；後端只收 x/y（`boardWrites.applyBoardChanges`）。
3. **PDF 文字**：只在瀏覽器用 pdfjs 抽出（`frontend/src/lib/pdf/extractText.ts`），寫進內文時不帶頁碼、截在 6 萬字。
4. **「AI 提議、使用者接受」只有一種形狀**：針對一則既有筆記的文字／標題修改與留言（`services/aiSuggestions.ts` 的 `SuggestionItemKind`）；其他種類的提議只有 `proposeTagPack` 這條擁有者核准的 outbox 路。

## 2. 方法與限制

- AI 這一側：讀 `services/agentTools/`、各模組的 `agentTools`（`modules/*/index.ts`）、`routes/mcp*.ts`、`spine/toolScope.ts`、`app.ts` 的 token 限制。
- 使用者這一側：列舉 `routes/*.ts` 與 `modules/*/routes.ts` 的寫入路由（POST／PUT／PATCH／DELETE），以及 `frontend/src/lib/data/` 的寫入入口檔名。**前端這側只確認了入口存在與命名，沒有逐一讀每個畫面元件怎麼呼叫。**
- 權限：看每個領域服務傳給 `mutate()` 的 `authority`（`spine/authority.ts`）與路由層另外的檢查。
- 同步：對照 `spine/syncClasses.json`（哪些表「已標記」「已接線」）與 `docs/architecture/proposals/causal-stamps-2026-11-12.md` 第 8 節進度。
- **沒做**：沒跑任何測試、沒實際呼叫工具、沒開瀏覽器。標「未確認」的是靠讀程式推得但沒執行的。

## 3. AI 現在有的工具（共 22 個）

通用登記處 `services/agentTools/registry.ts`；MCP（`routes/mcpProtocol.ts` 的 `tools/list`）與 API 跑法（`services/agentRuntime/api/tools.ts` 的 `toolsForRuntime`）**同一份**，呼叫同一個 `callTool`。
API 跑法額外不給 `proposeTagPack`（`NOT_FOR_API`）。token 只有 `read`／`write` 兩級（`templates.ts`）。

| 工具 | 來源 | 讀／寫 | 能做什麼 | 「建議 → 接受」？ | 權限怎麼擋 |
|---|---|---|---|---|---|
| `searchNodes` | core | 讀 | 全文／`#標籤`／屬性搜尋，回標題與片段 | — | `nodeSearch` 把讀取範圍放進 SQL |
| `getNode` | core | 讀 | 一則筆記：內文、標籤、屬性、附件清單（不含手寫筆跡、PDF 標記） | — | `readableNote`（讀不到＝回 null） |
| `getAttachment` | core | 讀 | 內文引用的圖片；其他檔案只回中繼資料 | — | 讀得到該筆記＋`canReadMedia` |
| `listChildren` | core | 讀 | 某筆記或空間頂層的子筆記 | — | `readableAmong` |
| `listSpaces` | core | 讀 | 可讀的空間與自己的權限（view／suggest／edit） | — | 只列可讀空間 |
| `listSuggestions` | core | 讀 | 自己提的建議各處的結果 | — | 讀得到該筆記 |
| `queryView` | core | 讀 | 執行「標籤檢視」，回列 | — | 與畫面同一個 `executeTagView`（#1697 後） |
| `loadSkill` | core | 讀 | 載入一個技能的全文 | — | `skillForAi`＋外部 AI 開關 |
| `listMySessions`／`getSessionLog` | core | 讀 | 自己過去的工作階段後設資料 | — | 只看自己的 session |
| `semanticSearch`／`suggestLinks` | `semantic` 模組 | 讀 | 語意相近的筆記、連結建議 | — | 模組開關＋讀取範圍 |
| `reviewQueue` | `review` 模組 | 讀 | 今天要複習的卡 | — | `readableScopeSql` |
| `getSlides` | `slides` 模組 | 讀 | 把筆記當簡報讀：每頁與版型 | — | `readableNote` |
| `createNode` | core | 寫 | 建立筆記（可帶標籤、屬性、父層、空間） | 直接生效；`suggest` 模式被擋 | `createNote` 在事件鎖內重驗 |
| `updateNode` | core | 寫 | 改標題／內文（三方合併，衝突回 `conflicts`） | **`suggest` 模式自動轉成建議** | `nodeUpdate.updateNode`（與 REST PATCH 同一個） |
| `suggestEdit` | core | 寫 | 同 `updateNode` 參數，但一律只存建議 | **是** | `assertAuthority(write_node)` |
| `commentOnNote` | core | 寫 | 在筆記（可指定段落）留言，不改文字 | 是（存成建議的一種項目） | 同上 |
| `applyTag`／`removeTag` | core | 寫 | 套用／移除標籤 | 直接生效；`suggest` 被擋 | `tagMembershipWrites`（與 REST 同一個） |
| `proposeTagPack` | core | 寫 | 提議一個標籤包（欄位、行為、範本子項） | **是：outbox `pending_approval`，擁有者在收件匣核准才安裝** | 工具端先驗格式；安裝時擁有者權限 |
| `setSlideLayout` | `slides` 模組 | 寫 | 設簡報某頁版型／整份主題 | 直接生效；`suggest` 被明確拒絕 | `assertWriteModeAllows`＋`set_attribute` |

**邊界有四層**（不是只靠工具清單）：

1. `app.ts`：bearer token 只能打 `/api/mcp/*`，其他路由一律 403 `token_scope`。
2. 工具授權：`spine/toolScope.ts` 的 `assertToolAllowed`（token 發行時展開的 `allowed_tools`；之後新增的工具不會自動給舊 token）＋速率限制，拒絕也留稽核事件。
3. `write_mode = suggest`：`spine/toolScope.ts` 的 `assertWriteModeAllows` 在 `mutate()` 裡擋掉除了「提建議」以外的所有事件，不靠工具清單隱藏。API 跑法永遠是 suggest（`decisions-ai-collaboration.md`）。
4. 領域 `authority`：`spine/authority.ts`。`space`、`principal_admin`、`review` 三種**結構上不收 token**（程式裡寫明「token 只能提議，不能直接做」）。

## 4. 使用者動作對照（四類）

圖例：**①** AI 能做、和使用者同一個底層入口；**②** AI 能做但走另一條路；**③** 刻意不給 AI（附出處；「未寫下來」＝看起來是刻意但找不到明文）；**④** 做不到、看不出是刻意。

### 4.1 筆記

| 動作 | 使用者入口 → 底層 | AI | 類 | 證據與說明 |
|---|---|---|---|---|
| 建立 | `POST /api/nodes` → `noteCreate.createNote` | `createNode` | ① | 工具檔頭寫「同一個 createNote」 |
| 改內文、改標題 | `PATCH /api/nodes/:id` → `nodeUpdate.updateNode` | `updateNode` | ① | 同一個函式，`source:"agent"` 只影響稽核欄位 |
| 搬到別的父層、改排序、顯示／隱藏 | 同上 PATCH 帶 `parent_id`／`sort_order`／`hidden`（前端 `lib/data/noteStructure.ts` 的 `reorderChildren`、`appendChild`） | 無 | **④** | `nodeUpdate.updateNode` 已支援這三欄，但工具的 `EditArgs`（`agentTools/editArgs.ts`）只開 `title`／`markdown`。排序值由前端 `planSiblingOrder` 算（見 §5.1） |
| 換空間 | `POST /api/spaces/move` → `spaces.moveToSpace` | 無 | ③（程式內明寫） | `authority: space` 不收 token，錯誤訊息寫「請改用提議」；**但沒有任何「提議搬空間」的工具**（見 §6） |
| 刪除、還原（垃圾桶） | `DELETE /api/nodes/:id`、`POST …/undelete` → `nodeTrash.trashNode`／`undeleteNode` | 無 | ③（未寫下來） | `createNode` 的註解說「建立可逆，所以不用核准」，但沒有任何文件說明為什麼不給刪除。找過：`agent-delegation.md`、`decisions-ai-collaboration.md` |
| 永久刪除 | `POST /api/nodes/:id/purge` | 無 | ③（未寫下來） | 需空間管理者；`restoreContract` 把 purge 標為「不可逆」 |
| 回到某個版本 | `POST /api/nodes/:id/versions/:versionId/restore` → `restoreNodeVersion` | 無 | ③（未寫下來） | 擁有者可整組還原 AI session（`agentSessions.revertSession`），單篇版本還原沒有給 AI |
| 複製、升級成獨立筆記、段落拆成子筆記 | `noteDuplicate`、`nodePromote`、`blockChildNote`（路由在 `routes/nodes.ts`） | 無 | ④ | 服務都有 `authority: node/write_node`；低優先 |
| 標題上方的視角分頁、筆記層級檢視 | `routes/nodes.ts` 的 `/:id/views` → `noteViews` | 無 | ④ | `queryView` 只認標籤檢視（見 §4.5） |
| 搜尋 | 前端 `reads.notes.search`（伺服器優先、離線退回本機、錯字容忍） | `searchNodes`、`semanticSearch` | ②（輕微） | 伺服器端同一個 `nodeSearch`；離線與錯字容忍只在前端，對 AI 無意義 |
| 匯出單篇 | `POST /api/nodes/:id/export-preview` | 無 | ④（低） | AI 已能讀內文，優先度低 |

### 4.2 標籤、屬性、任務、複習

| 動作 | 使用者入口 → 底層 | AI | 類 | 證據與說明 |
|---|---|---|---|---|
| 套用／移除標籤 | `PUT／DELETE /api/nodes/:id/tags/:tagId` → `tagMembershipWrites` | `applyTag`／`removeTag` | ① | 同一個 `applyTagToNode`／`removeTagFromNode` |
| 建立標籤 | `POST /api/tags` → `tagHierarchy.createTag`（authority `any_space_write`） | 只有 `proposeTagPack` | ③（有明文） | `proposeTagPack.ts` 檔頭：「AI 起草能力、人類授予」；`decisions-ai-collaboration.md` |
| 改名、欄位（schema）、功能、擴充、合併、模組 | `routes/tags.ts` → `tagIdentity`、`tagWrites`、`functionRefs`、`tagMerge`（authority `principal_admin`） | 無 | ③（有明文） | `spine/authority.ts` `principal_admin` 註解：能改定義的 agent 可以越權 |
| 設定或刪除某一個屬性（含表格儲存格） | `PUT／DELETE /api/nodes/:id/attributes/:key` → `attributeWrites.setNodeAttribute`／`recordAttributeChange`（authority `set_attribute`） | 只有 `createNode` 的 `attributes`（建立當下）與 `setSlideLayout` | **④** | 沒有「對既有筆記設屬性」的工具。服務在、權限在服務裡 |
| 建立任務（筆記內一行） | 內文寫 `- [ ] … {task}` → `blockNodes.syncBlockNodes` → `modules/tasks/blockTasks.ts` → `updateTask` | `updateNode` 改內文 | ②（隱性） | 儲存時伺服器同步出任務節點；AI 靠改內文間接做到（未實跑確認） |
| 勾掉任務 | `PATCH /api/tasks/:id`（前端 `taskWriter.patch`） | 改內文的 `- [x]` | ②（隱性） | `blockTasks.ts` 檔頭：勾框＝完成任務、重複任務會產生下一次。**沒有明文說 AI 可以／不可以勾**（未寫下來） |
| 建立獨立任務、排進某天、延期、截止、重複、提醒、專注 | `modules/tasks/routes.ts` → `create.ts`、`update.ts`、`placement.ts`、`focus.ts` | 無 | **④** | 這些都是屬性（`_task_*`），AI 沒有設屬性的工具，也看不到議程（無 `taskAgenda` 讀取工具） |
| 看今天要做的任務（議程） | `GET /api/tasks/agenda`（`modules/tasks/routes.ts` → `taskAgenda`） | 無 | ④ | 純讀；補工具小 |
| 讀複習佇列 | `review.queue` | `reviewQueue` | ① | 同一個 `queue`／`deck`（`reviewQueueTool.ts`） |
| 評分、復原評分 | `POST /api/review/:nodeId/grade` | 無 | ③（有明文） | `reviewQueueTool.ts` 檔頭：AI 給自己評分沒有意義，排程模擬的是人的記憶 |
| 整篇筆記設為複習卡 | `PUT／DELETE /api/review/cards/:nodeId` → `cards.setNoteCard`（function_ref、事件、需編輯權） | 無 | **④** | 服務自帶權限與事件。段落卡可用 `{review}` 寫進內文（②）。注意：`proposeTagPack` 與 `reviewQueueTool` 的描述仍說「標籤讓筆記成為卡」，但 `cards.ts` 說標籤不再建卡（migration 195）——描述過時 |
| 複習設定 | `/api/review/settings/:tagId` | 無 | ③（個人設定） | 個人資料（`mutatePersonal`），非共用內容 |

### 4.3 檢視、表格、白板、手寫、PDF

| 動作 | 使用者入口 → 底層 | AI | 類 | 證據與說明 |
|---|---|---|---|---|
| 執行標籤檢視 | `GET /api/tags/:tagId/views/:viewId/exec` → `tagViews.executeTagView` | `queryView` | **①**（#1697 後） | 工具直接呼叫 `executeTagView`（`queryView.ts`），與畫面同一個入口；原本是各寫一份的兩條路，已收斂 |
| 建立、改、刪檢視 | `routes/tags.ts` `/views`（`principal_admin`）、`routes/nodes.ts` `/views`（筆記） | 無 | 標籤檢視 ③（同標籤定義）；筆記檢視 ④ | 筆記檢視的服務 `noteViews` authority 是 `write_node`，不需擁有者 |
| 白板：建立白板 | `POST /api/canvases` → `createNote` | `createNode`（建立一則筆記，但沒有「是白板」的設定） | **④** | 未確認白板的建立需要哪些屬性（`whiteboardNote.ts`、`canvasNodes`）；工具端沒有任何白板語意 |
| 白板：放卡片、移動、改大小、折疊、分組框 | `PATCH /api/boards/:id` → `boardWrites.applyBoardChanges`（`write_node`；標籤白板 `any_space_write`） | 無 | **④** | 服務可直接用；**AI 也讀不到版面**（`getNode` 不回位置；分組框在 `_canvas_sections` 屬性 JSON，讀得到但沒說明格式） |
| 白板：連線 | `POST /api/edges` → `edgeWrites.createEdge`（來源筆記 `write_node`） | 無 | **④** | 「目標筆記可讀」檢查已在服務內（`edgeWrites.createEdge`，#1697 後），工具可直接包這個服務 |
| 白板：自動排版、對齊 | 前端 `tidyActiveCanvas`、`arrangedSlot`、`alignCanvasCards` | 無 | **④（邏輯只在前端）** | 三欄格狀，不看分組、不看連線；後端沒有任何排版函式 |
| 全域圖譜位置 | `PUT /api/nodes/:id/position` → `boardWrites.moveGraphPosition` | 無 | ④（低） | 已記 `GRAPH_POSITION_UPDATED` 事件 |
| 手寫（筆跡）、白板筆層、PDF 標記 | 前端 `inkWriter`、`pageLayerWriter` → 屬性寫入 | 無 | ③（程式內有理由） | `getNode.ts` 描述：這些是數 MB 的筆跡 JSON，沒有工具讀或改 |
| PDF 全文 | 前端上傳時 `extractPdfText` 寫進內文 | `getNode` 讀得到內文 | ② | 沒有頁碼、截 6 萬字、**只有瀏覽器上傳才有**（見 §5.1） |

### 4.4 引用、技能、發布、空間、收件匣

| 動作 | 使用者入口 → 底層 | AI | 類 | 證據與說明 |
|---|---|---|---|---|
| 引用一個段落（`[[筆記/開頭]]`、`^id`） | `POST /api/nodes/:id/block-links` → `blockLinks.createBlockLink`（來源筆記需寫入權；目標無錨點時需寫入權才能建立） | 無（可手寫 `[[筆記#^id]]`） | ②／**④** | AI 讀得到已有的 `^id`（在內文裡），但**沒有工具取得或建立任意段落的穩定身分**，見 §5.1 |
| 重新指定遺失的段落錨點 | `POST …/paragraphs/:blockId/reassign` | 無 | ③（人判斷） | `blockAnchors` 設計是「不猜」，需要人看 |
| 「當成技能」、給 AI 用、套用到哪些標籤 | 前端 `modules/skills/changeSkill.ts` 改內文 frontmatter；「當成技能」＝加內部標籤 | `updateNode` 改 frontmatter、`applyTag` | ①（讀程式推得可行，未實跑） | `decisions-ai-collaboration.md` 第 158 行明寫：**「AI 不能自己新增或修改技能」**（刻意）。實作上沒有擋：技能的內部標籤不是設定標籤（`spine/reservedNodes.ts` 的 `CONFIG_TAG_SQL` 只涵蓋 workspace-config），`applyTag` 的標籤權限只要求能讀該定義（`spine/authority.ts` 的 `tag` 一節），所以有該筆記寫入權的 token 只要知道標籤 id（讀任何一則技能筆記的 `getNode` 標籤清單就拿得到）即可套用；frontmatter 的 `ai` 預設開，AI 寫的技能會進 `<available_skills>`。文件與實作不一致，需業主決定要擋（例如對 token 拒絕模組內部標籤）還是改文件 |
| 按下「發布」、網站設定 | `modules/website/routes.ts`（`principal_admin`） | 無 | ③（有明文） | `agent-delegation.md`：「代理沒有『發布網站』的工具」；`principal_admin` 結構性擋 token。標記某篇「發布／不發布」本身是屬性，歸入 §4.2 的屬性缺口 |
| 空間：建立、改名、成員、刪除 | `routes/spaces.ts` → `services/spaces.ts`（`space`／`principal_admin`） | 無 | ③（有明文，但沒有提議管道） | `authority.ts`：「agents only propose space moves and membership changes」，**而提議的工具不存在** |
| 收件匣：接受／拒絕 AI 建議 | `POST /api/ai-suggestions/:id/accept`、`/api/inbox/*` | 無 | ③（有明文） | `authority.ts` `review`：AI 自己核准自己的事會讓審核失去意義；路由 `requirePerson` |
| 工作區設定、模組、擁有者轉移 | `routes/workspace.ts` | 無 | ③（結構性） | `principal_admin` |

### 4.5 外部來源、備份、匯入

| 動作 | AI | 類 | 證據 |
|---|---|---|---|
| RSS 訂閱、稍後讀、行事曆訂閱 | 無 | ③（有明文） | `modules/rss/index.ts`、`modules/external_calendars/index.ts` 檔頭：「訂閱是人的行為，沒有 agent 工具」 |
| 備份、還原、Obsidian 匯入、收集箱、書籤、媒體上傳 | 無 | ③（未寫下來） | `routes/backup.ts` `requirePerson`；匯入／書籤／上傳為路由層檢查。token 本來也進不去 `/api/*`（`app.ts`） |
| 看歷史、復原某個事件、回到某一天 | 無 | ③（未寫下來） | `routes/events.ts`、`routes/history.ts`；AI 只有「擁有者復原整個 AI session」（`agentSessions.revertSession`） |

## 5. 三個專題

### 5.1 出處指得到嗎

| 種類 | 有沒有穩定身分 | 可被引用並跳過去？ | AI 讀取時拿得到嗎 |
|---|---|---|---|
| 筆記整篇 | 有：節點 id | 是 | 是 |
| 筆記段落 | **只有被「升級」的段落**才有：`^id`＋`block_anchors`（被連結、有標籤、是任務、被引用）。其他段落沒有身分（`block-nodes.md` 的「選擇性升級」） | 有 `^id` 的可以（`[[筆記#^id]]`）；錨點遺失會標 lost | 內文若已有 `^id` 就看得到；**沒有工具可「取得／建立某一段的身分」**。建立錨點需要目標筆記的寫入權（`blockLinks.createBlockLink`），唯讀筆記的未升級段落建不出來 |
| PDF 頁 | 手寫頁鍵 `pdf:N`（`inkPages.ts`），屬於筆跡資料 | 畫面可以；文字出處的「PDF 劃線」文件上寫**尚未做**（`excerpts.md` 的「之後」） | **否**：PDF 文字進內文時沒有頁碼標記（`extractText.ts` 的 `joinPages` 只用空行接），且最多 6 萬字；AI 不讀 PDF 標記 |
| 手寫區域 | 有：嵌入語法 `![[筆記\|ink=頁@x,y,w,h]]`（`markdown/src/inkRegion.ts`；頁鍵穩定、座標是頁內單位）。檔頭寫「之後可變成錨點」，**目前不是錨點** | 畫面可以 | 內文看得到那串文字，**看不到筆跡內容** |
| 白板卡片 | 卡片＝筆記，身分是節點 id；位置在 `node_positions` | 是（筆記） | 筆記是；版面不是（`getNode` 不回位置） |
| 白板分組框 | 有 id（`_canvas_sections` 內的分組 id） | 畫面可以 | 以屬性 JSON 形式可見，沒有說明 |
| 表格的列 | 列＝筆記，身分是節點 id；儲存格＝屬性（鍵） | 是 | 是；`queryView` 回列，但沒有保證回屬性鍵以外的身分資訊（未確認） |
| 任務 | 任務節點 id；筆記內任務行另有 `^id`（`block_nodes.task_id`） | 是 | 任務節點被工具排除在 `listChildren` 之外；經由 `getNode` 內文可見行 |
| 複習卡 | 筆記 id 或段落 id（前端 `cardKey.ts`；`/api/review/blocks/:blockId`） | 是 | `reviewQueue` 回 `node_id`；段落卡未確認是否回段落 id |
| RSS／網頁摘錄 | `^id`＋原文網址＋Text Fragment（`excerpt.ts`） | 外部網址可跳；站內是 `^id` | 是（在內文裡） |

目前已有的出處機制：**AI 面板對話**的 `ChatSource`（`services/panelChat.ts`）——只列 session 紀錄裡「讀過」的筆記，回答裡的 `[[標題#^區塊id]]` 只有該筆記真的讀過、真的有該區塊 id 才附上，否則只列筆記（`decisions-ai-collaboration.md`「出處」）。
這是**筆記層級**的出處（最多附一個區塊），不是「每句一個出處」。

### 5.2 能不能撤回

「接受」本身（`AI_SUGGESTION_ACCEPTED`）是決定紀錄；真正改內容的是接受時呼叫的 `updateNode`（`aiSuggestions.acceptSuggestionItems`），所以能不能撤回看**那次寫入**的事件種類（`services/restoreContract.ts` 的可復原清單）。

| AI 造成的改動 | 事件 | 能用歷史復原？ |
|---|---|---|
| 接受文字／標題建議 | `NODE_UPDATED` | 能（`restoreNodeUpdated`，保留後續編輯衝突判斷） |
| `updateNode`（直接寫） | `NODE_UPDATED` | 能 |
| `createNode` | `NODE_CREATED` | 能（還原＝丟進垃圾桶） |
| `applyTag`／`removeTag` | `TAG_APPLIED`／`TAG_REMOVED` | 能（`tagMembership` 的註冊處理器） |
| `setSlideLayout` | `ATTRIBUTE_SET`／`ATTRIBUTE_DELETED` | 能 |
| 標籤包核准安裝 | `TAG_IMPORTED` 等 | **未確認**：`TAG_IMPORTED` 不在內建或註冊的復原清單裡，看起來是 `unsupported` |
| 留言、建議本身 | `AI_SUGGESTION_CREATED` | 不適用（沒改內容）；被拒絕即結束 |
| 整個 AI session | — | 擁有者可用 `revertSession`／`history/agentRunUndo`；不能復原的事件會列在 `skipped` |
| **將來**：白板版面、連線、指標、檢視、空間 | `CANVAS_UPDATED`、`EDGE_CREATED`、`POINTER_CREATED`、`COLLECTION_VIEW_*`、`SPACE_*` | **不能**：不在可復原清單，回 `unsupported` |

換句話說：現有工具的改動全部可復原；**一旦補上白板、連線、檢視工具，這些改動目前沒有逆向操作**（「回到某一天」有 `structure_log` 的計畫，但那是各節點自己的歷史，且 `causal-stamps` 第 8.5 節說基準之前的日子還原不了）。

### 5.3 權限在哪裡擋

結論：**寫入權限都在底層服務／`mutate()`，不是在路由或畫面**。`kind: "open"` 在 2026-11-16 的 main 只有 6 處（不含 `authority.ts` 自身），每處都寫了 `why`（`actors.ts`、`fieldDefaults.ts`、`tagMembershipWrites.ts`、`templateExpander.ts`、`mutate.ts`；`tagDispatcher.ts` 已不存在），都是跟著已授權的操作走。

| 寫入 | 權限在哪 | 備註 |
|---|---|---|
| 建立／改筆記、標籤套用、屬性、邊、指標、白板、任務、複習卡、空間 | 服務傳給 `mutate()` 的 `authority`，事件鎖內重讀操作者（`resolveCurrentActor`） | 與入口無關 |
| 刪除／還原／永久刪除 | `nodeTrash`（`delete_node`） | |
| 收件匣核准／拒絕 | `eventReview`（`review`）；路由另用 `requirePerson` | 雙層 |
| 備份、外部行事曆 | **只在路由**（`requirePerson`） | 因為 token 本來進不去 `/api/*`，目前安全；若將來提供工具，必須先把檢查搬進服務 |
| 建立連線的「目標可讀」檢查 | 已在服務（`edgeWrites.createEdge`，#1697） | 原本只在路由，已搬 |
| 媒體上傳 | 路由層 `canWriteSomewhere`，不經 `mutate`（註解自述 off-spine） | 同上 |
| 只靠畫面不顯示來擋的地方 | **沒找到**。畫面上的 `can_review`、`actor_is_owner` 來自伺服器（`services/sync/bootstrap.ts`），只是顯示用，伺服器端仍各自判斷 | 未逐一檢查所有前端旗標 |

## 6. 兩個即將要做的功能會撞到什麼

### (a) 對標籤、空間或選取的幾則筆記發問，答案每句標出處

AI 面板對話已經有「範圍」與「筆記層級出處」（`panelChat.ts`、harness `gatherNodes`）。要做到**每句**標出處會撞到：

| 缺口 | 說明 | 類型 |
|---|---|---|
| 空間不能當範圍 | 面板範圍只收筆記與標籤，且必須同一個空間、整次最多 20 則（`decisions-ai-collaboration.md`「範圍」）；MCP／API 工具沒有「讀一整個空間／標籤」的批次工具，只能 `searchNodes` → 逐則 `getNode`（受速率限制） | AI |
| 檢索結果沒有段落身分 | `searchNodes`、`semanticSearch` 只回筆記層級；`searchNodes` 的片段只有偏移範圍，沒有 `^id` | AI |
| 大多數段落沒有穩定身分 | 見 §5.1：沒有升級的段落沒有 `^id`；為唯讀筆記建立錨點不被允許（`createBlockLink` 需寫入權） | AI／引用 |
| PDF、手寫 | PDF 沒有頁碼、手寫沒有文字，答案無法標到頁或區域 | AI |
| 驗證「標的真的有這句」 | 現在只驗證區塊 id 存在（`noteHoldsBlock`），不驗證引用的句子是否真出自該段 | AI |
| 同步 | 出處是讀取結果，不寫入；錨點本身（`block_anchors`）已是「已標記、未接線」（`syncClasses.json`） | 同步（間接） |

### (b) AI 建議一張心智圖，接受後建立白板（卡片、連線、分組框、自動排版）

| 缺口 | 說明 | 類型 |
|---|---|---|
| 提議形狀只有文字修改 | `ai_edit_suggestion_items` 的種類只有 replace／insert／delete／title／comment，掛在一則既有筆記上。「建立一堆筆記＋白板＋連線」沒有地方放 | AI |
| `suggest` 模式下什麼都建不了 | `assertWriteModeAllows`：只允許 `AI_SUGGESTION_CREATED`；API 跑法永遠是 suggest，所以 `createNode` 會被擋（`commentOnNote` 的註解就是用來「說明做不到的事」） | AI |
| 已有的另一條路 | outbox 的 `pending_approval`（`proposeTagPack`、`outbox.ts` 的 held 機制）：先存請求、擁有者核准才執行。可擴成「白板提案」，但那是**擁有者**核准，不是筆記的編輯者 | AI |
| 沒有白板寫入工具 | 沒有「建立白板」「放卡片」「連線」「分組框」工具；服務都在（`createNote`、`boardWrites.applyBoardChanges`、`edgeWrites.createEdge`）。連線是全域的 `knowledge_link` 邊，不是白板專屬，接受時需一併決定 | AI |
| 排版邏輯在前端 | `arrangedSlot`（三欄格狀）不看連線與分組；沒有任何樹狀／放射排版。AI 要嘛自己算座標（會不一致），要嘛需要把排版搬到 `@onden/markdown` 共用 | AI／同步 |
| 不可復原 | `CANVAS_UPDATED`、`EDGE_CREATED` 不在可復原清單（§5.2）；一鍵接受後想撤，只能逐項處理 | AI |
| 同步 | 白板卡片位置（`node_positions`）、手動邊、筆記都已「已標記、已接線」；分組框在 `_canvas_sections`（已接線）。**同步面沒有額外缺口**，缺的是統一的「一次交易建立整張白板」入口 | 同步（無） |

## 7. 影響同步的缺口

AI 與同步共用同一個理由：寫入是否走統一入口、有沒有來源標記（`spine/syncClasses.json`）。目前：

- 已標記且已接線：筆記、屬性、標籤、手動邊、指標、卡片位置、空間、成員、工作區設定。上面 AI 缺口所對應的服務**同步面都沒問題**。
- **已標記但尚未接線**（意即資料表還沒有每列的來源標記）：`function_refs`（已存檢視、任務設定、複習卡、技能功能都在這張表）、`block_anchors`、`block_link_bindings`、`focus_sessions`、`review_states`、`actor_prefs`、`rss_seen`、`ai_edit_suggestions`／`_items`。`causal-stamps` 第 8 節已記錄 `function_refs` 沒有指派階段。
- **尚未分類**（`undecided`）：`board_copy_folds`、`board_copy_unparents`、`board_ink_moves`、`canvas_note_conversions`（都與白板有關）、`agent_runners`、`agent_tokens`、`ai_suggestions`、`member_removals` 等。
- 前端獨有的邏輯會影響「裝置對裝置」：排序規劃（`planSiblingOrder`）只在前端，兩個節點直接合併時沒有共同的規則可套；PDF 文字抽取只在瀏覽器，另一個節點上傳的 PDF 沒有文字。

## 8. 建議優先順序（最多 12 項）

「大小」是工具補上去的粗估，不含測試與介面。★＝會撞到 (a)；◆＝會撞到 (b)。

| # | 缺口 | 影響 | 大小 | 建議做法（一句） |
|---|---|---|---|---|
| 1 | 提議只能是文字修改 ◆ | AI | 大 | 把 outbox 的 `pending_approval` 泛化成「整批提議」（白板、多筆記），接受時走一個統一交易入口 |
| 2 | 段落沒有穩定身分、沒有取得工具 ★ | AI＋同步 | 中 | 加唯讀工具回傳每段的 `^id`／錨點；對唯讀筆記的段落另定規則（只引用已有錨點） |
| 3 | 白板排版只在前端 ◆ | AI＋同步 | 中 | 把排版（格狀、樹狀）搬進 `@onden/markdown`，前端與後端共用 |
| 4 | 白板、連線、分組框沒有工具與逆向操作 ◆ | AI | 中 | 先補 `CANVAS_UPDATED`、`EDGE_*` 的復原，再開工具（連線的目標可讀檢查已在 `edgeWrites`） |
| 5 | 排序與搬移只在前端算 | AI＋同步 | 中 | 把 `planSiblingOrder` 變成後端「移到某父層的某位置」操作，工具與前端共用 |
| 6 | 沒有對既有筆記設屬性的工具（表格儲存格、任務日期） | AI | 小 | 補一個 `setAttribute` 工具，直接呼叫 `setNodeAttribute`；`suggest` 模式照 `assertWriteModeAllows` 擋 |
| 7 | 沒有批次讀取範圍（標籤、空間、選取） ★ | AI | 小 | 補 `listNotesIn`（標籤／空間），回 id、標題、版本，受 `readPolicy` 範圍 |
| 8 | PDF 文字只在瀏覽器、沒有頁碼 ★ | AI＋同步＋匯入 | 中 | 抽取搬到共用函式，內文加頁標記（或存成每頁一列），支援匯入與其他節點 |
| 9 | 任務議程與設定沒有工具 | AI | 小 | 補 `taskAgenda` 讀取與 `updateTask` 工具（`updateTask` 已有權限與事件） |
| 10 | `function_refs` 未接線（檢視、任務、複習、技能） | 同步 | 中 | 依 `causal-stamps` 建議在 S5 前獨立接線 |
| 11 | 文件與實作不一致：技能「AI 不能修改」、標籤建卡的描述、`reviewQueue` 沒進 `READ_ONLY_TOOL_NAMES` | AI | 小 | 業主決定技能是否允許 AI 改；其餘修描述與清單 |
| 12 | 空間／成員「提議」管道缺失 | AI | 中 | 要嘛補提議工具，要嘛把 `authority.ts` 的錯誤訊息改成「這是擁有者的操作」 |

## 9. 未確認的事項

- 前端每個畫面元件實際呼叫哪個寫入入口（只確認了 `lib/data/` 的檔案與路由名稱）。
- AI 以 `updateNode` 改內文勾掉任務／建立任務行，是否真的產生預期結果（只讀了 `blockTasks.ts`，沒有跑）。
- 標籤包核准安裝後的事件（`TAG_IMPORTED`）能否復原：讀 `restoreContract.ts` 推斷是 `unsupported`，沒有執行。
- `reviewQueue` 不在 `READ_ONLY_TOOL_NAMES`：依程式推得它會出現在歷史列表，沒有執行；`test/events.test.ts` 只比對核心工具，不含模組工具。
- 白板的建立需要哪些屬性（未讀 `whiteboardNote.ts`、`canvasNodes.ts` 細節）。
- 段落卡（複習）是否回段落 id、`queryView` 回的列是否保證帶身分欄位。
