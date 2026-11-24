# 後端規則：事件、權限、交易與復原

> 狀態：現行（最後確認 2026-11-22）
> 涵蓋：packages/backend/src/spine/mutate.ts, packages/backend/src/spine/authority.ts, packages/backend/src/spine/currentActor.ts, packages/backend/src/spine/systemJobs.ts, packages/backend/src/services/readPolicy.ts, packages/backend/src/services/tagMembershipWrites.ts, packages/backend/src/services/eventRestore/restore.ts, packages/backend/src/test/guards/systemActor.guard.test.ts, packages/backend/src/dbClose.ts, packages/backend/src/test/guards/backgroundWriters.guard.test.ts

何時讀：改後端寫入、權限、事件、交易或復原的任何程式之前。硬規則的精簡版在 [AGENTS.md](../../AGENTS.md)。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 分清事件、權限、復原與同步

| 責任 | 回答的問題 | 邊界 |
| --- | --- | --- |
| 權限政策 | 操作者現在可以做什麼？ | 由可信任的身分與目前政策判斷，後端執行 |
| 操作紀錄／領域事件 | 誰在何時完成了什麼變更？ | 記錄已提交的事實、對象與因果關係 |
| 復原 | 如何恢復內容，如何處理後續修改？ | 明確定義快照、反向操作、衝突與不支援的情形 |
| 同步 | 裝置缺哪些變更，哪些資料已不可讀？ | 分別處理內容增量與可讀集合的變化 |

這些責任可以共用資料表與交易，但不能互相代替。操作歷史不自動等於完整 Event Sourcing；
新增紀錄需求不代表必須讓整個系統靠事件重播取得目前狀態。

## 權限規則

- 集中定義與測試政策；領域操作宣告所需能力，入口不重寫角色、標籤、繼承與 scope 判斷。
- 寫入使用既有 `spine/mutate.ts` 與 `spine/authority.ts`；讀取使用 `services/readPolicy.ts`
  的適當公開介面，包括集合查詢的 SQL 範圍。不要先全量取出再另寫一套可見性判斷。
- actor/token ID 來自可信驗證情境，但驗證時的 role/scope 可能在等待期間過期。
  根寫入在事件鎖後經 `spine/currentActor.ts` 重讀；在 `mutate` 前還有來源、父層或
  建立範圍判斷的領域操作，也須在同一鎖內使用當前 actor。不要以找不到 actor 時沿用舊值作相容。
  不經 `mutate` 而以請求的 actor 名義寫的事件（agent 工具呼叫的稽核紀錄）走 `currentActor.ts` 的
  `appendEventAsCurrentActor`：同樣是鎖 → 重讀 → 寫入。驗證之後、寫入之前 actor 被移除（或 token 被撤）
  就是 401 `{ error: "unauthorized" }`，和從沒發出過的憑證同一個回應；不得讓資料庫對 `domain_events.actor_id`
  的檢查（migration 071）來拒絕而變成 500（PR #1875）。發布快照的 `PUBLISH_SNAPSHOT_CREATED` 也走這條。
  這種 401（請求已登入、重讀時 actor／token／臨時工作階段不見了，`ActorGoneError`）由 `httpError.ts` 記一行 `[auth]` 警告
  （token id、路徑、401；不記 token、actor id、參數；沒有 token 的人或臨時工作階段只記路徑）。
  每個 HTTP 入口對「身分在請求執行中不見了」只有一個判斷：`currentActor.ts` 的 `actorGoneDuring`（`apiOnError` 在答 500 之前、
  MCP 協定端點在回呼失敗時問它；看身分現在還解不解得開，不看錯誤的形狀）。新路由、新工具不要自己捕捉這種失敗。
  背景工作（outbox 執行、派生工作）以「排進佇列時」抓到的 actor id 寫事件，不拒絕：在同一個事件鎖的交易裡先用
  `signatureForCapturedActor` 決定簽名——actor 還在就照舊，被移除了就簽系統（`REMOVED_ACTOR_REF`），原 id 放 payload 的
  `removed_actor_id`。工作照樣完成，不讓 outbox 重試一天後埋掉、不讓補跑每次重來、不讓派生佇列的 promise 被拒。
- 一般標籤套用／移除使用 `services/tagMembershipWrites.ts`，共用目標與標籤的雙邊政策、
  human/token scope、事件及同步附帶效果；安全副本仍使用專用的複製操作。
  背景派生與重啟補跑須在寫第一個屬性前重驗權限；契約與工具縮權見
  [標籤與當前身分修正](../archive/tag-authority-fixes-2026-09-29.md)。
