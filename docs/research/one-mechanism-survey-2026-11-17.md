# 同一件事兩套做法：普查（2026-11-17）

> 狀態：歷史紀錄（寫於 2026-11-17）
>
> 2026-11-17 業主審查後修訂（第 3、4、9 項與排序）。最後一節「當時的建議」是寫作當天的看法，之後的排程以 PR 討論與業主決定為準。

業主 2026-11-17 在同意「RSS 重點與 PDF 重點應該是同一個機制」之後說：「找看看有沒有其他機制」。
這份報告找出 App 裡**同一個概念有兩種以上做法**的地方：在一邊加的規則，另一邊沒有；或使用者以為是同一件事，卻看到兩種行為。
只調查，沒有改任何產品程式或測試。

## 怎麼查的（做了哪些）

1. 讀 `docs/architecture/feature-map.md`、`docs/architecture/core-vs-modules.md`、`docs/agents/entrypoints-catalog.md`（只取責任表，找同一概念出現在兩處）。
   三份 `decisions-*.md` 只對照了與下列家族相關的段落，沒有逐份讀完。
2. 依業主列的家族逐一把「存的地方、寫的人、讀的人」並排：
   引用與指向（摘錄、區塊引用、嵌入、標題／段落連結、反向連結）、頁面上的標記（手寫、文字框、圖、PDF 標記）、
   名稱與唯一性、隱藏與移除、排序、日期與「今天」、「這段是任務／卡片／引言」、權限與範圍、離線與重試、
   文字搜尋、匯入／匯出／備份、復原、設定與偏好、通知、數量與上限。
3. 找名字像雙胞胎的程式（`Legacy`、`V2`、`old*`、`Compat`）。
4. 用 GitHub 查了開放中的 PR（共 29 個），看有沒有人已在處理。
5. 分工：我自己讀「名稱與唯一性」「引用與指向」；另外三組只讀程式的調查（分別負責排序／隱藏／上限／日期、
   權限／搜尋／匯出匯入／復原、標記／任務／離線／通知／偏好），我再對下列幾項回頭核對原始碼：
   離線搜尋、空白筆記、任務行的字、兩個標題選單、日曆分日、白板分頁、RSS 清理、PDF 匯出、標籤名長度。

**沒有執行任何測試或腳本**：這個環境沒有安裝套件（沒有 `node_modules`）。因此每一項的「差異」都標明
**讀程式，沒有執行**；我核對過的標「已回頭核對原始碼」。其餘（子調查的結論）請當作有證據的推論。

## 排序：先看對資料的傷害，再看混淆，再看維護成本

| # | 概念 | 傷害類型 | 資料會動嗎 |
| --- | --- | --- | --- |
| 1 | 舊 PDF 標記只有 App 讀得到，匯出沒有 | 資料（匯出漏掉內容） | 要搬（遷移） |
| 4 | 任務行的「字」編輯器與伺服器不同（**已在真機上發生**） | 資料（筆記行被悄悄當成任務）／混淆 | 不動 |
| 2 | 「空白筆記」有五套規則 | 資料（備份留下／網站不發布不一致） | 不動 |
| 9 | 標籤名稱長度只在一條路上檢查 | 資料（超長名稱可進來） | 不動 |
| 10 | 「這個節點是任務」三個判斷 | 資料（備份算法不同） | 不動 |
| 3 | RSS「已看」有兩處，清理只看一處（只影響明確標成「未看」的文章） | 資料（留著之後看的文章內文被清掉；是否有入口未確認） | 不動 |
| 5 | 離線搜尋與線上搜尋對運算子的答案相反 | 混淆 | 不動 |
| 6 | 日曆檢視與「今天」對「一天從幾點開始」看法不同 | 混淆 | 不動 |
| 7 | 白板分頁「有沒有」前後端不同 | 混淆 | 不動 |
| 8 | 兩個標題選單不用共同的比對規則 | 混淆 | 不動 |
| 11 | 標籤名稱的大小寫與 Unicode 規則有四種 | 混淆／維護 | 不動 |
| 12 | 同名後綴（`-2`、`-<六碼>`、`(2)`）的規則有五種 | 混淆／維護 | 不動 |
| 13 | 標題排序用了三種字典序 | 混淆 | 不動 |
| 14 | 標籤「不顯示」有三個定義 | 混淆 | 視做法 |
| 15 | 復原：撤銷的堆疊分散 | 混淆 | 不動 |
| 16 | 到期提醒：App 內與推播規則不同 | 混淆 | 不動 |
| 17 | 線上寫入的重試鑰匙有三種做法 | 低（重複套用風險小） | 不動 |
| 18 | 視圖分頁順序是整數，筆記用分數鍵 | 維護 | 要搬（遷移） |
| 19 | `hidden` 一欄兩種意思 | 維護 | 要搬（遷移） |
| 20 | AI 找筆記是第三套詞法比對 | 低（可能是故意） | 不動 |

表裡的 # 是項目編號，**不是名次**；表的列序才是建議的先後。第 4 項已有真機證據，排在最前面一組。

下面每一項：概念；做法 A／B（檔案與函式）；一個具體差異；使用者會注意到什麼；該由誰擁有、刪掉什麼；大小；有沒有人在處理。

### 1. 舊 PDF 標記：App 讀，匯出不讀

