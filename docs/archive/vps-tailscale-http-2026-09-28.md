# NixOS VPS 的 Tailnet HTTP 部署（2026-09-28）

VPS 依鄰近 `nixos` 倉庫核對為 `oandy-vps`、NixOS 26.11；該倉庫本來就
啟用 Docker、Tailscale、僅開放公網 SSH 與 Tailscale UDP，並信任
`tailscale0`。本次沒有修改／重建 NixOS，也保留該倉庫既有未提交的
`hosts/oandy-laptop/default.nix`。部署 Onden 提交 **`620d29c`** 到
`/srv/onden/releases/620d29c`，`/srv/onden/current` 指向該發行版。
VPS 本地產生獨立 PostgreSQL 密碼與 Better Auth 密鑰，保存在
`/srv/onden/shared/.env`（模式 `600`）；秘密沒有寫進 Git 或測試輸出。

依使用者要求，正式網址使用 Tailnet 內的 HTTP：

- `http://oandy-vps.tail9249f1.ts.net:5180`
- `http://100.84.227.77:5180`

`APP_URL` 以 MagicDNS 名稱為主要網址，`CORS_ORIGIN` 精確允許上列
兩個 origin；nginx 僅綁 `100.84.227.77:5180`，沒有公網 5180 listener，
PostgreSQL、後端與前端容器也未發布公網埠。沒有設定 Tailscale Serve
或 Funnel。MagicDNS 使網址易讀；存取限制來自 Tailnet，而非 DNS 名稱。
HTTP 在 Tailscale 通道內傳輸，但瀏覽器仍把這種非 localhost 的 HTTP
網址視為非 secure context，原生 picker、麥克風等能力仍須另外驗收。

正式啟動前，以相同三個 Onden 映像建置一次性 `onden-vps-smoke` stack，
只綁 `127.0.0.1:5181`、使用獨立資料卷及 AI stub。隔離帳號註冊
`200`、已登入 bootstrap `200`、筆記建立 `201`、讀取 `200`、PATCH
`200`、重讀保存後文字 `200`。該 stack 的 DB dump、content volume
各完成 SHA-256 校驗；拋棄式 DB 還原後可找到更新過的筆記，content
逐檔比對相同。測畢刪除隔離容器與全部測試資料卷；受限目錄
`/srv/onden/backups/smoke-20260928134252` 保留演練檔與 checksum。

正式 `onden-vps` stack 從全新持久資料卷啟動，PostgreSQL healthy，
四個服務均運作。Tailnet IP／MagicDNS 的首頁各回 `200`，未登入
bootstrap 回 `401`；從兩種來源送不存在帳號的登入請求各回正常的
`401`，沒有 `INVALID_ORIGIN`。正式資料庫 `user` 數為 **0**，沒有
驗收帳號殘留，第一位使用者可自行註冊。正式空白資料卷備份位於
`/srv/onden/backups/baseline-20260928134603`，DB/content checksum
及拋棄式還原也通過，還原後使用者數為 0、content 逐檔相同。
備份目錄模式 `700`；往後可在 VPS 執行
`/srv/onden/shared/backup.sh`（版本化來源為 `scripts/backup-vps.sh`）做短暫
停寫的 DB/content 備份。尚未設定定期備份排程。

使用者完成首次註冊後，再執行一次手動正式備份，目錄為
`/srv/onden/backups/manual-20260928134954`，並將整份備份傳到這台工作機的
`/var/home/oandy/桌面/git/Onden-notes/manual-20260928134954`（不在 Git 倉庫內、
備份目錄 `700`、檔案 `600`）。傳送及移動後 DB 與 content 的 SHA-256 均與
來源一致，DB 封存可列出，並已在拋棄式資料庫還原出 1 個使用者；內容 tar
可讀。後端已恢復，HTTP
首頁仍回 `200`。此備份不包含 `.env` 中的密鑰，重建另一台服務時仍須另行
保管設定。後續備份腳本改用相對路徑 checksum，方便在其他主機直接驗證。
後續使用者改採只傳 Markdown 的 Git 文字備份；本機 DB/content 目錄已不在
`Onden-notes`，VPS 原始備份仍在。這項變動見
[Markdown Git 備份紀錄](vps-markdown-git-backup-2026-09-28.md)。

部署後 Onden 四容器約使用 293 MiB 記憶體，VPS 根分割區約剩 32 GiB。
這台工作機沒有正式 Onden 容器／資料卷及 `.env` 可搬遷，因此 VPS
目前是空白獨立實例；若舊資料在另一台主機，需另做有來源校驗的遷移。
隔離 smoke 已驗證同版映像可讀寫；正式資料庫已出現 1 個首次註冊帳號，
但**使用者本人在正式 URL 的筆記讀寫**尚待回覆，不將之冒充已完成。
本次 VPS 部署也不取代原計畫要求的
正式 localhost 備份／部署 smoke 或 151 項完整驗收。

## 22:28 歡迎卡片邊界修正

前端更新到 **`6695ce4`**，`/srv/onden/current` 改指向
`/srv/onden/releases/6695ce4`。本次只有前端樣式／測試與文件變動；後端及
compose 與 `620d29c` 沒有差異，因此只建置、重建 frontend 並 reload nginx。
部署前備份 `/srv/onden/backups/manual-20260928142722` 的 DB/content
checksum 均通過；備份短暫停止後端，之後已恢復。

Tailnet IP 與 MagicDNS 首頁各回 200，未登入 bootstrap 回 401。正式 HTTP
送出的 CSS 與容器產物 SHA-256 相同，且舊 240px 背景分隔線已不存在。
四個服務運作、PostgreSQL healthy；本輪沒有在正式站新增帳號／筆記或做
寫入故障測試。布局的 10 項單元與 6 項隔離無頭瀏覽器驗證見
[歡迎卡片與側欄邊界](welcome-sidebar-boundary-2026-09-28.md)。

## 23:12 頂部導航與閱讀比例試用

前端更新到 **`47d22bb`**，`/srv/onden/current` 指向
`/srv/onden/releases/47d22bb`。後端與 compose 相對 `6695ce4` 沒有差異，
只建置／重建 frontend 並 reload nginx；沒有更改 NixOS、登入來源或網路
綁定。舊前端映像保留為 `onden-vps-frontend:before-47d22bb`，舊 release
亦保留，以供回退。

部署前 `/srv/onden/backups/manual-20260928150535` 的 DB/content SHA-256
均通過，後端已恢復。第一次透過 stdin 傳入部署腳本只完成備份便正常
結束；核對 current 及建置紀錄後確認尚未套用，改為先傳送完整腳本檔、
以空 stdin 執行，重新核對已有備份才建置，沒有以 exit 0 冒稱部署完成。

正式切換後 Tailnet IP 與 MagicDNS 首頁各回 200，未登入 bootstrap 回
401。前端剛啟動時一次 502 由有界重試恢復，最終四個服務均 running、
PostgreSQL healthy。實際 HTTP CSS 與新容器產物 SHA-256 均為
`0541b42a80ee839e80c125a74027edbf5286f9a225bdb7ca8dea425dd0276784`，
包含本輪筆記比例樣式；前端產物亦含頂部導航。部署證據保存在
`.acceptance/2026-09-28/top-navigation/vps-deploy.log`，VPS 建置紀錄為
`/srv/onden/backups/frontend-build-47d22bb.log`。

本輪正式站只做讀取檢查，未新增帳號／筆記，也沒有故障注入或資料清理。
相關單元100項、隔離無頭Chromium17項及兩端TypeScript／lint、前端build
均通過，細節與限制見[本輪試用紀錄](top-navigation-trial-2026-09-28.md)。
隔離測試容器與資料卷已移除，未將這組測試當成163項完整驗收。

## 23:35 桌面／手機選單與新增筆記

前端更新到 **`d21b9a2`**，current 指向 `/srv/onden/releases/d21b9a2`。
部署前備份 `/srv/onden/backups/manual-20260928153246` 的 DB/content
checksum 均通過；本輪備份以 `start backend` 恢復原容器，沒有重建相依
資料庫。後端與 compose 相對 `47d22bb` 未變，只建置／重建前端及 reload
nginx；舊映像保留為 `onden-vps-frontend:before-d21b9a2`。

切換時一次短暫502由有界重試恢復。四服務均running、PostgreSQL healthy。
VPS及工作機核對 Tailnet IP／MagicDNS 首頁均200、未登入bootstrap為401。
正式HTTP樣式與新容器產物的SHA-256一致：
`c410686ffb4e9dacfdfc599bf5dd8b4a0ab89879cc25473cdf4e0577a5d3289e`。
新產物含頂部導航、Create new note及本輪按鈕樣式。正式站僅做讀取檢查，
未新增帳號或筆記；備份、部署及工作機smoke證據保存在
`.acceptance/2026-09-28/menu-parity/`。

已通過相關單元46項、隔離單工Chromium10項、兩端typecheck／lint與前端
build；截圖及範圍見[本輪驗收紀錄](navigation-menu-parity-2026-09-28.md)。

## 2026-09-29 00:02 更多選單分組雙欄

前端更新到 **`cbae6c4`**，current 指向 `/srv/onden/releases/cbae6c4`。
使用者確認分組雙欄草圖後實作，桌面與手機共用日常／整理與發布／工具三組。
相關單元47項、隔離單工Chromium11項、兩端typecheck／lint與前端build
通過；細節與限制見[本輪驗收紀錄](grouped-more-menu-2026-09-28.md)。

部署前備份 `/srv/onden/backups/manual-20260928155923` 的DB/content
checksum均通過；使用`start backend`恢復同一後端容器。後端及compose
相對`d21b9a2`未變，本輪只建置／重建前端並reload nginx；舊前端保留
為`onden-vps-frontend:before-cbae6c4`，未改NixOS、Tailnet來源或正式資料。

切換時一次502由有界重試恢復，最終四服務均running、PostgreSQL healthy。
VPS與本機核對MagicDNS／Tailnet IP首頁均200、未登入bootstrap為401。
HTTP實際送出的分組選單CSS與容器產物SHA-256一致：
`ecbac67cf3f04ba2445e1cf9812e6ad40b85345e5943ff144da489335b7372a3`。
新產物也含Organize and publish及手機雙欄樣式。正式站僅做讀取檢查，
未新增驗收帳號／筆記；證據位於`.acceptance/2026-09-28/grouped-menu/`，
VPS建置紀錄為`/srv/onden/backups/frontend-build-cbae6c4.log`。
隔離測試stack及資料卷已移除，本輪不推進163項總表狀態。

## 2026-09-29 00:30 導覽入口去重與側欄搜尋

前端更新到 **`350889f`**，current 指向 `/srv/onden/releases/350889f`。
桌面更多移除頂列已有的今日／搜尋／閱讀／複習／設定；手機依可見入口
去重並保留詳情頁可用的搜尋。側欄筆記搜尋預設收起，以按鈕或快捷鍵展開。
相關單元74項、20個不同隔離Chromium案例最終有成功證據，兩端
typecheck／lint及前端build通過；首輪失敗與定向補驗分開保留，詳見
[本輪驗收紀錄](navigation-entry-deduplication-2026-09-29.md)。

部署前備份 `/srv/onden/backups/manual-20260928162709` 的DB/content
checksum均通過，使用`start backend`恢復同一後端容器。後端與compose
相對`cbae6c4`未變，只建置／重建前端並reload nginx；舊前端映像保留為
`onden-vps-frontend:before-350889f`。沒有修改NixOS、登入來源或網路設定。

切換時一次502由有界重試恢復，最終四服務均running、PostgreSQL healthy。
VPS及工作機確認MagicDNS／Tailnet IP首頁均200，未登入bootstrap為401。
實際HTTP送出的CSS與容器產物SHA-256一致：
`d502fdc2ac5c9041d47a59877188027f4a6747862840bc044580aaa23a875139`。
產物含本輪一次性搜尋聚焦與收合按鈕。正式站僅做讀取檢查，未新增帳號／
筆記或寫入故障測試；證據位於`.acceptance/2026-09-29/deduplicate-navigation/`。
隔離stack及資料卷已移除。本輪未重跑全套驗收，不推進163項總表狀態。

## 2026-09-29 01:21 編輯區與歷史入口整理

前端更新到 **`b1f6f5d`**，current 指向 `/srv/onden/releases/b1f6f5d`。
內容／歷史／資訊分工，版本與事件集中歷史頁，資訊欄移除重複開關與
空關聯區塊，顯示設定按需展開。相關單元63個不同案例、隔離單工
Chromium整組25項通過；最後名稱調整後再驗13項全數通過，不重複計數。
兩端typecheck／lint、前端build通過；邊界與失敗修正見
[本輪驗收紀錄](editor-layout-refinement-2026-09-29.md)。

部署前備份 `/srv/onden/backups/manual-20260928171827` 的DB/content
checksum均通過；使用`start backend`恢復同一後端容器。後端與compose
相對`350889f`未變，只建置／重建前端並reload nginx；保留舊映像
`onden-vps-frontend:before-b1f6f5d`。沒有修改NixOS、登入來源或網路設定。

切換時一次502由有界重試恢復，最終四服務均running、PostgreSQL healthy。
VPS與工作機核對MagicDNS／Tailnet IP首頁均200，未登入bootstrap為401。
實際HTTP送出的CSS與容器產物SHA-256一致：
`ee976a1b180ef7c7562222f396caf2a1a247ff68a8f2c9be38d4575c632dc370`。
產物亦包含本輪版本歷史元件。正式站僅做讀取檢查；證據保存在
`.acceptance/2026-09-29/editor-layout/`，VPS建置紀錄為
`/srv/onden/backups/frontend-build-b1f6f5d.log`。隔離stack及資料卷已移除，
未將本次介面驗證當成163項完整驗收。

## 2026-09-29 01:54 資訊欄精簡歷史與浮動視窗

前端更新到 **`7795c3e`**，current 指向 `/srv/onden/releases/7795c3e`。
移除中央上方內容／歷史列，資訊欄底部顯示最近三筆版本；點選直接開啟
浮動比較視窗並預選該版本，正文保持原位。相關單元5檔31項與隔離
Chromium 6檔27項通過；手機關窗導覽位置另重驗其中1項，不重複計數。
兩端typecheck／lint、前端build通過，細節見
[本輪驗收紀錄](inspector-history-2026-09-29.md)。

部署前 `/srv/onden/backups/manual-20260928175138` 的DB/content
checksum均通過，使用`start backend`恢復同一後端容器。後端與compose
相對`b1f6f5d`未變，只更新前端及reload nginx；保留舊映像
`onden-vps-frontend:before-7795c3e`，沒有修改NixOS、登入來源或網路設定。

切換時一次502由有界重試恢復，最終四服務均running、PostgreSQL healthy。
VPS及工作機核對MagicDNS／Tailnet IP首頁均200，未登入bootstrap為401。
實際HTTP送出的CSS與容器產物SHA-256一致：
`356128ec17c7f39c8e1564836352dde139d2bfb8889128328ee6b404027d8a01`，
並核對產物包含資訊欄footer及版本歷史元件。
正式站僅做只讀檢查；部署／工作機smoke／隔離清理證據在
`.acceptance/2026-09-29/inspector-history/`，VPS建置紀錄為
`/srv/onden/backups/frontend-build-7795c3e.log`。隔離服務及資料卷均已移除。
本輪不是完整本機CI或163項全部驗收，不更新其完成總數。

## 2026-09-29 標籤操作、當前身分與事件交易

後端更新到 **`d87466e`**，current 指向 `/srv/onden/releases/d87466e`；
前端保留 `7795c3e`。沒有 schema migration，NixOS、登入來源及 Tailnet HTTP
設定保持原狀。修正內容、紅測、完整後端 1,853 項、前端完整回歸與過期斷言
補驗，以及單 worker Chromium 18 項的結果，見
[本批驗證與邊界](tag-authority-fixes-2026-09-29.md)。

備份 `/srv/onden/backups/manual-20260928194209` 的 DB/content checksum 通過。
在拋棄式資料庫完成 pg_restore（12 節點、46 事件），content tar 解開到獨立
資料卷；演練資源已清除。目錄 0700、備份與既有 `.env` 0600。
只重建後端及 reload nginx；舊映像保留為
`onden-vps-backend:before-d87466e`。建置紀錄為
`/srv/onden/backups/backend-build-d87466e.log`。

四個服務 running，PostgreSQL healthy，後端健康端點 200。
VPS 與工作機均確認 MagicDNS／Tailnet IP 首頁 200、未登入 bootstrap 401。
五個核心編譯檔 checksum 與本機驗證產物一致；正式站僅作讀取檢查。
證據在 `.acceptance/tag-authority-2026-09-29/`；本批隔離服務與資料卷已清除，
163 項總表完成數未變。

## 2026-10-11 tag 白板、白板變動存檔、註冊開關與排程備份

部署 `release/2026-10-11` 的 **`4ca7bab`**（合併 `fix/cheap-critical` 580f844 與
`feat/tag-board-lens` ecd859f），`/srv/onden/current` 指向
`/srv/onden/releases/4ca7babe728f456f2ffceda6f249301ad819be7e`。這次包含後端、
migration（`084_member_removals`）與 compose 變更，因此重建 backend、frontend 並新增
`backup` 服務，不是只換前端。

- 部署前備份 `/srv/onden/backups/manual-20261011124536`（DB dump、content tar、
  SHA256SUMS；同目錄保留 `env.before`、`build.log`、`up.log`）。舊映像標記為
  `onden-vps-backend:before-20261011`、`onden-vps-frontend:before-20261011`。
- `shared/.env` 新增 `ONDEN_BACKUP_DIR=/srv/onden/backups/scheduled`（模式 700）；
  `backup` 容器啟動後立即寫出第一份 `onden-*.sql.gz` 與 content tar，之後每 24 小時一次、保留 14 份。
- 部署前後資料筆數相同：使用者 1、筆記 9、白板 1、tag 2、卡片位置 8、node_tags 4；
  migration 84→85。
- MagicDNS／Tailnet IP 首頁 200，未登入 bootstrap 401，`/api/boards/:id` 未登入 401（路由存在），
  後端 health 200。新帳號註冊回 403 `SIGNUP_CLOSED`，使用者數仍為 1。
- 尚未在正式站以登入帳號實際開 tag 白板或拖卡片；這部分只在本機 :5399 驗過。

回滾：前端／後端可用上述 `before-20261011` 映像與舊 release 的 compose 重建；migration 084
只新增資料表，舊版後端可忽略。需要還原資料時用部署前備份。

## 2026-10-11 改為 Tailnet HTTPS（PWA 可安裝）

瀏覽器只在 HTTPS 下允許安裝 PWA，因此正式網址改為
**`https://oandy-vps.tail9249f1.ts.net`**。使用者在 Tailscale 後台開啟 HTTPS
Certificates；`nixos` 新增 `modules/services/onden-https.nix`（指令
`onden-tailscale-serve`／`onden-tailscale-stop`），以 `tailscale serve --https=443`
轉到 `http://127.0.0.1:5180`。Serve 設定由 Tailscale 保存在已持久化的 `/var/lib/tailscale`。

`shared/.env` 改為 `APP_PORT=127.0.0.1:5180`、`APP_URL` 與 `CORS_ORIGIN` 為上述 HTTPS 網址
（舊值在 `/srv/onden/backups/manual-20261011124536/env.before-https`），重建 backend 與 nginx。
舊的 `http://…:5180` 不再監聽 Tailnet IP。

驗證：憑證 Let's Encrypt，到期 2027-01-09（Tailscale 自動續期）；首頁、manifest、sw.js、
192／512 圖示皆 200，未登入 bootstrap 401，錯誤密碼登入回正常 401（無 origin 錯誤）。
無頭 Chromium：secure context、service worker activated、`Page.getInstallabilityErrors` 為空。
manifest 僅有 share_target 未指定 enctype 的非關鍵提示。

## 2026-10-11 RSS 大小上限

部署 **`1307c6b`**：RSS 訂閱與更新的下載上限 5 MB → 25 MB（逾時 20 秒），「載入全文」2 MB → 8 MB；
超過上限回 422 `feed_too_large`，閱讀器顯示中文說明。部署前備份
`/srv/onden/backups/manual-20261011134523`；舊映像標記 `before-1307c6b`。重建 backend、frontend，
資料筆數不變（使用者 1、筆記 9、卡片位置 8），HTTPS 首頁與 manifest 200、未登入 bootstrap 401。
尚未用使用者原本失敗的 RSS 網址實測。

注意：`backup.sh` 內的 `docker compose exec` 會讀 stdin，不能與經 ssh stdin 傳送的 `git archive`
放在同一個 ssh 指令裡（會吃掉部分 tar）；分開執行。

## 2026-10-11 歡迎卡片只在空工作區出現

部署 **`5d5f946`**（只重建 frontend）：「歡迎使用 Onden」原本只看瀏覽器 localStorage 的關閉旗標，
改用 HTTPS 網址後瀏覽器視為新網站，已有筆記仍跳出歡迎卡片。現在工作區只要有日記以外的筆記就不顯示。
部署前備份 `/srv/onden/backups/manual-20261011141411`；舊前端映像 `before-5d5f946`。HTTPS 首頁、manifest 200，
未登入 bootstrap 401。

## 2026-10-11 標題下方加標籤

部署 **`a0468e3`**（`feat/title-tag-row`，PR #6；只重建 frontend）：筆記標題下方的標籤列顯示實際套用的標籤
（點開標籤頁、✕ 移除，有功能的標籤先確認），「＋ 標籤」輸入時提示既有標籤，Enter 新名稱即建立並套用。
部署前備份 `/srv/onden/backups/manual-20261011154106`；舊前端映像 `before-a0468e3`。HTTPS 首頁 200、
未登入 bootstrap 401。

## 2026-10-12 筆記畫面整理

部署 **`b94fd14`**（PR #6；只重建 frontend）：資訊欄的標籤區改為唯讀功能摘要；未命名且空白的欄位（field_1…）不再顯示；
RSS 的 `#subscription` 不出現在標籤選單與側欄標籤清單；內容／白板／表格切換移到中間上方；有滑鼠時隱藏「圖片」按鈕
（觸控裝置保留）。部署前備份 `/srv/onden/backups/manual-20261011163324`；舊前端映像 `before-b94fd14`。HTTPS 首頁 200、
未登入 bootstrap 401。

## 2026-10-12 翻譯整理與 RSS 閱讀畫面

部署 **`d811846`**（PR #6；重建 backend、frontend）：
- 介面中文化：約 770 個新翻譯，伺服器錯誤訊息經 `ApiError` 走 t()，網站工作室積木名稱、白板控制項也已翻譯；
  `zzI18nAudit.spec.ts` 以中文開啟各主要畫面，無殘留英文（已知例外：Puck 內建介面、Schema.org 等名稱）。
- 「這一天」翻譯且不再列出 tag；閒置時顯示「已儲存」取代灰色儲存按鈕；沒人用的 tag 不列在側欄；指令面板不再出現 workspace-config。
- RSS 閱讀：約 720px 閱讀欄、襯線大標題、16px 內文、操作移到右上工具列（「存成筆記」「看過了，下一篇」）、專心閱讀模式、
  清單摘要與縮圖（`/api/rss/items` 新增 excerpt、image）、中文日期；修正深色模式引言白底與整頁跟著清單變高。
部署前備份 `/srv/onden/backups/manual-20261011183801`；舊映像 `before-d811846`。HTTPS 首頁 200、未登入 bootstrap 401。
先前中斷的部署（989ddc4，只上傳未建置）留下的發行目錄已刪除。

## 2026-10-12 RSS 上一篇

部署 **`df3b7fb`**（只重建 frontend）：文章結尾並排「上一篇／下一篇」，電腦版工具列左側多「‹ 上一篇」；兩者依清單順序。
部署前備份 `/srv/onden/backups/manual-20261011185838`；舊前端映像 `before-df3b7fb`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 RSS 工具列拿掉「上一篇」

部署 **`fa1a0f5`**（只重建 frontend）：依使用者回饋移除工具列的「‹ 上一篇」，上一篇只留在文章結尾。部署前備份
`/srv/onden/backups/manual-20261011194752`；舊前端映像 `before-fa1a0f5`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 RSS 動作移到標題下方；檢查工作區不再閃畫面

部署 **`db8f776`**（只重建 frontend）：
- RSS（電腦版）：拿掉工具列、「看過了，下一篇」與專心閱讀；「存成筆記」「載入全文」改成標題下方資訊列的文字連結。手機保留底部操作列。
- 「正在檢查工作區」遮罩：工作區仍立即鎖定，但不透明遮罩與卡片延後 1.5 秒才淡入，一秒內完成的重新檢查（SSE 重連、權限通知）不再讓整個畫面閃一下。
  正式站 nginx 紀錄顯示 SSE 連線會不定期中斷再重連（每次重連都觸發檢查）；已排除 nginx、Tailscale serve（實測 4 分鐘不斷線）、
  service worker、頁面重新載入；本機重現不出來，根因仍待查。
部署前備份 `/srv/onden/backups/manual-20261011205337`；舊前端映像 `before-db8f776`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 編輯器樣式、預覽換行、並排預覽

部署 **`4812c09`**（只重建 frontend）：
- 編輯器：標題依預覽大小、粗體斜體連結直接套樣式，Markdown 符號保留但變淡（不隱藏，游標移動時行長不變，中文輸入法不受影響）。
- 預覽與公開網站：段落內按一次 Enter 即換行（remarkSoftBreaks）；預覽標題改粗體。
- 「顯示 → 並排預覽」：1100px 以上左右並排編輯與即時預覽。
- 補上 `--surface-2` 變數，深色模式下的引言與程式碼區塊不再是白底。
完整一般 e2e：295 通過、14 略過、~~0 失敗~~ **34 失敗**（2026-10-12 更正：當時的摘要指令沒去掉終端色碼，漏抓「34 failed」一行；
說明見下方「模組庫第 1 階段」）。部署前備份 `/srv/onden/backups/manual-20261011215144`；舊前端映像 `before-4812c09`。
HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 編輯器連結與預覽一致

部署 **`19cfa55`**（只重建 frontend）：編輯器原本把任何 `[文字]` 都畫成連結（解析器視為 CommonMark shortcut reference），
預覽卻依規則顯示成純文字加方括號。現在編輯器只把 `[文字](網址)`、`[文字][參照]`、`[[筆記]]`、裸網址標成連結，單獨的 `[文字]`
維持一般文字；預覽中的一般連結也改為主題色加淡底線（原本看起來跟純文字一樣）。單元 1848、相關 e2e 103 通過、
**6 失敗**（2026-10-12 更正，原紀錄漏記；同上，都屬於累積測試資料造成、乾淨資料庫上會通過的那一類）。
部署前備份 `/srv/onden/backups/manual-20261011225537`；舊前端映像 `before-19cfa55`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 模組庫第 1 階段（引入模組）、白板點選不再跳動、日期跟介面語言

部署 **`40ea795`**（重建 backend 與 frontend；PR #7，疊在 PR #6 上）：
- **模組庫**（[設計](../architecture/module-library.md)第 1 階段）：「標籤」移到上方導覽列，頁首是模組庫，每個模組可「引入／取消引入」。
  沒引入的模組在所有地方隱藏（導覽、「更多」、手機底列、首頁區塊、指令面板、筆記指令、白板卡片選單、標籤功能、設定）；
  取消引入會保留資料。只有管理員、只有連線時能改。`workspaces.modules`（migration 085）；`PATCH /api/workspace/modules`，
  事件 `MODULE_IMPORTED`／`MODULE_REMOVED`；沒引入 RSS 的工作區不在背景抓取。
- **首次升級自動判斷**：正式站開機紀錄 `[modules] workspace 807b07a3…: imported rss, website (first library run)`，
  資料庫 `default | ["rss", "website"]`，與部署前預估一致：RSS 有 1 個訂閱、網站有發布紀錄，複習／稍後讀／文獻沒有使用，
  所以上方導覽的「複習」分頁消失；要用時到「標籤 → 模組庫 → 引入」。
- **白板**：點卡片不再把白板捲到那張卡（⌘ 點第二張時會把第一張推到工具列或縮圖底下）；⌘／Ctrl／Shift 點選穩定地加入或移出多選；
  選到卡片時出現的「內容／白板」切換列改為在白板上方固定保留位置，白板不再往下跳 42px（b94fd14 起的問題）；
  「符合畫面」會避開工具列與縮圖。
- **日期跟介面語言**：衝突清單、筆記事件紀錄原本固定用美式英文，垃圾桶、集合、查詢區塊、發布快照跟著瀏覽器語言，現在都跟 App 語言；
  衝突清單與側欄搜尋筆數補上翻譯。
- 標籤頁沒有任何標籤時，空白提示不再把整頁擠成一排；上方列在 901–1100px 時「資訊」只顯示圖示，英文介面也放得下。

驗證：
- 後端 2008 通過、29 略過；前端 249 檔 1857 測試；兩端 lint、型別檢查通過。
- 完整一般 e2e（Chromium、Firefox、手機 Chrome，乾淨堆疊開始跑）：**302 通過、16 失敗、14 略過**。16 項失敗所在的 14 個測試檔
  在重置資料庫後重跑 **50 項全部通過**——這些失敗都來自整輪測試累積的資料（例如跑過 5,200 筆的壓力測試之後，
  `/api/bootstrap` 不再帶回新建的筆記）。WebKit 與手機 Safari（在 Playwright 映像內跑）10/10；`zzI18nAudit` 單獨在乾淨堆疊上沒有任何英文殘留。
- 之前在這裡的 e2e 數字有誤：Playwright 的摘要行帶終端色碼，我用的 grep 抓不到「N failed」，
  所以 4812c09 那次其實是 34 失敗（記成 0）、19cfa55 那次的相關 e2e 有 6 失敗。已在上方原紀錄更正。
  今天逐項追查後，大多數是累積資料造成；真正的問題已修正：白板點選跳動（canvasAlign、canvasColor、personas 設計師）、
  兩個跟著先前改版過時的測試（designTagsD6、reviewExtract）、「從白板移除」測試重新整理到錯的網址。
  WebKit 在本機缺系統函式庫無法啟動，改在 Playwright 映像內跑。

部署前備份 `/srv/onden/backups/manual-20261012025017`；舊映像 `onden-vps-backend:before-40ea795`、`onden-vps-frontend:before-40ea795`。
HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 模組庫第 2 階段：模組標籤與「延伸」

部署 **`96d9f6e`**（重建 backend 與 frontend；PR #8，疊在 PR #7 上；沒有 migration）：
- **模組標籤**：引入「複習」或「稍後讀」時，同時建立它的模組標籤（中文介面是 `#複習`、`#稍後讀`；已有同名的頂層標籤就直接沿用）。
  取消引入時標籤保留，只是失去能力。
- **延伸**：標籤頁新的「能力」區塊——「延伸自」可以加入模組標籤（例如讓 `#課程` 延伸 `#複習`），貼 `#課程` 的筆記就成為複習卡；
  可以多層（`#論文` 延伸 `#課程`）。不能延伸自己或互相延伸。每個能力卡註明來源（「來自 #複習」），
  `#複習` 的頁面也會列出延伸它的標籤的筆記。舊的「直接開啟」開關仍有效，顯示成可按 × 關閉的標籤。
- **複習**跟著延伸走：研讀 `#複習` 會包含 `#課程`、`#論文` 的卡；每天新卡數等設定跟著 `#複習`；沒引入複習時不排卡。
- 正式站目前沒有模組標籤、也沒有延伸（`default | ["rss", "website"]`，4 個標籤）；要用時到「標籤 → 模組庫 → 複習 → 引入」。

驗證：後端 2016 通過、29 略過（新增 7 個整合測試）；前端 249 檔 1863 測試；兩端 lint、型別檢查通過。
完整一般 e2e（乾淨堆疊開始）302 通過、16 失敗、14 略過；這 16 項在重置資料庫後重跑 46/47 通過，
剩下的 `offlineFlakyNetwork` 單獨跑 3 次過 2 次（偶發，本次改動前也失敗過）。標籤／複習相關測試（含深度複習流程）在乾淨堆疊上全部通過；
`zzI18nAudit` 沒有英文殘留。部署前備份 `/srv/onden/backups/manual-20261012041354`；
舊映像 `onden-vps-backend:before-96d9f6e`、`onden-vps-frontend:before-96d9f6e`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 畫面偶爾閃一下：重新連線不再鎖住工作區

部署 **`b873594`**（只重建 frontend）。**原因**：即時更新連線（`/api/events/stream`）每次重新連上，前端就鎖住工作區、重新核對權限，
核對超過 1.5 秒就出現「正在檢查工作區」遮罩（閃一下），鎖住時也會讓編輯器失去游標。Linux 上的 Chrome 只要電腦的網路介面有變化
（Docker／k3s 容器啟動或停止、Tailscale 更新路由）就會切斷所有連線，所以這台電腦一小時重新連線約 25 次：
正式站 nginx 紀錄 20 小時內桌機 Chrome 重開 347 次，其中 67% 與本機 Tailscale 紀錄的路由變更相差 2 秒內（例如 11:12:48、11:12:58、11:13:09 逐秒對上）；
其餘多半是部署／備份重啟後端。本機沒有介面變化時，連線 3 分鐘都沒斷。
**修正**：重新連線只做補同步；同步時比對權限版本（membership epoch），只有斷線期間權限真的變了才鎖住並重新核對。
撤權仍會被抓到，差別只是畫面上原本就有的內容會多顯示到這次核對回來（不到一秒）。實測重啟後端：連線自動重開、沒有出現遮罩。
**未改**：任何筆記加／移除標籤都會讓權限版本 +1，其他開著的裝置仍會短暫鎖住核對（正式站 48 小時內 4 次）。
部署前備份 `/srv/onden/backups/manual-20261012052429`；舊前端映像 `before-b873594`。HTTPS 首頁 200、未登入 bootstrap 401。

## 2026-10-12 標籤頁「功能」改版與模組庫第 3 階段

部署 **`4b1e353`**（重建 backend 與 frontend；PR #9，疊在 PR #8 上；沒有 migration）：
- **單一標籤頁**由上而下是「功能 → 欄位 → 已標記的筆記 → 進階」。「＋ 加入功能」列出每個功能與一句說明，選了就讓標籤延伸該模組標籤，
  模組沒引入時一併引入；功能卡有「設定」「移除」。欄位直接顯示名稱，「編輯欄位／新增欄位」才展開。
  「進階」放「從其他標籤繼承」（介面用詞改為「繼承」，資料仍是 extends）、存取權限、舊自動化提示與「移除自動化」；自動化編輯器移除，既有規則照常執行。
  變更功能、欄位、繼承、存取的按鈕只給管理員。
