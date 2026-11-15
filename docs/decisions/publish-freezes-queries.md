# 發布時查詢／資料庫區塊凍結成快照

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-19（業主決定，2026 年） |
| 實作狀態 | **已定案（未逐項對照程式）** |

## 決定

發布出去的頁面裡，查詢或資料庫區塊在發布當下凍結成快照，不隨之後的資料變動。

## 為什麼

公開頁面不該因私人資料的改動而洩漏或變形。

## 例外

—

## 相關檔案與狀態備註

- [發布改版](../architecture/proposals/publish-redesign-2026-10-24.md)
- [網站呈現模型](../architecture/site-render-model.md)
- packages/backend/src/modules/website/publishing/