- **概念**：畫在 PDF 頁面上的螢光筆、筆跡、形狀。
- **A（App）**：`frontend/src/lib/pdf/pageUnits.ts` 的 `readPdfInk(ink_data, pdf_annotations)` 載入時把舊屬性 `pdf_annotations` 併進來。
- **B（匯出）**：`backend/src/services/exportInk.ts` 的 `noteInkFiles` 對 PDF 只讀 `ink_data`（`decodeInk`＋`currentUnits`），不讀 `pdf_annotations`。
  另外 `agentTools/getNode.ts`、`exportZip.ts` 把它當資料屬性略過。沒找到把舊資料搬進 `ink_data` 的遷移。
- **差異**：只有 `pdf_annotations`、`ink_data` 為空的舊 PDF 筆記。App 顯示標記；匯出的頁面 SVG 沒有。已回頭核對原始碼（`exportInk.ts` 的 PDF 分支只用 `ink_data`），沒有執行。
- **使用者會注意到**：匯出（或備份後的圖片）少了標記，App 裡卻看得到。
- **誰擁有**：`ink_data`。一次性伺服器遷移把 `pdf_annotations` 併入，再刪掉 `readPdfInk` 的第二個參數與同步延後的讀取路徑。
- **大小**：1 個遷移（**使用者資料會動，需要業主同意**）＋約 6 個檔案。
- **別人在做嗎**：開放 PR 裡沒有直接對應；#1776（note_pages 格式）與 #1783（手寫合併）在同一區，建議先看它們的走向。
- **相關、不算雙套**：PDF 的 `ink_data` 同時存 `units` 與舊的 `pages`＋`annotations`，用 `unitsFrom` 指紋保持一致，這是故意的相容，只要讀的人走 `currentUnits` 就沒問題；沒有找到只讀舊欄位的後端讀者。

### 2. 「這是空白筆記」有五套規則

- **概念**：一則什麼都沒有的筆記。它決定要不要發布、要不要匯出／備份、能不能被「清除空白筆記」、能不能從區塊變回去。
- **做法**：
  - 發布：`modules/website/publishing/publishedSet.ts` 的 `BLANK_SQL`（文字無 `\S`、沒有未刪除子節點、沒有非 `_` 開頭的屬性；不看標籤、不看連結）。
  - 清除空白：`services/history/activity.ts` 的內嵌 `blank`（再要求標題是預設名或日期、子節點不分刪除與否都算、只限 `content`）。
  - 匯出／備份：`services/exportZip.ts` 的 `EMPTY_DAY_NOTE_SQL`（只管日記；`btrim` 只去空格不去換行；有標籤、有連結、有任何屬性〔含 `_`〕都不算空）。
  - 區塊搬成子筆記：`services/blockChildNote.ts` 的「有屬性」判斷。
  - 前端：`hooks/useNodeCreation.ts` 的 `isBlankNote`（只看文字，不看屬性、子節點、標籤）。
- **差異**：標題 `2026-11-17`、內文只有一個換行、掛一個標籤。發布判它是空白（換行沒有 `\S`，標籤不算）而不發布；匯出判它不是空日記而保留。已回頭核對 `BLANK_SQL` 與 `EMPTY_DAY_NOTE_SQL` 原文，沒有執行。
- **使用者會注意到**：自己覺得是空的筆記，備份帶走、被提示可清除、卻又悄悄沒有發布（或相反）。
- **誰擁有**：一個共用的「空白」判斷，放在 `spine/` 的 `nodeSql.ts` 旁，帶「日記」「標題是預設名」兩個變體選項；刪掉 `BLANK_SQL`、`activity.ts` 的內嵌複本與 `EMPTY_DAY_NOTE_SQL` 的核心。
- **大小**：3 個後端檔、0 張表、資料不動；邊緣行為（只有換行的內文）會變，需要業主決定哪邊對。
- **別人在做嗎**：沒有找到。

### 3. RSS「已看」兩處，清理只看一處（只影響明確標成「未看」的文章）

- **概念**：一則 RSS 文章看過了／被略過了。
- **A**：每人一列 `rss_seen(staging_id, actor_id, seen)`，`modules/rss/staging.ts` 的 `markSeen`。
- **B**：全域 `rss_staging.seen_at`，只有空間有 `shared_seen` 能力時由 `markSeen` 寫，加上 `fetch.ts` 的「老化」掃描也會寫。
  讀的地方都走 `modules/rss/items.ts` 的 `seenSql`（兩者合併）；但 `fetch.ts` 的清除內文那段只看 `s.seen_at`。
- **差異**：不在共用已看的空間，甲**明確把一則文章標成「未看」**（`rss_seen.seen=false`）。超過老化天數後掃描仍寫入 `seen_at`，再過一段時間內文被清空（`tombstoned_at`），文章從清單消失。
  甲「留著之後看」的意思沒有被尊重。
- **業主審查更正（2026-11-17）**：初稿寫的「未讀數裡有一則點不開」不成立：`subscriptions.ts` 的未讀數與 `itemList.ts` 的清單都有 `tombstoned_at IS NULL`，被清空的文章不會算進未讀也不會列出。
  「或從沒碰」那半句也不成立：沒有 `rss_seen` 列時，`seenSql` 的 `COALESCE` 落到 `seen_at IS NOT NULL`，老化後它就是已看（這是對的）。
  已回頭核對上述兩個過濾條件的原文；清理那段 SQL 也核對過。**介面上有沒有「標成未看」的入口沒有確認**；沒有的話，這項只是潛在問題。
