# 深模組審查：模組系統（標籤、功能、視圖模組、技能、設定裡的模組管理）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查日期 2026-10-24，基準 `origin/main`（6f1b2cbc）。只讀程式碼（.ts/.tsx/.json/測試/eslint 設定），沒有讀任何 .md。

## 一句話結論

「註冊」這一層是真正的深模組：後端 `modules/index.ts`、前端 `modules/index.ts` 各是唯一入口，核心完全不 import 模組內部，還有 lint 與測試守著。但「模組」本身有一半是空殼：四個視圖模組、白板、技能、日記的實際功能寫在核心裡，模組目錄只剩一份中繼資料；前後端的模組定義是各寫一份、靠測試對齊，而且新增視圖類模組要動約 9–10 個檔案。

## 模組地圖

### 後端：`packages/backend/src/modules/index.ts`

- 入口：`MODULES`（`modules/index.ts:39`，14 個模組）、`mountModules`（`:59`）、`registerModuleEffects`（`:83`）。對外匯出共 9 個名字（`grep ^export`）。
- 介面：每個模組只交一份 `ModuleDefinition`（`modules/types.ts`，11 個欄位：`id`、`registerRoutes`、`agentTools`、`dispatcherHandlers`、`outboxEffects`、`personalTables`、`nodeHooks`、`tagFunction`、`startBackground`、`routePrefixes`、`library`）。
- 隱藏了什麼：
  - 路由掛載。
  - 「未引入就拒絕寫入」的閘門：路由 409（`moduleWriteGate`，`:117`）、agent 工具（`onlyWhenImported`，`:130`）、節點掛勾（`hooksWhenImported`，`:148`）。這三種閘門由入口一次包好，模組不用自己寫。
  - 重複 id 檢查、個人資料表登記、tag module 登記。
- 呼叫端：核心只有 `backend/src/index.ts:50` 一個地方 import 它（核心 services／routes 沒有任何一處 import `modules/`，grep 為 0）。測試有 55 個檔案直接 import（lint 規則對測試關閉）。

### 前端：`packages/frontend/src/modules/index.ts`

- 入口：`MODULES`（`:29`，14 個模組）加 31 個匯出名字（`grep ^export`）：`importedModules`、`enabledTagFunctions`、`MODULE_SCREENS`、`READING_SECTIONS`、`NOTE_COMMANDS`、`VIEW_MODULES`、`moduleEntry`、`moduleInUse`、`moduleFilterFor`、`moduleStatusFor`……
- 介面：每個模組交一份 `FrontendModule`（`modules/types.ts`，18 個欄位，其中 `sitePublisher`、`suggestsLinks`、`generatedSourceTypes`、`blockAction`、`NavIndicator`、`noteHeaderAction` 各只有 1–2 個模組用）。
- 呼叫端：40 個非模組、非測試檔案 import `../modules`；其中 30 處呼叫 `isImported(...)`／`isModuleImported(...)` 這類過濾器。
- 繞路：0。`grep` 找非模組目錄 import `modules/<x>/…` 的深層路徑，結果為空；`test/moduleBoundary.test.ts` 也在守。

### 各模組實際大小（檔案數，後端／前端）

| 模組 | 後端 | 前端 | 備註 |
|---|---|---|---|
| website | 4 | 63 | 完整住在模組裡 |
| rss | 17 | 32 | 同上 |
| review | 9 | 19 | 同上 |
| skills | 1 | 10 | 後端只有 `tagFunction`，路由在核心（見問題 3） |
| daily | 1 | 6 | 後端路由在 `routes/day.ts`；前端入口散在核心（問題 2） |
| read_later | 3 | 6 | 完整 |
| citations / slides / semantic | 7／1／4 | 8／6／1 | semantic 的邏輯在 `services/embeddings.ts`（問題 5） |
| canvas | 1 | 1 | 空殼（問題 2） |
| table / calendar / kanban / gallery | 各 1 | 各 1 | 只有中繼資料（問題 1） |

## 分數表

