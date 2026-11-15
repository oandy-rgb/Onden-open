# 瀏覽器版：不用伺服器的試用版（第 2、3、4 批）

> 狀態：現行（最後確認 2026-11-02；盲測修正批見 §16）。第 2 批（能用）、第 3 批（可以給朋友用，§12）與第 4 批（圖片與檔案，§14）已實作並測試（Chromium 桌機與手機視窗實跑；WebKit／iOS 沒有跑，原因見 §15）。
> 地基是[可攜後端](portable-backend.md)（第 1 批，PR #1157）；實驗與數字的來源是 [browser-trial](../research/browser-trial/README.md)。
> iPhone 真機要做的檢查：[browser-app-ios-checklist.md](browser-app-ios-checklist.md)。第 4 批做了圖片與檔案（§14）；沒做的（WebKit 實跑等）在 §15。

打開一個靜態網址，就有一個完整、能寫筆記的 Onden：後端是同一套 `packages/backend` 的 `app`，跑在這個頁面的 Web Worker 裡，
資料庫是 PGlite；資料只存在這個瀏覽器。正式伺服器的行為與正式版的開機 JS 預算都沒有改動。

## 1. 架構

```
頁面（packages/frontend/src/browserApp/）                      Worker（packages/backend/src/browser/worker.ts）
┌──────────────────────────────────────┐   postMessage     ┌───────────────────────────────────────────────┐
│ BrowserAppShell                      │  ───────────────▶ │ 一個串行佇列 queue.ts                          │
│  1. Web Locks：同時只有一個分頁       │  {request id,     │   ├ 每個 /api 請求 ─▶ 本機登入的 cookie ─▶ app.fetch │
│  2. 啟動 worker，等 ready             │   method, path,   │   ├ 週期工作（任務排程、工作區時鐘…）           │
│  3. installFetchBridge：/api/*、/health│   headers, body}  │   └ 存檔（saveLoop）                           │
│     與 EventSource 換成走 worker      │ ◀─────────────── │ PGlite（記憶體）← 首次：snapshot.tar.gz         │
│  4. 載入同一個 AppRoot                │  head/chunk/end   │                  ← 之後：OPFS／IndexedDB 的副本  │
│ TrialNotice：「試用版」標示、備份、   │                   │ snapshotStore：OPFS（優先）／IndexedDB／無       │
│   清範例、重新開始                    │                   └───────────────────────────────────────────────┘
└──────────────────────────────────────┘
建置（scripts/build-browser.mjs）：snapshot（Node 先套完遷移）＋ worker.js（esbuild，Node 模組換替身）＋ 頁面（vite）→ packages/frontend/dist-browser
```

| 檔案 | 責任 |
| --- | --- |
| `backend/src/browser/worker.ts` | Worker 入口：開機（開庫、遷移、本機登入、範例筆記）、訊息、回應。所有請求與週期工作都經 `queue` |
| `backend/src/browser/env.ts`、`hostSetup.ts` | 在 import `db.ts` 之前設環境（`setEnvironment`）、裝串行 context provider、遷移來源、週期工作的佇列 |
| `backend/src/browser/queue.ts` | 串行佇列：請求、週期工作、存檔一次只跑一個（可攜後端 §3 的前提） |
| `backend/src/browser/saveLoop.ts`、`snapshotStore.ts` | 何時存、存到哪（§4） |
| `backend/src/browser/localSession.ts` | 單一本機使用者：worker 自己登入，替每個請求補 session cookie |
| `backend/src/browser/sampleNotes.ts` | 範例筆記與「清掉」（筆記永久刪除；標籤放進垃圾桶：App 從不永久刪除標籤定義） |
| `backend/src/browser/unavailable.ts` | 試用版沒有的功能（§7） |
| `backend/src/browser/prepareSnapshot.ts` | 建置時在 Node 上先套完遷移，輸出 `snapshot.tar.gz` |
| `backend/browser-shims/` | 打包時的 Node 替身（`node:crypto`、`archiver`→fflate、`buffer`…），不屬於 `src/` |
| `markdown/src/browserBridge.ts` | 頁面與 worker 的訊息型別（兩邊共用，型別而已） |
| `frontend/src/browserApp/`、`frontend/src/lib/browserAppWorker.ts`、`lib/browserAppBridge.ts` | 頁面這一端：`browserAppWorker`（訊息→`Response`）、`browserAppBridge`（fetch／EventSource／下載連結；放在 `lib/` 是因為 `window`／`document` 的主人是 `lib/`）、`BrowserAppShell`、`TrialNotice` |
| `frontend/vite.browser.config.ts`、`browser.html` | 獨立的頁面建置（與 Astro 的正式版、Capacitor 的 `vite.capacitor.config.ts` 都分開） |

## 2. fetch 橋：為什麼放在頁面的 fetch，不用 Service Worker

選頁面的 fetch 層（`window.fetch` 與 `EventSource` 換成走 worker），理由：

1. **Service Worker 會被瀏覽器隨時停掉**（閒置幾十秒就停），而資料庫必須一直活在記憶體裡；SW 頂多是另一跳，真正握著資料庫的仍是 Dedicated Worker。多一跳＝多一種「SW 睡著了」的失敗。
2. 前端所有讀寫本來就走 `lib/api`、better-auth client、`downloadBlob` 這幾個地方，攔 `fetch` 一處就全涵蓋；`/api/events/stream`（SSE）換成 `EventSource` 的替身，讀同一座橋的串流，**不改前端任何呼叫端**。
3. 部署只需要靜態檔，不需要 SW 的註冊範圍與路徑（第 3 批的 PR 預覽網址在子路徑，SW scope 會多一個麻煩）。

代價與缺口：瀏覽器自己發出的請求（`<img src="/api/media/…">`、`<a href download>`）看不到 `window.fetch`。
`<a download>` 已處理（`lib/browserAppBridge.ts` 在 capture 階段攔下，經橋取回後交給瀏覽器下載）；圖片與檔案第 3 批不行，所以當時關閉上傳。
第 4 批才加了 Service Worker，**而且只用來轉 `GET /api/media/*`**（§14）；上面第 1、3 點的理由對「資料庫與 /api」仍成立，所以 /api 照舊走頁面的 fetch。

細節：

- **瀏覽器禁止的標頭**：頁面不能送 `Cookie`；Worker 裡的 `Request` 會丟掉 `cookie`／`origin`。`localSession.ts` 用 `Proxy` 把 `headers` 換成含 session cookie 與 `origin` 的 `Headers`（一般 `Headers` 接受任何名稱）。
- **登入**：試用版只有一個人，沒有登入畫面。快照裡已有本機帳號；worker 開機後自己登入（密碼固定、不是祕密：帳號只在這個瀏覽器的資料庫裡，能讀到密碼的程式碼本來就能讀資料庫）。每次啟動換新的 session 簽章密鑰（`env.ts`）；請求遇到 401（session 過期）會重新登入並重送一次。「登出」被擋下（回成功但什麼都不做），免得把人鎖在自己的筆記外。
- **SSE**：`/api/events/stream` 的回應是串流；worker 在佇列**外**讀它（它只轉發記憶體裡的通知，不碰資料庫），每個片段轉給頁面，`EventSource` 替身解析 `data:` 行。
- **回應**：非串流的回應在佇列裡讀完整個 body 才送出，所以匯出 zip 這類「讀 body 時才查資料庫」的回應也在序列之內。

## 3. 一個佇列，一個分頁

- 所有 `/api` 請求、週期工作（`useJobRunner`，`backgroundJobs.ts` 唯一的新增）、存檔都進同一個 `queue`；這是可攜後端 §3 說的「串行堆疊 context provider 夠用的前提」。
- **同時只有一個分頁**：頁面以 Web Locks 搶 `onden-browser-app-owner`，搶不到的分頁顯示「已在另一個分頁開啟」（兩個 worker 寫同一份副本會互相蓋掉）。沒有 Web Locks 的舊瀏覽器直接繼續（兩個分頁時最後存的贏）。
- 啟動的週期工作只有：工作區時鐘、dispatcher catch-up、任務模組的排程（週期任務滾動）。**沒有**：outbox（git／GitHub 備份）、RSS 抓取、推播提醒、事件修剪。

## 4. 持久化：記憶體優先，整份副本定期存到 OPFS／IndexedDB

實驗（[browser-trial §3.3](../research/browser-trial/README.md)）量到 PGlite 直接用 `opfs-ahp://` 首次建庫 13.5 秒、`idb://` 38 秒，Safari 又不支援 `opfs-ahp`。
所以 PGlite 一律跑在記憶體，**整個資料庫的副本**（`dumpDataDir`）寫進瀏覽器的儲存空間：

| 儲存空間 | 何時用 | 做法 |
| --- | --- | --- |
| OPFS | 有 `navigator.storage.getDirectory()` 且能建立 sync access handle（Chromium、Firefox、Safari 15.2+ 的 Worker） | 兩個槽位 `slot-a`／`slot-b` 輪流寫，最後才更新指標檔 `current`（槽位大小、類型）；寫到一半掛掉，指標仍指向上一份完整的。**未壓縮**的 tar（約 60 MiB，製作約 0.2 秒），所以存檔短 |
| IndexedDB | OPFS 不能用（舊 Safari、部分無痕視窗、被拒）；測試用 `?store=indexeddb` 在任何瀏覽器強制走這條路 | 單一 `put`（原子），存 gzip 的副本（約 6 MiB，製作約 1 秒；IDB 寫大值慢，所以壓縮） |
| 無 | 兩者都不行 | 介面直說「這個瀏覽器沒有提供保存的地方，請下載備份」；從不宣稱已保存 |

**何時存**（`saveLoop.ts`）：每個可能寫入的工作之後，以 `txid_snapshot_xmax`（只有寫入交易才會增加）判斷資料庫有沒有真的變動；變動後 **0.5 秒沒有新變動就存**，連續變動最久 **10 秒**內一定存，沒存的修改累積到 **100 筆**也立刻存（`MAX_UNSAVED_CHANGES`，同時限制重開要重放的日誌長度）。時間或筆數到了的那一次存檔**插在還在排隊的請求前面**（`queue.runNext`，只等正在跑的那一個）：2026-11-12 量到，頁面一次丟 300 個請求不等回答時，排在隊尾的存檔等了 80 秒以上、一份都沒存；
重放日誌時開啟畫面顯示「恢復 N 筆中的第幾筆」（worker 的 `replay-progress` 訊息）。純讀的 `POST /api/sync` 不進日誌（以前它永遠不會被裁掉，每次重開都「recovered 1」並多存一份完整副本）。
頁面隱藏或關閉時（`onPageHide`：`pagehide`＋`visibilitychange`）立刻存。「已保存」只在儲存空間真的收下副本、而且存的期間沒有新變動時才成立（有單元測試）。

