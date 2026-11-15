# 深模組審查：前端元件與互動層

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查日期 2026-10-24，基準 `origin/main` @ `6f1b2cbc`。範圍：`packages/frontend/src` 的 `components`、`hooks`、`pages`、`components/ui`、`styles`、i18n。
只讀 `.ts/.tsx/.astro/.css/設定檔`，沒有讀任何 `.md`。數字用 `grep` 統計，已排除 `*.test.*`；「推測」處會標明。

## 一句話結論

**寫入與彈窗（Modal）這兩條線整合得很好，而且有 lint 規則在守；選單／彈出層、按鈕、文案只做到一半**：
寫入全走 `lib/data`（元件裡 0 個繞路），所有 Modal 都經 `ui/Modal`；但 `ui` 只有 4 個元件（沒有 Sheet）、至少 3 個自刻的 listbox 下拉＋1 個自刻選單，
744 個 `<button>` 只有 26 個用 `<Button>`，網站編輯器（studio）約 170 行寫死中文繞過 i18n，另有數個 1000 行級大元件。

## 模組地圖

| 深模組 | 入口 | 介面大小 | 呼叫端 |
| --- | --- | --- | --- |
| UI 基本元件 | `components/ui/index.ts:4-8` | 匯出 9 個值（`Button, buttonClass, Modal, Menu, MenuHeading, MenuItem, MenuLabel, MenuSeparator, Popover, usePopover`）＋型別；`Modal` 約 8 個 props（`Modal.tsx:88`），`usePopover` 4 個選項（`usePopover.ts:38`）。共 572 行，小而實 | 66 個檔案 import `./ui`；`<Modal>` 22 檔、`<Popover>/<Menu>` 16 檔（`usePopover` 16 檔）、`<Button>` 10 檔、`buttonClass` 35 檔 |
| 資料／寫入層 `lib/data` | `lib/data/index.ts`；領域 writer（`noteWriter`、`tagWriter`、`taskWriter`…）、`nodeActions`（`lib/data/nodeActions.ts:25`）、`writeErrors` | 對元件而言是「完成一件事」的介面（刪除、複製、改名、移動、`tagWriter.create`）；`makeNodeActions` 把「找筆記、清選取、寫一致的 toast」包起來（`nodeActions.ts:1-9`） | 元件／hooks 裡 `nodeActions.` 26 處、14 檔；`tagWriter.` 等 writer 分散在約 14 檔；元件層直接 `api()/apiFetch()/fetch()`＝**0** |
| 復原 | `hooks/useEventRestore.ts`、`hooks/useVersionRestore.ts` | 各一個 hook | 6 個元件（`HistoryView`、`TimelineView`、`NodeEventHistory`、`NoteVersionHistory`、`EventLogPanel`、`RestorePreviewModal`）；未找到元件自己 POST `/restore`（只有 `useEventRestore.ts:58` 一處） |
| i18n | `lib/i18n.ts`（98 行）：`t()`、`useT()`、`registerDictionary` | 英文原文當 key，zh-TW 字典 3126 個 key | `t("…")` 約 2220 次、201 個檔 |
| Toast | `lib/appStore.ts` 的 `addToast`、`hooks/useToasts.ts`（12 行） | 一個函式 | 元件／hooks／modules 直接呼叫 86 處（見問題 6） |

## 分數表

| 子模組 | 深度 | 整合度 | 理由 |
| --- | --- | --- | --- |
| `ui/Modal` | 4 | 5 | 原生 `<dialog>`＋頂層、Esc、焦點、堆疊、頁面快捷鍵一手包（`Modal.tsx:50,88`）；`eslint.config.js:274` 規則禁止手刻，全 repo 只有 3 個有說明的例外。 |
| `ui/Popover`＋`Menu`＋`usePopover` | 3 | 3 | 介面小、定位／外點關閉藏得好；但 16 檔採用，仍有 ≥4 個自刻下拉（問題 2），沒有 lint 守。 |
| `ui/Button` | 2 | 1 | 27 行，只是 class 組合；`<button>` 744 vs `<Button>` 26，另 106 個 `<button>` 手套 `buttonClass`，其餘各自 class。 |
| 底部面板（Sheet） | 1 | 2 | **沒有 Sheet 元件**。`CreateSheet` 用「手機 Modal／桌面 Popover」二選一（`CreateSheet.tsx:181-183`），算有重用基本元件；但 `ShellDialog`、`RssSourceSheet` 等各用各的 css 做出「sheet」外觀。 |
| 寫入（`lib/data`）＋ `nodeActions` | 5 | 4 | 元件 0 個繞路（`writes-through-data` 規則 `eslint.config.js:216` ＋ 讀取規則 `:228`，`READS_ALLOWLIST` 為空 `:37`）；扣分在 `TasksMode` 自己做樂觀更新（問題 4）與 toast 散落（問題 6）。 |
| i18n | 4 | 3 | `t()` 介面極小、2220 次使用；扣分在 studio 約 170 行寫死中文、沒有 lint／測試保證字典完整（問題 3）。 |
| hooks 層（60 個） | 3 | 3 | 大多是有實質邏輯的領域 hook；淺包裝只有 2–3 個（問題 7）。 |
| 大元件結構 | 2 | 3 | 1453 行的 `MarkdownEditor`、988 行的 `KnowledgeWorkspace` 等（問題 5）。 |