- **標籤總覽**：「＋ 新增標籤」可選範本（書籍、人物、會議、專案；只給欄位）；複習範本移除。
- **模組庫第 3 階段**：功能型模組卡列出「用在」哪些標籤、可「＋ 加到標籤」；「設定」放模組自己的設定（RSS 的 OPML 匯入／匯出，從「設定 › 你的資料」搬來）
  與功能的設定表單（複習：每天新卡數、目標記憶率、最長間隔）。
- **複習每天新卡額度**改成每個來源標籤一份，延伸它的標籤共用（#複習 設 15 張就是全部合計 15 張）。
- **論文**：文獻引用的模組標籤；引入時會沿用名為 `#paper-review` 的頂層標籤（正式站有一個，0 則筆記），否則以論文欄位建立 `#論文`。
- 正式站資料沒有變動：`default | ["rss"]`（網站模組已由使用者取消引入）、8 則筆記、6 個標籤（含 review 的模組標籤 `#複習`，
  目前複習未引入）；沒有標籤用舊自動化或舊開關。

**部署時磁碟滿了**：建置與重啟都完成（新容器已在跑），但最後更新 `current` 連結時 `No space left on device`——
根目錄 59 GB 用到 100%（Docker 映像 51 GB，其中 34 GB 是歷次部署留下的 `before-*` 回復用映像，另有 9.7 GB 建置快取）。
資料庫仍健康（沒有寫入錯誤）。立即清掉建置快取與無標籤映像（`docker builder prune`、`docker image prune`，回收 5.9 GB），
剩 4.1 GB（93%）後再更新 `current`。之後經使用者同意，刪掉 28 個舊的 `onden-vps-*:before-*` 映像，只保留最近 3 次部署
（`before-4b1e353`、`before-b873594`、`before-96d9f6e`）；其他服務的映像沒動。磁碟降到 41%（23 GB 用、34 GB 可用），所有容器照常運作。
之後每次部署前先看 `df -h /`，回復用映像保留最近 3 次。

驗證：前端 251 檔 1883 測試、後端 245 檔 2047 測試；兩端 lint、型別檢查通過。完整一般 e2e（乾淨堆疊開始）298 通過、20 失敗、14 略過；
這 20 項連同所有改到的 spec 在重置資料庫後重跑 66/66 通過（其中一項是我改寫的測試本身的競態，已修）。WebKit 與手機 Safari 10/10；
改到的深度驗收 spec 5/5；`zzI18nAudit` 單獨在乾淨堆疊上沒有英文殘留（先刪掉英文測試登入種下的範例筆記）。
部署前備份 `/srv/onden/backups/manual-20261012083130`；舊映像 `onden-vps-backend:before-4b1e353`、`onden-vps-frontend:before-4b1e353`。
HTTPS 首頁 200、未登入 bootstrap 401；前端 bundle 確認含新字串（`AddFunctionMenu`、「加入功能」）。

## 2026-10-12 白板進模組庫

部署 **`de2b2a6`**（重建 backend 與 frontend；PR #9 分支；migration 086）：
- 模組庫多一張「白板」卡，可以引入／取消引入。白板原本是核心功能，所以預設引入：
  migration 086 把 `canvas` 加進已記錄的模組清單（正式站開機紀錄 `[migrate] applied 086_canvas_module`，
  清單由 `["rss"]` 變成 `["rss", "canvas"]`），新工作區的首次引入也會帶上它——部署後畫面不變。
- 取消引入時隱藏所有白板入口（「更多」的白板、筆記與標籤的白板分頁、指令面板的白板動作與清單、側欄 📐、資訊欄「出現在白板」、
  快捷鍵說明的「刪除選取的卡片」）；點開白板節點顯示「白板模組未引入」；白板資料保留，重新引入就回來。
  `/api/canvases`、`/api/boards` 改由後端白板模組掛載，路徑不變。
- 正式站資料：10 則筆記、6 個標籤、1 塊白板，沒有變動。

驗證：前端 252 檔 1889 測試、後端 245 檔 2051 測試（三次完整執行各有 1～3 項逾時／時序類失敗，每次不同，單獨重跑都通過；
另修正一項寫死「出廠模組集合」的測試）。白板相關 e2e 55/55；完整一般 e2e（乾淨堆疊開始）298 通過、21 失敗、14 略過，
這 21 項連同新的白板模組 spec 在重置資料庫後重跑 55/55 通過。WebKit 與手機 Safari 10/10；`zzI18nAudit` 沒有英文殘留。
部署前備份 `/srv/onden/backups/manual-20261012130522`；舊映像 `before-de2b2a6`。HTTPS 首頁 200、未登入 bootstrap 401；
前端 bundle 含白板模組卡的字串。之後刪掉 `before-96d9f6e`，回復用映像保留最近 3 次（`before-de2b2a6`、`before-4b1e353`、`before-b873594`），
清掉 1.7 GB 建置快取，磁碟 43%（32 GB 可用）。

## 2026-10-13 修正全程式檢查找到的 8 個錯誤；「今天」改用台北時間

部署 **`862a8d7`**（PR #11 分支 `fix/audit-bugs`；重建 backend 與 frontend；沒有 migration）：
- **時區**：後端原本一律用 UTC 日期當「今天」（重複任務完成後的下一次日期、排程器判斷錯過、`$today`、
  複習每天新卡數、議程與單日檢視的 `CURRENT_DATE`），台灣要到早上 8 點才換日。新增 `ONDEN_TIMEZONE`（IANA 時區名），
  後端的「今天」與每條資料庫連線（`-c TimeZone=…`）都用它；沒設定時維持 UTC。正式站 `shared/.env` 新增
  `ONDEN_TIMEZONE=Asia/Taipei`（原檔備份為 `.env.bak-20261013`）。部署前查過正式資料庫沒有不含時區的時間欄位
  （登入用的 `user`、`session` 等也都是 `timestamptz`），改連線時區不會讓既有時間偏移。
- **公開網站**：匿名的 `/api/site` 原本列出每個有欄位定義的標籤（名稱、slug、欄位），即使沒有任何公開項目
  （正式站有 `gt`、`hi`、`paper-review` 三個，都是 0 項）。現在沒有公開項目的集合不列出。
- **`child:` 屬性**：父筆記的 `child:status = todo` 本該帶給新的子筆記，但查詢條件 `NOT LIKE '_%'`
  （`_` 是萬用字元）把每一列都濾掉，從未生效。
- **AI 金鑰設定**：寫入改走同一個交易（`q()`），與 `AI_SETTINGS_UPDATED` 事件一起成功或一起取消。
- **PDF／手繪筆記**：最後一筆畫完 0.8 秒內關掉筆記，那次存檔會被丟掉；現在關閉時立刻存，且每則筆記各自排隊
  （快速切換筆記也不會互相取消）。
- **設定 › 標籤包**：改用 `installTagPack`，標籤包宣告的模組會一起引入；失敗訊息改成白話。
- **時間軸「快照」**：失敗時原本沒有任何提示；改走網站寫入流程（防重複金鑰、有待同步變更時不發布、失敗跳通知）。
- **「把清單項目送到任務」**：改用任務與筆記寫入工具（每個任務自帶防重複金鑰，斷線時排隊重送而不是重複建立）。

驗證：前端 254 檔 1896 測試、後端 247 檔 2058 測試（平行執行時各有時序類失敗：前端 3 項、後端 `compositionLaws`
準備步驟逾時，單獨重跑都通過；前端其中一項是新測試等待延遲載入的時間太短，已加長）；兩端 lint、型別檢查通過。
完整一般 e2e（乾淨堆疊開始）296 通過、23 失敗、14 略過。在設定 `ONDEN_TIMEZONE=Asia/Taipei` 的乾淨堆疊重跑這 20 個
失敗檔案，加上 21 個日期、任務、複習、發布相關檔案：105 通過、3 失敗——兩項是同一輪前面的複習測試已用完每天 20 張的
新卡額度（重置後單獨跑 5/5），一項是 `tasksAgenda` 自己用 UTC 算日期（在 UTC 堆疊單獨跑通過）。WebKit 與手機 Safari 10/10。
這次沒有新增介面文字，沒有跑 `zzI18nAudit`。
第一輪的失敗中，「今天」檢視、任務分到「今天」、學習流程（braid 1）三項正是這個時區問題：測試在台北時間凌晨 1～2 點跑，
瀏覽器的「今天」是 10/13，e2e 後端（UTC）還是 10/12；設定台北時區後都通過。e2e 測試本身對「今天」的假設不一致
（有的用瀏覽器本地日期，有的用 UTC），只在台灣時間 08:00～24:00 才會全部一致；CI 全是 UTC，不受影響。
部署前備份 `/srv/onden/backups/manual-20261012182800`；舊映像 `before-862a8d7`。HTTPS 首頁 200、未登入 bootstrap 401；
後端與資料庫連線時區都是 `Asia/Taipei`，後端的「今天」與 `CURRENT_DATE` 都是 2026-10-13（台北 02:32）；匿名 `/api/site`
的集合 3 → 0（公開筆記仍是 1）；資料筆數不變（筆記 10、標籤 6、白板 1、標籤關聯 7、屬性 47、未完成任務 1、事件 557、actor 2）。
之後刪掉 `before-b873594`，回復用映像保留最近 3 次（`before-862a8d7`、`before-de2b2a6`、`before-4b1e353`），
清掉 1.7 GB 建置快取，磁碟 46%。

## 2026-10-13 空間（PR #10）上線，連同 PR #11 的修正

部署 **`7c1fef8`**（`fix/audit-bugs` 分支：main `4800a4f`〔PR #10 合併〕＋ PR #11；重建 backend 與 frontend；migration 090～094）：
- **空間取代標籤權限**：
  - 每則筆記／白板屬於一個空間；成員在各空間有角色（管理者／編輯者／檢視者）。
  - 空間有開關：可發布、可送外部 AI、會備份、共用已讀。
  - 工作區有預設空間「共用」，每個人有自己的個人空間（「只有我」）。
  - 標籤只說明筆記是什麼，不再管誰看得到。舊的標籤存取規則、成員與權杖的標籤範圍、`node_tags` 的權限版本觸發器都移除了。
- **一次轉換（migration 094）**：正式站沒有任何標籤存取規則、標籤範圍成員或權杖，所以沒有產生「受限」空間。
  所有既有筆記／白板都在「共用」，oandy 是「共用」與個人空間的管理者。
- **使用上會注意到的變化**：
  - 之後新建的頂層筆記預設放在自己的個人空間，不能發布、也不會送給外部 AI；要發布就移到「共用」（標題下方的空間標籤）。既有筆記不受影響。
  - 複習進度、RSS 已讀改成每個人各自一份。
- **部署前演練**：用正式資料庫的即時副本在 VPS 建暫時資料庫，依序套用 090～094（與 `db.ts` 的 migrate 相同，每個檔案一個交易），全部成功。
  結果與正式部署相同：「共用」59 個筆記／白板、沒有缺空間的、沒有跨空間的父子關係、舊欄位已移除、筆記與事件數不變。暫時資料庫隨後刪除。
  空間那邊 01:05 也演練過一次。
- **合併**：PR #11 只有 `modules/review/routes.ts` 的 import 衝突；其餘重疊檔案自動合併，台北時區的修改都保留。

驗證：
- 合併後前端 256 檔 1903 測試全過。後端 243 檔 1999 測試只有 1 項失敗：PR #11 新加的測試沒跟上空間規則（從 API 建立的項目先進個人空間，不能發布），已修，單獨 6/6。lint 與型別檢查通過。
- 完整一般 e2e（乾淨堆疊開始）296 通過、24 失敗、14 略過。這 21 個失敗檔案在設定台北時區的乾淨堆疊重跑：57 通過、1 失敗。
  失敗的是 TASK-07 寬螢幕版（用鍵盤勾選任務）：單獨跑 3 次 2 次通過，失敗那次瀏覽器沒有送出請求（載入後焦點被重新繪製打斷）；用滑鼠點的版本都通過。
- 第一輪「匯入 .canvas」的失敗，是測試在延遲存檔送出前就讀伺服器；資料有存到。
- WebKit 與手機 Safari 10/10。

部署前備份 `/srv/onden/backups/manual-20261012195211`。094 刪掉了舊欄位，所以**要退回，必須同時還原這份備份**；`before-7c1fef8` 是空間改版前的程式。

上線檢查：
- 開機紀錄依序 `applied 090`～`094`；HTTPS 首頁 200、未登入 bootstrap 401。
- 「共用」是預設空間，可發布、可送外部 AI、會備份；另有 oandy 的個人空間。oandy 是兩者的管理者，System 是「共用」的管理者。
- 60 個筆記／白板全在「共用」：0 個沒有空間、0 個跨空間父子、舊欄位 0、沒有「受限」。
- 資料筆數：筆記 11（多出的是使用者 03:45 建的今天每日筆記，在備份之前）、標籤 6、白板 1、標籤關聯 7、屬性 47、未完成任務 1、事件 558、actor 2。
- 匿名 `/api/site` 仍是 1 則公開筆記、0 個集合；時區仍是 Asia/Taipei。

之後刪掉 `before-4b1e353`，回復用映像保留最近 3 次（`before-7c1fef8`、`before-862a8d7`、`before-de2b2a6`），清掉 1.7 GB 建置快取，磁碟 48%。
邀請第二個人之前必須先完成的事項，見 [integration-audit-2026-10-13.md](integration-audit-2026-10-13.md) 第四節。


## 2026-10-13 使用性 P0 修正上線（PR #13）

部署 **`39f00bc`**（main：PR #13 合併；重建 backend 與 frontend；沒有 migration）。
修正 2026-10-13 使用性檢查（[usability-walkthrough-2026-10-13.md](usability-walkthrough-2026-10-13.md)）的六項 P0：
- **PDF 手寫**：不必按「停止繪製」，筆離開約 1 秒後就存檔；按 Esc 或關閉畫面時保留已畫的筆跡（原本 Esc 會丟掉）。
- **RSS 存成筆記**：文章內容轉成 Markdown，不再是原始 HTML。
- **「將劃線存成卡片」**：已設定複習時，卡片帶上 #複習，會進入複習。
- **教學筆記**：改寫成實際的做法（選取 `- [ ]` 那行按任務按鈕，或從 ⋯ 選單「把清單項目轉成待辦」）；不會自動把每個核取方塊變成任務。
- **快速捕捉**：按 Esc 或關閉時保留草稿（依帳號存在這台裝置），存檔或清空後才刪除。
- **白板雙擊新增卡片**：游標直接在新卡片的標題，可以馬上打字。

驗證：PR #13 的 CI 全部通過（關鍵 e2e 第一次有 1 項 `agenda-quick-add` 失敗，重跑通過；同一項在 main 也會失敗，取決於堆疊殘留狀態）。
新增的 `e2e/fullstack/uxP0.spec.ts`（F1、F5、F6）在 :5300 堆疊連跑 3 次全過。
部署前備份 `/srv/onden/backups/manual-20261013083015`；舊映像 `before-39f00bc`。HTTPS 首頁與 manifest 200、未登入 bootstrap 401；
資料筆數不變（筆記 11、標籤 6、白板 1、標籤關聯 7、屬性 47、事件 558）；前端 bundle 已含新程式。
之後刪掉 `before-862a8d7`，回復用映像保留最近 3 次（`before-39f00bc`、`before-dd41446`、`before-7c1fef8`），清掉 1.7 GB 建置快取，磁碟 53%。


## 2026-10-13 標籤整理上線（PR #14）

部署 **`b4df1ee`**（main：PR #14 合併；重建 backend 與 frontend；migration `100_reserved_tag_keys`）。
整合審查（[integration-audit-2026-10-13.md](integration-audit-2026-10-13.md)）的標籤項目：
- **保留標籤改用角色辨識**：`#task`、`#subscription`、`#workspace-config`、`#page` 改看 `content_nodes.reserved_key`，不再看標題。
  改名不會讓任務、RSS、網站設定或頁面版型失效；巢狀的 `#專案/task` 是一般標籤。
- **套用標籤只有一條路**：AI 建立筆記、Markdown 匯入、RSS、標籤合併、範本子項現在都會帶出範本內容與欄位預設值。
- **前端只有一種 #標籤 寫法**（`lib/hashtags.ts`，和後端相同）。離線時範本與快速捕捉的標籤先用本機標籤清單對應；
  對應不到的留在筆記裡當 `#文字`，不會被丟掉。快速捕捉新建的標籤會立刻出現在「標籤 › 我的標籤」。

驗證：PR #14 的 CI 全部通過。本機後端完整測試（從 `schema.sql` 建的乾淨資料庫）2024 通過，前端 1930／1931
（`accountStoragePersistence` 1 項失敗，與本次無關，單獨跑 3/3 通過），lint 與型別檢查通過。
**部署前演練**：用正式資料庫的即時副本在 VPS 建暫時資料庫套用 100，成功。標題與角色找到的關聯數一致
（subscription 2、workspace-config 1；正式資料沒有未刪除的 #task 或 #page），暫時資料庫隨後刪除。

部署前備份 `/srv/onden/backups/manual-20261013085450`；舊映像 `before-b4df1ee`（即 39f00bc 的程式）。
100 只新增欄位與索引，舊程式仍可執行；要完全退回，同時還原這份備份。

上線檢查：開機紀錄 `applied 100_reserved_tag_keys`；HTTPS 首頁與 manifest 200、未登入 bootstrap 401、匿名 `/api/site` 200；
後端紀錄沒有錯誤。保留標籤：`subscription`、`workspace-config`（都是最上層）。
資料筆數不變（可見筆記 10、標籤 6、白板 1、標籤關聯 7、屬性 47、事件 558）。
之後刪掉 `before-7c1fef8`，回復用映像保留最近 3 次（`before-b4df1ee`、`before-39f00bc`、`before-dd41446`），清掉 1.7 GB 建置快取，磁碟 55%。

## 2026-10-13 導覽改版、系統標籤、開頁時打的字不再消失（#16、#17、#19）

部署 **`a395acb`**（`fix/gate-keeps-typing` 分支：main `c71d280`〔#16、#18 已合併〕加上尚未合併的 #17、#19，三者 CI 全過；重建 backend 與 frontend；沒有 migration）：
- **#16 導覽改版（note-a4，F8–F10）**：模組不再藏在標籤頁、側欄整理、「閱讀」成為一個入口（稍後讀與引用是它的分頁）。
- **#17 系統標籤**：前端改用 `reserved_key` 認出 workspace-config 標籤；改名後不會跑進側欄、標籤頁、指令面板與關聯圖，剛好同名的一般標籤也不會被藏起來。
- **#19 開頁時打的字不再消失**：每次開頁的權限確認（Step D，fail-closed）會讓工作區鎖住約 0.25 秒，這段時間打的字以前會直接不見。
  現在先存在工作區外的隱藏輸入框（注音照常組字），解鎖後放回原本的欄位，或鎖住時點的欄位；單行欄位按過 Enter 會照常送出。
  鎖定本身沒變。這也是 #13、#17 關鍵 e2e 一直失敗（`agenda-quick-add`）的原因，測試已改成確認文字有進去才繼續。

驗證：#17、#19 的 CI 全部通過（關鍵 e2e 第一次就過）。在 :5300 實測：開頁鎖住期間點快速新增、立刻打字並按 Enter，5/5 建立任務；
`uxP0` F6 連跑 5 次通過。部署前備份 `/srv/onden/backups/manual-20261013101224`；舊映像 `before-a395acb`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401；資料筆數不變（筆記 11、標籤 6、白板 1、標籤關聯 7、屬性 47、事件 558）；
前端 bundle 已含三項變更。「閱讀」分頁的實際畫面需要登入，尚未在正式站確認。
之後刪掉 `before-dd41446`，回復用映像保留最近 3 次（`before-a395acb`、`before-b4df1ee`、`before-39f00bc`），清掉 1.7 GB 建置快取，磁碟 57%。

## 2026-10-13 `/` 選單、捕捉、寫入整理上線（#21、#22）

部署 **`7b14226`**（main：PR #21、#22 合併；只重建 frontend；後端、compose 相對 `a395acb` 沒有差異，沒有 migration）：
- **#21 （F7、F11）**：`/` 選單可以直接開 PDF、手寫頁、草圖，也能用中文篩選；手繪白板跟著介面語言；
  首次使用不再問儲存位置（預設瀏覽器）；按鈕改叫「捕捉」；捕捉時寫 `@明天` 會建立當天到期的待辦。
- **#22 寫入整理**：前端寫入一律經過 `lib/data`（統一的 `sendWrite`、`uploadMedia`），新增 lint 規則 `onden/writes-through-data` 防止繞過。

VPS 上原有一個 20:54 建置、從未切換的 `f1fc3bc` release（前端映像已建好，`current` 仍指向 `a395acb`）；
這次直接以 `7b14226` 取代，該 release 目錄保留，`before-f1fc3bc` 標記刪除（與 `before-7b14226` 內容相同）。

驗證：CI 暫停中，以本機針對性檢查為準（見各 PR）。部署前備份 `/srv/onden/backups/manual-20261013155037`；舊映像 `before-7b14226`。
`backup.sh` 與 `up -d frontend` 都會重建 postgres 容器，後端紀錄出現短暫斷線（`terminating connection`、`ENOTFOUND postgres`），隨即自動重連。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；
資料筆數不變（未刪除節點 19、事件 560、標籤關聯 7）；前端 bundle 已含「手寫頁」選單項目。
之後刪掉 `before-39f00bc`，回復用映像保留最近 3 次（`before-7b14226`、`before-a395acb`、`before-b4df1ee`），清掉 1.7 GB 建置快取，磁碟 61%。

## 2026-10-14 前端整理上線（#24）

部署 **`368f661`**（main：PR #23、#24 合併；只重建 frontend；後端、compose 相對 `7b14226` 沒有差異，沒有 migration）。
#24 把 BuilderApp 與 KnowledgeWorkspace 中各入口重複的規則收進 hook：開啟筆記／標籤／白板（`useWorkspaceFocus`）、
白板鏡頭（`useBoardCamera`）、白板工具（`useCanvasTools`）等；行為不變。

驗證：CI 暫停中，以本機為準（見 PR #24：型別檢查、lint、單元測試、:5300 導覽與白板 e2e）。
部署前備份 `/srv/onden/backups/manual-20261013175244`；舊映像 `before-368f661`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；
資料筆數不變（未刪除節點 19、事件 560、標籤關聯 7）；執行中的前端映像即本次建置。
之後刪掉 `before-b4df1ee`，回復用映像保留最近 3 次（`before-368f661`、`before-7b14226`、`before-a395acb`），清掉 0.4 GB 建置快取，磁碟 65%。

## 2026-10-14 標籤頁改版：功能標籤／自訂標籤，桌面拿掉「更多」

部署 **`172694d`**（main：PR #28；只重建 frontend，用 `up -d --no-deps frontend`，postgres 沒有重建；沒有 migration）。
標籤頁的「模組庫」改名「功能標籤」、「我的標籤」改名「自訂標籤」；桌面頂部列拿掉「更多」，「關係圖」獨立成按鈕；
已引入的功能點功能標籤卡片打開；釘選的標籤移到標籤頁最上面；詢問筆記、前往關係圖加進 ⌘K。

驗證：CI 暫停中，以本機為準（單元測試、lint、:5320 實際操作）。
部署前先跟 note-0f、note-d6 確認沒有其他部署在進行。
部署前備份 `/srv/onden/backups/manual-20261013200914`；舊映像 `before-172694d`。
HTTPS 首頁、manifest、`/?view=tags` 200，未登入 bootstrap 401，匿名 `/api/site` 200；執行中的前端映像即本次建置，
bundle 含新字串。這次沒有核對資料筆數（讀正式資料庫被權限擋下；只重建前端，沒有動資料）。
之後刪掉 `before-a395acb`，回復用映像保留最近 3 次（`before-172694d`、`before-368f661`、`before-7b14226`），清掉 0.35 GB 建置快取，磁碟 68%。

## 2026-10-14 移除草圖、非同步結果綁定原筆記（#27、#31）

部署 **`d9e183b`**（main：PR #27、#31；重建 backend 與 frontend，`up -d --no-deps`，postgres 沒有重建；沒有 migration）：
- **#27 移除 Excalidraw 草圖**：建立入口、編輯器草圖模式、`GET /api/nodes/:id/render` 與 `@excalidraw/excalidraw` 一併移除；
  舊 `sketch_data` 留在資料庫，那些筆記以一般筆記打開。前端打包 18 MB → 13 MB。
- **#31 非同步結果綁定原本的筆記或白板**（掃描報告 #1–#4、#35）：儲存途中打字不再造成文字重複；
  拆分、合併、送清單到待辦，PDF 筆跡，慢網路的貼圖與插入，白板拖放圖片與子白板，都寫回開始時的對象。

驗證：CI 暫停中，以本機為準（見 PR #27、#31；含 :5300 慢速儲存探針與相關 e2e）。部署前先跟 note-66、note-0f 確認沒有其他部署。
部署前備份 `/srv/onden/backups/manual-20261013204004`；舊映像 `before-d9e183b`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；後端紀錄沒有錯誤；前端 bundle 不含 excalidraw。
資料筆數部署前 24／772／8（未刪除節點／事件／標籤關聯），部署後 25／773／9：期間有人在正式站新增一篇筆記，只增不減。
之後刪掉 `before-7b14226`，回復用映像保留最近 3 次（`before-d9e183b`、`before-172694d`、`before-368f661`），清掉 1.7 GB 建置快取，磁碟 74%。

## 2026-10-14 手機觸控與小 bug 批（#29、#32）

部署 **`24a10ca`**（main：PR #29、#32；重建 backend 與 frontend，`up -d --no-deps`；沒有 migration）：
- **#29 手機觸控**（note-0f）：筆記頂部按鈕維持 30px，只把點擊範圍撐到 44px；鍵盤收起超過 350ms 時，格式工具列跟著隱藏；
  觸控選取時，浮動工具列放在選取範圍下方並限制在可視區內，避開系統選單；`useIsMobile` 取代四份 media query。
- **#32 小 bug 批**（note-66）：⋯ 選單的釘選與顏色可以寫入並顯示（`services/systemAttributes.ts` 是唯一的可寫保留鍵清單）；
  24 處 Enter 改用 `lib/keys.ts`，輸入法選字的 Enter 不會送出；PDF 選取文字後，要按「劃線」或「→ 卡片」才會寫入。

驗證：CI 暫停中，以本機為準（PR 審查：前端 tsc／lint／2002 項單元測試；後端單元測試與 noteMarks 等整合測試）。部署前先跟 note-66、note-0f 確認沒有其他部署。
部署前備份 `/srv/onden/backups/manual-20261013210443`；舊映像 `before-24a10ca`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；後端紀錄沒有錯誤；
執行中的前端映像即本次建置，bundle 含 `--onden-tap`。資料筆數不變（未刪除節點 25、事件 773、標籤關聯 9）。
之後刪掉 `before-368f661`，回復用映像保留最近 3 次（`before-24a10ca`、`before-d9e183b`、`before-172694d`），清掉 2.9 GB 建置快取，磁碟 75%。

## 2026-10-14 讀取閘、模組引入檢查、設定持久化（#33、#35）

部署 **`81b393e`**（main：PR #33、#35；重建 backend 與 frontend，`up -d --no-deps --no-build`；沒有 migration）：
- **#33 讀取閘與模組引入**（note-0f，統一性審查 W5）：
  - 收件匣先套可見性規則，再取 500 筆，看不到的事件不再把可見的擠出清單。
  - 標籤成員、標籤合併預覽、白板清單、RSS 來源、未讀數、OPML 改在 SQL 裡套讀取範圍。
  - 讀 `domain_events` 的檔案都要在 lint 的 `EVENT_READS` 分類。
  - 模組沒引入時：代理工具回 409 `module_not_imported`；node hook 不觸發；`routePrefixes` 底下的寫入回 409，讀取照常。
- **#35 設定持久化**（note-66，W12）：存檔和套用分開，存取 localStorage 包 try/catch。

驗證：CI 暫停中，以本機為準。後端完整測試 2061 項；無 DB 單元測試 1105 項；note-d6 審查時在乾淨 DB 跑了 17 個模組整合測試檔，114 項通過。
部署前先跟 note-d6、note-66 確認沒有其他部署。部署前備份 `/srv/onden/backups/manual-20261013211853`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；後端開機紀錄沒有錯誤。
這次沒有核對資料筆數（讀正式資料庫被權限擋下；沒有 migration）。

**回退映像沒做成**：`compose build` 先把 `latest` 換成新版，之後才想到要標記執行中的舊映像。結果發現舊映像的內容已經被之前的建置快取清理刪掉，`docker tag` 和 `docker commit` 都失敗（containerd 映像庫，`content digest … not found`）。
要退回 24a10ca，就用 `/srv/onden/releases/24a10ca…` 重建。
之後的部署順序改成：build 之前先 `docker tag onden-vps-<svc>:latest onden-vps-<svc>:before-<sha>`。另外，`docker builder prune` 可能刪掉執行中映像的內容，清理只刪舊的 `before-*` 映像。
這次沒有清理（現有 `before-24a10ca`、`before-d9e183b`、`before-172694d` 共 3 組）。

## 2026-10-14 正文副作用統一、後端邊界小修、筆記生命週期（#38、#39、#44）

部署 **`de88eaa`**（main：PR #38、#39、#44；重建 backend 與 frontend，`up -d --no-deps`；沒有 migration）：
- **#38 W8**（note-0f）：正文改動後的處理收成 `applyBodyChange`，編輯、版本還原、撤銷編輯、匯入共用；版本還原可以撤銷。
- **#39 W9**（note-66）：移除舊 CSV 路徑與沒人用的 `GET /api/export`；export-static 與 `/api/site` 用同一套規則；MCP 錯誤由 httpError 統一對應。
- **#44 W3**（note-d6）：筆記丟進垃圾桶、救回、從歷史撤銷都走 `services/nodeTrash.ts`，並觸發 `nodeLifecycleCommitted`，已發佈的筆記會連帶更新靜態網站；
  交易內呼叫的提交後 hook 改成等最外層提交才執行；從歷史撤銷刪除時會重新產生 slug。

驗證：CI 暫停中，以本機為準；三個 PR 在乾淨資料庫上都跑過完整的後端整合測試。部署前先跟 note-0f、note-66 確認沒有其他部署。
順序依 2026-10-14 的教訓：先替執行中映像打 `before-de88eaa`，再 build，然後備份 `/srv/onden/backups/manual-20261013220623`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；後端紀錄沒有錯誤；執行中映像即本次建置。
資料筆數不變（未刪除節點 25、事件 773、標籤關聯 9）。
之後刪掉 `before-172694d`，回復用映像保留 `before-de88eaa`、`before-24a10ca`、`before-d9e183b`，三者都確認可以啟動；清掉 4.1 GB 建置快取，磁碟 75%。
（`81b393e` 部署時沒有留下回復映像；要退回那一版，需用 `/srv/onden/releases/` 底下的原始碼重建。）

## 2026-10-14 本機鏡像、同步投影、拆 tags.ts、核取方塊、視圖運算子（#40、#41、#43、#45、#47、#51）

部署 **`82f0df0`**（main；重建 backend 與 frontend，`up -d --no-deps --no-build`；沒有 migration）：
- **#40 本機鏡像寫入器**（W10）：本機 SQLite 的 nodes、edges、pointers、attributes 只剩一份寫入函式（`lib/localMirror.ts`）。
- **#41 同步投影**（W11）：edge、attribute、pointer 的欄位清單各只寫一份；bootstrap 新增 `attributes[]`，帶上屬性型別。
- **#43 拆 tags.ts／inbox**（W7，note-66）：tags.ts 降到 591 行；核心程式不再寫死模組 id。
- **#45 核取方塊識別**（W15，note-66）：點擊和送出清單共用 `taskLines`。已知回歸：引用或清單裡未關閉的 ``` 會讓後面的方塊點不動，note-66 正在修。
- **#47 視圖編輯器補上範圍運算子**（W18 第一部分）。
- **#51 修好 nodeEventHistoryInk 測試**。

部署前先跟 note-d6（它把部署交給我）和 note-66 確認沒有其他部署。
照新順序：先 `docker tag latest before-82f0df0`（確認執行中映像就是 latest），再 build，最後備份 `/srv/onden/backups/manual-20261013224945`。
HTTPS 首頁、manifest、`/?view=read_later` 200，未登入 bootstrap 401，匿名 `/api/site` 200；後端開機紀錄沒有錯誤。沒有核對資料筆數（讀正式資料庫被權限擋下；沒有 migration）。
清理：刪掉 `before-d9e183b`，回復用映像保留 `before-82f0df0`、`before-de88eaa`、`before-24a10ca`。沒有跑 builder prune。

## 2026-10-14 任務日期、錯誤碼、手寫離線、搜尋、能力 hook（#42、#46、#49、#50、#53）

部署 **`e1406b6`**（main；重建 backend 與 frontend；沒有 migration）：
- **#42 任務日期與分桶**（W14）：線上和離線共用同一個「今天」和分桶規則；bootstrap 帶上 `timezone`；每月重複夾到月底。
- **#46 搜尋**（W17）：指令面板離線也能搜尋；伺服器和本機共用同一個摘要渲染元件；搜尋結果排除任務節點（隱藏的筆記仍搜得到）；Ask 支援中文字面召回。
- **#49 空間能力單一來源**（W16，note-66）：只有擁有者能編輯 class_tag，前端與後端一致。
- **#50 錯誤碼翻譯**（W13）：伺服器回的錯誤，改成先依錯誤碼顯示。
- **#53 手寫離線不被覆蓋**（W20 第一部分）：本機還有待送的寫入時，以本機鏡像為準。

note-d6 驗證過這批：前端與後端完整測試都通過，只有一個 flake，單獨重跑通過。部署前先和 note-66 確認沒有其他部署在進行；build 前確認執行中的映像就是 latest，再打 tag `before-e1406b6`。
備份 `/srv/onden/backups/manual-20261013233730`。HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，後端沒有錯誤。
清理：刪掉 `before-24a10ca`，保留 `before-e1406b6`、`before-82f0df0`、`before-de88eaa`。磁碟 80%，逐次上升，下次部署前要清舊的 release 目錄和備份。

## 2026-10-14 即時失效、白板單一寫入、標籤成員、引用匯出（#52、#56、#57、#58、#59、#60、#62）

