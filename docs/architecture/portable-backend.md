# 可攜後端：同一套 Hono 後端放進別的環境

> 狀態：現行（最後確認 2026-11-01）。第 1 批（地基）已實作並測試。承接實驗 PR #1140（`docs/research/browser-trial/`）。
> 第 2 批（瀏覽器 App 本體）已實作：見 [browser-app.md](browser-app.md) 與本文 §8。第 3 批（PR 預覽網址＋WebKit／iOS 測試）與桌面 App（PR #1133）共用這一批。
> 正式伺服器行為不變：預設仍是真 Postgres（`pg` Pool）＋pgroonga＋`AsyncLocalStorage`＋`node:*`。
> 涵蓋：packages/backend/src/app.ts, packages/backend/src/server.ts, packages/backend/src/db.ts, packages/backend/src/dbPglite.ts, packages/backend/src/requestContext.ts, packages/backend/src/services/textSearch.ts, packages/backend/src/dbKysely.ts

## 1. 怎麼拆（已實作）

| 責任 | 入口（catalog） | 說明 |
| --- | --- | --- |
| 組裝 | `src/app.ts`（`be-app`） | 只組路由與中介層：沒有 top-level await、不監聽埠、不跑遷移與背景工作。任何環境都能 import。守門：`guards/portableBackend.guard.test.ts`。 |
| Node 開機 | `src/server.ts` | 遷移、背景工作、`serve()`。`npm start`／`dev`、Dockerfile、persona 腳本改指它；測試改 import `app.ts`。 |
| 資料庫 | `src/db.ts`＋`src/dbPglite.ts`（`be-db`） | `db.ts` 仍是唯一 import `pg` 的檔（守門規則 `be-pg-driver`）。`ONDEN_DB_DRIVER=pglite` 時 `pool` 換成 `PglitePool`；`q()`、`withTransaction`、`withSavepoint`、`withReadSnapshot` 不變。 |
| 跨實例鎖 | `db.ts` `withLeaderLock` | 原本 `backgroundJobs`、`outbox`、`tasks/scheduler` 各寫一份「pool.connect＋pg_try_advisory_lock」，收成一個。PGlite 只有一個程序，直接執行。 |
| 遷移來源 | `src/dbMigrations.ts`（`be-migration-source`） | 預設讀 `db/migrations`；沒有檔案系統的環境用 `useMigrationSource()` 注入。`portableMigrationSql` 拿掉 PGlite 沒有的 `age`、`pgroonga`、`pg_stat_statements`，其餘 SQL 與正式版逐字相同。 |
| 請求上下文 | `src/requestContext.ts`（`be-request-context`） | 見 §3。 |
| Node 內建模組 | `src/nodeBuiltins.ts`（`be-node-builtin`） | `process.getBuiltinModule` 呼叫時才找；瀏覽器打包不必 alias。 |
| 搜尋 | `src/services/textSearch.ts`（`be-text-search`） | 見 §4。 |

### 1.1 PGlite 單一連線（§ 實驗發現的死結）

PGlite 只有一條連線，而後端假設「握著交易的 client 之外，另有連線可以 `pool.query`」。`dbPglite.ts` 兩條規則：

1. `connect()` 是 FIFO 互斥鎖：誰握著 client，誰就獨佔資料庫直到 `release()`；兩個請求的交易不會交錯。等待者有逾時（預設 10 秒，同 `PG_CONNECT_TIMEOUT_MS`），錯誤訊息與 `pg` 相同；放棄等待的人不會讓鎖卡住。
2. 在交易裡呼叫 `pool.query()`（`db.ts` 的交易 context 回答「現在在哪個交易」）就用該交易的 client。例如 `blobs.putBlob` 原本刻意走另一條連線，現在跟著交易提交或回滾；它以內容雜湊為鍵、冪等，無影響。其餘約 160 處 `pool.query` 在 PGlite 上同理：**語意差異**是「原本會先於交易提交」的寫入現在跟著交易；整合測試在 PGlite 上全跑過（§6）。

