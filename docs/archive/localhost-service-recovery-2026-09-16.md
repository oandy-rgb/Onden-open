# localhost 服務停止與恢復（2026-09-16）

> 狀態：歷史紀錄（最後確認 2026-11-01）

使用者提供 `http://localhost/` 截圖：登入狀態／providers API 為
`ERR_CONNECTION_REFUSED`，字型與 manifest 也失敗。對應 ACC-01、SYS-02、GAP-38。

## 原因與修復

13:16（Asia/Taipei）檢查時主機已開機約 44 分鐘，`docker.service` 為
`inactive`、`disabled`，HTTP 80 連線被拒絕。既有 Compose 已有
`restart: unless-stopped`，但它不能啟動 Docker daemon 本身。Service Worker 可回傳
先前的首頁快取，因此畫面還在不代表 API 正在運行。

透過系統管理員驗證執行 `systemctl enable --now docker.service`，啟用目前服務及
`multi-user.target` 的開機啟動。四個既有 Onden 容器隨之恢復，未重建容器、映像或資料卷，
未修改帳號、auth secret、允許來源及應用程式碼。修復後 Docker 為 `active`／`enabled`。

## 實際驗證

- PostgreSQL healthy；backend 容器內 `/health` 回 200 `{"ok":true}`，包含真實 DB `SELECT 1`。
- 首頁、`/api/auth/get-session`、`/api/auth/providers` 都回 200。
  不帶 cookie 的 session 回 `null`，providers 回空清單，符合未登入及未設定社群登入的狀態。
- manifest、Service Worker、截圖中四份字型（plex-sans 400／500／600、fraunces-var）均回 200。
- 前端入口仍為 `/_astro/AppRoot.CpStFwRf.js`，回 200；映像
  `sha256:b03b104bd60ff15651b738c69fbea9d5bd6503c59d5acb0cde67421ea4c5d7be`，
  與第二十九批已驗證部署一致。工作區尚在測試的白板分組修改沒有套入正式服務。
- 真實瀏覽器打開正式 localhost：1280×720、320×740 登入頁均能載入，手機尺寸重載後沒有
  控制項溢出，未出現 console error。沒有清除瀏覽器快取或本機待同步資料。

未使用正式帳密登入，也未重新開機整台主機；本次確認的是實際服務恢復及持久啟動設定，
不宣稱已完成下一次開機、實體手機、完全離線登入或所有 worker 重啟驗收。

## 後續診斷順序

在使用 systemd 的此類 Linux Docker 部署上，先檢查：

```sh
systemctl is-active docker.service
systemctl is-enabled docker.service
curl --max-time 5 -i http://localhost/api/auth/get-session
```

已確認需要開機啟動 Docker 時，由管理員執行：

```sh
sudo systemctl enable --now docker.service
```

再以有 Docker 存取權的身分檢查現存容器：

```sh
sudo docker ps -a --filter label=com.docker.compose.project=onden
```

`connection refused` 先查程序與監聽埠；502 再查代理的上游；401／403 才依實際回應檢查
登入與授權。不要把停機當成 session 過期，也不要用清空本機儲存或放寬 CORS 修復停機。
既有部署缺少原始環境檔時，不能用預設密碼或不完整 `.env` 重建服務。