部署 **`47d04f7`**（main；重建 backend 與 frontend；沒有 migration）：
- **#52、#57 即時失效與 actor 解析**（W19，note-66）：bearer token 改用 `resolveCurrentActor`；前端由 `liveInvalidation` 統一處理，一次存檔只觸發一次 sync。
- **#56 標籤成員單一規則**（W18 第二部分）：成員包含子標籤，以及 extends 這個標籤的標籤；`/api/query` 改用相同的成員規則和有型別的排序。
- **#58、#59**（note-66）：#45 回歸的修正，以及其他後續項目。
- **#60 引用匯出**（W24）：`.bib` 裡重複的 key 由較舊的論文保留。
- **#62 白板單一寫入路徑**（W23，note-66）：canvases PATCH 帶 data 回 410；`boardStore.ts` 是唯一寫入點。舊版前端佇列裡的整份版面 PATCH 會進入恢復清單，2026-10-11 以後的前端不會再送這種請求。

note-d6 已驗證：後端單元測試 1119 個、整合測試 162 個檔案全綠；前端只有已知的 flake。部署前先和 note-66 確認沒有其他部署；build 前先打 tag `before-47d04f7`。
備份 `/srv/onden/backups/manual-20261014005006`。HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，後端沒有錯誤。
清理：刪掉 `before-de88eaa`，保留 `before-47d04f7`、`before-e1406b6`、`before-82f0df0`；`image prune` 沒有回收到空間。
**磁碟 84%（build 後一度到 88%）**：建置快取 30 GB，每次部署約多 2.7 GB。這次刻意不跑 builder prune（之前清快取時，執行中映像的內容被刪掉）。下次部署前要先找一個能驗證的清法：清完確認執行中映像和回退映像都還在，必要時從 release 目錄重建。

## 2026-10-14 收斂批次收尾（#63–#78，migration 101）

部署 **`3cec0ea`**（main；重建 backend 與 frontend；**migration 101_outbox_retry_day**）。內容是使用者說「都當審了，然後部署」之後合併的全部 PR：
- W4 `createNote`（#66）、軟刪除改走 `markTrashed`（#67）、W22 RSS 存檔生命週期（#73）、白板與書籤歷史的後續（#74）；
- W6 前端寫入收斂（#63、#75，含 #69）、回歸檢查的後續（#64）；
- W26 blob GC 寬限期（#70）、W29 範本 savepoint（#71）、W30 標籤建立權限（#72）；
- W21 markdown.zip 往返（#54）；
- W27 outbox 交付保證（#76），以及審查修正（#78）：逾時嘗試與重試不重疊、重試不送舊內容。

驗證：前端完整單元測試在 main 19aa9379 上 287 個檔案、2093 項通過。後端完整測試在 #54 rebase 後 2125 項通過（用含 101 的新 schema）。#78 由 note-d6 在真的 Postgres 上跑重現情境驗證通過。
部署前先和 note-d6、note-66 確認沒有其他部署；build 前打 tag `before-3cec0ea`。
清理建置快取時用 `builder prune --filter until=24h`，沒有回收到空間；清完確認每個 latest 和 before-* 映像都能 `docker create`。
備份 `/srv/onden/backups/manual-20261014033015`。開機紀錄 `applied 101_outbox_retry_day`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200。
outbox：`max_attempts` 預設 35；沒有 pending。有 77 列 dead，**全部是 `embed`**（2026-09-28 起），錯誤是 `Unable to get model file path or buffer`：容器裡沒有 embedding 模型，語意搜尋的向量一直沒產生。這是既有問題，不影響筆記資料；重新排入只會再失敗，留給使用者決定要不要裝模型或關掉嵌入。
清理：刪掉 `before-82f0df0`，保留 `before-3cec0ea`、`before-47d04f7`、`before-e1406b6`；舊的 release 目錄只留最近 5 個。磁碟 84%（build 後一度 88%）。

## 2026-10-14 手寫 envelope、屬性事件軌、outbox hold、AI harness（#82、#83、#84、#86、#87）

部署 **`04b059d`**（main；重建 backend 與 frontend；**沒有 migration**，最新仍是 101）：
- **#82、#86 W20 第二部分**：每次 PDF 編輯只寫一個 `ink_data` envelope，一個 debounce、一個解碼器；e2e 讀 envelope，歷史保留螢光筆變更。
- **#83 W28**：所有屬性變更都走事件軌（`recordAttributeChange`）。
- **#84 outbox**：逾時的嘗試以 dedup key 為單位 hold，而不只是單列。
- **#87 Harness H1**：只有一條路呼叫模型；ask 搬進 harness，`/transform` 改成 skills。環境變數改讀 `AI_PROVIDER`／`AI_MODEL`，未設時沿用 `ASK_*`，所以 `.env` 不用改。
- #81 只是文件（筆記式 AI skills 與簡報模式的設計）。

build 前確認執行中映像就是 3cec0ea 的 latest，再打 tag `before-04b059d`。沒有跑任何 prune。磁碟 build 前 84%，build 後 88%。
備份 `/srv/onden/backups/manual-20261014053712`，DB/content checksum 通過。release 目錄寫入 `REVISION`。
注意：`backup.sh` 重啟 backend 時，已經用剛 build 好的 latest 重建了 backend，所以新後端比正式切換早約 20 秒上線。切換時 compose 也重建了 postgres（映像沒變，資料卷保留），05:37:41–47 後端有幾行連線中斷／`ENOTFOUND postgres`，之後自動恢復。
驗證：`/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200；`content_nodes` 87 列；05:38 之後後端紀錄沒有錯誤。
清理：刪掉 `before-e1406b6`，保留 `before-04b059d`、`before-3cec0ea`、`before-47d04f7`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 de88eaa，留最近 5 個。磁碟 84%。

## 2026-10-14 網站不外洩、AI harness H2–H4、W28 後續（#89、#90、#92、#94、#95、#96、#98）

部署 **`dff0a9d`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 101）：
- **#96 W34 網站不外洩**：網站後台只限擁有者；復原和隱藏會把已發佈頁面撤下。未登入的 `/api/export-static` 現在回 401。
- **#89 W28 後續**：`delete_attribute` 被拒絕時保留 tentative；其餘屬性寫入也走事件軌。
- **#90、#92 Harness H2**：`#技能` 筆記式 skills、nodes／tag 範圍、MCP prompts、SKILL.md；文字 skills 也接受 nodes 範圍。
- **#94 Harness H3**：白板範圍、`applies_to` 標籤綁定。
- **#95 Harness H4**：outline skill 與簡報設計筆記、readingOrder。
- #98 只是文件（W38 網站渲染模型、簡報決策）。

順序依 04b059d 的教訓：先確認執行中映像就是 04b059d 的 latest（current 的 `REVISION` 為 04b059d），打 tag `before-dff0a9d`；
再傳 release 並寫入 `REVISION`；然後執行 `backup.sh`（`/srv/onden/backups/manual-20261014061548`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build。
沒有跑任何 prune。磁碟 build 前 84%，build 後 88%。06:19:07 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`（經 HTTPS 的 `/health` 會落到文件站 404，屬正常）；HTTPS 首頁、manifest、`/?view=tasks` 200，
未登入 bootstrap 401，匿名 `/api/site` 200，**未登入 `/api/export-static` 401**（`{"error":"unauthorized"}`）。切換後後端紀錄沒有錯誤或警告。
`content_nodes` 部署前後都是 87 列；未刪除數 27→25，是使用者 06:17:57 在舊版上丟進垃圾桶的兩則筆記（`NODE_DELETED`，actor user），不是部署造成的。
清理：刪掉 `before-47d04f7`，保留 `before-dff0a9d`、`before-04b059d`、`before-3cec0ea`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 82f0df0，留最近 5 個。磁碟 82%。

## 2026-10-14 權杖與代理工具收斂、UI 元件統一、網站重新部署走 outbox（#97、#100、#101，migration 102）

部署 **`ea423d0`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**migration 102_token_issuer_removed**）：
- **#97 W35**：權杖與代理工具收斂；移除成員時撤銷他發出的權杖。migration 102 新增 `agent_tokens.issuer_removed_at`，並在 `actors` 加上 BEFORE DELETE trigger 標記發行者已刪除的權杖。這是純新增：舊版程式不讀這個欄位，trigger 只寫新欄位，所以退回舊映像時可以保留 102。
- **#100**：UI 元件統一第一層（共用 Popover／Menu、Button、Modal）。
- **#101 W34 後續**：網站重新部署改走 outbox reconciler（開機時啟動），改變網站內容的變動都會重新部署。

順序同 dff0a9d：先確認執行中映像就是 dff0a9d 的 latest（current 的 `REVISION` 為 dff0a9d），打 tag `before-ea423d0`；
再傳 release 並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014063603`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-ea423d0.log`）。
沒有跑任何 prune。磁碟 build 前 82%，build 後 86%。06:38:49 UTC 切換，`current` 指向新 release。
migration 由後端開機時套用：開機紀錄 `[migrate] applied 102_token_issuer_removed`，`schema_migrations` 有 102（06:39:12），`\d agent_tokens` 有 `issuer_removed_at`，`actors` 有 `actors_mark_tokens_issuer_removed` trigger。
outbox reconciler 啟動時不印紀錄，只在失敗時記 `[outbox]` 錯誤；切換後沒有這類錯誤。outbox 狀態：既有 77 列 `embed` dead（見 3cec0ea 一節）、1 列 `embed` pending（05:56 起，部署前就存在），其餘 done。
驗證：容器內 `/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401。
切換後約 1.5 分鐘後端紀錄只有驗證請求，沒有錯誤或警告。`content_nodes` 部署前後都是 87 列（未刪除 25），`domain_events` 最大 id 前後都是 808，期間沒有寫入。
清理：刪掉 `before-3cec0ea`，保留 `before-ea423d0`、`before-dff0a9d`、`before-04b059d`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 e1406b6，留最近 5 個。磁碟 82%。

## 2026-10-14 匯入基準、網站後續、權杖工作區範圍、技能 UI（#80、#103、#104、#93）

部署 **`0b330c8`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 102）：
- **#80**：重新匯入時，由內文推出的屬性不再算成本機變更。
- **#103 W34 後續**：已發佈列的複本從草稿開始；已發佈列的編輯會重建網站；`node_tags` 的寫入也受可見性檢查掃描。（W36 是 #105，在 73e2e4a 才上線。）
- **#104 W35 後續**：`revokeTokensIssuedBy` 限定在同一個工作區。
- **#93 H2**：前端「用技能…」技能模組，含技能的標籤功能卡。
- 其餘是文件（#85 harness 設計、#91 審查第 6 輪、#88／#99／#102 部署紀錄）。

順序同 ea423d0：先確認執行中映像就是 ea423d0 的 latest（current 的 `REVISION` 為 ea423d0），打 tag `before-0b330c8`；
再傳 release 並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014065547`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-0b330c8.log`）。
沒有跑任何 prune。磁碟 build 前 82%，build 後 86%。06:58:40 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401，**未登入 `GET /api/ai/skills` 401**。
切換後約 1.5 分鐘後端紀錄只有驗證請求，沒有錯誤或警告。`content_nodes` 部署前後都是 87 列（未刪除 25），`domain_events` 最大 id 前後都是 808，期間沒有寫入。
清理：刪掉 `before-04b059d`，保留 `before-0b330c8`、`before-ea423d0`、`before-dff0a9d`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 47d04f7，留最近 5 個。磁碟 82%。

## 2026-10-14 W36 前端小修批、技能標籤功能卡、H3 技能 UI（#105、#106、#109）

部署 **`73e2e4a`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 102）：
- **#105 W36 前端小修批**：輸入法組字中按 Esc 只取消候選字；伺服器拒絕的筆記與他處刪除的白板會離開離線副本；標籤頁離線可整頁開啟；標題比對與高亮統一；備份檔名用工作區的日期；拒絕備份以錯誤碼判斷。
- **#106**：技能的標籤功能卡（修好 main 上的 tagFunctionRegistry）。
- **#109 H3 技能 UI**：`applies_to` 按鈕、結果存成屬性、外部 AI 提示；#93 後續。
- #107（W24 引用）在這次 fetch 之後才合併，**不在本次部署內**。

順序同 0b330c8：先確認執行中映像就是 0b330c8 的 latest（current 的 `REVISION` 為 0b330c8，容器映像 id 與 latest 相同），打 tag `before-73e2e4a`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014090247`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-73e2e4a.log`）。
沒有跑任何 prune。磁碟 build 前 82%，build 後 87%。09:05:49 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401，未登入 `GET /api/ai/skills` 401。
切換後約 1.5 分鐘後端紀錄只有開機訊息與驗證請求，沒有錯誤或警告。`content_nodes` 部署前後都是 87 列（未刪除 25），`domain_events` 最大 id 前後都是 808，期間沒有寫入。
清理：刪掉 `before-dff0a9d`，保留 `before-73e2e4a`、`before-0b330c8`、`before-ea423d0`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 3cec0ea，留最近 5 個。磁碟 82%。

## 2026-10-14 W24 引用身分與正文解析器線性化（#107）

部署 **`74a05a4`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 102）：
- **#107 W24**：正文的 `[@key]`（含 Pandoc 群組 `[@a; @b, p. 3]`、`[-@key]`）建立 `cites` 邊，只在引用筆記所在的空間內解析；新增 `PUT /api/citations/papers/:id/citekey`，改名時回傳引用它的筆記，key 被佔用時回 409。
- **#107 審查修正（優先）**：每個正文解析器在病態正文上都維持線性時間，修掉會讓伺服器卡住的 regex；citekey 規則對齊；改名加鎖。

順序同 73e2e4a：先確認執行中映像就是 73e2e4a 的 latest（current 的 `REVISION` 為 73e2e4a，容器映像 id 與 latest 相同），打 tag `before-74a05a4`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014090947`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-74a05a4.log`）。
沒有跑任何 prune。磁碟 build 前後都是 82%。09:10:39 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401，未登入 `GET /api/ai/skills` 401。
切換後約 2.5 分鐘後端紀錄只有開機訊息、嵌入模型的 dtype 提示與正常請求（使用者正在使用），沒有錯誤或警告。
`content_nodes` 部署前 87 列（未刪除 25），之後 88 列（未刪除 26）；`domain_events` 最大 id 808→809，多出的是使用者 09:12:20 在新版上建立的筆記（`NODE_CREATED`），不是部署造成的。
清理：刪掉 `before-ea423d0`，保留 `before-74a05a4`、`before-73e2e4a`、`before-0b330c8`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 04b059d，留最近 5 個。磁碟 80%。

## 2026-10-14 編輯器復原修正、簡報模式、W18、W37、前端解析器線性化（#116、#114、#115、#111、#113）

部署 **`8138539`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 102）：
- **#116（優先，資料遺失修正）**：外部來的文字（同步、遠端更新）不再進入編輯器的復原歷史，換筆記時歷史重來；先前按復原可能把別處寫入的內容撤掉。
- **#114 H4 簡報模式**：任何筆記都能播放，從白板或標籤「做成簡報」；含 #109 後續與審查修正。
- **#115 W18 收尾**：Bases 的 `file.hasTag` 計入子標籤和 extends，和後端一致。（`/api/query` 標籤名不分大小寫是 #118，不在這次部署，下一次才上線。）
- **#111 W37**：拆大元件（編輯器補全與浮動工具列、側欄衝突、白板匯入與卡片清單），網站集合即時更新、studio 失敗會說出來。
- **#113**：前端正文解析器在病態正文上維持線性時間（`lib/textScan`）。
- 其餘是文件（#108、#110、#112 部署紀錄）。

順序同 74a05a4：先確認執行中映像就是 74a05a4 的 latest（current 的 `REVISION` 為 74a05a4，容器映像 id 與 latest 相同），打 tag `before-8138539`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014092736`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-8138539.log`）。
沒有跑任何 prune。磁碟 build 前 80%，build 後 83%。09:30:24 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401，未登入 `GET /api/ai/skills` 401。
切換後約 1.5 分鐘後端紀錄只有開機訊息與驗證請求，沒有錯誤或警告。`content_nodes` 部署前後都是 88 列（未刪除 26），`domain_events` 最大 id 前後都是 809，期間沒有寫入。
清理：刪掉 `before-0b330c8`，保留 `before-8138539`、`before-74a05a4`、`before-73e2e4a`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 dff0a9d，留最近 5 個。磁碟 82%。

## 2026-10-14 Obsidian 匯入分批、W38a/b 單一網站來源與發布預覽、AI 不設預設模型（#128、#123、#125、#124 等）

部署 **`1752af5`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；**沒有 migration**，最新仍是 102）：
- **#128（使用者在等）**：Obsidian 匯入改成分批上傳（每批目標 8 MB、單一請求上限 19 MB，圖片先傳），58 MB 的 vault 不再整包被 nginx 拒絕。部署中的 nginx 設定 `client_max_body_size 20m`（容器內 `/etc/nginx/nginx.conf` 與 current release 的 `docker/nginx/nginx.conf` 都是 20m），足夠一批的大小。
- **#123 W38a 單一網站來源、#125 W38b 發布預覽**，以及後續 #126、#129、#130。
- **#124 AI 沒有預設模型**、**#127** 檢查程式碼裡沒有寫死的模型 id。
- **#117** 簡報後續修正、**#118** `/api/query` 標籤名不分大小寫、**#122** 離線白板拖曳、#121 e2e 整理，其餘是文件（#119、#120）。

**行為改變（使用者要知道）：**
- **#124**：AI 不再有預設模型。在正式站上，AI 功能預設是關的，要到「設定 › AI」選模型，或設定 `AI_MODEL`/`ASK_MODEL` 才會開（這次沒有讀 env 檔確認目前是否有設定）。
- **W38a/b**：把筆記標成已發布，不會馬上上線，要按「發布」才會上線，而「發布」現在會先顯示預覽。對外網站內容 = 最新快照扣掉下架的項目。匿名 `/api/site` 部署前後一樣：快照 id `a9634c0c…`（2026-10-13T18:56Z），`nodes` 1、`edges` 0、`collections` 0。下次用新流程發布後，網站內容可能和現在不同。

順序同 8138539：先確認執行中映像就是 8138539 的 latest（current 的 `REVISION` 為 8138539，容器映像 id 與 latest 相同），打 tag `before-1752af5`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014102336`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-1752af5.log`）。
沒有跑任何 prune。磁碟 build 前 82%，build 後 86%。10:26:52 UTC 切換，`current` 指向新 release。
驗證：容器內 `/health` 回 `{"ok":true}`（backend 映像沒有 wget，改用 `node -e fetch`）；HTTPS 首頁、manifest、`/?view=tasks` 200，未登入 bootstrap 401，匿名 `/api/site` 200，未登入 `/api/export-static` 401，未登入 `GET /api/ai/skills` 401，**未登入 `GET /api/ai/models` 401**。
切換後約 1.5 分鐘後端紀錄只有開機訊息與驗證請求，沒有錯誤或警告。`content_nodes` 部署前後都是 92 列（未刪除 27），`domain_events` 最大 id 前後都是 835，期間沒有寫入。
清理：刪掉 `before-73e2e4a`，保留 `before-1752af5`、`before-8138539`、`before-74a05a4`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 ea423d0，留最近 5 個。磁碟 84%。
注意：nginx 容器（2 天前啟動，這次沒有重建）的設定檔 bind mount 指向已刪除的 release `1307c6b…/docker/nginx/nginx.conf`；容器仍持有該檔案，內容和目前的一樣，但下次重建 nginx 時會從 current 重新掛載。

## 2026-10-14 前端樣式修正：側欄、Markdown 與檢視樣式回來（#136、#137），W38c 單一 Markdown 管線（#135）等

部署 **`2de5721`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`，並重建 nginx；**沒有 migration**，最新仍是 102）：
- **#136（優先）**：正式站的 app 少了側欄、Markdown 與各檢視的樣式（首頁 CSS 裡 `.sidebar-tag-chip`、`.md-codeblock` 都是 0 筆）。修正後這些樣式回來，build 後會跑 `check-app-css` 檢查 app 用到的 class 都有樣式。
- **#137**：前端 Dockerfile 複製 `packages/frontend/scripts`，讓 build 後的 CSS 檢查能在映像裡執行。
- **#135 W38c 第一部分**：新的 `packages/markdown`（`@onden/markdown`）單一 Markdown 管線，app 經由它渲染；RSS 文章的 `$` 金額保持文字；頁內連結（註腳）留在頁內。backend/frontend Dockerfile 加複製 `packages/markdown`。
- **#134** permission matrix 測試、**#132** CSV 匯入自成一批、**#131** 發布預覽的媒體判斷，其餘是文件（#133）。

**失敗的前一次（目標 `c5ee554`，未上線）**：前端 build 在 `astro build && node scripts/check-app-css.mjs` 停下，因為 Dockerfile 沒有把 `packages/frontend/scripts` 複製進映像，找不到檢查程式。當時已打 tag `before-c5ee554`（= 1752af5 的映像）、跑過備份 `manual-20261014105448`，並把 `onden-vps-backend:latest` 指回舊映像；新 backend 映像留成未標記，release 資料夾已上傳但 `current` 仍指向 1752af5。正式站一直是 1752af5，沒有中斷。#137 修正後重新部署。

順序：先確認執行中映像就是 1752af5（current 的 `REVISION` 為 1752af5，容器映像 id 與 latest、`before-c5ee554` 相同），把同一組映像再打 tag `before-2de5721`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014110928`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；最後才 build（紀錄 `backups/build-2de5721.log`，`check-app-css: 15 reachable stylesheets cover the app's classes.`）。
磁碟 build 前 83%，build 後 93%。11:13:29 UTC 切換 backend 與 frontend，健康後 `current` 指向新 release，再 `up -d --no-deps nginx` 重建 nginx：它的設定檔 bind mount 原本指向已刪除的 `1307c6b…`，現在是 `/srv/onden/current/docker/nginx/nginx.conf`（新 release）。
驗證：容器內 `/health`（port 8787）回 `{"ok":true}`；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`GET /api/ai/skills`、`GET /api/ai/models` 都是 401。
**修正確認**：HTTPS 首頁的主樣式表 `/_astro/index.CZxxZ5Zv.css` 現在有 `.sidebar-tag-chip` 4 筆、`.md-codeblock` 6 筆（部署前 0 與 0）。
切換後後端紀錄只有開機訊息、嵌入模型的 dtype 提示與正常請求（使用者正在使用），沒有錯誤或警告。`content_nodes` 部署前後都是 450 列（未刪除 375），`domain_events` 最大 id 前後都是 1666（失敗那次記錄時是 1661，期間使用者寫入了 5 筆，與部署無關）。
清理：刪掉失敗那次的 release `c5ee554`、它留下的未標記映像（`1d7429aa7ce5`）與 `before-c5ee554` tag；刪掉 `before-74a05a4`，保留 `before-2de5721`、`before-1752af5`、`before-8138539`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 0b330c8，留最近 5 個。磁碟 91%。
**待處理**：磁碟仍超過 90%。打算跑 `docker builder prune -f --filter until=24h`（所有 rollback 映像都已標記），但這次被權限分類器擋下，沒有執行；要由使用者決定。

## 2026-10-14 查詢區塊修正、Excalidraw 與 PDF 匯入、.trash 選擇性匯入（#144、#145/#147/#149、#148）；migration 103

部署 **`642f7c4`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建；**migration 103**）：
- **#144**：查詢區塊的篩選修正。
- **#145、#147、#149**：Excalidraw 繪圖匯入。
- **#148**：匯入 vault 時處理嵌入、PDF 與 `.trash`。
- **#139、#146、#150** 重構（單一入口、消除循環相依、發布入口），其餘是文件與測試（#138、#140、#143）。backend Dockerfile 現在先 build `packages/markdown` 再 build backend。
- **migration `103_imported_media_pdf`**：`imported_media.extension` 的 check 加上 `.pdf`。只放寬限制、不動資料，退回舊映像也安全。

**行為改變（使用者要知道）：**
- 查詢區塊的鍵打錯時，現在會顯示錯誤，不再列出全部筆記。
- 系統筆記不再出現在查詢結果裡。
- Excalidraw 繪圖匯入後會變成手寫筆記。
- vault 裡的 PDF 會一起匯入（`![[paper.pdf]]` 改寫成指向存好的檔案的連結）。
- `.trash` 資料夾預設不匯入，要自己勾選。

順序：先確認執行中映像就是 2de5721（current 的 `REVISION` 為 2de5721，容器映像 id 與 latest 相同），打 tag `before-642f7c4`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014115934`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；接著 `docker builder prune -a -f`（已核准的例行步驟，這次 cache 本來就是 0B），最後才 build（紀錄 `backups/build-642f7c4.log`，`check-app-css: 15 reachable stylesheets cover the app's classes.`）。
磁碟 build 前 37%，build 後 48%。12:03:44 UTC 切換 backend 與 frontend，紀錄出現 `[migrate] applied 103_imported_media_pdf`，健康後 `current` 指向新 release。nginx 的設定檔 bind mount 來源是 `/srv/onden/current/docker/nginx/nginx.conf`，nginx 設定這次沒有改，所以沒有重建（容器建立時解析到的是 2de5721 release，該資料夾保留中）。
驗證：容器內 `/health`（port 8787）回 `{"ok":true}`；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`GET /api/ai/skills`、`GET /api/ai/models` 都是 401。主樣式表 `/_astro/index.CZxxZ5Zv.css` 仍有 `.sidebar-tag-chip` 4 筆。
**migration 確認**（只查 schema）：`imported_media_extension_check` 現在是 `.png .jpg .jpeg .gif .webp .svg .avif .pdf`（部署前沒有 `.pdf`）。
切換後約 2 分鐘後端紀錄只有開機訊息、migration 訊息與嵌入模型的 dtype 提示，沒有錯誤或警告。`content_nodes` 部署前後都是 450 列（未刪除 375），`domain_events` 最大 id 前後都是 1669（上次部署記錄時是 1666，兩次部署之間使用者寫入了 3 筆，與部署無關）。
清理：刪掉 `before-8138539`，保留 `before-642f7c4`、`before-2de5721`、`before-1752af5`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 73e2e4a，留最近 5 個。磁碟 46%。

## 2026-10-14 發布用的 Markdown 管線收尾（W38c #158）與 lib/data 重構（#142、#151）；沒有 migration

部署 **`5c341df`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建；**沒有 migration**，最新仍是 103）：
- **#158 W38c 收尾**：發布用的 profile（網站與匯出）會顯示編輯器自己寫的 `u`、`mark`、`audio`、`video`（加 `source`），一樣經過 sanitize；其他行內 HTML 仍顯示成文字。音訊／影片快速建立改寫成 `![name](url)`。
- **#142、#151** 重構（`lib/data` 單一入口、`writersFor(options)`），其餘是文件（#152 部署紀錄、#153/#155 block nodes、#154 agent delegation）。
- W38c 的共用管線 `packages/markdown`（#135、#138）在 2de5721、642f7c4 已經上線，這次 backend 仍先 build `packages/markdown`、再複製它的 `dist/`，build 正常。

**行為改變（使用者要知道）：**
- 網站與匯出：callout（`> [!note]`）會畫成 callout；匯出裡的數學用 KaTeX 畫出來（這兩項隨 #138 在 642f7c4 已上線，這次在正式容器內再確認一次）。
- 匯出與網站裡的其他行內 HTML 會顯示成文字，但 `<u>`、`<mark>`、`<audio>`、`<video>` 會正常呈現，播放器可以播（**這次新上線**）。
- RSS 文章裡的 `$` 不再被當成數學（例如金額），保持文字。
- 「發布」旗標與網站設定的修改要按 Publish 才會生效——這在 1752af5 就已上線，不是這次的改變。

順序：先確認執行中映像就是 642f7c4（current 的 `REVISION` 為 642f7c4，容器映像 id 與 latest 相同），打 tag `before-5c341df`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261014131111`，DB/content checksum 通過，重啟後的 backend 仍是舊映像）；接著 `docker builder prune -a -f`（例行步驟，清掉 4.7 GB），最後才 build（紀錄 `backups/build-5c341df.log`：`npm run build --workspace=packages/markdown` 通過、`COPY --from=build /app/packages/markdown/dist` 完成，`check-app-css: 15 reachable stylesheets cover the app's classes.`）。
**注意**：第一次備份是用 `ssh … 'bash -s' < scripts/backup-vps.sh` 送腳本，`compose exec -T` 把 stdin 剩下的腳本吃掉，只留下 `database.dump`、沒有 `content.tar` 與 `SHA256SUMS`。那個不完整的資料夾（`manual-20261014131048`）已刪掉，改成在 VPS 上執行 `bash /srv/onden/current/scripts/backup-vps.sh </dev/null` 才成功。以後一律在 VPS 上直接跑腳本。
磁碟 build 前 40%（prune 後），build 後 51%。13:15:11 UTC 切換 backend 與 frontend，`current` 指向新 release。nginx 設定沒變，所以沒有重建（bind mount 來源 `/srv/onden/current/docker/nginx/nginx.conf`，建立時解析到 2de5721 release，該資料夾保留中）。
驗證：容器內 `/health`（port 8787）回 `{"ok":true}`（backend 映像沒有 `wget`，用 `node -e fetch(...)`）；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200（回傳 site 與 nodes）；未登入 bootstrap、`/api/export-static`、`GET /api/ai/skills`、`GET /api/ai/models` 都是 401。主樣式表 `/_astro/index.CZxxZ5Zv.css` 仍有 `.sidebar-tag-chip` 4 筆。
**Markdown 管線確認**：在 backend 容器內 import `dist/services/publishing/htmlUtils.js` 的 `md2html`，渲染 `> [!note] hi\n\n$x^2$`，輸出 `<div class="callout callout-note">…` 與 `<span class="katex">…`。
切換後約 2.5 分鐘後端紀錄只有開機訊息、嵌入模型的 dtype 提示與正常請求，沒有錯誤或警告。`content_nodes` 部署前後都是 450 列（未刪除 375），`domain_events` 最大 id 前後都是 1669。
清理：刪掉 `before-1752af5`，保留 `before-5c341df`、`before-642f7c4`、`before-2de5721`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 74a05a4，留最近 5 個。磁碟 49%。

## 2026-10-14 架構債 A1–A4 收尾、發布站 CSS 修正、block nodes 資料表（#156、#159、#162、#160、#163、#157）；migration 104

部署 **`512f5a3`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建；**migration 104**）：
- **#156、#159、#162**（A2 收尾）：`lib/data` 對外名稱從 68 降到 47（`drafts.*`、`dataSync.*`、`recovery.*`、`writeErrors.*`、`noteStructure.*`、`pins.*`）。純重構。
- **#157**（A4）：`BuilderWorkspace` 從 1320 行拆成 hooks 和 `components/workspace/`。純重構；審查時修掉兩處拆分造成的差異（切換模式時側欄會重新展開群組、右鍵選單開關時整個側欄重繪）。
- **#160**：發布站頁面引用的 `SiteTemplate` CSS 沒有被輸出（Astro 會刪掉含 island 自身模組的 chunk 的 CSS）。現在用 `SiteTemplateIsland` 當 island；`check-app-css` 在 JS 引用了沒輸出的 CSS 時會讓 build 失敗。
- **#163**（B1a）：block nodes 的解析器與資料表。正式程式還沒有任何地方讀寫這些表，存檔行為不變。
- **migration `104_block_nodes`**：新增 `block_nodes`、`block_node_tags` 兩張表，以及 `content_nodes.tag_is_inheritable`（可為空）。只新增、不回填，退回舊映像也安全。

**行為改變（使用者要知道）：**
- 發布站：之前缺少的 `SiteTemplate` 樣式回來了，公開頁面第一次載入預覽時不會再出現「Unable to preload CSS」。
- 其他都是內部重構，畫面和操作應該沒有變化。

順序：先確認執行中映像就是 5c341df（current 的 `REVISION` 為 5c341df，容器映像 id 與 latest 相同），打 tag `before-512f5a3`（本來打成 `before-382a965`，準備部署 382a965 時 #157 測試通過並合併，改部署 512f5a3，tag 改名、382a965 的 release 刪掉）；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後在 VPS 上執行 `bash /srv/onden/current/scripts/backup-vps.sh </dev/null`（`/srv/onden/backups/manual-20261014134946`，database.dump 與 content.tar 的 checksum 通過，重啟後的 backend 仍是舊映像）；接著 `docker builder prune -a -f`（清掉 4.7 GB），最後才 build（紀錄 `backups/build-512f5a3.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。
磁碟 prune 後 43%，build 後約 50%。13:53:48 UTC 切換 backend 與 frontend，紀錄出現 `[migrate] applied 104_block_nodes`，健康後 `current` 指向新 release。nginx 設定沒變，所以沒有重建（bind mount 來源 `/srv/onden/current/docker/nginx/nginx.conf`，建立時解析到 2de5721 release，該資料夾保留中）。
驗證：容器內 `/health`（port 8787）回 `{"ok":true}`；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`GET /api/ai/skills`、`GET /api/ai/models` 都是 401。首頁引用的 19 個 `/_astro/` 資源、`/site/` 引用的 4 個資源全部 200。
**migration 確認**（只查 schema）：`block_nodes` 存在且 0 列，`content_nodes.tag_is_inheritable` 欄位存在。
切換後約 5 分鐘後端紀錄沒有錯誤或警告。`content_nodes` 部署前後都是 450 列（未刪除 375），`domain_events` 最大 id 前後都是 1669。
清理：刪掉 `before-2de5721`，保留 `before-512f5a3`、`before-5c341df`、`before-642f7c4`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 8138539，留最近 5 個（含 nginx 掛載用的 2de5721）。磁碟 50%。

## 2026-10-15 摘要掃描效能修正（#169）；只重建 backend，沒有 migration

部署 **`a33aa30`**（main；只重建 backend，`up -d --no-build --no-deps backend`；frontend 與 nginx 沒有改動、沒有重建；**沒有 migration**，最新仍是 104）：
- **#169**：`excerptOf` 找圖片與 Markdown 連結時改用掃描器，不再用正規表示式（舊做法在每個 `[` 都重掃最多 2000 字，含大量未閉合連結的筆記會拖慢 `/api/bootstrap`）。輸出不變；測試把舊的正規表示式版本當參考，用隨機內容比對。另外筆記切換的前端測試把逾時調得比等待時間長（只有測試）。

**行為改變（使用者要知道）：** 沒有。列表預覽的文字應該和之前一樣。

