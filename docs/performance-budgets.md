# 效能預算與基準測試

> 狀態：現行（最後確認 2026-11-01）

20k 篇筆記的工作區是 Onden 的規模目標。2026-10-24 效能審查（分支 `review/2026-10-24-performance` 的 `docs/archive/research/review-2026-10-24/performance.md`）量過這個規模，
這份基準測試把那些量測變成可重複的指令，並用預算擋住退步。它是 `scripts/check-worker-bundle.mjs`、`check-app-css.mjs`
（建置大小守門）在執行期的延伸。

## 在你自己的機器上跑

需要本機 Postgres 16（帳號 `onden`／`onden`，可建立資料庫），已經 `npm ci`：

```
npm run bench          # 第一次會先建 onden_bench 並種資料（約 3 分鐘），再量後端、前端、建置大小（約 4 分鐘）
npm run bench:check    # 和 bench-budgets.json 比，超過預算就失敗，並印出表格
```

- 資料庫連線用 `BENCH_DATABASE_URL`（預設 `postgres://onden:onden@localhost:5432/onden_bench`）。
  資料庫名稱必須以 `_bench` 結尾，否則種資料與量測都拒絕執行，不會碰到正式或測試資料庫。
- 重新種資料：`npm run bench:seed`。固定的 PRNG 種子，每次產生同樣的 20,300 個節點（20,000 篇筆記＋300 個標籤）、
  40,000 筆 node_tags、60,000 筆屬性、60,000 條邊、150,000 筆事件、一份含 20,000 篇的發佈快照。
- 選項：`npm run bench -- --runs=15`（每項重複次數，預設 9）、`--reuse-build`（沿用現有的 `packages/frontend/dist`）、
  `--only=backend|frontend|bundle`。
- 沒有 `pgroonga` 的 Postgres 載不了完整的 `schema.sql`；種資料時會自動去掉 `pgroonga`、`vector`
  （清單在 `packages/backend/scripts/bench/common.ts` 的 `SCHEMA_SKIPS`），全文搜尋兩項因此標為「略過」，不當成 0。
  在有 `pgroonga` 的機器上跑會量到，再補上預算。
- 結果寫在 `bench-results.json`（不進版控）；中間檔在 `.bench/`。

## 量什麼

| 項目 | 呼叫的真實程式 |
| --- | --- |
| `backend.bootstrap_lean` | `buildBootstrap`，完整內文、lean2 編碼（受 5,000 篇上限；審查 #8 的慢路徑，只重複 3 次） |
| `backend.bootstrap_slim` | `buildBootstrap`，`?bodies=none`＋lean2（20k 篇客戶端實際走的路） |
| `backend.sync_delta_empty` / `_500_events` | `buildSyncDelta`，沒有新事件／最後 500 筆事件（500 篇不同的筆記） |
| `backend.search_common_word` / `_rare_word` | `searchNodes`（需要 pgroonga） |
| `backend.node_query_sort_attribute` | `runNodeQuery({ sort: "-status", limit: 50 })` |
| `backend.tag_catalog` | `readTagCatalog` |
| `backend.served_site_load` / `media_visibility_check` | `loadServedSite`、`servedSiteShowsMedia`（35 MB 級的發佈快照） |
| `backend.event_list_page` | `GET /api/events?limit=50` 的路由處理 |
| `frontend.*` | 在 Node 裡用真的 sql.js：`decodeBootstrapWire`、`persistBootstrapInto`（空資料庫冷啟）、`applySyncDelta`（500 筆 upsert 對 20k）、`patchNode` 之後的 `tagMemberCounts` |
| `bundle.*` | 正式建置後的 gzip 大小：入口 chunk（`AppRoot`）、登入路徑（island 入口＋ React renderer＋它們的靜態 import 閉包，不含 `import()`） |

每項先暖機 2 次（丟棄），再量 N 次，報告中位數與 p95；預算只比中位數。桌機 CPU 實測值不是手機數字。

## 預算與雜訊

`bench-budgets.json` 的 `median` 是上限，`mainMedian` 是 main 上兩次完整執行中較大的中位數。時間類預算＝`mainMedian`×1.3；
建置大小是確定的，用 ×1.1。雲端共用機器的雜訊可到 ±15%：失敗時先重跑 `npm run bench`，真正的退步每次都會重現。
預算是在雲端容器量的；換機器（尤其是你的實機）第一次請先跑兩次 `npm run bench`，需要時整體重設預算再提交。

## 改善合併後怎麼收緊

1. 合併後在乾淨的 main 上跑兩次 `npm run bench`。
2. 對該項把 `median` 設成兩次中較大的中位數×1.3（建置大小×1.1），並更新 `mainMedian`。
3. 在同一個 PR 的描述寫出舊值與新值；沒收緊的預算會讓退步悄悄吃掉成果。

`bench-budgets.json` 的 `tightenAfter` 列出每個進行中的效能 PR 應該收緊哪些項目（目前是 `perf/d-measured-cuts`）。
