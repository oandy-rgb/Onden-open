# 備份還原與搬整個工作區

> 狀態：現行（最後確認 2026-11-22；版本歷史見下節）
> 涵蓋：packages/backend/src/services/backup*.ts, packages/backend/src/spine/importedHistory.ts, packages/backend/src/routes/backup.ts

程式：`packages/backend/src/services/backupArchive.ts`（寫出）、`backupFile.ts`（檢查上傳）、`backupRestore.ts`（還原）、
`backupWorkspaceMove.ts`、`backupExtras.ts`、`backupSystemAttrs.ts`、`backupLinks.ts`；介面在「設定 › 你的資料 › 從備份還原」。
2026-11-06 用正式站完整資料（874 篇、489 篇在垃圾桶、5 個空間）走「伺服器 → 桌面 → 瀏覽器 → 新伺服器」後的修正與新模式。

## 一般還原（empty／merge）現在保證的

| 項目 | 規則 |
| --- | --- |
| slug | 未刪除的筆記優先保留備份裡的 slug（`createNote` 的 `preferredSlug`）；只有目標空間裡真的被佔了才加 `-2`。垃圾桶裡的筆記先用暫時 slug（`restoring-<id>`）建立，刪除後（不佔 live 唯一索引）才改回自己的 slug。 |
| 連結 | 全部筆記就位後、刪除之後才一次決定（`backupLinks.ts`）。格式 2 的備份記著每篇的 wikilink 目標，原樣還原（包括垃圾桶筆記刪除時留下的）；舊備份：未刪除的筆記用既有規則 `syncWikilinkEdges` 重算，垃圾桶筆記不連到未刪除的筆記（來源當時連到誰已不可知，連到同名孿生是猜的）。 |
| 任務 | 從內文一行長出來的任務，在內文重建出任務後對齊備份所有 `_task_*` 欄位（狀態、時間、結束時間、完成時刻、重複…）；行已不在內文的已刪除任務改建成宿主底下的任務再刪除，不再被丟掉。值走 `restoredTaskField` 的白名單。**任務自己的內文、標籤與其他屬性**（三種任務——內文一行、筆記底下加的、獨立的——都一樣）也帶回：內文走 `updateNode`，標籤與屬性走筆記同一個 `restoreOwnContent`。任務的宿主不在（已刪除、或在別的空間）時任務無處可放：不寫入，記在報告的 `skipped.tasks`。 |
| 已存的檢視 | 筆記的每一種檢視（表格、看板、月曆、相簿、白板、手寫、簡報…）都帶回（`noteViews.ts` 的 `restoreNoteViews`，每個檢視過 `viewCreateSchema` 驗證）；名稱重複、版面不認得的記在 `skipped.views`。標籤的檢視在標籤由還原新建（或搬整個工作區）時走 `appendTagView` 帶回；既有標籤不改。 |
| 側欄捷徑 | 筆記旁檔（`.onden/notes/<id>.json`）新增選填欄位 `pointers`：指向這則筆記的捷徑，記著放在哪個上層（備份裡的筆記，或 `null` ＝側欄最上層）、順序鍵與標籤；上層不在備份裡的不寫（與 bootstrap 一致）。還原在所有筆記就位、刪除之前用 `createPointer` 放回；放不回去的（已存在、上層種類不對、被拒）計入 `skipped.pointers`（選填，舊伺服器的報告沒有它）。**格式版本仍是 2**：舊備份沒有這個欄位，照常還原、只是沒有捷徑；舊伺服器讀新備份會略過它（和 `wikilinks` 同一個做法）。 |
| 關係圖位置 | 備份本來就帶（旁檔 `positions` 裡 `surface = "graph"` 的列）。還原不再把它當成「找不到白板」跳過，改走關係圖自己的寫入口 `moveGraphPosition`；失敗才計入 `skipped.positions`。 |
| 系統屬性 | 見下表。 |

### 系統屬性

