# 工作階段第二批：讀開啟者的個人資料、不離開那台、不認得的作者

> 狀態：提案（2026-11-17）。只做後端與錯誤句子字典：沒有畫面、沒有通道、沒有部署。
> 接在 [工作階段後端核心](sessions-core-2026-11-17.md)（PR #1800，已合併）之後，做它第 6、9 節留下的事。
> 完成後：歸檔
> 標記：**【查過】**＝附指令與輸出；**【推論】**＝由程式推出、沒執行；**【沒做】**。

## 0. 七件事，各做了沒有

| # | 事 | 狀態 |
| --- | --- | --- |
| 1 | 工作階段讀開啟它的人的個人資料（七類、一個函式、寫入仍拒絕） | 做了（第 1 節） |
| 2 | 工作階段的任何列、任何標記都不離開那台（快照、修改包、摘要用同一條規則） | 做了；**找到並修掉真的洩漏**（第 2 節）。審查第 1 輪第 3 點（判斷靠另一張表現在的列）：第 2a 節 |
| 2b | 工作階段的 id 不在列的值裡離開（審查第 1 輪第 4 點） | 做了（第 2b 節） |
| 3 | 作者是誰：只有這台能證明是工作階段才說是；移除的成員與 AI 照舊 | 改過（審查第 1 輪第 2 點；第 3 節）。原本「沒有列的 uuid 就給固定標籤」會標錯人，已拿掉 |
| 4 | 錯誤代碼掃描改成看代碼是什麼 | 做了；多找到 84 個代碼，其中 53 個沒有句子，已補（第 4 節） |
| 5 | `NO_VALID_PROBE` 縮小 | 25 → 15：「種資料」6 與「要開模組」5 共 11 條，10 條補好；**skills 一條不是缺資料而是設計**（第 5 節） |
| 6 | 一般登入沒有本文上限：寫進文件、測試釘住 | 做了，沒改行為（第 6 節） |
| 2d | 審查第 3 輪：工作階段不得做不可復原的事、不得領取邀請 | 做了（第 2d 節） |
| 2c | 審查第 2 輪：資料庫守住工作階段的列、走訪證明每一類寫入、不記不可信的裝置、屬性來源、段落歷史的作者 | 做了（第 2c 節） |
| 7 | `docs:covered` 列的文件 | 11 份：6 份改、5 份寫了「文件不需要更新」（在 PR 說明） |

## 1. 讀開啟者的個人資料

**設計比較**（新公共介面）。甲：每個讀取點問一個函式「這是誰的列」（採用）。乙：把工作階段的 `ActorCtx.id` 在讀取時換成開啟者的 id。
乙會讓同一個 `actor` 在讀與寫、在空間規則（`spine/spaceAccess.ts` 用工作階段自己的 id 查成員列）裡意思不同：一處忘了還原就變成「用開啟者的身分寫」，
而「工作階段永遠不比開的人寬、寫入永遠被拒」靠的正是它的 id 不是本人的 id。甲只改「讀哪個人的列」，寫入從頭到尾用寫的人自己的 id。

**契約**：

```ts
// spine/authority.ts
personalDataOwnerId(actor): string        // 開啟者（工作階段）或自己；只用在讀取。openedBy 每個請求從 participant_sessions 重讀（spine/currentActor.ts），不信客戶端
isTemporarySessionActor(actor): boolean   // 唯一的「是不是工作階段」：寫入拒絕、讀誰的列、這個讀取點要不要拿掉東西，都問它
// 呼叫範例（modules/rss/mutes.ts）：.where("actor_id", "=", personalDataOwnerId(actor))
```

**【查過】七類、所有讀取點**（`git grep -n personalDataOwnerId -- 'packages/backend/src' ':!packages/backend/src/test'`，節錄）：

```
services/actorPrefs.ts:250:  return readPrefOf(personalDataOwnerId(actor), key);              偏好
modules/review/service.ts:696:  "SELECT settings FROM actor_module_settings WHERE actor_id=$1 …", [personalDataOwnerId(actor), tagId]   複習設定
modules/review/service.ts:220/250/512  review_states（卡片進度、單張卡的排程）；:379…:646 每日上限與覆寫設定
modules/tasks/focus.ts:229:  const owner = personalDataOwnerId(actor);                     專注紀錄
modules/rss/itemList.ts:23 · items.ts:70 · subscriptions.ts:256   RSS 已讀（列表、單篇、未讀數）
modules/rss/mutes.ts:59                                             RSS 靜音（列表；濾掉靜音的文章在 itemList／subscriptions）
modules/external_calendars/store.ts:36 · :41 · :154                  外部行事曆（清單、單個、事件）
```

提案原本寫「八個」是數檔案（readPref、settings、state、cards、focus、items、mutes、store）；`cards.ts` 沒有個人列的讀取，
實際是上面七類十幾處，**一次全改**。`src/test/guards/personalReads.guard.test.ts` 掃每個讀個人表的檔：沒問這個函式、也不在「不是給請求者的讀取」清單（5 項，各有理由）的就失敗，
所以以後新增的讀取點會被擋。

**每一類：陌生電腦多知道了什麼、拿掉了什麼**（不可信的一方握著有效憑證）：

| 類 | 多知道 | 拿掉（對工作階段） | 為什麼 |
| --- | --- | --- | --- |
| 偏好 | 本人的介面設定：導覽、工具列、墨水顏色、字型、專注分鐘、複習每日上限… | 內含**筆記、標籤、訂閱源、文章 id** 的 9 個 key（`sidebarTags`、`recentBlocks`、`dayNoteParent`、`captureDestination`、`rssFeedCounts`、`rssReadingPosition`、`splitPane*`）讀成「沒設過」 | id 可能指向它進不去的空間；讀成「沒設過」與本人沒設過同一個答案。`SESSION_MAY_READ_PREF` 要求每個 key 表態（型別擋），新增 key 時被迫決定 |
| 複習設定 | 本人對某標籤的間隔設定（數字） | 無 | 只能讀它看得到的標籤（`assertVisibleTag`）；內容是數字 |
| 複習進度 | 本人對它**讀得到的**卡片的排程與擱置 | 無（卡片範圍本來就是工作階段的空間範圍） | 進度的列透過 `readableScopeSql(actor)` 連到筆記，讀不到的筆記沒有進度 |
| 專注 | 本人當天的專注時間與長度；綁在它讀得到的任務上的紀錄連那句話 | 綁在它讀不到的任務上的紀錄整筆不給（任務 id 與那句話）；**沒綁任務的紀錄那句話不給**（只給時間與長度） | 那句話可能寫了別的空間的事，沒有任務就沒有範圍可以判斷 |
| RSS 已讀 | 本人讀過哪些文章 | 無 | 只對它讀得到的訂閱源（列表本來就以來源範圍限制） |
| RSS 靜音 | 靜音的**訂閱源**（讀得到的才列）；靜音關鍵字會讓文章被濾掉（效果看得到） | **關鍵字不列出來** | 關鍵字是本人自己的字（不想看什麼），列表是為了管理它，工作階段不能管理 |
| 外部行事曆 | 本人的行事曆名稱、顏色、事件的**時間**（標題固定「忙碌」） | 清單裡的**網址主機**與**抓取錯誤**；事件的**標題、地點、說明**（空） | 網址（含密鑰）本來就只存密文、任何回應都不含；主機與錯誤碼只服務設定頁；地點與說明常帶會議連結與密碼（帶能力的值），行事曆不受空間範圍限制、62 天一段可以翻完整個歷史。放寬要業主決定 |

【審查第 1 輪改成保守的一邊】行事曆事件原本整個給，現在只給時間與「忙碌」（`modules/external_calendars/store.ts` 的 `eventForReader`，與 `forReader` 同一處）；業主若說要給標題，再放寬（第 7 節）。
**不在讀取點裡的**：推播訂閱（endpoint、金鑰）沒有任何讀取路徑給任何人（只有寄推播的背景工作讀），所以不需要拿掉；MCP token 本來就不是個人列。

**性質測試**（`src/test/properties/sessionReadsOwn.property.integration.test.ts`）：隨機的人 P（偏好、行事曆、靜音、已讀、專注，各隨機）與成員 M，
P 開的工作階段讀到的**等於 P 自己讀的減去上表拿掉的**（期望值由測試自己寫的模型算，不是程式的函式）；「別人（M）開的」工作階段讀到 M 的、
任何答案都不含 P 的字，反之亦然。另有：寫入全部 403 且列數不變（偏好、行事曆、靜音、專注、評分、複習設定、標已讀、結束靜音）、行事曆路由讀 200／改 403。

## 2. 工作階段的東西不離開那台

**【查過】**（`sessionsStayOnTheirNode.integration.test.ts`，兩個節點，PGlite；修之前）：在 A 開工作階段、它在共用空間寫一則筆記、結束（成員列被清掉）後讀給 B 的修改包並收下：

```
× an ended session: B holds its note … and nothing of the session itself      stampsNamingIt: expected 0, got 1
× a session that ran out …
× on the wire: … the digests of the two nodes agree
```

洩漏的是 **`space_members` 那一列被刪除留下的墓碑標記**：它的 row key 是 `<空間>/<工作階段的 actor id>`。快照與修改包只用「在表裡的列」判斷範圍，
墓碑（列已不在）不經過那個判斷；快照的 `readTombstoneChunk`、修改包、摘要（`computeSnapshotDigest`）各自讀標記，所以三處都會送（摘要還會讓兩台的數字對不起來）。

