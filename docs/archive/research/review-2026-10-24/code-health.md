# 程式碼健康審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：`packages/backend`（Hono + Postgres）、`packages/frontend`（React/Vite PWA + 本機 DB worker）、`packages/markdown`。
方法：只讀程式碼，不讀任何 `.md`／`docs/`；用 `npx knip`、`npx madge --circular`、`npx jscpd`、`tsc --noEmit`、
`eslint src`、`vitest run`，再對抽樣結果人工核對。沒有改任何原始碼，也沒有把工具加進 `package.json`。

嚴重度：**P1**＝現在就讓修改有風險或變慢；**P2**＝債務。
**CONFIRMED**＝有工具輸出或可指出的確切重複／反例；**SUSPECTED**＝讀碼推論，尚未用執行驗證。

## 總覽

| 項目 | 結果 |
| --- | --- |
| 原始檔（src 下 ts/tsx） | 約 1920 個（不含 test 者的總行數約 13 萬行含 i18n）；測試檔 942 個 |
| `tsc --noEmit` | backend 通過；frontend 在乾淨 checkout 失敗 7 個錯誤（見 F9），`astro sync` 後通過 |
| `eslint src` | backend、frontend 皆 0 問題（exit 0） |
| `vitest run`（未接資料庫） | backend：1741 通過、**1 失敗**、1825 跳過（整合測試需資料庫，**我沒有跑**，不算通過）；frontend：3880 通過、**2 失敗** |
| 重跑失敗項 | `MarkdownRendererParity` 的 RSS 案例**穩定失敗**；`inviteClaim`、`bodyParsersLinear` 單獨重跑通過（平行時才失敗＝時間敏感） |
| 循環 import（madge，略過 type-only） | frontend 12 組、backend 1 組（有測試容許）、markdown 1 組 |
| 複製貼上（jscpd，≥12 行） | 只有 3 組、91 行（0.07%）——重複不在整段貼上，而在「同一件事不同名字」 |
| `as any`／`@ts-ignore` | 非測試 29 處（`localDbWorker.ts` 佔 18）；`eslint-disable` 90 處；`as unknown as` 非測試 44 處 |

共 **22 項發現**：P1 × 7、P2 × 15；CONFIRMED × 20、SUSPECTED × 2（F19、F20）。

## 發現（依回報排序）

### P1

**F1. [P1][CONFIRMED] 主線有一個確定失敗的前端測試：`MarkdownRendererParity` 檢查原始碼字串。**
`packages/frontend/src/test/MarkdownRendererParity.test.tsx:240` 斷言 RSS 面板原始碼含 `"<MarkdownRenderer math={false}>"`，
但 `modules/rss/RssReaderPanel.tsx:772` 現在寫成 `<MarkdownRenderer math={false} resolveImage={…}>`，所以穩定失敗（單獨重跑仍失敗）。
這類「讀原始碼比字串」的測試（全 repo 有 103 個測試檔用 `readFileSync`，其中不少是這種）會在無關的小改動上變紅，
也讓人習慣忽略紅燈。
修法：改成渲染 `RssReaderPanel` 或匯出一個「RSS 用的 math 設定」常數來斷言行為；原始碼守門測試（如 `importCycles`、`spineGate`）留著，但逐個確認是在守「規則」而不是守「某行文字」。

**F2. [P1][CONFIRMED] `components/MarkdownEditor.tsx` 是一個 1150 行的元件。**
`MarkdownEditor.tsx:296` 的 `function MarkdownEditor` 一路到檔尾（1453 行），內有 75 個 `useEffect/useCallback/useRef`、25 個 `useEffect`，
Props 一行列出 25 個欄位（`:296-300`）。它同時負責：CodeMirror 實例與 compartment、貼上／拖放圖片、`#標籤`／`[[連結]]` 補全彈窗、
工具列與選取氣泡、任務勾選、區塊動作、嵌入編輯、手機鍵盤行為。每次改其中一項都得讀懂全部。
接縫：(a) 補全彈窗＋`detectPopupTrigger`（`lib/editorCompletion.ts` 已有一半）；(b) 貼上／拖放／檔案匯入；(c) 工具列／選取氣泡；(d) 任務與區塊動作；(e) CodeMirror 擴充組裝。
修法：先把 (b)(c) 抽成 `useEditorPaste`、`useEditorToolbar` 兩個 hook，不改行為；完成條件是主元件 < 500 行且 `MarkdownEditor*` 測試不動。

