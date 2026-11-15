# 深模組審查：任務、日記、時區、偏好（2026-10-27）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查範圍：#688 #689 #690 #702 #709 #710 #722 #726 #731 #739 #798 #803 #808。
基準：`origin/main` 在 `a94b45c`。只讀程式碼（.ts/.tsx/.sql/設定/測試），沒有讀任何 .md。
不計入：#694 #698 #699 #704 #706 #712（未合併）。

## 一句話結論

**部分算深模組。** 後端的「任務模組」「工作區時鐘」「帳號偏好端點」做得真的深：介面小、複雜度藏在裡面、有測試與 lint 守邊界。
但前端的任務沒有真的接上模組登錄（只有一個 28 行的資訊殼，任務頁、快速新增、提醒都是寫死的核心頁），
而且「任務落在哪一天」這條規則被各處各算一次（5 份）、遞迴規則算 3 份、日期加減有 4 份、「今天」的 hook 有 2 種，
這些是新長出來的重複實作，不是深模組該有的樣子。

## 先說明：PR 對應

- `git log origin/main --grep "Merge pull request #<號碼>"` 找得到 #722 #726 #731 #739 #798 #803 #808。
- #688 #689 #690 #702 #709 #710 在 main 上**沒有自己的合併 commit**。#722（`accept/tasks-int`，合併 commit `9cb232e`）
  的歷史裡有 `feat/tasks-t1-module … t7-export`、`test/multi-tab-properties` 等分支被合進同一個整合分支。
  **推測**這幾個號碼是那些子分支，由 #722 一次進 main；我沒有逐一證實，所以下面把它們合成「任務改版（#688–#710 + #722）」一組評。

## 每組判定

| 組 | PR | 新模組入口檔 | 介面大小 | 深度 | 整合度 | 判定 |
|---|---|---|---|---|---|---|
| A1 任務模組（後端） | #722（含 #688–#710） | `backend/src/modules/tasks/index.ts:25`、`services/taskSeam.ts` | 1 個 ModuleDefinition + 1 個 seam（3 個方法） | 4 | 4 | 算 |
| A2 任務（前端） | #722 | `frontend/src/modules/tasks/index.ts:11`、`lib/data/taskWriter.ts`、`components/tasks/index.ts` | 模組殼 0 行為；寫入入口 1 個 `taskWriter`；元件匯出 12 個名字 | 3 | 2 | 部分算 |
| A3 中文快速新增解析器 | #722 | `markdown/src/taskParse.ts:153` | 1 個函式 `parseTaskInput(text, opts)` + 4 個選項 | 5 | 3 | 算（深度）／整合有缺口 |
| A4 任務匯出／匯入 | #722 | `services/exportTasks.ts`、`services/importTaskLists.ts`、`services/taskListFile.ts` | 各 1–2 個匯出函式 | 3 | 2 | 部分算 |
| B 日記 | #726 #731 #739 #798 | `frontend/src/modules/daily/index.tsx:15`、`journal.ts` | 1 個 FrontendModule（screen + settings + library）；4 個純函式 | 3 | 4 | 算 |
| C 時區／一天幾點開始 | #808 | 後端 `localDay.ts` + `services/workspaceTime.ts`；前端 `lib/localDate.ts` | 後端 `localDayId()`、`setWorkspaceTime()`；前端 `todayId()` | 4 | 4 | 算（有 4 處洩漏） |
| D 偏好跟著帳號 | #803 #798 | `backend/src/services/actorPrefs.ts:12`、`routes/me.ts`、`frontend/src/lib/accountPrefStore.ts:33` | 1 個端點 `/api/me/prefs/:key`、1 個 schema 表、1 個前端工廠 | 4 | 4 | 算（有 4 處沒走工廠） |

## 問題清單（嚴重度由高到低）

### 1. 「今天的任務落在哪」被實作了 5 次，規則還不一樣
- 現況：同一個問題「這個任務算今天／逾期／即將嗎」有 5 份各自的實作：
  1. 後端 agenda SQL `services/tasksStore.ts:131-144`（overdue／today／upcoming 7 天／scheduled）
  2. 前端任務頁 `lib/tasks/taskModel.ts:73-76`、`:108`（逾期算今天，沒有 overdue）
  3. 前端日記 `lib/tasks/journalBuckets.ts:49-60`（只有 `when_date === today`，另有自己的 `JournalTask` 型別與 `isOpen`）
  4. 前端離線版 `lib/data/taskAgenda.ts:15`（複製 #1）
  5. 匯出 `services/taskListFile.ts:118`（`sectionOf`）（`when <= today` 算今天）
