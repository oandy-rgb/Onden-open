# Onden 開發指引

適用於整個 repository。使用者本次明確要求優先於本文。本文只留每次任務都要遵守的硬規則；
解釋、範例、各批設計決定與分區指引在 [docs/agents/](docs/agents)，依下方索引按任務讀。
本文不表示既有程式都已符合，也不授權順便重構全專案。每條規則的完整原文在索引所列檔案。

## 工作方式

- Onden 是給資工大學生用、也用來學習的長期專案：優先資料可靠、日常使用舒適、使用者能理解並接手。
- 用繁體中文說明具體行為、責任邊界與驗證結果；區分已實作、已測試、建議方向。
- 修改前確認相關入口、資料流與既有未提交變更；保留任務範圍外的工作。
- 每批重構選一個完整使用案例，先定義要減少的理解負擔與完成條件，再改、再驗；
  符合契約且驗證通過就停止擴大。程式碼變短或測試通過，不單獨證明設計變簡單。
- 在本次涉及的邊界修掉造成重複特例的根因，不在每個入口再補一個分支。
- 語言模型只有兩條路，都受 MCP 同一套工具、權限、寫入與紀錄約束（業主 2026-10-30 決定，推翻 2026-10-23 的「不呼叫任何模型」）：
  使用者自己的 Claude 透過 MCP／訂閱執行程式，或**伺服器用使用者自己的 API 金鑰**呼叫模型（`services/agentRuntime/api/`，**只能提建議**）。
  不新增全域 API key、預設模型、直接寫入的模型迴圈，也不在 `agentRuntime/api/` 以外 import 模型 SDK（`harnessBoundary.test.ts` 擋）；
  見 [decisions-ai-collaboration.md](docs/agents/decisions-ai-collaboration.md)、[harness.md](docs/architecture/harness.md)、
  [agent-delegation.md](docs/architecture/agent-delegation.md)。

## 設計硬規則（細節：[design-principles.md](docs/agents/design-principles.md)）

- 公開介面表達使用者要完成的事（改名、完成任務、保存、復原）。元件、路由、agent 工具重用領域操作，
  不各自組合權限、事件、交易、離線佇列與回復流程。
- 新公共介面或重要責任切分：先比較至少兩種設計草圖，並寫簡短契約與呼叫範例，再實作；簡單修正免。
- 新抽象須指出消除的重複責任或錯誤來源，且在本批遷移中實際使用；優先沿用現有模組與 registry，
  不為假想擴充預建政策語言、插件框架或事件平台。搬檔案、縮短函式、加轉呼叫層不算完成重構。
- 功能模組的入口（`modules/<id>/index`）只放登記資料（id、名稱、圖示、指令、判斷是否在用的小函式）；畫面、編輯器、對話框、設定元件與大型函式庫用 `lazyWithReload`／`import()` 用到才載。
  建置後 `scripts/check-boot-bundle.mjs` 檢查登入後必載 JS 的 gzip 總預算與每個模組的上限，超過就失敗並指出模組（見 [modules/README](packages/frontend/src/modules/README.md)）。
- 影響使用決策的保證（保存確認、覆蓋範圍、撤權結果）放進介面與名稱；只隱藏不影響使用方式的內部選擇。
- 同一概念同一名稱；ID、游標、版本、時間單位從名稱或型別可辨識；不用含糊的 `data`／`info`／`manager`。
- 錯誤語意與回傳型別一致；既有慣例有問題時，在明確範圍內修正並遷移呼叫者，不為新入口另建近似慣例。
- 註解只寫不明顯的原因、不變條件與取捨；跨模組契約集中記錄並從使用處連結。
- 警訊（一個小改動牽動很多入口、轉呼叫層增加、旗標增加、兩模組須交叉閱讀、註解要解釋大量內部步驟）：
  指出原因並在本批範圍處理。

## 事件、權限、復原、同步是四種責任，不互相代替

權限政策＝操作者現在能做什麼（後端依可信身分與目前政策判斷）；操作紀錄／領域事件＝已提交的事實；
復原＝新的、依目前權限執行的操作；同步＝內容增量與可讀集合的變化。可共用資料表與交易；
操作歷史不自動等於 Event Sourcing。完整表格：[backend-rules.md](docs/agents/backend-rules.md)。