| 屬性 | 一般還原 | 搬整個工作區 | 理由 |
| --- | --- | --- | --- |
| `_import_*`（匯入來源、路徑、基準雜湊） | 帶 | 帶 | 屬於筆記本身；沒有它從 Obsidian 再匯入一次會重複 |
| `_pinned`、`_color`、`_captured`、`_tpl_origin`、`_rss_guid`／`_rss_url`／`_rss_published_at` | 帶 | 帶 | 筆記本身的狀態或來源 |
| `_published` | 只對「以原貌回來」的未刪除筆記（不含「備份」副本） | 同左 | 只是筆記的選用旗標：站台要等擁有者下次按發布才會變，且只有空間的發布開關開著、筆記公開可讀才會被服務（`publishedSet.ts`）；寫入走筆記選單同一條 `setNodeAttribute`，還原者現在沒有 `set_attribute` 就被拒絕並計數。不帶它，已發布的網站在搬家後等於下架。 |
| `_review_state`、`_rss_source`、`_rss_kind` | 不帶 | 帶 | 屬於「這個人」的進度與訂閱，只在搬家（訂閱與進度一起搬）才有意義 |
| `_task_*` | 見任務 | 見任務 | 只寫白名單與合法值 |
| 其他 `_` 開頭（白板分區、區塊標記…） | 不帶 | 不帶 | 衍生或由模組自己重寫；白板分區尚未還原（已知缺口） |

## 搬整個工作區（mode `workspace`）

同一組 `/api/backup/restore/*`，`mode=workspace`，`space` 傳擁有者自己的個人空間；介面只在預覽沒有拒絕時才出現這個選項。

**目標必須是「新的」工作區**（`inspectTargetWorkspace`，每一條都有測試）：
1. 操作者是工作區擁有者（委派 token 永遠不是）→ 否則 403 `not_workspace_owner`；
2. 除了擁有者沒有別的真人（含已邀請未加入的）；
3. 除了擁有者的個人空間，其他存活空間只能是只有擁有者、沒有任何筆記的共用空間（會被重用）；
4. 沒有任何筆記（含垃圾桶），除了系統筆記（`source_type='system'`，如網站設定）與瀏覽器版／桌面版第一次開啟時的範例筆記（`browser_app_state` 的紀錄）；
5. 沒有自己的存活標籤：標籤只能是系統標籤（保留標籤、模組標籤）、六個種子標籤，或範例標籤。

不符合 → 409 `workspace_not_new`。檢查在預覽、開始前、以及事件鎖內各做一次。

**做的事（同一個 BACKUP_RESTORED 事件，開頭的交易）**：範例筆記與標籤進垃圾桶（可從歷史救回）；依 `.onden/spaces.json` 重建共用空間
（名稱、開關；個人空間 = 目標的個人空間；預設空間 = 目標的預設空間）；**成員不重建**，結果列出「原本有別人」的空間要重新邀請。
筆記回到各自的空間；同名系統標籤改用備份的顏色、欄位與說明；頁面設計（`presentation`，網站外觀）跟筆記走。

**`.onden/extras.json`（備份格式 2）**，只有搬家會讀：複習進度、專注紀錄、RSS 訂閱（`_rss_source` 指著它的 id；那個 id 在原伺服器上一定還被舊的訂閱佔著，所以新工作區裡通常是新 id——`planRssIds` 在寫筆記之前就決定好對應，筆記的 `_rss_source` 與訂閱列用同一份對應；對應不到的訂閱，筆記不寫 `_rss_source`）、個人設定
（`actor_prefs`，只收 `isPrefKey`＋`parsePref` 過關的）、模組設定、模組開關與最新一份發布快照（只有擁有者備份才寫入）。
`functionRefs`（2026-11-14 加，migration 201 同一個 PR，檔案版本仍是 1）：標籤與空間提供的功能（`function_refs` 沒有檢視 id 的列；已存檢視、任務自己的引用、卡片的複習引用由各自的載體帶，不重複），搬家時寫進新工作區，持有者與 `source_tag_id` 換成新 id，已有同一組（持有者、功能）的不覆蓋。一般還原不讀這個檔。沒有這個欄位的舊備份照常讀。
舊備份（格式 1）仍可還原，只是沒有這些，也沒有 wikilink 紀錄。`backupFile.ts` 沿用 `MAX_JSON_BYTES` 與項目數上限。

