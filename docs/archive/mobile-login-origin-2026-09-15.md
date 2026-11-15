# 手機登入問題：部署來源與版本核對

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-15。接續使用者回報手機出現錯誤或一直載入，提供網址 `http://localhost/`。
尚未確認是實體手機或電腦的手機尺寸模式，也尚未取得畫面上的錯誤原文。
因此以下區分已重現的部署缺陷與仍待確認的使用者情境，不將本次診斷宣稱為真機修復完成。

## 已取得的證據

- 此機器的 80 埠提供 Onden，8080 是 OmniTools，之前測試用 5099 未開啟。
  localhost 與 `192.168.173.28` 的登入頁均可載入，檢查當時 console 無 error。
  未登入 `GET /api/auth/get-session` 為 `200 null`。
- 對正在運行的部署使用不存在的診斷帳號，各來源一次 POST；沒有使用使用者帳密，沒有建立帳號或 session。

| 請求 Host／Origin | 結果 |
| --- | --- |
| `localhost`／`http://localhost` | 401 `INVALID_EMAIL_OR_PASSWORD`，已進入帳密驗證 |
| `192.168.173.28`／`http://192.168.173.28` | 403 `INVALID_ORIGIN`，來源拒絕 |
| `100.124.155.2`／`http://100.124.155.2` | 403 `INVALID_ORIGIN`，來源拒絕 |

- 前端公開入口 `/_astro/AppRoot.70MjpCxk.js` 仍含 `user-dropdown`，沒有新 `account-panel` 或
  `mobile-sync-strip`。正在運行的是第二十一批之前的前端；工作區編譯不會更新 Docker image。
- Docker socket 存取被 OS 權限拒絕，`sudo -n` 要求密碼。這是本機管理權限限制，
  不是 automatic approval review 拒絕。沒有修改容器、變更允許來源或重啟正式服務。

空白 JSON 會先得到 body validation 400，不能拿它判定 origin 已允許；上表以格式有效的
不存在帳號取得實際來源核對結果。若是實體手機，localhost 指向手機自身，不是這台電腦。

## 工作區修改

- LoginGate 對登入、註冊與社群登入的 `INVALID_ORIGIN` 共用一份說明，顯示目前 origin，
  引導使用既有允許網址或請管理者開放；保留輸入、拒絕掛載私人工作區並可再試。
- `.env.example` 說明 `APP_URL` 同時影響 auth 基準網址與預設允許來源，`CORS_ORIGIN`
  可明列多個需要的 origin。保留精確來源檢查，不自動信任任意 Host／Origin，也不使用 `*`。
- 這些改動改善診斷，不會自行解除正在運行部署的來源限制。

## 套用部署時的範圍

在確認手機實際使用的網址後，由部署原本的設定來源維護，例如需要同時允許本機與目前區網位址時：

```dotenv
APP_URL=http://192.168.173.28
CORS_ORIGIN=http://localhost,http://192.168.173.28
```

這是本次機器的範例，不是所有部署的預設值。若使用其他 hostname、HTTPS 或非預設 port，
必須填實際 origin；如需 Tailscale，另明列確認要使用的網址。
不能覆寫既有 PostgreSQL 密碼、auth secret 或其他設定，不能新建一份不完整 `.env` 代替原部署設定。

更新 Compose 環境值後需重新建立 backend，單純 restart 不會載入新環境；新前端需重新建置並更新 image。
目前沒有取得原部署管理權限與完整非機密啟動方式，未提供可能丟失原設定的強制重建指令。

## 驗證

新增 3 案涵蓋 email 登入／註冊及社群登入的來源拒絕，保留輸入與恢復按鈕；
相關 4 檔／28 案、TypeScript、lint、建置通過，退出碼均為 0。
暫時前端 5101 代理現行部署 API；以不存在的診斷帳號重現 403，顯示指出目前 origin 的中文訊息。
390×844／320×568 截圖確認原輸入仍顯示、登入可重試；320px document scrollWidth 為 320，無橫向溢出。
診斷分頁與 viewport 已清理。紀錄位於 `/tmp/onden-mobile-origin-{tests,tsc,lint,build}.log`。
未重跑全後端或全前端，也未宣稱登入有效帳號成功、真機通過或已完成部署。

## Tailscale 固定網址方向

