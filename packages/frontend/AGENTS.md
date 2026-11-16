# 前端（packages/frontend）

全域規則、保存與錯誤契約、UI 文字規則在[根目錄 AGENTS.md](../../AGENTS.md)，這裡不重複。
這份只回答「在這裡要做 X，一律用 Y」。路徑相對 `src/`；最後一欄是擋住它的守門測試（`src/test/guards/`），
違規會在那裡失敗並指出該用誰。**寫新的工具函式前先看這張表；表上有的不要再寫一份。**

## 這件事歸誰管（手寫；每列都有守門測試）

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 顯示筆記標題（沒標題時的「未命名」） | `lib/noteLabel.ts` 的 `displayTitle`／`untitledTitle` | `dup-owners.guard.test.ts` |
| 同層筆記排序、搬動時算新鍵 | `lib/childOrder.ts` 的 `compareChildren`／`sortChildren`／`planSiblingOrder`（鍵用 `@onden/markdown` 的 `keyBetween`；不挑整數、不重編鄰居） | `dup-owners.guard.test.ts` |
| 依標題過濾、排名 | `lib/noteSearch.ts` 的 `matchTitle`／`rankByTitle`（搜尋整體走 `lib/data/noteSearch.ts`） | `dup-owners.guard.test.ts`、`noteSearch.guard.test.ts` |
| 「這則筆記有標籤 X」 | `lib/nodeTags.ts` 的 `nodeHasTag`／`nodeTagIds` | `dup-owners.guard.test.ts` |
| 標籤名去掉開頭 `#` | `lib/hashtags.ts` 的 `tagName`／`tagQuery` | `dup-owners.guard.test.ts` |
| 清單要不要列出某筆記 | `lib/nodeTags.ts` 的 `isShownNote`／`listsAsNote` | `dup-b2-logic.guard.test.ts` |
| 工作區的「現在」「今天」 | `lib/localDate.ts`（頁面用 `hooks/useToday.ts`） | `dup-b2-logic.guard.test.ts` |
| 沿 `parent_id` 往上走 | `lib/treeWalk.ts` | `dup-b2-logic.guard.test.ts` |
| 句子裡的數量（「3 則筆記」） | `lib/i18n.ts` 的 `tn` | `dup-b2-logic.guard.test.ts` |
| 前端自己產生 id | `lib/uuid.ts` 的 `randomUUID` | `dup-b2-logic.guard.test.ts` |
| 「誰可以做什麼」 | `lib/capabilities.ts` | `dup-b2-logic.guard.test.ts` |
| 「這則筆記有白板」 | `lib/whiteboardNote.ts` | `dup-b2-logic.guard.test.ts` |
| 隨帳號同步的偏好（`createAccountPref`） | 每個 spec 必須寫 `follows`：`"account"`（每台裝置同一個選擇）或 `"deviceKind"`（只對某種螢幕有意義的版面選擇，手機／桌面各存一份）。只對一種螢幕有意義的偏好，絕不原樣跟著帳號到另一種裝置；`lib/prefs.ts` 的 `"account"` 範圍只是「這個瀏覽器裡各帳號的本機副本」，不會同步，兩者不要混用 | `accountPrefs.guard.test.ts` |
| 離開頁面時存檔 | `lib/pageHide.ts` 的 `onPageHide` | `interactionOwners.guard.test.ts`、`shared-helpers.guard.test.ts` |
| 回到前景重新檢查 | `lib/appResume.ts`（連線狀態 `lib/data/connectivity.ts`） | `dup-b2-interaction-a.guard.test.ts` |
| 複製到剪貼簿 | `lib/clipboard.ts` | `interactionOwners.guard.test.ts` |
| 一段時間後自己復位的旗標 | `hooks/useTransientFlag.ts` | `interactionOwners.guard.test.ts` |
| 按 Esc／「返回」離開一個面板、模式或浮層 | `hooks/useEscapeKey.ts`（`useDismiss`；選單與 Popover 已內建） | `dup-b2-interaction-a.guard.test.ts`、`dismissStack.guard.test.ts` |
| 改網址、`pushState`、`popstate` | `hooks/useUrlLocation.ts` | `dup-b2-interaction-a.guard.test.ts` |
| 長按與震動 | `hooks/useLongPress.ts`、`lib/touchHold.ts` | `dup-b2-interaction-b.guard.test.ts` |
| 拖著東西停在收合的列上自動展開（側欄筆記樹、標籤清單） | `lib/springOpen.ts` 的 `createSpringOpen`（由 `hooks/useSidebarDrag.ts` 擁有；暫時展開不寫進偏好） | `springOpen.guard.test.ts` |
| 指標拖曳、`setPointerCapture`、拖動門檻 | `lib/pointerDrag.ts` | `dup-b2-interaction-b.guard.test.ts` |
| 量元素大小 | `lib/observeSize.ts` | `dup-b2-interaction-b.guard.test.ts` |
| 輸入框驅動的清單用方向鍵 | `lib/listNav.ts` 的 `stepActive` | `dup-b2-interaction-b.guard.test.ts` |
| 自動儲存的延遲 | `lib/persistScheduler.ts` 的 `createSaveDebounce` | `dup-b2-interaction-b.guard.test.ts` |
| 把東西存成檔案下載 | `lib/download.ts` 的 `downloadBlob` | `shared-helpers.guard.test.ts` |
| 位元組轉 hex、SHA-256 | `lib/hex.ts` | `shared-helpers.guard.test.ts` |
| 月份鍵 `YYYY-MM` | `lib/localDate.ts` 的 `monthId` | `shared-helpers.guard.test.ts` |
| 最近更新排序 | `lib/noteOrder.ts` 的 `byUpdatedDesc` | `shared-helpers.guard.test.ts` |
| 搬到另一個空間 | `lib/moveToSpace.ts` | `nav-ui.guard.test.ts` |
| 分頁列、對話框、底部面板、開關、錯誤欄位、關閉鈕 | `components/ui`（見該資料夾的 AGENTS.md） | `ui-owners.guard.test.ts`、`dup-b2-ui.guard.test.ts`、`nav-ui.guard.test.ts`、`sheet.guard.test.ts` |
| 渲染 Markdown | 只由 surfaces 檔匯入 `MarkdownRenderer` | `dup-b2-text.guard.test.ts` |
| 搜尋結果的高亮 | `SnippetText`（不自己寫 `<mark>`） | `dup-b2-text.guard.test.ts` |
| 錯誤與提示的用字（「需要連線」「複製」「AI」） | `lib/i18n.zh-TW.ts` 既有句型 | `dup-b2-wording.guard.test.ts`、`wording.guard.test.ts` |
| 手機上寫筆記時焦點、游標、捲動歸編輯器：游標在鍵盤與工具列上方、按浮層／工具列不搶焦點、點不在文字上的地方游標只落一次 | `lib/editorKeyboard.ts`（編輯器端）＋ `lib/editorTouch.ts`（點擊落點）＋ `hooks/useEditorKeyboard.ts`（React 端）；只有它們碰 `EditorView.scrollMargins` 與 `useVirtualKeyboard`（`components/ui` 的浮層除外）；保焦點用 `components/ui` 的 `keepFocus`／`useInlinePopover`，不手寫 `onMouseDown preventDefault` | `allowlist.guard.test.ts`（`fe-keyboard-state`、`fe-editor-scroll-margin`、`fe-focus-steal-guard`） |
| 三個入口頁（index.astro、index.html、browser.html）共用的 `<head>` | `appShell/head.ts`（入口頁只放 `<AppHead />` 或 `<!-- app-head -->`；各入口差異是 head.ts 裡的選項） | `appShell.guard.test.ts` |
| 讀寫伺服器 | `lib/data`（只從 `lib/data` 匯入，見該資料夾的 AGENTS.md） | `packages/frontend/eslint.boundaries.config.js` |

