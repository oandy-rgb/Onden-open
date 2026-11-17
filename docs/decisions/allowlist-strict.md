# 允許清單嚴格模式；規則全部保留

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：scripts/allowlist-baseline.json, scripts/allowlistLib.mjs, scripts/allowlist.mjs, scripts/checkEditedFile.mjs

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-01（業主決定，2026 年） |
| 實作狀態 | **實作中** |

## 決定

允許清單守門的基準必須為空（2026-11-01 時 `scripts/allowlist-baseline.json` 全部是空物件；現況見下方備註）；規則全部保留（含 import 邊界）。之後清掉各守門的舊例外清單。

## 為什麼

「還沒改」的容身處會讓違規越積越多。

## 例外

—

## 相關檔案與狀態備註

- 嚴格模式已實作：`scripts/allowlistLib.mjs` 對不在 `RATCHET_RULES` 的規則，基準有任何項目就失敗。
- **業主 2026-11-17 決定：「例外清單全部清空」**——帶逐檔計數的規則（`RATCHET_RULES`）也要歸零、改成嚴格模式，不是例外該留著。當天的狀況（讀 `scripts/allowlist-baseline.json`）：原有五條，`fe-literal-api-write`（26 檔 61 處）與 `fe-store-write`（1 處）已歸零並移出 `RATCHET_RULES`；還在進行：`fe-app-store-reach`（85 檔 174 處）、`fe-store-inline-selector`（54 檔 94 處）、`be-raw-sql`（194 檔 897 處，分批改寫，做法見 [工作指示](../research/allowlist-empty-brief-2026-11-17.md)）。現在的數字以 `scripts/allowlist-baseline.json` 為準。
- 舊例外清單還沒清完（2026-11-17）：`packages/frontend/eslint-rules/module-entry-allowlist.json` 仍有項目（後端同名檔已是 `{}`）、`packages/backend/eslint-rules/dup-b2-infra-exceptions.json` 剩 `console` 一項、`packages/backend/eslint-rules/route-input-exceptions.json` 仍有逐檔計數、`scripts/dup-names-baseline.json`、`scripts/dup-near-baseline.json` 仍有內容（`scripts/dup-baseline.json` 只剩 45 位元組）。`packages/*/eslint-rules/*-allowlist.json` 這個樣式只剩 `module-entry-allowlist.json`。
- [AGENTS.md](../../AGENTS.md)「允許清單守門」