**規則**（一處）：`spine/syncClasses.json` 的 `neverLeaves`（分類裡寫「這張表的哪些列永遠不離開」：`actors` 與 `space_members` 的臨時工作階段的列），
`spine/snapshotTables.json` 寫怎麼判斷（SQL），`spine/snapshotTables.ts` 的 `SNAPSHOT_SPECS.where`（列）與 `stampMayLeaveSql`（標記，含墓碑）用它；
快照、修改包、摘要都問同一個。標記只靠 key 判斷，所以有標記的表的 `neverLeaves` 只准用主鍵欄位（`neverLeaves.guard.test.ts` 擋）。
**舊的兩處特例**（`actors.where` 的 `type <> 'session'`、`space_members.where` 的 `NOT IN (…)`）併進同一條，`where` 裡不能再有 `session`（守門擋）。
**沒有動** `spine/stampedMerge/*` 與 `spine/stampedImport.ts`（修在 `spine/snapshotSql.ts` 的三個讀標記的查詢，各加 `AND ${stampMayLeaveSql()}`，與 `spine/snapshotTables.ts`）。

修之後：B 有筆記與它的標記（作者＝工作階段 id）、沒有 `actors` 列、沒有 `space_members` 列、沒有 `participant_sessions`、沒有 key 或值提到工作階段的標記；
線上傳輸（修改包與快照頁序列化成 JSON，拿掉 `author` 欄位後）找不到工作階段 id；兩台的摘要相同。變異檢查：拿掉 `stampMayLeaveSql`（3 項失敗）、拿掉列的 `neverLeaves`（2 項失敗）。

## 2a. 判斷靠的列要一直在（審查第 1 輪第 3 點）

`space_members` 的 `neverLeaves` 是「成員是 `type = 'session'` 的 actor」，讀的是 `actors` **現在的**列。墓碑比它的列活得久：工作階段的 `actors` 列一旦被刪，
它成員列的墓碑（key `<空間>/<工作階段 id>`）就會被判成「可以離開」而送出去。當時 `removeActor` 沒有排除 `type = 'session'`，所以這條路是通的。

**比較兩種做法**：甲、工作階段的 `actors` 列**永遠不刪**，只結束（採用）。乙、把「這是工作階段的」記在標記或列本身（`sync_stamps` 多一欄，或另一張只增不刪的表）。
乙要動寫標記的觸發器與 `stampedMerge`（另一個 PR 正在改），也多一份要保持一致的紀錄；甲不用 migration，而且第 3 節要的證據（「這個作者是工作階段」）正好就是這一列。

**規則與它的守門**：

- `services/actors.ts` `removeActor`：對工作階段回 **409 `session_not_removable`**（「臨時工作階段是結束，不是移除」，句子兩種語言都有），列、`participant_sessions` 列與歷史都留著、不寫 `ACTOR_DELETED`。
  理由：結束有自己的操作、事件與權限（`endTemporarySession`），同一個操作有兩種意思是要避免的。成員清單本來就不列工作階段（`listActors` 的 `type <> 'session'`），畫面不會出現這個按鈕。
- 唯一一句 `DELETE FROM actors` 加上 `AND type <> 'session'`（多一層：就算上面的判斷被拿掉也刪不到）。
- `guards/neverLeaves.guard.test.ts`：(一) `neverLeaves` 讀了別張表（`FROM`／`JOIN`）的，必須列在 `CROSS_TABLE_INVARIANTS`（`// ratchet:list never-leaves-cross-table`），寫明保持那些列的不變條件與測試它的測試名稱，
  而且那個測試要存在；新的一條沒寫就紅。(二) 原始碼裡每一句 `DELETE FROM actors` 都要排除 `'session'`，不准用查詢產生器刪 `actors`。
- `sessionActorKept.integration.test.ts`：拒絕（列還在、墓碑仍不離開）；開啟者被移除時（先交出擁有權）工作階段結束、`participant_sessions` 列隨 FK 一起刪、`actors` 列留著、墓碑仍不離開；
  **FK 連帶刪除也會寫墓碑**（移除一個成員，`space_members` 經 `ON DELETE CASCADE` 刪掉，留下一個刪除標記，而且是可以離開的：人的；【查過】PGlite 與本機真 Postgres 16）；
  以及「為什麼列要留著」：手動刪掉工作階段的 `actors` 列後，同一個墓碑就變成可以離開——這就是規則依賴的事。

**誰清掉它們**：沒有。每開一次工作階段留下一列 `actors`（id、名稱、type）與一列 `participant_sessions`（開啟者被移除時隨 FK 刪掉）。要清，得連同指著它的標記一起處理，見第 7 節。
**第 2 輪改成由資料庫守**（第 2c 節）：文字掃描補不完拼法，改成 migration 217 的觸發器；原本的掃描留作第二層，也掃 `scripts/` 與 `db/migrations/`。

## 2b. 工作階段的 id 不在列的值裡離開（審查第 1 輪第 4 點）

**【查過】會被帶走、可能放 actor id 的欄位**（從資料庫目錄讀，不是手寫：參照 `actors(id)` 的欄位，或名稱是 `actor_id`、`*_by`、`*_actor_id`、`author*`、`created_by*`，
且沒有被 `snapshotTables.json` 的 `exclude`／`override` 留在這台；`carriedActorColumns.integration.test.ts`，新的一欄沒分類就紅）：

| 欄位 | 工作階段寫得到嗎（路由） | 怎麼擋 |
| --- | --- | --- |
| `actors.id`、`space_members.actor_id` | 是（開工作階段時建） | `neverLeaves`（第 2 節） |
| `workspaces.owner_actor_id`、`spaces.owner_actor_id` | 否：擁有者與個人空間的主人是人 | — |
| `function_refs.created_by` | **是**：`PUT /api/review/cards/:nodeId`、`POST /api/nodes/:id/views`、在段落寫卡片字（`PATCH /api/nodes/:id` → `blockNodes.ts` → 複習的 `markCards`） | `carriedActorId` → null |
| `ai_edit_suggestion_items.decided_by` | 否：接受／拒絕是人做的（`routes/aiSuggestions.ts` `requirePerson`；走訪時兩條都 403） | 仍經 `carriedActorId` |
| `rss_subscriptions.created_by_actor_id` | 否：訂閱是個人寫入（`mutatePersonal` 拒絕工作階段） | 仍經 `carriedActorId` |
| `ai_edit_suggestions.agent_actor_id` | 否：只有 AI | — |
| 個人表的 `actor_id`（偏好、複習設定與進度、專注、RSS 已讀與靜音、外部行事曆） | 否：個人寫入一律拒絕 | — |
| JSON 欄位（`presentation`、`tag_schema`、`config`、`value`…） | 沒有已知的寫入點放 actor id | 靠下面的走訪在線上檢查 |

**一條規則**：`spine/authority.ts` `carriedActorId(actor)`——會被帶走的「誰做的」欄位，寫的人是人或 AI 時記他的 id（他們的 `actors` 列也會帶走），
**臨時工作階段記 null**（和 System 這種不是 uuid 的操作者一樣）。**不記開啟者的 id**：那會把工作階段做的事算到開啟者頭上（歷史會說是他做的）；這三欄都不是「這是誰的」的意思
（`function_refs.created_by` 沒有讀取點；`decided_by` 沒有讀取點；RSS 的 `created_by_actor_id` 只用在搬移「自己建的」訂閱源，null 就是不搬，和 System 建的一樣）。
是誰寫的仍留在這台：事件（`domain_events.actor_id`，不離開）與標記的 `author`。規則放在**寫那一欄的函式裡**（`insertOwnRef`、`markOwnRefViaWord`、`insertView`、`addFunction`、`settle`、`createSource`），
呼叫端只傳寫的人（`by: actor`），不各自判斷。

**走訪**（`sessionsStayOnTheirNodeWrites.integration.test.ts`）：用寫入掃描的路由清單（`helpers/sweepWriteBodies.ts`，每條掛上的寫入路由一個有效請求，缺一條 `crossWorkspaceWriteSweep` 就紅），
工作階段拿著自己的憑證對自己工作區的東西把 164 條全打一次（【查過】48 條 2xx，含建立／修改筆記、複習卡、筆記檢視、標籤、屬性、連結、白板、還原、匯入）；
然後擁有者讀快照與修改包（序列化成線上的 JSON、拿掉標記的 `author`）：工作階段的 actor id 與 session id 都找不到；控制組：帶 `author` 時找得到。

**標記的 `author` 照原樣帶真的 id**（決定）。它是每個標記內容雜湊的一部分（`spine/stampedImport.ts` 的 `wall/counter/author/device`），兩台要持有一模一樣的標記，
在送出時換掉就要改 `stampedMerge`（另一個 PR 在改，本批不動）。收到的那台**能做的**：知道「這幾筆是同一個它不認得的 id 寫的」；**不能做的**：查到名字（`actors` 列不離開）、
知道那是工作階段、用它做任何事（它不是憑證；`participant_sessions` 不離開；這台的入口只認 `actors` 列與憑證雜湊）。id 是 `randomUUID()`，不帶裝置或地點。
同一處還有 `device`（寫入請求的 `x-onden-device-id`，**由不可信的電腦自己給**）也跟著標記走：第 2 輪起工作階段的寫入不記它（第 2c 節）。

## 3. 作者是誰（審查第 1 輪第 2 點：原本的標籤給錯人）

**原本的錯**：`authorName.ts` 寫「沒有 `actors` 列的 uuid 只可能是工作階段的寫入」。不對：`removeActor` 會刪 `actors` 列，migration 071 的 `domain_events_actor_ref` 只在 INSERT 檢查，
所以**被移除的成員與 AI** 的舊事件也是「沒有列的 uuid」，會在版本、筆跡版本、當天活動、還原卡被標成「臨時工作階段」，`history/activity.ts` 的 LEFT JOIN 還把它們（含 AI）說成 `human`，
`backupHistory.ts` 把標籤寫進備份檔的 `actor.name`，跟著備份帶走。這是「註解寫『只可能』、程式其實有反例」的一次，記在 `docs/agents/mistakes.md`。