**最多可能丟多少**（第 3 批之後；寫入日誌見 §12.2）：

| 情況 | 可能丟 | 為什麼 |
| --- | --- | --- |
| 正常關分頁、重新整理、切到別的 App | **0**（日誌有收到、頁面也回「已存」的修改） | 每個寫入請求在後端執行**之前**先記進 IndexedDB 日誌，記好才回答頁面；下次開機把副本之後的日誌重放（冒煙測試必過項：丟掉頁面的「立刻存檔」訊息、馬上重新整理，修改仍在） |
| 瀏覽器行程被殺（iOS 背景被系統回收、當機、斷電） | 日誌已寫入磁碟的都在；**最多丟瀏覽器還沒把日誌交給磁碟的最後一次修改**（IndexedDB 的 `durability: "strict"` 要求寫入前不回覆；Safari 忽略這個選項，所以 iOS 上這句話是「盡力」，要實機檢查，見 iOS 清單第 3、4 項） | 日誌是 IndexedDB；斷電時是否真的落盤由瀏覽器與作業系統決定 |
| 單一請求內容超過 16 MiB（日誌不收） | 該次修改在下一份副本之前（**最多約 10 秒**）若行程被殺就會丟；頁面狀態的 `journalSkipped` 會記次數，診斷資訊也列出 | 日誌不存大內容；一般筆記遠小於此 |
| 瀏覽器沒有 IndexedDB 可用（極少數無痕模式） | 回到第 2 批的數字：修改後立刻關頁可能丟最後 0.5～約 1 秒；行程被殺最多約 10 秒＋一份副本的寫入時間 | 沒有日誌，只剩整份副本；診斷資訊的「修改紀錄」寫「關」 |
| 重放時某個請求被後端拒絕（例如重放時目標已不存在） | 那一項；伺服器回 4xx 的視為原本就被拒絕（不算遺失），只有 5xx 或例外才算「無法套用」，會在開機時回報（`recoveryFailed`） | 重放是依目前狀態再跑一次，沒有保證每一項都能成功 |
| 還原備份剛結束就關頁 | **0**（盲測修正批起）：還原結束時 worker 在持有佇列的同一個工作內存一份副本（`saveLoop.flushInJob`），頁面的進度查詢排在後面，所以聽到「完成」時結果已在瀏覽器的儲存空間 | 還原的各步驟不進日誌（上傳只存在記憶體，重放時找不到），所以靠這份「結束時存一次」，不靠 0.5 秒的閒置存檔 |
| 清除網站資料、換瀏覽器／裝置、Safari 7 天沒互動的 ITP 清除 | **全部**（沒有伺服器副本；日誌與副本都在同一個瀏覽器的儲存空間裡） | 所以「下載備份」常駐、會提醒（§12.3）；介面不叫它「已同步」 |

第 2 批的寫法（沒有日誌時）留作對照：修改後立刻重新整理，Chromium 實測會丟那次修改；2 秒後重新整理則保住。

副本讀不出來（損毀）時**不會**默默換成預設資料庫：開機失敗並顯示訊息，由「重新開始」明確清掉。

頁面這一端的本機副本（`lib/localDb` 的 sql.js 鏡像）照正式版的方式運作，但它是**第二份**：worker 若從較舊的副本還原，頁面鏡像的游標會比伺服器新；正式版對「伺服器退回」本來就有處理（`landBootstrap` 的 `rewound`），所以沿用，不另外關掉。「重新開始」會一併刪掉頁面的 IndexedDB。

## 5. 預先遷移好的快照：首次開啟不跑遷移

`prepareSnapshot.ts` 在建置時用 Node 跑完全部遷移與 better-auth 的表、建立本機帳號、關掉需要網路的模組，輸出 `snapshot.tar.gz`（gzip，約 5.5 MiB）。
首次開啟時 worker 從它還原，**不跑 150 支遷移**（實驗量到記憶體建庫＋遷移約 3.6–4.0 秒）。之後的新版若多了遷移，worker 仍內嵌了遷移 SQL，開機時先在記憶體裡對已存的副本補跑，成功並存好新副本才取代舊的；失敗、或副本比程式新，都不動舊副本（§12.1）。

首次開啟（`e2e/browser-app/measure.mjs`：本機 Chromium headless、無 HTTP 快取、靜態檔不經壓縮傳輸，重複兩次的結果相差 < 5%）：

| 項目 | 首次開啟（用打包好的快照） | 第二次開啟（讀 OPFS 副本） |
| --- | ---: | ---: |
| worker 準備好（載入 wasm、還原資料庫、本機登入、放範例筆記或讀副本、第一次存檔） | 約 **2.0 秒** | 約 1.2–1.4 秒 |
| 第一則筆記出現在畫面上（含頁面 JS 載入、`AppRoot` 啟動、第一次同步） | 約 **4.0 秒** | 約 3.2 秒 |
| 下載（gzip，127 個檔） | 14.4 MiB | 8.9 MiB（其中快照 5.4 MiB 不再下載，其餘在真實瀏覽器會來自 HTTP 快取） |

對照：沒有快照時，實驗（browser-trial §3.2）量到「記憶體建庫＋套 150 支遷移」就要 3.6–4.0 秒，worker 到可回應約 4.0–4.5 秒；
這一批沒有另外量「不用快照」的版本（沒有保留那條路徑），所以這個對照是實驗當時的數字，環境類似（同類雲端容器的 Chromium），不是同一次量測。
數字來自雲端容器的 headless Chromium，**不是手機**；Tab S9／iPhone 的實測仍待做（browser-trial §3.4 的清單）。

## 6. 上傳檔案與圖片：第 2、3 批關閉，第 4 批打開（見 §14）

第 2 批的結論是「關閉」：圖片是用 `<img src="/api/media/…">` 讀的（瀏覽器自己發的請求，fetch 橋看不到）、後端縮圖用 `sharp`（瀏覽器沒有）、檔案要與副本和備份一起設計。
當時 `POST/PUT/PATCH/DELETE /api/media` 在 worker 入口回 501 `browser_app_unavailable`。第 4 批把三件事都補上（Service Worker 只轉 `GET /api/media/*`、檔案放 OPFS／IndexedDB、縮圖改用瀏覽器的 canvas），
入口那條規則已移除；做法、取捨與每個「如果是試用版」的分岔見 §14。

## 7. 各模組在試用版的狀態

| 模組／功能 | 狀態 | 怎麼做的 |
| --- | --- | --- |
| 筆記、標籤、連結、搜尋（可攜搜尋）、歷史與復原、垃圾桶 | **可用** | 同一套後端；搜尋見可攜後端 §4 |
| 任務、日記、複習、白板、表格／看板／月曆／圖庫、簡報、關係圖、收件匣、匯入器 | **可用** | 同一套後端 |
| 稍後閱讀 | 可存網址；**抓網頁標題不可用** | `/api/bookmark` 回 `browser_app_unavailable`（瀏覽器不能跨網域讀別人的頁面） |
| 技能（skills，AI 用）、外部行事曆（external_calendars） | **預設關閉** | 快照裡 `modules_off = [skills, external_calendars]`；後端自己的閘門回 `module_not_imported`（`moduleOffNoTrace`：關著不留痕跡）。擁有者仍可在設定打開，但它們需要網路，會失敗；外部行事曆的抓取迴圈在試用版不啟動 |
| AI（`ai` 模組）、RSS、發布網站、語意搜尋 | **預設關閉**（需擁有者一次同意的 `confirmOnce` 模組，試用版從不問） | 新工作區本來就關著（遷移 159：只有已用 AI 的工作區才開）；發布另需 `pagefind`／`simple-git`／`@octokit`，打包時換成「被用到才說沒有」的替身；AI 與 MCP 的路由由 AI 模組自己的閘門擋（409 `module_not_imported`）；API 金鑰的 AES 加密（`createCipheriv`）不提供 |
| 推播提醒 | **沒有** | `/api/push` 回 `browser_app_unavailable`；提醒迴圈沒有啟動 |
| 上傳檔案、圖片、音檔、PDF | **可用**（第 4 批） | 貼上、拖放、「上傳檔案」、手機拍照／選圖、白板上的圖；存在瀏覽器的檔案空間（§14） |
| 匯出 | **可用** | 下載完整備份（`/api/backup/full.zip`）、單篇匯出；zip 由 `archiver` 的 fflate 替身在 worker 裡做（`browser-shims/archiver.mjs`） |
| 還原備份 | **可用**（第 3 批；設定 › 資料與備份） | 後端原本的上傳→預覽→套用流程，上傳暫存換成記憶體檔案系統（§12.3）。含圖片或檔案的備份**一併還原檔案**（第 4 批；第 3 批時會被拒絕） |
| 多人、邀請、帳號設定 | **沒有意義**（一個人） | 登出被擋下；沒有登入畫面 |

## 8. 建置與大小

```bash
npm run build:browser        # 根目錄；產出 packages/frontend/dist-browser（純靜態，任何靜態主機都能放，相對路徑，子路徑也行）
npm run build:browser -- --tag=<版本標籤> --report-url=<回報位址>   # 兩個參數都可省略（§12.6）；另會寫 build.json（§12.5）
```

- 三步：Node 上先套遷移並輸出 `snapshot.tar.gz`（`prepareSnapshot.ts`）→ esbuild 把 `worker.ts` 打包成 `worker.js`（`node:*` 換成 `browser-shims/`）→ vite 用 `vite.browser.config.ts` 建頁面，再把 PGlite 的 wasm／資料／擴充複製進去。
- **正式版不受影響**：頁面是獨立的 vite 設定與 `browser.html`，不經 Astro，也不進 `scripts/check-boot-bundle.mjs`；正式版沒有任何新的 import（`browserApp/` 只被 `browser.html` 用，守門 `browserApp.guard.test.ts` 釘住）。`npm run build` 照舊通過。
- 唯一碰到共用程式的地方：`localDbWorker.ts` 找 `sql.js` 的路徑（瀏覽器版放在頁面資源旁邊、正式版不變）、`db.ts`／`dbPglite.ts`／`backgroundJobs.ts`／`config.ts` 各一個注入點（`useDatabaseSnapshot`、`useJobRunner`、`setEnvironment`）。

首次開啟要下載的東西（gzip，靜態主機的壓縮傳輸；`measure.mjs` 實測請求 127 個檔）：

