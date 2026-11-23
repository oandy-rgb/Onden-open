# 部署、回滾與備份（VPS）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：scripts/deploy-vps.sh, scripts/backup-vps.sh, scripts/restore-vps.sh, scripts/restore-drill.sh, packages/frontend/e2e/probe/prod-probe.mjs, packages/frontend/e2e/probe/probeLib.mjs

何時讀：要部署到正式 VPS、回滾、做或還原備份，或正式站／localhost 連不上、登入出現 `INVALID_ORIGIN` 時。
每次部署在 docs/deploy-log.md（未隨公開庫附上） 加一列。以下流程整理自 2026-09-28～10-22 的實際部署紀錄
（[原始流水帳](../archive/vps-tailscale-http-2026-09-28.md)）；細節與例外以該檔及 `scripts/backup-vps.sh` 為準。
沒有使用者在對話中明確要求「部署」，不要部署。

## 環境

- 主機 `oandy-vps`（NixOS，Docker、Tailscale）；公網只開 SSH，服務經 Tailscale。正式網址是 Tailnet HTTPS（`tailscale serve` 轉到 `127.0.0.1:5180`），
  `APP_URL`／`CORS_ORIGIN` 在 `/srv/onden/shared/.env`（模式 600，秘密不進 Git）。
- 目錄：`/srv/onden/releases/<完整 sha>/`（每次一份原始碼）、`/srv/onden/current`（指向目前 release，內含 `REVISION`）、
  `/srv/onden/shared/.env`、`/srv/onden/backups/`。Compose project 名稱 `onden-vps`，映像 `onden-vps-<backend|frontend>:latest`
  （`compose.yaml` 的 `image:` 預設是自架用的 ghcr 名稱；`shared/.env` 設 `ONDEN_IMAGE=onden-vps` 才保持這個名稱，見 [release.md](release.md)）。
- **「今天」的時區與換日時間**：擁有者在 設定 › 時間 設定工作區時區（IANA 名稱）與「一天從幾點開始」（0–6 點），存在 `workspaces.time_zone`／`day_start_hour`
  （migration 137），後端啟動時讀入、改設定時立即更新（`localDay.ts`、`services/workspaceTime.ts`）。環境變數 `ONDEN_TIMEZONE` 現在只是
  **工作區從沒設過時的預設**（再沒有就 UTC）；已經設過的工作區不再看它。Postgres 連線一律 `TimeZone=UTC`，日期運算在 SQL 裡明寫時區與起算小時，
  所以改設定不需要重啟、也不會有連線留著舊時區。部署時不必為時區設定動 `.env`；要確認線上用的是哪個，看設定頁或 bootstrap 的 `workspace.time_zone`／`timezone`。
- nginx 容器掛載某個舊 release 內的 `docker/nginx/nginx.conf`；只有 nginx 設定改變才重建 nginx（先在拋棄式 `nginx:1.31-alpine` 跑 `nginx -t`，再 `up -d --no-deps --force-recreate nginx`）。

## 部署指令：`scripts/deploy-vps.sh`

下面 1–7 步都寫在 `scripts/deploy-vps.sh` 裡，部署一律用它，不再手動一步步做（在筆電、repo 內執行）：

- `scripts/deploy-vps.sh build <commit>`：上傳該 commit、在 VPS 建映像，**不動正式站**。映像標成 `onden-vps-<svc>:pre-<tree>-<commit>`，不碰 `latest`，
  所以可以**和測試同時跑**：測試一開始就對要驗收的疊合 commit 執行 build，測完合併後再 switch，不用等 build（約 2 分鐘）。
- `scripts/deploy-vps.sh switch <commit>`：上鎖、備份、打回滾 tag、切換、`/health`、`X-Onden-Build`、migration 紀錄、Chromium 開機檢查，
  最後印出一列 deploy-log 草稿（PR 與 migration 由 git 算出，備註自己補）。找的是 **tree 相同**的映像：疊合 commit 建好的映像，
  合併後的 main commit 只要 tree 一樣就直接用（`X-Onden-Build` 會是疊合 commit，`current/REVISION` 是 main commit）。tree 不同時會叫你先 build。
- **瀏覽器版與桌面版跟著同一版**（擁有者 2026-11-12）：switch 的開機檢查通過後，會接著跑 `scripts/deploy-clients.sh <commit>`：
  在獨立的 checkout（`../Onden-clients-build`，不是你正在用的工作目錄）建瀏覽器版並上傳到 https://onden.o-andy.com
  （Cloudflare Worker `onden-trial`；先過發布前掃描，上傳後核對 `build.json` 是該 commit），再建桌面版 AppImage 放到 `~/Applications`
  （下次開啟生效）。這一步失敗**不會**讓正式站部署失敗：deploy-log 草稿會寫「沒有更新成功」，照它印的指令重跑即可
  （`scripts/deploy-clients.sh <commit> browser|desktop`；`scripts/deploy-clients.sh status` 看兩邊各在哪一版）。
  兩個建置都吃記憶體（約 3 GB、十來分鐘），跟完整測試一樣一次只跑一個；需要筆電已 `npx wrangler login`。
