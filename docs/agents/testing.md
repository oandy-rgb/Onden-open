# 驗證與完成條件

> 狀態：現行（最後確認 2026-11-14）

何時讀：決定驗證範圍、寫測試、回報完成時。精簡版在 [AGENTS.md](../../AGENTS.md)。部署相關的兩條在 [deploy.md](deploy.md)。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

- 檢查本次設計是否出現警訊：一個小改動牽動很多入口、轉呼叫層持續增加、選項旗標越來越多、
  兩個模組必須交叉閱讀，或介面註解必須解釋大量內部步驟。指出原因並在本批範圍內處理。
- 測試用來驗證行為，不代替介面設計；不為迎合某個 mock 而把正式 API 拆碎。
  紅燈轉綠燈後，仍檢查呼叫者是否更容易理解與正確使用。
- 針對改動的不變條件測試，不以檔案數或測試數作為完成指標。
  權限重構涵蓋允許與拒絕、workspace／scope 邊界及撤權；交易重構涵蓋事件回滾、重試去重；
  保存與復原涵蓋輸入保留、後續編輯、衝突，以及涉及的離線重連情境。
- 政策有逐筆與集合查詢兩種實作時，驗證兩者可見結果一致；行為不變的重構可用新舊實作對照測試。
- 從對應套件目錄執行相關 `npm test -- <測試路徑>`、`npx tsc --noEmit`、`npm run lint`；
  影響前端建置或載入時執行 `npm run build`。純文件改動檢查內容與連結即可。
- 資料庫整合測試使用隔離測試資料庫。確認哪些測試實際執行，不能把跳過的整合測試當成通過。
- 影響介面的變更使用瀏覽器檢查桌面與手機尺寸，關注文字密度、留白、控制項重疊、溢出、焦點及保存回饋。
  手機 viewport 測試須如實標示，不能宣稱已完成真機驗證。
