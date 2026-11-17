# 別人可以自架；發行版來自 main；公開發布要乾淨

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：scripts/public-mirror/**, scripts/release.sh, .github/workflows/release.yml, docs/self-host/*.md

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-24（業主決定，2026 年） |
| 實作狀態 | **實作中** |

## 決定

別人可以自架；發行版來自 main。公開發布時開一個**不帶歷史**的新 repo，授權乾淨（不引入 GPL／AGPL 相依）。

## 為什麼

歷史內有內部流水帳與部署細節；授權不乾淨會限制別人使用。

## 例外

—

## 相關檔案與狀態備註

- 自架文件已有（`docs/self-host/`：https、recovery、upgrade、ai-client-on-a-machine）。發行版：`scripts/release.sh`、`.github/workflows/release.yml` 與 [release.md](../agents/release.md)（映像推 GHCR，`latest` 指向最新穩定版，不是 main）。
- 公開庫已經存在並跟著私人庫：`scripts/public-mirror/public-push.sh` 把某個 ref 的內容做成**一個**提交推到公開庫，私人庫的提交歷史不會被推過去（見 [public-mirror README](../../scripts/public-mirror/README.md)）。這符合「不帶歷史」；README 寫「之後公開庫會變成正本（切換另外公告）」，所以正式公開發布（切換）還沒宣布。
- 授權乾淨：靠 `npm run notices:check` 與 `scripts/licence-policy-baseline.json`（不在清單上的授權先問擁有者，見根目錄 AGENTS.md）；本文沒有重新逐一核對相依的授權。
- 2026-11-17 起鏡像的自動工作流程先關掉（Actions 額度用完），由合併者手動跑，見該 README。
- [自架 HTTPS](../self-host/https.md)、[帳號救援](../self-host/recovery.md)
