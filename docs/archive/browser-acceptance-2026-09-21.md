# 瀏覽器產品驗收執行紀錄（2026-09-21）

> 狀態：歷史紀錄（最後確認 2026-11-01）

唯一案例清單：[full-feature-audit.md](../research/full-feature-audit.md)。本文件記錄執行證據，不另立驗收項目。

## 目標與提交邊界

- 目標為非環境 151 項全部已盤且通過，部分／待盤歸零；原 12 項設備及外部服務保留需環境。
- 直接在 `main` 按完整使用案例提交，不 push、不合併遠端變更。每批先跑相關測試、兩端 lint／typecheck 與前端 build；大批次另跑完整 CI 等價驗證。
- 權限、purge、撤權、故障與競態僅在隔離 `onden_test` 執行。正式 localhost 只用 `驗收-<timestamp>` 可清理資料。
- 正式服務重建以前，須找回原設定、DB／content 備份及 checksum，並完成拋棄式資料庫還原演練。

## 起始基線

- 起始 commit：`43da4800cf2272d08a3a1610ce519dd1247bd0bd`；分支 `main`；起始工作樹乾淨。
- 主機 Node.js `v22.23.1`，npm `10.9.8`。
- 清單：18 類、163 項；已盤 5、部分 111、待盤 35、需環境 12。既有狀態尚未以本輪結果推進。
- 根目錄 `preflight` 只含兩端 typecheck 及前端 build，不能代表 lint、單元、PG 或 E2E 已通過；完整流程以 `.github/workflows/ci.yml` 為依據。
- 首次 `npm ci --offline` 因缺少 katex／playwright-core 快取失敗，改以原 lockfile 線上安裝，不升級依賴。

## 正式部署來源待確認

本輪唯讀檢查：Docker context 僅 `default`（`unix:///var/run/docker.sock`），主機名 `laptop`，DockerRootDir `/var/lib/docker`；容器、image、volume 都為 0。Podman 同樣沒有容器或 volume。repository 沒有 `.env` 或 `backups/`，`http://localhost:80` 連線被拒絕。

這與計畫所指的「既有容器」不一致。已向使用者確認原主機／context／備份位置；未猜測秘密、建立替代正式資料、重建正式容器或宣稱完成正式備份。本機隔離驗證可繼續；正式備份／還原／smoke 仍缺來源。

額外唯讀核對 k3s：僅有 flux-system／kube-system 的系統服務，沒有 Onden pod 或 persistent volume。

## 本輪基線結果

來源均為起始 `43da480`，產品程式尚未修改。依賴由根 lockfile 安裝 1,428 個套件，E2E lockfile 安裝 3 個套件；沒有更動 lockfile。

| 檢查 | 結果 | 限制／證據 |
| --- | --- | --- |
| 兩端 lint | 通過 | backend `npm run lint`；frontend `npm run lint`（0 warnings） |
| 兩端 TypeScript | 通過 | `npx tsc --noEmit`；frontend 先 `ASTRO_TELEMETRY_DISABLED=1 npx astro sync` |
| 前端完整 Vitest | 203 檔／1,582 項通過，0 失敗／跳過 | `/tmp/onden-acceptance-frontend-unit.json` |
| 後端完整 Vitest（無 DB） | 收集 213 檔、1,763 項；1,033 通過，0 失敗，730 跳過 | `/tmp/onden-acceptance-backend-baseline.json`；730 項必須另在 PG 執行，不能算通過 |
| 前端 build | 通過 | `/tmp/onden-acceptance-frontend-build.log` |
| 後端 build | 通過 | `/tmp/onden-acceptance-backend-build.log` |
| Playwright collection | 132 檔／298 項，5 個 project | `/tmp/onden-acceptance-e2e-list.log`；僅收集，未宣稱執行通過 |
| 後端完整 Vitest（真 PostgreSQL） | **213 檔／1,763 項通過，0 失敗／跳過** | `/tmp/onden-acceptance-backend-pg-baseline.json`；`onden-acceptance` 的 `onden_test` |
| 隔離 full-stack E2E | 初跑中斷，未取得 298 項完整結果 | `onden-e2e` 使用獨立資料卷；已觀察到失敗，但原始失敗輸出未完整留存，GAP-65 須逐案重新重現 |
| 正式備份／還原／smoke | 尚未執行 | 等待正式部署來源 |

初次沙箱執行 `safeFetch` 有 6 個 `listen EPERM`，`askProvider` 的本機 server setup 超時；相同程式在允許 loopback socket 的完整後端重跑全部通過。這是執行限制，不登錄為產品 GAP。初次 Astro sync 因使用者設定目錄不可寫中止，關閉遙測後成功。