| 子模組 | 深度 | 整合度 | 理由 |
|---|---|---|---|
| 後端模組註冊（`modules/index.ts`） | 5 | 5 | 一個入口把路由、工具、掛勾、閘門、個人資料表全收掉；核心 0 處繞過；lint 白名單是空的 |
| 前端模組註冊（`modules/index.ts`） | 4 | 4 | 核心 0 處深層 import；但匯出 31 個名字、`FrontendModule` 有 18 個欄位，偏寬 |
| 前後端定義的對齊 | 2 | 3 | 兩份各寫、靠 3 個測試用 regex 讀原始碼對齊（問題 4） |
| 視圖模組（table／calendar／kanban／gallery） | 1 | 2 | 模組只是中繼資料，版面實作與清單都在核心（問題 1） |
| 白板（canvas） | 1 | 2 | 模組檔 22 行，功能全在核心，核心靠 `CANVAS_MODULE` 在 15 個檔案問答案 |
| 日記（daily） | 2 | 3 | 前端模組檔有 UI 與設定，但開關檢查散在核心 5 個檔案 |
| 技能（skills） | 2 | 3 | 後端路由繞過模組直接掛在 `index.ts:379` |
| 語意搜尋（semantic） | 3 | 4 | 掛勾與工具走模組；模組 id 常數與檢查函式放在核心 `services/embeddings.ts` |
| 功能模組（review／rss／website／read_later／citations／slides） | 4 | 4 | 目錄自足、可整個刪除；website 在前端有 8 條 lint 白名單例外 |
| 設定裡的模組管理（`settings/ModulesSetting.tsx` + `components/ModuleLibrary.tsx`） | 4 | 5 | `ModulesSetting` 24 行，只轉給 `ModuleLibrary`；設定頁清單由 `MODULES` 產生；核心沒有寫死模組名 |

## 問題清單（依嚴重度）

### 1. 視圖模組是空殼，加一種版面要動 9–10 個檔案

- 現況：`kanban`、`table`、`calendar`、`gallery` 四個模組在前後端各只有 1 個檔案、10–17 行，只有 id、標籤名與卡片文字。真正的版面和「有哪些版面」寫在核心。
- 證據：
  - 後端 `services/viewLayouts.ts:4` 寫死 `["table","kanban","calendar","gallery"]`，被 `tagHierarchy.ts:469`、`viewModules.ts:37,63,68`、`tagCatalog.ts` 使用。
  - 前端 `components/collections/CollectionView.tsx:40` 寫死 `ViewLayoutType`，`:686–699` 的 `switch (layout)` 逐一對應 `TableLayout`／`KanbanLayout`／`CalendarLayout`／`GalleryLayout`，連錯誤訊息「Switch to table, board, calendar or gallery」也寫死。
  - `services/importNotionDatabase.ts:339–341` 與 `services/publishing/siteRows.ts:38` 也各自寫了版面名稱的對應。
  - 前端 `FrontendModule.view`（`modules/types.ts`）只描述「新增視圖時要問哪個欄位」，沒有「畫出來」的元件欄位。
- 影響：
  - 實際追一遍新增 `kanban`：後端 `modules/kanban/index.ts`＋`modules/index.ts`＋`services/viewLayouts.ts`；前端 `modules/kanban/index.ts`＋`modules/index.ts`＋`CollectionView.tsx`＋`components/collections/kanban/KanbanLayout.tsx`＋`lib/i18n.zh-TW.ts`（至少 3 條字串，`:2756`、`:2763`、`:3085`）；另外 Notion 匯入與網站發佈各有一處對應。共約 9–10 個檔案，其中 3 個是核心。
  - 「刪掉模組目錄就整個移除功能」的承諾，對視圖模組不成立。
- 建議：讓 `FrontendModule.view` 帶 `Layout` 元件，`renderLayout` 改查 `VIEW_MODULES`；後端 `VIEW_LAYOUTS` 改由 `MODULES` 中有 view 標記者推導。

### 2. 白板與日記：功能在核心，模組只負責「開關」

