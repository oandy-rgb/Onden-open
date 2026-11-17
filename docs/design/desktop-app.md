# 桌面 App 內建伺服器：設計（2026-11-02 依現況改寫）

> 狀態：歷史紀錄（2026-11-02 的設計；桌面外殼之後已在 `packages/desktop` 試做，現況見 [desktop/README.md](../desktop/README.md)）。以下是當時寫給業主看的設計。
> 改寫原因：10/31 的初稿假設「要內建真的 Postgres、自己寫搜尋抽象層」。之後 #1157（可攜後端）與 #1164（瀏覽器版）已上線，那兩件事已經做完，且方向不同。本文照現況重寫。
> 相關：伺服器不在線時的行為見 `docs/design/intermittent-server.md`（#1132，另一個 PR，尚未合併）；後端怎麼放進別的環境見 [portable-backend.md](../architecture/portable-backend.md)；瀏覽器版見 [browser-app.md](../architecture/browser-app.md)。
> 初稿的實驗已被取代，只留結論：[research/desktop-app](../research/desktop-app/README.md)。

名詞（第一次出現時各一句）：**PGlite**＝用 WebAssembly 編譯的 Postgres，跑在同一個 Node 程序裡，不必另裝資料庫。**pgroonga**＝正式伺服器用的中文全文搜尋擴充。**secure context**＝瀏覽器只對 HTTPS 或 `localhost` 開放 service worker、OPFS 等功能的環境。

## 現況對照（2026-11-02）

「確認」＝我讀了 main 上的程式或文件；「未確認」＝沒有證據，不假裝。

| 初稿的目標 | 狀態 | 在哪裡 |
| --- | --- | --- |
| 不另裝 Postgres（原計畫：內建真 Postgres） | **已完成，且方向改了**：後端可跑 PGlite（`ONDEN_DB_DRIVER=pglite`，資料夾由 `ONDEN_PGLITE_DIR` 指定） | #1157（已合併）。`packages/backend/src/db.ts`、`dbPglite.ts`；[portable-backend.md](../architecture/portable-backend.md) §1–2 |
| PGlite 單一連線會不會死結（初稿最大疑慮） | **已解**：連線互斥鎖（先進先出），交易內的 `pool.query` 沿用該交易 | `dbPglite.ts`；後端整合測試在 PGlite 上 5,077 通過、0 失敗、88 跳過（portable-backend.md §7；跳過清單有列） |
| 遷移檔拿掉 age／pgroonga 後能套用 | **已完成**，不改舊遷移檔 | `dbMigrations.ts` 的 `portableMigrationSql` 在載入時拿掉那三個擴充 |
| 搜尋抽象層（pgroonga ↔ trigram） | **已完成** | `services/textSearch.ts` 兩個引擎；資料庫有 pgroonga 就用它，否則用 `ILIKE` ＋ `pg_trgm`；契約測試 `textSearchEngines.integration.test.ts` |
| 語意搜尋（pgvector） | 套件已在依賴（`@electric-sql/pglite-pgvector`）；桌面版是否開啟：**未確認** | `packages/backend/package.json` |
| 預先遷移好的資料庫，首次開啟不重跑 150 支遷移 | **已完成**（瀏覽器版用）；Node 端有 `ONDEN_PGLITE_SNAPSHOT` 同樣可用 | browser-app.md §5；`db.ts` |
| 後端不綁 Node（為了將來放進別的外殼） | **已完成**：`app.ts` 純組裝、`server.ts` 才是 Node 開機 | #1157 |
| 手機／平板只靠瀏覽器就能用 | **已部分完成，但不是本文要的**：瀏覽器版（#1164）把整個後端放進瀏覽器，資料只在那個瀏覽器裡，沒有跟桌機同步 | browser-app.md；試用網址 onden.o-andy.com |
| 瀏覽器版給朋友用（資料升級、寫入日誌、備份還原、SW＋OPFS 圖片、更新提示、WebKit） | **進行中**：分支 `feat/browser-app-friends`，**未合併**。我讀了分支上的文件：寫入日誌、升級檢查、備份提醒、從備份還原、更新提示、冒煙測試 42 項在 Chromium 通過。圖片上傳在該分支仍標「未開」，WebKit 未實跑 | 分支 `feat/browser-app-friends`；其 browser-app.md §12–14 |
| 分散式同步（桌機、手機、瀏覽器版都是對等節點） | **進行中（beta 第 1 步）**：分支 `feat/distributed-sync`（#1169，仍開著）。只有引擎與模擬測試，沒有介面、沒有真傳輸、沒有簽章，預設關閉 | 該分支 `docs/architecture/distributed-sync.md` |
| 打包成可安裝的桌面程式（Electron／Tauri） | **還沒人做**。倉庫裡沒有任何 electron／tauri 相依 | 全倉庫 `package.json` 搜尋，確認 |
| 手機在區網配對、HTTPS | **還沒人做** | 確認 |
| 裝置網域＋憑證簽發小服務 | **還沒人做** | 確認 |
| 升級前自動備份、舊程式拒絕新資料庫 | **還沒進 main**：#705 仍開著（Docker 腳本版）；main 上沒有 `DatabaseNewerThanCodeError`。瀏覽器版朋友分支有自己的 `schemaCheck.ts`（未合併） | #705；分支 `feat/browser-app-friends` |
| 完整備份下載、從備份還原 | **已完成（伺服器版）**：`/api/backup/full.zip` 與還原路由 | `routes/backup.ts` |
| 匯入器 | **部分完成**：單筆 Markdown、Obsidian 資料夾、Notion 資料庫（CSV）、一般 CSV、Excalidraw 繪圖已在 main。Logseq、SiYuan、Evernote：**程式裡沒有，仍缺** | `packages/backend/src/modules/importers/`、`packages/frontend/src/modules/importers/` |

