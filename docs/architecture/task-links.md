# 任務的連結與嵌入（T6）

> 狀態：現行（最後確認 2026-11-20）
> 涵蓋：packages/markdown/src/nodeRef.ts, packages/frontend/src/lib/taskRefs.ts, packages/frontend/src/lib/taskRefs.app.ts, packages/frontend/src/lib/embedDom.ts, packages/backend/src/services/wikilinkEdges.ts, packages/backend/src/modules/website/publishing/redaction.ts

任務是隱藏節點（掛 `#task`），不在筆記樹，也不在前端的 `nodes`（在 `data.tasks`）。本文記錄筆記怎麼連到任務、
把任務嵌成能直接勾的列，以及權限與發布的處理。已實作、已測試的範圍以「驗證」一節為準。

## 寫法

| 寫法 | 意思 |
| --- | --- |
| `[[onden://node/<id>\|標題]]` | 用 id 指到任務的連結；同名任務不會連錯。`[[` 選單選任務時寫的就是這個 |
| `![[onden://node/<id>]]` | 任務嵌成一列：勾選框、標題、標籤片（何時做、截止、重複） |
| `![[任務標題]]` | 沒有同名筆記時，同上（先找筆記，再找任務） |

`onden://node/<id>` 是備份與匯出本來就用的節點參照；`@onden/markdown` 的 `nodeRef.ts`（`nodeRefTarget`／`nodeRefId`）
是唯一的拼法與解析。它是一般連結目標，所以連結文法、嵌入文法、`extractWikilinks` 都不需要新語法。
`#錨點`、`#^區塊` 不屬於任務（嵌入帶錨點時仍當筆記處理）。

## 前端

- `lib/taskRefs.ts`（純函式＋登記處）：`taskRefsFrom` 把任務列轉成連結目標；`resolveTaskRef` 依 id 或標題找任務；
  `lib/taskRefs.app.ts` 由工作區殼登記讀者目前持有的任務列（含「這位讀者能否在該空間寫入」）。發布站不登記，所以那裡什麼都解析不到。
- `resolveEmbed` 多一種 `task`：`task` 為 `null` 代表「用 id 指到，但讀者沒有這個任務」（沒權限或已不存在），
  只顯示「無法存取的內容」，不顯示標題；連結同理（`wikilink-token--unavailable`）。
- `lib/embedDom.ts` 的 `renderTask`：勾選框走既有 `taskWriter.patch(id, { status })`，任務頁與所在筆記那一行跟著同步（伺服器端 `taskLines`）。
  只有讀權限（`writable` 為 false）的人看得到狀態、勾不了。編輯器（`editorEmbeds`）與預覽（`MarkdownRenderer`）共用同一個渲染器。
- `[[` 選單：輸入文字後在筆記列之後最多列 4 個任務，勾選框圖示，小字 `何時做／隨時／已完成 · 在「筆記」裡`（`lib/taskChips.ts`）。
- 點連結：筆記裡的任務開所在筆記並用 `cursorHandoff` 選到那一行；沒有所在筆記的任務用 `openTaskSheet`（任務模組的 `TaskSheetHost`，殼層掛載）
  開任務頁同一張設定面；找不到該任務才提示「找不到這個任務」（任何空間的任務都開得了），不會誤建筆記。

## 後端

- `wikilinkEdges.linkMatchesNodeSql` 多一個條件：`onden://node/<id>` 等於該節點 id。`syncWikilinkEdges`、`relinkTarget`（目標端還原／改名後重算）共用，
  所以隱藏的任務節點也有邊與反向連結。讀取仍走各讀取入口的既有政策。
- `nodeSearch.searchNodes(…, { tasks: true })`（`GET /api/nodes/search?tasks=1`）才回傳任務，結果帶 `is_task`；預設仍不含任務，
  範圍限制照舊推進 SQL（`readableScopeSql`）。筆記樹（bootstrap `nodes`）仍排除任務（`notATaskNodeSql`）。
- 發布：用 id 指到的連結沒有標題／slug／別名可比對，所以在 `redaction.ts` 一律變成無害文字（作者的別名文字或網站語言的佔位字，中文網站「（未公開）」），
  id 不會進快照、站台或匯出。`publishRedaction.property` 加入 `taskRef`／`taskEmbed`／`taskTitle` 三種連結並禁止任務標題與 id 外洩。

## 限制

- 發布站不渲染任務嵌入（沒有勾選框，也不顯示完成狀態）；只保證不外洩。
- 獨立任務（沒有所在筆記）的讀取與開啟畫面屬任務改版 T1／T2；T1 合併前測試以「沒有 parent 的 hidden #task 節點」模擬。
- `![[筆記#^區塊]]` 對到任務行時仍是既有的區塊嵌入（唯讀顯示該行），尚未換成活勾選框。

## 驗證

`packages/backend/src/test/taskLinks.integration.test.ts`、`properties/publishRedaction.property.integration.test.ts`；
`packages/frontend/src/test/taskEmbed.test.tsx`；`packages/markdown/src/nodeRef.test.ts`。