3. `end()` 之後，`query()`／`connect()`／`database()`（含已取得的 client）一律拒絕，與 `pg` 的 `Cannot use a pool after calling end on the pool` 同義；以前會悄悄開第二個資料庫（`memory://` 是空的）。重新開始必須是新的 `PglitePool`，產品裡沒有這條路（桌面關閉、`admin.ts`、建置腳本都是 `end()` 後離開）。 **界線**：這只保護「有呼叫 `end()`」的關閉；瀏覽器版的 worker 從不 `end()`，被瀏覽器終止（分頁關閉、bfcache 淘汰）時沒有任何事件，「結束後丟錯」不涵蓋那條路（那是存檔與 #1877 處理的另一類）。建置腳本（`prepareSnapshot.ts`、`makeOldCopy.ts`）在傾印前 `awaitAllDispatchers()`，結束走 `pool.end()`（先排空），不直接 `pglite.end()`。

另外對齊 `pg` 的行為：`bigint`／`numeric` 回字串（事件游標、`parseBigintId` 依賴）；沒有參數的字串走簡單協定（可含多個語句，遷移檔需要）；對已中止的交易 `COMMIT` 回 `command: "ROLLBACK"`（`db.ts` 因此把它判為失敗，不是成功）。

### 1.2 Node 專屬清單與處理狀態

「已收」＝已在 catalog 入口後面，瀏覽器版只要換入口實作；「第 2 批」＝瀏覽器版要處理（處理結果見 §8 與 browser-app.md）。

| 項目 | 狀態 |
| --- | --- |
| `pg` 連線池 | **已收**：`db.ts`（守門 `be-pg-driver`），底下可換 PGlite。 |
| `node:async_hooks` `AsyncLocalStorage`（7 處） | **已收**：`requestContext.ts`（守門 `be-async-hooks`）。better-auth 自己另有一份 ALS（`@better-auth/core/async_hooks`）：第 2 批打包時 alias 到同一個串行堆疊替身（`browser-shims/asyncHooks.mjs`），因為它的 browser 條件用單一全域變數、兩個請求同時會互相覆蓋。 |
| `node:fs` 讀遷移檔 | **已收**：`dbMigrations.ts` 的 `useMigrationSource`。 |
| 開機段（top-level await、`serve()`、背景工作） | **已收**：`server.ts`。 |
| 定時工作／advisory lock | **已收**：`backgroundJobs.ts` 的 `startPeriodicJob` ＋ `withLeaderLock`；PGlite 不搶鎖。第 2 批的決定：只啟動工作區時鐘、dispatcher catch-up、任務模組的排程，且每一次都經 worker 的佇列（`useJobRunner`）；outbox、RSS、推播提醒、外部行事曆、事件修剪不啟動。 |
| pgroonga 搜尋 | **已收**：`services/textSearch.ts`，資料庫有就用，沒有用可攜版。 |
| `node:fs` 媒體儲存（`services/mediaStore.ts`、`media.ts`、`MEDIA_DIR`） | **已收（第 4 批）**：全部經 `services/mediaFiles.ts` 的 `MediaFiles` 接口（`mediaFiles()`／`useMediaFiles()`；伺服器預設是磁碟，瀏覽器版是 OPFS／IndexedDB）。第 2 批曾關閉上傳，理由與後來的做法見 browser-app.md §6、§14。 |
| `node:fs` 其他（`auth.ts` 密鑰檔 `content/.auth-secret`、`git.ts`、備份暫存、匯出） | **第 2 批已處理**：auth 密鑰每次啟動隨機產生（本機登入每次重簽，不必存）；`git.ts`、備份暫存不提供；匯出改走 fflate。 |
| `node:crypto`（約 37 檔：`randomUUID`、`createHash`、AES 一處） | **第 2 批已處理**：`browser-shims/crypto.mjs`（`@noble/hashes` 同步 SHA-256；WebCrypto 是非同步的，`sha256Hex` 是同步呼叫）。AES（API 金鑰加密）試用版不提供。 |
| `Buffer`、`node:path`、`node:url`、`node:events`、`node:util` | **第 2 批已處理**：`buffer`、`path-browserify`、`events`、小型 `url`／`util` 替身（`isDeepStrictEqual` 為結構比較）。 |
| `node:stream`、`archiver`、`yauzl`、`zlib`（備份 zip） | **第 2 批已處理**：`archiver` 以 fflate 實作（`browser-shims/archiver.mjs`），完整備份與匯出在 worker 內可用；`yauzl`（還原上傳）**第 3 批已提供**：`browser-shims/vfs.mjs`（記憶體檔案系統，`node:fs`、`fs/promises` 的替身）、`yauzl.mjs`（fflate 讀 zip）、`stream.cjs` 補了 `Readable.fromWeb`、`Transform`、`pipeline`；後端服務碼沒改，見 browser-app.md §12.3。媒體檔仍不保存。 |
| `sharp`（原生模組，圖片縮圖） | **已收（第 4 批）**：`services/imageCodec.ts` 的 `imageCodec()`／`useImageCodec()`；伺服器預設 sharp，瀏覽器版用 `createImageBitmap`＋`OffscreenCanvas`（browser-app.md §14.4）。 |
| `safeFetch.ts`（`node:http/dns/net`）、RSS、頁面中繼資料 | 瀏覽器版不提供（CORS、SSRF 防護依賴 DNS）。 |
| `simple-git`、`@octokit`、`web-push`、`pagefind` | 瀏覽器版不提供（路由層回 404＋白話說明）。 |
| MCP 伺服器（`@modelcontextprotocol/sdk`） | 瀏覽器版不提供。 |
| SSE 即時通知（`routes/events.ts`） | **第 2 批已處理**：頁面的 `EventSource` 替身經橋讀串流（worker 在佇列外轉發記憶體內的通知）；試用版只允許一個分頁（Web Locks），沒有用 `BroadcastChannel`。 |
| 瀏覽器禁止的標頭（`cookie`、`origin`、`set-cookie`） | **第 2 批已處理**：`localSession.ts` 用 Proxy 換掉 `headers`（含 session cookie 與 `origin`）。 |