- `scripts/deploy-vps.sh deploy <commit>`：build 再 switch。
- 預設只換前端；加 `--backend` 前後端都建、都換（migration 在 backend 開機時套用）。
- `scripts/deploy-vps.sh rollback before-<sha> [--backend]`、`scripts/deploy-vps.sh status`（正式版本、鎖、磁碟、各 tag）。
- 回滾映像由腳本自己清（同一條規則，數量不同）：**建置前**每個服務只留「和目前執行中不同」的最新 1 個（業主 2026-11-17：「只留最新一組」——建置最多要用掉 12% 的磁碟，原本每次部署都要先問他刪哪一組）；**switch 成功後**留最新 2 個（業主 2026-11-15；剛做出來的那一個加上建置前留下的那一個），其餘取消 tag；沒切換過的 `pre-*` 也一併清掉。所以平常主機上是兩組，建置當下是一組。
- 開機檢查用 `packages/frontend/e2e` 的 playwright；沒裝時依序找 `PLAYWRIGHT_LIB`、`/opt/node-tools`、`git worktree list` 裡其他 worktree 裝好的那份，都沒有才停。

小改動（只動前端少數檔案、沒有改共用元件）可以先跑 `scripts/fast-lane.sh` 就部署：前端 tsc、eslint、有 import 到改動檔案的測試
（`vitest --changed`），加上 markdown 套件的跨套件守門。完整套件留到下一批一起跑，deploy-log 註明「快速通道」。
改到後端、migration、共用元件（Modal、Popover、編輯器核心、同步）或在模組間搬 export 的，不能走快速通道。

不論走哪一條，合併前先過 `scripts/guard-lane.sh`（各套件的守門、markdown 與 site 測試；見 [testing.md](testing.md)）。

## 部署步驟（腳本內做的事）

1. 部署前確認沒有其他 session 正在部署，且 `current/REVISION` 是你以為的版本。
2. **換掉 `latest` 之前**把執行中映像打回滾 tag：`docker tag onden-vps-<svc>:latest onden-vps-<svc>:before-<sha>`
   （2026-10-14 一次 build 先換掉 `latest`，回滾映像沒做成；現在 build 只寫 `pre-*` tag，回滾 tag 在 switch 時打）。
3. 傳 release：`git archive <sha> | ssh … 解到 /srv/onden/releases/<sha>`，寫入 `REVISION`。
4. 在 VPS 執行 `backup-vps.sh`（版本化來源 `scripts/backup-vps.sh`）：短暫停 backend，做 `pg_dump -Fc` 與 content tar，產生 `SHA256SUMS` 並驗證，再以 `start` 恢復同一個 backend 容器（不重建，`ONDEN_BUILD_ID` 不會被清掉）。
   結果在 `/srv/onden/backups/manual-<UTC 時間戳>/`（模式 700）。
5. build 要換的服務（紀錄存 `backups/build-<sha>.log`），檢查 `check-app-css` 通過、`localDbWorker-*.js` 大小在預算內
   （目前預算 114,000 B，見 `packages/frontend/scripts/check-worker-bundle.mjs`；worker 不得打包 micromark／mdast／unified 等，`workerImports.test.ts` 守門）。
6. **`ONDEN_BUILD_ID=$(cat REVISION)` 要同時給 backend 與 frontend**（`compose.yaml` 兩邊都讀它）：backend 以 `X-Onden-Build` 回報，
   與頁面的 build 不同就顯示「有新版，重新載入」。只重啟一邊時另一邊的 id 會不同，開著的頁面會被提示一次。
   切換：`up -d --no-build --no-deps backend frontend`（只改前端就只列 frontend）；再把 `current` 指向新 release。
   migration 由 backend 開機時套用，紀錄有 `[migrate] applied NNN_…`。
7. 驗證（一定要用真的瀏覽器）：`/health` 回 `{"ok":true}`；首頁、`/api/site` 200；未登入 `/api/bootstrap` 401；backend 紀錄無 error；
   用 Chromium 開正式首頁沒有錯誤，並實際 `new Worker(...)` 載入 worker。只看 HTTP 狀態碼曾讓壞掉的前端（worker 載入失敗、App 一直轉圈）上線。
8. 在 deploy-log.md（未隨公開庫附上） 加一列（版本、PR、migration、回滾 tag、備份名、一句備註）。
9. 舊版前端會繼續連新版後端（開著的分頁、離線佇列裡舊版程式記下的寫入）。部署前一個 PR 就先執行
   `npm run capture:client-writes -- <要部署的 commit>`，把新版目錄提交，並刪掉已無人使用的最舊一版；
   `clientWritesReplay` 與 `clientReadsDecode` 兩個整合測試會用留存的每一版對照目前後端（見 [testing.md](testing.md)）。

## 靜態輸出（zip 下載、GitHub Pages、線上搜尋）：做一次、存起來、重複用

