# 邊界決定：核心寫入、標籤同名、冪等、同步與 membership（第 10–15、17 批，2026-09-13）

> 狀態：現行（最後確認 2026-11-20）
> 涵蓋：packages/backend/src/services/nodeUpdate.ts, packages/backend/src/services/orderKeys.ts, packages/backend/src/services/actorPrefs.ts, packages/backend/src/services/actorReadSnapshot.ts, packages/backend/src/spine/txHooks.ts, packages/backend/src/services/sync/membership.ts, packages/backend/src/services/eventLog/bodyMerge*.ts, packages/frontend/src/lib/data/syncEngine.ts, packages/frontend/src/lib/data/membershipReconcile.ts, packages/frontend/src/lib/pendingNoteProjection.ts, packages/frontend/src/lib/localCopyState.ts, packages/frontend/src/lib/accountPrefStore.ts

何時讀：改 `updateNode`、標籤改名、交易／冪等、sync、membership、待同步文字之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 第十批：核心寫入時序與工作版本（2026-09-13）

- **一般筆記編輯由完整操作擁有。** 比較每個入口自行在交易內組裝與共用領域操作，選擇
  `services/nodeUpdate.ts` 的 `updateNode(workspaceId, id, changes, { actor, baseMarkdown, ... })`。
  REST PATCH 與 agent updateNode 共用目前狀態、授權、合併、slug、父層守衛、逆向歷史、索引與 outbox。
  `source` 只表達追蹤來源，不切換保存保證；agent 也會建立 backup／embed 意圖，並保存完整版本標題。
  dry-run 只預覽，不能保留權限或狀態；正式操作會重新判定。領域拒絕由 `NodeUpdateError` 經共用 HTTP 邊界映射。
- **授權與判斷在鎖內觀察。** 比較 CAS 重算與既有事件鎖後，選擇先取得工作區事件鎖，再讀目前狀態、
  查政策、計算 merge／inverse、驗證父層及保存。`mutate` 自身也在取得鎖後查授權，不能沿用等待前的節點政策。
  不改不重疊文字三方合併、重疊文字的最後寫入與 BODY_CONFLICT／版本保留契約。
  這不代表 ActorCtx 的角色／token 快照已即時刷新，也不表示所有直接 SQL／外部 cascade 都已遷移。
- **普通編輯不能關閉標籤政策身分。** 比較普通 PATCH 加管理 gate 與禁止一般轉換後，選擇後者：
  普通 PATCH 將 class_tag 改成 content 回 422，包括管理員；一般標題／正文仍照原權限保存。
  不增加未使用的轉換 API。舊 NODE_UPDATED 的逆向操作若實際進出 class_tag，須 `principal_admin`，
  `force` 不能繞過，成功仍由既有復原流程增加 membership epoch；建立內容副本維持原契約。
- **確認只涵蓋觀察到的版本。** 同步空頁回傳輸入 since，非空頁回傳最後掃描事件；不能另外查 MAX 後
  確認沒掃描到的事件。outbox 的成功、重試、dead 都核對選取時的 xmin；舊結果不能改動新 payload 的
  狀態、重試次數或排程。版本不符保持 pending，由既有 drain 再執行；不新增 worker 平台。
- **交易後工作沿用既有機制。** 保存操作的冪等 wrapper 包住它自己的事件交易；dispatcher 啟動交由
  `afterCommit`，回滾不送出通知。當批另列更外層晚回滾的 GAP-06；後續第十二批已修正共用交易邊界，
  原批次的測試不能單獨當作這項修正的證據。

實際回歸、相容影響與手機 viewport 限制見 [核心修復紀錄](../archive/core-design-fixes-2026-09-13.md)。

## 第十一批：標籤同名與改名確認（2026-09-13）

- **同名是可修正的領域衝突。** 比較各入口捕捉 SQL 例外與共用標籤身分檢查後，選擇
  `tagHierarchy.assertTagNameAvailable(ws, id, { title, parentId })`：一般 node PATCH、tag PATCH
  與 agent dry-run 共用，真實 agent 寫入沿用 `nodeUpdate`。檢查在適用的授權之後，不能當作
  名稱預約；資料庫仍裁決競態。維持同 workspace／父層／live class_tag 的精確大小寫規則，
  不限制一般筆記，不自動改名，也不返回衝突節點的資訊。
- **共用 HTTP 邊界識別已知衝突。** `TagNameConflictError` 與精確的同名 unique constraint
  映射為 `409 tag_name_conflict`；其他 23505／未知儲存例外不能冒充同名。
  交易回滾後才回應。MCP 保留 scope、authority、rate-limit 和參數的既有專用回應，
  其餘向共用邊界傳遞；未知錯誤由原本帶內部 detail 的 `tool_error` 改為 `500 internal`。
  已有復原／匯入的明確衝突結果維持原契約，不在這批統改所有領域。
- **改名表單依確認關閉。** 比較把 UI 改成接住例外與沿用 writer 回報後返回結果，選擇
  `renameNode(id, title): Promise<boolean>`：true 表示伺服器或持久佇列已接受，false 保留表單。
  `useNodeLifecycle` 防止 Enter／blur 重複提交；只在目前仍是同一節點、同一份輸入時關閉。
  409 使用既有 rejected 分類與單次繁中提示，不進自動離線重試；離線接受仍只代表待同步。
- **標籤名稱是節點標題的顯示資料。** `storeOps.patchNode` 同步既有 tag.name；writer 的
  樂觀更新、伺服器調和與拒絕回滾都沿用它。schema pack 名稱保持獨立，不以整頁刷新掩蓋
  本次更新的漏項。這不代表所有 tag/schema 同步與離線投影都已完成盤點。

驗證與手機 viewport 限制見 [標籤同名修復紀錄](../archive/tag-name-conflict-fixes-2026-09-13.md)。

## 第十二批：外層回滾與請求冪等（2026-09-13）

- **冪等快取跟隨取得它的 SQL 單位。** 比較每次 claim 重查 DB／要求每個 caller 重設快取，
  與共用交易結果通知後，選擇既有 `txHooks` 承擔後者。claim 實際 INSERT 成功時登記
  `afterRollback`，使 root transaction 或任一包住它的 savepoint 失敗後失效；不再把任意
  callback 拋錯當成已經 SQL 回滾。失敗 child 不能清除它建立前就存在的 parent claim。
- **savepoint 成功不是提交。** `withTxHookScope` 的 callback 必須包含 SQL 完成與錯誤清理；
  child release 將成功與回滾 callbacks 一起交給 parent。root 確認 COMMIT 才發成功通知，
  失敗於清理嘗試後逆序執行本單位的失效通知，再往 caller 傳遞。這項機制由 `db.ts` 使用，
  領域仍只選 `withTransaction`／`withSavepoint`／`withEventTransaction`，不自行管理通知堆疊。
- **回滾通知只失效本機判斷。** COMMIT 回應遺失時，DB 可能已提交；將 cached claim 清掉後，
  同鍵重試仍由 INSERT／unique key 裁決，不推論可以重做。`afterRollback` 只供同步記憶體失效，
  不做補償 SQL 或外部副作用；callback 例外記錄後繼續，不覆蓋原始交易結果。
