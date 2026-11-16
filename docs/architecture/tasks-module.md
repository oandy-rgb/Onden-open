# 任務模組（tasks）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/modules/tasks/**, packages/backend/src/spine/taskIdentity.ts

狀態：**已實作後端與資料層**（2026-10-24，T1）。任務頁的新介面、自然語言快速新增、日記頁、連結／嵌入、匯出由其他批次接手；它們都照本文的資料合約。
前置：[模組庫](module-library.md)（內建模組預設全開）、[段落節點 B4](block-nodes.md)（勾選行即任務）、[空間](spaces.md)。

## 一句話

「任務」是模組庫裡的內建模組（它的模組標籤節點 `#task`，`tag_schema.module = tasks`，之後移除；任務節點已不靠它）。任務還是節點：筆記裡的勾選行照舊與任務雙向同步；新增**獨立任務**，沒有所屬筆記，在自己的空間，可以有內文，也能「放進筆記」變成一行，再「拿出來」。

> **2026-10-30 起**：新增的任務都寫成筆記裡的一行（快速新增寫進今天的日記），獨立任務只剩匯入、備份還原與舊離線佇列會產生，
> 既有的獨立任務已由 migration 147 搬進日記。任務多了開始／結束時間（`_task_time`、`_task_until`，寫在那一行的行首）、
> 完成時間（`_task_done_at`）與專注紀錄（`/api/tasks/focus`）。見[日子時間線](day-timeline.md)。

## 模組與標籤

- 模組 id `tasks`，後端在 `packages/backend/src/modules/tasks/`（路由、更新、列表、排程器、重複規則、放進／拿出筆記、勾選行同步）。
- `#task` 不再是保留標籤（`reserved_key = task` 移除，migration 135；page、workspace-config 不動）。任務節點原本是掛著模組標籤的隱藏節點；**2026-11-12（migration 191）起改記一筆功能引用，見下「任務節點記一筆引用」**。
- 標籤節點只在擁有者於設定打開模組時建立（2026-11-12 起，新增任務與寫 `{task}` 不再建立它）。名稱是 `task`；根層已有同名的一般標籤時，新標籤叫 `任務`。段落不繼承任何標籤（2026-11-09，`block-nodes.md` §5），所以任務段落底下的段落不是任務。
- 標籤仍受保護：不能刪除、不能合併進別的標籤或讓別的標籤併入（409 `reserved_tag`，`services/reservedTags.ts assertTagDefinitionChange`）。要看任務標籤用名稱找沒有用，用 `schema_module`。
- 核心留下的部分（模組關掉也要能運作）：任務節點的基礎（`services/tasksStore.ts`、`taskIdentity.ts`：讀取政策、空間範圍、同步、垃圾桶、備份都要認得任務節點）、日記頁的當天任務（`services/dayLens.ts`）、`services/taskLineHook.ts`。核心不 import 模組；核心要呼叫任務行為的三個地方（筆記存檔、備份還原、`POST /api/nodes/:id/tasks`）經 `services/taskSeam.ts` 或由模組自己掛載。

## 兩種任務

| | 勾選行任務 | 獨立任務（新） |
|---|---|---|
| 寫法 | `- [ ] 標題 {task}` | `POST /api/tasks` |
| `parent_id` | 所屬筆記 | `null` |
| 空間 | 筆記的空間（資料庫保證子節點與父節點同空間） | 建立者的個人空間，或 `space_id` 指定（要有寫入權） |
| 出現在筆記樹 | 否（隱藏節點） | 否 |
| 內文 | 無（標題就是那一行） | 可以有；用一般節點路由讀寫（`GET/PATCH /api/nodes/:id`），`has_body` 表示有沒有 |
| 讀取權限 | 任務節點自己的空間規則，等同宿主的空間；宿主要存活 | 任務節點自己的空間規則；沒有宿主要等 |