- 內容只在發布時變，所以靜態輸出**不在每次下載／推送時重爬**：發布完成、或下架／取消下架改變「最新快照扣掉下架」時，outbox 的 `site_bundle`
  工作（與 `pages_push` 一起排入、不擋發布回應、失敗會重試）向前端 SSR 伺服器逐頁取 HTML（`SITE_SSR_URL`，`compose.yaml` 預設 `http://frontend`，
  即前端服務的 `PORT: 80`；本機開發預設 `http://localhost:4321`），建好 Pagefind 搜尋索引，再整份存到**內容磁碟區**的 `content/site-bundles/<key>/`
  （沿用 `content_data`，沒有新磁碟區）。先寫進 `.tmp-*` 再整個改名，讀的人只會看到完整的一份；只留最新 2 份，其餘與放棄的暫存資料夾自動刪除。
- `<key>` ＝ hash（格式版本、`ONDEN_BUILD_ID`、快照 id、**已扣掉下架的網站內容**）。所以下架一定換 key，舊輸出不會被當成現在的網站；
  **部署新前端後 `ONDEN_BUILD_ID` 變了，第一次下載 zip 會重建一次**（約一輪爬頁時間，之後重用）。沒傳 `ONDEN_BUILD_ID` 時，部署後的輸出要等下次發布才會換成新樣式，所以部署照既有步驟傳它。
- `GET /api/export-static` 把存好的資料夾打成 zip；缺或過期時當場建（首次、或請求比排程工作早到；同時多個請求共用一次建置）。前端沒起來時 zip 回 502 `static_site_unavailable`，
  `site_bundle`／`pages_push` 由 outbox 重試並在紀錄寫明「check SITE_SSR_URL」。Pages 推送讀同一份，再換上 Pages 網址（不再爬第二次）。
- `content/site-bundles` 是快取：刪掉只會讓下次重建，所以 `docker/backup/run.sh` 的內容備份排除它。
- 線上 `/site` 搜尋讀同一份索引：前端 `/site/search.idx/*` 轉給 backend `GET /api/site/search.idx/*`（和 `/api/site` 一樣公開，網站一律公開、沒有存取閘門）。
  目前網站還沒有對應的存好輸出時回 503 並在背景開始建，頁面的搜尋框在索引可讀之前保持隱藏。**發布或下架後到新輸出建好之前，線上搜尋框暫時隱藏**（絕不用舊索引回答）。
- backend 與 frontend 的 `APP_URL` 要相同：頁面的 canonical、sitemap、feed 用 frontend 的 `APP_URL`，推送 Pages 時再換成 Pages 網址。
- 搜尋索引由 npm 套件 `pagefind`（backend 依賴）的 Node API 產生，它呼叫 `@pagefind/<平台>` 內的靜態連結（musl）二進位檔；glibc 的 runtime 映像（bookworm-slim）
  與 alpine 都能直接跑，Dockerfile 不需另外安裝。lockfile 已含 linux-x64／arm64 等所有平台項目；ARM 主機一樣可用。
- 部署後驗證：下載 zip，確認有 `site/index.html`、`_astro/*.css`、`404.html`、`site/search.idx/pagefind.js`，且 HTML 內沒有 `href="/site/` 或 `/_astro/`；
  從靜態主機（不是 `file://`）開啟並搜尋一個詞。
- 圖表（mermaid）腳本與 `_astro` 的字型、樣式由前端建置產出；zip 內只含實際被頁面引用的檔案。
- **內建的 Pages 推送擁有自己的分支**（`GITHUB_PAGES_BRANCH`，預設 `gh-pages`）：每次推送讓分支剛好是現在的網站，單一個沒有 parent 的 commit，
  被下架頁面的圖片一併刪除，分支歷史不留舊內容；手動加進該分支的檔案會在下次推送被移除。GitHub 仍可能暫時以舊 commit id 回應、既有 fork／clone 保留已取得的內容，這在 Onden 管不到。
  自訂網域的 `CNAME` 是唯一取自即時設定的檔案（綁定主機，不算內容）。網站一律公開，沒有「不推送」的受限模式。
- 沒有別的網站建置物：舊的網站殼（`dist-published`、`build:published`、`published_bundle` 磁碟區、`deploy-site.yml` 與分享連結）隨 P5 刪除，
  `compose.yaml`、Dockerfile、備份腳本都不再提到它們。

## 部署後檢查：線上巡檢（2026-11-23）

合併前的 CI 看不到「上線之後」的樣子（2026-11-23 擁有者自己用才發現本機版登出卡死、開機先閃英文、部署後第一次打開一直轉圈）。
`packages/frontend/e2e/probe/prod-probe.mjs` 就是看上線後的站：

- 本機版網站（`https://onden.o-andy.com`，資料只在瀏覽器）：Chromium 與 WebKit 各開一次**全新的瀏覽器設定檔**（繁體中文）。檢查：90 秒內開好（不卡在轉圈或「正在確認工作區資料」）、
  開機過程每個畫面都沒有英文字串、新增筆記打字重新整理後還在、本機版選單沒有「登出」、沒有未處理的錯誤。失敗留下截圖與頁面文字。
- 伺服器正式站：用專用巡檢帳號（一般成員）登入 → 新增標題帶日期的筆記 → 確認落在自己的個人空間、重新整理還在 → 永久刪除（刪除前確認範圍只有這一篇，否則不刪）。
  只動它自己建的那一篇。**密鑰 `ONDEN_PROBE_URL`／`ONDEN_PROBE_EMAIL`／`ONDEN_PROBE_PASSWORD` 沒設就印「略過：巡檢帳號未設定」**，報告看得到，不失敗也不假裝通過。
