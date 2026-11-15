# 歷史頁與新增／改名筆記變快（2026-10-30）

> 狀態：歷史紀錄（最後確認 2026-11-01）

處理 [perf-2026-10-27.md](perf-2026-10-27.md) 的第 1、2 點。量測用同一份報告的資料與腳本（`clone.sql` 長出 20k、`create-latency.mjs`），
另加 [feed-timing.mjs](perf-2026-10-27/feed-timing.mjs)（歷史清單的伺服器時間）與
[history-open.mjs](perf-2026-10-27/history-open.mjs)（從「更多 → 歷史」到清單出現）。

## 結果

環境與 10-27 相同（雲端 4 vCPU，backend、PG、nginx、Chromium 同一台）；改前是 `origin/main` 的建置，改後是這個分支，
兩者都從同一份資料庫快照還原（每個階層各一份），每次重新啟動後量。5k／20k 的歷史清單是當天有 5,105 篇被編輯的那種最壞情況。

| 項目 | 5k 改前 | 5k 改後 | 20k 改前 | 20k 改後 |
| --- | --- | --- | --- | --- |
| `GET /api/history/feed` 伺服器時間（中位數，5 次） | 7,055 ms | 139 ms | 7,452 ms | 167 ms |
| 回應大小 | 1.9 MB | 19 KB | 1.9 MB | 19 KB |
| 歷史頁：點「歷史」到清單出現（中位數，3 次） | 10.1 秒 | 0.76 秒 | 9.7 秒 | 0.86 秒 |
| 同上，主執行緒 long task 合計 | 3,086 ms | 0 ms | 2,783 ms | 103 ms |
| 清單上的列數 | 5,106 | 50（另有「顯示更多」） | 5,106 | 50（另有「顯示更多」） |
| 新增一篇筆記（中位數，10 次） | 253 ms | 62 ms | 884 ms | 74 ms |
| 改名一篇筆記（中位數，10 次） | 283 ms | 65 ms | 959 ms | 74 ms |

10-27 報告量到的 1k 是新增 79 ms；這次沒有重做 1k（快照沒有留下），20k 的 74 ms 與它同一個量級，且 5k→20k 只多 12 ms。

沒有量：手機尺寸的歷史頁、1k 階層、改前的「顯示更多」（改前沒有這個功能）。

## 做了什麼

### 歷史（`services/history/activity.ts`）
- 參與者（actors）改在一個查詢裡每個（日、筆記）只聚合一次，再接到要回傳的列上；原本每個輸出列各掃一遍 `edits`（O(N²)）。
- 每天先排名（新到舊），只取前 50 篇（`FEED_NOTES_PER_DAY`）；變更摘要（前後內文雜湊與 diff）只對這些列算。
  一天的篇數 `notes_total` 與修改次數 `edits_total` 在同一個查詢裡用 window function 算出，所以標題的「N 次修改」仍是全天的數字。
- 前後內文雜湊改成一個語句裡對每個（筆記、日）做 LATERAL，不再在每個輸出列的 SELECT 清單裡各查兩次。
- 新增 `GET /api/history/day/notes?date=&offset=&limit=`（「顯示更多」用）。前端 `useHistoryFeed.loadMoreNotes` 取下一頁接在清單後面；
  失敗時保留已顯示的列並提示，可再按一次。沒有新增視窗化元件：`useRowWindow` 需要自己的捲動容器，歷史頁是整頁流動，限制初始列數已把 DOM 降到 50 列。
- 讀取範圍照舊：仍是 `readableNotesSql`（readPolicy）的 SQL 範圍，讀不到的筆記不進清單，也不計入 `notes_total`／`edits_total`。

### 新增／改名（`services/wikilinkEdges.ts`）
- 只有改名、別名、換空間、從垃圾桶回來才會 relink；只改內文不會（`applyBodyChange` 只在 `renamed` 時呼叫），這次沒有改這點。
- `relinkTarget` 原本對所有含 `[[` 的筆記做 `lower()`＋`strpos`＋正規表示式。現在每篇筆記有一列 `note_link_index`（migration 146）：
  內文裡每個連結的小寫目標與 slug，正是 `linkMatchesNodeSql` 比對的那兩組陣列。找「現在連到這個名字」的筆記是用 GIN 索引查，
  再交給同一個 `linkMatchesNodeSql` 規則做最後判斷（規則本身沒動）。
- 這列只在「描述的就是目前內文」時才可信：觸發器在 `markdown` 改變時把該列標成 `stale`，`syncWikilinkEdges`（所有內文寫入都會走）重寫並清除 `stale`。
  `stale` 的筆記照舊讀內文（舊做法）。所以任何繞過 `syncWikilinkEdges` 的寫入都只會變慢，不會漏連結。
- 既有筆記在 migration 時全部是 `stale`；伺服器啟動後在背景補齊（`indexMissingNoteLinks`，不擋啟動）。
  20k 筆記從啟動到補完約 27 秒，期間 relink 對還沒補到的筆記用舊做法，結果相同。

## 結果一致的驗證

- 歷史：同一份 5k、20k 資料，改前與改後的 `/api/history/feed`，改後每天的前 50 列與改前同一天的前 50 列逐欄位相同
  （含參與者、變更摘要、`first_at`／`last_at`、`created`），`agent_runs`、`rewinds`、`end_at`、`earlier_day` 也相同；
  `notes_total` 等於改前的當天篇數，`edits_total` 等於改前各列 `edits` 的總和。
- relink：`wikilinkRelinkIndex.integration.test.ts` 對同一組過期的邊，一次走索引、一次把全部列標成 `stale`（走舊做法），結果的邊集合必須相同。
  情境含：大小寫、`[[ALPHA|顯示]]`、`[[名#段落]]`、slug 寫法、JSON 陣列別名與單一別名、`onden://node/<id>`、
  另一個空間（含標籤全域可連）、垃圾桶中的來源、刪除後重建同名。

## 還剩的

- `syncWikilinkEdges` 的來源端比對（`content_nodes n, content_nodes s WHERE linkMatchesNodeSql`）仍對整個工作區做 `lower(normalize(title))`，
  20k 時每次新增約 30 ms。要改得靠 `lower(normalize(title))` 的運算式索引並把 OR 拆成各自走索引的幾路，這次沒動。
- 歷史清單的伺服器時間（約 150 ms）仍隨「當天被編輯的篇數」增加（要為全部篇數排名並算總數）；這次沒有定位到更細的成本。