15 份基線原始輸出另保存於 repository 的 `.acceptance/2026-09-21/baseline/`，附 `SHA256SUMS`；目錄 0700、檔案 0600，已 gitignore。完整 DB／content 備份的預設 `backups/` 也已加入忽略，避免把實際資料隨驗收提交。

隔離 image 首次建置並未通過：Postgres 在 `git clone https://github.com/apache/age/` 出現 `Could not resolve host`；應用 image 的 `npm ci` 出現 `read ETIMEDOUT`；Playwright image 讀取逾時。主機 DNS／registry HTTP 200 正常後，使用僅供本次建置的 `/tmp/onden-acceptance-build-network.yaml` 設定 `build.network: host` 重試，沒有修改正式 Compose 或 Dockerfile。這些是建置環境結果，不作為產品缺陷或通過證據。

重試已完成三個應用 image 與 Playwright image。隔離 PostgreSQL 實測為 18.6，擴充 AGE 1.7.0、PGroonga 4.0.6、pgvector 0.8.2、pgcrypto 1.4、pg_stat_statements 1.12；`current_database()` 明確為 `onden_test`。Playwright image digest 為 `sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948`。

已修正前端 `pretest` 的誤導訊息：它原本警告不存在的前端 PG 測試，並指向不存在的 `test:integration:docker` script。開發 README 不再宣稱 265／117／12 個測試，也不把目前單元測試當成完整產品驗收。

### GAP-64：harness 的過期 Timeline 預期

- 案例：NAV-01／SYS-02 的瀏覽器測試基線；原始產品來源 `43da480`。
- 環境：鎖定 Playwright image 的 Chromium，1280×360 元件 harness；不連 DB，角色／scope 不適用。
- 原步驟：執行 `packages/frontend/e2e/run.mjs`，開 `?view=timeline`，要求 Places trigger 為 active。實際 13/14，該斷言失敗。
- 契約核對：`components/lenses.tsx` 明確將 Timeline 從 PLACES 移除；`useUrlLocation.ts` 仍保留 legacy URL，完整 app 由 secondaryLens 開啟歷史。這是測試期待過期，沒有恢復多餘選單入口。
- 修正：改驗實際存在的 Tasks 深連結選中；另驗 legacy Timeline URL 保留，但不選中不存在的 Place。原有返回、History lens、Graph、Tags 及 underline 斷言保留。
- 重驗：相同 Chromium **16/16 通過**，`/tmp/onden-acceptance-harness-retest.log`。無產品程式修改；此為 harness 缺陷已修，完整 NAV／SYS 案例狀態仍未推進。

## 已選定的契約及執行狀態

- DEC-01／TASK-07：task 節點負責角色與政策，宿主筆記負責 human／token tag scope；agenda、bootstrap、sync、by-id、PATCH、membership 與撤權必須一致。
- DEC-02／NOTE-11／PER-02：普通複製只支援 content。`POST /api/nodes/:id/duplicate` 接受客戶端 UUID 及原冪等鍵，回傳完整新節點；同一事件交易檢查來源可讀、建立、父層及每個直接標籤能力。
- 副本包含正文、目前父層、使用者可見明確屬性、媒體引用與目前直接標籤；不複製版本、任務、關聯、衍生／繼承／內部索引，也不觸發標籤 automation／default／template。
- `as_new_node` 保留 wire shape，歷史正文搭配來源目前父層與標籤；透過獨立內部操作記錄 TAG_APPLIED 關係歷史。

設計比較與執行結果將隨對應批次補入；以上為使用者定案的目標契約，不表示實作或驗收已完成。

### TASK-07 設計草圖

1. 各入口自行組合 `taskPolicy`／`hostScope`：agenda、day、bootstrap、sync、membership、單筆讀取與寫入都必須知道 task 的表示法；新增入口仍容易遺漏一半政策。現有 agenda 已這樣組合，其他入口則對 task 自身套 scope，正是本次不一致的來源。
2. 在既有讀取與寫入政策內共用「此節點的 tag scope 對象」：一般節點用自身，task 用同工作區宿主；角色／政策仍對 task 與祖先檢查。逐筆、SQL predicate 及集合讀取使用同一規則，路由繼續呼叫既有政策介面。

選擇第二種；不加入客戶端可指定的 scope 對象。重要不變條件為：task 的額外直接標籤不能放寬宿主 scope，human／token 同時存在時取交集，task 自身限制仍生效，宿主不存在／不可讀不能洩露任務。無實際欄位變更的 PATCH 也必須完成授權。跨入口回歸現已納入 `packages/backend/src/test/taskScopeContract.integration.test.ts`，實際結果如下。

### 副本操作設計草圖