## 2. 資料庫選擇與設定

| 設定 | 意義 |
| --- | --- |
| `ONDEN_DB_DRIVER=pglite` | 用 PGlite（預設真 Postgres）。 |
| `ONDEN_PGLITE_DIR` | PGlite 資料位置；預設 `memory://`（Node 可給資料夾，瀏覽器的 `idb://`、`opfs-ahp://` 由第 2 批的開機檔給）。 |
| `ONDEN_PGLITE_SNAPSHOT` | `dumpDataDir()` 產生的 tar：第一次開啟從它還原，不必重跑 150 支遷移（測試與桌面預建庫用）。 |
| `ONDEN_SEARCH_ENGINE=portable\|pgroonga` | 強制搜尋引擎；預設依資料庫有沒有 pgroonga 自動選。 |

PGlite 開機時另外 `CREATE EXTENSION vector, pgcrypto, pg_trgm`，並建 `content_nodes_trgm_idx`（`pg_trgm` GIN，供可攜搜尋）。這些只在 PGlite 路徑做，**沒有新增遷移**，正式伺服器的結構不變。

## 3. 請求上下文：結論

**問題**：後端用 `AsyncLocalStorage` 傳交易（`db.ts`）、cascade 根操作者（`spine/mutate`）、commit／rollback hooks（`spine/txHooks`）、冪等鍵、agent 工具鏈、標籤派送鏈、MCP 請求的 actor。瀏覽器沒有它；zone.js 會換掉全域 `Promise`，實驗要把 async/await 降級才勉強可用，不採用。

**介面**（`requestContext.ts`）：`createContextSlot<T>()` 回傳 `{ run(value, fn), getStore() }`，正好是後端對 ALS 用到的全部（實測 7 處都只用 `run`／`getStore`）。底下是 `ContextProvider`：

- Node（預設）：`AsyncLocalStorage`，程式行為與以前逐字相同。
- 串行堆疊（`createSerialContextProvider()`）：`run()` 把值推進堆疊，`fn` 的 Promise 結束時彈出；`getStore()` 回最內層。不用 zone.js、不碰全域 Promise。瀏覽器版在 import `app.ts` 之前 `useContextProvider(createSerialContextProvider())`。

**足夠的條件**（`test/requestContext.test.ts` 用同一組契約測試跑兩種 provider）：

1. 在 `run()` 裡跨 await、微任務、計時器都拿得到值；巢狀時內層遮蔽外層、結束後還原；丟例外也還原。
2. **宿主一次只跑一個流程**：請求、背景工作都要排進同一個佇列。PGlite 本來就只有一條連線，連線互斥鎖已經讓資料庫操作排隊，所以「一次一個請求」不是額外限制（實驗：20 個並行寫入也是排隊）。

**不足的地方**（測試明確釘住，不默默放寬）：