## 問題清單（依嚴重度）

### 1. 按鈕基本元件形同虛設（中高）
- 現況：`ui/Button` 只做 variant/size class（`Button.tsx:13-27`，27 行）。
- 證據：`<button` 744 次、分布 175 個檔；`<Button` 26 次、10 個檔；106 個 `<button>` 手套 `buttonClass(...)`；另 66 處手寫 `className="…btn…"`。沒有 lint 規則。
- 影響：要改按鈕的焦點樣式、忙碌狀態、觸控尺寸（44px）得改上百個地方；`Button` 沒有 loading／disabled-while-busy 這類能讓它「變深」的行為。
- 建議：先讓 `Button` 吃掉 `busy`／`pending` 與觸控尺寸，再用一條 lint 規則擋新的裸 `<button className=` 並逐批遷移。

### 2. 自刻的彈出層／下拉（中）
- 現況：Modal 守得很緊，但 Popover／Menu／listbox 沒有同等保護。
- 證據（自刻，非 `ui/Popover`）：
  - `components/ParentCombobox.tsx:128` `role="listbox"`，自己處理 Esc（`:119`）與用 `setTimeout(onClose, 150)` 做 blur 關閉（`:125`）。
  - `components/TitleTagRow.tsx:157` `role="listbox"`，自己處理 Esc（`:144`）。
  - `modules/rss/RssDestinationFields.tsx` listbox，自己處理 Esc（`:92`）。
  - `components/MobileNav.tsx:227-232` 自刻 `role="menu"`／`menuitem` 與 Esc（同檔 `:188` 的另一個選單卻用了 `usePopover`）。
  - 另 `NoteActions.tsx:212` 的匯出選項是自帶 `role="menu"` 的內嵌清單（推測：在 `Menu` 內，影響較小）。
  - `SelectionToolbar.tsx`、`EditorLinkChip.tsx`、`MarkdownEditor.tsx`（有 18 處 popover／menu 類 class）也不經 `ui`（推測：因為跟著編輯器游標定位，需要確認）。
  - 其他 document／window 層級事件：`PdfNodeView.tsx:337`（keydown）、`GateTypingBuffer.tsx:68`（mousedown 外點）、`AllCardsGraph.tsx:208`（拖曳，合理）。
- 影響：Esc／外點／焦點行為各寫一份，之後要統一（例如 Modal 內再開下拉的堆疊）要逐一改；z-index 也散在各 CSS（`z-index` 值 1／5／10／30／60／100 等多種，`ui.css:8` 是 1000）。
- 建議：在 `ui` 新增 `Combobox`（listbox＋鍵盤＋blur 規則）並把這 3 個遷移進去；順便補一條 lint 規則擋 `role="listbox|menu"` 出現在 `components/ui` 之外。

