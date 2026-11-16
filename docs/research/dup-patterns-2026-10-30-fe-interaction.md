# 前端互動、手勢、瀏覽器 API：各寫各的盤點（2026-10-30）

> 狀態：歷史紀錄（進行中的盤點／計畫，完成後移到 docs/archive/）（寫於 2026-11-01） 引用的路徑、函式與行號是寫作當時的，現況以程式為準。

範圍：`packages/frontend/src`（含 `modules/`、`lib/ink`）。**只查、只寫報告，沒有改任何程式碼。**
找的是 `npm run dup:check`（逐字複製）與 `npm run dup:names`（同名匯出）抓不到的：同一件事、不同寫法、不同名字。
已有防線與上一輪清單（`dup-sweep-2026-10-29-*.md`）已處理的不重報；手機底部 sheet 已另案統一成 `ui/Sheet`，本報告不含。
行號為 2026-10-29 的 `origin/main`。「違規幾處」是以建議的守門規則在目前程式碼上實際掃出的數量。

## 總表

依「嚴重度高且工作量小」排序。

| # | 概念 | 份數 | 嚴重度 | 工作量 | 守門方式 |
| --- | --- | --- | --- | --- | --- |
| 1 | 離開頁面／切到背景時存檔（`useCardDraft` 只聽 `pagehide`） | 2 條寫法（1 個有缺口） | **高**（手機切 App 丟草稿） | 小 | guard test |
| 2 | 暫時性旗標（「已複製」「錯誤 4 秒後消失」）用裸 `setTimeout` 重設 | 9 處 | **高**（連續錯誤被前一個計時器提早清掉） | 小 | ESLint |
| 3 | 複製到剪貼簿 | 10 處 | **高**（成功／失敗回饋各不同，有靜默失敗） | 小 | ESLint＋guard |
| 4 | 設定對話框自己 `pushState`／`popstate`，違反 `useUrlLocation` 宣告的唯一擁有者 | 2 條 | 中高（返回鍵行為） | 小 | guard test |
| 5 | Esc 關閉／離開的 window `keydown` 監聽（不看是否有彈窗在上層） | 6 處 | 中高 | 中 | guard test |
| 6 | `sessionStorage` 直接用（key 字串複製 5 份、`try` 有無不一） | 7 檔／34 處 | 中 | 小 | ESLint |
| 7 | 回前景／恢復連線時重新檢查（`online`、`visibilitychange`、`focus` 組合各異） | 5 處 | 中 | 中 | guard test |
| 8 | 長按（300／500 ms、位移容忍 8／10、含不含滑鼠、各自吞 click） | 4 處 | 中（手感不一致） | 中 | guard test |
| 9 | 清單鍵盤導覽＋失焦關閉（夾住／循環、略過停用、開啟方式、blur 150 ms） | 8 處 | 中 | 中 | guard test |
| 10 | 內嵌確認框（`role="alertdialog"` 的 `div`，無 Esc、無焦點管理） | 3 處 | 中 | 小 | guard test |
| 11 | 拖曳／指標捕捉（`setPointerCapture` 的 try／`?.` 與位移門檻各自定義） | 7 處捕捉＋6 個門檻 | 中低 | 中 | guard test |
| 12 | 元素尺寸量測（`ResizeObserver`；兩個幾乎一樣的 hook） | 15 處 | 低 | 中 | ESLint＋guard |
| 13 | 防抖自動存檔計時器（400／600／1000／1500／2000 ms 各自） | 5 處 | 低 | 中 | 例外名單 |
| 14 | z-index 魔術數字、`position: fixed` 散在 15 個 CSS | 74 處 z-index | 低（尚無已知錯層） | 大 | guard test（只准減） |
| 15 | 「是不是觸控」三種定義 | 3 種 | 低 | 小 | guard test |
| 16 | `visualViewport` 兩處直接讀 | 2 處 | 低 | 小 | guard test |
| 17 | 震動 `navigator.vibrate` | 2 處 | 低 | 小 | 不另守，併入 #8 |

已查、**沒有**重複（不用處理，列出是為了讓下一輪不必再查）：`localStorage`（`lib/prefs.ts` 唯一，ESLint 已擋，`eslint.config.js:320-334`）；
IME／Enter／Esc 判斷（`lib/keys.ts`，`imeKeys.guard.test.ts` 已擋）；`matchMedia`（`hooks/useIsMobile.ts` 與 `settings/appearance.ts:38` 查的是不同媒體查詢）；
`IntersectionObserver`（4 處用途各異：`JournalScreen.tsx:91` 日記捲動、`PdfCaptureSurfaces.tsx:199` 延遲載入、`embedDom.ts:275`、`noteTitleVisibility.ts:27`）；
捲動鎖定（只有 `ui/Modal.tsx:56`，且有堆疊計數）；focus trap（全由 `<dialog>` 負責，無手寫）；`Notification`（只有 `hooks/useDueSoonNotifications.ts`）。

---

## 1. 離開頁面／切到背景時存檔