**規則**：只有這台能**證明**作者是工作階段時才說是。證據是這台自己的 `actors` 列、`type = 'session'`；這一列永遠留著（第 2a 節）。讀取照舊 JOIN `actors`，問 JOIN 到的列的 type，
不看 id 長什麼樣子（`services/authorName.ts`：`shownAuthorName(type, 名稱)`、`shownAuthorKind(type, 種類)`）。伺服器送**種類** `session`、不送名稱；畫面用使用者的語言寫
「臨時工作階段」／「A temporary session」（`NoteHistory.tsx`、`WorkspaceHistoryNoteRow.tsx`），後端不再有寫死的中文。

**【查過】origin/main 對「被移除的成員」顯示什麼，本批沒有證據時照舊**：

| 讀取面 | 檔案 | 被移除的成員或 AI（main 與現在相同） | 這台的工作階段（現在） |
| --- | --- | --- | --- |
| 版本清單（列表與 raw） | `services/history/noteVersions.ts` | 名稱 `null`、種類照事件（畫面「某位成員」／「AI」） | 名稱 `null`、種類 `session` |
| 手寫／白板的版本與修改 | `services/nodeReads.ts`、`services/history/inkChanges.ts` | 同上 | 同上 |
| 當天誰改了 | `services/history/activity.ts` | 不列（內部 JOIN；本批把 LEFT JOIN 改回來） | `{ name: null, kind: "session" }` |
| 當天的還原卡 | `services/history/rewind.ts` | 名稱 `""`；`actor_kind` 照事件的 `actor_type`（第 2 輪；原本一律 `human`，被移除的 AI 也是） | 名稱 `""`、`actor_kind: "session"`（畫面目前不顯示還原卡的人） |
| 備份寫的歷史 | `services/backupHistory.ts` | 名稱 `null`、type 照事件 | 名稱 `null`（**不寫標籤**，也不寫 `actors.name`「你（臨時）」）、type `user` |
| 事件清單 `/api/events` | `services/eventQuery.ts` | 只回 `actor_id` 與 `actor_type`，沒有名稱 | 同左（沒改；工作階段的事件 `actor_type` 是 `user`）。**畫面**拿到查不到的 id 時不顯示 id：清單只寫 `actor_type` 的字（`components/SideDrawers.tsx` `actorTypeLabel`：「使用者」），AI 用 `agentNameOf(id)` 找名字，找不到就「AI」（`lib/history/eventSentence.ts`）。測試：`unknownAuthor.integration.test.ts`「the event list」 |

**順手修掉的一個會變嚴重的舊問題**：帶進來的版本（`tx_meta.history_import`）名稱是 null 時，讀取用 `coalesce(帶進來的名稱, a.name)`，`a` 是**做還原的人**——
沒有名字的版本會被說成是還原的人寫的。工作階段的版本在備份裡沒有名字，還原的人多半就是開啟者，所以這會把工作階段的寫入算到開啟者頭上。
現在帶進來的版本只用它自己帶的名稱與種類（`history/bodyEvents.ts` `versionActorNameSql`、`versionAuthorRowTypeSql`），不會落到還原的人。

**別台收到的工作階段寫入**：今天它的**事件**收不進來（071 在 INSERT 就拒絕不認得的 uuid，`it.fails("WANTED: …")` 照舊釘著），只有標記會到，而沒有讀取面顯示標記的作者。
等事件能收進來，這台沒有任何東西能證明它是工作階段（`actors` 列不離開它開的那台），所以會顯示得和被移除的成員一樣。若要顯示成工作階段，得讓「是工作階段」跟著寫入走——那就是一個要決定的設計（第 7 節）。

**測試**：`unknownAuthor.integration.test.ts`——被移除的成員、被移除的 AI、這台結束的工作階段，各寫一則筆記、一筆筆跡、一次還原，再在上表每個讀取面檢查（id 與任何標籤都不出現）；
控制組：還在的人有名字、工作階段的列還在。

## 2d. 工作階段不得做不可復原的事（審查第 3 輪）

**規則（一類，不是一條路由）**：不被信任的電腦做的事要救得回來。它改的、丟進垃圾桶的，都有路回來（`restoreEvent`、垃圾桶）；
**永久刪除、清空垃圾桶、刪掉一個沒有復原路徑的東西**沒有，一律拒絕工作階段（403），其他人照舊。
「有沒有復原路徑」照程式裡已有的那一條規則判斷：`services/restoreContract.ts` `restoreBlockedReason`
（`irreversible`＝永久刪除；`unsupported`＝這種事件沒有反向操作）。

**機制**：和 `own_personal` 同一個地方：`spine/authority.ts` 一個新的授權種類 `{ kind: "irreversible", of }`，`assertAuthority` 遇到它先問
`assertUndoableBy(actor)`（工作階段就丟 `AuthorityError`，訊息固定），再檢查 `of`（原本的權限，不變）。在宣告權限之前沒有別的檢查的兩處
（整批永久刪除、清除 AI 對話）在入口直接呼叫 `assertUndoableBy`。不選 `requirePerson`：它也會拒絕委派的 token（AI），改到 AI 的允許結果；這一類只是工作階段不行。

**【查過】工作階段在走訪裡成功（2xx）的每一類寫入，逐類**（走訪每個請求後讀它寫的事件；「可復原」是事件有反向操作或進垃圾桶）：

| 類 | 路由（2xx 的） | 寫的事件 | 可復原？ | 處理 |
| --- | --- | --- | --- | --- |
| `history/deleted` | `POST /api/history/deleted/purge` | 沒有：每筆被空間的 manage 擋下（`purgeDeletedEach` 把拒絕收成 `purged: false`），整批仍回 200——**工作階段沒有永久刪除任何東西** | **否**：永久刪除 | **403**（入口） |
| （同類，原本就 403） | `POST /api/nodes/:id/purge`；刪空間時的「一起永久刪除」（`purgeSpaceDeleted`） | `NODES_PURGED` | **否** | **403**（`irreversible` 種類；原本靠空間的 manage） |
| `nodes/views` 的刪除 | `DELETE /api/nodes/:id/views/:viewId` | `COLLECTION_VIEW_DELETED` | **否**：`unsupported` | **403** |
| `edges` 的刪除 | `DELETE /api/edges/:id` | `EDGE_DELETED` | **否**：`unsupported` | **403** |
| `pointers` 的刪除 | `DELETE /api/pointers/:id` | `POINTER_DELETED` | **否**：`unsupported` | **403** |
| `ai/panel-chat` | `DELETE /api/ai/panel-chat/:nodeId` | 沒有事件（`chat_cleared_at`） | **否**：清掉的對話畫面上回不來（工作階段開不了對話，所以原本都是清 0 筆） | **403**（入口） |
| `tags` 的檢視刪除（原本就 403） | `DELETE /api/tags/:tagId/views/:viewId` | `COLLECTION_VIEW_DELETED` | **否** | 擁有者的（`principal_admin`）之外再包一層 `irreversible` |
| `nodes` | 建立、修改、刪除（進垃圾桶） | `NODE_CREATED`、`NODE_UPDATED`、`NODE_DELETED` | 是 | 照舊 |
| `nodes/undelete`、`events/restore`、`history/rewind`、`history/rewinds`、`history/agent-runs`、`nodes/versions`、`nodes/ink-versions`、`events/revert-conflict` | 救回、還原、回到某時、撤銷 | `NODE_UNDELETED`、`NODE_UPDATED`、`ATTRIBUTE_SET` | 是（本身也可再還原） | 照舊 |
| `nodes/attributes`、`tasks` | 設定、刪除屬性；任務欄位 | `ATTRIBUTE_SET`、`ATTRIBUTE_DELETED` | 是 | 照舊 |
| `nodes/tags` | 套用、拿掉標籤 | `TAG_APPLIED`、`TAG_REMOVED` | 是（`tagMembership.ts` 的還原） | 照舊 |
| `review/cards` | 加、拿掉複習卡 | `FUNCTION_REF_ADDED`、`FUNCTION_REF_REMOVED` | 是（`functionRefs.ts` 的還原；進度是個人列，不刪） | 照舊 |
| `canvases` | 刪白板（進垃圾桶）、改名 | `NODE_DELETED`、`CANVAS_UPDATED` | 刪除：是；改名：沒有反向操作，但只改名字 | 照舊（見下） |
| `boards` | 排列卡片、區塊 | `CANVAS_UPDATED` | 沒有反向操作 | 放上、移動、改名照舊；**拿掉卡片或區塊 403**（第 4 輪） |
| `nodes/position` | 圖上的位置 | `GRAPH_POSITION_UPDATED` | 沒有反向操作，只改位置 | 照舊（見下） |
| `nodes/views` 的建立與修改 | 建、改檢視 | `COLLECTION_VIEW_CREATED`、`COLLECTION_VIEW_UPDATED` | 建：加東西；改：沒有反向操作 | 建、改名、改排序照舊；**改設定（篩選、排序、分組、欄位、版面）403**（第 4 輪） |
| `nodes/promote` | 把隱藏的筆記變成一般筆記 | `NODE_PROMOTED` | 沒有反向操作，只改可見 | 照舊（見下） |
| `edges`、`pointers`、`tags/resolve-path`、`capture/inbox`、`nodes/duplicate`、`nodes/tasks`、`nodes/block-to-child`、`import/obsidian`、`media` | 建立 | `*_CREATED` 等 | 加東西（媒體每次一個新檔名，不覆蓋） | 照舊 |
| `tags` | 建標籤 | `TAG_CREATED` | 加東西；標籤是**整個工作區**的（不屬於空間） | 照舊：**審查已定接受**（它本來就能在筆記上打標籤） |
| `tasks/place`、`tasks/unplace` | 把任務放進／拿出筆記 | `NODE_UPDATED`（段落節點跟著內文） | 是（內文還原時段落節點跟著回來） | 照舊 |
| `nodes/block-anchors` | 確認段落錨點 | 沒有事件 | 只改錨點的狀態，不刪內容 | 照舊 |
| `sync`、`sync/*`、`query`、`nodes/suggested-links` | 讀（用 POST 傳參數） | 沒有 | 不寫 | 照舊 |
| `nodes/export-preview` | 單篇筆記匯出成 Markdown／HTML | 沒有 | 不寫 | 照舊：**審查已定接受**（它讀得到那則筆記） |

