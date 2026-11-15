> 狀態：現行（最後確認 2026-11-01）

# 實驗：只在瀏覽器裡的 Onden 試用版

> 狀態：技術實驗（2026-10-31），可丟棄，不進 workspace、不影響建置，沒有改 `packages/` 任何產品程式。
> 目標（業主：「先試看看」）：同一套 Hono 後端放進瀏覽器 worker，底下接 PGlite（Postgres WASM），攔下 `/api/*` 自己回應。
> 相關：桌面 App 設計與 PGlite 實測在 PR #1133（`docs/design/desktop-app.md`、`docs/research/desktop-app/`），本文沿用其結論並補上它沒測的部分。

## 0. 先看結論

1. **可行。** 真正的後端（`packages/backend/src/index.ts` 的 Hono app，未改一行）已在 headless Chromium 的 module worker 裡跑起來：套完 150 支遷移、登入、bootstrap、建立／修改筆記、搜尋（含中文兩字詞、OR、排除）、20 個並行寫入全部回 2xx。
2. **最大障礙有三個，都不是「寫另一份後端」：** ① 後端靠 `AsyncLocalStorage` 傳交易與權限，瀏覽器沒有（本實驗用 zone.js 頂替，能跑但要把 async/await 降級，行為風險要長期測）；② PGlite 只有一條連線，後端有 162 處直接 `pool.query`，其中有的發生在別人的交易「裡面」（會死結，已用「已在交易裡就沿用該連線」解掉）；③ **持久化很慢**：同樣 20 個寫入，記憶體 0.7 秒、OPFS 4.3 秒、IndexedDB 23.9 秒（見 §3）。另外下載量約 7.8 MiB（gzip）。
3. **建議：值得做成「選用的第二條載入路徑」，但先做第 1 步（約 2–3 週，粗估）而不是整個產品：** 搜尋抽象層＋資料庫替換層（與桌面 App 共用）→ 單分頁試用版 → 備份格式匯出入。持久化速度與多分頁要先在 Tab S9／Brave 實機確認再投入第 2 步。待決定問題 5 個見 §9。

## 1. 後端能不能在 worker 裡跑（問題 1）

### 1.1 結果

`build-browser.mjs --shims` 用 esbuild 把 `src/workerMain.ts`（→ 真正的 `index.ts` 路由組裝）打成單一 `worker.js`，在 Chromium module worker 載入，**情境全過**（`scenario.mjs`）。Node 版（`smoke.mjs`）同一個情境也過。

### 1.2 Node 專屬東西逐項盤點

「換法」欄就是本實驗實際用的（程式在 `shims/`、`nodeShims.mjs`、`esbuild-plugins.mjs`）。