## 平台全域物件、原生元素與 CSS（從 `allowlist/owners.ts` 產生，不要手改）

跑 `npm run agents:tables`（在 repo 根目錄）更新；`agentsTables.guard.test.ts` 會比對。

<!-- generated:owners -->
資料來源：`src/test/guards/allowlist/owners.ts`、`allowlist/css.ts`。`scripts/allowlist-baseline.json` 已清零並維持空（嚴格模式），任何違規直接失敗。

| 要用的全域物件 | 只准這些檔案用 | 其他地方改用 |
| --- | --- | --- |
| `window` | `lib/`、`hooks/`、`components/ui/`、`main.tsx` | 要碰瀏覽器的 window／document（事件、捲動、焦點）；要把整個 App 掛到網頁上（只有開機那一處） |
| `document` | `lib/`、`hooks/`、`components/ui/`、`main.tsx` | 要碰瀏覽器的 window／document（事件、捲動、焦點）；要把整個 App 掛到網頁上（只有開機那一處） |
| `navigator` | `lib/clipboard.ts`、`lib/ink/touch.ts`、`lib/haptics.ts`、`lib/storagePersist.ts`、`lib/pushBrowser.ts`、`lib/i18n.ts`、`lib/shortcuts.ts`、`lib/browserNetwork.ts`、`lib/webLock.ts` | 要知道現在有沒有網路、何時恢復連線；要複製文字到剪貼簿；要判斷裝置有沒有觸控螢幕、或讓手機輕震一下；要登記或比對鍵盤快捷鍵、顯示平台對應的按鍵提示；要請瀏覽器把本機資料標成「不要自動清掉」，或問 service worker 狀態；要判斷瀏覽器能不能收推播（Brave、iOS 的特例）；要知道裝置的語言；要讓同一個動作在多個分頁裡不同時執行 |
| `history` | `hooks/useUrlLocation.ts`、`lib/pageUrl.ts` | 要讀或改網址列（目前在哪個畫面、哪則筆記；外部帶進來的一次性參數） |
| `location` | `hooks/useUrlLocation.ts`、`lib/pageUrl.ts`、`lib/api.ts` | 要讀或改網址列（目前在哪個畫面、哪則筆記；外部帶進來的一次性參數）；要知道伺服器位址或呼叫伺服器 API |
| `crypto` | `lib/uuid.ts`、`lib/hex.ts` | 要產生新的 UUID（用戶端建立的 id）；要把位元組轉 hex，或算 SHA-256 |
| `localStorage` | `lib/prefs.ts`、`lib/accountStorage.ts` | 要記住一個本機偏好設定（帳號分區）；要存「某帳號在這台裝置上」的本機資料（含舊版資料的認領） |
| `sessionStorage` | `lib/sessionPrefs.ts` | 要記住只在這個分頁有效的暫存狀態 |
| `matchMedia` | `lib/mediaQuery.ts` | 要依螢幕寬度切換版面（手機／平板／桌面）；要套用外觀（淺色／深色／跟隨系統）並隨系統即時切換 |
| `visualViewport` | `hooks/useVirtualKeyboard.ts` | 要知道手機螢幕鍵盤有沒有開、占了多少高度 |
| `ResizeObserver` | `lib/observeSize.ts` | 要在元素大小改變時得到通知 |
| `IntersectionObserver` | `lib/noteTitleVisibility.ts`、`lib/embedDom.ts` | 要在元素進入或離開可視範圍時得到通知 |
| `setPointerCapture` | `lib/pointerDrag.ts` | 要在拖曳時鎖住指標（pointer capture）與判斷拖曳門檻 |