**沒有反向操作的修改**：審查第 4 輪定了——**加、移動、改名可以；會拿掉或覆蓋既有內容而沒有反向操作的，一律拒絕工作階段**。所以白板與看板的放上、移動、改名，圖上的位置，
檢視的改名與排序，把隱藏筆記變一般照舊；改檢視的設定、從看板拿掉卡片或區塊改成 403（見下方「第 4 輪」）。
測試（`sessionsStayOnTheirNodeWrites.integration.test.ts`）：(一) 從回應與事件導出：工作階段成功的寫入裡，沒有一個根事件的 `restoreBlockedReason` 是 `irreversible`，
也沒有一個「刪除」（`*_DELETED`、`*_REMOVED`、`*_PURGED`）是 `unsupported`——之後加一條新的不可復原的刪除路由會紅；(二) 上表 403 的每一條：工作階段 403、
訊息是這一類的固定字（`IRREVERSIBLE_REFUSAL`），擁有者用自己的新物件做同一條成功。

**領取邀請**（`POST /api/invites/claim`）：【查過】它今天對工作階段成功時**什麼都沒做**（審查第 3 輪的更正也這樣讀）：領取是在登入時解析 cookie 的那一步做的（`app.ts` 只在沒有 bearer 時把邀請碼交給
`actorForSession`），工作階段用的是 bearer 憑證，所以永遠不會領取；路由本身只回 `{ actor: { id, name, type } }`（工作階段自己的）。走訪那次前後：
整個資料庫的 `space_members` 122 → 122 列、這個工作區的 `space_members` 119 → 119、工作區的 `actors` 37 → 37，沒有事件。現在 `requirePerson` → 403
（委派的 token 在 `/api/mcp/*` 以外本來就被擋在路由之前，所以只多拒絕了工作階段）。同一類的其他路由，走訪裡工作階段都是 403，測試逐條釘住：
加成員、邀請、改成員（角色）、移除成員、空間成員的加入與移除、轉移擁有權、建 token、開另一個工作階段、建空間、刪空間。
「帶憑證不領取」也釘住了：`sessionInviteClaim.integration.test.ts` 讓工作階段拿一個真的、還沒領的邀請碼去領，403，邀請仍未領（`external_id`、`invite_used_at` 仍是 null），成員數不變。

**走訪怎麼算「成功」**（審查第 3 輪第 5 點）：工作階段成功的類別是測試裡一份**完整清單**（`SESSION_KINDS`，`toEqual`），每一類寫「為什麼工作階段可以」與「它該留下什麼」：
事件（工作階段的事件）、媒體列、可讀的回應（用 POST 的讀取），或「這次的請求沒有事可做」並寫原因（`import/obsidian`：匯入的資料夾不是它能寫的；`nodes/block-anchors`：走訪的錨點沒有疑問）——
寫成「沒事可做」的，測試也斷言它真的沒寫，所以它一開始寫東西清單就得改。回應 2xx 但什麼都沒做的（還原到筆記現在那一版、回到「現在」）不算：
`nodes/versions` 與 `history/rewind` 另外各打一次有事可做的請求（先由擁有者改過那則筆記），要留下事件。`NO_POSITIVE` 裡工作階段**沒被拒絕**的路由也逐條列出原因（`NOT_REFUSED_NO_POSITIVE`：
段落連結、展開子筆記，各 409，都是在它能編輯的筆記裡、可復原的修改）。

**伺服器對外的請求**（審查第 3 輪第 6 點）：【查過】`grep -rn "safeFetch\|fetchPageMeta\|fetchAndParseFeed\|fetchPageHtml" src`：

| 路由／來源 | 抓什麼 | 授權在抓之前？ | 工作階段 |
| --- | --- | --- | --- |
| `POST /api/bookmark/preview` | 頁面標題（`pageMeta.ts`） | 原本只有 `requireActor`；現在 `assertMayReachOut` 在前 | **403**，不抓 |
| `POST /api/bookmark` | 頁面標題、描述、圖（寫進筆記） | **原本否**（先抓再 `createNote`）；現在先 `newNoteSpace`（空間寫入權）——所有人都一樣 | **403**，不抓 |
| `POST /api/rss/subscribe` | 訂閱源（`fetchAndParseFeed`，上限 25 MiB、20 秒） | **原本否**（先抓再 `mutatePersonal`）；現在先 `own_personal` 與空間——所有人都一樣 | **403**，不抓 |
| `POST /api/rss/items/:id/fulltext` | 文章原頁（`fetchPageHtml`） | 是（`assertSourceWritable`），但工作階段過得了 | 現在 **403**，不抓 |
| `POST /api/rss/opml`、`POST /api/rss/sources/:id/refresh` | 訂閱源，由 outbox 在之後抓 | 是（`mutatePersonal`、`changeSource` 在排進 outbox 之前） | 403，不抓 |
| `POST/PATCH /api/external-calendars…`、`…/:id/refresh` | 外部行事曆 | 是（`person(c)` 第一行） | 403，不抓 |
| AI 的工具（`harness/scope.ts`）、AI 供應商（`agentRuntime/api`） | 網頁、模型 API | 是 | 到不了（`/api/mcp` 與開 AI 都拒絕工作階段） |

規則：`spine/authority.ts` `assertMayReachOut(actor)`——工作階段不讓這台伺服器對外抓任何東西；每個會抓的請求在抓**之前**呼叫它，並先檢查它原本的權限。
沒有放在 `safeFetch` 裡：工作階段的請求會在同一個非同步脈絡裡帶起背景工作（`void drainOutbox`），那會把擁有者的訂閱源抓取也擋掉。
測試 `sessionNoOutboundFetch.integration.test.ts`：把 `safeFetch` 換成會記錄呼叫的替身，上表每一條工作階段都 401／403 且替身沒被呼叫；控制組：本人的預覽有呼叫；
順序：沒有那個空間寫入權的成員建書籤，403 且沒有抓。

**三個問題的答案（讀碼）**（審查第 3 輪第 10 點，給業主）：
- (a) **開了發布的空間裡，工作階段的編輯或丟進垃圾桶會不會直接改到公開網站？** 編輯**不會**：網站是擁有者按「發布」時的快照，之後的編輯等下一次發布
  （`modules/website/publishing/servedSite.ts` 第 1–9 行）。丟進垃圾桶或改成私人**會**立刻從網站**拿掉**那一頁（只會拿掉，不會加；`takenDown.ts`），
  而且救回來之後要等擁有者下一次發布才會再出現。工作階段不能發布（`/api/publish*` 403）、也不能設或清發布標記（第 4 輪起在所有屬性寫入共用的那一層：`services/attributeChange.ts` `storeAttributeState`，還原事件也走它）。
- (b) **`POST /api/history/rewind` 每一步都可復原嗎？** 是：`services/history/rewind.ts` 的三種步驟——還原＝`updateNode` 寫一個新版本（第 100 行）、救回＝`undeleteNode`（第 123 行）、
  刪除＝`trashNode` 進垃圾桶、不是永久刪除（第 147、165 行）；整次回到某時可以用 `POST /api/history/rewinds/:id/undo` 撤銷（第 286–337 行）。一次最多 `REWIND_MAX_NOTES`（5000）則：量大，但每一則都救得回來。
- (c) **`DELETE /api/nodes/:id/views/:viewId`、`DELETE /api/canvases/:id` 有沒有復原的路？** 檢視：**沒有**——`COLLECTION_VIEW_DELETED` 不在任何還原的處理裡（`restoreContract.ts` 的 `unsupported`），
  舊的檢視只留在事件的 `tx_meta.prev_field_values`，產品沒有路把它放回去；所以現在拒絕工作階段。白板：**有**——它是一則筆記，進垃圾桶（`routes/canvases.ts:108-113`），救回時版面與區塊都回來。

**217 的觸發器補強**（審查第 3 輪第 7 點）：函式 `SET search_path = public, pg_temp`、表名寫 `public.`（同一條連線的暫存表 `workspaces` 不能冒充）；兩個觸發器 `ENABLE ALWAYS`
（`session_replication_role = replica` 也跑；測試釘住）。【查過】還原不受影響：在一個拋棄式資料庫（本機真 Postgres 16），把含 22 列工作階段的測試資料庫用 `scripts/backup.sh` 的
`pg_dump --clean --if-exists --no-owner` 匯出，還原到空資料庫、再還原到它自己身上，兩次都成功（`ON_ERROR_STOP=1`），22 列都在，觸發器狀態 `A`（always），`search_path` 設定也在；
還原後刪工作階段的列仍被拒絕。原因：`--clean` 是 DROP 再建，資料用 COPY 載入，不觸發 DELETE／UPDATE／TRUNCATE。
「沒有任何設定或開關」改成實際成立的說法：觸發器不讀任何設定（GUC）；仍能拿走那一列的是把觸發器關掉的 DDL（`ALTER TABLE … DISABLE TRIGGER`，要表的擁有者）或刪表。
`TRUNCATE workspaces CASCADE` 在有工作階段的列時也會被拒，和「整個工作區刪除時讓開」不一樣（陳述式觸發器分不出整表截斷）：寫進檔頭；【查過】產品、測試、腳本都沒有截斷 `workspaces` 或 `actors`。
測試的清理輔助 `deleteWorkspaceActors` 碰到有工作階段的工作區改成先丟一句明白的錯誤、什麼都不刪（選這個而不是「刪整個工作區」：很多呼叫者的工作區有存過文字的事件，那種事件永遠刪不掉，整個工作區刪不了；有的還是共用的預設工作區）。

