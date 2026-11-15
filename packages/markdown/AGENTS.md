# 共用套件（packages/markdown，`@onden/markdown`）

前後端都用的 Markdown 語法、日期規則與共用常數。全域規則見[根目錄 AGENTS.md](../../AGENTS.md)。
路徑相對 `src/`；最後一欄是擋住它的守門測試（`src/test/guards/`）。這個套件沒有 `allowlist/owners.ts`，所以沒有產生的表。

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 去掉強調、刪除線、行內程式碼記號 | `plainText.ts` 的 `plainInline` | `dup-b2-text.guard.test.ts` |
| 去掉標題 `#`、清單與任務記號 | `plainText.ts` 的 `stripLineMarker` | `dup-b2-text.guard.test.ts` |
| 判斷 `[ ]`／`[x]` 任務框 | `plainText.ts` 的 `checklistLine` | `dup-b2-text.guard.test.ts` |
| 判斷程式碼圍欄（` ``` `、`~~~`） | `fences.ts` | `dup-b2-text.guard.test.ts` |
| 找 YAML 前言的範圍 | `frontmatter.ts` 的 `frontmatterEndLine`／`readFrontmatter` | `dup-b2-text.guard.test.ts` |
| 截短文字並加 `…` | `graphemes.ts` 的 `ellipsize`（上限含 `…`） | `dup-b2-text.guard.test.ts` |
| 解析 `[[…]]` 連結 | 線性掃描器；只有掃描器不適用處可寫 regexp | `dup-b2-text.guard.test.ts` |
| 解析 callout 記號 `[!type]` | `callouts.ts` | `ownership.guard.test.ts` |
| 檢查 `#rrggbb` | `color.ts` 的 `isHexColor` | `ownership.guard.test.ts` |
| 檢查網址協定、內嵌 data 媒體 | `urlSchemes.ts` | `ownership.guard.test.ts` |
| 字數、閱讀時間 | `readingTime.ts` | `ownership.guard.test.ts` |
| 名稱長度上限 | `sharedContract.ts` 的常數 | `ownership.guard.test.ts` |
| 前後端要一致的常數（任務模組 id、`_task_*` 屬性鍵、回溯上限、密碼長度、檢視欄位…） | `sharedContract.ts` | `crossPackage.guard.test.ts` |
| UUID、顏色、區塊 id 長什麼樣 | `isUuid`／`UUID_SOURCE`、`isHexColor`、`BLOCK_ID_CHARS` | `crossPackage.guard.test.ts` |
| 一段文字是哪一天、任務落在哪個 bucket、日期加減 | `parseDateText`、`taskBucket`／`taskHome`、`addDays`／`daysBetween`／`addMonths`、`isCalendarDay` | `tasks-time.guard.test.ts` |

## 測試

```
cd packages/markdown
npx tsc --noEmit && npx vitest run
```

改了這裡的匯出，前端與後端都會受影響：兩邊也跑各自的 `npx tsc --noEmit`。