**不搬、搬完會明說**：操作紀錄（以及沒選「包含版本歷史」的備份裡的版本歷史，見下節）、AI 金鑰（用來源伺服器的密鑰加密，搬不動）、推播訂閱（綁裝置）、資訊來源的已讀記號、區塊層級的複習進度。

## 版本歷史（備份格式 3）

「版本」寫備份時讀版本表（`note_versions`，migration 220；一篇筆記的內文與標題，內文在 `blobs`；`services/history/storedVersions.ts` 的順序）；標籤說明與系統筆記還沒有版本，仍讀帶 `body_hash` 的 `NODE_CREATED`／`NODE_UPDATED`／`NODE_RESTORED` 事件（`bodyEventSql`）。
搬它＝在新工作區寫出同樣的事件，並把版本鑄成 `g:` 版本（`spine/importedHistory.ts`）。**不需要 migration。**

| 項目 | 規則 |
| --- | --- |
| 帶什麼 | 每則筆記每一個「儲存」：種類（建立／修改／還原）、標題、內文、原始時間（微秒）、作者種類與顯示名稱、被還原的是哪一版。 |
| 不帶什麼 | 操作紀錄（屬性、標籤、搬移、刪除等事件；多數事件重建不出資料，外傳「改之前的內容」會洩漏舊內容）、AI 執行紀錄、用來源伺服器密鑰加密的東西、發布快照。結果畫面照舊列出沒搬的。 |
| 下載 | `GET /api/backup/full.zip?history=1`；設定裡一個開關，旁邊先顯示「N 個版本、約 X MB」（`GET /api/backup/history-size`，文字大小、未壓縮）。內文總量不超過 200 MB 預設開，超過預設關。 |
| 檔案 | `.onden/history/<筆記 id>.jsonl`，一行一個版本、最舊在前；manifest `version` = 3，另有 `history: { notes, versions, bytes }`。**沒有版本歷史的備份仍是格式 2，位元組與以前相同**（README 也不變）。 |
| 舊伺服器收到格式 3 | 整份拒絕，絕不半套還原。拒絕碼是 **`unexpected_entry`**（不是 `newer_version`）：舊的 `backupFile.ts` 先逐一檢查檔名，`.onden/history/…` 不在它認得的名單，在讀 manifest 之前就擋下；畫面上是「備份裡有 Onden 備份沒有的檔案，沒有使用」。（`newer_version` 只在格式號大於 3 時由新伺服器回。）新伺服器收到格式 2 照舊還原。格式 2 的 manifest 卻帶歷史檔 → 拒絕（`unexpected_entry`）。 |
| manifest 的 `history` | 只是說明，不被相信：預覽、「沒搬的」清單、設定頁的提示一律看實際讀到的歷史檔（有幾篇、幾個版本，由 `reader.countHistory()` 逐行數；有沒有歷史檔由檔名判斷）。格式 3 的 manifest 缺 `history` 或數字不符，不影響結果。 |
| 誰、進哪 | 只有「搬整個工作區」（`mode=workspace`）會讀它：擁有者、目標是新的工作區、筆記是這次還原剛建的（`spine/importedHistory.ts` 驗擁有者）。一般還原（合併／空空間）與別人的工作區**不會**讀，也不會把歷史併進既有歷史。 |
| id | 筆記 id 沿用搬家已有的對應（`createdIds`）。事件是新的（新 id），來源版本的名字（行的 `id`：來源的 `version_key`；2026-11-22 之前寫出的檔是來源事件的編號，兩種都收，都當成不透明的名字）記在 `tx_meta.history_import.event`，用來去重（同一個來源版本不寫第二次）與重新指向「還原自」。舊伺服器讀到 key 當 id 的行：那一篇的歷史不帶（行檢查不收），筆記照常還原。 |
| 作者 | 事件的作者 id 是擁有者（來源的 id 在這裡沒有意義），**`actor_type` 一律寫 `user`**；來源的作者種類與顯示名稱放 `tx_meta.history_import.actor_type`／`actor_name`，版本清單與再次匯出讀它們（`history/bodyEvents.ts` 的 `versionActorTypeSql`、`noteVersions.ts`），不同名稱不會併成同一次修改。寫備份時作者的名稱：這台有那一列就寫它的名字；這台沒有列（被移除的成員或 AI）或那一列是臨時工作階段（`type = 'session'`）就寫 `null`（`services/authorName.ts` `shownAuthorName`），不寫 id，也不寫任何代替的標籤（「臨時工作階段」只是畫面上的字，不是人的名字，而備份檔會比這台活得久）。還原時帶進來的名稱是 `null` 的版本就是沒有名字，**不會**顯示成做還原的人（`versionAuthor`；以前 `coalesce` 到做還原的那一列，會把工作階段的版本算到開啟者頭上）。選這個而不是在三個讀取面各加「排除匯入事件」：審查收件匣（`inboxQueue`）、AI 執行紀錄（`history/agentRuns.ts`）、日記頁的 AI 清單（`dayLens`）本來就用 `actor_type = 'ai_agent'` 找 AI 的工作，匯入事件不再是 `ai_agent`，三處自然排除、不必各抄一份條件；只有「顯示作者」的讀取面多讀一個欄位。搬來的 AI 版本因此不會以「擁有者的待審 AI 修改」出現，版本清單仍標示是 AI 寫的。 |
| 時間與順序 | 原樣（微秒）：時間以**文字**交給資料庫（`::timestamptz`），不經 JS `Date`（只有毫秒，真 Postgres 上會丟微秒）；格式固定 `YYYY-MM-DDTHH:MM:SS.ffffffZ`、必須是真實的日曆時間。同一時間靠檔案順序決定（事件 id 遞增）。**晚於這次還原替該筆記寫的第一次儲存的版本一律拒絕**（時鐘不準或造假的檔案；夾住的話會與還原自己的那次儲存順序糾纏），該篇歷史整篇不寫。還原建立筆記時多出的那一次儲存，內文與最後一版相同，版本清單會併入最後一版。`base_hash` 沿用同一篇已帶進來的最後一版，所以跨批（200 筆一批）也不會斷。 |
| 驗證 | 每個版本的內文要符合它的 SHA-256；逐行：來源事件 id 必須是字串（數字不收，否則去重的鍵對不上、重放會重複）、內文／標題／名稱不得含 NUL（資料庫存不了，且會在筆記提交後才爆）、一行最多 16 MB（伺服器對筆記內文沒有上限，這是遠超一般筆記的保護；讀到上限就停，不把整行讀進記憶體）。逐篇兩遍：第一遍只驗，第二遍才寫；任何一行壞掉、雜湊不符、行太長或日期在未來，**那一篇的歷史一個版本都不寫**（整篇在一個 savepoint 裡回滾），結果畫面列出標題（筆記本身仍在），其他篇照常。 |
| 冪等 | 同一個來源版本在同一篇只寫一次；重跑（同一上傳重放、再次匯入）不會重複。 |
| 復原 | 帶進來的事件（建立、修改、還原三種）一律不能當事件復原：`restoreBlockedReason`（`restoreContract.ts`）看到 `tx_meta.history_import` 就回 `imported_history`，清單不提供「復原」，直接要求也在動任何狀態之前被拒絕（409，畫面：「這個版本是從備份或搬家帶過來的，不能當成一次修改來復原。請到筆記的版本清單，直接還原那一版。」）。否則「建立」那一版的復原會走刪除路徑，把線上的筆記丟進垃圾桶。要回到舊版用「還原這一版」（它讀版本內文，照常可用，並成為新的一版）。 |
| 記憶體 | 匯出每篇一頁（200 筆）一頁寫進暫存檔，再以串流放進 zip；匯入逐行讀、每 200 筆一批寫入，從不把整篇歷史讀進記憶體。實測見 PR 說明。 |
| 事件格式 | 沒有動；這些事件不是同步格式的一部分（`docs/architecture/proposals/node-sync-channels-2026-11-14.md` 第 5 節「近期可做」的那一項）。 |

