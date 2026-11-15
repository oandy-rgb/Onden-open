# 標籤操作與當前身分（2026-09-29）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `b49de57`。本批處理標籤成員、背景派生，以及寫入等待期間的身分撤權。
它是標籤承載功能之前的授權修正，不新增動態模組平台、不改既有角色預設，
也不把所有功能盤點項目改成通過。程式與本紀錄的提交可由 Git 歷史追溯。

## 設計選擇

標籤操作比較兩案：只抽授權 helper，仍由 REST/MCP 各自排列 SQL、事件、
template/default；或讓 `applyTagToNode({ workspaceId, actor, nodeId, tagId })`
與 `removeTagFromNode(...)` 擁有完整使用案例。選後者。呼叫者只需知道結果是否
改變成員關係；缺少 live 資源回 404，拒絕與儲存錯誤由共用 HTTP 邊界處理。
已有／沒有關係的 no-op 仍先授權，不重跑 automation。

身分重驗比較每個入口另查 actor/token 與共用既有 read snapshot 查詢。
選後者：`resolveCurrentActor(authenticated, workspaceId)` 只信任已驗證的
actor/token ID；role、human scope、token scope、token owner／到期／撤銷
全部重讀。read snapshot 在原快照內使用；寫入在事件鎖內使用。沒有「找不到
資料列就相信舊 ActorCtx」的相容旁路，也不修改其他請求共用的原物件。

`mutate` 的根操作、獨立 cascade、復原、筆記更新／副本及標籤領域操作使用
當前身分。MCP registry 以執行上下文保留實際工具名，鎖後重驗目前
`allowed_tools`；內部巢狀工具不能遮蔽外層限制。不將搜尋與外部 I/O 全部包入
持有工作區鎖的長交易。

重啟補跑也從已提交的觸發事件核對工作區、操作者、節點與 token，再恢復
工具上下文。token intent 的舊事件若缺少可驗證工具或 token 歸屬資料，記錄
失敗並消耗 intent，不放寬成無限制重播。這項保守拒絕只影響背景派生，
不刪除先前保存的正文。

## 可觀察契約

- 標籤套用／移除同時要求目標的 read、write_node、祖先政策，帳號與 token
  範圍的交集，以及標籤本身的 apply／remove 能力。標籤自己的節點治理與
  schema 中套用到成員的政策仍為不同責任。
- 保留既有 token 對完全無標籤普通筆記的首次套用能力；不豁免目標或祖先政策、
  不豁免 human scope。task 的 scope 仍由宿主筆記承擔，不能靠 task 本身新標籤擴權。
- 範圍外的筆記不能靠套上範圍內標籤變成可寫。過去漏掉檢查而成功的操作，
  現在拒絕。一般 API 與 MCP 共用這個結果；公開 bearer 原本仍限 MCP，
  測試中的 REST token injection 只是內部防禦驗證。
- MCP 建立筆記在同一鎖內決定建立能力、scope、parent 與 dry-run 結果。
  human 或 token 有標籤 scope 時，都須提供落在所有有效範圍內的標籤；父層
  須可讀且可寫。標籤與父層均須是同工作區的 live 節點，不能引用別的工作區。
  這收緊了先前漏檢的建立入口，不更換一般角色與標籤政策的預設授權語意。
- 成員關係、epoch、成功事件及同步執行的附帶寫入共用交易；拋出失敗就回滾。
  既有 template 逐 slot 略過、`CASCADE_DENIED` 診斷等語意未改，不能把成功套用
  解讀成每個附帶效果都已完成。
- 正文保存後的背景派生是下一筆操作。即時 queue 與 catchup 都先取事件鎖、
  查驗當前身分和節點 write_node，再寫正文屬性與 frontmatter。派生失敗不撤銷
  先前已確認的正文保存；失敗審計與成功變更有不同語意。
- 主寫入拒絕不留下成功事件或有效的成功冪等標記；背景派生拒絕不留下它的
  屬性／成功事件。先前已提交正文的確認與冪等標記仍有效。查驗失敗不退回舊權限。

## 本輪重現與驗證

環境為本機獨立 `onden-authority-test`、PostgreSQL `onden_test`，限制一顆 CPU、
512 MiB；測試單 worker。所有撤權、故障與競態僅使用隔離測試資料。

身分查驗不再接受僅存在於測試記憶體的假 actor ID，因此既有整合 fixtures 改成
先保存真 actor/token，再注入驗證情境；後續撤權明確修改資料庫，保留舊 context
來驗證重新查驗。只隔離事件／政策接線的純單元測試可 mock 身分讀取，整合測試
沒有「找不到就放行」旁路。組合案例另外使用每輪獨立工作區，避免舊資料擠滿
今日清單的 50 筆上限。50 請求併發仍維持原規模與斷言，測試等待上限改為
15 秒以容納單 CPU；agenda 的一秒效能斷言未放寬。

修正前保留的紅測：

- catchup 5 個新案例：3 個拒絕案例失敗、2 個允許案例通過。human scope 縮小、
  或 token owner 已不符時，仍留下正文解析的 `status` 屬性。
- 標籤 22 案：17 失敗、5 通過。讀寫政策、human scope、等鎖期間政策收緊與
  dry-run 拒絕均錯誤成功。最早測試 fixture 的 SQL 型別錯誤已修正，不算產品缺陷證據。
