# 效能與規模審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：後端 `packages/backend`（SQL、sync、發佈）、前端 `packages/frontend`（建置產物、本機資料庫 worker、狀態與渲染）。
本審查只從程式碼與實測形成判斷，沒有讀任何 `.md` 文件；指令來自各 `package.json` 的 scripts。除本檔外沒有改任何檔案。

## 怎麼量的（請先讀，數字的可信度取決於這裡）

- **後端資料**：本機 PostgreSQL 16，資料庫 `onden_perf_test`，載入 `db/schema.sql`（去掉 `age`、`pgroonga`、`vector` 三個擴充與其索引，環境裝不到）。
  種入 1 個 workspace、20,000 篇筆記（每篇約 1.8 KB 中文 Markdown）＋ 300 個標籤、39,600 筆 `node_tags`、60,000 筆 `node_attributes`、
  59,994 條 `node_edges`、樹狀 `parent_id`；`domain_events` 先 140,000 筆，後來擴到 700,000 筆。`publish_snapshots` 另放一份含 20,000 篇的快照（35.6 MB jsonb）。
- **怎麼呼叫**：用 `tsx` 直接呼叫真正的 `buildBootstrap`、`buildSyncDelta`、`searchNodes`、`runNodeQuery`、`loadServedSite`，並攔截 `pg.Client.query` 記錄每條 SQL 的耗時與回傳大小。
  `EXPLAIN (ANALYZE)` 用同一份資料。
- **前端**：`npm -w packages/frontend run build` 後讀 `dist/client/_astro` 的 chunk；在 Node 內用真的 `sql.js`、真的 `persistBootstrapInto`、真的 `decodeBootstrapWire`、
  `applySyncDelta`、`tagMemberCounts`，餵入後端實際產出的 24.7 MB bootstrap。
- **限制（如實）**：
  1. **`pgroonga` 沒裝**，所以全文搜尋本體沒量到，只量了它周圍的權限與排序條件。
  2. 沒有手機。「手機」的數字一律是桌機 CPU 實測值，倍率只是推測，標為 SUSPECTED。
  3. 種的資料是合成的：事件 `payload` 約 0.5 KB、標籤與筆記的分布是均勻的，真實資料的分布會讓個別數字上下浮動。
  4. 生產環境的反向代理設定不在 repo 裡，壓縮是否由它處理無法確認。

## 結果總覽

| 嚴重度 | CONFIRMED | SUSPECTED | 合計 |
| --- | --- | --- | --- |
| P0 | 0 | 0 | 0 |
| P1 | 6 | 1 | 7 |
| P2 | 7 | 2 | 9 |
| 合計 | 13 | 3 | 16 |

沒有發現「在 20k 篇下直接當掉」的 P0：量到的最差情況是 14.8 s（#8，非日常路徑）。
之前說的三件事，我的結論是：**登入畫面載整個 app 在這個版本已不成立**（#12）；**20k 篇冷啟動慢**的主因我認為在 #2、#3、#5 的組合；
**搜尋凍結 ~20 s 我無法重現**（#7，缺 `pgroonga`），只能列為 SUSPECTED，並指出兩個會放大它的條件。

---

## P1：使用者會感覺到的慢

### 1. 每次冷啟 bootstrap 都對整個事件紀錄做分組排序（CONFIRMED）

- 位置：`packages/backend/src/services/sync/bootstrap.ts:149-166`（`evt_meta` CTE）、`packages/backend/src/services/nodeRowProjection.ts:17`（`NODE_EVENT_META_COLUMNS_SQL`）。
- 情境：20k 篇、140k 筆事件時，lean bootstrap 全程 2.7 s，其中這一條就佔 **1.13 s**；事件擴到 700k 筆（5 倍）後變 **2.65 s**（整體 4.1 s）。
  `EXPLAIN` 顯示它對全部 `target_type='node'` 的事件做 `Seq Scan` ＋ `external merge` 排序（臨時檔 13 MB → 67 MB），再 `GroupAggregate`。
  成本隨「事件總數」成長，不隨「筆記數」成長；而 `domain_events` 有刪除觸發器擋著，不會自己變小（見 #13）。
