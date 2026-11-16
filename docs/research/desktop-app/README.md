# 桌面 App 技術實驗：結論（腳本已移除）

> 狀態：已被取代（2026-11-02；現況見 [portable-backend.md](../../architecture/portable-backend.md)）。10/31 在 PGlite 上做的兩個實驗，結論已被 main 上的可攜後端實作吸收；腳本與 lock 檔刪除。

對應設計文件：[docs/design/desktop-app.md](../../design/desktop-app.md)。

| 實驗 | 當時的結論 | 現在 |
| --- | --- | --- |
| A：PGlite 套用全部遷移 | 拿掉 `age`、`pgroonga`、`pg_stat_statements` 後 150／150 支成功（約 2.6 秒） | 已成為正式程式：`packages/backend/src/dbMigrations.ts` 的 `portableMigrationSql`；整個後端整合測試在 PGlite 上通過，見 [portable-backend.md](../../architecture/portable-backend.md) §7 |
| B：沒有 pgroonga 的中文搜尋 | `pg_trgm` ＋ `ILIKE` 可用；trigram 相似度 `%` 與 `to_tsvector('simple')` 對中文不可用 | 已成為正式程式：`packages/backend/src/services/textSearch.ts` 的可攜引擎，見 portable-backend.md §4 |

限制（當時就有）：只在 PGlite 上做；規模測試只有 200 篇。較大規模的數字在 portable-backend.md §4（1 萬篇約 3 ms）。想重跑舊腳本，從 git 歷史取（本檔之前的版本）。
