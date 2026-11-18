# Onden 桌面版（試做）

> 狀態：現行（試做 spike，2026-11-02 起；最後確認 2026-11-17）。業主決定：「Electron 試試看」，只做第一層——**在這台電腦雙擊就能用**。
> 涵蓋：packages/desktop/src/**, packages/desktop/scripts/**, packages/desktop/package.json, scripts/desktopCheck.mjs
> 已實作並測過的是下面「現在能做什麼」；「還沒做的」一節是刻意不做的範圍，不是漏掉。

## 現在能做什麼

雙擊 AppImage → 看到「正在開啟…」→ 建立帳號（第一次）或直接進入你的筆記。資料全在這台電腦，不需要網路、不需要 Docker、不需要另外裝資料庫。

做法：Electron 外殼開一個 `BrowserWindow`，背後有兩個東西，都只綁在 `127.0.0.1`：

```
Electron 主程序（packages/desktop/src/main.mjs）
 ├─ 後端子程序  node packages/backend/dist/server.js（既有後端，一行沒改；ONDEN_DB_DRIVER=pglite）
 │              資料庫＝PGlite（Postgres 的 WASM 版），存在 <userData>/pgdata
 └─ 小型網頁伺服器（webServer.mjs）  127.0.0.1:47821（被占用才換埠）
        / 與 /_astro/…   前端建置（packages/frontend/dist/client）的靜態檔，沒有副檔名的路徑回單頁應用
        /api/*、/health   原樣轉給後端
```

為什麼這樣切：

- **同一個後端、同一份前端**：桌面版、瀏覽器版（`build:browser`）、伺服器版走同一套程式；桌面版只是「用 PGlite 的後端 ＋ 把前端與 `/api` 放在同一個網址」。
- **同源**：視窗載入的網址就是 API 的網址，不需要 CORS；登入 cookie、來源檢查（`BETTER_AUTH_URL`、`CORS_ORIGIN`）都指向它。
- **埠盡量固定**：瀏覽器端的本機資料（IndexedDB、離線佇列）綁 origin（含埠）。第一次選好的埠記在 `desktop.json`，之後優先用同一個；被別的程式占走才換，換了就像換一台電腦（本機副本重新同步）。
- **子程序用 `child_process.fork`**（`ELECTRON_RUN_AS_NODE`），不用 `utilityProcess`：行為與普通 `node serverEntry.mjs` 相同，開發與測試不需要 Electron；有 IPC，Windows 也能「請它關資料庫再離開」。
- **乾淨關閉**：後端本身沒有 SIGTERM 處理。`serverEntry.mjs` 先裝好關閉處理（先 `db.pool.end()`：等提交後的背景寫入做完再關資料庫，見後端 `dbClose.ts`；然後離開）再載入既有的 `server.js`，所以後端程式碼沒動。關掉視窗 → 請後端關好 → 退出；8 秒內沒結束才強制結束。結束後的連線池不可再用（`PglitePool` 拒絕而不是悄悄重開資料庫）。測試：`packages/desktop/test/shutdown.test.mjs` 用真正的 `serverEntry.mjs` 起後端、排一個提交後的派發工作、送同一則 shutdown 訊息，檢查正常結束、工作做完、重開後資料還在、連線池結束後的寫入被拒絕（需要後端已建好；`desktop:check` 打包後會跑）。
- **安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；不動 `webSecurity`。有一個 preload（`src/preload.cjs`），只用 `contextBridge` 對網頁暴露 `window.ondenDesktop.ai`（見下一節「AI 橋」），沒有通用的 `invoke`／`send`，網頁拿不到 `ipcRenderer`。外部連結用系統瀏覽器開，視窗不會被導到別的網址；只放行剪貼簿、通知、全螢幕權限；網頁伺服器檢查 `Host`（防 DNS rebinding）並蓋掉用戶端自帶的 `X-Real-IP`；只允許一個實例（再雙擊會把原視窗叫到前面）。

### AI 橋：用這台電腦上的 AI 回答

設定 › AI 的按鈕（前端 `lib/desktopBridge.ts`）透過 preload 呼叫主程序，開關「這台電腦上已登入的命令列 AI 工具替你回答筆記旁的問題」（設計：[提案](../architecture/proposals/desktop-ai-answering-2026-11-15.md)）：

- 網頁能要求的動作只有 `src/aiAnswering/bridge.mjs` 的 `AI_CHANNELS` 那幾個（偵測、狀態、預覽位址、開關自己的／遠端的回答），`preload.cjs` 的清單要與它一致。主程序只回應 App 自己畫面的主框架（固定來源、不是 `/api/` 底下的內容）。
- 回答程式是 `packages/ai-answerer`，`stage.mjs` 複製成 `ai-answerer/src` 隨安裝檔出貨；載入失敗不影響開機，按鈕只會停用。狀態與連線碼存在 `<userData>/ai-answering.json`（用系統的 `safeStorage` 加密）。關閉 App 時先停掉回答（`stopAll`）再關後端。
- 瀏覽器版與伺服器版沒有這座橋（`window.ondenDesktop` 不存在）。

### 第一次打開

走既有的「建立帳號」畫面。**欄位要填電子郵件**，但桌面版不寄信、不驗證——填任何格式正確的位址即可（例如 `me@onden.local`）。第一個註冊的帳號是擁有者；之後不開放註冊（`ONDEN_SIGNUP=first-only`，其他人只能用邀請連結）。忘記密碼目前沒有「寄信重設」可用（沒有寄信設定），請自己記好或備份。

## 資料放哪（`<userData>`）

Linux：`~/.config/Onden/`（打包版）；開發時是 `~/.config/onden-desktop/`。可用 `--user-data-dir=<路徑>` 指定別處（測試就這樣用）。

| 路徑 | 內容 |
| --- | --- |
| `pgdata/` | PGlite 資料庫（所有筆記、帳號、事件） |
| `data/content/` | 上傳的圖片與附件（`media/`）、筆記備份用的 git 倉庫 |
| `secrets.json` | 第一次啟動自動產生的 `ONDEN_SECRET_KEY`（加密你的 AI 金鑰與外部日曆網址）與 `BETTER_AUTH_SECRET`（簽登入 cookie），權限 0600 |
| `desktop.json` | 上次使用的埠 |
| `ai-answering.json` | 「用這台電腦上的 AI 回答」的開關狀態與連線碼（加密） |
| `version.json` | 這份資料上次是由哪個版本開的（換版時據此自動備份） |
| `backups/` | 換版前的自動備份，每份一個資料夾（`before-<舊>-to-<新>-<時間>/`），預設保留最近 3 份 |
| 其他（`Cache`、`Local Storage`…） | Chromium 自己的資料（登入 cookie、瀏覽器端離線副本） |

## 怎麼備份

最簡單：**關掉 Onden**，把整個 `<userData>` 資料夾複製走（必須關掉：資料庫是檔案，開著複製可能不一致）。還原＝關掉 Onden、把資料夾放回去。`secrets.json` 一定要一起帶走，否則已加密的內容讀不回來、要重新登入。

另一條路：設定 › 你的資料 的匯出／備份（與瀏覽器版、伺服器版相同，產生 zip，可在任何版本還原）。換版前的備份不用自己做（見下）。

## 怎麼更新

**關掉舊版，換上新的 AppImage，直接打開。** 不需要先複製資料夾。Onden 不支援新舊版本並存，所以更新設計成「很難出事」（`src/safeUpdate.mjs`，不依賴 Electron，`test/safeUpdate.test.mjs` 測）：

1. **換版自動備份**：啟動時比對 `version.json`（版本＋建置編號；同一版本不同建置也算換版）。不同就在資料庫升級**之前**備份到 `backups/before-<舊>-to-<新>-<時間>/`：資料庫（`pgdata/`）、金鑰、設定、筆記備份 git 全部複製；上傳檔（`data/content/media/`，通常最大）用硬連結，不佔第二份空間（上傳檔只新增不原地改寫；不同磁碟分割無法硬連結時退回複製）。`data/content` 底下的快取與暫存（`backup-uploads`、`backup-scratch`、`site-bundles`）不帶：後端每次開機都會清掉沒做完的上傳與暫存（`backupFile.ts`、`backupArchive.ts`），上傳的備份檔 6 小時就過期，網站發布的複本是快取、沒有就重建（`siteBundle.ts`）。所以回滾或手動還原把這三個資料夾換掉，只會讓進行中的備份上傳作廢、網站複本重建一次。保留最近 3 份。全新安裝與版本沒變的啟動不備份。
2. **空間不足就不升級**：備份一份、還原時還要在旁邊再放一份才對調，所以要有「要複製的大小」的 2 倍（含 10% 餘裕）。不夠就跳白話訊息（需要多少、剩多少），資料不動。
3. **升級失敗自動退回**：資料庫升級失敗、或後端 180 秒內沒通過健康檢查，就把資料還原成剛才那份備份（先複製到暫存再對調，中途失敗現況不變），並說明「這個新版本無法開啟你的資料、資料已還原成更新前的樣子」；對話框有「複製診斷資訊」按鈕（版本、後端日誌最後幾十行），主要文字不放原始錯誤。
4. **資料比程式新**（用舊版開了新版寫過的資料）：版本檔記著上次成功的最新資料庫升級檔，比這個建置多就**先判斷、不備份、不啟動**；判斷不出來時後端也會拒絕啟動（`DatabaseNewerThanCodeError`）。桌面版顯示「這份資料是較新版的 Onden 寫的，請用較新的版本開啟」，不還原、不改資料、不留備份。
5. **中斷安全**：備份之後、升級之前先寫 `update-in-progress.json`（指向那份備份）。升級成功（版本檔已換新）或還原整個做完才清掉。升級或還原中途被強制結束、斷電，下次啟動先看這個標記，把還原做完（還原可重複執行，每次都收斂到備份的樣子），再做別的。標記指到的備份不會被清。
   - 啟動時**先**補完還原，之後才建資料夾、讀金鑰（否則會拿到半套的金鑰檔）。
   - 若升級成功後標記與版本檔都寫不下去（磁碟滿了），會停掉後端並還原（下次啟動會把這段期間的資料還原掉，不如現在就做）。
   - 若標記指到的備份不見或不完整（例如手動刪了 `backups/` 清空間），或標記檔本身損毀（空的、被截斷），無法還原：對話框給「結束」「直接開啟現有資料」（放棄還原，只清標記）「複製診斷資訊」（複製完回到同一個對話框）三個選項，建議先複製整個資料夾；不會再跳第二個對話框。
   - 寫入方式：備份與還原複製出來的檔案與資料夾、標記、版本檔都先刷到磁碟（fsync）再改名，清標記後也刷資料夾，斷電後不會留下空的標記、被截斷的備份，或標記已清但還原的檔案還沒落盤。**已知限制**：fsync 沒有任何自動測試涵蓋（測試只驗證沒有殘留檔與中斷點的收斂），斷電行為需要實機；硬連結的上傳檔不再刷（它們本來就是已在磁碟上的原檔）；不支援 fsync 的檔案系統或 Windows 的資料夾刷新會略過；沒有在實機斷電驗證過。
6. **版本可見**：選單 Onden › 關於 Onden 顯示版本與建置編號；內建後端帶 `ONDEN_BUILD_ID`（`stage.mjs` 決定，與前端建置同一個），網頁那套「有新版」比對才有東西可比。`--no-build` 沿用舊前端時編號留空（不送標頭，不誤報）。
7. **手動還原**：選單 Onden › 還原到更新前的備份…（列出備份 → 確認 → 先另存目前資料 → 還原 → 關閉）。還原後要用與備份相符的**舊版**程式開啟（不自動重開，否則新版會立刻再升級一次）。

沒有做：下載新版、自動更新通道。取得新版目前仍是自己下載 AppImage。

## 怎麼開發

需求：Node 22、根目錄已 `npm ci`（建前端與後端用）。**Electron 不在根目錄的 workspaces 裡**（根目錄 `workspaces` 有 `"!packages/desktop"`），所以根目錄 `npm ci` 不會多下載 Electron；桌面版自己裝：

```bash
npm ci                      # 根目錄，照舊
npm run desktop:install     # = npm ci --prefix packages/desktop（Electron、electron-builder、playwright-core）
npm run build:browser       # 不需要；桌面版不用它
npm run desktop:dev         # 整理 stage/ 後用 `electron .` 開視窗（前後端要先建好：下面）
```

`desktop:dev` 用已建好的前後端（`npm run build -w packages/markdown -w packages/site -w packages/backend -w packages/frontend`）；`desktop:build` 會自己建。改前端／後端後要重建再 `desktop:dev`。

在容器或以 root 執行時，Chromium 要 `--no-sandbox`（`npx electron . --no-sandbox`）；一般使用者不需要，也不要加。

### 測試

```bash
npm run desktop:test     # 不需要 Electron：資料夾與金鑰、找埠、靜態檔＋代理（node --test，1 秒）
npm run desktop:check    # 一個指令：裝依賴 → 打包（linux-unpacked）→ desktop:test → 打包版冒煙（PR 用這個）
npm run desktop:pack     # 只打包到 packages/desktop/release/linux-unpacked（不做 AppImage）
npm run desktop:smoke    # 真的 Electron（xvfb-run）：啟動 → 建帳號 → 新增筆記 → 上傳圖片 → 關掉重開 → 筆記還在、仍登入
node packages/desktop/test/smoke.mjs --app <打包後的執行檔>   # 測打包版（複製到 repo 外面測，才不會偷用 repo 的 node_modules）
node packages/desktop/test/bench.mjs --notes 5000            # 量啟動時間、記憶體、中文搜尋
```

冒煙測試與量測都**不在**預設整套測試裡（要 Electron 與虛擬螢幕）。但改到後端、markdown／contract／site 套件、桌面版或根目錄 `package.json`／`package-lock.json` 的 PR，
雲端要跑 `npm run desktop:check`（裝依賴 → 打包 → `desktop:test` → 對複製到 repo 外的打包執行檔跑冒煙測試），並跑 `npm run parity` 與另外兩個版本對照同一套操作；見 [testing.md](../agents/testing.md)。

## 怎麼打包

```bash
npm run desktop:build    # 建前後端 → 整理 stage/ → electron-builder 產出 AppImage
# 產物：packages/desktop/release/Onden-<版本>-x86_64.AppImage
```

`packages/desktop/scripts/stage.mjs` 做的事：

1. 前端建置複製到 `stage/web`；
2. 後端執行環境到 `stage/server`：後端 `dist`、`db/migrations`、markdown／site 的 `dist`，以及 `npm ci --omit=dev` 裝出來的 `node_modules`（與 `backend/docker/Dockerfile` 同一個作法）；
3. **PGlite 是後端的 devDependency**（伺服器版用真 Postgres），`--omit=dev` 不會裝，所以從根目錄已裝好的那份原樣帶進來（版本與 lockfile 一致）；
4. **瘦身**：從 dist 的所有 import 出發，順著 `dependencies` 走過每個套件，走不到的刪掉（連 vitest、tsx、esbuild、happy-dom 這些建置／測試工具）；
5. **檢查**：關鍵套件必須解析到 stage 裡面。Node 會一路往上層資料夾找套件，不檢查的話在 repo 裡會悄悄用到根目錄的 `node_modules`，打包後才缺東西（這個問題真的發生過一次）。
6. **後端用的 Node**：下載官方 Node 22（版本與 SHA-256 固定在 `stage.mjs`）放到 `stage/server/runtime/node`，後端用它跑，不用 Electron 內建的 Node。Electron 在 Linux 會把系統的 glib 符號帶進程序，sharp 讀圖片時因此 SIGSEGV（electron#46323；在 Fedora 44 上實際發生，上傳圖片讓後端當掉）。AppImage 因此多約 30 MB。下載的壓縮檔快取在 `packages/desktop/.cache/`。

`asar: false`：後端要從磁碟讀遷移 SQL、`sharp` 有原生檔，後端又在子程序裡跑；全部攤開最單純。electron-builder 的 `extraResources` 會略過名為 `node_modules` 的資料夾，所以後端由 `packages/desktop/scripts/afterPack.cjs` 在打包後複製進 `resources/server`。

**選 electron-builder 的理由**：AppImage 一行設定就有，Windows（NSIS）、macOS（dmg）同一份設定，日後的簽章與自動更新（`electron-updater`）也在同一個工具鏈；授權 MIT。

### 在 Fedora 執行 AppImage

```bash
chmod +x Onden-0.1.0-x86_64.AppImage
./Onden-0.1.0-x86_64.AppImage
```

- Fedora 預設沒有 FUSE 2：若出現 `dlopen(): error loading libfuse.so.2`，裝 `sudo dnf install fuse-libs`，或用 `./Onden-….AppImage --appimage-extract-and-run`。
- 筆記備份用系統的 `git`（後端的 `initGit`）：Fedora 要有 `git`（`sudo dnf install git`）。
- 沒有圖示的桌面整合（選單項目）要靠 AppImageLauncher 之類；試做版沒有附。

### Windows／macOS 需要什麼（沒有在雲端產出，也沒測過）

- 必須在各自的系統上建置（`npm ci` 與 `stage.mjs` 會裝該平台的原生檔，例如 sharp、pagefind）：Windows 用 `electron-builder --win nsis`，macOS 用 `--mac dmg`（設定檔要補各平台的 `win`／`mac` 區塊與圖示 `.ico`／`.icns`）。
- 不簽章也能跑，但 Windows SmartScreen／macOS Gatekeeper 會警告；簽章與公證的成本與流程見設計文件（PR #1133，`docs/design/desktop-app.md` 第 1.3 節）。
- 這份試做沒有改任何後端或前端的行為，所以平台差異只在外殼與打包。

## 搜尋（中文）

PGlite 沒有 pgroonga。後端既有的「便攜搜尋引擎」（`services/textSearch.ts`，瀏覽器版與測試也在用）會自動接上：`pg_trgm` 索引加 `ILIKE` 子字串比對，中文可用；差異見 `docs/architecture/portable-backend.md`。量到的延遲在 PR 說明。

## 還沒做的

| 項目 | 說明 |
| --- | --- |
| 系統匣、開機啟動 | 現在關掉視窗就退出；沒有常駐 |
| 自動下載更新 | 升級前自動備份、失敗退回資料、手動還原已做（見「怎麼更新」）；新版放哪裡下載還沒決定，所以仍是自己取得新的 AppImage |
| 簽章與公證 | Windows／macOS 未做 |
| 手機／平板連線與 HTTPS | 完全不做：現在只綁 `127.0.0.1`，區網連不到。要做需要 HTTPS 憑證與配對流程（設計文件 PR #1133 第 3 節） |
| Windows／macOS 建置 | 只寫了需要什麼，沒產出、沒測 |
| 首頁網站（`/site/*`）、網站發佈預覽 | 這些頁面是前端 Astro 伺服器端渲染的（`dist/server`），桌面版只帶靜態檔，這些網址會回單頁應用的殼；發佈到 GitHub Pages 的後端功能仍在（尚未驗證） |
| 預先建好的資料庫快照 | 第一次啟動要跑全部遷移，約 9 秒；後端支援 `ONDEN_PGLITE_SNAPSHOT`，可以把遷移好的資料庫隨安裝檔出貨（可降到 2–3 秒），這份試做沒做 |
| 語意搜尋（pgvector 嵌入） | 沒有驗證；本機嵌入模型沒有隨附 |
| 圖示、桌面整合 | 圖示暫用 App 的 512 像素圖；選單只有「Onden」（關於、還原）與標準的編輯／檢視，選單列預設自動隱藏（按 Alt 顯示） |