- 建議：不要在 bootstrap 重算。把 `last_actor`／`last_modified_at`／`recent_actors` 存成 `content_nodes` 的欄位（或一張 `node_event_meta` 表），在寫事件的同一交易內更新；
  最小改法是只算「最近 N 天」且 `created_at` 有索引的視窗，其餘用 `updated_at` 代替。

### 2. 客戶端把 bootstrap 寫進本機資料庫要 5 秒，其中八成是重複 prepare（CONFIRMED）

- 位置：`packages/frontend/src/lib/localDbPersist.ts:231`（nodes 迴圈）、`:236`（edges）、`:267-274`（attributes，slim 路徑每個節點還先 `DELETE`）、`packages/frontend/src/lib/localMirror.ts:38`、`:77`、`:116`（每列一次 `d.run(sql, params)`）。
- 情境：用實際 24.7 MB payload（20,301 篇／59,994 邊／60,000 屬性）在 Node 內跑真正的 `persistBootstrapInto`：**4.97 s**（再跑一次 5.31 s）。
  分項：edges 1.73 s（59,994 次）、attributes 1.51 s（60,000 次）、nodes 1.16 s（20,301 次）、每節點的 `DELETE node_attributes` 0.40 s（20,301 次）。
  約 29 µs／條語句，共約 16 萬條，每條都重新 parse。這在 worker 裡所以不卡畫面，但它決定「離線可用」與「後續動作開始」的時間。
  每日一次的完整刷新、`resync_required`、冷啟動都會走這條。手機若比桌機慢 3–5 倍，是 15–25 s（SUSPECTED，未在手機量）。
- 建議：在 `persistBootstrapInto` 內對每種表 `prepare` 一次、迴圈裡 `stmt.run`／`bind`+`step`+`reset`；slim 路徑的逐節點 `DELETE` 改成一次 `DELETE ... WHERE node_id IN (SELECT value FROM json_each(?))`，這兩項都不改行為。

### 3. 同步 delta 在主執行緒對 20k 陣列做 O(N×U) 複製（CONFIRMED）

- 位置：`packages/frontend/src/lib/data/storeOps.ts:139`：`for (const n of delta.nodes.upsert) nodes = [...nodes.filter(x => x.id !== n.id), n];`
- 情境：後端 delta 一次最多 500 筆事件（`delta.ts:114`）。實測 20k 篇、500 個 upsert：**629 ms**（桌機、純 JS、主執行緒，會直接凍結輸入）；同樣結果用一次 `Map` 比對只要 **3.7 ms**。
  離線一天後重連、匯入、批次改標籤都會踩到。附帶效果：被更新的筆記全被移到陣列尾端，順序靠後面的排序再補回來。
- 建議：先建 `Map<id, node>`，一次 `prev.nodes.map(...)` 取代舊列，再 push 新列；順序依賴請改用明確排序（`sort_order`）。

### 4. 公開網站與「複製連結」每次都解析並複製整份發佈快照（CONFIRMED）

- 位置：`packages/backend/src/services/publishing/servedSite.ts:111-117`（`loadServedSite` 取整列 `SELECT *`）、`:48`（`structuredClone(row.payload)`）；呼叫者含 `servedPages`（→ `publishedUrlFor`、`singleNoteExport`）、`GET /api/site`、分享連結、`pagesPush`。
- 情境：快照含 20k 篇（payload 35.6 MB）時，`loadServedSite` 一次 **2.4 s**，期間事件迴圈一次被擋 **456 ms**；
  我的快照裡沒有任何筆記公開（`nodes: 0`），也一樣 2.4 s，因為先整份讀出、解析、複製，才套用「下架」過濾。
  這是未登入的公開路徑：幾個並行請求就足以讓小 VPS 的單一 Node 程序回應變慢。
- 建議：把「可公開的 id 集合」（`publishedNodeIds`）先查出來，用 SQL 只取 `jsonb_path_query`／`jsonb_array_elements` 中符合的節點；
  或在發佈時就把每頁切成獨立列／檔案，供應時只讀單頁；至少加一個以 snapshot id 為鍵的記憶體快取。