部署前在乾淨的 worktree（a33aa30）跑過 backend `tsc --noEmit`、`excerptScan.test.ts`（3 通過），以及其他匯入 `utils` 的 backend 測試（118 通過、33 跳過）。
順序：先確認執行中映像就是 512f5a3（current 的 `REVISION` 為 512f5a3，容器映像 id 與 latest 相同），打 tag `before-a33aa30`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後在 VPS 上執行 `bash /srv/onden/current/scripts/backup-vps.sh </dev/null`（`/srv/onden/backups/manual-20261014204830`，database.dump 與 content.tar 的 checksum 通過，重啟後的 backend 仍是舊映像）；接著 `docker builder prune -a -f`（清掉 4.7 GB），最後只 build backend（紀錄 `backups/build-a33aa30.log`）。
磁碟 prune 後 43%，build 後 49%。20:50:41 UTC（VPS 時間）切換 backend，`/health` 回 `{"ok":true}` 後 `current` 指向新 release。
驗證：HTTPS 首頁、`/?view=tasks`、匿名 `/api/site`、`/site/` 200；未登入 bootstrap、`/api/export-static`、`GET /api/ai/skills`、`GET /api/ai/models` 都是 401。在新容器內 import `dist/utils.js`：`excerptOf("# T\n![img](a.png) see [docs](http://x) and [[Page|alias]]")` 回 `"T see docs and alias"`；20000 個 `[` 的內容 0 ms。
切換後約 5 分鐘後端紀錄沒有錯誤或警告。`content_nodes` 部署前後都是 450 列，`domain_events` 最大 id 前後都是 1669。
清理：第一次刪除被權限擋下，使用者同意後補做。刪掉 `before-642f7c4`，保留 `before-a33aa30`、`before-512f5a3`、`before-5c341df`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 1752af5，留最近 5 個（含 nginx 掛載用的 2de5721）。磁碟 44%。

## 2026-10-15 深度模組審查 D1–D10、D2 與後續修正（#179、#184、#186–#195）；沒有 migration

部署 **`600baad`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建；**沒有 migration**，最新仍是 104；Dockerfile 與 compose 沒有變）。執行中的程式與 `f1c728fa` 相同（#195 只改測試）。D11（#196）與 D12（#197）**沒有**包含在內，它們等 904bc15d 的 e2e 結果。
- **#184 D1**：建立 tag 與寫入 tag schema 集中到 `services/tagWrites.ts`。
- **#179 D3**：複製筆記、範本子筆記也會備份、建連結、區塊 id 與 embedding（`finishNewNote`）。
- **#186 D4、#187 D5**：側欄改收分組 props；`KnowledgeWorkspace` 改收 `{ board, actions }`，修掉 memo 每次都失效、所有卡片跟著重繪的問題。
- **#188 D6**：前端同步引擎搬進 `lib/data`，只有 `lib/data` 能讀 localDb。
- **#189**：重新連線同步到一半時瀏覽器又離線，不再把工作區鎖在「更新權限中」。
- **#190 D8、#192 D10、#193**：後端同步協定與 `/api/bootstrap` 搬進 `services/sync/`；bootstrap 在單一讀取快照內完成。
- **#191 D9**：成員與 token 的十個操作搬進 `services/actors.ts`，每個先檢查擁有者。
- **#194 D2、#195**：routes 不再直接寫 SQL（lint `onden/no-route-writes`），服務層的寫入需經 spine 或列在例外清單。

**行為改變（使用者要知道）：**
- 複製的筆記、範本產生的子筆記，建立時就會進 git 備份與搜尋索引，不必等第一次編輯。
- 離線又上線又斷線時，不會再卡在「更新權限中」而無法編輯本機筆記。
- 開啟 App 時若帳號已被移除或 token 已撤銷，載入會回 401（過去撤銷的 token 仍能拿到初次載入的資料）。
- 其餘都是內部重構，畫面與操作應該沒有變化；大畫布上的卡片重繪變少。

**e2e 把關**：note-3f 在 f1c728fa 跑完整 general suite（3 個 project，台北時區、全新環境）：283 通過 / 40 失敗，a33aa30 為 284 / 39。只在 f1c728fa 失敗的 4 個 spec 在全新環境重跑：3 個 3/3 通過（長時間執行的狀態偶發），pdfInk:37 是 spec 只接受舊的歷史文字（`drawing updated`），新的手勢說明先載入時就失敗，不是程式錯誤（修正為 PR #198）。約 20 個網站 spec 自快照模式 B 起就過時，兩邊都失敗。

順序：先確認執行中映像就是 latest（backend 為 a33aa30 的 build，frontend 為 512f5a3 的 build），打 tag `before-600baad`；
再傳 release（`git archive` 經 ssh）並寫入 `REVISION`；然後在 VPS 上執行 `bash /srv/onden/current/scripts/backup-vps.sh </dev/null`（`/srv/onden/backups/manual-20261015015843`，database.dump 與 content.tar 的 checksum 通過，重啟後的 backend 仍是舊映像）；接著 `docker builder prune -a -f`（清掉 2.3 GB），最後才 build（紀錄 `backups/build-600baad.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。
磁碟 prune 後 41%，build 後 53%。02:02:24 UTC 切換 backend 與 frontend，健康後 `current` 指向新 release。nginx 設定沒變，所以沒有重建。
驗證：容器內 `/health`（port 8787）回 `{"ok":true}`；兩個容器的映像 id 與新的 latest 相同；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`/api/ai/skills`、`/api/ai/models`、`/api/sync`、`/api/actors` 都是 401；首頁引用的 `/_astro/` 資源全部 200。
切換後後端紀錄沒有錯誤或警告。`content_nodes` 部署前後都是 451 列（未刪除 376），`domain_events` 最大 id 前後都是 1670。
清理：刪掉 `before-5c341df`，保留 `before-600baad`、`before-a33aa30`、`before-512f5a3`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 642f7c4，留 5 個（含 nginx 掛載用的 2de5721）。磁碟 48%。

## 2026-10-15 深度模組審查 D11、D12（#196、#197）；沒有 migration

部署 **`2d935e7`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建；**沒有 migration**，最新仍是 104）。執行中的程式與 `904bc15d` 相同（#198 只改 e2e spec，#199 是文件）。
- **#196 D11**：前端核心的讀取集中到 `lib/data/reads.ts`（lint `onden/reads-through-data`）。搜尋離線時改用本機索引、有排隊寫入時屬性值改讀本機副本的退路一併搬進去。
- **#197 D12**：拆分、合併筆記搬進 `lib/data`（`noteStructure.splitNote` / `mergeChildren`）；只有 `lib/data` 能改 store 的 `setData`。
- **#198**：pdfInk e2e 接受歷史紀錄的新手勢說明。

**行為改變（使用者要知道）：** 沒有預期的畫面或操作變化，都是內部重構。

**e2e 把關**：note-3f 在 904bc15d 跑完整 general suite（3 個 project）：283 通過 / 40 失敗，與 f1c728fa 相同。只在 904bc15d 失敗的 2 個：inkCanvas:217 在 a33aa30 也失敗（已知偶發），table-inline-edit:65 在全新環境重跑 3/3 通過。修好的 pdfInk spec 5/5 通過。

順序：確認執行中映像就是 600baad 的 latest，打 tag `before-2d935e7`；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261015023011`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（紀錄 `backups/build-2d935e7.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。磁碟 build 後 53%。
02:33:47 UTC 切換 backend 與 frontend，健康後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；兩個容器的映像 id 與新的 latest 相同；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`/api/ai/skills`、`/api/ai/models`、`/api/sync`、`/api/actors` 都是 401；首頁引用的 `/_astro/` 資源全部 200。後端紀錄沒有錯誤或警告。`content_nodes` 前後都是 451 列（未刪除 376），`domain_events` 最大 id 前後都是 1670。
清理：刪掉 `before-512f5a3`，保留 `before-2d935e7`、`before-600baad`、`before-a33aa30`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 5c341df，留 5 個（含 nginx 掛載用的 2de5721）。磁碟 48%。

## 2026-10-15 深度模組審查 D13（#201、#202、#203）；只有 backend，沒有 migration

部署 **`c212d63`**（main；**只重建 backend**，`up -d --no-build --no-deps backend`；frontend 沿用 2d935e7 的映像，`2d935e7..c212d63` 沒有改動 `packages/frontend`；nginx 沒有重建；**沒有 migration**，最新仍是 104）。
- **#201 D13c**：`/api/ai/ask` 搬進 `services/aiAsk.ts`（計量、回答、SSE、錯誤對應，`/run` 共用）；RSS 文章存成筆記搬進 `modules/rss/save.ts`。
- **#202 D13a**：收件匣佇列、每日檢視、查詢區塊、markdown 匯出的讀取搬進 `inboxQueue`、`dayLens`、`nodeQuery`、`exportZip`。
- **#203 D13b**：任務更新與議程、Obsidian 匯入、tag 套件匯入搬進 `taskUpdate`、`taskAgenda`、`importObsidian`、`tagPacks.installTagPack`。

**行為改變（使用者要知道）：** 沒有，都是內部重構；note-87 的新舊對照（AI 問答含 SSE 與各錯誤狀態、10 種身分的讀取、zip 逐檔、任務與匯入）全部一致。

**e2e 把關**：note-3f 在 c212d632 跑完整 general suite（3 個瀏覽器、全新環境）：283 通過 / 40 失敗 / 14 略過，與 904bc15d 相同。新出現的 2 個重跑後通過（navigationMenuParity:96 差 0.51px，3/3；table-inline-edit:105 全新環境 9/9，屬已知的狀態累積偶發）。

順序：確認執行中 backend 映像就是 latest，打 tag `before-c212d63`；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261015041637`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；只 build backend（紀錄 `backups/build-c212d63.log`）。
04:20:29 UTC 切換 backend，健康後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；backend 映像 id 與新的 latest 相同；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/export-static`、`/api/ai/skills`、`/api/ai/models`、`/api/sync`、`/api/actors`、`/api/inbox`、`/api/day/:date/lens`、`/api/tasks/agenda` 都是 401。後端紀錄沒有錯誤或警告。`content_nodes` 前後都是 451 列（未刪除 376），`domain_events` 最大 id 前後都是 1670。
清理：刪掉 `before-a33aa30`，保留 `before-c212d63`（backend）、`before-2d935e7`、`before-600baad`，每個 latest 和 before-* 映像（加上 postgres、backup）都能 `docker create`。舊 release 刪掉 512f5a3，留 5 個（含 nginx 掛載用的 2de5721）。磁碟 45%。

## 2026-10-15 標籤區深度檢查 T1、T2、T3、T6、T8（#217–#221）；沒有 migration

部署 **`2484ee01`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建，仍掛載 2de5721；**沒有 migration**，最新仍是 104）。由 note-a3 部署（使用者說「都合併」）。
- **#217 T3**：bootstrap 改送和 GET /api/tags 同一份標籤目錄（含 parent_id、reserved_key、usage_count），重新連線不再用精簡清單覆蓋離線目錄。
- **#218 T1**：保留標籤（task、page、subscription、workspace-config）不能被合併或刪除，回 409 `reserved_tag`；改名、改色照常。
- **#219 T8**：視圖改名和新建用同一條名稱不重複規則。
- **#220 T2**：+標籤列與側欄的「建立 #名稱」改走 `POST /api/tags`（`createTag`），和在筆記打 `#名稱` 同一條路。
- **#221 T6**：標籤同名規則只在 `tagHierarchy` 一處（同父層、逐字相同）。

**行為改變（使用者要知道）：**
- 離線時 `#a/b` 這類子標籤路徑能正確解析，子標籤的筆記不再從成員與 bases 漏掉。
- 保留標籤的頁面不再顯示合併與刪除，改為提示「系統標籤：可以改名，但不能合併或刪除。」；合併選單不列保留標籤。父標籤底下掛著保留標籤時，刪除父標籤會被拒（409）。
- 視圖改成同一個標籤下已有的名字會被拒（409）。
- 共享空間的編輯者也能從 +標籤建立標籤（以前樂觀出現後 403 回滾）。擁有者從 +標籤建立的空白標籤不再自動帶 collection schema；名稱含 `/` 會被拒；非擁有者不能建立和保留鍵同名的根標籤（409 `reserved_name`）。
- 同名衝突只看同父層：已有 `#books/reading` 時可以再建根層的 `reading`；合併時只差大小寫的子標籤直接搬過去。

**e2e 把關**：這次部署**沒有**跑 e2e。

順序：確認執行中映像就是 latest，打 tag `before-2484ee0`；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261015205753`，checksum 通過）；`docker builder prune -a -f`（清掉 2.3 GB）；build（紀錄 `backups/build-2484ee0.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。
21:01:53 UTC 切換 backend 與 frontend，健康後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；兩個容器的映像 id 與新的 latest 相同；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/tags`、`/api/sync`、`/api/actors` 都是 401。後端紀錄沒有錯誤。
切換前 `content_nodes` 453 列，未刪除只剩 15：使用者自己在 20:51–20:55 UTC 把 363 篇筆記丟進垃圾桶（使用者的整理，不是事故）。`domain_events` 最大 id 2041。
清理：刪掉 `before-600baad`，保留 `before-2484ee0`、`before-c212d63`（backend）、`before-2d935e7`，每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 a33aa30。磁碟 49%。

## 2026-10-15 標籤區深度檢查 T4、T5（#222）；migration 106

部署 **`7f14e4c4`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建，仍掛載 2de5721）。由 note-a3 部署。
- **#222 T4**：「標籤 X 的筆記」只有一個答案（`lib/nodeTags.ts` 的 `tagMembers`）：側欄以 tag id 為 key、同名標籤用路徑區分；SchemaLens 含子標籤與 extends。
- **#222 T5**：保留標籤只認 `reserved_key`（後端 `reservedTagPredicate`、前端 `isReservedTag`），拿掉只看標題的判斷。
- **migration `106_subscription_key_backfill`**：為翻成 content 或已刪除、沒有 key 的 #subscription 補上 `reserved_key`。啟動時套用（紀錄 `[migrate] applied 106_subscription_key_backfill`）。

**行為改變（使用者要知道）：**
- #課程 的標籤頁也會列出 #課程/演算法 的筆記，並提示「也包含子標籤的筆記」；白板與存檔檢視的成員一致。用量數字（標籤總覽、`usage_count`）刻意維持只算直接標記。
- 側欄裡 `#draft` 和 `#proj/draft` 不再合成一個，同名標籤用路徑顯示；標籤頁與側欄 chip 的數字一致（都計入文字 hashtag）。
- 把 #subscription 改名（例如 feeds）後它不會出現在標籤選單；使用者自己的 `#reading/subscription` 不再被藏起來；垃圾桶裡的 `#x/subscription` 不會被當成 RSS 標籤復活。
- `/api/query` 與存檔檢視明確排除標籤定義列。

**e2e 把關**：這次部署**沒有**跑 e2e。

順序：確認執行中映像就是 latest，打 tag `before-7f14e4c`；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261015211221`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（紀錄 `backups/build-7f14e4c.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。
21:16:00 UTC 切換 backend 與 frontend，migration 106 在啟動時套用，健康後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；兩個容器的映像 id 與新的 latest 相同；HTTPS 首頁、`/?view=tasks`、匿名 `/api/site` 200；未登入 bootstrap、`/api/tags`、`/api/sync`、`/api/actors`、`/api/query` 都是 401。
清理：刪掉 `before-2d935e7`，保留 `before-7f14e4c`、`before-2484ee0`、`before-c212d63`（backend），每個 latest 和 before-* 映像都能 `docker create`。舊 release 刪掉 600baad。磁碟 49%。

## 2026-10-15 事故：前端 2484ee01／7f14e4c4 開不起來，前端回滾

21:01–22:28 UTC，正式環境的 App 一直轉圈，進不了工作區。由 note-1d 發現，note-a3 處理。
- **原因**：D20（#209）讓 `pendingNoteProjection` 從 `@onden/markdown` 匯入 `slugify`，整條 micromark 管線因此被打包進本機資料庫 worker（`localDbWorker`）。其中 `decode-named-character-reference` 在模組載入時就呼叫 `document.createElement("i")`，worker 裡沒有 `document`，於是 worker 啟動就拋錯。
- **為什麼部署時沒抓到**：2484ee01 與 7f14e4c4 的部署只驗了 HTTP 狀態碼（首頁 200、私有 API 401），沒有用真的瀏覽器開 App。
- **處理**：只回滾前端。壞掉的映像改名 `onden-vps-frontend:broken-7f14e4c` 留存；把 `before-2484ee0`（b0c6ae95，2d935e7 的 build）重新標成 latest，`up -d --no-build --no-deps frontend`，22:28:42 UTC 切換完成。backend 留在 7f14e4c4。驗證：送出的是舊 worker `localDbWorker-BlcgvhRS.js`，新的 `localDbWorker-DfoZ2Yyw.js` 回 404。
- **回滾期間的影響**：前後端版本不一致，編輯者從「+ 標籤」建立標籤會失敗，直到下面的重新部署。
- **修正**：#235（note-1d）。`@onden/markdown` 多一個沒有相依的 `./slug` 入口，worker 只匯入它；新增 `workerImports.test.ts`，用 esbuild 以瀏覽器格式打包 worker，確認裡面沒有 micromark／mdast／unified／remark／rehype／hast／decode-named-character-reference。
- **之後的規矩**：部署驗證一定要用真的瀏覽器開過 App：部署前在本機用空的本機資料庫開一次，部署後檢查正式環境送出的 worker 能在瀏覽器載入。

## 2026-10-16 標籤區深度檢查收尾與前端修正（#224–#230、#232、#234–#236）；沒有 migration

部署 **`4e8346aa`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建，仍掛載 2de5721）。由 note-a3 部署。
- **#235**：本機資料庫 worker 不再載入 markdown 管線（修好上面的事故）。
- **#228 T9、#232 GAP-142**：標籤行為存檔前先驗證（handler manifest、欄位型別、空鍵、每個字串 2000 字元、每個 hook 32 KiB），錯誤回 400 `invalid_behaviour`；已存的壞規則在派發時略過並記 `CASCADE_SKIPPED`，不再讓筆記寫入 500。
- **#229 T11**：標籤改名只走一條路，名稱有統一的格式規則。
- **#226 T13**：集合管理改標籤定義可以復原；檢視事件不再顯示「復原」。
- **#225、#236**：設定筆記只認 `_workspace_config`；同名標籤在標籤頁標題、合併選單、模組庫清單顯示路徑。
- **#224、#227、#230、#234**：文件與測試。

**行為改變（使用者要知道）：**
- 標籤行為裡寫錯的規則（未知 handler、欄位型別不合、空鍵、太長）現在存檔時就被擋下，並列出出錯的位置。以前存進去的壞規則不會再擋住筆記存檔，而是略過並在稽核裡留紀錄；下次編輯那條規則時要先改正才能存。
- 標籤名稱的格式規則（T11）只套用在新建與改名；已存在的不合規名稱不會被自動修改。

**驗證（部署前）**：後端全套 2634 過、1 失敗（`readGuard` 過時項目，等使用者決定）；前端 `nodeVersionPreview` 隨機失敗 1–3 個，7f14e4c4 上也一樣（另案處理）。本機用 `compose.e2e.yaml` 疊加從零建的資料庫，加上新的瀏覽器設定檔實際開 App：註冊、建立與儲存筆記、連結、圖、版本紀錄都正常（`coreJourney` 的發布步驟是已知過期的 spec）。

順序：打 tag `before-4e8346a`（backend 62372f2a、frontend b0c6ae95）；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261016015302`，checksum 通過）；`docker builder prune -a -f`；build（紀錄 `backups/build-4e8346a.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。切換前確認新映像裡的 `localDbWorker-ZYPGePd2.js` 沒有 `createElement` 和 micromark，和本機開過的 build 檔名相同。
01:57:18 UTC 切換 backend 與 frontend，健康後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；HTTPS 首頁、匿名 `/api/site` 200，未登入 `/api/bootstrap` 401；正式環境送出 `localDbWorker-ZYPGePd2.js`（200），舊的 `BlcgvhRS` 404；用 Chromium 開正式環境首頁沒有錯誤，並在頁面裡實際 `new Worker(...)` 載入該 worker，沒有錯誤。登入後的畫面沒有帳號可測，需使用者確認一次。
清理：刪掉 `before-c212d63`（backend）與 `broken-7f14e4c`，保留 `before-4e8346a`、`before-7f14e4c`、`before-2484ee0`。舊 release 刪掉 c212d63。磁碟 49%。

## 2026-10-16 深度檢查第 9–11 輪（#210–#216、#223、#231、#233、#237–#242、#244–#250）；migration 105

部署 **`9316d48e`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建）。由 note-59 部署（note-a3 同意，期間不動 VPS）。不含 #243（T10），留給下一次部署。

**內容（使用者看得到的）：**
- **D21 #216**：屬性值型別只看 schema 欄位；migration 105 依同一條規則修正已存的 `node_attributes.value_type`（日期、數字欄位裡放不下的值改存成文字）。
- **D34 #248**：`key:: value` 屬性行只藏那一行，下一行正文不再一起消失；`~~~` 區塊裡的 `key::` 不再被存成屬性。
- **D35 #250**：白板上的音訊、影片卡片顯示播放器；`.oga` 顯示成音訊；網站圖示可上傳 `.ico`；可上傳 `.aac`、`.flac`、`.ogv`；選檔視窗只列伺服器接受的格式。
- **D36 #247**：靜態網站中文網址重新整理、分享連結都開到對的頁面。
- **D30 #246**：`+ [ ]`、`1. [ ]`、引用裡的勾選框可以轉任務；程式碼區塊裡的不會；同文字兩行會勾對行。
- **D33 #241**：能不能復原由伺服器逐筆判斷，不會再出現按了「復原」卻失敗的事件。
- **D31 #237**：事件時間軸、筆記歷史、收件匣用同一套事件顏色與名稱（深色主題可讀）。
- **D41 #249**：離線時任務清單的已完成區和伺服器一樣；離線刪除筆記後回線，任務不會短暫又出現。
- **#242**：筆記清單的排序方式會被記住。
- 其他是重構（D16、D22、D23、D25、D26、D27、D29a、D32、T7、#244）與測試修正（#240）。

**驗證（部署前）**：main 9316d48e 完整測試：backend 2695 過、1 失敗（`readGuard` 過時項目，等使用者決定）；前端 2406 全過。worker bundle 只帶 `markdown/dist/slug.js`。

順序：打 tag `before-9316d48`（backend 3b786eaf、frontend 97981595，即 4e8346aa 的映像）；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261016060108`，database.dump 與 content.tar checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（紀錄 `backups/build-9316d48.log`，`astro build` 通過、`check-app-css: 16 reachable stylesheets cover the app's classes.`）。切換前確認新映像的 `localDbWorker-D54uNdzC.js`（71 KB）沒有 `createElement` 和 micromark。
06:41:10 UTC 切換 backend 與 frontend，06:41:35 健康；backend 記錄 `[migrate] applied 105_attribute_value_type_repair`。之後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；HTTPS 首頁、匿名 `/api/site` 200，未登入 `/api/bootstrap` 401；schema_migrations 最新為 106、105；content_nodes 812、node_attributes 2326 筆。正式環境送出 `localDbWorker-D54uNdzC.js`（200），舊的 `ZYPGePd2` 404；用 Chromium 開正式環境首頁沒有錯誤，並在頁面裡實際 `new Worker(...)` 載入新 worker，沒有錯誤。正式站目前沒有公開發布的頁面，D36 的中文網址沒辦法在正式站實測（單元測試涵蓋）。登入後的畫面沒有帳號可測，需使用者確認一次。
清理：刪掉 `before-2484ee0`（backend、frontend）與 release 2484ee0、2d935e7；保留 `before-9316d48`、`before-4e8346a`、`before-7f14e4c`，三組都通過 `docker create`。release 2de5721 仍被 nginx 掛載，保留。磁碟 51%。

## 2026-10-17 深度檢查第 12 輪與 T10（#243、#252–#254、#256）；沒有 migration

部署 **`2ea8aefd`**（main；重建 backend 與 frontend，`up -d --no-build --no-deps backend frontend`；nginx 沒有重建）。由 note-59 部署。沒有新 migration（最新仍為 106）。不含 #255（另一個 session 整合中的舊 PR）。

**內容（使用者看得到的）：**
- **T10 #243**：內文與標題裡的 `#文字` 不再算成標籤；Tasks 快速新增也不再解析 `#tag`。
- **D37 #253**：筆記摘要只有一套規則：RSS 描述不再是 `---`、文章列表摘要不再顯示 `status: …`、Obsidian 匯入的文章不再重複標題；摘要不含清單記號、表格、^id；手寫的 `description:` 成為摘要。
- **D39 #252**：圖譜、白板、連結檢視、箭頭選單用同一套連線名稱與顏色（建議連結、導覽、白板 wikilink 的顏色調深，兩種主題都有 3:1 對比）。
- **D43 #254**：`[[連結]]` 只在連結所在的空間找標題（同名筆記不再開錯）；`[[Plan|別名]]`、`[[Plan#段落]]` 的反向連結有片段、點了會跳到連結。
- **D44 #256**：屬性名稱可用中文，匯出再匯入不會遺失；Obsidian 的中文 property 匯入得到屬性；含空格、冒號的新屬性名稱會被拒絕（已存在的照舊可編輯）。

**驗證（部署前）**：main 2ea8aefd：markdown 134/134；backend 2712 過、1 失敗（已知的 `readGuard` 過時項目）、5 skipped；前端 2419/2419；三個套件 tsc、前後端 eslint 乾淨。worker bundle 只帶 `markdown/dist/slug.js`、0 個 `createElement`。

順序：打 tag `before-2ea8aef`（backend 9b356df6、frontend ae0a0a89，即 9316d48e 的映像）；傳 release 並寫入 `REVISION`；在 VPS 上執行 `backup-vps.sh`（`/srv/onden/backups/manual-20261017074020`，database.dump 與 content.tar checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（紀錄 `backups/build-2ea8aef.log`，`check-app-css: 16 reachable stylesheets cover the app's classes.`）。新映像的 `localDbWorker-D54uNdzC.js` 沒有 `createElement` 和 micromark。
07:45:00 UTC 切換 backend 與 frontend，07:45:24 健康。之後 `current` 指向新 release。
驗證：`/health` 回 `{"ok":true}`；HTTPS 首頁、匿名 `/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 813、node_attributes 2326。用 Chromium 開正式環境首頁沒有錯誤，頁面裡 `new Worker(...)` 載入 worker 沒有錯誤。登入後的畫面沒有帳號可測。
清理：刪掉 `before-7f14e4c`（backend、frontend）與 release 7f14e4c；保留 `before-2ea8aef`、`before-9316d48`、`before-4e8346a`，三組與 latest 都通過 `docker create`。release 2de5721 保留（nginx 現在掛載 `current`）。磁碟 51%。

## 2026-10-17 白板卡片連結、⌘S、中文屬性搜尋（#258、#259）；沒有 migration

部署 **`2fcbe1e7`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署。

**內容（使用者看得到的）：**
- **#258**：⌘S 只存一次（以前每次送兩個 PATCH）。白板卡片上的 `[[連結]]` 能點了（之前 sanitizer 剝掉 `data-wikilink`，點了沒反應），並以卡片自己的空間解析；可點的連結有手指游標。
- **#259（D44b）**：搜尋 `作者:王` 會篩中文屬性；`http://…` 不再被當成屬性條件；`$attr.作者` 支援中文 key；`#2024=x` 不再產生屬性。半形冒號的中文詞在搜尋框裡會變成屬性條件（全形「：」仍是文字）。

**驗證（部署前）**：main 2fcbe1e7：markdown 135/135；backend 2728 過、1 失敗（已知 `readGuard`）、5 skipped；前端 2423/2423；tsc、eslint 乾淨；worker bundle 16 個 input、無 micromark。

順序：打 tag `before-2fcbe1e`（backend 3c6cea93、frontend 9a5f45e9，即 2ea8aefd 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017102033`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-2fcbe1e.log`，`check-app-css: 16 reachable stylesheets`）；新映像 worker 無 `createElement`／micromark。
10:24:25 UTC 切換，10:24:49 健康；`current` 指向新 release。
驗證：`/health` ok；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 813、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後畫面（白板卡片連結）需使用者確認。
清理：刪掉 `before-4e8346a` 與 release 4e8346a；保留 `before-2fcbe1e`、`before-2ea8aef`、`before-9316d48`，與 latest 都通過 `docker create`。磁碟 51%。

## 2026-10-17 深度檢查第 13 輪（#262、#264、#266）；沒有 migration

部署 **`edb9a3e3`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署。不含 #265（D53）、#267（D52），兩者等使用者合併。

**內容（使用者看得到的）：**
- **D51 #262**：Notion CSV 的 `October 16, 2026`、`10/16/2026` 存成真正的日期（排序、篩選、行事曆讀得到）；`1,200` 這種千分位是數字欄；`2026-02-30` 不再讓欄位變日期欄。
- **D48 #264**：Collections 可以存 Rating（星等）欄位；欄位型別打錯會被拒，不再默默變文字；BibTeX 帶 `doi:` 前綴不再產生重複論文筆記。
- **D50 #266**：子筆記有一個非數字值時彙總不再消失；`1e3`、`NaN` 不再算進彙總；表格頁尾只加總數字。

**驗證（部署前）**：main edb9a3e3：markdown 139/139；backend 2746 過、1 失敗（已知 `readGuard`）、5 skipped；前端 2426/2426；tsc、eslint 乾淨；worker bundle 16 個 input、無 micromark。

順序：打 tag `before-edb9a3e`（backend ba4ef962、frontend 16540558，即 2fcbe1e7 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017111820`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-edb9a3e.log`，`check-app-css: 16 reachable stylesheets`）；新映像 worker 無 `createElement`／micromark。
11:22:25 UTC 切換，11:22:49 健康；`current` 指向新 release；backend 啟動後兩分鐘內沒有 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 814、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-9316d48` 與 release 9316d48；保留 `before-edb9a3e`、`before-2fcbe1e`、`before-2ea8aef`，與 latest 都通過 `docker create`。磁碟 52%。

## 2026-10-17 舊 PR 整合（#255）、區塊節點（#260）、深度檢查第 12–14 輪；migration 107

部署 **`167ff336`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署；note-82 合併 #255、#260、#263、#269 後交由這次部署一起上線。

**內容（使用者看得到的）：**
- **#255**：網頁發布審查的 15 個修正（#171–#185 等，由 note-82 整合）。
- **#260**：區塊節點（`ONDEN_BLOCK_NODES` 預設關閉，正式站行為不變；bootstrap 多 `blocks: []`、`features.block_nodes: false`）。
- **D54 #270**：搜尋 `#標籤`、問 AI、從標籤做簡報都算子標籤與繼承的標籤。
- **#271**：系統筆記不進搜尋、AI 範圍與語意搜尋。
- **D56 #272**：上傳檔案由第一個引用它的筆記擁有（內文、屬性、頁面設計都算）；未認領的上傳只有上傳者可讀。**migration 107** 認領既有未認領檔案。
- **D46 #274**：時間顯示照工作區時區與語言；發布網站日期 SSR 與瀏覽器一致。
- **D47 #275**：AI 問答只走 `/api/ai/run`（`/ask` 移除、snake_case）。
- #263、#269：測試修正。

**驗證（部署前）**：c984cc68 完整測試：backend 2839 過、0 失敗（readGuard 已由 #255 修好）、5 skipped；前端 2456/2456。167ff336 的增量：前端 2466/2466、後端 harness/AI/site/publish/media 47 檔 317/317；tsc、eslint 乾淨；worker bundle 16 個 input、無 micromark。

順序：打 tag `before-167ff33`（backend bdb28ac8、frontend 711d4200，即 edb9a3e3 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017121229`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-167ff33.log`，`check-app-css: 16 reachable stylesheets`）；新 worker `localDbWorker-_Wj3jA7T.js` 無 `createElement`／micromark。
12:16:23 UTC 切換，12:16:47 健康；`[migrate] applied 107_media_owner_attributes`；`current` 指向新 release；兩分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；content_nodes 814、node_attributes 2326；media_uploads 未認領 1 → 0（共 3）。Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-2ea8aef` 與 release 2ea8aef；保留 `before-167ff33`、`before-edb9a3e`、`before-2fcbe1e`，與 latest 都通過 `docker create`。磁碟 52%。

## 2026-10-17 D45、D49、D50 標籤、D60 與 guard 修正（#278、#280、#282、#283）；沒有 migration

部署 **`2c4522ce`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署。

**內容（使用者看得到的）：**
- **D45 #278**：離線建立的筆記在首繪保留全文；被伺服器拒絕的內文不會因其他排隊寫入提到它而留在裝置上（本機 `pending_writes` 加 `targets` 欄）。
- **D49 #280**：`onden-base` 依屬性值型別比較與排序（數字、日期），`file.hasLink` 認別名與段落；修好範圍篩選值非數字非日期時整個查詢 500。D50：彙總的標籤條件含子標籤、不分大小寫。
- **D60 #283**：emoji 修改按「復原」不再 500。
- **#282**：D45／D49 造成的兩個前端 guard 測試回綠。

**驗證（部署前）**：1c93b453 完整測試：backend 2857 過、0 失敗；前端 2518 過、2 個 guard 失敗（由 #282 修好）。2c4522ce：前端 2520/2520；後端 restore／bodyPatch／guard／boundary 22 檔 292/292；tsc、eslint 乾淨；worker bundle 17 個 input、無 micromark。

順序：打 tag `before-2c4522c`（backend 55c462f9、frontend 0270a957，即 167ff336 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017125422`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-2c4522c.log`，`check-app-css: 16 reachable stylesheets`）；新 worker `localDbWorker-BGJyP6ZS.js` 無 `createElement`／micromark。
12:58:23 UTC 切換，12:58:47 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；content_nodes 814、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-2fcbe1e` 與 release 2fcbe1e；保留 `before-2c4522c`、`before-167ff33`、`before-edb9a3e`，與 latest 都通過 `docker create`。

## 2026-10-17 D61 反向連結、D63 標籤名稱（#286、#288）；沒有 migration

部署 **`d32655d7`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署。

**內容（使用者看得到的）：**
- **D61 #286**：筆記改名、加別名、搬空間、從垃圾桶救回時，指向它的反向連結重新連；兩邊用同一套比對。
- **D63 #288**：寫在筆記裡的標籤名稱只有一套解析（從根層、完全相同優先，其次唯一的不分大小寫）。已有 `Book` 時寫 `book` 會接到 `Book`。