- **使用者會注意到**：明確標成未看、打算之後再讀的文章，過一陣子不見了。
- **誰擁有**：RSS 模組的一個「還有人要這則嗎」判斷；清理要把 `rss_seen.seen=false` 當作保留。
- **大小**：1 句 SQL，0 張表，資料不動。
- **別人在做嗎**：沒有找到。

### 4. 任務行的「字」：編輯器與伺服器不同（已在真機上發生）

- **概念**：`- [ ] 買牛奶 {task}` 是任務行。
- **A（伺服器）**：`backend/src/modules/tasks/seam.ts` 的 `lineWords()`：任務模組標籤現在的名字，**加上**保留字 `task`（除非使用者有自己的 `task` 標籤）；模組關閉時沒有任何行是任務（`linesAreTasks`＝`tasksOn`）。由 `services/blockNodes.ts` 使用。
- **B（編輯器）**：`frontend/src/modules/index.ts` 的 `moduleLineWord()` 只回**一個字**：有模組標籤時就是那個標籤的現名，不看模組開關；`lib/editorBlocks.ts` 的 `blockTaskTagName` 用它決定任務圖示、自動方框與退格規則。
- **真機證據（業主提供，2026-11-17，平板、正式站、測試空間）**：在筆記裡自己打 `- [ ] 週五前讀完第 9 章 {task}`。編輯器把 `{task}` 當普通文字，沒有任務圖示；歷史檢視裡那一行的 `{task}` 被隱藏。
  之後同一則筆記的「功能」面板任務數從 1 變成 2，任務頁「今天／接下來」的數字也多了一件：伺服器把那一行當成任務。
  這個現象**不需要先把任務標籤改名**。
- **差異（修正前提）**：只要前端認的字不是 `task`，就會分歧。初稿的例子是標籤改名成「待辦」；真機的例子顯然更一般。
  **前端為什麼在沒有改名時不認 `{task}`，我沒有追到原因，也沒有執行**。讀程式能看到的可能性：`moduleLineWord` 在有模組標籤時回傳它的現名（工作區的任務模組標籤若不叫 `task`，例如有一個舊的普通 `task` 標籤在先、模組標籤叫「任務」），或標籤列表尚未載入時走另一條。這只是推測，需要用真機工作區的標籤資料確認。
  **更新（業主 2026-11-19 審查）**：編輯器為什麼不認 `{task}` 的原因已由 #1851 查出，請以 #1851 為準；這裡的推測不再需要追。
  反向（模組關閉時編輯器仍畫圖示、伺服器不建任務）已回頭核對兩邊原文，沒有執行。
- **使用者會注意到**：看起來像普通文字的行卻跑進任務頁（數字悄悄變多）；或看起來是任務卻沒有。
- **誰擁有**：伺服器的字集合。由啟動資料帶 `lineWords`／`linesAreTasks` 給編輯器，刪掉前端 `moduleLineWord` 與 `ALT_LINE_WORD`。
- **大小**：約 3 個前端檔＋1 個回傳欄位，資料不動（但已被悄悄建立的任務不會自己消失）。
- **別人在做嗎**：#1828（任務頁列出筆記裡還沒變成任務的核取方塊）是提案、同一區；不是同一件事。與「段落尾的 `{…}` 七處」那條已知線同族。

### 5. 離線搜尋與線上搜尋對運算子的答案相反

- **概念**：查詢語法（`-排除`、`a OR b`、`"片語"`）本應由 `@onden/markdown` 的 `parseSearchQuery` 一家管。
- **A（伺服器）**：`backend/src/services/textSearch.ts`（pgroonga 或可攜引擎的 `parsePortableQuery`）懂 OR 與 `-`。
- **B（本機）**：`frontend/src/lib/localDbWorker.ts` 的 `searchTitlesAndBodies`：FTS 路徑把每個空白分隔的詞包成 `"詞"*`；`-streams` 變成必須有 `streams` 開頭的字，`OR` 變成必須有 `or` 開頭的字。
  LIKE 備援走 `queryTerms`（`markdown/src/snippet.ts`），`-x` 與 `OR` 直接被丟掉。
- **差異**：查 `kafka -streams`，甲「kafka streams」、乙「kafka only」。線上：只有乙。離線（FTS）：必須同時有 kafka 與 streams，只有甲；FTS 沒結果才退到 LIKE，兩則都回。`a OR b` 離線變成要有 `or` 開頭的字（會中 order）。已回頭核對 FTS 路徑原文；FTS5 分詞設定沒有讀，**讀程式，沒有執行**。
- **使用者會注意到**：網路一斷，同一個查詢出現不同的筆記，排除詞失效。
- **誰擁有**：一個「查詢→比對器」編譯器，伺服器與本機共用（輸出 SQL 與 FTS 字串）。
- **大小**：`localDbWorker.ts`、`markdown/searchQuery`、`textSearch.ts`；本機 FTS 表會重建，資料不動。
- **別人在做嗎**：#1786（一個字也由伺服器回答、離線時提醒結果可能不完整）處理的是已知的「一字／兩字」那條，沒有碰運算子。
- **附帶**：可攜引擎用 ILIKE 不折疊全形與重音，pgroonga 會折疊全形，`frontend/src/lib/noteSearch.ts` 的註解說伺服器折疊；`docs/architecture/portable-backend.md` 可能已記錄，我沒有讀。