- 寫入身分 7 案：7 失敗。降權、縮 scope、撤銷／到期 token 後仍成功；刪除
  actor 落到資料庫錯誤；舊 viewer 快照也無法取得已授予的新權限。
- MCP 建立筆記 10 案：7 失敗、3 通過，涵蓋等鎖期間 scope 改變、human scope、
  dry-run 與父層政策。另補的跨工作區父層／標籤 2 案在修正前均錯誤成功。

主要回歸入口：

| 情境 | 角色／scope 與預期 | 證據 |
| --- | --- | --- |
| 標籤套用／移除 | REST 與 MCP 的 editor 同時受節點、祖先與標籤政策，以及 human/token scope 限制；允許、拒絕、no-op、dry-run、故障回滾、task 宿主 scope | `tagMembershipAuthority.integration.test.ts`，23 項 |
| 寫入等待中權限改變 | 真連線阻擋事件鎖；角色、human scope、token scope／撤銷／到期與工具 allowlist 以取得鎖後狀態為準；新授權也能生效 | `actorWriteAuthority.integration.test.ts`，9 項 |
| 建立筆記 | token 或 human scope 要求合法標籤；parent 須可讀寫；外工作區 parent/tag 拒絕且無成功建立 | `createNodeAuthority.integration.test.ts`，12 項 |
| 背景派生與重啟 | 正常派生可完成；actor/token 歸屬、scope 或工具權限失效時，屬性與成功事件不落盤，失敗另記審計 | `dispatcherCatchup.integration.test.ts`，16 項 |
| 工具上下文 | 並行請求隔離、巢狀保留外層工具限制、registry 拒絕 | `toolAuthority.test.ts`，6 項 |

完整後端回歸：219 檔、1,853 項全部通過，零略過；包含上述案例、真 PostgreSQL
整合、讀取快照、復原、同步撤權、匯入、複習、RSS 與 outbox。單 worker 耗時
516.85 秒。兩端 preflight、lint 及前端 production build 已通過；最終後端
typecheck、lint、production build 亦通過。

前端完整回歸跑完 204 檔、1,607 項：1,605 通過、2 失敗、零略過。兩個失敗
均為先前導覽改名後留下的 `Editor／編輯器` 舊斷言；對照既有產品的
`Content／內容` 修正預期後，`navLabelsI18n.test.tsx` 的 4 項及該檔 lint
重新通過。前端產品程式未修改，其餘 203 檔不重跑；原始完整報告與局部重驗
分開保留。

隔離 full-stack Chromium：`tagContracts`、`tagMergeUI`、`tagSafeDelete`、
`liveUpdates`、`noteDuplicateContract`、`historyJourney` 共 18 項全通過、零略過，
耗時 1.8 分鐘。單 worker，瀏覽器限制一顆 CPU、1 GiB，其他測試服務各設
CPU／記憶體上限；從最新本機編譯產物掛入既有 runtime，避免重建全部映像。
測試涵蓋標籤 automation、MCP 拒絕、連帶復原、公開讀取政策、跨分頁同步、
標籤合併與垃圾桶復原、版本視窗，以及 1280px／320px 複製筆記後重載。
只在 `localhost:5099` 的專用 `onden_test` 與測試帳號寫入。

原始紅／綠測報告、完整回歸與瀏覽器截圖保存於本機
`.acceptance/tag-authority-2026-09-29/`（不入 Git）。這次沒有 schema migration。

## 交付

修正提交 **`d87466e`** 已推送 `origin/main`，VPS 後端已部署同一版；前端沿用
`7795c3e` 的既有畫面。`/srv/onden/current` 指向 `/srv/onden/releases/d87466e`。

部署前備份 `/srv/onden/backups/manual-20260928194209`（UTC 命名）的 DB 與
content checksum 均通過。DB 在拋棄式 `onden_restore_test_d87466e` 還原成功，
包含 12 個節點、46 個事件；content tar 也實際解開到拋棄式資料卷。完成後
兩者均清除。備份目錄 0700、兩個備份檔與既有 `.env` 0600，未輸出秘密。

只重建後端並 reload nginx；四個服務 running，PostgreSQL healthy。後端健康
端點 200，VPS 與工作機的 MagicDNS／Tailnet IP 首頁 200，未登入 bootstrap
維持 401。`currentActor`、`tagMembershipWrites`、`createNode`、
`dispatcherQueue`、`mutate` 五個編譯檔 SHA-256 與本機驗證產物完全一致。
舊後端映像保留為 `onden-vps-backend:before-d87466e`。

正式站只做讀取檢查；寫入、撤權及故障驗證均在隔離環境完成。本批測試容器、
網路與資料卷已移除。不以這次 GAP 修正推進 163 項總表的整體完成數。

## 邊界

身分重驗不等於再次驗證 session cookie，也不建立新的政策語言。交易內
權限一致性依賴既有治理入口共用工作區事件鎖；不宣稱任意外部 SQL 都遵循該鎖。
`mutate` 只核對操作宣告的能力，不會自動重算呼叫者先前作的業務判斷；本批
另將 MCP 建立筆記的 scope、parent 與 dry-run 檢查移入鎖內。這不等於所有
舊讀取入口、鎖外前置判斷與模板 slot 的獨立回滾皆已盤完。
本批未實作模組依賴、衝突解決、per-user 複習進度或 TagPack 升級。