- **概念**：頁面要消失（關閉、換頁、手機切 App）前把未存的內容送出。
- **各自的寫法**
  - 唯一入口 `lib/pageHide.ts:4` `onPageHide`（同時聽 `pagehide` 與 `visibilitychange→hidden`；手機切 App 時 `pagehide` 可能根本不觸發）。已用：`modules/rss/readingPosition.ts:31`、`modules/website/studio/useHomeStudio.ts:34`、`components/InkNodeView.tsx:197`、`components/PdfNodeView.tsx:407`、`hooks/useOverviewMode.ts:74`、`lib/pageLayer/useLayerController.ts:28`、`lib/localDb.ts:452`。
  - **`hooks/useCardDraft.ts:89` 只聽 `pagehide`**。手機切到別的 App 時不會送出草稿，只在之後真的關頁才會（也可能永遠不會）。這是缺口，不是風格差異。
  - `lib/data/writeRecovery.ts:17-18` 自己配對 `pagehide`＋`visibilitychange`（已有守門測試過關，但仍是第二份實作）。
  - `lib/persistScheduler.ts:92-93` 聽 `pagehide`＋`beforeunload`、沒有 `visibilitychange`。`beforeunload` 在行動瀏覽器幾乎不觸發。
- **為什麼守門沒抓到**：`shared-helpers.guard.test.ts:49-53` 只抓「同一個檔案同時含 `pagehide` 與 `visibilityState === "hidden"`」；只寫 `pagehide` 的檔案不違規，所以漏洞正好是最危險的那種。
- **建議的唯一入口**：`lib/pageHide.ts` `onPageHide`。`useCardDraft`、`persistScheduler` 改用它；`writeRecovery` 的「引用計數式」註冊可留在原處，但內部改呼叫 `onPageHide`。
- **怎麼擋住**：改成「`"pagehide"`、`"beforeunload"` 字串只准出現在 `lib/pageHide.ts`」。`findUses(sourceFiles("."), /["'](pagehide|beforeunload)["']/, ["lib/pageHide.ts"])`。目前違規 4 處：`useCardDraft.ts:89`、`writeRecovery.ts:17`、`persistScheduler.ts:92-93`（`lib/localDb.ts` 與 `lib/data/connectivity.ts:115` 是對 worker 的轉送，需看是否改用 `onPageHide` 或放例外）。
- **嚴重度**：高。**工作量**：小。

## 2. 暫時性旗標用裸 `setTimeout` 重設

- **概念**：「已複製」「上傳失敗」這類顯示一陣子就消失的狀態。
- **各自的寫法**
  - `components/OverviewEditor.tsx:453, 466, 480, 504, 525`：5 次 `setTimeout(() => setUploadError(null), 4000)`，沒存計時器 id、沒清除。第一個錯誤 3 秒後又來第二個，第二個會在 1 秒後被第一個計時器清掉。元件卸載後也會對已卸載的元件 `setState`。
  - `components/MarkdownRenderer.tsx:79`（1400 ms）、`modules/website/PublishNoteRow.tsx:119`（1500 ms）：同一個「已複製」，時間不同、都沒清除。
  - `components/PdfNodeView.tsx:222`（1400 ms 閃一下）。
  - `components/InboxReview.tsx:356`（5000 ms，有 cleanup，是唯一正確的）；`components/MarkdownEditor.tsx:631`（12 秒，有 cleanup）。
- **建議的唯一入口**：新建 `hooks/useTransientFlag.ts`：`const [on, flash] = useTransientFlag(ms)`；重複呼叫會重新計時、卸載時清除。時間用具名常數（`COPIED_FLASH_MS`、`ERROR_VISIBLE_MS`）。`InboxReview` 的寫法就是正確版本，照它抽。
- **怎麼擋住**：ESLint `no-restricted-syntax`，選擇器抓「setTimeout 的第一個參數是只做 `setX(false|null)` 的箭頭函式」：
  `CallExpression[callee.name=/^(window\.)?setTimeout$/] > ArrowFunctionExpression[body.type='CallExpression'][body.callee.name=/^set[A-Z]/][body.arguments.0.value=/^(false|null)$/]`（細節要調，也可用 guard test 的正規式 `/setTimeout\(\(\) => set\w+\((false|null)\)/`）。目前違規 9 處（OverviewEditor×5、MarkdownRenderer、PublishNoteRow、PdfNodeView:222，加 `components/tagPage/…` 待掃）。
- **嚴重度**：高（OverviewEditor 是真實 bug）。**工作量**：小。

## 3. 複製到剪貼簿

- **概念**：把文字複製並告訴使用者結果。
- **各自的寫法**（`navigator.clipboard` 在前端非測試碼共 12 處）
  - `modules/website/copyUrl.ts:9`：有 `navigator.clipboard?.writeText` 判斷（註解說明 LAN IP 的 HTTP 自架環境下 `clipboard` 是 `undefined`），成功 toast「Copied」(`info`)、失敗 toast「Couldn't copy — select the URL…」。
  - `components/DeviceNotices.tsx:40`、`components/FailedWriteRecovery.tsx:51`：toast「Copied to clipboard」(`success`)，失敗 toast「…select the text…」(`error`)；沒有 `clipboard` 判斷，但被 `try` 包住所以不會崩。
  - `components/MarkdownRenderer.tsx:77`：`void navigator.clipboard?.writeText(text).then(…)`，**沒有 `catch`**：被拒絕就是未處理的 rejection，使用者沒有任何回饋；成功只有按鈕圖示變 1400 ms。
  - `modules/website/PublishNoteRow.tsx:118`：失敗 `{/* clipboard denied */}` 靜默，成功只改按鈕文字 1500 ms。
  - `settings/spacesAndMembers/AddAiRoleWizard.tsx:107`、`HelperKeys.tsx:65`、`SpacesAndMembers.tsx:121`：`addToast(t("Copied"))` 預設類型，失敗處理各自不同。
  - `hooks/useNoteExport.ts:12`、`lib/editorParagraphActions.ts:133`：匯出與段落動作各自取用。