- 每天自動跑（`ci.yml` 的 `scheduled-probe`，結果進 scheduled-report）。**部署後手動跑**：`cd packages/frontend && npm run probe:prod`
  （`-- --only local` 只跑本機版、`-- --engines chromium` 只跑一種引擎、`-- --out <資料夾>` 指定失敗證據放哪；伺服器段要先在 shell 設那三個環境變數）。
- 已知會紅、正在別的 PR 修的項目在 `packages/frontend/e2e/probe-known-baseline.json`（只准減少）：不讓巡檢失敗，但報告一定列出；修正上線、巡檢看到通過，就把那一行刪掉。
- 腳本自己的判斷由 `npm run probe:prod:selftest` 驗（英文閃過會被抓到、密鑰不存在就略過、已知紅與新紅分開）。

## 回滾

- 只回滾前端或後端：把 `before-<sha>` 重新標成 `latest`（壞掉的映像改名留存，如 `broken-<sha>`），`up -d --no-build --no-deps <svc>`。
  前後端版本不一致期間要在紀錄註明受影響的功能。
- **同步協定加版（`CLIENT_PROTOCOL` 變大）之後退版的後果**：只退**前端**時，每台裝置的本機副本（`local_copy_protocol` 較新）會被舊前端拒絕開啟，
  頁面改用伺服器資料並顯示「重新載入」，重新載入沒有用，直到再升版；副本本身不會被改動，升版後原樣可用。只退**後端**時（協定必須相同才同步，後端回報的協定和前端不同），
  前端會停止送出寫入與同步並顯示「伺服器需要更新」，佇列保留。退前端前先確認加版的 PR，必要時前後端一起退，並在 deploy-log 註明。
- migration 多半只新增資料表，舊版 backend 可忽略；會刪資料的 migration（例：110 刪除 Excalidraw 匯入原檔）部署前須有使用者明確同意，
  並用 `KEEP.txt` 標記該備份、清理時不可刪。需要還原資料時用部署前備份；回滾映像若被 `docker builder prune` 清掉，從 release 目錄重建。
- 備份還原演練見下一節「還原演練」；`scripts/restore.sh`、`scripts/backup.sh` 是通用版本。
  備份不含 `.env` 密鑰，重建主機時另行保管。

## 還原：還原後的資料庫換一個新的節點編號

每個伺服器有一個節點編號（`sync_node`），它寫下的每一筆修改都記著「哪個編號、第幾號」。備份裡帶著當時的編號與號碼；
伺服器在備份之後又往下編了號，所以還原後如果沿用舊編號，接下來的修改會用到**已經發出去過、內容不同**的號碼。
因此 `scripts/restore.sh` 載入備份之後、任何寫入之前（包括開機時的 migration），會讓資料庫換一個新編號
（`scripts/lib/renewNodeId.sh` → `scripts/lib/renewNodeId.sql` → migration 213 的 `sync_renew_node_id()`）。
不變條件：**任何一次還原結束時，節點編號一定是新的、舊編號記成這台以前的編號；做不到就拒絕、什麼都不動**，不會以結束碼 0 留著舊編號。

- 新編號從第 1 號開始編；**已經存著的東西一筆都不改**：備份之前的修改仍記在舊編號名下。
- 舊編號改記成「這台握有的另一個來源，握到第 N 號」（`sync_origins`，`vouched_by = 'self-restore'`）。
- 時鐘不會比資料庫裡任何一筆修改記的時間早。
- 換號之後仍能給新裝置快照：快照把舊編號當成這台自己的（`former`），新裝置加入後同時記著新、舊兩個編號（舊的記成「這台伺服器帶來的來源」），之後雙向的修改包照常收（migration 214；測試 `nodeRenewal.integration.test.ts`「gives a new device its snapshot」）。
  舊編號是來源自己報的，所以加入時會核對：每個編號都要是節點編號的格式、最多 32 個、每一頁都相同，而且送來的舊編號標記不能超過它報的號碼；不合就整個拒收（`join_bad_former`、`join_wrong_former`、`join_stamp_beyond_former`）。
  資料形狀升到 3，所以**版本 2 與版本 3 的節點之間**快照與修改包一律拒收（`join_data_shape`／`bundle_data_shape`），要兩邊都升級。

- 被蓋掉的資料庫原本若是**另一個**編號（備份之後它又被還原、換過號），那個編號也記成這台以前的編號，握到 0（備份裡沒有它的修改，別台握有的可以送回來）。

怎麼做到（`scripts/restore.sh`；收 `backup.sh` 的 `onden-<時間>.sql.gz`、`pg_dump -Fc` 的 `database.dump`、`backup-vps.sh` 的 `manual-<時間>/` 資料夾）：
1. **先把整份備份讀一遍、驗過，才動任何東西**：解得開（gzip 的 CRC、`-Fc` 由 `pg_restore` 整份讀過）、結尾有 `pg_dump` 最後那一行「dump complete」；資料夾附的 `SHA256SUMS` 要相符。
   壞掉、被截斷（包括剛好斷在一行或一個語句的邊界）都在這一步拒絕，資料庫沒動。