| CSS／JSX 規則 | 內容 |
| --- | --- |
| 原生元素（`<button>`、`<input>`…） | 只准 `components/ui/` 裡寫；畫面用其中的元件 |
| `position: fixed` | 只准 `components/ui/` |
| `@media` 寬度 | 只准 600／900／1280px |
| 顏色、圓角、陰影、`z-index`、字級 | 只准 `var(--token)`，不寫字面值（例外檔見下） |

| 不受 CSS 規則約束的樣式 | 理由 |
| --- | --- |
| `styles/tokens.css` | defines the tokens the rules ask everyone else to use |
| `styles/theme-tokens.css` | defines the tokens the rules ask everyone else to use |
| `styles/site-tokens.css` | published-site look is frozen; it does not follow app tokens |
| `styles/published-site.css` | published-site look is frozen; it does not follow app tokens |
| `styles/print-export.css` | paper for the PDF print window (fixed print colours and pt sizes on white); not the app theme, never loaded by the app |
| `components/siteFrame/` | published-site look is frozen; it does not follow app tokens |
<!-- /generated -->

## 測試

```
cd packages/frontend
npx tsc --noEmit && npm run lint && npx vitest run   # 4 個 worker、happy-dom（vitest.config.ts）；要用 jsdom 的檔案第一行寫 // @vitest-environment jsdom
npm run build   # 影響載入或建置時
npx vitest run src/test/guards   # 只跑守門
```

守門失敗的訊息會寫該改用誰；不要靠加基準或例外過關（規則見根目錄 AGENTS.md「允許清單守門」）。
