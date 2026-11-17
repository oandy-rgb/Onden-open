# 身分只有擁有者與成員；擁有者逐空間設定成員

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/spine/spaceAccess.ts, packages/backend/src/routes/invites.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-22（10-18 邀請）（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

身分只有「擁有者」「成員」，擁有者逐空間決定誰是成員（權限只在「空間與成員」一個畫面）。加入別人用 email 邀請，對方第一次登入時認領。新筆記預設「只有我」。

### 臨時工作階段不是第三種身分

「工作階段」（`actors.type = 'session'`，`participant_sessions`）是某個人臨時開出來的操作者，不是第三種角色：它屬於開它的人，只能讀寫開的時候指定的空間，
且永遠不比開的人現在能做的多（開的人被降權或離開空間，它同一刻跟著縮）。它不能管理成員、開別的工作階段、啟動 AI、備份、整份匯出、取快照，也不能寫個人資料
（`isPerson`／`requirePerson` 對它一律拒絕）。設計與清查見[提案](../architecture/proposals/sessions-core-2026-11-17.md)。

## 為什麼

角色與標籤權限組合太多，使用者說不清誰看得到什麼；改成「放在哪裡」決定。

## 例外

—

## 相關檔案與狀態備註

- [空間](../architecture/spaces.md)
- [提案：只剩擁有者／成員](../architecture/proposals/roles-owner-member-2026-10-22.md)
- packages/backend/src/spine/spaceAccess.ts
- packages/backend/src/routes/invites.ts
