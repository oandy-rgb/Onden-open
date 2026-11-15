# Onden 架構收斂計畫

> 狀態：歷史紀錄（最後確認 2026-11-01）

> 制定日期：2026-06-15
> 驗證狀態：**診斷 12/12、處方 10/10 盲測通過**（純碼 agent、禁讀 docs/memory、含魔鬼代言人、含「偶爾多人協作」偏 A 前提，仍全數收斂）。
> 方向部分不再論證，本文聚焦：做什麼、什麼順序、怎麼驗收。

---

## 一、定調（先釘死）

**定位：Onden 是 event-logged CRUD，不是 event sourcing。**

可變狀態表是真相源；`domain_events` 是寫入時原子產生的**下游副產物**（審計 / 逆 patch 撤銷 / 同步信號），**永不從 log 重建狀態**。

### 判斷尺（每個新設計／PR 過一遍）
1. 任何「同一個*可變*東西出現多份表示 / 多條寫入路徑 / 多處授權判斷」→ 收斂成唯一一個。
2. 不從 log 重建 state。**撤銷（逆 patch 退一步）要，重放（從頭重算）不要。**

### 北極星（收斂完成的標誌，任何代碼都能乾淨回答且都「是」）
1. 狀態從可變表讀（不手抄第二份投影）
2. 寫入過 `mutate()`（不繞 spine 直接 `event()`+SQL）
3. 讀取過授權層（不事後 `.filter(scope)`）

### 保留不動（對的，別碰）
spine 寫入閘 · `domain_events` 當審計＋逆 patch 撤銷 · inbox 治理 · content-hash blob 儲存 · 版本歷史（`/versions`：用事件攜帶的 `body_hash` JOIN content-addressed blobs 取回每一版的內容，是**版本快照／內容定址歷史**，不是從事件 log 重放重建 state 的真正 event-sourcing；運作良好，保留）。

### 明確不做
純 ES / projector / replay · 可變 CoW 應用層 · 客戶端從 event fold 狀態。

---

## 二、階段總覽

| 階段 | 目標 | 量級 | 依賴 | 風險 |
|---|---|---|---|---|
| **P0 止血** | 堵真洩漏／真丟資料 | 1–2 週，逐項獨立 | 無 | 低 |
| **P1 撕皮** | 刪假裝 ES 的死碼，降複雜度 | 幾天 | 無 | 低 |
| **P2 讀取閘** | 讀取授權收斂成單一強制層 | 2–4 週 | 無（可與 P1 並行） | 中 |
| **P3 寫入貫穿** | 所有寫入收回 spine | 2–4 週 | 最好 P2 後 | 中 |
| **P4 結構債收尾** | node 統一、FK、測試守門 | 持續 | P2/P3 後 | 低–中 |

---

## 三、各階段詳細

### Phase 0 — 止血（立即，與架構無關，逐項可獨立 merge）

安全洩漏：
1. `GET /api/git/diff/:hash`（`routes/publish.ts`→`git.ts`）— 洩漏全部受限筆記全文。加 role gate + 讀取過濾。
2. `GET /api/snapshots` — 加 role gate（目前僅洩 metadata）。
3. `GET /api/nodes/block/:blockId`（`nodes.ts:85`）— 補 `canReadNode`。
4. collection item 屬性整包進公開 payload（`services/collections.ts:212`、`publishing/collections.ts:181`）— 加欄位級 allowlist（只露 `schema.fields`）+ 對 item 文本套 `inertUnpublishedWikilinks`。
5. `GET /api/share/:token`（`publish.ts:189`）— 補 `checkSiteAccess`（或明確定義 share=公開豁免並寫下）。
6. `routes/import.ts:197`（現 `modules/importers/`） — 圖片落盤移到 `assertAuthority` **之後**；`.svg` 過 `sanitizeSvg`；加大小 cap。
7. `routes/pointers.ts:43` — 建 pointer 指向 target 前補 `canReadNode(target)`。
8. `readPolicy.ts:36` `depth<10` — 改成遞迴到根（或迭代），消除超深子樹 fail-open。

丟資料 / 成本：
9. 離線 flush 死碼（`persistScheduler.ts:82` 在 worker 內 early-return）— 主執行緒 `pagehide`→postMessage→worker `flushSync()`。
10. `/api/ai/ask` 與 `/api/ai/transform`（`ai.ts`）— 加 rate limit + role gate。

縱深（可降級到 P4）：全站安全標頭（CSP/nosniff/X-Frame-Options）· `svgSanitize` 處理 `<style>`/`@import` · SSRF IPv6（NAT64）· 登入 rate limit。