- 兩個流程交錯時，後一個會讓前一個讀到它的值（測試「overlapping flows」）。例：請求 A 在 await 中，背景工作 B 啟動並進入自己的 `run()`，A 恢復後 `getStore()` 回 B 的交易。所以瀏覽器宿主**不可以**讓背景工作（`setInterval`、outbox、`startDispatcherCatchup`）在請求處理中途自己開跑；要把它們也送進同一個佇列，或只在佇列空閒時啟動。
- 請求回應「之後」才跑的工作：Node 的 ALS 會讓 `setTimeout` 回呼仍拿到原上下文；堆疊版拿不到（測試「a timer started inside run()」）。逐項看後端這類工作：
  - **after-commit hooks**（`txHooks`）：在 `withTxHookScope` 內，於 `storage.run()` 結束後同步執行，不依賴上下文延續，兩種 provider 行為相同。
  - **hook 裡的 fire-and-forget**（`notifyChanged`、`drainOutbox` 的即時觸發）：hooks 在 `withTransaction` 的 COMMIT 之後、呼叫者自己的上下文裡執行（已在交易的 `run()` 之外），所以兩種 provider 看到的都是「不在交易裡」，走 `pool`；行為相同。
  - **outbox／dispatcher catch-up／週期工作**：本來就從 timer 起頭、以 `pool`／`withTransaction` 自己開交易，不指望繼承上下文。
- 所以第 2 批的結論是：**堆疊版夠用，前提是單一佇列**；佇列要放在瀏覽器橋層（每個 `/api/*` 請求與每個背景工作都排進去），不放進後端。若之後要真正的並行，等 TC39 AsyncContext 在目標瀏覽器（含 Safari）可用再換 provider，後端不必改（未查證各瀏覽器支援狀況）。

## 4. 搜尋：兩個實作

`nodeSearch.ts` 只負責「工作區、標籤、屬性、`readableScopeSql`、LIMIT」，文字比對、排序、摘要關鍵字向 `TextSearchEngine.build(alias, queryText, params)` 要三段 SQL：`match`、`order`、`keywords`。**`readableScopeSql` 仍在同一條 SQL 的 WHERE 裡**，LIMIT 落在已授權的列上；沒有應用程式複過濾。結果形狀（`id,title,slug,node_type,snippet,is_task`）不變。資料庫有 pgroonga 就用它，否則可攜版（`ONDEN_SEARCH_ENGINE` 可強制）。

| | pgroonga（正式伺服器，行為不變） | 可攜版（PGlite、沒有 pgroonga 的 Postgres） |
| --- | --- | --- |
| 比對 | `title &@~ q OR markdown &@~ q` | 每個詞 `ILIKE '%詞%'`（跳脫 `%`、`_`），整句查詢要在標題成立、或在內文成立（與 pgroonga 同樣的「標題或內文」語意） |
| 查詢語法 | Groonga 語法 | 詞（AND）、`"片語"`、`a OR b`、`-排除`；其餘 Groonga 語法（欄位限定、括號、萬用字元）當一般文字。**OR 與空白的優先序**：可攜版是 OR 結合較緊（`a b OR c`＝a 且 (b 或 c)）；pgroonga 的優先序**未查證**，兩者可能不同 |
| 只有排除（`-x`） | 不命中 | 不命中（一致） |
| 排序 | 標題相同 → 標題開頭相同 → `pgroonga_score` | 標題相同 → 標題開頭相同 → 自訂分數（詞在標題 1000＋內文出現次數，上限 999，各詞相加）。**第三層以後的相關性不同**，`pgroonga_score` 無法重現 |
| 摘要關鍵字 | `pgroonga_query_extract_keywords`（片語整個、OR 與排除不算） | 同語意，由應用程式從解析結果組成 `ARRAY[...]` |
| 索引 | pgroonga 索引 | 1 字、2 字詞＝循序掃描；3 字以上用 `pg_trgm` GIN（實驗：1 萬篇約 3 ms，無索引 2 字詞約 160 ms，10 萬篇會到秒級） |
| 標題前綴的召回 | `&@~` 比對整個 token：`Note 6` 找得到 `Note 6 draft`，找不到黏在一起的 `Note 60`（不是排序問題，是召回） | `ILIKE` 子字串：兩者都找到。排序四級（相同 → 開頭 → 整句包含 → 其餘）兩邊一樣，`textSearchEngines.integration.test.ts` 的黏字案例只在可攜版斷言 |
| 大小寫、全形半形 | pgroonga 正規化 | `ILIKE` 只處理大小寫；全形半形、Unicode 正規化**不做**（與前端離線 LIKE 搜尋一致） |