## 權限（完整：[backend-rules.md](docs/agents/backend-rules.md)）

- 集中定義與測試政策；領域操作宣告所需能力，入口不重寫角色、標籤、繼承與 scope 判斷。
- 寫入走 `spine/mutate.ts`、`spine/authority.ts`（`spine/` 不得 import `services/`，ESLint 擋；spine 需要的規則放在 `spine/`）；讀取走 `services/readPolicy.ts` 的公開介面
  （含集合查詢的 SQL 範圍），不先全量取出再另寫可見性判斷。
- actor／token ID 來自可信驗證情境，role／scope 不可沿用等待前的快照：根寫入在事件鎖後經
  `spine/currentActor.ts` 重讀；`mutate` 前還有來源、父層或建立範圍判斷的領域操作也須在同一鎖內用當前 actor。
  找不到 actor 時不得沿用舊值。
- 標籤套用／移除用 `services/tagMembershipWrites.ts`；背景派生與重啟補跑在寫第一個屬性前重驗權限。
- 一般操作、批次、匯入、復原、背景工作、agent 工具都遵循適用的權限邊界；UI 隱藏與本機快取不是授權依據。
- 操作者取自可信驗證情境，沿用 cascade 的根操作者與因果追蹤；不接受客戶端指定權限種類，
  不以 `open`／`cascade` 修掉授權失敗。
- 重構保持既有允許／拒絕結果；改政策行為須說明受影響的操作者、資源、操作，並驗證允許與拒絕案例。
- 政策改變可能影響整個子樹或集合：沿用 `membership_epoch` 與可讀集合核對，驗證撤權與重連後結果。

## 事件與交易（完整：[backend-rules.md](docs/agents/backend-rules.md)）

- 領域操作定義事件種類、對象與必要資料；共用機制負責歸屬、因果、交易與重試去重，UI／路由不重複配置。
- 狀態變更與成功事件必須同一交易提交或回滾，適用的權限集合版本也在同一交易；
  「呼叫了檢查」不等於已消除授權與寫入之間的競態。
- 網路失敗可能只是回應遺失：重試沿用原冪等鍵；失敗交易不留下會吞掉有效重試的成功標記。
- 被拒絕的嘗試、診斷日誌與已提交事件語意不同，失敗嘗試不得成為同步或復原中的成功變更。
- 事件內容服務明確用途，不傾倒整個請求或憑證；改事件格式要檢查歷史、復原、同步消費者。
- 外部副作用走既有 outbox，不新增與資料庫交易各自提交的傳送流程。

## 復原（完整：[backend-rules.md](docs/agents/backend-rules.md)；契約：[restore-writes.md](docs/architecture/restore-writes.md)）

- 復原是依目前權限執行的新操作，產生新紀錄並保留原歷史；可否復原、所需資料、衝突處理屬操作契約，
  外部副作用不假定可逆。
- 不得覆蓋未納入本次操作的後續編輯；無法證明安全就保留現況並回明確拒絕，不假成功。
- 逆向操作檢查逆向的權限；`force` 不繞過 parent 授權或 cycle 檢查。
- 不新增繞過 `restoreEvent`（`services/eventRestore/restore.ts`）的復原旁路；
  共用權限、交易、事件機制逐步收回既有邊界，領域保留自己的衝突判斷。

## 錯誤與保存（完整：[errors-and-saves.md](docs/agents/errors-and-saves.md)）

- 先考慮能否消除不必要的失敗情形，但不得吞掉授權失敗、儲存失敗、資料損壞或未知例外，
  也不得擅自改變既有 API 語意。
- 後端共用錯誤由 `packages/backend/src/httpError.ts` 映射；路由只捕捉自己能處理的清理、衝突、部分成功。
- 前端沿用領域 writer、`writeLifecycle.ts`、`writeQueue.ts`、`writeErrors.ts`；不自創 HTTP 分類、通知、重試或離線成功定義。
- 保存確認只能來自伺服器接受或離線佇列已持久化，且 UI 區分兩者：只有記憶體更新不能顯示已保存，
  待同步不能顯示已同步。