- **不一致後果**：同樣是複製，成功文字有「Copied」「Copied to clipboard」兩種、toast 種類有 `info`／`success`／預設三種；失敗時有的提示手動複製、有的完全沒反應。
- **建議的唯一入口**：把 `modules/website/copyUrl.ts` 升格為 `lib/clipboard.ts` 的 `copyText(text, { what })`：有 `clipboard` 判斷、失敗提示依 `what`（「連結」「文字」）、成功文字統一。需要「按鈕變已複製」的呼叫者拿回傳的 `Promise<boolean>` 再用 #2 的 `useTransientFlag`。
- **怎麼擋住**：ESLint `no-restricted-properties`：`{ object: "navigator", property: "clipboard", message: "用 lib/clipboard 的 copyText" }`（已有 `localStorage` 同型規則可仿，`eslint.config.js:330-334`），`lib/clipboard.ts` 與 `useNoteExport`（需要寫入非文字型別時）放例外。目前違規 10 處。
- **嚴重度**：高（靜默失敗＋文字不一）。**工作量**：小。

## 4. 設定對話框自己管瀏覽器歷史

- **概念**：手機按返回鍵關閉設定。
- **各自的寫法**
  - `hooks/useUrlLocation.ts:112` 的註解宣告「this file is the only owner of the history」，`:139`、`:203` 為 `pushState`，`:181` 為唯一 `popstate` 監聽。
  - `components/SettingsModal.tsx:311` 自己 `pushState({ ondenSettings: 2 })`，`:320` 自己加第二個 `popstate` 監聽。兩份各自維護「現在有沒有推過一筆」的旗標（`pushed.current` 對 `useUrlLocation` 的內部 ref），返回鍵同時觸發兩個 handler，靠狀態物件裡的 `ondenSettings` 鍵彼此不誤判。
  - `components/BuilderWorkspace.tsx:95` 註解提到「place switch = pushState」，實際走 `useUrlLocation`（不算違規）；`lib/pageScrollRestore.ts:18` 提到 Back 路徑須呼叫它，是第三個與歷史綁在一起的人。
- **建議的唯一入口**：`hooks/useUrlLocation.ts` 增加 `useBackDismiss(active, onBack)`（「這個覆蓋層佔用一筆歷史，返回時關閉」），`SettingsModal` 改用。之後其他想用返回鍵關閉的覆蓋層（#10）也用它。
- **怎麼擋住**：guard test：`/\b(pushState|replaceState)\b|["']popstate["']/` 只准出現在 `hooks/useUrlLocation.ts`。目前違規 1 檔（`SettingsModal.tsx:311, 320`）。
- **嚴重度**：中高。**工作量**：小。

## 5. Esc 關閉／離開的 window 層 `keydown` 監聽

- **概念**：按 Esc 離開某個模式（專注、放大、面板）。
- **各自的寫法**（直接 `addEventListener("keydown")` 共 19 處，其中屬於「Esc 離開」的）
  - `hooks/useZenMode.ts:34`：`isEscapeKey && !defaultPrevented`。
  - `hooks/useExpandedPane.ts:73`：同上，另外跳過 `.ui-popover, dialog` 內的事件（`:68`）。
  - `components/SpaceChip.tsx:55`：**只有** `isEscapeKey(e)`，不看 `defaultPrevented`，也不看有沒有彈窗在上層。
  - `components/ShortcutsCheatsheet.tsx:68`、`settings/ShortcutsSetting.tsx:70`、`components/PdfNodeView.tsx:439`（`document` 層，自己忽略欄位與 popover，見 `imeKeys.guard.test.ts` 的 `NO_TEXT_FIELD` 例外）。
  - 另有純快捷鍵類：`components/KnowledgeWorkspace.tsx:559`、`hooks/useCanvasTools.ts:49,71`、`hooks/useCanvasUndo.ts:133`、`modules/review/ReviewPanel.tsx:319`、`hooks/useKeyboardShortcuts.ts:193`（唯一正確的入口，`lib/shortcuts.ts` 註冊）。
