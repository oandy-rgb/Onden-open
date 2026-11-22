# 邊界決定：復原、屬性與標籤、歷史、版本（第 1–5 批，2026-09-08～12）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/eventRestore/*.ts, packages/backend/src/services/tagMembership.ts, packages/frontend/src/hooks/useVersionRestore.ts, packages/frontend/src/hooks/useLiveEventLog.ts

何時讀：改事件復原、版本復原、屬性／標籤復原、歷史列表與預覽之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 本次審核的邊界決定（2026-09-08）

- **復原保有自己的領域操作。** 比較將所有反向操作塞進 `mutate` 與共用底層機制後，
  選擇 `restoreEvent(eventId, { actor, workspaceId, ... })` 封裝逆向政策、衝突和分組；
  `spine/eventTransaction.ts` 共用事件鎖，`spine/idempotency.ts` 共用既有請求去重。
  路由不得再分別傳入可不一致的 `actorId`／`actorType`，歸屬從 ActorCtx 推導。
- **可捕捉的復原失敗必須先回滾。** `withTransaction` 巢狀時仍加入外層交易；
  需要失敗後繼續批次的復原使用 `withSavepoint`，同時丟棄該單位的提交後通知。
  內部以具型別的拒絕中止交易，回到邊界後才轉成原有 `RestoreError`；未知錯誤往外傳。
  同一資料庫 client 的 savepoint 分支須依序等待，不平行執行。
- **垃圾桶政策是明確的能力。** 比較把所有讀取改成包含垃圾桶與區分生命週期後，
  選擇一般 `node`／`canReadNode` 只處理 live 節點；復原和治理歷史明確使用
  `retained_node`／`canReadRetainedNode`，仍檢查目前祖先政策及 token、人類 scope 的交集。
  不存在的節點拒絕授權，不能和「存在但沒有政策」混為一談。
- **復原檢查逆向操作的權限。** 例如撤回建立是 `delete_node`，撤回新增屬性可能是
  `delete_attribute`，標籤成員變更另檢查該標籤的 apply／remove 政策。
  scalar 欄位須與原事件的正向值比較；後續編輯衝突不能默默覆蓋，缺乏可驗證資料也不能假成功。
  `force` 不能繞過 parent 授權／cycle 檢查；建立復原副本只複製該筆記，不逆向處理原筆記的 cascade。
- **先保存草稿，再復原版本。** 比較取消草稿與先保存後，選擇後者以保留可回看的文字。
  保存失敗就停止，等待保存時的新輸入取消這次復原準備；復原送出後的新輸入仍保留。
  筆記寫入順序涵蓋基準讀取、請求、結果調和及本機鏡像，不能只包 HTTP。
- **提交確認與結果分開。** `200 { deduped: true }` 不含筆記內容；歷史 writer 必須再讀取。
  已提交卻讀取失敗時保留草稿、提示刷新；該 writer 存活期間同版重試只讀結果。
  這個重試狀態尚未跨重載持久化，不能宣稱已解決所有跨裝置／重載後的重試。

## 第二批：屬性與標籤復原（2026-09-09）

- **屬性是一份完整狀態。** 比較逐欄補缺值與完整快照後，選擇 `null` 表示不存在，
  否則保存 value／value_ref、value_type、is_inheritable、source。來源會影響覆蓋優先序，
  不能在復原時改成 ui 或用預設值補上；row id 和 updated_at 不屬於恢復的語意。
  `eventLog/attributeSnapshot.ts` 統一編碼，ink 在正反向都用 blob 參照。
- **標籤只逆轉該事件實際改動的欄位。** 比較整份 schema CAS 與逐欄 CAS 後選擇後者；
  fields／views／behaviour／policy 各是完整值，不在 policy 內做深層合併。
  同一事件實際改過的 name／slug 成組比對，color 獨立且允許 null；未改的 slug 不加額外守衛。
  不覆寫無關欄位、不重跑 defaults／behaviours，schema.name/slug 保持 migration 074 的獨立身分。
  歷史名稱／slug 已被占用時拒絕，不自動另取後綴；只有實際 policy 逆向更新才增加 membership epoch。