- 區分永久拒絕、登入失效、可重試失敗、本機儲存失敗；回復只影響本次操作，保留較新修改與可恢復輸入。
- 已收到提交確認後，本機副本更新失敗不得改判為未提交，也不得誘發重複建立。
- 依賴成功才關閉、清空、跳頁的表單必須等待結果並在失敗時保留輸入；同一錯誤不重複通知；
  `backgroundWrite` 僅用於不依賴成功後續動作者。
- 手機、桌面、快捷操作與不同檢視共用保存與錯誤契約，只有布局可以不同。

## 使用者介面文字（業主規則 2026-10-23：「JSON 這類技術細節不應該給使用者看」）

- UI 不顯示 JSON、uuid／id（含截短）、token id、`snake_case` 錯誤碼、事件常數（`NODE_UPDATED`）、
  `effect_kind`、毫秒／耗時、堆疊與伺服器原文錯誤；收合的「技術細節」也不行。改用一句白話：誰做了什麼；失敗給簡短原因。
- 錯誤文字只走 `lib/serverErrors.ts`（未知代碼＝通用訊息，不回傳原文）、`writeErrors.message`／`writeErrors.requestMessage`；
  不直接顯示 `error.message`。事件名走 `eventTypeLabel`，背景工作名走 `effectKindLabel`。找不到名稱時顯示「未命名」等，不退回 id。
- 例外只限使用者自己設定的內容（MCP token 的名稱與工具清單、輸入的網址、一次性顯示的 token 明文）。
- ESLint 擋 JSX 子節點裡的 `JSON.stringify`；經 helper 回傳的字串仍靠審查。

## 已定案的共用入口（動這些之前先讀對應的 decisions 檔；理由與例外都在那裡）

- 復原：`restoreEvent(eventId, { actor, workspaceId, ... })`，歸屬由 ActorCtx 推導，路由不另傳 `actorId`／`actorType`；
  可捕捉的失敗用 `withSavepoint`；同一 client 的 savepoint 與 ambient 寫入依序 await。垃圾桶：一般
  `node`／`canReadNode` 只看 live 節點，復原與治理歷史用 `retained_node`／`canReadRetainedNode`。
- 一般筆記編輯：`services/nodeUpdate.ts` 的 `updateNode`（REST PATCH 與 agent 共用）；先取工作區事件鎖，再讀狀態、查政策、保存。
  普通 PATCH 不得把 class_tag 改成 content（422，含管理員）。標籤同名用 `tagHierarchy.assertTagNameAvailable`（409 `tag_name_conflict`）。
- 標籤關聯的復原核對由 `services/tagMembership.ts` 擁有；屬性是完整快照（`null` 表示不存在）。
- 交易：領域只選 `withTransaction`／`withSavepoint`／`withEventTransaction`；冪等快取與回滾通知由 `txHooks`／`withTxHookScope` 承擔。
- 同步回應：`withReadSnapshot`／`withActorReadSnapshot`，其內讀取一律 `q()`、不穿插 `pool.query`，已在交易內會被拒絕；
  membership 核對由 `reconcileMembership` 擁有，`done.eventCursor` 不能直接寫入 `last_event_id`。
- 離線與帳號：拒絕輸入保留（`rejectPendingWrite`、`preserveDirectRejection`），不自動重送；本機副本經 `accountStorage.ts` 分區，
  API 請求帶 `X-Onden-Expected-User`（`bindAccountStorage`）；登出前 `prepareEditorForExit()`；進行中寫入 `protectPendingWriteOnExit`。
- UI 復原與匯出：版本 `useVersionRestore().restore`、筆記 `useNoteExport`（`export-preview` 前後端須同版）。
- 匯入：單筆 `importMarkdownNote`、圖片 `prepareImportedImages`、資料夾 `modules/importers/obsidian/folders.ts`；白板布局
  `applyCanvasPositions`、`placeCanvasNode`、`refreshOpenCanvas`。

## 這件事歸誰管（唯一入口；已存在才列，先用這些，不另寫第二套）