**F3. [P1][CONFIRMED] 前端「核心 ↔ modules」有循環 import，移除模組要拆循環。**
madge（略過 type-only）：`modules/index.ts > modules/skills/index.tsx > ImportSkillDialog.tsx > lib/createSkillNote.ts > lib/moduleLibrary.ts / components/ModuleImportConfirm.tsx`，
以及 `modules/index.ts > modules/daily/… > components/collections/CollectionView.tsx > AddViewMenu.tsx > hooks/useModuleFilter.ts`（共 7 組）。
根因：核心用 40 處 `from "../modules"` 讀註冊表（這個作法本身是好的，見「做得好」），但註冊表同時 import 各模組的畫面，
而模組畫面又回頭 import 核心裡讀註冊表的檔案（例如 `lib/createSkillNote.ts:22` 取 `SKILLS_MODULE`）。
修法：把「純資料的註冊表（id、tag、命令）」和「畫面元件（lazy）」分成兩個入口；核心只 import 前者。`createSkillNote` 改吃參數，不直接 import `SKILLS_MODULE`。

**F4. [P1][CONFIRMED] 後端 `routes`／`services` 反向依賴 `modules`（2 處直接、1 處靠型別），模組並非真的可整個拔掉。**
`backend/src/httpError.ts:44` `import { ReviewError } from "./modules/review/index.js"` 並在 `:82` 特判；
`backend/src/services/actors.ts:31` import 整個 `MODULES`，在 `:686` 取各模組的 `personalTables`。
刪掉 `modules/review` 時 `httpError.ts` 會編譯失敗。另外核心裡仍有以 module 名為準的字串：`services/*` 內提到 rss 的檔案 14 個、semantic 21 個、website 15 個
（多為註解，但 `reservedTagKeys.ts`、`systemAttributes.ts`、`purgedContent.ts`、`eventRestore/attributes.ts` 是程式邏輯）。
修法：`ReviewError` 改繼承核心的 `HttpError` 基底（`httpError.ts` 只認基底類別）；`actors.ts` 改成 `registerPersonalTable()` 由模組註冊（模組已有 `personalTables` 欄位，只差反向）。

**F5. [P1][CONFIRMED] 同一個 UUID 正規表示式在 15 個檔案各抄一份，名字有三種。**
`const UUID_RE = /^[0-9a-f]{8}-…$/i` 出現在：`modules/rss/destination.ts:36`、`modules/rss/subscriptions.ts:24`、`services/harness/noteSkills.ts:40`（名為 `UUID`）、
`services/importMarkdown.ts:155`、`services/tagAbilities.ts:31`（唯一 `export`）、`services/sync/delta.ts:482`（`UUID`）、`services/nodes.ts:30`、
`services/backupRestore.ts:424`、`services/exportZip.ts:113`、`services/boardWrites.ts:14`、`services/tagMembership.ts:47`（小寫 `uuid`）、
`routes/canvases.ts:45`、`routes/boards.ts:28`、`routes/nodes.ts:474`、`frontend/src/lib/data/syncEngine.ts:364`。
這些被用來判斷「這是不是節點 id」，是權限／同步路徑上的輸入檢查；某天要放寬（例如大寫、`nil` UUID）時會漏改。
修法：在 `@onden/markdown`（兩端都已依賴）或 `backend/src/utils.ts` 放一個 `isUuid()`，一次替換 15 處；`tagAbilities.UUID_RE` 的匯出順便移除。

