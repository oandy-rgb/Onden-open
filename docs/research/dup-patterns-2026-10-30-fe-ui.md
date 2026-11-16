# 前端介面「各寫各的」盤點（2026-10-30）

> 狀態：歷史紀錄（進行中的盤點／計畫，完成後移到 docs/archive/）（寫於 2026-11-01） 引用的路徑、函式與行號是寫作當時的，現況以程式為準。

範圍：`packages/frontend/src`（含 `modules/`），只看介面元件與樣式。後端、跨套件、資料層由別的任務掃。
**只查、只寫報告，沒改任何程式碼。**

jscpd（`dup:check`）與同名檢查（`dup:names`）只抓逐字複製與同名匯出。這份找的是它們抓不到的：
**同一件事、不同寫法、不同名字**。上一輪（`dup-sweep-2026-10-29-*.md`）已列的項目不重報；手機底部 sheet 已另案統一成
`ui/Sheet`，這裡不查。

方法：先 grep 全目錄找候選，再逐一讀原檔確認；每一條至少有兩份實際的 `檔案:行`。行號是 2026-10-29 `origin/main`
當下的樣子。凡是「由程式碼推論、沒有在真機或瀏覽器重現」的，在該條明寫「未驗證」。沒有跑任何測試（沒改程式）。

## 總表

依「嚴重度高且工作量小」排序。份數是實際找到的處數。

| # | 概念 | 份數 | 嚴重度 | 工作量 | 守門方式 |
| --- | --- | --- | --- | --- | --- |
| 1 | 手機輸入框「16px 防 iOS 縮放」被各自的 class 蓋掉 | 約 19 個輸入 class；全域規則 1 條 | 高 | 小 | guard test（解析 CSS＋TSX） |
| 2 | 固定在角落的通知／橫幅沒有放進 modal 頂層，開著對話框時被蓋住 | 3 個（含「寫入失敗救援」橫幅） | 高 | 小 | guard test（`position: fixed` 白名單） |
| 3 | 開關（switch） | 6 份（4 個按鈕版、2 個 checkbox 版） | 中 | 小 | ESLint `no-restricted-syntax` |
| 4 | 空狀態（沒有資料時的文字／畫面） | 76 處手刻 vs 4 處 `EmptyState` | 中 | 中 | guard test（只減不增） |
| 5 | 行內錯誤文字 | 9 組 class，色／字級／後備色各異 | 中 | 小 | guard test＋ESLint |
| 6 | 關閉（X）鈕與圖示鈕尺寸 | 14 個 close/icon class，26～44px | 中 | 中 | ESLint（`:has`）＋guard test |
| 7 | 「手機版」斷點（600／640／720／768／900／1024） | 59 個 CSS 檔、21 處非標準 max-width | 中 | 中 | guard test（斷點白名單） |
| 8 | focus ring（焦點外框） | 58 條手寫 `outline`、44 條 `outline: none`、token 只用 1 次 | 中 | 中 | guard test（只減不增） |
| 9 | z-index 沒有層級表 | 71 個宣告、34 個檔、30 種值 | 中 | 中 | guard test＋新增 token |
| 10 | 浮在內容上的小面板（泡泡選單、提示、候選清單） | 8 份 | 中 | 中～大 | guard test（`position: fixed` 白名單） |
| 11 | 色彩 token 三種拼法＋寫死的後備 hex | 341／73／43 次三種 accent；67 個 hex 後備 | 低 | 大 | guard test（基準線只減不增） |
| 12 | chip／徽章／膠囊 | 13 種各自的 class | 低 | 中 | guard test（新增限制） |
| 13 | 載入中（文字、旋轉、骨架） | 3 套＋1 套沒人用 | 低 | 小 | guard test |
| 14 | 重複的 `@keyframes`、沒人用的 CSS | 3 組重複、1 組死碼 | 低 | 小 | guard test |
| 15 | 圓角／陰影／hover 底色／字級後備值寫死 | 456 個 px 圓角、38 個陰影、6 種 hover 底、22 個 `0.9rem` 後備 | 低 | 大 | guard test（基準線只減不增） |

---

## 1. 手機輸入框「16px 防 iOS 縮放」被各自的 class 蓋掉（高／小）

- **概念**：iOS Safari 在輸入框字級小於 16px 時，聚焦會自動放大整個頁面。要在手機把所有可輸入的東西字級墊到 16px。
- **各自的寫法**：
  - `styles/global.css:975-987`：在 `@media (max-width: 1024px)` 裡對 `input, textarea, select, …` 寫
    `font-size: max(16px, var(--onden-text-base))`。這是**元素選擇器**，權重 (0,0,1)。
  - 但各輸入框自己的 class 規則（權重 (0,1,0)）又寫了一次字級，**蓋掉全域規則**。這些 class 都沒有手機覆寫
    （逐一 grep 過）：
    - `components/NodeAttributesPanel.css:293`（`.attr-input`，行 294：11px）
    - `components/CardNode.css:134`（`.card-node-title-input`，行 137：12px）
    - `modules/rss/RssReaderPanel.css:35`（`.rss-subscribe-input`，行 42：12px，手機 RSS 的訂閱框）
    - `styles/sidebar.css:71`（`.sidebar-tag-new-input`，行 75：12px）
    - `components/ServerSetup.css:19`（`.server-setup-input`，行 22：13px，第一次連線畫面）
    - `components/collections/CollectionView.css:725`（`.cv-quickadd-input`，行 732：13px）
    - `components/OverviewSidebar.css:166`（`.sb-rename-input`，行 171：13px）
    - `components/viewTabs/ViewTabs.css:62`（`.view-tab-rename`，行 72：13px）
    - `modules/capture/QuickCapture.css:68`（`.quick-capture-textarea`，行 78：15px）
    - 另有 `.tag-fn-picker-search`、`.title-tag-input`、`.cv-groupby-select`、`.cv-kanban-move-select`、
      `.rss-sheet-select`（0.92rem）、`.bubble-link-input`、`.schema-field-options`、`.tk-sheet-title`（1.1em）等。
  - **已經有人用「class 內自己寫 16px」解決**的是另一套寫法：`components/PlacePicker.css:10`、
    `components/CreateSheet.css:43`、`components/ParagraphMenu.css:19`、`modules/tasks/QuickAddTask.css:38`、
    `components/MoveToDialog.css:37`、`styles/global.css:956`。同一件事三種寫法：全域列清單、class 內寫 `max(16px, …)`、
    class 內寫 `calc(base * 16 / 14)`。
  - 全域清單裡的 `.quick-capture-input`（`styles/global.css:983`）**是不存在的 class**：實際 class 叫
    `quick-capture-textarea`（`modules/capture/QuickCapture.tsx:480`），改名後清單沒跟上。結果「快速記錄」這個手機最常用的輸入框
    是 15px，會縮放。
  - `.obsidian-search-input` 同時在 `components/ObsidianImport.css`（13px）與全域清單出現，同權重，誰贏看載入順序，**未驗證**。