- **正反向紀錄都描述實際前後值。** 本批的屬性、任務、評分與標籤 PATCH 在事件鎖內取舊值，
  不在交易外觀察後假定它就是被覆蓋的值。任務排程器先事件鎖、再資料列鎖，與任務 PATCH 同序。
  屬性與標籤的逆向規則分別在 `eventRestore/attributes.ts`、`tags.ts`；
  `record.ts` 只統一歸屬、因果和結果，不能獨立取代 `restoreEvent` 的授權與交易。
- **無法證明安全時保留現況。** current 等於 before 可視為已復原；需要寫入時，current 須等於 after。
  不同回 `state_conflict`，必要歷史／blob 缺失回 `history_incomplete`，皆為不可 force 的 409。
  舊紀錄不回填猜測值，也不能改回 unsupported 422，因為收件匣會把 unsupported 視為可完成審核。
  新建 schema 的撤回仍是不支援的產品操作。cascade 只略過 unsupported／already_in_state；
  其他領域拒絕與例外中止整組，避免父操作刪除子操作剛保護的資料。
- **前端復原結果明確分成 applied／refused。**（2026-10-24：每筆事件歷史與 `useEventRestore`／事件復原對話框已從前端移除，以下是當時的決定；後端 `restoreEvent` 不變。） 比較兩入口各自 catch/rethrow 與共用操作後，
  選擇 `useEventRestore` 集中 API、錯誤、重試鍵及提交後刷新；對話框只在 applied 關閉。
  拒絕保留預覽並提供重新讀取，游標交接只在收到提交確認後建立。歷史刷新回傳是否成功，
  刷新失敗不改判寫入失敗；模糊網路失敗同一操作沿用冪等鍵，狀態仍只保存於 hook 生命週期。
  對話框以 portal 放在頁面頂層，不能隨手機隱藏的桌面側欄一起消失。

## 第三批：標籤關聯的復原（2026-09-09）

- **關聯是否存在，不能代表它仍是原本那次變更。** 比較掃描標籤事件與資料庫追蹤後，
  選擇 migration 081 的 `node_tag_states`：實際 INSERT／DELETE（包括沒有標籤事件的 SQL）
  產生新的狀態識別；不存在的關聯也保留識別，purge 則隨兩端的外鍵清除。
  不將 created_at、事件時間或整個 workspace 的 epoch 當作單一關聯的版本。
- **狀態識別是復原鏈，不是遞增版本。** 事件記錄 before／after 識別，逆向操作核對目前 after，
  交易內恢復 before 的識別與存在狀態；因此可順序撤回及撤回復原，後來明確套用／移除仍會衝突。
  `membership_epoch` 維持單調遞增，由既有 node_tags trigger 更新；復原不再額外重複 bump。
  不將狀態識別拿來作同步游標、撤權版本、冪等鍵或授權依據。
- **`services/tagMembership.ts` 擁有這項知識。** `tagMembershipWrites` 的 `recordTagEvent` 使用 `recordedTagMembership` 取得事件資料；
  復原與預覽使用同一份核對規則，路由不組合識別、資料表或逆向 SQL。
  正向的 `recordTagEvent` 必須緊接實際關聯變更、位於同一事件交易中。REST／agent 的 apply／remove
  已先取事件鎖再寫資料；集合 createItem 的標籤事件、template／defaults 也加入建立交易。
  其他透過 `attachTagInTx` 的既有入口沿用該交易契約；這不是授權所有直接 SQL 省略領域事件。
- **舊歷史保持可讀，無法核對時拒絕寫入。** migration 只替既有關聯建立識別，不猜測回填 append-only 歷史。
  需要變更但缺少完整識別時回 `history_incomplete`；後續變更回 `state_conflict`，皆不可 force。
  存在狀態已等於逆向目標仍回 `already_in_state` 且不寫事件。預覽使用同樣結果，
  保留更新預覽／取消與既有權限、scope、連帶回滾規則。

## 第四批：歷史讀取與畫面歸屬（2026-09-12）