2. **載入到一個新的資料庫** `<名稱>_restoring`，換號也在那裡做（換號的列只在整份備份進去之後才出現；備份的來源中途失敗，就沒有那一列，新資料庫丟掉）。
   不在正在用的資料庫上清 schema：正在用的那一份（含 pgroonga 的索引）從頭到尾沒被碰過，也不需要一個拿著上千把鎖的大交易。
3. **兩者都成功才對調名字**，一個交易：還原好的拿到原來的名字，被換下來的改名 `<名稱>_before_restore_<UTC 時間>` 留著，就是還原前的安全複本（`restore.sh` 會印出刪掉它的指令；要不要刪由人決定）。
   所以還原期間需要的空間約等於資料庫的大小，再加上載入時 WAL 的成長（最多到伺服器的 `max_wal_size`，預設 1 GB，檢查點會回收）：compose 模式先看 postgres 容器的磁碟，
   需要「較大的那份 × 1.1 ＋ min(那份, 1 GB)」，不夠就拒絕（`--no-space-check` 跳過）；`DATABASE_URL` 模式看不到伺服器的磁碟，只印提醒。
   開始時列出之前的還原留下的 `<名稱>_before_restore_*` 與大小：每份都是一整個資料庫，**沒有人會自動刪**；確認不需要了就 `DROP DATABASE "<名稱>";`。
   被換下來的資料庫**一個工作區都沒有**時（compose 的 postgres 開機時只載入 schema 的那個空資料庫）不留複本：裡面沒有可以退回去的東西，對調之後就刪掉並說一聲。
4. 任何失敗、被拒、中途被中斷（`Ctrl-C`、`kill`）：正在用的資料庫完全是還原前的樣子。最壞只留下一個 `<名稱>_restoring`，下一次執行會先把它丟掉。
   對調名字需要沒有人連著那個資料庫：先停後端；還有連線（只算人或程式的連線，`backend_type = 'client backend'`，不算 autovacuum 這類伺服器自己的工作）就拒絕，並列出是哪個程式。
   對調送出之後才被中斷時，腳本會問資料庫實際是哪一個，照實說「已經還原完成」或「維持原樣」；問不到就說怎麼自己確認（第 2 輪審查 A1）。
   載入完成、對調還沒送出時被中斷：說「維持原樣」並丟掉 `<名稱>_restoring`（2026-11-22 筆電演練找到：這一格以前在 `set -e` 下一聲不吭地以 1 結束）。
   對調本身失敗（有人在這期間連上）：丟掉 `<名稱>_restoring`、說資料庫維持原樣；再跑一次會重新載入整份備份。
5. **同一個資料庫一次只有一個還原**：這台機器上的鎖（`$TMPDIR/onden-restore-<目標的雜湊>.lock`，記著行程編號）；第二個直接拒絕、什麼都不問伺服器。
   持有鎖的行程已經不在（`kill -9`）時，下一次接手。
6. **含 Apache AGE 的舊備份**（2026-10-31 之前）：`scripts/lib/strip-age.sed` 是唯一的一份規則，`restore.sh` 與 `restore-drill.sh` 共用。
   `-Fc` 先過濾 `pg_restore -l` 的目錄、再用 `-L` 只還原其餘項目（`ag_catalog` 裡的每一項，包括 AGE 設定表的 `TABLE DATA`，以及 `age` 的 extension 與註解）；
   純 SQL 逐行刪掉同樣的項目，包括 `COPY ag_catalog.… FROM stdin;` 到 `\.` 的資料區塊。AGE 的圖（另外的 schema）不在這份規則裡：Onden 從沒建過圖（見「移除 Apache AGE」）。

- 備份來自 migration 213 之前的版本（沒有 `sync_renew_node_id()`）：`renewNodeId.sql` 帶著 migration 自己的定義（`scripts/lib/renewNodeIdSql.mjs` 從 migrations 逐字取最後一份，守門測試核對；它只認得 `CREATE OR REPLACE FUNCTION fn(` 加 `$$` 的寫法，遇到別的寫法或 `DROP FUNCTION` 直接失敗，不會悄悄漏掉），
  只在資料庫缺少時裝上再換號；已經有的不覆蓋（主機上的 checkout 比備份舊時，不會換成較舊的定義）。之後開機的 migration 以 `CREATE OR REPLACE` 定義同樣的函式。
- **拒絕**（結束碼 1，資料庫不動）：備份來自 migration 190–205 的版本（2026-11-12～16：有編號、卻沒有 `sync_origins` 可以記舊編號）；或備份沒有編號（190 之前）、被蓋掉的資料庫卻有。
  備份沒有編號、目標是空資料庫時照常完成（從沒編過號，第一次寫入才取得編號）。