- **已造成的不一致**：手機上點這些輸入框，頁面會自己放大（預期：不會）。這是使用者看得到的問題，且為推論（由 CSS 層疊規則推出，
  **未在 iOS 真機驗證**）。
- **建議的唯一入口**：不要再靠「清單＋各自寫」。在 `styles/tokens.css` 新增 `--ac-fs-input: max(16px, var(--ac-fs-base))`，
  用 `@media (pointer: coarse)` 對 `input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
  textarea, select` 寫一條 `font-size: var(--ac-fs-input) !important`（這是少數該用 `!important` 的地方：它要贏過所有 class 規則）。
  刪掉各處的手機 16px 補丁與全域清單。另外「手機」用 `pointer: coarse` 而不是 `max-width: 1024px`，平板橫放也涵蓋。
- **怎麼擋住**：guard test `src/test/guards/input-font.guard.test.ts`。用 `sources.ts` 的方式掃 `.tsx`，抓出所有帶 `className`
  的 `<input|textarea|select>`（排除 checkbox／radio／file／range／color／hidden）；再讀所有 `.css`，對這些 class 的規則
  若有 `font-size` 且值不含 `16px`／`--ac-fs-input` 就列為違規。目前違規約 19 個；若採「全域 `!important`」方案，守門改成：
  「輸入框 class 規則不准寫 `font-size`，除非列在例外清單並寫理由（例如標題大字）」，違規約 19 個要先收斂或放例外。
  需要新增一個 `cssFiles()` helper 到 `sources.ts`（現在只掃 ts／tsx）。
- **嚴重度／工作量**：高／小（改一條規則、刪約 10 行補丁）。

## 2. 固定在角落的通知／橫幅沒進 modal 頂層（高／小）

- **概念**：浮在畫面角落、不屬於任何對話框的通知（寫入失敗救援、裝置提示、旅行時區詢問）。
- **各自的寫法**：
  - `ui/Modal` 用原生 `<dialog>.showModal()`（`components/ui/Modal.tsx:125,143,147`），所以開著對話框時，頁面上所有東西
    （不管 z-index 多大）都被蓋在「頂層」之下。`components/ui/surfaceHost.ts` 的 `floatingHost()`、`useTopModalLayer()` 就是為此：
    讓選單、popover 與 toast 渲染進最上層的 modal 裡。
  - `components/ToastStack.tsx:88,101` 有用（「Settings 開著時 toast 的『復原』仍可按」）；`ui/Popover` 也有用。
  - 但同樣是角落通知的這三個**沒有用，只靠 `position: fixed` 加 z-index**：
    - `components/FailedWriteRecovery.css:10-14`（z-index 420，註解寫「above toasts (400) — it outlives them」），
      渲染處 `components/workspace/WorkspaceOverlays.tsx:63`。這是**寫入失敗時保存使用者未存內容的橫幅**。
    - `components/DeviceNotices.css:4-8`（z-index 60），渲染處 `components/BuilderWorkspace.tsx:300`。
    - `components/TimeZoneAsk.css:3-6`（z-index 350），渲染處 `components/workspace/WorkspaceOverlays.tsx:54`。
  - 這三個的 z-index 數字沒有任何作用（頂層會蓋過），而且三者的數字（60／350／420）與 toast 的 400 互相「比大小」，
    暗示作者以為 z-index 能贏過 modal。
- **已造成的不一致**：推論——使用者在設定、搬移、確認刪除等對話框開著時，寫入失敗，救援橫幅（含「複製未存內容」）
  被蓋在對話框下面看不到也按不到，而 toast 可以。**未在瀏覽器驗證**，但由 `showModal()` 的頂層行為可直接推出。
- **建議的唯一入口**：做一個 `ui/Floating`（或讓 `ToastStack` 的 portal 邏輯抽出一個 `<TopLayerPortal>`），這三個都包進去。
  不需要新概念：`floatingHost()` 已存在。
- **怎麼擋住**：guard test：`position: fixed` 只准出現在白名單檔（`ui/ui.css`、全螢幕遮罩如 `AppErrorBoundary`、
  `ExpandPaneButton`、`MobileNav`）；其餘出現就失敗。目前 `position: fixed` 出現在 15 個 CSS 檔
  （`ui.css` 之外 14 個），白名單先放整批現況、只准減少。對照規則：白名單內「通知類」（上面三個）的 TSX 必須 import
  `TopLayerPortal`——可用 guard test 檢查「CSS 有 `position: fixed` 的 class，其 TSX 檔含 `role="status"|"alert"` 則必須含
  `floatingHost|TopLayerPortal`」。
- **嚴重度／工作量**：高（遺失未存內容橫幅的可見度）／小。

## 3. 開關（switch）（中／小）

- **概念**：二選一的開／關控制。
- **各自的寫法**：
  - 按鈕版，三個一模一樣的本機 `Switch` 函式，都套 `.settings-toggle` + `.settings-toggle-thumb`（`styles/global.css:359-369`，
    40×22px、無 44px 觸控區）：`settings/NavigationSetting.tsx:15`、`components/ModuleLibrary.tsx:45`（多一個 `disabled`）、
    `components/ToolbarLayoutEditor.tsx:112`（`ToolSwitch`，多一段 aria-label 組字）。
  - 第四份是 `settings/SettingRenderer.tsx:41` 內聯寫的同一個按鈕。
  - checkbox 版：`settings/spacesAndMembers/SpaceSwitches.tsx:43` 用 `<input type="checkbox" role="switch">`，樣式是
    自己的 `.sm-switch input`（`settings/spacesAndMembers/SpacesAndMembers.css:49-54`：36×20px，`appearance: none`，
    自畫滑塊與 focus ring）。
  - `settings/TimeSetting.tsx:78` 也是 `<input type="checkbox" role="switch">`，但**沒有任何開關樣式**：看起來是一般核取方塊
    （語意說是開關，外觀不是）。