| 項目 | 用在哪 | 判定 | 怎麼處理 |
| --- | --- | --- | --- |
| `pg` 連線池 | `db.ts`、better-auth（Kysely `PostgresDialect`） | **要換** | `pgShim.mjs`：用到的只有 `Pool.query／connect／release／on／end`（全後端只有 `db.ts` import `pg`）。FIFO 互斥鎖＝單連線；`BEGIN…COMMIT` 期間其他請求排隊。bigint／numeric 以字串回傳（與 `pg` 一致）。PGlite 另有官方 `node-postgres` 轉接，未採用（會把整個 `pg` 帶進瀏覽器）。 |
| `pool.query` 在交易內 | 162 處；例如 `blobs.ts putBlob`（刻意用另一條連線，避免長交易鎖） | **要換（致命）** | 單連線下會死結（實測：PATCH 筆記卡死）。shim 讓「已在交易裡的 `pool.query`」沿用該交易的連線。需要 `db.ts` 露出交易上下文（實驗用 esbuild 一行修補；正式做法見 §2.3）。語意差異：真 Postgres 那些寫入在交易外先提交，PGlite 版跟著交易提交／回滾，對 `putBlob`（內容雜湊、冪等）無影響，其他 162 處需逐一檢查。 |
| `node:async_hooks` `AsyncLocalStorage` | `db.ts` 交易、`spine/mutate`、`idempotency`、`txHooks`、`toolScope`、`tagDispatcher`、`mcpProtocol`（7 檔，只用 `run`／`getStore`） | **要換（風險最高）** | `shims/asyncHooks.mjs`：zone.js 實作。zone.js 只管得到 `Promise.then`，管不到原生 `async/await`，所以打包要 `supported: {async-await: false}`（esbuild 降級成 Promise 鏈）。實測 20 個並行請求交易沒有互相污染。瀏覽器正式支援（TC39 AsyncContext）**未查證**。 |
| better-auth 的 ALS | `@better-auth/core/async_hooks` | **要換** | 它的 `browser` 條件用「單一全域變數」當 ALS（兩個請求同時會互相覆蓋）。alias 到會 import `node:async_hooks` 的版本（= 上一列的 zone.js 版）。 |
| `node:fs`（遷移檔） | `db.ts migrate()` 的 `readdir／readFile` | **要換** | 建置時把 150 支 SQL 內嵌（`virtual:migrations`）；`shims/fs.mjs` 回答 `readdir／readFile`。 |
| `node:fs`（其他） | `auth.ts` 密鑰檔、`git.ts`／`mediaStore.ts` 的 `content/`、備份暫存、匯出 | **要換／不提供** | 讀取一律 ENOENT。媒體要改存 OPFS 或 IndexedDB（§1.3）；auth 密鑰見 §1.3。 |
| `node:crypto` | 37 檔：`randomUUID`（237 處）、`randomBytes`、`createHash`（sha256／sha1）、1 處 AES（`createCipheriv`，API 金鑰加密） | **要換** | `shims/crypto.mjs`：`crypto.randomUUID`、`getRandomValues`、`@noble/hashes` 同步 SHA-256（WebCrypto 是非同步的，後端的 `sha256Hex` 是同步呼叫）。AES 部分試用版不提供（§8）。 |
| `Buffer` | 41 處（`from`、`byteLength`、`concat`…） | **要換** | `buffer`（MIT）全域注入。 |
| `node:path`／`url`／`util`／`events` | 路徑運算、`fileURLToPath`、`isDeepStrictEqual` | **要換** | `path-browserify`、`events`、小型替身。`isDeepStrictEqual` 的替身是 JSON 比較（**近似**，正式版要換真正深比較）。 |
| `process.env`／`process.cwd` | `config.ts`（唯一讀環境的入口）、`logger.ts` | **可直接用** | `config.ts` 與 `logger.ts` 本來就是唯一入口；只要注入一個 `process` 物件（`shims/globals.mjs`）。 |
| `node:stream`、`archiver`、`yauzl`、`node:zlib` | 備份 zip 匯出／還原、站台 zip | **要換**（才有備份，§7） | 本實驗以替身略過。換成 `fflate`（MIT，已裝）。 |
| `sharp`（原生模組） | `media.ts` 上傳縮圖、`getAttachment` | **試用版不提供** | 圖片原樣存（或前端用 canvas 縮）。 |
| `@hono/node-server` | `index.ts` 開機 | **不需要** | 橋直接呼叫 `app.fetch`。 |
| 開機段（top-level await） | `index.ts` 底部 `if (!isTest()) {…}` 與組裝在**同一個檔** | **要拆（產品程式）** | 實驗用 esbuild 把 `// Server bootstrap` 之後整段切掉。正式做法：拆成 `app.ts`（組裝）與 `server.ts`（Node 開機），再加 `worker.ts`（試用版開機）。 |
| 定時工作 | `backgroundJobs.ts` 的 `startPeriodicJob`（唯一的 `setInterval` 入口，含 `pool.connect` 的 advisory lock）、outbox、任務排程、dispatcher catch-up | **要換／部分不提供** | 試用版只在頁面開著時才有 worker；只需換 `startPeriodicJob` 一個入口（`exclusive:false`、不要 advisory lock）。RSS 抓取、GitHub 備份、web push 這幾個 outbox 效果不啟動。 |
| SSE 即時通知 | `routes/events.ts`（`/api/events`，`setInterval` heartbeat）、前端 `useLiveEvents` 用 `EventSource` | **要換** | 單分頁沒有「別人改了」，可關閉；多分頁要靠 `BroadcastChannel`。 |
| 對外抓取 | `safeFetch.ts`（`node:http/https/dns/net`，防 SSRF）、RSS、`pageMeta`、citations(Crossref) | **試用版不提供** | 瀏覽器受 CORS 限制，且 SSRF 防護依賴 DNS 解析。 |
| `pagefind`、`simple-git`、`web-push`、`@octokit` | 發布網站的搜尋索引、git／GitHub 備份、推播 | **試用版不提供** | 替身（載入不報錯、被呼叫才失敗；正式版由「路由允許清單」擋在 API 層，回 404＋白話說明）。 |
| MCP 伺服器 | `routes/mcpProtocol.ts`（`@modelcontextprotocol/sdk`） | **試用版不提供** | 外部 Claude 連不進瀏覽器（§8）。 |
| 「browser 條件」套件 | `decode-named-character-reference`（用 `document`）、`hast-util-from-html-isomorphic`（用 `DOMParser`） | **要換** | Worker 沒有 DOM；alias 到非 DOM 版本。其他依賴升級時可能再出現同類問題。 |
| 瀏覽器禁止的標頭 | `Request` 的 `cookie`／`origin`／`host`、`Response` 的 `set-cookie` 被建構子**悄悄丟掉**（實測：第一次跑登入後全部 401） | **要換** | `src/bridge.ts`：橋用 `auth.api.signInEmail({returnHeaders:true})`（一般 `Headers` 不受限）自己拿 session cookie，每個請求用 Proxy 換掉 `headers`。 |

### 1.3 「唯一入口」規則：只要換哪幾個檔

`scripts/entrypoints.catalog.json`（後端 25 項）已經把這些責任收在單一檔案，替換面因此很小：