- **被拒時的出路**：`--keep-node-id`。照樣還原、**保留**資料庫手上的編號，大聲印出後果：這台之後可能編出伺服器已經發過的號碼，**在每台和它交換過的裝置重新加入之前，不能和它們交換**；
  資料庫記下這件事（`sync_restore_kept_node_id`：何時、保留的編號、被蓋掉的編號、原因），交換的那一批要在這張表有列時拒絕（合併核心 README「接上傳輸前必須完成」）。
  換得了號的備份帶這個旗標照樣換號（它只是被拒時的出路）。

看到什麼：還原成功時多一行 `[restore] the restored database is a new node: id <舊> -> <新> …`，以及安全複本的名字；拒絕時 `ERROR: restore refused, nothing was changed: <原因>` 與 `--keep-node-id` 的用法。
沒有腳本經手的還原（磁碟快照、自己跑的 `pg_restore`）之後跑 `bash scripts/lib/renewNodeId.sh …`：結束碼 0 換好、3 資料庫沒有編號（不用換）、4 換不了（原因在 stderr，資料庫沒動）、1 psql 失敗（沒動）。

- 後端開機**從不**換編號（守門：`packages/backend/src/test/guards/restoreRenewsNodeId.guard.test.ts`）：只有還原指令知道資料庫被還原過。
- `scripts/upgrade.sh rollback` 經過 `restore.sh`，所以自動涵蓋。舊版映像用一次性的環境變數下載，`.env` **在還原前一刻**才切到舊版本；
  還原（對調名字）完成之前，失敗、被拒或被中斷（`Ctrl-C`）都會把 `.env` 切回原本的版本、重新啟動服務；完成之後中斷，版本留在舊版（資料已是舊版的）。
  腳本靠 `onden_before_restore_<這次的時間>` 在不在判斷還原是否完成（守門：`restoreRenewsNodeId.guard.test.ts`「scripts/upgrade.sh rollback」；`scripts/upgrade-selftest.sh` 含 `Ctrl-C` 的情形）。
- 桌面版的還原（選單手動還原、升級失敗退回、補完中斷的更新、使用者自己把資料夾放回去）同一份 SQL，見 [桌面版說明](../desktop/README.md)「還原之後的節點編號」。
- `scripts/deploy-vps.sh rollback` **不是還原**：它只把映像標籤換回 `before-<sha>`，資料庫不動，所以編號不換也不該換。
  需要把 VPS 的資料庫倒回部署前備份時，在 VPS 上跑 `scripts/restore-vps.sh /srv/onden/backups/manual-<時間> --yes [--with-content]`：拿 `deploy.lock`（與 `deploy-vps.sh` 同一把）、停後端、
  用這台的 compose（`-p onden-vps`、`shared/.env`、`current/compose.yaml`）跑同一個 `restore.sh`、再啟動後端。
  `--with-content` 在後端停著時把上傳檔換成備份裡的（先清空 `onden-vps_content_data` 再解 `content.tar`，先核對 `SHA256SUMS`）；不帶它，資料庫是備份的、檔案是現在的
  （備份之後上傳的還在、備份之後刪掉的不見了），腳本會說明。不要在後端跑著時手動解 `content.tar`。
  整機或磁碟快照回滾沒有腳本可掛：啟動後端之前自己跑 `bash scripts/lib/renewNodeId.sh <連到那個資料庫的 psql 指令>`。
- `DATABASE_URL` 模式用主機的 `psql`／`pg_restore`：PG 18 的 `pg_dump` 會在備份裡寫 `\restrict`，主機的 psql 早於 17.6 時讀不懂，還原會在驗證或載入時失敗（資料庫不動）；裝同一個大版本的用戶端，或改用 compose 模式（容器裡的工具與伺服器同版）。
- 這些腳本只讀未加密的備份檔：把備份加密後存到異地（例如用 age）的，還原前先解開成原本的 `onden-<時間>.sql.gz`、`database.dump` 與 `SHA256SUMS`。

## 還原演練

備份從沒被證明能還原，migration 也只在空資料庫測過（migration 110 曾因此刪掉使用者標籤）。`scripts/restore-drill.sh`
在**自己的電腦**上把真備份還原到拋棄式資料庫、換新節點編號（與 `restore.sh` 同一步，見上一節）、跑 migration、核對資料不變。它不連任何遠端主機，只碰名稱以 `_drill`
結尾的本機資料庫，輸出只有數量、id 與雜湊，不印筆記內容。

何時跑：**每次含新 migration 的部署之前**（用要部署的 commit），以及**每週一次**（用最新的 `manual-*` 備份）。

1. 把備份目錄（`manual-<時間戳>/`，含 `database.dump`、`content.tar`、`SHA256SUMS`）複製到本機。
2. 需要 Docker 與已 `npm ci`：`scripts/restore-drill.sh <備份目錄> [--commit <要部署的 ref>] [--bootstrap]`。
   不給 `--commit` 就用目前 checkout 的 migration；`--bootstrap` 另外以擁有者讀一次 `buildBootstrap`（`/api/bootstrap` 背後的函式，非 HTTP 請求；它自己會補建個人空間等資料，所以在比對之後才跑）。
3. 沒有 Docker 才用：`--no-docker --database-url postgres://…@localhost/<名稱>_drill`（本機 PostgreSQL，版本須與產生備份的 `pg_dump` 相同，且要有 pgroonga、vector；舊備份裡的 age 項目會被略過）。