使用者追加詢問如何避免 Tailscale IP 問題。唯讀 `tailscale status` 確認本機名稱為
`aurora.tail9249f1.ts.net`，`tailscale serve status` 為 `No serve config`。
尚未啟用 Serve、變更 tailnet 設定或取得此主機的 HTTPS 憑證。

建議將完整 MagicDNS 名稱作為單一入口，使用 Serve 的 HTTPS 代理本機 80 埠：

```sh
sudo tailscale serve --bg http://127.0.0.1:80
```

如果 tailnet 尚未啟用 HTTPS，依 CLI 提供的官方設定流程完成。再於原部署設定來源套用：

```dotenv
APP_URL=https://aurora.tail9249f1.ts.net
CORS_ORIGIN=https://aurora.tail9249f1.ts.net
```

兩端連上有存取權限的 Tailscale 網路後，電腦／手機均使用該完整 HTTPS 網址。
MagicDNS 名稱取決於 machine name／tailnet name，改名後仍需更新配置；並非永久不變的識別。
Serve 僅供 tailnet 內的可授權裝置存取。登入服務的來源核對仍保留，換成 hostname 本身不會解除 403。

換 origin 也代表不同瀏覽器儲存位置；原網址尚未同步／未保存的輸入不會自動搬到新網址，
切換前須完成原有保存與同步，不刪除舊網站資料。

依據：[MagicDNS](https://tailscale.com/docs/features/magicdns)、
[Serve CLI：HTTPS、背景執行與狀態](https://tailscale.com/docs/reference/tailscale-cli/serve)，查閱於 2026-09-15。

## 依使用者要求直接允許 Tailscale IP

使用者選擇較簡單的 IP 方式並要求直接修改。系統授權讀取 container labels 後，確認正式 Compose
project 為 `onden`，working directory 就是本 repository，config file 為 `compose.yaml`。
現有 `CORS_ORIGIN` 與 `BETTER_AUTH_URL` 均為 `http://localhost`；沒有找到本機 `.env`。

已新增僅供本機的 `compose.override.yaml`，自動加入 `http://100.124.155.2`，保留原有
`CORS_ORIGIN`／`APP_URL` 預設，並將該本機檔案列入 `.gitignore`。沒有猜測或重設資料庫密碼。
用非機密驗證環境比較 Compose 合併前後 JSON，確認只有 backend 的 CORS_ORIGIN 改變，
另一個既有自訂 origin 也能保留；`git diff --check` 通過。

第二次系統管理授權回 `Not authorized`，已請使用者確認是否重開系統驗證視窗。
目前設定檔已修改，執行中的後端是否套用另以下方結果記錄為準，不以檔案存在視為已完成登入修復。

### 已套用並驗證

使用者同意重開系統驗證後，管理授權成功。從現行 backend／postgres 的環境值在記憶體內組合
Compose 所需設定，沒有輸出或另存憑證。先確認合併後 backend environment 只有 CORS_ORIGIN
變動，以及既有 image tag 對應的 digest 未改，才用 `--no-deps --no-build --pull never` 重建 backend。
重建後核對 image digest 相同，完整 environment 除新增來源外與原容器一致；未重建 postgres 或 frontend。

現行部署的實測結果：

| Origin | 套用後結果 |
| --- | --- |
| `http://localhost` | 401 `INVALID_EMAIL_OR_PASSWORD` |
| `http://100.124.155.2` | 401 `INVALID_EMAIL_OR_PASSWORD`，原 403 已解除 |
| `http://untrusted.example.invalid` | 403 `INVALID_ORIGIN`，仍拒絕未允許來源 |

仍以不存在的診斷帳號測試，不使用使用者憑證、不建立 session；401 在此代表已通過來源核對並進入
正常帳密驗證，不是有效帳號登入成功的證據。`GET http://100.124.155.2/` 回 200。
手機須連上可存取本機的 Tailscale 網路，再用該網址登入；LAN IP 尚未加入允許清單。

本機 `compose.override.yaml` 已由 `.gitignore` 排除，不將這台機器的 Tailscale IP 變成全專案預設。
預設 `docker compose` 會自動讀取它；若未來明確用 `-f compose.yaml`，需一併包含本機 override。
此次只解除登入來源限制，尚未更新先前修復的前端 image；GAP-23 的部署版本缺口仍保留。
