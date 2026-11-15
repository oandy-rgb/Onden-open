# 近期更新算不算深模組 — 歷史改版（2026-10-27）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查範圍：PR #666 #667 #668 #670 #671 #678 #682 #720 #729 #733 #745 #752 #755 #792 #795 #799。
只讀程式碼，沒有讀任何文件；判斷依據是 `origin/main`（a94b45c）上現在的程式。

## 一句話結論

**部分算深模組。** 後端歷史有一個小而穩的入口（`services/history/index.ts`），寫入全部經過既有的領域操作（`updateNode`／`trashNode`／`undeleteNode`），讀取全部經過 `readPolicy`，「那天結束」也和全站共用同一個日曆時鐘；前端資料入口也沒有人自己 fetch。主要缺點不在「繞路」，而在**「同一件事做了好幾遍」**：段落切分有三份、改動計數有兩份（單位不同）、「讀得到的筆記加空間」的 SQL 有四份、前後端型別各寫一份（約 17 個）、AI 執行卡與還原卡是兩份近乎相同的元件。

## 關於 PR 編號

- `git log origin/main --grep "#<號碼>"` 找得到合併 commit 的只有 #720 #729 #733 #745 #752 #755 #792 #795 #799。
- #666 #667 #668 #670 #671 #678 #682 找不到以這些編號命名的合併 commit。從歷史看，H1–H7（版本清單、工作區活動、時間滑桿、這段的歷史等）是在 `accept/history-int` 分支一起整合、由 #720 進 main（`34093a8`、`ff47bb1`、`66dcb87`、`06fd905`、`34b693a` 等 merge）。**推測**這幾個編號就是 H1–H7 的子 PR，我把它們併進下表的 A 組一起評。

## 判定表

| 組 | PR | 新模組入口檔 | 介面大小 | 深度 | 整合度 | 判定 |
|---|---|---|---|---|---|---|
| A 後端：版本清單／活動／AI 執行撤銷／最近刪除 | #666–#682（推測）、#720、#733、#752、#792、#795 | `services/history/index.ts:1-18`（路由 `routes/history.ts`） | 匯出約 30 個名字（含型別）；路由 7 條讀、5 條寫 | 4 | 3 | 部分算 |
| B 後端：那天的樣子、還原到這時、撤回 | #799（含 `2f49e6a` 那天結束） | 同上；`pointInTime.ts:50`、`rewind.ts:77,240` | 3 個動作函式 + 1 個錯誤類別；呼叫端只傳 actor、時間點、三個 id 清單 | 4 | 4 | 算 |
| C 前端：資料入口與頁面骨架 | #729、#733、#745、#795 | `lib/history/index.ts`、`components/history/index.ts:1-5` | lib 匯出約 45 個名字、元件只匯出 3 個 | 3 | 4 | 部分算 |
| D 前端：時間滑桿、區塊歷史、差異顯示 | #720、#755、#799 | `HistorySlider.tsx:17`、`lib/history/paragraphDiff.ts`、`blockParagraphs.ts`、`charDiff.ts` | 滑桿 props 8 個（可接受）；差異有 3 套各自的匯出 | 3 | 2 | 部分算 |
| E 前端：AI 執行卡、還原卡、確認視窗 | #792、#799 | `WorkspaceHistoryRunCard.tsx`、`WorkspaceHistoryRewindCard.tsx`、`RewindConfirm.tsx` | 每張卡 5–6 個 props，內部各 7–8 個 state | 2 | 3 | 部分算 |

**整體：部分算深模組。**

## 問題清單（依嚴重度）

### 1. 段落切分有三份實作（含一份手寫的 Markdown 判斷）
- 現況：同一個「把筆記切成段落」的規則寫了三次。
  - 後端 `segmentMarkdown`（`services/history/noteVersions.ts:55`，用手寫 regex 認標題、清單、圍欄，行 `35-40`）。
  - 前端 `splitParagraphs`（`lib/history/paragraphDiff.ts:50`）。
  - 前端另一個 `splitParagraphs`（`lib/history/blockParagraphs.ts:27`）。檔案開頭自己寫著「兩者形狀不同，之後應該合併」（`blockParagraphs.ts:2-3`）；`lib/history/index.ts:19` 還得改名成 `splitBlockParagraphs` 才不撞名。
