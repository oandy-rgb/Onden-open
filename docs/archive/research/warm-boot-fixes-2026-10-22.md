# 冷／熱啟動：先畫再寫、清單先讀（2026-10-22）

> 狀態：歷史紀錄（最後確認 2026-11-01）

對應 [perf-logged-in-2026-10-21](perf-logged-in-2026-10-21.md) 的 F2 第 2 項與 F4。
以下只描述程式行為與契約；沒有在 20k 的手機環境量測，數字由 reviewer 在本機 20k stack 量。

## 契約

- **冷啟動先畫。** `syncEngine.paintThenPersist`：下載完成後讀一次待送佇列，在 main thread 用
  `pendingNoteProjection` 的同兩個函式（`projectPendingNoteText`、`missingPendingNoteCreations`）
  投影後 `setData`，worker 的 `persistBootstrap` 在背景繼續。boot 仍 `await` 它才進入 sync
  （sync 需要它寫下的 `last_event_id`）。worker 回傳的投影只在佇列於兩次讀取之間改變時才修補
  （`bootPaint.reconcilePersistedBootstrap`），而且只修補仍等於「畫出來的文字」的筆記，
  使用者畫面後輸入的文字不會被蓋回。讀不到佇列就等 worker 的投影，不畫沒有待送文字的版本。
  寫入鏡像失敗時列表保留，錯誤沿用原本的路徑（改走完整抓取或離線）。
- **熱啟動兩段。** `loadBootstrapList` 只讀清單需要的欄位與佇列投影（無 edges／tasks／pointers／
  suggestions／graph positions／attrs）；大型工作區的 slim paint 連非佇列筆記的正文都不從 SQLite 讀出
  （`body_len` 為 NULL 的舊列用 `LENGTH(markdown)` 補）。其餘在 idle 以獨立 RPC 讀取
  （`loadBootstrapRelations`、`loadAttributePage` 每頁 10,000 列），每個 RPC 之間 worker 可以處理 sync 等請求。
  合併規則（`bootRest.ts`）：store 已有的優先，只補缺的；store 已沒有的筆記不復活；
  期間若有完整的伺服器 bootstrap 取代 store（`wholeBootstrapGeneration`），舊的快取內容不合併。
  離線熱啟動同樣讀取。
- **membership digest。** 熱啟動開始時就送 `GET /membership/digest`（不帶 `expected_epoch`），
  第一次 reconcile 在 epoch 吻合、且不超過 30 秒時重用；否則照舊重新請求。digest 只能讓 reconcile
  略過分頁，不會移除任何東西。

## 已知限制

- 第二段讀取完成前，反向連結、任務、圖譜與屬性欄位是空的（清單與標題、父層、標籤不受影響）。
  讀取失敗重試三次，仍失敗會 `console.warn`，關聯要到下次完整 bootstrap 才出現。
- 屬性合併只補缺的 key：使用者在第二段完成前刪除某個屬性，若那個 key 還在已讀出的頁面中，
  畫面會暫時又出現，直到下次同步。窗口只有開機後第一個 idle。
- 啟動時三個 `/api/events`（NOTIFICATION／ATTRIBUTE_CONFLICT／BODY_CONFLICT）是三個不同過濾條件，
  後端 `event_type` 只接受單一值，合併需要後端契約變更，未做。兩個 `/api/inbox*` 是不同端點
  （`/api/inbox` 與 `/api/inbox/approvals`），不是重複請求。