- **歷史、游標和讀取生命週期屬於同一次查詢。** 比較在各入口加 key／清空資料與集中讀取後，
  選擇由 `useLiveEventLog` 隔離查詢、取消舊請求、停止舊輪詢及丟棄晚到的成功／失敗。
  切換時立即隱藏舊事件；A → B → A 也不能復活第一次 A 的請求或 reload。
  呼叫端只提供查詢，不自行管理游標或非同步回應版本。
- **同一查詢的快照與增量依序讀取。** 手動 reload 等待在該次呼叫之後開始的快照；
  讀取中收到的 tick 合併成後續讀取，SSE 重連與頁面重新可見時補讀。
  空歷史的前向查詢明確使用 `since=0`，不能省略成倒序快照。
  reload 失敗或離開查詢回 false；同查詢失敗保留已讀列，不能據此推翻先前寫入的提交確認。
- **筆記的預覽與回饋跟隨筆記生命週期。**（`NodeEventHistory` 已於 2026-10-24 移除。）`NodeEventHistory` 內部重置選取、復原預覽與回饋，
  側欄和歷史頁不各自加重置流程。完整事件列表的目前篩選，在載入／失敗／空結果時仍須顯示。
- **歷史操作不能依賴 hover 才能使用。** 窄螢幕與無 hover 裝置分開呈現內容與操作，
  還原與展開控制保持可見且至少 44px；桌面保留緊湊布局，鍵盤焦點也要顯示操作。
  此處只調整歷史入口，不代表所有頁面的觸控布局已完成審核。

## 第五批：版本復原與編輯器一致（2026-09-12）

- **保存版本的復原共用一個操作入口。** 比較每個畫面各自保存／刷新與共用操作後，選擇
  `useVersionRestore().restore(nodeId, versionId)`，由既有 `restoreOverviewDraft` 與
  `nodeMutations.restoreVersion` 處理草稿、寫入順序、冪等重試、結果調和與通知。
  側欄、完整版本視窗與全域版本列表都等待 applied／refused，不再直接 POST 或先關閉視窗。
  保存版本與反向事件仍是兩種領域操作，不把它們合成旗標式的萬用復原器。
- **只準備本次復原對象的草稿。** 等待該筆記的待保存或進行中保存，不要求先保存另一筆記。
  準備期間的新輸入取消這次復原；送出後的新輸入保留，繼續走既有保存與合併規則。
  提交確認後讀取失敗仍是 applied，保留草稿並提示刷新，不改判成失敗。
- **已開啟的版本預覽擁有內容快照。** 連續保存會讓 session 列表合併舊 ID；比較停用合併與
  保留預覽快照後選擇後者。完整視窗保留開啟時的版本列表，重新開啟取得新列表；Current 顯示即時草稿。
  點選側欄版本時先捕捉快照，即使稍後合併也保留原目標；切換筆記即清除，不在回到原筆記時復活。
  預覽狀態原由 `NodeInspector` 擁有；2026-09-29 導覽去重後遷到 `NoteVersionHistory`，
  資訊欄列最近三筆並開啟浮動版本視窗。Builder 與 `useOverviewMode` 仍不傳遞選取或復原 callback，
  草稿準備、預覽快照與復原契約不變；見 [資訊欄歷史](../archive/inspector-history-2026-09-29.md)。
- **等待結果與手機布局是同一契約的不同呈現。** 完整版本視窗等待期間停用關閉／重複復原，
  失敗保留預覽與回饋；portal、焦點限制及背景捲動鎖定不依附桌面側欄的可見性。
  手機將版本列表放在正文上方，正文採 14px，操作至少 44px；全域版本列表的操作不依賴 hover。
  這些尺寸是本次歷史畫面的選擇，不是全站一律套用的通用設計規則。

審核範圍、交易排序及尚未處理的邊界見 [復原審核與契約](../architecture/restore-writes.md)。
這些決定描述本批的契約，不表示所有舊的直接事件寫入或所有外層交易已完成遷移。

> 2026-11-18：復原的反向操作若會刪掉一個在用模組的標籤，`restoreEvent` 回 `module_tag`（409）而不是 `reserved_tag`（`RestoreError` 型別多一種）；其他復原規則不變。