- **已造成的不一致**：兩種開關外觀與尺寸不同（40×22 vs 36×20）；`TimeSetting` 的開關外觀是核取方塊；`disabled` 只有一份
  有處理；focus ring 只有 checkbox 版有（`.settings-toggle` 沒有 `:focus-visible`）。
- **建議的唯一入口**：新增 `components/ui/Switch.tsx`（`on`、`label`、`disabled`、`onChange`），樣式併入 `ui/ui.css`，
  含 44px 觸控區與 focus ring。6 處都改用；`.settings-toggle*` 與 `.sm-switch input` 刪除。
- **怎麼擋住**：ESLint（`eslint.config.js` 已有 `no-restricted-syntax` 機制與 `eslint-rules/`）加一條：
  `JSXAttribute[name.name='role'][value.value='switch']` 在 `components/ui/` 以外報錯，訊息指向 `ui/Switch`。目前違規 6 處
  （4 個按鈕＋2 個 checkbox；其中 `SettingRenderer`／`NavigationSetting`／`ModuleLibrary`／`ToolbarLayoutEditor`／`SpaceSwitches`／
  `TimeSetting`）。
- **嚴重度／工作量**：中／小。

## 4. 空狀態（中／中）

- **概念**：清單或面板沒有內容時顯示的文字。
- **各自的寫法**：
  - 共用元件 `components/EmptyState.tsx`（圖示＋標題＋說明＋行動，`components/EmptyState.css`）只有 4 處使用：
    `components/OverviewSidebar.tsx`、`components/OverviewEditor.tsx`、`components/ModuleNotImported.tsx`（共 3 個檔、4 個呼叫）。
  - 其餘 76 處是 `<p className="xxx-empty">`，約 51 個 CSS 規則各自定義，例如：
    - `components/collections/CollectionView.css:86`（`.cv-empty`）：13px、`padding: 24px 0`、置中。
    - `components/CommandPalette.css:159`（`.palette-empty`）：13px、`padding: 24px`、置中。
    - `components/views/BaseRenderer.css:5`（`.bases-empty`）：13px、`padding: 12px 0`、置中。
    - `modules/review/ReviewPanel.css:46`（`.review-empty`）：13px、`padding: 24px 16px`、**靠左**、行高 1.6。
    - `modules/rss/RssReaderPanel.css:519`（`.rss-empty`）：**12px**、`padding: 10px 12px`、靠左。
    - `components/history/WorkspaceHistory.css:57`（`.wh-empty`）：13px、無 padding、靠左。
    - `components/TagsPanel.css:12`、`components/PlacePicker.css:70`、`components/TimeZonePicker.css:27`、`styles/sidebar.css:223`、
      `styles/global.css:711` 各有一份。
  - 另有 `components/InboxReview.css:291`（`.inbox-empty` 含 icon／title／sub）自己做了一份「圖示＋標題＋說明」，
    等於重做 `EmptyState`。
- **已造成的不一致**：同樣是「沒有資料」，字級 12／13px、置中／靠左、留白 0／10／12／24px 各不同；視覺上是「這裡比較空、
  那裡比較擠」。文字本身也沒有統一風格（`cv-empty` 一行、`inbox-empty` 圖示加兩行）。
- **建議的唯一入口**：`EmptyState` 加 `size="inline"`（一行、置中、固定留白）給清單用；`panel`／`page` 給整塊用。
  先收斂 CSS 全相同的幾組（`cv-empty`、`palette-empty`、`bases-empty` 三份幾乎逐字）。
- **怎麼擋住**：guard test：CSS 裡選擇器名稱符合 `/-empty(?![a-z-])/` 的規則不准新增（基準線檔 `empty-baseline.json`，
  只准減少）；現況約 51 條。搭配 TSX 掃描：`className` 符合 `-empty` 的 JSX 數量只准減。
- **嚴重度／工作量**：中／中（76 處但多半是機械替換；先做 3 組逐字相同的）。

## 5. 行內錯誤文字（中／小）

- **概念**：表單或面板內一行紅字的錯誤訊息（都有 `role="alert"`）。
- **各自的寫法**（9 組 class，`role="alert"` 都對，但樣式各自定義）：
  - `components/PurgeDeletedModal.css:19`（`.purge-dialog-error`）：13px、`--onden-state-error-text`。
  - `styles/global.css:2131`（`.login-error`）：12px、`--onden-state-error-text`。
  - `modules/skills/skills.css:9`（`.skill-run-error`）：只設顏色，不設字級。
  - `modules/citations/citations.css:16`（`.paper-import-error`）：`var(--danger, #b42318)`，13px。
  - `modules/rss/RssSheets.css:17`（`.rss-sheet-error`）：`var(--danger, #c0392b)`（**後備色與上一條不同**），`0.85rem`。
  - `components/SettingsModal.css:153-154`（`.settings-storage-error`）：14px，`var(--onden-state-error-text, #d97c70)`
    （第三種後備色）。
  - `components/history/WorkspaceHistory.css:58`（`.wh-error`）：**不是紅字**，是 accent 12% 底色的方塊、內文用 `--text`。
  - `components/AccountPanel.css:12`（`.account-error`）：內文用 `--text`（**不是紅色**）、14px。
  - `components/CommandPalette.css:113`（`.palette-error`）：`--muted` 灰字加重試按鈕。
- **已造成的不一致**：同一類「出錯了」有紅字、灰字、色塊三種外觀；字級 12／13／14／0.85rem；三種後備色
  （理論上 token 永遠有定義，後備不會用到，但留著三個不同的 hex 是未來換色時的漏網）。
- **建議的唯一入口**：新增 `components/ui/FieldError.tsx`（或在 `ui.css` 加 `.ui-error`）：`role="alert"`、固定色與字級，
  需要重試鈕時用 children。錯誤文字仍照 AGENTS.md 走 `writeErrors.message`／`serverErrors`，不在這裡處理。
- **怎麼擋住**：guard test：CSS 規則名稱符合 `/-error\b/` 且含 `color` 的，值必須是 `--ac-danger`／`--onden-state-error-text`，
  且不准帶 hex 後備（基準線：現況 6 條帶後備或不是紅色）。
- **嚴重度／工作量**：中／小。