用到備份檔的用戶端：設定頁（下載連結、上傳與預覽、結果）、瀏覽器版（同一個後端程式；它自己的備份提醒呼叫不帶 `history`，仍是格式 2）、桌面版（同一個後端與前端，沒有自己的壓縮檔格式）、MCP（沒有備份工具）。

## 備份帶了哪些表：`test/helpers/backupCoverage.ts`

「備份有沒有帶這張表、誰在還原時放回去」只有一份清單：`BACKUP_COVERAGE`（逐表：帶在筆記旁檔的哪個欄位／`extras.json` 的哪個欄位／`spaces.json`／附件／版本歷史／從內文重算，
或不帶與原因；`missing` 寫出「帶了這張表、但少了哪幾欄」）。守門 `src/test/guards/backupCoverage.guard.test.ts`：schema 新增的表若沒列（且在 `spine/syncClasses.json` 不是 `derived`／`node-local`）就失敗；
清單承認的缺口（`gap: true` 或有 `missing`）是只准減少的 ratchet 清單。欄位名是 `BackupNote`／`BackupExtras` 的 key，改名會在編譯時壞掉。
還原那一側由 `backupRoundTrip.property.test.ts` 與 `backupHostHop.property.test.ts` 比對「畫面前後一樣」，各表的最小案例在 `helpers/roundTripRichSpec.ts` 的 `RICH_LOSSES`。