**驗收：** 每個洩漏端點有 integration test 證明受限 actor（viewer / 越 scope token）拿不到；離線編輯→關頁→重開，資料在（e2e）；AI 路由超限返回 429。

---

### Phase 1 — 撕皮（刪假裝 ES 的部分）

1. 確認 `foldClientEvents`/`applyClientEvent`（`eventLog.ts`）**無生產消費者**（盲測已確認只有測試呼叫），刪除 client event log 軌：`mintEvent`（散在 26 處）、client domain-event 表、`markSynced` 鏈。
2. 客戶端簡化成兩軌：**可變鏡像（權威來自服務端）+ `pending_writes` 寫隊列**（本來就是，刪掉並行 event-log 軌）。
3. 刪 "replay produces same state" 類註解承諾（`restore.ts` 頭、`eventLog.ts`）。不建 projector。
4. 寫一句話定位進代碼註解／輕文檔：`domain_events` = 審計 + 撤銷 + 同步信號的下游副產物。

**驗收：** 刪除後全測試綠；grep 無生產路徑引用已刪 API；客戶端寫入路徑數從 4 軌降到 2 軌。

---

### Phase 2 — 讀取閘（治本第一刀，盲測裡洩漏最多的軸）

1. 建**單一讀取資料訪問層**：所有返回 node 資料的查詢必須過它，授權變成 SQL 條件（`WHERE id IN (readable)` / JOIN），**不再事後 `.filter(scope.has)`**。
2. 順帶解決：假分頁（scope 進 LIMIT 前）、`semanticSearch`/`ask` 的 over-scan 靜默欠填。
3. 收編 ~28 處手抄 `readableNodeIdSet` + ~39 處直接 `FROM content_nodes`。
4. **結構性守門**：把 `readGuard.test.ts` 從「grep 當門」升級成結構強制——任何返回 node 的路徑不過授權層就編譯/CI 失敗（對標寫入側的 `spineEventGate.test.ts`）。

**驗收：** 北極星 #3 對所有讀取路徑答「是」；受限使用者分頁頁數正確；新建一個繞過授權層的讀取端點 → CI 紅。

---

### Phase 3 — 寫入貫穿（治本第二刀，讓 inbox 可信）

1. 所有寫入收回 `mutate()`：`tagDispatcher.ts`（直接 `event()`+`q()`）、`import.ts`、`agentTools/createNode.ts`、`collections.ts` 套 class-tag、其餘 ~37 處直接 `event()`。
2. `affectsMembership` 從「每處手動宣告」改成**從 `node_tags` 實際變動自動推導**；修所有漏 bump（cascade / template / import / createNode / collection 套 tag）。
3. `outbox` 單實例假設：加 DB 級保護（`FOR UPDATE SKIP LOCKED` / 狀態 CAS / advisory lock）讓 drain 冪等；或明確單實例並文檔化。

**驗收：** `spineEventGate` 白名單清零（僅剩合法 system 審計）；membership-epoch 漏 bump 的 property test（任何改 `node_tags` 的路徑必 bump）；inbox 能看到所有 `actor≠me` 的變更（治理無盲區）。

---

### Phase 4 — 結構債收尾（持續，P2/P3 後）

- node 統一化收尾：`collection_schemas`/`views`、ink 兩套 shape、task 雙模型。
- actor 身分加（弱）引用約束（`domain_events.actor_id` 等，注意 system 字串／可刪 actor 的張力）。
- `064` migration 編號碰撞重命名。
- restore cascade 非原子（部分路由無外層事務）。
- inbox 單筆 vs 批次 reject 語意統一。
- 測試：schema.sql 結構漂移守門（`pg_dump` diff）· 整合測試共享 DB 隔離 · 5k 切換 e2e 解 quarantine · 跨瀏覽器 ink/PDF。

---

## 四、推薦順序與里程碑

```
里程碑 A（可對外說「安全了」）：P0 全部 + P1
里程碑 B（可說「讀取治本了」）：  P2 + 守門測試
里程碑 C（可說「治理可信了」）：  P3 + inbox 無盲區
里程碑 D（可說「債清了」）：      P4 滾動推進
```

- **P0 現在就能開始**，不用等想清楚任何架構。
- **P1 與 P2 可並行**（P1 是刪、P2 是建，互不衝突）。
- **P3 最好在 P2 之後**（讀取閘的授權層，寫入貫穿時能複用）。

---

## 五、貫穿原則（每個 PR 都遵守）

