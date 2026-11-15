# 任務讀寫與宿主 scope（TASK-07／DEC-01）

> 狀態：已被取代（by docs/architecture/spaces.md、docs/architecture/tasks-module.md）（最後確認 2026-11-01）

> 2026-10-24：讀寫範圍已改成空間規則（[spaces.md](../../architecture/spaces.md)）。任務在宿主筆記的空間；**沒有宿主的獨立任務**在自己的空間（建立者的個人空間，或建立時指定）。
> 下文的標籤 scope 描述是空間規則之前的版本，保留作為歷史；現況與獨立任務見 [任務模組](../../architecture/tasks-module.md)。

任務沿用節點模型與既有 API wire shape。**task 節點及其祖先承擔角色／政策，當前宿主筆記的直接標籤承擔 human／token tag scope**。兩者都允許才可操作；task 自身額外標籤不能取代宿主 scope。

## 呼叫契約

```ts
await canReadNode(actor, taskId);
const where = readableScopeSql(actor, workspaceId, "t", params);
await assertAuthority(actor, { kind: "node", nodeId: taskId, op: "set_attribute" });
```

一般節點仍以自身直接標籤判斷 scope。任務為帶有有效 `#task` class tag 及 `_task_status` 屬性的節點，scope 對象由伺服器根據當前 `parent_id` 解析，呼叫者不能指定另一個 scope 對象。human 與 token scope 各自必須和宿主直接標籤至少交集一項；`null`／未設定表示該項不限，空陣列表示不允許。兩個 scope 的符合標籤可以不同，不要求兩個 allowlist 自身相交。

- task 上的 read／write／attribute 政策照常生效，祖先限制照常向下套用。
- 宿主必須存在且屬於同一工作區；live 讀寫另要求宿主未刪除。歷史／復原的 retained 讀取可使用軟刪除宿主，仍核對當前 scope；purge 不可繞過。
- 移動任務立即改用新宿主 scope；移除宿主 scope 標籤後，agenda、bootstrap、sync delta、by-id、membership 與 PATCH 使用相同結果。既有 membership epoch／重連核對機制負責清掉本機舊投影。
- PATCH 包含與現值相同的欄位，也須在事件交易鎖內核對 task 可讀及每項請求能力。標題要求 `write_node`；屬性設值要求 `set_attribute`，清除要求 `delete_attribute`。拒絕不改資料、不留下成功事件；回傳的任務也在該交易內讀取。

這不授予 bearer token 一般 REST 存取。既有公開邊界仍將它限制在 `/api/mcp/*`；token 測試另驗共用政策與內部路由的防禦邊界，session 測試走完整 app。

## 責任與相容範圍

`spine/taskIdentity.ts` 提供 task scope 對象的 SQL，`services/readPolicy.ts` 的逐筆／集合／SQL 讀取及 `spine/authority.ts` 的寫入共用它；`dispatcher/permissions.ts` 保留 task 本身的角色政策與生命週期判斷。agenda 改用 `readableScopeSql`，不再自行組合 task／host 兩個授權對象。

既有一般節點 scope 不變；以前「agenda 有任務，但 bootstrap／sync 因 task 沒有宿主 scope 標籤而漏掉」會恢復一致。以前「給 task 額外套 scope 標籤而讀到宿主 scope 外的任務」會拒絕；以前無變更 PATCH 略過授權的情況也拒絕。

## 驗證

跨入口 PostgreSQL 回歸：`src/test/taskScopeContract.integration.test.ts`。與既有 SQL／集合等價、retained、human scope 及 spine 回歸一併執行。實際執行結果、基線、部署狀態及尚待完成的瀏覽器證據集中在[本輪驗收紀錄](../browser-acceptance-2026-09-21.md)；測試存在不代表已完成整項產品驗收。
