# 發布版本與映像（自架用）

> 狀態：現行（最後確認 2026-11-16）
> 涵蓋：scripts/release.sh, scripts/changelog.sh, .github/workflows/release.yml

何時讀：要切發布版本、改 `release.yml`／`scripts/release.sh`、或改 compose 的 `image:` 時。
沒有使用者明確要求「切版」，不要切版、不要推映像。

## 模型

- `main` 照常快速前進，正式 VPS 繼續部署 main（見 [deploy.md](deploy.md)）。自架的人只跟**發布版本**：
  從 main 的某個 commit 打 `vX.Y.Z` tag，三個預先建好的映像推到 GHCR：
  `ghcr.io/oandy-rgb/onden-postgres`、`onden-backend`、`onden-frontend`（`linux/amd64`、`linux/arm64`）。
- 每個映像有 `:vX.Y.Z` 與 `:latest`；`latest` 指向**最新穩定發布版本，不是 main**。預發布（`v0.2.0-rc.1`）不動 `latest`。
- `ONDEN_BUILD_ID` 在映像裡等於版本字串（`v0.1.0`），前後端相同，「有新版，重新載入」的機制照常運作：
  frontend 在 build 時寫入頁面，backend 的 CMD 在環境變數 `ONDEN_BUILD_ID` 為空時用映像內建的版本。
  VPS 從原始碼 build 時照舊傳 git sha，不受影響。
- 自架的人：`.env` 可設 `ONDEN_VERSION=v0.1.0` 釘住版本（不設就是 `latest`），然後 `docker compose pull && docker compose up -d`。
  升級＝改版本號再 pull／up；backend 開機時自動套用 migration。

## 什麼時候可以切版

全部成立才切，並把結果寫進 release notes 或 PR：

1. 要切的 commit 在 `origin/main` 上，CI 在該 commit 全綠。
2. 各套件 `npm test`、`npm run lint`、`npx tsc --noEmit` 通過；前端 `npm run build` 通過。
3. e2e（含故障測試）在本機對該 commit 跑過（見 [testing.md](testing.md)）；跑不了的項目要寫出來，不算通過。
4. 若含新 migration：先照 [deploy.md](deploy.md)「還原演練」對真備份跑過 `scripts/restore-drill.sh --commit <該 commit>`。
5. `docker compose config` 有效；本機 `docker compose up -d --build` 能起來，`/health` 回 `{"ok":true}`。

## 版本號

`v主.次.修`，0.x 階段：

- **升 minor（`v0.2.0`）**：有任何新 migration、破壞性變更（API／設定／環境變數／compose 結構改動、需要自架者動手的事）。
- **升 patch（`v0.1.1`）**：只有修正與不含 migration 的小改動。
- 預發布用 `-rc.N` 後綴；不更新 `latest`。
- 已發布的 tag 與映像不重推、不改動；有問題就發下一個 patch。

## 怎麼切

先備好 release notes，再選一種發布方式（兩者建出相同的映像與 tag）。

1. `scripts/changelog.sh vX.Y.Z --update` 更新 `CHANGELOG.md`（上一個 tag 以來合併的 PR 標題＋新增的 migration），
   人工補寫「需要手動處理」，經 PR 合併進 main。切的 commit 取這個 PR 合併之後的 main。
2. **(a) GitHub Actions**：`git tag -a vX.Y.Z <commit> -m vX.Y.Z && git push origin vX.Y.Z`。
   `.github/workflows/release.yml` 依平台用原生 runner 建三個映像，合成多架構 manifest，推 `:vX.Y.Z`（穩定版再加 `:latest`），
   並用同一支 `changelog.sh` 的輸出建立 GitHub release。arm64 job 失敗不擋 amd64（manifest 只含成功的平台，要在 release 說明註明）。
3. **(b) 本機**（Actions 不能用時）：先自己登入 `echo "$GHCR_TOKEN" | docker login ghcr.io -u <帳號> --password-stdin`
   （token 需要 `write:packages`），在要切的 commit 上執行 `scripts/release.sh vX.Y.Z`
   （`--dry-run` 只印指令，`--no-latest` 補發舊版本）。腳本不建 tag；推完後手動 `git tag`／`git push origin vX.Y.Z`，
   並在 GitHub 手動建立 release 貼上 changelog 該節。Actions 恢復後推 tag 會再跑一次 `release.yml`，覆蓋同版本映像（內容相同的重建）。
   本機要有 `docker buildx`，建 arm64 需要 QEMU（`docker run --privileged --rm tonistiigi/binfmt --install all`）；前端 build 在模擬下很慢、很吃記憶體。
4. 第一次推送後，GHCR 套件預設私有：到 GitHub ▸ Packages ▸ 每個映像 ▸ Package settings 改成 Public 並連到 repo，
   自架的人才能不登入就 pull。
5. 驗證：在乾淨的目錄只放 `compose.yaml`、`docker/` 與 `.env`，設 `ONDEN_VERSION=vX.Y.Z`，`docker compose pull && docker compose up -d`，
   `/health` 正常，登入後 `X-Onden-Build` 回應標頭等於 `vX.Y.Z`。

## Release notes 要寫什麼

`changelog.sh` 產生「資料庫 migration」與「變更」兩節；「需要手動處理」由人填，沒有就寫「無」。必須明確標出：

- **migration**：檔名；有刪資料或不可回滾的要特別寫（回滾映像無法復原資料，要靠升級前備份）。
- **需要手動處理**：新增或改名的環境變數、compose／nginx 設定要自架者自己合併的改動、資料搬移、從哪個版本起必須先經過哪個版本。
- 跳過版本的升級路徑（例如「從 v0.1.x 升 v0.3.0 要先升 v0.2.0」）。
- 已知限制，例如某平台映像缺少。

## 開發者本機與 VPS 的注意

`compose.yaml` 每個服務同時有 `image:` 與 `build:`。`docker compose build`／`up --build` 會把原始碼建出的映像標成
`ghcr.io/oandy-rgb/onden-<名稱>:${ONDEN_VERSION:-latest}`，會蓋掉本機已 pull 的同名映像；`docker compose pull` 也會反過來蓋掉本機建的。
從原始碼跑的環境（VPS、開發機）請在 `.env` 設 `ONDEN_VERSION=local`，本機建的映像就叫 `:local`，與發布版本不會互相覆蓋；
映像名稱的前綴可用 `ONDEN_IMAGE` 改（預設 `ghcr.io/oandy-rgb/onden`）：VPS 的 `.env` 設 `ONDEN_IMAGE=onden-vps`，
建出的映像仍叫 `onden-vps-<名稱>:latest`，回滾 tag 流程（`before-<sha>`）不用改，見 [deploy.md](deploy.md)。