- 證據：呼叫端 8 處分兩邊：`NoteHistory.tsx:124,127`、`RewindNoteDiff.tsx:31`、`takeBack.ts:19-44` 用 `paragraphDiff`；`blockHistory.ts:53,68,80`、`useBlockHistory.tsx:38` 用 `blockParagraphs`。三份的「`^id` 怎麼算」「標題怎麼算」細節不同（例如 `paragraphDiff.ts` 的 `BLOCK_ID` 要求前面有空白、`noteVersions.ts` 的 `BLOCK_ID_AT_END` 允許行首；一個認 `#{1,6}\s+`、一個認 ` {0,3}#{1,6}`）。
- 影響：後端算的「改了 N 段」和前端自己算的（`noteTimeline.ts:60` 在後端沒給 summary 時自己 `summarizeChange`）可能對不上；Markdown 規則改一次要改三處。`@onden/markdown` 已有 `blocks.ts`、`blockId.ts`（`BLOCK_ID_PATTERN`、`trailingBlockId`）這套「一個解析器」，歷史完全沒用。
- 建議：把「切段落＋對齊＋計數」放進 `@onden/markdown` 一個入口（後端、前端共用），歷史只留「怎麼顯示」。

### 2. 「改動計數」有兩套，單位不同
- 現況：同一頁上，筆記列的 `added/changed/removed` 是**段落**（`describeChange`，`activity.ts:188`），AI 執行卡裡每篇的 `added/changed/removed` 是**行**（`countLineChanges`，`activity.ts:225`，來自 `eventLog/bodyMerge.ts:93`）。兩者在前端型別裡欄位名完全一樣（`DayNoteChange` 與 `RunNote`，`workspaceHistoryApi.ts:20-27,41`）。
- 影響：同一次 AI 修改，在「筆記」列顯示「改 1 段」、在「AI 執行」卡顯示「改 7 行」，使用者看到兩種單位卻同名。
- 建議：AI 執行卡改用同一個計數函式，或把欄位名拆開（`lines_*` 與 `paragraphs_*`）。

### 3. 「讀得到的筆記＋空間範圍」SQL 有四份
- 現況：`readableScopeSql` 本身是共用入口，但「加上最近刪除、再加空間」每個檔案自己拼。
  - `activity.ts:29-32` 的 `scopeSql`（只含活的）。
  - `agentRuns.ts:103-104`（內嵌同樣的邏輯，沒用 `scopeSql`）。
  - `pointInTime.ts:51-55`（活的 ∪ 垃圾桶 ∪ 空間 ∪ 單篇）。
  - `rewind.ts:177-190` `readableNotes`（活的 ∪ 垃圾桶 ∪ 空間，和上一條幾乎逐字相同）。
- 影響：「空間」或「可讀」的規則一變，要同步改四處；`AGENTS`／讀取政策的優點（一個地方判斷）在這一層被稀釋。目前 4 份的結果一致（我逐一讀過），不是現存 bug，是漂移風險。
- 建議：在 `readPolicy`（或 `history/` 內一個小檔）出一個 `readableNotesSql(actor, alias, params, { space, includeTrashed })`，四處改用。

### 4. 前後端型別各寫一份，已出現不一致
- 現況：約 17 個回應型別前後端各定義：`ActivityDay`、`DayNote`、`DayNoteChange`、`FeedDay`、`Feed`、`DeletedNote`、`DeletedNoteBody`、`DayAgentRun`↔`AgentRun`、`RunRevertResult`↔`RunUndoResult`、`NoteStatus`、`AtNote`、`WorkspaceAt`、`NoteAt`、`RewindResult`、`DayRewind`↔`RewindCard`、`RewindUndoResult`、`REWIND_MAX_NOTES`（後端 `services/history/*.ts`，前端 `lib/history/workspaceHistoryApi.ts`、`rewindApi.ts`）。前端讀取用 `reads.history.feed<Feed>(…)`（`workspaceHistoryApi.ts:57`），泛型由呼叫端自報，沒有驗證。
- 證據（已漂移）：後端 `FeedDay.end_at` 必填（`activity.ts:46`），前端是選填 `end_at?`（`workspaceHistoryApi.ts:45`），導致前端留了第二套「那天結束」計算（見問題 5）；後端 `DayAgentRun.summary: string`，前端 `summary: string | null`；前端 `RunUndoResult.skipped?` 選填，後端必有（`agentRunUndo.ts:219`）。
- 建議：用一份共用型別（或 zod schema）讓兩邊 import；至少加一個合約測試比對欄位。

