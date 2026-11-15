# 深模組審查：導覽、資訊欄、設定、建立（2026-10-27）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：#672 #673 #684 #686 #687 #711 #734 #741 #744 #746 #747 #749 #750 #759 #762 #763 #770 #780 #782 #784 #785 #786 #790 #802 #806 #810。
基準：`origin/main`。只讀程式碼，沒有讀任何 .md；不確定的地方標「推測」。
路徑簡寫：前端 `packages/frontend/src` 記為 `FE/`，後端 `packages/backend/src` 記為 `BE/`。

## 一句話結論

**部分算深模組。** 這批最好的部分（#672 並行輸入合併、#746 頁面版面宣告、#734 拿掉白板特例、#684 每帳號一次性提示、#686/#687 的 @ai 都走既有入口）介面小、也走對入口；
但有四個明顯缺口：
(1) 跨空間「移動」的寫入流程在 3 個地方各寫一份（選位置畫面只共用了「選」這一半）；
(2) 資訊欄「段落」分頁自己寫了一套標題解析，而 `@onden/markdown` 已有宣稱「唯一規則」的 `headingAnchors`；
(3) 「一個筆記的關係」被三條路徑各算一次，且關係圖是「同一個圖元件」而不是「同一個關係元件」；
(4) 分頁列（tablist）沒有 `components/ui` 版本，全專案 7 處手刻，這批又多了一處。

## 判定表

| PR（組） | 新模組入口檔 | 介面大小 | 深度 | 整合度 | 判定 |
| --- | --- | --- | --- | --- | --- |
| #672 並行輸入合併 | `BE/services/eventLog/bodyMerge.ts`（改既有 `threeWayMergeBody`） | 對外沒變（仍一個函式）；內部抽出 `mergeRegions`、新增 `mergeChars` | 5 | 5 | 算深模組 |
| #686 #687 @ai 提及＋技能按鈕 | `FE/hooks/useAgentMentions.ts`、`FE/lib/agentMentions.ts`、`FE/lib/mentionHandOff.ts`、`FE/modules/skills/SkillHandoffAction.tsx` | 6 個檔、約 780 行；對外 3 個 hook／2 個函式 | 3 | 4 | 部分算 |
| #673 筆記內找字 | `FE/lib/editorFind.ts`、`FE/lib/findInNote.ts` | 窗口事件＋3 個函式，引擎用 `@codemirror/search` | 4 | 4 | 算深模組 |
| #684 一次性提示每帳號 | `FE/hooks/useHintOnce.ts`、`FE/lib/hintsSeenStore.ts` | `useHintOnce(id, legacy?)` 一個 hook，回 `{show, markSeen}` | 5 | 4 | 算深模組 |
| #750 #759 #784 #749 建立面板／選位置／移動到… | `FE/components/PlacePicker.tsx`、`FE/lib/placeGroups.ts`、`FE/components/MoveToDialog.tsx`、`FE/components/CreateSheet.tsx` | `PlacePicker` 一個元件（groups、current、onPick…）；`placeGroups` 3 個函式 | 4（選位置）／2（移動寫入） | 3 | 部分算 |
| #747 #785 #790 資訊欄分頁＋關係＋關係圖 | `FE/components/NodeInspector.tsx`、`FE/components/InfoRelationsTab.tsx`、`FE/components/LocalGraphLens.tsx`、`FE/lib/noteNeighborhood.ts`、`FE/lib/noteOutline.ts`、`FE/lib/graphFocus.ts` | 資料函式小（`noteNeighborhood` 一個）；元件各自獨立 | 3 | 2 | 部分算 |
| #734 #746 #762 #763 #770 #810 #741 #744 #802 導覽／版面 | `FE/components/shellNavigation.ts`（`pageLayout`）、`FE/lib/createKinds.ts`、`FE/lib/viewSwitch.ts` | `pageLayout(mode)` 一個函式，一個讀取點 | 4 | 4 | 算深模組（有小瑕疵） |
| #780 #782 #786 設定頁 | `FE/settings/DataRow.tsx`、`FE/settings/registry.tsx`、`FE/settings/SettingRenderer.tsx` | `DataRow` 一個元件，6＋2＋3 個呼叫端 | 3 | 3 | 部分算 |
| #806 重新載入守門 | `FE/lib/data/draftActions.ts`（`prepareEditorForReload`）、`FE/lib/lazyWithReload.ts` | 一個函式回 4 種判定 | 4 | 3 | 部分算 |
| #711 隱藏純區塊 id | `packages/markdown/src/blocks.ts`＋`FE/lib/editorBlocks.ts` | 約 95 行，改在 `@onden/markdown` | 4（依 diff 統計，沒逐行審；推測） | 5 | 算深模組 |