### 第 4 輪（審查 6974825917）

**對外請求，從程式導出**：`GET /api/rss/items/:id/link`（文章裡的連結，還沒存的就去抓）原本沒問 `assertMayReachOut`——現在抓之前問（已存的照樣回）。
AI 金鑰與角色的路由（`routes/aiRuntime.ts`）、外部行事曆的新增／修改／更新（`modules/external_calendars/routes.ts`）也在第一步問。
守門 `guards/outboundFetch.guard.test.ts`：從 `safeFetch` 與全域 `fetch` 往上建呼叫圖（依 import 解析名稱），任何方法的路由只要碰得到就必須在路上呼叫 `assertMayReachOut`，
或列在 `UNGUARDED`（`// ratchet:list outbound-fetch-unguarded`，只准減）並寫原因；現在只列 `/api/mcp` 的兩條（`app.ts` 在路由之前就拒絕工作階段）。
`sessionNoOutboundFetch` 補上行事曆的修改與更新、文章連結（GET）、AI 金鑰測試；文章連結另有本人的控制組（會抓）。

**發布標記只有一個入口**：工作階段原本能用 `POST /api/events/:event_id/restore` 還原別人設定或清除 `_published` 的事件，繞過第 3 輪放在 `setNodeAttribute` 的檢查。
現在「這個操作者能不能寫這個鍵」放在所有屬性列共用的寫入函式 `storeAttributeState`（`recordAttributeChange` 與屬性事件的還原都走它）。
【查過】其他寫 `node_attributes` 的檔案都只寫固定的鍵（匯入的戳記、任務的 `_task_*`、看板區塊、網站設定、區塊自動標籤），沒有一個寫發布標記：
既有的 `attributeWriters.test.ts` 本來就列出它們（新的寫入者會紅）；本輪拿掉一項（還原不再自己寫列），並加一則：清單上的其他檔都沒提到發布標記。回到某時、複製、範本、MCP 都經過同一層。（第 4 輪原本寫「複製本來就不帶標記」：那只對「發布」成立，「不發布」會跟著副本走，見下方第 5 輪。）
測試 `sessionPublishMark.integration.test.ts`：工作階段還原「設定」與「清除」兩種事件都被拒（`publish_mark`），標記不變；擁有者自己的還原照舊。

**拿掉或覆蓋、沒有反向操作的，拒絕工作階段**：`PATCH /api/nodes/:id/views/:viewId` 改的不只是名字或排序時、`PATCH` 看板帶 `removeCards`／`removeSections` 時，
授權包一層 `irreversible`（`services/noteViews.ts`、`services/boardWrites.ts`）。只改名、只排序、只放上或移動，照舊。

**走訪改成逐條路由、看效果**（`sessionsStayOnTheirNodeWrites.integration.test.ts`）：
(一) 每一條寫入路由必須是「被拒（401／403）」、或「成功且留下它那一行寫的效果」（`SESSION_ROUTES`，46 條，各寫為什麼可以與效果）、或列在 `NEITHER`（7 條，寫明為什麼兩者都不是）；
404／400／409／422 兩者都不算。(二) 不可復原的判斷改看效果，不看事件名：讀工作階段那次請求寫的 stamp，`deleted`（拿掉一列）或 `saw` 非空（覆蓋了之前的值）的欄位，
除了名字與排列（`RENAME_OR_ARRANGEMENT`：標題、檢視的名字與排序、位置），那次請求必須有一個還原合約能還原的根事件（`restoreBlockedReason` 為 null；還原本身寫的事件也算根）。
(三) 工作階段改檢視設定、從看板拿掉卡片：403；擁有者同樣的請求 200。

**刪除的守門**：`guards/sessionDeletes.guard.test.ts` 掃 `services/` 與 `modules/` 每個會刪列（`DELETE FROM`、`deleteFrom(`）或寫不可還原的 `*_DELETED` 事件的函式：
它自己必須宣告一個工作階段拿不到的授權——`irreversible`、`own_personal`（拒絕工作階段）、`system`（只有背景工作）、`principal_admin`／`review`（工作區擁有者：工作階段的 actor 永遠不是 `workspaces.owner_actor_id`，217 讓它的列一直是工作階段的）、
空間的 `need: "manage"`（個人空間的主人是人；共用空間由工作區擁有者管理）——或自己呼叫 `requirePerson`／`assertUndoableBy`／`mutatePersonal`，或寫一個能還原的 `*_DELETED` 事件；
否則要列在 `LISTED`（`// ratchet:list session-deletes-unguarded`，45 項，每項寫原因：個人資料由呼叫者放在 `mutatePersonal` 裡、呼叫者是擁有者或本人、刪除有反向事件、由內文推導、背景工作與快取）。

**工作階段寫的東西會經背景工作到擁有者設定的目的地**：工作階段能寫的筆記內容，之後會由擁有者設定的 GitHub 備份（outbox 推送）帶出去，開了發布的空間裡也會在擁有者下一次發布時上網站。
這兩條都是擁有者自己設的目的地，工作階段不能新增或改它們（備份、發布都 `requirePerson`），也不讓伺服器對外抓；它只是寫了擁有者的筆記。寫在這裡，讓開工作階段的人知道。

### 第 5 輪（審查 6980879906）

**發布標記：「選擇」與「跟著來」分開**（第 4 輪的退步）：把檢查搬進 `storeAttributeState` 之後，每一筆 `_published` 都問 `requirePerson`，
所以 AI 的權杖與工作階段在「不發布」的筆記底下建筆記、複製一則不發布的筆記、展開範本、把段落變子筆記，全都 403（之前都成功）。規則改成：
**選擇**發布標記（設「發布」、清除、把既有的筆記改成「不發布」）只有人能做；**新筆記從它被建立的地方或被複製的來源帶來的「不發布」**（值只可能是 `'false'`）
不是選擇，任何人照寫——否則不是擋住正常的寫入，就是有人為了放行漏掉這一列，讓一則該保持不發布的筆記的副本被發布。
「跟著來」由寫入帶的 `inheritedAtCreation` 說（`setNodeAttribute` 的 `keptOffNewNote` 轉給它），只有建立筆記的伺服器程式會設：父筆記的網站預設、`child:` 與欄位預設、
複製時來源的「不發布」、匯入檔寫的 `publish: false`（匯入成**新**筆記時；對既有筆記重新匯入仍是選擇、仍拒絕）。`attributeWriters.test.ts` 釘住只有那幾個檔會設它（沒有路由、沒有 AI 工具）。
測試 `nonPersonKeptOff.integration.test.ts`：真的權杖與真的工作階段各一份，五種「跟著來」都成功、新筆記帶 `'false'`；設「發布」、清除、把既有筆記改成「不發布」、帶著「跟著來」寫 `'true'`，都 403；
`unpublishedParentDefault` 的「AI 的 createNode」改成真的權杖。

**跨空間搬移**：工作階段不能把既有的筆記搬到另一個空間（會改變誰讀得到它；搬進發布中的空間會在下次發布時公開，搬出則那一頁立刻下架）。
`spine/authority.ts` `assertKeepsReaders`，問在搬移唯一的授權點 `services/spaces.ts` `sourceAuthority` 的第一步：搬移路由、還原 `NODE_MOVED_SPACE`、任務放進另一個空間的筆記，三條都經過它。
同一個規則也拒絕「把隱藏的筆記變一般」（`POST /api/nodes/:id/promote`：沒有反向，在發布中的空間裡下次發布會成為一頁）。在同一個空間裡搬動、排序照舊。
走訪加了一個 `members_can_move_out` 的共用空間，工作階段兩邊都能寫：403、筆記的空間不變；擁有者同一個請求 200。

**走訪的「被拒」要是規則**：走訪記下每個工作階段請求執行時丟出的每個 `AuthorityError`（換成會記錄自己的子類別），每條被拒的路由，拒絕的原因必須是工作階段的規則
（`session`、`session_irreversible`、擁有者的、`requirePerson` 的，或人／擁有者限定路由的回答代碼），不是「在這個佈景下剛好沒權限」。換了請求的兩條：
`POST /api/canvases`、`POST /api/tasks`（原本沒指定空間，工作階段能寫好幾個空間又沒有預設，403「name the space」）——指定空間之後成功（加東西是工作階段的），結果變了但不是洞。
跨空間搬移是有變的那一條（原本被空間的 `manage` 擋，現在是工作階段的規則）。其餘工作階段永遠過不了、但不說工作階段規則的 9 條（空間的 `manage`、收件匣的審查人、結束不是它開的 AI 工作階段）列在 `STRUCTURAL_REFUSALS` 並寫原因。

**對外抓取的守門補強**：根加上 GitHub 客戶端（`new Octokit…`）、`web-push` 的 `sendNotification`、transformers 的動態匯入、better-auth 的 `auth.handler`；
`drainOutbox` 與排入「`perform` 會對外」的 effect 也算到得了（從每個 `{ kind, perform }` 物件導出；只送到擁有者設定的目的地的 kind 列在 `OWNER_DESTINATIONS` 並寫原因）；
以名字傳入的處理器、`app.on`、`app.use` 跟進去，路徑是模板的照寫、`obj.prop` 的處理器或不是字串的路徑會報出來（不默默略過）；「有守」改成守的呼叫必須在第一個到得了的呼叫**之前**
（`assertMayReachOut`、`requirePerson`、`mutatePersonal`、工作階段拿不到的授權種類，或呼叫一個含有它們的函式）。結果：OPML 與訂閱源更新（經 `changeSource`）、收件匣的三條與發布（`principal_admin` 在前）都被認出有守；`/api/auth/*` 列名並寫原因。