- Markdown 語法、段落、標題、連結、閱讀時間 → `@onden/markdown`；首頁設計資料型別與驗證 → `@onden/site`。
- 搜尋筆記（側欄、指令面板、`((`）→ `reads.notes.search`（`lib/data/noteSearch.ts`）：伺服器優先、離線退回本機、最後錯字容忍；查詢語法 `parseSearchQuery` 在 `@onden/markdown`。不另寫第二套。
- 前端讀寫伺服器 → `packages/frontend/src/lib/data`。後端寫入 → 領域操作／`spine/mutate.ts`；讀取權限與空間範圍 → `services/readPolicy.ts`。
- 後端新的資料庫查詢 → `dbKysely.ts` 的 `db`（有型別，走 `q()` 所以共用交易）；型別由 `npm run db:types` 從 migrations 產生；舊的手寫 `q()` SQL 逐檔只減不增（規則 `be-raw-sql`）。見 [portable-backend.md §9](docs/architecture/portable-backend.md)。
- 日期與「今天」→ 前端 `lib/localDate.ts`（頁面用 `hooks/useToday.ts`）、後端 `localDay.ts`；日期加減（`addDays`／`daysBetween`／`addMonths`）與「是不是日曆日」（`isCalendarDay`）是 `@onden/markdown` 的，兩邊都從那裡來。
- 選日期 → `components/ui` 的 `DatePicker`（不再用原生 `<input type="date">`，守門：`packages/markdown/src/test/guards/tasks-time.guard.test.ts`）；一段文字是哪一天 → `@onden/markdown` 的 `parseDateText`（內部走 `parseTaskInput`／`toCalendarDate`）；月曆格 → `buildMonthGrid`／`stepMonth`（只吃工作區的「今天」，不讀裝置日期）；是不是日記 → `dayNoteDate`；某天被編輯的筆記＝`services/history` 的「儲存」（`saveOnDaySql`），日記頁的時間線與歷史共用。
- 任務落在哪個 bucket／分頁（逾期、今天、即將、某天）→ `@onden/markdown` 的 `taskBucket`／`taskHome`；重複規則（`parseRecur`、`nextOccurrenceDate`）也在那裡。後端 agenda SQL 是同一規則的 SQL 寫法，由 `taskBucketRule.integration.test.ts` 對齊。
- 「這次更新」卡片與設定 › 更新紀錄 → 內容來自 `changes/`（build 時由 `lib/whatsNew.ts` 打包，不進 local-DB worker）；看到哪一筆跟著帳號（`lib/changesSeenStore.ts`，只往前）。
- 帳號偏好 → `createAccountPref`（`lib/accountPrefStore.ts`）＋ `/api/me/prefs`；一次性提示 → `useHintOnce`。
- 彈出、選單、對話框、按鈕 → `components/ui`。選位置 → `PlacePicker`／`lib/placeGroups.ts`。
- 手寫輸入 → `lib/ink`（`InkEngine`）與 `components/InkToolbar.tsx`；形狀幾何 → `@onden/markdown` 的 `inkShapes.ts`；停住修形 → `lib/ink/recognize.ts`；墨水顏色 → `lib/ink/palette.ts`＋`lib/inkPrefs.ts`。
- 寫新的元件或共用邏輯之前，先在 [docs/agents/entrypoints-catalog.md](docs/agents/entrypoints-catalog.md) 依需求查；真的要新增共用入口，把它加進清單（`scripts/entrypoints.catalog.json`，再跑 `npm run catalog`）。
- 基準與例外清單只准減少：`scripts/*baseline*.json`、`packages/*/eslint-rules/*{allowlist,exceptions}*.json`、guard 測試裡以 `// ratchet:list <標籤>` 標記的例外陣列，由 `npm run ratchet:check`（含 markdown 套件的 `ratchet.guard.test.ts`）對 `git merge-base HEAD origin/main` 比對（找不到 origin/main 就失敗，不當作通過：先 `git fetch origin main`）；也涵蓋 `guards/allowlist/*.ts`、a11y 基準、layout-audit 基準、`bench-budgets.json` 與測試檔裡的 `ratchet:list`；計數變大、既有規則多了檔案、例外多了項目就失敗，整組新規則與刪除放行。新增例外陣列要加標記。真的要放寬只能由擁有者在 PR 說明寫明原因，並在 commit 訊息帶 `ratchet-override: <原因>`（腳本看到才放行）。
- 寫新的工具函式前先找現成的；新加的要在 PR 說明寫為什麼不用現成的。
- 各套件另有一份就近的對照表（「在這裡要做 X，一律用 Y」＋守門測試）：[前端](packages/frontend/AGENTS.md)、[後端](packages/backend/AGENTS.md)、[markdown](packages/markdown/AGENTS.md)、[site](packages/site/AGENTS.md)；`components/ui`、`lib/data`、`spine/` 資料夾內也各有一份。其中的允許清單表由 `npm run agents:tables` 從 `owners.ts` 產生，不手改。
- 最近更新排序 → `lib/noteOrder.ts`；存成檔案下載 → `lib/download.ts`；位元組轉 hex、SHA-256 → `lib/hex.ts`；月份鍵 → `lib/localDate.ts` 的 `monthId`；離開頁面時存檔 → `lib/pageHide.ts` 的 `onPageHide`（守門：`shared-helpers.guard.test.ts`）。
- 寫檔即檢查：`.claude/settings.json` 的 PostToolUse hook 在每次 Write／Edit／MultiEdit 後跑 `scripts/checkEditedFile.mjs`，用上面允許清單守門的同一份規則（各套件 `allowlist/fileRules.ts`）只檢查那一個檔；次數高於 `scripts/allowlist-baseline.json` 就 exit 2 並寫出規則、行號與該用的主人。被擋時改用訊息裡的主人入口，不要改基準、`owners.ts` 或 `--no-verify`；新規則加在 `fileRules.ts`，hook 與守門測試才會一起生效。本機 session 也會多跑這一次（約 1 秒）。
- 收斂一處重複時，同一個 PR 加守門測試（`src/test/guards/*.guard.test.ts`）。
- `npm run dup:check` 只准減、不准增逐字重複；變少時用 `npm run dup:baseline` 降低 `scripts/dup-baseline.json`。
- `npm run dup:names` 只准減、不准增「同名匯出」（同一個函式／常數名稱在兩個以上檔案各自定義；jscpd 抓不到）；變少時用 `npm run dup:names:baseline`
  降低 `scripts/dup-names-baseline.json`，通用名稱要放該檔 `allow` 並寫理由。兩個檢查都在完整 vitest 的 `dup.guard.test.ts` 內，不是只有 `npm run check` 才跑——新 PR 必須通過。