- 證據：上述行號；`TasksMode.tsx:86` 用 #2，`useDueSoonNotifications.ts:94` 用 #1（`reads.workspace.taskAgenda`），`JournalTasks.tsx:41` 用 #3。
  其中 #3 與 #2 「刻意不同」（檔頭有寫），但 #1 與 #2 同樣是「任務頁看到的清單」卻規則不同：同一個逾期任務，通知說「逾期」、任務頁把它放今天。
- 影響：改一次「今天」的定義要改 5 處；兩個畫面對同一任務說法不同。
- 建議：保留「日記只看當天」這個有意的差異，但 agenda／任務頁／離線版／匯出收斂成同一份規則表（一個函式回傳 bucket 名），讓 SQL 以外的使用者共用。

### 2. 前端任務沒有真的接上模組登錄；模組開關關掉時前端不會收起來
- 現況：`modules/tasks/index.ts:11-28` 只有 `library` 說明，沒有 `screen`、`settings`、`openCommand`。
  檔頭註解（`:1-6`）說核心畫面會「問模組庫開了沒」，但實際沒有。
  對照日記模組 `modules/daily/index.tsx:15-47` 有 `screen`、`settings`、`inUse`，並且 33 處用 `DAILY_MODULE`／`dailyNotesEnabled` 守。
- 證據：
  - `TASKS_MODULE`（`modules/index.ts:40`）在整個 `frontend/src` 只有 `test/moduleBoundary.test.ts:9,51` 用，**正式程式 0 處用**。
  - 寫死的任務入口：`components/shellNavigation.ts:75`（CORE_PAGES）、`hooks/useUiMode.ts:17`（`CoreMode`）、`hooks/useUrlLocation.ts:37`、
    `lib/navLayout.ts:30`（預設手機釘選）、`hooks/useCommandPalette.ts:196`（新增任務）、`:236`（前往任務）、`components/workspace/WorkspaceOverlays.tsx:78`（`<QuickAddTask />`）、`modules/daily/JournalScreen.tsx:19`（日記內任務）。**8 個入口 0 個依模組開關。**
  - 後端：模組關閉時 `/api/tasks` 寫入回 409 `module_not_imported`（`modules/tasks/index.ts:32`），前端 `lib/serverErrors.ts:26` 只顯示「這個功能在這個工作區已關閉」。
  - `test/moduleBoundary.test.ts:51` 的「核心不得寫死模組 id」守衛把 `TASKS_MODULE` 加進豁免名單，等於把這個缺口記成「設計如此」。
- 影響：使用者關掉任務模組後仍看得到任務頁與「新增任務」，按下去才被 409 擋；這是 UI 與後端規則不一致，不是「深模組」的樣子（模組應該整個消失）。
- 建議：給 `tasksModule` 補 `screen`／`openCommand`，把上面 8 個入口改成問 `useModuleFilter()`，守衛測試拿掉對 `TASKS_MODULE` 的豁免。

### 3. 匯入任務繞過任務建立入口，且不驗證欄位
- 現況：任務有兩條建立路：`modules/tasks/create.ts:84-95`（zod 驗證 `when_date`、`recur`…，經 `createTaskNode`）與
  `services/standaloneTasks.ts:94-118`（`createStandaloneTask`，匯入用）。後者直接 `INSERT INTO node_tags` 與 `node_attributes`（`:106-114`），
  註解寫明「`_task_*` 欄位照給的存」。
- 證據：`services/importTaskLists.ts:87`、`services/taskListFile.ts:119-124`（`recurFromWords` 對無法識別的文字「原樣保留」；`"every year"` 會變成 `1y`）。
  `modules/tasks/recurrence.ts:23` 的 `isValidRecur` 只接受 `d/w/m`，`:76` 的 `advanceDue` 遇到 `1y` 會 throw。
  匯出端的 `recurAsWords`（`taskListFile.ts:94`）卻接受 `y`——三處對「可用的重複單位」說法不一。
- 影響：匯入一份手改過的任務清單，可能存入 `_task_recur=1y` 或不存在的日期；之後排程器在每個週期都對它 throw 並被 per-task try/catch 吞掉（`scheduler.ts:63-110`），**推測**會每分鐘重試且永遠修不好（未實測）。
  匯入也沒走 `isTaskDay`／`isValidRecur`，保存規則在兩條路徑上不同。