**F6. [P1][CONFIRMED] 後端標籤服務 `tagHierarchy` 直接用 `pool.query`，繞過 `q()` 與讀取快照。**
`services/tagHierarchy.ts:368` `descendantsOf`、`:448` `memberTagIds`、`:472` `memberTagIdsNamed` 都走 `pool.query`；
但 repo 內其他服務用 `q()`（可在交易／`withReadSnapshot` 內執行）。全後端 `pool.query` 共 153 處（`actors.ts` 18、`outbox.ts` 11、`routes/tags.ts` 9、`routes/nodes.ts` 8）。
在交易內呼叫 `memberTagIds` 會看不到同交易剛寫的標籤，在同步快照內會讀到快照外的資料。
`descendantsOf` 還是 `nodeTree.subtreeIds`（已有 `skipTagDefinitions`、`maxDepth`、`lifecycle` 選項）的另一份遞迴 CTE 實作，只被 `tagMerge.ts:173` 與 `routes/tags.ts:248` 用。
修法：這兩個函式改 `q()`；`descendantsOf` 用 `subtreeIds` 加一個「只取 class_tag」選項取代。標籤同名檢查（`assertTagNameAvailable`）同檔也確認一遍。

**F7. [P1][CONFIRMED] 三個巨型檔案各自混了多個責任。** 見下方「最大檔案」表：`localDbWorker.ts`（1261 行，18 個 `as any` 與 19 個 `eslint-disable`）、
`data/syncEngine.ts`（1100 行）、`KnowledgeWorkspace.tsx`（單一元件約 800 行，`:208` 起）。這三個是離線與白板的核心，改動頻率高、卻最難審。
修法見表；建議先動 `localDbWorker.ts`（把 journal、bootstrap 讀寫、sync 套用分檔），因為它同時是型別弱點最集中的地方。

### P2

**F8. [P2][CONFIRMED] 零呼叫者的程式碼（見下方「今天可安全刪除」清單）。** 主要有 `modules/skills/catalogue.ts`（整檔）、3 個沒被引用的 CSS、
`backend/src/services/nodes.ts:36 loadActor`、`backend/src/git.ts:57 getHistory`、前端 `patchTask`、`isSeeded`、`skillName`、`skillDescription`、`listSkills`。
全部確認過沒有動態 import、沒有被註冊表字串引用。

**F9. [P2][CONFIRMED] 乾淨 checkout 上 `npx tsc --noEmit`（前端）會失敗。**
7 個 `Property 'env' does not exist on type 'ImportMeta'`（`lib/api.ts:435`、`lib/accountStorage.ts:58`、`components/BuilderApp.tsx:78,90`、`components/ServerSetup.tsx:14`、`lib/siteFeed.ts:21`、`lib/share/shareSources.ts:42`）。
原因：`import.meta.env` 的型別來自 Astro 產生的 `.astro/types.d.ts`（已被 `.gitignore`），要先跑 `npx astro sync`。跑完之後 tsc 通過。
根目錄 `preflight:frontend` 是 `npx tsc --noEmit && npm run build`，在新環境（含 CI 或新的 agent 工作階段）第一步就紅。
修法：`preflight:frontend` 前面加 `astro sync`，或在 `src/` 放一個 `/// <reference types="astro/client" />` 的 `env.d.ts`。

**F10. [P2][CONFIRMED] 兩個名為 `wouldCycle` 的函式、兩個 `previewRestore`、前後端各一份 `tagsExtending`／`isTagModuleEnabled`／`memberTagIds`。**
- 後端：`services/tagAbilities.ts:120 wouldCycle(rows, tagId, targets)`（標籤繼承圖）與 `services/nodeTree.ts:103 wouldCycle(workspaceId, nodeId, newParentId)`（節點樹）；簽章與語意完全不同卻同名。
- 後端：`services/eventRestore/restore.ts:427` 與 `services/backupRestore.ts:369` 都叫 `previewRestore`。
- 前端／後端鏡像：`lib/tagModules.ts:63/107` 對 `services/tagAbilities.ts:20/83`；`lib/nodeTags.ts:68 memberTagIds` 對 `tagHierarchy.ts:448`（後端註解說靠 `tagMembershipParity.json` 固定一致，這是有意為之的雙實作，而且有測試守著，風險可接受）。
修法：把兩個 `wouldCycle` 改成 `wouldCreateTagExtendsCycle` 與 `wouldCreateParentCycle`；`previewRestore` 加上來源前綴。鏡像實作維持現狀。

