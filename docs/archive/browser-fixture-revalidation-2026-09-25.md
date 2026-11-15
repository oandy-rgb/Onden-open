# 隔離瀏覽器案例與舊 fixture 補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

對應 GAP-65 的 Calendar、指令面板、資料夾首次匯入／同來源重匯及 RSS 線索，另補 CAN-09 的
`.canvas` 正常往返。來源 `7ea9be3`；本批只更新三份 E2E 案例及驗收紀錄，
沒有修改產品程式。

環境為 `compose.e2e.yaml` 的獨立 `onden_test` PostgreSQL、目前後端／前端映像、
`127.0.0.1:5100`，Playwright 1.60.0 無頭 Chromium、單一 worker。
全域 setup 使用隔離 owner 測試帳號；沒有使用正式 localhost、外部 RSS 或公開目的地。
所有瀏覽器案例依序執行，完成後已停止隔離容器。

| 使用案例 | 修正前重現及本輪結果 |
| --- | --- |
| Calendar 日期格與前後月 | 伺服器 view 執行和畫面 chip 均有事件，但舊 `has` locator 把整個 `.cv-cal` 當成儲存格後代，15 日斷言逾時。改用相對於日期格的 chip locator 後，15 日、上月／下月、Today 返回全部通過；保留原斷言及畫面。 |
| 指令面板無命中查詢 | 舊測試等 `No results` 逾時；實際畫面提供 `Create note: …`。改為點建立項目，核對標題與重載後仍能開啟；通過。 |
| Your Data 匯入 Markdown 資料夾 | 舊測試選檔後直接等結果，實際停在來源確認，故逾時。選擇唯一來源名稱並點 `Start import` 後，結果顯示匯入兩筆；伺服器搜尋兩個標題與 frontmatter 標籤均通過。未驗相同來源再次匯入。 |
| 同來源重匯 API | 舊測試以 `upsert:true` 卻不給來源，第一個回應沒有 `imported` 而失敗；目前 API 對此拒絕。改用固定來源 UUID／名稱後，初匯 1、修改更新 1、原樣重匯 unchanged 1、`upsert:false` 再建 1，均通過。每次先核對 HTTP 成功，避免把錯誤 JSON 當成匯入結果。 |
| RSS 訂閱／閱讀 | 先前 full-stack 初跑曾見 422；目前來源、獨立測試資料及隔離 stack 下未重現。UI 訂閱→staging→Read→標註自動保存→Skip／Skip all，以及首頁待讀提示，兩項均通過；422 原因未證明。 |
| `.canvas` 匯入與匯出 | 真實匯入三卡一組一邊，核對顏色、版面與伺服器資料，再下載 `.canvas` 並核對結構與顏色；通過。這只驗正常往返，不涵蓋部分建立／失敗重試。 |

最終 Chromium 專項 **7 項通過、0 跳過**：Calendar 1、指令面板 1、資料夾首次匯入 1、
同來源重匯 1、RSS 2、白板往返 1。四項舊 fixture 失敗均保留修正前 log／JSON／畫面，修正後
再跑通過；RSS 與白板只有本輪成功紀錄。原始輸出放在 gitignored
`.acceptance/2026-09-25/{calendar-nav,gap65-fixtures,reimport-gap65,rss-gap65,canvas-interchange}/`；
共同 checksum 為 `.acceptance/2026-09-25/browser-fixtures-SHA256SUMS`，已全數核對。
相關前端單元回歸 7 檔／89 項通過，`--maxWorkers=1`。
同批提交前兩端 TypeScript／lint 及前端 build 通過；依序執行，沒有並行啟動 build 或瀏覽器。

這些證據沒有完成 COL-06 的跨年、日期修改、手機與重開矩陣，NAV-04 的全部指令、
RSS-01 的非法 feed／離線／拒絕，DATA-02 的改名／移動、衝突與整批恢復，以及 CAN-09 的錯誤與
部分建立情境；各列仍為「部分」。GAP-65 已知的四項 fixture 問題本輪已重現並
修正，RSS 原 422 在這批獨立兩項測試未再重現。後續全掃描指出舊組合測試仍以私有媒體 URL
當 feed，修正與 305 項掃描結果見 [FS](fullstack-sweep-2026-09-25.md)；不能據此關閉
整體 E2E 缺口或宣稱正式部署已套用。
