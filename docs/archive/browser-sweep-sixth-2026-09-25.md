# 第六輪隔離 Chromium 離線流程補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `9e552b0`。沿用獨立 `onden_test`、唯讀前端 build、Playwright 1.60.0
無頭 Chromium；單一 worker、零重試、五項失敗即停。測試只使用隔離 owner
與具時間戳的測試筆記，沒有操作正式 localhost 或正式資料。

排除前五輪已執行案例後掃描 126 項 Chromium；達上限時 **3 通過、5 失敗、
118 未執行**。五項失敗都先撞到同一個舊 selector：畫面現在有兩個
`.sync-status .status-dot.offline`，Playwright strict mode 拒絕任選其一。
一併更新七個尚有此 selector 的離線／同步測試檔，限定可見狀態列。

| 案例／範圍 | 修正後的實際結果 | 尚缺邊界 |
| --- | --- | --- |
| NOTE-03／06，owner／離線快速捕捉 | 離線建立後顯示本機 pending，重連送達後端；通過。 | 403／503、回應遺失與重送結果仍需整列對照。 |
| NOTE-03／TAG-01，owner／通勤組合 | 離線捕捉三筆並建立連結與標籤，重連後三筆收斂；通過。 | 跨角色標籤拒絕、部分失敗與真機待驗。 |
| NOTE-03／PER-04，owner／反覆斷線 | 修 selector 後，測試仍在初次 membership gate 尚未解除時切離線，點正文被 gate 擋住；先等待核對完成再進入兩段斷線。兩次 pending 各自清空，伺服器正文含兩段編輯，節點唯一且版本數在測試上限內；定向重驗通過。 | 冷啟動完全離線登入、較新輸入與拒絕保存另驗。 |
| INK-01，owner／手寫筆記 | 離線筆畫與標題待同步後重連落盤；另一案例離線 host remount 後筆畫仍在本機鏡像，重連後落盤；兩項通過。 | 真筆壓／觸控屬 INK-02；拒絕、損壞鏡像與多裝置待驗。 |

本批五項原失敗都有定向通過；第一次定向跑 **4 通過、1 失敗**，
反覆斷線案例加上 gate 等待後單獨通過。這些不同嘗試不累加為六項新案例。
證據位於 gitignored `.acceptance/2026-09-25/sixth-sweep/` 與
`.acceptance/2026-09-25/sixth-fixes/`。另三個被同步改動但尚未執行的測試檔
`offlineOrganize`、`offlineTaskTag` 及 `syncStatus` 仍待後續跑到才算通過。
兩端 TypeScript、前端 build（`npm run preflight`）與兩端 lint 均通過。

完整 305 項 E2E 仍未通過，118 項 Chromium 與 20 項其他引擎待執行；
本批只增添正常／離線情境證據，驗收狀態不變。
