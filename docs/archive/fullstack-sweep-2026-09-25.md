# 隔離 full-stack E2E 掃描與案例修復（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `3bc39d7`。環境為獨立 `onden_test` PostgreSQL、隔離後端／前端映像、
`127.0.0.1:5100`、Playwright 1.60.0 無頭 Chromium；全域 setup 登入隔離 owner，
RSS 來源使用同一隔離 stack 的公開 `/site/feed.xml`。所有瀏覽器執行均為一個 worker、
零自動重試、依序進行；沒有使用正式 localhost、正式資料或外部目的地。

原始全專案掃描收集 **305 項**，設五項失敗上限後得 **61 通過、5 失敗、239 未執行**。
五項失敗均有 log、JSON 與失敗畫面；停在 `designLenses`，因此不能稱作完整 E2E 通過。
本批修正的是這五項案例對當前產品契約的舊假設，沒有改產品程式。

| 案例及角色／範圍 | 失敗重現、修正後的預期與實際 | 尚缺的邊界 |
| --- | --- | --- |
| CAN-02，owner／同一白板的既有筆記 | 加入後畫面立即有卡片，舊測試立刻讀 API 曾無成員；等待伺服器成員後確實存在。原先重載停在被點開的目標筆記，改明確回到白板，再見加入卡片；通過。移除案例也先等 API 成員數變一，再重載仍一張；通過。 | 拒絕、離線重播、跨分頁仍依 CAN-02 保留「部分」。 |
| RSS-01／06、REV-07，owner／隔離公開 feed | 舊組合案例將 RSS XML 上傳為需要登入的私有媒體，後端訂閱抓取回 422；改由本機公開站點 feed 提供文章後，訂閱與兩篇本輪文章進 staging。收件匣目前按來源列示且包含先前測試未讀，改依 `/api/rss/sources` 的順序選本次 source，從閱讀清單選本輪文章。選句建立引用卡片、加 `#review`、評分 Good、首頁數量下降及今日清單均通過；Reader 作為主畫面，靠後續導航離開。 | 這個公開 feed 會包含隔離資料庫先前測試文章；測試不假定固定未讀數。失敗儲存、離線與手機仍待盤。 |
| HIST-08，owner／測試筆記 | 舊案例假設 API 新建筆記立刻進側欄本機索引，等不到項目；改用新節點 ID 深連結開啟，再用筆記的 More actions → Delete。Undo 提示、`/undelete` 請求與 bootstrap 復活通過。 | 權限、slug 衝突、離線／手機仍待盤。 |
| TAG-04／COL-03，owner／隔離 schema tag | 舊案例找已移除的 `.schema-lens-instances`；改建立可見 `status` 的 table view，從標籤頁切 table，核對標題與 `todo` 欄值；通過。 | 其他欄位與拒絕、手機矩陣仍待盤。 |
| 治理組合流程，owner + tag-scoped agent／第二個瀏覽器 context | agent 建立、標籤 automation 與 Inbox 成組即時到達先已成功。撤銷後伺服器 bootstrap 已無節點；舊側欄斷言找已移除的空結果 class，改核對輸入查詢、`0 results`、無原標題，並核對伺服器搜尋與 agenda；通過。 | 更多角色／撤權競態與重連仍待盤。 |

定向重驗累計涵蓋原五項失敗，最終各有一次通過；額外的治理組合與發布組合也通過。
測試先後批次保留失敗過程，不把相同案例的多次執行相加當成新的產品覆蓋。
證據位於 gitignored `.acceptance/2026-09-25/fullstack-sweep/` 與
`.acceptance/2026-09-25/fullstack-fixes/`；61 個檔案的 SHA-256 清單
`fullstack-fixes/SHA256SUMS` 已逐檔核對。兩端 TypeScript／lint 與前端 build 通過。
本批沒有故障注入或正式環境 smoke；
原盤點狀態沒有因舊 E2E fixture 的修復而推進。