- **增量、可回滾**：一次收編一條路徑/一個端點，不大重寫。
- **每步留守門**：修一類 bug 就加一個結構性測試，防回歸（spine 已證明有效）。
- **judgment 用判斷尺**：任何新代碼過北極星三問；違反就是在製造新債。
- **不被 ES 招牌綁架**：看到「該建 projector / 讓 log 當真相」的念頭，停——那是往已被否決的方向跑。

---

## 附：本計畫的證據基礎

- 病根（統一根因）：by-construction 單一強制閘只覆蓋「寫入」一軸，讀取授權/投影/撤權 epoch/客戶端狀態全是 by-discipline 手抄平行軌且已漂移。12/12 純碼盲測收斂。
- 處方（不做純 ES）：10/10 純碼盲測收斂，含魔鬼代言人、含偏 A 協作前提。多數 agent 指出系統底層「已經是 B」，只剩假裝 A 的死碼/註解待刪。
- 偶爾多人協作不證成 ES：合併能力來自「事件形狀的交換性（tag grow-set / attr per-key LWW / edge union）+ 文字三向 diff」，不依賴從 log 重放；未來實時共編用字段級 Yjs（CRDT）疊加，與 ES 正交。

---

## 六、執行進度 + 下個 session 起點（2026-06-15）

### 已落地（push 到 origin/main）

| 階段 | commit | 狀態 |
|---|---|---|
| P0 止血（5 組安全/資料丟失：git/diff·snapshots·collection payload·share·block·pointer·import·離線flush·AI節流） | `b428017..92e497b` | ✅ |
| P1 撕假 ES（client event log −627 行，客戶端縮回三真軌） | `da20e6b` | ✅ |
| P2 讀取閘（readableScopeSql 下推 + 收編 8 端點 + eslint `onden/require-read-gate` 結構強制） | `ed8e31a`/`169851a`/`1891b6f`/`c22399b` | ✅ |
| P3.1 membership epoch by-construction（migration 069 node_tags trigger） | `6a35929` | ✅ |
| P3.2 增量1：cascade 核心三文件收回 mutate（keystone + tagDispatcher/builtinHandlers/fieldDefaults） | `b966cbd` | ✅ |
| P3.2 增量2：templateExpander/tagHierarchy 收回 mutate + dispatcherQueue 改 system 類 → **spineEventGate cascade 類清零** | (本 session) | ✅ |

by-construction 紀律已從寫入軸擴展到讀取軸 + membership 軸（北極星核心）。**P3.2 完成：所有 cascade 寫入收回 mutate，spineEventGate 不再有 cascade 旁路。**

### P4.2（actor 弱 FK）— 已落地（commit `af12583`，未 push）

**SoT 前提修正（探查後）**：本計畫原述「System actor 是字串 `'system'`」不精確。實碼：`actor_type='system'` ≠ `actor_id='system'`——dispatcherQueue/routes(tags,nodes) 的 system 觀測事件其實塞**真 actor uuid**；真正的 daemon sentinel 是 `'system-task-scheduler'`（taskScheduler）與 `'feed'`（rss）。所以這三欄是「真 actors.id uuid **或** 自由 daemon/external sentinel 字串」的混合，**嚴格存在性 FK 在架構上是錯的**（會擋掉合法 sentinel、且 actor 可刪）。

**解法 = migration 071**：BEFORE INSERT trigger，鏡像 `services/nodes.ts loadActor()` 的 UUID_RE 規則——**只有當 ref 是 uuid 形狀時才驗它存在於同 workspace 的 actors；任何非 uuid 字串一律放行為 sentinel**。一個 `actor_ref_resolves(ws,ref)` SQL helper（CASE 短路，非 uuid 不觸 `::uuid` cast）+ 一個通用 `assert_actor_ref()` plpgsql trigger（欄名走 `TG_ARGV[0]`、值/workspace_id 走 `to_jsonb(NEW)`）掛三表：`domain_events.actor_id` / `dispatcher_pending.actor_id` / `event_reviews.reviewed_by`。**write-time 檢查、無 ON DELETE 綁定**：刪 actor 不改寫/不擋既有列，只（正確地）擋為已消失 actor 鑄造的新事件。閉合真正的洞——uuid 形狀卻指向不存在 actor（typo / 跨 workspace / 刪後重用 id / client junk）不可再寫入。