- `npm run dup:near` 只准減、不准增「近似重複」（變數改名、改註解後仍相同的函式；正規化後相似度 ≥ 0.8，jscpd 與 `dup:names` 都抓不到）；
  變少時用 `npm run dup:near:baseline` 降低 `scripts/dup-near-baseline.json`（只掃產品程式，不含測試）。同樣在 `dup.guard.test.ts` 內跑。
- 前後端要一致的常數與判斷 → `@onden/markdown` 的 `sharedContract.ts`（任務模組 id／`_task_*` 屬性鍵／任務標籤功能、發布的邊類型、回溯上限、標籤頁列數、密碼長度、檢視的內建欄位與篩選運算）、`isUuid`／`UUID_SOURCE`、`isHexColor`、`BLOCK_ID_CHARS`；不在兩邊各寫一份。守門：`packages/markdown/src/test/guards/crossPackage.guard.test.ts`；清單與待收斂項目：[docs/research/dup-sweep-2026-10-29-cross.md](docs/research/dup-sweep-2026-10-29-cross.md)。
- 後端：SHA-256 十六進位摘要 → `utils.ts` `sha256Hex`；事件附加鎖 → `spine/eventLock.ts` `lockEventAppend`；區塊 id → `blockNodes.ts` `newBlockId`；「哪些事件算儲存」→ `services/history` `bodyEventSql`；復原的 `history_incomplete`／`state_conflict` 拒絕 → `eventRestore/refusals.ts`；路徑中的 bigint id → `routes/params.ts` `parseBigintId`；新筆記預設落點 → `services/spaces.ts`。清單與待處理批次：[dup-sweep-2026-10-29-backend.md](docs/research/dup-sweep-2026-10-29-backend.md)；守門 `src/test/guards/dupSweep.guard.test.ts`。
- 允許清單守門（預設拒絕：只有列出的主人能用，其他一律失敗）：前端 import 分層 `packages/frontend/eslint.boundaries.config.js`；平台全域（`window`、`document`、`crypto`…）、原生 `<button>`／`<input>` 等、CSS 的顏色／圓角／陰影／z-index／字級／`@media` 寬度（600／900／1280）／`position: fixed` 的主人表在 `packages/frontend/src/test/guards/allowlist/owners.ts`；後端 route 的 import 層、`process.env`、`setInterval`、`console`、route 內直接下 SQL（`.query(`、`q(`；含 `modules/*/routes.ts`） 在 `packages/backend/src/test/guards/allowlist/owners.ts`。`scripts/allowlist-baseline.json`（`{ 規則: { 檔案: 次數 } }`）已清零（2026-10-31），現在是嚴格模式：每條規則必須維持空物件（唯一例外：`be-raw-sql` 逐檔計數、只減不增，見 `allowlistLib.mjs` 的 `RATCHET_RULES`），基準有任何項目、或任何違規，守門測試直接失敗。失敗訊息寫「這個檔不准用 X，請改用 <主人>」：改用主人，不要記基準。新增主人須在 `owners.ts` 該行寫理由，且主人必須是 catalog 某筆的 `entry` 檔；沒有「還沒改」的容身處。新增規則時先把現有違規清到 0 再加（基準檔裡只加該規則的空物件）。
  app 的 CSS／TSX 讀顏色只准 `var(--ac-*)`（規則 `css-legacy-token`；准用前綴與理由在 `TOKEN_PREFIX_OWNERS`）；舊別名（`--accent`、`--muted`、`--onden-text-muted`…）已刪，只剩已發布網站共用樣式表還在讀的幾個，記在基準。

