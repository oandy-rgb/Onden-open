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
- **與決定不同（給業主）**：決定寫「基準必須為空」，但 `RATCHET_RULES` 另有五條規則允許逐檔計數、只減不增：`be-raw-sql`（194 檔 897 處）、`fe-app-store-reach`（85 檔 174 處）、`fe-store-inline-selector`（54 檔 94 處）、`fe-literal-api-write`（26 檔 61 處）、`fe-store-write`（1 檔 1 處）；其餘規則皆為空物件（2026-11-17 讀 `scripts/allowlist-baseline.json` 統計）。後四條是 2026-11-14 之後加進來的，`AGENTS.md` 只寫 `be-raw-sql` 一個例外。這是決定改了、還是例外該收回，由業主定；本文不改決定。
- 舊例外清單還沒清完（2026-11-17）：`packages/frontend/eslint-rules/module-entry-allowlist.json` 仍有項目（後端同名檔已是 `{}`）、`packages/backend/eslint-rules/dup-b2-infra-exceptions.json` 剩 `console` 一項、`packages/backend/eslint-rules/route-input-exceptions.json` 仍有逐檔計數、`scripts/dup-names-baseline.json`、`scripts/dup-near-baseline.json` 仍有內容（`scripts/dup-baseline.json` 只剩 45 位元組）。`packages/*/eslint-rules/*-allowlist.json` 這個樣式只剩 `module-entry-allowlist.json`。
- [AGENTS.md](../../AGENTS.md)「允許清單守門」
