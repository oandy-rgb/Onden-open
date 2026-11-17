# 閱讀只留 RSS；摘錄模型

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/markdown/src/excerpt.ts, packages/frontend/src/modules/rss/rssQuote.ts, packages/frontend/src/components/pdf/PdfHighlights.tsx

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-18、10-29（業主決定，2026 年） |
| 實作狀態 | **實作中** |

## 決定

閱讀功能只留 RSS。RSS 劃線是「摘錄」：帶來源的段落。PDF 劃線預設是可引用的 `^id` 段落，可隨時升級成子筆記。

## 為什麼

引用要追得到來源，又不想每段劃線都變一篇筆記。

## 例外

—

## 相關檔案與狀態備註

- RSS 劃線已實作：`modules/rss/rssQuote.ts` 呼叫共用的 `excerptBlock`（`@onden/markdown`）。
- PDF 劃線：PDF 檢視器有自己的劃線（`components/pdf/PdfHighlights.tsx`，存成 PDF 標註紀錄，座標在 `lib/pdf/coords.ts`），**不是**決定裡說的「可引用的 `^id` 段落」：除了 `rssQuote.ts` 沒有別處呼叫 `excerptBlock`，PDF 劃線也不會升級成子筆記。這一半尚未照決定做（2026-11-17 `grep excerptBlock`）。
- 「閱讀頁依網址找出劃線」尚未做：後端沒有「網址 → 摘錄」的索引（`excerpts.md`「之後」仍如此寫）。
- [摘錄](../architecture/excerpts.md)
- [段落節點](../architecture/block-nodes.md)