### 5. 匿名讀取每一個媒體檔都掃描整份快照 jsonb（CONFIRMED）

- 位置：`packages/backend/src/services/publishing/servedSite.ts:186-200`（`servedSiteShowsMedia`：`jsonb_array_elements(payload->'nodes')`＋`lower(n::text)`）。
- 情境：同一份 35.6 MB 快照，SQL 這一條 **185 ms**（只含 SQL，沒含網路）。一個含 20 張圖的公開頁，圖片請求合計約 3.7 s 的資料庫時間，且每次都 detoast 整個 payload。
- 建議：發佈快照時順便寫一張 `snapshot_media(snapshot_id, node_id, filename)`，這條改成索引查詢。

### 6. 冷啟 payload 24.7 MB，邊占 15 MB，repo 內看不到壓縮（payload 大小 CONFIRMED；壓縮 SUSPECTED）

- 位置：`packages/backend/src/services/sync/bootstrapWire.ts:54`（只壓縮 nodes／attributes，`edges` 仍是完整物件）、`bootstrap.ts:186-193`（edges 查詢）；回應由 `routes/bootstrap.ts` 的 `c.json` 同步 `JSON.stringify`。
- 情境：lean2 payload 實測 **25.1 MB**（gzip 後 **5.4 MB**）：edges 15.2 MB（每條約 253 B，含兩個 uuid、`edge_type`、`status`、`origin`、`created_at`）、attributes 8.6 MB（`BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS` 已排除圖畫）。
  伺服器端 `JSON.stringify` 0.3–0.9 s（同步），`pg` 解析列時事件迴圈被擋 156 ms。
  壓縮：後端沒有 compress 中介層、`packages/frontend/docker/nginx.conf` 沒有 `gzip`、Astro node adapter 預設不壓縮；若生產的反向代理也沒開，手機要吃下 25 MB。
- 建議：把 edges 併入 lean2 的字典編碼（uuid 換字典索引、`status`／`origin` 預設值省略），預期可砍到約 1/4；並確認前端與 API 的壓縮在實際邊緣層有開（`curl -I -H 'accept-encoding: br,gzip'`）。

### 7. 全文搜尋：本體未能量測，但有兩個放大條件（SUSPECTED）

- 位置：`packages/backend/src/services/nodeSearch.ts:59`（`title &@~ $n OR markdown &@~ $n`）、`:119-122`（`ORDER BY lower(title)=lower($n) DESC, starts_with(...) DESC, pgroonga_score(tableoid, ctid) DESC`）、`:68`（每個 `#tag` 先在 JS 端呼叫 `memberTagIdsNamed`）；`packages/backend/src/db.ts:15`（連線池沒有 `statement_timeout`）。
- 情境：我無法重現「~20 s」，因為環境沒有 `pgroonga`。能量到的部分：把 `&@~` 換成「每列都命中」的 `LIKE`，其餘權限、`notATaskNodeSql`、`NOT_SYSTEM_NODE_SQL`、排序全留著，20k 命中列要 **117–152 ms**（計畫是 `Nested Loop Anti Join` ＋ top-N heapsort，沒有用到索引排序），所以非全文部分不是 20 s 的來源。
  剩下的疑點是：(a) 排序鍵要求對**所有命中列**算 `lower(title)`／`pgroonga_score` 後才取前 30，詞越常見越貴；(b) 全 repo 沒設任何 `statement_timeout`／`lock_timeout`，一條失控的查詢會一直占住一條連線（池最多 20 條），多開幾個分頁就把池吃光（`connectionTimeoutMillis` 10 s 之後所有請求 500）。
- 建議：先在有 `pgroonga` 的環境對 `EXPLAIN (ANALYZE, BUFFERS)` 這條 SQL，確認是否 `Index Scan using content_nodes_pgroonga_idx`；同時在 `pool` 的 `options` 加 `-c statement_timeout=15000`（背景工作用單獨的 client 覆寫），並讓精確標題比對走 `lower(title)` 的函式索引、其餘才交給 `pgroonga_score`。

---

