# lib/data

前端讀寫伺服器的唯一入口：讀、寫、草稿、同步狀態與寫入錯誤。從 `lib/data` 匯入，不從裡面的檔案匯入
（`packages/frontend/eslint.boundaries.config.js` 擋）。全域規則見[根目錄 AGENTS.md](../../../../../AGENTS.md)。

| 要做的事 | 用 | 守門 |
| --- | --- | --- |
| 改筆記、標籤、屬性、關聯、任務、白板 | `index.ts` 匯出的領域 writer（`noteWriter`、`tagWriter`、`taskWriter`、`canvasWriter`…） | `eslint.boundaries.config.js` |
| 讀筆記、搜尋 | `reads`（搜尋是 `reads.notes.search`） | `noteSearch.guard.test.ts` |
| 不依賴成功後續動作的寫入 | `backgroundWrite` | 無專屬守門，靠審查 |
| 離線排隊與重送 | `writeQueue`（不自己重試、不自創「離線算成功」） | 無專屬守門，靠審查（根目錄 AGENTS.md「錯誤與保存」） |
| 寫入失敗的分類與訊息 | `writeErrors`（`message`／`requestMessage`）與 `lib/serverErrors.ts` | 無專屬守門，靠審查 |
| 線上／離線狀態 | `connectivity.ts` | `dup-b2-interaction-a.guard.test.ts` |
| 瀏覽器 `navigator`（連線、儲存） | 只有本資料夾列在 owners 內的檔案 | `allowlist.guard.test.ts` |

保存確認只能來自「伺服器接受」或「離線佇列已持久化」，且 UI 要分開表示；規則全文在根目錄 AGENTS.md「錯誤與保存」。
