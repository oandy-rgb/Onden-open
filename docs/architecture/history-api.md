# 整個工作區的「歷史」API

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/history/**, packages/backend/src/routes/history.ts

何時讀：改 `routes/history.ts`、`services/history/*`，或前端「歷史」畫面（`components/history/`）時。
後端全部限制在「呼叫者讀得到的筆記」（`readableScopeSql`；已刪除用 `readableTrashedNodeIds`）。

## 合約（最終版）

**`space` 查詢參數**（`/activity`、`/day`、`/feed`、`/deleted`、`/deleted/:id`，可選）：空間 id。有給時只算 `n.space_id = <id>` 的筆記，
疊在讀取範圍之上；呼叫者讀不到或不存在的空間＝沒有任何資料（空結果／404），不洩漏空間是否存在；不是 uuid 回 400；不給時行為不變。
AI 執行只列該空間的筆記，一篇都不在該空間的執行不出現。回應裡每筆筆記（`DayNote`、agent run 的 `notes`、`deleted`）都帶 `space_id`（可為 null）。
撤銷／取消撤銷 API 不變，前端只送篩選後的 `node_ids`。

| 路由 | 回應 |
| --- | --- |
| `GET /api/history/activity?days=14&until=YYYY-MM-DD` | `{ days: [{ date, you, agents }] }`，`days` 1–90，最後一天是 `until`（預設今天），沒有修改的日子補 0 |
| `GET /api/history/day?date=YYYY-MM-DD` | `{ notes: [DayNote], agent_runs: [{ run_id, agent_name, started_at, summary, notes: [{ id, title, added, changed, removed }], undone }] }`；`DayNote` = `{ id, title, edits, first_at, last_at, actors: [{ name, kind }], created, change, ink, board_ink }`（`ink`／`board_ink`：當天在手寫頁／白板筆層畫了、擦掉幾筆，沒變＝null）；另有 `rewinds: [RewindCard]`（見下） |
| `GET /api/history/day/notes?date=YYYY-MM-DD&offset=0&limit=50` | `{ notes: [DayNote], notes_total, edits_total }`：該天第 `offset` 篇起的 `limit` 篇（新到舊，`limit` 1–200），與 `/day` 的 `notes` 同一順序、同一內容；`/feed` 只送每天最前面 50 篇，「顯示更多」用這條取後面的 |
| `GET /api/history/feed?until=YYYY-MM-DD&days=14` | `{ days: [{ date, end_at, notes: [DayNote], notes_total, edits_total, agent_runs, rewinds }], earlier_day }`：每天的 `notes` 只有最新 50 篇，`notes_total`／`edits_total` 是該天（呼叫者讀得到的）全部篇數與修改次數；`[until-days+1, until]` 之間**有修改的日子**，新到舊，沒有修改的日子不回傳；`days` 1–31，`until` 預設今天 |
| `GET /api/history/deleted?days=30` | `{ notes: [{ id, title, deleted_at, space_id, blank }] }`，`days` 1–365；救回用既有 `POST /api/nodes/:id/undelete` |
| `GET /api/history/deleted/:id` | `{ id, title, markdown, deleted_at }`：一篇刪除筆記刪除前最後的內文（兩欄版右欄的預覽）。不是已刪除、已永久刪除、或呼叫者讀不到（`canReadRetainedNode`）一律 404 |
| `POST /api/history/deleted/purge` body `{ items: [{ node_id, expected_ids }] }` | `{ results: [{ node_id, purged: true, media_removed } \| { node_id, purged: false, code }] }`，1–200 筆 |
| `POST /api/history/agent-runs/:runId/undo` body `{ node_ids }` | `{ undone, conflicts, skipped }`（皆為筆記 id 陣列） |
| `POST /api/history/agent-runs/:runId/redo` | 同上 |
| `GET /api/history/at?t=<ISO>&space=` | 見〈回到某個時間點〉：`{ at, counts, notes }` |
| `GET /api/history/at/:id?t=&space=` | 一篇筆記當時與現在：`{ id, status, title_then, markdown_then, title_now, markdown_now, deleted }`；讀不到或不在清單內 404 |
| `POST /api/history/rewind` body `{ t, space?, restore_ids, undelete_ids, delete_ids }` | `{ rewind_id, restored, undeleted, deleted, stale, unwritable, skipped }`（皆為筆記 id 陣列；`rewind_id` 為 null＝什麼都沒寫） |
| `POST /api/history/rewinds/:rewindId/undo` body `{ node_ids }` | `{ undone, conflicts, kept, skipped }` |

- **`change`**（`DayNote`）：這天這篇的內文變化。基準＝當天第一次儲存**之前**最後的內文（沒有就是 ""，即新建），
  對上當天最後一次儲存的內文，用 `summarizeChange` 同一套段落對齊算出
  `{ added, changed, removed, sections, sample, sample_kind }`。`sample` 是第一處（文件順序）有字可顯示的改動段落：
  新增或改寫用新內容、刪除用舊內容（`sample_kind` = `added | changed | removed`），去掉開頭的標題／清單／任務框／引用記號與結尾的 `^id`，
  多行併成一行，最長 120 字（超過截成 119 字加「…」）；沒有可顯示的文字時 `sample` 與 `sample_kind` 為 null。
  內文當天沒變（只改標題，或改了又改回來）時三個計數為 0。任一邊內文已被清除時整個 `change` 為 null。
  段落對齊與「哪些段落被動到」在 `noteVersions.ts touchedSegments`，筆記版本清單（`summarizeChange`）與這裡共用，輸出不變。
- **`/feed`**：與 `/day` 同樣只含呼叫者讀得到的筆記與 agent 執行，內容是同一個函式（`notesEditedBetween`／`agentRunsBetween`）一次算多天。每天只取前 `FEED_NOTES_PER_DAY`（50）篇，變更摘要與參與者只對這些列計算（排名、總數在同一個查詢內，參與者每個（日、筆記）只聚合一次）；前後內文雜湊用一個語句的 LATERAL 查出。
  `earlier_day` 是窗口之前最近一次內文儲存所在的日子（null＝沒有更早的）：下一頁用它當 `until`，整段 14 天都沒修改也能一步跨過。
  它是提示，不是保證：那次儲存可能屬於一個在窗口內結束的修改，所以下一頁可能是空的，但會再給出更早的 `earlier_day`，一定會走到 null。
- **`blank`**（已刪除）：一般筆記（不是白板）、內文去空白後為空、沒有任何以它為上層的筆記（不論是否一起被刪）、沒有存在內文以外的內容（`ink_data`、`sketch_data` 等；`_` 開頭的匯入／發布紀錄不算），而且標題只是預設名稱：空的、「未命名」「Untitled」「新筆記」「New Note」，或只有日期（空白的日記）。新筆記建立時一定有預設名稱，不會是空標題。
  所以永久刪除它只會帶走它自己，前端送 `expected_ids: [id]`。
- **`POST /deleted/purge`**：對每一筆各呼叫一次 `purgeDeleted`（各自的交易、權限檢查與 `expected_ids` 比對，與單筆完全相同），
  被拒絕的筆（`not_found`、`not_deleted`、`plan_changed`、`live_descendant`、無權限等，`code` 是單筆會回的錯誤碼）記在結果裡，其餘照做；
  資料庫錯誤等非拒絕的例外會中止並照一般錯誤回應。
- **日**：以工作區的時區與「一天從幾點開始」（設定 › 時間；沒設過時為 `ONDEN_TIMEZONE`，再沒有就 UTC；`localDay.ts`）切日，`end_at` 是下一天開始的前 1 毫秒。`date` 缺省為今天；格式錯誤回 400。
- **修改次數**：與版本清單同口徑——同一篇、同一作者、相鄰兩次保存不超過 5 分鐘合成一次；建立與還原各自算一次。
  一次修改歸在它最後一次保存的那天。`you` 是人類（含其他成員），`agents` 是 agent。
- **`summary`**：session 的提示文字（空白壓成一格、超過 80 字截短加「…」）；沒有 session 的舊紀錄為空字串。
- **`added/changed/removed`**：該次執行前後內文的行數差（一行被改成另一行算 `changed`，其餘為新增或刪除）。
- **`undone`**：這次執行裡「可以回去的筆記」（非本次建立、有執行前內文）全都已撤銷且之後沒有取消。
- 沒有權限寫入的筆記、不在這次執行裡的筆記、本次執行建立的筆記（沒有「之前」）、內容已被清除的筆記：不動，放進 `skipped`。
  有重疊行而進收件匣的筆記同時在 `undone` 與 `conflicts`。重送同一個動作（回應遺失後重試）不再寫入，仍回報在 `undone`。
- 找不到該次執行（或其中沒有讀得到的筆記）回 404。

## 回到某個時間點（看那時的樣子、還原到這時）

### 第 0 步的結論：事件紀錄能可靠重建什麼

| 項目 | 能不能重建 | 依據與取捨 |
| --- | --- | --- |
| 標題與內文 | **可以，會還原** | 每個 `NODE_CREATED`／`NODE_UPDATED`／`NODE_RESTORED` 帶 `title` 與 `body_hash`（內文在 `blobs`）；T 當時的版本＝T 之前（含）最後一個這類事件。事件不會被改寫或刪除（唯一例外是永久刪除時的內容清除）。 |
| 筆記在不在 | **可以，會還原** | T 之前有內文事件，且最後一個 `NODE_CREATED`／`NODE_DELETED`／`NODE_UNDELETED` 不是刪除 → 當時在。「T 之後新增」要有**正面證據**：它的 `NODE_CREATED` 在 T 之後，而且 T 之前沒有任何內文事件。沒有建立事件（其他種建立、事件已清除）的筆記不會被當成「之後新增」，所以不會被刪。 |
| 位置（parent） | **不可靠，這版不還原** | `NODE_CREATED` 不一定記上層；搬動走好幾條路（編輯 PATCH 的 `parent_id`、搬到別的空間、標籤合併、升格…），不是每條都記下舊位置。猜錯會把筆記放到錯的地方，寧可維持現在的樣子。 |
| 標籤 | **不可靠，這版不還原** | `TAG_APPLIED`／`TAG_REMOVED` 有，但標籤合併、刪除、串聯移除等路徑不會逐篇留下對稱事件，重建結果可能與當時不同。 |
| 白板／手寫內容、媒體檔、標籤定義、模組、設定、網站發布 | 不在範圍 | 它們的資料不是靠這條內文事件鏈；確認畫面白話寫「只還原筆記的內容」。 |

筆記屬於哪個空間用**現在**的 `space_id`（搬過空間的筆記算現在那個空間）。只算 `node_type = 'content'` 且不隱藏的筆記。

### `GET /api/history/at`

`t` 是帶時區的 ISO 時間（沒有或格式錯回 400；比現在晚就當現在）；`space` 同其他路由。只算呼叫者讀得到的筆記
（活的：`readableScopeSql`；已刪除保留的：`readableTrashedNodeIds`，與 `canReadRetainedNode` 同一條規則），讀不到的完全不出現。
一次 SQL 取每篇 ≤T 的最後內文事件與最後生命週期事件（`DISTINCT ON`），不是每篇一個查詢。

| `status` | 意思 |
| --- | --- |
| `same` | 當時在，標題與內文跟現在一樣（只計數，不列出） |
| `changed` | 當時在、現在還在，標題或內文不同；附 `change = { added, changed, removed, sections }`（當時 → 現在，與版本清單同一套段落對齊；只算前 300 篇，其餘為 null） |
| `deleted_since` | 當時在、現在在「最近刪除」 |
| `created_since` | T 之後才建立、現在還在 |

回應 `{ at, counts: { same, changed, deleted_since, created_since, total }, notes: [...] }`；`notes` 不含 `same`，依 changed、deleted_since、created_since 排。
不回傳內文；單篇用 `GET /at/:id`。

### `POST /api/history/rewind`

伺服器**不信任**瀏覽器送來的清單：在工作區事件鎖內重算 T 的狀態，再逐個 id 檢查它確實屬於被指定的那一組
（`restore_ids`⊂changed、`undelete_ids`⊂deleted_since、`delete_ids`⊂created_since；有給 `space` 時只算該空間），
不屬於的記在 `stale`（例如之後又被改過、不在這個空間）。三組加起來超過 2000 篇回 400 `rewind_too_many`，什麼都不寫。
一個交易完成（`withEventTransaction`；每篇一個 savepoint，一篇被拒不影響其他篇）。每篇都走既有的寫入服務，權限、事件、slug、衍生狀態都與一般操作相同：

- 還原內容：`updateNode` 寫一個**新版本**（T 的標題＋內文）。沒有刪或改任何舊事件。內文與標題已經是 T 的就不寫。
- 救回：`undeleteNode`（`restoreLive`，連同一起刪掉的子孫與被刪的上層），之後若內文不是 T 的，再寫一個新版本。
- 之後新增的：`trashNode`（軟刪除，進「最近刪除」，絕不硬刪）。它底下活著的子筆記照既有規則一起進垃圾桶，所以**只要底下有一篇不是「之後新增」的筆記
  （例如較舊的筆記後來被搬進來），這篇就整個跳過**（`skipped`），不把舊筆記連帶刪掉。
- 沒有寫入權限（`AuthorityError`／`ScopeError`）的記在 `unwritable`，其他不動。全部沒寫 → `rewind_id: null`，不留紀錄。
- 重送同一個請求：idempotency key 重複＝原結果；沒有 key 時，狀態已是 T 的筆記變成 `stale`，不會再寫一遍。

### 怎麼記、怎麼撤回（沒有新的資料表）

每個寫出的事件的 `tx_meta` 帶 `rewind_id`（隨機 uuid）、`rewind_to`（T）、`rewind_kind`（`restore`｜`undelete`｜`undelete_content`｜`delete`）。
feed 的 `rewinds`（`/day` 與 `/feed` 每天）由這些事件依 `rewind_id` 分組：`{ rewind_id, to, at, actor_name, notes: [{ id, title, space_id, kind }], undone }`，
只含呼叫者讀得到的筆記；一張卡片都沒有可讀筆記就不出現。**選擇不把還原建模成 `agent_runs` 那樣的 run**：agent run 的「前後內文」是從 run 分組推出來的，
還原的前後內文本來就在事件鏈上（上一個內文事件），而且還原要處理刪除／救回，agent run 沒有這兩種；沿用的是 `agentRunUndo` 的**合併作法**（`updateNode` 的 `baseMarkdown`＋`keepOnConflict: "current"`）。
Migration `136` 只加兩個 partial index（`tx_meta ? 'rewind_id'`／`'undoes_rewind'`）讓查詢不用掃整張事件表，沒有資料變更。

`POST /rewinds/:rewindId/undo`（也是一個交易、依目前權限、每篇一個 savepoint）：

| 當初 | 撤回 |
| --- | --- |
| `restore` | 三方合併：base＝還原後的內文、theirs＝還原前的內文、ours＝現在。之後別人改的行保留；同一行兩邊都改，筆記保留現在的字，另一邊進收件匣（`BODY_CONFLICT`，回在 `conflicts`）。還原之後標題又改過就不動標題。 |
| `undelete` | 再刪一次——除非這篇（或底下的筆記）在還原之後又有人改過內文：那就保留（`kept`），因為刪掉會藏起新的工作。 |
| `delete` | 從最近刪除救回。 |

撤回的事件帶 `tx_meta.undoes_rewind`，卡片的 `undone` 與重送的 no-op 都由它推得。沒有可讀筆記或找不到 → 404 `rewind_not_found`。

### 前端

- 過去某天的標題旁有安靜的「那天的樣子」（今天沒有：沒有東西可比）。T＝那天在工作區時區的最後一毫秒（`endOfDayInstant`）。
- 筆記列的 ⋯ 選單與 AI 卡片的安靜連結「回到這之前」：T＝該筆記當天第一次儲存（`first_at`）／該次執行開始（`started_at`）前 1 毫秒。
- 預覽（`RewindPreview`）：寬螢幕在右欄，窄螢幕是全螢幕 Modal；一句數字、三組清單（沒變的只計數）、點一篇看當時與現在的段落差異（`alignParagraphs`）、最下方「還原到這時」→ 確認畫面（`RewindConfirm`，三組各自可勾、預設全勾、一句範圍說明、離線停用）。
  選了切點時，清單裡比 T 新的列（筆記、AI 卡片、還原卡片）變淡並標「會被撤銷」，切點處有一條線，上方有說明列；關掉預覽就恢復。窄螢幕的預覽是 Modal，關掉才看得到清單。
- 還原卡片（`WorkspaceHistoryRewindCard`）：「還原到 10/23 下午06:00 · N 篇」、列出筆記與各自發生的事、「撤銷這次還原」（先選筆記）。

### 限制

- 位置與標籤不還原（見上）。若之後要做，需要先讓每條搬動與標籤路徑都記下舊值。
- 「T 之後新增」只認 `NODE_CREATED`；其他種建立的筆記不會被刪。
- 同一個交易內的事件共用 `created_at`，切點落在同一個交易中間時以事件 id 的順序為準。
- `changed` 的段落數字只算前 300 篇。

## 怎麼分辨「一次執行」

`spine/mutate.ts` 發事件時，若操作者用的是 agent session 的 token（`tokenScope.sessionId`），
事件 payload 帶 `agent_run_id` = session id（由操作者推導，呼叫端不能傳）。執行 = 同一個 `agent_run_id`。

沒有這個欄位的舊事件（以及常駐 token 的寫入）：同一個 agent、只算改內文的事件
（`NODE_CREATED/UPDATED/RESTORED` 帶 `body_hash`），相鄰間隔不超過 10 分鐘為同一次，`run_id` =
`legacy:<actor_id>:<第一筆事件 id>`。同一份歷史算出的 id 固定；進行中的執行會隨新事件延伸，id 不變。
沒有 migration。

## 撤銷與取消撤銷

每篇筆記，`pre` = 執行第一次寫這篇之前的內文（該筆記更早的最後一個內文事件）、`end` = 執行最後一次寫之後的內文、
`now` = 現在：

- 撤銷：`threeWayMergeBody(base = end, ours = now, theirs = pre)`，之後人類自己改的行保留。
- 取消撤銷：`base = pre, theirs = end, ours = now`（同一個變更再套一次）。
- 同一段兩邊都改過：筆記保留 `now`，另一邊的文字進 `BODY_CONFLICT`（收件匣），不覆蓋任何人寫的字。
  做法是 `updateNode(..., { baseMarkdown, keepOnConflict: "current" })`，合併在事件鎖內、依目前寫入權限進行。
- 每篇一個一般的 `NODE_UPDATED`，操作者是按下的人，`tx_meta.undoes_agent_run = runId`、
  `agent_run_action = undo|redo`；`undone` 就是由這個標記推得。
- 只復原內文；agent 改的標題不動。

## 限制

- `GET /day` 的 `agent_runs` 會掃過本工作區所有 agent 的內文事件來分組（agent 事件遠少於人類事件；
  若成為瓶頸，再為 `(workspace_id, actor_type, event_type)` 加索引或快取 run 邊界）。
- 本次執行建立的筆記不能用這支 API 撤銷（要刪除請用筆記的刪除與救回）。

## 前端畫面

- 歷史頁只看整個工作區（標題「歷史」一行）。一篇筆記的歷史一律是時間滑桿（`NoteHistory`），
  從筆記標題下「N 天前修改」、筆記 ⋯ 選單、歷史頁的列進去；沒有「這篇筆記｜整個工作區」切換，也沒有每篇的事件清單。
  `?view=timeline` 開這一頁；舊的 `?lens=timeline` 開該筆記的編輯器。
- **「變更」一次只看一天**：長條圖是「選日子」，清單只顯示選中的那一天（標題、AI 執行卡、筆記列）。預設是最新一個有修改的日子；
  點任一根長條（含沒有修改的日子）換成那一天。選中的日子在比較舊的頁，就用 `useHistoryFeed.loadThrough` 載到那天，載入中顯示「載入中…」；
  載完仍沒有資料顯示「這天沒有修改」。沒有無限捲動、「更早」按鈕與「沒有更早的修改」；更早的日子用長條圖的 ‹ › 換 14 天區間。
  換區間時，原本選中的日子不在新區間內，就改選新區間裡最新一個有修改的日子，沒有就選區間最後一天（顯示「這天沒有修改」）。
- **兩欄**：歷史頁自己的寬度（`useElementWidth`，不是視窗寬，因為側欄可收合）≥ 1100px
  （`TWO_COLUMN_MIN_WIDTH`）時，左欄是長條圖＋分頁＋清單，右欄是選中那一列的細節；兩欄各自捲動。
  更窄時維持單欄，點「變更」的列跳出時間滑桿視窗；「最近刪除」沒有細節視窗（列上本來就有「救回」）。
- 右欄由各分頁自己用 portal 放進頁面提供的 `DetailSlot`（`detailSlot.ts`），所以資料與選取狀態留在各分頁裡：
  - 「變更」：同一份 `NoteHistory` 以 `inline` 嵌入（沒有 Modal 與返回鍵，頂端多「打開筆記」），開在該列那天結束時的版本
    （`initialIndex(points, versionId, day)`）。預設選選中那天的第一列；換日子時改選新那天的第一列，方向鍵只在那天的列之間走；
    選取一旦決定就保留，重新載入清單時不會因為最上面多出新的一列而換掉右欄。
    在右欄回到某版、只拿回一段、另存新筆記後，左欄清單與長條圖重新載入。
  - 「最近刪除」：用 `GET /deleted/:id` 讀內文，以唯讀 Markdown 預覽顯示並附「救回」；空白筆記那一行選中時顯示「N 篇空白筆記，沒有內容可看」。
  - 鍵盤：清單上下鍵換選（焦點跟著），Enter 在「變更」打開筆記。

- **空間篩選**：標題列（分頁右側）的「全部空間 ▾」選單，只在讀得到 ≥2 個空間時出現。選擇由 `historySpace.tsx` 的 context（`useHistorySpace()`）提供給長條圖、
  清單、AI 卡片與最近刪除，記在 `PREFS.historySpace`（帳號範圍的 localStorage）；記住的空間已不存在或讀不到時退回全部。
  切換時 `useHistoryFeed` 以 space 為依賴重新載入，右欄已選的筆記清掉。「全部空間」且 ≥2 個空間時，每列筆記標題後面有淡色小字空間名稱；選了單一空間不顯示。

## 版本關係：`body_hash` 與 `base_hash`（遷移 162，2026-11-02 業主決定）

事件紀錄本身是一條直線（流水號＋反向補丁）。從 162 起，改動筆記內文的事件（`payload.body_hash` 存在者：
`NODE_CREATED`／`NODE_UPDATED`／`NODE_RESTORED`）在 `domain_events` 多記兩欄，讓版本關係之後可以還原成 DAG
（分散式同步、匯回更新、簽章會用到）。**現在只記錄，不改任何使用者看得到的行為**；事件重播、復原、同步、匯出不讀這兩欄。

- `body_hash`：這筆之後的內文。與 `payload.body_hash` 同值，另存一欄是為了能用索引（`domain_events_body_hash_idx`，部分索引）
  回答「哪筆事件的 body_hash = X」；放 `tx_meta` 做不到而且每筆事件都要付 jsonb 運算式索引的代價。
- `base_hash`：這筆寫入是從哪個內文做出來的。編輯器存檔送 `baseMarkdown`（合併基準）時是它的雜湊；其他寫入
  （補丁、AI／MCP、匯入、復原、重做、複製、自動化）是「該筆記上一筆帶 body_hash 的事件」的內文，也就是被取代的那版。
  筆記的第一版為 `NULL`。
- 雜湊規則：內文 UTF-8 位元組的 SHA-256 十六進位（`utils.ts` `sha256Hex`，與 `blobs.hash` 同一個），**不做任何正規化**——
  換行、前後空白、frontmatter 都算在內，因為存下來的就是這份文字。目前只有後端計算，所以沒有放進 `@onden/markdown`；
  前端若要算，與 `blobs` 對得上的唯一做法是對同一份字串做同樣的 SHA-256，不要先 trim 或換行轉換。
- 唯一填寫處：`db.ts` 的 `insertEvent`（所有事件都經過它，`mutate`／`event` 皆然）。呼叫者不算雜湊；只有編輯器存檔經
  `mutate({ event: { baseHash } })` 帶入合併基準（`services/nodeUpdate.ts`）。新的改內文寫入路徑只要把 `body_hash` 放進 payload 就自動被記。
- 舊事件不回填：欄位為 `NULL`，讀的人退回 `payload.body_hash`，且只有「上一版」一個父版本。
- 版本的父子關係：每版的父版本＝`base_hash` 與「當時的最新版（上一筆內文事件）」，兩者相同就只有一個；合併存檔有兩個。
  目前沒有程式把它還原成圖（原本只供測試用的 `versionParents` 已於 2026-11-14 刪除），要用時從這兩欄重建。
- 寫入成本：每筆帶內文的事件多一次以 `domain_events_target_idx` 往回找上一筆內文事件的查詢（通常第一列就命中），
  加一個部分索引的維護；沒有內文的事件不付任何成本。
- 守門：`test/eventBodyHash.integration.test.ts`——帶 `payload.body_hash` 的事件必須帶同值 `body_hash`，除第一版外必須有 `base_hash`。

## 筆跡歷史（手寫頁與白板筆層）

一則筆記有兩份筆跡，歷史各列各的：`GET /api/nodes/:id/ink-edits?kind=handwriting|board`（每次編輯畫了、擦掉幾筆，新到舊）、
`/ink-change?kind=&before=&after=`（兩張圖，打開那一列才讀）、`/ink-versions?kind=`，以及 `POST /api/nodes/:id/ink-versions/:eventId/restore?kind=`
（回到該次儲存後的樣子：只寫該 `kind` 自己的屬性，成為一筆新的儲存）。沒帶 `kind` ＝ `handwriting`，其他值 400。
哪個事件算哪一種、migration 172 搬過的白板舊事件怎麼接，見 [ink-attributes.md](ink-attributes.md) 的「歷史」。
`/day`、`/feed`、`/activity` 的「編輯」與「這天編輯過的筆記」把兩種筆跡的儲存都算進去（`editEventSql`）。
