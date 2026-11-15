# 工作區重載與失敗恢復（2026-09-30）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：UX-01／ACC-07／SYS-04，起點為 `d3001bf`。使用者截圖停在「正在確認工作區資料」。
這是等待可讀資料核對的保護畫面；本批保留完整 membership diff、最後版本確認、事件追平及核對中變更的 dirty latch。

## 實測與設計取捨

隔離 `onden-toast-e2e`／`onden_test`，同一 Chromium、1280×800、owner 無 scope 限制。
瀏覽器限制 1 CPU／1 GB、單 worker；固定同一筆記，先建立瀏覽器快取再重載，每個條件三次。
本機與額外 150ms 網路延遲各量三次，不將結果當成 VPS 實測。

原版每次 `/api/sync` 只一輪，收件匣卻讀四次，approvals 三至四次。
根因是治理 hook 用整個 `data` 物件作刷新條件；本機載入、bootstrap、同步投影與一般編輯都會觸發不相關讀取。
因此本批不移除權限核對，也不以「只跑 sync」取代 bootstrap，後者沒有完整角色、集合、白板位置與網站 metadata。
全改 slim bootstrap 對少量短文可能多一次正文請求，本批亦未採用。

比較把治理 hook 移到條件掛載子元件，與原 hook 明確接受安全就緒狀態／工作區身分：選後者，保留篩選和既有審核入口。
`useInboxGovernance({ refresh, enabled, workspaceId })` 在已上線、完成啟動且可讀核對成功時讀取。
SSE、篩選與審核後仍刷新；同查詢連續 tick 合併為後續一輪，普通正文輸入不重抓收件匣。
禁用／切換／卸載立即隱藏舊列、取消舊請求並丟棄晚到結果。

## 核對不再無限等待

比較全域 API 一律加逾時與明確包裝唯讀操作，選 `readWithDeadline(read, signal?)`：
`readWithDeadline(signal => api("/api/inbox", { signal }), querySignal)` 讓呼叫者明確標示唯讀操作。
15 秒期限涵蓋讀取 response body，取消 transport 並丟棄晚到結果。僅套用 sync delta／membership／projection，以及收件匣兩個 GET。
前者包含唯讀 POST；任何提交寫入與離線重播均不套這個期限，避免把回應遺失誤當成沒有提交。

`MembershipGate` 保留手動立即重試；仍顯示時從 5 秒開始重試，失敗退避至 10／20／30 秒，頁籤隱藏時暫停。
成功但 dirty 再核對讓 gate 繼續掛載時，仍保留後續重試；只有同步層可以解除遮罩。
同時只能有一次本介面要求的核對，卸載後忽略晚到回饋。
這不是所有網路操作的總期限：待傳寫入、bootstrap 與白板讀取仍沿用原本契約。

## 驗證

重載計時從 navigation 開始，到標題可用且遮罩消失；確認等待從遮罩出現到消失。
以下為三次中位數，非統計上顯著改善的宣稱；固定資料僅含本批隔離測試筆記，未代表大工作區或真實 VPS。

| 條件 | 整頁重載：原版 → 新版 | 確認等待：原版 → 新版 |
| --- | --- | --- |
| 本機 | 1,690 → 1,582 ms | 802 → 653 ms |
| 額外 150ms 網路延遲 | 1,529 → 1,515 ms | 995 → 926 ms |

工作區可用前已完成的 `/api/inbox` 回應，原版每次 4 份，新版為 0–1 份；新版將該讀取移到可讀核對完成後。
整頁重載仍受前端啟動、worker 與網路往返影響，本輪整體改善有限，不承諾數倍加速。

- 回歸先重現：原版 gate／read deadline 6 案失敗；治理生命週期 11 案失敗；新單飛讀取的 deadline 另 4 案失敗，修後通過。
- 合併相關前端 13 檔／166 項通過，涵蓋 membership、dirty latch、晚到結果、離線佇列、帳號隔離、治理與複習。
- 前端 typecheck／lint／build 通過；後端未變，沿用同輪通知批次已通過的後端 typecheck／lint。
- Chromium full-stack 11 項通過、零略過（單 worker／1.7 分鐘）：治理六案、跨視窗同步／待審核效果兩案、離線捕捉重連一案，以及本批新增的暫時 503 自動恢復／真正停滯讀取逾時兩案。
- 停滯讀取案例確認原請求在約 15 秒後被取消、沒有手動點擊仍能完成新核對；暫時 503 期間保留遮罩，恢復後重新顯示同一筆記。
- 原通知批次另有 5 項單元、24 組配色／尺寸樣本與 1 項真實刪除復原通過；通知程式提交 `d3001bf` 已先部署。
- 未重新掃描全部前後端測試；本批沒有後端、資料表或權限政策修改。

本機證據：`.acceptance/reload-speed-2026-09-30/` 的 `related.log`、`typecheck/lint/build.log`、各 red/green 日誌、`browser/results.json`、`browser/reload-{before,after,summary}.json`；第一批通知另見相鄰紀錄。
此批不推進 163 項功能總表的整列狀態；未宣稱所有啟動、真機、跨瀏覽器或完整回歸已完成。

## VPS 部署

2026-09-30 前端部署 `7723b2dacec9aa3ac12248567d31f17d093ef376`，包含通知修正；已推送既有 `main`。
部署前 DB／content 備份、SHA-256 校驗、拋棄式 DB 全表指紋及 content 還原比對皆通過。
備份：`/srv/onden/backups/reload-speed-20260930130836-7723b2dacec9`。
後端容器／映像與 migration baseline 不變；首頁 200、未登入 bootstrap 401、後端 health 200，新唯讀期限的 JS 產物與 HTTP 實際提供內容 hash 相同。
更新後仍維持使用者指定的 Tailnet HTTP 入口；未對正式內容執行故障注入或刪除復原測試。
本輪本機測試 stack／volume 與 VPS 還原演練資源皆已移除。備份目錄保留 `SUCCESS`、校驗／還原證據與前端專用 `rollback.sh`。