## 驗證與完成條件（完整：[testing.md](docs/agents/testing.md)）

- 從對應套件目錄執行相關 `npm test -- <測試路徑>`、`npx tsc --noEmit`、`npm run lint`；
  影響前端建置或載入時加 `npm run build`（會印出開機 JS 大小與每個開機 chunk 最大的來源檔；新功能預設延後載入，開機預算只准調低）。純文件改動檢查內容與連結：`node scripts/check-md-links.mjs`。
- 改了使用者看得到的東西（`packages/frontend/src`、`packages/site/src` 的非測試檔），就在 `changes/` 加一個檔案（寫法見 [changes/README.md](changes/README.md)：
  日期加一到兩句白話，不寫版本、PR 編號、檔名等技術字）；`npm run changes:check` 會比對 `origin/main...HEAD` 提醒。
  確實使用者看不出差別時，在 PR 說明寫「不需要更新說明」並以 `--skip` 略過。
- 新 PR 必須通過 `npm run dup:check` 與 `npm run dup:names`（前端完整 vitest 的 `src/test/guards/dup.guard.test.ts` 會跑）；
  新增工具函式在 PR 說明寫為什麼不用現成的。
- 針對改動的不變條件測試：權限涵蓋允許／拒絕、workspace／scope 邊界、撤權；交易涵蓋事件回滾、重試去重；
  保存與復原涵蓋輸入保留、後續編輯、衝突與離線重連。政策有逐筆與集合兩種實作時驗證兩者一致。
- 資料庫整合測試使用隔離測試資料庫；確認哪些測試實際執行，跳過的不算通過。後端與前端的 vitest 每輪結尾印 `[tests] mode: …, ran N, skipped M`，跳過資料庫測試又不是明說的無資料庫輪（`npm run test:no-db`）就失敗；每種跑法的模式見 [testing.md](docs/agents/testing.md)。
- 影響介面的變更用瀏覽器檢查桌面與手機尺寸（文字密度、留白、重疊、溢出、焦點、保存回饋）；
  手機 viewport 須如實標示，不宣稱真機通過。
- 改 UI（版面、樣式、元件結構）的 PR 要跑 `npm run build:browser`（根目錄），再在 packages/frontend 跑 `npm run layout:audit`：用程式量位置，檢查被蓋住、重疊、截斷、捲不到底、hover 位移、橫向捲軸、手機點擊目標、對齊；
  基準外的新違規就失敗，修好的從 `packages/frontend/e2e/layout-audit/baseline.json` 刪掉（只准變少）。規則與誤報處理見該資料夾的 README。CI 不自動跑，由擁有者指定時才跑。
- 以效能為由改設計，先建立有代表性的量測並向下一層定位成本，修改後同條件比較。
- 部署與連線診斷見 [deploy.md](docs/agents/deploy.md)：核對實際提供的版本，不以停用來源檢查、
  清除本機資料或放寬登入來源修復問題；每次部署在 docs/deploy-log.md（未隨公開庫附上） 加一列。