- 現況：核心靠模組 id 常數問「有沒有引入」，白板與日記的程式不在模組目錄。
- 證據：
  - 白板：後端 `modules/canvas/index.ts` 只是把 `routes/canvases.ts`、`routes/boards.ts` 掛上去（`:5–6, :17–20`）；`"canvas"` 字串在後端核心出現 27 行／15 個檔案、前端核心 65 行／28 個檔案（其中不少是 node_type／lens 的合法用法，未逐筆區分）。前端 `CANVAS_MODULE` 被 `OverviewSidebar.tsx:163`、`NotesCenter.tsx:74`、`BuilderWorkspace.tsx:87`、`useCommandPalette.ts:207,234`、`useModuleFilter.ts:24` 使用。
  - 日記：`DAILY_MODULE` 定義在核心 `lib/dayNode.ts:16`，被 `HomeStart.tsx:42`、`useCommandPalette.ts:193,204`、`useModuleFilter.ts:31` 使用；`lib/data/dayNotes.ts` 自己判斷模組是否關閉。
  - 測試承認這是特例：`moduleBoundary.test.ts` 的「核心不得寫模組 id」檢查，明確排除 `canvas`、`table`、`daily`（約 `:42` 的 `filter`）。
- 影響：這三個 id 可以直接在核心任何地方出現而不被攔；關掉模組時要靠每個入口各自記得檢查，正是模組註冊想消除的特例分支。
- 建議：把「有沒有引入」收成一個 hook 或註冊欄位（例如 `FrontendModule` 的 `entryPoints` 由核心的指令面板／首頁自行迭代），核心不再 import `CANVAS_MODULE`／`DAILY_MODULE`。

### 3. 技能路由繞過模組註冊

- 現況：技能模組後端是 `tagFunction: true` 加 module tag，但 `/api/skills` 路由由 `index.ts` 直接掛（`index.ts:28, :379`），`modules/skills/index.ts:11` 的 `registerRoutes` 是空函式。
- 證據：`backend/src/index.ts:379` `app.route("/api/skills", skillsRouter)`；`modules/skills/index.ts:11`。另外 `services/harness/noteSkills.ts:47,49` 自己手寫 `isModuleImported(..., "skills")` 與 `modules.has("skills")`。
- 影響：同一模組的路由、閘門與工具各走不同路徑。因為現在只有 GET，不受寫入閘門影響，但之後加寫入路由就會漏掉閘門（推測）。
- 建議：把 `routes/skills.ts` 的掛載移進 `skillsModule.registerRoutes`，並在 `noteSkills.ts` 用共用的判斷函式。

### 4. 前後端模組定義各寫一份，只靠測試對齊，而且不完整

- 現況：沒有共用的定義檔。後端 `ModuleDefinition` 與前端 `FrontendModule` 各列 14 個模組；module tag 名稱、`tagFunction`、library 欄位兩邊各抄一份。
- 證據：
  - 重複的值：`review` → `moduleTag: { name: "review" }` 在 `backend/.../review/index.ts:28` 與 `frontend/.../review/index.tsx:28`；`paper`、`read-later`、`skill` 亦同（共 4 組兩邊都寫）。`kanban` 等視圖模組的標籤名「看板」只在後端（`kanban/index.ts:9`），前端沒有，兩邊的 moduleTag 結構還不一樣。
  - 對齊測試：`frontend/src/test/moduleBoundary.test.ts`（「every frontend module has a backend module of the same id」）只檢查前端 → 後端目錄存在，沒檢查後端 → 前端；`tagFunctionRegistry.test.ts` 用 regex（`/\btagFunction:\s*true\b/`、`/\bid:\s*"([^"]+)"/`）讀後端原始碼，遇到 `id: SEMANTIC_MODULE` 這類常數寫法就會失效（semantic 目前不是 tagFunction，所以還沒出事）。
  - 沒有找到比對兩邊 `moduleTag.name` 是否一致的測試（我只搜了檔名含 module／registry 的測試，可能遺漏，標為推測）。
- 影響：新增或改名時容易兩邊不一致；測試讀原始碼 regex 很脆弱。
- 建議：把 id、moduleTag 名稱、tagFunction、library 分類做成一份純 JSON／常數檔給兩邊 import，或至少加一個比對兩邊清單與 moduleTag 名稱的測試。

### 5. 語意搜尋：模組外殼薄，id 與判斷在核心 service

