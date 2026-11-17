# 不做點對點同步；支援「伺服器常常不在」；拿掉 Apache AGE

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：docker/postgres/Dockerfile, packages/backend/db/migrations/158_drop_age.sql, docs/design/intermittent-server.md

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **已實作**（離線優先與拿掉 AGE；「伺服器常常不在」的其餘項目見備註） |

## 決定

不做裝置之間的點對點同步。「伺服器常常不在」是支援的自架等級：前端離線可用，連上再同步。拿掉未使用的 Apache AGE。

## 為什麼

點對點同步的衝突與權限都會變難；離線佇列加伺服器已足夠。AGE 沒有被使用卻增加建置成本。

## 例外

—

## 相關檔案與狀態備註

- 離線優先已實作（[同步協定](../architecture/sync-protocol.md)）。
- AGE 已拿掉：`docker/postgres/Dockerfile` 只裝 pgvector 與 PGroonga 的 apt 套件，不編譯 AGE；`packages/backend/db/migrations/158_drop_age.sql` 對既有資料庫 `DROP EXTENSION age`（還有圖資料就拒絕執行）。`packages/backend` 下沒有任何 `CREATE EXTENSION … age`（2026-11-17 `grep` 結果）。
- 設計文件在 main：[intermittent-server.md](../design/intermittent-server.md)。檔頭狀態仍是「提案（2026-11-02，待業主決定）」，內容分批（①–④）是否都做完，本文沒有逐項核對。