**驗收**：tsc+lint 綠；全量整合 8 failed == baseline 8（完全相同的 pre-existing 共享DB污染集，零新增 regression）；from-empty migrate + schemaDrift 綠。新增 `actorWeakFk.integration.test.ts`（8 案：真 actor 放行 / phantom uuid 三表皆擋 / 跨 workspace 擋 / sentinel 放行 / 刪 actor 後舊列存活但新寫被擋）。修兩支注入 uuid actor 卻沒 seed actors 列的測試（canvasAuthority / canvasPositionsSync，beforeAll 補 seed）。schema.sql 手加 DDL + seed 071（非 pg_dump 全量重生，避免格式漂移）。**gate 基線=8 failed**：permissionMatrix（隔離也掛=真壞）/ collectionViewQuery×2 / compositionLaws v8 / dispatcherAudit / httpRoutes×2 / mediaAuthority×2（隔離通過=純污染）。

### P4.4（restore/inbox 一致性）— 已落地（commit `ebebb6d`，未 push）

**Gap A — restore cascade 原子性**：`restoreEvent` 原本每個 cascade descendant 與主事件各自獨立 tx、無外層包覆（`POST /events/:id/restore` 更是完全無 tx）→ crash mid-cascade 留半還原樹。修=把整串還原（所有 descendant + 主事件 + membership bump）包進**單一 `withTransaction`**；它 reentrant → 每個子 `restoreEvent` 與每個 restoreX 內層 tx 都 join（inbox-reject caller 的 tx 也吸收 → event_reviews 列與還原原子）。restoreX 前置 READ 從 `pool.query` 轉 `q()`（13 site，restoreX 區段 463+）使單 tx 內讀寫一致；preview 路徑（永不開 tx，q()===pool.query）維持 pool.query。**未特別處理**「主事件返回 error code 後子已寫入」的 partial（非 crash；inbox reject 已 throw rollback 處理，裸端點留 pre-existing 細節）——避免動到 reentrant caller 的錯誤處理。

**Gap B — inbox reject 稽核軌一致**：單筆 reject 原本對**任何** restore error code 都 throw→rollback→留隊列；群組/批次對 `already_in_state`/`unsupported` 卻記 event_reviews(rejected, restore_event_id NULL) 移出隊列 → 稽核軌依「按哪顆鈕」而異。修=單筆對齊：`already_in_state`/`unsupported` → 記錄移出（回 200, restore:null）；`external`/`target_gone`/`patch_conflict` → 不記錄、留隊列（不變）。三路徑（單筆/群組/批次）現在完全一致。

**驗收**：tsc+lint 綠；restore/inbox/cascade 既有 56 測試綠；全量整合 8 failed == baseline 8（零新增 regression）。新增 `inboxRejectConsistency.integration.test.ts`（單筆 vs 批次對 no-op code 產生相同 event_reviews 列；正常 reject 仍記 restore_event_id）。Gap A crash-atomicity 失敗注入需 mock 內部、脆弱，靠結構 wrap（reentrant tx 語義）+ 既有 cascade 測試覆蓋。

### P3.2 增量 1 已落地（cascade 核心三文件）— 設計強化記錄

**實作 vs 原設計的關鍵修正**：原計畫的一行設計（`{kind:"cascade", rootEventId}` 直接 skip）有**封閉性漏洞**——任何 code 都能傳 `{kind:"cascade"}` 繞過授權，等於把剛殺掉的 by-discipline 平行軌重新引入。改為 **by-construction 封閉**：

- spine 加 `Authority {kind:"cascade"}`（assertAuthority skip），但 **mutate() 在 `!parent`（無 cascade store）時對 cascade authority 直接 throw** → cascade skip 只在「已被授權建立的 cascade store」內可達，不可能當 root bypass。
- spine 加 `runCascade(actor, authority, causeEventId, body)`：**唯一**從外部進入 cascade 的授權閘——assert 真授權（`{node,write_node}`）後才開 store。配合「cascade child 用 `{kind:"cascade"}` skip → handler 內不可能再產生 AuthorityError」，所以 `runCascade + catch → CASCADE_DENIED` 只攔閘拒、絕不吞 handler 錯誤（精準保留舊語義）。
- mutate event 加 optional `triggeredBy`（顯式因果，TAG_APPLIED 連上游 user event，不必改 7 個 caller）。
- 探查發現：cascade 入口**從不**嵌在真 mutate 內（route 用 `withTransaction`+裸 `event()`，queue 是 post-commit 獨立 tx），故所有入口都得自建 cascade root；queue 路徑本就非原子（best-effort + DISPATCHER_FAILED），重構**保持**不新增原子性。
- 條件式 emit（set_hidden/delete_attribute 依 rowCount）：寫入留在 mutate 外、僅 EVENT 走 mutate（同 tx）；無條件的（set_attribute/notify/fieldDefaults）寫入進 apply()。
- fieldDefaults 原本**無**授權閘 → 不新增（避免難點#3 的誤拒），用 `runCascade({open, why})` 只建 store。