- **保存確認必須是實際 COMMIT。** PostgreSQL 若因先前被吞掉的 SQL 錯誤，使 COMMIT 回覆
  `ROLLBACK`，共用交易層拋錯並丟棄成功通知；不能返回保存成功。未知清理失敗保留原有
  connection eviction／AggregateError 行為，不把損壞 client 放回可用連線。
- **本批不改整個請求的原子範圍。** 同一請求循序操作沿用同一 claim，已提交的前一交易不因
  後一交易失敗失效；需要全有全無的複合操作仍須共用外層交易。共用 PG client 的 savepoint
  與同一 ambient request 的寫入仍須依序等待，不宣稱支援平行分支、手寫交易 SQL 或跨重載 writer。

GAP-06 的重現、領域入口與故障驗證見 [外層回滾與冪等修復](../archive/idempotency-rollback-fixes-2026-09-13.md)。

## 第十三批：同步回應的資料快照（2026-09-13）

- **一次回應的讀取共用快照。** 比較讀完後核對 epoch／event cursor 並整組重試，與資料庫
  `REPEATABLE READ READ ONLY` 後，選擇 `withReadSnapshot(() => ...)`。GET／POST sync、
  membership 單頁及 by-id projection 的角色政策、標籤關聯、事件、epoch、內容與任務查詢均用
  `q()`，不可穿插 `pool.query` 讀取較新的版本。傳入的 ActorCtx 仍是可信任入口先前取得的值。
- **快照不加入既有交易。** 沿用 `db.ts` 的同一連線、提交確認、回滾和失敗連線清理；
  `withReadSnapshot` 若已在任何交易內就拒絕，不能默默加入 READ COMMITTED 後宣稱快照一致，
  也不另取連線造成巢狀連線耗盡。snapshot 內各通道依序 await，領域 helper 不傳 client／isolation 旗標。
- **一致不等於取消已開始的讀取。** 撤權與正文更新若在快照之後提交，正在進行的回應可帶舊內容
  和舊 epoch；不可拿舊可讀集合送新內容。下一次請求重新核對，舊 `expected_epoch` 保留明確的
  `retry_required`，不能用空集合暗示全部撤權。事件游標仍只確認已掃描事件。
- **本批只保證單次回應中的資料庫讀取。** 不更換角色、祖先政策或 token ∩ human scope 語意；
  不把登入前取得的 ActorCtx 自動刷新，也不讓多頁 HTTP、bootstrap、SSE 或本機 mirror 共用交易。
  角色／scope 取值新鮮度、跨頁建立刪除與重連清除仍屬 GAP-04 的未完成部分。

交錯重現、允許／拒絕與剩餘範圍見 [同步快照修復](../archive/sync-snapshot-fixes-2026-09-13.md)。

## 第十四批：同步快照內的操作者授權（2026-09-13）

- **驗證身分與使用目前授權分開。** 比較各入口在 `withReadSnapshot` 內自行 reload actor／token，
  與共同操作後，選擇 `withActorReadSnapshot(authenticated, workspaceId, current => ...)`。
  只把可信任驗證情境的 actor ID／token ID 當身分線索；角色、名稱、類型、human scope 和 token
  allowlist 在第一個快照查詢重新取得。呼叫者必須使用 callback 的 current，不能再讀較早的 ActorCtx。
- **核對必須保持憑證歸屬。** actor 須仍在要求的 workspace；有 token 時須仍屬於該 actor、
  未刪除／撤銷／到期。缺失或不符沿用 `UnauthorizedError` → 401；未知 DB 錯誤向上傳成 500，
  不降成 anonymous，也不退回快取權限。原來的角色政策與 token ∩ human scope 仍由 readPolicy 決定。
- **快照先後是保證的界線。** 降權、縮 scope 或 token 撤銷在身分核對前提交，本次就套用；
  之後提交，正在進行的回應仍可使用同一快照的舊授權和舊內容，下一請求重讀。
  角色提升、scope 放寬同樣讀目前值，不將舊的較低權限永久保留。沒有宣稱取消所有進行中的請求。
- **本批完整範圍是同步讀取。** GET／POST sync、membership、by-id、空 ids 及 known 超限回應
  都走此邊界。既有 native 快取可用來辨識 ID，不能再決定這些回應的 role／scope；正式 bearer
  仍只可進 MCP。沒有重做 cookie 驗證、actor 自動建立、bootstrap、一般讀取、寫入或 cascade 的身分刷新。
- **測試分清控制的邊界。** 原有 mini-router 測試繼續注入 ActorCtx，透過測試專用 helper 保留
  真實 SQL 快照與政策查詢；不把這些案例當作 actor／token 查表的證據。
  `actorSnapshot.integration.test.ts` 用真實 actor、token、actor PATCH 和完整 app 解析路徑驗證刷新，
  僅控制登入票據辨識與交錯排程；正式程式不能引用測試 helper 或以缺少 fixture 為由略過查表。

驗證及仍未收尾的 GAP-04 範圍見 [操作者快照修復](../archive/actor-snapshot-fixes-2026-09-13.md)。

## 第十五批：membership 分頁、補資料與事件交接（2026-09-13）

- **跨請求核對版本，不保留伺服器讀取 session。** 比較長時間持有交易／exported snapshot 與版本核對，
  選擇每頁及 by-id 回傳同一資料庫快照中的 `epoch`＋`event_cursor`，後續請求帶 expected 值。
  前者需要連線、到期與清理契約；目前以有界重試處理漂移即可。epoch 涵蓋政策集合，event position
  補上有領域事件的建立、刪除與內容變更；未遵循事件交易的直接 SQL 不在這項保證內。
- **補資料也屬於核對操作。** `reconcileMembership` 擁有分頁、每 1,000 個 ID 的補資料、版本檢查，
  以及套用後的最後核對。呼叫者只提供 HTTP、完整投影套用與本機保存；不能自行省略某一 channel。
  超過 by-id 原有 50,000 個 ID 上限明確回 413，不再靜默截斷。新前端缺少版本時停止核對，
  分開更新時先更新後端；舊前端只享有原有契約，不能宣稱混版也有完整跨頁保證。
- **部分套用不等於已核對。** 先隔離撤權，再套用各批；重試從當下本機集合重新計算，所有批次與最後
  核對成功才保存 epoch。中途例外或持續變動保留 gate，不回報完成。每次嘗試開始時取得 local IDs，
  避免把該次分頁期間才在本機建立的 ID 當成撤權；既有未提交草稿／佇列與跨嘗試的完整協調仍待盤。
- **membership 的事件位置只供交接。** `done.eventCursor` 表示同步還須實際讀過哪些事件，不能直接
  寫入 `last_event_id`。sync 沿原 since 繼續讀 delta，讀到該位置才解除 gate；補資料沿用已確認游標。
  本批不更改 bootstrap、事件游標 bigint 的既有 number 表示、cookie 驗證或真機離線保存契約。

實際重現、前後端整合與瀏覽器範圍見 [membership 跨請求修復](../archive/membership-pages-fixes-2026-09-13.md)。