| 入口（catalog 項目） | 試用版要做的事 |
| --- | --- |
| `db.ts`（`be-route-layers` 以外的資料庫入口；唯一 import `pg` 的檔） | 換驅動（pgShim）、遷移來源、露出交易上下文。**最大一塊。** |
| `config.ts`（`be-config`）／`logger.ts`（`be-logger`） | 不用換；只要有 `process.env`。 |
| `backgroundJobs.ts`（`be-periodic-job`） | 換成不用 advisory lock 的版本。 |
| `index.ts`（組裝＋開機） | 拆檔。 |
| `auth.ts` | 密鑰：非 production 用公開的開發密鑰（實驗如此）；production 會讀寫 `content/.auth-secret`。試用版要在瀏覽器端產生隨機密鑰並存起來；session cookie 只在本機 worker 驗證，不外送。 |
| `services/mediaStore.ts`／`media.ts`（`MEDIA_DIR`） | 媒體存放換成 OPFS。 |
| `utils.ts`（`sha256Hex`，`be-sha256`） | 靠 crypto 替身即可。 |
| `safeFetch.ts` | 試用版不提供。 |

沒被入口收住的：`node:crypto` 散在 37 檔、`pool.query` 162 處、AES 1 處——靠 alias 與驅動層吸收，不改這些檔。

## 2. 最小可跑原型（問題 2）

### 2.1 怎麼重跑

```bash
cd docs/research/browser-trial
npm ci                      # 本資料夾自己的 package.json（pglite、zone.js 等），不是 workspace
ln -sfn ../../../packages/backend/db db   # 只有 Node 版需要：db.ts 的 migrate() 以相對路徑找 db/migrations
node build-node.mjs && node smoke.mjs                       # Node：真正的 app + PGlite
node build-browser.mjs --shims --write && node browser-run.mjs [memory|idb|opfs] [relaxed]   # headless Chromium module worker
node search-bench.mjs 10000                                  # 搜尋與 pgvector（§4）
```

### 2.2 打到的 API（Chromium worker，記憶體模式，全部成功）

| 呼叫 | 結果 |
| --- | --- |
| `GET /health` | 200，約 15 ms |
| 本機帳號（橋自己登入）→ `GET /api/bootstrap` | 200，約 60 ms |
| `POST /api/nodes`（建立）／`PATCH /api/nodes/:id` | 201／200，27–45 ms |
| `GET /api/nodes/search?q=…`：`搜尋樹`、`死結`（2 字）、`死結 OR 搜尋樹`、`樹 -AVL` | 200，8–15 ms，結果正確（含摘要） |
| 20 個並行 `PATCH` | 全 200，約 0.65–0.75 秒（單連線排隊，沒死結） |

### 2.3 卡關與正式做法

- **登入**：瀏覽器的 Request／Response 會丟掉 cookie 相關標頭（§1.2 末列）。橋自己登入、自己帶 cookie。Node 的 `smoke.mjs` 因 `NODE_ENV=test` 會開 native bypass，**不能證明認證**；瀏覽器版用 `NODE_ENV=development`，session 為真，才是有效的認證證據。
- **這些修補要不要進產品程式**（本批沒有做）：(a) `db.ts` 對驅動露出「目前交易的連線」（取代實驗的 esbuild 修補）；(b) `index.ts` 拆開機；(c) 遷移來源可注入。三者都屬「資料庫替換層」，與桌面 App 共用。
- **未驗證**：其餘約 150 個路由（匯入、歷史、復原、白板、任務、標籤視圖…）只靠同一個 app 組裝，**沒有逐一跑**；後端的整合測試套件（`npm run test:integration`）沒有在 PGlite 上跑過。這是下一步最有價值的事：把 `test:integration` 的資料庫換成 PGlite 看通過率。
- **語意差異**：`pg_advisory_lock`（遷移、定時工作）、`LISTEN/NOTIFY`（後端單程序用記憶體機制，影響小）、`statement_timeout`／`jit` 等連線設定在 shim 裡被忽略。

## 3. 大小與效能（問題 3）

量測環境：雲端容器、headless Chromium（Playwright 附的版本）、Node 22。**不是 Tab S9**；手機的數字預期明顯較慢，待實機（§3.3）。

### 3.1 下載大小

| 檔案 | 原始 KiB | gzip KiB | brotli KiB |
| --- | ---: | ---: | ---: |
| `worker.js`（後端＋PGlite JS＋150 支遷移 SQL＋remark／katex 等，minify） | 4,345 | 1,196 | 922 |
| `pglite.wasm` | 8,875 | 3,211 | 2,503 |
| `pglite.data`（Postgres 基底檔案系統） | 6,102 | 2,080 | 1,041 |
| `initdb.wasm`（首次建庫） | 293 | 129 | 106 |
| `pgcrypto.tar.gz` | 1,124 | 1,118 | 1,112 |
| `pg_trgm.tar.gz`／`vector.tar.gz` | 15／50 | 15／50 | 15／50 |
| **合計** | | **約 7,800（7.6 MiB）** | **約 5,750（5.6 MiB）** |

- `pgcrypto` 只被 3 支遷移的 trigger 用來算 `digest(markdown,'sha256')`（`030／032／048`）與 `147`；Postgres 內建 `sha256(bytea)`，若改寫可省約 1.1 MiB（要動遷移檔或新增遷移，須單獨設計）。
- 預先套完遷移的資料庫快照（`dumpDataDir('gzip')`）約 5.7 MiB——比「首次 initdb＋150 支遷移」的程式碼還大，不划算當成品；首次建庫要在使用者裝置上做一次。

