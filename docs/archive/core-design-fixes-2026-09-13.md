# 核心設計缺陷修復 — 2026-09-13

> 狀態：歷史紀錄（最後確認 2026-11-01）

本批已修復 [核心審查](core-design-review-2026-09-13.md) 的五組缺陷（GAP-12～16）。
保留現有核心模型與未提交工作；沒有子代理、部署或日常資料庫遷移。
完成條件是原本六個交錯情境不再破壞授權、內容、樹結構、同步或新備份工作，並維持其他入口的行為。

## 修復結果

| 缺口 | 目前行為 | 回歸證據 |
| --- | --- | --- |
| GAP-12／C5 政策身分旁路 | 普通 node PATCH 將 class_tag 改成 content 回 422；受限筆記仍拒絕讀寫。舊歷史逆向實際進出 class_tag 須 principal_admin，force 不能繞過，成功增加 epoch | editor、管理員、delegated agent；正反兩種歷史轉換；一般內容欄位仍可編輯 |
| GAP-13／C1 鎖外授權 | mutate 取得工作區事件鎖後再查節點政策。排隊期間政策收緊，後續寫入拒絕且不留下成功事件 | REST PATCH 與沒有外層事件交易的直接 mutate 都驗證拒絕 |
| GAP-14／C2、C2b 舊狀態 | 目前值、merge、父層可讀性／循環檢查及 inverse 都在同一事件交易內 | 不重疊文字都保留；互相移動結果 200／400、無循環；兩次 scalar 修改可依序復原；agent 只改標題不覆蓋正文 |
| GAP-15／C3 同步跳事件 | 空頁保留輸入 since；非空頁回傳最後掃描事件 ID，移除較晚的 MAX 查詢 | 暫停真實空事件查詢後提交更新，第一頁不推進，下次收到更新 |
| GAP-16／C4 舊失敗結算 | done／backoff／dead 都以選取時的 xmin 核對工作版本。過期結果不更動新 payload 的重試預算與狀態 | 舊工作的可重試、最後一次失敗，皆保留新工作 pending／attempts=0；下一輪實際執行 v2 |

回歸實作在 [coreConsistency.integration.test.ts](../../packages/backend/src/test/coreConsistency.integration.test.ts)。
SQL、Hono 路由、交易、授權與合併皆使用正式實作；測試障礙只控制交錯順序。
外部 outbox performer 以測試函式替代，因此沒有把 GitHub／git 真實目的地列為已驗證。

## 責任與介面取捨

比較兩種筆記編輯介面：

- A：REST 與 agent 分別 `withEventTransaction → read → authority → merge → mutate → effects`。
  能修正時序，但每個入口仍須知道保存的全部步驟。
- B：`updateNode(ws, id, changes, { actor, baseMarkdown, ... })` 擁有完整操作。
  入口只解析使用者欄位與追蹤來源。選擇 B，兩個現有入口立即共用，沒有新建通用 callback 平台。

[`services/nodeUpdate.ts`](../../packages/backend/src/services/nodeUpdate.ts) 現在擁有讀取基準、授權、slug、
合併與逆向紀錄、結構守衛、事件、索引、outbox 和提交後 dispatcher。
相比原先兩個入口各自組合流程，之後改筆記保存契約只需在一處檢查這些協作。
`source` 僅表達 UI／agent 的追蹤來源，不能關閉權限或保存機制。

時序上比較「版本 CAS 後重算」與「沿用既有事件鎖」後選擇後者；沒有新增鎖平台、事件框架或 CRDT。
這是目前單工作區與個人負載下的設計取捨，沒有做效能量測，不宣稱吞吐量提升。

政策身分比較「普通 PATCH 額外加管理 gate」與「普通 PATCH 禁止轉換」後，選擇後者。
目前沒有需要這項轉換的正常 UI，因此不新增未使用的轉換 API。
舊歷史仍可由 principal_admin 依既有復原操作處理；讀歷史或建立內容副本不等於改變原節點政策身分。

## 保留與相容影響

- 保留 PATCH 只更動明確欄位、普通內容型別同值更新、cursor_state、冪等回應、版本與事件格式。
- 保留帶基準的不重疊正文合併；重疊修改仍用既有最後寫入 + BODY_CONFLICT／版本保留規則，沒有暗改成一律拒絕。
- 普通 class_tag → content 現在回 422（包括管理員），這是有意收緊的授權邊界。
- agent 的 title／markdown 保存現在也建立 backup／embed 意圖，版本事件帶完整解析後標題；
  title-only 仍不寫正文。dry-run 只預覽，正式執行會重新查狀態與權限。