- 現況：`SEMANTIC_MODULE` 與 `semanticImported` 定義在 `services/embeddings.ts:10,16`，模組反過來 import 它（`modules/semantic/index.ts:3,31`）。
- 影響：依賴方向是「模組 → 核心 service → 引入狀態」，但模組 id 的擁有者是核心；與 `daily`、`canvas` 同一類。這只是方向問題，沒有造成繞路，風險低。
- 建議：把 id 常數移回 `modules/semantic/`，`embeddings.ts` 改收參數。

### 6. 前端 `FrontendModule` 介面偏寬

- 現況：18 個選用欄位，有 5–6 個只有單一模組使用（`sitePublisher`、`suggestsLinks`、`blockAction`、`generatedSourceTypes`、`NavIndicator`）。入口匯出 31 個名字，另有針對特定欄位的推導函式（`SITE_MODULE`、`SITE_PUBLISHER`、`linkSuggestionsShown`）。
- 證據：`frontend/src/modules/types.ts`；`frontend/src/modules/index.ts:41–45, :72–76`。
- 影響：呼叫端要知道哪個欄位對應哪個擴充點；介面成長快。尚未造成問題。
- 建議：先不處理；新增第 3 個類似單一用途欄位前，先想能否用通用的 `extensions` 型別。

## 做得好、值得保留的地方

1. 後端單一接縫：核心只有 `index.ts:50` 一處 import 模組；`mountModules` 一次處理重複 id 檢查、路由閘門、工具閘門、掛勾閘門（`modules/index.ts:59–160`）。測試 `moduleSeam.test.ts` 釘住這份契約。
2. 「未引入就拒絕」只寫一次：路由 409、agent 工具、節點掛勾都由入口包裝，模組作者不用記得。
3. 擴充點用同一種方式註冊：路由、agent 工具、dispatcher、outbox 效果、節點掛勾、個人資料表都是 `ModuleDefinition` 的欄位，再由 `registerModuleEffects`（`:83`）分送到既有 registry，沒有第二套。
4. 核心不 import 模組內部：後端 0 處，前端 0 處；`module-entry` lint 規則（`eslint-rules/module-entry.mjs`）後端白名單是空的（`backend/eslint-rules/module-entry-allowlist.json` 內容為 `{}`）。
5. 前端有「核心不得寫模組 id」的測試（`moduleBoundary.test.ts`），而且列出每個例外的理由。實測：`review`、`rss`、`semantic` 等 id 在核心剩下的引用多為資料值（`source_type`、`origin`）或註解／i18n。核心也沒有硬編碼模組標籤名（#複習、#稍後讀、#論文、#技能 在核心非註解程式碼 0 處；#月曆 等只出現在註解）。
6. 設定頁的模組管理很薄：`ModulesSetting.tsx` 24 行，清單由 `MODULES` 產生（`settings/registry.tsx:109–118`），沒有寫死模組。
7. 功能完整的模組（website、rss、review、read_later、citations）把 UI、路由、工具、設定全放在自己的目錄，確實可以整個刪除。

## 不確定、需要人確認的點

1. 問題 2 的 `"canvas"` 字串：後端 27 行、前端 65 行裡，哪些是「模組 id」、哪些是 node_type／lens 的合法用法，我沒有逐筆分類；需要人確認真正屬於「模組特例」的數量。
2. 問題 1 裡視圖模組空殼是不是刻意設計：模組內檔案註解寫「a view module like modules/calendar」，是否有意讓版面留在核心（因為 `table` 與 base block 共名），我無法從程式判斷。
3. 前端 `moduleTag.name` 與後端是否一致，我只比對了 4 組肉眼相同，沒找到自動檢查；可能有我沒搜到的測試。
4. 後端 55 個測試直接 import `modules/…`：lint 規則對測試關閉，這算合理例外還是繞路，需要人決定。
5. 前端 `module-entry` 白名單 32 個 importer／67 條目標，其中 8 條屬於 `modules/review`、`modules/website`（往核心 `lib/ink`、`components/templates` 等內部檔案伸手）。這是「模組依賴核心內部」而非「核心繞過模組」，是否要先整理核心的出口，需要人確認優先順序。
6. 我沒有執行 `tsc` 或測試，所有結論來自靜態閱讀與 grep。
