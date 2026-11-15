# 統一程度與深模組審查（2026-10-14）

> 狀態：歷史紀錄（最後確認 2026-11-01）

> 範圍：main `14227440`。四個唯讀審查：後端寫入／讀取、前端資料層、模組系統、UI 元件。
> 另外收錄使用者在正式站筆記「改進事項」（2026-10-14 手機寫）回報的問題。
> 行號對應 main `14227440`；修正時以當下程式為準。

## 結論

| 面向 | 統一程度 | 一句話 |
| --- | --- | --- |
| 後端寫入閘 | 高 | 直接 `event()` 只剩白名單 23 處，有測試鎖住；但 `mutate()` 是機制不是意圖，呼叫者要懂事件型別與 `inverse_op` |
| 後端讀取閘 | 中 | 推下 SQL 是多數；仍有 ~11 處撈全表後 `.filter`，inbox 先 `LIMIT 500` 再過濾（假分頁） |
| 後端領域操作 | 中低 | 建立筆記有 ~10 套流程，副作用各不同；刪除／復原寫在路由裡，模組 hook 靠呼叫者手動觸發 |
| 前端寫入層 | 約一半 | 13 個寫入走 `writeLifecycle`，其餘 6 套做法、12 種回傳型別、4 種錯誤語意 |
| 「目前目標筆記」 | 無 | 每個非同步操作自己判斷；scan P0 #2–#4 的共同根因 |
| 模組系統 | 中高 | 註冊表與擴充點統一；核心仍有 ~11 類寫死模組名稱；伺服器多半不擋未引入的模組 |
| UI 元件 | 低（顏色除外） | 顏色有 token；沒有共用 Button／Menu／Popover，72 種按鈕 class，十幾種斷點，~20 處 Enter 沒擋 IME |

### 已經是深模組的（新程式照這些做）

- 後端 `services/nodeUpdate.ts` `updateNode`：權限、三方合併、循環檢查、逆 patch、索引、備份、嵌入、冪等全藏在一個呼叫裡；REST 與 agent 共用。
- 後端 `services/tagMembershipWrites.ts` `applyTagToNode` / `removeTagFromNode`。
- 後端 `spine/mutate.ts` + `runCascade`、`services/spaceScope.ts`、`eventRestore/restore.ts` `restoreEvent`。
- 後端 outbox 副作用註冊表、`nodeHooks`、`workspaceModules.setModuleImported`。
- 前端 `writeQueue.submitWrite`、`writeLifecycle.commit`、`optimisticFields`、`writeErrors`、`membershipReconcile`。
- 前端 `useCardDraft`、`useCanvasTools`、`useBoardCamera`。

### 淺或洩漏的（主要問題）

- 前端 shim 只改名或吞錯：`canvasActions`、`graphMutations`、`offline`、`tagMerge`、`nodeMutations`；`domainWriters` ctx 建了三份。
- 前端佇列格式外洩：`canvasWriter.targetsCanvas`、`taskAgenda`、`pendingNoteProjection` 用正規式解析 pending path。
- 前端草稿 API 操作「編輯器」而不是「筆記 X」：`applyRestoredDraft(markdown, title)` 不帶 nodeId。
- PR #24 拆出的 hook 偏淺：`useKeyboardShortcuts`、`useNodeLifecycle` 各 21 個參數；`useCommandPalette` 收 ~30 個 callback。
- 保留屬性名稱規則前後端各自決定：前端寫 `_pinned` / `_color`，後端只放行 `_published`（見 B1）。
- 後端「新筆記放哪個空間」TS 與 DB trigger 各一份；23 處 `INSERT INTO content_nodes` 只有 4 處帶 `space_id`。
- 後端同一權限檢查寫兩次（`tags.ts:281/294`、`:366/402`；`website/routes.ts` 五次手寫 `isWorkspaceOwner`）。
- inbox 審核流程三份（單筆、群組、批次）。

## 使用者回報（正式站「改進事項」）

