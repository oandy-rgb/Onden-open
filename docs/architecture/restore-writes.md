# 復原審核與寫入契約

> 狀態：現行（最後確認 2026-11-22）
> 涵蓋：packages/backend/src/services/eventRestore/**

2026-09-08 至 2026-09-09。分兩批以「筆記復原」與「屬性／標籤復原」為完整使用案例，追查版本復原、事件反向操作、收件匣拒絕、
垃圾桶與相關讀取政策。沒有宣稱完成全專案安全審計。原先的前端重構工作保留。

## 發現與修正

| 發現 | 原本可觀察的錯誤 | 本批處理 |
| --- | --- | --- |
| 主事件失敗卻提交子事件 | cascade 先刪除子節點，主事件回傳衝突，交易仍提交 | 在交易內拋出領域拒絕，回滾後才轉回 API 結果；巢狀批次使用 savepoint |
| 事件順序按字串排列 | 跨 9→10 或 99→100 時反向操作順序錯誤 | 以 bigint 排序，僅輸出時轉為字串 |
| 復原統一檢查 write_node | 能編輯的人可能藉撤回建立來刪除受限制節點 | 按實際逆向操作宣告權限，保留目前政策與 scope |
| 垃圾桶目標被當成沒有政策 | 刪除後的歷史／屬性可能繞過原本的限制 | 區分 live／retained，兩者都拒絕不存在的目標 |
| 人類標籤 scope 未套用於標籤讀取 | 標籤清單、詳細資料與集合入口可見範圍不一致 | 清單和單筆共用 token ∩ human tag scope |
| scalar 欄位復原不完整 | title 覆蓋後續編輯；部分欄位回成功但根本沒還原 | 比較欄位的正向值／先前值，只修改真正逆向的欄位並拒絕衝突 |
| 復原成新筆記沒有請求去重 | 回應遺失後重試可能建立多份副本 | 與 mutate 共用交易內的 idempotency claim |
| 副本與連帶復原可同時送出 | 按建立副本仍可能反轉原筆記的子事件 | 副本限 NODE_UPDATED、忽略 cascade；前後端都維持原筆記及其子事件不變 |
| 復原回應遺失後誤用 dedupe 回應 | `{ deduped: true }` 被當成完整筆記，舊內容留在編輯器 | 明確區分提交與結果，重新 GET 筆記 |
| 自動保存與復原競態 | 延遲保存的舊草稿可能蓋回剛復原的版本 | 先 flush 草稿並等待既有保存，再復原；整個結果調和持有同一筆記寫入順序 |

## 呼叫者的責任縮小

後端事件與收件匣入口只提供可信任的 `actor`、workspace、事件和產品選項。
復原領域決定操作權限、衝突與事件意義；共用層負責事件鎖、交易與重試去重。
UI 透過 `useVersionRestore`，由 `restoreOverviewDraft` 協調草稿、`noteHistoryWriter` 執行版本復原，
不必各自了解 autosave timer、佇列基準與 dedupe 回應格式。

沒有把 `restoreEvent` 強行改寫成 `mutate` 的大型 callback 配置。
這兩者的操作形狀不同：一般 mutation 有一個根事件，復原可能有歷史分組、逆向衝突與部分略過結果。
兩者實際共用 `eventTransaction` 的 append lock 與 `idempotency`；新增這兩個共用位置是為了消除已存在的旁路。

## 交易與排序

`withTransaction` 仍維持既有「巢狀時加入外層」語意。
`withSavepoint` 用於外層需要捕捉失敗並繼續的操作；成功的通知移交外層提交後執行，
失敗單位及其成功子單位的通知都丟棄。外層交易最後回滾，也不能發出成功通知。

2026-09-13 更新：claim 的記憶體狀態也交給同一交易邊界。實際取得 claim 的單位登記
`afterRollback`；已 release 的 child 將失效通知交給 parent，因此 `restoreEvent` 返回成功後，
更外層交易再失敗，也能在同一請求內重新 claim。COMMIT 回應不明時仍須同鍵向 DB 確認，
不能把快取失效解讀為肯定沒有提交。驗證見 [外層回滾與冪等修復](../archive/idempotency-rollback-fixes-2026-09-13.md)。

`withEventTransaction` 先取得與 `mutate` 相同的 workspace append lock，再執行狀態變更。
不能只在 `event()` INSERT 的最後一刻加鎖：這會與其他寫入的「先事件鎖、後資料列鎖」形成反向順序。
本批只保證已採用此共用邊界的路徑；其他舊的直接事件寫入仍需逐步審核。

cascade 一般按數字事件 ID 逆序，最後處理主事件。垃圾桶復活則有結構上的前置條件：
`NODE_DELETED`／`TAG_MERGED` 的根節點先復活，子節點才能合法回掛。
兩階段仍在同一復原交易內，沒有「可指向已刪 parent」的例外旗標。
不支援或已經在目標狀態的子事件沿用既有略過報告；其他拒絕會回滾整組，未知例外與授權拒絕不被吞掉。

## 保留的邊界與後續審核

以下是本批未完成的問題，不能由測試通過推導為已解決：

- **撤權與新內容的一致性。** `/sync` 先算可讀集合，再讀內容；政策、actor role／scope 和內容
  是否來自一致的版本在本批尚未驗證。2026-09-13 後續已將單次同步回應的 DB 讀取放入快照，
  重現並修正舊授權配新內容；同日再將同步的 actor／token 權限放入快照重新核對。
  分頁與補資料隨後加入版本核對；其他入口的 ActorCtx、bootstrap、pending writes 與本機清除仍未收尾，
  見 [同步快照修復](../archive/sync-snapshot-fixes-2026-09-13.md)、
  [操作者快照修復](../archive/actor-snapshot-fixes-2026-09-13.md)
  與 [membership 跨請求修復](../archive/membership-pages-fixes-2026-09-13.md)。
- **task 的 scope 依附誰。** 部分任務入口依 host note 檢查 scope，bootstrap／sync 又可能按 task 自身標籤過濾。
  應先確定產品契約，再統一 agenda、讀取集合與撤權測試。
  2026-09-25 後續已依[任務授權契約](../archive/architecture/task-authority.md)修正並重驗 TASK-07；本列保留當時審核背景。
- **跨重載的前端重試。** 已提交待讀取的狀態只存在 writer 生命週期內；發布沿用原結果契約，
  此批沒有把所有 online writer 的結果載入都遷移。
- **復原副本的可見性。** as_new_node 沿用既有內容副本、不複製直接 tags 的語意。
  是否應繼承原筆記的直接政策標籤，需連同普通 duplicate 功能訂出明確契約。
  2026-09-25 後續改用[安全副本契約](note-duplicates.md)：目前直接標籤與明確屬性一起複製並核權，
  歷史正文由該事件的 blob 加 inverse patch 重建；缺乏可驗證歷史時拒絕，避免混入後續編輯。
- **class_tag 型別變更。** 普通 PATCH 的 node_type 變更可能影響政策來源；本批不擅自新增
  principal 權限限制。逆向恢復 node_type 會更新 membership epoch，原始正向入口仍待審核。
- **其他寫入與逆向種類。** 本次遷移的正向入口為 node 屬性 PUT／DELETE、task PATCH、review grade、
  field defaults 與 tag identity／schema PATCH。其他直接儲存路徑、
  標籤成員操作與所有歷史格式尚未完整審核；不能把本批的快照保證推及全部事件。
- **歷史不足的相容性。** 舊屬性或標籤事件缺乏必要前後值時會拒絕自動復原，需要依可讀歷史另做正向修正。
  本批不改寫不可變歷史，也不假定缺失欄位等於當年的資料庫預設值。

## 第二批：屬性／標籤的操作邊界

`restoreEvent` 保有共同的事件讀取、目前權限、交易、分組與錯誤轉換；
`attributes.ts` 擁有完整屬性狀態的解碼、比較、逆向與預覽，`tags.ts` 擁有標籤欄位的同一組責任。
兩者都使用 `recordRestore` 記下實際寫入的前後值。這個共用介面沒有 force／cascade 旗標，
也不接受另一份操作者歸屬設定，避免各事件重新組合相同機制。

屬性採完整快照 CAS，包含來源與繼承設定；標籤採每個實際改動欄位 CAS，保留其他欄位的後續編輯。
屬性的還原把快照寫回時，用的是一般寫入也用的那一個列寫入函式（`attributeChange.ts` `storeAttributeState`），所以「這個操作者能不能寫這個鍵」
（發布標記 `_published` 只有本人能設或清，臨時工作階段不行）對還原一樣成立，不另寫一份。
例如 policy-only 復原不清掉後來新增的 fields，color-only 復原不把新名稱改回去。
name／slug 實際有改的部分成組比對，不能一半恢復、一半套用另一段歷史；舊名稱被占用回衝突。
`state_conflict` 和 `history_incomplete` 都回 409、不可強制，收件匣不得將它們標成已拒絕完成。

正向事件也要服從同一資料契約。共用 `encodeSnapshot` 隱藏 ink hash 與普通值的編碼差異；
任務和評分保留 SQL 真正留下的 metadata，不以「這個畫面通常用 text／false」代替實際資料。
預設值 INSERT 沒插入資料時不留下假成功事件。

（2026-10-24：前端的每筆事件歷史、`useEventRestore` 與 `RestorePreviewModal` 已移除；後端合約不變，以下前端描述是當時的設計。）
前端的兩個事件歷史入口共用 `useEventRestore`；Modal 處理使用者選擇、預覽和焦點，
不再把 fulfilled Promise 當作提交成功。手機改為上下比較、44px 操作按鈕，
並用 portal 避開桌面側欄的 display:none。預覽列出值、型別、子項目套用與來源，避免 metadata 變更不可見。

## 驗證紀錄

使用隔離的 `onden_integration_test` 執行真實 PostgreSQL 測試，瀏覽器使用另一個
`onden_browser_test`。測試資料不指向日常使用資料庫。

- 交易測試包含 SQL 錯誤後外層可繼續、主／子單位回滾、提交後通知、事件鎖持有到外層提交。
- 復原測試包含目前權限、scalar 衝突、parent cycle、跨位數排序、真實 inbox 路由及並行副本重試。
- 前端測試包含保存失敗保留輸入、等待中再輸入、已有 autosave、結果重新讀取失敗與重試只 GET。
- 瀏覽器以 1365×900 與 390×844 操作：輸入測試草稿、復原版本、回到編輯器；
  資料庫確認先 `NODE_UPDATED` 保存草稿，再 `NODE_RESTORED`，最後內容維持所選版本。
  390px 沒有頁面水平溢出；這是 viewport 測試，不是手機真機或軟鍵盤驗證。
  事件復原預覽亦檢查兩種尺寸：桌面保留並排、手機改上下比較與 44px 操作按鈕，警告色沿用主題。

第一批結果：

- 後端完整回歸在新建的 `onden_restore_final_test`：196 檔，1,546 項通過、2 項失敗、3 項跳過。
  本批新增的交易、復原、政策案例皆實際執行。
- 2 項失敗分別為 `licenseDeclared` 讀不到根目錄 README、`logger` 預期純文字但環境輸出 JSON。
  以獨立的 HEAD 程式副本執行完整基準也重現同樣 2 項失敗；本批沒有修改這些檔案。
  3 項跳過為既有 `mediaAuthority` 案例，不列入通過數。
- 前端完整 167 檔／1,183 項通過；後續新增復原預覽 1 檔／2 項亦通過。
- 前後端 TypeScript、ESLint、build 及 diff 空白檢查通過。
- 多次重用舊測試庫曾觸發 membership 測試的 200 筆 drain 上限與既有 fixture 干擾；
  最終採全新資料庫驗證，沒有藉調整正式權限或放寬斷言掩蓋失敗。

本機完整紀錄：`/tmp/onden-restore-backend-clean.log`、`/tmp/onden-restore-head-all.log`、
`/tmp/onden-restore-frontend-all.log`、`/tmp/onden-restore-preview-test.log`。


### 第二批驗證結果（2026-09-09）

- 後端完整回歸使用全新的 `onden_fields_verified_test`：198 檔，1,582 項通過、2 項失敗、3 項跳過。
  剩餘失敗仍是第一批已在 HEAD 重現的 README 缺失與 logger 格式期望；3 項跳過仍為既有 mediaAuthority 案例。
- 新增真實 HTTP／DB 案例涵蓋並行屬性覆寫與連續評分、ink 刪除的 undo／redo、任務保留來源與繼承設定、
  子事件歷史不足時整組回滾且不清除 inbox、nullable color、名稱占用、schema 衝突、policy-only epoch 及 delegated-token 預覽拒絕。
  原先完整回歸中的 syncRevocation fixture 會和其他測試的根 #task 撞名，已改用獨立父節點隔離 fixture；
  沒有修改正式權限。第一次與建置並跑的 compositionLaws 出現 5 秒逾時，獨立完整回歸已通過。
- 前端完整回歸：169 檔／1,196 項通過。新增拒絕不關閉、重新預覽、游標成功後交接、未知例外、
  不可 force 的欄位衝突、模糊失敗沿用冪等鍵、deduped 回應及提交後刷新失敗的案例。
  Portal 測試確認入口容器隱藏後視窗仍可見。
- 前後端 TypeScript、ESLint、build 與 diff 空白檢查通過。
- 瀏覽器使用 `onden_browser_test` 的合成帳號與驗證筆記。桌面 1365×900 與手機 viewport 390×844：
  UI 保存新屬性 → 開啟預覽 → 注入另一寫入的繼承變更 → 確認收到拒絕且視窗不關閉；
  移除注入後完成復原，手機編輯器確認顯示原值。桌面是左右比較，手機為上下比較，按鈕高度 44px，無水平溢出。
  實測發現並修正切換手機時側欄 display:none 把復原視窗一併隱藏；portal 後切換尺寸仍保持可見。
  此為 viewport 與滑鼠／鍵盤驗證，沒有宣稱手機真機、觸控鍵盤或所有功能都已驗證。

紀錄：`/tmp/onden-fields-backend-verified.log`、`/tmp/onden-fields-frontend-verified.log`，
另有 `/tmp/onden-fields-{backend,frontend}-{tsc,lint,build}.log`。


## 第三批：標籤關聯的狀態識別（2026-09-09）

### 使用案例、方案與完成條件

使用者撤回套用／移除標籤時，不能把後來的「移除再套用」或「套用再移除」當作同一狀態。
同時仍須支援順序撤回、撤回復原，以及同一 cascade 內對同一關聯的多次變更。

比較過的設計：

| 方案 | 呼叫者與內部須知道的事 | 取捨 |
| --- | --- | --- |
| 掃描最新 TAG_APPLIED／TAG_REMOVED | 所有改關聯的入口都必須完整留下同種事件，還要解釋先前復原事件 | 任務／初始化等既有 SQL 並無此保證，不能用沒有事件推論沒有修改 |
| 追蹤關聯狀態識別 | 資料庫捕捉實際關聯變更；領域模組核對 before／after | 新增一張每個曾使用關聯一列的內部狀態表及 migration；能保護沒有標籤事件的寫入 |

選擇第二種。保留 `restoreEvent(id, { actor, workspaceId, cascade })`，沒有新增客戶端識別參數。
正向入口仍呼叫 `dispatchTagApply/Remove`；它們在交易中使用
`recordedTagMembership(nodeId, tagId, applied)`，不自行讀取狀態表。

### 資料與交易契約

- migration 081 的 `node_tag_states` 包含目前存在狀態、state_id、previous_state_id。
  實際 INSERT／DELETE 產生 UUID；衝突而未 INSERT、未刪到資料與只改 created_at 均不改識別。
  key-changing UPDATE 追蹤兩端的狀態；目前應用入口不使用此操作。
- 初次套用前的「從未存在」用 null 識別；已套用的狀態一定有識別。
  明確移除會建立新的缺席識別，因此同為不存在也能辨識後續變更。
- `payload.membership_change` 保存 before_state_id／after_state_id。只供內部歷史契約使用，
  不要求前端讀懂；識別不表示時間或提交順序。
- 逆向操作先依目前政策授權，再在事件交易中鎖住關聯狀態、核對 after、改 node_tags，
  最後恢復 before 的識別並記錄相反轉換。任何失敗都回滾資料、識別、事件與 epoch。
  恢復識別讓較早的同關聯操作能繼續核對；任何新的正向寫入仍會產生不同識別。
- node_tags 的既有 trigger 單獨負責 membership_epoch／通知；本批移除復原的重複 bump。
  狀態識別可以回到前一值，epoch 不會回退。兩者不能互換。
- 兩端 hard purge 透過外鍵清除狀態；trigger 不在 purge 時重新建立失效的外鍵。
- REST 與 agent apply/remove 的外層改用 withEventTransaction，先事件鎖、再關聯與狀態列。
  集合 createItem 的模板／defaults 移入原本的 mutate.apply；
  標籤事件失敗時不再留下已提交的新項目。模板自己的可恢復錯誤政策維持原樣。

### 錯誤與相容性

- 目前存在狀態已等於逆向目標：already_in_state，不寫事件。
- 需要寫入但歷史缺少有效的兩端識別：history_incomplete 409，保留資料，不猜測回填。
- 存在狀態相同、識別不同：state_conflict 409；force 不適用。
- 預覽與執行共用同一規則。前端兩個歷史入口沿用 useEventRestore，拒絕不關閉對話框；
  更新預覽可重新核對。錯誤文字調整為「新的變更」，適用於欄位與標籤關聯。
- Migration 只為既有關聯播種識別，不能因此宣稱舊標籤事件已安全可復原。
  既有使用者可以正常查看歷史與直接套用／移除；無法驗證的歷史復原會明確拒絕。
- 本批維持既有授權結果與 scope 門檻；沒有重新設計各正向入口的政策選擇，
  也未解決先前文件列出的所有政策快照競態、歷史因果分組或跨重載冪等狀態。

### 驗證

- 新增 tagMembershipRestore.integration.test.ts：有事件／無事件的重新套用、後續缺席、
  順序 undo／redo、同關聯 cascade、衝突整組回滾、並行復原、no-op、無關關聯、
  舊事件、權限與 workspace／token scope、purge，以及集合事件失敗後完整回滾。
- 舊資料升級：在隔離 onden_browser_test 執行 migration 081，為 14 個既有關聯建立識別；
  未修改實際使用者資料庫。
- 瀏覽器：桌面 1365×900、手機 viewport 390×844。舊套用事件顯示衝突、不可強制覆蓋；
  對話框保留並可更新預覽。手機 dialog 寬 351px、所有按鈕高 44px，無橫向溢出。
  實際完成最新標籤事件的復原與其逆向操作；此為 viewport 驗證，非真機測試。

- 最終後端完整回歸使用乾淨 `onden_membership_complete_test`，199 檔／1,594 項通過、
  2 項失敗、3 項跳過。2 項失敗仍是之前已在 HEAD 重現的 README 缺失與 logger 格式預期；
  跳過為既有 mediaAuthority 案例。新增的 12 項標籤契約案例均實際執行。
- 回歸中重現 membershipEndpoint 的共用 workspace 干擾：兩筆一頁、最多 100 頁的測試守衛
  會漏掉其他測試累積的資料。已隔離該案例的 workspace，並在累積資料庫重跑 6 項皆通過，
  最終完整回歸也通過；沒有更動正式分頁或權限政策。
- 前端完整回歸 169 檔／1,198 項通過。前後端 TypeScript、lint、build 與 diff 檢查通過。
  新 schema 已由 pg_dump 重新產生並實際載入乾淨資料庫。

最終紀錄：`/tmp/onden-membership-backend-complete.log`、`/tmp/onden-membership-frontend-full.log`、
`/tmp/onden-membership-endpoint.log`，以及 `/tmp/onden-membership-{backend,frontend}-{tsc,lint,build}-final.log`。
測試隔離調整後亦重跑後端 TypeScript／lint，紀錄為 `*-complete.log`。

## 第四批：目前筆記與歷史必須一致（2026-09-12）

### 使用案例與實測發現

快速切換筆記或事件篩選時，列表與還原按鈕必須屬於目前選取的內容。
同一查詢收到刷新、SSE 通知及慢速回應時，不能被舊資料覆蓋或漏掉新事件。

瀏覽器在隔離資料庫重現：延遲筆記 A 的 `/api/events` 回應 12 秒，切回筆記 B；
B 的標題與本文正確，右側卻被 A 的 18 筆歷史覆蓋，仍有可操作的還原按鈕。
舊實作只共用 mounted ref；新 effect 又將它設為 true，讓已離開查詢的回應重新取得更新資格。
切換當下也沒有清空舊歷史，初始載入、reload 和增量各自更新同一游標。

### 方案與契約

| 方案 | 呼叫方式及需要理解的知識 | 取捨 |
| --- | --- | --- |
| 每個畫面重掛元件／清空列表 | 每個入口自行辨識查詢變更、清除資料與取消請求 | 無法單獨解決同一查詢內的刷新／增量競態，篩選與其他訂閱者仍可能漏改 |
| 查詢擁有讀取生命週期 | `useLiveEventLog({ query })`；需要刷新時 `await reload()` | 選用。請求、游標、等待者、輪詢及晚到回應的處理集中在既有 hook |

- 正規化查詢參數，同值不因物件順序或空值重啟；每次離開再返回仍建立新的查詢歸屬。
- 當次選取才可發布資料／錯誤。render 不暴露前次選取的列，effect 清理取消 fetch、輪詢與訂閱；
  即使取消未被 transport 採納，也依歸屬丟棄結果。保留的舊 reload 不會刷新後來重新選取的同名查詢。
- 同一查詢只有一個讀取流程。讀取中要求 reload，會等待下一份快照；多次要求合併，
  每個呼叫者得到對應讀取的 boolean。讀取中收到的更新提示排入後續讀取，不等到 60 秒 fallback。
- 前向分頁明確傳 `since=0` 或目前游標，依實際最大 ID 推進，合併結果依 ID 去重並倒序呈現。
  保留既有記憶體與單輪分頁上限；本批沒有把列表改成可完整匯出的歷史存檔。
- 同查詢刷新失敗保留已讀事件，標示暫停與錯誤；成功重試清除錯誤。
  初始讀取失敗後仍重試快照，不能把未初始化狀態當作已讀游標。
- 保留共享 SSE、可見性暫停、失敗退避與定期補讀。SSE 重連或頁面重新可見時立即補讀。
  讀取中離開查詢，等待中的 reload 回 false；不更改已提交寫入的 applied 結果。
- `NodeEventHistory` 內部按 nodeId 擁有預覽、展開、ink 衍生資料與復原回饋。
  側欄和單筆歷史頁不必理解這些重置步驟。全域 `EventLogPanel` 的主動選取預覽仍依原有事件 ID 執行。
- 全域種類篩選保留目前選項，即使載入中或結果為空；否則 DOM 的下拉選單會錯顯 All types，
  而實際請求仍帶 TAG_APPLIED。兩個篩選器補上可辨識的 accessible name。

### 前端布局

- 真實手機 viewport 中，原全域歷史把事件種類、標題、時間與透明操作按鈕塞在同一行，
  兩個標題只剩數個字，觸控也沒有 hover 可以顯示操作。
- 全域歷史在窄螢幕／無 hover 裝置改成事件種類、目標、操作三行，完整換行；
  手機隱藏與操作者下拉重複的 Agent only 快捷按鈕，仍可由下拉選 AI agent。
- 筆記歷史將還原控制放在內容下方；兩個入口的還原／展開至少 44px 且可見。
  桌面保留既有緊湊布局，新增 focus-within 顯示操作。載入筆記歷史有安靜的「載入中」狀態。

### 實際驗證

使用真實前端、API 與隔離 `onden_browser_test`。HTTP 測試 wrapper 只延遲或替換歷史 GET 的回應；
建立、套用標籤、預覽、確認復原、SSE 與重新載入均走實際流程，沒有偽造寫入成功。

| 情境 | 觀察結果 |
| --- | --- |
| 桌面 1365×900，A 回應延遲 12 秒，A → B | 修正前串入 A 的歷史；修正後載入時無舊列，舊回應到達也保持 B |
| 全域 User 回應延遲 12 秒，改選 System | 保持 System 的空結果，不混入 User 歷史 |
| 已載入 99 筆事件，刷新回 503，再恢復 API | 99 筆保留並顯示 Paused；手動刷新後 Live，錯誤清除 |
| 種類篩選 TAG_APPLIED 的讀取延遲 | 修正前顯示 All types；修正後維持所選種類，舊列清空 |
| 手機 390×844，A 在 20 秒後回 503，先切到 B 的資訊頁 | A 載入中有提示；B 的 5 筆事件保持正確，未出現 A 的錯誤 |
| 手機全域歷史撤回標籤移除，提交後歷史讀取延遲 3.5 秒 | 等待時顯示正在復原；刷新後關閉，增加一筆 TAG_APPLIED |
| 手機筆記資訊再次撤回剛才的套用 | 成功後關閉並顯示回饋；另一分頁的全域歷史自動增至 101 筆，首列 TAG_REMOVED |
| 資料庫核對 | 該測試筆記事件 96–101 與畫面相符，review 關聯為 0；本文仍是「第一版：這段文字必須保留。」 |

新增回歸涵蓋晚到成功／失敗、A → B → A、舊 reload、離開時取消與等待結果、同查詢刷新失敗、
初始／增量／快照排序、讀取中的 tick、since=0 多頁、初始失敗重試、重連／可見性、
筆記預覽歸屬與篩選載入／失敗／空結果。最初的 9 個核心案例在舊程式全部失敗；修正後通過。

手機檢查是 viewport 與滑鼠／鍵盤操作，並非真機或觸控鍵盤測試；沒有宣稱全站功能測完。
本批不修改後端權限、事件格式、交易或復原衝突規則，沒有重跑完整後端整合測試。
既有跨重載冪等狀態、政策快照競態和完整歷史分組的限制仍在；本批只保證讀取與畫面歸屬。
讀取不新增 timeout 政策，同查詢的後續刷新仍須等待進行中的網路請求完成或離開查詢取消。

最終前端回歸：172 檔／1,213 項通過（本批新增 15 項）；TypeScript、ESLint、build 與 diff 空白檢查通過。
桌面另以 Tab → Enter → Escape 驗證預覽取消與焦點返回；手機重載後文字及標籤結果與資料庫一致。
量測兩個手機入口的操作高度 44px、opacity 1，頁面無水平溢出；桌面保持 1365px 內。
修改 hook 期間開發伺服器曾因 HMR 沿用舊 hook 順序報錯，完整重載後重新驗證；
注入的 503 屬於本批故障測試，不能將它算成正式 API 失敗。測試後已移除所有延遲與故障設定。

執行紀錄位於 `/tmp/onden-live-20260912/`：`history-red.log`、`history-final.log`、
`frontend-full-final.log`、`tsc-final.log`、`lint-final.log`、`build-final.log`。
這些暫存紀錄可能於重新開機清除；可重跑的行為案例已收進 `packages/frontend/src/test/useLiveEventLog.test.tsx`、
`nodeEventHistoryScope.test.tsx`、`eventLogPanelFilter.test.tsx`。

## 第五批：保存版本與編輯器一致（2026-09-12）

### 使用案例與實測發現

本批處理筆記側欄、完整「時光回溯」及全域 Versions 列表的保存版本復原。
完成條件：保存前的草稿不遺失，復原後編輯器與已讀伺服器結果一致，失敗仍可檢查及重試原版本。

2026-09-29 入口整理後，`NoteVersionHistory` 擁有資訊欄最近三筆版本及浮動比較視窗。
點選版本先捕捉清單與預選 ID，再載入 `HistoryView`；不提供行內還原。
視窗關閉只作用於本次 opening，避免舊還原的晚到回應關掉另一筆筆記的新視窗。
舊 TimelineLens／URL 保持相容，版本 writer、草稿準備與拒絕後重試契約維持不變。
遷移驗證見[資訊欄精簡歷史](../archive/inspector-history-2026-09-29.md)。

在真實瀏覽器及隔離資料庫重現三個問題：

- 完整視窗送出復原立即關閉；API 回 503 後只剩通知，原預覽已丟失。
- 全域列表直接 POST 復原第一版，資料庫已是第一版，切回編輯器仍顯示第二版。
  此入口繞過了現有筆記 writer 及草稿調和，下一次保存可能重新覆蓋復原內容。
- 草稿保存成功會刷新 session 列表；同一操作者的連續保存被合併後，原選取的 ID 消失。
  再遇到復原 503，視窗仍開著但正文空白、沒有選取列，復原按鈕停用，無法重試。

### 方案、責任及相容行為

| 方案 | 呼叫者需要知道什麼 | 取捨 |
| --- | --- | --- |
| 各入口分別保存、POST、更新編輯器並刷新 | 草稿生命週期、寫入順序、提交與讀取失敗的差別，以及何時可關閉 | 三個入口容易繼續分歧；不採用 |
| 共用 `useVersionRestore().restore(nodeId, versionId)` | 等待 applied／refused，依結果呈現預覽與回饋 | 選用；原 writer 與草稿模組繼續擁有各自的知識 |

呼叫範例：`const result = await restore(nodeId, versionId)`；只有 `result.status === "applied"`
才可關閉依賴成功的視窗。hook 只組織草稿準備、領域 writer 與可呈現結果；
`makeNoteHistoryWriter` 繼續擁有序列化、冪等鍵、提交後讀取及本機副本調和，未新增第二套保存機制。
writer 已回報的錯誤不再增加第二次 toast；拒絕回傳共用錯誤訊息，保存準備未完成則提示保留草稿。

- 草稿準備只等待目標筆記的 pending／active save；恢復另一筆記不強迫保存目前無關的草稿。
  準備期間的新輸入中止這次復原，送出後的新輸入保留並按既有三方合併規則保存。
- `undefined` 仍代表已提交、結果未讀取，不替換草稿；回 applied 並要求刷新。
  同一 writer 生命週期中的讀取重試及模糊網路重試沿用既有契約，沒有新增跨重載持久化。
- `useOverviewMode` 在目前筆記的 `updated_at` 改變時讀取版本，回應綁定 nodeId，
  切換時不呈現另一筆記的版本。此 hook 和 Builder 不再持有預覽 ID 或傳遞復原 callback。
- 預覽與列表分開擁有生命週期。比較停用 session 合併與保留已開啟快照後，選用快照，
  保留既有五分鐘分組與每次保存的原始歷史。完整視窗的歷史列表固定於開啟時，重新開啟讀取新列表；
  Current 仍訂閱即時草稿，且只在視窗開啟時讓 inspector 訂閱輸入，保留平常的按鍵渲染隔離。
  側欄自己保留選取版本的內容及 ID，即使它被合併或移出前五筆；切換筆記即清除。
- 完整視窗使用 portal，等待期間禁止關閉及重複送出；拒絕保留內容、恢復按鈕和焦點。
  Tab 留在視窗內，Escape 可在非等待時關閉，關閉後還原焦點及背景捲動設定。
  手機版本列表移至正文上方，差異正文 14px、主要控制至少 44px；提高新增文字的對比。
  全域 Versions 在手機分開標題與操作行，顯示 restore／展開，桌面鍵盤 focus 也顯示操作。

### 實際驗證

沿用 `onden_browser_test`，操作透過真實前端與 API；測試 wrapper 只在指定方法／路徑
延遲請求或回覆 403／503，或延遲真正提交後的回應，不偽造成功寫入。

| 情境 | 結果 |
| --- | --- |
| 桌面 1365×900，完整視窗復原 503，再恢復服務 | 失敗保留預覽；同一視窗重試成功後關閉 |
| 桌面全域列表復原第二版，切回編輯器 | 立即顯示第二版，修正原本只有資料庫改變的情形 |
| 側欄復原前保存延遲 15 秒 | 第三版先保存為事件 106，再以 107 復原第一版；草稿仍可由原始歷史讀取 |
| 保存延遲 20 秒，等待時輸入第六版 | 復原準備取消；事件 109／110 保存第五／六版，沒有多出復原事件 |
| 復原真正提交後延遲回應 15 秒，再輸入第七版 | 事件 111 復原、112 保存第七版；編輯器保留第七版。既有三方合併另記 113 BODY_CONFLICT，沒有變更其政策 |
| 手機 390×844，保存回 403 | 停止復原、保留第八版草稿；Current 可讀到尚未提交的文字 |
| 手機保存成功、復原 503，session 合併原版本 | 修正前空白且不能重試；修正後仍選取第九版，錯誤清楚且按鈕可用 |
| 原預覽重試成功 | 事件 116 保留第十版草稿；117 明確復原事件 115 的第九版，未被新列表改換目標 |
| 手機全域列表再復原第十版 | 事件 118 的 version_id 為 116；重新載入後版本閱讀及作者檢視皆是第十版，資料庫一致 |
| 等待中實際按 Escape；拒絕後 Tab／Shift+Tab／Escape | 等待時保持視窗及停用關閉；拒絕後焦點循環，關閉返回「時光回溯」 |
| Read、Authorship、Changes、並排差異及比較基準 | 內容與選取版本相符；320×720 時無水平溢出，恢復按鈕仍為 44px |

390px 全域列表的 restore／展開實測高度 44px、opacity 1；完整視窗背景鎖定時頁面寬度 390px。
320px 完整視窗寬 296px、正文保有可捲動空間；桌面仍是左右配置。

前端完整回歸 **174 檔／1,222 項通過**，本批新增 9 項；TypeScript、ESLint、build 通過。
新增測試涵蓋共用復原結果、重複請求、提交後讀取缺失、預覽保留、版本合併、切換筆記、
焦點及捲動恢復；既有草稿、離線與 history writer 的重試測試亦重跑。
紀錄：`/tmp/onden-live-20260912/version-{targeted-final,frontend-full,tsc-final,lint-final,build-final}.log`。

測試後已清除 wrapper 的延遲與故障設定。本批只有前端及文件變更；403 是故障注入，
不能當成後端撤權政策測試，也沒有重跑完整後端整合測試。
手機驗證使用 viewport 與滑鼠／鍵盤，沒有真機、觸控鍵盤或全站全部功能的驗證。
版本列表仍有原有的分組與讀取上限，已開啟視窗不自動納入新版本；重新開啟才取得新列表。
本批不改變後端版本覆蓋語意、事件反向操作、權限、交易、同步或跨重載冪等限制。
最終清除故障設定、恢復預設 viewport 後完整重載，編輯器與資料庫皆為第十版，沒有新的前端錯誤。

## 備份還原的報告與中途失敗（2026-11-14）

（備份還原的規則表在 [backup-move.md](backup-move.md)：任務與檢視的列在「一般還原現在保證的」。）

- `RestoreReport`（`@onden/contract`）多了 `tasks`、`views`（帶回幾個）與 `skipped.tasks`／`views`／`attachments_too_large`／`attachments_unreadable`／`attachments_not_yours`（沒帶回幾個與原因）。
  畫面（`FullBackupSetting` 的 `RestoreResult`）把每個非零的數字用白話列出，沒有 id 或代碼。附件的三種原因：超過該類型大小、類型不允許或內容損壞、
  檔案在本機缺而且是別人上傳的（還原者不能補）。
- 還原中途失敗（或伺服器重啟時 `failInterruptedRestoreJobs`）會先逐筆復原、再 `discardAbandonedRestore` 清掉殘留。清掉的「永久刪除」現在只用在
  「這次還原建立、且還原開始後沒有任何其他事件提到它或它底下的筆記」的筆記（連同整個子樹都要符合，檢查與刪除在同一個事件鎖內）；
  有人後來編輯過、或在底下新增了筆記的，留在「歷史」（垃圾桶）裡，並在伺服器日誌記下「留了幾篇」。可疑就留著。
  限制：沒有新增資料表欄位，所以「留了幾篇」只在日誌，不在工作的紀錄列上；復原本身（`restoreNodeUndeleted`）仍照既有規則把底下後來新增的筆記一起放進垃圾桶（可從歷史救回），不會永久刪除。
- 「哪些種類有帶、哪些沒帶」的唯一清單在 `test/helpers/backupInventory.ts`；`backupFidelity.integration.test.ts` 讀資料庫與登記表，
  有新的節點種類、屬性來源、檢視版面、任務狀態或「有筆記欄位的資料表」沒在清單裡就失敗。清單目前誠實列出的缺口：側欄的筆記指標（`note_pointers`）還不在備份裡。

## 復原也是一個版本（2026-11-22）

復原一個內文事件是一筆新的寫入，所以也鑄一個新的版本（migration 220；`services/eventRestore/restore.ts` 呼叫 `spine/noteVersions.ts` 的
`recordVersion`）。版本記下它放回的是哪一版：被復原的事件之前、這台最後記下的那個版本，前提是內容相同；不同就留空。
寫回的內容和現在一樣時不鑄版本，事件照舊。契約不變：依目前權限執行、保留原歷史、衝突照舊拒絕。
復原一個手寫事件（`eventRestore/attributes.ts`）也鑄一個新的版本，單位是該屬性鍵（`ink_data`／`board_ink`／`note_ink`），內容雜湊是寫回那張畫的
`value_ref`；復原到「沒有畫」鑄 `removed`（沒有內容），其餘是 `restored`。`restored_from` 記被復原的事件當初取代的那一版（`versionBeforeEvent`，
和內文復原同一條規則：內容相同才記）。同一交易裡復原再重做，鑄兩個版本、序號 1 和 2。這是 2026-11-22 業主「都按建議」的決定；
先前這條路徑只記在 `sync_clock.version_misses`，現在正式路徑應為 0（`noteVersions.integration.test.ts`）。
