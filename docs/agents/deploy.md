# 部署、回滾與備份（VPS）

> 狀態：現行（最後確認 2026-11-01）

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
- switch 成功後自動清回滾映像：每個服務保留「和目前執行中不同」的最新 2 個（業主 2026-11-15；原本 3 個），其餘取消 tag；沒切換過的 `pre-*` 也一併清掉。
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

## 還原演練

備份從沒被證明能還原，migration 也只在空資料庫測過（migration 110 曾因此刪掉使用者標籤）。`scripts/restore-drill.sh`
在**自己的電腦**上把真備份還原到拋棄式資料庫、跑 migration、核對資料不變。它不連任何遠端主機，只碰名稱以 `_drill`
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
- 失敗時暫存目錄保留（路徑會印出；內含計數、id 與雜湊，不含內容）供查詢，通過時自動刪除；容器一律刪除。

要加新檢查：在 `drillInvariants.ts` 的 `COUNTS`（數量）或 `STRUCTURE`（回傳違規 id 的查詢）加一列。
腳本本身的測試：`scripts/restore-drill-selftest.sh <本機 PostgreSQL 管理網址>`（合成資料，驗證「該過的會過、該擋的會擋」；
用 `--no-docker` 模式，合成 schema 去掉 pgroonga／vector，所以 Docker 容器本身與這些 extension 的還原不在它的涵蓋內）。

## 清理與磁碟

- 回滾映像保留最近 2 次、release 保留最近 3 次；nginx 仍掛載的 release 與有 `KEEP.txt` 的備份不刪。
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