| # | 回報 | 原因 | 歸入 |
| --- | --- | --- | --- |
| R1 | 手機上分享之類的按鈕太高 | 把 44px 點擊範圍做成 44px 視覺高度（`NoteActions.css:133`、`OverviewEditor.css:86`）；全站 84 處同寫法 | W1 |
| R2 | 按返回鍵收鍵盤後底部格式工具列還在 | 工具列只看 `editorFocused`（`MarkdownEditor.tsx:1328`），返回鍵不會 blur | W1 |
| R3 | 手機選取時被原生選單擋住 | 浮動工具列固定在選取上方 48px（`MarkdownEditor.tsx:975`、`CardNode.tsx:162`），正是 Android 選單位置 | W1 |
| R4 | PDF 拖拉直接變高光 | `PdfNodeView.tsx:194-196` pointerup 有選取就 `addHighlight` | W2 |
| R5 | 劃線加進卡片讀不到 | 未重現，先重現 | W2 |
| R6 | 「釘選」下面的顏色不能用 | `OverviewEditorHost.tsx:151-161` 寫 `_pinned`／`_color`，後端 `attributeWrites.ts:53`、`routes/nodes.ts:917` 拒絕 `_` 開頭（只放行 `_published`）；`_color` 也沒有任何地方讀 | W2 |
| R7 | 另一位使用者重複輸入 | scan #1（autosave 舊 base）— 已在 `fix/async-target-boundary` | Onden-target |
| R8 | 專門頁面管理合併衝突歷史 | 新功能，需設計 | 待設計 |
| R9 | 標籤不要直接 `#`，要專用語法；範圍標籤當子節點 | 新設計，接 `#tag ^id` 段落節點方向 | 待設計 |

## 工作包

每包一條 branch、一個 session。開始前先 `git fetch`，從最新 main 開 worktree；只 stage 自己改的檔案；
本機驗證（CI 暫停）：前端 lint、tsc、vitest、build；後端 tsc、測試；必要時 e2e。

### W1 手機觸控與編輯器工具列（R1–R3）

- 在 `theme-tokens.css` 加 `--onden-tap: 44px`、控制項高度 token、`--bp-mobile`；新增 `.tap-target`（`::after` 透明延伸點擊區，視覺高度不變）；新增 `hooks/useIsMobile.ts` 取代四份 `matchMedia("(max-width: 900px)")`。
- 新增 `useVirtualKeyboard()`（visualViewport）回傳 `{ open, inset }`；工具列條件改 `editorFocused && kb.open`。
- 抽出 `useSelectionBubble(view)` 給 MarkdownEditor 與 CardNode 共用；觸控（`pointer: coarse`）時放在選取下方。
- 完成：375px 寬分享按鈕視覺 ≤32px、可點 ≥44px；返回鍵後工具列消失；選取時不與原生選單重疊（Playwright mobile emulation 截圖）。
- 注意：Onden-target 正在改 `MarkdownEditor.tsx`，先跟它的 session 對齊或等它合併。

### W2 小 bug 批（R4–R6 + IME）

- R6：保留屬性名稱只定義一次（後端一份清單，`_pinned`、`_color` 放行或改用不帶底線的系統欄位；DELETE 與 PUT 共用同一判斷），前端實際顯示釘選與顏色。
- R4：PDF pointerup 只顯示提示（「劃線」「→ 卡片」），按了才寫入；Alt 框選最小 8px。
- R5：重現「劃線加進卡片讀不到」，修正。
- IME：新增 `lib/keys.ts` `onEnter(handler)`（內建 `isComposing` / keyCode 229）；OverviewSidebar 三份 rename input 合成一個 `<RenameInput>`；替換 ~20 處 Enter。
- 完成：每項有單元或 e2e 測試。

### W3 後端筆記生命週期（scan P0 #7）

- `services/nodeTrash.ts` `trashNode` / `undeleteNode`，把 `routes/nodes.ts:319-488` 的 cascade 移進來；`nodeHooks` 加 `nodeLifecycleCommitted`，restore 逆向操作也觸發；網站模組在刪除與 undo 後下架。
- 完成：整合測試證明刪除／復原後網站下架；路由 handler < 15 行。