### 6. 「一天從幾點開始」：日曆檢視與「今天」看法不同

- **概念**：一個時間點屬於哪一天。工作區日＝區內時間減去 `day_start_hour`（0–6）。
- **A**：`backend/src/localDay.ts` 的 `localDayId`、`sqlLocalDate`；`frontend/src/lib/localDate.ts` 的 `dateIdAt`、`todayId`，都套用起始小時。
- **B**：`packages/markdown/src/attributeValue.ts` 的 `calendarDayOf`／`dayInZone` 只吃時區，沒有起始小時。
  呼叫者：`frontend/src/components/viewLayoutKit/calendarGrid.ts` 的 `bucketRowsByDay`（日曆檢視，含建立／更新時間欄）、`modules/tasks/noteFunctionRows.ts`（任務期限）。
- **差異**：時區 Asia/Taipei、起始小時 4，時間點 `2026-10-14T19:30Z`（台北 10-15 03:30）。日子時間線、今天、議程：屬於 10-14。日曆檢視：放在 10-15。已回頭核對兩邊原文，算術推論，沒有執行。
- **使用者會注意到**：同一則筆記在日曆檢視與「今天」被放在不同的日子。
- **誰擁有**：`localDate.ts`／`localDay.ts`。`calendarDayOf` 要多收起始小時（markdown 是純函式，由呼叫端傳入）。
- **大小**：1 個函式、2 個呼叫端；若後端 `collectionViewQuery.ts` 的日曆欄在 SQL 分日，也要看。資料不動。
- **別人在做嗎**：沒有找到。

### 7. 白板分頁「有沒有」：前後端不同

- **A（前端）**：`frontend/src/lib/viewTabs.ts` 的 `showsWhiteboard = canvasImported && (stored ? !isWhiteboardHidden(stored) : earnsWhiteboard)`，看模組有沒有開，用陣列順序取第一筆紀錄。
- **B（後端）**：`backend/src/services/boardStore.ts` 的 `whiteboardShownSql`，不看模組，取 `ORDER BY created_at, id` 的第一筆紀錄；用於 `canvasMemberships.ts`、`exportLeftOut.ts`。
- **差異**：白板模組關閉，筆記有卡片、紀錄沒被標隱藏。前端：沒有分頁。後端：「出現在白板上」仍列出它、匯出的略過摘要仍算一塊白板。已回頭核對兩邊原文，沒有執行。註解寫「同一個規則」，模組開關讓它不再相同。
- **誰擁有**：一邊。最小做法是讓後端 SQL 也看模組開關，或前端 `canvasImported` 不參與。
- **大小**：1 個 SQL 片段或一個參數。資料不動。
- **別人在做嗎**：#1767（內容分頁可以移除）在同一區，不是同一件事。

### 8. 兩個標題選單不用「一個選單規則」

- **概念**：打字比對筆記標題。`frontend/src/lib/noteSearch.ts` 自稱「每個選單一個規則」（NFKC、去重音、小寫），約 15 處使用，包含 `[[`、`/`、⌘K、側欄。
- **例外**：`modules/tasks/TaskSheet.tsx` 的 `n.title.toLowerCase().includes(q)`；`hooks/useGraphLayout.ts` 白板搜尋（標題與內文）；`lib/tagSuggestions.ts` 的 `offersTag`（標籤名）。
- **差異**：查 `cafe`、標題 `Café`（或全形 `ａ１` 對 `A1`）。`[[` 與 ⌘K：找得到。任務表單「連到筆記」：找不到。白板搜尋：把 `Café` 淡掉。已回頭核對 `TaskSheet` 與 `useGraphLayout` 原文，沒有執行。
- **誰擁有**：`matchTitle`／`containsTitle`；刪掉兩段手寫過濾。`offersTag` 的隱藏標籤精確比對規則不動。
- **大小**：3 個前端檔，資料不動。
- **別人在做嗎**：沒有找到。與「一字／兩字搜尋走不同引擎」同族但不同處。

### 9. 標籤名稱長度只在一條路上檢查

- **A**：`TAG_NAME_MAX = 200`（`markdown/src/sharedContract.ts`）只在 `routes/tags.ts` 的 `tagNameLength`（建立與改名）、`routes/workspace.ts` 的 `tag_name`（業主審查補，已核對）、`agentTools/proposeTagPack.ts`、側欄改名輸入框。
- **B**：`PATCH /api/nodes/:id` 改標籤節點的標題，走 `services/nodeUpdate.ts` 的 `tagRename`→`writeTagIdentity`，只檢查 `isTagNameShape`（非空、無首尾空白、無禁字），**沒有長度**。節點標題上限是 `NODE_TITLE_MAX`（500，據註解，未重讀）。
- **差異**：把標籤改成 300 字。經 `/api/tags/:id`：400。經 `/api/nodes/:id`：接受。`routes/tags.ts` 有、`nodeUpdate.ts` 與 `tagIdentity.ts` 沒有 `TAG_NAME_MAX`，已回頭核對；是否真的存入沒有執行。筆記裡 `{300 字}` 也會因 `isTagNameShape` 被當標籤。
- **誰擁有**：`isTagNameShape` 加長度（它已被 `{…}` 讀者共用），一處修三條路。
- **大小**：1 個函式；要先查現有超長標籤（舊名字仍要能載入，沿用「只檢查新的」那條）。資料不動。
- **別人在做嗎**：沒有找到。與已知的「標籤名稱規則後端與括號不同」同族。

