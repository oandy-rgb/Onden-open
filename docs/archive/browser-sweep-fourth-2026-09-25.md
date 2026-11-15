# 第四輪隔離 Chromium 掃描與手機案例補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點提交 `bda5984`。沿用獨立 `onden_test` 與唯讀掛載的前端 build；
Playwright 1.60.0 無頭 Chromium、單一 worker、零重試、五項失敗即停。
隔離 owner 建立具時間戳的筆記與標籤；雙 context 使用同一隔離帳號。
沒有碰正式 localhost 或正式資料。

排除前三輪 135 個已執行案例後，掃描 150 項 Chromium；達失敗上限時
**4 通過、5 失敗、141 未執行**。原五項失敗各保存 log、JSON、DOM 與畫面，
修正 E2E 假設後以同一單工環境定向重驗，**五項全通過**。

| 案例／角色 | 失敗重現與重驗結果 | 尚缺邊界 |
| --- | --- | --- |
| NOTE-03／NAV-06，owner／Pixel 5 | Quick capture 後測試點隱藏的桌面樹列；改等待建立對話框結束，從手機編輯畫面返回清單選取。輸入 `first`、Enter、`second` 確實分行，勾選列 Enter 延續為新勾選列；通過。 | 真實鍵盤、IME、離線與拒絕保存。 |
| NAV-07，owner／Pixel 5 | 手機編輯畫面背後的樹列隱藏，原長按案例到不了起點；回到清單後長按 child、拖到 host，伺服器 `parent_id` 變更；通過。 | 真實觸控與搬移拒絕／撤銷。 |
| NAV-06，owner／390px | 工具列案例的共用找筆記 helper 假定桌面搜尋框可見；改由 helper 在手機先返回清單、逐鍵輸入並確認框值。聚焦後格式工具列可見，點 Bullet list 生效；通過。 | 真實軟鍵盤高度與 320px。 |
| NAV-06，owner／390px | Info 的檢視與寬度檢查已通過，最後把畫面存到唯讀 `/work/e2e/` 才失敗；改存 Playwright 個案輸出目錄後通過。 | 實際裝置及更多 inspector 欄位。 |
| PER-04／05，owner／兩個 context | B 的受控制搜尋框用 `.fill()` 沒留下查詢，舊斷言等不到標題；改逐鍵輸入並核對框值。A 建立、改名、加標籤後，B 不刷新即顯示新標題；B session bootstrap 同時含新標籤；通過。 | 競態同編、離線與撤權仍待驗。 |

共用 `selectNodeByTitle` 只在需要時從手機編輯畫面返回清單，保留桌面原有入口；
受控制輸入改採實際鍵盤事件並驗證值，不以空搜尋結果誤判同步失敗。
證據位於 gitignored `.acceptance/2026-09-25/fourth-sweep/` 與
`.acceptance/2026-09-25/fourth-fixes/`。
兩端 TypeScript、前端 build（`npm run preflight`）及兩端 lint 均通過。

完整 305 項 E2E 仍未通過；剩餘 141 項 Chromium 與 20 項其他引擎待跑。
本批只補正常路徑，不能據此推進上述驗收列狀態。