（#802 只改 CSS 的 dvh，沒有程式介面可評；#741、#744、#762、#770、#810 都是小調整，歸入導覽／版面一組，沒有新增模組。）

## 逐題回答

1. **「移動到…」選位置畫面是否被選單和建立面板共用同一個元件與同一個移動寫入入口？**
   - 元件：**是**。`PlacePicker` 同時被 `FE/components/MoveToDialog.tsx:135`（選單的移動）與 `FE/components/CreateSheet.tsx:132`（建立面板的「放在」）使用；候選清單都來自 `FE/lib/placeGroups.ts`，底層同一個 `placementCandidates`。
   - 寫入入口：**否**。建立面板是「建立」，不是移動，沒有移動寫入。真正的移動有兩條：同空間改父層走 `nodeActions.assignToGroup`（`FE/components/ContextMenu.tsx:80`，一個入口）；**跨空間移動**則是「預覽 → `spaceApi.move` → `refreshSpaces` → 提示 → 409 時重新預覽」這串流程，**3 處各寫一份**：`FE/components/MoveToDialog.tsx:77,95-103`、`FE/components/SpaceChip.tsx:67,75-82`、`FE/modules/website/usePublishMove.ts:34,48-49`。見問題 1。
   - 同一件事（挑一個筆記當位置）還有 2 個旁支：`FE/components/QuickCapture.tsx:169-173` 自己過濾＋自己畫清單；`FE/components/ParentCombobox.tsx`（「釘到…」，`MoveToDialog.tsx:30` 與 `ParentPicker` 的 3 個呼叫端：`NoteBreadcrumb.tsx:5`、`modules/rss/RssDestinationFields.tsx:10`、`modules/rss/RssNotePickSheet.tsx:3`）。三者都呼叫 `placementCandidates`（規則統一），但清單 UI 有 3 套。

2. **關係圖元件（資訊欄關係分頁、關係圖頁、上下層）是不是一個元件兩個呼叫端？** **不是。**
   - 圖：`AllCardsGraph` 是共用的，全域圖與「完整關係」都用它（`FE/components/LocalGraphLens.tsx:60-79`）——這部分是一個元件、兩種模式。
   - 資訊欄「關係」分頁 `FE/components/InfoRelationsTab.tsx` 是**純文字列表**，沒有用圖元件；它和圖只共用資料函式 `noteNeighborhood`（`FE/lib/noteNeighborhood.ts:25`）。
   - 筆記本文下方的 `FE/components/NoteRelations.tsx` 是第三個「這篇的關係」畫面，自己用另一條路徑（`appStore.selectLinkAdjacency`，`NoteRelations.tsx:127-128`、`FE/lib/appStore.ts:392-444`）算反向連結／外連，子筆記又另外用 `overviewNodes.filter`（`NoteRelations.tsx:129`）。
   - 所以是「一個資料函式、一個圖元件、兩個互不相干的列表元件」。見問題 3。