## 第十七批：既有筆記的待同步文字與遠端載入（2026-09-13）

- **遠端載入回傳實際套用的投影。** 比較每個畫面在 GET 後自行查 queue、重套文字，與由現有
  SQLite 接收操作統一調和後，選後者。`persistBootstrap`、`applySync`、`persistRemoteNode`
  在同一 worker 工作序列中讀目前 pending，保存調和後的快取並回傳該投影；畫面使用回傳值。
  不把「快取接受」宣稱為新寫入已持久化，原 pending 請求才是已確認的本機輸入。
  `loadBootstrap` 也從 durable queue 投影文字，涵蓋請求已保存但樂觀快取尚未寫完的離線冷啟動。
- **只在仍可讀的節點上投影待送文字。** `pendingNoteProjection` 擁有既有 node PATCH 的
  title／markdown 解讀，依 queue 順序取最後值，空字串是有效編輯；base_markdown 不是待送正文。
  不因請求參照某 ID 就保留已撤權副本，也不把整份本機節點蓋回遠端的政策、父層與其他資料。
  slim bootstrap 只沿用明確 POST `/api/nodes` 建立 ID 的既有暫存例外，移除任意文字包含 ID 的保護。
- **這不是通用離線重播器。** 不解讀每個領域的內部格式；屬性、任務、標籤成員的樂觀投影，
  pending 建立在 full bootstrap／membership 的存續，與未入列草稿另批處理。
  這次核對的是套用時仍 pending 的請求；跨遠端讀取的已提交新編輯、跨分頁副本與完整備份置換另驗。
