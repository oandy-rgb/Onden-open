# 邊界決定：本機備份與匯入（第 6–9 批，2026-09-12）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/modules/importers/**/*.ts, packages/backend/src/services/backupRestore.ts, packages/backend/src/services/backupExtras.ts, packages/backend/src/services/exportZip.ts, packages/backend/src/services/vaultPath.ts, packages/backend/src/services/taskListFile.ts, packages/backend/src/services/standaloneTasks.ts, packages/frontend/src/lib/localBackup.ts

何時讀：改本機備份、資料夾副本，或 Markdown／Obsidian／圖片匯入之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 第六批：本機備份與資料夾副本（2026-09-12）

- **替換操作自身確認落盤。** 比較 UI 額外 flush 與 worker 提供完整契約後，選擇後者。
  `importDatabase` 先驗證候選及工作區、等待 IndexedDB 交易提交，再替換作用中的資料庫。
  失敗保留原資料；RPC 與背景快照在同一 worker 內依序執行，不表示已解決跨分頁競態。
- **先複製再啟用目錄。** `localBackup.ts` 的 `chooseLocalBackupFolder` 封裝選取、複製與設定提交；
  已有 Onden 資料庫的目錄拒絕覆蓋，取消為正常結果，其他失敗回報且不重新載入。
  `switchToBrowserStorage` 先確認本機保存，保留原目錄檔案；設定頁不再各自排列儲存步驟。
- **已確認的本機快照優先。** 資料夾副本可能延遲或寫入失敗；啟動時不能用它覆蓋已有的本機工作區。
  只有沒有本機工作區時才從資料夾初始化，其餘替換走明確的匯入操作。
  這不是雙向檔案同步，也不宣稱資料夾副本永遠最新。
- **備份範圍必須說清楚。** 目前 SQLite 檔是本機快取與佇列，不包含媒體檔、完整伺服器歷史、
  瀏覽器偏好或尚未保存的編輯；還原不倒回伺服器。工作區 ID 比對是防誤用，不能代替後端授權。
  舊 `opfs` 偏好值保留相容性，UI 不再以它宣稱實際使用 OPFS。

實測與剩餘邊界見 [本機備份盤點](../archive/storage-audit-2026-09-12.md)。

## 第七批：匯入資料夾與結果回饋（2026-09-12）

- **重複匯入按來源路徑辨識資料夾。** 比較「同名同父層即重用」與「來源身分加建立紀錄」後，
  選擇 `modules/importers/obsidian/folders.ts` 擁有 `_import_folder_path` 衍生索引與匯入建立紀錄的核對。
  路由只給相對路徑及是否沿用，取得可用父層與新建／沿用／略過數量；不操作資料夾索引。
  已有資料夾的改名、正文和父層不被覆寫；唯一且有匯入建立紀錄的舊資料夾可補上內部索引。
  補索引不算內容修改；不藉前台提供的屬性把普通同名筆記認成資料夾。
- **無法安全解析父層就略過子樹。** 相同來源有多個候選、既有資料夾已移動、缺少讀取或寫入能力，
  都不得改放根目錄或默默另建同名樹。現存重複資料夾不自動刪除、合併；copy 模式仍明確建立另一份。
  這收緊了匯入父層的操作限制：editor 仍可用開放父層，受 read／write_node 或 token／human scope
  限制的父層不再被匯入繞過。資料夾解析與筆記寫入時都在事件鎖內檢查目前父層能力。
- **身分查找和寫入共用事件交易。** 資料夾與單筆 Markdown 各用 `withEventTransaction`，在事件鎖內
  查找、授權、取舊值、寫入並記錄；筆記查找改用交易內的 `q`，並在提交後才計入結果。
  不把匯入資料夾當成筆記的舊標題比對候選。資料夾未知儲存錯誤往共用 HTTP 邊界傳，
  只有已知權限／父層衝突可略過；這不是整批匯入的全有或全無保證。
- **UI 區分讀檔、提交與清單刷新。** 讀檔失敗沒有發出請求；送出後失敗可能已有部分提交。
  使用 `writeFailureMessage`，保留結果並提供重新選擇；已提交後刷新失敗不改判匯入失敗。
  此入口沒有整批持久化冪等鍵、離線佇列或 CSV 去重；媒體去重由下一批補上。
  不自動重送，也不能宣稱重匯絕對安全。
  本批當時仍缺 vault 命名空間與後續編輯保護；第九批已收緊這兩項契約，後續修改依第九批。