### W4 後端 `createNote` 領域操作

- `services/noteCreate.ts` `createNote({ actor, ws, kind, title, markdown, parentId?, spaceId?, attrs?, tagIds? })`；遷移 nodes、bookmark、canvases、import、agent createNode、rss、citations。
- 完成：使用者筆記的 `INSERT INTO content_nodes` 只在 noteCreate；白名單測試鎖住系統列。
- 注意：bookmark／canvas 會多出備份與嵌入（行為變更，寫進 PR）。建議接在 W3 之後，同一人做。

### W5 讀取閘補洞 + 模組引入在伺服器端統一擋

- inbox 改用 `eventVisibleSql`（LIMIT 前推下 SQL）；`tags.ts:890,1084`、`canvases.ts:141`、rss `:131,380,390,679`、review `:217,260` 改 `readableScopeSql`；lint `readsNodes` 擴到 `domain_events`。
- `mountModules` 統一包住有 `library` 的模組的路由、agent 工具、nodeHooks；未引入回 409 `module_not_imported`；移除 `review/routes.ts:89` 手寫檢查。NULL = 全部引入。
- 完成：受限使用者 inbox 分頁正確；未引入網站時 `publishSite` 被拒、`_published` 不觸發部署。

### W6 前端寫入收斂（等 Onden-target 合併後）

- 以筆記為對象的編輯 session：`editNote(nodeId, edit)`、`beginNoteOperation(nodeId)`；不再匯出不帶 nodeId 的草稿函式；收斂 Onden-target 新增的 `beginBodyRewrite`、`stillOn`、畫布 revisions。
- `makeOnlineOperation` 成為唯一 online 寫入；刪 `tagExtendsWriter`／`tagModuleWriter` 重複；`workspaceWriter`、`tagPackInstall`、`pointerWriter`、`noteStructure` 遷移；前提檢查一處。
- 統一回傳 `{ status, value }`、回報後拋出；刪 shim；ctx 一份；草稿狀態加 `queued`。
- 完成：lib/data 中帶 method 的 `api(` 只剩 writeQueue 與 onlineWrite；中途切換筆記測試。

### W7 拆 tags.ts / inbox + 核心模組字串清除

- `services/tagViews.ts`、`services/tagMerge.ts`；刪 `notOwner` 預檢改映射 `AuthorityError`；inbox 收斂成 `reviewEvents(ids, decision)`。
- `actors.ts:485` 改 `ModuleDefinition.personalTables`；`tags.ts:148` 改註冊表旗標；網站發布開關改 `FrontendModule.noteHeaderAction`；`moduleBoundary.test.ts` 禁止核心出現模組 id 字串（白板白名單）。

### 待設計（先草圖，使用者核准後才做）

- R8 合併衝突歷史頁。
- R9 標籤專用語法與範圍標籤子節點。
- UI 元件庫（Button／Menu／Popover）與尺寸 token 全面遷移：W1 只做觸控 token，其餘逐步。

## 第二輪（main 2441f559）

第一輪沒涵蓋的區域：同步協定、發布、agent 工具、匯入、事件復原／版本、前端設定、i18n。

| 區域 | 判斷 |
| --- | --- |
| 同步協定 | 後端節點欄位統一（`nodeRowColumnsSql`）；本機 SQLite 列格式散在 6 處（`nodes` 有 4 份 INSERT、`space_id` 補丁 UPDATE 有 3 份且語意不一），bootstrap 丟掉屬性型別 |
| 發布 | 「哪些公開」只定義一處；遮蔽寫了 3 份（snapshot、servedSite、export-static），export-static 少規則 |
| Agent 工具 | 多數重用領域操作；`getNode` 依 slug 查詢時，`LIMIT 1` 在套讀取範圍之前；`updateNode` dry-run 自己重寫前置檢查 |
| 匯入 | 新建走 mutate；舊 CSV 路徑直接 INSERT 屬性（保留鍵可寫、無事件、無 hook）；更新路徑繞過 `nodeUpdate` |
| 事件復原 | 入口統一；正文副作用鏈 4 份。**復原一次編輯不重算 wikilink 邊、blockId、嵌入**；`NODE_RESTORED` 沒有逆向，版本還原不能撤銷 |
| 前端設定 | 設定定義成資料、交給 renderer 畫，這點好；持久化淺（4 個近乎相同的 hook，每個 `set` 自己寫 localStorage，沒有 try/catch） |
| i18n | 以英文原文當 key 的做法一致；但前端用 `t(後端錯誤 detail)`，後端改字就靜默失效 |