- 建議：匯入時把欄位交給 `modules/tasks/fields.ts` 的同一組驗證，無效就丟到 `conflicts`，並讓 `createStandaloneTask` 收進 `createTaskNode`。
- 勾選框嵌入是好的：`lib/embedDom.ts:191` 走 `taskWriter.patch`，沒有第二條。

### 4. 重複規則被算了 3 次、單位字串被解析 6 次
- 現況：「下一次是哪天」後端 `modules/tasks/recurrence.ts:74-93`（`advanceDue`）、前端 `lib/tasks/taskModel.ts:233-258`（`addMonths`、`nextOccurrence`，只是提示）、
  解析器 `markdown/src/taskParse.ts:82`（`addMonths`）。月底夾緊的邏輯三份。
- 證據：`/^(\d+)([dwm])$/` 之類解析 `recur` token 的正規式出現在 6 處：
  `recurrence.ts:76`、`taskListFile.ts:94`、`taskLabels.ts:31`、`quickAddTask.ts:33`、`taskChips.ts:23`、`taskModel.ts:229`。
  `{1,3}` 與 `+` 的位數上限也不一致（後端 3 位、前端不限）。
- 影響：改單位（例如加「年」）要改 6 處；前端的「下一次」提示可能和伺服器真正生出來的日期不同（兩邊對「已過期怎麼辦」的迴圈寫法不同）。
- 建議：把 `parseRecur` 與 `nextOccurrence` 放進 `@onden/markdown`（和 `isCalendarDate` 同處，後端前端共用），標籤函式只負責翻成文字。

### 5. 「今天」的 hook 有兩種，日記頁不會跨日更新
- 現況：`components/TasksMode.tsx:52-60` 自己寫 `useToday()`（每分鐘重算）；`modules/daily/JournalScreen.tsx:45` 直接 `localDateId()`（每次 render 算一次，沒有計時）。
- 影響：日記頁開著過午夜（或一天的起算點），標題「今天」不會變，除非有別的狀態變化觸發重新 render（**推測**，未實測）。
- 建議：把 `useToday` 提到 `lib/localDate.ts`（或 hooks/），兩處共用。另外 `dayNode.ts:localDateId`（14 個呼叫端）只是 `todayId` 的轉手別名，可以收掉。

### 6. 日期工具與日期檢查散在 4 處
- 現況：「日期 ± 天數」有 4 份：前端 `lib/localDate.ts:94`、後端 `recurrence.ts:112`、`services/history/activity.ts:57`（`shiftDay`）、`taskParse.ts:76`。
  「這是不是真的日曆日」有 5 種寫法：`@onden/markdown` 的 `isCalendarDate`（註解自稱「the one date grammar」，`markdown/src/attributeValue.ts:30`）只有 `recurrence.ts`、`dayNotes.ts:78`、`sqlClauses.ts` 用；
  繞過的有 `lib/dayNode.ts:44-48`（自己 round-trip）、`routes/day.ts:20`、`services/history/activity.ts:54`（`isDay`）、`util/captureSyntax.ts:50-54`。
- 影響：同一個「2026-02-30 算不算日期」的問題，`dayNode.ts` 與 `dayNotes.ts:78` 在同一個前端用兩種寫法。
- 建議：前端日期運算收進 `localDate.ts`、後端收進 `localDay.ts`（匯出 `addDays`／`daysBetween`），所有日期檢查走 `isCalendarDate`。
- 守衛現況：`eslint-rules/time-through-labels.js` 只擋「用 `toLocaleDateString` 顯示」，**沒有**擋「自己算今天／自己加減天數」，所以這類複本沒有東西阻止它長出來。

### 7. 日記的 `dayNoteParent` 自己手寫一份，沒用新的偏好工廠
- 現況：#803 讓 RSS、收工、時區問答共 7 個偏好走 `createAccountPref`（`lib/accountPrefStore.ts:33`，含一次性搬舊值 `legacy`）。
  `dayNoteParent` 仍用 `createSyncedPrefStore` + 自己寫 load／save（`lib/data/dayNoteParentStore.ts:25-34`），
  還另外有 `hooks/useDayNoteParentSync.ts` 重寫了一遍「搬舊值」邏輯。