- **待送文字蓋過的筆記，由本機副本記著，送完再讀一次（2026-11-18）。** 每次保存現在都先是佇列的一列（[送出前先記下](../architecture/note-writes.md#送出前先記下2026-11-18)），
  所以 bootstrap、delta、單筆讀取常常遇到「這則筆記還有待送的文字」：照第十七批的規則把待送文字蓋在伺服器較新的那一列上，
  游標同時越過伺服器那一版。送出那筆寫入的常常是**另一個**分頁（或重開之前的那一頁），只靠這一頁記憶體裡的
  頁面記憶體裡的集合不夠：這一頁、它的快照、從快照打開的頁面，都會一直顯示舊字。所以副本自己記
  （`localDbWorker` 的 `noteHeldText`，`sync_state.held_text`，跟著快照走）：投影蓋過伺服器的筆記加進去，
  伺服器那一列真的存進來就拿掉；`syncEngine.releaseHeldNotes` 每輪把「已經沒有待送寫入」的那些（`heldNotesNowSent`）
  併進同一個集合（`serverTruthLoad.readAgain`），`hydrateNode` 一次。單筆讀取被副本拒收時，副本也把那則筆記記進同一份清單
  （#1794 併入 main 之後收成一條：頁面一個集合、副本一份清單）。delta 的 `applied.heldText` 仍餵頁面的集合（沒有本機副本的裝置靠它）。

- **伺服器副本不蓋掉還沒有回應的欄位（2026-11-19，擁有者回報：剛打的字消失又回來、游標跑到它們前面）。**
  一份同步回應或 `GET /api/nodes/:id` 可能是在這台的存檔送到伺服器之前讀的。在確認過的存檔之前讀的回應，頁面的入口
  依位置整份不收（`writePositions.takeAnswer`，見下方「晚到的回應」；#1794 併入後取代原本的時間規則 `lib/rowAge.ts`）；
  還沒有回應的存檔沒有位置可比，所以剩下的一條放在 `storeOps.serverCopyOver`，
  同步回應（`applySyncDelta`）、整份 bootstrap（`syncEngine.setWholeBootstrap`；沒有本機副本的裝置每一回合都是它，沒有佇列的投影）
  與單筆讀取（`serverTruth.readNoteFromServer`）都走它：這台有一筆還沒有回應的編輯的欄位
  （`optimisticFields`）保留手上的值，列也保留手上的時間；被保留過的筆記等那筆編輯有了回應（`whenAnswered`）
  再讀一次（`syncEngine.readAgainWhenAnswered`，與排在佇列後面的筆記同一條 `releaseHeldNotes`），所以別人的較新文字仍會到。
  編輯器的邊界（`draftActions.applyRemoteNode`）：已被接受的存檔，它的回應標頭一到，頁面就不再收在它之前讀的回應（位置，不是伺服器時間），
  所以比它舊的列到不了草稿（`typedTextNeverReplacedByOlder` 的「編輯器自己的防線」那一則經頁面的入口送進來）；
  輸入法正在組字時，外來文字不進草稿，組字結束（`setEditorComposing`）時再交給同一條路。`MarkdownEditor` 的外來文字同步在組字中不動文件，
  組字結束（compositionend）時用同一個區段替換套用，不用計時器。測試：`test/typedTextNeverReplacedByOlder.test.tsx`（真編輯器、隨機順序）、
  `saveTiming.property.test.ts` 的 2026-11-19 案例、`offlineBodyHydrate.test.ts`。
  時間規則已刪，伺服器時鐘倒退不再影響（`saveTiming` 的時鐘案例照舊通過）。
  已知限制（之後的小 PR 收進門）：區塊的復原與建立（`blockChildWriter`）用沒有經過門的 GET／POST 回答直接換掉 `markdown`，
  而且和筆記的存檔不在同一條寫入通道，那一趟來回裡打字存檔，舊字可能進 store 再進草稿，直到之後的 `refresh()`；
  還原版本（`noteHistoryWriter`）也是沒有經過門的 GET（有值的對照、握著同一條通道，較安全）。守門 `answerDoor.guard`
  只認四個函式名，看不到直接的 `setData`。
  `saveTiming` 的 seed 222、3333 與 #1866（改名後立刻重新整理又遇到 503）在 #1794 之後通過，但當時只證明模擬的重新整理：
  它（`saveTiming` 的 `reload()`）只清草稿，記憶體裡的 store、還沒有回應的欄位、頁面的水位與日誌都留著，所以擋住的是
  `serverCopyOver`。真的重新整理時這些都不在了，靠的是佇列的列蓋在回答上（佇列的投影；`saveSurvivesKill` 測關掉頁面後的存檔）。
  2026-11-19 起 `reload()` 是真的重新整理（重新載入模組，舊頁面的回答沒人收；[note-writes.md](../architecture/note-writes.md#沒有被收下的文字不算數2026-11-19)），
  這三則照樣通過，所以現在證明的是佇列的投影這一條。
- **沒有被收下的文字不算數（2026-11-19）。** 重新整理後的第一次畫面是本機副本加上佇列的投影，編輯器的 base 就可能是一段伺服器
  還沒收下、之後又拒絕的文字。被拒的文字不成為 base（`writeRecovery.withoutRefusedBase`，`writeQueue` 送出的兩處都經過它）；
  救回副本只依伺服器回答的內文丟掉；上一頁沒排進佇列的存檔在 `runBoot` 顯示本機副本之前先排進去（`writeQueue.takeInLeftWrites`）。
  規則、案例與不保證的，見 [note-writes.md](../architecture/note-writes.md#沒有被收下的文字不算數2026-11-19)。

- **門對每一種列都用同一條規則（2026-11-20）。** 上一條只查筆記列自己那本帳（`node:<id>`）；屬性、任務、標籤套用、首頁各自有帳，
  門卻不看，所以「等回應中」時同步回答、整份 bootstrap、`?nodes=none` 的更新會用伺服器的舊副本蓋掉手上的值：連改兩次屬性、
  勾任務、加標籤，畫面回到第一次的值（`gateHoldsEveryUnansweredEdit.test.ts` 在修改前 21 則全紅）。現在只有一條規則、一個地方：
  `storeOps.keepUnanswered(帳, 伺服器那一列, 手上那一列)`——**任何一種列，有還在等回應的欄位就保留手上的值**。
  帳本名：筆記列 `node:<id>`、屬性 `attribute:<筆記>`、標籤套用 `membership:<筆記>`（每個標籤一個欄位，值是在分類標籤或一般標籤裡，
  這一批從 `membership:<筆記>:<標籤>` 改成每則筆記一本）、任務 `task:<id>`、首頁與外框 `workspace:<id>`、網站設定 `workspace:<id>:config`、
  標籤清單裡的一個標籤 `node:<標籤>`、圖譜上手動放的位置 `position:<筆記>`。`tagWriter.setHidden` 與 `graphPositionWriter` 這一批才開始記帳。
  入口：`serverCopyOver`（筆記列、它的屬性與標籤）、`syncDeltaOver`（`applySyncDelta` 是它的 `.state`）、`wholeBootstrapOver`、
  `sharedRowsOver`（首頁、網站設定、標籤清單、圖譜位置；`syncEngine.mergeBootstrapMeta` 用它）。
  保留之後再讀一次，所以別台較新的值仍然會到（`syncEngine.showServerCopy`）：筆記那三本帳都有回應後讀那則筆記（`readAgainWhenAnswered`，
  `GET /api/nodes/:id` 帶著屬性與標籤）；首頁、網站設定、標籤清單、圖譜位置在那筆有回應後做一次 `?nodes=none` 更新；
  任務沒有帶位置的單筆讀取，所以做一次整份 bootstrap（`refresh()`，罕見：要在任務的修改等回應時剛好收到帶著舊值的回答）。
  守門 `everyJournalAtTheDoor.guard`：`lib/` 裡每個 `optimisticFields(` 的帳都要出現在 `storeOps` 的程式裡，否則列進例外並寫原因
  （目前只有白板布局 `canvas:`，它由 `refreshOpenCanvas` 讀回，不經過門）。
  **還沒做（第二步、第三步）**：寫入一變成「已排隊」帳就清掉（`writeLifecycle` 的 `accepted` 對排隊結果也呼叫，各 writer `settle(true)`），
  排隊中的搬移、排序、刪除、屬性在整包 bootstrap 後會退回舊值；`/api/tags`、檢視、檢視查詢、屬性、空間、RSS 的 GET 沒有位置（要後端）。

實測與入口限制見 [待同步文字驗證](../archive/pending-note-text-fixes-2026-09-13.md)。API 完全不可達
時的 LoginGate 冷啟動仍阻擋編輯器，登錄 GAP-20；不能以快取存在取代登入／換帳號隔離的契約。

## 第四十一批：同步存活、離線副本與版本提示（2026-10-24）

來源：同步與離線審查（分支 `review/2026-10-24-sync-offline` 的 `docs/archive/research/review-2026-10-24/sync-offline.md`）的 #5–#8、#10、#13–#20。

- **回到前景、網路恢復、斷線時輪詢都補拉。** 主要同步註冊 `onVisible`、`onOnline`、`pollMs: 60_000`；
  SSE 每 25 秒送 `data:` 心跳（`EventSource` 看不到 `:` 註解），前端 60 秒沒收到任何框就關掉重連。
  心跳 `{"kind":"heartbeat"}` 不算 tick，不帶內容，不改「只有盲 tick」的契約。
- **標籤不改 `membership_epoch`。** 標籤不帶權限（`readPolicy.ts`）；094 已拔掉 `node_tags` 觸發器，但 `schema.sql` 沒重生，
  新資料庫仍有它。130 再拔一次（既有資料庫不受影響）並更正 `schema.sql`。用戶端的 gate 只在「第一次核對、有被拒絕的重放」
  或 digest 顯示本機集合不同時才先升起；核對中途失敗或重啟用盡仍升起。**代價**：epoch 變動但 digest 相同時，
  不再為那一次往返遮住畫面（撤權一定使 digest 不同，會先升起再刪）。
- **核對頁間只釘 epoch。** 事件位置（`event_cursor`）仍回傳，`done.eventCursor` 是第一次讀取時的位置，sync 從該處起讀事件。
  分頁期間的新增／刪除不再讓核對重啟；刪除由接著的事件 delta 套用。後端 `expected_event_cursor` 仍接受（舊前端）。
- **本機副本三種狀態**（`lib/localCopyState.ts`）：`ok`、`restarting`（worker 逾時 60 秒或出錯，已終止，下一次呼叫重建並重播快照與 journal）、
  `none`（打不開：只用伺服器資料，直送寫入，`getPendingWrites()` 為空，`sync()` 即完整 bootstrap）。介面各一句白話，不阻擋儲存。
  `none` 時離線不會有佇列：直送失敗就失敗，輸入留在畫面（沿用 `WriteStorageError` 路徑）。重新載入頁面才會再試打開。
- **伺服器時間與頭位置。** bootstrap 帶 `server_time`（讀取交易的開始時間），白板鏡像修剪只用它；沒有就不修剪。
  delta 帶 `head_event_id`，游標超過它就重設為它並做完整 bootstrap，且重做冷啟動核對。
- **版本提示。** 後端有 `ONDEN_BUILD_ID` 才送 `X-Onden-Build`；前端與之不同顯示「有新版，重新載入」，重用 `setBeforeChunkReload`。
  部署須讓 backend 與 frontend 拿到同一個 `ONDEN_BUILD_ID`（`compose.yaml` 已傳）；只部署一邊會讓兩邊不同，
  使用者按過一次後同一個伺服器版本不再提示（`sessionStorage`）。
- **`fallbackData` 換成 `noWorkspaceData`**：`workspace.id` 為空、viewer、非擁有者、不能審核；`workspace.id === ""` 判斷。
- **`blocks` 通道移除**（delta、bootstrap、`/sync/nodes`）：前端不用，`features.block_nodes` 保留給舊 shell。
- **本機鏡像版本**：`sync_state.mirror_schema_version`（`MIRROR_SCHEMA_VERSION`）；改變時清掉 `full_refresh_at`，下次開啟做完整 bootstrap。
  改本機欄位語意時要加一。版本 2（migration 194 把釘選 id 改成由「上層、目標」算出）：舊副本裡的釘選 id 伺服器已不認得，
  所有副本都重新讀一次，不另外保留舊 id 的對照。
- **同一行並行輸入（F03／F04）**：`bodyMerge.ts` 的衝突區塊先再試一次字元層級（`mergeChars`）：兩邊都只「加字」
  （沒刪／改任何字元）時兩份都留，同一點的兩段依文字的 code unit 順序排，與先後存檔無關（重播與另一分頁合併結果相同）。
  任一邊刪或改了字元仍是衝突：保留較晚存檔、`BODY_CONFLICT` 帶回被蓋掉的字，不把兩份改寫拼成誰都沒寫的文字。
  版本列表（`GET /:id/versions`）把贏得衝突的存檔當成新 session 的起點，被蓋掉的內文即使同一帳號也是獨立一列；
  輸掉的那個分頁收到「另一邊同時改了同一段文字」提示（`useBodyConflictNotice`）。
- **同一點的兩個獨立段落（2026-11-13）**：`bodyMerge.ts` 的 `mergeInsertions`。兩邊在同一點各加一個**獨立段落**
  （前後都是空行或筆記邊緣，且至少有一個真的空行），合併把兩段隔一個空行（用筆記原本的換行；順序仍是文字的 code unit 順序，與誰先存無關）。
  接在清單項目／段落後面、沒有空行的行照舊相連（那是同一個清單或段落的延續）；空筆記裡兩邊各寫一整份內文也照舊相連（沒有任何東西說它們是段落）。
  共同開頭／結尾不會把圍欄式程式碼區塊切成兩半，但只在兩邊的中段都不為空時才退；一邊包含另一邊（例如一邊把程式碼區塊多打了一行）時取較長者整份。
  退的計算是線性的（共同結尾只讀共同行本身，沒關的圍欄最多試 64 行）。已知限制：新增的程式碼區塊緊鄰另一個程式碼區塊時，
  行 diff 可能把鄰居的圍欄當成新區塊的圍欄，兩邊的程式碼落進同一個圍欄（內容不丟）。
  **這條會改變 `distributedSync/materialize` 重算出的內文**（每個副本自己呼叫 `threeWayMergeBody`）。分散式同步目前關著，所以現在可以改；
  **開啟之後再改這類合併規則必須跟協定版本走**（見提案第 4 節）。這個 PR 沒有加版本常數。
  **同一行字元層級的合併規則沒有動**（兩邊只加字就兩份都留，含貼在同一個字上的加字）；是否收緊見
  [提案](../architecture/proposals/body-merge-same-line-2026-11-13.md)，合併規則等於同步協定的一部分，須業主與同步工作階段看過才實作。
- **搬動的段落（2026-11-15，合併規則版本 2）**：寫入、復原與同步重算現在呼叫 `eventLog/bodyMergeMoves.ts` 的 `mergeBody`，不再直接呼叫行級的 `threeWayMergeBody`
  （它仍是主角，也是 `mergeBody` 的第一步）。兩件事：
  ① 行級合併判衝突、且每個衝突區都由「某一邊逐字搬動的單位」解釋得了時，才把三份文字切成段落／清單項目等單位逐個合併（逐字相同的單位被搬動、另一邊改它，兩邊都留）；
  補救結果必須是乾淨的，且通過 `mergeLossProblems` 的行數檢查（重複、掉字、憑空多出的行），否則仍是行級的衝突。兩邊改同一句仍交給 `threeWayMergeBody`，仍是衝突。
  沒有搬動的衝突不補救：兩邊把短段落改寫成不同的字，單位認不出是同一段，會兩份改寫都留（`coreConsistency.integration.test.ts` 抓到）。
  ② 行級合併說乾淨、但兩邊都搬了逐字相同的單位時，若同一段被搬到不同地方（或拼出兩邊都沒寫過的順序），或行級的結果有重複／掉字，改判衝突：
  合併後的內文留 incoming 整份，`BODY_CONFLICT` 帶 current 整份（`before`／`after` 為空），與其他衝突一樣把沒留下的一邊交還；復原遇到它照舊要 `force` 才覆蓋。
  一邊刪、另一邊搬同一個單位時不套用 ②（順序判斷會隨誰是 incoming 而不同，不屬於這條規則）。
  **合併規則版本**：`BODY_MERGE_RULE_VERSION`（`distributedSync/types.ts`）= 2（行級合併 = 1）。改變 `mergeBody` 回傳的內文就要加一，並依
  [節點同步提案](../architecture/proposals/node-sync-channels-2026-11-14.md)第 12 項讓同步協定的版本閘門讀它；目前只有常數與測試，閘門本身還沒有（同步關著）。
  數字與限制：[量測報告](../research/body-merge-measurements-2026-11-15.md)。
- **合併規則版本 3（2026-11-19）：合併出來的每一行都有人寫過，沒有一行出現兩次。** `BODY_MERGE_RULE_VERSION` = 3（數字定在 `bodyMerge.ts` 的 `CURRENT_BODY_MERGE_RULE`，同步這邊只讀它）；`mergeBody(base, incoming, current, rule)` 的
  `rule` 預設是目前版本，傳 1 或 2 得到當時的結果（`threeWayMergeBody(…, rule)` 同樣只在 3 改變），歷史上的合併可以重算。三件事：
  ① 行級合併的衝突區兩邊都改時，不再把整區當成一串字逐字比對（那會把舊行的字對到另一邊新寫的行，一邊改的字落進另一邊的新段落）。
  `bodyMerge.ts` 的 `mergeLineByLine`：相同的行照行 diff 配對，其餘每一行舊的配上每一邊唯一一行「只加了字」的行；配好之後逐行合（兩邊都改的那一行照 F03 逐字合，同一點各加的行照 `mergeInsertions`）。
  一邊在行中間按了 Enter（拆行）時，那一行舊的配上它被拆成的幾行（`mergeSplitLine`）：每一片都要帶著那一行至少兩個字母／數字／漢字、而且不是另一行舊的（只靠一個「。」或空白不算一片：那正是一邊的字落進另一邊新行的起因），
  從前面讀與從後面讀兩種讀法合出來的文字一樣才採用。配不起來（刪、改寫、拆出只剩標點的一片）或配法不只一種就是衝突。
  ② 行級合併的結果（乾淨或衝突）有一行比三份文字的任何一份都多時（`bodyMergeLoss.ts` 的 `heldTwice`；衝突時兩種先後都看，結果不隨誰是 incoming 而變），
  先試段落層級的合併，否則整份判衝突（內文留 incoming、`BODY_CONFLICT` 帶 current 整份）。這是「一邊搬動、另一邊改原位置，那行出現兩次」（舊的性質測試 4b）在產品入口的修正。
  ③ 段落層級的補救：衝突區由「某一邊把那些段落搬出去」解釋得了時也試（`relocatedOutOf`，跟行 diff 的讀法一致）；補救結果兩種先後要得到同一份文字才採用；
  同一點兩邊各加一串段落時，後面接的空行取兩串中較寬的（以前取 incoming 的，交換寫作者會把段落黏到後面的清單）。
  性質（每次新種子）：`bodyMergeProvenance.property.test.ts`（後端 `src/test/properties/`）；量測：`docs/research/eg-walker-bench/bench/src/paraId/runRules.ts`，數字在[規則 3 的量測](../research/body-merge-rule3-2026-11-19.md)。
  已知未修：同一行兩邊只加字、加字位置有歧義時，一邊的字可能被另一邊的字從中間切開（`bodyMergeMoves.test.ts` 的 `it.fails`）。業主 2026-11-22 決定：維持現狀（選項 A，同一行兩邊只加字就都留），歧義時不改判衝突；一邊在行中間按 Enter、拆出只剩「。」或一個字的一片、另一邊同時改那一行時判衝突（隨機情境約 1.3%），接受。

## 重新載入閘（2026-10-26）

- **問題**：「有新版，重新載入」與 stale chunk 自動重新載入共用 `prepareEditorForExit`（登出用）。它會把伺服器已拒絕、
  已在復原面板的同一份文字再送一次，也要求 `flushLocalDbSync` 成功（`none` 的裝置永遠失敗），失敗一律顯示同一句。
- **重新載入問的是「有沒有文字只存在記憶體」**：`prepareEditorForReload`（`drafts.prepareReload`）回傳 `ReloadGate`：
  `safe`（含 `recovered` 標題）、`memory-only`（筆記標題＋可複製文字）、`local-queue`（本機副本不回應且佇列有待送）、`typing`。
  已拒絕的文字不再重送；由 `writeRecovery.recoveryHolding` 確認復原面板有「完全相同的文字」且重新載入後仍在
  （SQLite 拒絕列，或瀏覽器儲存裡真的讀得到的項目；只在記憶體的備份不算）。沒有才擋。
- **本機副本 `none`／`restarting`**：沒有佇列可失去，`flushLocalDbSync` 失敗只在 `getPendingCount() > 0` 時才擋。
- **復原文字的告知**：重新載入後頁面立刻消失，所以句子存在 `sessionStorage`（`onden.reloadNotice`），載入後由 `DeviceNotices` 顯示一次。
- **登出不變**：`prepareEditorForExit` 仍重送被拒絕的文字並要求本機快照寫入成功。
- 診斷：被擋時 `console.warn("[reload] blocked: …")`，帶筆記 id（只在 console）。
- PDF／手寫：文字編輯器在這兩種表面不掛載，筆跡走 `saveInk`（背景寫入，不進 `activeSaves`、不弄髒草稿）；
  沒有找到會讓草稿在沒打字時變 dirty 的路徑（見測試 `reloadGate.test.tsx` 最後一項）。

## 設定跟著帳號：RSS（帳號偏好）

> 收工（`journalShutdown`、`journalShutdowns`）已於 2026-11-06 退役：後端不再有這兩個 key，migration 178 刪掉既有的列；
> 舊版頁面仍送的寫入回成功但不存（`actorPrefs.ts` 的 `RETIRED_PREF_KEYS`），讀取當作沒有。
> 臨時工作階段讀的是開啟它的人的偏好（`readPref` 問 `personalDataOwnerId`），但內含筆記、標籤、訂閱源或文章 id 的 key 對它讀成「沒設過」
> （`SESSION_MAY_READ_PREF`：每個 key 都要表態，新增 key 時型別會逼人決定）；寫入仍然被拒。

- **四個原本存在本機、現在跟著帳號的偏好**：RSS「顯示未讀數字」（`rssShowCounts`）、每個訂閱的數字開關（`rssFeedCounts`）、
  閱讀位置（`rssReadingPosition`）、上次打開閱讀的時間（`rssLastVisit`）。
  共用 `lib/accountPrefStore.ts` 的 `createAccountPref`（`syncedPrefStore` 加 serverKey、本機副本 `…Copy`、parser、搬遷）；
  後端 key 與形狀在 `services/actorPrefs.ts`（map 最多 500／50 筆、字串長度有限、形狀不對 400）。
- **搬遷**：舊本機值在第一次同步成功後才處理——伺服器沒有值才送上去一次，有值就用伺服器的（上次打開閱讀的時間改比「較新」：
  `isNewer`，相等不算較新）；之後舊 key 刪除（`PREFS` 標 Retired，仍留著讓搬遷讀得到）。同步前頁面先顯示舊值，離線也能用。
- **「較新」**：`rssLastVisit` 儲存時若伺服器的比較新就保留伺服器的，舊裝置不會把時間往回寫。
  其餘是 `syncedPrefStore` 的「最後一次編輯為準」，整張表一起取代（不逐筆合併）。
- **閱讀位置節流**：本機立刻更新（`store.stage`，標 dirty），安靜 2 秒後或頁面隱藏／離開（`visibilitychange`、`pagehide`）才送伺服器；
  只留最近 50 個 view。
- **設定頁**：`ValueSettingFields.subscribe` 讓有自己 `get`／`set` 的帳號設定在另一台裝置的值同步進來後更新；
  模組頁的範圍說明改成「有些是你的、有些是工作區共用」。`accountPrefs.test.tsx` 守門：account／workspace 分頁裡的 value setting 必須自己有 `get`／`set`。

## 第 43 批：打開先能用，背景再整理（2026-10-30）

來源：手機冷開／熱開量測（[perf-open-first-2026-10-30](../archive/research/perf-open-first-2026-10-30/README.md)）。業主要求「每天打開到能打字」的時間。

- **冷開先畫、再寫鏡像。** `paintThenPersist` 先讀佇列、畫面送出後才把 bootstrap 交給 worker。原本佇列讀取排在整份寫入之後，
  worker 一次只答一個請求，所以「先畫」實際上等了整份寫入（20k 筆記手機約 2 秒）。試過再加「等一個 frame、等 worker 安靜 1 秒」，
  量不出比單純換順序更好（誤差內），還讓 `multiTab.property.test.ts` 釘住的 KNOWN 重現序列（對開機時間差很敏感）失效，所以沒留。
- **剛由伺服器填滿的鏡像，第一次核對不先升起 gate。** 沒有本機副本、整份 bootstrap（伺服器依讀取政策過濾）剛落地時，內容不可能比伺服器剛給的更舊，
  所以 `maybeReconcileMembership` 不再先遮住畫面（`mirrorFilledThisSession`）；核對照跑，digest 顯示集合不同、核對失敗或重試時仍升起（fail-closed）。
  有本機副本的重開不變：仍先升起，核對完才放下。
- **沒有改成「先顯示本機內容、核對在背景」。** 有快取的重開要顯示的是可能已被撤權的內容，前面第十五、四十一批決定的 fail-closed 就是為了不露出；
  要改就是改這個決定，不是效能調整。改做的是縮短 gate：離線內文下載改在開機核對之後才開始（同一個 worker 一次只答一個請求，
  下載的請求排在核對前面）、本機副本的邊／任務／屬性分頁讀取（`loadLocalRest`）改在核對之後（重開時每次合併都重畫整個 store）。
- 沒做：`persistBootstrap` 仍回傳整份 bootstrap（主執行緒反序列化），bootstrap 欄位格式與 API 不動；`localDbWorker` 沒有增加位元組（預算只剩 238 B）。


## 同層排序鍵（2026-11-14，migration 200；上線前格式第 5 項）

設計與撞鍵規則見 [distributed-ready 4.7](../architecture/proposals/distributed-ready-2026-11-12.md)；這裡記取捨：

- **公共介面**：前端 `planSiblingOrder` 算「搬動後哪幾列要新鍵」，PATCH 帶 `order_key`；後端 `services/orderKeys.ts` 是唯一寫入入口，
  `orderKeyWriters.guard.test.ts` 擋新的寫入者。比較過兩種草圖：A 客戶端算鍵（選）、B 客戶端只說「放在誰後面」由伺服器算鍵（沒選：離線時客戶端仍要自己算鍵才能顯示）。
- **舊整數的處理**：伺服器收下 `sort_order` 並翻成鍵（`translateLegacySortOrder`），**同時**把 `CLIENT_PROTOCOL` 升到 4。兩者不是二選一：
  升版保證舊頁面不能再把整數寫進新格式的資料、不能讀沒有整數的同步內容；翻譯讓升版前排在佇列裡的搬動重載後還能送出，不丟使用者的動作。
- **新筆記放同層最後**（以前預設整數 0）。客戶端暫存列沒有鍵，排在最後，等於伺服器的結果。這是唯一刻意的行為對齊。
- **`sort_order` 欄位留一版**，不再讀寫（新列為 NULL），回退走「還原升級前備份＋切回舊映像」。
- **備份**：封存版本 2 → 3；版本 2 的封存還原時依舊整數順序（再依建立時間、id）一則一則放在同層最後；新封存帶 `order_key`。
- **瀏覽器副本**（sql.js）：`MIRROR_SCHEMA_VERSION` 3；舊副本第一次開啟時依舊規則補佔位鍵，隨後整份 bootstrap 換成伺服器的鍵。

## 連不到伺服器＝離線；只有明確拒絕才 fail-closed（業主 2026-11-15，「統一」）

- **規則**：連不到伺服器（網路錯誤、逾時、閘道 502／503／504 且沒有伺服器自己的錯誤碼）一律當離線：不升成員資格遮罩、照常讀寫本機副本（寫入進佇列）、標示離線，稍後照 `connectivity.ts` 的 5 秒節奏再試。伺服器有回答（401／403、`accessRevoked`、成員資格版本一直變而核對沒收斂、其他非閘道的錯誤）則維持 fail-closed。
- **單一判斷**：`writeErrors.isServerUnreachable` → `sync()` 的 `SyncResult.unreachable` → `syncEngine.serverNotReached`。開機（`runBoot`）與恢復連線（`reconnect`）都問這一個；離線的動作（`stayOffline`：標離線＋降遮罩）也是同一個。不另寫第二份。
- **不放鬆**：沒有本機副本（`getLocalCopyState() === "none"`）的裝置連不到時仍停在遮罩後；`accessRevoked` 先判斷、不當離線；伺服器有回答時的檢查一字未動。
- **現況**：重新核對的路徑——`reconnect()`（瀏覽器 `online`、伺服器更新後的 `protocolGate`、連不到後的重試）改用這條規則。SSE 成員資格通知（`membershipChanged`／`sync()` 的 `syncDirty` 重跑）是伺服器剛說過成員資格變了，連不到時維持遮罩（明確訊號，不是「連不到」）。
- 測試：`src/test/properties/connectionLiveness.property.test.ts`（隨機序列含「恢復網路但伺服器不通」、開機與恢復連線參數化對照）、`src/test/serverUnreachable.test.ts`。

## 晚到的回應不蓋掉已確認的保存：事件位置與水位（2026-11-16，取代 #1753 的 `updated_at` 規則；#1794 審查後定案）

- **原因**：一個在保存之前送出的同步請求，回應在保存確認之後才到，帶的是保存之前的資料，整份套用就把剛存好的蓋回去（記憶體與本機副本都是）。時間不是可靠的先後（伺服器時鐘會往回調）。
- **伺服器**：`db.ts insertEvent` 在事件鎖下記下這筆 `domain_events.id`，提交之後才算數（`spine/eventPosition.ts`，`afterCommit`）；`eventPositionHeader.ts` 一個中介層把「這個請求最後提交的事件」放進 `X-Onden-Event-Position`。拒絕、沒有事件的寫入、回滾都沒有這個標頭；重送（同一個冪等鍵）回**原本的**位置（migration 212：`idempotency_keys.event_position`，與 claim 同一個交易寫入）。同步回應與 bootstrap 帶 `server_id`：由這台的節點 id 導出的值（`spine/stamps.ts serverIdentityField`，加固定用途字串取 SHA-256），不是節點 id 本身（節點 id 與標記不出現在任何給用戶端的回答裡，`syncStamps.integration`）；還原或 rebase 換了節點 id，它就跟著換，用戶端丟掉所有位置。單筆讀取 `GET /api/nodes/:id` 帶 `X-Onden-Read-Head`（讀列之前的 `MAX(id)`）。修剪事件（`pruneEvents`）不刪工作區最大的那一筆，`MAX(id)` 不會往下掉。`CLIENT_PROTOCOL` 升到 5：不說位置的伺服器與新頁面互相擋住，不會無聲沒有保護。
- **為什麼可比**：事件鎖涵蓋配號與提交，同一工作區 id 的順序＝提交順序；回應在一個 REPEATABLE READ 快照裡讀 `MAX(id)` 與所有列，所以 head ≥ P ⇔ 回應包含寫入 P 動到的每一列（衍生的也算）。一份回應不是在寫入之後、就是不是：**不需要推算寫入動到哪些列**。
- **規則**（`lib/answerPositions.ts isCurrentAnswer`）：每個伺服器身分一個**水位**＝這台裝置知道的最高位置（確認過的寫入、套用過的回應的 head）。任何帶列的回應（delta、成員資格頁、整份／slim／`?nodes=none` 的 bootstrap、單筆讀取）head 低於水位就**整份不套用**，再問一次。
- **兩個地方、一個函式**：本機副本（`localDbWorker` 的 `judgeAnswer`：applySync、persistBootstrap；水位在 `sync_state`，寫進日誌，其他分頁套用回應前先讀進來）與頁面（`lib/data/writePositions.ts takeAnswer`：標頭一到就提高頁面的水位，副本忙的那個空窗由它擋；副本收了而頁面不收時，副本的游標退回去）。守門 `src/test/guards/answerDoor.guard.test.ts`：把伺服器的列交給副本或 store 的呼叫只出現在 takeAnswer 的回呼裡。
- **活性**：連續 3 次不收後，下一筆寫入等到有一份回應被收下（或這輪同步結束）才送；keepalive 不等。`writePositions.test.ts` 用模型時鐘量上限。
- **伺服器退回去**（#1794 第 4 輪定案，取代之前的「連續 3 次」「安靜」「游標在 head 後面」各條）：一份回答的 head **低於它的請求送出那一刻這台已知的位置**，而且是同一個身分（或回答沒說身分、或這台還不知道身分）⇒ 伺服器退回去了，一次就判（`writePositions.ts serverWentBack`）。送出那一刻已知的每一個位置都在伺服器讀這份回答之前就提交了（各種回答的 head 都是同一工作區的 `MAX(id)`，讀在請求到達之後），健康的伺服器不可能回一個比它小的 head。「已知」＝頁面的水位、副本的水位（頁面最近一次得知的：載入時、每一回合開頭 `getWatermark`、副本拒收時回傳的 `answer_watermark`；其他分頁的確認頁面看不到，學到的值是當時副本已知的下限，判斷只會少、不會錯）、同步請求自己的游標（它來自一份收下的回答）——所以「游標在 head 後面」是這條規則的一種情形。送出之後水位重新開始過（`era`）的請求不再判。只是晚到的回答（`送出時已知 ≤ head < 現在的水位`）只拒收、再問，永遠不會被當成退回去。判出來之後只有一條路（`serverTruth.ts serverLostItsWrites`，同步迴圈與 `takeBootstrap` 呼叫）：副本忘掉水位並記下「還欠一次重建」（`sync_state.rebuild_owed`，`critical` 寫入，失敗就丟出，頁面這時也不忘自己的）→ 頁面忘掉水位 → 提示一次（「伺服器上的資料比這台裝置最後存的還舊，請看一下最近改過的筆記。」；副本說之前已欠就不再提示；沒有副本的裝置每一回合都是整份 bootstrap，每次退回去只會判到一次）→ 整份 bootstrap（游標在 `persistBootstrap` 裡退回）→ 成員檢查從頭做完才放下閘門。bootstrap 失敗或重新整理：每一回合開頭讀副本的 `rebuildOwed`，欠著就先重建；整份 bootstrap 存進副本才清（`?nodes=none` 不算）。bootstrap 也照同一條規則（開機第一份 bootstrap 判出來就照這條路收下，不走離線）；單筆讀取判出來就交給同步（加進「再讀一次」並立刻要一次同步）。成員頁與 `?nodes=none` 不判（沒有 `asked`，只拒收；不判的路不會誤判），它們前後的 delta 會判到。
- **不是退回去的情形**（每一條都有測試）：另一個身分（`sameServer` 為假，空的 delta 也算）走「換了伺服器」：忘掉水位、整份重建、不提示。第一次重建失敗也不會變成退回去：副本自己看到另一個身分時（`applySync`、`?nodes=none` 的 `persistBootstrap`）記下欠重建；頁面先看到時，下一回合開頭發現副本還算在另一份紀錄裡（`startWatermarkFrom` 回 false，不收它的位置），先重建，再拿副本的游標判斷。`?nodes=none` 不是整份狀態（`wholeState` 只給整份）；沒有 head 的回答不判；讀副本（read replica）延遲在這個部署不存在（單一 Postgres、每個回答都讀主庫）——將來若加讀副本，回答的 head 必須讀自主庫，否則這條規則會誤判；修剪不刪工作區最大的事件；一台伺服器只有一個工作區（`services/workspaceId.ts`），預設工作區被換掉等於伺服器的狀態換了，照退回去處理是對的。
- **規則靠的前提**（`writePositions.ts` 檔頭）：一台伺服器一個工作區（水位只以身分為鍵；後端守門 `singleWorkspaceHead.guard`）；帶 head 的回答一律 `Cache-Control: no-store`（`app.ts`，`eventPositionHeader.integration` 釘住），被快取重放的舊回答會被當成退回去；單筆讀取也帶身分（`X-Onden-Read-Server`），換了身分之後的讀取走「換了伺服器」，不會拿舊紀錄的位置來判；副本拒收時附上它的水位與身分，頁面只在同一份紀錄裡學（`startWatermarkFrom`）。
- **在同步迴圈外發現**：bootstrap 判出退回去時同樣把成員檢查設成從頭做（`reconciledRejectionRevision = null`）；單筆讀取判出來時先把證據留下（欠重建、提示）。判出來之後立刻要一回合（`serverLostItsWrites` → `later.again`）：沒有同步在跑就跑一回合，正在跑的（已經過了開頭的檢查）結束後再跑一回合（`markSyncDirty`，它也先把閘門升起來）。
- **被拒之後**：bootstrap 在擋住新寫入的期間重新下載同一種，最多 3 次（`ASK_AGAIN_AT_MOST`，只是重問的上限，不是退回去的判斷）；單筆讀取（`serverTruth.ts readServerNode`）同樣再問，仍被拒就把筆記放進「再讀一次」的清單（`serverTruthLoad.ts readAgain`），2 秒後的同步讀它。閘門**只因成員檢查完成**而放下：被拒的回答（`RefusedAnswer`）不放它，成員頁被拒更不放。退回去之後進得去，靠的是恢復本身成功（清水位 → bootstrap 被收下 → 成員檢查照常跑完）。單筆讀取的重問有讀取期限（`readWithDeadline`，它握著新寫入）；重問逾時也把筆記放進「再讀一次」；一則一直被拒的筆記每一輪間隔加倍（2、4、8、16 秒），四輪後停，等它下一次改變或被打開；伺服器回「不在了／讀不到」（403／404／410）就清掉它的輪數。
- **已知、不擋的（第 4 輪起）**：(1) 兩個分頁可能各提示一次（甲判出、重建、記號清掉之後，乙還握著自己的水位，自己再判出一次）。(2) 這條規則只在 head 仍低於這台已知的位置時發現得了：快照把事件序號也還原，之後別台又寫到超過這台的游標，閒著的這台就分不出來，直到每日的整份更新（要關掉需要紀錄的指紋，另排）；走還原腳本的還原會換身分，不受影響。(3) 真的退回去時，這台的本機副本是遺失存檔唯一的持有者，重建會蓋掉它（main 上本來如此，另排：重建前把不同的本機內文留成救回的副本）。
- **已知、不擋的**：水位寫進日誌是 `critical: false`、頁面不等它。確認之後幾毫秒內重新載入可能少了那一次提升，但同一個 worker 先寫提升、後寫「移除待送」，所以不是提升還在，就是那筆寫入還在佇列裡，重送會回原本的位置。
- **分頁與帳號**：每個分頁一個 worker、一份記憶體副本，共用同一份 IndexedDB 快照與日誌（`localDb.ts` 每頁 `new Worker`；`localDbWorker.ts` `adoptStoredSnapshot`／`catchUpWithOtherTabs`）；水位經日誌在分頁間傳遞。副本依帳號分開（`accountStorage`），頁面一次只綁一個帳號。
- **測試**：`lateAnswerKinds.property.test.ts`（每一種資料、副本忙、勾選任務改寫筆記、隨機序列、MR-Y1）、`saveTiming.property.test.ts`、`answerPositions.test.ts`、`writePositions.test.ts`、`serverRolledBack.test.tsx`（退回去的每一條路與健康伺服器不誤判）、`serverRolledBackRealCopy.test.tsx`（同一條恢復接真的 worker，含重新整理後仍欠重建）、`readAgain.test.tsx`、`localDbSharedStorage.test.ts`（兩個分頁、兩個帳號）、後端 `eventPositionHeader.integration.test.ts`、e2e `faults/lateAnswer.spec.ts`（規則關掉會紅）。