**刪除的守門與效果檢查**：刪除的守門掃整個 `src/`（`routes/`、`spine/`、`db.ts` 的 8 個列名寫原因），單位加上就地寫的路由處理器與 effect 的 `perform:`，守的宣告必須在第一個刪除之前。
走訪的效果檢查加上沒有標記的表（段落節點、段落引用、筆跡、上傳、AI 建議、事件審查、不受標記管的屬性、快照的 `taken_down`）：每個請求前後逐列比較。
「同一個請求有可還原的根事件就放行它所有的移除」是限制：沒有逐項證明根事件的還原涵蓋每一個被拿掉的東西；目前靠它放行的 15 個請求列在 `RELYING_ON_ROOT`，各寫根事件為什麼涵蓋（都是記下前值、或進垃圾桶、或由內文推導的）。媒體的效果改成這次請求新增的列。

**工作階段的哪些動作會立刻改到公開網站**：丟進垃圾桶、改成隱藏、（第 5 輪之前的）搬出空間，都會讓一則已發布的筆記立刻下架，並把網站重新推送到擁有者的 GitHub Pages（`modules/website/index.ts` 的節點掛鉤排入 `site_rebuild`）。
救回來之後要等擁有者下一次發布才會再出現。

**小項**：推送訂閱的刪除也要是人（`requireHuman`，和新增一樣，並放在「伺服器有沒有推送」之前，所以工作階段的回答是規則）；段落錨點的「重新指定」沒有反向（`BLOCK_ANCHOR_CONFIRMED`），包 `irreversible`；
`attributeWriters.test.ts` 也看 Kysely 的寫法；`sessionPublishMark` 加經路由的 403。

### 第 6 輪（審查 6990637869）

**「新筆記」是證明，不是旗標**：第 5 輪讓「帶來的不發布」靠一個布林（`inheritedAtCreation`／`keptOffNewNote`），而匯入的**更新**分支（既有的筆記）也帶上了它，
所以工作階段或 AI 權杖重新匯入一個寫著 `publish: false` 的檔，就能把一則發布中的既有筆記拿下網站。現在：
- 匯入更新既有筆記時的「不發布」是選擇：人照寫；權杖與工作階段，那一個檔回 `site_mark`（「要把一則已有的筆記從網站拿下，這只有你在自己的裝置上能做」），那個檔什麼都不寫（交易回滾），其他檔照做。
- 例外要一份**證明**（`services/newNoteProof.ts`）：只有插入筆記的三處（`createNote`、複製、範本的格）在 INSERT 之後為那個 id 鑄一份，`createNote` 交給 `within`／`afterDerived`；
  發布標記的檢查要證明裡的 id 等於正在寫的那則（`attributeWriters.test.ts` 釘住只有那三個檔鑄、而且在 INSERT 之後）。
- 標籤的欄位預設跳過系統鍵（`_` 開頭），和 `child:` 一樣：套標籤的對象多半是既有筆記。【查過】出貨的標籤沒有一個欄位是系統鍵又有預設。

**取消隱藏的每一條路**：`PATCH /api/nodes/:id {"hidden": false}` 和 promote 效果相同卻沒擋。現在「hidden 由 true 變 false」只有一個檢查：`nodeUpdate.ts` `assertMayShowHidden`，
由 `applyNodeColumns`（存檔、PATCH、還原 `NODE_UPDATED` 共用的欄位寫入）呼叫。`promoteNode` 是明確的「顯示出來」，第 7 輪起不論筆記現在是否隱藏，一律拒絕工作階段（`assertKeepsReaders`）。還原 `NODE_PROMOTED` 沒有反向處理（不在還原清單），所以沒有第三條路。

**守門的「先問」要每次都成立**：對外抓取的守門只認在函式最外層、無條件、在第一個對外之前直接呼叫的守（`assertMayReachOut`、`requirePerson`、`requireHuman`、`mutatePersonal`），
或一張寫明原因的包裝清單（`changeSource`、行事曆的 `person`、`siteAdmin`）；不再認「深處某處有一個守」或單獨的授權字面值。只靠舊規則才過的：收件匣的三條（靠 `principal_admin` 字面值），
現在在處理器開頭呼叫 `assertMayReachOut`；訂閱源更新與發布改由包裝清單認出。

**走訪的「被拒」看造成回應的那一個拒絕**：記下錯誤處理器轉換成 401／403 的那一個（`spineErrorStatus`），或路由自己的回答代碼；不再掃請求期間建構過的所有拒絕。

**第 7 輪**：(1) 已是「不發布」的筆記，權杖或工作階段寫入同樣的「不發布」（例如重新匯入仍寫著 `publish: false` 的檔）不是選擇，也不寫入（`attributeChange.ts` `keepsKeptOff`：不寫而不是放行寫入，因為寫入會把一個從父筆記繼承來的「不發布」變成那個權杖或工作階段寫的）；人照舊。
(2) promote 一律拒絕工作階段。(3) 證明改用模組私有的 `WeakSet` 認（複製一份、或做一個同形狀的物件都不算），守門釘住鑄造和 INSERT 在同一個函式、而且鑄給那個 INSERT 的 id。
(4) 守門的「無條件」也排除 try 區塊；走訪在 app 的錯誤處理器（`apiOnError`）記造成回應的拒絕。**已知**：欄位預設跳過所有 `_` 開頭的鍵，不只 `_published`，所以擁有者自訂的 `_` 欄位預設不再被填（出貨的標籤與模組沒有這種欄位）。

**決定（審查第 6 輪）**：`STRUCTURAL_REFUSALS` 的 9 條、`OWNER_DESTINATIONS` 的 7 個 kind 接受；`RELYING_ON_ROOT` 寫成限制並釘住，逐項證明排到之後的批次（第 7 節第 16 項）。

## 2c. 審查第 2 輪（接手的工作階段）

**段落歷史的作者**（第 1 點）：`BlockHistorySheet.tsx` 原本「沒有名稱就是『你』」，而工作階段與被移除的成員正好都沒有名稱，所以每個看的人都看到「你」。
改成和整篇筆記的歷史同一個函式 `lib/history/historyAuthor.ts`（`NoteHistory.tsx` 原本的 `whoIs` 搬過去）：送來的種類是 `session` 就是「臨時工作階段」；
「你」只在名稱等於目前登入的人的名字時；沒有名稱的人是「某位成員」。raw 版本本來就帶 `actor_kind`，前端現在讀它。
限制：讀取面不送作者 id，所以兩個同名的成員彼此都看成「你」（和當天清單 `WorkspaceHistoryNoteRow.tsx` 同一條規則）。

**資料庫守住工作階段的 `actors` 列**（第 3 點，migration 217）：`actors_keep_session_row` 觸發器，`BEFORE DELETE OR UPDATE OF id, workspace_id, type`：
刪除 `type = 'session'` 的列、改它的 id、工作區或種類、把別的列改成工作階段，一律以 SQLSTATE 23001 拒絕；`TRUNCATE actors` 在有工作階段的列時也拒絕。
**唯一讓開的情況是整個工作區在刪**：判斷是「看不到這個 actor 的 `workspaces` 列」。刪工作區時 `actors` 經 `ON DELETE CASCADE` 跟著刪，Postgres 在 `workspaces` 那一列刪掉之後才跑連帶刪除，
所以觸發器的查詢已經看不到它；沒有任何開關或設定可以讓單一個 actor 符合這個條件（沒有新的 GUC），唯一的辦法就是把整個工作區連同它的一切刪掉；
程式裡刪工作區的兩處（`spine/stampedImport.ts`）緊接著刪它的標記、標記頭與時鐘。
測試（`sessionActorKept.integration.test.ts`「the database keeps a session's actors row」）：六種刪除的拼法（含 `public.actors`、`ONLY "actors"`、別名與 `USING`、`type <> 'session' OR …`、`EXECUTE format` 的變數表名）、
查詢產生器、改種類／id／工作區、把人改成工作階段、經 FK 刪開啟者（工作階段的列留著）、刪整個工作區（讓開，標記也刪）、`TRUNCATE` 觸發器在目錄裡（不實跑：少了它會清空共用資料庫）。
「為什麼要留著」改成在一個一定回滾的交易裡關掉觸發器（`session_replication_role = replica`，只這個連線）示範。`scripts/bMcpSmoke.ts` 那句刪除加上 `AND type <> 'session'`。

**走訪證明每一類寫入**（第 4 點）：每條路由用自己的新物件（和寫入掃描的正向一輪一樣），所有物件在開工作階段**之前**建好（它們建的空間才在工作階段的範圍裡），
開完再讀一次 `membership_epoch`（開工作階段會改它）。寫入的「類」從路由讀（`/api/` 之後前兩段固定的部分），沒被拒絕（401／403／404；對工作階段，404 就是「看不到」，
而每個請求都是掃描的正向一輪證明擁有者會成功的）的每一類至少一條 2xx，否則紅；全都在 `NO_POSITIVE` 的類例外（目前 6 類：段落連結、展開子筆記、段落改歸屬、推播、RSS 的兩條，都要網路或特殊資料）。
沒有請求的路由、逾時（599）都算失敗。線上找的東西多了摘要、憑證、憑證雜湊（含 sha256）與它自稱的裝置；`author` 只從**標記的形狀**（有 `origin`、`seq`、`wall`、`counter`、`author`、`device`）拿掉，
列的值裡有一欄叫 `author` 也會被找到（自測）。【查過】164 條路由，42 類寫成功。

**兩個繞過 `carriedActorId` 的寫入點**（第 5 點）：`backupExtras.ts` 的 `importFunctionRefs`／`importExtras` 改收寫的人（`ActorCtx`），兩欄經 `carriedActorId`；
`carriedActorColumns.integration.test.ts` 用語法樹找出每個寫「誰做的」欄位的地方（查詢產生器的 `.values`／`.set`、或 SQL 文字與它旁邊的參數陣列），值必須是 `carriedActorId(寫的人)`，
【查過】找到 7 處；自測餵它兩種寫法的錯誤。讀不到的：值是一個變數物件的寫入（`modules/rss/sources.ts` 的 `.set(columns)`，鍵是訂閱源的設定）。