**驗證（部署前）**：#286 分支後端全套 2868/0；#288 分支（含 #286，與 main d32655d7 同一棵樹）前端全套 2539/2539、後端全套 2877 過 0 失敗；tsc、eslint 乾淨；worker 不變（`localDbWorker-BGJyP6ZS.js`）。

順序：打 tag `before-d32655d`（backend fe38ccf7、frontend 857b32bd，即 2c4522ce 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017132600`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-d32655d.log`）；worker 無 `createElement`／micromark。
13:29:45 UTC 切換，13:30:09 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 814、node_attributes 2326、node_edges 195；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-edb9a3e` 與 release edb9a3e；保留 `before-d32655d`、`before-2c4522c`、`before-167ff33`，與 latest 都通過 `docker create`。磁碟 52%。

## 2026-10-17 D64 兄弟順序、D65 上傳上限（#290、#292）；nginx 重建；沒有 migration

部署 **`4d5bbdbb`**（main；重建 backend 與 frontend；**nginx 重建**以套用新設定）。由 note-59 部署。

**內容（使用者看得到的）：**
- **D64 #292**：側欄拖曳只改同層必要的筆記（以前一次拖曳 PATCH 幾乎每篇、每篇都「剛剛修改」）；只改順序不更新修改時間、不成為版本；側欄、白板、離線、發布網站同一套順序；拖「進」一篇筆記時排在它子筆記最後。
- **D65 #290**：上傳上限只有一處（`@onden/markdown` mediaTypes）；nginx 新增 `location = /api/media`（501m），其他 `/api/` 仍 20m；超過上限顯示「檔案超過 N MB 的上傳上限」。

**驗證（部署前）**：#292 分支（含 #290，與 main 同一棵樹）前端全套 2560/2560、後端全套 2882 過 0 失敗；tsc、eslint 乾淨；worker bundle 無 micromark。新 nginx.conf 在 compose 網路裡 `nginx -t` 通過。

順序：打 tag `before-4d5bbdb`（即 d32655d7 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017140856`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-4d5bbdb.log`）；新 worker `localDbWorker-DGyLR4U6.js` 無 `createElement`／micromark。
14:12:51 UTC 切換 backend、frontend，14:13:14 健康；`current` 指向新 release 後 `up -d --force-recreate nginx`，nginx 現在掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`（**不要刪這個 release**，除非先重建 nginx）。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；未登入 POST 25 MB 到 `/api/media` 得到後端的 401（以前 nginx 直接 413）；content_nodes 814、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-167ff33` 與 release 167ff33、2de5721（nginx 已不再掛載它）；保留 `before-4d5bbdb`、`before-d32655d`、`before-2c4522c`，與 latest 都通過 `docker create`。

## 2026-10-17 D68、D70、vitest worker 上限、垃圾桶文字（#296、#297、#299、#301 與 #298）；沒有 migration

部署 **`8d246d0c`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`）。由 note-59 部署。

**內容（使用者看得到的）：**
- **D68 #301**：「今天的筆記」只有一個入口、id 由個人空間＋日期固定產生（兩台裝置收斂成一篇）；每日範本只在今天的筆記空白時套骨架；`POST /api/nodes` 主鍵衝突回 409 `note_exists`。
- **D70 #299**：「建立你的第一個網站」在可發布的空間建立頁面並真的發布；不再發布使用者原有的同名筆記；歡迎卡片的「查看已發布的網站」終於會出現。
- **#296**：垃圾桶不再承諾 90 天後自動刪除（使用者決定：保留到清空）。
- **#297**：vitest 最多 2 個 worker（開發用）。
- 另含其他 session 的 #298（標籤視圖分頁）。

**驗證（部署前）**：main 8d246d0c 完整測試：markdown 160/160；前端 2581/2581；後端 2885 過、0 失敗、5 skipped；tsc、eslint 乾淨；worker bundle 17 個 input、無 micromark。

順序：打 tag `before-8d246d0`（即 4d5bbdbb 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017154931`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-8d246d0.log`）；worker `localDbWorker-DGyLR4U6.js` 無 `createElement`／micromark。
15:53:21 UTC 切換，15:53:45 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 814、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-2c4522c` 與 release 2c4522c；保留 `before-8d246d0`、`before-4d5bbdb`、`before-d32655d`，與 latest 都通過 `docker create`。磁碟 53%。

## 2026-10-18 D77 審核權限（#307）；沒有 migration

部署 **`cccb1ec5`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`）。由 note-59 部署。

**內容（使用者看得到的）：**
- **D77 #307**：誰能審核只有一條規則（擁有者，或 role ≥ reviewer 的人類）；擁有者的角色不能再被改（409），不會再把自己降級後看不到待核准項目；沒有審核權限的人看不到核准／拒絕按鈕；角色選單不再提供 admin（有擁有者時它等於 reviewer）；錯誤角色回 400。

**驗證（部署前）**：#307 分支（與 main cccb1ec5 同一棵樹）前端全套 2585/2585、後端全套 2894 過 0 失敗；tsc、eslint 乾淨；新 worker `localDbWorker-BhjEzDNv.js` 無 `createElement`／micromark。

順序：打 tag `before-cccb1ec`（即 8d246d0c 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017161902`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-cccb1ec.log`）。
16:23:05 UTC 切換，16:23:29 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；content_nodes 814、node_attributes 2326；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的審核畫面需使用者確認。
清理：刪掉 `before-d32655d` 與 release d32655d；保留 `before-cccb1ec`、`before-8d246d0`、`before-4d5bbdb`（nginx 掛載的 release 4d5bbdb 保留），與 latest 都通過 `docker create`。磁碟 53%。

## 2026-10-18 檢視模組 V1.5、V2（#309、#311）；migration 109

部署 **`bd31c851`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`）。V1 分頁（#298）與「引入與使用分開」（#300）已隨 cccb1ec5 上線。

**內容（使用者看得到的，docs/architecture/views-as-modules.md）：**
- **#309 標籤頁以筆記為主**：功能、欄位各一行（點功能在下方展開細節）；釘選＋「⋯」選單（匯出、合併、刪除）；標籤節點不再有 Table lens。
- **#311 檢視模組**：月曆、看板、卡片是預設引入的模組（設定 › 模組「檢視」一組，可取消引入）；「＋ 檢視」先列表格、列表與已引入的檢視模組，月曆問日期欄位、看板問分欄欄位、卡片問封面；取消引入時該檢視顯示說明並保留；伺服器拒絕未引入版面（409 `module_not_imported`）。**migration 109** 把 calendar／kanban／gallery 加進工作區模組清單。

**驗證（部署前）**：前端全套 2594/2594、lint 乾淨；後端整合測試全套（獨立 DB `onden_views_test`）1394 過，唯一失敗為寫死的模組清單，已在 #311 修正；e2e（全新 stack）檢視、月曆、看板、白板、標籤功能相關 spec 通過。

順序：打 tag `before-bd31c85`（即 cccb1ec5 的映像，backend a53b7e4d、frontend 2aa6be3e）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017170725`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-bd31c85.log`，`check-app-css: 15 reachable stylesheets`）；worker `localDbWorker-BhjEzDNv.js` 與上次相同，無 `createElement`／micromark。
17:20:12 UTC 切換，17:20:36 健康；`[migrate] applied 109_view_modules`；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；`/_astro/localDbWorker-BhjEzDNv.js` 200；content_nodes 814、node_attributes 2326（不變）；workspaces.modules 多了 calendar、kanban、gallery；正式站既有檢視只有 2 個 list，沒有受影響的月曆／看板／卡片檢視。Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的標籤頁需使用者確認。
清理：刪掉 `before-4d5bbdb` 映像（release 4d5bbdb 保留，nginx 仍掛載）；保留 `before-bd31c85`、`before-cccb1ec`、`before-8d246d0`，與 latest 都通過 `docker create`。磁碟 53%。

## 2026-10-18 內文三方合併改為逐行（#312）；沒有 migration

部署 **`d55ae763`**（main；bd31c851 加 #312 與部署紀錄 #313；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`）。由 note-82 部署。

**內容（使用者看得到的）：**
- **#312**：兩人同時改同一篇筆記時，改不同行照樣合併。改到同一處而且改法不同就是衝突：以前會悄悄丟掉其中一份（例如兩人把同一個詞改成不同的字），或把整份內文蓋掉；現在保留後存的那份、其他修改照樣合併。收件匣「內文編輯衝突」並排顯示已保留／未放入的文字，可「改用未放入的內容」或「兩者都保留」。

**驗證（部署前）**：main d55ae763 完整測試：後端 2920 過、0 失敗、5 skipped；前端 2600/2600；tsc、eslint 乾淨；worker bundle 17 個 input、只有 markdown/dist/slug.js、無 `createElement`。

順序：打 tag `before-d55ae76`（即 bd31c851 的映像，backend b1168957、frontend 0b714820）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017173938`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-d55ae76.log`）；worker `localDbWorker-BhjEzDNv.js` 與上次相同，無 `createElement`／micromark。
17:43:44 UTC 切換，17:44:08 健康；`current` 指向新 release；log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 814、node_attributes 2326（不變）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的收件匣衝突區需使用者確認（需要兩個裝置同時改同一處才會出現）。
清理：刪掉 `before-8d246d0` 與 release 8d246d0；保留 `before-d55ae76`、`before-bd31c85`、`before-cccb1ec`（release 4d5bbdb 保留，nginx 仍掛載），與 latest 都通過 `docker create`。磁碟 54%。

## 2026-10-17 D74 連線角色（#314）；沒有 migration

部署 **`1fa5f14d`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…/docker/nginx/nginx.conf`）。由 note-59 部署（note-82 部署 d55ae763 完成後）。

**內容（使用者看得到的）：**
- **D74 #314**：連線的來源（wikilink／手畫）與狀態送到 app，各視圖用同一套角色。wikilink、citation 產生的箭頭不能刪除或改類型（伺服器 409）；已有連結時再手畫不會疊兩條；Inspector 的外連／反向連結只算有效的 knowledge_link；公開網站只發布有效的邊（舊快照重新發布後才乾淨）。

**驗證（部署前）**：#314 分支（與 main 1fa5f14d 只差部署紀錄文件）前端全套 2618/2618、後端全套 2926 過 0 失敗；tsc、eslint 乾淨；新 worker `localDbWorker-CGs1VxV0.js` 無 `createElement`／micromark。

順序：打 tag `before-1fa5f14`（即 d55ae763 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017174555`，checksum 通過）；`docker builder prune -a -f`（5.2 GB）；build（`backups/build-1fa5f14.log`）。
17:49:54 UTC 切換，17:50:18 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；content_nodes 818、node_attributes 2332、node_edges 195（比 d55ae763 部署時多，使用者正在使用）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-cccb1ec` 與 release cccb1ec；保留 `before-1fa5f14`、`before-d55ae76`、`before-bd31c85`（與 nginx 掛載的 release 4d5bbdb），與 latest 都通過 `docker create`。磁碟 53%。

## 2026-10-18 月曆 V3（#318）；只重建 frontend；沒有 migration

部署 **`36b20b6b`**（main = 1fa5f14d ＋ #316 文件 ＋ #318；只重建 frontend，`up -d --no-build --no-deps frontend`；backend、postgres、nginx 沒動）。由 note-af 部署；事前沒有先通知負責部署的 note-9e，事後已告知（以後部署前先問）。打 tag 前確認 `current/REVISION` 為 1fa5f14d，沒有倒退任何人的變更。

**內容（使用者看得到的，docs/architecture/views-as-modules.md「V3」）：**
- 月曆「+N more」可在當天展開／收合；每個月曆檢視記住移到的月份（「今天」忘掉）；檢視「⋯ › 日期欄位…」可改舊月曆猜錯的欄位（卡片：「封面…」）；別人改資料時開著的檢視自動重查（GAP-158）；390px 長標題不再撐寬月曆（GAP-157）。

**驗證（部署前）**：前端全套 2604/2604、lint 乾淨；e2e（:5099）tagViewTabs 月曆 V3、calendar-nav、kanban-dnd、zzDeepCol06 通過。

順序：打 tag `before-36b20b6`（即 1fa5f14d 的映像，backend 56e2abf7、frontend 757eded5）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017175627`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；build frontend（`backups/build-36b20b6.log`，`check-app-css: 15 reachable stylesheets`）；新 worker `localDbWorker-CGs1VxV0.js` 無 `createElement`／micromark。
18:07:06 UTC 切換 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；新 worker 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：沒有刪任何映像（frontend `before-*`：36b20b6、1fa5f14、d55ae76、bd31c85，交給 note-9e 依慣例清理）。磁碟 53%。

註：等 build 時用 `pgrep -f "compose -p onden-vps"` 經 ssh 輪詢會比對到 ssh 自己的指令列而永遠顯示執行中；改看 build 紀錄的 `Built` 行。

## 2026-10-17 D78 分組規則（#320）；只重建 frontend；沒有 migration

部署 **`77876e8e`**（main；**只重建並切換 frontend**，backend 不變——1fa5f14d 之後 backend／markdown／docker 沒有變動；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af）。

**內容（使用者看得到的）：**
- **D78 #320**：看板、表格、清單用同一套分組：依欄位宣告的選項排序、其他值依出現順序、空值永遠最後並標「無值」；值剛好是 `(none)` 的列自成一組。
- 也包含 note-af 已部署的 #318（月曆 V3）。

**驗證（部署前）**：#320 分支（合併 main 後，與 main 77876e8e 同一棵樹）前端全套 2626/2626；tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`），無 `createElement`／micromark。

順序：打 tag `onden-vps-frontend:before-77876e8`（即 36b20b6 的 frontend 映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017183538`，checksum 通過；會重啟 backend，映像不變）；`docker builder prune -a -f`（2.6 GB）；`build frontend`（`backups/build-77876e8.log`）。
18:38:57 UTC `up -d --no-deps frontend`；`current` 指向新 release。
驗證：`/health` ok；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 818、node_attributes 2332；backend 兩分鐘內無 error；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
回滾：`onden-vps-frontend:before-77876e8`（backend 不需要）。這次沒有清理舊映像。

## 2026-10-18 開機確認不再等完整 bootstrap（#322）；沒有 migration

部署 **`ffa24516`**（main = 77876e8e ＋ #321 文件 ＋ #322；重建 backend 與 frontend；nginx 沒動）。由 note-af 部署；事前通知 note-9e（同意）與 note-82（同意），打 tag 前確認 `current/REVISION` 為 77876e8e。

**內容（使用者看得到的）：**
- **#322**：重新載入時「正在確認工作區資料…」不再等完整 `/api/bootstrap`（壓縮後 9.9 MB、約 7 秒）；同步與權限確認完就解除，完整資料在 idle 時背景更新。連不到伺服器仍當離線（快取可用）；伺服器回錯誤仍擋著。匯入 Excalidraw 的原檔（`_import_excalidraw`，原本佔 bootstrap 4.9 MB、送兩次）不再送給前端；單一筆記的屬性 API 仍有。

**驗證（部署前）**：前端全套 2625/2625、lint 乾淨；後端整合測試全套 1405 過、單元測試全過（獨立 DB `onden_views_test`）；新增 `bootWarmReload.test.tsx`、`serverOnlyAttributes.integration.test.ts`。

順序：打 tag `before-ffa2451`（即 77876e8e 的映像，backend 56e2abf7、frontend da9b195f）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017190226`，checksum 通過）；`docker builder prune -a -f`（2.6 GB）；build（`backups/build-ffa2451.log`，`check-app-css: 15 reachable stylesheets`）；worker `localDbWorker-CGs1VxV0.js` 不變，無 `createElement`／micromark。
19:06:30 UTC 切換，19:06:54 健康；`current` 指向新 release；切換後無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 818、node_attributes 2332（白天新增，非部署造成）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後重新載入的等待時間需使用者確認。
清理：沒有刪映像，交給 note-9e；磁碟 63%（多了 before-77876e8、before-ffa2451）。release 4d5bbdb（nginx 掛載）保留。

## 2026-10-17 D69 範本（#324）；沒有 migration

部署 **`45ac05b6`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/4d5bbdb…`）。由 note-59 部署（事前通知 note-82、note-af；基於 note-af 19:06 部署的 ffa24516）。

**內容（使用者看得到的）：**
- **D69 #324**：範本只有一套變數展開（`{date}`、`{datetime}`，套件子筆記標題也會展開）；套用的標籤自帶子筆記骨架時，範本不再重複寫內文（裝了 Meeting 套件時「會議筆記」只有一份 Agenda／Decisions／Action items）；Meeting 範本會填入套件必填的 `meeting_date`；斜線選單改名「範本內文：…」，只插入文字。

**驗證（部署前）**：#324 分支前端全套 2630/2630、後端全套 2930 過 0 失敗；合併 main（#322，無重疊檔案）後 tsc 乾淨、範本與 bootstrap 相關測試通過；worker 不變。

順序：打 tag `before-45ac05b`（即 ffa24516 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017193157`，checksum 通過）；build（`backups/build-45ac05b.log`）。
19:35:49 UTC 切換，19:36:13 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 820、node_attributes 2332；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-1fa5f14` 與 release 1fa5f14；保留 `before-45ac05b`、`before-ffa2451`、`before-36b20b6`（與 nginx 掛載的 release 4d5bbdb），都通過 `docker create`。磁碟 53%。

## 2026-10-18 Excalidraw 只在匯入時轉換（#327）；migration 110（刪除資料）

部署 **`cb4f498f`**（指定這個 commit，不是當下的 main：note-82 的 #328 隨後合併，由他接著部署；= 45ac05b6 ＋ #325 測試 ＋ #326 文件 ＋ #327；重建 backend 與 frontend；nginx 沒動）。由 note-af 部署；與 note-9e、note-82 協調順序，打 tag 前確認 `current/REVISION` 為 45ac05b6。

**刪除資料，使用者在 note-af 的對話中直接同意（「全部刪掉」）**：migration 110 刪除 36 份匯入時保留的 Excalidraw 原檔（`_import_excalidraw`）、80 個 `excalidraw-*` 外掛屬性與 frontmatter 中對應的行、頂層 `#excalidraw` 標籤與其 70 筆成員關係。部署前已在正式站以交易乾跑並 ROLLBACK，數字一致。

**內容（使用者看得到的）：** 以後匯入的 Excalidraw 畫只轉成手寫頁，不留原檔、不帶外掛的 frontmatter 與 `#excalidraw` 標籤；既有的同樣清掉。手寫筆跡（`ink_data`）與筆記不受影響。

**驗證（部署前）**：前端全套 2630/2630、lint 乾淨；後端整合測試全套 1402 過、單元測試全過；新增 `excalidrawImportOnly.integration.test.ts`。

順序：打 tag `before-cb4f498`（即 45ac05b6 的映像，backend e2b4b427、frontend ddd4f461）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（**`/srv/onden/backups/manual-20261017194806`**，checksum 通過；`pg_restore` 確認含 36 筆 `_import_excalidraw`；加了 `KEEP.txt`，**清理時不要刪**，是這些原檔唯一的副本）；`docker builder prune -a -f`（4.7 GB）；build（`backups/build-cb4f498.log`，`check-app-css: 15 reachable stylesheets`）；worker `localDbWorker-CGs1VxV0.js` 不變，無 `createElement`／micromark。
19:52:20 UTC 切換，19:52:46 健康；`[migrate] applied 110_excalidraw_import_only`；`current` 指向新 release；切換後無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。資料：`_import_excalidraw` 0、`excalidraw-*` 屬性 0、`#excalidraw` 標籤 0、`ink_data` 49（不變）、content_nodes 819（820 減掉標籤本身）；活著的筆記沒有殘留外掛 frontmatter 行。
清理：沒有刪映像（交給 note-9e）；磁碟 59%。

## 2026-10-18 匯入更新改走 updateNode（#328）；沒有 migration

部署 **`77c74228`**（main；cb4f498f 加 #328 與部署紀錄 #329；**只重建 backend**，frontend 與 nginx 沒有重建）。由 note-82 部署。

**內容（使用者看得到的）：**
- **#328**：重新匯入 Obsidian 檔案到已存在的筆記時，和一般編輯走同一條存檔路徑（`updateNode`）。檔案改了標題，筆記的 slug 會跟著變（以前留在舊標題）；以後編輯加的規則也自動套到匯入。白板改名不變（白板 slug 固定是 `canvas-<id>`）。

**驗證（部署前）**：#328 分支後端全套 2936 過、0 失敗；合併 #327 後 tsc、eslint 乾淨，匯入、守門、核心一致性相關 23 檔 419 項通過。前端沒有變動。

順序：打 tag `onden-vps-backend:before-77c7422`（即 cb4f498f 的 backend 映像 357ccc9e）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017195433`，checksum 通過）；`docker builder prune -a -f`（4.7 GB）；只 build backend（`backups/build-77c7422.log`）。
19:56:26 UTC 切換 backend，19:56:39 健康；`current` 指向新 release；log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker `localDbWorker-CGs1VxV0.js` 200；content_nodes 819、node_attributes 2216（migration 110 之後的數字，本次沒有 migration）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
沒有做清理（目前由 note-9e 負責）；`manual-20261017194806`（Excalidraw 原始檔的唯一備份，KEEP）沒有動。磁碟 59%。

## 2026-10-17 D79 復原改用三方合併（#331）；只重建 backend；沒有 migration

部署 **`89b4fc13`**（main；**只重建並切換 backend**——77c74228 之後 frontend／docker／migrations 沒有變動；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af）。

**內容（使用者看得到的）：**
- **D79 #331**：事件歷史的「復原」不再用模糊 patch：先精確還原事件前的正文，再和目前正文做三方合併。別人之後改過同一段時回 409（可選擇 force，只覆蓋衝突的那幾行），不再默默蓋掉別人的修改；預覽顯示的就是實際會寫入的內容。

**驗證（部署前）**：#331 分支後端全套 2942 過 0 失敗；合併 main（#328）後 restore／bodyPatch／import 32 檔 246/246、tsc、eslint 乾淨。

順序：打 tag `onden-vps-backend:before-89b4fc1`（即 77c74228 的 backend）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017200630`，checksum 通過）；`build backend`（`backups/build-89b4fc1.log`）。
20:08:11 UTC `up -d --no-deps backend`，20:08:24 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 819、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
回滾：`onden-vps-backend:before-89b4fc1`。KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 設定頁分組、搜尋、進階設定（#334）；沒有 migration

部署 **`7eb9286a`**（main；89b4fc13 加 #334，另含 e2e 與部署紀錄 #332、#333；**只重建 frontend**，backend 與 nginx 沒有重建）。由 note-82 部署。

**內容（使用者看得到的）：**
- **#334 設定頁**：
  - 左欄分「本裝置」（一般、外觀、伺服器）與「工作區」（空間、模組、AI、你的資料）兩組，每個分頁說明套用範圍。
  - 新增「搜尋設定」，跨分頁比對名稱、說明、選項與關鍵字。
  - `.sqlite3` 備份、標籤包、連線時的後端網址收進「顯示進階設定」。
  - 原本沒顯示的小工具標題（例如「Anthropic API 金鑰」「AI 模型」）現在會顯示。
  - 「你的資料存放在哪」連線時也顯示：筆記在伺服器上，這台裝置有一份副本。

**驗證（部署前）**：前端全套 2638 過（唯一失敗的模組邊界測試已修正，修正後相關 9/9）；lint、build（check-app-css 16）乾淨；用建置 CSS 單獨渲染設定視窗做 Chromium 截圖檢查（桌面、390px、中英、深淺色）。

順序：打 tag `onden-vps-frontend:before-7eb9286`（即 89b4fc13 的 frontend 映像 8c371c67）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017202533`，checksum 通過）；`docker builder prune -a -f`（2.3 GB）；只 build frontend（`backups/build-7eb9286.log`，check-app-css 16）；worker `localDbWorker-CGs1VxV0.js` 不變。
20:28:40 UTC 切換 frontend；`current` 指向新 release；frontend log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；正式站的 `SettingsModal.heRSV343.js` 含新的「Search settings」「Show advanced settings」；content_nodes 822、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的設定頁需使用者確認。
沒有做清理（目前由 note-9e 負責）。磁碟 52%。

## 2026-10-17 D83 讀屬性可只讀指定 key（#335）；沒有 migration

部署 **`7cd3446e`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af；基於 note-82 20:28 部署的 7eb9286a）。

**內容：**
- **D83 #335**：`GET /api/nodes/:id/attributes?keys=a,b` 只回指定的屬性；打開手寫筆記（ink）與技能對話框只讀需要的 key。（只給伺服器的屬性在 migration 110 後已不存在。）

**驗證（部署前）**：#335 分支前端全套 2635/2635、後端相關 31 檔 336/336；tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`）。

順序：打 tag `before-7cd3446`（即 7eb9286a 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017203027`，checksum 通過）；build（`backups/build-7cd3446.log`）。
20:34:05 UTC 切換，20:34:29 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 822、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-45ac05b`、`before-cb4f498` 與這兩個 release；保留 `before-7cd3446`、`before-7eb9286`（frontend）、`before-89b4fc1`、`before-77c7422`（backend），nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 拿掉列表、表格成為檢視模組（#338）；migration 111

部署 **`7ecb2229`**（main = 7cd3446e ＋ #337 文件 ＋ #338；重建 backend 與 frontend；nginx 沒動）。由 note-af 部署；事前 note-9e、note-82 同意，打 tag 前確認 `current/REVISION` 為 7cd3446e。migration 111 由本次使用（note-50 的日記模組改用 112）。

**內容（使用者看得到的）：** 檢視不再有「列表」；表格跟月曆、看板、卡片一樣是檢視模組（預設引入，可在 設定 › 模組 取消）。「＋ 檢視」只列已引入的檢視模組。**migration 111** 把已存的列表檢視原地轉成表格（正式站 2 個，順序、篩選、分組保留），並把 `table` 加進工作區的模組清單。

**驗證（部署前）**：前端全套 2633/2633、lint 乾淨；後端整合測試 1406 過（唯一失敗為本機測試 DB 殘留改名前的 111，全新 DB 重跑通過）、單元測試全過。

順序：打 tag `before-7ecb222`（即 7cd3446e 的映像，backend a53e12dc、frontend f9d1ee96）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017204044`，checksum 通過）；`docker builder prune -a -f`（0 B，note-9e 剛清過）；build（`backups/build-7ecb222.log`，`check-app-css: 16 reachable stylesheets`）；worker `localDbWorker-CGs1VxV0.js` 不變，無 `createElement`／micromark。
20:44:45 UTC 切換，20:45:08 健康；`[migrate] applied 111_table_view_module`；`current` 指向新 release；切換後無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。資料：已存檢視全部為 table（2 個），modules 含 `table`；content_nodes 822。
清理：沒有刪映像（交給 note-9e）；KEEP 備份 `manual-20261017194806` 保留；磁碟 59%。

## 2026-10-18 設定頁：模組頁、鍵盤快捷鍵、危險操作（#343）與月曆日期（#339）；沒有 migration

部署 **`425ff135`**（main；7ecb2229 加 #343、#339 與部署紀錄 #340；**只重建 frontend**，backend 與 nginx 沒有重建）。由 note-82 部署；#339（D81）由 note-59 同意一起上線。

**內容（使用者看得到的）：**
- **#343 設定頁**：
  - 已引入、而且有自己設定的模組，在「模組」底下各有一頁（目前是 RSS 閱讀，以及有模組標籤時的 #複習）。
  - 「鍵盤快捷鍵」可以修改：錄下新的按鍵組合；撞到其他快捷鍵時拒絕並說出是哪一個；可以恢復預設。改動只存在這台裝置。
  - 「危險操作」集中列出會刪除或取代資料的動作，並可「前往」執行的地方。沒有新增刪除功能。
- **#339（D81）**：月曆用同一套日期規則（`calendarDayOf`）。只新增在 `@onden/markdown`，後端沒有用到，所以只重建 frontend。

**驗證（部署前）**：前端全套 2644/2644；合併 main 後設定、模組庫、快捷鍵、月曆相關測試 101/101；lint、build（check-app-css 16）乾淨；單獨渲染設定視窗做 Chromium 截圖檢查。

順序：打 tag `onden-vps-frontend:before-425ff13`（即 7ecb2229 的 frontend 映像 0c1e5c9e）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017210515`，checksum 通過）；`docker builder prune -a -f`（4.75 GB）；只 build frontend（`backups/build-425ff13.log`，check-app-css 16）；worker `localDbWorker-CGs1VxV0.js` 不變。
21:08:25 UTC 切換 frontend；`current` 指向新 release；frontend log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；正式站的 `SettingsModal.DD1xnPQr.js` 有模組頁，`AppRoot` chunk 有「Danger zone」「Reset all shortcuts」；content_nodes 822、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的設定頁需使用者確認。
沒有做清理（目前由 note-9e 負責）。磁碟 59%。

## 2026-10-17 D80 發布預覽與 hash 同一份讀者內容（#345）；沒有 migration

部署 **`aa94806b`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af；基於 note-82 21:08 部署的 425ff135）。

**內容（使用者看得到的）：**
- **D80 #345**：發布預覽的變更與發布 hash 用同一份「讀者看得到的內容」：調整頁面順序、在已發布筆記間加連結，預覽會列出「順序改變」「連結有變動」；只有時間戳變動不算變更，也不會讓預覽過期。部署後第一次預覽可能一次性列出舊快照沒記錄的差異；部署當下開著的預覽會 409 一次。

**驗證（部署前）**：#345 分支（合併 main）後端 publish／site／guard 40 檔 347/347、前端全套 2644/2644；分支先前後端全套 2892 過 0 失敗；tsc、eslint 乾淨；worker 不變。

順序：打 tag `before-aa94806`（即 425ff135 frontend＋7ecb2229 backend）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017211500`，checksum 通過）；build（`backups/build-aa94806.log`）。
21:18:40 UTC 切換，21:19:04 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 822、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-7cd3446`、`before-7eb9286`、`before-89b4fc1`、`before-77c7422` 與對應 release；保留 `before-aa94806`、`before-425ff13`（frontend）、`before-7ecb222`，nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。磁碟 66%→47%。

## 2026-10-18 模組只在「設定 › 模組」引入（#347）；沒有 migration

部署 **`83682407`**（main；aa94806b 加 #347 與部署紀錄 #346；**只重建 frontend**，backend 與 nginx 沒有重建）。由 note-82 部署。

**內容（使用者看得到的）：** 使用者決定「其他引入都刪掉」，現在模組只能在 設定 › 模組 引入。
- 移除：
  - 桌面頂列「＋ 功能」、手機「更多 › 引入功能」。
  - 第一次使用的功能挑選視窗。
  - ⌘K 的「引入…並開啟」。
- 改為提示並打開 設定 › 模組（不再自動引入）：
  - 未引入模組頁。
  - 設定複習。
  - 歡迎卡建立網站。
  - 安裝標籤包。
  - 標籤頁「加入功能」與休眠功能。

**驗證（部署前）**：前端全套 2646 過（`TagModuleCenter` 兩項舊行為測試已改寫，該檔 15/15）；lint、build（check-app-css 16）乾淨。

順序：打 tag `onden-vps-frontend:before-8368240`（即 aa94806b 的 frontend 映像 eb788342）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017214723`，checksum 通過）；`docker builder prune -a -f`；只 build frontend（`backups/build-8368240.log`，check-app-css 16）；worker `localDbWorker-CGs1VxV0.js` 不變。
21:50:26 UTC 切換 frontend；`current` 指向新 release；frontend log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；建置產物中已沒有 ModuleImportMenu／FeaturePicker 的 chunk，`AddFunctionMenu` chunk 有「Open the module library」；content_nodes 823、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。登入後的畫面需使用者確認。
沒有做清理（目前由 note-9e 負責）。磁碟 47%。

## 2026-10-17 D86 Notion 檢視模組檢查、D87 agent 寫入要帶 base（#349、#350）；沒有 migration

部署 **`4d726ac7`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af；基於 note-82 21:50 部署的 83682407）。

**內容（使用者看得到的）：**
- **D86 #349**：Notion 匯入的預設檢視也檢查檢視模組；缺模組的版面直接略過。版面按鈕順序改為模組登記順序（表格、月曆、看板、卡片）。
- **D87 #350**：agent／MCP 的 `updateNode` 改內文要帶 `base_markdown`，三方合併；不再蓋掉使用者在 agent 讀取後的修改；沒帶 base 回 400（**外部 MCP 客戶端的 API 變更**）。

**驗證（部署前）**：#349 分支前端全套 2649/2649、後端相關 40 檔 570/570；#350 分支前端全套 2649/2649、後端相關 36 檔 603/603；合併 main 後 tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`）。

順序：打 tag `before-4d726ac`（即 83682407 frontend＋aa94806b backend）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017215728`，checksum 通過）；build（`backups/build-4d726ac.log`）。
22:01:17 UTC 切換，22:01:41 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 823、node_attributes 2216；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-7ecb222`、`before-425ff13` 與 release 7ecb222、425ff13；保留 `before-4d726ac`、`before-8368240`（frontend）、`before-aa94806`，nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。磁碟 47%。

## 2026-10-18 欄位繼承 2b、禁止同名欄位（#353）；沒有 migration

部署 **`54628581`**（main；4d726ac7 加 #353 與部署紀錄 #352；重建 backend 與 frontend；nginx 沒有重建）。由 note-af 部署（事前通知 note-9e、note-82，兩者同意；基於 note-59 22:01 部署的 4d726ac7）。

**內容（使用者看得到的）：**
- **欄位繼承**：標籤給筆記的欄位＝自己的＋上層標籤＋功能的模組標籤（＋舊的標籤↔標籤 extends），任意深度，同名以最近的為準。值驗證、套用預設值、彙總、檢視欄位型別都算進繼承的欄位；標籤頁欄位列以虛線列出「來自上層 #x」「來自功能 #x」。
- **禁止同名欄位**（使用者 2026-10-18「要」）：新增／改名成上層已有的欄位、加功能、移到別的上層下、合併標籤時，若產生新的同名衝突，回 409 `field_name_inherited` 並列出欄位；欄位編輯器即時標示「#書 已有「頁數」欄位」且不儲存。已存在的衝突照常運作。

**驗證（部署前）**：rebase 到 main 後全套：前端 2657/2657、後端 unit 1570、integration 1437（5 skipped）；後端與前端 eslint 乾淨。