契約測試（`test/textSearchEngines.integration.test.ts`）：同一份語料、兩個引擎都要通過「命中集合相同、標題兩層排序相同、排除與片語、摘要標亮」；不要求相關性順序。pgroonga 那一組只在有擴充的資料庫跑——**雲端沒有 pgroonga，這一組在本批沒有實跑**，正式伺服器／業主筆電的 CI 才會跑它。

## 5. 第 2 批（瀏覽器 App）要的接口

1. `import { app } from "./app.js"`，呼叫 `app.fetch(request)`；不必切原始碼。
2. 在 import `app.ts` 之前依序：`useContextProvider(createSerialContextProvider())`、`useMigrationSource(內嵌 SQL)`；環境變數 `ONDEN_DB_DRIVER=pglite`、`ONDEN_PGLITE_DIR=idb://…|opfs-ahp://…`（`config.ts` 讀 `process.env`，注入一個 `process` 物件即可）。
3. 開機檔（`worker.ts`）自己做 Node `server.ts` 該做的事中瀏覽器需要的：`migrate()`、`loadWorkspaceClock`、`auth.$context.runMigrations()`、選用背景工作；全部排進同一個佇列（§3）。
4. 打包 alias：`node:crypto`、`Buffer`、`node:path/url/events/util`、`node:fs`（媒體與密鑰檔，§1.2 第 2 批項目）、better-auth 的 ALS。`pg` 不必 alias：`db.ts` 只在 `ONDEN_DB_DRIVER` 不是 pglite 時才 `new pg.Pool`（import 仍在，bundle 可把 `pg` 設為 external／空殼）。
5. PGlite 的持久化（`idb://` 慢一個數量級、`opfs-ahp://` 不支援 Safari）與 WebKit／iOS 實測屬第 2、3 批；本批只提供 `ONDEN_PGLITE_DIR`／`ONDEN_PGLITE_SNAPSHOT` 兩個接口。

## 6. 後端測試在 PGlite 上跑

```bash
cd packages/backend
ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://onden:onden@localhost:5432/onden_test npx vitest run
```

- `DATABASE_URL` 只是讓既有的「`_test` 資料庫才跑整合測試」守門通過，PGlite 路徑不連它。
- `globalSetup` 只遷移一次、存成 tar（約 3.5 秒、42 MiB）；每個測試檔的 worker 從它開自己的記憶體 PGlite。因此**檔與檔之間完全隔離**，比共用一個 `onden_test` 更嚴格。
- 正式伺服器與業主筆電的 CI 仍以真 Postgres＋pgroonga 為準；PGlite 是「沒有 Postgres 的環境也能跑整合測試」的第二條路，不是取代。

## 7. PGlite 上的測試結果與跳過清單（2026-11-01，雲端實跑）

完整 `npx vitest run`（552 個測試檔，`ONDEN_DB_DRIVER=pglite`）：**5165 個測試：5077 通過、0 失敗、88 跳過**，約 50 分鐘。
跳過的 88 個含本來就會跳過的（例如需要 pgroonga／外部服務的測試自己的 `skipIf`）與本批新增的明確標記（`test/helpers/pgliteSkips.ts`，只在 PGlite 為真，真 Postgres 全跑）：

| 標記 | 數量 | 意義 |
| --- | ---: | --- |
| `needsSecondConnection` | 41 處（含 `it.each` 展開更多案例） | 測試握著一個交易、另用第二條連線（鎖等待、「排隊的寫入者」、跨連線快照、別處持有 advisory lock）。涵蓋 `createNodeAuthority`、`tagMembershipAuthority`、`actorWriteAuthority`、`coreConsistency`、`syncSnapshot`、`readSnapshot`、`bootstrapSnapshot`、`eventTransaction`、`backupRestoreConcurrency`、`outbox`／`schedulerLeaderLock` 的跨實例鎖案例等。 |
| `needsPostgresServer` | 4 處 | 測的是 Postgres 伺服器本身：自己的 `pg` 連線（遷移 127 的暫存資料庫、`migration.integration`）、`statement_timeout`、連線池計數、連線驅逐，以及灌兩萬筆的 `scale`（PGlite 跑超過一小時）。 |
| `needsPgroonga` | 3 處 | `searchUnicode` 中釘住 pgroonga 分詞器／運算子的案例（可攜版的差異見 §4）。 |

