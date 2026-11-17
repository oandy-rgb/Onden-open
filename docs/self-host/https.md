# 自架 Onden 的 HTTPS

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：docker/nginx/nginx.conf, docker/caddy/Caddyfile, packages/backend/src/authClientIp.ts, scripts/test-real-ip.sh

手機、安裝成 App（PWA）、離線模式、剪貼簿，只有在 **https://** 網址（或 `localhost`）下才能用。
用 `http://192.168…` 或 `http://你的網域` 開，網頁看起來正常，但這些功能會悄悄失效。
下面三條路挑一條；不確定就選第一條。**不照做也不影響原本的用法**：預設仍是 nginx 聽 `APP_PORT`（預設 80）的 http。

| 你的情況 | 走哪條 |
| --- | --- |
| 有自己的網域、主機能從網際網路連到 80 與 443 | [路 1：內建自動憑證](#路-1內建自動憑證caddy) |
| 主機裝了 Tailscale，只有你和你的裝置要用 | [路 2：Tailscale](#路-2tailscale) |
| 前面已有 nginx／Traefik／Cloudflare Tunnel | [路 3：已有反向代理](#路-3已經有反向代理) |

## 路 1：內建自動憑證（Caddy）

Onden 附一個選用的 Caddy：向 Let's Encrypt 免費申請憑證、到期自動更新、存在 Docker volume（`caddy_data`），重啟不會重新申請。

事先要有：一個網域（例如 `onden.example.com`）的 DNS 已指向這台主機；主機防火牆開 80 與 443（Let's Encrypt 要從 80 驗證）。

1. 編輯 `.env`（沒有就 `cp .env.example .env`），改這幾行：
   ```
   ONDEN_DOMAIN=onden.example.com
   ONDEN_ACME_EMAIL=you@example.com
   APP_URL=https://onden.example.com
   APP_PORT=127.0.0.1:8080
   ```
   `APP_URL` 一定要是 `https://` 加同一個網域：登入的允許來源（`CORS_ORIGIN`、better-auth 的 trusted origins）預設跟著它走，不用另外設。
   `APP_PORT` 要換掉，因為 80 被 Caddy 佔了；`127.0.0.1:` 讓 nginx 的 http 只有主機自己看得到。
2. 啟動：`docker compose --profile https up -d`
   （以前用 `docker compose up -d` 啟動的，之後每次都要帶 `--profile https`；backend 會因 `APP_URL` 改變而重建。）
3. 等約一分鐘，看憑證有沒有拿到：`docker compose logs caddy | grep -i "certificate obtained"`。

**怎麼確認成功**
- 瀏覽器開 `https://onden.example.com`，網址列有鎖頭，點開能看到憑證由 Let's Encrypt 簽發。
- 登入能成功；用 `http://onden.example.com` 開會被自動轉到 https。
- 手機（Chrome／Safari）開同一個網址：選單出現「安裝應用程式」／「加入主畫面」，裝完能從桌面開啟。

**常見問題**
- 拿不到憑證：`docker compose logs caddy` 看原因。多半是 DNS 還沒生效、80／443 被防火牆或雲端安全群組擋住、或網域打錯。
- 登入出現 `INVALID_ORIGIN`：`.env` 的 `APP_URL` 和網址列不一致（含 `https`、有沒有 `www`），改好後 `docker compose --profile https up -d backend`。
- 不要刪 `caddy_data` volume（`docker compose down -v` 會刪）；Let's Encrypt 對同一網域每週只發有限次憑證。

## 路 2：Tailscale

適合只有自己（和你授權的裝置）要用：不用網域、不開任何對外 port，Tailscale 自動給 `https://` 憑證。

1. 主機與你的手機／電腦都裝 Tailscale 並登入同一個帳號；在 Tailscale 管理頁開啟 **MagicDNS** 與 **HTTPS Certificates**。
2. `.env`：讓 nginx 只聽本機，並讓 `APP_URL` 用 tailnet 網址（主機名稱在管理頁看，格式 `主機名.tailnet名.ts.net`）：
   ```
   APP_PORT=127.0.0.1:5180
   APP_URL=https://主機名.tailnet名.ts.net
   ```
   然後 `docker compose up -d`（不要帶 `--profile https`）。
3. 讓 Tailscale 把 https 轉給 nginx：`sudo tailscale serve --bg --https=443 http://127.0.0.1:5180`。`tailscale serve status` 可確認。
   （`tailscale serve` 只有 tailnet 內的裝置連得到；要對網際網路公開才用 `tailscale funnel`，一般不需要。）

**怎麼確認成功**：手機連上 Tailscale，開 `https://主機名.tailnet名.ts.net`，有鎖頭、可「安裝應用程式」。

**注意（真實 IP）**：這條路上 nginx 看到的連線來自 Tailscale 本機，所有人的登入速率限制會算在同一個 IP。
只有你自己用沒影響；要區分來源，在 `docker/nginx/nginx.conf` 的 `http {` 內加（把位址換成 nginx 實際看到的來源，`docker compose logs nginx` 的第一欄）：
```
set_real_ip_from 172.16.0.0/12;   # tailscale serve 在 Docker 內看到的來源
real_ip_header X-Forwarded-For;
```
只加你確定是自己的代理位址，不要加 `0.0.0.0/0`。

## 路 3：已經有反向代理

Onden 要轉的只有一個地方：**主機上 nginx 發佈的 `APP_PORT`**（預設 80；建議 `.env` 設 `APP_PORT=127.0.0.1:8080`，只讓同一台主機的代理連到，再轉 `http://127.0.0.1:8080`）。不要自己拆 `/api` 與前端，nginx 已經處理。不要帶 `--profile https`。

代理必須做到：
- 把 **整個網站**（所有路徑）轉給它，並保留原本的 `Host`（nginx 與登入來源檢查要用）。
- 支援 **WebSocket／長連線**，且 **關閉 `/api/events/stream` 的緩衝**（同步用 SSE；緩衝會讓它看起來斷線）。大多數代理預設就行；自己的 nginx 要 `proxy_buffering off`。
- 請求 body 上限不要比 Onden 小：上傳影片最大約 500 MB、備份還原約 1 GB。讀取逾時至少 60 秒（SSE 約每 25 秒有心跳）。
- 送 `X-Forwarded-Proto: https`、`X-Forwarded-For`（用戶端位址）。
- `.env` 的 `APP_URL` 填對外的 `https://你的網域`。

範例：
```
# 自己的 nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;  # 上傳邊收邊轉給 Onden，不先在你的 nginx 寫暫存檔（備份還原可達 16 GB）
  client_max_body_size 16400m;  # 備份還原上限預設 16 GB（ONDEN_MAX_BACKUP_MB）
}
```
Traefik：router 指到該 service，service 的 server URL 設 `http://127.0.0.1:8080`，其餘預設即可。
Cloudflare Tunnel：`cloudflared` 的 ingress 填 `service: http://127.0.0.1:8080`；Cloudflare 的上傳上限（免費方案 100 MB）會比 Onden 小，大檔會失敗，這是 Cloudflare 的限制。

### 讓速率限制看到真實 IP

Onden 的登入速率限制看 nginx 轉給後端的 `X-Real-IP`。nginx 預設**只相信連線來源**，不信任客戶端寫的標頭——這是有意的，否則任何人都能每次換一個假 IP 繞過限制。所以你的代理在前面時，所有人在 nginx 眼中都是代理的 IP，會共用一個額度。

要修，只信任**你的代理**，在 `docker/nginx/nginx.conf` 的 `http {` 內加（位址換成代理連到 nginx 的來源）：
```
set_real_ip_from 172.17.0.1;       # 你的代理位址，可寫多行；不要寫 0.0.0.0/0
real_ip_header X-Forwarded-For;    # Cloudflare 可改 CF-Connecting-IP
```
改完 `docker compose up -d --force-recreate nginx`。代理必須**覆寫**（不是附加）客戶端送來的 `X-Forwarded-For`。

## 真實 IP 是怎麼保證的（給想確認的人）

- nginx 在每個轉給後端的路徑，把 `X-Real-IP`／`X-Forwarded-For` **覆寫**為 `$onden_client_ip`，後端只看 `X-Real-IP`（`authClientIp.ts`）。
- 預設（80 埠）：`$onden_client_ip` 就是連線來源，客戶端寫什麼都被丟掉。
- 內建 Caddy：Caddy 把瀏覽器的位址用 `header_up` **取代**進 `X-Real-IP`，連到 nginx 的私有埠 8081。8081 沒有發佈到主機，只有 Docker 網路內的容器連得到（這就是「信任清單」：只信任 compose 網路內的 Caddy）；從 80 埠送來的 `X-Real-IP` 不被採用。
- 驗證：`npm test -- src/test/authClientIp.test.ts`（後端；含 nginx／Caddy 設定的契約檢查與限流桶），以及有 Docker 的機器上 `scripts/test-real-ip.sh`（實際起 nginx 與 Caddy，確認偽造的標頭無效）。