### 3. 文案沒有全走 i18n（中）
- 現況：`t()` 用得很普遍，但有一整塊寫死中文。
- 證據：非註解的程式碼中含中日韓字元且未包 `t()` 的行共約 248 行、19 個檔，其中：
  - `modules/website/studio/`：`dictionary.ts` 72（Puck 的繁中字典，**合理**，檔頭 `dictionary.ts:1` 已說明）、`StylePanel.tsx` 24（`:12-13`「緊／中／鬆」「明體／黑體／等寬」）、`HomeStudio.tsx` 22（`:39-40`「桌面」「手機」）、`suggestions.ts` 19、`fields.tsx` 16（`:63-65`）、`AssetsPanel.tsx` 13、`SuggestPanel.tsx` 2、`WebsiteDesignPanel.tsx` 2（`:262` 寫死「未命名」「找不到這個項目」「還沒選」）；studio 的 `.tsx` 共約 4 處 `t(` 呼叫（`HomeStudio.tsx`）。合計約 **100 行實際介面文字**。
  - `components/templates/siteLocale.ts` 46：已發佈網站的語系字串，屬於另一套（發佈網站語言），**推測合理**。
  - `hooks/useCommandPalette.ts` 20：多為 `keywords` 內的中文別名，非顯示文字（推測，抽查前 2 筆確認）。
  - 英文寫死：只找到 `placeholder="搜尋…"`、`fields.tsx:197,200` 的 `label="class 名稱"` 等 4 處屬性；英文 JSX 文字的自動掃描誤報太多，無法給可信數字。
- 反面：抽查 `t("…")` 約 1699 個不同的字串，只有 7 個在 zh-TW 字典找不到，且都在 `components/siteFrame/SiteFrames.tsx`（`allNotes`、`backlinks` 這類 key，推測是內部 key 非介面文字）。
- 影響：studio 在英文語系下仍顯示中文；沒有測試或 lint 檢查「新字串是否補進字典」（只有 `puckDictionary.test.ts` 檢查 Puck 字典）。
- 建議：把 studio 的 `.tsx` 字串包進 `t()`；加一個簡單測試掃 `t("…")` 字面值是否都在 `ZH_TW`。

### 4. 樂觀更新有一處元件自己做（中低）
- 現況：寫入本身走 writer，但 `TasksMode` 自己維護一份 agenda 並做樂觀更新與回補。
- 證據：`components/TasksMode.tsx:27`（`patchAgendaTask`）、`:256-274`（先 `setAgenda` 套用，失敗再 `load()` 重讀）。
- 影響：同一份任務資料，別處由 store／writer 管理，這裡是第二份本機狀態；離線與回復規則得在兩處對齊（`taskWriter` 與這裡）。
- 建議：把 agenda 的樂觀補丁搬進 `taskWriter`（或 `lib/data/taskAgenda.ts`），元件只呼叫 `patch` 並讀 store。

### 5. 過大的元件（中）
最大的 10 個 `.tsx`（不含測試）：

| 行數 | 檔案 | 觀察 | 該拆嗎 |
| --- | --- | --- | --- |
| 1453 | `components/MarkdownEditor.tsx` | 33 個 `useRef`、24 個 `useEffect`、18 個 memo／callback，只有 9 個頂層函式；38 行 import | **該拆**：把選取工具列、連結補全、貼上／拖放、任務勾選各抽成 hook（推測：多數已在 `lib/editor*.ts`） |
| 988 | `components/KnowledgeWorkspace.tsx` | props 型別在 `:173`；`:229` 註解已提到由約 50 個 prop 縮減過；32 行 import | 觀察，已改善過一次 |
| 938 | `settings/registry.tsx` | 設定項目註冊表（資料式），0 個 memo | 不必拆（登錄表） |
| 858 | `modules/rss/RssReaderPanel.tsx` | 13 個 `useRef` | 該拆（面板＋清單＋閱讀區） |
| 817 | `modules/website/CollectionsManager.tsx` | 只有 12 行 import | 看分區再說 |
| 747 | `components/OverviewSidebar.tsx` | 35 行 import、12 個 memo | 該拆 |
| 743 | `components/OverviewEditor.tsx` | 43 行 import（全場最多）、14 個 callback | 該拆：依賴面太廣 |
| 700 | `components/collections/CollectionView.tsx` | 22 行 import | 觀察 |
| 645 | `components/MarkdownRenderer.tsx` | 14 個頂層函式 | 可接受 |
| 592 | `components/QuickCapture.tsx` | — | 可接受 |

（另外 `lib/i18n.zh-TW.ts` 3257 行是字典資料，`lib/localDbWorker.ts` 1351、`lib/data/syncEngine.ts` 1191 不在本區。）
- 影響：改編輯器任何行為都要閱讀 1400 行；「兩個模組要交叉閱讀」的警訊明顯。
- 建議：先從 `MarkdownEditor` 抽 hook，目標單檔 < 800 行。