沒有默默放寬：其餘所有測試（含 `searchSnippets`、`searchNodesReadPolicy`、權限矩陣、復原、同步、匯入、備份還原）都在 PGlite 上通過。
雲端**沒有 pgroonga 也沒有 Postgres 伺服器**：pgroonga 引擎、真 Postgres 上的 `withLeaderLock` 互斥、`needs*` 跳過的案例，本批都**沒有實跑**，須由正式伺服器／業主筆電的 CI 以真 Postgres 確認。

過程中順手修的真問題（兩邊都適用）：備份上傳丟棄時先刪 meta 再刪 zip（原本可能短暫回「not_zip」而非 404）；`aiRuntimeApi` 預覽測試沒處理「附上時執行已結束」；`dbPglite` 契約測試不依賴執行順序。

## 8. 第 2 批的結果（瀏覽器版）

- 完整設計、數字與沒做到的項目：[browser-app.md](browser-app.md)。這一批對後端本身只加了**四個注入點**（第 4 批又加兩個：`useMediaFiles`、`useImageCodec`）（正式伺服器行為不變）：`db.ts` 的 `useDatabaseSnapshot`（首次開啟從打包好的快照開始）、`backgroundJobs.ts` 的 `useJobRunner`（週期工作經宿主的佇列）、`config.ts` 的 `setEnvironment`（宿主在 import 前設環境）、`dbPglite.ts` 的 `loadDataDir` 可回 `undefined`。其餘都在 `src/browser/`（worker 入口）與 `browser-shims/`（只在打包時用的 Node 替身）。
- §3 的結論成立：串行堆疊 provider 在「所有請求與背景工作經同一佇列」下夠用；佇列放在 worker 入口（`src/browser/queue.ts`），不放進後端。
- §5 的接口清單全部用上：`app.fetch`、`useContextProvider`、`useMigrationSource`、`ONDEN_DB_DRIVER`、快照；`ONDEN_PGLITE_DIR` 在瀏覽器版固定 `memory://`（持久化是整份副本，理由見 browser-app.md §4）。
- 第 1 批留下兩個過期的文件路徑註解（`dbMigrations.ts` 提到不存在的 `services/search/portableSearch.ts`、`app.ts` 提到已不存在的 `routes/rss.ts`）與一個過期的守門例外，這批順手修正（markdown 的 `dup-b2-constants.guard.test.ts` 因此從失敗變通過）。

## 9. 怎麼寫新查詢：`db`（有型別的 SQL）

新的資料庫查詢一律用 `db`（`packages/backend/src/dbKysely.ts`，Kysely），不再手寫 `q()`／`client.query` 的 SQL 字串。

```ts
import { db } from "../dbKysely.js";
const row = await db.selectFrom("workspaces").select(["time_zone", "day_start_hour"]).where("id", "=", workspaceId).executeTakeFirst();
```

- **走哪個連線**：`db` 的 driver 最後呼叫 `q()`。所以在 `withTransaction`／`mutate()`／savepoint 裡就用那個交易的連線（一起提交、一起回滾），在外面用 pool；真 Postgres 與 PGlite 都一樣。以後 `q()` 加的檢查（例如核心表寫入必須在交易內）Kysely 也自動經過同一處。不要用 `db.transaction()`（會丟錯）；交易一律由 `withTransaction`／`mutate()` 開。
- **型別從哪來**：`src/dbSchema.generated.ts`，由 `kysely-codegen` 從「跑完全部 migrations 的 PGlite」產生，勿手改。`bigint`／`numeric` 欄位在這個專案回傳字串（和 `pg` 一樣），`timestamptz` 是 `Date`。
- **改了 migration 之後**：在 `packages/backend` 跑 `npm run db:types` 並一起提交。忘了的話 `src/test/guards/dbTypes.guard.test.ts` 會失敗並提醒（它在獨立的記憶體 PGlite 上重跑 migrations 再比對，約 6 秒）。
- **舊的手寫 SQL**：`be-raw-sql` 規則逐檔計數，只准減不准增，新檔案是 0（`scripts/allowlist-baseline.json`）；改掉一個檔的查詢後用 `npm run allowlist:baseline` 降基準。複雜的 SQL（遞迴 CTE、`readableScopeSql` 這類權限範圍片段）可以在 Kysely 查詢裡用 `sql` 模板，或暫時留在舊檔；權限判斷的 SQL 這一批沒有動。
- **已示範的地方**：`services/workspaceTime.ts` 的 `readSetting`、`services/aiRoles.ts` 的 MCP 最後使用時間。

