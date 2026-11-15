# 登入後的效能量測：1k／5k／20k 筆記（2026-10-21）

> 狀態：歷史紀錄（最後確認 2026-11-01）

量的是登入後的 app，用接近正式環境的資料量（1k、5k、20k 筆記），桌面 Chromium 和手機模擬各跑 5 次，取中位數。另外分析兩件事：(A) 登入頁是否先下載整個 app，(B) 發布網站的 0.95 MB JS 裡有什麼。

這份是量測和分析，沒有改產品程式。量測腳本放在 [perf-2026-10-21/](perf-2026-10-21/)。

## 摘要：影響最大的五件事

依使用者感受排序。每項的原因、修法和預期效果見後面各節。

1. **指令面板搜尋會讓整個後端卡住約 20 秒。** 只要前 50 筆結果裡有長筆記，`GET /api/nodes/search` 就要 17–25 秒（SQL 本身只要 18 ms–0.6 s）。打字時中間的查詢也會送出，所以從最後一個按鍵到出現結果，桌面中位數 40 秒，手機 46 秒；1k 筆記時，連「筆記 N」這種標題查詢也要 17–22 秒（「筆記」二字出現在每篇內文，結果裡就有長筆記）。原因是 `snippetPlainText`（packages/markdown/src/snippet.ts）逐字 `out += ch`。V8 最佳化之後，這個寫法對 node-postgres 讀出的字串變得極慢：同樣 50 筆內文（約 4 MB），第一次 25 ms，之後每次約 19 秒。Node 是單執行緒，這段時間**所有使用者**的請求都在排隊。改成陣列收集字元後，同樣的資料每次約 250 ms，輸出完全相同。修法是 S 級，見 [F1](#f1-搜尋摘要卡住後端)。
2. **20k 筆記的手機冷啟動要 8.3 秒才出現第一列，之後背景還要再下載 30 秒。** 5k 是 4.6 秒，1k 是 2.7 秒。slim bootstrap 在 20k 是 2.0 MB（gzip）／23.5 MB（原始），下載加解析 3.3 秒。畫面要等 worker 的 `persistBootstrap` 寫完才出現（桌面就要 1.5 秒）。之後又背景下載 100 批內文和 drawings（66 MB 原始），本機鏡像 DB 長到 96 MB。見 [F2](#f2-冷啟動bootstrap-太大且第一列要等寫入鏡像)。
3. **登入頁先下載整個 app：512 KB（gzip）JS，加上 143 KB 會擋住繪製的 CSS。** 手機模擬下，登入表單要 1.66 秒才出現（轉圈畫面在 0.5 秒），已登入時 app 外殼要 1.37 秒，而且三個資料量都一樣。登入前用不到的程式約佔 85–90%。字型 CSS 本來應該在首次繪製後才載入（86 KB gzip），但建置時被提到 `<head>` 成了 render-blocking 的 `<link>`。見 [(A)](#a-登入頁)。
4. **20k 的手機熱啟動（已有鏡像）要 4.0 秒。** 第一列 2.4 秒才出現，接著成員核對 gate 擋 1.6 秒；離線熱啟動 2.9 秒。`loadBootstrap` 從 sql.js 讀出全部列要 1.2 秒，main thread 的 long task 合計 1.9 秒。5k 是 2.0 秒，1k 是 1.6 秒。見 [F4](#f4-熱啟動20k-要-4-秒)。
5. **長筆記自動保存每次上傳整篇內文兩次。** 50k 字的筆記，手機上一次保存來回 0.93 秒，最後按鍵到「已保存」2.4–2.6 秒；桌面 80–105 ms。PATCH 同時帶 `markdown` 和 `base_markdown`，中文 50k 字約 2 × 150 KB。4G 上傳 3 Mbps 時，光上傳就約 0.8 秒。見 [F5](#f5-自動保存上傳整篇內文兩次)。

兩個額外問題的結論：

- **(A) 成立。** 登入頁靜態載入的 JS 是 1,527 KB 原始／512 KB gzip，跟 app 完全相同。`AppRoot` → `BuilderApp` 靜態 import 了整個工作區，`LoginGate` 只是 `BuilderApp` 裡的子元件。
- **(B) 成立。** `/site/` 的 island 載入 954 KB 原始／318 KB gzip。其中有：
  - 整份 app 介面的繁中翻譯表（`i18n.zh-TW.ts`，180 KB 原始）；
  - app 的資料層（同步引擎、寫入佇列、localDb、appStore，約 40 KB）；
  - `parse5`／`entities`（154 KB，用來處理 Markdown 裡的原始 HTML）。

  資料層是因為 `OndenQueryBlock.tsx` 從 `lib/data` barrel import 了 `reads`，整個 barrel 跟著進來。

其他次要發現：

- 側欄的本機搜尋在 20k 找不到「筆記 42」或「第 42 篇合成筆記」。前 50 筆依 FTS rank 排序，完全相同的標題沒有優先，量測腳本只好另建一篇有獨特字詞的筆記。
- slim bootstrap 的 SQL 還是 `SELECT n.*`，把全部內文讀出來排序，在 20k 用掉 20 MB 磁碟暫存，之後才在 JS 裡丟掉內文。
- 冷啟動會發 3 次 `/api/events` 和 2 次 `/api/inbox`。

## 方法

### 資料

- 三份快照：`onden_mperf_onek_test`、`_fivek_`、`_twentyk_`，在 `onden-pg-test` 上，只讀不寫。
  - 2026-10-19 手機效能那次工作用真實 API 建立（`seed.mjs`），登入帳號是 `perf-owner@example.com`。
  - 1k 有 1,032 筆、5k 有 5,032 筆。20k 是 5k 再用 SQL 複製三份標題、內文、標籤和屬性（`clone.sql`），共 20,029 筆。所以 20k 的連結（10,206）和事件數跟 5k 一樣。
- 內容：
  - 一般筆記約 300 字，有標題、清單、待辦，以及一個連到上一篇的 `[[連結]]`。
  - 每 50 篇有一篇約 24k 字的「長筆記」，另有一篇 184k 字的「超長筆記 3」。
  - 每 200 篇有一篇帶 `ink_data` 的手寫筆記。
  - 共 30 個標籤；屬性有狀態、優先、截止。
- 用 `pg_dump` 匯出，再還原到本次 stack 自己的 postgres（`onden_p1k`／`onden_p5k`／`onden_p20k`）。開機時 backend 會把 migration 從 122 套到 124。
- 只在這些副本裡加了：
  - 「效能長筆記」：50,067 字；
  - 「效能樞紐筆記」：用 API 讓 300 篇筆記的內文連到它，所以它有 300 個反向連結；
  - 20k 另加一篇「效能短筆記」，見限制。
- 沒有新建帳號：快照裡的 perf-owner 就是工作區的 owner。

### 環境

- 這次 worktree 的 main（d7e8b88e，等於正式環境的 dc6a4c52 加上之後只改測試的 commit）。
- 用 `compose.e2e.yaml` 加 override 起一個 stack（:5095，`ONDEN_TIMEZONE=Asia/Taipei`），nginx gzip 設定與 repo 相同。
- 主機：16 核、7.6 GB RAM，量測期間只開這一個 stack。

### 裝置

- **桌面：** Chromium，1440×900，不降速。
- **手機模擬：**
  - 390×844、isMobile、觸控；
  - CDP CPU 4× 降速；
  - 網路 150 ms RTT、下載 9 Mbps、上傳 3 Mbps。
- service worker 開啟，跟正式環境一樣，離線熱啟動需要它。

### 次數

- 每個「資料量 × 裝置」跑 5 次，每次都是全新的瀏覽器 context。
- 表格是中位數，括號是最小值到最大值。

### 流程（每次）

1. **冷啟動：** 已登入但儲存空間是空的，開 `/?view=notes`，等本機鏡像不再成長（每 3 秒檢查一次）。
2. **熱啟動：** 同一個 context，開新分頁。
3. **開三篇筆記：** 用側欄搜尋找到後點開，計時到編輯器裡出現該筆記的文字。三篇分別是短筆記、50k 字、300 反向連結。
4. **打字：** 在 50k 字的筆記末尾打 43 個字。每個 keydown 計時到下一個 frame，同時記錄自動保存的請求。
5. **指令面板搜尋（Ctrl+K）：** 兩個查詢：
   - 一篇筆記的標題；
   - 常見詞「演算法 期中」。
6. **同步：** 另一個 API session 修改「筆記 100」，計時到這個頁面的 worker 套用 delta（`applySync`）。
7. **離線熱啟動：** context 設為 offline，開新分頁。

### 量測點

- **shell：** `#app-initial-loading` 被移除。
- **第一列：** 出現 `.obsidian-page-row`。
- **usable：** 有列，而且沒有 `.membership-gate`、工作區不是 inert。
- **long task：** `PerformanceObserver('longtask')`。
- **heap：** CDP `Runtime.getHeapUsage`。
- **worker 時間：** 包住 `Worker.postMessage` 量 RPC 來回。
- **網路大小：** CDP 的 `encodedDataLength`（壓縮後），以及 `dataReceived`（原始）。

### 伺服器端

- backend log 的 `[http] METHOD path status ms`。
- postgres `log_min_duration_statement=100`（只設在這個 stack）。
- 超過 200 ms 的 SQL 用 `SET jit=off`（同 backend 的連線設定）跑 `EXPLAIN (ANALYZE, BUFFERS)`。

## 量測結果

### 桌面 Chromium（不降速）

| 指標 | 1k | 5k | 20k |
|---|---|---|---|
| **冷啟動** | | | |
| shell 出現 (ms) | 136 | 165 | 162 |
| 第一列／可操作 (ms) | 703 (668–833) | 1,837 (1,706–2,291) | 4,170 (3,435–4,228) |
| initLocalDb (ms) | 149 | 182 | 190 |
| bootstrap 壓縮後／原始 | 539 KB／6.6 MB ¹ | 930 KB／8.3 MB | 2,020 KB／23.5 MB |
| bootstrap 下載時間 (ms) | 346 | 489 | 1,587 |
| 之後背景下載內文＋drawings（原始） | 0.9 MB | 17.0 MB（26 批） | 66.1 MB（100 批） |
| 冷啟動 API 總傳輸（壓縮後） | 749 KB | 2.4 MB | 7.9 MB |
| 鏡像寫完（usable 之後, ms） | 3,025 | 6,053 | 12,126 |
| 本機鏡像 DB 大小 | 5.5 MB | 24.2 MB | 95.6 MB |
| long task 到 usable（最長, ms） | 96 | 168 | 222 |
| long task 含背景寫入（總和, ms） | 174 | 251 | 815 |
| JS heap：usable 時／寫完後 (MB) | 18／30 | 36／19 | 60／36 |
| **熱啟動（有鏡像）** | | | |
| 第一列 (ms) | 370 | 603 | 1,282 |
| 可操作 (ms) | 662 | 953 | 1,949 |
| 成員核對 gate 持續 (ms) | 298 | 334 | 685 |
| initLocalDb／loadBootstrap (ms) | 92／88 | 131／258 | 241／793 |
| long task 總和 (ms) | 138 | 175 | 511 |
| JS heap (MB) | 13 | 20 | 54 |
| 離線熱啟動 可操作 (ms) | 512 | 762 | 1,555 |
| **切換筆記（點下→編輯器出現內容）** | | | |
| 短筆記 (ms) | 141 | 240 | 見 ² |
| 50k 字長筆記 (ms) | 103 | 185 | 306 |
| 300 反向連結筆記 (ms) | 76 | 157 | 208 |
| 　反向連結卡片出現 (ms) | 80 | 170 | 215 |
| 切換時最長 long task (ms) | 0–80 | 76 | 132 |
| **打字（50k 字筆記）** | | | |
| input→paint 中位數／p95／最大 (ms) | 11／14／15 | 12／15／18 | 13／17／18 |
| 自動保存：最後按鍵→送出 (ms) | 1,444 | 1,457 | 1,496 |
| 自動保存：請求來回 (ms) | 80 | 89 | 105 |
| **指令面板搜尋（最後按鍵→出現結果）** | | | |
| 標題查詢 (ms) | **16,951** (208–17,386) ³ | 126 | 128 |
| 常見詞「演算法 期中」(ms) | **42,235** | **39,852** | **39,965** |
| **同步** | | | |
| 遠端編輯→本頁套用 (ms) | 339 | 411 | 483 |
| delta 請求數／傳輸 | 7／1.6 KB | 7／1.6 KB | 7／1.6 KB |

¹ 1k 不到 2,000 筆，所以走完整 bootstrap（含內文）。5k、20k 走 slim（`?bodies=none`，加 `X-Onden-Bootstrap: lean`）。
² 20k 時，側欄搜尋找不到「筆記 42」，見[次要發現](#次要發現)。改用另建的「效能短筆記」量，結果見下方〈20k 短筆記〉。
³ 第 1 次只要 208 ms，第 2–5 次都在 16.9–17.4 秒：backend 熱起來以後才慢，原因見 F1。

### 手機模擬（390×844、CPU 4×、150 ms RTT、9 Mbps 下載／3 Mbps 上傳）

| 指標 | 1k | 5k | 20k |
|---|---|---|---|
| **冷啟動** | | | |
| shell 出現 (ms) | 1,372 | 1,377 | 1,373 |
| 第一列／可操作 (ms) | 2,700 (2,686–2,770) | 4,625 (4,557–4,727) | **8,300** (8,295–8,477) |
| initLocalDb (ms) ⁴ | 212 | 224 | 245 |
| bootstrap 下載時間 (ms) | 892 | 1,327 | 3,264 |
| 鏡像寫完（usable 之後, ms） | 6,040 | 9,119 | **30,453** |
| long task 到 usable：總和／最長 (ms) | 437／300 | 629／453 | 911／715 |
| long task 含背景寫入（總和, ms） | 601 | 1,045 | 2,333 |
| JS heap：usable 時 (MB) | 14 | 24 | 59 |
| 冷啟動 JS（壓縮後） | 499 KB | 499 KB | 499 KB |
| **熱啟動（有鏡像）** | | | |
| 第一列 (ms) | 1,044 | 1,389 | 2,441 |
| 可操作 (ms) | 1,602 | 2,006 | **4,043** |
| 成員核對 gate 持續 (ms) | 555 | 611 | 1,602 |
| initLocalDb／loadBootstrap (ms) ⁴ | 176／116 | 204／394 | 346／1,177 |
| long task 總和 (ms) | 416 | 690 | 1,900 |
| JS heap (MB) | 14 | 15 | 63 |
| 離線熱啟動 可操作 (ms) | 1,147 | 1,502 | 2,864 |
| **切換筆記** | | | |
| 短筆記 (ms) | 368 | 484 | 見 ² |
| 50k 字長筆記 (ms) | 414 | 362 | 752 |
| 300 反向連結筆記 (ms) | 128 | 267 | 623 |
| 　反向連結卡片出現 (ms) | 132 | 377 | 726 |
| 切換時最長 long task (ms) | 274 | 223 | 371 |
| **打字（50k 字筆記）** | | | |
| input→paint 中位數／p95／最大 (ms) | 22／27／38 | 25／34／51 | 27／36／55 |
| 自動保存：最後按鍵→送出 (ms) | 1,528 | 1,610 | 1,722 |
| 自動保存：請求來回 (ms) | **931** | **934** | **935** |
| 自動保存：最後按鍵→已保存 (ms) | 2,389 | 2,467 | 2,584 |
| **指令面板搜尋** | | | |
| 標題查詢 (ms) | **22,263** | 269 | 269 |
| 常見詞「演算法 期中」(ms) | **47,770** | **46,607** | **46,337** |
| **同步** | | | |
| 遠端編輯→本頁套用 (ms) | 473 | 482 | 512 |

⁴ worker 不受 CDP 的 CPU 降速影響（見限制）。手機上 worker 的時間應該再乘以約 3–4。

### 20k 短筆記（補量）

用另建的「效能短筆記」量，每種裝置 5 次。這次是在冷啟動 usable 後 8 秒點開，背景的內文下載仍在進行，所以和上表的情況不完全相同。

| 裝置 | 冷啟動後開短筆記 (ms) |
|---|---|
| 桌面 | 260（247–293） |
| 手機模擬 | 735（690–798） |

### 和 2026-10-19 的手機量測比較

10-19 的量測沒有寫進 repo；結果在那次 session 的暫存資料。比較時要注意兩次的網路條件不同：那次是 1.6 Mbps 下載，這次是 9 Mbps，所以只能看大方向。

| 項目 | 10-19（1.6 Mbps） | 今天（9 Mbps） |
|---|---|---|
| 20k 冷啟動 | 64–77 秒 | 8.3 秒 |
| 20k 熱啟動 | 17 秒 | 4.0 秒 |

在這兩天之間合併的相關改動：membership digest（#453）、reopen 改用 delta（#454）、lean bootstrap 與 `/api/sync/drawings`（#455）、寫入日誌（#450）。

### 伺服器端：最慢的 API

下表是 20k、10 次執行（桌面 5 次加手機 5 次）的 backend log，依 p95 排序。

| 路由 | 次數 | p50 (ms) | p95 (ms) | 最大 (ms) |
|---|---|---|---|---|
| GET /api/nodes/search | 30 | 20,134 | 47,462 | 48,034 |
| GET /api/bootstrap | 22 | 1,339 | 1,452 | 1,982 |
| GET /api/sync/membership/digest | 20 | 234 | 361 | 361 |
| GET /api/inbox | 70 | 93 | 241 | 250 |
| GET /api/events | 170 | 105 | 184 | 289 |
| POST /api/sync | 60 | 35 | 163 | 186 |
| PATCH /api/nodes/:id | 20 | 79 | 159 | 159 |

5k 時，search 的 p50 是 19.7 秒，bootstrap 381 ms。1k 時，search 的 p50 是 21.7 秒。

超過 200 ms 的 SQL 只有兩種。EXPLAIN 的完整輸出不放進文件，重現方式見腳本目錄。

- **search SQL（20k，「演算法 期中」）：**
  - 不開 JIT 時 627 ms，JIT 開著則是 1,055 ms。
  - 因為條件是 `(title &@~ q OR markdown &@~ q)` 再加上可讀範圍，planner 選了 Seq Scan，對 20k 列逐列套用 pgroonga 運算子。
  - 合成資料裡幾乎每篇都含這兩個詞（19,999 列符合），這是最壞情況。真實資料符合的列少，會比較快。
  - 但這 0.6 秒和 F1 的 20 秒比起來不是主因。
- **bootstrap 的節點查詢（`WITH evt_meta …`，20k）：**
  - EXPLAIN 是 300 ms，app 裡 500–790 ms，多出來的是傳輸寬列的時間。
  - 主要成本是 `SELECT n.*`：連 slim 模式都讀出全部 markdown，並依 `sort_order, created_at` 排序，`Sort Method: external merge Disk: 20304kB`。
  - 改成只選需要的欄位，排序就能留在記憶體，傳輸量也大幅下降。

## 發現與建議

### F1 搜尋摘要卡住後端

**現象：**

- 指令面板查詢的 SQL 在 18 ms 內完成（5k 時用 `log_min_duration_statement=0` 確認過），之後 backend CPU 100%、約 17–20 秒才回應。
- 這期間 Node 的 event loop 被佔滿，其他使用者的請求都在排隊。
- 打字時每段停頓都會送一次查詢，前一次還在算，後一次就排在後面，所以最後按鍵到結果是 40–47 秒。

**原因：**

- CPU profile（對 backend 送 SIGUSR1 後用 inspector 取樣）：`snippetPlainText` 自身佔 15.1 秒，GC 佔 4.7 秒。
- 呼叫路徑：`services/nodeSearch.ts`（最多 50 筆）→ `snippetAround` → `snippetPlainText`（`packages/markdown/src/snippet.ts`）。
- 函式逐字執行 `out += ch` 組出整篇內文的純文字，即使最後只用第一個命中前後 120 字。
- 用 backend 容器裡的 node-postgres 讀同樣 50 列重現：

| 輪次 | snippetPlainText（50 列） |
|---|---|
| 第 1 輪 | 25 ms |
| 第 2–4 輪 | 18,954／18,990／20,856 ms |

- 同樣的字串從 JSON.parse 來就不會變慢。這看起來是 V8 最佳化後，對這種字串的逐字串接掉進 slow path。
- 這解釋了為什麼新開的 backend 第一次搜尋很快，第二次以後就慢；正式環境的 backend 長時間執行，也會在這個狀態。
- 本機 sql.js worker 的離線搜尋（`localDbWorker.ts` 的 `searchNodes`）也用同一個 `snippetAround`，可能有同樣的問題，這次沒有量。

**修法（S）：**

1. 把 `snippetPlainText` 改成以陣列收集，或以 `slice` 收集連續片段，最後一次 `join`。
   - 一次性實驗只改了 `out` 的收集方式，輸出逐字相同。
   - 50 列從約 19 秒降到 241–261 ms，且之後每輪都穩定。
2. 進一步：
   - 先在原始 markdown 找第一個命中，只把前後幾千字轉成純文字，`fold()` 也只處理這個窗口；
   - 或者 SQL 只回傳 `left(markdown, N)` 或命中附近的片段。
   - 這樣 50 列預計可以降到數十 ms，也不必把 4 MB 內文從 Postgres 搬到 Node。
3. 加一個回歸測試：同一行程連續跑 3 輪，用 200 KB 內文，限制時間。

**預期：** 搜尋從 17–47 秒降到 0.2–0.4 秒，也解除後端被卡住的風險。這是本報告投資報酬最高的一項。

### F2 冷啟動：bootstrap 太大，且第一列要等寫入鏡像

**現象：** 手機模擬 20k 的冷啟動第一列在 8.3 秒：

1. 1.37 秒時 shell 出現；
2. bootstrap 下載 3.3 秒；
3. main thread 解析 23.5 MB JSON；
4. `withAttrsFromRows` 重建每個節點的 attrs；
5. structured clone 傳給 worker；
6. `persistBootstrap` 寫進 sql.js（桌面 1.5 秒，手機要更久）；
7. 回傳投影，`setData`，然後第一列出現。

usable 之後，背景再用 100 次 `POST /api/sync/bodies` 和 `/api/sync/drawings` 下載 66 MB 原始資料。鏡像要再 30 秒才寫完，最後 96 MB。

**原因與資料（20k、lean slim bootstrap 的組成，原始大小）：**

| 部分 | 大小 | 說明 |
|---|---|---|
| nodes | 14.5 MB（20,030 筆，約 725 B／筆） | 下方列出的欄位 |
| attributes | 6.1 MB（44,994 列，約 136 B／列） | 每篇都有「狀態」「優先」，各 2.7 MB |
| edges | 2.8 MB | |

nodes 裡值得注意的欄位：

| 欄位 | 大小 | 說明 |
|---|---|---|
| `label_tag_ids` | 1.4 MB | |
| `workspace_id` | 1.0 MB | 每列都一樣 |
| `space_id` | 1.0 MB | |
| `recent_actors`／`last_actor`／`last_modified_at` | 共 1.7 MB | |
| `deleted_by_event_id` | 0.5 MB | 全部是 null |
| `tag_is_inheritable` | 0.5 MB | 幾乎全部是 null |
| `collection_views` | 0.5 MB | 幾乎全部是 null |
| `source_type` | 0.45 MB | |

另外：

- 後端是先 `SELECT n.*`（含全部 markdown），再在 JS 把 markdown 換成空字串（`services/sync/bootstrap.ts` 第 262 行附近）。
- 前端的 `fetchBootstrap` 在 main thread `res.json()`，`refresh` 等 `persistBootstrap` 完成才 `setData`（`lib/data/syncEngine.ts`）。

**修法：**

1. **bootstrap 欄位瘦身（M）：**
   - slim 模式的 SQL 只選需要的欄位，不選 markdown；
   - 省略 null 和工作區常數欄位（`workspace_id`、`deleted_by_event_id`、null 的 `tag_is_inheritable`／`collection_views`）；
   - attributes 改成以節點分組的緊湊格式。
   - 估計原始大小可以減少 35–45%，解析時間和 worker 寫入時間大致等比例下降。
   - 要同步調整前端型別，舊客戶端相容可以沿用 `X-Onden-Bootstrap` header 分版本。
2. **先畫再寫（M，需要設計）：**
   - 用下載的 payload 先渲染清單，`persistBootstrap` 在背景完成。
   - 難點是 `persistBootstrap` 會回傳「套用了待送請求後的投影」（第十七、二十四批的契約）。
   - 冷啟動時可以先讀一次 pending（通常是空的），在 main thread 套用同一個 `pendingNoteProjection`，或者先畫、等投影回來再調和。
   - 預期手機 20k 第一列從 8.3 秒降到約 5–6 秒（少掉 worker 寫入加兩次 clone）。這是估計值，沒有實測。
3. **背景下載（S–M）：**
   - 背景的內文和 drawings 下載是設計上的離線預備，但 20k 的 66 MB 加上 96 MB 鏡像，對手機的流量和儲存都很重。
   - 可以考慮只預載最近 N 天或最近開過的內文，其餘在開啟時讀取（已有 lazy 路徑）。
   - 這是產品取捨，要使用者決定離線範圍。

### F3 登入頁與第一次載入（即問題 (A)）

見 [(A)](#a-登入頁)。修法是把 `LoginGate` 和工作區拆成兩個 chunk，加上字型 CSS 不擋繪製，S–M。

### F4 熱啟動：20k 要 4 秒

**現象：** 手機模擬 20k 的熱啟動：

| 階段 | 時間 |
|---|---|
| 第一列出現 | 2.4 秒 |
| 成員核對 gate 持續 | 1.6 秒 |
| `loadBootstrap`（worker 讀出全部節點、邊、屬性） | 1.2 秒 |
| 第一個 `getPendingWrites` 排在它後面 | 0.9 秒（桌面） |
| long task 總和 | 1.9 秒 |

**原因：**

- `loadBootstrap` 一次讀出整個工作區給 main thread；之後 Redux 的整份 `setData` 造成多個 long task。
- gate 在 digest 請求（`/api/sync/membership/digest`，20k 時 234 ms）和 `?nodes=none` 回來前不會解除，手機上還要加網路 RTT。

**修法（M–L）：**

- `loadBootstrap` 分兩段：先讀清單需要的欄位（標題、父層、排序、標籤），其餘在閒置時讀。
- 讓 worker 的讀取不必排在其他 RPC 後面。
- gate 的 digest 請求可以和 `loadBootstrap` 並行發出（目前看起來是先後執行；需要再確認 `useWorkspaceLive` 的順序）。

**預期：** 20k 手機熱啟動從 4.0 秒降到約 2.5 秒（估計）。

### F5 自動保存上傳整篇內文兩次

**現象：**

- 50k 字的筆記，手機上一次保存的請求來回 0.93 秒（三個資料量都一樣，所以跟筆記數無關），桌面 80–105 ms。
- 最後按鍵到送出是 1.45–1.72 秒：800 ms debounce 加上 writer 的排程。

**原因：** `PATCH /api/nodes/:id` 帶完整的 `markdown`，也帶完整的 `base_markdown`，讓伺服器做三方合併（`routes/nodes.ts`、`services/nodeUpdate.ts`）。上傳速度是瓶頸，正文越長越慢。

**修法（M）：**

- 改送基準版本的識別（例如 `updated_at` 或版本 ID），伺服器從自己的歷史取出 base。只有找不到時才要求客戶端補送。
- 或者送 diff。
- 這個改動牽涉寫入契約（`docs/architecture/note-writes.md`），要照 AGENTS.md 先比較兩種設計。

**預期：** 長筆記手機保存從 0.9 秒降到約 0.2–0.3 秒。短筆記影響很小。

### 次要發現

- **側欄本機搜尋的排序：**
  - 20k 時，搜尋「筆記 42」或「第 42 篇合成筆記」，前 50 筆都不是那篇筆記（截圖顯示的是「筆記 19988」等）。
  - 原因：`localDbWorker.ts` 的 `searchNodes` 對每個詞做前綴比對、`ORDER BY rank LIMIT 50`，完全符合的標題沒有加權。
  - 指令面板的伺服器搜尋在 20k 也沒有把「筆記 42」排進前面。
  - 修法（S）：標題完全相同或以查詢開頭的先排。
- **slim bootstrap 的 SQL 讀全部內文：** 見上方〈伺服器端〉，修法併入 F2-1。
- **啟動時的重複請求：**
  - 每次啟動發 3 次 `/api/events`（NOTIFICATION、ATTRIBUTE_CONFLICT、BODY_CONFLICT）和 2 次 `/api/inbox`。
  - 20k 時各約 100–250 ms，不在關鍵路徑上，但手機上都要多付 RTT。
  - 可以合併成一個摘要端點（S）。
- **打字：** 50k 字的筆記，手機模擬的 input→paint 中位數 22–27 ms，最大 55 ms，在可接受範圍。CodeMirror 對長文沒有明顯問題。
- **切換筆記：** 手機 20k 開 50k 字筆記 752 ms、300 反向連結 623 ms（反向連結卡片 726 ms），還可以接受。切換時最長的 long task 有 371 ms，值得之後用 profile 看是哪個 render。
- **同步：** 遠端編輯到本頁套用 0.34–0.51 秒，delta 很小（1.6 KB），不需要處理。

## (A) 登入頁

**結論：成立，登入前就下載整個 app。**

靜態 import 的封閉集合（從建置後的 `index.html` 的 island `component-url`、`renderer-url` 和 inline script 出發，只算靜態 import，不算 `import()`）：

| chunk | 原始 | gzip | 內容 |
|---|---|---|---|
| SiteTemplate.*.js | 764 KB | 257 KB | app 與網站共用的 chunk：Markdown 管線、i18n 表、資料層、範本 |
| AppRoot.*.js | 535 KB | 181 KB | BuilderApp、工作區 hooks、側欄、頂欄、appStore… |
| client.*.js | 176 KB | 55 KB | React DOM |
| transform、index、其他 | 52 KB | 19 KB | |
| **合計** | **1,527 KB** | **512 KB** | 與正式環境量到的 1.5 MB 相符 |

**原因：**

- `src/pages/index.astro` 只掛一個 `<AppRoot client:only="react" />`。
- `components/AppRoot.tsx` 靜態 import `BuilderApp`；`BuilderApp.tsx` 靜態 import 約 40 個工作區 hooks 和元件，以及 `lib/data`、`appStore`。
- `LoginGate` 是 `BuilderApp` 回傳樹裡的子元件（`<LoginGate>…</LoginGate>`），所以還沒登入時，整個工作區的模組都已經下載並執行了。

**可以延後多少：**

- 登入前真正需要的是 React DOM（55 KB gzip）、`LoginGate`、`ServerSetup` 和 auth client（估計 15–25 KB gzip）。
- 約 430–440 KB gzip（85–90%）可以等登入後再載入，或在登入頁閒置時 prefetch。

**CSS：**

- `<head>` 裡有四個 render-blocking 樣式表，合計 143 KB gzip：

| 樣式表 | gzip |
|---|---|
| `fonts-noto.css` | 86 KB |
| `index.css`（global） | 31 KB |
| `AppRoot.css` | 17 KB |
| `SiteTemplate.css` | 9 KB |

- `index.astro` 的 inline script 用 `void import("../styles/fonts-noto.css")`，註解說是「首次繪製後才載入」。但 Astro／Vite 建置時，把它提到 `<head>` 成了 `<link rel="stylesheet">`，所以它其實會擋住繪製，註解的意圖沒有達成。

**修法：**

1. **拆 chunk（S–M）：**
   - 做法一：`AppRoot` 只放 `LoginGate` 和 `ServerSetup`，登入後用 `lazyWithReload(() => import("./BuilderWorkspace"))` 載入工作區。
   - 做法二：反過來，讓 `LoginGate` 在 `BuilderApp` 外層，用 `React.lazy` 包工作區。
   - 要確認 `bootApp()` 的副作用（現在在 `AppRoot` 載入時執行）哪些登入前就需要。
   - 已登入的使用者冷啟動會多一個 chunk 往返。可以在 `LoginGate` 確認 session 的同時開始載入工作區 chunk，抵銷這個成本。
2. **字型 CSS 不要擋繪製（S）：**
   - 改用 `public/` 下的獨立檔案，並由 inline script 在 `load` 事件後插入 `<link>`；
   - 或者用 `media="print" onload="this.media='all'"`。
   - 並確認 `scripts/check-app-css.mjs` 的檢查仍然通過。
3. `SiteTemplate.css` 不應該出現在 app 頁的 `<head>`；它跟 (B) 的共用 chunk 是同一個問題。

**預期：**

- 登入頁 JS 從 512 KB 降到約 70–80 KB gzip，擋繪製的 CSS 從 143 KB 降到約 57 KB gzip。
- 手機 4G 下，登入頁 FCP 估計可以提早 0.3–0.6 秒；目前的量測見下表。

登入頁（未登入、全新 context）在本次 stack 的實測：

| 裝置 | FCP（轉圈畫面） | LCP（登入表單） | 請求數 | JS | CSS | 字型 |
|---|---|---|---|---|---|---|
| 桌面 | 60 ms | 188 ms | 23 | 513 KB | 143 KB | 327 KB |
| 手機模擬 | 500 ms | **1,660 ms** | 23 | 513 KB | 143 KB | 327 KB |

（大小是壓縮後的傳輸量，5 次中位數。）手機上，從轉圈畫面到出現登入表單的 1.2 秒幾乎都是在下載和執行登入前用不到的 JS。登入頁也下載了 327 KB 的 Noto 字型切片。

## (B) 發布網站

**結論：成立，app 的程式碼和整份翻譯表進到了網站。**

`/site/` 由 Astro SSR 產生，以 `SiteTemplateIsland`（`client:idle`）hydrate，載入的靜態集合是：

- `SiteTemplate.*.js`：764 KB 原始／257 KB gzip；
- `client.*.js`（React DOM）：176 KB／55 KB；
- 其他小檔：14 KB。

合計 954 KB 原始／318 KB gzip，與正式環境量到的 0.95 MB 相符。

`SiteTemplate.*.js` 是 app 和網站共用的 chunk。用字串探測正式建置的檔案，裡面有：

- `/api/sync/bodies`（同步引擎）；
- `addPendingWrite`、`Idempotency-Key`（寫入佇列）；
- `localDbWorker` 的 URL；
- 指令面板的文字；
- 約 2.5 萬個中文字（翻譯表）。

另外用 `vite.published.config.ts` 加 `--sourcemap` 建置一次，按 sourcemap 把位元組歸到原始檔。這是可以靜態託管的匯出版，入口是 `src/published/main.tsx`，共 891 KB：

| 來源 | 大小 | 應該在網站裡嗎 |
|---|---|---|
| `lib/i18n.zh-TW.ts` | 180 KB | **不應該**：整個 app 的翻譯表，網站只用到少數字串 |
| react-dom | 177 KB | 需要（可以考慮 Preact） |
| parse5 + entities | 154 KB | 部分需要：Markdown 內 raw HTML（`hast-util-raw`）；SSR 已經渲染過 HTML，hydrate 時可以不必再解析 |
| `lib/data/*`（canvasWriter、noteWriter、tagWriter、writeQueue、writeRecovery、workspaceWriter、nodeMutations、reads…）、`lib/localDb.ts`、`lib/appStore.ts`、`lib/api.ts` | 約 40 KB | **不應該**：app 的資料與寫入層 |
| `lib/serverErrors.ts`、`lib/shortcuts.ts`、`lib/prefs.ts`、`components/ui/Modal.tsx` | 約 18 KB | **不應該** |
| micromark／mdast／hast／unified 系列 | 約 100 KB | 視情況：只有在客戶端還要重新渲染 Markdown 時才需要 |
| 範本（`components/templates/*`）、`MarkdownRenderer`、`@onden/markdown` | 約 60 KB | 需要 |

**原因：**

1. `components/OndenQueryBlock.tsx` 第 12 行 `import { reads } from "../lib/data"`。barrel 帶進全部 writer、`writeQueue`、`localDb`、`appStore`、`api`。網站的 query block 是發布時凍結的快照（D113），用不到 `reads`。
2. `lib/i18n.ts` 靜態 import `ZH_TW`（第 17 行），而範本用 `useT()`。網站只要範本會用到的字串，或者依 `siteLocale` 動態載入。
3. 共用 chunk：Vite 把 app 和網站都用的模組放進同一個 `SiteTemplate` chunk，所以 app 那一側的東西（例如 `reads` 帶進來的資料層）也跟著到網站。反過來，`SiteTemplate.css` 也出現在 app 頁的 `<head>`。

**修法：**

| 項目 | 等級 | 做法 | 預期節省 |
|---|---|---|---|
| 1 | S | `OndenQueryBlock` 改從 `lib/data/reads` 直接 import，或把 live 查詢的部分拆成 app 專用元件，網站只用 `FrozenQueryResult`。加一個測試：網站入口的 import 圖裡不可以有 `lib/data`（仿照 `test/workerImports.test.ts`）。 | 約 60 KB 原始 |
| 2 | M | 翻譯表拆檔：範本用的字串放一個小表，app 的表在 app 入口載入。 | 約 170 KB 原始／40–50 KB gzip |
| 3 | M | 確認網站 hydrate 是否真的需要在客戶端重跑 Markdown 管線。如果 SSR 輸出已經完整，island 只需要互動部分（導覽、搜尋、手寫顯示），可以省掉 micromark 和 parse5 系列。 | 約 250 KB 原始 |

合計可能把網站 JS 從 318 KB gzip 降到約 120–150 KB gzip。這是估計值。

/site/ 在本次 stack 的實測（沒有發布內容，所以是空網站，JS 量和正式環境相同）：

| 裝置 | FCP／LCP | 請求數 | JS | CSS | 字型 |
|---|---|---|---|---|---|
| 桌面 | 80 ms | 10 | 318 KB | 37 KB | 46 KB |
| 手機模擬 | 436 ms | 10 | 318 KB | 37 KB | 46 KB |

網站的首次繪製不受 JS 影響，因為內容由 SSR 輸出，island 是 `client:idle`。318 KB JS 的成本是流量，以及閒置後 hydrate 時手機 CPU 的負擔。

## 建議先做的三件事

1. **F1 搜尋摘要（S）：** 改 `snippetPlainText` 的字串收集方式並限制處理範圍。代價最小、影響最大，而且能避免一個使用者搜尋就讓所有人卡 20 秒。
2. **(A) 登入頁拆 chunk 加字型 CSS 不擋繪製（S–M）：** 每個新裝置、每次登入都受益。順便處理 (B) 的 `OndenQueryBlock` import，兩者都是同一個共用 chunk 的問題。
3. **F2-1 bootstrap 欄位瘦身（M）：** slim SQL 不選 markdown，加上去掉 null 和常數欄位。對 5k、20k 的冷啟動、每日完整重新整理和伺服器負擔都有幫助，而且不需要改動寫入或同步的契約。

## 限制

- **模擬不是真機：**
  - CPU 4× 降速只套在頁面的 main thread。CDP 對 dedicated worker 回應 `Operation is only supported for pages, not workers`，所以 sql.js worker（initLocalDb、loadBootstrap、persistBootstrap、搜尋）是以主機全速執行。真機上這些時間應該再乘以 3–4。
  - 網路是 Chromium 的節流，沒有真實 4G 的抖動和丟包。
  - 沒有量 iOS Safari／WKWebView 和 Android WebView，也沒有量記憶體壓力下分頁被回收的情況。
- **資料是合成的：**
  - 20k 是 5k 複製三份，連結和事件沒有跟著複製。
  - 常見詞查詢在合成資料裡幾乎每篇都符合，是 SQL 的最壞情況；F1 的 JS 問題和這無關，只要結果裡有長筆記就會發生。
  - 真實工作區的屬性、標籤和反向連結分布不同，bootstrap 的組成比例會跟著改變。
- **伺服器是本機：**
  - 量測的 stack 在同一台主機上，沒有 Tailscale／VPS 的距離和 TLS。
  - 正式環境 VPS 的 CPU 不同；F1 的 20 秒在較慢的 CPU 上可能更長。
  - 這次沒有去正式環境重現 F1（沒有正式帳號的搜尋權限，也不應該在正式環境讓後端卡住 20 秒），但正式環境是長時間執行的同一份程式，應該會遇到同樣的情況。建議修好後再用一個 200 KB 內文的回歸測試確認。
- **side effect：**
  - 同步量測會修改「筆記 100」，每次附加一行。
  - 打字量測會讓「效能長筆記」每次多 43 字。
  - 這些都只發生在本次的副本裡，量完已經刪除。
- **沒有量的項目：**
  - Lighthouse 分數；
  - 白板、圖譜、PDF 等重量級 lens；
  - 多分頁同時開啟；
  - 有大量待送請求時的啟動；
  - 匯入。
- **(A)／(B) 的組成分析：**
  - 用正式建置的 chunk 加字串探測，以及另外用 `vite.published.config.ts` 帶 sourcemap 的建置。
  - Astro app 建置帶 sourcemap 失敗了（主 checkout 的 node_modules 比 main 舊，缺 `@fontsource-variable/noto-serif-tc`），所以 app 側沒有精確到檔案的歸屬。

## 重現

腳本在 [perf-2026-10-21/](perf-2026-10-21/)，用法寫在各腳本開頭的註解。shell 腳本要設定 `REPO_ROOT`（repo 位置）和 `PERF_DIR`（腳本目錄）；Node 腳本要能解析 `@playwright/test`，例如把 `packages/frontend/e2e/node_modules` 連結到腳本旁邊：

| 腳本 | 用途 |
|---|---|
| `measure.mjs` | 主要量測：冷啟動、熱啟動、開筆記、打字、搜尋、同步、離線 |
| `aggregate.mjs` | 產生本文的表格 |
| `loggedout.mjs` | 登入頁和網站的 FCP／LCP 與 chunk 清單 |
| `graph.mjs` | 建置後 chunk 的靜態 import 封閉集合 |
| `mapsize.cjs` | 依 sourcemap 歸屬位元組 |
| `bootcomp.mjs` | bootstrap 組成 |
| `routes.mjs` | backend log 依路由彙總 |
| `pgloop.mjs`、`pgfix.mjs` | 在 backend 容器內重現 F1，並驗證修法 |
| `prep.mjs` | 在副本加入長筆記和樞紐筆記 |
| `compose.perf.yaml`、`usedb.sh`、`restore.sh`、`dump.sh` | stack 與資料 |
