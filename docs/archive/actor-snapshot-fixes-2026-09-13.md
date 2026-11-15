# 同步操作者授權的快照修復

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-13。基線：`0e93619` 加前批尚未提交的三份審核紀錄變更。
案例：PER-03／PER-04、GAP-04 的 actor 新鮮度部分。本批未提交 git、未修改使用者資料庫。

## 問題與重現

第十三批已將同步資料放入同一 DB 快照，但角色與 allowlist 仍來自之前解析的 ActorCtx。
session 查 actor 後、sync 開始快照前若被降權或縮 scope，舊物件仍可能讀到後來的新內容。
native 路徑的 actor 還有一分鐘快取，且其查詢沒有取 human scope。

在新建隔離庫 `onden_actor_snapshot_test` 中建立真實 actor、政策標籤與兩筆筆記：
一筆需 admin，另一筆保留可讀。測試先讓請求取得舊 ActorCtx，暫停在快照開始前；
另一條連線透過真正的 actor PATCH 在事件交易中降權／縮 scope，並更新受限筆記正文。

修正前 GET delta、POST delta、membership、by-id 各兩種變更，共 **8 案失敗**：
仍帶出受限節點。該次使用測試名稱篩選，另 10 案未執行，不能算通過。
這會讓已移除的讀取授權繼續生效；沒有正式環境已遭讀取的證據。

## 設計與責任

| 草圖 | Caller 必須理解 | 取捨 |
| --- | --- | --- |
| `withReadSnapshot` 內自行載入 actor／token | 所有權、workspace、有效期、缺失結果、哪些舊欄位不可信、使用哪份 actor | 每個入口可能漏一項或在快照外先取值 |
| `withActorReadSnapshot(authenticated, ws, current => …)`，採用 | 傳可信任身分，使用 callback 的 current；依原有 readPolicy 讀資料 | 一個模組擁有重新核對與快照的完整順序 |

`services/actorReadSnapshot.ts` 使用已有的 `withReadSnapshot`，第一個查詢重新讀 actor 的
目前角色、類型、名稱和 human scope；如果帶 token ID，同一查詢也核對該 token 的 owner、
存續、有效期與 allowlists。不接受客戶端任意提供角色，也不把缺失 actor 當成匿名 viewer。
重新核對的是可信任入口的 actor／token ID，不是重新驗證 cookie 或原始 bearer 字串。

缺失 actor、workspace 不符、已解析 token 的引用被刪除／撤銷／過期／換 owner，
沿用 `UnauthorizedError` → 401。未知 DB 例外沿用 500，禁止回退舊的角色或 scope。
原有角色政策、祖先限制與 token ∩ human scope 仍由 readPolicy 判斷，未重寫政策。

已遷移 GET／POST `/sync`、GET `/sync/membership`、POST `/sync/nodes`，包含空 ids 與
known 超限的回應。路由改用 callback 的 actor，沒有再配置 token 查詢、欄位對應或有效期規則。
正式 app 仍把 bearer 憑證限制在 MCP；底層支援 token recheck 不代表新增 bearer sync API。

## 可觀察的保證

- 降權、縮 scope 或 token 撤銷在第一個 actor 查詢前提交，本次就採用目前結果。
  角色提升與 scope 放寬也採用新結果，不會被舊的較低權限永久限制。
- 若在 actor 查詢之後才提交變更，進行中的回應可用舊授權讀同一快照的舊內容、舊 epoch。
  新內容不能混入；下一請求重新核對。這不等於取消所有進行中的讀取。
- native 快取仍可辨識 actor ID，但這些同步端點會重新載入其角色與 human scope。
  actor 已被移除時拒絕讀取，不能因快取還有名稱而成功。
- 只有權限篩選縮小時，保留可讀的筆記仍正常同步；legacy known[] 撤權刪除及 membership
  expectation 契約保持不變。沒有把正常拒絕或未知故障偽裝成成功的空資料。

## 驗證

使用專案 schema 建立新的隔離 PostgreSQL 資料庫，測試以 barrier 控制交錯。
actorSnapshot 的 actor、token、scope、policy、正文、事件和交易都是真實資料庫資料。
完整 app 的 session 案只替換登入票據辨識；後面的 actor 查表與 name 更新仍執行真實程式。
native 案執行真正的快取路徑；暫借隔離庫的 System 身分，結束後復原既有 System 標記。

| 執行 | 結果 |
| --- | --- |
| 新增 actorSnapshot 24 案 | 通過；包含 8 個降權／scope 競態、提升、刪除／跨 workspace／匿名、token 存續與交集、快照後提交、完整 app session／native、MCP 限制及故障 |
| 後端專項 7 檔 | 84 項通過，包含既有 read snapshot、membership、sync revocation、HTTP 與完整 app 權限矩陣 |
| 完整後端 | 210 檔／1,740 項全通過，0 跳過，114.85 秒 |
| 前端同步契約 | membershipReconcile／useAppDataSync，2 檔／20 項通過 |
| 靜態與建置 | 後端 TypeScript、lint、build 通過 |

原有 11 份 mini-router suite 使用不存在於 actors 表的測試 ActorCtx，以測資料政策／projection。
本批明確保留其身分注入，使用測試專用 `injectedActorReadSnapshot`，仍跑真實 DB 快照與政策 SQL；
這些案例不算 actor freshness 的證據。新 actorSnapshot 與完整 app 權限矩陣使用正式刷新模組，
沒有在正式程式中加入 synthetic ID、查不到 fixture 時放行或測試模式分支。

執行紀錄在 `/tmp/onden-actor-snapshot-{red,targeted,backend-full,frontend,types,lint,build}.log`。
`/tmp` 不是永久保存；可重跑 [actorSnapshot 測試](../../packages/backend/src/test/actorSnapshot.integration.test.ts)。
本批沒有瀏覽器、真機、實際 cookie 登入／撤銷或本機 mirror 清除的端到端驗證。

## 剩餘範圍

GAP-04 仍為部分，不能把這次同步入口的保證推及全專案：

- bootstrap、其他讀取、MCP 工具、寫入及 cascade 的 ActorCtx 新鮮度未遷移。
  native 原有快取仍存在於其他入口；本批只隔離它對同步 role／scope 的影響。
- cookie 本身的失效、身分解析 fallback、actor 自動建立仍由既有 auth 擁有。
  移除 actor 不等於實作帳號停用；後續登入是否重新建立 actor 不在這批契約內。
- membership 多頁建立／刪除、游標交接、SSE 遺失、離線冷啟動、重連與本機撤權清除仍待完整驗收。
- 新增一次 DB actor／token 查詢；未做代表性大型工作區效能量測，沒有宣稱查詢更快。

邊界決定見 [AGENTS 第十四批](../../AGENTS.md)，目前覆蓋見 [完整盤點清單](../research/full-feature-audit.md)。