- 一般操作、批次、匯入、復原、背景工作與 agent 工具都必須遵循適用的權限邊界。
  UI 隱藏按鈕或本機快取不能作為後端授權依據。
- 操作者從可信任的驗證情境取得；沿用既有 cascade 的根操作者與因果追蹤。
  不接受客戶端任意指定權限種類，也不以 `open`／`cascade` 修掉授權失敗。
- 臨時工作階段（`actor.type = 'session'`）：`isPerson`／`requirePerson` 對它一律為否；個人資料的寫入權限種類由 `open` 改為 `own_personal`
  （`mutatePersonal` 使用，工作階段被拒）。它的存活與過期在事件鎖後由 `resolveCurrentActor` 重驗。
  `services/participantSessions.ts` 的兩個寫入函式登記在 `SERVICE_WRITE_HELPERS`（計數器寫入不在 spine 內，有登記才放行）。
  個人資料的**讀取**問「這是誰的列」只用一個函式：`spine/authority.ts` 的 `personalDataOwnerId(actor)`（工作階段＝開啟它的人，其他＝自己；寫入從不用它）。
  每個個人資料讀取點都要問它；`src/test/guards/personalReads.guard.test.ts` 擋掉沒問的新讀取點。工作階段讀得到的比本人少（每個讀取點各自拿掉它用不到的東西），
  由 `isTemporarySessionActor(actor)` 判斷；清單與理由見 [工作階段讀開啟者的個人資料](../architecture/proposals/sessions-reads-own-2026-11-17.md)。
  工作階段的 id 不離開這一台：會被帶走的表裡「誰做的」欄位（`function_refs.created_by` 這類）由寫那一欄的函式填 `carriedActorId(actor)`（工作階段與 System 是 null，不是開啟者），
  欄位清單由 `carriedActorColumns.integration.test.ts` 從資料庫目錄核對，每個寫入點也由它從程式碼找出來核對。工作階段是**結束**、不是移除：它的 `actors` 列永遠留著
  （資料庫的觸發器拒絕刪除與改 id、工作區、種類，只有整個工作區被刪時讓開：migration 217；`removeActor` 也回 409 `session_not_removable`），
  因為「這是工作階段的」只靠這一列判斷（`neverLeaves`、歷史的作者）。工作階段的寫入不記它自稱的裝置（`recordedDeviceId`：記 null），
  它手動設的屬性是人的值（`source = 'ui'`）。工作階段不得做不可復原的事（永久刪除、清空垃圾桶、刪掉沒有反向操作的東西）：那樣的操作把權限宣告成
  `{ kind: "irreversible", of: <原本的權限> }`，或在入口呼叫 `assertUndoableBy(actor)`；「有沒有反向操作」照 `restoreContract.ts` `restoreBlockedReason`。
  工作階段也不改變誰讀得到一則筆記、什麼會上網站（把筆記搬到另一個空間、把隱藏的筆記變一般）：`assertKeepsReaders`。發布標記只有人能**選擇**；新筆記從父筆記、來源或匯入檔帶來的「不發布」任何人照寫（`attributeChange.ts` `assertActorMayWriteAttributeKey`）。
- 重構應保持既有允許／拒絕結果。不能因為引用 Cedar 或其他論文，就直接更換預設授權語意。
  對政策行為的變更，須說明具體哪些操作者、資源與操作受到影響，並驗證允許與拒絕案例。
- 政策改變可能影響整個子樹或資料集合。沿用 `membership_epoch` 與可讀集合核對機制，
  驗證撤權及重連後的結果；不能只依賴節點的內容變更事件。

## 事件與交易規則

- 領域操作定義事件種類、對象及必要資料；共用機制負責操作者歸屬、因果追蹤、交易和重試去重。
  UI 與每個路由不應重複配置這些細節。
- 業務事件要描述實際發生的事。資料列差異可協助保存前後值，但無法自動推導完整業務意圖。
- 狀態變更與對應的成功事件必須同一交易提交或回滾；適用的權限集合版本更新也在同一交易內。
  確認授權檢查與寫入之間的一致性，不把「呼叫了檢查」視為已消除競態。
- 網路失敗可能只是回應遺失。重試沿用原冪等鍵；失敗交易不能留下會吞掉下一次有效重試的成功標記。
- 被拒絕的嘗試、診斷日誌與已提交的領域事件要有不同語意。
  如需記錄失敗嘗試，明確定義它的保存方式，不能讓它成為同步或復原中的成功變更。