### W8 正文寫入副作用統一（後端）
`applyBodyChange`（或擴充 `nodeUpdate`）供 `restoreNodeUpdated`、版本還原、匯入更新共用；`NODE_RESTORED` 可撤銷；版本事件條件收成一個常數。
完成：整合測試證明加入 `[[B]]` 後復原，邊會消失；版本還原後再撤銷成功；匯入改標題後，指向它的連結會更新。

### W9 邊界小修批（後端）
舊 CSV 路徑改用 `setNodeAttribute`（或移除 `deepCsv:false`）；`getNode` 依 slug 查詢時先套讀取範圍；刪除沒有人呼叫的 `GET /api/export`（website）；export-static 改用 `loadServedSite` 的過濾與遮蔽；`mcp.ts` 錯誤對應交給 `apiOnError`。每項各有一個測試。

### W10 本機鏡像寫入器（前端）
`localMirror.ts`：每張表一個 `upsertXInto(d, row, { bodyPolicy })`；精簡正文規則與 `space_id` 只定義一次；`SyncDelta` 只留一份。
完成：`INSERT INTO nodes|edges|pointers|node_attributes` 只出現在這個檔案；sql.js 往返測試（精簡 bootstrap → delta → upsertNode → 重新載入）證明正文與 `space_id` 不遺失。先補測試再改。

### W11 同步投影契約（兩端，W10 之後）
後端 `syncProjection.ts`：edge／attribute／pointer 的欄位清單只寫一份（取代 `SELECT e.*`），bootstrap、delta、`/sync/nodes` 共用；bootstrap 補上屬性型別、可繼承、來源，前端存進鏡像。

### W12 設定持久化（前端）
存檔與套用拆開；4 個 hook 合成一個 `useOption(def)` 加 codec；開機重放共用同一個 codec；localStorage 包 try/catch。
完成：`registry.tsx` 沒有 `localStorage.setItem`；儲存被封鎖時設定畫面仍能渲染。

### W13 錯誤碼與 i18n 契約（兩端）
後端回穩定的 `error` 碼，前端用碼查翻譯，不再 `t(detail)`；模組標籤名稱存語言中立的值；測試加上 `t(變數)` 白名單與孤兒 key 檢查。

### 分派（2026-10-14）
- note-0f：W5（PR #33）→ W8 → W10 → W11
- note-d6：W3 → W4 → W6
- note-66：W2 → W12 → W9 → W7
- W13：先放著，誰先空出來誰做

## 第三輪（main b560829b）

| 區域 | 判斷 |
| --- | --- |
| 任務與議程 | 重複規則只在後端算（好）；「今天」與分桶規則前後端各一份、時區不同（今天 09:00 的任務線上顯示逾期、離線顯示今天）；核取方塊點擊和「送出清單」用的行號定義不同，程式碼區塊裡的 `- [ ]` 會被勾錯；每月重複在 1/31 溢位 |
| 搜尋 | 約 7 套實作；面板只問伺服器、側欄只查本機；伺服器結果沒有過濾 `hidden`；本機 snippet 會露出 `‹ ›`；Ask／suggestLinks 先 LIMIT 後過濾 |
| 集合與視圖 | 後端只有一個 SQL 編譯器，但查詢語言有 4 種；「標籤成員」有 4 種定義；ViewBuilder 只認 5 個運算子，agent 存的 `gt` 視圖一編輯就被改成 `is` |
| 空間 UI | `useCanEditNode` 讓任何空間的編輯者都能改 class_tag，後端只准擁有者（UI 顯示可編，存檔必被拒）；7 個元件各自判斷 `actor_is_owner` |
| 即時事件 | 伺服器端深；前端沒有失效層（6 處直接訂閱、7 處 visibilitychange、11 處手動 sync）；自己寫入的回音也觸發完整 sync |
| 認證 | bearer 的 actor 查詢寫了兩份；前端身分存在 3 處；登出寫了兩份 |

