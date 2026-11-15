# 不做點對點同步；支援「伺服器常常不在」；拿掉 Apache AGE

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **實作中** |

## 決定

不做裝置之間的點對點同步。「伺服器常常不在」是支援的自架等級：前端離線可用，連上再同步。拿掉未使用的 Apache AGE。

## 為什麼

點對點同步的衝突與權限都會變難；離線佇列加伺服器已足夠。AGE 沒有被使用卻增加建置成本。

## 例外

—

## 相關檔案與狀態備註

- 離線優先已實作（[同步協定](../architecture/sync-protocol.md)）。
- **與程式不符**：`docker/postgres/Dockerfile` 仍編譯 Apache AGE，`db/schema.sql` 與 `001_baseline.sql` 仍 `CREATE EXTENSION age`。
- **文件缺**：業主指定的 `docs/design/intermittent-server.md` 尚未在 main，這裡不連結。