本批實測與剩餘限制見 [匯入盤點](../archive/import-audit-2026-09-12.md)。

## 第八批：匯入媒體與讀取授權（2026-09-12）

- **私有內容索引保留不透明 URL。** 比較雜湊直接當 URL 與私有雜湊對照後，選擇後者。
  migration 082 的 `imported_media` 按工作區、操作者、消毒後位元組與格式記錄隨機檔名；
  它是不可變檔案的內部索引，不是節點、權限、來源 vault 或事件。重用仍須 `canReadMedia` 允許，
  不能把知道內容或索引存在當成可讀證明。既有未索引媒體不猜測回填。
- **媒體準備隱藏儲存知識，正文重寫保有來源。** `prepareImportedImages` 統一驗證、SVG 消毒、
  內容比對、授權與落盤；路由只使用 `media.rewrite(body, sourcePath)`，Notion 正文也給原始頁面路徑。
  `importedImageLinks` 只處理來源路徑與語法：明確相對路徑不退回根目錄，短檔名須唯一，
  歧義或失敗路徑保留原引用並計數。程式碼、frontmatter 與普通連結不被圖片替換影響。
- **只重用相同內容，不覆寫舊圖。** 每檔在既有工作區事件交易鎖內查找及更新索引；磁碟暫存檔
  完整寫入並 rename 後再提交。變更內容建立新 URL；已索引檔案缺失／損壞時只用相同位元組修復。
  不合法圖片可略過，未知磁碟／DB 錯誤向共用錯誤邊界傳遞。DB 失敗可能留下孤立檔案，
  不確定 COMMIT 後不貿然刪檔；這不是整批原子性、持久化冪等或孤立檔案清理方案。
- **授權引用查找使用字面包含語意。** 實際 PostgreSQL 證明 PGroonga ILIKE 索引掃描會漏掉圖片 URL，
  不能再把空引用結果與三個跳過的媒體測試歸因於測試框架。`canReadMedia` 的正文及屬性查找
  改用 `strpos(lower(...))`，再沿用既有節點／公開集合政策；無引用圖仍要求已登入。
  三個案例已重新啟用，完整回歸沒有跳過；不宣稱已驗證發布快取或所有撤權入口。

實測、migration 與剩餘邊界見 [匯入圖片與媒體讀取盤點](../archive/import-media-audit-2026-09-12.md)。

## 第九批：匯入來源與覆蓋保護（2026-09-12）

- **來源身分必須明確。** 比較根資料夾名稱作 key 與使用者選擇持久 ID 後，選擇 UUID 來源；
  同名來源仍獨立，名稱只供顯示。`legacy` 明確沿用無來源 ID 的舊匯入，不自動認領到新來源。
  `modules/importers/shared/identity.ts` 集中路徑索引、建立事件歸屬與狀態基準；複製屬性不能偽造匯入來源。
  來源清單由可讀 live 節點的建立紀錄取得，使用 `readableScopeSql`；知道 ID 不能代替逐筆授權。
  不新增來源資料表或政策系統；來源全部不可讀／已刪除時不在清單出現。
- **單筆匯入由領域擁有。** 比較路由組裝查找與 helper 判斷，及完整領域操作後，選擇
  `importMarkdownNote({ actor, workspaceId, source, file, parentId, reuse })`。
  它封裝目標、權限、基準、逆向 patch、標籤、事件與 backup／embed；路由編排檔案及計數。
  imported／updated／unchanged／refused 明確區分；拒絕只回輸入路徑與原因，不洩漏目標內容。
- **覆蓋以前次成功匯入狀態為準。** 基準涵蓋標題、正文、父層、節點型別、標籤及非匯入索引屬性，
  排除 row ID／時間戳；在同一事件交易內比對及保存。內容相同的重匯不推進基準，
  不能藉 unchanged 批准未來覆蓋本機修改。需要更新而缺基準、有後續修改、已刪除或多個候選時拒絕。
  不再用標題／slug 認領手動筆記，也沒有 force、三方合併或改名追蹤。
- **內部索引與失敗歸屬一致。** frontmatter 同步不寫入 `_` 開頭的保留屬性，原 Markdown 保留。
  標籤解析在覆蓋核對之後，`tagHierarchy` 的 segment lookup 用 `q` 看見同交易的共同祖先。
  單筆未知儲存失敗向共用 HTTP 邊界傳遞，筆記、標籤、基準與事件一起回滾；
  已提交的其他檔案和預先準備的圖片不因此回滾，CSV／Notion 尚未遷移這份更新契約。