### 決定（note-0f，2026-10-14）
- **標籤成員包含子標籤與 extends 它的標籤的筆記。** 理由：介面用語是「繼承」，extends 的標籤繼承這個標籤的能力與欄位，使用者預期在這個標籤的表格裡看到它們；SchemaLens 已經這樣做，後端 `executeView` 也包含子標籤。之後 `/query`、`basesEval`、`executeView` 都改用同一個成員函式。

### W14 任務日期與分桶一處定義（兩端）
後端在 agenda／bootstrap 附上 `today` 與 `timezone`；前端新增 `lib/localDate.ts` 取代 4 份日期字串；`localTaskAgenda` 補上「有時間且已過算逾期」；`advanceDue` 夾到月底；改期時重新分桶。
完成：同一組 fixture 在 SQL 與本機分桶結果一致（含 09:00）；1/31 加一個月得到 2/28。

### W15 核取方塊識別（前端）
單一的 `taskLines(markdown)`（跳過程式碼區塊、支援引用區塊），點擊與送出清單共用。

### W16 空間能力單一來源（前端）
`useCapabilities()` 回傳 `{ isOwner, canEdit(node), canMoveOut(space), canManageSpace }`；class_tag 只有擁有者能編輯；`actor_is_owner` 只在這個 hook 裡讀；epoch 統一為數字。

### W17 搜尋契約統一（兩端）
伺服器搜尋濾掉 `hidden`；`searchQuery` 解析器前後端共用；snippet 統一用 `<mark>`；面板離線時改用本機、側欄線上時改用伺服器，介面一致；suggestLinks 與 Ask 把讀取範圍推進 SQL；Ask 的中文詞改用 bigram。

### W18 視圖查詢語言收斂（兩端）
ViewBuilder 支援 9 個運算子（清單由 shared 匯出）；`/query` 的排序與成員改用 `executeView` 同一個函式；成員定義依上方決定；刪掉 `fieldTypes`，視圖載入只留一份。

### W19 即時失效註冊表 + actor 解析收斂（兩端）
前端 `liveInvalidation.register(topic, refetch)` 統一處理 tick、visibility、online，並略過自己寫入的回音；後端 `resolveBearerActor` 共用 `resolveCurrentActor` 的查詢，name 有變才 UPDATE；前端身分以 `accountStorage` 為唯一來源，登出只留一份。

### 分派（第三輪）
- note-0f：W11 → W14 → W17
- note-66：W7 → W15 → W16
- note-d6：W3 → W4 → W6 → W19
- W13、W18：先放著，誰先空出來誰做

## 第四輪（main f422df94）：功能模組內部

| 區域 | 判斷 |
| --- | --- |
| 白板 | 寫入已改成只傳變更（`diffBoard` + `PATCH /api/boards`）；舊的整份覆寫 PATCH 還在，舊佇列重送會清空白板；position upsert 有 2 份、`_canvas_sections` 讀寫有 3 份；bootstrap 的 `graph_positions` 沒套讀取範圍 |
| 手寫與 PDF | 引擎只有一個，但讀取時先問網路、不看本機待送佇列：**離線畫的筆劃，一連線可能被伺服器舊版覆蓋**；一次 PDF 畫圖拆成兩個屬性，各有一個事件；解析器 4 份 |
| 複習 | 後端深（`fsrs.ts`）；`/stats` 為了計數也撈出正文；個人設定的 PUT 是整份取代，會清掉其他覆寫 |
| RSS／稍後讀 | 抓取層深；存下的筆記被刪除或復原後，staging 還指著它，之後永遠不能重存；並行存檔會建出兩則筆記 |
| 引用 | citekey 只在「讀得到的筆記」裡唯一，匯出的 `.bib` 會有重複的 key；`[@key]` 沒有反向連結 |
| 匯出 | HTML 深；**markdown.zip 不能往返**：中文標籤會多出引號、frontmatter 每往返一次多一份、aliases 和屬性會遺失 |