## P2：風險與技術債

### 8. 完整內文 bootstrap 的計畫會在 LIMIT 下翻成巢狀迴圈（CONFIRMED）

- 位置：`packages/backend/src/services/sync/bootstrap.ts:163-166`（`LEFT JOIN evt_meta em ON em.target_id = n.id::text` ＋ `ORDER BY ... LIMIT $3`，`BOOTSTRAP_NODE_LIMIT = 5000`）。
- 情境：`/api/bootstrap`（不帶 `bodies=none`）在 20k 篇下：**12.6 s（140k 事件）～14.8 s（700k 事件）**。`EXPLAIN` 是 `Nested Loop Left Join`，`Rows Removed by Join Filter: 49,959,304`，原因是 join 條件有 `n.id::text`，加上 `LIMIT` 讓 planner 低估。
  正常用戶端在 ≥2,000 篇時會改用 slim（`SLIM_MODE_NODE_THRESHOLD`），所以日常不踩；但 1,900 篇的工作區成長到過門檻之間、舊版客戶端、或任何直接打這個端點的腳本會踩。
- 建議：`evt_meta` 改 `MATERIALIZED` 並以 `target_id::uuid` 或把 `domain_events.target_id` 改存 uuid 欄位；或直接移除非 slim 路徑的 `LIMIT` 與 N 倍成本（做完 #1 後這條也會一起消失）。

### 9. 標籤目錄的 `usage_count` 是每個標籤一次相關子查詢（CONFIRMED）

- 位置：`packages/backend/src/services/tagCatalog.ts:75-76`；呼叫者：bootstrap、`GET /api/tags`、sync delta 在標籤目錄變動時。
- 情境：300 個標籤、39,600 筆 `node_tags`：**98 ms**（bootstrap 內最大的小項）。成本隨 `node_tags` 列數線性成長，且每次都帶 `spaceScopeSql` 子查詢。每次改標籤的 delta 都會重算。
- 建議：改成一條 `GROUP BY nt.tag_id` 的聚合後 `LEFT JOIN`，或在標籤套用／移除的交易內維護計數。

### 10. 每次 sync 輪詢都把 20k 個可讀 id 從資料庫拉回 Node（CONFIRMED）

- 位置：`packages/backend/src/services/spaceScope.ts:24`（`spaceReadableNodeIds`）←`readPolicy.ts` 的 `readableNodeIdSet`；`sync/delta.ts:106`、`sync/bodies.ts:23`、`sync/membership.ts:113/143/187`、`sync/drawings.ts:24/44`、`routes/events.ts:251/325`、`services/noteViews.ts:221`、`tagViews.ts:438`、`inboxQueue.ts:69`，共 23 處。
- 情境：沒有新事件的輪詢也要 **22–53 ms**、回傳 **933 KB**（20k 個 uuid）；bootstrap 又把同一組 id 以陣列參數送回資料庫 5 次（nodes／edges×2／pointers／attributes／suggestions，每次約 0.9 MB 參數）。
  事件列表 `routes/events.ts` 實測 `target_id = ANY($1::text[])` 對 700k 筆事件仍可用（約 30 ms，走 `domain_events_pkey` 反向掃描），所以這是「風險＋每次輪詢的固定稅」，不是目前的瓶頸。
  它也和專案自己的規則（讀取範圍要下推到 SQL）不一致。
- 建議：delta 在 `since` 之後沒有事件、`membership_epoch` 未變時，直接回空 delta，不要先取集合；其餘路徑逐步改用 `readableScopeSql`（`readPolicy.ts:42`）下推。

### 11. 整份本機資料庫快照寫入 IndexedDB（SUSPECTED；匯出本身 CONFIRMED 很快）

- 位置：`packages/frontend/src/lib/localDbWorker.ts:143-155`（`saveSnapshot`：`db.export()` → `idbSave`）、`:167-168`（`persist` 預設 debounce、`compact` 15 s／200 筆）。
- 情境：slim 20k 篇的資料庫匯出 **36.1 MB**，`db.export()` 只要 26 ms；程式碼註解說下載全部內文後是 35–100 MB。每次 mirror 變動（sync、bootstrap、載入內文）都會在 debounce 後整份重寫一次。
  Android 上把 36–100 MB 寫進 IndexedDB 的時間與電量我沒量到，推測是秒級；連續編輯＋sync 會反覆觸發。journal 已經把「使用者寫入」的持久化成本壓到很小，這一項只剩「mirror 變動」。
