# 簡報

> 狀態：現行
> 涵蓋：packages/markdown/src/slideDeck.ts, packages/frontend/src/modules/slides/PresentationPlayer.tsx, packages/frontend/src/modules/slides/present.tsx, packages/backend/src/services/harness/builtinSkills.ts

何時讀：改簡報的切頁規則、全螢幕播放，或想知道「大綱」存在哪裡時。簡報**視角**（版型、主題、`slides_data`）的決定在 [decisions-slides.md](../agents/decisions-slides.md)；
技能筆記格式在 [skills-and-presentation.md](skills-and-presentation.md)。2026-10 的「AI 生成大綱、存成簡報」流程與當時的決定已移到 [presentation-history.md](presentation-history.md)：
內建 API AI 與「做成簡報」入口都已不存在，使用者請自己的 AI（透過 MCP）產生大綱後貼進一則筆記即可播放。

## 簡報就是一則普通筆記

任何筆記都能播放，沒有專用資料表、屬性或節點型別（簡報視角的版型選擇另存在 `slides_data` 屬性，見上面的決定檔），
所以同步、離線、版本、復原、匯出、權限全部沿用筆記的。

切頁規則只有一份：`@onden/markdown` 的 `parseDeck`（`slideDeck.ts`），前端與後端共用。

- 單獨一行的 `---` 換頁；整份筆記沒有任何 `---` 時，改以 `##` 標題開頭換頁。
- 緊接在段落文字下一行的 `---` 是 Markdown 的標題底線（setext），不算換頁；要換頁就在 `---` 前空一行（在清單、標題下面則直接換頁）。
- 程式碼區塊與 `$$` 區塊裡的 `---` 不算；區塊要用同一種標記（``` 或 ~~~）結束。
- 筆記開頭的設定 frontmatter 不算內容。
- 最後一頁若整頁都是 `[n] [[筆記]]`（可帶一個標題）的來源行，它不當成投影片，而是變成各頁的「來源」：頁內 `[n]` 引用到哪幾筆，該頁底部就列出那幾筆的標題。

## 播放

- 入口只有一個：`presentNote`（`modules/slides/present.tsx`）；⌘K、功能分頁的列、簡報分頁的「播放」都呼叫它。它播出編輯器目前的文字（含未存的草稿），並用筆記的 `slides_data` 選擇。
- `PresentationPlayer` 是全螢幕對話框：← → PageUp PageDown 空白鍵 Enter 換頁，Home／End 到首尾，Esc 離開；水平滑動超過 48px 換頁。
- 每頁底部一行列出該頁引用的筆記標題；點其中一個，先離開簡報再打開那則筆記。
- 上一頁、下一頁、關閉按鈕都至少 44px。手機直向時的處理見 decisions-slides.md 的「手機直向」一條。

## 大綱技能

內建技能 `outline`（`services/harness/builtinSkills.ts`，範圍 `board`、`tag`、`nodes`）是一段給使用者自己 AI 的指示，經 MCP prompts 提供（見 [harness.md](harness.md)）：
要求每頁用 `## ` 開頭、頁與頁之間單獨一行 `---`、每頁最多五點、每頁標上引用的 `[n]`，不加筆記沒有的內容。範圍取材的規則（白板上卡片由上到下、同一列由左到右；最多 20 則；只取讀得到的筆記）在 `services/harness/scope.ts`。
Onden 本身不呼叫模型，也不替這份大綱建立筆記；使用者把結果貼成筆記後就是上面說的普通筆記。