**不記不可信的裝置**（第 6 點）：`spine/authority.ts` `recordedDeviceId(actor, 給的)`：人與 AI 記它給的，工作階段記 null。用在 `app.ts`（標頭）與 `updateNode`（存檔的 `body_change.device`，記在段落錨點的事件）。
選 null 而不是「伺服器替工作階段定一個值」：任何從工作階段推出來的值都會隨標記離開這一台，null 和背景工作一樣。
【查過】改之前，工作階段自稱的裝置 id 寫進 `domain_events.device_id` 與標記，並出現在快照與修改包裡（變異檢查：把規則拿掉，走訪找到「the session's device in the snapshot / bundle」）。

**屬性的來源**（第 7 點）：工作階段手動設的屬性原本記 `dispatcher`（`actor.type === "human"` 以外都是），排名最低。【查過】後果：內文有 `#key=value` 時，下一次存內文（任何人）
會用內文的值（`markdown`）蓋掉工作階段打的值；它也不算「人寫的值」（`isPersonAuthored`：匯出的 frontmatter、複製筆記都不帶）。改成和人一樣的 `ui`；`sessionAttributeSource.integration.test.ts`。

**還原卡的種類、事件清單**（第 8 點）：見第 3 節的表。

**工作階段的名稱**（第 9 點）：`actors.name` 不存字（`""`），開工作階段與清單的回應不送 `label`；畫面從種類寫字，和歷史同一個機制。
以前開的工作階段的列仍存「你（臨時）」：沒有讀取面送它，也沒改寫（改既有的列要決定，見第 7 節）。

## 4. 錯誤代碼掃描

`packages/frontend/src/test/serverErrors.test.ts` 原本用「類別名稱以 `Error`／`Refusal` 結尾」找代碼；`SessionRefused` 不符，6 個代碼沒有句子也沒人說。
現在找代碼**看它是什麼**：任何（一層或多層）繼承 `StatusError`／`CodedStatusError` 的類別（含沒有這種後綴的），它們的 `new X(…)` 引數、`super(…)` 裡的代碼，
以及「做出拒絕的小函式」（`const refuse = (code, …) => new XRefusal(403, code, …)`，只在定義它的檔與 `export` 它的檔裡認，不認別處同名的函式）呼叫時給的代碼。
前一版掃描還有一個洞：同一行前面有 `new Set(…)` 時，後面的 `new XError("code")` 被吃掉（`unknown_tag` 就是這樣只被舊的正則碰巧找到），改成往前看引數。

**紅燈與綠燈**：移除一個句子（`session_limit_reached`）→ 新掃描紅（`session_limit_reached (services/participantSessions.ts)`），舊正則找不到這個代碼（`old scan finds session_limit_reached: False`）；補回 → 綠。

**新掃描比舊的多找到 84 個代碼（舊 196、新 280，沒有少找的）**；其中 53 個**沒有句子**，本批補了（`serverSentences.ts` 與 `i18n.zh-TW.late.ts`，白話、沒有 id 與技術字）：
`bundle_*` 17 個、`join_*` 25 個（修改包與加入裝置的拒絕），另外 11 個：`distributed_sync_off`、`too_long`、`snapshot_since_not_done`、`snapshot_layer_not_done`、`stamp_clock_ahead`、`sync_unit_in_conflict`、
`focus_not_found`、`focus_still_running`、`merge_not_open`、`sync_bad_node`、`sync_node_is_self`。其餘 31 個本來就有句子，只是舊掃描沒看見。**新找到的全部 84 個（依來源檔）**：

- `browser/mediaStorage.ts`：`temporary_session_full`
- `distributedSync/index.ts`：`distributed_sync_off`
- `modules/tasks/focus.ts`：`focus_ends_before_it_starts`、`focus_in_future`、`focus_not_found`、`focus_running`、`focus_still_running`、`focus_too_long`
- `modules/website/publishing/snapshot.ts`：`preview_stale`
- `services/aiSuggestions.ts`：`suggestion_too_large`
- `services/edgeWrites.ts`：`derived_edge`
- `services/freshProof.ts`：`fresh_proof_expired`、`fresh_proof_invalid`、`fresh_proof_locked`、`fresh_proof_no_password`、`fresh_proof_password_needed`、`fresh_proof_required`、`fresh_proof_used`、`fresh_proof_wrong_password`
- `services/parentKind.ts`：`module_tag_parent`、`parent_kind_mismatch`
- `services/participantSessions.ts`：`body_too_large`、`session_limit_invalid`、`session_limit_reached`、`session_not_found`、`session_space_unavailable`、`session_spaces_invalid`
- `services/patchedValue.ts`：`patch_base_unknown`、`too_long`
- `services/siteConfig.ts`：`design_stale`
- `services/stampedBundle.ts`：`bundle_owner_only`
- `services/stampedSnapshot.ts`：`snapshot_foreign_origin`、`snapshot_layer_not_done`、`snapshot_since_not_done`
- `spine/eventLock.ts`：`workspace_busy`
- `spine/stampedBundle.ts`：`bundle_bad_have`、`bundle_no_pages`、`bundle_page_missing`、`bundle_pages_differ`、`bundle_sender_joining`
- `spine/stampedImport.ts`：`bundle_data_shape`、`bundle_from_self`、`bundle_gap`、`bundle_malformed`、`bundle_own_origin_ahead`、`bundle_scope`、`bundle_sender_restored`、`bundle_stamp_beyond_cut`、`bundle_stamp_clash`、`bundle_unknown_sender`、`bundle_wrong_workspace`、`join_already_done`、`join_bad_cut`、`join_bad_page`、`join_column_not_carried`、`join_data_shape`、`join_digest_mismatch`、`join_from_self`、`join_head_shape`、`join_layer_not_done`、`join_not_started`、`join_order`、`join_page_changed`、`join_page_extra`、`join_page_missing`、`join_person_missing`、`join_person_not_owner`、`join_sign_in_not_carried`、`join_stamp_conflict`、`join_stamp_from_this_node`、`join_stamp_label`、`join_stamp_number`、`join_stamp_origin`、`join_stamp_saw`、`join_table_not_carried`、`join_unstamped_rows`、`join_wrong_cut`、`join_wrong_source`、`join_wrong_workspace`、`merge_not_open`、`sync_bad_node`、`sync_node_is_self`
- `spine/stamps.ts`：`stamp_clock_ahead`
- `spine/unitInConflict.ts`：`sync_unit_in_conflict`

**這些句子目前沒有畫面會觸發**（裝置同步與加入裝置還沒有畫面），所以不需要更新說明；句子寫的是「那件事發生時會顯示什麼」。

## 5. `NO_VALID_PROBE`：25 → 15

給有效探測的 10 條（成員與工作階段都得 200；工作階段看 B 的真東西與看不存在的 id 得到同樣的狀態與本文，id 遮掉）。
**【查過】**（`SESSION_PROBE_DEBUG=1`，工作階段的回應開頭）：

| 路由 | 工作階段得到（A 的東西） |
| --- | --- |
| `GET /api/history/deleted/:id` | 200，A 的垃圾桶筆記標題與內文 |
| `GET /api/nodes/:id/views/:viewId/exec` | 200，`{"rows":[],"total":0,…,"view":{"layout":"table",…}}`（那則筆記的檢視） |
| `GET /api/tags/:tagId/views/:viewId/exec` | 200，A 裡標了這個標籤的筆記列 |
| `GET /api/canvases/:id` | 200，A 的白板（卡片是它讀得到的） |
| `GET /api/review/settings/:tagId` | 200，`{"mine":null}`（開它的人沒設過；有設過就是他的數字，第 1 節） |
| `GET /api/review/blocks/:blockId/state` | 200，`{"block_id":…,"state":null,"hold":null}` |
| `GET /api/rss/items/:id` | 200，A 的訂閱源的文章 |
| `GET /api/rss/items/:id/link?url=` | 200，`{"kind":"item","id":…}`（同源已有的文章） |
| `GET /api/nodes/:id/ink-change?before=&after=` | 200，兩份筆跡文字 |
| `GET /api/media/:filename` | 200，圖片位元組（嵌在 A 的筆記裡） |

B 那邊每條也種了真的東西，名字放進清單（`NAME.deletedNote`、`view`、`board`、`article`、`drawing`、`media`），掃描與「看 B 的真 id 與不存在的 id 答案相同」都過；沒有新的洩漏。

**`GET /api/skills/:id/skill.md` 沒有變成有效探測，這不是缺資料**：技能筆記是「建立它的那個操作者自己的」（`services/harness/noteSkills.ts` `loadSkills` 要 `NODE_CREATED` 的 `actor_id` ＝ 操作者），
工作階段沒建過任何技能，所以對它永遠是 404；成員建的技能成員讀得到。【推論】看程式，沒有種一個成員的技能來試。已移到「設計上」那組（原因寫在清單裡）。
這也是一個沒有包含在「讀你的」七類裡的個人化讀取：開啟者建的技能，他的工作階段讀不到（第 7 節要你決定）。

剩下 15 條：狀態 2、輸入 2、服務 1、設計上 10。

## 6. 一般登入沒有請求本文上限（只寫進文件、測試釘住）