順序：打 tag `before-5462858`（即 4d726ac7 的 backend＋frontend 映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261017223158`，checksum 通過）；`docker builder prune -a -f`；build backend＋frontend（`backups/build-5462858.log`）。
22:35:59 UTC 切換，22:36:01 健康；`current` 指向新 release；兩分鐘內 backend log 無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker `localDbWorker-CGs1VxV0.js` 不變、200，`new Worker(...)` 無錯誤；content_nodes 824、node_attributes 2219；Chromium 開首頁無錯誤。登入後的畫面需使用者確認。
沒有做清理（由 note-9e 負責）。

## 2026-10-17 D88 手寫三方合併（#356）；沒有 migration

部署 **`67528123`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af；基於 note-af 22:35 部署的 54628581）。

**內容（使用者看得到的）：**
- **D88 #356**：手寫（ink_data，含 PDF 註記）存檔帶上一次的值當 base，伺服器在其他裝置同時存過時三方合併（筆畫／圖形／註記依 id、擦除以點集），只有真正衝突才記 ATTRIBUTE_CONFLICT。兩台裝置各畫的筆畫不再互相蓋掉。新入口 `@onden/markdown/ink`（不在 localDbWorker 的引用鏈，worker 打包仍只有 `markdown/dist/slug.js`）。

**驗證（部署前）**：#356 分支前端全套 2653/2653、後端全套 2980 過 0 失敗；esbuild metafile：worker 17 個 input、無 micromark；合併 main（#353）後 tsc 乾淨、ink／attribute 測試 73/73。

順序：打 tag `before-6752812`（即 54628581 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017224710`，checksum 通過）；build（`backups/build-6752812.log`，`check-app-css: 16 reachable stylesheets`）；新映像 worker `localDbWorker-CGs1VxV0.js` 無 `createElement`／micromark。
22:51:02 UTC 切換，22:51:26 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 824、node_attributes 2219；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-aa94806`、`before-8368240` 與對應 release；保留 `before-6752812`、`before-5462858`、`before-4d726ac`，nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-17 D85 快捷鍵一份清單（#358）；只重建 frontend；沒有 migration

部署 **`6c11c65c`**（main；**只重建並切換 frontend**，67528123 之後 backend／markdown／docker 沒有變動；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af）。

**內容（使用者看得到的）：**
- **D85 #358**：快捷鍵只有一份清單與一套寫法：頂欄／側欄／指令面板的提示跟著改綁與平台（Linux／Windows 顯示 Ctrl+…）；指令面板與白板卡片存檔照改綁的鍵；`?` 能開快捷鍵一覽；編輯器、白板已用的鍵與單鍵不能綁；兩個分頁不再互相蓋掉改綁。

**驗證（部署前）**：#358 分支合併 main 後前端全套 2681/2681、tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`），無 `createElement`／micromark。

順序：打 tag `onden-vps-frontend:before-6c11c65`（即 67528123 的 frontend）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261017231943`，checksum 通過）；`build frontend`（`backups/build-6c11c65.log`）。
23:22:53 UTC `up -d --no-deps frontend`；`current` 指向新 release。
驗證：`/health` ok；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
回滾：`onden-vps-frontend:before-6c11c65`。這次沒有清理。

---

部署 **`bdad6602`**（main = 6c11c65c ＋ #359 文件 ＋ #342；**只重建並切換 frontend**，6c11c65c 之後 backend／markdown／docker／migration 沒有變動；nginx 沒有重建）。由 note-50 部署（事前通知 note-82、note-9e、note-af，皆同意）。打 tag 前確認 `current/REVISION` 為 6c11c65c。

**內容（使用者看得到的）：**
- **#342**：右側欄改成「標籤」：每個標籤一張卡（欄位、功能、上層），多個標籤共用的欄位只出現一次並註明「也使用這個欄位」，最後是「其他屬性」；反向連結、未連結的提及、出現在哪些白板、上層與子筆記（搜尋式選擇）移到筆記內文下方；標題下方「X 分鐘前修改 · 版本歷史」；手機在標題下方有可收合的「標籤」區塊。

**驗證（部署前）**：#342 rebase 到 main（含 #353）後，相關測試 43/43；前端全套在記憶體壓力下分兩次跑完，每個檔案都通過；tsc、eslint 乾淨。

順序：打 tag `onden-vps-frontend:before-bdad660`（即 6c11c65c 的 frontend 映像 01653954）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261018003844`，checksum 通過）；`docker builder prune -a -f`（2.6 GB）；只 build frontend（`backups/build-bdad660.log`，`check-app-css: 16 reachable stylesheets`）；worker `localDbWorker-CGs1VxV0.js` 不變，無 `createElement`／micromark。
00:42:34 UTC `up -d --no-build --no-deps frontend`；`current` 指向新 release。
驗證：`/health` ok；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 開首頁無錯誤，`new Worker("/_astro/localDbWorker-CGs1VxV0.js")` 正常；`content_nodes` 373 筆未刪除／824 筆總數。另外確認：不存在的 `/assets/*.js` 回 404（text/html），與「部署後舊 chunk 失效」的調查有關。
回滾：`onden-vps-frontend:before-bdad660`。磁碟 53%。這次沒有清理。

## 2026-10-18 D90 屬性衝突還原、D89 繼承欄位、D93 同名規則（#365、#370）；沒有 migration

部署 **`b4e6924d`**（main；重建 backend 與 frontend；nginx 沒有重建——#366 的 nginx 修正還沒合併）。由 note-59 部署（事前通知 note-82、note-af、note-50；基於 note-50 部署的 bdad6602）。

**內容（使用者看得到的）：**
- **D90 #365**：手寫衝突紀錄改存 blob ref、收件匣顯示摘要；「還原」由伺服器處理：手寫只換回衝突的那幾筆，其他屬性用原本的型別寫回、之後又改過則 409。還原需要連線。
- **D89 #370**：網站 › 集合、集合 API、公開網站都讀繼承的欄位。
- **D93 #370**：同名欄位只有一條規則（只比 name、只擋新增的衝突），SchemaLens 只擋衝突的那個欄位。

**驗證（部署前）**：#365 分支後端全套 3004/0；#370 分支（含 #365，與 main 同一棵樹）前端全套 2714/2714、後端全套 3015 過 0 失敗；tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`），無 `createElement`／micromark。

順序：打 tag `before-b4e6924`（即 bdad6602 frontend＋67528123 backend）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018013315`，checksum 通過）；build（`backups/build-b4e6924.log`）。
01:36:51 UTC 切換，01:37:15 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 824、node_attributes 2219；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-4d726ac`、`before-5462858` 與對應 release；保留 `before-b4e6924`、`before-bdad660`、`before-6c11c65`（frontend）、`before-6752812`，nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 D91 匯出／匯入往返（#375）；migration 116

部署 **`5388386a`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af、note-50）。

**內容（使用者看得到的）：**
- **D91 #375**：匯出 zip 再匯入不再丟失 PDF 連結、PDF 筆記的檔案、媒體欄位、音訊與關聯欄位（關聯寫成 `[[標題]]` 並在匯入時連回）。手繪／PDF 標註仍不往返。資料夾匯入時 .txt、.docx 會當媒體上傳。
- **migration 116**：`imported_media` 的副檔名檢查改成整張媒體表、檔名允許數字。只改 CHECK 約束，不改資料。**比預留的 112（日記）、113（V4）、114（RSS）先上線**：db.ts 逐一套用尚未套用的版本，所以它們之後仍會執行。

**驗證（部署前）**：#375 分支前端全套 2717/2717、後端全套 3023 過 0 失敗、markdown 197/197；tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`），無 `createElement`／micromark。

順序：打 tag `before-5388386`（即 b4e6924d 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018022011`，checksum 通過）；build（`backups/build-5388386.log`）。
02:23:42 UTC 切換，02:24:06 健康；`[migrate] applied 116_imported_media_all_types`；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 824、node_attributes 2219、imported_media 72；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-6752812`、`before-6c11c65` 與對應 release；保留 `before-5388386`、`before-b4e6924`、`before-bdad660`（frontend），nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。磁碟 48%。

## 2026-10-18 D94 重算屬性型別、D95 清空垃圾桶範圍（#378、#379）；沒有 migration

部署 **`346b43c7`**（main；重建 backend 與 frontend；nginx 沒有重建）。由 note-59 部署（事前通知 note-82、note-af、note-50）。

**內容（使用者看得到的）：**
- **D94 #378**：改欄位型別、套用／移除標籤、搬標籤父層、合併標籤時，已存屬性的 value_type 依目前的有效欄位重算（不寫事件），存好的檢視篩選、排序與彙總才會對。
- **D95 #379**：「清空垃圾桶」只永久刪除畫面上列出、而且呼叫者是該空間管理者的筆記（使用者決定：空間管理者＋自己的個人空間；編輯者能丟垃圾但不能永久刪除）；新路由 `POST /api/nodes/trash/empty`；移除 `/api/maintenance`（以前會清掉整個工作區、包括看不到的別人的垃圾）。

**驗證（部署前）**：#378 分支後端全套 3031/0；#379 分支後端 trash／prune／guard 28 檔 724/724、前端全套 2720/2720；合併後 trash／retype／guard 18 檔 247/247；tsc、eslint 乾淨；worker 不變（`localDbWorker-CGs1VxV0.js`）。

順序：打 tag `before-346b43c`（即 5388386a 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018032153`，checksum 通過）；build（`backups/build-346b43c.log`）。
03:25:26 UTC 切換，03:25:49 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 824、node_attributes 2219；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-bdad660` 與 release bdad660；保留 `before-346b43c`、`before-5388386`、`before-b4e6924`，nginx 掛載的 release 4d5bbdb 與 KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 標籤模型、RSS 改版、收件匣只放審核、語意搜尋改模組等 11 個 PR；migration 114、115

部署 **`60336fd1`**（main；重建 backend、frontend，並重建 nginx 換新 nginx.conf）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者要求「派 session 審核然後部署」：四個審核 session 看完後合併。

**內容（使用者看得到的）：**
- **#360** 標籤模型：上層＝繼承、功能分開；筆記只填值、結構在標籤頁；標籤樹與筆記樹分開（T12）。
- **#362** 手機設定改成全螢幕兩層清單。**#364** 手機選取文字只剩一排格式列。
- **#363** 正式環境可移除內建 System 帳號；System 不能持有 token。
- **#367** 收件匣只放審核；失敗工作移到設定 › 系統狀態；隱藏筆記另成群組。
- **#368** 語意搜尋改成可開關模組，預設不引入；migration 115 清掉 embed 的 dead/pending 工作。
- **#369** 長按選單「移到…」搜尋選擇框＋「在這裡新增筆記」；只列同空間、只在可編輯時出現。
- **#371** RSS：拿掉 #subscription（migration 114 改成內部記號 `_rss_kind=source`）、取消訂閱、存的時候選位置、閱讀器只剩「存成筆記」。
- **#373** micromark 長段落解析改線性（patch-package；Docker 兩邊都確認有套用）。
- **#377** 一個入口 bootApp；原生 App 走登入；換伺服器不重送別台的佇列（D92）。
- **#381**（取代 #366）部署後舊 chunk 不見時自動重新載入一次（離線不重載）；nginx `/_astro/` 拿掉 `always`，404 不再被快取一年；`ONDEN_BUILD_ID` build arg。

**驗證（部署前）**：四個審核 session 各自跑相關測試（全過）；114/115 在已套 116 的資料庫上跑兩次，第二次無動作；`nginx -t`（onden-vps_default 網路、新 conf）通過。

順序：打 tag `before-60336fd`（即 346b43c7 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018035634`，checksum 通過）；`docker builder prune -a -f`；build（`ONDEN_BUILD_ID=60336fd1…`，`backups/build-60336fd.log`）。
04:00:30 UTC 切 backend，`[migrate] applied 114_rss_source_marker`、`applied 115_semantic_embed_cleanup`，`/health` ok；切 frontend；`current` 指向新 release；`--force-recreate nginx`，掛載改為 `releases/60336fd1…/docker/nginx/nginx.conf`。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；不存在的 `/_astro/` chunk 回 404 且沒有 immutable；worker `localDbWorker-CDECBli9.js` 無 micromark／createElement，Chromium `new Worker(...)` 正常、首頁無錯誤；content_nodes 824、node_attributes 2221、outbox embed 0；backend 五分鐘內無 error。

待辦：真實 chunk 回應有兩個 Cache-Control（frontend 的 `max-age=0` 與 nginx 的 immutable），要確認是否早就如此。release 4d5bbdb 已不再被 nginx 掛載，刪不刪由使用者決定；KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 R23 smalls（#382）；沒有 migration

部署 **`3453c75b`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/60336fd1…/docker/nginx/nginx.conf`）。由 note-59 部署（事前通知 note-82、note-af、note-50；基於 note-50 部署的 60336fd1）。

**內容（使用者看得到的）：**
- **#382**：事件歷史裡 33 種事件有中文名稱與正確種類（測試保證之後新增的事件類型都要有）；隱藏的筆記在分享選單說明不會發布、不給連結；slim bootstrap 不再為每篇筆記算沒人讀的摘要；workspace 列在 bootstrap 與 delta 用同一份欄位。

**驗證（部署前）**：#382 分支前端全套 2767/2767、後端 sync／bootstrap／publish／guard 62 檔 921 過；合併 main 後 tsc、eslint 乾淨。新 worker `localDbWorker-CDECBli9.js`（60336fd1 帶來的）無 `createElement`／micromark。

順序：打 tag `before-3453c75`（即 60336fd1 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018040442`，checksum 通過）；build（`backups/build-3453c75.log`）。
04:08:34 UTC 切換，04:08:57 健康；`current` 指向新 release；一分鐘內無 error。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；worker 200；content_nodes 826、node_attributes 2221；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
**觀察到（不是這次造成）**：`/_astro/` 的 chunk 回兩個 Cache-Control（frontend 的 `public, max-age=0` 與 nginx 的 `immutable`）；應由 nginx 對 `/_astro/` 隱藏上游的 Cache-Control。
清理：刪掉 `before-5388386`、`before-b4e6924` 與 release 5388386、b4e6924，以及 nginx 已不再掛載的 release 4d5bbdb（git 可重建）；保留 `before-3453c75`、`before-60336fd`、`before-346b43c` 與 nginx 掛載的 release 60336fd1、KEEP 備份 `manual-20261017194806`。磁碟 68%→52%。

## 2026-10-18 D103 格式列切換、主題色即時更新、System 使用者一處定義（#386、#388、#390）；沒有 migration

部署 **`908ec001`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/60336fd1…/docker/nginx/nginx.conf`，#385 未合併）。由 note-9e 部署（事前通知 note-82、note-af、note-50，三位都回覆可以）。

**內容（使用者看得到的）：**
- **#386**：`EFFECTS_DISMISSED` 有中文事件名稱（修好 main 上的 eventKinds 測試）。
- **#388（D103）**：手機格式列顯示為「已套用」的引用、標題，再按一次就取消（以前會變成 `> > said`，或沒反應）；項目、數字（任何編號）、勾選清單（含已勾選）也一樣切換。
- **#390**：切換主題或系統深淺色翻轉時，瀏覽器／狀態列顏色立即跟著變（以前要重新整理；原生 app 入口也會補上 `theme-color`）；後端 System 使用者的 `external_id` 只在 `services/systemActor.ts` 定義一次。

**驗證（部署前）**：#388 前端全套 381 檔 2855 過；#390 前端全套 382 檔 2856 過、後端全套 3122 過／5 略過（新建的 `onden_r24s_test`），tsc、eslint 乾淨。新 worker 仍是 `localDbWorker-CDECBli9.js`，無 `createElement`／micromark。

順序：打 tag `before-908ec00`（即 3453c75b 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018060452`，checksum 通過）；build。
06:09 UTC 切換，健康檢查 `{"ok":true}`；`current` 指向新 release；backend 啟動後無 error。
驗證：首頁 200，未登入 `/api/health` 401（經 nginx）；content_nodes 826、node_attributes 2221（與上次相同）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。`/_astro/` 仍回兩個 Cache-Control（等 #385）。
清理：刪掉 `before-346b43c` 與 release 346b43c（nginx 未掛載）；`docker builder prune` 釋出 4.8 GB。保留 `before-908ec00`、`before-3453c75`、`before-60336fd`、nginx 掛載的 release 60336fd1、KEEP 備份 `manual-20261017194806`。磁碟 52%。

## 2026-10-18 V4 檢視模組、閱讀只留 RSS、首屏瘦身、死碼清理等；migration 113；nginx 重建

部署 **`87d1af6d`**（main；重建 backend、frontend，並重建 nginx）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「都合」。

**內容：**
- **#374**（note-af）V4：檢視模組標籤、繼承的檢視、總覽頁；migration 113 建立檢視模組標籤，並替正式站唯一的表格檢視（#gt）加上 extends。
- **#385** nginx `/_astro/` 只留一個 Cache-Control（`proxy_hide_header`）。
- **#387** 閱讀只留 RSS（拿掉稍後讀、PDF 與文獻、劃線分頁；資料不動）。**#394** 清掉死碼（CSS −2,286 行、翻譯 150 個、4 個死檔）。
- **#389** RSS 閱讀器「存成筆記」移到標題旁與文末，拿掉底部大按鈕。
- **#391** build 後檢查背景 worker（禁用套件＋體積上限 91 KiB）。
- **#392** 首屏瘦身：katex、程式碼上色用到才載入；延遲畫面的 CSS 不預載（`patches/astro+6.4.6.patch`）；拿掉 Starlight。首屏 JS gzip 596→468 KB、CSS 148→61 KB。
- **#393** 重複規則造成的 bug：HTML 解碼、別名連結被遮、刪欄位確認；`isFunctionTag()`。
- **#398** 後端映像只複製 micromark 的 patch。

**第一次 build 失敗（67967bc0）**：後端映像複製了整個 `patches/`，但後端不裝 astro，`patch-package --error-on-fail` 遇到不存在的套件就失敗。正式站沒有切換。#398 修好後改部署 87d1af6d。

順序：打 tag `before-67967bc`（即 908ec001 的映像，frontend/backend/nginx）；`backup-vps.sh`（`/srv/onden/backups/manual-20261018082845`，checksum 通過）；`nginx -t`（onden-vps_default、新 conf）通過；build（`ONDEN_BUILD_ID=87d1af6d…`，`backups/build-87d1af6.log`；`astro@6.4.6 ✔`、`micromark@4.0.2 ✔`；worker 檢查 72.8 KiB / 91.0 KiB，無禁用套件）。
08:34:49 UTC 切 backend，`[migrate] applied 113_view_module_tags`，`/health` ok；檢查資料：一個「表格」（module=table）標籤，#gt 的 extends 指向它。切 frontend；`current` 指向新 release；`--force-recreate nginx`，掛載改為 `releases/87d1af6d…/docker/nginx/nginx.conf`。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401，未知網址 404；不存在的 chunk 404 且沒有 Cache-Control；真的 chunk 只有一個 `public, max-age=31536000, immutable`；首頁不再預載 PdfNodeView.css；Chromium 首頁無錯誤、`new Worker(...)` 正常；content_nodes 827、node_attributes 2221；backend 無 error。

清理：release 67967bc0 失敗後已刪。release 60336fd1 不再被 nginx 掛載（交給 note-59）。KEEP 備份 `manual-20261017194806` 未動。

## 2026-10-18 D107 媒體權限與到期日、D108 AI 來源編號、空白筆記游標（#397、#396、#400）；沒有 migration

部署 **`98af95d2`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/87d1af6d…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-82、note-af、note-50，三位都回覆可以）。基於 note-50 部署的 87d1af6d。

**內容（使用者看得到的）：**
- **#397（D107）**：已登入、但不在筆記空間裡的人，打開公開網站時也看得到圖片（以前登入反而 404）；匯入時只重用同一空間裡的舊檔，圖片不會因為擁有者在別的空間而對隊友 404；任務到期日要是真的日期（`2026-02-30` 會被擋下）。
- **#396（D108）**：問筆記、做成簡報、技能存成子筆記，三處存下的來源都編號，和內文 [n] 對得上。
- **#400（note-50）**：空白筆記的提示文字改成絕對定位，Android 游標從開頭開始。

**驗證（部署前）**：#397 合併 main 後後端全套 3146 過／5 略過；#396 合併 main 後前端全套 385 檔 2871 過；tsc、eslint 乾淨。新 worker 仍是 `localDbWorker-CDECBli9.js`，無 `createElement`／micromark。

順序：打 tag `before-98af95d`（即 87d1af6d 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018104222`，checksum 通過）；build（`backups/build-98af95d.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 828、node_attributes 2226；Chromium 開首頁無錯誤、`new Worker(...)` 正常；`/_astro/` 只回一個 Cache-Control（#385 已生效）。
清理：刪掉 `before-3453c75`、`before-60336fd` 與 release 3453c75b、60336fd1（nginx 已改掛 87d1af6d）；`docker builder prune` 釋出 4.5 GB。保留 `before-98af95d`、`before-67967bc`、`before-908ec00`、`onden-vps-nginx:before-67967bc`、release 87d1af6d（nginx 掛載）與 908ec001、KEEP 備份 `manual-20261017194806`。磁碟 63%→51%。

## 2026-10-18 D97 網站 › 集合讀標籤目錄（#404）；沒有 migration

部署 **`607e2dd7`**（main；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/87d1af6d…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-82、note-af、note-50，三位都回覆可以）。

**內容（使用者看得到的）：**
- **#404（D97）**：網站 › 集合直接讀標籤目錄（和標籤頁同一份），在標籤頁新加的欄位，在集合裡改名存檔不會再被刪掉；暖啟動或離線時集合清單不再是空的。bootstrap 不再送 `collections`；標籤目錄多帶 `schema_name`。

**驗證（部署前）**：#404 前端全套 387 檔 2878 過、後端全套 3147 過／5 略過；tsc、eslint 乾淨；main 在其基底之後只多了部署紀錄。新 worker `localDbWorker-CXDfEOR5.js`，無 `createElement`／micromark。

順序：打 tag `before-607e2dd`（即 98af95d2 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018130524`，checksum 通過）；build（`backups/build-607e2dd.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁、新 worker 200；content_nodes 828、node_attributes 2226（與上次相同）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-908ec00` 與 release 908ec001；`docker builder prune` 釋出 4.5 GB。保留 `before-607e2dd`、`before-98af95d`、`before-67967bc`、`onden-vps-nginx:before-67967bc`、release 87d1af6d（nginx 掛載）與 98af95d2、KEEP 備份 `manual-20261017194806`。磁碟 52%。

## 2026-10-19 手機「更多」與設定重整、PDF 舊瀏覽器修正、稍後讀「讀完」、引用統一；沒有 migration

部署 **`691b3eff`**（main；重建 backend、frontend；nginx 沒有動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「合併並部署四個 PR」，並確認 #408 一起上（note-9e 先前的 #408 部署在 build 前被中斷）。

**內容：**
- **#402** #稍後讀 標籤頁也能按「讀完」（新擴充點 `members.Rows`）。
- **#403** pdf.js 改用 legacy build：modern build 直接用了約 10 個新語法（最晚 Chrome 145／Safari 26.2），舊瀏覽器打不開 PDF。
- **#405** 手機設定視覺重整：功能設定獨立一組、群組可折疊、危險操作單獨放最後。
- **#407** 手機「更多」改成導覽＋已引入的功能清單（`useImportedFeatures`）；帳號、同步狀態、設定、登出移到頭像；手機設定只剩一個入口。
- **#408**（D114）引用 `[@key]` 只有一套解析；引用鍵不可重複；匯入文獻後自動連上引用它的筆記。

**驗證（部署前）**：合併後的 main 跑 moduleBoundary、MobileNav、ShellAccountActions、settings*、i18nKeys、pdfjsCompat、readLaterTagPageDone、noRawLazy、workerImports：13 檔 93/93。

順序：打 tag `before-691b3ef`（即 607e2dd7 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018163853`，checksum 通過）；build（`ONDEN_BUILD_ID=691b3eff…`，`backups/build-691b3ef.log`；`astro@6.4.6 ✔`、`micromark@4.0.2 ✔`；worker 檢查 72.9 KiB / 91.0 KiB，無禁用套件）。
16:42:52 UTC 切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；`/pdf.worker.min.mjs` 200 且是 legacy 版（含 core-js）；Chromium 首頁無錯誤、`new Worker(...)` 正常；content_nodes 830、node_attributes 2226；backend 無 error。

殘留：note-9e 中斷的 #408 部署留下 release `a740d74b…` 與 tag `before-a740d74`（等同 607e2dd7），未動，交由 note-9e 清理。

## 2026-10-19 空白筆記提示字移出可編輯區（#409）；只重建 frontend

部署 **`1f1bad35`**（main；只重建 frontend；backend、nginx 沒動）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「就這樣做」（合併並部署 #409）。

**內容：** **#409** 接續 #400：Android 上空白筆記的提示字被當成選取範圍（兩個水滴把手）。提示字改成 `view.scrollDOM` 上的疊層（`lib/editorEmptyHint.ts`），不在 contentDOM 裡；`placeholder()` 與 #400 的 `:has` CSS 移除。

順序：打 tag `before-1f1bad3`（frontend，即 691b3eff）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018164701`，checksum 通過）；build frontend（`backups/build-1f1bad3.log`；`astro@6.4.6 ✔`；worker 72.9 KiB / 91.0 KiB）。16:50:08 UTC 切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200；Chromium 首頁無錯誤、worker 正常。Android 上的選取把手要使用者在手機上確認。

## 2026-10-19 D42／D58／D59／D62：網站網址只認一個、別名連結改寫、Unicode 文字、區塊錨點統一、標題錨點；migration 117

部署 **`30fc26c1`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者同意整串 rebase、審核、合併、部署，並選了別名選項 3。

**內容：**
- **#279 D42**：每篇筆記的網站網址只由實際發布的快照決定。別名（使用者選項 3）：發布時把只靠別名才連得到的 `[[alias]]` 改寫成 `[[served-slug|alias]]`，快照裡不放別名清單；未發布筆記的別名照舊遮掉。舊快照要下次發布才會套用。
- **#281 D58**：組合符號算文字的一部分，名稱存成 NFC；標題只有真的變了才重算 slug（審核修正）。
- **#284 D59**：`^id` 錨點一套語法，每種區塊都能當錨點；migration 117 刪掉 `node_block_ids`（部署前正式站該表 0 筆，沒有資料遺失）。
- **#287 D62**：標題錨點只有一個來源；中文標題的 id 不再是空字串，英文標題的 id 不變。

**驗證（部署前）**：整串由兩個 session rebase、獨立審核（後端 296 檔 2511 測試、前端、markdown 全套，在已套 117 的新資料庫上）；合併時解掉兩處和 #408 的 import／測試衝突，相關測試通過。

順序：打 tag `before-30fc26c`（即 1f1bad35 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018171832`，checksum 通過）；build（`ONDEN_BUILD_ID=30fc26c1…`，`backups/build-30fc26c.log`；`astro@6.4.6 ✔`；worker `localDbWorker-CmjAjCw5.js` 73.0 KiB / 91.0 KiB）。
17:22:06 UTC 切 backend，`[migrate] applied 117_drop_node_block_ids`，`node_block_ids` 已不存在，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；`/api/site` 沒有 `"aliases"`；Chromium 首頁無錯誤、worker 正常；content_nodes 831、node_attributes 2226；backend 無 error。

## 2026-10-19 導覽列跟著模組走、核心頁「歷史」、電腦版設定分組、拿掉垃圾桶（D111）；沒有 migration

部署 **`e1924b31`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「合併 #417」「412 也」「移除垃圾桶」。

**內容：**
- **#417** 導覽列：核心頁 筆記、任務、標籤、關係圖、歷史（`timeline`）；有頁面的已引入模組（複習、閱讀、網站、白板）自動加入，放不下收進「更多 ▾」；手機底部列 筆記・任務・＋・標籤・更多。
- **#412** 電腦版設定照手機分組（`settingsSections()` 一個來源）；白板在 設定 › 模組 的「檢視」組。
- **#415（D111）** 拿掉垃圾桶：刪除仍是軟刪除，從 歷史 › 事件 › 「已刪除的筆記」還原，連同上層與一起刪除的子樹；`/api/nodes/trash`、`/trash/empty` 移除；沒有任何東西會永久清除軟刪除的資料列。

**驗證（部署前）**：合併後的 main 跑 AppTopbar*、historyDestination、settings*、i18nKeys、MobileNav、eventLog*、moduleBoundary（14 檔 80/80）與後端 nodeLifecycleOwner（2/2）。

順序：打 tag `before-e1924b3`（即 30fc26c1 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018174437`，checksum 通過）；build（`backups/build-e1924b3.log`；`astro@6.4.6 ✔`；worker 73.0 KiB / 91.0 KiB）。17:48:14 UTC 切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：已刪除的筆記數切換前後都是 467／831（沒有任何資料被清除，都能從歷史還原）；首頁、`/api/site` 200，未登入 `/api/bootstrap`、`/api/nodes/trash` 401；Chromium 首頁無錯誤、worker 正常；backend 無 error。

待決定：刪除共用空間仍要求空間裡完全沒有筆記（已刪除的也算），拿掉清空垃圾桶後，曾刪過筆記的空間無法刪除。

## 2026-10-19 畫畫直接顯示、標籤頁改版、RSS 讀到哪與引用；沒有 migration

部署 **`64219335`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「merge #416, #422, #418, #420 and #419」。

**內容：**
- **#419** `![[畫畫]]`（含 `![[X.excalidraw]]`）在預覽、編輯（游標不在那一行時）與發布網站直接顯示；網站在發布時把畫面凍結進快照（`drawing_svg`），沒發布的嵌入變 `(private)`。
- **#418** 標籤總覽改成一份樹狀清單、功能小標記、整理提示；**#420** 標籤頁先看筆記，結構收進只給擁有者的「編輯結構」側板（檢視模組標籤上不出現）。
- **#416** RSS 讀到哪取代已讀未讀、導覽小點（併進 #417 的導覽模型）、左右滑換篇；**#422** 選字「引用到筆記」、文末「寫點什麼」、整篇存檔降級。

**驗證（部署前）**：合併後的 main 跑導覽、navIndicator、標籤頁、drawingEmbed、rss、i18nKeys、moduleBoundary、workerImports、noRawLazy（23 檔 134/134）與 markdown 全套（281/281）。

順序：打 tag `before-6421933`（即 e1924b31 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018185809`，checksum 通過）；build（`backups/build-6421933.log`；`astro@6.4.6 ✔`；worker 73.0 KiB / 91.0 KiB）。19:01:46 UTC 切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 467／831，前後一致；backend 無 error。

清理：磁碟部署後到 78%。刪掉較舊的回滾映像 `before-30fc26c`、`before-1f1bad3`、`before-691b3ef`、`before-607e2dd`、`before-98af95d`、`before-67967bc`（含 nginx），並 prune builder 與 dangling images，磁碟回到 52%。保留 `before-6421933`、`before-e1924b3`、所有備份（含 KEEP 的 `manual-20261017194806`）與 nginx 掛載的 release 87d1af6d。

## 2026-10-19 日記成為模組（#354）；migration 112

部署 **`43b52acc`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「#354 日記模組該合」。

**內容：** 日記成為可開關的模組（新工作區預設關、既有工作區開）；頂端「今天」按鈕與「更多」的核心「今日筆記」列移除，日記改成 #417 導覽模型裡的模組入口（桌面導覽／更多 ▾、手機 更多 › 功能）；日記的父筆記設定在 設定 › 功能；沒開日記時快速捕捉放到個人空間最上層。#354 落後 main 220 個 commit，以一個 merge commit 接上（衝突 12 檔），合併前跑過模組、導覽、設定、快速捕捉、日記相關測試與 `--changed`（293 檔 2213/2213）、後端 20 檔 154/154。

順序：打 tag `before-43b52ac`（即 64219335 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018195752`，checksum 通過）；build（`backups/build-43b52ac.log`；`astro@6.4.6 ✔`；worker 73.0 KiB / 91.0 KiB）。20:01:28 UTC 切 backend，`[migrate] applied 112_daily_module`（比已套用的 113–117 小，照名稱補上），`/health` ok；工作區模組清單多了 `daily`；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 467／831 不變；backend 無 error。

## 2026-10-19 歷史裡的「永久刪除」、刪除空間處理已刪除的筆記（#424）；migration 118

部署 **`85ee544b`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者同意設計（「其他都沒有意見，你開始吧」）。

**內容：** 歷史 › 已刪除的筆記 每列可「永久刪除」（一次一則、空間管理者或共用空間擁有者、要輸入標題、`expected_ids` 必填）；硬刪除筆記與所有已刪除的子孫、級聯資料、無人引用的版本／檔案、相關 outbox；已發布快照改寫；事件內容換成 `{"purged":true}`，另記 `NODES_PURGED`（不含標題）；同步把它們刪掉。刪除共用空間時可「一起永久刪除」（核對 `expected_deleted_ids`）或「搬到我的個人空間」。**migration 118** 換掉 `domain_events_immutable()`：只允許在交易內設了 `myapp.allow_event_redact` 時，把 payload／tx_meta 改成恰好那個標記，其他欄位不變，DELETE 仍禁止。獨立審核通過（修了 outbox 外洩、計畫核對兩處）。

順序：打 tag `before-85ee544`（即 43b52acc 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018201131`，checksum 通過）；build（`backups/build-85ee544.log`；`astro@6.4.6 ✔`；worker 73.0 KiB / 91.0 KiB）。20:15:09 UTC 切 backend，`[migrate] applied 118_event_redact_purged`，`/health` ok；切 frontend；`current` 指向新 release。
驗證：已刪除的筆記 467／831、事件 2675 筆，部署前後一致（部署本身不刪任何東西）；在會回滾的交易裡不帶旗標直接 UPDATE 一筆事件，被觸發器擋下（`domain_events is append-only`）；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常；backend 無 error。

後續（已接受）：清除時整表掃檔案引用、舊事件／舊快照裡內嵌的檔案引用、審查備註留在被清除的事件上。

## 2026-10-19 D118 移除成員走空間服務、發布可安全重送、日期篩選不再 500（#413）；沒有 migration

部署 **`35ccdc7a`**（main，包含 note-50 部署的 85ee544b；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/87d1af6d…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-82、note-af、note-50，三位都回覆可以）。

**內容（使用者看得到的）：**
- **#413（D118）**：移除成員時，由空間服務關掉他個人空間的發布等開關，記一筆 `SPACE_UPDATED`，並重建網站（外部靜態站立刻拿掉他的頁面）。發布用同一個 idempotency key 重送只會建一份快照、推一次；重送「產生存取碼」回 409 `mint_replayed`。檢視篩選對日期／排序欄位填了不合格的值時，存檔照存（邊打邊存不再閃「儲存失敗」），執行時當作沒有符合的結果，不再 500。

**驗證（部署前）**：#413 合併 main（含 85ee544b）後後端全套 3188 過／5 略過；tsc、eslint 乾淨。新 worker `localDbWorker-CmjAjCw5.js`，無 `createElement`／micromark。

順序：打 tag `before-35ccdc7`（即 85ee544b 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018205507`，checksum 通過）；build（`backups/build-35ccdc7.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁、新 worker 200；content_nodes 831（已刪除 470）、node_attributes 2226；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-6421933`、`before-e1924b3` 與 release 1f1bad35、30fc26c1、607e2dd7、64219335、691b3eff、98af95d2、e1924b31；`docker builder prune` 釋出 4.5 GB。保留 `before-35ccdc7`、`before-85ee544`、`before-43b52ac`、release 87d1af6d（nginx 掛載）、85ee544b、43b52acc、KEEP 備份 `manual-20261017194806`。磁碟 63%→53%。