**不能影響正式版開機包**：試用版是獨立進入點（獨立網址或 `import()` 動態載入的 worker 檔），不放進 `modules/<id>/index` 的登記資料，也不加進 `scripts/check-boot-bundle.mjs` 管的登入後必載 JS。本實驗完全沒碰 `packages/frontend`，正式版 boot JS 不變。

### 3.2 時間與記憶體（Chromium 單次，同機器三次重複約 ±5%）

| 項目 | 數字 |
| --- | --- |
| Node：載入 bundle | 約 0.55 s |
| 首次建庫＋套用 150 支遷移（記憶體） | **Node 2.8–3.3 s；Chromium worker 3.6–4.0 s**（桌面 App 設計文件用 Node 測得 2.6 s，一致） |
| 冷啟動到可回應（開 worker → 建庫 → 遷移 → 登入） | 約 4.0–4.5 s；整個情境跑完（含 dump）約 5.5–6.5 s |
| 暖啟動（資料已持久化，不用遷移；OPFS） | 開機 3.4 s（其中大半是載入 wasm 與開庫） |
| Chromium 所有行程總 RSS | 約 840–870 MB（記憶體模式）。**注意：這是整個 headless Chromium（含瀏覽器行程、GPU 行程），沒有扣掉空白頁基線，不能當成 worker 本身的用量**；worker 單獨的 JS 堆積與 wasm 記憶體**未量測**。 |

### 3.3 持久化後端速度（同一情境，Chromium）

| 後端 | 首次開機（含遷移） | 20 個並行 PATCH | 暖啟動 | 備註 |
| --- | ---: | ---: | --- | --- |
| 記憶體 | 4.0 s | 0.65–0.75 s | — | 關頁即消失 |
| `opfs-ahp://` | **13.5 s** | **4.3 s**（約 215 ms／次） | 成功，資料還在（遷移 0 支） | 官方文件：不支援 Safari；只能在 Worker |
| `idb://` | **38.4 s** | **23.9 s** | 成功 | 官方文件稱每次查詢後把改動的檔案寫回 |
| `idb://` + `relaxedDurability` | 4.0 s | 0.65 s | **我的測試中第二次開機又套了 150 支遷移 → 資料沒存下來**（寫回延後，我在 `terminate()` 前呼叫了 `syncToFs()` 仍沒保存；原因**未查明**） | 不能採用，需再查 |
| `opfs-ahp://` + `relaxedDurability` | 失敗（`ERRORDATA_STACK_SIZE exceeded`／遷移 064 `portal "" cannot be run`） | — | — | 不能採用 |

意思：**持久化是這條路最大的未知數**。可行的候選：(a) 遷移一律在記憶體做完再一次寫入；(b) 每次交易提交後只寫一次、不要每條查詢都寫；(c) 記憶體執行＋定期 `dumpDataDir()` 存檔（每次約 0.7 s、5.7 MiB，崩潰會丟最近的修改）。都要先在 Tab S9 實機量。

### 3.4 需要業主在 Tab S9／Android Brave 實機測的項目

做法：我提供一個測試頁（第 1 步產出），業主開網址、按「執行」，頁面把下列數字顯示出來（截圖貼回）。

| # | 項目 | 做法 | 通過標準（建議） |
| --- | --- | --- | --- |
| T1 | 冷啟動時間（首次建庫＋遷移） | 無痕視窗開測試頁，按執行 | ≤ 15 s，且不被系統殺掉 |
| T2 | 暖啟動時間 | 關掉分頁再開 | ≤ 5 s |
| T3 | `opfs-ahp://` 在 Brave Android 能不能開庫、20 次寫入耗時 | 同上選 OPFS | 可用、≤ 8 s |
| T4 | `idb://` 同上 | 同上選 IDB | 可用 |
| T5 | 記憶體峰值 | Chrome `chrome://inspect` 或 Android「開發人員選項→執行中的服務」看 Brave 行程 | < 600 MB |
| T6 | 背景 5 分鐘／鎖屏後再回來，資料還在、worker 還活著 | 切到別的 App 5 分鐘 | 資料不丟 |
| T7 | `navigator.storage.persist()` 的結果、`estimate()` 的配額 | 測試頁顯示 | 記錄結果 |
| T8 | 清除網站資料後行為、Brave「離開時清除資料」設定是否預設開 | 手動操作 | 記錄 |
| T9 | 兩個分頁同時開（§5） | 開兩個分頁各改一篇 | 不損壞資料 |
| T10 | 搜尋 1 萬篇的速度（§4） | 測試頁灌 1 萬篇再搜 | 兩字詞 ≤ 500 ms |

## 4. 搜尋（問題 4）

### 4.1 實測（`search-bench.mjs`，PGlite 在 Node，記憶體；1 萬篇、共約 18.7 MB 的合成中文語料，中位數 5 次，毫秒）