### 10. 「這個節點是任務」三個判斷

- **A**：`backend/src/spine/taskIdentity.ts` 的 `isTaskSql`（函式參照＋`_task_status`）；`tasksStore.ts` 的 `TASK_JOIN_SQL`、`standaloneTaskSql`、`noteDuplicate.ts` 用它。
- **B**：`hasTaskRefSql`（只要函式參照），供 `notATaskNodeSql`、`taskNodeIdsAmong`、`nodeSearch.ts` 的 `is_task`、`spaces.ts` 的垃圾桶列表。
- **C**：備份用 `hidden && 有 _task_status 屬性`，不看參照：`backupArchive.ts`、`backupRestore.ts`。
- **差異**：隱藏節點有任務參照但沒有 `_task_status`：搜尋與同步說它是任務（並從節點列表隱藏）；任務議程與獨立任務列表不顯示；備份把它當普通筆記。反過來有狀態屬性但沒參照：備份算任務，線上系統兩邊都不算。讀程式，沒有執行；沒有找到會製造這種中間狀態的路徑（`addTaskRefTx` 與還原順序沒追）。
- **誰擁有**：`taskIdentity.ts`；備份改用 `isTaskSql`，`hasTaskRefSql` 變成該檔私有。
- **大小**：約 5 個檔，不需遷移。
- **別人在做嗎**：沒有找到。

### 11. 標籤名稱：大小寫與 Unicode 有四種規則（我自己讀的）

- **資料庫唯一索引**：`content_nodes_class_tag_workspace_parent_title_uq`（遷移 039）對原始 `title` 唯一，區分大小寫、也不做 NFC。
- **改名／建立檢查**：`services/tagHierarchy.ts` 的 `liveTagIdByName`：NFC，區分大小寫。
- **筆記裡寫的名稱**：同檔 `writtenSegmentTagId` 與 `memberTagIdsNamed`：NFC＋不分大小寫；精確（NFC）命中優先，否則只有一個不分大小寫的才算，多個就當找不到。
- **同步合併顯示**：`spine/stampedMerge/rules/names.ts` 的 `resolveNameClashes`：預設 NFC、區分大小寫；`distributedSync/bridge/view.ts` 的 `tagDisplayTitles`：NFC＋小寫，兩邊都叫 `tagClashName`。
- **差異**：同一個父層下有 `Idea` 與 `idea`。伺服器兩個都准。筆記裡寫 `{idea}`：精確命中 `idea`。`{IDEA}`：兩個不分大小寫都命中，因此不指向任何一個。同步合併（stampedMerge）不算它們衝突；`bridge/view.ts` 把後建立的顯示成 `idea (2)`。讀程式，沒有執行。
- **使用者會注意到**：同一組標籤在 App 裡不被視為同名、在另一台同步後被改顯示名。
- **誰擁有**：一個 `foldTagName`（放 `sharedContract.ts`，與 `isTagNameShape` 同處）；大小寫要不要區分是**業主的決定**。
- **大小**：4 個檔；如果決定「不分大小寫」要改唯一索引，**會碰既有資料（同名不同大小寫的標籤），需要業主同意**。
- **別人在做嗎**：#1778（分散式同步 2b-2a）在碰同步端；與已知的「idea (2) 有兩處格式」同一線。

### 12. 同名後綴：五種規則（我自己讀的）

- 筆記 slug：`services/nodes.ts` 的 `uniqueSlug`，`-2`、`-3`，**同一空間內**唯一（遷移 099）。
- 已發布集合：`publishing/publishedSet.ts` 的 `uniquePublishedSlugs`，**預設空間的筆記保留**，其他得 `slug-<id 前六碼>`，仍撞再 `-2`（整個網站範圍）。
- 標籤頁網址：`publishing/siteRows.ts` 的 `tagSlugs`，`-2`。
- 同步合併：`stampedMerge/rules/names.ts` 的 `resolveSlugs`，`-2`，**整個工作區**範圍，先發布的保留網址。
- 遷移 064：`slug-<id 前八碼>`。
- **差異**：兩個空間各有筆記 `plan`。App 裡兩個都叫 `plan`；發布時預設空間那則是 `/plan`，另一則是 `/plan-3f2a1b`；同步合併則給後者 `plan-2`。註解已寫明是故意（空間內唯一、網站全域唯一），但**網址以哪個規則為準會因路徑而異**。讀程式，沒有執行。
- **誰擁有**：先決定網址由誰最終決定（建議：發布端 `uniquePublishedSlugs` 是唯一出口，同步端只顯示）。
- **大小**：視決定而定；若改網址規則，會影響已發布網址（`siteRedirects` 已有轉址機制）。
- **別人在做嗎**：與已知的「idea (2) 兩處格式」同線，沒有找到針對 slug 的 PR。
- **另記**：空間名稱**完全沒有**唯一性規則（遷移 093 只有預設空間與個人空間的唯一索引），與標籤、視圖、slug 各有規則形成對照；不算雙套，只是沒有規則。

### 13. 標題排序：三種字典序

