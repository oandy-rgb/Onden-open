# 架構總覽（先看這份）

> 狀態：現行（最後確認 2026-11-18）
> 涵蓋：packages/backend/src/spine/mutate.ts, packages/backend/src/spine/authority.ts, packages/backend/src/services/eventRestore/restore.ts, packages/backend/src/services/eventLog/bodyMerge.ts, packages/frontend/src/lib/data/syncEngine.ts, packages/frontend/src/lib/data/writeQueue.ts

結論：Onden 是「筆記樹＋事件紀錄」的離線優先 PWA。**所有寫入都過後端同一道閘門**，所有改動都留事件，
前端有本機副本、靠增量同步；內文衝突用逐行三方合併；功能以可關閉的模組掛上去。
每一段末尾的檔案路徑以 repo 根目錄為準，細節請進對應的專文。

## 套件

| 套件 | 做什麼 |
| --- | --- |
| `packages/backend` | Hono＋PostgreSQL。寫入閘門、權限、事件、同步、發布、MCP |
| `packages/frontend` | React／Vite PWA，本機資料庫在 worker（`lib/localDbWorker.ts`） |
| `packages/markdown` | 前後端共用的 Markdown 語法、日期／任務規則、共用常數（`sharedContract.ts`） |
| `packages/site` | 發布網站的呈現與設計資料型別 |

## 1. 寫入閘門（spine）

所有寫入都經 `mutate`：它在同一個交易裡完成「取工作區事件鎖 → 重讀當前操作者 → 查權限 → 寫狀態 → 寫事件」。
路由與 agent 工具不自己組這些步驟，而是呼叫領域操作（例如 `services/nodeUpdate.ts` 的 `updateNode`）。
`spine/` 不得 import `services/`（ESLint 擋）。讀取權限走 `services/readPolicy.ts`，不先全量取出再另外過濾。

- 位置：`packages/backend/src/spine/`（`mutate.ts`、`authority.ts`、`currentActor.ts`、`eventTransaction.ts`、`txHooks.ts`）
- 專文：[領域寫入](domain-writes.md)、[筆記寫入](note-writes.md)、[後端規則](../agents/backend-rules.md)

## 2. 事件紀錄與復原

狀態變更與成功事件同一交易提交或回滾。事件是「已提交的事實」，歷史畫面由它而來；
復原是**依目前權限執行的新操作**（`restoreEvent`），不改寫原歷史。被拒絕的嘗試不算事件。

- 位置：`packages/backend/src/services/eventRestore/restore.ts`、`services/eventLog/`、`services/history/`
- 專文：[復原寫入契約](restore-writes.md)、[歷史 API](history-api.md)

## 3. 同步與本機副本

前端把資料存在本機資料庫，寫入先進離線佇列（`writeQueue`；線上的保存也先記成一列再送，頁面當掉也不丟；被伺服器拒絕的文字不當下一次存檔的合併 base，見[筆記寫入](note-writes.md)），連上線後送出；伺服器回增量與「可讀集合」變化，
權限改變時以 `membership_epoch` 核對。保存確認只來自「伺服器接受」或「離線佇列已持久化」，兩者在介面上分開顯示。

- 位置：前端 `lib/data/syncEngine.ts`、`lib/data/writeQueue.ts`、`lib/localDbWorker.ts`、`lib/accountStorage.ts`；後端 `routes/sync.ts`、`services/sync/`
- 專文：[同步協定](sync-protocol.md)、[成員與權限世代](membership-and-permission-epoch.md)、[錯誤與保存契約](../agents/errors-and-saves.md)

## 4. 內文三方合併

兩台裝置改同一篇時，伺服器用「寫入端載入時的基準／寫入端現在送的／伺服器現有的」做逐行 diff3；
同一行兩邊改得不同才算衝突，不做模糊比對；兩邊都只加字時逐字合併，但只在配好的同一行裡（合併規則 3）。寫入只送差異（`textPatch`）。

- 位置：`packages/backend/src/services/eventLog/bodyMerge.ts`、`bodyPatch.ts`；`packages/markdown/src/textPatch.ts`
- 專文：[只送差異的寫入](patch-writes.md)

## 5. 模組

功能（白板、任務、看板、RSS、技能、簡報、網站…）是可開關的模組：入口只放登記資料，畫面用 `lazyWithReload` 用到才載。
標籤、功能與視圖的關係見模組庫。建置後 `packages/frontend/scripts/check-boot-bundle.mjs` 檢查登入後必載 JS 的大小預算。

- 位置：`packages/frontend/src/modules/`、`packages/backend/src/modules/`（各有 README）
- 專文：[模組庫](module-library.md)、[視圖也是模組](views-as-modules.md)、[模組分類的決定](../agents/decisions-modules.md)

## 6. 唯一入口目錄與守門測試

每件事只有一個主人檔案：要寫新的元件或共用邏輯前，先查目錄；守門測試會擋「不用主人入口」與重複碼。

- 目錄：[唯一入口清單](../agents/entrypoints-catalog.md)（由 `scripts/entrypoints.catalog.json` 產生，用 `npm run catalog`）
- 守門：各套件 `src/test/guards/*.guard.test.ts`；允許清單 `scripts/allowlist-baseline.json`（嚴格模式，必須為空）；`npm run ratchet:check`、`dup:check`、`dup:names`、`dup:near`
- 文件守門：`node scripts/check-md-links.mjs`（連結不得壞；`docs/architecture/`、`docs/research/` 的文件須有狀態行）
- 規則總覽：根目錄 [AGENTS.md](../../AGENTS.md)

## 其他

- 空間與權限：[空間](spaces.md)；AI 協作：[AI 協作的決定](../agents/decisions-ai-collaboration.md)、[harness](harness.md)
- 發布網站：[網站呈現模型](site-render-model.md)
- 產品決定：[docs/decisions/](../decisions/README.md)