- 證據：`/api/me/prefs/${KEY}` 字串由 5 個檔案各自拼：`accountPrefStore.ts:46,51`、`navLayoutStore.ts:29`、`dayNoteParentStore.ts:28`、`sidebarTagsStore.ts:39`、`hintsSeenStore.ts:33`。
  走工廠 7 個，手寫 4 個（nav、sidebarTags、hintsSeen、dayNoteParent）。
- 影響：搬舊值的規則有兩份，工廠改了手寫那份不會跟；端點路徑拼了 5 次。
- 建議：#798 剛做的 `dayNoteParent` 優先改成工廠（它有 `legacy` 需求），再看另外 3 個。

### 8. 前端偏好 key 與後端 schema 沒有交叉檢查
- 現況：後端 `actorPrefs.ts:16-76` 的 `PREF_SCHEMAS` 與前端各處的 `serverKey: "…"` 字串、`parse` 函式是兩份手維護的表（前端 `lib/prefs.ts` 每個偏好還要一個 `X` 加一個 `XCopy` 的 key）。
- 證據：`backend/src/test/actorPrefsShape.test.ts` 只測後端 schema；`frontend/src/test/accountPrefs.test.tsx` 沒有看到比對後端 key 表（我只掃了檔頭，**推測**沒有）。
- 影響：前端 key 打錯字只會在執行時得到 404 `unknown_pref`。
- 建議：把 key 清單與值型別放在 `@onden/markdown` 或新的共用型別檔，前後端都 import。

### 9. 解析器的出口不在套件主入口，要在 5 個設定檔各加一個別名
- 現況：`@onden/markdown/task-parse` 子路徑（`markdown/package.json:36`），理由是本機 DB worker 不能載入 Markdown 管線（`taskParse.ts:4-6`）。
- 證據：別名重複寫在 `frontend/astro.config.mjs:26`、`vite.capacitor.config.ts:14`、`vitest.config.ts:17`、`vitest.perf.config.ts:10`，加上 package.json，共 5 處。
- 影響：每多一個建置目標就要記得補別名；只有 `QuickAddTask.tsx:11` 與 `quickAddTask.ts:8` 兩個使用者。
- 建議：用 `exports` 條件讓子路徑自己解析，別名可以拿掉（或在一個共用設定檔裡定義一次）。

### 10. 第二個日期短語解析器、第二套標籤函式
- `util/captureSyntax.ts:42-61`（英文 `@today/@tomorrow`）與 `taskParse.ts`（中文自然語言）是兩個「從輸入文字找日期」的解析器；
  `QuickCapture.tsx:389,447` 用前者，任務快速新增用後者。`captureSyntax.ts:5` 的註解還寫著給「Tasks quick-add」用，已過時（現在沒有人這樣用）。
- 前端有 2 個 `dayLabel`（`components/tasks/quickAddTask.ts:19` 與 `taskLabels.ts:11`，名字相同、簽名不同）和 2 組重複規則文字（`recurLabel` vs `recurRuleText`），外加 `lib/taskChips.ts` 又一套。
- 建議：小事，順手合併；先把 `dayLabel` 改名避免誤用。

### 11. 過時的「相容」分支與死碼
- `lib/tasks/taskModel.ts:1-10,63,256` 還寫著「T1 合進來後把 LEGACY 分支刪掉」，T1 已經在 #722 合進來了；`lib/tasks/journalBuckets.ts:7-9` 同理。
  `taskWriter.ts` 還同時送 `due_date` 與 `when_date`（`:35`、`:45`）。後端也還收 `due_date`（`fields.ts:17`）。
  離線佇列可能還有舊格式寫入，所以後端保留是合理的（**推測**），但前端這側可以刪。
- `lib/data/taskAgenda.ts:74` 的 `loadTaskAgenda` 匯出於 `lib/data/index.ts:37`，在正式程式裡找不到呼叫者（只有測試）。
- 例外清單：`backend/eslint-rules/require-read-gate.js` 的允許表新增 2 條「不對外提供」（`modules/tasks/create.ts`、`placement.ts`），另有 5 條是搬路徑。整段區間（全 repo，不只本區）新增的 `eslint-disable` 約 3 處 `react-hooks/exhaustive-deps`、1 處 `modals-through-ui-modal`；本區檔案內只有 `QuickAddTask.tsx:58` 與 `JournalScreen.tsx:83` 兩處 exhaustive-deps。