- 先檢查來源節點編輯權限；來源與目的地都無權限時，現在由來源先回 403。
  有權修改來源但無權讀目的地仍回 404。既有父層測試補上來源 scope，避免把來源拒絕誤算為父層驗證。
- `NodeUpdateError` 的已知拒絕經 `httpError.ts` 映射；未知儲存錯誤仍向上傳遞。
  冪等 wrapper 包住本操作的交易；dispatcher 使用 afterCommit，不能在外層尚未提交時啟動。

## 驗證

- 新隔離資料庫 `onden_core_fix_test`，從目前 schema 建立；不使用含診斷循環的舊審查庫。
- 修復前新增的 7 個案例全部失敗，對應六個原始交錯與 outbox 的第二種失敗分支。
  修復後再補一般 mutate、agent、scalar 逆向、管理身分與相容案例，專項共 15 項。
- 最終完整後端：**204 檔／1,673 項通過，0 失敗、0 跳過**，136.26 秒。
- 前端保存／同步專項：**5 檔／58 項通過**，包含 useAppDataSync、noteWriter、writeQueue、membershipReconcile、versionRestore。
  本輪沒有改前端正式程式，未重跑整個前端測試集。
- 後端 TypeScript、lint、build 通過。架構門禁保留：BODY_CONFLICT 的合法 system 事件從路由移到領域操作，
  更新 allowlist 歸屬；同步 mock 移除已不存在的 MAX 查詢，沒有弱化投影斷言。
- 首次全套得到 4 個失敗，分別為上述舊查詢 mock 兩項、舊事件數一項及父層案例前提一項；調整後全套通過。
- 診斷腳本與 JSONL 保留作修復前證據，腳本已明註預期在修復後失敗，不能拿它當正常回歸。

### 瀏覽器實測

使用本機正式 app 路由（NODE_ENV=test 不啟動排程／外部備份）、另一個隔離庫 `onden_import_audit_test`，
虛構 editor 帳號，前端 5100／後端 18788。沒有改日常筆記。

- 桌面 1440×900：從介面建立筆記、編輯正文、按 Save，確認保存後按鈕停用、歷史更新；重載後文字仍在。
- 手機 viewport 390×844：在同一筆記追加段落、保存、重載；桌面與手機段落皆保留，捲到底可閱讀最後一段。
- 獨立 DB 查詢確認測試筆記 `2066409c-8c0b-4226-8f35-5294cb1fbc00` 的完整正文及 3 筆 NODE_UPDATED，
  因此不是只有記憶體畫面更新。
- 截圖檢查保存控制項與底部導覽；手機新帳號的歡迎區仍占較大首屏、長標題在單行欄位內截斷，
  本批沒有重新設計版面。這是 viewport／滑鼠操作，沒有實體手機、軟鍵盤或真雙裝置驗證。

## 剩餘邊界

本批封住已重現的五組缺陷，不代表全功能盤點完成。
ActorCtx 角色／token 取值的新鮮度、整份 sync 的內容／政策快照一致性（GAP-04）、
跨重載 online 冪等（GAP-05）、更外層回滾後 ambient claim（GAP-06）仍需獨立工作。
直接 SQL、外部 cascade 的完整遷移與真實 outbox 目的地、程序重啟也未在本批宣稱完成。

另在建立測試前提時觀察到：兩個 class_tag 改成同一父層下的同名標題，DB unique constraint 拒絕後目前為 HTTP 500。
資料沒有被重複保存；這是一般筆記 PATCH 編輯標籤標題的衝突回應缺口，列 GAP-17 待下一批處理，
不以修復本批併發契約為理由順便重做全部標籤操作。

後續進度：GAP-17 已於同日下一批修正，包含 REST／tag／agent 衝突映射與側欄改名保留輸入，
見 [標籤同名修復紀錄](tag-name-conflict-fixes-2026-09-13.md)。上段保留當批觀察時點。

後續進度：GAP-06 已由共用交易結果通知修正，見
[外層回滾與冪等修復](idempotency-rollback-fixes-2026-09-13.md)；前述 GAP-04／05 仍未於該批解決。

GAP-04 的單次同步回應部分已在同日後續修復，見 [同步快照紀錄](sync-snapshot-fixes-2026-09-13.md)。
ActorCtx 新鮮度、跨頁與本機清除仍保留未完成；不回填為本批已驗。
