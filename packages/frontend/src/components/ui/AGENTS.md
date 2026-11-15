# components/ui

彈出、選單、對話框、按鈕的唯一主人。畫面不直接寫原生 `<button>`／`<input>`，也不自己做 `position: fixed` 的疊層。
全域規則見[根目錄 AGENTS.md](../../../../../AGENTS.md)；平台全域與 CSS 規則的完整清單見[前端 AGENTS.md](../../../AGENTS.md)。

| 要做的事 | 用 | 守門（`src/test/guards/`） |
| --- | --- | --- |
| 按鈕 | `Button`、`CloseButton`（關閉鈕不自己畫 ×） | `allowlist.guard.test.ts`、`dup-b2-ui.guard.test.ts` |
| 面板標題列 | `SheetHeader`（標題＋文字動作＋×；`CloseButton` 只在這裡與 PanelHeader） | `sheetHeader.guard.test.ts` |
| 對話框、確認框 | `Modal`（`role="alertdialog"` 也用它） | `interactionOwners.guard.test.ts` |
| 底部面板 | `Sheet`、`SheetHandle` | `sheet.guard.test.ts` |
| 彈出選單、浮層定位 | `Popover`、`usePopover` | `ui-owners.guard.test.ts`（`position: fixed`）、`allowlist.guard.test.ts` |
| 分頁列 | `Tabs` | `nav-ui.guard.test.ts` |
| 搜尋／篩選輸入框 | `SearchField`（放大鏡、清除、方向鍵／Enter／Esc、輸入法安全；不用 `TextField` 自己組） | `allowlist.guard.test.ts`（`fe-search-input`） |
| 開關 | `Switch`（`role="switch"` 只在這裡） | `ui-owners.guard.test.ts` |
| 欄位內的錯誤文字 | `FieldError` | `ui-owners.guard.test.ts` |
| 標籤、徽章 | `Chip` | `dup-b2-ui.guard.test.ts` |
| 一排篩選標籤（全部／每個來源、標籤；數量不固定、橫向捲動） | `FilterChips`（5 個以內的固定選項用 `Segmented`） | `entrypointsCatalog.guard.test.ts`（目錄登記） |
| 選日期 | `DatePicker`（不用原生 date input） | `packages/markdown/src/test/guards/tasks-time.guard.test.ts` |

新增元件前先確認上表沒有；`position: fixed`、`z-index`、`@keyframes` 的主人是這個資料夾，其他檔案要用就改用這裡的元件。
