# 首頁設計套件（packages/site，`@onden/site`）

首頁設計的型別、驗證與樣式計算，前後端共用（不含 React、不引入 Puck）。全域規則見[根目錄 AGENTS.md](../../AGENTS.md)；
匯出清單與用途見 [README](README.md)。這個套件沒有 `allowlist/owners.ts`，所以沒有產生的表。

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 讀進任何儲存的首頁設計 | `validateDesign`（不丟例外，回合格設計加問題清單） | `validate.test.ts` |
| 沒有設計時的預設 | `defaultDesign` | `design.test.ts` |
| 走過首頁每個組件 | `walkHome` | `topLevel.test.ts` |
| 氣質、重點色、配色算出 CSS 變數 | `styleVars`／`styleCss`、`schemeColors` | `style.test.ts`、`palette.test.ts` |
| 自訂 CSS 的括號檢查與範圍化 | `bracesBalanced`、`scopedCss`；消毒 CSS 只有 `css.ts` 的 `sanitizeSiteCss` | `css.test.ts`、`packages/markdown/src/test/guards/ownership.guard.test.ts` |
| 組件、slot、巢狀規則 | `registry.ts` 的註冊表（不在別處複製清單） | `design.test.ts` |
| 區塊範本展開 | `expandPattern`、`patternDefaultSlots` | `design.test.ts` |

## 測試

```
cd packages/site
npx tsc --noEmit && npx vitest run
```