- 建議：先量真機的 `idbSave` 時間與頻率（加一個 `performance.measure`）；若確認，mirror 變動改成更長的 debounce（例如 60 s）或僅在 `visibilitychange→hidden` 時存。

### 12. 登入頁與進入 app 的程式碼量（CONFIRMED，結論是「大致良好」）

- 位置：`packages/frontend/src/pages/index.astro`（`<AppRoot client:only="react" />`）、`packages/frontend/src/lib/i18n.app.ts:6`（同步 `import { ZH_TW }`）。
- 數字（`npm -w packages/frontend run build`，靜態 import 閉包，不含動態 import）：
  - 登入頁：`AppRoot` 閉包 277 KB raw／104 KB gzip，加 React DOM `client` 194 KB／62 KB，約 **471 KB raw／166 KB gzip**。**之前「登入畫面載整個 app」在目前版本不成立**，`BuilderWorkspace` 是 `import()` 的。
  - 其中 `i18n.zh-TW` 單獨 **198 KB raw／74 KB gzip**，占登入頁的 40%，且是同步 import（`i18n.lazy.ts` 已經有動態載入的版本，zh-TW 卻走 eager）。
  - 登入後 `BuilderWorkspace` 閉包 **1.22 MB raw／420 KB gzip**；打開一篇筆記（`KnowledgeWorkspace`／`OverviewEditorHost`）累計 **2.1 MB raw／719 KB gzip**（含 `selectionBubble` 499 KB、`embeds` 206 KB）。
  - 重的函式庫都已動態載入、不在上述閉包：mermaid 573 KB、wardley 612 KB、pdf 485 KB、cytoscape 443 KB、katex 261 KB、pixi 230 KB（確認過閉包內 0 次出現）。
- 建議：把 zh-TW 字典切成「啟動需要的 ~5 KB」與其餘按需載入；`selectionBubble`（499 KB）如果是編輯器本體，確認它只在開筆記時才載。

### 13. 事件紀錄只增不減，且資料庫禁止刪除（SUSPECTED，與 #1 直接相關）

- 位置：`packages/backend/db/schema.sql` 的 `domain_events_no_delete`、`domain_events_no_update` 觸發器；全 repo 沒有任何歸檔或保留期限的程式。
- 情境：我的合成資料 700k 筆事件的表＋索引占 **776 MB**（payload 約 0.5 KB／筆，真實 payload 大小未知）；而整個 `content_nodes`（含 20k 篇內文）才 19 MB。小 VPS 的磁碟與備份會先被事件紀錄吃掉；#1 的成本也與它同步成長。
- 建議：先定義保留策略（例如超過 90 天的事件搬進 `domain_events_archive` 並移除其 payload 內文，保留 id／type／target），並讓所有「最後修改者」之類的讀取不再依賴全表聚合（#1）。

### 14. 每次 nodes 陣列換新就重算標籤計數與可見節點（CONFIRMED 於桌機；手機 SUSPECTED）

- 位置：`packages/frontend/src/lib/appStore.ts:289`、`:297`、`:320`（`memoLast` 以 `nodes` 陣列的 identity 為鍵）、`packages/frontend/src/lib/nodeTags.ts:105`（`tagMemberCounts`）、`packages/frontend/src/lib/data/storeOps.ts:15-16`（`patchNode` 每次 `nodes.map`）。
- 情境：20k 篇下，一次自動儲存（`patchNode`）約 **1.3 ms**，但因為陣列 identity 改變，`tagMemberCounts` 緊接著整個重算 **24 ms**，`overviewNodesOf`／`searchableNodesOf` 各再過濾一輪 20k。即使只是改內文、沒動任何標籤。桌機可接受；手機以 3–5 倍估算約 100 ms 以上，打字停頓後的每次儲存都會碰到。
- 建議：讓這些選擇器以「影響結果的欄位」為鍵（`label_tag_ids`／`class_tag_ids`／`hidden`／`source_type` 的版本號），或讓 `patchNode` 對只改 `markdown`／`updated_at` 的情況回傳新陣列但保留一個 `membershipVersion` 供 `memoLast` 比較。