## 1. 結論（四句話）

1. **桌面版改用 PGlite，不內建真的 Postgres。** 初稿不選 PGlite 的唯一理由是「單一連線可能死結」，現在已解決並有測試。好處：一個 Node 程序、資料就是一個資料夾、沒有子程序與埠要管、三平台不必各帶一份 Postgres 二進位。
2. **搜尋不用再做，已經有。** 桌面版與瀏覽器版共用「可攜搜尋」（`ILIKE` ＋ `pg_trgm`）。代價是第三層以後的相關性排序和 pgroonga 不同（portable-backend.md §4 已列差異）。
3. **還沒人做的是三件事：桌面外殼、手機連桌機（HTTPS＋配對）、桌面版升級與遷移。** 其中手機連桌機是最大風險。
4. **共用空間要有一個「裁判」**（業主 2026-11-02 的說法）。桌面 App 就是自己這個工作區的裁判，手機走現有 `/api/sync` 對它同步，也就是星狀。分散式同步（#1169）若日後成熟，是讓「裁判不在時裝置互通」的加法，不是桌面版的前提。

## 2. 資料庫與搜尋（取代初稿第 2 節）

### 2.1 為什麼選 PGlite

| | PGlite（建議） | 內建真 Postgres |
| --- | --- | --- |
| 現況 | 在 main，整合測試全跑過 | 沒人在 main 上跑過；初稿也只下載檢查過套件，沒啟動過 |
| 程序 | 與後端同一個 Node 程序 | 要管子程序、埠、崩潰復原、資料目錄鎖 |
| 打包 | 純 JS／WASM，三平台同一份 | 各平台二進位（初稿查到 npm 解壓縮約 59／109／337 MB，最大那個原因未查明） |
| 並行 | 一次一個交易（排隊）。單人加幾台手機夠用 | 真並行 |
| 規模 | **未量**：portable-backend.md 只有「1 萬篇搜尋約 3 ms、10 萬篇 2 字詞約秒級」；資料庫本身在 10 萬篇的啟動時間與記憶體沒量過 | 較有餘裕 |

**什麼時候才該回頭考慮真 Postgres**：階段 0 量到「業主實際資料量下，PGlite 的啟動時間或記憶體不可接受」。沒有這個數字之前，不為假想的規模多背一條二進位流水線。

### 2.2 要先驗證的（階段 0）

- 在 **Node 上用資料夾**（`ONDEN_PGLITE_DIR=<資料夾>`）完整跑 `server.ts`：目前測試跑的是 `app.ts` ＋ 記憶體資料庫；資料夾模式的耐久性（斷電、強制結束）**未確認**。
- 圖片／附件在 Node 端走 `MEDIA_DIR`（`sharp` 原生模組仍在，Electron 打包要把它放在 asar 外面）。
- 資料夾版的備份：直接用現有 `/api/backup/full.zip`，或複製資料夾（需先停寫）。要選一個，見 §5。
- 業主的匯入資料量下的啟動時間與記憶體。