## 2026-10-19 白板手感第 1 步、D82 伺服器連不上的單一規則、D84 網站存取單一閘門；沒有 migration

部署 **`f7f9a4c9`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-50 部署（事前通知 note-82、note-9e、note-af）。使用者說「合併」。

**內容：** **#317** 白板手感第 1 步（Delete 不刪筆記、連線可選取、手寫不崩潰、卡片高度上限、勾選一次生效），ink 解碼器的「逐欄讀、壞資料丟掉、永不丟例外」改寫進共用的 `@onden/markdown/ink`；**#341 D82** 一個 `isServerUnreachable` 規則，部署中的 502／503 不再卡住 warm boot；**#351 D84** 網站讀取只走 `siteAccessGate`，被拒的 `?access=` 不會蓋掉有效 cookie。三個 PR 都落後 main 260–330 個 commit，合入 main（含 #413）後重跑測試。

順序：打 tag `before-f7f9a4c`（即 35ccdc7a 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261018211550`，checksum 通過）；build（`backups/build-f7f9a4c.log`；`astro@6.4.6 ✔`；worker `localDbWorker-CmjAjCw5.js` 73.0 KiB / 91.0 KiB，與上一版相同，映像內 micromark 0、createElement 0）。21:19:25 UTC 切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831（部署前後一致；比上一版多 3 篇是使用者這段時間的刪除）；backend 無 error。

## 2026-10-19 新使用者手感修正（#428）、段落標籤補全（#430）、段落上的複習卡（#432）；migration 120

部署 **`eca5b9a9`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-af 部署（事前通知 note-9e、note-82、note-50，三位都回覆可以；基於 note-50 部署的 f7f9a4c9）。

**內容（使用者看得到的）：**
- **#428**：在標籤頁快速捕捉時，不再把筆記放到標籤底下（伺服器會拒絕，D101 的捕捉部分），改放今天的日記或最上層，標題照實寫；側欄 ＋ 一按就開新筆記並選取標題（其他類型在旁邊的 ⌄），新筆記叫「未命名」；歡迎筆記拿掉新帳號做不到的說法（按 N、⌘⇧N、Today 按鈕、內文 `#tag`）。
- **#430（B2b）**、**#432（B3）**：段落標籤的 `{` 補全、段落上的複習卡（`block_review_states`，migration 120）。都在 `ONDEN_BLOCK_NODES` 後面，**正式環境開關仍關閉**，畫面不變。

順序：打 tag `before-f7f9a4c`（即 f7f9a4c9 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261018214714`，checksum 通過）；build（`ONDEN_BUILD_ID=eca5b9a9`，`backups/build-eca5b9a.log`）。21:50:19 UTC 切 backend＋frontend，`[migrate] applied 120_block_review_states`，21:50:42 `/health` ok；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；content_nodes 831（已刪除 470）與部署前一致；`block_review_states` 0 列；backend 無 error；worker `localDbWorker-CmjAjCw5.js` 不變；Chromium 首頁無錯誤、`new Worker(...)` 正常。
已知：前端 `moduleBoundary` 測試抓到 #432 的 `OverviewEditor.tsx` 直接寫了模組 id `review`（不影響執行），下一個 PR 改成由模組宣告。

## 2026-10-19 任務行（#435，B4）；migration 122

部署 **`4dbc8c60`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d）。由 note-af 部署（事前通知 note-9e、note-82、note-50；note-82、note-50 回覆可以；基於 eca5b9a9）。

**內容：** `- [ ] 文字 {task}` 的清單項目就是任務（段落節點包住一般任務節點，`block_nodes.task_id`，**migration 122**）：打勾＝完成、任務頁完成會勾回那一行、拿掉 `{task}` 任務進垃圾桶、貼回還原；編輯器的「轉成任務」在段落節點開啟時改寫 `{task}`。另修 #432 的模組邊界（`blockAction` 由模組宣告）。**`ONDEN_BLOCK_NODES` 仍關閉**（要不要打開由使用者決定；唯讀掃描正式站，現有筆記沒有任何 `{…}` 段落標籤會被改動），畫面不變。

順序：打 tag `before-eca5b9a`；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261018220348`，checksum 通過）；build（`ONDEN_BUILD_ID=4dbc8c60`，`backups/build-4dbc8c6.log`）。22:06:43 UTC 切 backend＋frontend，`[migrate] applied 122_block_task_lines`，22:07:08 `/health` ok；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；content_nodes 831（已刪除 470）不變；backend 無 error；worker `localDbWorker-CmjAjCw5.js` 不變；Chromium 首頁無錯誤、`new Worker(...)` 正常。

## 2026-10-19 舊 PR 整理後合入（#303 #310 #306 #276 #304 #295 #291 #273 #267，另含 #173 文件）

部署 **`130f4141`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d；沒有新 migration）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 4dbc8c60）。

**內容：** 使用者核准「還有用的接到最新版、跑測試後合併部署；已被取代的關掉」（#302 關閉）。
- **#303**：快速捕捉可以指定要放進哪篇筆記。
- **#310 D76**：搜尋片段統一為 `{ text, ranges }`，伺服器不再回 HTML。
- **#306 D75**：白板清單由白板節點推導，改名／刪除只有一條路。
- **#276 D57**：合併標籤時，`extends` 由來源改指到目標。**#304 D72**：模組開關的檢查移進 `writeTagSchema`。
- **#295 D67**：大小上限在每個寫入點都檢查，不只 REST 入口。
- **#291 D66**：分頁統一為 `parsePage` + `{ rows, total, next }`。
- **#273 D55**：「slug 跟著標題」只有一個負責的地方（合 main 時 `collections.ts` 只有 import 衝突）。
- **#267 D52**：單篇 Markdown 下載／複製用跟 zip 一樣的檔名規則。

順序：打 tag `before-130f414`（即 4dbc8c60 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261018235147`）；build（`ONDEN_BUILD_ID=130f4141`，`backups/build-130f414.log`；worker `localDbWorker-CHDaVa5x.js` 76.8 KiB / 91.0 KiB，no forbidden library）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：合併後 main 上跑改到的測試（前端 34 檔 432、後端 8 檔 304、markdown 19，全過；前後端 tsc 無錯）；首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831（部署前後一致）；backend 無 error。

## 2026-10-19 使用者自己下載完整備份（#439）

部署 **`7bd4fa65`**（main；重建 backend、frontend；nginx 沒動，仍掛 87d1af6d；沒有新 migration）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 130f4141）。

**內容：** 設定裡可以下載完整備份（Markdown 資料夾 + 還原用的 `.onden` 資料），`GET /api/backup/full.zip`。獨立審查後修了畫布 id／位置外洩（d9fc1b11）；合 main 時與 #267（D52）的匯出重構合成一套檔名規則（`vaultIndex` + `vaultBases`，單篇下載／複製與 zip 共用）。還原 #442 還沒上線（D1、D2、E、G 等使用者決定）。

順序：打 tag `before-7bd4fa6`（即 130f4141 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019001845`）；build（`backups/build-7bd4fa6.log`；worker `localDbWorker-CHDaVa5x.js` 76.8 KiB / 91.0 KiB，與上一版相同）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 與 `/api/backup/full.zip` 皆 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831 不變；backend 無 error。備份範圍（只含讀得到的筆記、所屬空間的保留列、`canReadMedia` 的附件）由審查與 backupDownload 整合測試確認，未在正式站用其他帳號實測。

## 2026-10-19 手機效能與離線（#446、#447）

部署 **`7d8b364a`**（main；重建 backend、frontend，實際只動前端；nginx 沒動，仍掛 87d1af6d；沒有新 migration）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 7bd4fa65）。

**內容：**
- **#446**：手機筆記列表虛擬化（只畫畫面附近的列），搜尋結果路徑由 O(n²) 改為查表。模擬中階手機（390px、CPU 4×、Slow 4G）：5k 篇重開到可用 8.7–9.0 → 4.5 s，DOM 列數 4,466 → 41，JS heap 69–78 → 30 MB。
- **#447**：service worker 改寫（`onden-v4` → `onden-v5`）：`/` network-first、`/_astro/*` cache-first（未命中一律走網路）、wasm／字型／icon network-first 加離線備援、`/api/*` 與非 GET 不碰；`lib/offlineWarmup` 閒置時預抓標籤、任務、設定、筆記畫面。修好離線重新整理時本機資料庫起不來（wasm 沒快取）。
- 量測報告與後續建議（membership 檢查 20 頁、bootstrap 重下載、本機 DB 整份存檔）在 note-50 的 mobile-perf 報告。

順序：打 tag `before-7d8b364`（即 7bd4fa65 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019004353`）；build（`backups/build-7d8b364.log`；worker `localDbWorker-CHDaVa5x.js` 76.8 KiB / 91.0 KiB，與上一版相同）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap`、`/api/backup/full.zip` 401；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831 不變；backend 無 error。
**SW 更新路徑**（note-af、note-82 要求）：部署前用持久化 Chromium 設定檔載入舊版（`onden-v4` 控制頁面）；部署後重新整理 → 新 SW `onden-v5` 接手、舊快取刪除、載入新版 chunk（`AppRoot.DOFQYjaU.js`，舊為 `AppRoot.BX6u0if8.js`）；`onden-v5` 內 0 個 `/api` 項目、不存在的 chunk（404）未被快取。離線重新整理有回應頁面（未登入設定檔顯示「暫時無法確認登入狀態」，符合預期；已登入的離線重開由 #447 的離線 e2e 涵蓋）。退回時舊 sw.js 的 activate 會刪掉 `onden-v4` 以外的快取，不會卡住用戶端。

## 2026-10-19 設計 token 與 赭紅墨 配色、思源宋體／黑體（#431、#438）

部署 **`9be7c453`**（main；重建 backend、frontend，實際只動前端；nginx 沒動，仍掛 87d1af6d；沒有新 migration）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 7d8b364a）。

**內容：** A+C「安靜寫作」改版的第一步。**#431** token 打底（發布站獨立、補齊未定義 token、守門測試）；**#438** 赭紅墨配色（深淺）、Noto Serif TC／Noto Sans TC 改由 npm `@fontsource-variable` 提供（使用者決定：不進 git、接受首次載入 1.5–1.9 MB、編輯器預設宋體）。#438 以 **squash** 合入，分支早期 commit 曾帶的 9.5 MB 字型檔不進 main 歷史。

順序：打 tag `before-9be7c45`（即 7d8b364a 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019012730`）；`docker builder prune` + `image prune`（磁碟 81% → 71%）；build（`backups/build-9be7c45.log`；`check-app-css` 35 個樣式表通過；worker `localDbWorker-CHDaVa5x.js` 76.8 KiB / 91.0 KiB 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200；`fonts-noto.*.css` 216 個 `@font-face`，每個都有 `unicode-range` 與 `font-display:swap`；登入頁（手機 390、桌面 1280，深淺各一）只抓 6 個 woff2、共 324 KB、最大 72 KB，無頁面錯誤；字型切片在 `/_astro/` 下，由 SW `onden-v5` 快取（上限 1000 項）。Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831 不變；backend 無 error。

## 2026-10-19 從備份還原（#442）；migration 123；nginx 改掛新 release

部署 **`eafdc46e`**（main；重建 backend、frontend；**重建 nginx**；migration 123）。由 note-50 部署（事前通知 note-82、note-9e、note-af；三位都回覆可以；基於 9be7c453）。

**內容：** 使用者自己從備份還原（預覽、空白還原或合併、整次可在歷史撤銷）。上線前兩輪獨立審查：第一輪修了 crafted zip 讓 backend 掛掉、大小檢查失效、他人遺失檔案被補；使用者決定 D1／D2／E／G 照推薦修（建立時間夾限、背景 job＋進度、合併一律進目標空間、sync 依事件先後）；第二輪再修 D1 夾限繞過（大小寫／URL 前綴）、同空間兩個還原同時成功（partial unique index `one_running_per_space`）、還原進行中在歷史撤銷（409）、自動撤銷一個大交易握鎖（改逐筆短交易）、sync 復活到不可讀空間時少送刪除。寫附件前檢查磁碟（不足 507）。已知：歷史裡手動撤銷大型還原仍是一個交易。

**nginx**：容器原本掛 `releases/87d1af6d…/docker/nginx/nginx.conf`；新設定只多 `location = /api/backup/restore/upload`（`client_max_body_size 1024m`、600s）。先在同一 docker 網路的拋棄式 `nginx:1.31-alpine` 容器跑 `nginx -t` 通過，再 `up -d --no-deps --force-recreate nginx`；現在掛 **`releases/eafdc46e3af3f8f3d43d9e29a4142034527f2054/docker/nginx/nginx.conf`**——**這個 release 不可刪**；87d1af6d 從此可清（退回 nginx 時可再改掛它）。上傳在 nginx 先落地暫存再由 backend 驗身分（與媒體上傳 501m 相同做法；站台只在 tailnet），未登入 30 MB 上傳回 401（舊設定會在 20 MB 回 413）。

順序：打 tag `before-eafdc46`（即 9be7c453 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019014310`）；build（`backups/build-eafdc46.log`；check-app-css 通過；worker `localDbWorker-CHDaVa5x.js` 不變）。切 backend：`[migrate] applied 123_backup_restore_jobs`，`/health` ok；切 frontend；重建 nginx；`current` 指向新 release。
驗證（經 tailscale HTTPS）：首頁、`/api/site` 200；未登入 `/api/bootstrap`、`/api/backup/full.zip`、`POST /api/backup/restore/upload` 401；hashed chunk 200 且 `immutable`，最大的 `SiteTemplate.*.js` 731 KB 200；Chromium 首頁無錯誤、worker 正常；已刪除的筆記 470／831 不變；backend、nginx 無 error。
磁碟：部署後 87%，`docker builder prune` 後 80%，再移除較舊的回退 tag（before-eca5b9a、f7f9a4c、35ccdc7、85ee544）後 **68%（19 GB 可用）**；保留 before-eafdc46、9be7c45、7d8b364、7bd4fa6、130f414、43b52ac。

## 2026-10-19 本機資料庫寫入日誌（#450）

部署 **`f3dcb1b5`**（main；重建 backend、frontend，實際只動前端；nginx 沒動，掛 eafdc46e；沒有新 migration；sw.js 沒動，仍 `onden-v5`）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 eafdc46e）。

**內容：** 離線排隊的寫入（新增／拒絕／略過／清除）與筆記、畫布刪除，改成先寫一筆小紀錄到另一個 IndexedDB `onden-journal`，worker 等這筆提交就回覆；整份快照延後到 15 s 沒新紀錄或累積 200 筆時才存（compaction），一次存檔只匯出一次。20k 篇：一筆排隊寫入 155 ms → 1–2 ms，排隊時的記憶體尖峰 258–340 MB → 約 0。整份快照仍是整檔匯出（OPFS 方案寫在 `docs/research/local-db-opfs-plan-2026-10-19.md`）。

**⚠ 退回注意：** 舊版不讀 `onden-journal`。退回到 `before-f3dcb1b` 之前，**先請使用者連上線、等排隊的寫入送完**；否則最後一次 compaction 之後（最多約 15 s）排隊的離線寫入會在舊版消失。快照格式（`onden-storage` v1）沒變，舊版可以照常開。

順序：打 tag `before-f3dcb1b`（即 eafdc46e 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019014954`）；build（`backups/build-f3dcb1b.log`；check-app-css 通過；worker **`localDbWorker-cONDiylz.js` 82.0 KiB / 91.0 KiB**，no forbidden library）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤，**以實際檔名**載入 `localDbWorker-cONDiylz.js` 正常、IndexedDB 可開；已刪除的筆記 470／831 不變；backend 無 error。離線寫入的耐久性（未存檔就關頁／重開、舊版→新版→當掉→退回）由 #450 在 Chromium、Firefox、WebKit（docker）實測；正式站沒有測試帳號，未在正式站重做。

**更正：** note-50 的開機檢查腳本把 worker 檔名寫死成 `localDbWorker-CmjAjCw5.js`；130f4141 起 worker 改名為 `CHDaVa5x`，之後四次部署（130f4141、7bd4fa65、9be7c453、eafdc46e）紀錄裡的「worker 正常」其實是對舊檔名的檢查（回報 error，被誤讀）。這四版的 worker 都是同一個 `CHDaVa5x`，7d8b364a 部署時以正確檔名（SW 更新測試）確認可啟動，所以實際上沒有問題。腳本已改成從頁面找出實際檔名。

## 2026-10-19 大工作區重新開啟（#453、#454、#455）與還原測試修正（#456）

部署 **`6362b23c`**（main；重建 backend、frontend；nginx 沒動，掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-82、note-9e、note-af；note-82、note-af 回覆可以；基於 f3dcb1b5）。

**內容：**
- **#453**：`GET /api/sync/membership/digest`（可讀 id 集合的 SHA-256 加每個兩字元前綴的桶雜湊）；客戶端相同就不分頁，不同只分頁不同的桶（≤64，否則全部），一頁最多 5,000。舊伺服器回 404/405 → 全部分頁；沒有 Web Crypto → 全部分頁。`/sync/bodies` 只收嚴格 UUID（400）。
- **#454**：有同步游標的裝置重新開啟只等 sync；背景改抓 `GET /api/bootstrap?nodes=none`（看板、位置、建議、事件、目錄、網站設定、旗標），完整 bootstrap 一天最多一次（`sync_state.full_refresh_at`）；`resync_required` 仍抓完整。新裝置或清掉 IndexedDB 沒有游標，照抓完整。
- **#455**：帶 `X-Onden-Bootstrap: lean` 才省略 `attrs` 與 `ink_data`／`pdf_annotations` 值（舊前端不帶，照拿完整）。`GET/POST /api/sync/drawings`（讀取閘門、嚴格 UUID、每次 ≤20）在閒置時背景下載手寫，含雜湊以更新過期副本、不蓋未同步的筆畫；手動 SQLite 備份先強制下載，缺的會提示。`ink_data` 寫入在伺服器做三方合併（`mergeInk`），在手寫下載前打開並畫的筆畫會與既有筆畫合併，不會覆蓋。`features.block_nodes` 每次都送。
- **#456**：還原 job id 格式不對回 404（原本 500）；`permissionMatrix`、`spineGate` 測試補齊。
- 兩輪獨立審查：權限邊界沒有漏洞；D1（舊伺服器 404 讓閘門卡死）、D2（桶全同但總摘要不同時跳過撤銷）、D3（類 UUID 回 500）、D4（本機備份缺手寫）都已修。
- 模擬手機 20k 篇：「正在確認工作區資料」14 s → 約 2 s，可用 17 s → 約 5 s，重開流量 10.7 MB → 約 20 KB；空裝置冷啟動 65 s → 23 s。

順序：打 tag `before-6362b23`（即 f3dcb1b5 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019032412`）；build（`backups/build-6362b23.log`；check-app-css 通過；worker `localDbWorker-DYQEwYIy.js` 85.3 KiB / 91.0 KiB）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200；未登入 `/api/bootstrap`、`/api/sync/membership/digest`、`/api/sync/drawings`、`/api/backup/restore/jobs/…` 皆 401；Chromium 首頁無錯誤，以實際檔名載入 worker 正常、IndexedDB 可開；已刪除的筆記 470／831 不變；backend 無 error。
磁碟：build 後 83%；`builder prune` 並移除回退 tag before-7bd4fa6、130f414、43b52ac 後 64%（21 GB 可用）；保留 before-6362b23、f3dcb1b、eafdc46、9be7c45、7d8b364。

## 2026-10-19 D96 靜態網站 zip 內含圖片、D116 網站首頁由伺服器一處決定（#437）；沒有 migration

部署 **`c0af6398`**（main，包含 note-50 部署的 e65e78f1；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50；note-af、note-82 的 session 已結束）。

**內容（使用者看得到的）：**
- **D96**：「下載靜態網站」的 zip 現在附上頁面用到的圖片與檔案（`media/<id>`，連結改成相對路徑），放到別處架站不再 404。和推到 GitHub Pages 共用一個 `bundleSiteFiles`。
- **D116**：網站首頁只由伺服器的 `siteHomeFor` 決定：指定的首頁 → 工作區首頁 → 第一個沒有功能標籤的頁面 → slug `home` → 第一頁。核准 AI 發布後首頁不再跳成最舊的論文。Studio／時間軸發布不再送 `home_node_id`。

**驗證（部署前）**：#437 合併 main 後後端全套 3337 過、3 失敗（`backupRestoreAdversarial` 兩個是本機 yauzl 2.10 的環境問題，換 3.4.0 後 16/16 過；`bodyParsersLinear` 的計時檢查在高負載下 9.5×／上限 9×），前端全套 3198 過、1 失敗（`FontScaling`：main 上 `global.css:2587` 寫死 10px，不是 #437，note-50 修）；tsc、eslint 乾淨。新 worker `localDbWorker-DYQEwYIy.js`，無 `createElement`／micromark。

順序：先清 build cache 與舊 tag（磁碟 75%→55%）；打 tag `before-c0af639`（即 e65e78f1 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019065246`，checksum 通過）；build（`backups/build-c0af639.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁、新 worker 200；content_nodes 831（已刪除 470）、node_attributes 2226；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-eafdc46`、`before-9be7c45`、`before-7d8b364`、`before-f3dcb1b` 與 nginx 未掛載的舊 release；保留 `before-c0af639`、`before-e65e78f`、`before-6362b23`、release eafdc46e（nginx 掛載）、e65e78f1、6362b23c、KEEP 備份 `manual-20261017194806`。磁碟 55%。

## 2026-10-19 拿掉標籤頁重複的「功能」列（#458）

部署 **`e65e78f1`**（main；重建 backend、frontend，實際只動前端；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-9e，回覆可以；note-82、note-af 的 session 已結束）。

**內容：** 使用者看手機畫面時提出「兩個功能是不是留一個就好」：「全部標籤」頁的「功能」chip 列（`FeatureLauncher`）刪除，標籤頁只剩搜尋、新增、列表、整理；功能入口只留「更多 › 功能」。「管理功能…」統一為設定頁用的「管理模組」。桌面：有頁面的模組在上方導覽列，管理模組從齒輪進設定 › 模組。

順序：打 tag `before-e65e78f`（即 6362b23c 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019062933`）；build（`backups/build-e65e78f.log`；worker `localDbWorker-DYQEwYIy.js` 不變）。切 backend、frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 470／831 不變；backend 無 error。

## 2026-10-19 手機導覽數字徽章字級（#459）

部署 **`7644e408`**（main；基於 note-9e 部署的 c0af6398；重建 backend、frontend，實際只動 `global.css`；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（note-9e 部署完 #437 後交棒）。

**內容：** 手機導覽列的未讀數字徽章原本寫死 `font-size: 10px`，違反 FontScaling（不可寫死 px 字級、不可小於 11px）；改為沿用 `.nav-indicator--count` 的 `--onden-text-xs`，跟著使用者的字級設定。FontScaling 在 main 上恢復通過。

順序：打 tag `before-7644e40`（即 c0af6398 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019065838`）；build（`backups/build-7644e40.log`；check-app-css 通過；worker `localDbWorker-DYQEwYIy.js` 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 470／831 不變；backend 無 error。磁碟 55%。

## 2026-10-19 D110 用一次性邀請連結加成員（#433）；migration 119

部署 **`828ebae9`**（main，包含 note-50 部署的 7644e408；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50）。

**內容（使用者看得到的）：**
- **#433（D110）**：設定 › 使用者與代理「邀請」一個人要填名字、email、角色，建立後顯示一次性的邀請連結（只在當下可複製，可「重新產生」讓舊連結失效，14 天到期）。對方從連結登入、而且 email 相符，才接手預先設好的角色與空間（`ACTOR_CLAIMED`），不再變成另一個只能檢視的帳號。註冊關閉時，只有帶有效連結的人能註冊。登入時不再每次覆寫名字（改名不會被蓋回）；第一次登入會記 `ACTOR_CREATED`。
- **Migration 119**：`actors` 新增 `invite_email`、`invite_token_hash`、`invite_expires_at`、`invite_used_at` 與兩個部分唯一索引；只加欄位，不改資料。在 120／122／123 之後補跑（runner 依檔名，`[migrate] applied 119_actor_invite_email`）。

**驗證（部署前）**：#433 合併 main 後後端全套 3357 過／5 略過（本機改用 yauzl 3.4.0）、前端全套 418 檔 3207 過；tsc、eslint 乾淨。worker 不變（`localDbWorker-DYQEwYIy.js`），無 `createElement`／micromark。

順序：打 tag `before-828ebae`（即 7644e408 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019073554`，checksum 通過）；build（`backups/build-828ebae.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 831（已刪除 470）、actors 2（邀請 0）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-e65e78f`、`before-6362b23` 與 release e65e78f1、6362b23c；保留 `before-828ebae`、`before-7644e40`、`before-c0af639`、release eafdc46e（nginx 掛載）、7644e408、c0af6398、KEEP 備份 `manual-20261017194806`。磁碟 66%→55%。

## 2026-10-19 D102 移動標籤一套檢查（含復原）、D105 新繼承只指向模組、D100 欄位名稱規則進寫入閘（#464）；沒有 migration

部署 **`d49f086e`**（main，包含 828ebae9；重建 backend 與 frontend，前端沒有變動；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50）。

**內容（使用者看得到的）：**
- **D102**：移動標籤、合併標籤、復原移動都走 `assertReparent`（放置權限、空間、種類、循環、標籤名稱、欄位衝突）。復原被擋時回 409 `state_conflict` 並帶 `reason`；同名標籤衝突不再是 500。復原移動需要對原上層有寫入權限。
- **D105**：`PUT /api/tags/:id/extends` 新的繼承目標必須是模組標籤；已存在的舊繼承保留。
- **D100**：欄位名稱規則放進標籤寫入閘（`insertTagRow`／`writeTagSchema`），標籤套件、AI 提議、模組範本都會檢查；資料庫匯入與備份還原保留原名。兩個 PATCH 路由共用 `patchTagSchema`。

**驗證（部署前）**：#464 合併 main 後後端全套 3375 過／5 略過（乾淨 DB、yauzl 3.4.0）；tsc、eslint 乾淨。worker 不變。

