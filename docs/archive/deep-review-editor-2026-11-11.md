# 深入審查：筆記編輯器與存檔（2026-11-11）

> 狀態：歷史紀錄（全部處理完；修正見 #1498，最後確認 2026-11-12）

## 結論

這一塊的日常路徑與「失敗之後」的主要路徑已有很強的既有安全網（`saveTiming`、`multiTab`、`reloadGate`、`bodyMerge`、`bodyPatch`、`blockLinkIndex` 等性質測試）。
這次讀程式加上新測試，**重現 2 個問題（都在前端草稿存檔，影響偏小）**，後端兩人合併、重送與段落錨點沒有找到問題。沒有湊數。

## 總表

| 編號 | 一句話說明 | 嚴重度 | 狀態 | 測試檔 |
| --- | --- | --- | --- | --- |
| E1 | 編輯器顯示 A、但 store 已選 B 的短暫空檔裡，打給 A 的字會被存成 B 的內文（B 原內文被覆蓋） | 中（後果重、條件窄） | 已修（PR #1487） | `packages/frontend/src/test/editorSaveDeepReview.test.ts`（`it.fails`） |
| E2 | 打了字又打回原樣時，這段期間別台裝置存進來的內文不會出現在編輯器，卻顯示「已儲存」 | 低 | 已修（PR #1487） | 同上（`it.fails`） |
| E3 | 差異推導的段落錨點在「同位置換成相似段落」時可能把識別碼移到新段落 | 低（既定的相似度設計） | 見「查過」：不算缺陷 | `packages/backend/src/test/properties/twoDeviceSave.property.integration.test.ts` |

新型測試（安全網，皆綠）：`twoDeviceSave.property.integration.test.ts`——兩台裝置從同一份文字各改一次，走真的 `PATCH /api/nodes/:id`
（`base_markdown`、`body_change`〔真／無／亂碼／過期〕、`Idempotency-Key` 回應遺失後原樣重送），隨機 1–4 步，檢查：
沒掉段落（在內文或 BODY_CONFLICT）、沒復活刪除、段落不重複、重送不寫事件、沒動過的標籤段落保有錨點、`block_nodes` 與從頭解析一致。

## 細節

### E1　存到另一則筆記
- 位置：`packages/frontend/src/lib/data/draftActions.ts` `scheduleAutosaveIfDirty`（用 `selectOverviewSelectedNode` 取節點）；`typeIntoDraft` 與 `editNoteText` 只檢查 `editorNodeId`。
- 觸發：store 的 `selectedId` 已換成 B，但 `useOverviewMode` 的 effect（呼叫 `resetDraftForNode`）還沒跑；這一格裡標給 A 的輸入（例如上傳完成後 `editNoteText` 插入文字）進入 `typeIntoDraft("a")`，快照的節點卻是 B。
- 後果：A 的文字以 B 為對象送出，B 的內文被蓋掉（有版本歷史可救）。
- 重現：測試把 store 選到 B 後呼叫 `typeIntoDraft("a")` + `flushPendingSave()`，PATCH 打到 `/api/nodes/b`。**限制**：我沒有在真實 React 渲染裡量到這個空檔會被打進輸入；手動點側欄時 blur／組字結束發生在選取之前，所以實際機率低（信心：函式層級確定，實際觸發中低）。
- 修法：快照用 `getNode(editorNodeId)`，且與選取不同時丟棄／走 recovery。約 0.5 小時。

### E2　打回原樣後的畫面落後
- 位置：`draftActions.ts` `flushPendingSave` 內「typed back」提早 return；`applyRemoteNode` 在 `isDirty` 時略過，而 `useOverviewMode` 的 effect 只在列文字變化時重跑。
- 觸發：打字（dirty）→ 別台存了新內文並同步到 store → 使用者把字改回原樣 → 儲存。
- 後果：編輯器停在舊文字並顯示「已儲存」，store 是新內文；下一次打字的存檔會正確三方合併並推回，所以不丟資料，只是暫時看不到對方的修改。
- 修法：該提早 return 與存檔成功後，再對目前列呼叫一次 `applyRemoteNode`。約 0.5 小時。

## 查過沒問題的

- 後端 `nodeUpdate` 合併：舊 base 的三方合併、題外話的 noop 判斷、`body_change` 不可信時退回差異（`verifiedEditorChanges` 驗證後才用）——新性質測試三組種子以上通過（亂碼／過期 ChangeSet 不影響內文）。
- 回應遺失後以同一 `Idempotency-Key` 重送：回 `deduped`，不寫事件、內文不變。
- 草稿存檔的切換筆記、頁面離開（keepalive）、拒絕後不重送：既有 `saveTiming` 性質測試已涵蓋，且新增的手寫案例沒有找到別的路徑。
- E3（相似度）：兩段文字約一半以上字元相同、又在同一位置時，錨點跟著「像的那段」（`similarity.ts` 的 `KEEP_MOVED = 0.5`）。我在性質測試的早期版本用過於相似的段落文字撞到它，換成差異大的文字後不再出現；以固定的一般文字嘗試（`a…`／`c…` 標記）沒有重現，因此不列為缺陷，只是啟發式的邊界。
- 編輯器外部同步（`MarkdownEditor` 的 `ExternalSync`）只替換差異區段、不入復原堆疊；其產生的 ChangeSet 進入 `editorChangeLog`，長度不符時 `takeEditorChanges` 回 null，即使長度巧合相符，伺服器也會驗證結果才信任，不影響內文。

## 這次沒查到的範圍

- 輸入法組字期間觸發自動存檔／遠端更新：jsdom 無法模擬真輸入法，**未驗證**（`composingField` 只管裝飾，不管外部文字替換；建議用真瀏覽器補測）。
- 任務行在編輯器與任務頁勾選交錯、貼上大圖／大內容逾時、數萬字筆記的 patch 失敗退路（`patchedBody`／`patch_base_unknown`）：只讀程式，沒有新測試。
- 備份還原、垃圾桶、權限撤銷與本批的交會：未做。
- 需要真 Postgres 才能驗的項目：本批新測試皆在 PGlite 通過，沒有使用 `needsSecondConnection` 類標記；真 Postgres 上的行為尚未補跑。