### 2.3 搜尋

已完成，不重做。仍要在桌面版文件寫清楚的使用者可見差異：查詢語法只支援「詞、`"片語"`、`a OR b`、`-排除`」；1–2 字詞為循序掃描，大量筆記時較慢。

## 3. 打包方式

後端沒有子程序要管了，外殼只需要：啟動 Node 後端、放系統匣圖示、顯示 QR code、做備份與升級。

| | Electron | Tauri v2 ＋ Node |
| --- | --- | --- |
| 後端怎麼帶 | Electron 自帶 Node，後端直接跑在主程序或 `utilityProcess` | 要另外塞 Node（當 sidecar，一個獨立執行檔）；每個可執行檔各自要簽章 |
| 接手難度 | 全 JavaScript，與專案一致 | 外殼是 Rust |
| 安裝檔大小、記憶體 | **未量**（初稿只有「一般約 100 MB 以上」的印象） | **未量**；外殼小，但 Node 會吃掉部分差距 |
| 更新器 | `electron-updater`（MIT） | 內建，強制簽章驗證 |

**建議第一版 Electron**，理由同初稿，且 PGlite 讓「帶 Node」的差距更小。階段 0 實測安裝檔大小與記憶體後確認；外殼可換，後端不動。簽章費用（Apple 年費、Windows 簽章）初稿標「未查證」，本次**仍未查證**，請業主確認。

## 4. 手機連桌機：HTTPS 問題

為什麼一定要 HTTPS：service worker、OPFS 只在 secure context 啟用，`http://192.168…` 開起來看似正常，離線與安裝成 PWA 會悄悄失效（見 [self-host/https.md](../self-host/https.md)）。桌機本機用 `localhost` 不受影響。

| 選項 | 手機要做什麼 | 外出能用 | 要營運什麼 | 主要風險 |
| --- | --- | --- | --- | --- |
| (a) Tailscale | 裝 App、登入同帳號 | 是 | 無 | 多裝一個 App；個人免費方案有上限，條款可能改 |
| **(b) 自有網域指向區網 IP**（建議第 1 階段） | 掃 QR 開網址 | 否（同 Wi-Fi） | 一個網域＋簽憑證的小服務 | 部分路由器擋「公開網域解析到私有 IP」（DNS rebinding 防護）；憑證發放有頻率限制（未查證） |
| (c) 轉接通道 | 無 | 是 | 全天候服務與流量費 | 營運責任最高 |
| (d) 自簽憑證裝到手機 | 手動信任 | 否 | 無 | 對一般使用者太難，不建議 |
| (e) 原生外殼（Capacitor） | 裝原生 App | 否 | 無 | 要上架與簽章；業主沒有 iPhone 可驗 |
| (f) 公開靜態網址載入 App、WebRTC 直連桌機 | 開網址＋掃 QR | 是 | signaling／STUN／TURN | Chrome「區網存取權限」提示；前端要換傳輸層；iOS 未知 |

**現況帶來的新選項**：瀏覽器版（#1164）已證明整個 App 能從純靜態網址載入。所以 (f) 的「靜態網址載入 App」那一半已有現成基礎；剩下的是「把請求送到桌機」那一半（`lib/api.ts` 的 `apiFetch` 仍是單一入口，初稿估 1–2 週的換傳輸層工作沒變）。但 (f) 仍不進第一版。

**Chrome 區網存取權限（LNA）**：初稿查到的說法（Chrome 142 起公開網站對區網位址發請求要使用者同意）我**這次沒有重新查證**，標「待確認」。實機驗證請用業主的 Tab S9／Brave（初稿 E1–E7 的清單仍有效，見 §8）。

分階段（沿用初稿，不變）：階段 1 = (b)；階段 2 = Tailscale 選配文件；階段 3 = 評估 (f)，等實機實驗與實際需求。

## 5. 升級、遷移、備份

PGlite 讓這一節比初稿簡單：資料是一個資料夾，沒有「Postgres 大版本升級」問題（版本跟著 npm 套件，跟 App 一起升）。