讀取一律是「節點自己的空間」：`readableNodeIdSet`、`canReadNode`、`readableScopeSql`、同步、bootstrap、membership 核對都用同一條規則；差別只在 `taskHostLiveSql`：有宿主的任務，宿主在垃圾桶就一起隱藏；沒有宿主的不受影響。同步列的 `node_id` 可以是 `null`，過濾改用 `taskRowReadable`（任務自己的 id，以及有宿主時宿主的 id）。

## 資料合約

屬性（`node_attributes`，key 由 `taskIdentity.K` 定義）：

| key | 值 | 意義 |
|---|---|---|
| `_task_status` | `todo｜doing｜waiting｜done｜cancelled` | 永遠有。`later` 已不存在（見下） |
| `_task_when` | `YYYY-MM-DD` | 何時做（取代 `_task_due`） |
| `_task_evening` | `true`（關＝沒有這一列） | 當天晚上；有 `when` 才有意義 |
| `_task_someday` | `true`（關＝沒有這一列） | 隨時：不排日子，擱著 |
| `_task_deadline` | `YYYY-MM-DD` | 截止 |
| `_task_recur` | `<n><d｜w｜m>`，n ≥ 1 | 重複 |
| `_task_recur_mode` | `fixed｜after`（`fixed` 不存） | 重複方式 |
| `_task_remind_at` | ISO 時間（含時區），或 `YYYY-MM-DDTHH:MM[:SS]`（工作區時區） | 提醒時間 |

各欄位互相獨立，伺服器不強制互斥：`someday` 有值時任務屬於「隨時」，即使還留著 `when`（舊的 `later` 任務就是這樣轉過來的）。要不要同時清掉日期是介面的決定。

任務列（bootstrap `tasks`、sync `tasks.upsert`、`GET /api/tasks/agenda`、各寫入回應）：既有欄位 `id, workspace_id, node_id, title, status, due_date, recur, created_at, updated_at` 不變，其中 `node_id` 可為 `null`；新增 `when_date, evening, someday, deadline, recur_mode, remind_at, space_id, has_body`。`due_date` 永遠等於 `when_date`（舊客戶端與離線佇列的名稱）。agenda 的列另有 `node_title`（獨立任務為 `""`）與 `bucket`；buckets 名稱不變：`overdue today upcoming waiting later unscheduled scheduled`，`someday` 的任務在 `later`。

### 寫入

| 請求 | 說明 |
|---|---|
| `POST /api/tasks` | body `{ id?, title, when_date?, evening?, someday?, deadline?, recur?, recur_mode?, remind_at?, space_id? }` → 201 任務列。`id` 是客戶端產生的 uuid，重送同一個 id 回同一個任務；id 已是別的東西 409 `id_conflict`。沒有寫入權的空間 403 |
| `PATCH /api/tasks/:id` | `title status when_date evening someday deadline recur recur_mode remind_at`，`null` 清除（旗標清除＝關）。空 body 400；`when_date` 與 `due_date` 同時給而不同天 400 |
| `POST /api/nodes/:id/tasks` | 在筆記底下新增（路徑與先前相同），收同樣的欄位 |
| `POST /api/tasks/:id/place` | body `{ note_id, after_block_ref? }` → 任務列＋`block_ref`。404 找不到任務／筆記／區塊，409 `already_placed`、`not_a_note`，403 沒寫入權 |
| `POST /api/tasks/:id/unplace` | → 任務列。409 `not_placed` |

全部走 spine `mutate()`：每個欄位的變更是自己的 `ATTRIBUTE_SET／ATTRIBUTE_DELETED` 事件，標題是 `NODE_UPDATED`，建立是 `NODE_CREATED`，同一個交易、可復原。權限在事件鎖內以當前 actor 重判。

### 舊客戶端相容