- **不一致後果**：在專注模式開著的情況下，打開 `SpaceChip` 的選單再按 Esc——`useZenMode` 看 `defaultPrevented`，`SpaceChip` 不設也不看，兩者會**同時**反應（關選單＋離開專注）。`useExpandedPane` 靠 CSS 選擇器 `.ui-popover, dialog` 猜上層是否有彈窗，換元件就失效。
- **建議的唯一入口**：新建 `hooks/useEscapeKey.ts`：`useEscapeKey(onEscape, { enabled })`，內部維護一個堆疊（仿 `ui/Modal.tsx:33` 的 `openModals`），只有最上層回應，並統一 `defaultPrevented`、IME（`isEscapeKey`）判斷。`useZenMode`、`useExpandedPane`、`SpaceChip`、`ShortcutsCheatsheet` 遷移。
- **怎麼擋住**：guard test：`addEventListener("keydown"` 只准出現在白名單（`hooks/useKeyboardShortcuts.ts`、`hooks/useEscapeKey.ts`、`ui/Modal.tsx`、`hooks/useEyedropper.ts`、`lib/` 下的編輯器外掛等，每個寫理由），其餘一律違規。目前違規約 13 個檔（上列 19 處扣掉白名單）。例外名單只准減少。
- **嚴重度**：中高。**工作量**：中。

## 6. `sessionStorage` 直接用

- **概念**：分頁級的小暫存（游標位置、白板視野、已略過的衝突、重載標記）。
- **各自的寫法**（7 檔、34 處）
  - `components/MarkdownEditor.tsx:973, 1188, 1195, 1210`、`hooks/useWorkspaceFocus.ts:118`、`lib/cursorHandoff.ts:20`：同一個 key `onden.pendingCursor.${id}`、`onden.cursor.${id}` 字串複製 5 份，沒有常數。
  - **`MarkdownEditor.tsx:1188` 的 `getItem` 在 `try` 之外**（`try` 從 `:1194` 才開始）：儲存被封鎖（隱私模式、嵌入頁）時 `getItem` 會丟 `SecurityError`，在 effect 內崩潰。同檔 `:1195` 在 `try` 內；`lib/cursorHandoff.ts:20` 在 `try` 內。
  - JSON 讀寫各自寫：`lib/canvasViewport.ts:29-42`（有驗證）、`hooks/useAttributeConflicts.ts:47,71`（無驗證）、`lib/lazyWithReload.ts:63,102,108,127`（無驗證）、`lib/buildVersion.ts:17,41`。
- **建議的唯一入口**：新建 `lib/sessionPrefs.ts`，與 `lib/prefs.ts` 同型（具名 key 表、`try/catch`、可選 JSON 驗證函式）。
- **怎麼擋住**：ESLint 擴充 `eslint.config.js:320-334` 的 `no-restricted-globals`／`no-restricted-properties` 清單，加入 `sessionStorage`（`lib/sessionPrefs.ts` 例外）。目前違規 7 檔。
- **嚴重度**：中（一處可能崩潰）。**工作量**：小。

## 7. 回前景／恢復連線時重新檢查

- **概念**：使用者回到這個分頁或網路恢復時，重新核對某件事。
- **各自的寫法**
  - `lib/data/connectivity.ts:112-113`：`online`＋`offline`（擁有連線狀態的入口）。
  - `components/LoginGate.tsx:134`：只聽 `online`，不聽可見性。
  - `lib/liveInvalidation.ts:122-123`：`online`＋`visibilitychange`。
  - `lib/syncedPrefStore.ts:152-153`：`online`＋`visibilitychange`（**不**判斷 `visibilityState === "visible"`，隱藏時也會重新讀）。
  - `components/TimeZoneAsk.tsx:30-32`：`visibilitychange`＋`focus`（沒有 `online`）。
  - `hooks/useToday.ts:13`：`visibilitychange`＋計時器。
- **不一致後果**：同一次「手機解鎖後回到 App」，有的重新核對（liveInvalidation）、有的不會（LoginGate 要等網路事件）；有的在隱藏時也白做一次（syncedPrefStore）。
- **建議的唯一入口**：新建 `lib/appResume.ts`：`onAppResume(check, { whenOnline?: boolean })`，只在「可見」或「連線恢復」時呼叫，回傳 undo；`connectivity.ts` 仍擁有連線狀態本身。
- **怎麼擋住**：guard test：`/["'](online|offline|visibilitychange)["']/` 只准在 `lib/data/connectivity.ts`、`lib/pageHide.ts`、`lib/appResume.ts`。目前違規 7 檔（`LoginGate.tsx`、`liveInvalidation.ts`、`syncedPrefStore.ts`、`TimeZoneAsk.tsx`、`useToday.ts`、`lib/data/writeRecovery.ts`、`lib/localDbWorker.ts`；後兩者屬 #1 範圍）。
- **嚴重度**：中。**工作量**：中。

## 8. 長按

- **概念**：手指／滑鼠按住不動一段時間觸發某個動作（選單、拖起、顯示來源）。
- **各自的寫法**

| 位置 | 時間 | 位移容忍 | 觸發裝置 | 吞掉之後的 click | 備註 |
| --- | --- | --- | --- | --- | --- |
| `components/NavLayoutEditor.tsx:15-50` `useLongPress` | 500 ms | 8 px | 滑鼠、觸控、右鍵 `contextmenu` | `onClickCapture` | 被 `InkPresetButton`、`SidebarTagTree`、`MobileNav` 從 `NavLayoutEditor` 匯入（住錯地方） |
| `lib/touchHold.ts:11, 128` | 300 ms | `HOLD_SLOP = 10` | 只有 touch／pen（`:110`） | `swallowNextClick`（`:82`，500 ms） | 另有 `createTouchPressGuard`（`:63`，400 ms） |
| `lib/editorEmbeds.ts:50-51, 104-123` | 500 ms | 10 px | 非滑鼠 | `swallow`（capture） | 自己重寫整套計時器＋位移判斷 |
| `lib/ink/engine.ts:52, 713` | 500 ms | `HOLD_SLOP_PX / scale` | 筆停住修形 | 不適用 | 語意不同，不算重複 |