## 6. 關閉（X）鈕與圖示鈕尺寸（中／中）

- **概念**：對話框、面板右上角的「×」與其他方形圖示鈕。
- **各自的寫法**：
  - `ui` 有 `Button variant="icon"`（`components/ui/ui.css:165-175`：桌面 38px、手機 `min-width: 44px`、`sm` 30／40px）；
    `ui/Popover.tsx:109` 的關閉鈕用它。
  - 其餘各自畫：
    - `modules/tasks/QuickAddTask.css:27`（`.quick-add-close`）：44×44，負邊界 −8px 補位。
    - `components/CommandPalette.css:103`（`.palette-close`）：寬 44、`min-height: 44px`。
    - `components/CanvasMode.css:314`（`.canvas-add-close`）：32×32。
    - `components/ShortcutsCheatsheet.css:42`（`.shortcuts-close`）：**26×26**，用文字字元 `×`（`components/ShortcutsCheatsheet.tsx:91`）而非圖示，另有自己的 hover／focus。
    - `modules/capture/QuickCapture.css:60`（`.quick-capture-close`）：只有 `padding: 4px`（約 26px 見方）。
    - `components/NodeAttributesPanel.css:181`（`.attr-panel-close`）：無尺寸、無 padding。
    - `components/HashtagScopeHint.css:29`（`.hashtag-hint-close`）：`min-width: 32px`。
    - 另有 `.card-node-icon-btn`（`CardNode.css:169`）、`.schema-lens-icon-btn`（`SchemaLens.css:24`）、`.nh-icon`
      （`components/history/NoteHistory.tsx:208,265,295`）。
  - 圖示尺寸：`<X size=…>` 29 處用 16／18／22；全專案 lucide `size=` 有 14（120 次）、16（71）、15（46）、13（42）、
    12（33）、11（28）等 14 種。
- **已造成的不一致**：手機上 26px 的「×」（快捷鍵說明、快速記錄）不到 44px 觸控標準；同為「關閉」，圖示有 16／18／22px。
  `aria-label={t("Close")}` 有 20 處、`<button><X>` 這類寫法有 8 處未走 `Button`。
- **建議的唯一入口**：`ui/Button variant="icon"`（已有，已含手機 44px），加一個 `CloseButton`（固定 `X` 圖示與 label「Close」），
  Modal 內的 header 一律用它。
- **怎麼擋住**：ESLint `no-restricted-syntax`，selector `JSXElement[openingElement.name.name='button']:has(> JSXElement[openingElement.name.name='X'])`
  （esquery 支援 `:has`）：`<button>` 直接包 `<X/>` 就報錯，訊息指向 `CloseButton`。目前違規 8 處。guard test：
  CSS 規則名稱符合 `-close\b` 且 `width`／`height`／`min-*` 小於 44px 的，只准減少（目前約 5 條）。
- **嚴重度／工作量**：中（觸控尺寸）／中。

## 7. 「手機版」斷點（中／中）

- **概念**：什麼寬度算手機、什麼寬度算平板。
- **各自的寫法**：
  - 規範寫在 `hooks/useIsMobile.ts:4-5`：`MOBILE_QUERY = "(max-width: 900px)"`，並註明「樣式也用 900px，要一起改」。
  - CSS 的 `max-width` 實際出現：900px（42 次）、600px（15）、640px（9）、1024px（4）、768px（3）、720px（1）、480px（1）、
    1279px／1099px 各 1。`min-width`：901（10）、900（4）、601（4）、600、1100、72em。共 59 個 CSS 檔有 `@media`。
  - 同一類東西用不同斷點切換：
    - 角落卡片：`components/TimeZoneAsk.css:21`（640）、`components/FailedWriteRecovery.css:109`（600）。
    - 輸入框 16px：`styles/global.css:975`（1024）。
    - `ui` 自己也兩套：`components/ui/ui.css:92`（`max-width: 768px` 加 `(hover: none)`，選單變 44px 列）、
      `components/ui/ui.css:200`（600，Modal 邊距變 12px）。
    - 命令面板 `components/CommandPalette.css:201`（640）；設定 `components/SettingsModal.css:145`（600）；
      但設定的手機版另用 JS `settings-modal--phone` class（`SettingsModal.css:103`）。
  - 夾在 601～900px 的視窗（小平板、手機橫放）：JS 說是手機（`MOBILE_QUERY`）、600px 斷點的 CSS 說是桌面——
    **同一個畫面一半元件走手機版、一半走桌面版**（例如 Modal 邊距看 600px、選單看 768px 或 `hover: none`、導覽列看 900px）。
  - 只有 `AppTopbar.tsx:206`、`hooks/useBoardTree.ts:32` 用 `useMediaQuery(MOBILE_QUERY)`；`hooks/useWorkspacePanes.ts:11`
    另有 `THREE_PANE_MIN_WIDTH`（`window.innerWidth`）。
- **已造成的不一致**：推論，601–900px 寬度下，介面部分是手機布局、部分是桌面布局（**未在瀏覽器逐一驗證**，只確認了斷點值不同）。
- **建議的唯一入口**：CSS 無法讀 JS 常數，所以用「標準斷點表」：`phone = 600`（單手操作、sheet）、`mobile layout = 900`
  （與 `MOBILE_QUERY` 同值）、`tablet = 1024`（只給觸控縮放修正這類）。其餘（640／720／768／480／1099／1279）逐一歸入其中之一
  或寫例外理由；`@custom-media` 若 build 工具支援可用，否則維持字面數字加白名單。
- **怎麼擋住**：guard test：掃全部 `.css` 的 `@media`，`max-width` 值只准 `600px`／`900px`／`1024px`、`min-width` 只准
  `601px`／`901px`／`1025px`（及一份有理由的例外清單，例如 `72em`、`1100px` 的大螢幕規則）。目前違規：max-width 21 處
  （640×9、768×3、720、480、1099、1279、其餘 `px` 值）、min-width 7 處。例外清單只准減少。
- **嚴重度／工作量**：中／中（需要逐一確認 640→600 或 900 是否改變行為）。

## 8. focus ring（焦點外框）（中／中）