3. **頁面自己宣告有沒有筆記側欄（#746）是否所有頁面都照做？** **大致是，且做得好。**
   - 單一宣告：`FE/components/shellNavigation.ts:69-83`（`CORE_PAGES[].layout`）＋`:87`（`pageLayout(mode)`，模組畫面一律預設 `full`）；測試 `FE/test/pageLayout.test.ts`。
   - 單一讀取點：只有 `FE/components/BuilderWorkspace.tsx:296` 讀它（`:301,:321,:367,:385`）。全專案 grep 沒有別的地方用 `pageLayout(mode)` 判斷側欄。
   - 瑕疵（小）：`BuilderWorkspace.tsx:367` 與 `:385` 的 `!fullPage` 判斷在 `mode !== "notes"` 的分支裡；目前只有 `notes` 是 `sidebar`，所以這兩個條件**永遠成立或永遠不成立**（推測：死分支），多宣告了一種「非筆記頁也有側欄」的可能。另外 `FE/hooks/useWorkspacePanes.ts:30,43,44` 仍直接比對 `mode === "notes"` 來決定資訊欄，沒有走 `pageLayout`（2 處旁路，見問題 8）。

4. **資訊面板分頁、設定頁各分頁是否共用同一套分頁／列元件（components/ui）？** **否。**
   - `components/ui` 只有 `Button`、`Modal`、`Popover/Menu`、`usePopover`（`FE/components/ui/index.ts`），**沒有 Tabs**。
   - 手刻 `role="tablist"` 的共 7 個檔：`FE/components/NodeInspector.tsx:93`、`LensStrip.tsx`、`TasksMode.tsx`、`history/WorkspaceHistory.tsx`、`collections/CollectionView.tsx`、`modules/website/studio/HomeStudio.tsx`、`modules/website/studio/BlocksPanel.tsx`。#747 的資訊欄是其中之一（它新增了分頁邏輯 `initialInfoTab` 在 `FE/lib/infoPanel.ts`，但 markup 又手刻一次）。
   - 設定頁不是分頁列而是「分類清單＋內容」（`FE/components/SettingsModal.tsx`），內容由 `settings/registry.tsx` 資料驅動、`SettingRenderer` 畫列（這是深的）。但「列」有兩套：`settings-row`（`SettingRenderer.tsx` 5 處、`NavigationSetting`、`ShortcutsSetting`、`registry.tsx:509,649`、`FullBackupSetting.tsx:245,303`、rss／daily 小工具 3 處）與 #786 新增的 `DataRow`（`registry.tsx` 6 處、`FullBackupSetting` 2 處、`TimeSetting` 3 處）。`DataRow` 只覆蓋「資料」頁，同頁的 `FullBackupSetting.tsx:245,303` 還在用舊列。

5. **重新載入守門（#806）是否從 lib/data 的存檔狀態判斷？** **主要是，但多了一份平行記錄。**
   - 判斷在 `FE/lib/data/draftActions.ts:557 prepareEditorForReload`，讀的是 lib/data 內的存檔狀態（進行中的存檔、`pendingSave`、`getLocalCopyState`、`getPendingCount`、`recoveryHolding`）。UI 端 `FE/components/DeviceNotices.tsx` 與 `FE/lib/lazyWithReload.ts` 只拿「判定」，不自己追蹤。這點符合期待。
   - 但它新增了模組級 `failedTexts`（`draftActions.ts:81,301,316`），是「最近一次失敗的存檔文字」的第二份記錄，與既有的 recovery 清單並存；`recoveryHolding`（`FE/lib/data/writeRecovery.ts`）還要 `JSON.parse(write.body)` 取回 markdown／title，等於呼叫端要知道失敗請求的 body 格式。見問題 6。