## 做得好、值得保留

- **後端任務模組是真的模組**：`modules/tasks/index.ts:25-40` 一個 `ModuleDefinition` 帶路由、背景工作與模組標籤；
  核心只透過 `services/taskSeam.ts` 的 3 個方法呼叫它，且核心程式碼**沒有任何一處 import `modules/tasks`**（grep 確認，只有註解提到）；
  模組關閉時排程器、存檔掛鉤、寫入路由三處一致地停掉（`scheduler.ts:55`、`seam.ts:22-28`、`index.ts:32`）。
- **任務寫入只有一個前端入口**：所有任務的建立／修改都經 `lib/data/taskWriter.ts`（`:88,134,167,180` 是全程式唯一的 `/api/tasks` 寫入字串）；
  嵌入的勾選框（`embedDom.ts:191`）、快速新增（`createQuickTask.ts`）、日記收工（`JournalTasks.tsx:20`）、快速擷取（`QuickCapture.tsx:70`）、複習卡（`review/extractCards.ts:87`）全部共用。後端還原備份也走 `createTaskNode`（`backupRestore.ts:887`）。
- **解析器是教科書式的深模組**：一個純函式、無 import、輸入輸出都是資料，並回傳 `spans` 讓 UI 做「取消這個解讀」。有 property test（`test/properties/taskParse.property.test.ts`）。
- **時區：一個時鐘，兩側各一份**：後端所有「今天」都經 `localDayId()`（`localDay.ts:96`），SQL 經 `sqlLocalDate`／`sqlDayStart`；
  `grep CURRENT_DATE` 在非測試程式為 0；前端 `todayId()` 同一套語意並由 bootstrap 灌入。
  設定一次改兩個值（`services/workspaceTime.ts:setWorkspaceTime`）走 `mutate` + 事件 + `afterCommit` 才改行程內時鐘，交易語意正確；前端 `lib/workspaceClock.ts` 是「確認 → 寫入 → 可改回」的單一路徑，設定頁與旅行詢問共用。
- **偏好：一個端點、一張 schema 表**：`routes/me.ts` 只有 GET／PUT `/prefs/:key`，未知 key 404、型別不符 400；RSS 未讀、閱讀位置、收工、時區問答共 7 個偏好用同一個工廠，工廠內含「搬舊值」與「只往前」規則。
- **日記整合良好**：`modules/daily/index.tsx` 同時登錄 `screen`、`settings`、`library.inUse`；`JournalScreen.tsx` 用 `ui` 的 `Popover`／`usePopover`／`buttonClass`、`buildMonthGrid`（沒有自己畫第二套月曆）、`dayNotes.openDay`（單一入口）。新 UI 的 `Modal`／`Button` 都用 `components/ui`（`TaskSheet.tsx:6`、`QuickAddTask.tsx:18`、`ShutdownSheet.tsx:6`）。
- **守邊界的測試**：`test/moduleBoundary.test.ts`（核心不 import 模組檔）、`backend` 的 `require-read-gate` 規則、`time-through-labels` 規則、`actorPrefsShape.test.ts`、`workspaceClock.test.ts`、`journalBuckets.test.ts`、多分頁 property test。

## 不確定、需要人確認

1. **PR 對應**：#688–#710 我只能從 #722 的子分支名「推測」；若擁有者另有對應，請告訴我，我會重評。
2. **前端不隨模組開關收起任務**是否為刻意決定？`modules/index.ts:37-40` 與 `moduleBoundary.test.ts` 的註解說「核心就是要命名它」，但檔頭又說要問模組庫。兩者矛盾，我無法判斷哪個是現行意圖。
3. 問題 3 的「每分鐘重試」與問題 5 的「過午夜不更新」是看程式推論，我沒有實際跑。
4. 問題 8 我只看了測試檔頭，沒逐行確認是否有前後端 key 對照。
5. **與未合併的重構 PR（#694 #698 #699 #704 #706 #712）的關係**：我沒有讀它們的內容，也不知道它們動哪些檔。
   **推測**若其中有動 `lib/data`、`components/ui`、`modules/index.ts` 或 `lib/prefs.ts` 的，合併時會碰到本文提到的 `taskWriter.ts`、`shellNavigation.ts`、`dayNoteParentStore.ts`；
   特別是問題 2（把任務入口改成問模組）和問題 7（改偏好工廠）若與它們方向重疊，請先決定順序再動手。