**驗收**：lint+tsc 綠；DB-free vitest 836 pass（5 失敗全為 clean main 既有：dispatcherAudit source 命名、collectionViewQuery×2、httpRoutes sync×2）；cascade+adjacent+spine-core 整合 ~110 pass（唯一失敗 compositionLaws v8 在 clean main 亦失敗）；spineEventGate 已把三文件移出 ALLOWED（cascade 類剩 templateExpander/tagHierarchy）。新增 `spineCascade.test.ts`。

### P3.2 增量 2（剩餘三文件）— 已落地

- **templateExpander.ts**：簽名 `actorId/actorType` → `ActorCtx`（4 caller + 遞迴更新）；slot 迴圈包進 `runCascade({open}, causeEventId)`；NODE_CREATED 走 `mutate({cascade})`、TAG_TEMPLATE_SLOT_FAILED 走 `mutate({cascade})`。`open` 因模板擴展歷史無授權閘（只建新子樹），不新增閘避免誤拒。**（後續修正見「P3 校正 #1」：child state 已進 mutate apply、與 event 同 tx 原子。）**
- **tagHierarchy.ts**：簽名 → `ActorCtx`（棄未用的 system 預設）；TAG_CREATED 走 `mutate({open}, timing:"after")`（DB 生 id）。`open` 因 segment 建立歷史只有 route 的 requireActor、無授權閘。**非 cascade**（無 causeEventId，是獨立 create）。
- **dispatcherQueue.ts**：不改碼——它只發 `DISPATCHER_FAILED`（`actor_type='system'` 的 post-commit/catch-up 失敗審計，無 acting user），正是 spine 明文的 system 旁路。spineEventGate ALLOWED 從 cascade **改歸 system 類**。

**結果**：spineEventGate cascade 類**清零**。驗收：lint+tsc 綠；DB-free 836 pass（5 既有失敗同 clean main）；整合 114 pass（template/tag-path/cascade/import/tasks/tagpack/node-spine），fresh onden_test。

### P3.3（其餘直接 event() 收回）— 審計完成：剩餘 10 個全為合法旁路，**無可收**

P3.2 後 spineEventGate ALLOWED 剩 10 個直接 emitter（18 個 event() 點）。逐一讀 emit 點（event type、第 6 arg actor_type、是否伴隨 state change）後確認**全部落在 spine 明文的合法旁路分類**，無一是「真 actor 的狀態變更卻繞過 mutate」：

| 檔案 | event | 分類 | 為何不能/不該進 mutate |
|---|---|---|---|
| routes/nodes.ts | BODY_CONFLICT / ATTRIBUTE_CONFLICT | system | actor_type='system' 伺服端偵測衝突，無 state change（純觀測，真寫入在其 parent mutate） |
| routes/tags.ts | TAG_DEPENDENCY_MISSING | system | actor_type='system' 觀測，無 state change |
| routes/publish.ts | PREVIEW_GENERATED | audit | 無 state change；actor_type 取自觸發的使用者（**正確**，與 TOOL_CALL 一致——audit 事件歸因觸發者比 'system' 更有用） |
| modules/website/publishing/snapshot.ts | PUBLISH_SNAPSHOT_CREATED | external | external=true(ER4 restore 跳過) **且** DB 生 id → event → outbox-enqueue(triggered_by=eventId) 的三段原子鏈不符 mutate before/after 兩段 timing（mutate 也不回傳 eventId） |
| services/dispatcherQueue.ts | DISPATCHER_FAILED ×2 | system | actor_type='system' post-commit/catch-up 失敗審計，無 acting user |
| services/taskScheduler.ts | TASK_OCCURRENCE_MISSED / NODE_CREATED | system | actor_type='system' 排程 daemon，mutate 無法鑄造 system |
| services/agentTools/registry.ts | AGENT_TOOL_CALLED / _FAILED ×2 | audit | 無 state change（工具自身的寫入走 mutate）；actor_type 取自 agent/user（正確） |
| services/maintenance/prune.ts | NODE_PURGED | audit | actor_type='system' GC，事件先於 hard DELETE 記錄被清者，純觀測 |
| services/eventRestore/restore.ts | 11 個 inverse events | restore | spine 明文「restore 自有治理面」：route 已 assertAuthority，這些是已授權的反向操作（重新 assert 會誤拒）；[[restore-state]] 記其刻意不進 spine |
| services/tagPacks.ts | TAG_IMPORTED | approved-effect | outbox drain 執行 principal-admin 先前的 EFFECT_APPROVED，授權在批准那一步已發生 |