| 檔案 | gzip |
| --- | ---: |
| `snapshot.tar.gz`（預先遷移好的資料庫） | 5.4 MiB |
| `pglite.wasm`（Postgres） | 3.1 MiB |
| `pglite.data`（Postgres 的檔案系統映像） | 2.0 MiB |
| `pgcrypto.tar.gz` | 1.1 MiB |
| `worker.js`（後端＋150 支遷移 SQL） | 1.1 MiB |
| 頁面 JS／CSS／字型（開機會用到的） | 約 1.2 MiB |
| `media-sw.js`（Service Worker，第 4 批） | 1.4 KiB |
| sql.js（頁面的離線鏡像，兩個 wasm 檔共約 0.6 MiB，實際只下載一個） 與其他小檔 | 約 0.6 MiB |
| **首次開啟合計**（127 個檔） | **14.4 MiB**（第 3 批後 `worker.js` 多約 5 KiB gzip：日誌、升級檢查、記憶體檔案系統與 zip 讀取；其餘沒變） |
| 整個資料夾（第 4 批後、已合併當時的 `origin/main`：493 個檔，gzip 合計 19,057,031 B ＝ 18,610 KiB，比第 3 批多 9 KiB，其中新增一個檔案 `media-sw.js` 1.4 KiB；`worker.js` gzip 1,248,051 B） | 18.17 MiB |
| 整個資料夾（含按需才載入的圖表、PDF、簡報等） | 18.16 MiB（第 3 批後 493 個檔，gzip 合計 18,601 KiB，比第 2 批的 18,594 KiB 多約 7 KiB；未壓縮約 38.7 MiB） |

`pgcrypto` 只有 3 支遷移的 trigger 用到 `digest()`，Postgres 內建 `sha256()` 可取代，能省 1.1 MiB；那要改遷移，需另外設計，這批沒做。

## 9. 驗證

### 第 4 批（2026-11-01，雲端容器，圖片與檔案）

測試一律用瀏覽器版的資料庫（`ONDEN_DB_DRIVER=pglite`）跑。

| 項目 | 結果 |
| --- | --- |
| `backend`、`frontend`：`tsc --noEmit`、`lint` | 通過 |
| `backend` 整套：`ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test npx vitest run --maxWorkers=3` | **562 個檔通過、7 個檔整檔跳過（資料庫以外的條件）；5221 個測試通過、0 失敗、88 個跳過、7 個預期失敗**（全在 PGlite 上跑，約 30 分鐘） |
| `frontend` 整套 `npx vitest run --maxWorkers=2` | **799 個檔、7584 個測試通過**、0 失敗（2 個預期失敗、4 個跳過） |
| `markdown` 整套 | **95 個檔通過；1309 個測試通過**、1 個預期失敗 |
| `npm run build`（正式版；`check-app-css`、`check-worker-bundle`、開機預算） | 通過；開機 JS **持平**（合併當時的 `origin/main` 之後整體是 432.5 KiB gzip／預算 432.6 KiB，增加的部分來自 main）：與 PR 合併 main 之前的基底（第 3 批分支）逐 chunk 比較（建置輸出的精度是 0.1 KiB），只有 `BuilderWorkspace` 這一個 chunk 的數字不同（原始 +242 B，`gzip -9` **−16 B**；原始增加的是「這次更新」那一則說明與句子改短之差）；預算 432.6 KiB（443,000 B）不動 |
| 根目錄：`dup:check`、`dup:names`、`dup:near:check`、`ratchet:check`、`changes:check`、`check-md-links` | 通過 |
| 新的單元測試 | `mediaFiles.test.ts`（儲存接口的約定，同一組測試跑「磁碟」與「IndexedDB」兩個實作：寫入全有或全無、串流來源中途失敗不留檔、位元組範圍、列表／用量／清除）、`browserMediaStorage.test.ts`（OPFS 的配額錯誤→`MediaStorageFull`且不留半個檔、估計剩餘空間不足就先拒絕、沒有儲存空間）、`browserImageCodec.test.ts`（檔頭判斷格式、要求解碼器套用 EXIF 旋轉、縮小不放大、不能寫 WebP 時改 JPEG／PNG 且副檔名跟著）、`mediaStorageFull.integration.test.ts`（空間不夠→507、沒有檔案、沒有上傳者紀錄）、`browserAppMedia.test.ts`（前端：子路徑位址還原、Range 轉發、304／HEAD 無 body、worker 失敗→502、只回應自己的訊息）、`browserSaveLoop`（`stop()`）、`browserJournal`／`browserUnavailable`（上傳不進日誌、不再被擋） |
| **冒煙 e2e**（`smoke.mjs`）Chromium 桌機（OPFS） | **62/62** |
| 冒煙：Chromium 手機視窗（Pixel 5 模擬） | **63/63** |
| 冒煙：Chromium 強制 IndexedDB（`--store indexeddb`） | **62/62** |
| 冒煙：WebKit（Desktop Safari）、mobile-safari | **沒有跑**：SKIPPED，瀏覽器下載不了（§15） |
| 圖片項目（每個引擎都跑） | 全新設定檔的**第一次開啟**，Service Worker 已接管；貼圖（桌機）或上傳（手機）→ 筆記裡的 `<img>` 真的載入（`naturalWidth > 0`）→ 筆記與圖片都已存檔 → 重新整理後圖片仍載入 → 相機旋轉的 JPEG 存成轉正的 200×300 WebP → 不認識的副檔名被拒絕 → Range 請求回 206 → 不存在的檔案 404 → 瀏覽器自己的 `Image` 請求經 Service Worker 載入 → 其他請求（`favicon.svg`）不受影響 → 備份的 zip 有 `attachments/` → 重新開始後檔案數是 0 → 還原後檔案回到儲存空間、筆記裡的圖片載入 → 子路徑（`/onden-trial/`）下上傳並載入圖片 |
| 同時發現並修好的 | (1) 重新開始與存檔搶時間：重新開始時若剛好有一份副本在寫，寫完的指標會指向已被刪掉的檔案，下次開不起來（「試用版打不開」）。現在重新開始先 `saveLoop.stop()`（等進行中的寫入完成、不再存）再清除。(2) 第 3 批的冒煙在手機視窗找不到帳號選單、且「資料只存在這個瀏覽器」那一行已改位置（8eda1258），測試已跟著改。(3) 「這次更新」小卡片會蓋住對話框，測試會先關掉它。 |

### 第 3 批（2026-11-01，雲端容器，已合併 `origin/main`、`npm ci` 之後）

| 項目 | 結果 |
| --- | --- |
| `backend`：`tsc`、`lint` | 通過 |
| `backend`：新測試 `browserJournal`（日誌、`judgeSchema`、哪些請求進日誌）、`browserRestoreGate`、更新後的 `browserSaveLoop`／`browserUnavailable`；守門 `dup-b2-responses`（R10：開機失敗不用新的 `extends Error`）、`importCycles`（只有 `app`、`server`、worker 與快照工具能 import `modules/`） | 通過 |
| `backend` 整套，`ONDEN_DB_DRIVER=pglite` 且**未**設 `DATABASE_URL`（有 DB 的測試檔因此自行跳過）：5290 個測試 | 2539 通過、0 失敗、2750 跳過（343 個檔整檔跳過） |
| `backend` 整套，`ONDEN_DB_DRIVER=pglite DATABASE_URL=…`（第 1 批的方式，需約 50 分鐘） | （寫文件時還在跑，結果見 PR 說明） |
| `frontend`：`tsc`（只剩 `origin/main` 本來就有的 `backupFile.ts` 的 `yauzl` 型別錯誤）、`lint`（`--max-warnings 0`）、完整 vitest（795 個檔）、`npm run build`（`check-app-css`、`check-worker-bundle`、開機預算 **430.4 KiB gzip／預算 432.6 KiB**） | 7532 通過、0 失敗；lint、build 通過 |
| `frontend` 新測試：`browserAppBackup`（提醒條件、診斷文字不含 id／網址、最近問題）、守門 `browserRelease.guard`（掃描與發布腳本，10 個）、`entrypointsCatalog`、`wording`（「保存」改「儲存」）、`allowlist`（`<a>` 改 `Link`）、`browserApp`（環境變數名稱不與正式版的旗標混）、`tasks-time`（不手算天數） | 通過 |
| `markdown`：完整 vitest | 1309 通過、1 預期失敗 |
| 根目錄：`dup:check`、`dup:names`、`dup:near:check`、`ratchet:check`、`changes:check`、`check-md-links` | 通過 |
| 發布前掃描（`npm run scan:browser`）對真實的建置結果 | 416 個文字檔，沒有發現私密（排除項與理由見 §13） |
| `deploy:browser --dry-run` 與實際複製到 `/tmp` 的資料夾 | 493 個檔案、`.nojekyll` 寫在根目錄；沒有 push |
| **冒煙 e2e 42 項**（`smoke.mjs`）：Chromium 桌機（OPFS） | 42/42 |
| 冒煙：Chromium 手機視窗（Pixel 5 模擬） | 42/42 |
| 冒煙：Chromium 強制 IndexedDB（`--store indexeddb`，Safari 沒有可用 OPFS 時走的路） | 42/42（第一次跑有 1 項失敗，原因是測試腳本：應用程式自己的重新載入會把測試旗標從網址拿掉，使「重新開始」之後走了預設的 OPFS；已改成重新帶旗標開啟，不是產品問題） |
| 冒煙：WebKit（Desktop Safari）、mobile-safari | **沒有跑**：SKIPPED，瀏覽器下載不了（§14） |
| 冒煙另外列出、**沒有涵蓋**的 | 貼圖後重新整理圖還在（沒有做圖片，§14）；日誌在 Safari 上的落盤（要實機，iOS 清單） |

冒煙 42 項涵蓋：開啟、寫筆記、重新整理後還在、**丟掉頁面的存檔訊息後立即重新整理仍在（必過）**、連續兩次寫入不重複、2 秒後重新整理、說明頁與診斷資訊不含筆記內容、清範例、匯出、**備份→重新開始→還原→筆記回來並已儲存**、**舊 schema 副本升級（筆記都在、新副本取代舊的、再開不再升級）**、**比程式新的副本被拒絕且不動**、**升級失敗時保留舊副本並可下載**、**子路徑**、**新建置的重新載入提示（與同版不提示）**、無腳本錯誤。

### 第 2 批（留作對照）

