# 深入審查：白板（2026-11-11）

> 狀態：歷史紀錄（全部處理完；修正見 #1498，最後確認 2026-11-12）

範圍：白板（canvas／board）的前後端寫入、與垃圾桶／永久刪除／搬到別的空間／備份還原／離線重送的交會、`.canvas` 匯入匯出、權限。
方式：只看程式、不改產品程式；每個候選都試著用測試重現。重現到的用 `it.fails` 釘住（測試名稱寫的是「正確的行為」，所以修好之後測試會變紅，到時把 `it.fails` 改回 `it`）。

## 摘要表

| 編號 | 一句話說明 | 嚴重度 | 狀態 | 測試檔 |
| --- | --- | --- | --- | --- |
| F1 | 備份還原後，白板上畫的「分組框」全部消失 | 中 | 已修（PR #1489） | `backend/src/test/boardBackupSections.integration.test.ts` |
| F2 | 兩台裝置改同一張卡：舊副本只搬動位置，會把另一台剛改的顏色、大小蓋掉 | 中 | 已修（PR #1493） | `backend/src/test/boardReview.integration.test.ts` |
| F3 | 永久刪除一個白板後，它上面所有卡的位置紀錄留在資料庫裡（沒人讀得到，但清不掉） | 低 | 已修（PR #1489） | 同上 |
| F4 | 永久刪除子白板後，別的白板上指向它的卡仍帶著該子白板的連結 | 低 | 已修（PR #1489） | 同上 |
| F5 | 匯入 `.canvas`：分組標題超過 500 字或顏色字串過長，驗證放行，但存白板時被伺服器拒絕；此時筆記已建好，只剩空白板 | 低 | 已修（PR #1487） | `frontend/src/test/properties/boardImportExport.property.test.ts` |
| F6 | 匯入 `.canvas`：只要有一條連線的終點是分組（Obsidian 允許），整份檔案被拒絕 | 低 | 已修（PR #1487） | 同上 |
| F7 | 一次要搬動／寫入超過 5000 張卡的變更整批被 400 拒絕，客戶端不分批 | 低 | 已修（PR #1493）| `backend/src/test/boardReview.integration.test.ts` |

沒有找到高嚴重度的問題（沒有丟資料的日常路徑、沒有權限外洩、沒有越權寫入）。

新型測試（兩個，沒問題的部分也留下當安全網）：

- `backend/src/test/properties/boardCrossFeature.property.integration.test.ts`：兩個白板、四則筆記，隨機排列「放卡／拿掉卡／筆記進垃圾桶／復原／永久刪除／白板進垃圾桶／復原／筆記搬進編輯者不在的空間／搬回來」，每一步用編輯者與管理員兩種身分核對 `GET /api/boards/:id`、「出現在哪些白板」與位置資料表是否和模型一致。預設種子、種子 1 與 2（各 120 次）通過；種子 3 第一次失敗，原因是我自己的模型（編輯者無法復原一則已被搬進他們不在的空間的筆記，伺服器回 403 是對的），修正模型後種子 3、4、5（各 100 次）通過。故意把模型改錯（讓垃圾桶中的筆記仍算可見）會變紅，確認它有在檢查。
- `frontend/src/test/properties/boardImportExport.property.test.ts`：隨機卡片與分組的 `.canvas` 匯出→匯入往返（位置、大小、顏色、標題、內文、連線）、`diffBoard` 套用到舊版得到新版、無變更時 diff 為空。通過。

## 每一項的細節

### F1　備份還原後分組框消失（中）

- 觸發：在白板畫一個分組框 → 下載完整備份 → 還原。測試走的是「工作區」模式；一般模式用同一段還原程式，但我沒有另外測。
- 後果：卡片的位置、大小、顏色都回來，但分組框（含標題與顏色）一個都沒有。使用者自己畫的內容無聲消失（我沒有查還原報告有沒有提到）。
- 位置：`packages/backend/src/services/backupSystemAttrs.ts` 把 `_canvas_sections` 歸為 `never`（註解說是「別的模組會再寫出來」），但分組框是使用者畫的，沒有任何模組會重寫。還原的「Board positions」段（`backupRestore.ts` 約 885–915 行）只還原卡片。
- 建議修法：還原時把備份裡的 `_canvas_sections` 經 `applyBoardChanges` 的 `upsertSections` 寫回（沿用權限、事件與交易），而不是當屬性寫；或把它列為 `note` 類。約半天，需補「分組 id 保留」與「備份副本模式」的測試。
- 測試：`boardBackupSections.integration.test.ts`（卡片往返的對照組通過、分組框的 `it.fails`）。

### F2　兩台裝置同時改同一張卡，後到的整張蓋掉（中）

