# Membership 分頁、補資料與事件交接修復

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-13。延續 GAP-04，這批處理一個完整案例：同步在核對可讀集合時遇到
分頁間建立／刪除、補資料期間變更，仍須保留正確本機集合，並讀完交接事件才報完成。
沒有開子代理，也沒有重構其他領域。

## 實際重現與修正

1. **分頁中的新增被當成撤權。** 第一頁讀到 `a,c`，接著建立 `b`，第二頁從 `c` 往後讀；
   permission epoch 沒變，舊流程漏掉 `b`，再拿分頁後的本機集合比對，會刪掉本機 `b`。
   新測試在舊實作確實得到 `isolated = [b]`；修正後核對 event position，重讀全部頁面。
2. **已讀頁面的刪除留在本機。** 讀過 `a,b` 後刪除 `a`，舊流程仍把 `a` 算進可讀集合。
   第二個紅燈案例確實漏掉這次本機刪除；修正後重新分頁並隔離 `a`。
3. **補資料截斷卻保存 epoch。** 前端原本一次提交所有 newly-readable IDs，後端只取前
   50,000 個。對放寬權限後才可見的舊筆記，事件增量不一定再補回未下載的內容。
   現在每批 1,000 個，後端超過原上限明確回 413，前端也拒絕缺少要求節點／任務的投影。
4. **核對完成時仍有未讀事件。** membership 可以比先前 delta 看到更新的內容位置。
   現在回傳該位置給 sync，沿原 since 讀取期間的事件；不把 membership 的 MAX 當成確認。
   網路在這段斷掉，sync 回 `ok: false` 並保留 gate。

## 責任與相容性

比較過兩個方案：保留跨請求的資料庫快照 session；以及每次請求核對版本並有限次重試。
前者需處理長時間連線、session 到期與清理，本批選後者，沒有新增資料表或快照平台。

- `routes/sync.ts` 在既有 actor/data snapshot 中產生 `{ epoch, event_cursor }`。
  membership 與 by-id 接受對應 expected 值；不符時回 `retry_required`，空 channels 不代表撤權。
- `membershipReconcile.ts` 集中分頁、版本核對、批次大小、投影完整性、套用後最後確認與重試。
  呼叫者不用自行記住 50,000 上限、每個階段何時驗版本，或如何處理漂移。
- `useAppData.ts` 提供 HTTP 與完整投影保存，並在 sync 中負責事件交接和 gate。
  補資料仍沿用既有 localDb／appStore 的 channels 與游標。
- 撤權先於授予，未知錯誤向上傳遞；部分本機套用不宣稱全部成功。所有批次與最後核對成功才保存 epoch。
- 角色、token、人類 scope 與目前政策語意保持不變。單次回應仍使用上一批的 actor snapshot。
- 舊客戶端可省略 expected position，但沒有新保證；新客戶端遇到缺少版本的舊伺服器會停止核對。
  分開部署時先更新後端。

決定同步記錄在 `AGENTS.md` 第十五批；正式協定見
[同步協定](../architecture/sync-protocol.md)及[權限集合](../architecture/membership-and-permission-epoch.md)。

## 驗證結果

- **舊實作紅燈**：前端 same-epoch 新增／刪除兩案皆失敗，其餘案例刻意由測試篩選排除。
  記錄 `/tmp/onden-membership-pages-red.log`；這次失敗不是相依安裝或資料庫跳過。
- **新 PostgreSQL 協定測試：8 項通過。** 使用新建 `onden_membership_pages_test`，真實 actor、
  `mutate` 事件交易、membership/by-id/delta 路由。三個案例直接載入正式前端 reconciliation 模組
  操作這些路由；本機 mirror 用 Set 代替，不冒充 IndexedDB／OPFS 驗證。
  含同 epoch 建立、刪除、by-id 舊版本拒絕、policy epoch 拒絕、50,001-ID 超限拒絕，
  以及分頁重試／補資料後刪除／delta 仍讀到交接事件。最後補強此案例的真實 task、attribute、edge
  channels 後，8 項再次通過（`/tmp/onden-membership-pages-protocol-final.log`）。
- **前端同步專項：34 項通過。** 包含 50,001 筆的完整批次補資料、同 epoch hydration retry、
  套用後再次撤權、第二批斷線、缺失投影、分頁期間本機建立、舊版／錯誤格式回應，
  以及 sync 沿原 since 讀到或超過要求位置才解除 gate。大型補資料案例使用模擬 I/O，
  不宣稱已實測五萬筆真實資料庫的效能。
- **完整後端：211 檔／1,748 項通過，0 跳過**（182.78 秒）。
  `/tmp/onden-membership-pages-back-full.log`。
- **完整前端：180 檔／1,280 項通過，0 跳過**（67.18 秒）。
  `/tmp/onden-membership-pages-front-full.log`。frontend pretest 的通用 DB 提醒不代表這些前端測試有跳過。
- 兩端 TypeScript、lint、build 通過。前端建置仍有現有的 docs collection、Astro deprecated API
  與大型 chunk 提示；不把建置通過當成效能已改善。

## 瀏覽器檢查

在 `127.0.0.1:5100`，使用既有隔離 `onden_import_audit_test` 和核心修復測試帳號。
桌面 1440×900 與手機 390×844 viewport 重載後均能開啟既有筆記，沒有殘留權限更新遮罩；
手機資訊抽屜可開啟，標題與正文保留。桌面 clientWidth/scrollWidth 均為 1440；手機可用寬度
扣除捲軸後兩者均為 375，沒有頁面水平溢出。這次沒有改寫筆記，也沒有測真機或離線磁碟持久化。

一開始開發站出現 AppRoot 動態 import 失敗，停在初始 loading。完整建置完成後重新啟動
開發站並重載即可恢復；記錄為測試站載入問題，沒有將它算成 membership 故障或新增產品修復。

## 剩餘限制與下一個完整案例

GAP-04 **仍是部分已修**，不增加完整功能盤點的已盤數。清單維持 163 項：4 已盤、104 部分、
43 待盤、12 需環境。

- 未遵循 domain event／epoch 契約的直接 SQL 不會被這個版本組合全面追蹤。
- 同步非常繁忙時可耗盡重試；本批沒有宣稱持續寫入之下必定收斂或提高效能。
- 同一嘗試分頁開始後才在本機建立的 ID 不會被這次 revoke 差集刪除；嘗試前已存在的
  pending writes、跨重試建立及離線草稿仍需和撤權機制一起盤。這是下一個適合的完整使用案例。
- bootstrap merge／大 workspace resync、登入 cookie 本身的重驗、其他讀寫入口的身分刷新、
  多裝置與真機撤權後清除還沒全面驗證。
- event cursor 新讀取 guard 使用字串，但既有 delta 與本機 last_event_id 仍是 number；沒有進行全協定 bigint 遷移。
- 最後版本確認之後仍可能發生新撤權，既有 SSE、後續 sync 與重連檢查仍必要。