- **提交前選來源，失敗後保留選擇。** API 的 `upsert:true` 必須附 source，缺少時在寫入前回 400。
  UI 先讀檔，再顯示來源／檔案數與開始按鈕；不明回應後同表單沿用來源 ID。
  ID 不是請求冪等鍵，不能宣稱整批原子性或跨重載重試已解決。衝突保留內容並列出原因。
  手機設定導覽的選擇器須能抵抗共用桌面 CSS 的載入順序，避免直排側欄造成大片空白。

實際驗證、相容性與剩餘邊界見 [匯入來源與覆蓋保護盤點](../archive/import-source-audit-2026-09-12.md)。

## 獨立任務的匯出與匯入（T7，2026-10-24）

- **範圍。** 獨立任務＝沒有 `parent_id` 的 hidden 且掛 `#task` 的節點（`standaloneTasks.ts`）。
  筆記裡的 `- [ ]` 行本來就在 Markdown 裡，不動；本批只處理沒有宿主筆記的任務，
  因為它們的欄位（`_task_*`）不在任何筆記文字中，匯出會漏。
- **一個檔案、一份文法。** Markdown 匯出把它們寫成 `任務/任務.md`（`?lang=en` 為 `Tasks/Tasks.md`），
  文法只在 `taskListFile.ts`：`renderTaskList` 寫、`parseTaskList` 讀。符號對應 Obsidian Tasks：
  ⏳ scheduled＝何時做（`_task_when`，讀時也認舊的 `_task_due`）、📅 due＝截止（`_task_deadline`）、
  🔁＝`_task_recur`（`2w`⇄`every 2 weeks`）、✅＝完成日、`[ ] [x] [-] [/]`＝todo/done/cancelled/doing。
  Obsidian Tasks 沒有符號的欄位（`_task_evening`、`_task_someday`、`_task_remind_at`、`_task_recur_mode`、
  其他 `_task_*`、非標準狀態）用 Dataview 行內欄位 `[evening:: true]`，所以任何欄位都不會被漏掉。
  行尾 `^t-<節點 id 前 12 碼>` 是穩定代碼。有內文的任務另存 `任務/<標題>.md` 並在行內用 `[[…]]` 連過去
  （連結與圖片照一般筆記改寫成相對路徑與 `attachments/`）。
- **匯入認檔案，不認路徑。** frontmatter 有 `onden_export: tasks` 的檔案才是任務清單
  （`modules/importers/markdown/taskLists.ts`）：每行變回獨立任務，連到的內文檔變成任務內文而不是另一篇筆記，
  段落標題忽略（可任意搬動行）。沒有標記的檔案——包括別人寫了 Obsidian Tasks 符號的筆記、
  一篇叫「任務」的筆記——照原本的匯入行為。更新匯入（`upsert`）遇到 `^t-…` 已對到本工作區可讀的任務就略過，
  不更新其欄位；一般匯入永遠新建。
- **「不發布」的 frontmatter 鍵**（2026-11-12）：標成「不發布」（`_published`＝`false`）的筆記匯出成 `publish: false`
  （Obsidian Publish 的同名開關）；匯入讀回成同一個標記。作者自己已有 `publish` 欄位（值不是 `false`）時匯出不覆蓋，
  標記改寫成 `onden_publish: false`；匯入兩個鍵都認，`onden_publish` 讀完不留在筆記裡。作者自己的 `publish: false`
  已經表達同一件事，不再多寫第二行。常數在 `@onden/markdown` 的 `PUBLISH_OFF_KEY`／`PUBLISH_OFF_FALLBACK_KEY`。
  匯入一份「檔案沒變、但本筆記還沒有 `_published`」的舊匯入筆記也會補上標記（已有任何值就不動，之後使用者給的「發布」不被覆蓋）。
- **讀取與復原。** 匯出走 `readableScopeSql`，別人個人空間的任務與內文不會出現。
  `taskHostLiveSql` 現在把沒有宿主的任務視為自己存活（原本一律當成「宿主已刪」，
  任何節點授權與讀取都看不到它）。備份還原把獨立任務經 `createStandaloneTask` 還原
  （內文、所有 `_task_*`、落在目標空間）；原本它被當成「宿主不可放置」而靜默丟掉。