- `due_date`（建立與 PATCH 都收）：日期部分是 `when_date`；帶時間的 `YYYY-MM-DDTHH:MM` 其時間成為 `remind_at`（沒另外給 `remind_at` 時）。回應仍帶 `due_date`（＝`when_date`，不帶時間）。
- `status: "later"`（舊的「擱著」）：寫入視為 `status: todo` ＋ `someday: true`。伺服器不再回傳 `later` 這個狀態。已知限制：舊客戶端用 `status: todo` 把擱著的任務拉回來，不會清掉 `someday`。
- 前端 `NodeTask.status` 型別仍留 `"later"`，只為了讀得懂舊資料；本機鏡像在遷移時把 `later` 列轉成 todo＋someday。

## 重複

- **fixed（照時間表）**：完成時，下一次是排程上 `max(when, 今天)` 之後的第一個日子（既有 break-or-make「make」）；提早或晚完成都不改變時間表。排程器的「過期就往後推」（「break」）只作用在這種：未處理過期的 `fixed` 重複任務被標成取消（`TASK_OCCURRENCE_MISSED`），並產生下一次。沒有 `when` 的 `fixed` 任務沒有時間表可跟，完成時不產生下一次。
- **after（完成後起算）**：完成時，下一次是**完成當天**加一個間隔，沒有 `when` 也可以。排程器完全不碰。
- 下一次沿用 `evening`、`recur`、`recur_mode`；`deadline` 與 `remind_at` 保持與日子的相對距離；不沿用 `someday`（有了日子就不是「隨時」）。
- `someday` 的任務、模組關掉的工作區：排程器不滾動。純函式在 `modules/tasks/recurrence.ts`（`nextOccurrence`），scheduler 與完成共用。

## 放進筆記／拿出來

一個事件交易內完成，任務的搬移、筆記的修改與連結一起提交或一起退回：

1. **放進**：任務若在別的空間，先用 `moveToSpace` 搬到筆記的空間（搬動規則照原有：來源是自己的個人空間才行）；再把任務掛到筆記底下（`updateNode` 改 `parent_id`）；最後在筆記裡寫一行 `- [ ] 標題 {task} ^ref`（已完成的任務寫成 `[x]`）。`after_block_ref` 給的區塊：有標籤的區塊（區塊節點）或任何以 `^ref` 結尾的一行；清單項目接在它與它的子項目之後，其他區塊接在下一個空行之前。沒給就放在筆記最後。筆記的存檔會替那一行建立區塊節點，這時模組把**這個任務**接到它（`adoptTaskForLine`），而不是從那一行再造一個。
2. **拿出來**：先解除區塊與任務的連結（否則刪掉那行會把任務丟進垃圾桶），從筆記刪掉任務自己的那一行（底下的子項目留在筆記），任務的 `parent_id` 清掉。任務留在目前的空間（不搬回個人空間）。從沒有行的位置（用 `POST /api/nodes/:id/tasks` 建在筆記底下的）拿出來，只是不再掛在筆記底下。

## 模組關掉

- 任務資料與 `#task` 標籤保留，不刪不改。
- 排程器跳過這個工作區（SQL 依 `workspaces.modules_off`）。
- `/api/tasks` 底下的寫入與 `POST /api/nodes/:id/tasks` 回 409 `module_not_imported`；讀取（agenda）照常回應，因為移除模組保留資料。
- 筆記存檔：`{task}` 不再建任務、既有的行任務不被同步或丟進垃圾桶、標籤不會被新建；一般勾選框 `- [ ]` 是核心，照常能勾。重新打開之後，下一次存那篇筆記就把行與任務對齊。
- 介面收起任務頁與提醒是前端的事（`modules` 清單不含 `tasks`）。

## Migration 135

見 `db/migrations/135_tasks_module.sql`；不刪任何資料。

