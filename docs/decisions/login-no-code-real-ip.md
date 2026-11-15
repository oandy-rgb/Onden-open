# 登入不用驗證碼；用真實 IP 限速

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-24（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

登入只用帳號密碼，不寄驗證碼；暴力破解靠依真實來源 IP 的限速擋。

## 為什麼

驗證碼依賴寄信，自架者最麻煩；限速足以擋暴力嘗試。

## 例外

—

## 相關檔案與狀態備註

- packages/backend/src/auth.ts（`emailAndPassword`）
- packages/backend/src/authClientIp.ts
- [自架 HTTPS](../self-host/https.md)（反向代理必須覆寫 `X-Forwarded-For`）