**F11. [P2][CONFIRMED] `lib/ink/index.ts` 是只用了一半的桶檔。**
knip 報它 40 多個匯出沒人從桶檔引入——因為 60 處引用都是 `from "../lib/ink/xxx"` 直接路徑，只有 `InkPageCamera`、`inkReadOnlyMessage`、`encodeInk`…這幾個走桶檔。
桶檔讓人以為 `lib/ink` 有一個公開介面，實際沒有。順帶一個**假陽性示範**：`PixiCommittedRenderer`（`pixiCommitted.ts:21`）被 knip 判為未使用，但 `committed.ts` 用動態 `import()` 載入它（為了不把 pixi.js 79MB 依賴放進主 bundle），不能刪。
修法：桶檔只留真的對外的 6–8 個名字，其餘改為直接路徑。

**F12. [P2][CONFIRMED] 後端有 7 支沒有任何引用的 `scripts/`（共 1318 行）與一個沒人 import 的桶檔。**
`backend/scripts/a1AcceptanceSmoke.ts`（272）、`a2TimingSmoke.ts`（89）、`bMcpSmoke.ts`（454）、`erIntegrationSmoke.ts`（287）、`fix-slugs.ts`（55）、`import-notes.ts`（139）、`backfill-git.ts`（22）：
`package.json` 沒有對應 script，也沒有 CI／shell 引用（測試註解提到 `bMcpSmoke` 是「CI 已用 `httpRoutes.test.ts` 取代」）。
`services/maintenance/index.ts`（4 行）沒人 import，所有呼叫端都直接引 `maintenance/prune.js`。
修法：一次性腳本（`fix-slugs`、`backfill-git`、`import-notes`）和已被測試取代的 smoke 腳本直接刪；`maintenance/index.ts` 刪除。前端 `scripts/login-page-weight.mjs`、`measure-bundles.mjs`、`serve-static.mjs` 同樣沒有 package.json 入口（SUSPECTED，可能有人手動跑）。

**F13. [P2][CONFIRMED] 有一個永久 `describe.skip` 的測試檔。**
`backend/src/test/membershipAutobump.integration.test.ts:18`：「removed: tags no longer gate reads」——標題自己說測的東西已經移除。
修法：整檔刪除。其他 `skipIf(!isTestDb)` 是依資料庫存在條件跳過，屬正常，但代表**不接資料庫時 1825 個 backend 測試等於沒跑**，審查時要看 CI 是否真的接了資料庫。

**F14. [P2][CONFIRMED] 時間敏感的測試在平行負載下會假失敗，而且是最慢的測試。**
`backend/src/test/bodyParsersLinear.test.ts`（81 秒）與 `frontend/src/test/bodyParsersLinear.test.ts`（56 秒）斷言「長度 ×4 時間 < ×9」；
backend 的 `parseBlocks nested quotes` 在四個 vitest 平行時得到 11.8 倍而失敗，單獨重跑通過。兩邊各自佔整個套件單檔耗時的第一名（其餘檔案都 < 6 秒）。
修法：改成比較「計算次數／步數」或用較寬的倍率並重試一次；兩個檔案共用的 `Linear` 判定函式抽成一個 helper。`inviteClaim.test.tsx` 同樣在平行時失敗（找不到 `role="alert"`）、單獨通過，疑似 `waitFor` 逾時過短（SUSPECTED）。

**F15. [P2][CONFIRMED] `localDbWorker.ts` 的 `as any` 是 sql.js 的型別縫。**
`:222`、`:231`、`:429`、`:439` 等 18 處都是 `params as any` 傳給 `stmt.bind`／`run`，每處前面一行 `eslint-disable no-explicit-any`。
修法：寫一個 `bindParams(params: unknown[]): BindParams` 轉型 helper 放在檔案頂端，18 個 `as any` 與 19 個 `eslint-disable` 減到 1 個。
同理其他 `as any`：`lib/fileSystemStorage.ts`（File System Access API 缺型別）、`PuckStudioCanvas.tsx`（puck 的型別）。