怎麼讀結果：每步印 ✓ 或 ✗，最後一行「通過」且結束碼 0 才算過；結束碼 1＝有違反條件，2＝用法或環境問題。

- ✗ **數量**（筆記、垃圾桶、標籤、連結、標籤套用、屬性、任務、白板、空間、成員）migration 前後不同；事件紀錄只能增加。
- ✗ **內文／標題雜湊改變**或**節點消失**：列出 id。migration 若真的要改寫，須在自己的 SQL 寫
  `-- drill: allows note-bodies`（或 `note-titles`、某項計數的名稱，見 `packages/backend/scripts/drillInvariants.ts`）；
  這時該項改列為「△ 已聲明」，不算失敗，但審查者要看清單。
- ✗ **結構**：父層不存在、筆記掛在標籤底下、標籤套用或連結指向不存在的列。訊息會註明是 migration 造成還是備份原本就有。
- ✗ **媒體**：現行筆記引用的檔案不在 `content.tar`（備份不完整）。
- ✗ **migration 失敗**：只印失敗的檔號、PostgreSQL 錯誤代碼與表／約束名稱。
- ✗ **節點編號**（`node_id_renewed`）：還原後沒有換成新編號、舊編號名下的修改標記在還原後被寫入或改寫、舊編號沒有變成「握有到第 N 號」的來源、
  或時鐘比備份裡的標記還早。成功時印「節點編號：已換新」。這一項不能用 `-- drill: allows` 聲明掉。
  第 5b 步在 migration **之前**換號（`restore.sh` 的位置，213 之前的備份也是）；備份來自 migration 190–205 的版本時演練停下（`restore.sh` 不帶 `--keep-node-id` 會拒絕它）；
  備份沒有任何編號（190 之前）時印 △、不比對這一項。
- 失敗時暫存目錄保留（路徑會印出；內含計數、id 與雜湊，不含內容）供查詢，通過時自動刪除；容器一律刪除。

要加新檢查：在 `drillInvariants.ts` 的 `COUNTS`（數量）或 `STRUCTURE`（回傳違規 id 的查詢）加一列。
腳本本身的測試：`scripts/restore-drill-selftest.sh <本機 PostgreSQL 管理網址>`（合成資料，驗證「該過的會過、該擋的會擋」；
用 `--no-docker` 模式，合成 schema 去掉 pgroonga／vector，所以 Docker 容器本身與這些 extension 的還原不在它的涵蓋內）。

## 清理與磁碟

- 回滾映像保留最近 2 次（建置當下 1 次）、release 保留最近 3 次；nginx 仍掛載的 release 與有 `KEEP.txt` 的備份不刪。
- **還原留下的資料庫複本**（`onden_before_restore_<時間>`，`restore.sh`／`restore-vps.sh` 每還原一次多一份，大小約一整個資料庫）也佔這顆磁碟，而且不會被自動清：
  確認還原沒問題後 `sudo docker compose -p onden-vps … exec postgres psql -U onden -d postgres -c 'DROP DATABASE "onden_before_restore_<時間>";'`。下一次還原開始時會列出還在的複本與大小。
  `deploy-vps.sh` 在 90% 拒絕部署時只列 `before-*` 映像標籤，這些複本也要看。
- 每次部署約多 2.7 GB 建置快取；`deploy-vps.sh switch` 做完會自動清掉（業主 2026-11-14 同意；只清建置快取，不動映像、回滾點與 release 目錄），
  下一次建置因此從頭來、會慢一些。`docker builder prune` 可能刪掉執行中映像的內容，所以腳本清完會逐一確認執行中映像與回滾映像都還建得出容器，
  壞了會印 `IMAGE DAMAGED AFTER PRUNE`。
  磁碟逼近 85% 時先清再部署（最近一次紀錄：87%，剩 7.4 GB，未清理）。

## 連線與登入診斷（原 AGENTS.md「驗證與完成條件」）

- 部署連線被拒絕時，先查主機服務與監聽埠。Compose 的容器 restart policy 不會啟動 Docker daemon；
  分別驗證主機開機啟動、容器健康及正式 HTTP 回應。恢復現存服務不應重建缺少原設定的部署，
  也不能以清除本機資料或放寬登入來源修復停機。實例見 [localhost 服務恢復](../archive/localhost-service-recovery-2026-09-16.md)。
- 驗證登入須分清電腦 localhost 的手機 viewport 與實體手機的區網／公開網址；後者有不同 origin。
  `INVALID_ORIGIN` 不能靠停用來源檢查或反射任意 Host 解決，維護部署的精確允許清單。
  工作區建置與隔離服務通過不等於 Docker 已更新，回報時核對實際提供的前端版本與部署是否已套用。
  本次來源拒絕及部署權限限制見 [手機登入診斷](../archive/mobile-login-origin-2026-09-15.md)。

## `ONDEN_SECRET_KEY` 與備份分管（API 跑法）

使用者的 Anthropic API 金鑰存在資料庫 `ai_credentials`，只存 AES-256-GCM 密文；解密用的 `ONDEN_SECRET_KEY`（32 位元組，64 個十六進位字元或 base64）
只來自部署環境（`/srv/onden/shared/.env`），**不在資料庫、不在設定畫面**。沒設這個變數，API 跑法整個不出現（不是灰掉）。

