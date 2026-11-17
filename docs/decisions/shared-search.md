# 側欄與指令面板共用同一套搜尋

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/frontend/src/lib/data/noteSearch.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-29（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

搜尋筆記只有一個入口：伺服器優先、離線退回本機、最後錯字容忍。

## 為什麼

兩套搜尋會給出不同結果，使用者無法預期。

## 例外

—

## 相關檔案與狀態備註

- packages/frontend/src/lib/data/noteSearch.ts（`reads.notes.search`）
- 查詢語法 `parseSearchQuery`（`@onden/markdown`）