**F16. [P2][CONFIRMED] `react-hooks/exhaustive-deps` 被關掉 44 次。**
`hooks/useCommandPalette.ts` 5、`hooks/useWorkspaceFocus.ts` 4、`hooks/useOverviewMode.ts` 3、`components/MarkdownRenderer.tsx` 3。
每一處都是「effect 該重跑的條件」與程式碼寫的不一致，是 stale closure 型 bug 的來源（錯誤多半在離線／同步邊緣情境才出現）。
修法：不必全改，先針對 `useCommandPalette`、`useWorkspaceFocus` 逐個改成 ref 或補依賴；新增規則：關閉時註解必須寫「為什麼不需要這個依賴」。

**F17. [P2][CONFIRMED] 14 個前端與 8 個後端檔案超過 700 行，且 `registry.tsx`／`OverviewSidebar.tsx` 內有大片重複 JSX。**
`jscpd` 抓到 `OverviewSidebar.tsx:370↔413` 重複 61 行（同一個頁面按鈕、重新命名輸入框在「有子節點」與「葉節點」兩條路徑各寫一次）、
`CollectionsManager.tsx:138↔168` 重複 16 行、`frontend/src/lib/ink/diff.ts:40↔markdown/src/ink.ts:377` 重複 17 行（跨套件的筆畫差異演算法，兩份改一份會漏）。
修法：`OverviewSidebar` 抽 `<SidebarPageRow>`；`ink/diff` 的重複改由 `@onden/markdown` 匯出、前端引用。

**F18. [P2][CONFIRMED] 依賴與 lockfile：多份 lockfile、未宣告的依賴、`patch-package` 掛在別的套件。**
- 倉庫有 4 份 lockfile：根目錄、`backend/`、`frontend/`、`frontend/e2e/`。根目錄 lockfile 內同時存在兩個 `@vitejs/plugin-react`（5.2.0／4.7.0）、兩套 esbuild（0.27.7／0.28.1）、兩個 `react-refresh`，顯示各套件鎖檔與根鎖檔已經漂移。
- knip 報**用了但未宣告**的依賴：`kysely`（`backend/src/auth.ts:3`）、`mdast`（`backend/.../importedImageLinks.ts:7`、`frontend/src/lib/taskLines.ts:17`）、`@lezer/highlight`、`@lezer/markdown`（`frontend/src/components/MarkdownEditor.tsx:13`、`lib/editorMathSyntax.ts:1`）、`remark-stringify`、`micromark*`（測試）。靠 hoisting 才碰巧能用。
- 根目錄 `postinstall` 跑 `patch-package`，但它只在 `packages/markdown/package.json:51` 宣告，根目錄 `package.json` 沒有；單獨在根目錄 `npm ci --workspace=packages/backend` 就會找不到指令（SUSPECTED，未實測）。
- 體積：`mermaid` 88MB（單一動態 import，`MarkdownRenderer.tsx:132`，OK）、`pixi.js` 79MB（動態載入，OK）、`lucide-react` 41MB（確認是否皆用具名匯入）、`pdfjs-dist` 35MB。這四個都只有一處或少數處使用，但都有 lazy 載入，是合理的取捨。
修法：只保留根目錄 lockfile（其餘刪除並在 CI 檢查），把缺的套件補進對應 `package.json`，`patch-package` 移到根目錄 devDependencies。

**F19. [P2][SUSPECTED] `agentSessions.ts` 開關與 `ONDEN_AGENT_SESSIONS=off` 是唯一還留著的功能旗標。**
`services/agentSessions.ts:89`；檔案 813 行，且 `loadRunner`、`endSession`、`SESSION_STATUSES`…等 10 個匯出只在同檔使用。若「關閉」從未被用過，旗標就是多一條要測的分支（`:93`、`:622`、`:776` 三處檢查）。
修法：確認線上是否曾設為 `off`；沒有就移除旗標，並拆出 `agentRunners.ts`（runner 設定／列表）與 `agentSessions.ts`（工作階段生命週期）。

