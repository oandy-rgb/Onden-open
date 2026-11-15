# Review TagPack 匯入到評分的隔離瀏覽器驗收（2026-09-26）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `28da3b9`；本案例與本紀錄由同一批提交追溯。使用隔離 Docker project
`onden-task-e2e`、新建的 `onden_test` volume、owner session 與
`127.0.0.1:5100`，未連正式 localhost。後端掛載本輪編譯的 `dist`，前端掛載
本輪 build；Playwright 1.60.0 的無頭 Chromium 採 1280 × 800、單一 worker、
零重試。測試資料只在隔離資料庫建立，標題含本輪時間戳。

案例 `reviewPack.spec.ts` 的「Review starter settings govern a browser grade
and an existing card's next grade」涵蓋同一條使用路徑：

1. 在 Settings → Your Data 按 Review starter 的 Install；乾淨資料庫顯示
   `installed as #review`。讀回 tag schema 的 retention `0.9`、最長間隔
   `365` 天、每日新卡 `15` 張，並從 `/api/review/stats` 讀到 `15`。
2. 建立 deck 和一張帶 `#review` 的子筆記。把每日上限設為 `0`、最長間隔設為
   `2.9` 天；全域 queue 不列這張新卡，stats 回 `0`。在 deck 筆記執行
   「Review cards under this note」，畫面揭示答案並按 Good；該次指定範圍
   允許學習，完成畫面顯示 `1 reviewed`。持久化的 `_review_state` 為首次
   評分，期限與評分時間相差整數 `2` 天。
3. 重載頁面後狀態仍在。把設定改成每日 `1.9` 張、最長 `1` 天，stats
   回整數 `1`；對同一張舊卡再評 Good，`reps` 變 `2`，新期限相差 `1` 天。
   再以相同 Easy 評分比較兩張新卡：保留率目標 `0.7` 的排程天數長於
   `0.97`，證明該設定影響排程而不只是保存於 schema。

乾淨資料庫最終版本 **1/1 通過**；同一案例在已存在 `#review` 的資料庫
也 **1/1 通過**。重跑時不將 409 名稱衝突當成安裝成功，而是先使用現有標籤，
並在案例結束還原原設定，避免改變其他測試的每日預算。較早的乾淨資料庫
版本亦 1/1 通過；最後補上匯入後 stats=15 的斷言，再清空隔離 volume
重驗。原始 Playwright JSON 與 SHA-256 manifest 位於 gitignored
`.acceptance/2026-09-26/review-journey/`。本批 `npm run preflight`、後端及
前端 lint 通過；沒有修改產品程式碼，也沒有新增本輪缺陷。
新增後以 Playwright `--list` 收集到 Chromium **286 項／134 檔**；本批
只執行上列單案，不能把清單數當成全量通過數。

此證據將 **REV-06 從待盤推進為部分**。已驗的是 owner、桌面、正常匯入、
改設定、真實畫面評分、重載，以及小數邊界。不同角色／tag scope 的拒絕、
非法配置的完整型別與極值、409／503／回應遺失、離線重連、手機 390／320px
及正式部署仍缺；不能宣稱整列「已盤且通過」。
