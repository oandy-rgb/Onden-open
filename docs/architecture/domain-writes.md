# 領域寫入模組

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/frontend/src/lib/data/domainWriters.ts, packages/frontend/src/lib/data/taskWriter.ts, packages/frontend/src/lib/data/propertyWriter.ts, packages/frontend/src/lib/data/tagWriter.ts, packages/frontend/src/lib/data/relationWriter.ts, packages/frontend/src/lib/data/canvasWriter.ts, packages/frontend/src/lib/data/writeLifecycle.ts, packages/frontend/src/lib/data/optimisticFields.ts, packages/frontend/src/lib/taskMirror.ts

延續 `note-writes.md` 的局部重構。這一批把任務、屬性、標籤、關聯、白板的主要寫入流程
收進領域模組。所有 writer 都綁在 `domainWriters` 的同一個 context 上（`useAppData`
以 `bindDomainLifecycle` 交出資料夾同步與 refresh），呼叫端直接使用
`canvasWriter`、`taskWriter`、`relationWriter`、`propertyWriter`、`tagWriter`；
舊的 `graphMutations`、`canvasActions`、`offline.ts` 相容入口已移除（W6）。
畫面不用再組合 API、SQLite、離線佇列與 HTTP 錯誤判斷。

## 公開介面與隱藏的責任

| 模組 | 畫面表達的意圖 | 模組負責 |
| --- | --- | --- |
| `taskWriter` | `create / patch` | 穩定任務 ID、狀態／截止日／重複規則、保存與拒絕回復 |
| `taskAgenda` | `reads.workspace.taskAgenda`（伺服器議程） | 伺服器議程；bucket 規則是 `@onden/markdown` 的 `taskBucket`（後端 SQL 版由 `taskBucketRule.integration.test.ts` 對齊） |
| `propertyWriter` | `set / remove` | 值、型別、繼承與來源、本機 metadata 還原、欄位 URL 編碼 |
| `tagWriter` | `create / apply / remove` | 標籤節點與清單、分類／標籤成員關係及冪等的回復 |
| `relationWriter` | `connect / remove` | 連結 ID、伺服器既有連結去重、刪除確認與回復 |
| `canvasWriter` | `select / create / rename / save / remove` | 白板資料、本機布局、選擇競態、保存排序與回復 |

例：任務畫面只呼叫 `writer.patch(id, { due_date, recur })`；表格與看板只呼叫
`propertyWriter.set(nodeId, field, value, options)`。各領域共用**寫入生命週期**，但
任務排程、標籤分類、白板選擇不塞進一個「萬用服務」。

## 共用生命週期

`writeLifecycle` 是領域模組的內部工具。它負責依資源排序、等待提交確認、區分永久拒絕與
未確認保存，以及合併之後更新本機副本。UI 不直接配置這些 callback。

成功只有兩種：收到伺服器回應，或離線佇列已持久化。儲存空間不足會保留恢復用的意圖，
拋出 `WriteStorageError`；不能因為記憶體已變更就顯示「儲存成功」。

同一節點的筆記、屬性與標籤寫入共享順序。本機副本盡量從當下狀態更新，
避免把排隊時捕捉的整列蓋回去。刪除本機連帶資料要等提交接受之後才做。

`optimisticFields` 追蹤每個欄位的待確認編輯。例如 `原值 → A → B`，若 A、B 都被拒絕，
必須回到原值，不能讓 B 回復成已被拒絕的 A。它也讓舊回應不覆蓋後續待確認的同欄位修改。
這是單一執行環境內的排序與回復，並非跨裝置衝突解決。

## 錯誤與畫面契約

- 網路／可重試 HTTP 失敗、401：沿用共用佇列及既有重播政策。
- 永久 HTTP 拒絕：領域回復受影響的資料，回報可讀原因並維持 Promise rejection。
- 佇列持久化失敗：保留樂觀意圖與恢復副本，不假裝儲存成功。
- 提交已成功但本機副本更新失敗：提示副本問題，保留已成功的提交結果。
- 領域與外層 UI 共用錯誤去重；同一個 Error 不重複發出全域提示。

需要成功後續動作的表單必須 `await`，失敗時保留輸入。屬性新增、一般欄位、自訂欄位、
筆記頂部欄位都已接入；文字欄位的 Enter 與 blur 不會重複提交同一個待處理保存。
`backgroundWrite` 只接沒有成功後續動作的事件，吸收已回報的 rejection。

墨跡和全域關係圖位置也使用共用提交與錯誤政策；墨跡保留使用者的筆畫供重試／匯出，
不在伺服器拒絕時突然抹除。這是領域差異，而不是吞掉錯誤。

## 本機任務資料修正

舊 SQLite 任務表只有 ID、宿主、標題與狀態，因此截止日和重複規則無法可靠離線重開。
`taskMirror` 提供可重複執行的欄位升級，以及 bootstrap、sync delta、即時任務保存共用的 upsert。
離線清單保留日期、時間字串與規則；重複任務的下一次實例仍由伺服器在重播完成時建立。
任務頁也會在待同步佇列清空後重新讀取，避免伺服器已建立而清單仍少一筆。

## 驗證與範圍

新增 `domainWriters.test.ts`、`taskMirror.test.ts`、`fieldSave.test.tsx`，並延伸原有回歸測試。
包括持久化等待、儲存失敗、兩次拒絕、其他欄位保留、屬性 metadata、重複標籤操作、
連結去重、白板選擇競態、離線布局、輸入保留、實際 sql.js 舊資料升級及匯出再開啟。

第一批前端回歸：163 個測試檔、1,151 項測試通過；`tsc --noEmit`、ESLint 與 Astro production build 通過。
建置仍有既有的大型 chunk 與空 docs collection 提示。

瀏覽器使用隔離帳號與資料庫，桌面 1280 × 900、手機 viewport 390 × 844：

- 新增「領域重構驗證」，設定每天重複；斷線後順延至 2026-09-10，冷啟動確認仍保留。
- 離線新增「手機離線新增驗證」；恢復連線重播後直接查 PostgreSQL，確認兩筆任務與欄位。
- 再以「同步後清單驗證」重測重連：停留任務頁，佇列清空後清單顯示全部 5 筆，不須再切換頁面。
- 新增筆記屬性、建立測試標籤、套用及移除稍後讀標籤。
- 白板加入測試筆記，離線整理至 `(80, 80)`；手機離線冷啟動確認卡片內容與座標保留，頁面無水平溢出。重連後亦查 PostgreSQL 確認同一筆布局已保存。

手機是 viewport 驗證，不代表 Android/iOS 真機程序回收或儲存壓力測試。
瀏覽器開發熱更新期間曾出現 Worker 尚未初始化／動態模組錯誤；完成編輯後以新頁面狀態重新測試。
未把這類開發伺服器生命週期問題列為本次已修復項目。

這一批沒有把所有 API 寫入一口氣遷移。RSS 文章儲存／重點擷取、網站 presentation、
標籤 schema／合併、版本還原、工作區設定、匯入與權限等仍有個別流程；部分已經使用共用佇列，
但尚未全部具備本文的領域回復契約。2026-09-13 起，永久拒絕的重播項目保留在原 SQLite
queue 的 rejected 狀態，不再直接丟棄；不自動重送，透過既有 recovery 面板讀取／複製／明確移除。
這不是將原節點恢復成可讀，也不取代各領域的樂觀狀態調和。
見 [離線拒絕輸入保留](../archive/rejected-writes-fixes-2026-09-13.md)。

網站、工作區設定、版本還原與取消刪除的後續遷移，見 [website-writes.md](website-writes.md)。