| 項目 | 結果（2026-11-01，雲端容器） |
| --- | --- |
| `backend`：`tsc`、`lint`；新單元測試 `browserQueue`、`browserSaveLoop`、`browserUnavailable`、守門 `portableBackend`（含「不把模組自己的 `../index.js` 當成舊 `index.ts`」的修正）、`importCycles` | 通過 |
| `backend` 整套（`ONDEN_DB_DRIVER=pglite`，第 1 批的方式）：5278 個測試 | 5159 通過、88 跳過（第 1 批的 `needs*` 標記）、24 失敗：全在 AI／MCP 相關的 8 個檔與上面兩個守門——原因是 PGlite 測試範本沒有像共用 Postgres 那樣讓預設工作區同意 `ai` 模組（main 新增的模組，已在 `globalSetup.ts` 補上），以及 main 新增的 `ai.test.ts` 讓舊守門誤判；修正後這 10 個檔重跑全過（沒有整套重跑第二次） |
| `frontend`：`tsc`、`lint`、完整 vitest、`npm run build`（含 `check-app-css`、`check-worker-bundle`、開機預算：429.8 KiB gzip／預算 432.6 KiB） | lint、vitest、build 通過；`tsc` 在 `origin/main` 本身就有 `backend/src/services/backupFile.ts` 的 `yauzl` 型別錯誤（前端的 `moduleDefinitionsAlign.test.ts` 把後端模組帶進型別檢查），這批沒有新增；其餘無錯 |
| `markdown`：完整 vitest | 1309 通過 |
| 根目錄：`dup:check`、`dup:names`、`dup:near:check`、`ratchet:check`、`changes:check`、`check-md-links` | 全部通過 |
| Chromium 冒煙（`smoke.mjs chromium`）：開啟→建立筆記→（等存檔）重新整理後還在→2 秒後重新整理還在→清範例（筆記永久刪除、標籤進垃圾桶，自己的筆記不動）→匯出 zip→無腳本錯誤 | 12/12；「修改後立即重新整理」只回報、不要求（§4）。強制 IndexedDB（`--store indexeddb`）通過 5 次、間歇失敗 2 次（失敗的是「新筆記進資料庫」，同一支腳本再跑即過；原因沒查明，疑似負載高時的時序） |
| Chromium 手機視窗（`smoke.mjs mobile-chrome`，Pixel 5 模擬） | 12/12（手機走底部「捕捉」建立筆記） |
| WebKit／mobile-safari | **沒有跑**（§10） |

## 10. 第 2 批時沒做到、沒跑的（第 3 批的狀況見 §15）

- **WebKit／mobile-safari 沒有跑**：這個雲端環境的網路規則擋住 Playwright 的下載主機（`cdn.playwright.dev`、`playwright.download.prss.microsoft.com` 都回 403 `request blocked`），`npx playwright install webkit` 失敗，所以沒有 WebKit 瀏覽器可用。冒煙腳本已支援（`node e2e/browser-app/smoke.mjs webkit`、`mobile-safari`；瀏覽器啟不起來時回報 SKIP，不假裝通過），第 3 批在可下載的環境（或 CI）跑。**所有 iOS 相關結論（IndexedDB 退路、`createSyncAccessHandle` 在 Safari、7 天 ITP、背景被殺）都是設計推論，沒有實測。**
- 手機實機（Tab S9、iPhone）沒測；手機畫面只用 Chromium 的 Pixel 5 模擬檢查過版面。
- 修改後立刻關頁／重新整理可能丟那次修改（§4）；沒有寫入日誌。
- 附件、圖片上傳（§6）、還原備份、外部行事曆、AI、推播、發布網站。
- 多分頁同時使用（只允許一個；離線佇列的 `navigator.locks` 與這把鎖互不相干）。
- PGlite `opfs-ahp://` 持久化、SharedWorker、`pgcrypto` 瘦身。
- 模組庫介面仍列出被關掉的模組（可在設定打開）；沒有為試用版另做「隱藏」旗標。

## 11. 第 3 批用到的接口（已用上）

- **PR 預覽網址**：`npm run build:browser` 的輸出是相對路徑的純靜態資料夾，可直接放在 `/<pr>/`；`worker.js` 與 PGlite 資產以 `document.baseURI` 為準，`sql.js` 以頁面資產為準。尚未驗證的是「子路徑下的所有 `/api/` 以外的絕對路徑」（字型已確認是相對路徑；其他 `public/` 檔案沒有帶進來）。
- **WebKit e2e**：`e2e/browser-app/smoke.mjs <engine>`，退出碼 0＝通過、1＝失敗、2＝瀏覽器啟不起來；`--dir` 可指向別處的建置。`serve.mjs` 是最小靜態伺服器（`.wasm` 要 `application/wasm`）。
- **iOS 檢查清單**（要在真機或 WebKit 驗的）：OPFS sync access handle 是否可用（否則走 IndexedDB 並看 6 MiB 的副本寫入時間）、Web Locks、`pagehide`／`visibilitychange` 時的存檔能否完成、背景 5 分鐘再回來資料還在、7 天沒互動後資料還在、加到主畫面後的儲存配額、下載備份在 iOS 的檔案流程、Worker 內 `fetch` 載入 wasm 的 MIME。
- **狀態查詢**：`GET /api/browser-app/state`（worker 自己回答）給 e2e 判斷「已保存」：`{ store, lastSavedAt, lastCopyMs, lastCopyBytes, unsaved, failed, sampleNotes }`。

## 12. 第 3 批：可以給朋友用

業主要把試用版給朋友實際使用（不是正式公開，但那是別人真的會寫進去的筆記）。這一批只處理「資料不能壞、不能無聲地丟」，與「朋友遇到問題能回報」。
每項都是試用版殼或 worker 內的小模組，正式伺服器與正式版開機 JS 預算不受影響（`npm run build` 的開機預算照舊通過）。

### 12.1 更新不弄壞資料（`schemaCheck.ts`、`worker.ts` 的 `boot()`）

- 每份副本旁記 `meta`：`journalSeq`（它已包含到日誌第幾筆）與 `schema`（做這份時最新的遷移名）。OPFS 寫在指標檔，IndexedDB 與副本同一筆資料（`snapshotStore.ts` 的 `CopyMeta`）。沒有 meta 的第 2 批副本視為 `journalSeq: 0`。
- 開機時**先看副本裡實際套用了哪些遷移**（`schema_migrations`），再與這個建置內嵌的遷移比（`judgeSchema`，純函式、有單元測試）：
  - 相同：照常開。
  - 副本缺遷移（舊副本）：在**記憶體裡**補跑（遷移 SQL 隨 worker 打包；沿用第 1 批的 `useMigrationSource`／`portableMigrationSql`）。成功後立刻存一份新副本，頁面並顯示「你的筆記已經升級…」；舊副本在新副本寫完、指標更新之前一直是目前的那一份（OPFS 兩個槽位輪流、指標最後才改；IndexedDB 單次 `put` 原子取代）。
  - 補跑失敗：丟出 `upgrade-failed`，**不存任何東西**；頁面顯示「資料升級沒有成功，舊資料原封不動」，按鈕有「下載舊資料」（原樣的資料庫映像，給開發者復原，不是筆記檔；要能直接讀的備份只能用舊版開啟後下載）與「重新整理」。
  - 副本比程式新（有這個建置不認得的遷移，例如開到舊的快取版本）：丟出 `newer-copy`，**拒絕開啟**，說明「這份資料比這個版本新」，同樣可「下載舊資料」。不降版、不蓋掉。
- 「下載舊資料」與「重新開始」在開機失敗後仍可用（worker 把儲存空間的開啟與開機分開）。
- 測試：`browserJournal.test.ts`（`judgeSchema` 的四種情況）；冒煙 e2e 用 `makeOldCopy.ts` 做出三種副本——只套到第 158 支遷移並含兩則筆記（升級後筆記都在、`schema` 變成最新、第二次開啟不再升級）、含不認得的遷移（被拒絕且儲存的副本位元組不變）、讓第 160 支遷移失敗（顯示說明、「下載舊資料」的位元組與原副本完全相同、儲存的副本不變）。

### 12.2 不丟最後一次修改：寫入日誌（`journal.ts`）

- 每個會改資料的請求（非 GET／HEAD，排除 worker 自己的端點、登入、還原備份的各步驟）在佇列裡、**後端執行之前**先寫進 IndexedDB `onden-browser-journal`（`durability: "strict"`），寫好才執行、才回答頁面。內容超過 16 MiB 的不記（記次數，§4 的表）。
- 每份副本在**與製作副本同一個佇列工作內**記下「已執行完的最後一筆日誌編號」；副本寫入成功後才把日誌裁到那個編號。所以日誌裡「副本之後」的紀錄界線是精確的，重放不會把已在副本裡的修改再做一次。
- 開機時（副本載入、遷移之後）依序重放編號大於副本 `journalSeq` 的紀錄；重放的請求帶著原本的標頭（包含既有的冪等鍵），所以即使界線有誤，後端自己的冪等機制也是第二道保護。重放用的是目前的狀態再跑一遍：伺服器 4xx 視為原本就被拒絕，只有 5xx／例外算「無法套用」並回報。編號在副本的 `journalSeq` 之上繼續累加（日誌被裁空後也不會與舊編號衝突）。
- 重放完（或升級完）立刻存一份副本，再讓頁面開始；頁面顯示「找回了頁面關閉前最後的 N 項修改」。
- **限制**：重放不保證每一項都能套用（§4 的表）；伺服器產生、後面請求又引用的 ID，重放時會是新的（Onden 的前端幾乎都由客戶端產生 ID，沒有逐一驗證）。Safari 不支援 `durability` 選項，iOS 上「日誌落盤」要靠實機確認。
- 冒煙必過項（`smoke.mjs` §2）：頁面的「立刻存檔」訊息被丟掉（模擬行程被殺前沒機會存檔）、寫入收到回覆後**立刻**重新整理，筆記仍在；連續兩次寫入也都各剩一則（不重複）。

### 12.3 持久儲存、備份與還原

