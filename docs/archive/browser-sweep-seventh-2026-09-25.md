# 第七輪隔離 Chromium 掃描與 PDF／日常旅程補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `32cb6be`。既有 `onden_test` 隔離 stack、唯讀前端 build、
Playwright 1.60.0 無頭 Chromium，單一 worker、零重試、五項失敗即停。
使用隔離 owner 與時間戳資料；AI 為後端 deterministic stub，無外部模型或公開目的地。

排除前六輪已執行案例後掃描 118 項 Chromium；達上限時 **32 通過、
1 略過、5 失敗、80 未執行**。五項原失敗的 log、JSON、DOM、畫面均保留；
修測後原五項定向重驗 **5／5 通過**。

| 案例／角色 | 原失敗與重驗結果 | 尚缺邊界 |
| --- | --- | --- |
| PDF-03，owner／單頁測試 PDF | 舊側欄搜尋在大量資料下沒有留下查詢，測試還沒進入 PDF；改以本輪節點 ID 深連結，先核對 `pdf_url` 寫入。滑鼠筆畫保存成 `ink_data` 向量與 PDF 標註、SVG 可見，重載後仍在；通過。 | 多頁、不同縮放、失敗／離線、真實選檔與 PDF 閱讀路徑仍待驗。 |
| REV-02，owner／`#review` 筆記 | UI 評 Good 後測試立刻 GET 屬性，提交未必完成；改輪詢 `_review_state`，伺服器排程狀態落盤；通過。 | 多評級、重送、權限與手機仍待驗。 |
| TASK-01，owner／三筆任務 | 測試把 2026-06-16 寫死成「今天」，目前日期已變；改取執行當日與三天前。Overdue、Today、Unscheduled 三桶各有預期任務；通過。 | 時區跨日、拒絕／離線與大量任務待驗。 |
| NOTE-06／NAV-06，owner／390px | 舊 QuickCapture FAB 在手機編輯畫面隱藏；目前主要入口是底部導覽中央 Capture。點擊後輸入框可見；通過。 | 真實 PWA share sheet／系統手勢、保存失敗待驗。 |
| AI-01，owner／stub Ask | 答案另存的引用已改用穩定 `[[slug|標題]]`，舊測試只接受 `[[標題]]`；修期待後驗出來源列、續問、另存 AI 筆記與 slug 引用；通過。 | 真實模型品質、錯誤／撤權、手機與可恢復輸入待驗。 |

本輪另有離線屬性組織、task/tag 重連、公開內容私有隔離、PWA manifest 與
share-target 參數等通過案例。五項效能測試在此隔離資料庫記錄：冷頁面導向
**384 ms**、5 次 bootstrap 平均 **136 ms**、單節點建立 **40 ms**、lens 切換
**1605 ms**、同時 50 筆建立 **1253 ms**、限併發 8 的 50 筆建立 **733 ms**，
其後 bootstrap **96 ms**。這是本機當次觀察，不是正式環境 SLA；
沒有長文／大白板／記憶體量測。

證據位於 gitignored `.acceptance/2026-09-25/seventh-sweep/` 與
`.acceptance/2026-09-25/seventh-fixes/`。PDF-03 因本輪真實瀏覽器筆畫與伺服器
落盤／重載證據，由待盤改為部分；其餘列狀態不變。完整 305 項 E2E
仍未通過，80 項 Chromium 與 20 項其他引擎待執行。
兩端 TypeScript、前端 build（`npm run preflight`）及兩端 lint 均通過。