### 6. Toast／錯誤回報散落（中低）
- 現況：`addToast` 是 store 函式，任何地方可直接呼叫；有共用的 `writeErrors.report(e, addToast)`（如 `hooks/useCreateTag.ts:23`）與 `writeErrors.wasReported`。
- 證據：元件／hooks／modules 直接呼叫 `addToast(` 共 86 處，前幾名：`hooks/useOverviewMode.ts` 11、`modules/citations/commands.tsx` 7、`modules/rss/RssReaderPanel.tsx` 6、`modules/review/extractCards.ts` 6、`components/ParagraphMenu.tsx` 4。其中多少是自己組訊息而非用 `writeErrors.message`，**沒逐筆驗證**。
- 影響：寫入失敗的文案與「已回報就不重複通知」規則若有人漏用 `wasReported`，會重複跳 toast（推測）。
- 建議：另開一批審查 `addToast` 的 86 處，把「寫入失敗」類統一走 `writeErrors.report`。

### 7. 淺包裝 hooks（低）
- 60 個 hooks 檔中最小的：`useKbdHint`（9 行，包 `useSyncExternalStore`，有實質理由）、`useToasts`（12 行，**只回傳 store 的 `addToast` 與 toasts**，且全 repo 只有 `ToastStack.tsx:83` 一個呼叫端）、`useCreateDialog`（29 行，`hooks/useCreateDialog.ts:12-27` 純 4 組 `useState` 打包、無邏輯）、`useCreateTag`（27 行，有實質邏輯）。
- 淺包裝約 2 個（`useToasts`、`useCreateDialog`）；其餘有行為。
- 建議：`useToasts` 讓 `ToastStack` 直接用 `useAppSelector`；`useCreateDialog` 若只服務 `BuilderApp` 就放回該元件。

### 8. 其他小項
- `ShellDialog`（18 行，`ShellDialog.tsx:8-17`）是 Modal 加兩層 div 的淺包裝，但有 15 個呼叫端、統一了版面，**可接受**。
- `pages/` 只有 Astro 殼與已發佈網站路由（`pages/index.astro` 102 行），沒有業務邏輯，無問題。
- `eslint-disable` 在非測試檔共 46 個檔，絕大多數是 `no-explicit-any` 與 `exhaustive-deps`；與邊界規則相關的只有 `modals-through-ui-modal` 3 處（`MergePanel.tsx:34`、`TagDeleteConfirm.tsx:76`、`TagMoveConfirm.tsx:33`，皆有理由）與 `module-entry` 2 處。

## 做得好、值得保留

- **Modal 邊界是教科書式的**：一個元件＋一條 lint 規則（`eslint-rules/modals-through-ui-modal.js`）＋ 3 個有理由的例外。
- **寫入／讀取邊界守得住**：`writes-through-data`、`reads-through-data`、`localStorage` 唯一入口（`prefs`）、時間格式唯一入口（`time-through-labels`）、`localDb` 與 `setData` 的 `no-restricted-imports`（`eslint.config.js:216-290`）；`READS_ALLOWLIST` 為空，`STORAGE_ALLOWLIST` 只有 1 項。
- **`nodeActions` 把「找筆記、清選取、一致的 toast」收在一起**（`nodeActions.ts:1-9`）；右鍵選單、⋯ 選單、側欄、快捷鍵共用。
- **i18n 介面極小**（`t(text, vars)`），字典幾乎完整。
- `ui/` 單一入口 `index.ts`，內部檔案互相直接 import，沒有多餘一層。

## 不確定、需要人確認

1. **MarkdownEditor 的彈出元素**（斜線選單、連結補全、`SelectionToolbar`、`EditorLinkChip`）是否刻意不走 `ui/Popover`（因為要跟著 CodeMirror 游標）？我沒追進去確認。
2. **studio 是否刻意只做中文**？若是，問題 3 的 studio 部分可降為「文件化的例外」。
3. **`useCommandPalette.ts` 的 20 行中文**我只看了前 2 行（是 `keywords` 別名），其餘未逐行驗證。
4. 英文寫死的 JSX 文字，我的掃描誤報太多，**沒有可信的數字**；需要的話可改用 AST 規則統計。
5. `addToast` 86 處是否都合規（問題 6）尚未逐筆驗證。
6. 「過大」的判斷只看行數與 hook 數，沒有量測實際理解成本；`registry.tsx`、`CollectionsManager.tsx` 我未打開看結構。