- **持久儲存**：開機呼叫 `navigator.storage.persist()`（`lib/storagePersist.ts`，現在回傳結果），試用版提示裡顯示結果（已答應／還沒答應／這個瀏覽器沒有說明），沒答應時有「請瀏覽器長期保留我的筆記」按鈕可再問一次（Safari 與 Chromium 常不會答應；主畫面 App 較可能）。診斷資訊也列出用量與上限。
- **備份提醒**（`lib/browserAppBackup.ts`，純函式 `backupDue` 有單元測試）：距離上次備份（沒備份過則從第一次開啟起算）滿 7 天且之後存過檔，或之後存了 50 次檔，就在試用版按鈕上換成注意色、並在這次開啟時彈出一則提示。次數與時間記在這個瀏覽器的裝置偏好（localStorage；清掉網站資料時一起消失，沒有影響，因為那時筆記也消失了）。
- **自動備份到資料夾**：有 File System Access（Chromium 桌機與 Android）時，「備份到資料夾…」讓使用者選一次資料夾（把資料夾控制代碼存在 IndexedDB，與離線副本的資料夾分開存），之後「立刻備份到「資料夾名」」會寫入 `onden-backup-日期時間.zip`，只留最近 5 份（只刪自己命名規則的檔）。瀏覽器重開後需要使用者再按一次授權，所以不假裝是背景自動執行：按鈕改成「允許並備份到…」。沒有這個 API 的瀏覽器（Safari）不顯示這個按鈕。
- **備份**沿用既有的完整匯出 `GET /api/backup/full.zip`，不另做格式。
- **從備份還原**（第 2 批時不可用，現在打開）：設定 › 資料與備份的原有流程（上傳 → 預覽 → 套用）完全沿用後端路由與服務，**後端服務碼沒有改**。瀏覽器版替換了兩個底層：`browser-shims/vfs.mjs`（記憶體檔案系統，`node:fs`／`fs/promises` 的替身，上傳的 zip 暫存在這裡）與 `browser-shims/yauzl.mjs`（用 fflate 讀 zip 的 `yauzl` 子集；同樣拒絕絕對路徑、`..`、反斜線、zip64），再補上 `stream` 替身需要的 `Readable.fromWeb`、`Transform`、`pipeline`。
  - 套用是背景工作，後端自己在請求之外繼續跑；瀏覽器版是單一佇列＋單一共用 context，所以 worker 在套用後**持有佇列直到工作結束**（直接讀 `backup_restore_jobs` 那一列，不經 app，以免在交易中途疊上別的請求 context）。代價：還原進行中，頁面的其他請求（含進度查詢）排在後面，結束後才一起回；朋友規模的備份是數秒。
  - 含圖片或檔案的備份：第 3 批會被拒絕（`restoreGate.ts`）；第 4 批已移除那道關卡，檔案經儲存接口寫回瀏覽器的檔案空間（§14）。
  - 還原的各步驟不進日誌（§4 的表）。
  - 測試：冒煙 e2e「備份 → 重新開始（清空）→ 還原 → 筆記回來、已保存、重新整理後還在」（第 4 批另有含圖片的版本）。**沒有**專門的壓力測試（大備份、數千則筆記）；本機實測只有幾十則筆記。

### 12.4 圖片與檔案：第 3 批沒有做，第 4 批做了

見 §14。

### 12.5 有新版時提示重新載入（`browserApp/watchNewBuild.ts`）

- 建置時每個建置有一個 id（`ONDEN_BUILD_ID`，預設時間戳），頁面內嵌它，同時寫進發布資料夾的 `build.json`。頁面開啟時與之後每 5 分鐘（頁面在前景時）以 `no-store` 取回 `build.json`，與自己的 id 不同就走正式版既有的做法：`noteServerBuild`（`lib/buildVersion.ts` 從原本的 `watchServerBuild` 抽出的同一段）→ 「有新版，重新載入」提示（`components/DeviceNotices`）→ `reloadForNewBuild`，**重新載入前先存好正在編輯的文字**（既有的 `lazyWithReload` 流程）；worker 在頁面離開時也會存副本。
- 取不到 `build.json`（離線、本機建置沒有發布資料夾）：什麼都不說。測試：冒煙 e2e 用 `serve.mjs` 讓 `build.json` 回不同的 id → 出現提示；回相同的 id → 不出現。
- 為什麼不用 Service Worker 做更新：第 4 批的 Service Worker 只轉圖片（§14），不快取、不管更新；正式版的提示做法本來就是「比對建置 id」。GitHub Pages 的靜態檔最多有約 10 分鐘的快取，所以「有新版」可能比發布晚一點出現。

### 12.6 說明頁與診斷資訊（`browserApp/TrialHelp.tsx`、`lib/browserAppDiagnostics.ts`）

- 試用版提示 › 「說明與回報問題」：這是什麼、資料存在哪裡、怎麼備份與還原、試用版沒有的功能、怎麼回報問題。字句走一般的字典（`i18n.zh-TW.late.ts`），畫面沒有 JSON、id、錯誤碼。
- 「複製診斷資訊」：版本（建置日期或發布時的標籤）、瀏覽器與系統（只有名稱與主版本，不是完整的識別字串）、保存方式、是否答應長期保留、用量、日誌是否開啟、上次存檔時間、有沒有未存的修改、上次存檔是否失敗、上次備份時間、回報時間、最近幾個問題（只有「存檔失敗」「備份失敗」這類標籤與時間）。**不含任何筆記內容、標題、標籤、名稱或 id**（冒煙 e2e 檢查複製出來的文字不含筆記文字與 uuid）。
- 回報的位址用建置參數：`npm run build:browser -- --report-url=<網址>`（說明頁才會多一個「回報的地方」連結；預設不顯示）。`--tag=<標籤>` 會成為診斷資訊裡的版本名稱。

## 13. 發布（`scripts/deploy-browser.mjs`、`scripts/browserReleaseScan.mjs`）

預計上線在 GitHub Pages 的子路徑（另一個只放建置結果的公開 repo，**尚未建立**，這一批沒有推到任何地方）。

```bash
npm run build:browser -- --tag=2026-11-01-a --report-url=https://example.invalid/report --start-choice   # 三個參數都可省略（第三個見 §17）
npm run deploy:browser -- --to ../onden-trial --path onden [--tag v3] [--build] [--dry-run]
npm run scan:browser        # 只掃描建置結果，不複製
```

- `deploy:browser` 把建置結果放進 `<--to>/<--path>/<--tag>/`（`--path`、`--tag` 都可省略；有 `--tag` 就是並存的版本資料夾，不覆蓋別的版本），在 `--to` 根目錄寫 `.nojekyll`。**只複製檔案**：沒有 commit、沒有 push、沒有任何遠端；之後怎麼發布由人決定。
- 順序：（`--build` 時先建置）→ **發布前掃描** → 清掉目的地那一層舊的建置 → 複製（略過 `*.meta.json` 這類建置副產品）。掃描有發現就停，一個檔案都不複製；目的地那層若有不是瀏覽器版建置的檔案（沒有 `index.html` 與 `worker.js`），也不動它。`--path`／`--tag` 只准英數字與 `._-`（子路徑可用 `/` 分層），不准 `..`，寫入只會發生在 `--to` 底下。
- **發布前掃描**：文字檔（js、css、html、json、svg、webmanifest、map…）裡找：金鑰樣式（私鑰標頭、`sk-…`、`ghp_…`、`AKIA…`、JWT、Bearer、寫死的 password／secret／token 字串）、內部網址（私人網段、`.internal／.local／.lan／.corp`）、IP 位址、email、機器路徑（`/home/<人>/`、`/Users/…`、`C:\Users\…`、`/root/`）。
  對真實建置的第一次掃描找到的東西，及處理：
  | 發現 | 是什麼 | 處理 |
  | --- | --- | --- |
  | `http://localhost`、`localhost:11434` 等 | 假來源（頁面與 worker 之間，不會有請求送出）、開發預設埠（Ollama） | `localhost`／`127.x` 是「看頁面的人自己的電腦」，不算內部網址 |
  | `me@this-browser.onden` 與其固定密碼 | 試用版唯一的本機帳號，只存在使用者自己的瀏覽器（`localSession.ts` 說明過） | 逐字列為預期內，不放寬樣式 |
  | `/home/runner/…`、`/home/postgres/.pgpass`、`user@example.com`、`10.0.0.0` 等網段表 | 第三方套件自己發布的偵錯字串、示範網域、保留網段表 | 逐項排除（`/home/runner/`、`/home/postgres/`、`@example.com／org／net`、`0.x` 與 `.0` 結尾的網段起點、版本號形狀） |
  | `worker.meta.json` 裡的 `/home/user/Onden/…` | esbuild 的建置副產品，**真的**含這台機器的路徑 | 不發布（`notPublished`）；掃描也不看它 |
  新增的排除要改 `browserReleaseScan.mjs` 並附理由；沒有「全部放行」的開關。守門測試 `browserRelease.guard.test.ts`（10 個）涵蓋掃描與發布腳本的各個拒絕與成功情況。
- **子路徑修正（這一批找到的真問題）**：PGlite 的 contrib 擴充（`pgcrypto`、`pg_trgm`）在打包後的 `worker.js` 裡以 `new URL("../pgcrypto.tar.gz", import.meta.url)` 取檔，`../` 在 `/onden/worker.js` 會跳出子路徑，第 2 批只在根目錄測過所以沒發現。建置時把這兩處改成 `./`（`build-browser.mjs`，只准剛好兩處，數量變了就讓建置失敗而不是讓頁面壞掉）。冒煙 e2e 現在固定在 `/onden-trial/` 子路徑跑一遍。
- 發布位置要 HTTPS（OPFS、Web Locks 需要安全來源；`localhost` 也算）。純靜態：不需要任何伺服器設定，只有 `.wasm` 要 `application/wasm`（GitHub Pages 預設就是）。

## 14. 圖片與檔案（第 4 批）

目標：貼上、拖放、「上傳檔案」、手機拍照／選圖、音檔、PDF 筆記、白板上的圖，在試用版跟正式版一樣能用，重新整理後還在，備份帶得走。
差異只在兩個可換的接口與試用版的殼（下面「如果是試用版」清單列全部）；沒有任何呼叫端問「是不是試用版」。

### 14.1 顯示：Service Worker 只攔 `GET /api/media/<id>`

```
<img src="/api/media/ab…webp">  ──▶ Service Worker（browser-sw/media-sw.js，不存任何東西）
                                      │ clients.get(clientId).postMessage + MessageChannel
                                      ▼
                               頁面（lib/browserAppMedia.ts answerMediaRequests）
                                      │ client.request(…)  與每個 /api 請求同一條路
                                      ▼
                               worker：app.fetch → routes/media.ts → mediaFiles().open(name, range)
```