- **限制。** 標題結尾若恰好長得像欄位（`⏳ 2026-01-01`、`[k:: v]`、`^t-…`）會被匯入讀成欄位；
  完成日 ✅ 取自最後更新日，匯入時不回存；匯出只帶 `_task_*` 欄位，任務上的其他標籤與屬性不在清單中
  （備份的 sidecar 有）；備份的 Markdown 半邊不含任務清單。`createStandaloneTask` 是匯入／還原用的建立入口，
  T1 的任務建立路徑合併後應由它取代。

## 匯出帶得走：檔名用標題、連結對得到檔案（盲測修正第 2 批，2026-11-02）

- **檔名＝標題。** `services/vaultPath.ts` 的 `vaultName` 以標題（其次 slug、id）命名，
  把檔案系統與連結不能用的字元（`\ / : * ? " < > | # ^ [ ]`、控制字元）換成空白，擋 Windows 保留名；
  同一資料夾重名依序加 ` 2`、` 3`。資料夾仍照筆記樹（父筆記＝資料夾加旁邊同名檔）。
- **改名的檔案要能被連結找到。** 檔名與標題不同時（清過字元、被截短、重名），`exportZip.ts` 把檔名
  寫進該筆記的 `aliases`（Onden 與 Obsidian 都認），並把指向它的 `[[標題]]` 改寫成 `[[檔名|標題]]`
  （`#標題` 錨點保留、程式碼內不動）；匯入端靠別名解回同一篇，所以匯出→匯入的連結圖不變。
  同標題的多篇在 Onden 本來就是同一個連結目標，維持 `[[標題]]` 不改寫。
- **id／slug 仍在 front matter。** 還原需要的 `id`、`slug` 沒搬去 `.onden/`；完整備份的 sidecar 不受影響。
- **Markdown 連結要編碼。** 檔名有空白，`[文字](./a b.md)` 會斷，所以 `rewriteLinks` 輸出 `%20` 等。
- **匯入路徑只擋絕對路徑與網址。** 檔名中間的 `:`（`Note: 草稿.md`）是普通字元；
  先前 `^[a-z][a-z0-9+.-]*:` 會讓一個檔名使整批 400。
- **匯入報告列出沒轉成任務的核取方塊。** `- [ ]` 沒有 `{task}` 標記就是一般核取方塊；
  `checkboxes_not_tasks`／`checkboxes_with_dates` 回報數量，不改任務語意。
- **跳轉排序四級。** 標題完全相符 > 前綴 > 包含 > 其餘：伺服器兩個引擎共用 `titleTiersFirst`，
  瀏覽器端的標題挑選器（`[[`、指令面板的標籤）用 `rankByTitle`。pgroonga 的排序案例在 PGlite 上具名跳過，需真 Postgres 驗。

## 備份還原的保真與搬整個工作區（2026-11-06）

- 還原保留 slug（未刪除優先，垃圾桶筆記用暫時 slug 再改回）、連結一次決定、任務欄位對齊備份、筆記本身的系統屬性跟著回來；
  新增 `mode=workspace`（僅擁有者、僅新工作區，不重建成員）與 `.onden/extras.json`（備份格式 2，舊備份仍可還原）。
  規則、屬性分類表與「新的工作區」的精確定義見 [backup-move.md](../architecture/backup-move.md)。
- 新的還原行為要先在 `src/test/backupFidelity.integration.test.ts`／`backupWorkspaceMove.integration.test.ts` 加案例；
  新增要搬的資料放進 `backupExtras.ts`，不要在 `backupRestore.ts` 再加分支。

## 備份還原的缺口補齊（2026-11-14，`fix/backup-restore-gaps`）

- 任務的內文／標籤／屬性、各種檢視、報告的略過計數、中途失敗清理不得永久刪除後來的工作：規則見 [backup-move.md](../architecture/backup-move.md)（任務、檢視列），報告與中途失敗的清理見 [restore-writes.md](../architecture/restore-writes.md) 最後一節。
- 備份格式沒有改（仍是 2；舊備份照樣能還原）：需要的資料本來就在 sidecar 裡。進行中的 `feat/move-backup-history`（格式 3）只動 `moved.history` 與 `FullBackupSetting` 的搬家區塊，這批的契約欄位（`tasks`、`views`、`skipped.*`）與畫面（`RestoreResult`）在不同位置。
- 新增要搬的種類：先在 `test/helpers/backupInventory.ts` 登記為「帶」或「不在備份裡（理由）」，保真測試才會過。

> 2026-11-18：備份還原「清除內建範例」遇到被保護的標籤（reserved、任務、在用模組的標籤）時，保留該標籤並照常繼續（`ReservedTagError` 算清除的拒絕，`cleared.tags` 不計）；其他還原規則不變。
