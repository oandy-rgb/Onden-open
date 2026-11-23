# 時間軸只放任務與專注；外部行事曆唯讀 iCal 是例外

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/backend/src/modules/external_calendars/**, packages/frontend/src/modules/external_calendars/**, packages/frontend/src/modules/daily/day/external/**

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-31（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

時間軸只放任務與專注時段。唯一例外是外部行事曆（唯讀 iCal）。

## 為什麼

時間軸若什麼都放，會變成另一個難以掌握的資料來源。

## 例外

唯讀 iCal 外部行事曆。

## 相關檔案與狀態備註

- 時間軸只放計畫的部分已實作（changes/2026-10-31-timeline-plans-only.md）。
- 外部行事曆（唯讀 iCal）已實作（changes/2026-10-31-external-calendars.md）：後端模組 `external_calendars`（`ical.ts` 解析、`refresh.ts` 每 15 分鐘抓取、`store.ts` 網址加密存放：`services/serverSecret.ts` 的用途 `external-calendar`；分兩次部署，第二步才改寫成綁用途的格式），事件存在 `external_calendar_events` 表、不是筆記，沒有 agent 工具；前端 `modules/external_calendars`（設定）與 `modules/daily/day/external/`（時間軸上顯示）。路由只有訂閱、改名／顏色、刪除與手動重抓，沒有寫回行事曆的路徑（`modules/external_calendars/routes.ts`）。臨時工作階段可以讀開啟它的人的行事曆清單與事件（`GET /` 與 `GET /events`），但清單裡的網址主機與抓取錯誤對它是空的，事件只給時間與「忙碌」（標題、地點、說明是空的：地點與說明常帶會議連結與密碼，行事曆又不受空間範圍限制）；訂閱、改名、刪除、重抓仍只准人（`requirePerson`）。
- [日子時間線](../architecture/day-timeline.md)
