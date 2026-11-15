# 本機資料庫增量保存：這次做了什麼、OPFS 留待之後（2026-10-19）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

手機效能報告第 5 點（本機 DB 每次整份序列化）的後續。這次出貨的是寫入日誌加合併保存；sqlite-wasm＋OPFS 寫成計畫，沒有出貨。

## 選項評估

### (a) @sqlite.org/sqlite-wasm＋OPFS：這次不做

| 問題 | 說明 |
|---|---|
| 多分頁 | 不需要 COOP/COEP 的 VFS 只有 `opfs-sahpool`，它獨佔資料庫檔：第二個分頁打不開。Onden 每個分頁各開一個 worker，要先做分頁間的單一擁有者（Web Locks 選主，加 BroadcastChannel 或 SharedWorker 轉送 RPC）。 |
| 跨來源隔離 | `opfs` VFS 需要 SharedArrayBuffer，也就是全站 COOP/COEP。外部嵌入和 Puck 的遠端 CSS 會壞。 |
| iOS WKWebView、Android WebView | 這台機器測不到真機。WKWebView 在 capacitor:// 這類自訂 scheme 下的 OPFS 支援不明，需要真機驗證。 |
| 大小 | sqlite3.mjs 壓縮後仍遠超過 worker 的 91 KiB 預算，要拆成另一個 chunk；wasm 約 850 KB（sql.js 是 645 KB）。service worker 要預快取新的 wasm，cache 名稱要升版。 |
| 改動面 | worker 約 950 行、localDbPersist／localMirror 等模組，以及約 15 個測試檔都直接用 sql.js 的 API。 |

### (b) 保留 sql.js、存 page 差異：做不到

sql.js 1.14 沒有對外提供 Emscripten 的 FS，拿不到 page 層級的寫入；唯一的讀取方式就是 `db.export()`。要做到就得 patch sql.js 的打包檔。

### 這次出貨：(b) 的寫入日誌部分，加上 (c)

- **寫入日誌：** 需要立刻落地的變更，改成在另一個 IndexedDB 資料庫（`onden-journal`）寫一筆小紀錄，RPC 等這筆紀錄 commit 就回應，不再等整份 export。包括：排隊的寫入、它被拒絕或移除、刪除筆記、刪除畫布。
- **合併保存：** 整份快照改成之後再存，當作 compaction：日誌 15 秒沒有新紀錄、或累積 200 筆時存一次。快照存好後刪掉它已包含的紀錄。
- **(c)：** 一次保存就是一次 export，不會再一筆寫入兩次。關頁或切到背景時，只在有鏡像變更（同步、bootstrap、內文下載）時才存整份。

## sqlite-wasm＋OPFS 的計畫

1. **分頁擁有者：** 用 `navigator.locks` 選出一個擁有 DB 的分頁，其他分頁經 BroadcastChannel 把 RPC 轉給它。這一步跟 OPFS 無關，sql.js 也受益：目前兩個分頁各存各的快照，最後存的覆蓋前一個。
2. **引擎介面：** 在 worker 裡把 `qry`／`run`／`exec` 收成一個小介面，讓 sql.js 和 sqlite-wasm（oo1 API）都能接上。測試繼續用 sql.js 在 Node 跑。
3. **OPFS 路徑：**
   - 有 `FileSystemSyncAccessHandle` 時，用 `opfs-sahpool` VFS。
   - 首次啟動時，把 IndexedDB 快照加上日誌重播後的內容 `importDb` 進 pool。
   - 確認讀得回來，才在 sync_state 標記已遷移。舊快照保留一個版本，供回滾。
4. **備援：** 沒有 sync access handle、或 pool 開啟失敗時，回到 sql.js＋IndexedDB＋日誌（也就是這次的實作）。
5. **Service worker：** 預快取 `sqlite3.wasm`，離線時一樣有備援，cache 名稱從 onden-v5 升到 v6。
6. **驗證：**
   - 在 Android 真機或 WebView 上用 `chrome://inspect` 量 worker 端的時間。
   - iOS Safari 和 Capacitor iOS 要測 OPFS 是否可用、清除網站資料後的行為，以及背景被殺之後是否保有資料。
   - 這次沒有做，因為手上沒有真機。

## 量測（這次的改動）

- **方法：** 用 Playwright Chromium 跑打包後的 worker，搭配真的 sql.js wasm 和真的 IndexedDB。資料是 perf 工作區的真實 bootstrap：5k 是完整 payload；20k 是 slim 加上全部內文。
- **未降速：** worker 不吃 CDP 降速，手機上大約要 ×3–4。
- **峰值記憶體：** renderer 行程的 VmHWM 減去量測前的 RSS。

| 指標 | 5k 前 | 5k 後 | 20k 前 | 20k 後 |
|---|---|---|---|---|
| 本機 DB 大小 | 23 MB | 23 MB | 81.7 MB | 81.7 MB |
| 排隊寫入一筆（中位數） | 98–110 ms | 1 ms | 155 ms | 1–2 ms |
| 先改鏡像再排隊寫入（自動保存的情況，中位數） | 231 ms（兩次 export） | 2 ms | 308 ms | 1 ms |
| 10 筆排隊寫入期間的峰值記憶體增加 | 34–141 MB | ≈0 | 258–340 MB | ≈0 |
| 關頁或切背景（有鏡像變更）時的保存 | 99–122 ms，峰值增加 67–72 MB | 82 ms，峰值增加 72 MB | 165 ms，峰值增加 258 MB | 149 ms，峰值增加 258 MB |
| 重開（含重播日誌） | 130–198 ms | 131–154 ms | 170 ms | 183 ms |

整份快照本身（compaction、bootstrap 之後、關頁時有鏡像變更）的成本沒有變：sql.js 只能整份 export。要讓這部分也變成增量，就是上面 OPFS 的計畫。
