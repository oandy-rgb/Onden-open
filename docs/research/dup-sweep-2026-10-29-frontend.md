# 前端功能重複清單（2026-10-29）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：`packages/frontend/src`（不含測試）。後端與跨套件由別的任務掃。jscpd 只抓逐字複製；
這份找的是「同一件事寫了兩套以上」（名稱、寫法不同也算）。位置為掃描當下的 `檔案:行`；
「已收斂」的位置是收斂前的樣子，現況以程式碼為準。掃描由人工 grep 加三路平行盤點，
每條引用都讀過原檔；「未驗證」會標明。

共 **16 組**：本次已收斂 **6 組**（A–F），其餘 10 組分成後續批次（見最後）。

## 本次已收斂（行為一致，或差異已說明）

| # | 做的事 | 收斂前的位置（份數） | 唯一入口 | 行為差異 |
| --- | --- | --- | --- | --- |
| A | 筆記「最近更新在前」排序 | `lib/recentNotes.ts:11`、`hooks/useCommandPalette.ts:372`、`components/InfoTagsTab.tsx:64`、`modules/website/studio/editorData.ts:143`、`components/OverviewSidebar.tsx:154`；升冪 2 份：`modules/read_later/useReadLater.ts:42`、`modules/read_later/tagFunction.ts:15` | `lib/noteOrder.ts` 的 `byUpdatedDesc`／`byUpdatedAsc` | 無（同一個比較式）。`lib/canvasList.ts:27` 與 `editorData.ts:50`（欄位叫 `updatedAt`）型別不同，未動，見 H |
| B | 把 Blob 存成檔案下載 | `lib/noteExport.ts:37`、`hooks/useCanvasExport.ts:37`、`components/TagsPanel.tsx:43`、`settings/registry.tsx:252`（4 份） | `lib/download.ts` 的 `downloadBlob` | 原本各自不同：2 份立刻 revoke、1 份不把連結接到頁面上。統一成「接上頁面＋延遲 1 秒 revoke」（原 `downloadNoteText` 的做法），這是 Firefox／Safari 較穩的寫法；正常瀏覽器看不出差別 |
| C | 0–1 夾限 `clamp01` | `lib/ink/color.ts:6`、`components/InkColorPicker.tsx:16` | `lib/ink/color.ts` 匯出 | 無 |
| D | 位元組轉 hex、SHA-256 hex | `lib/localDbWorker.ts:790`、`lib/data/membershipDigest.ts:24`（摘要，逐字相同）；`lib/uuid.ts:73`、`lib/data/draftActions.ts:125`（轉 hex 迴圈） | `lib/hex.ts` 的 `bytesToHex`、`webCryptoSha256` | 無。worker 版多一個 `TextEncoder` 檢查（所有目標環境本來就有） |
| E | 月份鍵 `YYYY-MM` | `modules/calendar/CalendarLayout.tsx:80`、`modules/daily/JournalScreen.tsx:138` | `lib/localDate.ts` 的 `monthId` | 無 |
| F | 離開頁面時存檔（`pagehide`＋切到背景） | `hooks/useOverviewMode.ts:75`、`lib/pageLayer/useLayerController.ts:28`、`modules/website/studio/useHomeStudio.ts:33`、`components/InkNodeView.tsx:198`、`components/PdfNodeView.tsx:409`、`lib/localDb.ts:450`、`modules/rss/readingPosition.ts:35`（7 份） | `lib/pageHide.ts` 的 `onPageHide` | 無。`lib/data/writeRecovery.ts:14` 是多個寫入共用一對監聽、且是「記為未確認」而非存檔，另一件事，列為例外；`hooks/useCardDraft.ts:89` 只聽 `pagehide`（不聽背景），留給 G |

守門：`src/test/guards/shared-helpers.guard.test.ts`（每組一段，例外都寫理由）。

## 尚未收斂（依價值與風險排序）

### G　`pagehide`／背景存檔的其餘不一致｜價值中、風險中
`hooks/useCardDraft.ts:89` 只聽 `pagehide`，行動裝置切 app 時 `pagehide` 可能不觸發；`useOverviewMode.ts:68` 的註解寫的正是這個風險。改成 `onPageHide` 是**行為改變**（多一個存檔時機），可能是 bug，需要測試證明再改。