**F20. [P2][SUSPECTED] 「舊資料相容」程式仍在跑，但很可能已無資料可轉。**
`localDbWorker.ts:279 adoptLegacyStore`（把舊的未分帳號 IndexedDB 收編）、`lib/accountStorage.ts:48 LegacyNativeStore`、`components/tagPage/structure/LegacyExtendsSection.tsx`（舊式 `extends`）。
這些都還會被執行到，所以不是死碼，但各自是「一次性搬遷」。若帳號分區已上線一段時間，收編路徑可整段拿掉。
修法：確認搬遷已完成的使用者比例後再刪；刪之前在 `adoptLegacyStore` 加一次性遙測或日誌。

**F21. [P2][CONFIRMED] 型別層循環：`tagFields.ts ↔ schemaValidation.ts`（backend）、`ink.ts ↔ inkSvg.ts`（markdown）。**
backend 這組只有 `import type`（`tagFields.ts:18`），執行期不成環（`importCycles.test.ts` 也只看執行期 import），不構成問題；
markdown 的 `ink.ts ↔ inkSvg.ts` 是真的執行期環（`inkSvg` 回頭用 `ink` 的函式）。
修法：把 ink 共用型別與小函式放進 `inkTypes.ts`，兩邊都從那裡 import。

**F22. [P2][CONFIRMED] 其他小的未使用匯出：後端 63 個、前端 81 個值匯出＋78 個型別匯出。**
抽樣 18 個後端與 20 個前端：**多數「只在同檔使用」**（加了 `export` 但沒人 import，例如 `MAX_BODY_IDS`、`loadRunner`、`restoredAttribute`、`citedKeys`、`rssCounts`），只有第 F8 列的幾個是真正零呼叫。
這類只是雜訊，不建議專案層級清除；建議在 knip 設定檔把「匯出給測試用」的列為例外後，在 CI 以 `knip --include exports` 只擋**新增**的未使用匯出。

## 最大檔案與接縫

（行數為非測試原始檔；`lib/i18n.zh-TW.ts` 3160 行為純字串表，不算。）

