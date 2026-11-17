# AI 中立：介面與文件不出現商家／產品名

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：scripts/lib/vendorNames.mjs, packages/frontend/src/test/guards/aiVendorNames.guard.test.ts, packages/backend/src/test/guards/aiVendorNames.guard.test.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

介面、使用者文件、變數名稱與註解不出現商家或產品名。

## 為什麼

Onden 不綁定特定 AI；使用者用哪一家是他的選擇。

## 例外

匯入功能（可寫來源軟體名）；真的連到該服務的整合（帳號登入、發布到 GitHub Pages、備份到 GitHub）；實際使用的套件名；字型名。

## 相關檔案與狀態備註

- 已清理並有守門：前端、markdown、site 套件的程式與 zh-TW／英文字串不出現商家、產品或模型家族名（`aiVendorNames.guard.test.ts`，只有 `ai-protocol-client` 的協定轉接資料夾例外）；後端那半（伺服器訊息、`.env.example`、`docs/self-host`、`changes/`）由後端同名守門測試擋。
- 2026-11-17 核對：對 `packages/frontend/src`、`packages/markdown/src`、`packages/site/src` 的 1688 個檔案跑 `vendorHits`，0 筆；`packages/frontend/src` 非測試檔沒有 `Claude` 字樣，`docs/self-host/` 也沒有。2026-11-01 記的「約 130 行」與 `ApiKeys.tsx` 已不存在。
- [AGENTS.md](../../AGENTS.md)「工作方式」