### H　排序規則其餘變體｜價值低、風險低
`lib/canvasList.ts:27`（手寫 `<`／`>`、無 `?? ""`）、`modules/website/studio/editorData.ts:50`（`updatedAt`）、`lib/siteFeed.ts:54`（`Date.parse`）。型別或空值處理不同，合併前先決定要不要統一。

### I　複製到剪貼簿＋提示｜價值高、風險中
6 份：`settings/spacesAndMembers/SpacesAndMembers.tsx:121`、`HelperKeys.tsx:65`、`AddAiRoleWizard.tsx:107`、`components/DeviceNotices.tsx:36`、`components/FailedWriteRecovery.tsx:51`、`modules/website/copyUrl.ts:8`。只有 `copyUrl` 處理沒有 clipboard 的情況（區網 HTTP）。提示文字有三種（「Copied」「Copied to clipboard」、info 種類），收斂會改 UI 文字，需先定一句。相關但不同：`hooks/useNoteExport.ts:11`（Safari 的 Promise 寫法）。

### J　下拉清單的鍵盤操作（上下／Enter／Esc）｜價值高、風險高
7 份：`components/PlacePicker.tsx:94`、`ParentCombobox.tsx:117`、`TitleTagRow.tsx:146`、`modules/rss/RssDestinationFields.tsx:93`、`components/TimeZonePicker.tsx:91`、`OverviewSidebar.tsx:585`、`CommandPalette.tsx:181`。Esc 與 Enter 的細節各不同（有的先清空查詢、有的有「已是成員」分支、`CommandPalette` 會循環），另外 `ParentCombobox:122`／`TitleTagRow:155` 的「失焦 150ms 後關閉」也是同一類。`components/ui` 沒有 combobox，是缺口不是繞過。建議先出一個 `useListNav` 的設計草圖（AGENTS.md 要求新公共介面至少兩種草圖）。

### K　長按偵測｜價值中、風險中
3 份：`lib/editorEmbeds.ts:50`、`components/NavLayoutEditor.tsx:15`（已是 `useLongPress` hook）、`components/viewTabs/ViewTabs.tsx:44`。都是 500ms，位移容忍 10／8／無。把 `NavLayoutEditor` 的 hook 升到 `hooks/` 後兩處改用；`ViewTabs` 的取消條件要先追完。`lib/touchHold.ts` 是另一種手勢，不併。

### L　去抖動（debounce）｜價值中、風險中
沒有共用工具，6 份手寫 `setTimeout`：`lib/data/autosave.ts:34`、`hooks/useCardDraft.ts:75`、`components/collections/ViewBuilder.tsx:106`、`hooks/useOverviewSearch.ts:53`、`hooks/useCommandPalette.ts:403`、`hooks/useBlockRefs.ts:94`。後三者形狀相同（延遲後查詢＋取消），可出 `useDebouncedValue`；前三者各帶旗標與合併邏輯，不併。

### M　元素尺寸觀察（ResizeObserver）｜價值低、風險中
`components/history/useElementWidth.ts:13`、`settings/spacesAndMembers/useContainerWide.ts:15`、`components/AllCardsGraph.tsx:55`、`hooks/useBoardCamera.ts:59` 可共用 `useElementSize`；其餘（`PageImageLayer`、`TextBoxLayer`、`InkToolbar`、`AppTopbar`、`OverviewSidebar`、`usePopover`）要自訂回呼，不併。

### N　視窗層 Esc 監聽｜價值中、風險中
`components/SpaceChip.tsx:58` 與 `components/ShortcutsCheatsheet.tsx:49` 都在 `<Modal>` 之外再聽一次 Esc（`Modal` 本來就會關）：疑似多餘，**未驗證**是否有 modal 鍵位守門影響。`hooks/useExpandedPane.ts:70` 與 `components/PdfNodeView.tsx:441` 有逐字相同的 `.ui-popover, dialog` 讓位判斷，可抽 `useEscape`。