1. 前端 `create` 後依序保存父層、屬性與標籤：需要每個入口理解保存順序，任一步失敗可能留下不完整或失去政策標籤的副本，普通套標籤還會重新觸發 automation。
2. 領域操作在事件交易內讀取來源並一次建立安全副本：REST 與歷史另存重用同一副本規則；獨立內部關係操作記錄 TAG_APPLIED，但不執行 automation。

選擇第二種。普通複製的呼叫者只提供來源及穩定的新 UUID／冪等鍵；歷史操作仍自行擁有正文復原及衝突規則。拒絕必須回滾節點、屬性、標籤與成功事件；重送不能重建，也不能因另存副本而撤回來源的 cascade。現有普通複製只送 title／markdown／node_type，歷史另存雖保留 parent_id 卻沒有直接標籤；此為來源核對結果，尚待執行失敗重現。

### GAP-66：TASK-07 授權一致性修正進行中

- 環境：隔離 `onden-acceptance`／`onden_test`，真實 PostgreSQL、actor／token／tag policy；session HTTP 使用 assembled app，僅注入 upstream session identity。
- 初次有效失敗重現：12 項中 7 失敗、5 通過，`/tmp/onden-acceptance-task-scope-before.log`。human／token／交集的宿主授權在 agenda 允許，bootstrap 卻漏掉 task；task 自身 scope 標籤又可讓 membership 與 agenda 不一致。
- 測試界線：公開 bearer 一律仍為 MCP credential，REST 回 403；內部 token 路由測試不是開放 REST 的證據。測試初稿誤以為 token 可以走一般 REST，已修正，未放寬產品邊界。
- 修正：共用 task scope 對象與宿主生命週期；agenda 使用共用 SQL 政策；PATCH 在事件鎖內核對可讀與所有請求能力，包含相同值，且在交易內讀回結果。正式契約見 [task-authority.md](architecture/task-authority.md)。
- 相關回歸：7 檔／93 項通過，包含新 16 項跨入口測試；`/tmp/onden-acceptance-task-scope-targeted.log`。涵蓋正常 scope、空 scope、交集拒絕、task 自身讀寫政策、撤權／membership epoch／held task delete、無變更 PATCH、宿主軟刪除／retained 歷史及移動。
- 2026-09-21 當時仍缺完整修正後 PG 回歸、lint／typecheck／build、隔離瀏覽器重驗與重載／重連證據；2026-09-25 的補驗及剩餘限制見下節。

### GAP-67：撤權觸發首次教學資料

TASK-07 首次瀏覽器授權斷言通過後，逐張核圖發現最後重載仍可能只拍到 boot spinner。加入已載入 Tasks 與空計數斷言再跑，才看見「This change was rejected」內含自動教學正文。另補明確攔截，重現撤權期間額外 `POST /api/nodes`（1280px 失敗，`/tmp/onden-acceptance-task-seed-e2e-before.log`）。不能把先前 3/3 當成完整通過。

設計比較：

1. 前端只加角色或空列表判斷：scoped admin 仍可能沒有可見內容，本機快取也不能證明工作區空白。
2. bootstrap 提供 `example_seed_eligible`，僅對未受 human／token scope 限制的 admin 且投影空白為 true；前端另等 membership 完成及線上空列表。缺欄位的舊 server／本機快取預設不自動建立。

選擇第二種。此欄位只是 UI 自動教學資格，不授予寫入能力；建立仍通過一般 writer／後端授權，不新增工作區管理入口。多裝置同時首次 seeding 的原子去重不是此欄位提供的保證。後端新增 admin／scoped admin／editor／viewer 與非空對照；瀏覽器另要求沒有自動建立請求和失敗復原面板，並確認桌面鍵盤與手機勾選保存。

## 2026-09-25：TASK-07／GAP-66／GAP-67 重驗