6. **@ai 提及與技能按鈕是否走既有的 agent／技能入口？** **是。**
   - 讀：`reads.agentMentions.mentionables/sessions/skills/runners`（`FE/hooks/useAgentMentions.ts:48,57`、`FE/hooks/useNoteSkills.ts:21`、`FE/settings/spacesAndMembers/HelperMention.tsx:24`），都在 `lib/data`。
   - 寫：`onlineOperation(...submit...)`（`useAgentMentions.ts:106,125`）與 `sendWrite`（`HelperMention.tsx:34,35,46`），沒有 bare `fetch`、沒有 `queueWrite`。
   - 解析：`findMentions`、`AI_MENTION_ALIAS` 來自 `@onden/markdown`（`FE/lib/agentMentions.ts:8`、`useAgentMentions.ts:2`）；`@onden/markdown` 還新增了 `mentions.ts`（`packages/markdown/src/index.ts:116`）。前端沒有 import unified／remark。
   - 技能按鈕走模組登錄：`FE/modules/skills/index.tsx:39 noteHeaderAction`，核心沒有寫死技能模組的名字；跨模組要編輯器代為送出，用 `FE/lib/mentionHandOff.ts` 的小註冊表。
   - 不呼叫任何語言模型（前端只送 `/api/agent-sessions`）。

7. **一次性提示統一成每帳號記錄（#684）是否所有提示都改用了？** **目前存在的 3 個都改了，沒有漏網。**
   - 使用端 3 個：`FE/components/MarkdownEditor.tsx:472`（hashtag-to-scope）、`FE/components/CommandPalette.tsx:105`（palette-prefix）、`FE/hooks/useWelcomeBanner.ts:29`（welcome）。舊的裝置旗標 `paletteHintDismissed`、`welcomeDismissed` 已標為退休、只由 `useHintOnce` 一次性搬進帳號清單（`FE/lib/prefs.ts:46-52`）。
   - 全專案找不到其他「看過／關掉就不再出現」的 `localStorage`／`PREFS` 旗標。相近但不算同一類的：`FE/lib/prefs.ts:96 inkPenSeen`（遷移用，註解自述 not a hint）、時區詢問（`FE/components/TimeZoneAsk.tsx`，用 `timeZoneAskPref`／`timeZoneAnsweredPref`，自己的帳號偏好，有「答案」不只是「看過」）、`FE/lib/buildVersion.ts:17,41` 的 sessionStorage（每個分頁階段一次，不是每帳號）。
   - 小重複：`FE/lib/hintsSeenStore.ts:20-45` 自己寫了 `load`／`save`（含聯集合併），而同類的 `FE/lib/accountPrefStore.ts createAccountPref` 已被 3 個檔使用（`modules/rss/rssPrefs.ts`、`lib/tasks/journalShutdown.ts`、`lib/timeZonePrefs.ts`）。`hintsSeen` 需要「只增不減」的聯集，可能因此沒用；推測，建議確認。

8. **同一行並行輸入合併（#672）是否在既有的 body merge 模組裡改？** **是。**
   - 改在 `BE/services/eventLog/bodyMerge.ts`：原本內嵌在 `threeWayMergeBody` 裡的區域走訪抽成 `mergeRegions`（`:136`），行層與字元層共用；新增 `mergeChars`（`:182`，上限 `CHAR_MERGE_MAX = 20_000`，`:171`）。對外介面不變（`:196 threeWayMergeBody`），兩個呼叫端（`BE/services/nodeUpdate.ts:253`、`BE/services/eventRestore/restore.ts:155`）都不用改，也沒有第二條合併路徑。
   - 前端只加了通知（`FE/hooks/useBodyConflictNotice.ts`、`FE/lib/bodyConflict.ts`），沒有自己再合併一次。

## 問題清單（依嚴重度）

### 1. 跨空間移動的寫入流程重複 3 份（中高）
- 現況：預覽 → 確認 → `spaceApi.move` → `refreshSpaces` → 提示 → 409 時重新預覽，這個「使用者要完成的事：移到另一個空間」沒有單一入口。
- 證據：`FE/components/MoveToDialog.tsx:77,95-103`、`FE/components/SpaceChip.tsx:67,75-82`（連「Moved to…」提示與 409 後重看都各寫一份）、`FE/modules/website/usePublishMove.ts:34,48-49`（發布用，批次版）。3 個呼叫端 3 個都自己組。`spaceApi` 在 `FE/lib/spaces.ts:155-159`，是端點包裝，不含流程。
- 影響：改 409 處理、成功提示、離線限制時要改 3 處；#784 把「選位置」收斂了，但「移動」本身反而在選單這邊多長了一份。
- 建議：在 `lib/data`（或 `lib/spaces`）做一個 `moveToSpace(nodeId, spaceId)`（含預覽、過期重試、`refreshSpaces`、提示），3 個呼叫端改用它。

