# 第五輪隔離 Chromium 掃描與同步／拆合補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `6bb98a4`。沿用隔離 `onden_test`、唯讀前端 build、Playwright 1.60.0
無頭 Chromium，單一 worker、零重試、五項失敗即停。操作者為隔離 owner；
離線案例以瀏覽器 context 切斷／恢復連線，沒有使用正式服務或資料。

排除前四輪 144 個已執行案例後掃描 141 項 Chromium；達上限時
**9 通過、1 略過、5 失敗、126 未執行**。五項失敗與畫面、DOM、JSON 留存，
修正過期 E2E selector／指令入口後，原五項單工定向重驗 **5／5 通過**。

| 案例／範圍 | 原失敗與重驗結果 | 尚缺邊界 |
| --- | --- | --- |
| NOTE-03／PER-04，owner／A、B 兩個 context | A 在離線狀態指示器兩個匹配元素上先觸發 strict-mode；改選可見狀態列。離線改正文時出現 pending，B 尚無新文字；A 重連後 pending 消失，B 的 session 取得新正文；通過。 | 完全離線冷啟動、拒絕／衝突與真機待驗。 |
| NOTE-03／PER-05，owner／同一 context 兩分頁 | 同樣被重複狀態點 selector 擋住；修後兩分頁同時重連，單筆離線建立只在伺服器產生一筆，兩邊 pending 清空；通過。 | 更多並發寫入、跨 context 的同帳號鎖與失敗注入待驗。 |
| NOTE-12，owner／筆記及子筆記 | 合併／拆分測試仍找舊 `for commands` placeholder，且用 Linux 不可靠的 `Meta+k`；改點目前指令面板按鈕與 `.palette-input`，依現有動作文字執行。兩子筆記合入父筆記、原子節點移除、順序和正文核對通過；空子筆記顯示友善提示；按標題拆為三個子筆記且父筆記保留 wikilink，均通過。 | 403／503、部分交易失敗、重送與手機入口未驗。 |

本批只改 E2E，沒有改產品程式。證據位於 gitignored
`.acceptance/2026-09-25/fifth-sweep/` 與 `.acceptance/2026-09-25/fifth-fixes/`。
兩端 TypeScript、前端 build（`npm run preflight`）及兩端 lint 均通過。
NOTE-12 有本輪真實 UI→API 正常／空情境，故從待盤改為部分；其他列狀態不變。
完整 305 項 E2E 尚未通過，126 項 Chromium 與 20 項其他引擎未執行。