- **不一致後果**：側欄標籤列用 300 ms 拖起，導覽列用 500 ms 開選單，內嵌預覽 500 ms 且滑鼠不觸發——使用者在三處得到三種手感；容忍位移 8／10 px 沒有理由。
- **建議的唯一入口**：`lib/touchHold.ts` 增加 `HOLD_MS`（已有）＋`createLongPress({ ms, slop, mouse })`，`useLongPress` 與 `editorEmbeds` 改為它的薄包裝；`useLongPress` 搬到 `hooks/useLongPress.ts`。`ink/engine` 的停住修形保留。
- **怎麼擋住**：guard test：名稱符合 `/LONG_PRESS|HOLD_MS|HOLD_SLOP|MOVE_TOLERANCE/` 的常數只准在 `lib/touchHold.ts` 定義。目前違規 3 檔（`NavLayoutEditor.tsx`、`editorEmbeds.ts`，加 `ink/engine.ts` 例外）。
- **嚴重度**：中。**工作量**：中。

## 9. 清單鍵盤導覽與失焦關閉

- **概念**：輸入框＋下拉清單，上下鍵移動、Enter 選取、Esc 關閉。
- **各自的寫法**

| 位置 | 到頭的行為 | 其他 |
| --- | --- | --- |
| `components/PlacePicker.tsx:96-97` | 夾住 | 無 Home／End |
| `components/ParentCombobox.tsx:117-118, 122` | 夾住 | `onBlur` 以 `setTimeout(onClose, 150)` 關閉 |
| `components/TitleTagRow.tsx:146-147, 155` | 夾住 | 同樣 150 ms blur 關閉 |
| `components/TimeZonePicker.tsx:91-92` | 夾住；ArrowDown 在關閉時會開啟，ArrowUp 不會 | — |
| `modules/rss/RssDestinationFields.tsx:93-94` | 夾住 | — |
| `components/OverviewSidebar.tsx:592-593` | 夾住 | 另有樹列導覽 `:534` |
| `components/CommandPalette.tsx:140-146, 185-186` | 夾住，且**略過停用項** | 群組顯示順序 |
| `components/ui/usePopover.ts:114-123` | **循環**，支援 Home／End | 選單用 |

  各自還有「選到的那列捲進視野」：`PlacePicker.tsx:75`、`ParentCombobox.tsx:96`、`TimeZonePicker.tsx:66`、`CommandPalette.tsx:104` 都是同一行 `querySelector(...)?.scrollIntoView?.({ block: "nearest" })`。
  歷史列表另有三份「列上下鍵」：`components/history/WorkspaceHistoryChanges.tsx:140`、`WorkspaceHistoryDeleted.tsx:76`、`OverviewSidebar.tsx:534`。
- **不一致後果**：能不能 Home／End、到頭是停住還是繞圈、停用項會不會被選到，依元件不同；`blur` 延遲 150 ms 是為了讓點選項目先觸發，換元件就不保證，也沒有鍵盤 Tab 離開與觸控的區分。
- **建議的唯一入口**：新建 `hooks/useListNav.ts`：`useListNav({ count, isDisabled, wrap, onChoose, onClose })` 回傳 `{ active, onKeyDown, bindActive }`，內建 IME 判斷、略過停用、`scrollIntoView`。`CommandPalette` 的 `moveIndex` 是最完整的版本，以它為基礎。關閉時機統一用 `usePopover` 的 pointerdown 外點判斷，不再用 blur＋150 ms。
- **怎麼擋住**：guard test：`/key === ["']ArrowDown["']/` 只准出現在 `hooks/useListNav.ts`、`ui/usePopover.ts`、`ui/Tabs.tsx`、`history/*`（滑桿與樹列，需寫理由）、MarkdownEditor 的 keymap。`/setTimeout\([^)]*(close|onClose)[^)]*,\s*\d+\)/` 禁止。目前違規：`ArrowDown` 8 檔、blur 計時器 2 處。
- **嚴重度**：中。**工作量**：中（一次一個元件遷移，可分批）。

## 10. 內嵌確認框

- **概念**：頁面內的「確定要這樣嗎？」小框。
- **各自的寫法**
  - `ui/Modal` 的 `alertdialog`：`ConfirmDialog.tsx:40`、`PurgeDeletedModal.tsx:78`、`history/PurgeBlankNotesDialog.tsx:21`、`settings/SpaceDeleteDialog.tsx:60`（5 個使用者，有焦點管理、Esc、`busy`）。
  - 手寫 `<div role="alertdialog">`：`components/tagPage/MergePanel.tsx:35`、`components/TagDeleteConfirm.tsx:77`、`components/TagMoveConfirm.tsx:34`。這三個**沒有 Esc 處理、沒有初始焦點、沒有 `aria-modal`**，只用 `scrollIntoView`（`MergePanel.tsx:15`、`TagDeleteConfirm.tsx:55`）把自己捲進視野；彼此共用 `schema-lens-*-confirm-pop` 的樣式。