### 決定（note-0f）
- 白板 PATCH 帶 `data` 一律回 410，並附上改用 `/api/boards` 的提示，不再接受整份覆寫。
- 手寫：本機有這則筆記的待送寫入時，以本機鏡像為準；PDF 外框併進 `ink_data` 信封，`pdf_annotations` 只保留唯讀相容。

### W20 手寫與 PDF 標註儲存收斂（前端）
`lib/ink/store.ts`：`loadInk(nodeId)`（有待送寫入時以鏡像為準）、`saveInk`（只留一層防抖）、`decodeInk`；PDF 外框併進 `ink_data`。
完成：離線畫 → 連線 → 重新載入 → 再畫，筆劃不遺失；一次 PDF 畫圖只產生一個事件；`ink_data` 的 JSON 解析只出現在 store。

### W21 markdown.zip 往返（後端）
前後端共用一個 frontmatter codec（YAML 正確跳脫、讀 aliases）；匯入時把 frontmatter 從正文剝掉；只匯出 `node_type='content'`；屬性寫進 frontmatter；zip 改成串流。
完成：中文標籤、含引號的標題、aliases 經過匯出、匯入、再匯出，位元組完全相同。

### W22 RSS 存檔生命週期（後端）
筆記軟刪除時清掉 `saved_node_id`，復原時接回（用 W3 的 `nodeLifecycleCommitted`）；重送時驗證 `node_id`；存檔流程放進事件交易；`auto_tag` 改存標籤 id。
完成：存 → 刪除 → 再存，得到新筆記；併發兩次存檔只產生一則。

### W23 白板寫入單一路徑（兩端）
canvases PATCH 帶 `data` 回 410；`services/boardStore.ts` 讓 position upsert 和 sections 讀寫各只留一份；`PUT /position` 限制 `surface='graph'`；`graph_positions` 套讀取範圍；前端卡片尺寸和格線常數只定義一處。

### W24 引用識別（兩端）
citekey 在整個工作區唯一（寫入端判斷，且不洩漏隱藏筆記）；`.bib` 匯出去重；`[@key]` 解析搬到 shared，並建 `cites` 邊。

### W25 複習小修（兩端）
`/stats`、`/decks` 改用不撈正文的查詢；個人設定改成合併式 PATCH；前端接上 `undo-grade`；`Card` 型別移到 shared。

### 分派（第四輪）
- note-0f：W20 → W21 → W24（W18 第二部分等 #43 合併）
- note-d6：W4 → W22 → W6
- note-66：W19 → W25 → W23

## 第五輪（main 2b0fe081）：dispatcher、outbox、維護、spine

| 區域 | 判斷 |
| --- | --- |
| 標籤行為與 dispatcher | 「從正文推出屬性」有 5 套做法；優先順序（ui > frontmatter > markdown > dispatcher）沒有集中，23 處 INSERT 只有 3 處檢查；推出的屬性不送 ATTRIBUTE_SET，所以別的裝置同步不到、也不能復原；範本 slot 的「獨立回滾」實際上不成立 |
| Outbox 與備份 | 核心設計好；重試約 4 分鐘就放棄，dead 列看不到；一個卡住的副作用會擋住全部；核准時遇到相同 dedup_key 會 500；遺留的 index.lock 讓備份永久停擺 |
| 維護 | 垃圾桶清除很嚴謹；**blob GC 與 putBlob 會競爭**（putBlob 在交易外執行，GC 沒有寬限期），建立筆記的版本可能因此消失 |
| Spine | 機制正確；inverse_op 只有 ATTRIBUTE_SET 會讀；屬性事件手刻 8 處；resolve-path 建立標籤是 `open`；改角色時沒標 membership epoch |