- 以效能為理由修改設計時，先建立有代表性的量測，再向下一層定位成本；修改後以相同條件比較。
  例如筆記開啟延遲應區分載入、查詢與渲染，不能只因刪掉一層呼叫就宣稱變快。
  參考作者的 [Always Measure One Level Deeper](https://www.cl.cam.ac.uk/teaching/2425/P56/files/ousterhout2018always.pdf)
  （Communications of the ACM，2018；屬於補充論文）。
- 完成時說明：哪些入口已遷移、呼叫者少理解哪些概念、保留了哪些行為、測試結果和剩餘限制。
  當本批使用案例已符合契約且驗證通過，停止擴大重構。

## 驗收分層：每個 PR（雲端）／合併前（筆電）／每晚（雲端）

業主筆電只有 7 GB，所有完整驗收排隊會超過一小時。能在雲端（沒有 docker、沒有真 Postgres）跑的都搬到雲端，筆電只留雲端做不到的。
雲端的後端是 PGlite（`ONDEN_DB_DRIVER=pglite`，單連線、無 pgroonga／pgvector，差異見 [portable-backend.md](../architecture/portable-backend.md)）。

| 層 | 在哪 | 跑什麼 |
| --- | --- | --- |
| 每個 PR | 雲端 | 相關測試、`npx tsc --noEmit`、`npm run lint`、守門（前端完整 vitest 內的 `*.guard.test.ts`、`npm run dup:check`、`npm run changes:check`）；後端 PGlite 完整套；瀏覽器版（`dist-browser`）冒煙 `e2e/browser-app/smoke.mjs`（`run-all.mjs` 跑完各引擎後接著跑 `handwritingTab.mjs`：筆記的「手寫」分頁——新增、畫、新增一頁、切回內容打字、重新整理、拿掉分頁再加回，筆畫都在；桌面淺色／深色與手機）；改 UI 時 `layout:audit`（`test/layout-audit` 合併後）；改到下表「桌面版與三宿主對照」所列路徑的 PR 加 `npm run desktop:check` 與 `npm run parity` |
| 合併前（一批 PR 一次） | 筆電 | 只跑後端需要真 Postgres 的部分、`npm run build`、B 類全端 e2e（下表）、WebKit 冒煙 |
| 每晚 | 雲端 | 完整前端 vitest、完整全端 e2e（`e2e:cloud-stack`）、屬性測試（`test:props:long`）、規模測試、`zz*` 探針 |

**新增或修改測試後、合併前**：跑 `npm run test:repeat-changed`（`scripts/repeat-changed-tests.sh [次數]`，預設 5）。它找出相對 `git merge-base HEAD origin/main`
新增或修改的 `*.test.ts(x)`（backend、frontend、markdown、site、contract），逐檔單獨連跑，任何一次失敗就停下並印出是哪個檔第幾次；沒有改到測試就印一句話、結束碼 0。
後端沿用 PGlite（`ONDEN_DB_DRIVER` 與 `DATABASE_URL` 未設時用 `pglite` 與 `onden_cloud_test`）。不穩定的測試要找出原因，不是重跑到過。

**新的守門看語法樹，不比對文字**：新守門優先寫成 ESLint 自訂規則，或用 TypeScript 語法樹判斷（例子：後端 `test/guards/allowlist/detect.ts` 的 `sqlInterpolationSites`、
markdown 守門的 `test/guards/sources.ts` 的 `nameLengthLimitSites`／`buildsHexColourRegExp`／`declaresName`）。文字比對只留給「檔案是否存在」「清單是否一致」這類。
理由：同一行出現別的欄位的數字、換行、`[\da-f]` 換寫法、拆成兩個字串，都能繞過或誤傷一條逐行的正規表示式；語法樹看的是「哪個屬性、哪個呼叫」。
讀取權限關卡（`eslint-rules/require-read-gate.js`）同理：`gateEvidence.js` 只認呼叫或使用，不認 import 或註解。守門自己要有「擋得住違規樣本、不誤擋擁有者」的測試，誤判過的寫法補進去。

**每次合併前都要過守門通道**：`scripts/guard-lane.sh`（筆電約 3.5 分鐘，雲端也能跑）。它依序跑 markdown 套件完整測試（裡面的守門會掃前後端原始碼）、
site 套件測試、後端與前端的 `src/test/guards/`、`ratchet:check`、`changes:check`。只跑自己那個套件的 PR 仍可能弄壞這些：
2026-11-10 的 main 同時帶著過期的資料庫型別檔、五個紅的 markdown 守門和一個紅的 site 測試，每個都是「自己的套件全綠」的 PR 合進來的。
合併的人在 PR 分支（已併入最新 main）上跑，紅的不合併；雲端任務的驗證清單也要列這一條。它不取代完整套件。

**e2e 的選擇器必須指向現在還畫得出來的東西**：`packages/frontend/src/test/guards/e2eSelectors.guard.test.ts` 檢查非 `zz*` 的 e2e 腳本用到的 class 與 `data-testid` 都在 `src/`（或 `packages/site/src`）找得到
（函式庫自己的 class 如 `cm-*`、`react-flow*` 除外）。對已不存在的 class 寫 `toHaveCount(0)`／`toBeHidden()` 永遠是綠的，點擊再加 `.catch(() => {})` 就是沒點。
沒修好的記在 `e2e-selectors-baseline.json`（今天的數字，只准減；修好的項目一定要從清單刪掉，測試會擋殘留）。要斷言「不存在」，用 role／標籤，不是舊 class。

### 後端：每一輪都說明自己是哪一種（2026-11-14）

後端與前端的 vitest 每一輪結尾都印一行 `[tests] mode: <模式>. ran N, skipped M; DB-gated files: ran X, skipped Y.`，
**跳過了不該跳過的測試就失敗**（`scripts/lib/skipGateReporter.mjs`）。以前約 457 個檔、2,905 個測試躲在 `describe.skipIf(!isTestDb…)` 後面，
沒有資料庫時整批消失、結束碼 0，沒有任何一條通道會失敗。現在只有五種合法的跑法：

| 跑法 | 指令 | 模式 | 什麼可以跳過 |
| --- | --- | --- | --- |
| PGlite（雲端每個 PR） | `cd packages/backend && npm run test:pglite` | `pglite` | 只有 `src/test/helpers/pgliteSkipList.ts` 的 `PGLITE_SKIPS` 列的檔案與個數（`// ratchet:list`，只准減） |
| 真 Postgres（合併前、CI） | `cd packages/backend && npm test`，`DATABASE_URL` 指向 `_test` 資料庫 | `postgres` | 只有同檔 `POSTGRES_SKIPS`（只在 PGlite 才有意義的測試） |
| 明說無資料庫 | `cd packages/backend && npm run test:no-db` | `no-database` | 任何（資料庫測試會跳過，結尾印出跳了多少） |
| 守門通道、fast lane | `scripts/guard-lane.sh`、`scripts/fast-lane.sh`（自己帶 `ONDEN_TESTS_WITHOUT_DATABASE=1`） | `no-database` | 同上；它們本來就不需要資料庫 |
| 前端 | `cd packages/frontend && npm run test:no-db`（沒有資料庫的整套）；`syncFaultSimulation.integration.property.test.ts` 要真 Postgres，在 CI 的後端 job 跑 | `no-database` 或 `postgres` | 前端只檢查「讀 `process.env.DATABASE_URL` 的檔」：沒資料庫又不是 `test:no-db` 就失敗 |

`test:props`、`test:props:long` 與單檔 `npx vitest run <檔>` 也是同一套：要嘛帶 `ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test`（或真 Postgres 的 `_test` URL），要嘛明說 `ONDEN_TESTS_WITHOUT_DATABASE=1`。
沒有資料庫、又沒說是無資料庫輪（例如直接 `npx vitest run`）就失敗，訊息會說兩條路。用 `-t <名稱>` 篩選的輪只回報、不失敗。
PGlite 跳過清單是「檔案：個數」且要**剛好相等**：跳過比清單多就失敗（新增了沒登記的跳過），比清單少也失敗（請把個數降下來，清單只准減少）。
新增 `needsSecondConnection`／`needsPostgresServer`／`needsPgroonga` 的測試要同時在清單登記，PR 說明寫為什麼它在 PGlite 上沒有意義。

每一輪另外把 `os.tmpdir()` 指到一個本輪專用的資料夾（`src/test/globalSetup.ts`）；結束時裡面還有東西（測試建了暫存資料夾沒刪）就失敗並列出名稱。測試自己用 `afterAll` 刪掉建立的暫存目錄。

### 後端：PGlite 完整套與只需真 Postgres 的部分

- 雲端（每個 PR）：`cd packages/backend && npm run test:pglite`（＝ `ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test vitest run --maxWorkers=3`，模式 `pglite`）。
  真 Postgres 才有意義的測試用 `needsSecondConnection`／`needsPostgresServer`／`needsPgroonga`（`src/test/helpers/pgliteSkips.ts`）在 PGlite 上具名跳過，原因寫在名稱裡；跳過的不算通過。
- 「PGlite 上也會過、但只有真 Postgres 才抓得到錯」的測試檔，在檔內寫一行 `// realPostgresAlso: <原因>`，`test:real-pg` 就會挑到它。
  該標的情況：測試涉及交易內外的可見性（交易 client 與連線池是兩條連線，PGlite 只有一條所以讀得到未提交的列）、
  `queryOnSeparateConnection` 的呼叫者、或任何「單一連線讓錯誤隱形」的行為。不要整個套件都標；完整套件在真 Postgres 另外跑。
- 守門：後端測試預設開啟 `ONDEN_FORBID_POOL_QUERY_IN_TRANSACTION`（`vitest.config.ts`）：交易中呼叫 `pool.query` 會丟錯，
  讀取請用 `q()`；刻意要在交易外提交的寫入（如 `blobs.putBlob`）用 `db.ts` 的 `queryOnSeparateConnection` 並寫原因。
- 筆電（合併前）：`cd packages/backend && npm run test:real-pg`（模式 `postgres`）（`scripts/realPostgresTests.mjs` 由上述標記找出檔案再交給 vitest；`-- --list` 只列檔案）。
  需要 `DATABASE_URL` 指向 `_test` 結尾的真 Postgres。檔案裡沒被標記的測試也會一起跑（是 PGlite 結果的超集），這是刻意的：標記是測試層級，檔案層級較簡單。
  跳過的原因分三類：`needsSecondConnection`（鎖等待、佇列中的寫入者、跨連線快照、別處持有的 advisory lock）、
  `needsPostgresServer`（自己的 `pg` 連線、`statement_timeout`、連線池計數、連線逐出、數萬列規模）、`needsPgroonga`（分詞器、`&@~` 運算子、Unicode 折疊）。

### 桌面版與三宿主對照：`desktop:check`、`parity`

同一個後端有三種跑法：伺服器（Node + 真 Postgres）、桌面版（Electron，後端是打包進去的 Node 22 跑 PGlite）、瀏覽器版（頁面 worker 裡的 PGlite）。
桌面版曾在一天內壞兩次（stage 漏了 `@onden/contract`、上傳圖片時後端 SIGSEGV），都是手動打包才發現，所以它和三宿主對照都進 PR 的雲端流程。

| 改到這些路徑的 PR | 雲端要跑 |
| --- | --- |
| `packages/backend`、`packages/markdown`、`packages/contract`、`packages/site`、`packages/desktop`、根目錄 `package.json`／`package-lock.json` | `npm run desktop:check`、`npm run parity` |
| `packages/frontend`（只動 UI、不動 API） | 既有的 `e2e/browser-app/smoke.mjs` 就夠（動到側欄／標籤列／檢視分頁或週看板的「按住後拖」（`lib/touchHold`）時加 `npm run e2e:touch-hold`：用 CDP 送真觸控序列，需先 `npm run build:browser`；動到簡報 `modules/slides/` 的版面、表格或匯出時加 `npm run e2e:slides`：真瀏覽器量表格有沒有超出投影片、PPTX 位置是否一致，需先 `npm run build:browser`）；改到 `src/browserApp`、`dist-browser` 的建置時加 `npm run parity -- --hosts browser`；改手寫頁的「引用」、區域嵌入或 `inkRegion` 時加 `npm run e2e:quote-region`（packages/frontend，先 `npm run build:browser`；`run-all.mjs` 也會跑）|

**`npm run desktop:check`**（`scripts/desktopCheck.mjs`，一個指令、一個結果；前提是根目錄已 `npm ci`、Linux x64）：
裝桌面依賴 → 打包（`stage.mjs` 建 markdown／site／contract／backend／frontend，`electron-builder` 只產 `release/linux-unpacked`，不做 AppImage）→ `desktop:test` →
把打包後的資料夾**複製到 repo 外**（才不會悄悄用到根目錄的 `node_modules`）→ `test/smoke.mjs --app`（沒有 `DISPLAY` 就包 `xvfb-run`）。結尾逐項列通過／失敗與秒數。首次約 5～8 分鐘（建前端、裝依賴、下載 Electron 與 Node 22）。
後端 dist 會 import 的 `@onden/*` 套件只有一份清單：`packages/backend/docker/runtime-packages.json`，`stage.mjs` 讀它，Dockerfile 的建置與 COPY 行由
`packages/backend/src/test/guards/runtimePackages.guard.test.ts` 對照（後端 vitest 內）；後端多 import 一個套件而清單、Dockerfile、`package.json` 沒跟上，測試就失敗。

**`npm run parity`**（`packages/frontend/e2e/parity/`）：一份**劇本**（`script.mjs`）只用 App 自己用的 HTTP API，依序做：建立／改標題內文／移動／刪除／復原筆記、樹狀、`[[連結]]` 與反向連結、
標籤與標籤欄位、屬性（含多值）、任務（勾選、日期、重複）、白板卡片位置、手寫（`ink_data`）、上傳圖片、段落連結（`[[筆記/段落]]`）、中文與英文搜尋、歷史版本與還原、完整備份 zip 的內容，
最後幾步探「宿主能力」（推播、抓網頁標題、AI 金鑰存放、外部行事曆、RSS、`/site/*`）。
原本那一段之後，`areas/*.mjs` 再接十三區（每區都有讀、有寫、有檢查結果；`script.mjs` 的 `AREAS` 是順序，備份還原放最後因為它會換掉整個工作區的內容）：
收件匣與待審（`inbox.mjs`：快速擷取、AI 建議的接受／拒絕、「直接改」事件的接受／拒絕）、寄件匣在後端看得到的行為（同鍵重送、舊 base 的三方合併與衝突、離線佇列依序送出再整串重送）、
同步（`reads.mjs`：開機回應、增量、游標前進）、查詢與檢視、日記與行程、歷史與事件（`history.mjs`：版本、事件列表、用事件復原、復原被拒、垃圾桶）、連結圖、
空間與成員（`spaces.mjs`：共用空間、view／edit 成員、搬進搬出、邀請、權杖撤銷）、偏好與工作區設定、匯入匯出與備份還原（`io.mjs`）、其他功能與搜尋（`misc.mjs`）。
只想跑某幾區時加 `--only inbox,sync`（略過原本那一段；各區自己建立需要的筆記）。三個**宿主轉接器**（`hosts/*.mjs`）各提供一個 `request()`：

| 宿主 | 怎麼跑 | 前提 |
| --- | --- | --- |
| `node`（基準） | `packages/backend/dist/server.js`。有 `DATABASE_URL`（`_test` 結尾）就在那台真 Postgres 上新建一個資料庫（跑完刪掉）；沒有就 `ONDEN_DB_DRIVER=pglite`，並印出「真 Postgres 那一欄沒跑」（具名跳過，**不算通過**） | `npm run build -w packages/backend` |
| `desktop` | Playwright `_electron` 開打包後（複製到 repo 外）的執行檔，用 App 的建立帳號畫面註冊，之後從 Node 端帶 cookie 與 `origin` 呼叫它的本機網址；沒有 `DISPLAY` 自動包 `xvfb-run` | `npm run desktop:pack`（或 `--desktop-app <執行檔>`） |
| `browser` | Chromium 開 `dist-browser`（靜態伺服器 `e2e/browser-app/serve.mjs`），請求在頁面內 `fetch`；圖片與 zip 走同源 `/__parity/in`、`/__parity/out`，不經 `page.evaluate` | `npm run build:browser` |

每一步的回應先**正規化**（`normalize.mjs`：各宿主產生的 id 換成劇本裡的名字、時間戳與計數器拿掉、標了 `unordered` 的清單排序），再與 Node 那一欄逐欄比對（`compare.mjs`）。
bootstrap、議程、備份 zip 這類含整個工作區的回應，只比劇本自己建立的東西（`projections.mjs`）；預設資料（內建標籤、瀏覽器版的範例筆記）不在比對範圍。
**已知差異**在 `scripts/parity-known-differences-baseline.json`：每條寫明哪一步、哪個宿主、哪個欄位、為什麼是設計（指向文件段落），`bug: true` 的是還沒修的錯誤、不是設計。
不在清單上的差異 → 失敗；清單上的差異消失了 → 印「可以移除」。檔名帶 `baseline`，所以 `npm run ratchet:check` 與 `ratchet.guard.test.ts` 會擋「新增一條」（只准減少；真的要新增要 `ratchet-override`）。
結尾逐宿主印通過步數／失敗差異／已知差異。參數：`--hosts node,desktop,browser`（`node` 永遠會跑）、`--verbose`（逐步印回應）、`--desktop-app <檔>`、`--keep`。對照測試自己的測試：`npm run parity:test`。

- 雲端（每個 PR）：`npm run parity`（Node 欄是 PGlite）。三個宿主共用同一個資料庫引擎，所以這一輪抓的是**宿主**差異（打包、橋接、環境），不是 PGlite vs Postgres 的差異。
- 筆電（合併前）：`DATABASE_URL=postgres://…/onden_cloud_test npm run parity`。Node 欄換成真 Postgres（pgroonga），搜尋排序與分詞的差異會在這裡出現，**第一次跑要把新差異判成設計（加進清單）或錯誤**。
- 不在對照範圍（沒有 HTTP 入口可以觀察）：瀏覽器版不跑的週期工作（RSS 抓取、推播提醒迴圈、外部日曆抓取、事件修剪）、git 筆記備份（`content/` 的 git 倉庫）、網站發佈。這幾項的依據是 [browser-app.md §7](../architecture/browser-app.md)，不是測試。
- 新增一步時：劇本只用 `api.call(步驟名, 方法, 路徑, 選項)`；回傳含 id 就用 `api.name("名字", id)` 登記；步驟名是已知差異清單的鍵，不要隨便改（同名第二次出現會自動變成「名 #2」）。
  選項：`project`（只留該比較的欄位——流水號、隨機權杖、各宿主排序不同的清單不要留）、`headers`（`Idempotency-Key`、`Authorization: Bearer` 權杖）、`raw`（原始位元組的請求本文，備份上傳用）。
  搜尋這類真 Postgres（pgroonga）與 PGlite 排序不同的步驟，投影成排序過的標題集合，只比結果集合、不比順序。

### 全端 e2e：不用 docker 的雲端堆疊

```sh
cd packages/frontend
npm run e2e:cloud-stack -- --run bash -c 'cd e2e && npx playwright test --project=chromium $(ls fullstack/*.spec.ts | grep -v /zz)'
```

`e2e/fullstack/cloud-stack.mjs` 一個指令做完：build（後端、前端；`--skip-build` 沿用上次）→ 後端 `node dist/server.js`（PGlite、資料放暫存目錄）→
Astro node 伺服器 → 以 Node 內建 http 做同源轉發（取代 compose 的 nginx，聽 `:5099`，`E2E_BASE` 原樣可用）→ 跑 `--run` 後面的指令 → 收掉全部程序並刪暫存資料。
不帶 `--run` 就起好等 Ctrl-C。內部埠自動挑空的，`E2E_PORT` 可換對外埠（同時起兩套時用，另設 `E2E_STORAGE` 避免 storageState 檔相撞）。
首次 build 約 1.5 分鐘；全套 spec 的耗時與結果見 PR 說明。

- **時區寫死**：後端與瀏覽器端（`--run` 的子程序）都是 `TZ=UTC`，與 compose 的 backend、playwright 容器一致（兩者都沒設 TZ），日期類 spec 因此與筆電行為一致。兩邊必須同一個時區：瀏覽器時區與工作區時區不同時，擁有者會看到「旅行時詢問」卡片（`TimeZoneAsk`），它會擋住點擊；`E2E_BROWSER_TZ` 可覆寫，但要連工作區時區一起設。
- **瀏覽器版本**：預裝的 Chromium 版本若與 `e2e/package.json` 釘的 Playwright 不同，腳本在暫存目錄建符號連結對應，不需要 `playwright install`。
- **B 類略過**：`E2E_CLOUD=1`（`--run` 自動設）時 `playwright.config.ts` 略過 `scaleIntegrity.spec.ts`：它灌 5000+ 筆記，PGlite（單連線）跑 4 分多鐘，之後每個 API 都逾時，會連累字母序在它後面的所有 spec。留給筆電的真 Postgres。
- **站內 feed 位址**：`rssReader`／`composition` 讓後端抓自己的 `/site/feed.xml`；compose 裡是 `http://nginx`，雲端用 `E2E_FEED_ORIGIN`（`cloud-stack.mjs` 設為轉發的 loopback 位址，`helpers.ts` 的 `FEED_ORIGIN`）。
- **`zz*` 探針**：沒有 `expect`、只印數值的 126 個已搬到 `e2e/probes/`（不屬於任何驗收，綠燈不代表受保護；跑法：`npm run e2e:probes`，見該資料夾的 README）。留在 `fullstack/` 的 `zz*` 是有斷言的。上面的指令 `grep -v /zz` 仍然排除它們。用 `e2eContainer`／`psql`／`docker exec` 的探針需要 docker 與真 Postgres，不在雲端堆疊跑；它們在 `helpers.ts` 會因沒有 `E2E_COMPOSE_PROJECT` 而具名跳過。
- **失敗分類**（回報全端 e2e 結果時分開列，不混在一起）：A＝舊測試本來就壞（產品改了、spec 沒跟上；在 docker 的筆電上也會失敗）；
  B＝需要真 Postgres（pgroonga 全文搜尋、第二條連線、PG 專有行為；留給筆電）；C＝雲端堆疊的環境差異（轉發、SSR、時區、路徑、背景工作；要修啟動腳本或輔助，不改產品）。

## 輸入法（IME）組字測試

使用者主要用注音／拼音，輸入法的錯是資料錯（多字、少字、殘留拉丁字母、組字中被送出）。
改編輯器或任何文字輸入元件（輸入框、標題、標籤輸入、重新命名、搜尋、⌘K、快速捕捉、補全選單、白板卡片、屬性欄位）的 PR，這三組**必跑**：

- 靜態守門：`npm test -- src/test/guards/imeKeys.guard.test.ts`。在 Enter／Escape／Tab／方向鍵上做事的 keydown 處理，
  必須經過 `lib/keys.ts`（`isEnterKey`／`isEscapeKey`／`isImeComposing`／`onEnter`）或讀 CodeMirror 的 `view.composing`；
  新的例外只准寫進該檔的 `NO_TEXT_FIELD` 並寫明為什麼那裡不可能有文字欄位。
- 真瀏覽器 e2e（Chromium，用 CDP 的 `Input.imeSetComposition`／`Input.insertText` 模擬組字；
  helper 在 `e2e/fullstack/imeHelpers.ts`）：`imeEditor`（編輯器各位置）、`imeCompletion`（`/` `[[` `#` `@` 選單）、
  `imeInputs`（標題、搜尋、⌘K、+標籤、重新命名、快速捕捉、白板卡片、屬性、檢視分頁重新命名）。
  執行：`cd packages/frontend/e2e && npx playwright test --project=chromium imeEditor imeCompletion imeInputs`。
- 新增輸入元件時，在 `imeInputs.spec.ts` 加一個案例：組字中按 Enter 不送出、Esc 不關閉、完成後 Enter 才送出最終文字。

自動測不到：實體 Android／iOS 鍵盤（Gboard、三星鍵盤、iOS 注音）與 Safari。CDP 只模擬 Chromium 的組字事件，
不模擬各家鍵盤的事件順序（例如 Android 在 `keydown` 回報 `key: "Unidentified"`、組字結束後才補 `compositionend`）。

### 輸入法手動檢查清單（改編輯器或輸入元件的 PR，有實機時各跑一次；結果寫進 PR）

用實機注音或拼音（Android：Gboard 與三星鍵盤各一次；iOS：內建注音；桌面 Safari：注音）：

1. 筆記內文行首、行尾各打一句中文：不多字、不少字、不重複，沒有殘留的拉丁字母或注音符號。
2. 在 `[[連結]]`、`**粗體**`、`#標籤` 的緊接後面打中文（Obsidian 長期有「連結後多一個字母」的問題）。
3. 清單項目、待辦項目、表格格子、引用區塊、標題行裡打中文，選字用 Enter、空白鍵、點候選字各一次。
4. 組字到一半按 Enter 選字：不換行、不送出、不開選單項目。
5. 組字到一半改字、按 Esc／退格取消：留下的文字與預期一致，沒有殘留。
6. 輸入 `/`、`[[`、`#` 後用中文組字當查詢：選單隨最終文字篩選；組字中 Enter 只是選字。
7. 筆記標題、側欄搜尋、⌘K（或手機的搜尋）、新增標籤、重新命名：選字 Enter 不送出，完成後才送出。
8. 快速捕捉與白板卡片：打中文、選字 Enter 不存檔；存檔後內容就是最終文字。
9. 組字中等候數秒（自動儲存）或讓另一台裝置改同一則筆記：組字不被打斷，也沒有被換掉。
10. 重新整理後，剛才輸入的中文都在，沒有注音符號殘留。

## 模糊測試（fuzz）

解析不可信文字的程式（Markdown 管線、SVG 消毒、匯入器、解碼器、搜尋語法）有 `*.fuzz.test.ts`，
用 fast-check 加上 `src/test/fuzz-corpus/` 的惡意種子；一般 `npm test` 不跑它們。

- 在 repo 根目錄 `npm run test:fuzz`（約 30 秒）或 `npm run test:fuzz:long`（每項次數乘 20）；也可在單一套件目錄執行同名指令。
- 每次執行會在開頭印出 `[fuzz] seed=…`；重現失敗：`FUZZ_SEED=<seed> npm run test:fuzz`，fast-check 會印出縮小後的反例。
- 已確認、尚未修的缺陷寫成具名的 `it.fails("FINDING …")`，註解寫輸入與影響；修好後該案例會變紅，刪掉 `.fails` 即可。
  一般性質測試只略過屬於這些缺陷的輸入，其餘仍照常檢查。
- 新增惡意種子：加到對應的 `fuzz-corpus/*.json`（名稱 → 輸入字串）；種子只放無害的標記字串。
- 需要資料庫的匯入寫入路徑不在其中；它們的純函式層與請求驗證在內。

## 中文與 Unicode

使用者主要寫繁體中文，文字在每一層都要被正確處理：截斷、搜尋、命名、排序、強調、匯出匯入。這一批以隨機測試（fast-check）為主，
範例測試只當回歸。

- **產生器**：`packages/markdown/src/test/helpers/unicodeText.ts`。前端、後端以相對路徑 import（和 `htmlHazards.ts`、`linearTiming.testing.ts` 同一做法），
  不另抄第二份。涵蓋：常用繁中字（佔多數）、罕用字、CJK 擴充區（代理對）、全形標點與全形英數、全形空白 U+3000、注音、emoji（ZWJ 家庭、國旗、膚色、
  變體選擇字元）、組合字元與 NFD 形式、零寬字元與 BOM、NBSP、`\r\n`，以及 Markdown 語法片段（`**`、`*`、反引號、`[[ ]]`、`#`、`>`、`- [ ]`、`|`、`$`）的隨機交錯。
  常用字有權重，怪字元每片段機率低、但幾個片段內幾乎一定出現。常用入口：`unicodeText`、`unicodeMultiline`、`markdownText`、`titleText`、
  `hostileTitle`（檔名與網址的惡意標題，含全形括號、Windows 禁用字元、超過 255 位元組）、`proseBody`、`searchCorpus`／`pieceOf`（前後端搜尋共用同一批筆記與查詢）。
- **放在哪、誰會跑**：各套件的 `src/test/properties/*.property.test.ts`（需要資料庫的叫 `*.integration.property.test.ts`，沒有 `_test` 資料庫就跳過）。
  `npm -w packages/<套件> run test:props:long`（`PROPS_RUNS=5000`，種子預設為當天日期 `YYYYMMDD` 並印在輸出開頭，可用 `PROPS_SEED` 覆寫重現）會跑到它們；根目錄的 `npm run test:props` 只跑後端。
  靜態守門在 `packages/markdown/src/test/guards/textCut.guard.test.ts`。
- **多裝置同步的故障模擬**：`packages/frontend/src/test/properties/syncFaultSimulation.integration.property.test.ts`（`npm run test:sync-sim`）。
  每台「裝置」跑前端真正的寫入佇列、本機副本與同步引擎，`fetch` 接到後端真正的 `app`（真 Postgres），中間的網路可丟請求、丟回應、
  重複送達、延遲亂序、假在線（逾時）、整段停機；裝置可離線、重開。需要 `DATABASE_URL` 指向已建好 schema 的 `…_test` 資料庫（先跑過後端測試即可），沒有就跳過。
  同一個檔案的第二個性質「客戶端在任何一步死掉再重啟」（`Crash`、`Resume` 指令）：頁面在兩次儲存請求之間、帶著或不帶 pagehide、送出中的請求到或沒到伺服器、
  開著的 IndexedDB 交易保留或捨棄時死掉，用同一份本機儲存重新開機（走 `attachConnectivity`，和 App 一樣）；檢查「告知已保存的內文行、標題、建立不消失」、
  「同一冪等鍵只套用一次」、「裝置認為自己在線時，佇列在安靜時間內自己動」、以及原有的收斂與佇列排空。沒有真 Postgres 時用
  `ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test`（測試自己跑 migration）。
  已知問題以 `it.fails("KNOWN: …")` 留在檔尾，隨機測試預設繞開；`SIM_INCLUDE_KNOWN=1` 不繞、`SIM_STRICT_RETRY=1` 也要求「已生效寫入的重送要回成功」，`SIM_STATS=1` 印出實際打到哪些故障。
- **重現**：失敗時 fast-check 印出種子與縮小後的反例；`PROPS_SEED=<種子> PROPS_RUNS=<次數> npm -w packages/<套件> exec vitest -- run <測試檔>`。
  預設種子固定（20261023），所以平常的 `npm test` 是確定的；夜間跑換新種子。
- **找到反例怎麼處理**：小錯同一個 PR 修掉，並把種子與最小反例寫成同檔案的 `describe("regressions …")` 固定案例；會改變行為的，用 `it.fails("FINDING …")`
  寫下最小反例，另在 PR 列出讓擁有者決定。目前行為尚待決定的（全形／半形、零寬字元、排序語系）寫成「current behaviour」案例，改行為時它會變紅。
- **截斷使用者文字一律走 `@onden/markdown` 的 `graphemes.ts`**（`cutToUnits`、`cutToGraphemes`、`cutToCodePoints`、`cutToBytes`、`ellipsize`）。
  `String#slice(0, N)` 會切在字素中間（半個家庭 emoji、孤立代理字元「�」、少了重音的字母）。守門測試統計各檔的原始 `.slice(0, N)`，新增的必須是 id、日期、
  雜湊或清單並調高 `textCut.baseline.json`；移除後用 `UPDATE_TEXTCUT_BASELINE=1 npx vitest run src/test/guards/textCut` 降低。
  `snippet.ts` 在本機資料庫 worker 的打包裡，所以它自己帶一份最小的字素邊界函式，不 import `graphemes.ts`。
- **強調與中文標點**：解析器用 CJK 友善規則（`packages/markdown/src/cjkEmphasis.ts`，`remarkCjkEmphasis`），編輯器的即時預覽用同一個判斷（`cjkAttentionSides`，
  `frontend/src/lib/editorCjkEmphasis.ts`）；`frontend/src/test/properties/cjkEmphasis.property.test.ts` 要求兩邊找到相同的粗體／斜體範圍。
- **改到文字處理時必跑**：改截斷、摘要、片段、搜尋比對、slug／檔名、連結名稱、強調規則、字數、編輯器擴充、匯出匯入的任何程式前後，
  在 markdown、frontend、backend 各跑 `npm run test:props` 與守門測試。後端的資料庫案例需要 `DATABASE_URL` 指向 `_test` 結尾的資料庫；
  雲端沒有 docker 時，用 `scripts/persona/boot.sh` 前三步（apt、擴充編譯、Postgres 叢集與 schema）原生開 Postgres 16 + pgroonga，
  再以 `ONDEN_TEST_DB_KEEP=1` 沿用該資料庫（`globalSetup` 預設會重建，而 schema.sql 是 PG18 傾印，PG16 要先刪掉 `SET transaction_timeout` 那行）。

## 舊版前端對新版後端（版本偏差）

部署很頻繁，而 PWA 與桌面分頁會開著好幾天，所以「舊程式碼對新後端」每天都在發生：離線佇列裡舊程式記下的寫入會在新路由上重播，
舊的解碼器要讀新版的 bootstrap／sync 回應。兩個後端整合測試守這件事，它們讀 `packages/backend/src/test/fixtures/client-writes/<commit>/`：

- `clientWritesReplay.integration.test.ts`：把每一版前端的 writer 實際送出的請求（方法、路徑、Idempotency-Key、JSON body，含離線佇列存的那一份）
  在目前後端重播。通過＝每個請求都成功且資料列的結果等於使用者原本的意思（不是只看狀態碼），或被明確設計的、舊版畫面有訊息的 4xx 拒絕
  （`DESIGNED_REFUSALS`）。5xx、泛用的 `bad_request`、舊版沒有訊息的代碼都算相容性問題，列在 `KNOWN_INCOMPATIBLE` 並以 `it.fails` 標記，附修正建議。
- `clientReadsDecode.integration.test.ts`：執行各版留存的 `decodeBootstrapWire` 與 `applySyncDelta`，對目前後端的回應解碼，
  結果須與目前前端解碼器相同（筆記、標籤、任務、關聯、權限旗標）。

規則：保留最近 N 個正式版本（目前 4 個）。部署新版前執行 `npm run capture:client-writes -- <commit>` 並提交新目錄，刪最舊一版。
`transcribed.json` 是少數在元件裡才組出的請求（設定頁的成員與金鑰），由人照原始碼抄下，重新擷取時會保留。
擷取程式在 `packages/frontend/scripts/client-writes/`：它把 `captureWrites.harness.ts` 複製進該版本的 worktree、用該版自己的 vitest 執行，
所以記錄到的是那一版 writer 真正組出的請求。新增 writer 或情境時改這個 harness，再對每一版重新擷取。

## 變異測試（核心程式碼）

測試通過不等於程式碼被保護。變異測試（StrykerJS）故意改動程式碼，看有沒有測試因此失敗；沒有失敗的改動叫「存活變異」，
代表那一行可以被改壞而沒人發現。不在 `npm test` 內，需要時手動跑：

- 後端、前端、markdown 各自在套件目錄執行 `npm run test:mutation`（核心檔案清單在該套件的 `stryker.config.mjs`），
  單一檔案用 `npm run test:mutation:file -- src/spine/authority.ts`。結果在 `reports/mutation/`（已忽略，不進版本控制）；
  已開啟增量模式，重跑只重算有變動的部分。
- 後端要有測試資料庫（`DATABASE_URL` 指向 `_test` 結尾的資料庫）。整合測試共用同一個資料庫，所以只開一個 worker；
  跑之前先重建資料庫，殘留資料多了會讓 `spaceOverview` 等測試逾時。測試清單在 `vitest.mutation.config.ts`，
  新增核心檔案的測試時加進去。
- 沒有 AGE／pgroonga／pgvector 的環境，用 `ONDEN_MUTATION_SKIP_TESTS` 列出跑不起來的測試檔（逗號分隔）。
- 結果與解讀見 [docs/archive/research/mutation-2026-10-24.md](../archive/research/mutation-2026-10-24.md)。