- **不一致後果**：鍵盤使用者按 Esc 對前者有效、對後三者無效；螢幕閱讀器不會被導到確認框。
- **建議的唯一入口**：`components/ui` 新增 `InlineConfirm`（非模態、Esc 取消、初始焦點在安全按鈕、`role="alertdialog"`），三處遷移。
- **怎麼擋住**：guard test：`role="alertdialog"` 只准出現在 `components/ui/`（`Modal.tsx` 與 `InlineConfirm.tsx`）與使用 `<Modal role="alertdialog">` 的呼叫端。目前違規 3 處。
- **嚴重度**：中。**工作量**：小。

## 11. 拖曳／指標捕捉與位移門檻

- **概念**：按下—移動—放開的拖動，以及「移動多遠才算拖，而不是點」。
- **各自的寫法**
  - `setPointerCapture` 共 7 處，保護方式三種：`try { … } catch { /* jsdom */ }`（`components/page/PageImageLayer.tsx:133`、`TextBoxLayer.tsx:225`、`InkColorPicker.tsx:170`、`lib/ink/engine.ts:443`），`?.`（`ui/PaneResizer.tsx:41`、`history/HistorySlider.tsx:39`、`NavLayoutEditor.tsx:65`）。
  - 另有不用捕捉、改掛 `window` 的：`hooks/useSidebarDrag.ts:317-318`、`lib/touchHold.ts:159-160`、`components/PdfNodeView.tsx:343-344`。
  - **`modules/graph/AllCardsGraph.tsx:251-253` 用 `mousedown`／`mousemove`／`mouseup`**，其餘都用 pointer 事件；觸控能不能拖動需實機確認（本報告沒有驗證，只指出寫法不同）。
  - 位移門檻：`PageImageLayer.tsx:47` `MOVE_SLOP_PX = 4`、`TextBoxLayer.tsx:189` 同名同值（逐字重複，但因為是不同檔案的非匯出常數，`dup:names` 不抓）、`BlocksPanel.tsx:14` `DRAG_SLOP_PX = 5`、`useSidebarDrag.ts:292` 內嵌 `< 4`、`NavLayoutEditor.tsx:16` `MOVE_TOLERANCE = 8`、`editorEmbeds.ts:51` `10`、`touchHold.ts:9` `HOLD_SLOP = 10`。
- **建議的唯一入口**：`lib/pointerDrag.ts`：`trackDrag(event, { slop, onMove, onEnd })`，內含捕捉（含 jsdom 保護）、`pointercancel`、門檻；`lib/touchHold.ts` 匯出 `DRAG_SLOP_PX` 作預設。`AllCardsGraph` 改 pointer 事件。
- **怎麼擋住**：guard test：`setPointerCapture` 只准在 `lib/pointerDrag.ts`、`lib/ink/engine.ts`；`/_SLOP(_PX)?\s*=|MOVE_TOLERANCE\s*=/` 的常數定義只准在 `lib/touchHold.ts`／`lib/pointerDrag.ts`。目前違規：捕捉 6 檔、門檻常數 5 檔。
- **嚴重度**：中低。**工作量**：中。

## 12. 元素尺寸量測

- **概念**：知道某個元素現在多寬、多高，變化時更新。
- **各自的寫法**（`new ResizeObserver` 共 15 處）
  - 兩個幾乎相同的 hook：`components/history/useElementWidth.ts:13`（`ResizeObserver`＋`window resize`，`:17`）與 `settings/spacesAndMembers/useContainerWide.ts:15`（只有 `ResizeObserver`）。
  - 判斷環境支援：`AppTopbar.tsx:81`、`OverviewSidebar.tsx:281`、`ui/usePopover.ts:76`、`lib/editorEmptyHint.ts:67` 有 `typeof ResizeObserver === "undefined"` 保護；其餘（`useBoardCamera.ts:59`、`AllCardsGraph.tsx:55`、`PageImageLayer.tsx:65`、`TextBoxLayer.tsx:85`、`InkToolbar.tsx:144`、`CanvasInkLayer.tsx:255`、`PdfViewerHost.tsx:300`、`lib/ink/pageCamera.ts:266`、`InsertMenu.tsx:73`）沒有。
  - 再加 `window.addEventListener("resize")`：`AppTopbar.tsx:87`、`OverviewSidebar.tsx:278`、`usePopover.ts:78`、`useActiveHeading.ts:27`、`lib/paneWidths.ts:93`。
- **建議的唯一入口**：`hooks/useElementSize.ts`（寬高、環境支援判斷），先收斂 `useElementWidth`／`useContainerWide`。其餘需要在同一次回呼做版面計算的（`usePopover`、`InkToolbar`）保留自己的 observer，但經過同一個 `observeSize(el, cb)` 函式（內含支援判斷）。
- **怎麼擋住**：ESLint `no-restricted-syntax`：`NewExpression[callee.name='ResizeObserver']`，`hooks/useElementSize.ts` 例外，其餘列入例外名單（只准減少）。目前違規 15 處（扣掉入口後的例外名單約 14 處）。
- **嚴重度**：低。**工作量**：中。

## 13. 防抖自動存檔計時器