- **概念**：鍵盤聚焦時的外框。
- **各自的寫法**：
  - 規範：`styles/tokens.css:106` 定義 `--ac-focus-ring`（頁面色一圈＋focus 色一圈，填色與透明控件都看得見）；
    `styles/theme-tokens.css:136` 別名 `--onden-focus-ring`。**實際用到它的只有 1 處**（grep `var(--ac-focus-ring)` 1 次）。
  - 其餘各自寫 `outline`：58 條 `outline: Npx solid …`，顏色有 `var(--accent)`（32）、`--onden-border-focus`（11＋3）、
    `--onden-accent-text`、`--onden-accent-9`、`--onden-accent-bg`、`--s-accent`、`currentColor`、`--accent, currentColor`…；
    `outline-offset` 有 2px（23）、−2px（17）、1px（8）、3px（2）、−1px（2）、−5px、−4px。
    例：`modules/tasks/QuickAddTask.css:40,60`（offset 1px）、`components/CommandPalette.css:102`（−2px）、
    `components/ui/ui.css:45`（−2px）、`ui.css:150`（2px）、`components/history/WorkspaceHistory.css:14,24,28`（−2px）。
  - `outline: none`／`0` 共 44 條，其中一批是 `:focus { outline: none }` 配上只改 `border-color`（例如
    `components/ObsidianImport.css:197,456`、`components/ServerSetup.css:30`、`components/NodeAttributesPanel.css:301`、
    `styles/global.css:1342` 全域 `select:focus`），沒有 `:focus-visible` 區分。
- **已造成的不一致**：鍵盤使用者在不同面板看到粗細、顏色、內縮外擴都不同的焦點；部分輸入框只換邊框色（在深色或低對比下不明顯，
  **未量測**）。`--ac-focus-ring` 在深色主題下有專門調過對比，手寫的沒有。
- **建議的唯一入口**：新增一個全域規則 `:where(button, a, [role="tab"], [role="menuitem"], input, textarea, select, [tabindex]):focus-visible
  { outline: 2px solid var(--ac-focus); outline-offset: 2px }`，並提供 `--ac-focus-inset`（offset −2px）給列表列用；
  元件只在需要時用 `box-shadow: var(--ac-focus-ring)`，不再各自選顏色。
- **怎麼擋住**：guard test：`outline:` 宣告值必須是 `none`（且同規則或同選擇器有 `:focus-visible` 補位）或
  `var(--ac-focus…)`；基準線 58＋44 條，只准減少。
- **嚴重度／工作量**：中（鍵盤無障礙）／中。

## 9. z-index 沒有層級表（中／中）

- **概念**：誰蓋住誰。
- **各自的寫法**：`styles/tokens.css` 沒有 z-index token。`ui.css` 之外 71 個宣告、34 個檔、30 種值：
  1、2、3、4、5、6、7、10、20、22、30、31、40、41、50、60、100、120、200、300、350、400、420、900、999、1000、3000、4000、9999。
  - 高值：`styles/global.css:204`（`.membership-gate` 9999）、`components/CardNode.css:295` 與 `components/OverviewSidebar.css:15`
    （4000）、`styles/global.css:605,663` 與 `components/HashtagScopeHint.css:5`（3000）、`components/InkToolbar.css:346`（1000）、
    `components/ui/ui.css:8`（1000）、`ui.css:102`（999）、`components/ExpandPaneButton.css:8`（900）。
  - 作者靠註解對比數字：`FailedWriteRecovery.css:14`「above toasts (400)」、`ExpandPaneButton.css` 的「below dialogs and menus」。
  - `ui.css` 的 modal 靠 `<dialog>` 頂層，其 `z-index: 1000` 其實沒有作用，但看起來像是層級的一部分。
- **已造成的不一致**：已確認的實例見第 2 條（數字對不到頂層的東西）。其他是「看起來蓋得住」的偶然——
  例如 3000／4000 的泡泡選單與 1000 的 Ink 工具列之間沒有任何文件寫誰在上面。
- **建議的唯一入口**：`styles/tokens.css` 新增一張表：`--ac-z-sticky: 10`、`--ac-z-float: 100`（泡泡、提示）、
  `--ac-z-overlay: 900`（放大窗格）、`--ac-z-gate: 9000`（登入／成員閘）；頁內堆疊（1～7）維持字面數字。
  其餘都歸進這幾層，頂層（modal 內）的東西靠第 2 條的 portal，不靠數字。
- **怎麼擋住**：guard test：`z-index` 值若 ≥ 100 必須是 `var(--ac-z-*)`；目前 ≥100 的字面值 16 處（`ui.css` 之外），
  放例外清單、只准減少。≤ 99 的頁內層維持不管。
- **嚴重度／工作量**：中（維護性＋第 2 條的根因）／中。

## 10. 浮在內容上的小面板（泡泡選單、提示、候選清單）（中／中～大）

- **概念**：貼著游標或輸入框的小浮層。`ui/Popover`／`Menu`（`components/ui/Popover.tsx`、`usePopover.ts`）已負責：定位、
  Esc、點外面關閉、頂層 portal。
- **各自的寫法**（`position: absolute|fixed` 加 `box-shadow` 加 `z-index` 加 `border-radius` 的手刻浮層）：

  | 檔案:行 | 用途 | 圓角 | 陰影 | z-index |
  | --- | --- | --- | --- | --- |
  | `components/HashtagScopeHint.css:2` | #標籤範圍提示 | 8px | `0 4px 16px rgba(15,23,42,.12)` | 3000 |
  | `components/CardNode.css:291` | 卡片泡泡選單 | 8px | `0 4px 16px rgba(0,0,0,.12)` | 4000 |
  | `styles/global.css:599-605` | 概覽編輯器泡泡選單 | 7px | `0 4px 16px rgba(0,0,0,.18)` | 3000 |
  | `styles/global.css:1017-1027` | `/` 斜線選單 | 10px | `var(--shadow)` | 300 |
  | `components/ObsidianImport.css:764` | 標籤候選清單（`title-tag-options`） | 8px | `0 6px 20px rgb(0 0 0/.18)` | 30 |
  | `components/CanvasMode.css:199` | 白板挑選器 | 10px | `0 8px 28px rgba(0,0,0,.14)` | 200 |
  | `components/CanvasMode.css:72` | 白板搜尋列 | 10px | `0 4px 20px rgba(0,0,0,.12)` | 20 |
  | `components/OverviewSidebar.css:11` | 側欄拖曳影子 | 6px | `0 8px 24px rgba(15,23,42,.16)` | 4000 |

  `ui` 側的陰影 token（`--ac-shadow-float`）只被 `ui.css` 等少數地方用；上面 8 處全是字面值。
  另有位置夾限 `Math.max(8, Math.min(x, innerWidth - W))` 在 `components/MarkdownEditor.tsx:1598,1627`、
  `components/HashtagScopeHint.tsx:24`、`lib/selectionBubble.ts:24`（已在上一輪 P 項列過，這裡只算 UI 一致性）。