## 已知缺口

- 清單（`BACKUP_COVERAGE`）承認還沒帶的：`rss_mutes`（靜音）、`external_calendars`（行事曆訂閱）、`ink_manifests`／`ink_chunks`（大型手寫的舊版本）、`imported_media`、`snapshot_media`、`ai_edit_suggestions`（待審的 AI 修改）、`block_nodes` 的 `detached_*`／`hidden_at`、區塊層級複習進度、工作區的時區／換日時間／首頁筆記。
- 值是空字串的文字屬性還原後不見（`restoredAttribute` 刻意排除空值）：該不該留是擁有者的決定，`empty-attribute` 案例維持 `it.fails`。

- 白板分區（`_canvas_sections`）、區塊複習進度、發布快照用到的手寫頁圖檔與 `snapshot_media` 尚未帶；搬完需要再發布一次。
- 舊備份的垃圾桶筆記連結只能保守處理（見上）。
- 帶進來的版本在「近期變動」與日記時間線顯示擁有者的名字，不是原作者（版本清單顯示原作者）；來源是 AI 的版本在那些地方是擁有者的人工修改，不會進 AI 清單。
- 版本的 `ui_context`（例如系統整理）不帶：搬完後，系統整理產生的儲存在版本清單裡看起來是一般修改。用事件復原功能寫的存檔，現在帶著它「還原自」哪一版（版本表記下了；以前沒有帶）。
- 沒有內文事件的版本（白板與任務的建立：它們的建立事件不帶 `body_hash`）也會寫進備份，因為版本表有它；以前的備份沒有。
- 版本歷史只在搬進新工作區時帶；沒有「把歷史合併進既有工作區」，這是刻意的。

> 2026-11-18：清除「內建範例標籤」時，若其中有模組自己的標籤（例如收件匣）或系統標籤，會被拒絕刪除而保留（`ReservedTagError` 算作清除的拒絕，不中斷搬移；`cleared.tags` 不計入）。