順序：打 tag `before-d49f086`（即 828ebae9 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019105945`，checksum 通過）；build（`backups/build-d49f086.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 831（已刪除 470）、node_attributes 2226；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-c0af639` 與 release c0af6398；保留 `before-d49f086`、`before-828ebae`、`before-7644e40`、release eafdc46e（nginx 掛載）、828ebae9、7644e408、KEEP 備份 `manual-20261017194806`。磁碟 55%。

## 2026-10-19 D106 人填的欄位一套判斷、D109 匯出保留上下層（#466）；沒有 migration

部署 **`66bc8c7a`**（main，包含 d49f086e；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50）。

**內容（使用者看得到的）：**
- **D106**：`isPersonAuthored` 一套判斷；新寫入一律 `ui`（不再寫 `explicit`）。集合、papers 填的欄位現在會匯出（例如 doi、authors），建立副本也會保留。
- **D109**：Markdown zip 匯出與完整備份依上下層分資料夾（父筆記＝`X/` 加旁邊的 `X.md`）；匯入讀 Obsidian folder-note，同時有 `X/` 與 `X.md` 合成一篇。git／GitHub 備份維持平放。

**驗證（部署前）**：#466 合併 main 後前端全套 418 檔 3207 過；後端全套 3394 過、2 失敗（`backupRestoreAdversarial` 兩個 D1 測試，note-50 確認在原本的 main 隨機順序下也會失敗，是共用 DB 的順序問題，單獨跑 16/16 過）；tsc、eslint 乾淨。新 worker `localDbWorker-CTfx9F_4.js`，無 `createElement`／micromark。

順序：打 tag `before-66bc8c7`（即 d49f086e 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019121308`，checksum 通過）；build（`backups/build-66bc8c7.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 831（已刪除 470）、node_attributes 2226；Chromium 開首頁無錯誤、`new Worker(...)` 正常。**完整備份**（在 backend 容器內以擁有者身分跑 `buildFullBackup`，暫存檔用完即刪）：1699 個項目、819 個 `.md`，其中 297 個在兩層以上的資料夾（例：`2area領域/資工主內容/演算法/1a二分搜尋法.md`），資料夾旁有同名 `.md`；`.onden/notes/*.json` 832 份。
清理：刪掉 `before-7644e40` 與 release 7644e408；保留 `before-66bc8c7`、`before-d49f086`、`before-828ebae`、release eafdc46e（nginx 掛載）、d49f086e、828ebae9、KEEP 備份 `manual-20261017194806`。

## 2026-10-19 釘到導覽列（#467）；migration 124

部署 **`8a82c1b7`**（main；基於 note-9e 部署的 66bc8c7a；重建 backend、frontend；nginx 掛 eafdc46e；**migration 124**）。由 note-50 部署（事前通知 note-9e）。

**內容：** 使用者核准「做，參考其他家」（Chrome／Logseq 釘選、Obsidian ribbon、Linear 自訂側欄、iOS tab bar 編輯）。每個人可以選哪些頁面直接放在導覽列：手機最多 3 個自選（筆記、捕捉、更多固定），滿了會問換掉哪一個；電腦用同一份順序、依寬度折進「更多 ▾」。入口：手機「更多」長按或「編輯」、電腦頂列右鍵、設定 › 你的帳號 › 導覽列（開關、拖曳、上移下移、恢復預設）、模組頁的「釘到導覽列」。沒編輯過的人版面完全不變。模組被移除後不留空位，重新引入不恢復釘選。
**migration 124 `actor_prefs`**：每人每 key 一列 jsonb（人刪除時連帶刪除）；路由 `GET/PUT /api/me/prefs/:key`，key 白名單只有 `nav`。前端先寫本機副本、離線可用，回線後補送，最後一次編輯為準。

順序：打 tag `before-8a82c1b`（即 66bc8c7a 的映像）；傳 release 並寫入 `REVISION`；`backup-vps.sh`（`/srv/onden/backups/manual-20261019122031`）；build（`backups/build-8a82c1b.log`；check-app-css 通過；worker `localDbWorker-CTfx9F_4.js` 85.3 KiB / 91.0 KiB，與上一版相同）。切 backend：`[migrate] applied 124_actor_prefs`，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁 200（切 frontend 後第一個請求 502，容器啟動中，數秒後連續 200）；`/api/site` 200；未登入 `/api/bootstrap`、`/api/me/prefs/nav` 401；`actor_prefs` 0 列；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 470／831 不變；backend 無 error。磁碟 56%。

## 2026-10-19 全部標籤：你的標籤／來自模組（#471）

部署 **`c276b8e3`**（main；基於 8a82c1b7；重建 backend、frontend，實際只動前端；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-9e，回覆可以）。

**內容：** 使用者核准的「標籤與模組」設計（設計畫布 p-tags）的第一半。「全部標籤」分成**你的標籤**（每列顯示組合了哪些功能，例如 #讀書 · 複習）與預設收合的**來自模組（N）**（以 `schema_module` 判斷，依模組分組；用過也留在這區）。沒有自己的標籤時顯示說明，不再列一排 0。「整理」多一條「N 個模組沒有任何標籤或筆記用到」，連到設定 › 模組。搜尋同時篩兩區。第二半（要用的地方順手匯入）另開 PR。

順序：打 tag `before-c276b8e`（即 8a82c1b7 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019124329`）；build（`backups/build-c276b8e.log`；check-app-css 通過；worker `localDbWorker-CTfx9F_4.js` 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；content_nodes 833（已刪除 472；部署前 831／470，多出的兩篇是使用者這段時間新增又刪除的，本次只動前端）；backend 無 error。

## 2026-10-19 用到才匯入（#474、#475）與任務查詢加速（#473）

部署 **`2c167275`**（main；基於 c276b8e3；重建 backend、frontend；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-9e，回覆可以）。

**內容：**
- **#474**：標籤頁「＋ 加功能」：已匯入的模組直接加上，未匯入的標「需要匯入」→「匯入並加上」先開確認框（它會加上什麼、能存取哪些筆記、連不連網；來自每個模組必填的 `library.manifest`），與設定走同一條 `PATCH /api/workspace/modules`（只有擁有者，伺服器測試 `moduleImportRoute.integration` 涵蓋 403／200），成功提示可「復原」。有自己頁面的模組在改過導覽列的人身上多一個「也釘到導覽列」（預設不勾）。
- **#475**：# 建議依序列出你的標籤、來自模組、需要匯入的模組標籤（非擁有者不列）、建立；順帶修 `workspaceTags` 沒傳進 MarkdownEditor 導致 # 選單一直是空的。設定 › 模組 分成「已匯入／可匯入」，每張卡寫附帶標籤；zh-TW 用語「引入／取消引入」統一為「匯入／移除」。
- **#473**：`tasksStore` 三個查詢由 `= ANY($2::uuid[])` 改為 `IN (SELECT unnest(...))`（5.8k 筆記時 1.9 s → 10 ms，bootstrap 與每次 sync 都用到）；`getNativeActor` 只找自己 workspace 的 System actor（只影響 dev／test）。
- 這推翻 2026-10-18「模組只在設定裡匯入」：設定是管理處，要用的地方也能順手匯入（使用者核准的「標籤與模組」設計）。

順序：打 tag `before-2c16727`（即 c276b8e3 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019130601`）；build（`backups/build-2c16727.log`；check-app-css 36 個樣式表通過；worker `localDbWorker-CTfx9F_4.js` 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 472／833 不變；backend 無 error。磁碟 65%。

## 2026-10-19 段落節點不再有開關（#477）

部署 **`c2001823`**（main；基於 2c167275；重建 backend、frontend；nginx 掛 eafdc46e；沒有新 migration，沒有回填）。由 note-50 部署（事前通知 note-9e，回覆可以）。

**內容：** 使用者決定「就是我產品本來的設定，不用有開關」：拿掉 `ONDEN_BLOCK_NODES`，段落節點（B1–B4：`{標籤}` 補全與標記、段落複習卡、`- [ ] … {任務}` 任務行、編輯器存檔補 `^id`）永遠開著。bootstrap 仍送 `features.block_nodes: true` 一個版本，給 service worker 留著的舊前端；之後可拿掉。
**對既有資料：** 啟動與 migration 都不做事；`block_nodes` 列與 `^id` 只在筆記存檔時建立。部署前唯讀掃描正式站：沒有 `#標籤 ^id` 區塊；3 篇筆記有以 `{…}` 結尾的行（程式碼區塊兩篇、Anki 填空一篇），用實際的 `parseBlocks` 跑過，三篇都不產生段落標籤，所以不會有筆記被改字。超過 32,000 字且有行以 `}` 或 `^id` 結尾的筆記：0 篇。

順序：打 tag `before-c200182`（即 2c167275 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019134453`）；build（`backups/build-c200182.log`；check-app-css 通過；worker `localDbWorker-Bc7ACkoE.js` 84.9 KiB / 91.0 KiB）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、新 worker 正常、IndexedDB 可開；已刪除的筆記 472／833 不變；`block_nodes` 0 列（等存檔才建立）；backend 無 error。

## 2026-10-19 「隱藏」只用在標籤（#468，D104）＋ #479；沒有 migration

部署 **`c21fb1a2`**（main，包含 note-50 部署的 c2001823 與 #479；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50，note-50 在 #468 上線前暫停前端合併）。

**內容（使用者看得到的）：**
- **#468**：隱藏只用在標籤。隱藏的標籤不出現在全部標籤（收在「來自模組」下方的「已隱藏」，可取消隱藏）、側欄、筆記上的 #晶片、`#` 建議（打完整名稱仍會建議）與公開網站；篩選、欄位、功能照常。筆記不能再隱藏（400 `only_tags_can_be_hidden`），側欄「已隱藏」群組與 `set_hidden` 規則移除（#task 完成不再自動隱藏、#archive 不再隱藏）。D104 解決：隱藏標籤底下的筆記照常列在側欄。
- **#479**：`ModuleImportConfirm.css` 不再用未定義的 `--onden-text-link`。

**資料步驟**：PR 預期要取消隱藏的 1 篇筆記，查證後是系統的 `Site Config`（`source_type = 'system'`、`#workspace-config`），應維持隱藏，所以**沒有做任何資料變更**。

**驗證（部署前）**：#468 合併 main（含 #471、#474、#475、#477）後前端全套 3268 過、1 失敗（`cssTokensDefined`，是 main 上 #474 的問題，#479 已修）；後端全套 3409 過、1 失敗（`importVaultBatches`，單獨跑 7/7 過，共用 DB 的順序問題）；tsc、eslint 乾淨。worker `localDbWorker-Bc7ACkoE.js` 不變。

順序：磁碟 81%，先 `docker builder prune` 並刪掉 `before-c276b8e`／`8a82c1b`／`66bc8c7`／`d49f086`／`828ebae` 與對應 release（→52%）；打 tag `before-c21fb1a`（即 c2001823 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019140833`，checksum 通過）；build（`backups/build-c21fb1a.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 835（已刪除 472）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
保留：`before-c21fb1a`、`before-c200182`、`before-2c16727`、release eafdc46e（nginx 掛載）、c2001823、2c167275、KEEP 備份 `manual-20261017194806`。

## 2026-10-19 全部標籤修正（#481）

部署 **`70718482`**（main；基於 note-9e 部署的 c21fb1a2；重建 backend、frontend，實際只動前端；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-9e）。

**內容：** 使用者在 iPad 上看 #471 覺得「好奇怪」：副標題說「4 個來自已匯入的模組」但其實只匯入 rss（那 4 個是已移除模組留下的標籤），寬螢幕上篇數離名稱很遠，「新增標籤」出現兩次。修正：「來自模組」只列已匯入模組的標籤（沒有就整區不出現、副標題不提模組）；已移除模組留下的標籤收進「整理」（「N 個標籤來自已移除的模組」→ 檢視：標籤、所屬模組、篇數、重新匯入；不刪任何東西）；隱藏的標籤只出現在「已隱藏」；內容一欄寬（`--ac-list-max: 720px`）、搜尋框有外框、只留一個「新增標籤」；沒有自己的標籤時只有一行「還沒有標籤。在筆記裡打 # 就會建立。」

順序：打 tag `before-7071848`（即 c21fb1a2 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019142513`）；build（`backups/build-7071848.log`；check-app-css 通過；worker `localDbWorker-Bc7ACkoE.js` 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200，未登入 `/api/bootstrap` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 472／835 不變；backend 無 error。磁碟 57%。

## 2026-10-19 D115 錯誤訊息一張表、D103 白板卡片格式鍵（#483）＋ note-50 的 #484 Postgres JIT 關閉；沒有 migration

部署 **`add003c3`**（main，包含 note-50 部署的 70718482；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50，note-50 請一併帶上 #484）。

**內容（使用者看得到的）：**
- **#483（D115）**：錯誤訊息只有 `serverErrors` 一張表，讀與寫出錯顯示同一句；「換了帳號」一律建議登回原帳號（待送的寫入只會用原帳號重送）；補上 42 個後端錯誤代碼的中英文；守門測試保證後端每個代碼都有訊息。
- **#483（D103）**：白板卡片的 ⌘B／⌘I 再按一次就取消（不再變成 `****x****`）；格式快捷鍵和主編輯器同一處定義。
- **#484（note-50）**：後端連線關掉 Postgres JIT。

**驗證（部署前）**：#483 合併 main 後前端全套 422 檔 3278 過；tsc、eslint 乾淨。worker `localDbWorker-Bc7ACkoE.js` 不變，無 `createElement`／micromark。

順序：打 tag `before-add003c`（即 70718482 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019145335`，checksum 通過）；build（`backups/build-add003c.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 835（已刪除 472）；Chromium 開首頁無錯誤、`new Worker(...)` 正常；後端連線 `SHOW jit` = `off`；擁有者完整備份（容器內 `buildFullBackup`）6.95 秒、36.8 MB，暫存檔已刪。
清理：刪掉 `before-c200182`、`before-2c16727` 與 release 2c167275、c2001823；保留 `before-add003c`、`before-7071848`、`before-c21fb1a`、release eafdc46e（nginx 掛載）、70718482、c21fb1a2、KEEP 備份 `manual-20261017194806`。

## 2026-10-19 筆記檢視：子筆記與標籤成員共用一套檢視（#485、#486）

部署 **`411217e4`**（main；基於 note-9e 部署的 add003c3；重建 backend、frontend；nginx 掛 eafdc46e；沒有新 migration）。由 note-50 部署（事前通知 note-9e，回覆可以）。

**內容：** 使用者問「為啥可以看到」：設定說「表格」未匯入，_Inbox 卻有「表格」鏡頭（筆記的子筆記表格，從沒跟模組綁）。使用者決定「兩種表格變成同一個東西」：
- **#485（後端）**：檢視仍存在 `content_nodes.collection_views`；標籤的檢視看成員，其他筆記的檢視看子筆記。新路由 `GET/POST /api/nodes/:id/views`、`PATCH/DELETE /api/nodes/:id/views/:viewId`、`…/exec`；讀需要筆記的讀取權（讀不到、不存在、標籤 id 都 404），改需要編輯權（空間檢視者 403）；隱藏的子筆記不列；改檢視不算修改筆記（`NOT_A_NOTE_CHANGE_SQL`）。設計寫在 `docs/architecture/views-as-modules.md`「檢視的來源」。
- **#486（前端）**：有子筆記的筆記在內容下方多「子筆記」區，分頁和標籤頁一樣（全部＋存的檢視，由檢視模組畫，可直接改值、分組、加總）；獨立的「表格」鏡頭拿掉（舊 `?lens=table` 開內容）；沒匯入的檢視模組不能建、已存的顯示「未匯入」；只有能編輯的人看得到「＋ 檢視」和「新增子筆記」。
- 獨立審查：9 個對抗測試（跨空間、刪除與隱藏子筆記、token 範圍、存在與否、跨型別、SQL 注入、事件可見性）都擋下，結論可以上線；兩個小問題已修。

順序：打 tag `before-411217e`（即 add003c3 的映像）；`backup-vps.sh`（`/srv/onden/backups/manual-20261019151649`）；build（`backups/build-411217e.log`；check-app-css 37 個樣式表通過；worker `localDbWorker-Bc7ACkoE.js` 不變）。切 backend，`/health` ok；切 frontend；`current` 指向新 release。
驗證：首頁、`/api/site` 200；未登入 `/api/bootstrap`、`/api/nodes/…/views` 401；Chromium 首頁無錯誤、worker 正常、IndexedDB 可開；已刪除的筆記 472／835 不變；backend 無 error。已知：幾個 e2e spec（`zzDeepCol09`、`stateGallery`、`navigationProportions`、`tour`、`designTagsD6`、`lens=table` 的 URL 檢查）還在找舊的表格鏡頭，待更新。

## 2026-10-19 D113 公開網站的查詢區塊改成發布當下存結果（#488）；沒有 migration

部署 **`dfdccaa5`**（main，包含 note-50 部署的 411217e4；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50，note-50 在 #488 上線前暫停碰 basesEval／runNodeQuery／MarkdownRenderer 的合併）。

**內容（使用者看得到的）：**
- **#488（D113）**：`onden-query`／`onden-base` 區塊在發布時由伺服器評估，存成靜態清單（最多 200 列、只列已發布的筆記）放進快照；公開網站和 zip／靜態頁畫這份結果，不再掛 app 元件、不再打 `/api/query`（匿名訪客不再看到 `{"error":"unauthorized"}`，擁有者也不會看到私人結果）。單篇 HTML 匯出在匯出當下以匯出者身分評估。`basesEval`／`basesParser`／查詢解析搬進 `@onden/markdown`，app 與伺服器共用；網站上 `file.modifiedBy`／`file.lastActor` 一律不成立，不透露誰編輯過。

**驗證（部署前）**：#488 合併 main（含 #485、#486）後 markdown 321 過、前端全套 423 檔 3293 過；後端全套 3428 過、1 失敗（`workspaceBoundary`：#485/#486 的 `noteViews.ts` 把 `workspace_id` 寫在 `OWNER_SQL` 常數裡，守門測試看不到；不是 #488，note-50 已在 #490 修好，這次部署不含 #490）；tsc、eslint 乾淨。worker `localDbWorker-Bc7ACkoE.js` 不變，無 `createElement`／micromark。

順序：打 tag `before-dfdccaa`（即 411217e4 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019154350`，checksum 通過）；build（`backups/build-dfdccaa.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200、`/api/site` 200；content_nodes 835（已刪除 472）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-7071848`、`before-c21fb1a` 與 release 70718482、c21fb1a2；保留 `before-dfdccaa`、`before-411217e`、`before-add003c`、release eafdc46e（nginx 掛載）、411217e4、add003c3、KEEP 備份 `manual-20261017194806`。

## 2026-10-20 D119 網站設計跟著同步、D112 筆記動作一處決定（#492、#493）＋ note-50 的 #490；沒有 migration

部署 **`b6e4de08`**（main，包含 dfdccaa5；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-9e 部署（事前通知 note-50，note-50 請一併帶上 #490）。

**內容（使用者看得到的）：**
- **#492（D119）**：`site_config` 與 `chrome` 隨同步 delta 送到其他分頁與裝置（`SITE_CONFIG_UPDATED`），本機鏡像一起更新；舊分頁存設計回 409 `design_stale` 並重新載入，不再蓋掉新的頁首；Studio 的發布與預覽一律用伺服器上存下的設計草稿。
- **#493（D112）**：筆記能做的動作由 `noteActionList` 一處決定，右鍵選單（側欄與白板）、標題 ⋯、⌘K、側欄刪除按鈕都從它畫；檢視者不再看到會被拒絕的改名／移動／刪除；「做成簡報」只在白板、「使用技能」離線時不出現、「合併」需要有子筆記。
- **#490（note-50）**：`noteViews.ts` 的查詢把 `workspace_id` 寫在語句裡（守門測試），行為不變。

**驗證（部署前）**：#492 前端全套 3302 過、後端 3432 過（1 個已知順序問題，單獨 7/7 過）；#493 合併 #492 後前端全套 427 檔 3326 過；tsc、eslint 乾淨。新 worker `localDbWorker-CeIwtHP5.js`（87 KB），無 `createElement`／micromark。

順序：打 tag `before-b6e4de0`（即 dfdccaa5 的映像）；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261019165354`，checksum 通過）；build（`backups/build-b6e4de0.log`）。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；content_nodes 835（已刪除 472）；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：刪掉 `before-add003c` 與 release add003c3；保留 `before-b6e4de0`、`before-dfdccaa`、`before-411217e`、release eafdc46e（nginx 掛載）、dfdccaa5、411217e4、KEEP 備份 `manual-20261017194806`。

## 2026-10-20 空白筆記貼截圖卡死修正（#495）；沒有 migration

部署 **`8daee495`**（main，b6e4de08 + #495；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-f8 部署（使用者 10/20 恢復所有工作；note-9e、note-82 已不在線，事前通知 note-3f，對方確認沒有部署進行中）。

**內容（使用者看得到的）：**
- **#495**：在空白筆記貼上截圖（Android 鍵盤剪貼簿，Brave／Chrome 安裝的網頁 App）會插入 `\n![…](…)\n`，筆記以空行開頭；`blocks.ts` 的 `mayHaveBlocks`／`existingIds` 往回掃行時 `lastIndexOf("\n", -1)` 從 0 找到第一個換行，永遠走不到第 0 行，頁面 CPU 100% 卡死、存檔沒送出。後端存檔也跑同一段，經 API 送進這種內容會卡住後端。8 處行首計算改用 `lineStartAt`。

**驗證（部署前）**：markdown 套件 323 過（新測試在修正前會卡到 `timeout 60`），`tsc --noEmit` 乾淨；本機 e2e 環境（Pixel 5 視窗）空白筆記插入圖片：修正前主執行緒卡死，修正後存檔正常。手機上用 adb 接 DevTools 確認原本的現象（渲染程序 CPU 100%，`Debugger.enable` 無回應）。

順序：打 tag `before-8daee49`（即 b6e4de08 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261020091622`，checksum 通過）；build（`backups/build-8daee49.log`，`check-app-css: 37 reachable stylesheets cover the app's classes.`）；`up -d --no-deps backend frontend`。
插曲：一開始誤把執行中映像打成 `before-b6e4de0`，蓋掉了指向 dfdccaa5 映像的同名 tag；已用懸空映像（10/19 23:45／23:46 建置的 499e709e／98a741ac）還原，四組 `before-*` 都通過 `docker create`。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：沒有清（磁碟 57%）；保留 `before-8daee49`、`before-b6e4de0`、`before-dfdccaa`、`before-411217e`、release eafdc46e（nginx 掛載）、b6e4de08、dfdccaa5、411217e4、KEEP 備份 `manual-20261017194806`。

## 2026-10-20 D101 上層規則一處決定、D99 彈窗都用 ui/Modal（#497、#498）；沒有 migration

部署 **`452460a2`**（main，8daee495 + #497 + #498；重建 backend 與 frontend；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-f8 部署（事前通知 note-3f，對方確認沒有部署進行中）。兩個 PR 由本機 agent 依規格實作，note-f8 審查與驗收。

**內容（使用者看得到的）：**
- **#497（D101）**：「誰能當上層」由 `lib/data/placement.ts` 的 `placementRefusal`／`canPlaceUnder`／`placementCandidates` 一處決定，移到…、側欄拖曳、釘選（改用選單，不再 `window.prompt`）、快速記錄（不能放就記到今天的筆記或最上層）、白板父子連線都問它；伺服器 `createPointer` 也呼叫 `assertParentKind`（釘到標籤下回 409 `parent_kind_mismatch`）。
- **#498（D99）**：版本歷史、還原預覽、指令面板、快速記錄、網站新頁面都改用 `ui/Modal`；版本歷史裡 ⌘K 的指令面板疊在上面、Esc 只關最上層、彈窗開著時頁面快捷鍵不觸發；新 lint 規則 `modals-through-ui-modal`。

**驗證（部署前）**：#497 前端全套 3353 過、後端相關整合 56 過；#498 前端全套 3343 過；合併後重疊部分（QuickCapture、placement、modal、palette、sidebar drag、ContextMenu）97 過、tsc 乾淨。本機 e2e：#497 列出的 11 個 spec 27 過 4 失敗，#498 列出的 17 個 spec 39 過 4 失敗；失敗的都在 main（4d9f4cc5）上同樣失敗（interactions 的 Table lens、navigationMenuParity ×2、virtSidebar、coreJourney、historyJourney、zzDeepHist04、mobileEditor），另開 agent 修。

順序：打 tag `before-452460a`（即 8daee495 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261020103735`，checksum 通過）；build（`backups/build-452460a.log`，`check-app-css: 37 reachable stylesheets cover the app's classes.`）；`up -d --no-deps backend frontend`。
切換後健康檢查 `{"ok":true}`；`current` 指向新 release；backend 無 error。
驗證：首頁 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理（使用者先前同意「保留最近 3 次」）：刪掉 `before-dfdccaa`、`before-411217e` 與 release dfdccaa5、411217e4；磁碟 68% → 63%。保留 `before-452460a`、`before-8daee49`、`before-b6e4de0`（都通過 `docker create`）、release eafdc46e（nginx 掛載）、b6e4de08、8daee495、KEEP 備份 `manual-20261017194806`。

---

部署 **`e9aef547`**（main，452460a2 + #500 #502 #503 #504 #505 #506；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-3f 部署（事前通知 note-f8）。#500 #502 #503 #504 由雲端代理實作，#505 由本機代理實作，#506 由 note-3f 實作；都由 note-3f 審查與驗收。

**內容（使用者看得到的）：**
- **#500**：發布站搜尋視窗改用 `ui/Modal`（原生 dialog）：焦點限制在視窗內、背景不能點也不能捲、Esc 關閉後焦點回到開啟它的按鈕；`Modal` 新增 `inline`，讓視窗留在 `.site-root` 裡保住站台主題。
- **#502**：發布站手機導覽抽屜（≤900px）改成 modal，抽屜內有 ✕；寬螢幕側欄不變。
- **#503（D117）**：多值屬性有單一編解碼器（`@onden/markdown` 的 `attributeValues`／`encodeValues`）：many 欄位逐元素驗證、relation 清單選取是加入、`eq`／`ne` 比對元素、看板與分組依元素（一張卡可在多欄）。
- **#504（墨跡 T1-0）**：墨跡格式地基：未知工具、形狀種類與欄位原樣保留（parse／serialize／merge）；`features`／`requires` 規則，`requires` 有不認得的功能就唯讀、不存檔；`inkToSvg` 畫出矩形／圓／箭頭。這一版不寫 `features`／`requires`，現有資料不受影響。
- **#505（D98）**：畫布歸屬跟著增量同步與本機 mirror（新 mirror 表 `canvas_memberships`、`graph_positions`），拖進畫布立刻出現在「出現在哪些畫布」；用畫布路由新增或改名的畫布現在也會同步到其他裝置。
- **#506**：read gate 補上 `services/pointers.ts`（#497 起 `readGuard` 測試在 main 上失敗）。

**驗證（部署前）**：
- #500 #502 #503 #505 合成一個分支：後端全套 3448 過（失敗 2：`readGuard` 由 #506 修、`mediaOwnerClaims` 全套逾時單獨 7/7 過）；前端全套 3412 過、tsc、eslint、build 通過。e2e（23 個 spec，chromium＋mobile-chrome，台北時區）43 過 5 失敗；5 個在 main b4d2a376 上同樣失敗（siteComponents:18 搜尋 tag 也找到 Garden hub、siteComponents:150、composition braid 1／3、tagViewTabs:15）。瀏覽器檢查兩個 modal：`dialog:modal`、有名稱、焦點在內、Tab 不外漏、背景捲不動、關閉後焦點回去。
- #504 合進 main 後：後端全套 3449 過（失敗 1：`mediaOwnerClaims` 逾時）；前端全套 3424 過、build 通過。墨跡 e2e（7 個 spec）每輪失敗的都不同（inkCanvas:58、offlineHandwriting:138 單獨重跑 3/3 過；序列重跑時換 inkCanvas:262 失敗，main 上本來就不穩）。

順序：打 tag `before-e9aef54`（即 452460a2 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261020233737`，checksum 通過）；build（`backups/build-e9aef54.log`，`check-app-css: 37 reachable stylesheets cover the app's classes.`，worker `localDbWorker-C4qo-eTk.js` 87.8 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release。
切換後 backend `/health` `{"ok":true}`；首頁 200、`/site/` 200；Chromium 開首頁無錯誤、worker 檔 200、`new Worker(...)` 正常。
清理：沒有做（刪除 `before-b6e4de0` 與 release b6e4de08 被權限擋下，留給使用者決定）。目前保留 `before-e9aef54`、`before-452460a`、`before-8daee49`、`before-b6e4de0`、release eafdc46e（nginx 掛載）、452460a2、8daee495、b6e4de08；磁碟 67%。

---

部署 **`dc6a4c52`**（main，e9aef547 + #508 #509 #510 #511 #512；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-3f 部署（事前通知 note-f8，對方確認沒有部署進行中）。

**內容（使用者看得到的）：**
- **#511（墨跡 T1-1）**：手寫頁手指／筆分工與縮放。偵測到筆後一指捲動（有慣性）、兩指縮放；沒筆時一指畫、第二指放下會取消進行中的筆畫；兩指點一下復原、三指點一下重做；防手掌。縮放 0.5×–4×，以手指中點或游標為中心，比例標籤點一下回到適寬；儲存格式不變。畫布改成可視範圍大小（長手寫頁不再超過 iOS Safari 的畫布上限）。觸控裝置的工具列有 ✋／✏️（裝置層級設定）。白板在筆模式下用同一套手指規則；PDF 不變。
- **#510**：沒有日期欄位的行事曆視圖改用 `updated_at` 時，backend 現在送 ISO 8601，行事曆不再整個空白。
- **#509**：outbox 的重新排入依 bigint id 排序（原本依文字）。
- #508、#512 只改測試（backend 測試隨機順序、測試各用自己的 workspace）。

**驗證（部署前）**：main dc6a4c52 前端全套 3464 過、tsc（前後端）通過、build 通過。#511 的 `inkTouch.spec.ts` 在 chromium、mobile-chrome、webkit、mobile-safari 各 9/9（webkit 兩者在 Playwright docker image 跑，用合成觸控事件）；既有墨跡 e2e 只有 inkCanvas:262（main 上本來就不穩）失敗。#510 的 3 個 spec 檔 `--workers=1 --repeat-each=3` 33 過。#508／#512：backend 全套多組 seed 全過（#512 的 seed 111 有一個 outboxDelivery 測試失敗，檔內順序問題，另開處理）。

順序：打 tag `before-dc6a4c5`（即 e9aef547 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261021044856`，checksum 通過）；build（`backups/build-dc6a4c5.log`，check-app-css 37 個樣式表通過，worker `localDbWorker-C4qo-eTk.js` 87.8 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release。
切換後 backend `/health` `{"ok":true}`；首頁 200、`/site/` 200；Chromium 開首頁無錯誤、`new Worker(...)` 正常。
清理：沒有做（刪舊回滾被權限擋下，留給使用者）。保留 `before-dc6a4c5`、`before-e9aef54`、`before-452460a`、`before-8daee49`、`before-b6e4de0`。

---

部署 **`b4980229`**（main，dc6a4c52 + #514 #515 #516 #517；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-c0 部署（事前確認沒有其他 session 在跑；使用者在對話中說「部署」）。

**內容（使用者看得到的）：**
- **#516**：`GET /api/nodes/search` 結果含長筆記時，`snippetPlainText` 逐字 `out += ch` 落入 V8 慢路徑，後端事件迴圈卡住 17–25 秒（所有使用者都被擋住）；改成收集片段最後 join，同樣資料 28–54 ms。
- **#517**：筆記標題區在中等寬度（901px、資訊欄開著，中欄約 297px）不再把「分享／⋯／已儲存」擠到第二行：>900px 時標題列是標題輸入框＋操作列，空間／編輯時間／字數放在下一行、佔滿整欄；標題列寬度 < 360px 時「分享」只顯示圖示（文字保留為無障礙名稱）。901px 標題到正文 220 → 170px；1024px 以上 148px；手機排版不變。
- #514 只改測試，#515 是效能報告文件。

**驗證（部署前）**：#517 合併 main 後：前端全套 441 檔 3464 過、tsc、eslint、build 通過；本機 e2e（chromium＋mobile-chrome）navigationProportions 的 901px 通過、zzDeepUx03／zzDeepUx04b 通過。仍失敗但不是 #517 造成：navigationProportions 手機 390／320 英文 260.8px（上限 260，main 上原本更高）、obsidianBasics 與 titleTagRow（資訊欄的 Tags 也渲染 `TitleTagRow`，兩個 `.title-tag-row`）、zzDeepNote12（指令面板合併子筆記停用）。#516 的驗證見 PR。

插曲：note-3f 先前要部署 c3288b6a（#516），只做到打 tag `before-c3288b6` 與上傳 release，沒有備份、build、切換；這次確認該 tag 與執行中映像、latest 是同一個（dc6a4c52），改名為 `before-b498022`。

順序：打 tag `before-b498022`（即 dc6a4c52 的映像，移除重複的 `before-c3288b6`）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261021160855`，checksum 通過）；build（`backups/build-b498022.log`，check-app-css 37 個樣式表通過，worker `localDbWorker-DZdKO3Bf.js` 87.9 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release（16:12 UTC）。
切換後 backend `/health` `{"ok":true}`、紀錄無 error；首頁 200、`/site/` 200；Chromium 開首頁無錯誤、worker 檔 200、`new Worker(...)` 正常。
清理：沒有做（刪 `before-452460a`、release 452460a2 與沒用到的 release c3288b6a 被權限擋下，留給使用者）。保留 `before-b498022`、`before-dc6a4c5`、`before-e9aef54`、`before-452460a`；release eafdc46e（nginx 掛載）、b4980229、dc6a4c52、e9aef547、452460a2、c3288b6a；磁碟 62%。

---

部署 **`be4832fe`**（main，b4980229 + #518 #519 #520；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-c0 部署（使用者在對話中說「部署」；沒有其他 Onden 部署進行中）。

**內容（使用者看得到的）：**
- **#520**：筆記編輯器的儲存狀態只在出問題時顯示。平常打字不再出現「儲存」按鈕、「保存中…」、「已儲存」；離線顯示「等待同步」，被拒絕顯示「重試保存」，最後一次編輯後 5 秒仍沒存好才顯示「保存中…」。操作列寬度打字時不變。
- **#519**：手機筆記標題下的「› 標籤」和標籤／「＋ 標籤」排在同一行（放不下才換行），英文手機版標題到正文 260.8 → 232.8px；另修 4 個過期 e2e。
- #518 是上一次部署的紀錄。

**驗證（部署前）**：#520 本機 e2e：連續打字 8 秒沒有任何提示、操作列寬度不變；離線顯示「Waiting to sync」，恢復連線後消失且伺服器有離線編輯；navigationProportions、zzAuditSave、zzDeepData07、zzDeepCol05、mobileEditor、obsidianBasics 15 過 2 略過；單元 12 過、tsc 通過。#519 見 PR（4 個目標 spec 各跑兩次通過，回歸組 19 過；vitest、tsc、eslint、build 通過）。

順序：打 tag `before-be4832f`（即 b4980229 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261021192752`，checksum 通過）；build（`backups/build-be4832f.log`，check-app-css 37 個樣式表通過，worker `localDbWorker-DZdKO3Bf.js` 87.9 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release（19:31 UTC）。
切換後 backend `/health` `{"ok":true}`、紀錄無 error；首頁 200、`/site/` 200；Chromium 開首頁無錯誤、worker 檔 200、`new Worker(...)` 正常。
清理：沒有做。保留 `before-be4832f`、`before-b498022`、`before-dc6a4c5`、`before-e9aef54`、`before-452460a`；release eafdc46e（nginx 掛載）、be4832fe、b4980229、dc6a4c52、e9aef547、452460a2、c3288b6a（沒用過）；磁碟約 76%，照「保留最近 3 次」該刪的舊回滾點等使用者決定。

部署 **`2577c635`**（main，be4832fe + #521 #522 #525；只動前端，只重建 frontend；沒有 migration；backend 與 nginx 沒有重建，nginx 仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-c0 部署（使用者在對話中說「部署」，同時視為 #525 截圖的同意）。

**內容（使用者看得到的）：**
- **#521**：筆記標題下只剩一列標籤；點標籤展開卡片（卡片名稱進標籤頁），手機上標籤維持原本大小，觸控範圍用看不見的 44px 區域補足。
- **#522**：手機麵包屑停在父筆記，不再重複目前這篇的標題。
- **#525**：手機筆記標題區安靜化。分享和 ⋯ 移到最上面固定列的右側；「圖片／顯示／編輯｜預覽」整列收進 ⋯（最上面是預覽／編輯、圖片、寫作模式）；寫作模式仍顯示工具列。390px 寬時正文起點 231 → 144px，390 與 320px 都沒有橫向捲動。

**驗證（部署前）**：#525 本機 e2e navigationProportions 10 過、其他工具列與手機編輯 spec 13 過、crossbrowser mobile-chrome 5 過；vitest 31 過、tsc、eslint、build 通過。#521 #522 見各自 PR。

順序：打 tag `before-be4832f`（即 be4832fe 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261022041946`，checksum 通過）；build frontend（`backups/build-2577c63.log`，worker `localDbWorker-DZdKO3Bf.js` 87.9 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build frontend`；`current` 指向新 release（04:22 UTC）。
切換後 backend `/health` `{"ok":true}`、紀錄無 error；首頁、`/?view=tasks`、`/api/site` 200，未登入 bootstrap 401；Chromium 開首頁無錯誤；新樣式 `note-actions-phone-only` 在 `OverviewEditorHost.*.css`。
清理：沒有做。磁碟升到約 82%；回滾點 `before-be4832f`、`before-b498022`、`before-dc6a4c5`、`before-e9aef54`、`before-452460a` 與對應 release、沒用過的 c3288b6a 都還在，等使用者決定。

---

部署 **`a11a4f19`**（main，2577c635 + #523 #526 #527 #528 #529 #531 #537；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-c0 部署（使用者在對話中說「都部署」；沒有其他 Onden 部署進行中）。

**內容（使用者看得到的）：**
- **#529**：編輯器裡可以跟著連結走（閱讀時點一下、Ctrl／Cmd＋點、編輯時的「開啟」小按鈕）。#525 已把手機的編輯／預覽切換收進 ⋯，這次補上對應的跳轉機制。
- **#528**：區塊、段落、整篇筆記的嵌入在編輯器與預覽都顯示。
- **#527**：手機工具列的 ¶ 段落選單。
- **#526**：`[[筆記#標題]]`、`[[筆記#^id]]` 連到段落。
- **#523**：技能存成檔案與匯入。
- **#531**：標籤頁「編輯結構」的功能開關點了立刻切換。
- **#537**：手機筆記頁頂部不再只剩一個「內容」分頁。

**驗證（部署前）**：各 PR 的本機 e2e 與截圖見各自 PR。

順序：打 tag `before-2577c63`（即 2577c635 的映像）；傳 release（`git archive` 經 ssh）；`backup-vps.sh`（`/srv/onden/backups/manual-20261022155559`，checksum 通過）；build backend frontend（`backups/build-a11a4f1.log`，check-app-css 36 個樣式表通過，worker `localDbWorker-DZdKO3Bf.js` 87.9 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release（15:59 UTC）。
切換後 backend `/health` `{"ok":true}`、紀錄無 error；首頁、`/?view=tasks`、`/site/`、`/api/site` 200，未登入 bootstrap 401；Chromium 開首頁無錯誤；`md-link-chip` 在 `OverviewEditorHost.*.js/css`。
清理：沒有做。磁碟升到 87%（剩 7.7G）；回滾點 `before-2577c63`、`before-be4832f`、`before-b498022`、`before-dc6a4c5`、`before-e9aef54`、`before-452460a` 與對應 release 都還在，等使用者決定。

---

部署 **`e60badac`**（main，a11a4f19 + #539 #546 #547，另含只改測試的 #534 #535 #536 #538 與紀錄 #544；重建 backend 與 frontend；沒有 migration；nginx 沒有重建，仍掛載 `releases/eafdc46e…/docker/nginx/nginx.conf`）。由 note-c0 部署（使用者在對話中說「都部署」）。

**內容（使用者看得到的）：**
- **#539**：指令面板搜尋只轉換命中附近的內文（20k 筆記：「演算法 期中」約 290 → 130 ms，「筆記 42」約 255 → 50 ms），標題完全相同或開頭相同的排第一（側欄本機搜尋與伺服器搜尋都是）。
- **#546**：手機筆記頁往下捲時，頂部「‹ 筆記」不再被捲走（`.app-shell` 改 `overflow-x: clip`）。
- **#547**：內文只有一行 `![[…]]` 的筆記，沒點進編輯器前也顯示嵌入（圖或段落）。

**驗證（部署前）**：#539 後端完整整合測試 409 檔 3458 過、markdown 404 過，20k 快照實測如上；#546、#547 本機手機模擬重現與修正、相關 e2e 見各 PR。

順序：打 tag `before-a11a4f1`；傳 release；`backup-vps.sh`（`/srv/onden/backups/manual-20261022175847`，checksum 通過）；build backend frontend（`backups/build-e60bada.log`，worker `localDbWorker-Br-NGLl1.js` 89.4 KiB／預算 91.0 KiB）；`up -d --no-deps --no-build backend frontend`；`current` 指向新 release（18:01 UTC）。
切換後 backend `/health` `{"ok":true}`、紀錄無 error；首頁、`/?view=tasks`、`/site/`、`/api/site` 200，未登入 bootstrap 401；Chromium 開首頁無錯誤。
注意：worker 已到 89.4／91.0 KiB，下一個加進 worker 的改動可能超出預算。清理：沒有做，磁碟 87%（剩 7.4G）。