- **已造成的不一致**：圓角 6～10px、陰影 3 種、z-index 20～4000；沒有走 `Popover` 的幾個也沒有「Esc 關閉」「modal 內可見」的保證
  （同第 2 條，開著對話框時蓋不住）。
- **建議的唯一入口**：能錨定在元素的（`title-tag-options`、白板挑選器、搜尋列）改用 `ui/Popover`；貼游標的
  （泡泡選單、斜線選單、hashtag 提示）可能需要 `ui/Popover` 支援「以座標定位」——這是缺口，先出兩種設計草圖（AGENTS.md 規定新公共
  介面要比較至少兩種）再動。
- **怎麼擋住**：同第 2 條的 `position: fixed` 白名單（目前泡泡類 5 處在名單內，只准減少）；再加一條 guard：
  `box-shadow` 的字面 `rgba(` 值不准新增（見第 15 條）。
- **嚴重度／工作量**：中／中～大（需要先設計「貼游標」的 Popover 模式）。

## 11. 色彩 token 三種拼法＋寫死的後備 hex（低／大）

- **概念**：同一個顏色在 CSS 裡有多種名字。
- **各自的寫法**：`styles/tokens.css` 開頭寫明 `--ac-*` 是唯一來源，`--onden-*` 與舊名 `--accent` 等都是別名
  （`styles/theme-tokens.css:185-216`），但呼叫端仍混用：
  - accent：`var(--accent)` 341 次、`--onden-accent-9` 73、`--onden-accent` 43、`--onden-accent-bg` 29、`--ac-accent` 27、
    `--onden-accent-text` 17。
  - 灰字：`--muted` 318、`--onden-text-muted` 276、`--onden-text-faint` 26（theme-tokens.css:97 其實 = `--ac-muted`，
    與 `--ac-faint` 不同色）、`--ac-muted` 12、`--ac-faint` 7。
  - 邊線：`--line` 295、`--onden-border-default` 135、`--border` 37、`--ac-line` 9。
  - 危險色：`--onden-state-error-text` 35、`--ac-danger` 12、`--onden-danger` 11、`--danger` 10、`--onden-red-9` 4、`--warn` 4。
  - 後備 hex：67 個 `var(--x, #hex)`；寫死的 hex 與 `rgba()` 在 token 檔之外分別有 49 與 70 處
    （`styles/event-kinds.css` 18、`styles/global.css` 14、`components/SettingsModal.css` 8、`components/InkToolbar.css` 6 …）。
  - 一個真實的陷阱：`styles/site-tokens.css:112-134` 也定義 `--bg`、`--text`、`--accent`、`--ink`…（已發布網站專用、
    刻意凍結）；`modules/graph/AllCardsGraph.tsx:68-70` 在 JS 內用 `getPropertyValue("--ink"/"--bg"/"--accent")` 取色，
    靠的是 app 這邊的別名；若有人把 app 別名清掉，圖會悄悄退到寫死的 `#44403a`。
  - 半徑 token 命名陷阱：`--onden-radius-lg` = 6px（`theme-tokens.css:173` 指向 `--ac-radius-md`），而 `--ac-radius-lg` = 12px。
- **已造成的不一致**：目前三套別名最終指向同一色，使用者看不出差別；風險是日後改主題時要記得三套都跟得上，並且
  `--onden-text-faint` 與 `--ac-faint` 同名不同值這種地雷。
- **建議的唯一入口**：新程式碼只用 `--ac-*`；舊名保留別名但標為「只讀」。不建議整批替換（341＋318＋295 次），
  用基準線控管。
- **怎麼擋住**：guard test：每個 `.css`（排除 token 檔）內「舊名／`--onden-*` 色彩」的 `var()` 次數建基準線，檔案只准減少、
  不准增加；新增檔案不准用舊名。hex／`rgba` 同理（基準線 49／70）。
- **嚴重度／工作量**：低／大（只靠守門擋新增，存量慢慢減）。

## 12. chip／徽章／膠囊（低／中）

- **概念**：小標籤、計數、狀態膠囊。
- **各自的寫法**（都是自己的 class，沒有共用元件）：
  - `modules/tasks/tasks.css:26`（`.tk-chip`）：padding 1px 7px、圓角 999px、`--onden-text-xs`、邊框。
  - `modules/tasks/QuickAddTask.css:51`（`.quick-add-chip`）：**min-height 44px**、padding 0 12px、背景 `--surface`。
  - `modules/rss/RssSheets.css:33`（`.rss-dest-chip`）：虛線邊框、min-height 32px。
  - `components/InboxReview.css:184`（`.inbox-filter-chip`）：字級 `base * 10.5/14`。
  - `components/InboxReview.css:108`（`.inbox-ev-pill`）：背景 accent 8%。
  - `components/history/NoteHistory.css:75`（`.nh-pill`）：`--ac-fs-caption`、`--ac-radius-full`（用的是新 token）。
  - `components/PlacePicker.css:61`（`.place-picker-badge`）、`components/TagFunctionPicker.css:28`（`.tag-fn-picker-badge`，
    背景用 warning 色）、`components/OverviewEditor.css:279`（`.node-source-badge`，圓角 4px、字級 `base*10/14`）、
    `components/CardNode.css:350`（`.card-node-ai-badge`，字級 `base*9/14`、圓角 3px）。
  - `modules/website/studio/HomeStudio.css:253`（`.hs-badge`）、`components/SchemaLens.css:38,82`（`.tag-function-chip`、
    `.tag-extends-chip`）。
- **已造成的不一致**：字級 9／10／10.5／11／12px、圓角 3／4／999px、padding 1px 6px／1px 7px／0 8px 各不同；
  「AI」的徽章有兩套（`node-source-badge--ai`、`card-node-ai-badge`，兩處都用 `color-mix(in srgb, var(--ac-info) 18%, transparent)`）。
- **建議的唯一入口**：`ui/Badge`（`tone`: neutral／accent／info／warning；一種尺寸）。可點的 chip（`quick-add-chip`、
  `tk-pill`）另歸 `Button` 家族，不要混進 Badge。