### 15. 以屬性排序的查詢明顯比其他慢（CONFIRMED）

- 位置：`packages/backend/src/services/nodeQuery.ts:121-140`（非內建欄位以 `node_attributes` 值排序）。
- 情境：`runNodeQuery({ sort: "-status", limit: 50 })` **130 ms**，對照 `{ limit: 50 }` 22 ms、`{ tags: [...] }` 10 ms。排序鍵來自逐列的屬性子查詢，沒有可用索引，隨筆記數線性成長（20k 篇是 130 ms，不是問題；到 100k 會變成 0.6 s 以上）。
- 建議：保持現狀，但在 `node_attributes` 加 `(workspace_id, key, value)` 的索引並讓排序走它；`node_attr_task_*` 已經是同樣做法的先例。

### 16. 建置警告：`lib/data/index.ts` 與 `sync.ts`、`reads.ts` 形成跨 chunk 的循環依賴（CONFIRMED）

- 位置：`npm -w packages/frontend run build` 的輸出：`Export "recovery"/"dataSync"/"reads" ... will end up in different chunks ... circular dependency between chunks and will likely lead to broken execution order`；涉及 `components/FailedWriteRecovery.tsx`、`lib/share/shareInbox.ts`。
- 情境：目前能跑，但是 Rollup 明講「執行順序可能壞掉」；任何 chunk 切分變動都可能在特定載入順序下讓模組在初始化前被使用，症狀會是只在冷啟動、特定裝置出現的白畫面，很難重現。
  另外 worker 打包 `localDbWorker` 是 **92,259 B，預算 93,200 B**（99%），下一個改動很可能就讓 `check-worker-bundle.mjs` 擋住建置。
- 建議：把兩處 import 改成直接指向 `sync.ts`／`reads.ts`（警告本身就指明了），並在 CI 把這類 `[WARN]` 當失敗。

---

## 做得好的地方

1. **bootstrap 的形狀就是為了大工作區設計的**：slim 模式（`?bodies=none`）不讀內文欄位、`BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS` 排除圖畫、lean2 字典編碼、
   暖啟動只靠 delta、整份刷新最多一天一次（`syncEngine.ts` 的 `FULL_REFRESH_MAX_AGE_MS`），並有 `withActorReadSnapshot` 讓游標與資料同一時刻。
   delta 本身很便宜：沒有新事件 38 ms、500 筆事件 75 ms（20k 篇）。
2. **本機資料庫完全在 worker 內**（sql.js ＋ 日誌 journal），使用者寫入以一筆小 IndexedDB 紀錄持久化，快照延後合併；側欄超過門檻就視窗化渲染（`OverviewSidebar.tsx` ＋ `sidebarFlatten.ts`）。
3. **建置有預算與守門**：`check-app-css.mjs`、`check-worker-bundle.mjs`（含「禁用函式庫」檢查）；重量級函式庫（mermaid、pdf.js、cytoscape、katex、pixi、Puck）全部動態載入，登入頁閉包 166 KB gzip。
   另外 `db.ts` 把 `jit=off` 寫進連線設定並附上實測原因（JIT 在 13k 篇時花 1.2–2.4 s 編譯），這是很少人會做的判斷。

## 建議的處理順序

1. #1（事件元資料）＋ #2（prepare 一次）＋ #3（delta 套用）：改動小、效果可量、互不相依，三項加起來直接降低 20k 篇冷啟動與重連的時間。
2. #4、#5（公開網站）：未登入路徑，優先於其他後端項目。
3. #6（edges 編碼與壓縮檢查）、#7（`statement_timeout` 與有 `pgroonga` 的 `EXPLAIN`）。
4. 其餘 P2 依 #13（保留策略）→ #14 → #10 的順序。