| # | 檔案 | 行數 | 一個責任還是多個？ | 接縫 |
| --- | --- | --- | --- | --- |
| 1 | `frontend/src/components/MarkdownEditor.tsx` | 1453 | 多個（F2） | 補全彈窗／貼上拖放／工具列與選取氣泡／任務與區塊動作／CodeMirror 擴充組裝 |
| 2 | `frontend/src/lib/localDbWorker.ts` | 1261 | 多個 | journal 與快照持久化（`:106-215`）／bootstrap 讀寫（`:302-455`）／sync 套用與佇列覆蓋（`:456-595`）／屬性與游標存取（`:596-735`）。`localDbJournal.ts`、`localDbPersist.ts` 已拆出一半 |
| 3 | `frontend/src/lib/data/syncEngine.ts` | 1100 | 多個 | 全量／增量 refresh（`:78-260`）／單筆與背景水合（`:290-420`）／圖片下載離線（`:423-500`）／membership 對帳（`:501-660`）／同步排程 |
| 4 | `frontend/src/components/KnowledgeWorkspace.tsx` | 1007 | 一個元件但過大 | `:208` 起單一元件約 800 行：節點／邊建構、鍵盤規則、拖動、導覽、插入選單；`useGraphLayout` 已先拆出 |
| 5 | `backend/src/services/eventRestore/restore.ts` | 975 | 一個主題、多個處理器 | 流程骨架（`restoreEvent`、`restoreWithinTransaction`）／`previewRestore`（`:427-560`）／node 刪除、還原、更新、移空間處理器（`:562-975`，其中 `restoreNodeUpdated` 一個就 200 行）。處理器可搬到 `restoreHandlers` |
| 6 | `frontend/src/settings/registry.tsx` | 933 | 多個 | 一個註冊表加 8 個設定小工具（備份、匯入、標籤包、伺服器狀態…）；每個 widget 可獨立成檔 |
| 7 | `backend/src/services/backupRestore.ts` | 909 | 一個主題 | 讀取／計畫（`:192-420`）／套用（`:511-720`）／續跑（`:724+`）；已有 `backupFile/Archive/RestoreJobs/Undo` 分檔，這個檔是剩下的核心，可接受 |
| 8 | `backend/src/services/outbox.ts` | 894 | 多個 | 執行器與逾時（`:73-140`）／入列 API（`:201-420`，含 backup、pages、publish 三種業務入列）／排程 drain（`:465-680`）／死信管理（`:731-860`）。業務入列應回到各模組 |
| 9 | `frontend/src/modules/rss/RssReaderPanel.tsx` | 857 | 一個元件過大 | `:96` 起單一函式約 760 行：文章清單／閱讀區／訂閱管理／全文載入 |
| 10 | `frontend/src/modules/website/CollectionsManager.tsx` | 817 | 多個 | `ViewsEditor`、`SchemaEditor`、`ItemEditor`、`ItemList` 已經是同檔的 4 個元件，各自成檔即可 |
| 11 | `backend/src/services/agentSessions.ts` | 813 | 多個 | runner 設定／工作階段生命週期／提及解析（F19） |
| 12 | `frontend/src/lib/api.ts` | 734 | 多個 | 型別定義（`:1-355`）／API base 與伺服器檢查（`:414-520`）／fetch 管線與錯誤（`:530-700`）。型別區塊獨立為 `apiTypes.ts` 是最便宜的一刀 |
| 13 | `frontend/src/components/OverviewEditor.tsx` | 733 | 一個 | 尚可，需看是否與 `OverviewEditorHost.tsx` 重疊 |
| 14 | `frontend/src/components/OverviewSidebar.tsx` | 709 | 一個但含重複 | F17 的 61 行重複 |
| 15 | `markdown/src/blocks.ts` | 703 | 一個 | 解析、錨點、區塊 id 指派；內聚，不用動 |

## 今天可以安全刪除的項目（含證據）

| 項目 | 證據 |
| --- | --- |
| `frontend/src/modules/skills/catalogue.ts`（39 行） | 全 repo（含 `.astro`、scripts）搜尋 `catalogue` 只剩註解與自己；knip 列為 unused file；檔案歷史經過「移除內建 API AI」的提交，推測是該批殘留 |
| `frontend/src/modules/skills/api.ts` 的 `listSkills`（`:19`） | 唯一呼叫者是上面的 `catalogue.ts` |
| `frontend/src/modules/skills/builtinSkills.ts` 的 `skillName`、`skillDescription`（`:19`、`:23`） | 全前端 `grep -w` 只有定義 |
| `frontend/src/components/DataBackup.css`（49 行）、`MarkdownEditorField.css`（7 行） | 沒有任何 `.tsx` 引用 `.data-backup-*`、`.md-editor-field-frame` 類別，也沒有 CSS import |
| `frontend/src/components/GraphCardNodes.css`（16 行） | 沒有任何檔案 import 它；它的 3 條規則（`graph-card-node--colored`、`graph-card-tag-chip--colored`、`graph-card-field-pill--bordered`）對應的類別在全前端沒有任何使用處（`graph-card-node--folded` 等其他類別在 `CardNode.css`） |
| `frontend/src/lib/data/storeOps.ts:74 patchTask`、`lib/data/syncStatus.ts:44 isSeeded` | `grep -w` 只有定義，無測試引用 |
| `backend/src/services/nodes.ts:36 loadActor` | 只有定義與一則測試註解；活的是 `services/currentActor.ts` |
| `backend/src/git.ts:57 getHistory`（連同 `HistoryEntry` 型別） | 只有 `httpRoutes.test.ts:102` 的 mock 還提到它；`getDiff` 仍被 `modules/website/routes.ts:5` 使用，要保留 |
| `backend/src/services/maintenance/index.ts` | 沒有人 import；所有呼叫端與測試引 `maintenance/prune.js` |
| `backend/src/test/membershipAutobump.integration.test.ts` | 整檔 `describe.skip`，標題自述功能已移除（F13） |
| `backend/scripts/{a1AcceptanceSmoke,a2TimingSmoke,erIntegrationSmoke,fix-slugs,import-notes,backfill-git}.ts` | 無 package.json／CI／shell 引用；其中三個是一次性修補腳本。`bMcpSmoke.ts` 同樣沒引用，但可能還有人手動跑，列為 F12 的建議而非「今天安全」 |