- **概念**：輸入後停一下自動存。
- **各自的寫法**：`components/tagPage/structure/useSchemaDraft.ts:86`（600 ms）、`components/collections/ViewBuilder.tsx:106`（400 ms）、`hooks/useCardDraft.ts:76`（1000 ms，有 `keepalive` 與 `retry`）、`lib/data/draftActions.ts:151`（1500 ms）、`lib/persistScheduler.ts:40`（預設 2000 ms，唯一抽成可重用的）。
- **差異**：只有 `useCardDraft`、`persistScheduler` 在卸載或頁面隱藏時送出；`useSchemaDraft`、`ViewBuilder` 的 `flush` 是否在離開時呼叫，沒有一致的契約（沒逐一驗證，列為待查）。
- **建議的唯一入口**：`lib/persistScheduler.ts` 是現成的；先查它能否承擔 `useSchemaDraft`、`ViewBuilder`（不要預先造新抽象，先驗證能否遷移）。
- **怎麼擋住**：不建議硬擋；用 guard test 把「`setTimeout` 的回呼是 `flush`／`save`」的檔案列為例外名單，只准減少。
- **嚴重度**：低。**工作量**：中。

## 14. z-index 與 `position: fixed`

- **概念**：疊層順序。
- **各自的寫法**：CSS 裡沒有任何 `--z-*` token（`grep -rn "var(--z" --include=*.css` 為 0）。74 個 `z-index: <數字>`：個位數 `1` 出現 12 次、`5` 11 次、`10` 8 次；大數 `20, 22, 30, 31, 40, 41, 50, 60, 100, 120, 200, 300, 350, 400, 420, 900, 999, 1000, 3000, 4000, 9999`。`position: fixed` 在 15 個 CSS 檔共 26 處（`MobileNav.css:9,16`、`OverviewEditor.css:333,405`、`global.css` ×7、`sitePreview.css:3`、`CardNode.css:292` 等）。
- **風險**：例如 `OverviewEditor.css:405` 的 `z-index: 41` 與 `sitePreview.css:3` 的 `30` 是互相不知情的數字，哪個蓋哪個是巧合；手機 sheet 統一後，這會是下一個「疊在 sheet 上方還是下方」的來源。目前沒有已知的使用者可見錯層，所以列低。
- **建議的唯一入口**：`styles/tokens.css`（或現有 token 檔）定義 `--z-sticky`、`--z-overlay`、`--z-modal`、`--z-toast`、`--z-max`，`position: fixed` 的元素優先放進 `components/ui`。
- **怎麼擋住**：guard test 掃 CSS：`/z-index:\s*\d+/` 的檔案內數量不得高於 `scripts/z-index-baseline.json` 的記錄（比照 `dup-baseline.json`，只准減）。目前基準 74。
- **嚴重度**：低。**工作量**：大（要逐一對照疊層順序），建議最後做，且只做新程式碼不准再加。

## 15. 「是不是觸控」的三種定義

- **各自的寫法**：`hooks/useIsMobile.ts:8,18` `(pointer: coarse)`（主要輸入裝置是粗略指標）；`lib/ink/touch.ts:4` `navigator.maxTouchPoints > 0`（任何觸控能力；有觸控螢幕的筆電也是 true）；`pointerType === "touch"`（`lib/touchHold.ts:110`、`editorLinkFollow.ts:342`、`lib/ink/engine.ts:849`，單次事件的來源）。
- **不一致後果**：同一台 2-in-1 筆電，手寫層認為是觸控裝置、選取工具列（`lib/selectionBubble.ts:21`）認為不是。三者語意不同，不一定要合併，但名稱要說清楚。
- **建議**：保留三者，各自改成具名函式（`hasCoarsePrimaryPointer`、`canTouch`、`isTouchEvent`），在 `hooks/useIsMobile.ts` 旁集中說明；`lib/ink/touch.ts` 的呼叫者需確認它真的要「有能力」而不是「主要輸入」。
- **怎麼擋住**：guard test：`maxTouchPoints` 只准在 `lib/ink/touch.ts`。目前違規 0 處（已符合，只是防止擴散）。
- **嚴重度**：低。**工作量**：小。

## 16. `visualViewport`

- `hooks/useVirtualKeyboard.ts:26` 擁有鍵盤高度；`lib/selectionBubble.ts:29-30` 自己再讀一次 `window.visualViewport` 算 `visibleBottom`（與 hook 的 `inset` 同一件事，不同算法）。
- **建議**：`useVirtualKeyboard.ts` 匯出純函式 `visibleViewportBottom()`，`selectionBubble` 改用。
- **怎麼擋住**：guard test：`visualViewport` 只准出現在 `hooks/useVirtualKeyboard.ts`。目前違規 1 處。
- **嚴重度**：低。**工作量**：小。

## 17. 震動

- `lib/touchHold.ts:93`（10 ms）與 `lib/ink/engine.ts:733`（8 ms）各自 `try { navigator.vibrate?.(n) } catch {}`。差異只在毫秒。
- **建議**：`lib/touchHold.ts` 的 `vibrateLift` 改名 `vibrate(ms)` 匯出，`engine` 使用；不另設守門。**嚴重度**：低。**工作量**：小。

---

## 建議的守門總設計