| 步驟 | 做法 | 狀態 |
| --- | --- | --- |
| 偵測新版、下載、驗簽 | `electron-updater` | 還沒人做 |
| 升級前備份 | 呼叫現有完整備份（`/api/backup/full.zip` 同一段程式），放在資料夾旁的 `升級前-<舊版本>/`；失敗就取消升級 | 備份程式在 main；「升級前自動做」還沒人做 |
| 遷移 | 新版啟動跑 `migrate()` | 已有 |
| 舊程式碰新資料庫就拒絕 | #705 是 Docker 腳本版，桌面版要重做同一條規則（`schema_migrations` 內有這份程式沒有的遷移就不啟動）。瀏覽器版朋友分支的 `schemaCheck.ts` 做過同樣的事，可以對照，**但未合併** | 還沒進 main |
| 失敗退回 | 用升級前備份還原並退回舊版 | 還沒人做 |
| 備份放哪 | 預設放資料夾同層；提醒「備份和資料在同一顆硬碟不算備份」，提供匯出到外接碟 | 還沒人做 |

## 6. 配對與安全（不變，摘要）

- **配對**：桌機產生一次性配對碼（128 位元、2 分鐘有效、用過即失效），QR 網址把碼放在 `#` 後面（不進伺服器日誌）。手機產生裝置金鑰，桌機畫面確認後核發。
- **裝置與撤銷**：沿用現有權杖與 `membership_epoch` 撤權機制，不新增第二套權限；設定頁列裝置、一鍵撤銷。撤銷不能刪掉已同步到手機的資料，要白話寫清楚。
- **區網攻擊面**：預設只綁 `localhost`，使用者開啟「手機連線」才綁區網；PGlite 沒有資料庫埠可外洩（比初稿少一個風險）；後端檢查 `Host`／`Origin`；憑證私鑰只在桌機。
- **公共 Wi-Fi 偵測**：怎麼偵測「不是家用網路」**沒設計**。

## 7. 要經營的小服務

只有階段 1 需要一個：**裝置網域＋憑證簽發**（無伺服器函式加 DNS；私鑰由桌機持有，服務看不到筆記內容；掛了不影響已發的憑證約 90 天，只影響新裝置配對）。成本量級與網域費用初稿標「未查證」，**仍未查證**。signaling／STUN／TURN 只在階段 3。

## 8. 剩下的（只列真正沒人做的）

大小：小＝1–2 天、中＝3–6 天、大＝1–2 週以上（單人含測試，相對大小）。

| # | 項目 | 大小 | 依賴 |
| --- | --- | --- | --- |
| 1 | **階段 0 驗證**：Node＋資料夾 PGlite 跑完整 `server.ts`；斷電耐久；業主資料量下的啟動時間與記憶體；Electron 安裝檔大小與記憶體 | 中 | 無（先做，其餘靠它的數字） |
| 2 | **Electron 外殼**：系統匣、啟動／停止、資料夾位置、`sharp` 放 asar 外、Windows＋macOS 安裝檔 | 大 | 1 |
| 3 | **簽章與公證**（Apple 年費、Windows 簽章）；申請本身有等待時間，是排程瓶頸 | 小（工）＋等待 | 業主決定 Q3 |
| 4 | **手機區網配對**：裝置網域＋憑證服務、QR 配對、裝置清單與撤銷、`localhost` 預設綁定 | 大 | 1、2；業主決定 Q2；先做 E1–E3 實機驗證 |
| 5 | **桌面版升級與遷移**：升級前備份、新資料庫拒絕舊程式、失敗退回、更新器 | 中 | 2；#705 或 `feat/browser-app-friends` 的做法可參考 |
| 6 | **匯入器缺口**：Logseq、SiYuan、Evernote（ENEX）。現有 Obsidian 資料夾匯入（`obsidian/folders.ts`）與共用的圖片、關聯處理（`importers/shared/`）可重用 | 每個中 | 無；優先序見 Q4 |
| 7 | **公共 Wi-Fi 偵測**（預設關閉區網監聽） | 小 | 4 |
| 8 | **Tailscale 選配文件**（外出連線） | 小 | 4 |
| 9 | **Linux 打包** | 中 | 2 |
| 10 | **外出直連 (f)**：WebRTC 與 `apiFetch`、service worker 圖片轉交；iOS 未知 | 大 | 4；E3–E6 實機結果；與分散式同步（#1169）的傳輸層合併討論，不要做兩套 |

**不再需要做的（相對初稿）**：搜尋抽象層、遷移檔條件執行、內建 Postgres 子程序管理、pgroonga 三平台打包（桌面版用可攜搜尋；若日後覺得中文搜尋不夠好再另議）。