**結論**：P3.3 **無程式碼可收**——閘已收斂到不可再化簡的合法核心。唯一動作=把 snapshot 的 ALLOWED 註解寫精確（原 "external=true, ER4" 沒講出真正不能進 mutate 的三段原子鏈原因）。审計用 1 個 Explore agent 蒐證 + 我親自覆核（agent 對 publish.ts 的旗標是自相矛盾的誤報，已駁回）。

### P3.4（outbox 跨實例鎖）— 已落地

**問題**：outbox reconciler（`drainOutbox`）只靠 process-local `draining` bool + `kickChain` 序列化 + Node 單線程，**無 DB 鎖**。水平擴展時兩個 backend 會各自 SELECT 同一批 `status='pending'` 列、**都執行外部副作用**（double git push / double pages deploy / double tag-pack install），然後都 UPDATE done。

**解法（採 plan 欽定三選一的 advisory lock，最小且免 migration）**：`drainOutbox` 開一條專用 `pool.connect()` 連線，`pg_try_advisory_lock(OUTBOX_DRAIN_LOCK_KEY=4242046046)`（非阻塞）→ 拿不到就跳過這趟（列留 pending 給持有者/下一 tick）→ finally `pg_advisory_unlock`。鏡像 `db.ts` 既有的 `MIGRATION_LOCK_KEY` 模式。**免 migration、免新 status、crash 自癒**（session lock 隨連線斷自動釋放，未標 done 的列留 pending 被重試）。保留 `draining` bool 當同進程 fast-path（`outboxLongrun` 並發測試行為不變）。把 drain body 抽成 `runDrain()`。

**不在 P3.4 範圍**：dispatcherQueue 也是 process-local singleton，但其 cascade 重跑是冪等收斂（重派生 attribute → 同狀態，只多幾筆事件），危害遠低於外部副作用雙發，且 catchup 已有 dispatcher_pending 守門；要鎖需 per-node advisory lock（粒度不同），留作後續。

**驗收**：lint+tsc 綠；DB-free 836 pass（5 既有失敗同 clean main）；outbox 整合 8 pass（新增 cross-instance guard 測試：另一連線持鎖時 drain 跳過、列留 pending、釋放後正常 drain）+ outboxApproval/outboxLongrun 共 15 pass。

### P3 校正（使用者審查後修正三處 overclaim）

使用者精準指出先前框架的三個過度宣稱，逐一查證**全部成立**，已修：

1. **「所有 cascade 寫入收回 mutate」原本只成立於 event 軌**。`templateExpander` 的 child state 原本在自己的 `withTransaction` 先提交、之後才 `mutate` 發 NODE_CREATED；在無外層 tx 的路徑（`collections.ts`/`applyTag.ts`——後者註解明說要在 item commit 後、spine tx 外跑）會「有 child、沒 event」。**已修**：app-mint childId（`randomUUID`）+ child INSERT/marker/childAttrs 進 `mutate({cascade}, timing:before)` 的 `apply()`、外包一層 `withTransaction`，state+event 同 tx 原子；遞迴移到 tx 外用回傳的 childEventId（保 best-effort 每槽隔離）。現在 state 真的收回 mutate，不只 event 軌。

2. **069 node_tags trigger 只 bump epoch、不觸發 app 層 SSE**；且 tag-apply route 既 INSERT node_tags（trigger bump）又顯式 `bumpMembershipEpoch`（bump+SSE）→ **epoch +2**。當時校正宣稱（epoch by-construction 正確、即時 SSE 只在 REST route、其餘靠 handshake），並提 pg_notify 統一為後續 track → **已做＝P3.5（見下）**。

### P3.5（membership epoch SSE 統一：pg_notify）— 已落地

**根治校正 #2**：讓 069 trigger 成為 node_tags-driven membership 訊號的**單一來源**。
- **migration 070**：`CREATE OR REPLACE` trigger function，UPDATE epoch 後 `pg_notify('membership_epoch', json{workspace_id, epoch})`。NOTIFY 是 transactional（commit 後才送達 listener，對齊原 afterCommit timing）。schema.sql 的 function 定義 + schema_migrations seed 同步更新。
- **services/membershipListener.ts**：bootstrap 開一條專用 `pool.connect()` 連線 `LISTEN membership_epoch`，收到就 `notifyMembershipChanged(epoch)` → SSE tick；連線斷自動重連（best-effort，掉了只失即時性，正確性靠 epoch+handshake）。index.ts 在 `startOutboxReconciler()` 旁啟動。
- **移除 4 個冗餘顯式 bump**（純 node_tags apply/remove 路徑）：`routes/nodes.ts` tag apply/remove、`applyTag.ts`、`removeTag.ts`——trigger 現在同 tx 內 bump epoch + NOTIFY，這些顯式 `bumpMembershipEpoch` 是雙重 bump，刪除（連 import）。**保留**非 node_tags 的 bump：actor role/scope（actors.ts）、parent_id（nodes.ts:299）、tag policy（tags.ts:345）、restore（restore.ts，混合且可能非 tag）。

