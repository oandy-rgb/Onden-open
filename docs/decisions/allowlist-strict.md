# 允許清單嚴格模式；規則全部保留

> 狀態：現行（最後確認 2026-11-01）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **實作中** |

## 決定

允許清單守門的基準必須為空（現在是 `scripts/allowlist-baseline.json` 全部空物件）；規則全部保留（含 import 邊界）。之後清掉各守門的舊例外清單。

## 為什麼

「還沒改」的容身處會讓違規越積越多。

## 例外

—

## 相關檔案與狀態備註

- 嚴格模式已實作；**舊例外清單尚未清**：`packages/*/eslint-rules/*-allowlist.json`、`dup-b2-infra-exceptions.json`、`scripts/dup-*baseline.json`。
- [AGENTS.md](../../AGENTS.md)「允許清單守門」