- **只攔什麼**：方法是 GET／HEAD，且路徑結尾是 `/api/media/<一段>`。其他任何請求，fetch 處理函式不呼叫 `respondWith`，請求照原路走（冒煙測試檢查 `favicon.svg` 不受影響）。`/api` 的呼叫（頁面程式碼發的）照舊走頁面的 fetch 橋，Service Worker 看不到也不需要。縮圖／變體：**正式版沒有縮圖路徑**（`routes/media.ts` 只有 `GET /:filename`，縮小發生在上傳時，見 14.4），所以沒有別的路徑要攔；查詢字串會原樣轉給 worker。
- **為什麼經頁面轉發，不直接找 worker**：Service Worker 拿不到 Dedicated Worker 的控制代碼，能做的只有 `postMessage` 給頁面。用 `MessageChannel` 一問一答（比廣播安全：回答只回到問的人），逾時 30 秒回 504。代價：頁面要開著才看得到圖——後端本來就活在頁面裡，沒有多一種失敗。
- **範圍與子路徑**：註冊在頁面旁邊（`media-sw.js`，scope 是頁面所在資料夾，例如 `/onden-trial/`）。被接管的頁面，**所有子請求**都會經過它的 Service Worker，不管 scope 在哪，所以頁面寫的絕對路徑 `/api/media/x` 與 `/onden-trial/api/media/x` 都會被攔到；頁面端把路徑還原成 `/api/media/<id>`（`workerPathOf`）再交給 worker。冒煙測試在子路徑（`/onden-trial/`）上傳一張圖並用瀏覽器自己的 `Image` 載入它（頁面寫的是根路徑的 `/api/media/…`）。
- **第一次開啟（Service Worker 還沒接管）**：選「**先等它接管再掛 App**」，沒有選「前端圖片元件改用 blob: 網址」。理由：(1) 只有一條路——圖片、音檔（含拖曳進度用的 Range）、CSS `url()`、PDF 檢視器、白板上用程式碼載入的圖全部走同一條，不必在每個元件換網址；(2) 啟動本來就要等 worker 約 2 秒，Service Worker 的安裝與啟動（`skipWaiting` + `clients.claim`）與它平行，通常不增加等待。流程：頁面一開始就 `register`，worker 就緒後 `await navigator.serviceWorker.ready`，若 `controller` 還是空的就等 `controllerchange`（最多 4 秒）。強制重新整理（Shift+重新整理）會讓頁面不被接管：這時**只重新載入一次**（sessionStorage 旗標防止迴圈）。接管不成（沒有 Service Worker 的瀏覽器、某些私密視窗、非 HTTPS）：App 照常啟動，上傳的檔案顯示不出來，試用版面板與診斷資訊直接說「沒有啟用」。冒煙測試：全新設定檔的第一次開啟，貼圖後 `naturalWidth > 0`。
- Service Worker 不快取。圖片回應的 `Cache-Control: private, no-cache` + ETag 是 `routes/media.ts` 原本的，原樣帶回（`If-None-Match` 得到 304）。

### 14.2 存放：`MediaFiles` 儲存接口（`services/mediaFiles.ts`）

先比較兩種做法：(A) 在瀏覽器版把 `node:fs` 替身（`vfs.mjs`）改成能存檔，後端十幾處 `join(MEDIA_DIR, …)` 一行不改；(B) 後端的媒體讀寫改走一個可換的接口。選 **B**：A 要讓一個假的 `fs` 同時冒充 OPFS 與 IndexedDB 的非同步行為（rename、sync、readdir），而「回已存之前一定落盤」「空間不夠」「清掉」都是接口該說清楚的保證，不是檔案系統該猜的。

```ts
interface MediaFiles {
  write(name, bytes | AsyncIterable): Promise<void>; // 全有或全無，resolve 時已落盤；空間不夠丟 MediaStorageFull
  read(name): Promise<Buffer | null>;  info(name): Promise<{ size, modifiedMs } | null>;
  open(name, range?): ReadableStream;  remove(name);  names();  usage();
  assertRoom(bytes); sweepIncomplete(); clear();
}
```

- 伺服器：`diskMediaFiles()`（預設，行為與原本一樣：`.store-*.tmp` 寫完 sync 再 rename）。瀏覽器版：`worker.ts` 開機時 `useMediaFiles(...)`（和 `useDatabaseSnapshot`、`useJobRunner` 同一種注入方式）。
- 已遷移到接口的呼叫者：上傳（`storeMedia`）、備份還原（`restoreMediaFile`）、匯入器圖片（同走 `storeMedia`）、`GET /api/media`、完整備份與 Markdown 匯出的 `attachments/`（`archiveStream.addMedia`）、永久刪除（`removeMediaFiles`）、開機清掃、網站發布的媒體檢查與打包、AI 工具的附件讀取。守門：`be-media-files` 登記在 `entrypoints.catalog.json`。
- **瀏覽器的實作**（`browser/mediaStorage.ts`）：與資料庫副本同一種家——副本在 OPFS 就用 OPFS 目錄 `onden-browser-app/media/`（一個媒體 id 一個檔案，sync access handle 寫入並 `flush()` 後才 resolve），副本在 IndexedDB（或 `?store=indexeddb`）就用 IndexedDB（一個檔案一筆，`durability: "strict"` 的交易 commit 後才 resolve）；OPFS 開不起來退 IndexedDB；都沒有則 `noMediaFiles()`（寫入回「空間不夠」，讀取找不到）。
- **名字**：沿用後端的媒體 id（`<32 位亂數>.<副檔名>`），**不是內容雜湊**。原因：筆記裡存的就是這個 id，且正式版刻意用不可猜的亂數當 key（`mediaStore.opaqueMediaName`，公開讀取不靠登入）；改成內容雜湊會讓兩邊 id 文法不同，備份在兩個版本之間搬不動。代價：同一張圖貼兩次存兩份；朋友規模不處理。
- **與寫入日誌一致**：上傳在回答頁面之前，檔案已經 `write()` 完成（落盤）；所以「回了網址」＝檔案已在儲存空間。`POST /api/media` **不進日誌**（`journal.ts isJournaled`）：重放會把同一個檔案用新 id 再存一次，而日誌也不該背 16 MiB 的圖。引用這張圖的筆記修改照常進日誌；上傳者紀錄（`media_uploads` 一列）是檔案的附屬資料、不是領域狀態，萬一在副本之前被關頁，那張圖變成「沒有人擁有」的檔案，仍然可讀（`canReadMedia`：未知 id 可讀）。
- **Hono 的 `bodyLimit`**：worker 替每個請求補 cookie 時把 `Request` 包在 Proxy 裡（`localSession.ts`），而 `bodyLimit` 在沒有 `Content-Length` 時會用 `new Request(c.req.raw, …)` 重建，瀏覽器的 `Request` 不接受 Proxy（`Request with GET/HEAD method cannot have body`）。`Content-Length` 對腳本是禁用標頭，所以 worker 在補 cookie 時一併補上 body 的長度（`fetchAsLocalUser(request, contentLength)`）。這是第 4 批才遇到的第一個大於 `bodyLimit` 的上傳路由。

### 14.3 上傳入口

沒有改任何前端上傳程式：貼上、拖放、「上傳檔案」、手機拍照／選圖、音檔、PDF 筆記、白板的圖，本來就都走 `lib/data/media.ts` 的 `uploadMedia` → `POST /api/media`。第 2、3 批把它擋在 worker 入口（`unavailable.ts` 的 `uploads` 規則）；第 4 批刪掉那條規則，其餘不動。`browser_app_unavailable` 仍用在稍後閱讀的網頁標題與推播。

### 14.4 縮圖與轉檔（`browser/imageCodec.ts`）

後端的 `sharp` 在 `services/imageCodec.ts` 後面：伺服器用 sharp（預設，行為不變），瀏覽器版 `useImageCodec(canvasImageCodec)`。

- **做的事跟正式版一樣**：上傳的 `.jpg/.jpeg/.png/.webp/.avif` 縮到最寬 2400 px（不放大）、重新編碼成 WebP（品質 0.85）、中繼資料（GPS、相機）不保留；GIF、SVG（先過 `sanitizeSvg`）、音檔、PDF 照原樣存。
- **用的是**：`createImageBitmap(blob, { imageOrientation: "from-image" })` 解碼（**EXIF 旋轉由解碼器套用**，輸出是轉正的），`OffscreenCanvas` 縮放，`convertToBlob({ type: "image/webp" })` 輸出。Safari 的 canvas 不會寫 WebP（會回 PNG）：照片改寫 JPEG、其他寫 PNG，**副檔名跟著實際寫出的格式**（回傳的 `ext`），不會出現「.webp 的 PNG」。
- **驗證圖片是不是真的圖片**：`inspect` 用檔頭判斷格式（所以改了副檔名的 PNG 仍是 PNG），再要求瀏覽器真的解得開（截斷的檔案會被拒絕，與 sharp 一樣）；SVG 是文字，Worker 解不了 SVG，只認檔頭。HEIC（相機原檔）一樣被拒絕（伺服器也是：沒有 HEVC 解碼器），而且 `.heic` 本來就不在允許的副檔名裡。
- 對大圖的效能：一張 12 MP 的手機照片，解碼成 bitmap 約 48 MB 記憶體，縮放與編碼在 Worker 內，不卡頁面；上傳在 `queue` 內串行，編碼期間其他請求排在後面。**沒有量過手機上的實際秒數**（沒有實機）。
- 與伺服器的差異：伺服器的 `sharp(...).resize(...)` 沒有 `.rotate()`，所以 EXIF 旋轉的照片在伺服器上是橫的、在試用版是正的。沒有為了一致而改伺服器（不碰正式行為）；這是已知的不一致。

### 14.5 備份、還原、重新開始

- **備份**：`archiveStream.addMedia` 把檔案用串流加進 zip 的 `attachments/`（伺服器照舊串流，不整個讀進記憶體；瀏覽器版的 `archiver` 替身把串流讀完再加進 fflate，與整份備份本來就在記憶體裡一致）。
- **還原**：`restoreMediaFile` 經 `mediaFiles().write()` 串流寫入，過程中檢查大小上限與檔頭簽章，被拒絕或空間不夠時不留半個檔；整個還原失敗會把這次寫的檔案刪掉。**第 3 批的 `restoreGate.ts`（含圖片的備份被拒絕）已刪除。**
- **重新開始**：worker 的 `reset` 訊息除了刪副本與日誌，也呼叫 `mediaFiles().clear()`。

### 14.6 配額與診斷

