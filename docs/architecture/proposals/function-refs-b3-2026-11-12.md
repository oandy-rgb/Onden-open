# 功能引用第三批：任務、複習、稍後讀、引用文獻、模組標籤節點之後的現況

> 狀態：現行
> 涵蓋：packages/backend/src/services/functionRefs.ts, packages/backend/src/spine/taskIdentity.ts, packages/backend/src/modules/review/cards.ts, packages/backend/src/modules/tasks/index.ts
> 提案原文與當時的討論（正式站盤點、業主確認、實作紀錄）：[function-refs-b3-2026-11-12-history.md](function-refs-b3-2026-11-12-history.md)。
> 還沒做完的部分：[function-refs-b3-remaining-2026-11-17.md](function-refs-b3-remaining-2026-11-17.md)（提案）。
> 上層文件：[功能引用表](function-references-2026-11-02.md)；分散式側：[資料帶來源標記](causal-stamps-2026-11-12.md)。

業主 2026-11-12：標籤不再掛功能，使用者的標籤只帶欄位與檢視。這份文件寫第三批做完之後的樣子；怎麼走到這裡看歷史檔。

## 誰能引用功能

- `function_refs`（`services/functionRefs.ts`）的引用者有三種，一列只有一個：筆記或標籤（`holder_node_id`）、空間（`holder_space_id`，還沒開放寫入）、段落（`holder_block_id`，migration 195）。
- 標籤只因為**檢視**出現在引用表（有 `instance` 的列，migration 188）；沒有任何使用者標籤持有功能。標籤頁沒有「＋加功能」；標籤層的 `addFunction`／`removeFunction` 只還有 `services/legacyTagFunctionWrites.ts` 這個舊入口在呼叫。
- 功能型的引用者只有筆記與段落：`tasks`（任務節點）、`review`（卡片筆記、卡片段落）；技能（`skills`）還是標籤成員，見未完成文件。
- 「這個東西有什麼功能」只問 `functionRefs.ts`（`functionsOf`、`functionIndex`）。

## 任務（migration 191）

- 任務節點＝有一筆 `function_id = 'tasks'`、引用者是該節點的 `function_refs`，並有 `_task_status` 的隱藏節點；不再掛任務標籤。判斷只經 `spine/taskIdentity.ts`（`hasTaskRefSql`、`isTaskSql`）；建立在 `services/tasksStore.ts`，引用由建立節點的事件記下，不另記事件。
- 筆記裡的 `- [ ] … {task}` 保留：`{task}` 是任務模組自己認得的保留字（`modules/tasks/seam.ts`），不解析成標籤。
- 標籤不能再讓整則筆記成為任務：`tasks_checkable`／`tasks_dates` 兩個功能與後端、前端的 noteTasks 檔案都已移除；任務只有兩種：任務節點與筆記裡的一行。
- 任務模組的設定在 設定 › 功能 › 任務，不是標籤頁。

## 複習（migration 195）

- 一則筆記或一個段落自己記一筆 `review` 引用就是一張複習卡（`modules/review/cards.ts` 的 `setNoteCard`；段落隨存檔，內文 `{複習}` 一類的字加引用，拿掉字不拿掉卡）。整則筆記要當卡：`PUT /api/review/cards/:nodeId`，事件 `FUNCTION_REF_ADDED`／`REMOVED`，可從歷史復原。
- 標籤頁沒有複習；以標籤為範圍練習見 [標籤當範圍](tag-as-scope-2026-11-13.md)。排程（`review_states`）與個人設定不動。

## 已移除的模組

- 稍後讀（migration 192）：後端與前端模組、`/api/read-later` 已移除；資料表 `read_later_done` 改名為 `read_later_done_removed_192` 保留一版。
- 引用文獻（migration 193）：`modules/citations`、`/api/citations`、論文欄位範本與 `ensurePaperTag` 已移除；既有論文標籤變成普通標籤，筆記裡的 `[@key]` 顯示成普通文字。
- 模組標籤節點（migration 196）：沒被改過的 live 模組標籤進垃圾桶（`NODE_DELETED`，可復原）；被改過的留下並列入遷移說明。舊備份還原時，複習標籤不還原成標籤，延伸它的標籤的筆記還原成卡片。

## 還在的過渡

`skills`、`capture` 的模組標籤沒有被移除（還在用它找成員），`tasks`、`review` 的模組標籤若被改過會保留記號：見未完成文件。