1. `reserved_key = 'task'` 的標籤改成模組標籤（保留 id、名稱、顏色與成員），`tag_is_inheritable` 預設關；放在它底下的標籤、或它自己有父標籤，照 migration 129 的規則搬到根層並讓子標籤「延伸」它，工作區的 `membership_epoch` 加一。
2. `_task_due` 改名 `_task_when`（值截成日期）；帶時間的值，時間放進 `_task_remind_at`。
3. `later` → `todo` ＋ `_task_someday = true`。
4. 每天掃描的部分索引 `node_attr_task_due` 換成 `node_attr_task_when`。

重跑沒有影響。還原演練：屬性數量會增加（新增提醒與 someday 兩種列），已用 `-- drill: allows attributes` 聲明；任務數量以「保留 key 或模組標記」計（`packages/backend/scripts/drillInvariants.ts`）。

## 任務節點記一筆引用；標籤不再讓筆記成為任務（2026-11-12，migration 191）

提案：[功能引用第三批](proposals/function-refs-b3-2026-11-12.md)第 2、7 節。

- **身分**：任務節點是**有一筆 `function_refs`（`function_id = 'tasks'`，引用者＝該節點）、並有 `_task_status` 的隱藏節點**；不再掛任務模組標籤。判斷只在 `spine/taskIdentity.ts` 的 `hasTaskRefSql`／`isTaskSql`（用 `function_refs_holder_node_idx`）；建立在 `tasksStore.createTaskNode`／`insertTaskNodeTx`／`addTaskRefTx`（引用由建立節點的事件記下，不另記事件）。同步給客戶端的 `tasks` 列、備份匯出的任務表示法不變。
- **`{task}`**：任務模組自己的保留字（`taskIdentity.TASK_TAG_NAME`；前端 `moduleLineWord("tasks")`），`blockNodes` 存檔時不把它交給 `resolveTagNames`，所以不會在任何情況下新建 `task` 標籤。保留字是**任務模組標籤目前的名稱**（`tasksStore.taskLineWord`；沒有那個標籤節點時是 `task`）：標籤被改名、或因已有普通的 `task` 根標籤而叫 `任務` 的工作區，寫的是 `{任務}`，與 main 上「靠標籤認」的行為一致，普通的 `{task}` 標籤也不會被拿掉；標籤節點移除時再決定改名的工作區怎麼轉；行內任務的 `block_node_tags` 列移除，`block_nodes.task_id` 不動。
- **移除第三種任務**：標籤的 `tasks_checkable`／`tasks_dates` 功能、`services/noteTasks.ts`、`PATCH /api/nodes/:id/task`、agenda 與日記對它的支援、前端 `lib/tasks/noteTasks.ts` 全部拿掉。migration 把仍持有這兩個功能的引用列刪掉（NOTICE 印出標籤 id）；筆記與它們的 `_task_*` 屬性值不動，只是不再被當成任務。
- **備份**：還原舊備份時，備份裡的任務標籤不當標籤還原（`TagAction` 的 `tasks_tag`），任務由 `createTaskNode`／`createStandaloneTask` 重建並得到引用。
- **模組標籤節點**這一批仍在（之後的 PR 移除）；沒有程式再依賴它存在。

## 驗證

- 後端：`tasksModule.integration.test.ts`（獨立任務、讀取範圍、欄位、重複、放進／拿出、模組關掉）、`tasksModuleMigration.integration.test.ts`、既有的 `tasksAsNodes`、`taskPhase3`、`blockTasks`、`taskScopeContract`、`dayLens`、`writePermissionMatrix`、`apiContract`、`taskBucketRule`。
- migration 191：後端 `tasksIntoFunctionRefsMigration.integration.test.ts`（搬遷前後任務列、agenda、同步列相同）；`functionRefs.integration.test.ts`（筆記當引用者）；`blockTasks.integration.test.ts`（`{task}` 不建標籤）。
- 前端：`taskWriterStandalone.test.ts`、`taskMirror.test.ts`、`taskBucketRule.test.ts`、`workerImports.test.ts`（本機資料庫 worker 的大小與 import 守門）。