### 2. 資訊欄「段落」自己寫標題解析，繞過 `@onden/markdown`（中高）
- 現況：`FE/lib/noteOutline.ts:12-45 extractHeadings` 用自己的 `FENCE`／`HEADING` regex 掃行、`plainHeading` 再用 3 條 regex 去連結與強調；檔頭註解寫「no Markdown engine」。
- 證據：`@onden/markdown` 的 `headingAnchors`（`packages/markdown/src/headingAnchors.ts`，已匯出於 `index.ts:113`）檔頭明講它就是「heading 的唯一規則」，並指出舊做法「line regex 會把 code fence 裡的 `## x` 當標題」。`FE/test/headingAnchorsParity.test.tsx` 只對照渲染器／目錄的 id，**沒有涵蓋 `extractHeadings`**（`FE/test/infoPanel.test.tsx:75` 只測自己）。
- 影響：隱藏的 `key:: value` 標題、`$$` 數學區塊裡的 `## x`、`{tag}`／`^id` 標記，渲染器與 `headingAnchors` 的判斷可能和 `extractHeadings` 不同；而「閱讀視圖用第 index 個 h1–h3」這個對應（`noteOutline.ts` 檔頭）會因此錯位（推測：未實測）。
- 建議：讓 `extractHeadings` 以 `headingAnchors`（或在 `@onden/markdown` 加一個帶行號的版本）為準，並把它加進 parity 測試。

### 3. 「這篇筆記的關係」被算三次，元件不共用（中）
- 現況：資訊欄關係分頁、關係圖「完整關係」、筆記下方 `NoteRelations` 是三個畫面、兩條資料路徑。
- 證據：`FE/lib/noteNeighborhood.ts:25`（用 `drawsInGraph`）vs `FE/components/NoteRelations.tsx:113,127-129` ＋ `FE/lib/appStore.ts:392-444`（用 `countsAsBacklink`＋`overviewNodes`）。`FE/components/NodeInspector.tsx:69` 先算一次 `noteNeighborhood`（只為了 `hasRelations`），`InfoRelationsTab.tsx:28` 再算一次。子筆記清單同時出現在 `InfoRelationsTab.tsx:57-81` 與 `NoteRelations.tsx:136-146`（桌面同畫面兩處）。`noteNeighborhood.ts:3-4` 的註解寫「shared by the info panel's 關係 tab」，已過期（圖也用它）。
- 影響：一種連結（例如「只有排版用的邊」）在三處可能一處有一處沒有；已經有 `edgeRoles` 這個集中規則，但三處各挑不同的謂詞。
- 建議：以 `noteNeighborhood` 為唯一來源，`NoteRelations` 的反向連結／外連改吃它；`hasRelations` 由分頁自己回報或用同一個 memo。

### 4. 分頁列沒有共用元件，全專案 7 份手刻（中）
- 現況與證據：見「逐題回答 4」。#747 又加一份（`FE/components/NodeInspector.tsx:93-107`），另寫 `aria-selected`、tabpanel 的 id 關聯。
- 影響：鍵盤方向鍵、`aria-controls`、手機點擊區的行為要逐份對齊；`NodeInspector` 有 `aria-controls`（`:101`），其他 6 份各自是否有、有沒有方向鍵，我沒有逐一比對（推測：不一致）。
- 建議：在 `components/ui` 加 `Tabs`（`TabList`/`Tab`/`TabPanel`，含方向鍵），先遷移 `NodeInspector` 與 `LensStrip`，其餘之後再收。

