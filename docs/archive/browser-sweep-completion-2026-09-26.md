# 隔離瀏覽器分段掃描收尾（2026-09-25～26）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `9446678`。沿用獨立 Docker project `onden-task-e2e`、資料庫
`onden_test`、localhost `127.0.0.1:5100` 與唯讀掛載的本輪前端 build。
Playwright 1.60.0 使用無頭瀏覽器、單一 worker、零重試；掃描最多五項失敗即停。
沒有連到正式 localhost，也沒有使用外部公開目的地。AI 使用 deterministic stub。
操作者是固定隔離 owner，這批入口未額外限制 human／token tag scope；
個別權限測試仍依其自身 fixture。重載、斷線重連只在相應案例執行，
不能從一次正常操作推論其他入口也已驗過。

對應提交：`9e1832c`（Review／RSS）、`cd3f2e4`（大量資料）、
`7bb9597`（欄位／任務）、`dea53b5`（歡迎與視覺擷取）。

第九輪排除前八輪已執行案例後掃描 73 項 Chromium：**5 通過、5 失敗、
63 未執行**。原五項改正後，Review starter 兩項與 RSS 閱讀兩項在重建的
乾淨隔離資料庫各自通過；5,200 節點案例留到其他瀏覽器案例跑完後單獨通過。
第一次輕量重驗在前次壓力案例留下的 5,200 多筆資料上，冷啟動 membership
gate 遮住操作，另有 RSS staging 查不到本次項目；該次四項失敗及畫面照留。
只清除 `onden-task-e2e` 的測試 volume，再用快取 image 重建，未動正式資料。

第十輪掃描剩餘 63 項 Chromium：**56 通過、4 失敗、3 跳過**。
原四項修測後各自定向通過；UX 截圖案例原本雖標記通過，手機編輯器兩張截圖
實際失敗，改以本輪建立的節點 ID 深連結後，淺／深主題都成功產生。
畫布 gallery 原本找舊空狀態 class，會寫出 FALLBACK 畫面但仍標記通過；
改用目前 `.canvas-empty-state` 後單獨重驗通過，沒有 fallback 警告。
另外四種跨瀏覽器 project 的 20 項全部通過：Firefox、WebKit、
mobile Chrome、mobile Safari 各五項，涵蓋導覽、overflow、快速捕捉與編輯器。

| 範圍 | 原失敗／修正後可重現結果 | 保留限制 |
| --- | --- | --- |
| REV-06、UX-04：Review starter | 舊測試仍找 Settings → Import，現在是 Your Data／你的資料；限定桌面 rail 設定入口後，安裝 `#review`、統計 API 與繁中列各通過。 | retention／interval／new_per_day 的邊界及實際評分完整循環仍未驗，REV-06 維持待盤。 |
| RSS-01／06：訂閱與閱讀 | 同名 Onden 訂閱被測試用標題誤選。訂閱列與 Inbox strip 現在帶來源 ID；測試按本次 URL 對應 ID 操作，並容許既有已發布文章造成未讀數大於兩筆。選句另存、來源關聯、Skip／Skip all 與手機閱讀返回通過。 | RSS 多段失敗、離線重播、拒絕與跨帳號仍未覆蓋；同一公開 feed 的舊文章不是本輪新節點。 |
| PERF-01：大量筆記完整性 | 原測試用短正文卻期待 280 字摘要不含正文，並以所有歷次 `scaleint-` 節點計數。改用長正文尾標記與本輪節點 ID／stamp，單跑 5,200 筆通過 slim→hydrate、伺服器搜尋、匯出與 backlink。 | 只證明完整性，沒有長文輸入／搜尋延遲與記憶體門檻；側欄本機搜尋在此規模仍只記錄已知缺口，PERF-01 維持待盤。 |
| COL-03、TASK-01、NAV-06：欄位／任務 | Escape 測試的 Promise 未 await；週期任務現在以圖示和 tooltip 呈現；手機任務截圖原寫到唯讀來源目錄。修測後核對欄位未落盤、週期下一筆伺服器資料、390px 無橫向 overflow／延後／完成及截圖，三項通過。 | 欄位與任務的 403／503、離線與全部欄位型別仍缺。 |
| ACC-01、UX-01：首次歡迎與視覺截圖 | 四個歡迎卡按鈕共用 class，舊測試違反 strict selector；限定「Write your first note」後建立並關卡通過。手機編輯器截圖改用本輪 ID，畫布空狀態錨點也修正；重驗通過。 | 這些是模擬 viewport 與 screenshot corpus，沒有真機鍵盤／safe area、逐頁人工視覺判定或完整鍵盤流程。 |

十輪排除清單互不重複，合計執行 **285 個 Chromium 案例**：首次執行
229 通過、49 失敗、7 預設跳過；49 個原失敗後來都能在各自的定向 JSON
找到同名成功結果。加上其他引擎 20 項，**已執行且最後有成功證據的
獨立案例為 298 項，預設跳過 7 項**。七項包括三個擷取 probe、兩個臨時
tour、一個慢速 scale probe，以及已明確停用的 `nodeSwitchScale`。
這是分段、不同測試資料庫狀態的覆蓋證據，**不是同一次 305 項全綠**；
被跳過的測試也不能當作通過。`nodeSwitchScale` 對側欄大資料搜尋的已知缺口
沒有因伺服器搜尋通過而關閉。每項原失敗、後續成功、DOM 與 screenshot 證據
在 gitignored `.acceptance/2026-09-25/`、`.acceptance/2026-09-26/`；
本報告對應的摘要與 SHA-256 manifest 在後者。

本批兩端 TypeScript、前端 build（`npm run preflight`）及兩端 lint 通過；
最後產品資產 build 是加入來源 ID 後的版本。隔離容器測畢已停止，
測試 volume 保留供查證。正式 `.env`、備份／還原演練與正式 localhost
部署 smoke 仍未完成，因此本批不推進任何整列驗收狀態；清單仍為
**已盤 7、部分 113、待盤 31、需環境 12**。