### O　列表鍵盤導覽（`[data-row]`）｜價值低、風險低
`components/history/WorkspaceHistoryDeleted.tsx:75` 與 `WorkspaceHistoryChanges.tsx:139` 幾乎逐字相同，抽成一個 helper；`OverviewSidebar.tsx:530` 不同，不併。`ToolbarLayoutEditor.tsx:47`／`NavLayoutEditor.tsx:101` 的 delta 一行只確認到這一行。

### P　其餘小項｜價值低
- `isObj` 型別守衛：`components/siteFrame/siteModel.ts:34`、`modules/website/studio/designModel.ts:13`，另有 `packages/site/src/validate.ts:16`（跨套件，歸跨套件任務）。
- sessionStorage JSON 讀寫：`lib/canvasViewport.ts:25`、`hooks/useAttributeConflicts.ts:42`、`lib/lazyWithReload.ts:60`、`lib/buildVersion.ts:17`、`lib/invite.ts:20`；`onden.cursor.*` 鍵散在 `MarkdownEditor.tsx`、`useWorkspaceFocus.ts`、`lib/cursorHandoff.ts` 三處。錯誤回傳語意不同（`undefined` vs `null`），要先定。
- 視窗邊緣夾限 `Math.max(8, Math.min(x, innerWidth - W))`：`MarkdownEditor.tsx:1598,1627`、`HashtagScopeHint.tsx:24` 等 5 份。
- 其他 `clamp`：`lib/ink/hsv.ts:15`、`lib/history/noteTimeline.ts:104`、`lib/ink/pageZoom.ts:55` 與約 69 處行內 `Math.min(Math.max(`（只是計數，未逐一確認）；不建議大量替換。
- `shallowEqual`（`lib/appStore.ts:147`）與 `sameIds`（`lib/nodeTags.ts:103`）。
- `components/QuickCapture.tsx:146` 用裝置時區組 `HH:mm`，`lib/localDate.ts` 的其他函式用工作區時區：**可能是 bug**，未驗證，先寫測試再決定。
- `cv-empty`「沒有符合的資料」逐字 4 份：`GalleryLayout`、`KanbanLayout`、`TableLayout`、`CalendarLayout`（一行，價值低）。
- 行內確認（兩顆鈕換位）而不走 `confirmDialog`：`RssSourceSheet.tsx:162`、`PhoneHomeStudio.tsx:356`、`ModuleLibrary.tsx:76`、`TitleTagRow.tsx:115`。可能是刻意的 UX，需要產品決定。
- `TagMoveConfirm`、`TagDeleteConfirm`、`tagPage/MergePanel` 三個行內 `alertdialog` 共用同一組樣式，可出一個行內確認元件。
- `MobileNav.tsx:230` 的註解說 `ui/Menu` 不能開在 `ui/Modal` 上，與 `Modal.tsx` 的說法不一致，註解可能過期（未驗證）。
- 直接 `fetch`：只有 SSR／網站端幾處（`siteFeed.ts`、`siteLoad.ts`、`pages/site/search.idx`），且 `API_BASE` 各定義一次；歸跨套件任務。

### 已確認乾淨（不需動）
Toast（單一 `addToast`）、`matchMedia`／行動版判斷（`hooks/useIsMobile.ts`）、點外面關閉（`ui/usePopover.ts`）、事件／背景工作名稱（`eventKinds`／`effectKinds`）、相對時間（`lib/timeLabels.ts`）、`escapeHtml`（`@onden/markdown`）、焦點陷阱（原生 `<dialog>`）。

## 之後可派工的批次（每批一個 PR）

1. **批 2：剪貼簿**（I）。先定提示文字，再做 `copyToClipboard`＋守門。
2. **批 3：離開頁面與 Esc**（G、N、O）。每項先寫能證明差異是 bug 的測試。
3. **批 4：長按＋去抖動**（K、L）。
4. **批 5：下拉清單鍵盤操作**（J）。先出兩種設計草圖與契約。
5. **批 6：小工具收尾**（H、M、P）。