### 5. 圖的焦點狀態自己聽 popstate、自己 pushState（中低）
- 現況：`FE/lib/graphFocus.ts:18-20` 自己註冊 `popstate`，`:34-40 recenterGraph` 自己 `history.pushState`；同時 `FE/hooks/useUrlLocation.ts` 另管 URL（#790 還在這裡加了 `getGraphFocus`／`setGraphFocus`）。
- 影響：網址同步有兩個擁有者：兩邊對 `view=graph&focus=` 各管一半，返回鍵行為靠兩處同步。
- 建議：把 `focus` 併進 `useUrlLocation` 的 location 狀態，刪掉 `graphFocus` 的 store。

### 6. 重新載入守門多了第二份「失敗文字」記錄（中低）
- 現況：`FE/lib/data/draftActions.ts:81 failedTexts`（模組級 Map），只為了 `prepareEditorForReload` 查「失敗存檔的文字是否在 recovery 裡」。`FE/lib/data/writeRecovery.ts recoveryHolding` 要解析 `write.body` 的 JSON。
- 影響：recovery 與 `failedTexts` 兩份記錄要同步（`:301,316` 與其他清除點）；少清一處就會多出假的「文字只在記憶體」判定而擋住重新載入。
- 建議：讓 recovery 項目自己帶 `{nodeId, markdown, title}`（已解析的欄位），拿掉 `failedTexts` 與 JSON 解析。

### 7. 建立／移動畫面沒用 `components/ui` 的按鈕（低）
- 證據：`FE/components/CreateSheet.tsx` 6 個 `<button>`、0 個 `Button`／`buttonClass`（`create-sheet-cancel`、`create-sheet-submit`…）；`FE/components/InfoRelationsTab.tsx` 6 個原生 `<button>`、0 個 `Button`。`MoveToDialog.tsx` 與 `MovePreviewSummary.tsx` 有用 `buttonClass`。Modal／Popover 則都正確使用（`CreateSheet.tsx:Modal/Popover`、`MoveToDialog.tsx`）。
- 建議：建立面板的取消／建立改用 `buttonClass`。

### 8. 面板顯示還有 `mode === "notes"` 的旁路與疑似死分支（低）
- 證據：`FE/components/BuilderWorkspace.tsx:367,385`（推測：條件恆定）；`FE/hooks/useWorkspacePanes.ts:30,43,44`（直接比 `mode === "notes"`）。見「逐題回答 3」。
- 建議：用 `pageLayout` 衍生資訊欄的「釘住／可關閉」判斷，刪掉恆定分支。

### 9. 新增了 4 處 lint 例外，沒有新增任何 lint 規則（低）
- 新增：`react-hooks/exhaustive-deps` ×3（`FE/hooks/useAgentMentions.ts:85`、`FE/components/OverviewEditor.tsx:168,175`，來自 #686/#687）；`@ts-expect-error webkitdirectory`（`FE/settings/registry.tsx:484`，#786，合理）。
- 規則：26 個 PR 沒有任何一個改 `eslint.config.js`、`eslint-rules/`、`module-entry-allowlist.json`。既有規則（`reads-through-data`、`writes-through-data`、`modals-through-ui-modal`、禁 unified／remark、禁 bare fetch）有涵蓋這批新程式的主要路徑，這批沒有繞過它們；但「選位置」「分頁列」「跨空間移動」這幾個新邊界沒有規則守。
- 測試缺口：`FE/lib/placeGroups.ts` 的 `movePlaceGroups`／`newNotePlaceGroups`／`tagPlaceGroup` 在測試裡沒有直接測（只被元件間接用到）；`FE/lib/graphRoleForce.ts`、`FE/components/InfoRelationsTab.tsx` 沒有對應測試。

### 10. 兩種「列」並存、一個新增的小頁面級重複（低）
- `DataRow` 與 `settings-row` 並存（見逐題回答 4）。`hintsSeenStore` 與 `createAccountPref` 的重複見逐題回答 7。

## 做得好、值得保留