- 上傳前 `assertRoom`：`navigator.storage.estimate()` 的剩餘空間小於「檔案 + 32 MiB（留給下一份資料庫副本）」就拒絕；瀏覽器仍然拒絕寫入（`QuotaExceededError`）時同樣是 `MediaStorageFull`，並刪掉半個檔。路由回 **507 `insufficient_storage`**，頁面顯示「空間不夠存放這些檔案，沒有儲存任何東西。」（`lib/serverErrors.ts`；原本只給備份用的同一個代碼，句子改成不講伺服器磁碟）。筆記的存檔不受影響：失敗的是 `POST /api/media` 這一個請求，筆記是另一個請求；單元測試涵蓋「配額錯誤 → 507、沒有檔案、沒有上傳者紀錄」。
- 備份還原時空間不夠：在寫第一個檔案之前檢查（`assertRoom`），或寫到一半時，都回原本的 `insufficient_storage`（507），刪掉這次寫的檔案，什麼都不還原。
- 診斷資訊多一行：上傳的檔案 N 個、佔多少、存在哪（檔案空間或資料庫空間）、「顯示功能」是否正常（Service Worker 是否接管）；不含檔名、id。`/api/browser-app/state` 多一個 `media: { files, bytes, store }`。

### 14.7 所有「如果是試用版」的分岔

| 地方 | 正式版 | 試用版 | 為什麼 |
| --- | --- | --- | --- |
| 媒體位元組放哪 | `diskMediaFiles()`（磁碟） | `useMediaFiles(OPFS／IndexedDB)`，`worker.ts` 開機時裝 | 沒有磁碟 |
| 圖片轉檔與驗證 | sharp | `useImageCodec(canvasImageCodec)`，同上 | sharp 是原生模組 |
| 誰攔 `<img src="/api/media/…">` | 瀏覽器直接問伺服器 | `browser-sw/media-sw.js`，頁面啟動時註冊 | 沒有伺服器 |
| 日誌 | —（沒有日誌） | `POST /api/media` 不進日誌（`journal.ts`） | 重放會重複存檔；檔案已落盤 |
| 補 `Content-Length` | 真的 Request 本來就有 | worker 的 `fetchAsLocalUser` 補長度 | Proxy 的 Request 無此標頭，`bodyLimit` 需要 |
| zip 的 `append(串流)` | archiver 原生 | `browser-shims/archiver.mjs` 讀完串流再加 | 替身只有記憶體 zip |
| 重新開始 | —（沒有這個動作） | 一併 `clear()` 檔案 | 資料全在瀏覽器 |
| 試用版面板 | —（沒有） | Service Worker 沒接管時說明；診斷資訊列出檔案數與用量 | 圖片可能顯示不出來要看得出原因 |

以上都在「注入點或殼」：後端 `services/`、`routes/` 裡沒有 `if (browser)`（守門：`browserApp.guard.test.ts` 與 `harnessBoundary.test.ts` 照舊通過）。

## 15. 沒做到的、沒跑的

- **WebKit／mobile-safari 沒有跑**：這個雲端環境無法下載 Playwright 的 WebKit（`playwright install webkit` 下載失敗，`/opt/pw-browsers` 只有 Chromium；第 2 批已記錄同樣的原因）。`smoke.mjs` 與 `run-all.mjs` 已支援四個專案（`chromium`、`mobile-chrome`、`webkit`＝Desktop Safari、`mobile-safari`＝iPhone 13），啟動不了時結果是 **SKIPPED**，不是通過。業主的筆電有 WebKit：`cd packages/frontend && node e2e/browser-app/run-all.mjs`（先 `npm run build:browser`）。WebKit 不是 iPhone：真機要照 [browser-app-ios-checklist.md](browser-app-ios-checklist.md) 做。
- **圖片與檔案（第 4 批）沒做、沒驗的**：
  - **Safari／iOS 一項都沒跑**：Service Worker 接管、OPFS 的 sync access handle 寫媒體、canvas 不能寫 WebP 時的 JPEG／PNG 退路（只有單元測試用替身驗證）、HEIC、拍照上傳、加到主畫面後圖片還在。iOS 檢查清單第 8 項要在真機做。
  - 大檔案：IndexedDB 路徑與瀏覽器版的 zip 都是整個檔案進記憶體（上限是各類型原本的 cap，最大 500 MB 的影片會吃力）；OPFS 路徑的讀取是串流，寫入是一次一個請求。沒有量過大影片或數百張圖的備份／還原時間。
  - 同一張圖貼兩次存兩份；沒有「沒人引用的檔案」的清理（正式版也沒有，永久刪除筆記時才連檔案一起刪）。
  - 當機在寫檔中途會留下一個沒人引用的半個檔（§14.2）；開機不掃。
  - 配額：真實瀏覽器的配額耗盡沒有在 e2e 裡製造（單元測試用替身驗證了錯誤路徑與提示）。`navigator.storage.estimate()` 的數字在各瀏覽器粗細不同，只當預檢。
  - 子路徑下由程式碼建立、離開文件的 `Image`（例如白板匯出）沒有另外測；Service Worker 對被接管頁面的所有子請求都會攔，理論上也涵蓋。
  - 沒有 Service Worker 的瀏覽器（或沒接管）：圖片顯示不出來，只在試用版面板與診斷資訊說明，沒有另做 blob: 備援（§14.1 的取捨）。
  - 與伺服器的 EXIF 旋轉不一致（§14.4）。
- 日誌的 `durability: "strict"` 在 Safari 被忽略：iOS 上「行程被殺也不丟」是盡力而為，沒有實機證據。
- 手機實機（Tab S9、iPhone）沒測；手機只用 Chromium 的 Pixel 5 視窗模擬檢查過版面與冒煙。
- （已在盲測修正批處理，§16）設定頁的「儲存」與帳號對話框在試用版顯示試用版自己的存檔狀態，不再寫「已同步」「已連線」。
- 「登出」按鈕在試用版仍看得到（worker 回成功但什麼都不做，第 2 批的設計）。
- 多分頁同時使用仍只允許一個；PGlite `opfs-ahp://`、SharedWorker、`pgcrypto` 瘦身（省 1.1 MiB）都沒做。
- 還原備份沒有大備份的壓力測試；還原期間佇列被持有（§12.3）。
- 重放日誌時，伺服器產生的 ID 若被後續請求引用會對不上（§12.2）；沒有逐一驗證每一種寫入。
- 發布 repo 沒有建、沒有推（照指示）；`--report-url` 沒有預設值。

## 16. 盲測修正第 2 批：離開前一定落地、完成就是真的存好、試用版說實話（2026-11-02）

兩份盲測（懷疑論者 PR #1228、重度使用者 PR #1227；報告在分支 `eval/blind-2026-11-02-trust`／`-power` 的 `docs/research/blind-eval-2026-11-02/`）是在第 2 批的 main 上測的。這一批先在第 3、4 批的分支上用 Playwright 逐項重現，只修還重現的。

### 16.1 重現表（`origin/feat/browser-app-images` 的建置，Chromium 桌機與 Pixel 5 視窗）

| 項目 | 結果 | 備註 |
| --- | --- | --- |
| S1 新筆記填完立刻重新整理 | **仍重現** → 已修 | 筆記已建立（日誌收了），但打的字只存在頁面的「待確認」紀錄（localStorage），下次開啟沒有人把它送出去，只顯示在恢復面板 |
| S2 既有筆記尾端打字 0 秒重新整理 | **仍重現** → 已修 | 同上 |
| S3 手機打字後立刻重新整理 | 打在筆記裡：**仍重現**（文字進恢復面板，沒有自動補回）→ 已修；快速擷取：文字在擷取框的草稿裡（`quickCaptureDraft`，重新整理後仍在），不是遺失 | 手機模擬（Pixel 5）有出現恢復面板；盲測說「沒有面板」沒有重現，但文字確實沒有回到筆記 |
| S4 連打 40 個詞後關分頁、開新分頁 | **仍重現** → 已修 | 同 S1 |
| S5 恢復面板「重試」沒救回、多建空白筆記 | **仍重現（沒救回）** → 已修；多建空白筆記**沒有重現** | 「重試」只把寫入放進離線佇列並移除面板項目，沒有送出，要等下一輪同步（實測超過 14 秒都沒送）。現在放進佇列後立刻送出 |
| 問題 3 資料夾匯入說完成後立刻關閉，資料全沒 | **已不重現** | 300 篇匯入答覆後立刻關掉瀏覽器、同一個設定檔重開，筆記都在（寫入日誌，第 3 批）。同類的**還原**仍有 0.5 秒空窗 → 已修（§4） |
| P1 還原備份顯示「Could not reach the server」 | **已不重現** | 第 3 批已能還原；冒煙的備份→重新開始→還原一直通過 |
| P5 網站資料被清掉後無聲重置 | **仍重現** → 已修 | §16.3 |
| P6 設定「筆記存在哪」寫在伺服器上 | **仍重現** → 已修 | 設定頁的位置說明沿用 `localOnlyStatus`（試用版有就說「在這台裝置上」） |
| P7 帳號對話框「Connected」、設定首頁「Synced」 | **已不重現** | 第 3 批把試用版提示移進存檔狀態列時已改成「只存在這個瀏覽器 · 已存好」 |
| P9 下載備份後沒有回饋 | **仍重現** → 已修 | 橋接下載與試用版提示的下載都說「已下載「檔名」」 |
| P12 自動建立的空白日記進備份／匯出 | **仍重現** → 已修 | §16.4 |
| P14 備份夾帶 11 個空的系統標籤頁 | **仍重現** → 已修 | §16.4 |

### 16.2 離開前的空窗在哪一層，怎麼補

一次寫入從打字到落地經過這幾層：編輯器的草稿（記憶體）→ 防抖後的寫入（`createSaveDebounce`，頁面離開時 `onPageHide` 立刻送出）→ 頁面的寫入佇列（`writeQueue.submitWrite`，要先等 IndexedDB 與 Web Lock）→ 頁面到 worker 的訊息 → worker 的日誌（IndexedDB，`strict`）→ 資料庫 → 副本。

- **worker 與日誌這一層沒有空窗**：日誌在後端執行之前就記好、記好才回答（§12.2）。
- **空窗在頁面這一層**：頁面離開（重新整理、關分頁、換 App）時，`pagehide` 只能同步做一件事：把還沒得到答覆的寫入寫進 localStorage 的「待確認」紀錄（`rememberUnconfirmedWrite`，本來就有）。真正的送出要等頁面的佇列，頁面已經不在了。下次開啟，這些紀錄只被當成恢復面板的項目，**沒有任何程式把它們送出去**（要使用者按「重試」，而「重試」又只入佇列、沒送）。
- **做法**（`lib/data/writeQueue.ts` 的 `adoptUnconfirmedWrites`，編輯器與離線佇列共用，正式版同樣適用）：下一次開啟時，在第一次送出或第一次排空佇列之前，把**更早的頁面載入**留下的、沒有被拒絕過的待確認紀錄，沿用原本的冪等鍵，依原順序放進持久的離線佇列，再從恢復面板移除。冪等鍵讓「回應遺失」與「根本沒送到」走同一條路，重複到達無害；被伺服器拒絕時，文字回到恢復面板（標示被拒絕），不會自動再送。每筆紀錄記下是哪一次頁面載入做的（`life`），**不用時鐘判斷**：新頁面的時間起點比舊頁面的 `pagehide` 更早，用時間會把舊紀錄當成新的。這一次頁面載入自己做的紀錄不動（它們還在路上）。
- 「重試」（`FailedWriteRecovery`）放進佇列後立刻排空，不等下一輪同步。