- 產生：`openssl rand -hex 32`。**遺失它，已存的金鑰全部讀不出來**（要使用者重新貼上），所以另外保管一份。
- **資料庫備份（`pg_dump`、`backups/`、GitHub 備份）含密文，不含 `ONDEN_SECRET_KEY`**；兩者必須分開保管：備份放在一處，金鑰放在另一處（密碼管理員）。
  不要把 `.env` 放進備份檔或內容 tar。
- 換金鑰（輪替）目前沒有工具：做法是設新 `ONDEN_SECRET_KEY` 後，請使用者在「空間與成員 › API 金鑰」撤銷舊的並重新貼上。
- 測試用的 `ONDEN_ANTHROPIC_BASE_URL` 只給測試指向假伺服器；**正式環境不要設**（設了，金鑰會被送到那個網址）。
- 建議在 Anthropic Console 為這把金鑰建專用 workspace 並設花費上限，是 Onden 之外的最後一道保險。

## `VAPID_*` 與鎖屏提醒（Web Push）

任務提醒在手機鎖屏、分頁被凍結時也要準時響，靠伺服器用 Web Push 送。三個變數都設了才會出現（任何一個沒設、或金鑰不能用，
功能整個不出現，不是灰掉；後端只在啟動時警告一次）：

| 變數 | 內容 |
| --- | --- |
| `VAPID_PUBLIC_KEY` | 公鑰（base64url）。瀏覽器訂閱時用，可以公開。 |
| `VAPID_PRIVATE_KEY` | 私鑰（base64url）。**只放 `/srv/onden/shared/.env`**，不進映像、不進 log、不進備份。 |
| `VAPID_SUBJECT` | 推播服務出事時能聯絡你的位址：`mailto:你的信箱` 或 `https://你的網址`。 |

- 產生一組（VPS 沒有 openssl 與 python3，用 node；兩條擇一）：
  - 在後端容器內：`docker compose exec backend node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey)"`
  - 在筆電上：`npx web-push generate-vapid-keys`（輸出的 Public Key／Private Key 對應上面兩個變數）。
- 寫進 `.env` 後重啟 backend（`docker compose up -d backend`）。**換一組金鑰，所有裝置要重新開啟提醒**（舊訂閱是綁舊公鑰的），所以產生一次就保管好。
- 訂閱（裝置位址與加密金鑰）存在資料庫 `push_subscriptions`，備份會帶；它們不是登入憑證，但仍不要公開。
- 送出的內容只有任務標題與提醒時間，不含筆記內文。同一個提醒時刻只送一次（記在 `push_reminder_sent`），多個 backend 行程不會重送。
- 裝置端限制：iOS 要先「加到主畫面」才收得到推播；Android 的 Brave 預設關閉 Google 推播服務，要到 Brave 設定開「使用 Google 服務進行推播通知」。

## 移除 Apache AGE 的部署順序（2026-10-31）

AGE 從未被產品程式使用。拆兩步，**順序不可顛倒**：

1. 先部署含遷移 `158_drop_age` 的版本（映像仍含 AGE）：遷移在沒有 AGE 圖時 `DROP EXTENSION age`；有圖就失敗並停下，不刪資料。
2. 遷移 `158_drop_age` 套用成功（部署紀錄有記）之後，才換成不含 AGE 的映像（映像不再編譯 AGE，`shared_preload_libraries` 只剩 `pg_stat_statements`）。
   自架者升級要把自己的 compose／設定檔裡的 `age,` 一併拿掉，否則 Postgres 找不到 `age.so` 而無法啟動。

全新安裝不再建立 AGE；舊備份還原時由 `scripts/lib/strip-age.sed` 略過 age 相關項目（`restore.sh`、`restore-drill.sh`）。

## 升級含 migration 201（自動建立的項目換 id）前（2026-11-14）

這個 migration 改寫既有資料的 id（收件匣／技能／網站設定標籤、設定筆記、預設／系統／個人空間、這些空間的任務筆記與日記），
只有擁有者看過正式環境的預覽數字並同意後才部署：

1. 在唯讀連線跑 migration 檔頭的預覽查詢（`packages/backend/db/migrations/201_derived_ids_function_ref_stamps.sql`），看每個用途改幾列、保留哪幾列與原因。
2. 讓工作佇列清空再部署：`SELECT count(*) FROM outbox WHERE status = 'pending'` 為 0（預覽的「left as is」列也會數出指到舊 id 的待辦）。
   還在排隊、指到舊 id 的工作（例如某則被換 id 的筆記的 `embed`）會像刪掉的筆記一樣失敗並重試到放棄；下次編輯會重新排入。
3. 部署前先做整庫備份並跑還原演練（`scripts/restore-drill.sh`；migration 已宣告 `-- drill: allows notes_gone`）。
4. 部署後：開著的分頁與離線佇列裡指向舊 id 的寫入會落空（`membership_epoch` 已加一，裝置重讀可讀範圍）；請使用者重新整理。