| 查詢 | B：`ILIKE` 無索引（含排序） | A：目前原型（`&@~` 相容 plpgsql 函式，無排序） | C：`ILIKE`＋GIN `pg_trgm`（含排序） | D：前端離線搜尋路徑（sql.js `LIKE`，無排序） |
| --- | ---: | ---: | ---: | ---: |
| `死結`（2 字，命中 40 篇） | 162 | 258 | 159 | 23 |
| `搜尋樹`（3 字，25 篇） | 177 | 378 | **3.1** | 38 |
| `樹`（1 字） | 383 | 2.4* | 381 | 0.1* |
| `死結 OR 排程` | 316 | 55* | 306 | 7.5* |
| `記憶體 -排程`（排除） | 310 | 71* | **18.5** | 5.5* |
| `kafka`（英文） | 305 | 2.7* | 233 | 0.2* |

\* 命中數超過上限 30 且**沒有排序**，掃到 30 筆就停，不代表整體掃描速度。B、C 為了排序必須掃完所有命中。
GIN 索引：建立 10.7 秒；表＋索引 72 MB（內文索引 48 MB，約為文字量的 2.6 倍）；寫入 1 萬篇（無索引）0.55 秒。
EXPLAIN：`搜尋樹`（3 字）用到 GIN；**`死結`、`樹`（1–2 字）用不到**（`pg_trgm` 要 ≥3 字才有 trigram，與桌面 App 文件一致）。

### 4.2 比較與結論

- **前端「既有的離線搜尋」實際是 LIKE 掃描，不是 FTS5。** `localDbWorker.ts` 建 `fts5 trigram` 虛擬表，但 `sql.js` 1.14.1 的標準 wasm 沒有編入 FTS5（實測 `no such module: fts5`），程式註解寫明失敗時「search falls back to LIKE」。所以離線搜尋走 LIKE（1 萬篇 23–38 ms，因為 SQLite 單機掃描很快）。這值得另外確認：**線上是否有人以為離線搜尋有 FTS5**。
- 中文兩字詞（最常見的查詢）在三種做法都等於**循序掃描**：PGlite 約 160 ms／1 萬篇，比 sql.js 慢 5–7 倍。1 萬篇可用；10 萬篇會到秒級，要另想辦法（見 4.4）。
- 排序：標題完全相同＞標題開頭相同＞標題包含＞內文出現次數，實測「查『死結』」前三筆為「死結」「死結與預防」「關於死結的筆記」，與 `nodeSearch.ts` 現有的兩層優先序一致。pgroonga 的 `pgroonga_score`（內部相關性）**無法在 PGlite 重現**；兩者排序品質的差距**未量測**（需要 pgroonga 環境與人工標註）。
- OR／排除／片語：查詢語法 `parseSearchQuery` 在 `@onden/markdown`，只分出 `text／tags／attrs`，`text` 仍是 pgroonga 語法字串（`OR`、`-x`、`"…"`）。本實驗寫了小型解析（`search-bench.mjs` `parseDsl`，**由左到右**，OR 與 AND 的優先序與 pgroonga 的差異**未查證**）。片語測 `"記憶體 管理"` 0 筆是語料沒有相鄰出現，不是 bug。
- Fuse.js 的錯字容忍（前端最後一道）：1 萬篇的速度**未量測**，且它只吃已載入的筆記。

### 4.3 搜尋抽象層介面草案（與桌面 App 共用，PR #1133 的草案再收斂）

目標：結果形狀一致——`NodeSearchResult`（`id,title,slug,node_type,snippet,is_task`）不變；差異只在 SQL 片段。

```ts
// services/search/textSearch.ts（草案，未實作）
export interface TextSearchEngine {
  readonly name: "pgroonga" | "trigram";
  /** 語意：title 或 markdown 命中 q。q 是 parseSearchQuery().text（詞、"片語"、OR、-排除）。 */
  matchSql(alias: string, q: Param): { sql: string; params: unknown[] };
  /** 越大越相關；沒有相關性的引擎回常數，排序仍有「標題相同、開頭相同」兩層 */
  rankSql(alias: string, q: Param): string;
  /** 摘要要標亮的詞（排除與 OR 不算），給 snippetAround */
  termsOf(q: string): string[];
}
// pgroongaEngine = 現況（&@~、pgroonga_score、pgroonga_query_extract_keywords）
// trigramEngine  = search-bench.mjs 的 trigramQuery：每個詞 → (title ILIKE $n OR markdown ILIKE $n)，OR 群用 OR 連，-x 用 NOT
// 選擇：開機時查 pg_extension 有沒有 pgroonga，選一個；建構時注入，不在每個呼叫處判斷。
```

- `termsOf` 可直接放進 `@onden/markdown`（前後端同一份），之後離線搜尋也用同一個函式，逐步取代 `pgroonga_query_extract_keywords`。
- 契約測試：同一組查詢×同一份語料，兩個引擎都要通過「命中集合相同、排序前三層相同」；不要求第四層（相關性）相同。
- 遷移：`001_baseline.sql` 硬性 `CREATE EXTENSION pgroonga／age`、建 pgroonga 索引；PGlite 路徑要有條件執行或另一支遷移（桌面文件已指出會動到既有遷移的慣例，需單獨設計）。本實驗是用字串替換「拿掉」這幾行（`src/migrations.ts`）。
- `age`：產品程式沒有使用（桌面文件已查證），可直接略過。