- **擁有者**：`markdown/src/childOrder.ts` 的 `compareTitles`（`zh-Hant`），網站建置、差異、工作室等用。
- **另外**：不帶語系的 `localeCompare` 在 `components/OverviewSidebar.tsx`、`tagPage/membersModel.ts`、`tagTree.ts`、`tagSuggestions.ts`、`tagTreeModel.ts`，以及後端 `services/tagViews.ts` 的 `byPinThenName`（用伺服器的語系）與 `history/pointInTime.ts`。
- **差異**：中文＋拉丁混合的標題清單。已發布網站依 zh-Hant；側欄與標籤成員依裝置語系；視圖分頁的同序依伺服器語系。我沒有執行 `Intl` 確認兩種順序實際長什麼樣，**讀程式，沒有執行**。
- **誰擁有**：`compareTitles`。約 8 個呼叫點，資料不動。
- **別人在做嗎**：沒有找到。

### 14. 標籤「不顯示」有三個定義

- `frontend/src/lib/nodeTags.ts` 的 `isTagShown`：`!hidden && !isNoteSwitchTag`（筆記開關模組標籤永不顯示）。
- `backend/src/modules/website/publishing/redaction.ts` 的 `siteShowsTagSql`：只看 `hidden=false`，不看 `schema_module`。
- `backend/src/modules/review/service.ts` 的 `groupTagScopes`：`hidden=false AND reserved_key IS NULL`，也不看 `schema_module`。
- （每人側欄的 `sidebarTags.hidden` 是另一件事，文件寫明只影響側欄，是故意的。）
- **差異**：把一則筆記開成「技能」，模組標籤 `hidden=false` 且有 `schema_module`，再發布。App：沒有標籤、選單、建議。網站：依 SQL 判斷，標籤與標籤頁會出現。**沒有確認該標籤建立時的 `hidden` 值**，所以網站那一側是推論。
- **業主審查補充**：同族還有標籤數量：側欄的標籤數只算筆記、不算段落，所以掛在段落上的標籤顯示 0、被歸到「沒在用的標籤」，刪除前的提醒也只寫「0 篇筆記」（業主觀察，我沒有核對程式）。
- **誰擁有**：一個共用判斷，或建立時就把 `hidden` 設為真（所有讀者就一致，舊資料需要補）。
- **大小**：3 個判斷，可能 1 個寫入路徑；不一定要遷移。
- **別人在做嗎**：沒有找到。

### 15. 復原：撤銷堆疊分散

- 白板：`hooks/useBoardHistory.ts` 一條時間順序的堆疊（卡片、手寫、移除、連線）。
- PDF／手寫頁面圖層：`components/PdfNodeView.tsx`、`InkNodeView.tsx` 各自的筆跡、文字框、圖片堆疊，⌘Z 作用於哪一個要看目前的工具。
- 編輯器：CodeMirror `history()`；外部同步（版本還原會觸發）時重設。
- 版本「撤銷還原」：`NoteHistory.tsx`，以 `v.markdown === before` 找版本，找不到就拿 `fresh[1]`；不是事件復原。
- 工作區：`restoreEvent`（有契約）。
- **差異**：PDF 頁面畫一筆、加一個文字框、按 ⌘Z。筆工具：撤銷筆跡。文字工具：撤銷文字框。白板上同樣的順序永遠先撤銷最新一步。版本還原後，編輯器的 ⌘Z 沒有作用，「撤銷還原」按鈕才有。讀程式，沒有執行。
- **業主審查補充（平板上看到的）**：白板選了筆之後，下方同時有兩條工具列、各有一個「復原」。
- **是缺陷還是設計**：`useBoardHistory` 檔頭說明頁面圖層是故意分開，所以這項我**不確定該不該改**，歸在「可能是故意」。
- **大小**：大型介面改動，資料不動。

### 16. 到期提醒：App 內與推播規則不同

- **App 內**：`frontend/src/lib/dueSoonNotify.ts` 的 `dueTasks`／`pendingDueNotices`：議程 bucket 為逾期／今天、狀態不是 done／cancelled 的任務，每個（bucket、id）每台裝置通知一次；不需要提醒時間。
- **推播**：`backend/src/modules/tasks/pushReminders.ts`：只有 `status IN ('todo','doing')` 且有提醒時間（`remind_at` 或時間＋日期）的任務，走共用的 `dueReminderMoment`。
- **差異**：僅日期、今天到期、沒有提醒時間、狀態是 `waiting`（非 done 非 cancelled）。分頁開著：作業系統通知「今天到期」。App 關著：沒有推播。已發過的集合 `PREFS.dueSoonFired` 只在裝置上，手機與電腦各提醒一次。讀程式，沒有執行；bucket 的細節沒有逐行驗證。
- **誰擁有**：一個伺服器端的「值得提醒什麼」規則，前端只顯示。
- **大小**：約 3 個檔，已發過的狀態要變成帳號級（一個小偏好）。

### 17. 線上寫入的重試鑰匙：三種做法