- **怎麼擋住**：guard test：新增 CSS 規則同時含 `border-radius: 999px`（或 `--ac-radius-full`）與 `padding` 且名稱符合
  `/(chip|badge|pill)/`，不在基準線就失敗。現況 13 條。
- **嚴重度／工作量**：低／中。

## 13. 載入中（低／小）

- **概念**：資料還沒到時的畫面。
- **各自的寫法**：
  - 文字：`t("Loading…")` 32 處，各配自己的 class（`journal-loading`、`nh-loading`、`attr-panel-loading`、`login-loading`）。
  - 空白佔位：`lazy-loading-pane`（`components/SecondaryLensOutlet.tsx:49,65,79,89,104` 等 10 處）。
  - 旋轉：`app-boot-spinner`（`components/BootScreen.tsx:8`、`components/MembershipGate.tsx:59`，CSS `styles/global.css:277`）、
    `welcome-banner-spin`（`components/WelcomeBanner.tsx:91,106`，`Loader2` 圖示＋`WelcomeBanner.css:55` 自己的
    `@keyframes welcome-banner-spin`，與 `global.css` 已有的 `spin` 重複）。
  - 骨架：`styles/sidebar.css:136-170` 的 `.sidebar-skeleton-*` 與 `styles/global.css:178` 的 `onden-skeleton` keyframe；
    TSX 內 **0 處使用**（grep `sidebar-skeleton` 在 `.tsx` 無結果，註解寫「Wire by rendering N <div>」），是預留未接的。
  - 其他進行中字串：`Saving…`（8）、`Searching…`（2）、`Working…`、`Rendering…`、`Loading the full article…`。
- **已造成的不一致**：載入中的外觀有純文字、空白、旋轉、（未接上的）骨架四種；同一個空白佔位又有 `u-fill` 與否兩種。
- **建議的唯一入口**：`ui/Spinner`（吃 `global.css` 既有的 `spin`）與 `ui/Loading`（文字＋可選旋轉、`role="status"`）。骨架若要用就接上，
  不用就刪。
- **怎麼擋住**：guard test：`@keyframes` 名稱只准在 `styles/` 與 `ui.css` 以外各檔自己的動畫用（見第 14 條）；
  JSX 內 `Loader2` 只准在 `ui/Spinner`（目前 3 處）。
- **嚴重度／工作量**：低／小。

## 14. 重複的 `@keyframes`、沒人用的 CSS（低／小）

- `@keyframes spin` 在 `styles/global.css:145` 與 `:285` 各定義一次；`onden-fade-in`／`onden-pop-in` 在 `:1827-1832` 與
  `:1929-1934` 逐字重複（連同 `prefers-reduced-motion` 區塊也重複，`1832-1838` 與 `1934-1940`）。jscpd 抓到的是逐字，
  但「同名 `@keyframes`」不是同名匯出，`dup:names` 看不到。
- `.segmented-control`（`styles/global.css:1302-1322`）在 TSX／TS 內 **0 處使用**（grep 無結果）；實際的分段按鈕是各自手刻：
  `modules/rss/RssReaderPanel.tsx:760`（`rss-filter-seg`）、`:873`（`rss-write-choice`）、`components/InfoTagsTab.tsx:152`
  （`info-legacy-choices`）、`modules/tasks/ShutdownSheet.tsx:55`（`shutdown-choices`）、`modules/website/studio/StyleChoices.tsx`
  與 `fields.tsx`（`aria-pressed` 群組）。這是另一個「該有共用元件但死碼留著、使用者各手刻」的實例，可併入 `ui/` 補一個
  `SegmentedControl`（目前 aria-pressed 群組至少 6 處）。
- **怎麼擋住**：guard test：同一 `@keyframes` 名稱在整個 `src` 的 CSS 只准定義一次（目前 3 組違規：`spin`、`onden-fade-in`、
  `onden-pop-in`，可直接刪成 0）；另一條：`.css` 內的 class 若在全部 `.ts|.tsx` 都找不到字串，列入「疑似死碼」清單（先只印、
  不擋，因為有動態組字的 class）。
- **嚴重度／工作量**：低／小（刪除即可）。

## 15. 圓角／陰影／hover 底色／字級後備值寫死（低／大）

- **圓角**：`border-radius: Npx` 456 處（6px 136、8px 104、999px 44、4px 32、10px 25、5px 22、3px 21、7px 20、12px 16、2px 14、
  16px 7，另 9／11／13／14／20／22px 等），使用 token（`--ac-radius-*`／`--onden-radius-*`）僅 67 處。5／7／9／10 沒有對應 token。
- **陰影**：`box-shadow` 字面值（不含 focus／inset）38 處，token（`--ac-shadow-*`／`--onden-shadow-*`）約 20 處。
  例如同為「卡片浮起」：`0 4px 16px rgba(15,23,42,.12)`（`HashtagScopeHint.css:15` 等 2）、`0 4px 16px rgba(0,0,0,.12)`（2）、
  `0 4px 16px rgba(0,0,0,.14)`（`TimeZoneAsk.css`）、`0 4px 16px rgba(0,0,0,.18)`（2）。
- **hover 底色**：`:hover { background: … }` 用了 `--surface-strong`（31，= `--ac-raised`，是輸入框／巢狀面板色）、
  `--onden-overlay-hover`（14）、`--onden-bg-subtle`（9，ink 4%）、`--onden-surface-hover`（7）、`--hover`（7）、
  `--onden-hover-wash`（5，**accent 6%**，唯一帶色的）、`--surface`（4）…。`--surface-strong` 當 hover 在淺色主題是變深，
  `--onden-overlay-hover` 是 ink 5% 疊色，兩者觀感不同。
- **字級後備值**：`var(--onden-text-sm, …)` 的後備有 `12px`（145）、`0.9rem`（22）、`14px`（7）、`13px`（5）、`0.85rem`（2）；
  `--onden-text-xs` 的後備有 `11px`（119）、`12px`（17）、`0.8rem`（4）。token 永遠有定義，後備不會用到，但留著不一致的數字會誤導讀者。
  另有 `font-size: 0.85em` 18 處、`0.9em` 9 處、各種 `rem`，沒走字級階（`--ac-fs-*` 只被用 12 次，舊的 `--onden-text-*` 用數百次）。
