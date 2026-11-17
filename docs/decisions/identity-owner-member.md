# 身分只有擁有者與成員；擁有者逐空間設定成員

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/spine/spaceAccess.ts, packages/backend/src/routes/invites.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-22（10-18 邀請）（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

身分只有「擁有者」「成員」，擁有者逐空間決定誰是成員（權限只在「空間與成員」一個畫面）。加入別人用 email 邀請，對方第一次登入時認領。新筆記預設「只有我」。

## 為什麼

角色與標籤權限組合太多，使用者說不清誰看得到什麼；改成「放在哪裡」決定。

## 例外

—

## 相關檔案與狀態備註

- [空間](../architecture/spaces.md)
- [提案：只剩擁有者／成員](../architecture/proposals/roles-owner-member-2026-10-22.md)
- packages/backend/src/spine/spaceAccess.ts
- packages/backend/src/routes/invites.ts