- `lib/data/onlineWrite.ts` 的 `operation(resource…)`：每個資源一把鑰匙，其他寫入開始就作廢（檔頭註解寫明可能重複套用）。
- `sendWrite()`：呼叫者自己持鑰匙；`modules/review/ReviewPanel.tsx` 自己維護 `attempt`／`undoAttempt` 並重用至伺服器確認。
- `lib/data/blockLinkWriter.ts` 的 `bind`／`confirm`：每次呼叫新的 `randomUUID()`；`bind` 失敗悄悄回 null。
- **差異**：評分一張卡片、回應遺失、這時筆記自動存檔、再重試。走 `onlineWrite`：新鑰匙，可能重複。`ReviewPanel`：同一把鑰匙，伺服器回已處理。`blockLinkWriter.confirm` 回應遺失後重試：新鑰匙，回 `confirmed:false`，但第一次其實已套用。讀程式，沒有執行。
- **誰擁有**：`onlineWrite`；把複習評分／撤銷／暫停遷過去，刪掉 `attempt` 參照。
- **大小**：約 3 個檔，資料不動；影響低。

### 18. 視圖分頁順序：整數 vs 分數鍵

- 筆記與指標：`order_key`＋`order_stamp`＋id，擁有者 `services/orderKeys.ts`（有守門測試）。
- 存好的視圖與分頁：整數 `pin_order`，每次移動重編（`lib/viewTabs.ts`、`useViewTabActions.ts`），同序以名稱（`tagViews.ts` 的 `byPinThenName`）；側欄釘選的標籤又是第三種（陣列位置）。
- **差異**：兩台裝置在 2 個分頁時各新增一個視圖，都寫 `pin_order: 2`。筆記的同序以 `order_stamp` 再 id 決定；分頁的同序以名稱，順序會因名字而翻動，而且移動一個分頁會改寫多個分頁的 `pin_order`，兩台裝置交錯。讀程式，沒有執行。
- **誰擁有**：`orderKeys`；視圖表要加 `order_key` 或改欄。
- **大小**：視圖相關表、**遷移會動使用者資料**、前端；中高。
- **別人在做嗎**：#1816（三宿主對照：位置欄位改比「順序」）在處理另一端的比較，不是這件事。

### 19. `hidden` 一欄兩種意思

- 擁有者隱藏標籤（D104；`routes/nodes.ts`、`nodeUpdate.ts` 拒絕隱藏非標籤）；獨立任務列與網站設定列也是 `hidden`。
- 只測 `hidden=false` 的讀者（`PAGE_SQL`、`collectionViewQuery`、`dayNotes` 與約 15 處）分不出兩者；備份用 `hidden && 狀態屬性` 反推任務（見第 10 項）。
- **差異**：`publishedSet.ts` 的 `leftOutNotes` 對任何被標「發布」的隱藏列回報原因 `hidden`，包含機器列，等於告訴擁有者有東西被隱藏，而他們從沒隱藏過。這是推測，沒有核對。
- **誰擁有**：另開旗標或用 `source_type` 標機器列。
- **大小**：約 20 個檔＋**遷移會動使用者資料（備份格式）**；成本高，只記錄。

### 20. AI 找筆記是第三套詞法比對

- `backend/src/services/harness/scope.ts` 的 `retrievalTerms`＋`ILIKE ANY`：5 字以上的字、CJK 二連字、最多 10 個詞、OR、依命中數排序。主搜尋 `nodeSearch.ts` 是 AND，下限 2 字（`routes/nodes.ts`）。
- **差異**：問題「Rust 所有權」。AI：詞是「所有」「有權」（`Rust` 因不到 5 字被丟掉），任一命中。搜尋：`Rust` AND `所有權`。
- **判斷**：自然語言問句需要鬆一點，可能是故意；列為「引用與搜尋結果可能不同」的提醒，不建議合併。

## 已經是一個機制（查過，沒問題）

- **摘錄／指向**：`[[筆記/段落]]` 的讀法是 `markdown/src/blockLink.ts` 一份，編輯器、閱讀、反向連結、網站、匯出預覽共用；區塊找不到時的歸屬 `blockHome.ts`／`blockRef.ts` 一份；「誰引用這段」`blockCitations.ts` 一份；以 id 指節點 `nodeRef.ts`（`onden://node/`）一份。
- **已定案的摘錄格式**：`markdown/src/excerpt.ts`（已知的 RSS／PDF 同一份）。
- **讀取權限**：`services/readPolicy.ts`＋`spine/spaceScope.ts`；`nodeSearch.ts`、agent 的 `searchNodes`、`semanticSearchNodes`、匯出與備份（`vaultIndex`）、`harness/scope.ts`、發布（`publiclyReadableNodeIds`）、RSS 與任務模組、`noteDuplicate` 都走它。外部 AI 閘門在 `harness/scope.ts`、`noteSkills.ts`、`agentRuntime/api/limits.ts` 另加一層，是故意的。
- **本機偏好**：`lib/prefs.ts`／`lib/sessionPrefs.ts`；帳號偏好 `createAccountPref`；`settings/legacyPrefs.ts` 是唯讀的故意後備。
- **前端寫伺服器**：`lib/data` 之外沒有直接 `fetch`／POST；保存狀態文字只有 `components/SyncStatus.tsx`；失敗通知 `writeErrors.ts`；提示與更新紀錄的「已看」是帳號偏好。
- **手寫頁面鍵**：`pdf:<n>`、`page`、`<uuid>` 共用於 `page_text`、`page_images`、`ink_data`。
- **同層順序（筆記）**：`markdown/src/childOrder.ts`、`orderKey.ts`、`services/orderKeys.ts`；`sort_order` 已凍結。
  輕微漂移：`siteDiff.ts` 的 `readerSite` 自己再排一次，混有鍵與無鍵的列時（舊快照）規則略不同。