- 事件內容須服務明確用途，避免傾倒整個請求、憑證或不必要的內容。
  修改事件格式時，檢查既有歷史、復原與同步消費者的相容性。
- 外部副作用沿用既有 outbox；不新增與資料庫交易各自提交的臨時傳送流程。
- 提交後或計時器才寫資料庫的背景工作（派發佇列與重試、outbox 立即清送、週期工作、語意索引續跑）要向 `dbClose.ts` 的
  `onBeforePoolEnd(名稱, { pending, drain })` 登記：`pool.end()` 先重複整輪排空到沒有待做（排空時新排的工作也會被等到），
  最多等 `DRAIN_LIMIT_MS`，超過就記一行並照樣結束連線池，來不及做完的留著 intent 列由下次開機補跑；排空出錯，連線池照樣結束、錯誤給呼叫者。
  一個行程只關一次，`isPoolClosing()` 之後不再重試。新增計時器或 `afterCommit` 的檔案若不登記，必須列在
  `test/guards/backgroundWriters.guard.test.ts` 的 `EXCEPTIONS` 並寫為什麼它不會寫資料庫（守門會擋，清單只減不增）。
  測試輪裡 `pool.end()` 真的等到工作時會記一行「哪個檔、哪個登記者、幾個工作」，一輪結束時由 `scripts/lib/skipGateReporter.mjs` 彙整成一份清單（只記不紅），該檔應自己 `awaitAllDispatchers()`。
  結束後的連線池不可再用：PGlite 的 `PglitePool` 與真 Postgres 一樣拒絕之後的 `query`／`connect`（不會悄悄開一個空資料庫）；要重新開始必須是新的連線池，不是一次查詢的副作用。
- 沒人觸發、到時間自己跑的背景工作（目前是任務排程器、段落標記修復、段落位置找回與收件匣，見 `SYSTEM_JOBS`；收件匣（`spine/stampedInbox.ts`）分段收別台送來的包、不寫事件，它的系統身分只用來清收件匣的列）用系統身分走 `mutate`（`spine/systemJobs.ts`）；段落位置找回（`services/blockAnchors/recover.ts`）只改錨點的位置、不寫事件，不走 `mutate`，但以它的系統身分蓋標記（`stampTransaction(..., { system: true })`），所以碰到有衝突的單位會被拒、不會替人解決衝突：
  事件 `actor_type` 為 `system`，`actor_id` 由工作推導；它只有 `{ kind: "system" }`／`cascade` 權限，
  允許的事件種類、對象種類與所需模組寫在 `SYSTEM_JOBS`，每個事件（含連帶）都核對，越界丟 `AuthorityError`。
  系統身分沒有個人空間（資料庫拒絕沒指定父節點或空間的建立）、不是擁有者，也不是原生 app 的 `system` 帳號。
  只有 `test/guards/systemActor.guard.test.ts` 列出的檔案能 `systemActorFor`；某人操作旁的稽核紀錄
  （`DISPATCHER_FAILED`、`BODY_CONFLICT` 等）仍可直接 `event(..., "system", ...)`，同一個測試逐項列出理由。

## 復原規則

- 復原是一個依目前權限執行的新操作；它產生新的紀錄並保留原歷史。
- 是否可復原、需要哪些資料、遇到衝突如何處理，屬於操作契約。
  不要求每個事件都能任意倒帶，也不把外部副作用假定為可逆。
- 復原不得覆蓋未納入本次操作的後續編輯。強制覆蓋與建立副本沿用既有明確操作語意。
- 分清共用的歷史／執行順序、各領域的反向操作，以及一次復原包含哪些操作的分組規則。
  在既有機制內逐步分離這些責任；不能直接把編輯器記憶體內的 undo 範例當作跨裝置持久化協定。
- 遷移復原流程時，將共用權限、交易、事件機制收回既有邊界，保留領域的衝突判斷。
  `services/eventRestore/restore.ts` 的寫入已經走 `spine/mutate.ts` 的 `runRestore`／`mutateRestore`；不要新增繞過它們的復原旁路。

> 2026-11-18：模組自己的標籤（`tag_schema.module`）在模組在用時不能刪除、不能被合併掉，與 reserved 標籤、任務標籤同一個檢查（`reservedTags.assertTagDefinitionChange`，409 `module_tag`）；「在用」的定義與已刪標籤的處理見 [decisions-modules.md](decisions-modules.md)。