**發現**（第 3 輪已提）：後端自己沒有本文上限，只有 nginx 有（`docker/nginx/nginx.conf`：`/api/` 20m、`/api/media` 501m）。
**【查過】** 直接打到後端（不經 nginx）、登入的人：`PUT /api/me/prefs/hintsSeen` 送 21 MiB 的 JSON（過了 nginx 的 20 MiB）→ 後端整個讀進來、解析、用形狀不對回 **400 `invalid_pref`**，不是 413。
`grep -rn "bodyLimit(" packages/backend/src` 只有 `routes/media.ts`。意思：任何直接連到後端的人（沒有那層代理、設定錯的代理、同一台機器上的別的行程）可以送任意大小到任何寫入路由，伺服器在回答之前先讀完。
**沒有改**（加上限會改變每一條路由接受什麼）；`requestBodyLimit.integration.test.ts` 釘住今天的行為，誰加上限，這個測試會變 413 而失敗，他要一起改它與這一節。
若要加：`app.ts` 一個全站 `bodyLimit`（用同一對 `MAX_REQUEST_BYTES`／`MAX_MEDIA_REQUEST_BYTES`），工作階段的 `readTemporarySessionBody` 就只剩「剩餘額度」的比對。
臨時工作階段不受影響：它的本文在後端有自己的上限（`readTemporarySessionBody`）。

## 1b. 隱藏在哪裡、各用哪個測試釘住（審查第 1 輪第 7 點）

隱藏分散在五處，不合併成一處，但每一列都有測試（`src/test/properties/sessionReadsOwn.property.integration.test.ts`，下稱「性質測試」）：

| 讀取點 | 給工作階段什麼 | 藏什麼 | 在哪裡藏 | 釘住的測試 |
| --- | --- | --- | --- | --- |
| 偏好 | 本人的介面設定（含 `inkPresets[].name`、`fonts.*.name`：本人打的字，留） | 9 個內含 id 的 key（`sidebarTags` 等） | `services/actorPrefs.ts` `SESSION_MAY_READ_PREF`（型別逼每個 key 表態） | 性質測試（隨機 key 組合，模型自己寫）、控制組讀 `nav` |
| 偏好 `nav` | 順序與手機釘選數 | 無（只會是應用自己的頁面 id） | 前端 `hooks/shellNavigation.ts` `arrangeNavigation`：`candidates = [...core（不含 notes）, ...modules]`，`resolveNavLayout(stored, candidates.map(d => d.id), unused)` 只留候選的 id；沒有任何寫入點放筆記或標籤 id（後端只限大小，所以信任的是前端；有人手打 API 放別的 id，只洩給自己的工作階段） | 性質測試「the navigation preference only ever holds…」（釘住那兩行） |
| 複習設定 | 本人對它**看得到的標籤**的數字 | 看不到的標籤：404，與不存在同一個答案 | `modules/review/service.ts` `personalSettings` 先 `assertVisibleTag` | 性質測試「review: what the person graded or set in a space the session is not in…」 |
| 複習進度 | 本人對它讀得到的卡片的排程與擱置 | 讀不到的卡片：404 | `readableScopeSql(actor)`（`loadEnrolledCards`）、`cardNote` 的 `canReadNode` | 同上；性質測試的 `reviewState`（A 的卡）與 `cardState` 404（B 的卡） |
| 專注 | 時間與長度；綁在它讀得到的任務的紀錄連那句話 | 綁讀不到的任務的紀錄整筆；沒綁任務的紀錄的那句話 | `modules/tasks/focus.ts` `focusOfDay`（`readableAmong`、`timeOnly`） | 性質測試（`@B` 不見、`@none` 的 note 為空） |
| RSS 已讀 | 本人對它讀得到的訂閱源的文章的已讀 | 讀不到的訂閱源 | 以來源範圍限制（`readableSourceIds`） | 性質測試（items、unseen；B 的來源不出現） |
| RSS 靜音 | 靜音的訂閱源（讀得到的才列）；關鍵字的效果 | 關鍵字不列出 | `modules/rss/mutes.ts` `listMutes` | 性質測試（`-keyword-` 不出現）、「a mute of a feed of A…」 |
| 行事曆 | 名稱、顏色、事件的時間 | 網址主機、抓取錯誤；事件標題（固定「忙碌」）、地點、說明 | `modules/external_calendars/store.ts` `forReader`／`eventForReader` | 性質測試（`-host-`、`-event-`、`unreachable` 不出現）、「calendar routes」 |

寫入：每一格都另有「寫入 403、列數不變」的測試（同檔 `it never writes…`）。守門：`personalReads.guard.test.ts` 逐函式檢查每個讀個人表的函式只用 `personalDataOwnerId`（含一個「加一個用 `actor.id` 的讀取會紅」的自測）。

## 7. 需要決定、沒做

1. 行事曆事件：**業主已答**，只給時間與「忙碌」（第 1 節）。
2. 開啟者建的**技能**他的工作階段讀不到（第 5 節）。要不要讓工作階段讀開啟者建的技能（在它讀得到的空間裡）？預設：不給。
3. 專注紀錄沒綁任務的那句話：**業主已答**，不給（第 1 節）。
4. 工作階段建日記時，`dayNoteParent` 讀成「沒設過」（9 個 key 的結果）→ 日記落在空間最上層，不跟本人的設定。
5. 來賓角色與人的「只能提建議」、通道、畫面：不在這批。
6. `distributedSync/bridge/*` 讀 `actors` 與 `space_members`（旗標預設關）：沒有動；開旗標前要先排除 `session`（第 1 批已記）。
7. 工作階段的 `actors` 與 `participant_sessions` 列沒有人清（第 2a 節）。**排進之後的批次（審查第 2 輪）**：要清得同時處理指著它的標記（墓碑），會刪或改既有列；
   那一批要先決定：清的時機（工作階段結束多久之後）、墓碑怎麼辦（一起刪，或先確認每一台都收過）、migration 217 的觸發器要給清理一個明確的入口（不是一個任何程式都能設的開關）。
8. 別台收到的工作階段寫入要不要顯示成工作階段（第 3 節）。**排進之後的批次（審查第 2 輪）**：要的話，「是工作階段」得跟著寫入走（例如標記多帶一個種類），會改標記格式與 `stampedMerge`。
   在那之前：顯示得和被移除的成員一樣。
9. 標記的 `device` 由不可信的電腦自己給：**第 2 輪已做**（第 2c 節）。
10. 工作階段 `actors.name` 寫死的「你（臨時）」：**第 2 輪已做**（第 2c 節）。**不需要改寫舊列**：前提是正式站上沒有舊列——審查者在 2026-11-17 部署後查過，
    `participant_sessions` 0 列、`type = 'session'` 的 `actors` 0 列（工作階段是 #1800 起才有，還沒有畫面能開）。這個前提若不成立（例如有人在部署與本批之間用 API 開過），舊列存的是「你（臨時）」，沒有讀取面送它。
11. PGlite 上大的還原查進度回 500（審查轉給管測試的工作階段）。**重現方式**：`cd packages/backend && ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test npx vitest run src/test/backupHistoryScale.integration.test.ts`，
    在負載高的機器上（例如整套 `npm run test:pglite` 同時跑）較容易出現：搬移在一個交易裡匯入整份歷史（`importNoteHistory`），PGlite 只有一條連線，
    查進度的請求排隊超過 `PG_CONNECT_TIMEOUT_MS`（10 秒）就回 `job poll: 500`，伺服器記錄 `timeout exceeded when trying to connect`。單獨跑時搬移 6～9.5 秒，通常不出現。
12. **後續清單**（不在這批）：同名的兩個成員在歷史裡彼此都是「你」（讀取面不送作者 id；整篇、段落、當天清單同一規則）。
13. 沒有反向操作的修改：**審查第 4 輪已定**——加、移動、改名可以；拿掉或覆蓋既有內容的拒絕（第 2d 節「第 4 輪」）。
14. **工作階段的列會一直累積**（排進後續清單，審查第 4 輪）：`removeActor` 拒絕刪工作階段的列，217 的觸發器也拒絕，所以工作階段結束後 `actors` 與 `participant_sessions` 的列一直留著。
    清它們**要一個新的 migration**（觸發器得給清理一個明確的入口），並同時決定墓碑怎麼辦（見第 7 項）。
15. 工作階段匯入一個寫著「不發布」（`publish: false`）的 Markdown 檔：**審查第 5 輪已定**——匯入成**新**筆記＝讓它保持不發布，放行；對既有筆記設或清標記仍然拒絕（第 2d 節「第 5 輪」）。

16. **逐項證明「根事件的還原涵蓋它拿走的東西」**（排進之後的批次，審查第 6 輪）：今天走訪只要求那個請求有一個可還原的根事件，靠它放行的請求列在 `RELYING_ON_ROOT` 並寫原因。
    要逐項證明，得讓每個還原處理器說出它涵蓋的範圍（哪些表、哪些列），再和走訪讀到的移除逐一比對。

## 7b. 「bounded memory」那一次失敗（審查第 1 輪的 13）

`backupHistoryScale` 量的是行程的常駐記憶體（RSS）峰值。【查過】同一個指令、單獨跑這個檔，origin/main 與本分支（合併前的頭）各 3 次：搬移階段 main +55／+36／+61 MB，分支 +89／+33／+54 MB——
同一段沒改過的程式自己就差到 50 MB，不是本批造成的（本批改的是備份**匯出**每行一個短字串，失敗的是**匯入**那一段）。原因：測試的 worker 沒有 `--expose-gc`，`global.gc` 不存在，
基準點包含前面步驟的垃圾；而且 PGlite 的資料庫就在同一個行程裡，存 16 MB 的列時碰到的原生記憶體頁也算進 RSS。真的收一次垃圾之後（`v8.setFlagsFromString` + `vm.runInNewContext("gc")`），
堆積加陣列緩衝穩定在 +38～45 MB（5 次），RSS 仍是 +20～56 MB。修法：量應用自己持有的（堆積＋陣列緩衝，收過垃圾之後），RSS 照印；上限 `textMb * 2 + 60` 沒改。

## 8. 驗證（見 PR 說明的貼上）

後端與前端 `tsc`、lint、整個 `test:pglite`（不改檔）、`scripts/guard-lane.sh` 逐步、新測試檔 PGlite 連跑 5 次、本機真 Postgres 上能跑的、九項變異檢查。第三批（2a、2b、3、7b）另有五項變異檢查，結果在 PR 留言。