### 4.4 其他

- **pgvector（語意搜尋）在 PGlite 可用**：`@electric-sql/pglite-pgvector` 實測 1 萬個 384 維向量，寫入 6.2 秒、精確最近鄰 10.8 ms、`hnsw` 索引建立 14.1 秒、查詢 2.5 ms。但嵌入向量要有人產生：後端 `embedder.ts` 是伺服器端，試用版需要瀏覽器端模型（大小、授權**未評估**）或使用者自己的 API 金鑰，建議第一版關閉語意搜尋。
- 筆記到 10 萬篇以上：中文 1–2 字掃描會秒級。選項：自製 bigram 欄位＋GIN（桌面文件實測可行，寫入較貴）或在前端 sql.js 建 bigram 表。**不建議第一版做**；試用版設筆記數量提示即可。

## 5. 多分頁（問題 5）

- PGlite 官方立場：單人單連線；多分頁用 `PGliteWorker`——每個分頁各起一個 worker，做 leader election，只有 leader 開庫並處理所有查詢，leader 關閉後重選（官方文件 [multi-tab-worker](https://raw.githubusercontent.com/electric-sql/pglite/main/docs/docs/multi-tab-worker.md)；README 寫 "PGlite is single user/connection"）。
- 與本專案既有物件對照：**任務書提到的 `lib/webLock.ts` 在 repo 裡不存在**。實際上有的是 `lib/data/writeQueue.ts` 用 `navigator.locks.request("onden-pending-drain")`（離線佇列排空的跨分頁互斥）。沒有 SharedWorker 也沒有 leader election。
- 平台：Web Locks 在 Samsung Internet 10.1+ 支援；Chrome Android 版本資料互相矛盾（caniuse vs MDN）**未確認**；**SharedWorker 在 Chrome Android 長期停用，Chromium 資料顯示 148 起才支援，穩定版未確認**（來源見 §6.2）。所以不能把 SharedWorker 當唯一方案。
- 建議：**第一版只允許一個分頁開著試用版**——用 Web Locks 搶 `onden-trial-owner`，搶不到的分頁顯示「已在另一個分頁開啟」並提供「切到那個分頁」。這樣不用 leader election，也不會兩個 worker 同時寫同一個 OPFS／IDB（會毀損）。第 2 步再評估 leader worker（leader 持有 PGlite，其他分頁用 `BroadcastChannel` 送請求）。

## 6. 資料安全（問題 6）

### 6.1 風險

資料只存在使用者這台裝置的這個瀏覽器：換手機、清除瀏覽資料、重裝瀏覽器、瀏覽器因空間不足回收，都會讓它消失，**沒有任何伺服器副本**。這是試用版最大的使用者風險，介面必須講清楚。

### 6.2 各瀏覽器政策（只列查得到的；查不到的標未查證）

| 項目 | 結論 | 來源 | 直接看到 |
| --- | --- | --- | --- |
| Safari 7 天規則 | 使用者 7 天沒有互動，Safari 清除 script 可寫入的儲存（IndexedDB、localStorage、SW 註冊） | [ionic.io](https://ionic.io/blog/is-apple-trying-to-kill-pwas)、[mjtsai.com](https://mjtsai.com/blog/2020/03/26/safari-13-1-third-party-cookie-blocking-and-7-day-script-writeable-storage/)（二手） | 否 |
| 加到主畫面的網頁 App 豁免 7 天 | WebKit Bugzilla 留言提及 webkit.org 有「Home Screen Web Application Domain Exempt From ITP」一文；本文未取得。另有 2020 年回報說主畫面 App 的 cookie 仍被刪 → 與豁免說法不一致，需實測 | [bugs.webkit.org #237350](https://bugs.webkit.org/show_bug.cgi?id=237350) | 否 |
| Chrome／Chromium `persist()` 授與條件 | **未查證**（MDN、web.dev 在查證環境被擋） | [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | 否 |
| Firefox | 只確認是依來源 LRU 清除的舊討論；`persist()` 提示行為**未查證** | [Bugzilla 1156671](https://bugzilla.mozilla.org/show_bug.cgi?id=1156671) | 否 |
| 使用者手動清除瀏覽資料時 IndexedDB／OPFS／Cache 是否一併清除 | **未查證** | — | — |
| Brave Android | 設定有「離開時清除資料」（Android 版全有全無，只在整個 App 關閉時觸發）與「關閉網站時忘記我」；**預設值與是否額外限制配額未查證** | [Brave 支援文](https://support.brave.app/hc/en-us/articles/360054509991-How-do-I-manage-Cookies-and-Site-data-in-Brave-on-Android)、[brave-browser #7487](https://github.com/brave/brave-browser/issues/7487) | 否 |
| OPFS `createSyncAccessHandle`（PGlite `opfs-ahp` 需要） | PGlite 文件：支援 Chrome、Firefox，**不支援 Safari**（Safari 的 handle 上限約 252 個，Postgres 需 300+）；只能在 Worker；文件建議瀏覽器內用 `idb://`。Chrome Android／Samsung Internet **未查證** | [PGlite filesystems.md](https://raw.githubusercontent.com/electric-sql/pglite/main/docs/docs/filesystems.md) | 是 |

→ 因此：iOS Safari 只能用 `idb://`（本實驗 IDB 很慢，§3.3），且受 7 天規則影響。業主沒有 iPhone，iOS 一律待確認。

### 6.3 現有可重用的入口與建議

- `lib/storagePersist.ts` 的 `requestPersistentStorage()` 已實作「請求 `persist()`＋印出配額」，**試用版開機時呼叫**；結果要**顯示給使用者**（現在只印 console）：「瀏覽器已答應保留資料／沒答應，請定期下載備份」。
- 引導裝成 PWA：既有 `public/sw.js`（只快取靜態檔、`/api/*` 不碰）可沿用；試用版要另外把 worker 與 PGlite 資產（約 7.6 MiB）納入離線快取，否則離線打不開。Chromium 對已安裝 PWA 較容易授與 `persist()`（以 `storagePersist.ts` 註解為準，官方條件**未查證**）。
- 匯出：見 §7；介面上「下載備份」要常駐，並在寫入 N 篇或超過 7 天沒備份時提醒（沿用既有提示入口 `useHintOnce`，不另做）。

## 7. 搬家（問題 7）

- 既有備份格式：`GET /api/backup/full.zip`（`services/backupArchive.ts`）＝可用 Obsidian 開的 Markdown vault＋`.onden/`（`notes/<id>.json`、`spaces.json`、`manifest.json`）；還原走 `POST /api/backup/restore/upload → preview → apply`（`backupRestore.ts`，可「空工作區」或「合併」；一個可復原的事件）。格式版本 `manifest` 有檢查。
- **試用版→正式版**：試用版用同一個 `buildFullBackup`（同一個後端程式）就會產出**同格式**的 zip，正式版直接匯入即可，不必寫轉換。缺的是 zip 寫入器：`archiver` 是 Node stream，瀏覽器不能用；`yauzl` 同理。換成 `fflate`（MIT）。`pacedArchive`／`archiveStream.ts` 的串流假設要檢查。
- **身分**：備份內作者是試用版的本機 actor；還原時的 actor 對應規則（`backupRestore.ts`）**沒有讀完**，匯入後「誰寫的」會變成匯入者還是保留，需確認（待驗證）。
- **反向**（正式版→試用版）：同一份 zip 丟給試用版的還原即可；上限是瀏覽器記憶體與 PGlite 容量（附件大時最先出問題）。建議試用版還原前警告「超過 N MB 可能失敗」。
- 這個功能同時是資料安全（§6）的唯一出口，優先順序高於多分頁。

## 8. 試用版做不到的功能（問題 8）

| 功能 | 可不可以 | 原因 | 介面上怎麼說（不放技術細節、不出現商家名字） |
| --- | --- | --- | --- |
| 發布網站 | 不行 | 需要有人能從外面連到你的網站；瀏覽器裡的資料沒有網址 | 「發布網站需要一個可以被別人連到的 Onden。試用版只在這台裝置上。」＋「搬到完整版」按鈕 |
| RSS 訂閱 | 不行（多數網站） | 瀏覽器不能跨網域抓別人的網站（網站沒允許就被擋）；也沒有背景排程 | 「訂閱需要伺服器定時去讀。」 |
| 推播／提醒通知 | 不行（頁面關閉後） | 需要伺服器推送；頁面開著時可以用頁面內提醒 | 「關掉頁面後不會提醒你，開著時會。」 |
| 外部 Claude 透過 MCP 連進來 | 不行 | 瀏覽器不接受外部連入 | 「讓你自己的 AI 連進來，需要完整版。」 |
| 多人 | 不行 | 單一裝置單一使用者 | 「試用版只有你一個人。」 |
| 圖片縮圖處理、上傳大檔 | 部分 | `sharp` 原生模組沒有；容量受瀏覽器配額限制 | 一般不用提；超量時說「這台裝置空間不夠」 |
| 以 API 金鑰從瀏覽器直接呼叫 AI | **技術上可以，建議限定「使用者自己的金鑰」** | Anthropic 在 2024-08 對 JSON API 開了 CORS，瀏覽器端要帶 `anthropic-dangerous-direct-browser-access: true`；官方 SDK 要傳 `dangerouslyAllowBrowser: true`（來源為二手：[Simon Willison](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access)、[SDK issue #248](https://github.com/anthropics/anthropic-sdk-typescript/issues/248)；**官方文件說法未查證**） | 「用你自己的 AI 金鑰。金鑰只存在這台裝置。」 |

AI 金鑰的規則（AGENTS.md）：全域金鑰、預設模型不准；伺服器版靠 `ONDEN_SECRET_KEY` 加密保存。試用版沒有伺服器，金鑰只能存在瀏覽器（明文或用使用者密碼加密，WebCrypto），風險是被同網站的腳本讀到；且 `agentRuntime/api/` 之外不得 import 模型 SDK（`harnessBoundary.test.ts` 擋）——試用版要走同一個目錄的 runtime，不是新開一條。**只能提建議**的規則照舊。要不要做是 §9 的待決定。

## 9. 建議與粗估（問題 9）

### 9.1 做不做

做，但分步，且把共用的底層做成「桌面 App 也要」的東西（兩個專案共用同一批工程）。

| 步 | 內容 | 粗估 | 與桌面 App 共用？ |
| --- | --- | --- | --- |
| 1 | **資料庫替換層**：`db.ts` 對驅動露出交易上下文、遷移來源可注入、`index.ts` 拆成 app／server；**搜尋抽象層**（§4.3）；把 `test:integration` 跑在 PGlite 上看通過率 | 2–3 週 | **是**（桌面文件的內建 Postgres 路線同樣需要搜尋抽象；PGlite 是它的備案） |
| 2 | 單分頁試用版：獨立進入點、橋（攔截 `/api/*`）、路由允許清單與「做不到」說明、持久化（先解 §3.3）、Web Locks 單分頁 | 2–3 週 | 否（橋與 UI 專屬） |
| 3 | 備份匯出入（fflate 取代 archiver／yauzl）、常駐備份提醒、PWA 離線快取 | 1–2 週 | 部分（zip 寫入器可共用） |
| 4 | 多分頁（leader worker）、使用者自己的 AI 金鑰、語意搜尋 | 視實機結果 | 否 |

（粗估是依本實驗的難度推測，未經排程驗證。）

### 9.2 待業主決定（最多 5 個，附建議）

1. **試用版要不要做、做到哪一步？** 建議：做第 1 步（因為與桌面 App 共用，風險小），第 2 步等 Tab S9 實測（§3.4 T1–T4）再決定。
2. **持久化可以接受多慢？** 實測 OPFS 約 215 ms／次寫入、IndexedDB 更慢。建議：試用版接受「儲存按鈕後確認已保存」的節奏，不追求每鍵即存；若實機太慢，改成「記憶體執行＋定期整庫存檔」，並說明最近的修改在崩潰時可能遺失。
3. **iOS 要不要支援？** Safari 不支援 `opfs-ahp`，IndexedDB 又慢且有 7 天規則。建議：第一版只承諾 Android／桌面 Chromium 系；iOS 顯示「請用完整版」。
4. **要不要在試用版開放自己的 AI 金鑰？** 建議：第一版不開，避免金鑰存瀏覽器的責任；搬到完整版後再用。
5. **試用版的網址與定位？** 建議：獨立網址或 `/try`，載入路徑獨立，不要出現在正式版選單；介面一律講「在這台裝置上試用」，不講技術名詞。

## 10. 授權（不碰 GPL／AGPL）

| 套件 | 版本 | 授權 | 依據 |
| --- | --- | --- | --- |
| `@electric-sql/pglite` | 0.5.14 | Apache-2.0（npm 中繼資料）；README 稱 Apache-2.0 與 PostgreSQL License 雙授權 | [README](https://raw.githubusercontent.com/electric-sql/pglite/main/README.md) |
| `@electric-sql/pglite-pgvector` | 0.0.15 | Apache-2.0（npm）；pgvector 本身為 PostgreSQL License | [pgvector LICENSE](https://raw.githubusercontent.com/pgvector/pgvector/master/LICENSE) |
| PostgreSQL（PGlite 內含） | — | PostgreSQL License（COPYRIGHT 檔載有條文，檔案沒寫出名稱） | [COPYRIGHT](https://raw.githubusercontent.com/postgres/postgres/master/COPYRIGHT) |
| `zone.js` | 0.16.3 | MIT（npm 中繼資料）；官方 LICENSE 檔**未查證** | — |
| `@noble/hashes` | 2.4.0 | MIT | [LICENSE](https://raw.githubusercontent.com/paulmillr/noble-hashes/main/LICENSE) |
| `buffer`、`events`、`path-browserify`、`fflate` | 6.0.3／3.3.0／1.0.1／0.8.3 | MIT（npm 中繼資料） | — |
| `hono`、`better-auth`、`kysely`（本來就在後端） | — | MIT（npm 中繼資料） | — |

## 11. 這個資料夾裡有什麼

| 檔案 | 用途 |
| --- | --- |
| `pgShim.mjs` | `pg` 的 PGlite 替身（單連線互斥鎖、交易內沿用連線、死結偵測） |
| `src/entry.ts`、`src/workerMain.ts`、`src/bridge.ts` | 試用版開機、worker 入口、fetch 橋 |
| `src/migrations.ts`、`src/pgroongaCompat.sql` | 遷移來源與擴充處理；用純 SQL 補出 `&@~` 等三個 pgroonga 介面（實驗用，循序掃描） |
| `shims/`、`nodeShims.mjs`、`esbuild-plugins.mjs` | Node 內建模組替身、不提供的套件、對 `db.ts`／`index.ts` 的實驗修補 |
| `build-node.mjs`、`smoke.mjs`、`build-browser.mjs`、`browser-run.mjs`、`scenario.mjs` | 建置與兩個環境的執行 |
| `search-bench.mjs`、`out-search.txt` | 搜尋與 pgvector 實驗及其輸出 |
