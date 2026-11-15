# 複習評分回應遺失與 503 重試（2026-09-28）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `0b6125e`。原本 `ReviewPanel` 的 Good／Hard 等按鈕直接送出評分；
若伺服器已提交但瀏覽器沒收到回應，畫面留在同一張卡片，下一次按鈕卻是
沒有原冪等鍵的新操作，會把同一張卡評兩次。前端單元案例先以「第一次
`fetch` 失聯、第二次回 `200 {deduped:true}`」重現失敗：沒有提示使用者
固定原選項，也沒有可重用的鍵。

比較兩個邊界：把評分接到一般 `makeOnlineOperation` 可重用請求鍵與錯誤分類，
但此面板還需另外傳入資料層 context，而且僅按 path/body 去重仍允許使用者
在模糊失敗後改按另一個評分；由 Review 面板保存「目前卡片、原評分、原鍵」
則能直接表達同一張卡片的下一步。選後者，沿用既有 `randomUUID`、
`classifyWriteFailure` 與後端 spine 交易內的 `Idempotency-Key` claim，
未增加新的公開 API 或另一套後端去重表。

現在每次評分送出 UUID 冪等鍵。可重試錯誤或 401 後，卡片保留，畫面提示
重按同一個按鈕；其他評分暫停，重按使用相同鍵。伺服器若回
`200 {deduped:true}`，代表原交易已提交，畫面才前進。403 等永久拒絕
不宣稱已提交，清除該鍵、保留卡片並使用共用錯誤說明；其後可以重新選擇。
這個鍵只在面板存活期間保存；跨重載時以伺服器 queue 重新判斷是否仍到期，
沒有宣稱跨裝置保存未確認的評分選擇。

驗證：前端 `ReviewPanel.test.tsx` **13/13 通過**，涵蓋模糊結果同鍵重試、
403 後新鍵與原有翻卡／評分。隔離 `onden_test` 全棧、1280 × 800 無頭
Chromium、單一 worker、零重試：`reviewGradeRecovery.spec.ts` **1/1 通過**。
它先讓真 PostgreSQL 提交後只中斷瀏覽器回應，核對 UI 留卡、舊評分鍵、
重試後該卡 `reps=1`；第二張卡先在送達伺服器前回 503，重試亦同鍵且
最後 `reps=1`。既有 `reviewLoop.spec.ts` **3/3 通過**。完整
`npm run preflight`（兩端 TypeScript 與前端 build）及兩端 lint 通過；
目前 Chromium 測試清單為 **287 項／135 檔**，本批只執行相關四個瀏覽器
案例，不能當成全量通過。Playwright JSON、清單與 SHA-256 位於 gitignored
`.acceptance/2026-09-28/review-grade-recovery/`。

本批關閉 **GAP-82** 的同一面板生命週期重複評分缺陷。REV-02 保持「部分」：
手機 viewport、四種評分的完整矩陣、離線冷啟動與跨重載未確認操作仍缺。
VPS 與正式 localhost 尚未以這個版本做讀寫 smoke。