驗收條件（沿用初稿）：全新 Windows／macOS 電腦裝完，**不開終端機**，能建立筆記、重開機後資料仍在、手機掃 QR 後在 Brave 看得到並能離線編輯再同步、升級失敗能退回。

### 需要業主在 Tab S9／Android Brave 實機驗證的實驗（沿用初稿）

業主沒有 iPhone，iOS 一律「待確認」。每項請記結果、截圖、瀏覽器版本。

| # | 要確認什麼 |
| --- | --- |
| E1 | Brave 開 `https://<自有網域子網域>`（指到電腦區網 IP）正常嗎？路由器有沒有擋 DNS rebinding |
| E2 | 同上頁面：service worker 註冊成功、IndexedDB／OPFS 可用、可安裝到主畫面 |
| E3 | 公開 HTTPS 網頁 `fetch` 電腦區網 IP：有沒有跳區網存取權限、混合內容是否被擋 |
| E4 | WebRTC 資料通道：同 Wi-Fi、行動網路、加 TURN 的成功率與速度（只有走 (f) 才需要） |
| E5 | WebTransport `serverCertificateHashes`（14 天憑證）（只有走 (f) 才需要） |
| E6 | 鎖屏 5 分鐘後頁面與 service worker 還能不能維持連線（只有走 (f) 才需要） |
| E7 | 掃 QR 後網址 `#` 後面的內容有沒有保留 |

## 9. 要業主決定的事

| # | 問題 | 建議 |
| --- | --- | --- |
| Q1 | 桌面版資料庫採 **PGlite**，不內建真 Postgres，可以嗎？ | 可以。階段 0 若量到業主的資料量下不可接受，再回頭談真 Postgres |
| Q2 | 願意註冊並長期維護**一個網域**＋一個無伺服器小服務嗎（階段 1 手機連線唯一要營運的東西）？ | 願意。沒有它，區網 HTTPS 只剩 Tailscale 或使用者自己裝憑證 |
| Q3 | 簽章預算（Apple Developer Program、Windows 簽章，費用都未查證）要現在申請嗎？ | 要，申請有等待時間；沒簽的安裝檔一般使用者不敢裝 |
| Q4 | 匯入器缺口先補哪一個（Logseq／SiYuan／Evernote）？ | 先補 Logseq（Markdown 為主、可重用 Obsidian 資料夾匯入）；Evernote 的 ENEX 是 XML，另需寫解析。業主若沒有人在用就先不做 |
| Q5 | 第一版接受「只在同一個 Wi-Fi 內手機才能連，外出自己裝 Tailscale」嗎？ | 接受（階段 1＋2）。外出直連先看實際需求，並與分散式同步的傳輸層一起討論 |

## 附錄：外部來源與本文沒重新查證的事

初稿查證的外部資料（Chrome 區網存取權限、WebTransport、Tauri／Electron 簽章與更新器、Tailscale 定價、Cloudflare TURN 定價、各元件授權）**這次沒有重新查證**，數字與日期請以官方頁面為準：

- Chrome 區網存取權限：<https://developer.chrome.com/blog/local-network-access>
- Electron 簽章：<https://www.electronjs.org/docs/latest/tutorial/code-signing>；Tauri 更新器：<https://v2.tauri.app/plugin/updater/>
- Tailscale 定價 FAQ：<https://tailscale.com/pricing/faq>；Cloudflare TURN 定價：<https://developers.cloudflare.com/realtime/sfu/pricing/>

授權（初稿 2026-10-31 對 npm 中繼資料查過）：Electron、electron-updater、PGlite、pgvector 套件為 MIT 或 Apache-2.0，不涉及 GPL／AGPL；`sharp` 為 Apache-2.0（libvips 為 LGPL，動態連結，**未查證**）；公開發布前請核對各元件原始 LICENSE（呼應 [自架與發行決定](../decisions/self-host-and-release.md)）。內建真 Postgres、pgroonga 不在這個方案裡，相關授權列已移除。

本倉庫依據：`packages/backend/src/db.ts`、`dbPglite.ts`、`dbMigrations.ts`、`services/textSearch.ts`、`server.ts`、`modules/importers/`、`packages/frontend/src/lib/api.ts`、PR #705、#1157、#1164、#1169。