**效果**：tag 變更**經任何路徑**（route / MCP tool / import / cascade / template）都即時 SSE，不再只有 REST route；REST route 不再雙重 bump。**驗收**：lint+tsc 綠；DB-free 836 pass（5 既有）；fresh onden_test 整合 membership/tag/sync 75 pass，含新增「trigger pg_notify 出 workspace_id+epoch」測試 + migration 070 套用 OK + schemaDrift 守門綠。

3. **outbox advisory lock 是並行控制、非 exactly-once**。完成外部副作用後、`status='done'` 前若崩潰，下次 drain 會重做 → **at-least-once**。**已修文件**：outbox.ts header 明寫 at-least-once + effect handler 必須冪等的要求（並標出 publish_site/tag_pack 在重試下會留重複 history row 的較弱保證，新增 kind 須在此檢查）；advisory-lock 註解改為「並行控制非 exactly-once」。

4. **（二輪審查）templateExpander 的 child tag 仍用 `pool.query`**——另一條 connection 寫 node_tags，在 route 外層 tx 下看不到尚未 commit 的 child，且 `node_tags.node_id` 有 FK `REFERENCES content_nodes(id)` → FK 鎖等 uncommitted child、而外層 tx 由同一 async context await 著 → **不可偵測的自我死鎖/卡死**（正是 collections.ts 註解警告的 wedge）；child tag 也完全沒走 spine（無 TAG_APPLIED、無 on_apply、非原子）。沒被測到是因為**無任何測試走 child_class_tag_slug**。**已修**：childTag SELECT + node_tags INSERT 改 `q()`（同 tx、FK 可見），child tag 走**完整 `dispatchTagApply()`**（TAG_APPLIED via mutate + on_apply 行為），`RETURNING` gate 防重複，遞迴改用 child tag 的 TAG_APPLIED id 當 causeEventId；新增 nodesSpine 巢狀模板整合測試（經 REST route 驗無死鎖 + 子標籤行為/巢狀子節點都生）。**註解校正**：「每槽 tx 隔離兄弟」只在無外層 tx 成立；route 路徑 withTransaction reentrant 無 savepoint，所有槽共用 request tx（仍 catch SLOT_FAILED 續跑，但失敗槽的部分寫入不獨立 rollback）。**三輪審查補完**：把整個 slot（child node mutate + child-tag {node_tags insert + dispatchTagApply + applyFieldDefaults} + 遞迴）收進**同一個** `withTransaction()`——有外層 reentrant 加入、沒有自開——使 slot 原子；順帶補上 `applyFieldDefaults`（child-tag 現在也 seed schema 預設），並修掉「child+marker 已 commit 但 tag 失敗 → 重展靠 filledMarkers 跳過永不補」的缺口（marker 與 tag 同 tx，要嘛全成要嘛全 rollback）。巢狀整合測試加驗 field default 已 seed。

### P3.2（cascade 完全收回 mutate）— 原始探查記錄

**Scope**：只收 cascade 6 文件（spineEventGate ALLOWED 裡 category=cascade）：
`tagDispatcher.ts` · `dispatcher/builtinHandlers.ts` · `templateExpander.ts` · `fieldDefaults.ts` · `tagHierarchy.ts` · `dispatcherQueue.ts`。其餘 7 個白名單（system/audit/external/restore/approved-effect）是合法旁路，**不收**。

**重新評估**：盲測說的「兩套平行授權」是誤讀——`cascadeAllowed`(tagDispatcher:146) 內部就是 spine `assertAuthority({node,write_node})`；漏 bump 已被 P3.1 trigger 修。所以收回的剩餘價值是**彻底的單一變更軌**（spineEventGate cascade 類清零），非修 bug。使用者欽定要做（不留例外）。