- 觸發：裝置 B 把卡片改成較大、紅色；裝置 A 手上還是舊副本，只是拖動這張卡。A 送出的是整張卡的位置資料（`diffBoard` 的 `cardKey` 一變就送整張），伺服器 `setNodePosition` 用 `ON CONFLICT DO UPDATE` 把所有欄位換成送來的值。
- 後果：B 剛設的大小與顏色悄悄變回預設；兩邊都不會出錯或提示。反過來（A 改色、B 搬動）也一樣。撤銷（undo）同理：送的是舊版的整張卡。
- 位置：`packages/frontend/src/lib/boardLayout.ts` `diffBoard`／`cardKey`；`packages/backend/src/services/boardStore.ts` `setNodePosition`、`boardWrites.ts` `applyBoardChanges`。後端測試檔頭已寫明「per card, last write wins」，所以這是設計的粒度，不是疏忽；但使用情境（同時搬同一張卡、同時改大小或顏色）會讓使用者看到卡片「跳回去」。
- 建議修法：線上格式改成「只送改變的欄位」（缺的欄位伺服器不動；要清除用明確的 `null`），客戶端 `diffBoard` 逐欄位比較。約 1–2 天（前後端與離線佇列裡舊格式的請求都要相容，現有 `canvasWriter` 性質測試的模型要跟著改）。
- 測試：`boardReview.integration.test.ts`「a stale device that only moves a card keeps the colour and size…」。

### F3　永久刪除白板後，卡片的位置紀錄留下（低）

- 觸發：白板進垃圾桶 → 永久刪除。
- 後果：`node_positions` 的 `surface` 欄位是文字、沒有外鍵，筆記被永久刪除時只會依 `node_id` 連動刪除，所以以該白板為 surface 的列全部留下。讀取時被 `JOIN` 過濾，使用者看不到，也不會外洩；只是資料庫累積無法清除的列，`clearSurface` 這個函式存在，但沒有任何呼叫者。
- 位置：`packages/backend/src/services/nodeTrash.ts` `purgeRows`（`DELETE FROM content_nodes` 之前）。
- 建議修法：在 `purgeRows` 的同一個交易裡 `DELETE FROM node_positions WHERE workspace_id = $1 AND surface = ANY($2)`（用既有的 `clearSurface` 的批次版）。約 1 小時。
- 測試：`boardReview.integration.test.ts`「purging a board for good takes the placements of its cards with it」；對照組「purging a note takes its placements on every board with it」通過。

### F4　永久刪除子白板後，卡片仍指向它（低）

- 觸發：白板 A 上的卡片 `subCanvasId` 指向白板 B；B 進垃圾桶並永久刪除。
- 後果：A 的卡片仍帶 B 的 id（`sub_canvas_id` 也沒有外鍵）。資料層面已重現；使用者點「開啟子白板」時畫面如何呈現，我沒有在瀏覽器驗證（讀程式推測會找不到該白板）。
- 建議修法：`purgeRows` 同時 `UPDATE node_positions SET sub_canvas_id = NULL WHERE sub_canvas_id = ANY($ids)`。約 1 小時（與 F3 一起做）。
- 測試：`boardReview.integration.test.ts`「purging a board clears the sub-board link…」。

### F5　匯入 `.canvas`：驗證比伺服器寬鬆，失敗時只剩空白板（低）

- 觸發：檔案裡有分組的 `label` 超過 500 字，或某張卡的 `color` 是 `#` 開頭但超過 64 字元。
- 後果：`fromJsonCanvas` 放行（只檢查了卡片標題長度）；`importJsonCanvas` 先建好板和所有筆記，最後 `saveCanvasData` 被 `PATCH /api/boards/:id` 的 schema（`NODE_TITLE_MAX`、顏色 max 64）以 400 拒絕。使用者會看到「匯入中斷，部分內容可能已建立」，推得的結果是筆記都在、白板是空的，需要手動整理（這段是讀程式推得，驗證只做到 `fromJsonCanvas` 放行、伺服器 schema 會拒絕，沒有跑完整匯入）。屬自己選的壞檔案造成，沒有資料外洩；惡意檔案最多造成大量筆記（也沒有數量上限，見 F7）。
- 位置：`packages/frontend/src/lib/jsonCanvas.ts` `fromJsonCanvas`、`hooks/useCanvasActions.ts` `importJsonCanvas`。
- 建議修法：`fromJsonCanvas` 對分組標題用和卡片相同的長度檢查；顏色只接受 `#rrggbb`／`#rgb`，其他丟棄。約 1 小時。
- 測試：`boardImportExport.property.test.ts`（兩個 `it.fails`）。

### F6　`.canvas` 有連到分組的連線就整份拒絕（低）