**從何時起一定不掉**（試用版與正式版相同）：

| 時間點 | 保證 |
| --- | --- |
| 按鍵的當下 | 還在編輯器的記憶體；**瀏覽器行程在這之後、`pagehide` 之前被殺（當機、被系統回收、沒有 `pagehide` 的離開）會丟最後約 1.5 秒內打的字**（編輯器防抖 `SAVE_DEBOUNCE_MS.overview`）。這一批沒有改成每個按鍵都寫 localStorage（大筆記會變慢），這個空窗還在 |
| 頁面收到 `pagehide`／`visibilitychange: hidden` 的那一刻 | 同步寫進 localStorage 的待確認紀錄；下次開啟自動補回（本機儲存本身失敗或超過容量時沒有保證，面板會說） |
| 頁面的請求到達 worker、日誌寫好 | 日誌（IndexedDB）；下次開機重放 |
| 回應「完成」 | 試用版：日誌或副本有它；還原：副本已寫好（§4） |

**自動補回需要多久**：下次開啟後第一輪同步時（約 3～4 秒，同開機）；這之前文字不在筆記裡。

### 16.3 資料被清掉的偵測（`lib/browserAppDataMark.ts`）

試用版在 localStorage 與一個很小的 IndexedDB 資料庫（`onden-trial-mark`，不是筆記的儲存空間）各放一個「這個瀏覽器存過副本」的記號，副本第一次存好時寫。worker 開機時若是從內建資料庫起算（`firstOpen`）卻看到任一個記號，就顯示一次白話提示（「這個瀏覽器裡的筆記不見了」＋「從備份還原」按鈕開設定、「先不用」）。「重新開始」是使用者自己的選擇，會清掉記號。

**偵測不到的情況**：清掉**全部**網站資料（記號與筆記一起消失）、換瀏覽器或裝置、Safari 的 7 天清除（同樣全部）、無痕視窗；只有範例筆記時被清掉也會提示（記號只說「存過副本」，不分有沒有自己的內容）。

### 16.4 備份與匯出的內容

- **空的標籤頁**：標籤定義（沒有自己的文字）不再在 Markdown 部分有檔案（`tag-….md`）；資料仍在 `.onden/notes/<id>.json`，還原照舊（`backupRestore` 的標籤往返測試通過）。有文字的標籤頁仍照原本當筆記。
- **空白日記**：自動建立、至今沒有文字、標籤、屬性、連結、子筆記的日記（標題是日期）不進備份也不進 Markdown 匯出（SQL 在 `exportZip.ts` 的 `EMPTY_DAY_NOTE_SQL`，與 `@onden/markdown` 的 `dayNoteDate` 同一條規則）；有任何東西的日記照舊。

### 16.5 驗證（2026-11-02）

見 PR 說明的測試結果。新的冒煙項目在 `smoke.mjs`「5d」：新筆記／尾端打字／連打 40 詞後關分頁，皆 0 秒離開；待確認紀錄補回自己的筆記且不多建筆記；匯入、還原後立即離開；清掉 OPFS（或強制 IndexedDB 時清掉 IndexedDB）後的提示與「重新開始」不提示；設定的文字、下載回饋；備份不含 `tag-….md` 與空白日記。

## 17. 暫時使用（`?temp=1`，2026-11-12；設計：[傳到我的手機提案](proposals/send-to-phone-2026-11-12.md) 第 5 節 1、2 項）

借用別人的電腦時用：什麼都不留在那台電腦，寫完下載一包只含這次內容的備份，之後合併進自己的工作區。**已實作並測試（Chromium 桌機；WebKit／手機沒有跑）。** 沒有做的：配對、加密、碰面點、網路傳輸（另一個任務）。

**進入**：網址 `?temp=1`，或發布資料夾的 `temp/`（建置時寫一個轉址頁）。建置加 `--start-choice` 時，第一次來（這個瀏覽器沒有我們的記號）的人先看到「開始使用／在這台電腦上暫時使用」兩個選項（`browserApp/StartChoice.tsx`、`startChoice.ts`）；沒加時頁面照舊直接進 App（e2e 的各腳本都這樣開）。**沒有一般瀏覽器版的「首頁」**：發布資料夾的 `index.html` 就是 App，所以入口是這個選擇畫面與網址（`?temp=1`、`temp/`），不是獨立的首頁；之後要不要做真正的首頁由業主決定。

| 層 | 做法 | 檔案 |
| --- | --- | --- |
| worker | 儲存種類強制 `"none"`（`openSnapshotStore("none")` 完全不碰 OPFS／IndexedDB，連「清除」都不做）、不開日誌、附件放記憶體（`memoryMediaFiles`，上限 200 MB `TEMP_SESSION_MEDIA_LIMIT_BYTES`，超過整個檔案拒絕，錯誤碼 `temporary_session_full`，白話在 `serverErrors`）、不放範例筆記，只退掉用不到的內建標籤並建一則標題是占位標題（「未命名」或 Untitled，看瀏覽器語言）的空白筆記 | `backend/src/browser/worker.ts`、`snapshotStore.ts`、`mediaStorage.ts`、`temporarySession.ts` |
| 頁面 | 在任何模組載入前（`browserApp/temporaryEntry.ts` 是 `main.tsx` 的第一個 import）把 `localStorage`／`sessionStorage` 換成記憶體、`indexedDB`／`caches`／`navigator.storage.getDirectory` 設為不存在；頁面本機副本（sql.js）的 worker 收到每個請求都帶 `temporary`，副本只留在它的記憶體、不讀寫 IndexedDB、不寫日誌 | `lib/temporaryStorage.ts`（旗標在 `lib/temporarySession.ts`，小到可以進開機包）、`lib/localDb.ts`、`lib/localDbWorker.ts`、`lib/sessionPrefs.ts`、`lib/storagePersist.ts` |
| 一般模式 | 不讀、不寫、不刪：臨時模式不取一個分頁一把的鎖（`BROWSER_APP_LOCK`）、不用 `?store`、不跑「有新版就重新載入」（會丟掉寫的東西）。e2e 在同一個瀏覽器先開一般模式並存檔，再開臨時模式寫入，比對 OPFS 檔案、IndexedDB 資料庫與日誌、localStorage、Cache 完全沒變 | `e2e/browser-app/smoke.mjs` 第 11 段 |
| 畫面 | 帳號選單的存檔那一行常駐說「不會留在這台電腦」，有沒下載的內容時變成「關掉分頁前請先下載」；按下去開說明＋「下載我寫的內容」；關分頁前若有沒下載的內容，用瀏覽器自己的離開提醒（`warnBeforeLeaving`） | `browserApp/TemporaryNotice.tsx`、`lib/pageHide.ts` |

**沒被清掉、也不算內容的**：Service Worker 的註冊與它快取的程式檔（`media-sw.js`，顯示上傳圖片用）。e2e 列舉的是 OPFS、IndexedDB、localStorage、sessionStorage、Cache、cookie。

**限制**：臨時模式不承諾「手機」：這一批只有下載，說明文字也只說下載；傳到手機是下一個任務。附件上限只在 e2e 之外以單元測試驗證（200 MB 的真實上傳沒有跑）。頁面關閉時沒有任何東西可救（這是設計）。

### 17.1 只含這次內容的備份，與合併進既有工作區

- **產生**：`GET /api/backup/full.zip` 加查詢參數時產生部分備份，格式不變（`onden-backup` v2）：`written=1`＝別人寫的筆記（有自己的標題、文字或手寫；空白筆記與占位標題 `PLACEHOLDER_TITLES` 不算）、`since=<ISO 時間>`＝這個時間（含）之後有存過的、`note=<id>`（可重複）＝只要這些。每一則都帶著它的上層筆記（保留父子關係）、套用的標籤（含上層標籤）與附件。頁面端：`lib/browserAppBackup.ts` 的 `makeSessionBackupBlob({ since?, noteIds? }) → { blob, cursor }`，`cursor` 是送出請求**之前**的時間，下一次當 `since`：請求進行中被存的筆記會在下一包再出現一次，重複無害、漏掉才會丟資料。**邊寫邊傳以「一則筆記＋它的附件」為單位做得到**（`note=<id>`，附件隨筆記）；一個時間點之後所有變動用 `since`。限制：`since` 用資料庫的 `updated_at`，在瀏覽器版與頁面同一台機器同一個時鐘；對別台機器的伺服器，時鐘差要自己留餘裕。
- **合併進去**：`POST /api/backup/restore/:id/apply` 與 `GET …/preview` 多兩個選項（只能合併模式，其他模式回 400 `bad_request`）：`parent_title`＝全部落在一則新建的父筆記底下（保留這包內部的父子關係；上層不在這包裡的筆記與另存的副本直接放在父筆記底下；工作任務仍跟著它的筆記）；`parent_id`＝同一個工作階段再匯入時用同一個編號，找得到就沿用，找不到就用這個編號建。預覽多 `new_parent: { title, exists }` 與 `counts.notes_updated`；報告多 `parent_note_id` 與 `superseded`。沒給選項時行為完全不變。走原本的 `BACKUP_RESTORED` 事件與 `manage` 權限檢查，整批復原時父筆記一起回去。
- **重複匯入與新版本**（`services/backupRestore.ts` 檔頭「parent note」）：同編號同內容＝跳過（原本就有）；同編號不同內容，原規則是另存一份「（備份 日期）」的副本，**不適合**「同一則筆記後來又多寫了幾行」（每次都多一份）。有給 `parent_id` 時多一條規則：這則筆記在該父筆記底下、且自從匯入後沒有人存過或畫過（只有還原自己的事件），就**就地更新標題與內文**（一般的更新，History 留得住舊的）；有人改過就維持原規則另存副本，**絕不蓋掉手機上的修改**。限制：就地更新只更新標題與內文，不重做標籤與手寫（第一次匯入時才帶）。
- **測試**：`backend/src/test/backupPartial.integration.test.ts`（來源與目標是兩個工作區；PGlite 上跑過，沒有真 Postgres 專屬項目）、`e2e/browser-app/smoke.mjs` 第 11 段（瀏覽器版臨時模式的包合併進一般模式的工作區）。