### 5. 「那天結束」：後端共用一套時鐘，前端留了一套備援（結論：基本共用，有一個小重複）
- 後端：`dayEnds`（`activity.ts:283-291`）用 `localDay.ts` 的 `sqlDayStart`，和 `editsSql`（`activity.ts:72`）、`dayChanges`（`173,177`）、`agentRunsBetween`（`201`）完全同一個時區與「一天從幾點開始」；單位測試也驗證（`historyActivity.integration.test.ts:161`）。**共用，做得好。**
- 前端：`rewindCut.ts:13` 在伺服器沒給 `end_at` 時用 `endOfDayInstant`（`lib/localDate.ts:103-112`）自己算一遍。實際呼叫只有 `WorkspaceHistoryChanges.tsx:194`，一定會傳 `day.end_at`，所以備援只對「舊後端」有用（**推測**）。`endOfDayInstant` 也只有 `rewindCut.ts` 一個正式呼叫端（其餘是測試）。
- 影響：小。但它是第二套日邊界計算，要是 DST 規則或「一天起點」改了，只有後端那邊有 `localDay.ts` 的註解守著。
- 建議：把 `end_at` 改成必填、移除 `endOfDayInstant`，或明確標示只給舊後端。

### 6. 在歷史服務內，常用的小工具被放到不相干的檔案；SQL 片段被複製
- `bodiesByHash` 放在 `agentRuns.ts:192`，但被 `activity.ts`（3 處）、`agentRunUndo.ts`（2）、`pointInTime.ts`（3）、`rewind.ts`（3）使用，共 12 個呼叫點、5 個檔案；`pointInTime`／`rewind` 為了它得 import `agentRuns`，造成 `activity → rewind → agentRuns`、`activity → agentRunUndo → agentRuns` 的交叉依賴。
- 「取某篇某時間點前最後一個有 body_hash 的事件」這段 SQL（`event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND payload ? 'body_hash'`）以字面量複製 9 次：`activity.ts:71,172,176,302`、`noteVersions.ts:405,424`、`pointInTime.ts:70`、`rewind.ts:273,302`；`agentRuns.ts:19` 雖有 `BODY_EVENTS` 常數，但沒匯出，別處用不到。
- 影響：哪天加一種「會改內文的事件」，要找 9 處；漏一處就是「這個頁面看得到、那個頁面看不到」的錯。
- 建議：匯出一個 `bodyEventsSql`／`bodyEventBefore(...)` 與 `bodiesByHash` 放進 `history/` 內的共用檔。

### 7. AI 執行卡與還原卡是兩份近乎同形的元件
- 現況：`WorkspaceHistoryRunCard.tsx`（195 行）與 `WorkspaceHistoryRewindCard.tsx`（146 行）都有 `showAll`／`sheetOpen`／`picked`／`busy`／`error`／`undone`／`outcome` 七個 state、同樣的「選要撤銷哪幾篇 → Modal → 呼叫 → 結果文字」流程；兩者的 `diff` 約 155 行不同（多半只是文字與 API）。
- 影響：流程只有「呼叫哪個 API、顯示哪段結果」不同，卻要維護兩份狀態機；一方補了錯誤處理另一方容易漏。
- 建議：抽一個「選筆記、確認、撤銷、顯示結果」的卡片（把 API 與文字當參數），兩張卡各約 40 行。

### 8. 還原／撤銷的寫入走 `sendWrite`，但位置在 `lib/history` 而非 `lib/data`
- 現況：`undoAgentRun`、`redoAgentRun`（`workspaceHistoryApi.ts:92-99`）、`rewindWorkspace`、`undoRewind`（`rewindApi.ts:60-76`）4 個寫入直接 `sendWrite`；版本還原 `restoreVersion` 卻在 `lib/data/noteHistoryWriter.ts:12` 用 `onlineOperation`＋寫入生命週期＋本機副本更新；永久刪除 `notePurge.ts:69` 也在 `lib/data`。
- 影響：同一個歷史畫面，三種寫入方式；`sendWrite` 版本沒有「已提交但結果讀失敗」的處理（`noteHistoryWriter.ts:16-18` 的 `awaitingResult`）。因為這四個只改伺服器內容且之後頁面會重讀，**目前沒看到錯誤行為**，但慣例不一致。
- 建議：把這 4 個搬進 `lib/data` 的一個歷史 writer，和 `restoreVersion` 同處。

### 9. 後端少量效能／一致性疑慮（推測，未量測）
- `agentRunsStartedBetween` 每次呼叫都先 `runEvents(workspaceId)` 掃整個工作區所有 AI 事件（`agentRuns.ts:174`），再用時間過濾；feed 每載入一頁就掃一次。
- `agentRunsBetween` 對每個 run 各 `await isRunUndone`（`activity.ts:227`），每次一個查詢，是 N+1。
- 這兩個在資料量大時才會有感；沒有看到量測。