- **#672**：把行層合併的走訪抽成 `mergeRegions`，字元層直接重用；沒有新開合併路徑，對外簽名不變；有 20,000 字元上限避免昂貴的 diff（`bodyMerge.ts:171`）；只在雙方都「純新增」時合併，改寫仍當衝突（`:182` 註解與 `empty` 檢查）。
- **#746**：把「這頁有沒有筆記側欄」變成頁面自己的一個欄位，單一讀取點，模組頁預設全寬（`shellNavigation.ts:87`），並有測試。
- **#734**：移除導覽裡「白板」的特例（`moduleEntry` 不再回傳 `"canvas"`），改由 `createKinds` 的 `module` 欄位只在匯入時顯示（`FE/lib/createKinds.ts:125`），少了 `openBoard`／`openBoardChooser`／`canvasNeedsBuild` 等一串旗標。
- **#784**：`PlacePicker`＋`placeGroups` 讓「移動」「新筆記放在」「新標籤放在」共用一個元件、同一條 `placementCandidates` 規則；`MovePreviewSummary` 把 `SpaceChip` 與 `MoveToDialog` 重複的「誰會看到／看不到」文字收成一個元件（`SpaceChip.tsx:113`）。
- **#684**：`useHintOnce` 是很好的深模組——呼叫端 3 個、只要一行，內部處理伺服器清單、離線、舊旗標一次性搬移、未登入。
- **#686/#687**：讀寫都走 `lib/data`，解析用 `@onden/markdown`，技能按鈕走模組登錄，不新增伺服器端模型呼叫。
- **#763**：`viewSwitch.ts` 讓「編輯／預覽」的目標、文字、哪些筆記能預覽只有一份，寬版選單、手機 ⋯ 選單、點擊預覽進編輯共用。
- **#673**：用 `@codemirror/search` 的比對引擎，只自訂面板；全域 Ctrl+F、選單、命令面板三個入口共用同一個窗口事件（`FE/lib/findInNote.ts`）。
- **#711**：隱藏純區塊 id 的規則放在 `@onden/markdown`（`packages/markdown/src/blocks.ts`），不是前端另寫。

## 不確定、需要人確認

1. **`withTimeout` 逾時視為安全。** `FE/lib/lazyWithReload.ts:85-88` 在守門逾時時 `resolve(SAFE)`（註解說 pagehide 的 keepalive 會接住）。這是 #806 之前就有的行為，但 #806 新增了「記憶體唯一」的更精確判定，逾時卻仍放行；這是刻意取捨還是遺漏？請確認。
2. **`headingAnchors` 與 `extractHeadings` 的實際差異**我沒有跑測試實測（只讀了程式）；問題 2 的影響是推測。
3. **`BuilderWorkspace.tsx:367,385` 是否真的是死分支**取決於 `AppMode` 是否還有 `pageLayout` 回傳 `"sidebar"` 的非 `notes` 值；目前 `CORE_PAGES` 只有 `notes`。
4. **`hintsSeenStore` 不用 `createAccountPref` 是否有意**（聯集語意）；若是，建議在檔頭寫一句原因。
5. **與上次審查的重構 PR（#694 #698 #699 #704 #706 #712）的衝突風險**（它們不在 main 上，我沒有讀這些 PR 的內容，以下僅依檔案推測）：
   - 若其中有收斂跨空間移動、分頁元件或關係資料的 PR，這批新增的 `MoveToDialog`（跨空間流程）、`NodeInspector` 手刻 tablist、`InfoRelationsTab`／`NoteRelations` 兩條資料路徑會讓它們更難合併或需要補遷移。
   - `FE/lib/data/draftActions.ts` 與 `FE/lib/data/writeRecovery.ts` 被 #806 大幅擴寫（約 +120 行）；若重構 PR 動到草稿或 recovery，衝突機率高。
6. 本報告沒有審 #741（標籤頁整理）、#744（筆記頁邊距設定）、#749（桌面只用快捷鍵捕捉）、#762、#770、#780（功能頁整理的細節）、#802（CSS）的內部邏輯，只確認它們沒有新增模組入口或繞路（僅看 diff 統計與檔名）。