**4 個難點（實作逐一處理）**：
1. **遞迴**：`dispatchTagApply → runHandler → handler 可能 apply 更多 tag → dispatchTagApply`。每步變 mutate = nested mutate（reentrant tx 已支援，但要逐處驗 triggeredBy 因果鏈不斷）。
2. **tentative**：`DispatchContext.tentative` Map 批量計算後 apply——這語義 vs mutate 原子提交要對齊。
3. **authority 繼承**：cascade child 繼承 root actor 授權（cascadeAllowed 已 assertAuthority），不重新檢查。mutate 需支援 `{kind:"cascade"}` / inherited authority，否則每個 child 重新 assertAuthority 會改語義（甚至誤拒）。
4. 6 文件的 `event()`/`q()` 全部適配，每處關乎授權/歸因/原子/因果鏈——**錯一處就是授權繞過或因果鏈斷裂**。

**建議方案**：給 spine 加 `{kind:"cascade", rootEventId}` authority（assertAuthority 對它 skip 重檢、記 triggeredBy）；cascade events 改走 `mutate(authority:{kind:cascade})`，cascade writes（builtinHandlers 的 attr `q`）進對應 mutate 的 apply()。**增量做**（一文件一文件），每步跑 cascade/dispatcher 整合測試 + 全量 DB gate 對比 baseline。**不在疲勞的長 session 末尾做**（授權繼承錯一處就是漏洞）。

### P4.3（測試隔離）— 診斷已清楚，是大 track

共享 onden_test 污染的根因不是「beforeAll 刷表不彻底」，而是 **21 個 integration 測試不自包含**：它們 mount 完整 app + native-origin auth，靠 `index.ts:232` 的 `nativeActorCache`（module 級緩存）+ first-human-auto-admin bootstrap 解析 actor，自己不建。任何 per-file reset（試過全 wipe + 保留 auth 表的溫和 wipe，都 30 failed/401）都破壞它們，根因在 app 的 native-auth 緩存/bootstrap 交互，**不只測試 setup**。彻底修 = 改 native-auth 隔離方式 + 21 測試自建 actor，是專門 track。現狀無 reset = baseline 7 failed（測試間資料衝突，單獨跑 pass，故 gate 用「對比 baseline 無新增」）。

### P4 其餘（相對獨立的小項，可單做）
- **P4.2**：`064_` 兩文件共序號（rename）；`domain_events.actor_id` 等裸 text 加弱 FK。
- **P4.3 子項**：schema.sql 結構漂移守門（pg_dump fresh-migrate vs schema.sql diff，現只驗種子行）。
- **P4.4**：restore cascade 部分路由無外層事務（半還原）；inbox 單筆 vs 批次 reject 對不可逆 code 處理分歧。
- **P4.1**：collection_schemas/views 平行表、ink 兩套 shape、task 雙模型（node 統一化尾）。

### P4.1 評估（2026-06-15）— 重新定性後的範圍
- **task 雙模型：已收斂**（mig 062 已 DROP node_tasks，task=普通 node）。非待辦。
- **ink 兩套 shape：重新定性＝合理的分離，非真債（低優先/可不做）**。`PdfShapeData`（lib/pdf/coords.ts）是 PDF-annotation 原生格式（arrow 點是 PdfHighlightRecord bounding-rect 內 0..1 正規化、stroke* 命名、存 pdf_annotations、由 PdfHighlights.tsx 渲染）；`InkShape`（lib/ink/types.ts）是統一 ink-doc 格式（kind/start/end/color/size、存 ink_data、可治理記錄）。轉換已收斂在 `pdfAdapter.ts addShapeToPage` **單一處**。兩者服務不同儲存情境＋不同座標慣例，強行統一＝改持久化格式 + PDF 渲染，風險>收益。footprint 僅 3 檔。
- **collection_schemas/views→node：真架構債（大、高風險、多 session）**。盲測 13 agent 共識「最後一張承載領域語意的平行表」。tag 身分已是 node（mig 037-040），但 tag 的 schema（fields/policy/behaviour/template_children/views）仍住 `collection_schemas`，由 `content_nodes.tag_schema_id` 軟連。**17 個後端檔**引用，含**安全關鍵授權 JOIN**（`readPolicy.ts`/`dispatcher/permissions.ts` 的 tag-policy ancestor cascade）+ dispatcher + eventRestore + publishing + imports（notion/csv）+ 前端。**必須 expand-migrate-contract**：(A) 加 schema 進 class_tag node 的 attribute/欄、雙寫；(B) 回填 + 切讀（尤其 readPolicy/permissions 的 policy JOIN 要逐一驗，錯一處＝授權漏）；(C) DROP collection_schemas。**不可在疲勞 session 末尾起**——授權面錯一處就是洩漏。建議專注 session、以 0-failed gate 當安全網、每 phase 全量 gate 對比。