### 決定（note-0f）
- 建立「普通標籤」（沒有 schema）需要能寫入任一空間（`any_space_write`）：這樣編輯者在快速記錄時打 `#新標籤` 仍然可用。改標籤定義或 schema 只限擁有者，與 W16 一致。唯讀 token 不能建立標籤。
- 已外送的備份要不要撤回（改名、刪除後清掉舊檔）先不做，W27 只處理交付保證。

### W26 blob GC 安全（後端）
putBlob 移進事件交易；GC 加上 `created_at` 寬限期或拿 append lock；pruneEvents 保留 NODE_DELETED 和帶 value_ref 的事件。
完成：交錯執行 putBlob、GC、commit 的整合測試不會留下懸空 hash；清理後每個 body_hash 和 value_ref 都有 blob。

### W27 outbox 交付保證（後端）
每種副作用加逾時；重試期限拉到約 24 小時；dead 列可以重新排入並在 UI 列出；核准時併入已存在的 pending 列；清掉過期的 index.lock。

### W28 推出屬性走事件軌（後端）
`recordAttributeChange` 一處產生 ATTRIBUTE_SET 與快照，寫完統一呼叫 dispatchAttributeChange；優先順序與 schema 驗證收進這一處；delete_attribute 也遵守優先順序。
完成：正文打 `status:: done` 會出現在別的裝置的同步差異裡，而且能復原；`"ATTRIBUTE_SET"` 只在一個檔案裡產生。

### W29 範本展開交易修正（後端）
slot 改用 savepoint；交易內不再用 `pool.query`；修正誤導的註解。

### W30 標籤建立權限與 membership 旗標（後端）
建立標籤定義只用一個 helper（依上方決定）；改角色時標上 affectsMembership；修正 mutate 對 timing 的說明。

### 分派（第五輪）
- note-0f：W26 → W29 → W30
- note-d6：W22 和小 PR 之後接 W28
- note-66：W6 之後接 W27

## 第六輪（main 04b059d6）：網站發布、agent 工具與身分、前端大型元件

前五輪沒有看過的三塊。整體：agent 工具和 REST 大致走同一套領域操作（createNote、nodeUpdate、tagMembershipWrites、讀取閘），bearer token 在 `/api/mcp/*` 以外一律被擋；網站發布的 trash／restore 已經走 `nodeLifecycleCommitted`，`publishedNodeIds` 也是快照、網站、匯出共用的一處。問題集中在下面幾點。

### 決定（note-0f）
- 安全與內容外洩先做（W34 前半、W35 前半），不排在重構後面。
- 「讀取政策改變」由 `mutate()` 發一個共用 hook，網站模組訂閱；不在各寫入點各自呼叫重新部署。
- 版本還原改走 `nodeUpdate`，不再自己寫 UPDATE。
- 刪除成員時撤銷他發出的 token（`issued_by` 變 NULL 不再等於保留授權）。
- 網站「快照 vs 即時」二選一、前後端 markdown 渲染器合一：較大，先寫設計再做（W38）。

### W34 網站發布不外洩（後端）
- `/api/export-static` 補權限檢查（目前任何登入的成員都能下載整站 zip）。
- 復原 `_published`（`eventRestore/attributes.ts`）沒呼叫 `nodeAttributeCommitted`，靜態站不會撤下；改成由 `recordAttributeChange` 統一觸發，誰都不會漏。
- 已發布的筆記被隱藏或加上限制讀取的標籤時，靜態站不會更新：接上 `mutate()` 的「讀取政策改變」hook。
- `collections.ts` 的 `_status` 與欄位寫入改走 `recordAttributeChange`（和 W28 收尾重疊，一起做）。
- `/publish`、`/site/access`、`/snapshots`、`/preview` 改走 `mutate` / `assertAuthority`；`snapshot.ts` 的讀取移進交易。
- slug 由伺服器產生：前端 `websiteWriter.renamePage` 的 `[^a-z0-9]` 會讓中文標題全變 `untitled`。
完成：發布後復原、發布後隱藏、發布後加限制標籤，三種情況靜態站都會撤下該頁（整合測試）；沒有權限的成員拿 export-static 得到 403。