- **軟刪除**：`liveNodeSql`／`LISTED_NODE_SQL`；其餘 `deleted_at IS NULL` 都在非節點表。
- **已發布集合**與「留在網站外」：`publishedNodeIds`、`KEPT_OFF_SQL`＋屬性旗標，`leftOutNotes` 與它同一個判斷。
- **筆記長度**：`noteLimits.ts`（UTF-16 單位，`cutToUnits` 不切斷字元）；`SLUG_MAX` 以字元計是故意的。
- **「今天」**：後端 `localDay.ts`、前端 `localDate.ts`；搜尋 `getFullYear`、`getDate`、`CURRENT_DATE`、`toISOString().slice(0,10)` 只在 `markdown/src/calendar.ts`（純算術）。第 6 項是「分日」不是「今天」。
- **匯出對 `_` 開頭屬性與手寫**：`isPersonAuthored`（`spine/attributeSource.ts`）匯出與複製共用；匯出把 `ink_data` 等拿出 frontmatter、改寫成圖，備份保留，複製會建立手寫分頁，各有文件說明。
- **SKILL.md 檔名** 只收 ASCII，是規格要求，不算與 `slugify` 雙套。
- **搜尋退路順序**：`lib/data/noteSearch.ts` 一個入口（側欄、⌘K、`((`、`[[`）。

## 無法判斷

- 五個「新東西放哪裡」偏好：`quickCaptureTarget`（只在裝置上）、`captureDestinationCopy`（同步）、`rssQuoteTarget`、`quickAddTaskSpace`、`dayNoteParent`。對使用者可能是一件事、存在兩處；我沒有讀介面，不敢說。
- 區塊搬成子筆記：複習排程是**複製**（來源列保持隱藏），任務身分是**跟著走**（`keepIdentity`）。兩種「身分跟著段落」的規則；我沒有看使用者事後看到什麼。
- 標籤頁成員檢視的「手動順序」：鍵在每個父層內才有意義，跨父層時順序是任意的；是否有意義沒判斷。
- 標籤頁的「隱藏」按鈕：`useTagHide` 顯示 `hidden: !isTagShown(tag)`，筆記開關標籤會顯示成「隱藏」卻切換不了；與第 14 項相關。
- `githubBackup.ts`、`backupSystemAttrs.ts`、Notion 與 CSV 匯入器對 `_` 屬性／標籤／連結的處理是否與 `backupArchive`、`exportZip` 一致：沒有讀。
- 前端 `useNoteExport` 與 `export-preview`；`routes/query.ts` 與視圖篩選對照 `nodeSearch`：沒有開。
- 筆記內「尋找」用 CodeMirror 自己的比對（不折疊重音與全形），所以 `cafe` 在列表找得到 `Café`、在打開的筆記裡找不到；可能是故意。
- 語意連結建議 `suggestLinksForNode` 用 `readableNodeIdSet`（id 陣列）而 `semanticSearchNodes` 用 `readableScopeSql`＋`NOT_SYSTEM_NODE_SQL`：可讀規則文件說等價，只是飄移風險，沒有顯示今天有差異。
- 吐司措辭（約 211 個 `addToast` 呼叫點）、技能名稱上限（對話框 200、模型看到 60；`load_skill` 是否以截斷名稱查找沒查）、RSS 靜音關鍵字的前端上限：沒有比較。
- 後端 `outbox.ts` 與 RSS／捕捉離線路徑：沒有找到第二個佇列，但只粗看。

## 已有人在做（開放 PR，查自 GitHub，2026-11-17）

- #1777 PDF 筆記與檔案入口一份定義、#1786 一個字也由伺服器回答、#1794 晚到的同步回應改用事件位置（刪掉時間規則）：都是這次已知例子的修法，不重複。
- #1776（note_pages 格式）、#1783（手寫合併）、#1767（內容分頁可移除）、#1577（手寫分頁引用區域）：與第 1、7、15 項同一區，動手前請對照。
- #1778（分散式同步 2b-2a）：與第 11、12 項同線。
- #1816（三宿主對照位置欄位）：與第 18 項鄰近。
- #1800（臨時工作階段，先清查沒有被空間限制的讀取）：與權限家族相關；本次沒有找到繞過 `readPolicy` 的讀者，與該 PR 清查的結果可互相核對。

## 當時的建議（寫作當天的看法，由業主決定）

**兩個順序各代表什麼**：上面表格的列序是「對資料的傷害」由大到小（再看混淆、維護成本）；這一節的順序是「一批做得完、資料不動、擁有者明確」的容易程度，所以兩邊不同（例如第 10 項傷害較大但需要先決定備份怎麼算，沒有排進這一批）。

最容易、傷害最小、一批做完：**第 4（真機已發生，建議最先）、2、8、9、7**（各 1–3 個檔，資料不動，各自有明確的唯一擁有者）。
**第 1、11（若要改索引）、18、19** 都要搬使用者資料，須業主同意後再排。
**第 5** 影響日常使用，但需要設計取捨（共用查詢編譯器），建議先寫兩份設計草圖；第 4 的方向（伺服器的字集合帶給編輯器）已經清楚，先查出前端不認 `{task}` 的原因再動手。