- **建議的唯一入口**：圓角補 `--ac-radius-*` 缺的階或把 5／7／9／10 併進 4／6／8／12；陰影統一用 3 個 token；hover 底色統一用
  `--ac-overlay-hover`；字級後備整批改成與 token 同值（機械替換，可腳本化）。
- **怎麼擋住**：guard test，**基準線只減不增**：`border-radius` 字面 px、`box-shadow` 字面 `rgba(`、`:hover` 的 `background`
  非 token 三項各設一個每檔計數基準（`scripts/` 下新增 `css-literals-baseline.json`，格式同 `dup-names-baseline.json`）。
- **嚴重度／工作量**：低／大。

---

## 這次沒有列、但看到的小事

- 原生 `title=` 當作 tooltip 有 285 處（`<… title={…}>`）；觸控裝置沒有 hover、不會顯示。專案沒有 tooltip 元件，
  圖示鈕的說明只靠 `aria-label`。要不要做 tooltip 是產品決定，這裡只記錄。
- `components/tagPage/MergePanel.tsx:35`、`TagDeleteConfirm.tsx:77`、`TagMoveConfirm.tsx:34` 三個「標籤操作確認」是
  `role="alertdialog"` 的行內面板（共用 `schema-lens-confirm-pop` 動畫），不是 modal，沒被 `modals-through-ui-modal` 規則抓到
  （需要 disable 註解）。與上一輪 P 項的「行內確認」同類，需要產品決定，先不列。
- Tabs 已經全部走 `ui/Tabs`（`role="tab"` 在 `components/ui/` 外 0 處）、Modal 已有 ESLint 守門
  （`eslint-rules/modals-through-ui-modal.js`）、按鈕有 `buttonClass`（`<Button>` 79 處、`buttonClass(` 128 處對 652 個
  原生 `<button>`，多數是列內操作，沒逐一檢查是否該改）。這幾類狀況良好，列在這裡說明「查過」。

---

## 建議的守門總設計

### 1. 先補工具，再放規則

- `src/test/guards/sources.ts` 只掃 `.ts|.tsx`。新增 `cssFiles()`（走過 `src/**/*.css`，排除 `styles/site-tokens.css`、
  `published-site.css`、`siteFrame/`——已發布網站刻意凍結、不跟 app token）與 `cssRules(file)`（回傳 `{ selector, body, line }`，
  簡單解析即可，不需要完整 CSS parser；可用現成的 `postcss`，若不想加依賴就用正規式）。
- 守門規則寫成 `src/test/guards/ui-consistency.guard.test.ts`（每條一段 `describe`，每條例外都寫理由，同
  `shared-helpers.guard.test.ts` 的風格）。

### 2. 哪些放 ESLint、哪些放 guard test

| 放 ESLint（寫在 TSX、IDE 立刻看見） | 放 guard test（要看 CSS 或跨檔） |
| --- | --- |
| `role="switch"` 在 `components/ui/` 外（第 3 條） | 輸入框 class 的 `font-size`（第 1 條） |
| `<button>` 直接包 `<X/>`（第 6 條） | `position: fixed` 白名單（第 2、10 條） |
| `Loader2` 在 `ui/Spinner` 外（第 13 條） | `@media` 斷點白名單（第 7 條） |
| `<dialog>`、`aria-modal`（已有，`modals-through-ui-modal`） | `outline` 值、z-index ≥100、顏色舊名／hex／rgba、圓角／陰影字面值（第 8、9、11、15 條） |
| | `-empty`／`-error`／`-close`／`-chip|-badge|-pill` 規則數（第 4、5、6、12 條） |
| | 重複 `@keyframes`（第 14 條） |

原則：能用 JSX selector 表達的放 ESLint（現有 `eslint.config.js` 與 `eslint-rules/` 已有機制）；要比對 CSS 內容或 TSX↔CSS 對應的
放 guard test（它跟完整 vitest 一起跑，CI 一定會跑到，不用多一個 stylelint 依賴）。**不建議引入 stylelint**：現有 guard 風格已夠，
且規則大多是專案專屬的。

### 3. 例外名單怎麼管（只准減少）

- 每條規則一份基準線，放 `scripts/ui-baseline.json`（格式比照 `scripts/dup-names-baseline.json`：每條規則 →
  `{ reason, files: { "路徑": 允許數量 } }`）。
- guard 的判斷是「檔案的違規數 **≤** 基準線」，且「基準線內的檔案若違規數變少而沒降低基準線也失敗」（比照 `dup:baseline` 的
  `npm run` 降低指令，另提供 `npm run ui:baseline` 重新計算）。這樣新增違規會失敗，收斂完成會被強迫鎖住成果。
- 新檔案一律「零違規」：基準線沒有的檔案，任何違規都失敗。
- 每個例外要寫理由，理由類別限定：「歷史存量」、「原生元素無法包」、「已發布網站凍結」、「動態值（runtime 設定）」。
  「歷史存量」類別每次收斂批次必須減少，其餘類別需要在 PR 說明理由。

### 4. 建議的收斂順序（依嚴重度＋工作量）

1. 第 1、2 條（高／小）：各一個 PR，含守門；先在真機（iOS）驗證第 1 條、在瀏覽器驗證第 2 條的推論。
2. 第 3、5、14、13 條（小）：新增 `ui/Switch`、`ui/FieldError`，刪重複 `@keyframes` 與死碼。
3. 第 7、9 條（中）：先定標準斷點表與 z-index 表，再逐批改；每批含基準線下降。
4. 第 4、6、8、10、12 條（中）：依使用面大小選批。
5. 第 11、15 條（大）：只靠守門擋新增，不排專案。

### 5. 這份報告的驗證與限制

- **已讀**：`components/ui/*`、`styles/tokens.css`、`styles/theme-tokens.css`、`styles/global.css` 相關段落、各條引用的 CSS／TSX 行。
- **推論、未實測**：第 1 條在 iOS 的縮放行為、第 2 條對話框蓋住通知、第 7 條 601–900px 的混合版面——都由 CSS 層疊與 `showModal()`
  頂層語意推出，沒有開瀏覽器或真機重現。實作前先重現。
- **沒做**：沒有開瀏覽器截圖、沒有跑 vitest／ESLint（沒改程式）。各處數量是 grep 計數，同一行出現多次的規則可能略有出入；
  表中「約」字開頭的是估計。