### W35 token 與 agent 工具收斂（後端）
- 刪除成員時撤銷他發出的 token。
- token 的空間過濾（external_ai + 空間）在 `spaceScope.ts` 寫了三份，收成一個 helper，連同 `currentActor.ts` 的發行者上限。
- 版本還原（`routes/nodes.ts:388-450`）改走 `nodeUpdate`：標題改了要重算 slug、遵守標籤名稱與身分檢查、排除已刪除。
- `nodeUpdate` 加 `dryRun`（`createNote` 已有），agent 的 updateNode 預覽改用它，不再自己抄一份驗證。
- 標題與正文長度上限放進 `nodeSchema`，UI 和 MCP 一致。
- agent 的 createNode 接受 `tag_ids` 和 `attributes`，跟 REST 一樣一次建立；拿掉重複的檢查。
- rate limit 以 actor 為單位（目前以 token 為單位，N 個 token 就有 N 倍額度）；MCP 工具清單只列 token 允許的工具。
完成：刪除成員後他發的 token 回 401；還原標籤的舊版本不會產生重名；同一份筆記從 MCP 和 UI 建立的結果相同。

### W36 前端小修批
- Esc 沒有輸入法保護：選字時按 Esc 會關掉輸入框、草稿消失。`lib/keys` 加 `isEscapeKey`，七處改用。
- 離線資料漂移：別的裝置刪掉的白板離線時又出現（`refreshCanvasList` 不清 mirror）；失去權限的筆記離線仍顯示正文（`hydrateNode` 4xx 時沒清 mirror，先確認 membership reconcile 是否已處理）；標籤頁離線一片空白（`SchemaLens` 自己 fetch，不讀 store）。
- 標題比對三份實作：`[[` 用 includes、`/` 用 fuzzyMatch、側欄與 ⌘K 各一份高亮。收進 `noteSearch.matchTitle` 和共用的高亮元件。
- 自己算日期：備份檔名用 UTC（台灣早上 8 點前會是昨天）、衝突紀錄不看工作區時區。
- `settings/registry.tsx` 用英文錯誤訊息字串判斷，改成錯誤碼。
完成：zh-TW 輸入法選字時按 Esc 只取消選字；離線三種情況都不再顯示錯的資料。

### W37 前端大元件拆分
- `MarkdownEditor`：一個約 1,200 行的函式。抽出 `lib/editorCompletion`（`getCompletions(trigger, ctx)`、`applyCompletion(view, item)`）和 `SelectionToolbar`。
- `OverviewSidebar`：抽出 `useAttributeConflicts()` 與 `ConflictList`、`useDismissOnOutsideClick`；dismiss 紀錄改用 `accountStorageKey`。
- `KnowledgeWorkspace`：抽出 `CanvasListPanel` 和 `canvasWriter.importFile`。
- `WebsiteStudio`、`CollectionsManager`：錯誤改用 `serverErrors`；集合清單接 `liveInvalidation`。
完成：每個抽出的模組有自己的單元測試；`MarkdownEditor.tsx` 不再含補全邏輯。

### W38 網站渲染模型（待設計）
- 網站目前混用即時資料（集合、外觀）和凍結快照（標題、正文、slug），改名後集合裡的連結會 404。
- 後端 `htmlUtils.md2html` 和前端 `MarkdownRenderer` 是兩套渲染器，匯出的 zip 和網頁呈現不同。
- 發布預覽用的是「上次快照 ∩ 現在允許」，不是「這次會發布什麼」。
先寫設計（快照或即時二選一、共用渲染器放哪），使用者看過再做。

### 分派（第六輪）
- note-d6：W28 收尾 → W34
- note-0f：W35（以子代理實作，note-0f 審）
- note-54：UI primitives 之後接 W36 → W37
- note-66：H2（技能）
- W38：note-0f 先寫設計