**不要刪（knip 假陽性）**：`PixiCommittedRenderer`（動態 import）、`public/sw.js`、`public/pdf.worker.min.mjs`（由建置／runtime 以路徑載入）、
`e2e/**`（372 個「未使用檔」中 360 個是 Playwright 規格，knip 沒有 Playwright 設定）、`eslint-rules/*.d.ts`、`eslint.config.js`，
以及各 `modules/*` 用註冊表字串載入的檔案。

## 測試品質

- 數量：942 個測試檔；backend 3567 個測試（未接資料庫時 1825 個跳過），frontend 3882 個。沒有 `it.only`／`it.todo`，唯一的無條件 `skip` 見 F13。
- 「斷言原始碼文字」：103 個測試檔使用 `readFileSync`。其中 `importCycles`、`spineGate`、`harnessBoundary` 屬於「守規則」（好）；`MarkdownRendererParity` 的 RSS 案例屬於「守某行文字」（F1，已紅）。建議逐檔分類，後者改成行為測試。
- mock 被測物：抽查 `eventRestore.test.ts`（6 個 `vi.mock`）、`restoreHandlers.test.ts`（5 個）：mock 的是 `db`、`authority`、`currentActor`、`eventTransaction` 等**周邊**，被測的 `restoreEvent` 本身是真的——可接受，但這兩個檔等於在驗證「呼叫順序」，真正的行為由整合測試保護，而整合測試在無資料庫時不會跑。
- 速度：除了 F14 的兩個線性度測試（56–81 秒），所有測試檔 < 6 秒；frontend 486 檔總耗時約 238 秒（累加），backend 約 92 秒。

## 做得好的地方

1. **用測試守住架構邊界。** `backend/src/test/importCycles.test.ts` 把「routes/modules 在 services 之上、services 在 spine/db 之上」變成會紅的規則，容許清單只有一組（`tagMembershipWrites ↔ templateExpander`），而且註解寫出了為什麼容許。實測 backend 執行期循環只剩這一組（外加 markdown 的一組）。這正是「AI 快速小 PR」最需要的護欄。
2. **模組註冊表很誠實。** `backend/src/modules/types.ts` 的 `ModuleDefinition` 只有路由、工具、dispatcher handler、outbox effect、個人資料表這幾個欄位，明說不做動態載入與沙盒；前端核心 40 處引用都走 `../modules` 單一入口，沒有任何核心檔案直接伸進某個模組的內部檔案。F3、F4 要修的只是少數幾個破口，而不是整體設計。
3. **重複程式碼極少、lint 與 backend 型別乾淨。** `jscpd` 只找到 3 組、91 行（0.07%）；`eslint src` 兩邊 0 問題；`@ts-ignore` 只有 1 處、`@ts-expect-error` 1 處；自訂 ESLint 規則（`no-route-writes`、`require-read-gate`、`modals-through-ui-modal`）把權限與 UI 規則放進靜態檢查。

## 方法限制

- 沒有跑需要資料庫的整合測試（backend 1825 個跳過），因此整合測試的紅綠沒有評估。
- `knip` 沒有專案設定檔，預設不認得 Playwright／Astro 頁面入口，所以前端「372 個未使用檔」只有 5 個是真的（已手動核對，其餘為 e2e 規格與 public 資源）。
- `madge` 的 12 組前端循環是略過 type-only import 的結果；含型別的原始結果是 30 組。
- 單檔責任歸類是讀函式清單與抽樣段落得到的判斷，沒有逐行讀完 15 個檔案。