### 10. 測試守得到什麼、守不到什麼
- 有：後端 `historyRewind.integration.test.ts` 19 個案例（四種狀態、無權限、空間、2000 篇上限、撤回衝突、404）；`historyActivity` 46 個；前端 `workspaceHistory*` 約 79 個；`endOfDayInstant` 單測。
- 沒找到：撤權後重送（rewind 內有 `resolveCurrentActor`，但測試檔無 `revok`／`idempot` 相關案例）；同一冪等鍵重送 rewind 的案例；前後端型別對照的合約測試；`lib/history` 差異函式的跨前後端一致性測試。
- eslint：歷史路徑沒有新加的 `eslint-disable`（`components/history` 有 3 條 `react-hooks/exhaustive-deps`：`useLoad.ts:19`、`NoteHistory.tsx:107`、`BlockHistorySheet.tsx:52,57`，都帶理由或是既有模式）；`module-entry` 白名單檔 `eslint-rules/module-entry-allowlist.json` 是 `{}`，沒有新增例外。但沒有專屬規則阻止「第四套段落切分」或「第二套 SQL 可讀條件」出現。

## 做得好、值得保留

- **一個後端入口**：`services/history/index.ts:1-18` 只匯出動作與型別；`httpError.ts:30` 與 `routes/nodes.ts:34` 都從這裡 import，外部沒有人深入 `history/*.ts`；`module-entry` 規則也守著。
- **rewind 的寫入沒有自己的一套**：還原文字走 `updateNode`（`rewind.ts:109`），撤回刪除走 `undeleteNode`／`trashNode`（`127,138,264,285`），全部在 `withEventTransaction`＋`withIdempotencyClaim`（`82-83,243-244`）內，actor 用 `resolveCurrentActor` 在鎖內重讀（`84,245`）。`services/history/*.ts` 與 `routes/history.ts` 沒有任何 `INSERT／UPDATE／DELETE`（grep 為 0）。
- **讀取權限沒有繞路**：`pointInTime`、`rewind.readableNotes`、`agentRuns`、`activity` 全部經 `readableScopeSql`／`readableTrashedNodeIds`／`canReadRetainedNode`（`readPolicy`），空間範圍放在 SQL 內，不是先全拉再過濾（`pointInTime.ts:55`、`rewind.ts:183`）。
- **前端沒有自己 fetch**：`components/history`、`lib/history`、`hooks/useBlockHistory.tsx` 沒有 `fetch`／`queueWrite`；讀走 `reads.history.*`（`lib/data/reads.ts:38-45`），寫走 `sendWrite`。
- **UI 零件走 `components/ui`**：`Menu`／`MenuItem`／`usePopover`（`WorkspaceHistorySpaceMenu.tsx:3`）、`Modal`、`Button` 都用共用元件；空間選擇用一個 context（`historySpace.tsx:11-27`），Feed／圖／刪除清單讀同一個選擇。
- **那天結束／日邊界後端共用**：全部經 `localDay.ts` 的 `sql*` 輔助函式，沒有 `CURRENT_DATE`。
- **rewind 的設計小心**：伺服器重新推導每個 id 屬哪組，過期的標 `stale`，不能寫的標 `unwritable`（`rewind.ts:115-139`），所以送偽造清單也越不過呼叫者自己的權限。
- 還原用 `meta` 標記 `rewind_id`／`undoes_rewind`，撤回是「新操作」不是改歷史（`rewind.ts:16-32`）。

## 不確定、需要人確認

1. **PR #666–#682 的對應**：上面是推測，請確認這些編號是否就是 H1–H7 子 PR；若不是，A 組評分可能要重算。
2. **rewind 沒有走 `restoreEvent`**：它是依時間點用 `updateNode`／`undeleteNode`／`trashNode` 新寫，不是由單一事件還原。這符合「新操作、依目前權限」，但專案規則寫「不新增繞過 `restoreEvent` 的復原旁路」（來自系統附帶的專案規則，我沒有另外讀文件）。請擁有者判斷這算不算旁路（我傾向算「共用寫入路徑、不共用還原路徑」）。
3. **`undoAgentRun`／`redoAgentRun` 沒有自己的 `withEventTransaction`**：它是逐篇呼叫 `updateNode`（`agentRunUndo.ts:281`），每篇各自一個交易，一次呼叫中途失敗會留下「部分已撤銷」。`undoRewind` 則是整批一個交易（`rewind.ts:243`）。兩者語意不同，是故意的嗎？
4. **未合併的重構 PR（#694 #698 #699 #704 #706 #712）**：我沒有讀這些 PR 的內容，所以無法判斷衝突。從檔名看，若其中有動 `readPolicy`、`updateNode`、`lib/data` 的 writer 或 `@onden/markdown` 的，會跟上面問題 1、3、8 的建議重疊；建議合併前先對照。**推測**。
5. 問題 9 的效能是推測，沒有實際資料量與量測。
6. 我沒有跑 `tsc`、測試或瀏覽器，上面的「測試存在」是指檔案與案例名稱，不代表我驗證過它們通過。