- 完成時說明：哪些入口已遷移、呼叫者少理解哪些概念、保留了哪些行為、測試結果與剩餘限制。

## 文件索引：什麼時候讀哪一份

| 檔案 | 何時讀 |
| --- | --- |
| [design-principles.md](docs/agents/design-principles.md) | 設計新公共介面、切分模組、拆函式、寫契約註解、命名時 |
| [backend-rules.md](docs/agents/backend-rules.md) | 改後端寫入、權限、事件、交易、復原的任何程式前 |
| [errors-and-saves.md](docs/agents/errors-and-saves.md) | 改前端保存／離線／錯誤處理、表單等待結果、HTTP 錯誤映射前 |
| [entrypoints.md](docs/agents/entrypoints.md) | 不知道某責任在哪個檔案、要找架構／研究文件時 |
| [decisions-restore-history.md](docs/agents/decisions-restore-history.md) | 改復原（事件／版本／屬性／標籤）、歷史列表與預覽（第 1–5 批） |
| [decisions-import-storage.md](docs/agents/decisions-import-storage.md) | 改匯入（資料夾／媒體／單筆 Markdown）或本機備份、資料夾副本（第 6–9 批） |
| [decisions-core-sync.md](docs/agents/decisions-core-sync.md) | 改 `updateNode`、標籤同名、冪等／交易、sync、membership、待同步文字、同步存活與離線副本狀態、開機先畫與 gate 時間（第 10–15、17、41、43 批） |
| [decisions-offline-account.md](docs/agents/decisions-offline-account.md) | 改離線佇列、登入檢查、帳號隔離、手機帳號入口、啟動位置（第 16、18–21、24、25 批） |
| [decisions-canvas.md](docs/agents/decisions-canvas.md) | 改白板與手寫（密度、加入、布局、分組、拖動、匯入匯出、卡片編輯、S Pen 側鍵、形狀／停住修形／顏色、頁面文字框與圖片、插入、筆的預設、取色器、形狀填色）（第 22、26–38 批） |
| [decisions-ui.md](docs/agents/decisions-ui.md) | 改側欄收合／寫作模式、指令面板、筆記匯出與剪貼簿、移動到…／選位置畫面、筆記與標籤頁標題上方的視角分頁（第 23、39、40 批） |
| [decisions-ai-collaboration.md](docs/agents/decisions-ai-collaboration.md) | 改 AI 的修改怎麼生效（待審建議、`write_mode`、接受／拒絕、@ai 回覆）、AI 跑法（API／訂閱／MCP）、API 金鑰與模型呼叫、`ONDEN_SECRET_KEY`、MCP 工具對筆記的寫入、AI 工作階段的復原（AI 協作第 0–4 批、技能當功能） |
| [decisions-slides.md](docs/agents/decisions-slides.md) | 改筆記的「簡報」視角、版型與主題、`slides_data`、`@onden/site/look`、簡報播放（簡報批 0–2） |
| [decisions-modules.md](docs/agents/decisions-modules.md) | 新增或搬動模組、決定能力要不要有開關（功能／內建模組／核心）、改兩邊模組註冊表時 |
| [testing.md](docs/agents/testing.md) | 決定驗證範圍、測試怎麼寫與回報時 |
| [migrations.md](docs/agents/migrations.md) | 新增／改 migration、改 `migrate()` 或升級／回退腳本、準備發布版本前 |
| [deploy.md](docs/agents/deploy.md) | 部署、回滾、備份、排查連不上或 `INVALID_ORIGIN` 時 |
| [release.md](docs/agents/release.md) | 切發布版本、推映像到 GHCR、改 `compose.yaml` 的 `image:` 或自架者的升級說明時 |
| [references.md](docs/agents/references.md) | 想知道設計準則的論文與教材依據時 |

其他入口：[功能地圖](docs/architecture/feature-map.md)；[全功能盤點](docs/research/full-feature-audit.md)
（沿用案例 ID，更新證據、狀態與缺口；測試檔存在不等於已驗證）；已完成的審核與報告在 [docs/archive/](docs/archive/README.md)；
改功能模組前讀[後端模組](packages/backend/src/modules/README.md)與[前端模組](packages/frontend/src/modules/README.md)。