- **環境與身分：**獨立 `onden_test` 資料卷、真實 PostgreSQL、隔離 localhost `127.0.0.1:5100`、鎖定 Playwright Chromium。PG 測試以 admin、editor、viewer 及 human／token scope 驗角色／政策交集；公開 bearer 仍只可用 MCP，REST 回 403。瀏覽器用真實 session：owner 建立 UUID 前綴的宿主、標籤與任務，另一個限定該標籤的 editor 登入。
- **正常步驟與結果：**PG 比對 agenda、bootstrap、sync delta／by-id、membership、單筆、SQL 集合及 PATCH，任務在宿主 scope 內一致可讀可寫，task 自身限制繼續生效。Chromium 於 1280、390、320px 看見任務、勾選完成，伺服器讀回 `done`；桌面另以鍵盤 Space 操作；owner 重設狀態後重載，三種寬度都顯示任務且無水平溢出。
- **失敗、撤權與重連：**PG 驗空／不交集 scope、task 自身 read／write 政策、無變更 PATCH、宿主移動或軟刪除均正確拒絕，拒絕不新增成功事件。瀏覽器讓 editor 離線、owner 移除宿主標籤、editor 重連；任務從 agenda 消失，單筆及 PATCH 回 403，by-id 無任務。再重載並等 agenda 確認為 0，三種寬度皆無自動 `POST /api/nodes`、無失敗復原面板；這也回歸 GAP-67 原先的假空工作區教學資料缺陷。
- **執行輸出：**PG 專項 2 檔／24 項通過（其中 TASK-07 契約 17 項），前端相關 4 檔／78 項通過；兩端 lint 與 TypeScript 通過。前端 build 於 2026-09-21 20:05 成功，晚於本批所有產品前端來源修改，產物含 `example_seed_eligible`；本次 Chromium 執行使用該產物的薄層 image，沒有重建整套 image。Playwright Chromium 以 `--workers=1` 跑 3 項／3 項通過、無重試；截圖中 320px 保存與撤權後版面符合斷言。原始 log、JSON、截圖與 SHA256 位於本機 gitignore 的 `.acceptance/2026-09-25/task-07/`；測後已停止隔離容器以釋放資源。
- **狀態與限制：**GAP-66、GAP-67 的 TASK-07 缺陷已修且重驗，DEC-01 落成正式契約，TASK-07 改為已盤且通過；總表成為已盤 6、部分 111、待盤 34、需環境 12。PER-03、SYS-04、ACC-02 整列尚未因此完成。完整 298 項 full-stack E2E 尚無成功結果，原正式部署來源、備份／還原演練及正式 localhost smoke 仍待確認；本段不宣稱整體交付完成。

## 2026-09-25：NOTE-11／DEC-02 安全副本

設計比較見前述「副本操作設計草圖」，正式介面與副作用見[安全副本契約](../architecture/note-duplicates.md)。原入口把複製當一般建立，來源檢查已確認它只送標題、正文和型別；目前父層、明確屬性與直接標籤都遺漏（GAP-68）。原歷史另存查目前正文後套 inverse patch，也沒有直接標籤，來源後續編輯可能混入歷史內容（GAP-69）。新回歸會在舊版缺少 `/duplicate` 端點時失敗，但為節省主機資源，本輪沒有另啟舊版完整 stack 跑一次紅測。

- **環境、角色及正常步驟：**同一隔離 `onden_test`；PG 用 admin、editor、human／token tag scope 驗來源、目前父層與每個直接標籤的權限。普通 API 接受客戶端 UUID 和共用冪等鍵，回 `201` 完整新節點；PG 核對正文媒體 URL、明確屬性中的媒體 URL、目前父層、直接 tag 與 `TAG_APPLIED` 關係狀態。`dispatcher`／匯入索引／`_published` 不複製，on_apply 沒執行，來源明確圖邊也沒帶到副本。
- **拒絕與重送：**PG 驗來源不是 content／是 task 回 422、標籤或父層不許可回 403、新 UUID 已占用回 409；即使先寫入標籤、後續屬性權限拒絕，整筆不留新節點、標籤、屬性、成功事件或已提交冪等鍵。同鍵模擬回應遺失重送只建立一次，返回共用 `200 {deduped:true}`。前端 writer 在回應遺失時把相同 UUID／key 的請求持久排隊，永久 403 只回滾這次 optimistic 副本並保存拒絕意圖；離線複製也走同一佇列。
- **歷史另存：**`as_new_node` 保留既有 wire shape，歷史正文由該事件的 post-edit blob 套 inverse patch 重建；來源即使再修改，副本仍是原歷史正文，父層與直接標籤則採目前值。缺可信歷史快照時回 `history_incomplete` 409，保留原節點及因果子事件，不假造成功。
- **瀏覽器：**只跑 Chromium、`--workers=1`，1280px 和 320px 各一項。真實 UI 開來源筆記，從 More actions 選 Duplicate，伺服器回傳新節點並保存屬性；重載後仍讀到副本正文，畫面無水平溢出。兩項均通過並留截圖。這只驗普通複製 UI；歷史另存的可見性由上述 PG 回歸驗證，HIST-07 整列仍需更多事件種類。
- **數量與保留證據：**最新隔離後端定向 3 檔／53 項通過、前端定向 4 檔／60 項通過、Chromium 2／2 通過；兩端 lint／TypeScript 與前後端 build 通過。本批瀏覽器使用既有 image 疊加編譯產物，測後關閉容器；原始 log、JSON、截圖與 SHA256 存在本機 gitignore 的 `.acceptance/2026-09-25/note-duplicate/`。NOTE-11 已盤通過，總表已盤 7、部分 110、待盤 34、需環境 12；PER-02 還缺其他查詢／生命週期入口，仍部分。正式 localhost 的備份、還原與 smoke 條件仍未具備。