**放 ESLint（語法層，可靠、編輯時就看到）**——規則一律加進 `eslint.config.js` 的 `SRC_SYNTAX_RULES`／既有 `no-restricted-*` 清單（注意 `:215-222` 的警告：覆蓋區塊會取代整份清單，新規則要併進共用常數）：

1. `navigator.clipboard` → `lib/clipboard.ts`（#3）。
2. `sessionStorage` → `lib/sessionPrefs.ts`（#6，與 `localStorage` 同型）。
3. `new ResizeObserver` → `hooks/useElementSize.ts`（#12，先帶例外名單）。
4. `setTimeout(() => setX(false|null), n)` → `useTransientFlag`（#2）。

**放 guard test（跨檔案、字串／結構層）**——新增 `src/test/guards/browser-api.guard.test.ts`，用 `sources.ts` 的 `findUses(sourceFiles("."), pattern, allowed)`，每個規則一個 `it`，`allowed` 是 `Record<檔案, 理由>`：

| 規則 | pattern | 允許的檔案 | 目前違規 |
| --- | --- | --- | --- |
| 離開頁面 | `["'](pagehide\|beforeunload)["']` | `lib/pageHide.ts` | 4 |
| 歷史 | `\b(pushState\|replaceState)\b\|["']popstate["']` | `hooks/useUrlLocation.ts` | 1 檔 |
| 回前景 | `["'](online\|offline\|visibilitychange)["']` | `lib/data/connectivity.ts`、`lib/pageHide.ts`、`lib/appResume.ts` | 7 檔 |
| Esc／快捷鍵 | `addEventListener\(["']keydown` | `hooks/useKeyboardShortcuts.ts`、`hooks/useEscapeKey.ts`、`ui/Modal.tsx`＋其他須逐項寫理由 | 約 13 檔 |
| 清單導覽 | `key === ["']ArrowDown["']` | `hooks/useListNav.ts`、`ui/usePopover.ts`、`ui/Tabs.tsx`＋歷史列表 | 8 檔 |
| 內嵌確認 | `role="alertdialog"` | `components/ui/` | 3 |
| 指標捕捉 | `setPointerCapture` | `lib/pointerDrag.ts`、`lib/ink/engine.ts` | 6 檔 |
| 虛擬鍵盤 | `visualViewport` | `hooks/useVirtualKeyboard.ts` | 1 |
| 觸控能力 | `maxTouchPoints` | `lib/ink/touch.ts` | 0 |

**放「只准減少」的基準檔**：z-index 數量（#14，`scripts/z-index-baseline.json`）。

**例外名單的管理**
- 一律寫在 guard test 檔內的 `Record<檔案, 理由>`（仿 `imeKeys.guard.test.ts` 的 `NO_TEXT_FIELD`），沒有理由的條目不收；不另開 JSON。
- 守門測試同時檢查「名單內的檔案是否仍然違規」：已經不違規的條目要刪掉，名單只會縮小（沿用 `dup:check` 的精神）。
- 每次收斂一條，**同一個 PR** 加對應規則（`AGENTS.md`「收斂一處重複時，同一個 PR 加守門測試」）。

**建議的收斂順序**：#1（修缺口，一個檔案）→ #2（修 OverviewEditor）→ #3 → #4 → #6 → #10 → #5 → #7 → #8 → #9 → #11 → #12 → #13 → 其餘。前 5 項合起來是小工作量、都有使用者可見的錯誤。

## 本次查過的範圍與方法

- 目錄：`packages/frontend/src/` 下的 `components/`（含 `ui/`、`page/`、`history/`、`pdf/`、`tagPage/`）、`hooks/`、`lib/`（含 `ink/`、`data/`、`pageLayer/`）、`modules/`、`settings/`、`styles` 及各 CSS；排除 `*.test.*` 與 `test/`。另讀 `test/guards/sources.ts`、`imeKeys.guard.test.ts`、`shared-helpers.guard.test.ts`、`eslint.config.js`。
- 主要 grep：`addEventListener\(['"]keydown`、`visualViewport`、`localStorage\.`／`sessionStorage\.`、`matchMedia\(`、`new ResizeObserver`／`IntersectionObserver`、`setPointerCapture`、`pushState|popstate`、`addEventListener\(['"](online|offline)`、`visibilitychange`、`pagehide|beforeunload`、`navigator\.vibrate`、`navigator\.clipboard`、`new Notification|Notification\.`、`isEscapeKey|isImeComposing`、`ArrowDown|ArrowUp`、`LONG_PRESS|HOLD_MS|useLongPress`、`scrollIntoView`、`setTimeout\(.*, *[0-9_]{3,}`、`addEventListener\(['"](pointermove|pointerup|touchmove|mousemove)`、`passive: *false`、`role="(dialog|alertdialog)"`、`body\.style`、`position: *fixed`、`z-index: *[0-9]+`、`maxTouchPoints|pointer: coarse|pointerType`。
- 已實際讀過上述各條引用的行號附近程式碼；少數標示「待查」的是沒有逐行確認其卸載行為的項目（#13），以及 `AllCardsGraph` 觸控是否可拖（#11），這兩項未驗證，不要當成已確認的 bug。
- 沒有執行測試、沒有改程式碼；違規數量是用上述 grep 估算，守門測試實作時以 `findUses` 的實際輸出為準。