- 觸發：用 Obsidian 做一份把箭頭畫到分組框的白板，匯入。
- 後果：出現「第 N 條連線有問題」，整份檔案無法匯入；使用者得手動改檔。程式註解把它寫成「不支援」，但它是合法的 JSON Canvas。
- 位置：`jsonCanvas.ts` 的 `connections to groups are not supported`。
- 建議修法：略過這類連線（其餘照常匯入），並在匯入完成時說「有 N 條連到分組的連線沒有匯入」。約 1–2 小時。
- 測試：`boardImportExport.property.test.ts`。

### F7　超過 5000 張卡的變更整批被拒（低）

- 觸發：白板有 5001 張以上的卡，全選後搬動（或匯入超過 5000 個節點的檔案，匯入也沒有節點數上限）。
- 後果：`PATCH /api/boards/:id` 的 `cards.upsert` 上限 5000，整個變更 400；客戶端不分批（讀程式確認），所以這次搬動送不出去；它在寫入佇列裡怎麼歸類沒有追。數百張的白板不受影響：我另外測了 500 張一次寫入，成功且在同一個請求內全部寫入（沒有量時間）。
- 位置：`routes/boards.ts` `patchSchema`；`frontend/src/lib/data/canvasWriter.ts` `change`。
- 建議修法：客戶端依 5000 分批（同一個冪等序列依序送），或匯入時先限制節點數。約半天；實務上很少碰到，列為低。
- 測試：`boardReview.integration.test.ts`「moving every card of a board with more than 5000 cards is accepted」。

## 查過沒問題的

- 筆記進垃圾桶→復原：卡片回到原位、顏色大小保留；「出現在哪些白板」跟著消失與回來（`boardReview`、`boardCrossFeature` 都驗）。
- 白板本身進垃圾桶→復原：卡片與分組框都在；垃圾桶中的白板讀取回 404。
- 筆記被搬到編輯者不在的空間：編輯者的白板與「出現在哪些白板」都看不到該卡（標題、位置、連線都沒有外洩），管理員仍看到、位置紀錄保留，搬回來就回來。
- 永久刪除一則筆記：它在每個白板上的位置紀錄依 `node_id` 連動刪除，沒有殘留。
- 權限：檢視者可讀白板、寫入回 403；沒有白板分頁的一般筆記不被 `/api/canvases` 當成白板（404）；看不到的卡不能被別人移動或移除（既有測試 GAP-256 仍有效）。
- 以同一個 Idempotency-Key 重送白板變更：不會把舊位置蓋回較新的位置（另一台裝置在中間改了）。
- 一次 500 張卡的寫入是單一請求、單一交易；含不合法位置的變更在寫入前就被拒絕，不會只搬一半。
- 匯出→匯入往返：位置、大小、顏色、標題、內文、分組、連線無遺失（性質測試）；只匯出兩端都在白板上的連線。
- `diffBoard`：把差異套用在舊版得到新版；沒有變化時為空。
- 離線重送順序、兩個分頁同時操作的前端記憶體狀態：已有 `canvasWriter.property.test.ts`（前端）與 `canvasBoard.property.integration.test.ts`（後端）涵蓋，這次沒有重寫；兩者沒有涵蓋的是 F2 的「同一張卡不同欄位」。
- 卡片 `subCanvasId` 可以指向使用者讀不到的白板：伺服器會把這個 id 原樣回給其他讀者，但只有 id，沒有標題或內容，而且只有能寫這張白板的人才設得出來。不視為外洩。

## 這次沒查到的範圍

- 畫面層：`Board*.tsx`、觸控手勢、手寫層（ink）、小地圖、對齊工具；沒有跑瀏覽器，沒有驗證手機尺寸。
- 自動排版／樹狀排版後的復原（`useCanvasUndo`、`boardTree` 的排版）：只確認撤銷走 `diffBoard`（因此受 F2 影響），沒有另外寫測試；`boardTree.property.test.ts` 已有的不變條件我沒有重跑以外的驗證。
- 剪貼簿貼上（`useBoardClipboard`）：讀了流程（每張卡經「複製筆記」入口建新筆記、新 id，沒有指向原卡的殘影），沒有寫測試；貼上跨空間時新筆記落在哪個空間沒有追。
- 白板內容的歷史復原：白板的 `CANVAS_UPDATED`／`BOARD_UPDATED` 事件只記數量不記內容，所以版本歷史無法復原某次排版；復原只在客戶端記憶體裡（`useBoardHistory`）。這是設計，沒有當成問題，但使用者若期待「從歷史復原白板」會落空。
- 公開網站上的白板、MCP／agent 對白板的工具、`routes/nodes.ts` 的 `PUT /:id/position`（全域圖）：沒有深入查。
- 需在真 Postgres 補跑：本次新增的測試都只用單一連線，PGlite 上的結果就是答案；沒有需要第二條連線的測試。
