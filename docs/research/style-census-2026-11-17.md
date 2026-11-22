# 外觀普查 2026-11-17

> 狀態：歷史紀錄（2026-11-17 的一次測量，由 `npm run style:census` 寫出，之後不再更新；工具與判定標準見 [e2e/style-census/README.md](../../packages/frontend/e2e/style-census/README.md) 與 [appearance-rules.md](../agents/appearance-rules.md)）

範圍：51 個畫面 × 8 個「寬度×主題」，實際量到 398 個畫面×寬度×主題；在瀏覽器版（`dist-browser`，資料是產生的）量的是**算出來的樣式**（computed style），不是原始碼寫的。
成本：1180 秒（3 個並行）；Node 峰值記憶體約 334 MB，Chromium 全部程序加總峰值約 5861 MB。

「次數」是（元素 × 屬性）出現的次數，不是宣告數：同一個 `padding: 8px` 在 40 個按鈕上算 4×40。「不在刻度上」依 appearance-rules.md 的草案判定（業主還沒看過，數字會變）。

## 一、每種值：量到幾種、幾種不在刻度上

| 種類 | 有沒有守門 | 量到的次數 | 不同的值 | 不在刻度上的次數 | 不在刻度上的值 | 原始碼：寫死的宣告／用 token 的宣告 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 顏色（`colour`） | fe-css-color（只擋寫死的顏色，不擋用哪個 token） | 41767 | 76 | 3800（9%） | 59 | 3／3115 |
| 字級（`font-size`） | fe-css-font-size（只擋寫死的數字，不擋 token 的個數） | 20076 | 26 | 7792（39%） | 20 | 76／1030 |
| 字重（`font-weight`） | **沒有** | 20076 | 4 | 2493（12%） | 1 | 300／27 |
| 行高（`line-height`） | **沒有** | 20076 | 12 | 4494（22%） | 9 | 171／7 |
| 字距（`letter-spacing`） | **沒有** | 20076 | 7 | 282（1%） | 5 | 37／2 |
| 字體（`font-family`） | **沒有** | 20076 | 4 | 0（0%） | 0 | 18／67 |
| 間距（padding／margin／gap）（`spacing`） | **沒有** | 73005 | 51 | 38310（52%） | 43 | 2360／155 |
| 圓角（`radius`） | fe-css-radius | 57908 | 8 | 42356（73%） | 5 | 4／652 |
| 邊框粗細（`border-width`） | **沒有** | 28600 | 4 | 30（0%） | 1 | 589／15 |
| 邊框樣式（`border-style`） | **沒有** | 8580 | 2 | 0（0%） | 0 | 21／0 |
| 邊框出現的位置（`border-where`） | **沒有** | 8580 | 9 | 5916（69%） | 3 | —（動態量不到靜態） |
| 陰影（`shadow`） | fe-css-shadow | 894 | 18 | 418（47%） | 11 | 2／99 |
| 控制項高度（畫出來的）（`control-height`） | **沒有** | 11780 | 82 | 8322（71%） | 79 | 603／45 |
| 觸控目標（實際可點的大小，只在觸控螢幕量）（`tap-target`） | **沒有** | 7138 | 77 | 4293（60%） | 46 | —（動態量不到靜態） |
| 圖示尺寸（`icon-size`） | **沒有** | 6342 | 23 | 3686（58%） | 16 | —（動態量不到靜態） |
| 圖示線寬（`icon-stroke`） | **沒有** | 6312 | 2 | 6292（100%） | 1 | —（動態量不到靜態） |
| 層級（`z-index`） | fe-css-z-index | 1332 | 19 | 454（34%） | 9 | 0／95 |
| 最大寬度（文字欄與容器）（`max-width`） | **沒有** | 927 | 26 | 903（97%） | 23 | 147／13 |
| 透明度（`opacity`） | **沒有** | 1356 | 9 | 924（68%） | 7 | 196／0 |
| 動畫時間（`transition-ms`） | **沒有** | 51014 | 7 | 14768（29%） | 5 | 75／9 |
| 焦點框（`focus-ring`） | **沒有** | 1190 | 5 | 870（73%） | 3 | 44／86 |

靜態那欄對不到 1:1：一個 `border: 1px solid var(--x)` 同時算邊框粗細、樣式與顏色；`calc()`、`em` 之類相對值算寫死。圖示尺寸另見第六節。

## 一之二、觸控目標（`pointer: coarse` 下，實際可點的大小）

對照業主 2026-11-17 在 Galaxy Tab S9（視窗 1204×714）上量的真機數字：同樣把「寬或高任一邊小於 44 CSS px」算不到。這裡的「可點大小」是用 `elementFromPoint` 從四邊往外量出來的，**畫面上看不見的擴大點擊範圍會算進去**。只量視窗內完整看得到的 button、連結、tab、輸入框等（淺色主題；捲到視窗外的沒有量）。觸控模擬不是真機。

| 寬度 | 量到的控制項 | 不到 44 | 比例 |
| --- | ---: | ---: | ---: |
| 390 | 805 | 301 | 37% |
| 1280x800 | 1950 | 1526 | 78% |
| 800x1280 | 844 | 340 | 40% |

### 390：每個畫面（控制項／不到 44）

| 畫面 | 控制項 | 不到 44 |
| --- | ---: | ---: |
| `tree-expanded` | 31 | 24 |
| `tree-selected-parent` | 31 | 24 |
| `note-missing` | 31 | 24 |
| `canvas` | 30 | 19 |
| `ai-panel` | 27 | 18 |
| `note-long` | 17 | 11 |
| `note-children` | 21 | 10 |
| `note-callouts` | 16 | 10 |
| `note-ink` | 28 | 10 |
| `offline` | 17 | 10 |
| `settings-4` | 13 | 10 |
| `note-image` | 15 | 9 |
| `note-pdf` | 26 | 9 |
| `empty-tasks` | 27 | 9 |
| `settings-6` | 19 | 9 |

最小的控制項（可點大小由小到大；「畫出來」是看得到的框，「可點」是含擴大範圍）：

| 元素 | 畫出來 | 可點 | 次數 | 出現在 |
| --- | --- | --- | ---: | --- |
| `…bcanvas-btn.card-node-subcanvas-btn--create.nodrag[aria-label="建立子白板"]` | 4.9×6.6 | 4.9×6.6 | 1 | canvas |
| `… > div.card-node-preview.card-md-preview > button.wikilink-token.known` | 39.1×7.2 | 39.1×7.2 | 1 | canvas |
| `…node > div.card-node-header > input.card-node-title-input.nodrag.nopan` | 69.8×8.8 | 69.8×8.8 | 4 | canvas |
| `…root > div.card-node-header > input.card-node-title-input.nodrag.nopan` | 62.6×8.8 | 62.6×8.8 | 1 | canvas |
| `…node-header > button.card-node-fold-btn.nodrag.nopan[aria-label="摺起來"]` | 8.8×8.8 | 15.8×13.8 | 4 | canvas |
| `…node-header > button.card-node-fold-btn.nodrag.nopan[aria-label="摺起來"]` | 8.8×8.8 | 15.8×13.8 | 1 | canvas |
| `…--md > ul.contains-task-list > li.task-list-item > span[role=checkbox]` | 14×14 | 14×14 | 2 | history |
| `…l.contains-task-list > li.task-list-item > span[role=checkbox].checked` | 14×14 | 14×14 | 1 | history |
| `…tree-root > button.card-branch-toggle.nodrag.nopan[aria-label="收起子筆記"]` | 16.1×16.1 | 16.1×16.1 | 1 | canvas |
| `…card-node > button.card-branch-toggle.nodrag.nopan[aria-label="收起子筆記"]` | 16.1×16.1 | 16.1×16.1 | 1 | canvas |
| `…[aria-label="筆記標籤"] > button.prop-tag.prop-tag--add[aria-label="加上標籤"]` | 11×11 | 18×36 | 5 | note-long、note-children、note-callouts、ai-panel、offline |
| `…I 的問題"] > div.note-ai-sources[aria-label="來源"] > button.note-ai-source` | 112.5×18.8 | 112.5×18.8 | 1 | ai-panel |

### 1280x800：每個畫面（控制項／不到 44）

| 畫面 | 控制項 | 不到 44 |
| --- | ---: | ---: |
| `canvas` | 81 | 69 |
| `ai-panel` | 72 | 65 |
| `info-features` | 67 | 59 |
| `offline` | 63 | 58 |
| `note-long` | 64 | 56 |
| `info-relations` | 67 | 56 |
| `note-callouts` | 63 | 56 |
| `info-tags` | 63 | 55 |
| `note-image` | 59 | 53 |
| `note-ink` | 59 | 53 |
| `slides` | 59 | 52 |
| `note-children` | 63 | 51 |
| `tree-expanded` | 57 | 51 |
| `tree-selected-parent` | 67 | 51 |
| `note-pdf` | 57 | 51 |

最小的控制項（可點大小由小到大；「畫出來」是看得到的框，「可點」是含擴大範圍）：

| 元素 | 畫出來 | 可點 | 次數 | 出現在 |
| --- | --- | --- | ---: | --- |
| `…bcanvas-btn.card-node-subcanvas-btn--create.nodrag[aria-label="建立子白板"]` | 12.1×16.1 | 12.1×16.1 | 1 | canvas |
| `…--md > ul.contains-task-list > li.task-list-item > span[role=checkbox]` | 14×14 | 14×14 | 2 | history |
| `…l.contains-task-list > li.task-list-item > span[role=checkbox].checked` | 14×14 | 14×14 | 1 | history |
| `… > div.card-node-preview.card-md-preview > button.wikilink-token.known` | 95.5×17.5 | 95.5×17.5 | 1 | canvas |
| `…[aria-label="筆記標籤"] > button.prop-tag.prop-tag--add[aria-label="加上標籤"]` | 11×11 | 18×36 | 13 | note-long、split-note-note、note-children、info-features、info-tags |
| `…mb[aria-label="此筆記的位置"] > ol.breadcrumb-trail > button.breadcrumb-item` | 96×18 | 96×18 | 1 | tree-expanded |
| `…I 的問題"] > div.note-ai-sources[aria-label="來源"] > button.note-ai-source` | 112.5×18.8 | 112.5×18.8 | 2 | ai-panel、search-empty |
| `…idian-group > div.obsidian-group-header > button.obsidian-group-toggle` | 20×34 | 20×34 | 18 | note-long、note-children、info-features、info-tags、info-relations |
| `…-header.obsidian-group-header--indented > button.obsidian-group-toggle` | 20×34 | 20×34 | 16 | info-features、info-tags、info-relations、tree-expanded、tree-selected-parent |
| `…題"] > button.note-edge-line.note-edge-line--h2[aria-label="第一節：為什麼要寫"]` | 24×20 | 24×20 | 10 | note-long、split-note-note、info-features、info-tags、info-relations |
| `…"] > button.note-edge-line.note-edge-line--h2[aria-label="第二節：程式碼與表格"]` | 24×20 | 24×20 | 10 | note-long、split-note-note、info-features、info-tags、info-relations |
| `…="標題"] > button.note-edge-line.note-edge-line--h2[aria-label="第三節：任務"]` | 24×20 | 24×20 | 10 | note-long、split-note-note、info-features、info-tags、info-relations |

### 800x1280：每個畫面（控制項／不到 44）

| 畫面 | 控制項 | 不到 44 |
| --- | ---: | ---: |
| `tree-expanded` | 32 | 25 |
| `tree-selected-parent` | 32 | 25 |
| `note-missing` | 32 | 25 |
| `canvas` | 30 | 22 |
| `ai-panel` | 31 | 22 |
| `note-long` | 21 | 15 |
| `offline` | 21 | 14 |
| `note-children` | 21 | 10 |
| `tasks` | 31 | 10 |
| `note-callouts` | 16 | 10 |
| `note-ink` | 30 | 10 |
| `empty-tasks` | 28 | 10 |
| `settings-4` | 16 | 10 |
| `note-image` | 15 | 9 |
| `note-pdf` | 28 | 9 |

最小的控制項（可點大小由小到大；「畫出來」是看得到的框，「可點」是含擴大範圍）：

| 元素 | 畫出來 | 可點 | 次數 | 出現在 |
| --- | --- | --- | ---: | --- |
| `…bcanvas-btn.card-node-subcanvas-btn--create.nodrag[aria-label="建立子白板"]` | 10.6×14.1 | 10.6×14.1 | 1 | canvas |
| `…--md > ul.contains-task-list > li.task-list-item > span[role=checkbox]` | 14×14 | 14×14 | 2 | history |
| `…l.contains-task-list > li.task-list-item > span[role=checkbox].checked` | 14×14 | 14×14 | 1 | history |
| `… > div.card-node-preview.card-md-preview > button.wikilink-token.known` | 83.9×15.4 | 83.9×15.4 | 1 | canvas |
| `…[aria-label="筆記標籤"] > button.prop-tag.prop-tag--add[aria-label="加上標籤"]` | 11×11 | 18×36 | 5 | note-long、note-children、note-callouts、ai-panel、offline |
| `…node > div.card-node-header > input.card-node-title-input.nodrag.nopan` | 149.7×18.8 | 149.7×18.8 | 4 | canvas |
| `…root > div.card-node-header > input.card-node-title-input.nodrag.nopan` | 134.4×18.8 | 134.4×18.8 | 1 | canvas |
| `…I 的問題"] > div.note-ai-sources[aria-label="來源"] > button.note-ai-source` | 112.5×18.8 | 112.5×18.8 | 1 | ai-panel |
| `… div.appearance-preview-app > button.ui-btn.ui-btn--primary.ui-btn--sm` | 79.5×24.3 | 79.5×24.3 | 1 | settings-more |
| `…內容"] > div.cm-line > span[role=checkbox].cm-task-box[aria-label="未完成"]` | 25.5×28.9 | 25.5×28.9 | 8 | note-long、ai-panel、phone-more-sheet、offline |
| `…記內容"] > div.cm-line > span[role=checkbox].cm-task-box[aria-label="完成"]` | 25.5×28.9 | 25.5×28.9 | 4 | note-long、ai-panel、phone-more-sheet、offline |
| `…ge-note > div.day-page-body.journal-body > button.wikilink-token.known` | 134×25.8 | 134×25.8 | 3 | daily、daily-date-picker、day-with-notes |

## 二、各種類的值（次數前 14 名；❌＝不在刻度上）

### 顏色（`colour`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `--ac-line` | 12834 | 398 | ✔ | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；border-bottom-color；— |
| `--ac-ink` | 10072 | 398 | ✔ | `…視角"] > button[role=tab].view-tab.view-tab--active > span.view-tab-name`；color；— |
| `--ac-muted` | 7272 | 382 | ✔ | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；color；— |
| `--ac-surface` | 2330 | 382 | ✔ | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；background-color；— |
| `--ac-accent` | 2298 | 358 | ✔ | `…label="筆記標籤"] > span.prop-tag.prop-tag--applied > button.prop-tag-name`；color；— |
| `--ac-bg` | 1143 | 268 | ✔ | `body.onden-note-detail`；background-color；— |
| `alpha:--ac-muted@0.55` | 1116 | 80 | ❌ token 加透明度疊出來的顏色（A 只用 token 本身） | `…ria-label="筆記內容"] > div.cm-line.cm-fold-head.cm-fold-open > span.ͼh.ͼs`；color；(找不到：inline <style>) |
| `--ac-code-bg` | 680 | 162 | ✔ | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；background-color；— |
| `--ac-accent-ink` | 464 | 248 | ✔ | `div.app-topbar-right > div.user-menu-wrap > button.user-chip > span`；color；— |
| `--ac-overlay-hover` | 400 | 132 | ✔ | `…v.topbar-desktop-only[aria-label="主要"] > button.topbar-mode-btn.active`；background-color；— |
| `raw:rgb(136, 136, 136)` | 272 | 72 | ❌ 沒有對應的 --ac-* token | `…f > span.obsidian-group-toggle.sb-tagtree-toggle > span.sb-tagtree-dot`；background-color；packages/frontend/src/styles/sidebar.css:111 |
| `alpha:--ac-accent@0.08` | 248 | 64 | ❌ token 加透明度疊出來的顏色（A 只用 token 本身） | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；background-color；(找不到：inline <style>) |
| `--ac-overlay-subtle` | 248 | 184 | ❌ token 在 A 裡併入別的顏色 | `…yer > div.app-topbar-right > button.topbar-next-up.topbar-desktop-only`；background-color；packages/frontend/src/components/AppTopbar.css:189 |
| `--ac-faint` | 248 | 32 | ❌ token 在 A 裡併入別的顏色 | `… button.ui-btn.ui-btn--ghost.day-happened-row > span.day-happened-kind`；color；packages/frontend/src/modules/daily/day/day.css:104 |

（另有 62 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 字級（`font-size`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `13px` | 6442 | 382 | ✔ | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；font-size；— |
| `14px` | 4774 | 248 | ✔ | `…on.sb-tag-node.sb-tagtree-name[aria-label="打開 #範例"] > span.sb-tag-hash`；font-size；— |
| `11px` | 2569 | 322 | ❌ 不在 12／13／14／16／20／24／34 | `…ote-relations-body > button.backlink-card > span.backlink-card-snippet`；font-size；packages/frontend/src/styles/global.css:1135 |
| `17px` | 1854 | 128 | ❌ 不在 12／13／14／16／20／24／34 | `…cm > div.ͼ1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line`；font-size；— |
| `12.5px` | 1565 | 286 | ❌ 不在 12／13／14／16／20／24／34 | `…> button.topbar-next-up.topbar-desktop-only > span.topbar-next-up-text`；font-size；— |
| `12px` | 826 | 136 | ✔ | `…ote-meta[aria-label="關於這篇筆記"] > div.note-meta-line > button.space-chip`；font-size；— |
| `15.3px` | 432 | 48 | ❌ 不在 12／13／14／16／20／24／34 | `…l="筆記內容"] > div.cm-table > div.cm-table-body.obsidian-preview--md > th`；font-size；— |
| `22.1px` | 384 | 60 | ❌ 不在 12／13／14／16／20／24／34 | `…ria-label="筆記內容"] > div.cm-line.cm-fold-head.cm-fold-open > span.ͼh.ͼs`；font-size；(找不到：inline <style>) |
| `15px` | 258 | 198 | ❌ 不在 12／13／14／16／20／24／34 | `…inspector-open > header.ui-layer > div.app-topbar-left > span.app-logo`；font-size；packages/frontend/src/styles/global.css:1268 |
| `14.45px` | 232 | 64 | ❌ 不在 12／13／14／16／20／24／34 | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；font-size；(找不到：inline <style>) |
| `16px` | 182 | 96 | ✔ | `….split-quick > input.ui-text-input.split-quick-input[aria-label="記一下"]`；font-size；— |
| `18px` | 88 | 60 | ❌ 不在 12／13／14／16／20／24／34 | `…tasks-mode.tasks-page > header.tasks-mode-header > h2.tasks-mode-title`；font-size；packages/frontend/src/modules/tasks/TasksMode.css:44 |
| `13.6px` | 80 | 64 | ❌ 不在 12／13／14／16／20／24／34 | `…x][aria-label="筆記內容"] > div.cm-table > span[role=button].cm-table-edit`；font-size；(找不到：inline <style>) |
| `38px` | 76 | 76 | ❌ 不在 12／13／14／16／20／24／34 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；font-size；packages/frontend/src/components/OverviewEditor.css:45 |

（另有 12 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 字重（`font-weight`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `400` | 15073 | 398 | ✔ | `…視角"] > button[role=tab].view-tab.view-tab--active > span.view-tab-name`；font-weight；— |
| `500` | 2493 | 306 | ❌ 不在 400／600／700 | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；font-weight；— |
| `600` | 2042 | 362 | ✔ | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；font-weight；— |
| `700` | 468 | 208 | ✔ | `…][aria-label="筆記內容"] > div.cm-line.cm-fold-head.cm-fold-open > span.ͼh`；font-weight；— |

### 行高（`line-height`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `1.5` | 14487 | 398 | ✔ | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；line-height；— |
| `1.7` | 2838 | 140 | ❌ 不在 1／1.3／1.5／1.8 | `…cm > div.ͼ1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line`；line-height；— |
| `1.4` | 836 | 256 | ❌ 不在 1／1.3／1.5／1.8 | `…視角"] > button[role=tab].view-tab.view-tab--active > span.view-tab-name`；line-height；— |
| `1.3` | 767 | 238 | ✔ | `…ote-meta[aria-label="關於這篇筆記"] > div.note-meta-line > button.space-chip`；line-height；— |
| `1` | 328 | 104 | ✔ | `…> div.sidebar-sort-bar > div.sidebar-sort-dropdown > button.sb-bar-btn`；line-height；— |
| `1.25` | 264 | 140 | ❌ 不在 1／1.3／1.5／1.8 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；line-height；packages/frontend/src/components/OverviewEditor.css:45 |
| `1.45` | 220 | 56 | ❌ 不在 1／1.3／1.5／1.8 | `…ote-relations-body > button.backlink-card > span.backlink-card-snippet`；line-height；packages/frontend/src/styles/global.css:1135 |
| `1.35` | 132 | 44 | ❌ 不在 1／1.3／1.5／1.8 | `…ead > h2.day-page-title > button.ui-btn.ui-btn--ghost.day-page-datebtn`；line-height；packages/frontend/src/modules/daily/day/day.css:85 |
| `1.2` | 76 | 28 | ❌ 不在 1／1.3／1.5／1.8 | `…v.nh-p.nh-p--same > article.obsidian-preview.obsidian-preview--md > h2`；line-height；— |
| `1.6` | 68 | 22 | ❌ 不在 1／1.3／1.5／1.8 | `…schema-lens.tag-page > div.tag-page-main > button.tag-description-edit`；line-height；packages/frontend/src/components/SchemaLens.css:216 |
| `normal` | 40 | 32 | ❌ 不在 1／1.3／1.5／1.8 | `…members-section > h2.schema-lens-section-title > span.tag-member-count`；line-height；— |
| `1.55` | 20 | 20 | ❌ 不在 1／1.3／1.5／1.8 | `….onden-empty-state.onden-empty-state--panel > p.onden-empty-state-desc`；line-height；packages/frontend/src/components/EmptyState.css:61 |

### 字距（`letter-spacing`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `0` | 19674 | 398 | ✔ | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；letter-spacing；— |
| `-0.01` | 140 | 124 | ❌ 不在 0／0.04／-0.02 | `…inspector-open > header.ui-layer > div.app-topbar-left > span.app-logo`；letter-spacing；packages/frontend/src/styles/global.css:1268 |
| `-0.02` | 120 | 116 | ✔ | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；letter-spacing；— |
| `0.06` | 72 | 40 | ❌ 不在 0／0.04／-0.02 | `…odal > div.palette-list > div.palette-group > div.palette-group-header`；letter-spacing；packages/frontend/src/components/CommandPalette.css:164 |
| `0.01` | 30 | 6 | ❌ 不在 0／0.04／-0.02 | `…root > div.card-node-header > input.card-node-title-input.nodrag.nopan`；letter-spacing；packages/frontend/src/components/CardNode.css:142 |
| `0.02` | 24 | 16 | ❌ 不在 0／0.04／-0.02 | `…-mode.tasks-page > header.tasks-mode-header > span.tasks-reminder--off`；letter-spacing；packages/frontend/src/modules/tasks/TasksMode.css:3 |
| `0.05` | 16 | 8 | ❌ 不在 0／0.04／-0.02 | `…cv-root > div.cv-table-wrap > table.cv-table > th.cv-table-th--builtin`；letter-spacing；packages/frontend/src/components/collections/CollectionView.css:224 |

### 字體（`font-family`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `sans` | 16658 | 398 | ✔ | `div.overview-mobile-tabs > span.pnl > button.pnl-put > span`；font-family；— |
| `serif` | 3138 | 204 | ✔ | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；font-family；— |
| `mono` | 272 | 88 | ✔ | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；font-family；— |
| `kai` | 8 | 8 | ✔ | `…abel="字體"] > button[role=radio].ui-choice-card > span.ui-choice-sample`；font-family；— |

### 間距（padding／margin／gap）（`spacing`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `6px` | 22122 | 370 | ❌ 不在 2／4／8／12／16／24／32／48 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；padding-top；packages/frontend/src/components/viewTabs/ViewTabs.css:17 |
| `8px` | 12888 | 398 | ✔ | `…abs > div.view-tabs > button.view-tab.view-tab--add[aria-label="新增檢視"]`；padding-right；— |
| `2px` | 7237 | 350 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；row-gap；— |
| `10px` | 6676 | 358 | ❌ 不在 2／4／8／12／16／24／32／48 | `…idian-workspace > div.overview-mobile-tabs > span.pnl > button.pnl-put`；padding-top；packages/frontend/src/components/PhoneNoteLocation.css:4 |
| `4px` | 6488 | 362 | ✔ | `…idian-workspace > div.overview-mobile-tabs > span.pnl > button.pnl-put`；padding-right；— |
| `12px` | 4462 | 390 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；padding-right；— |
| `3px` | 2416 | 274 | ❌ 不在 2／4／8／12／16／24／32／48 | `…[aria-label="筆記標籤"] > button.prop-tag.prop-tag--add[aria-label="加上標籤"]`；row-gap；packages/frontend/src/components/OverviewEditor.css:122 |
| `16px` | 2270 | 332 | ✔ | `…ian-main > section.note-meta[aria-label="關於這篇筆記"] > div.note-meta-line`；column-gap；— |
| `9px` | 1952 | 184 | ❌ 不在 2／4／8／12／16／24／32／48 | `…space.obsidian-workspace > div.notes-center-wrap > div.phone-view-tabs`；padding-left；packages/frontend/src/components/viewTabs/ViewTabs.css:114 |
| `1px` | 1208 | 164 | ❌ 不在 2／4／8／12／16／24／32／48 | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；padding-top；packages/frontend/src/styles/global.css:46 |
| `24px` | 880 | 248 | ✔ | `…space.obsidian-workspace > div.notes-center-wrap > div.center-lens-bar`；padding-right；— |
| `18px` | 688 | 196 | ❌ 不在 2／4／8／12／16／24／32／48 | `…es-center-wrap > section.obsidian-main > section[aria-label="這篇筆記的關聯"]`；padding-top；packages/frontend/src/components/NoteRelations.css:2 |
| `14px` | 666 | 158 | ❌ 不在 2／4／8／12／16／24／32／48 | `…-on > aside.split-pane[aria-label="右邊：有子筆記的父筆記"] > div.split-pane-body`；padding-right；packages/frontend/src/components/splitView/SplitView.css:62 |
| `5px` | 648 | 156 | ❌ 不在 2／4／8／12／16／24／32／48 | `…ian-main > section.note-meta[aria-label="關於這篇筆記"] > div.note-meta-line`；padding-right；packages/frontend/src/styles/global.css:46 |

（另有 37 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 圓角（`radius`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `6px` | 39424 | 390 | ❌ 不是 4／8／12／膠囊 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；border-top-left-radius；packages/frontend/src/styles/global.css:76 |
| `pill` | 8424 | 330 | ✔ | `…ote-meta[aria-label="關於這篇筆記"] > div.note-meta-line > button.space-chip`；border-top-left-radius；— |
| `4px` | 4256 | 246 | ✔ | `…rip.title-tag-row[aria-label="筆記標籤"] > span.prop-tag.prop-tag--applied`；border-top-left-radius；— |
| `12px` | 2872 | 248 | ✔ | `…yer > div.app-topbar-right > button.topbar-next-up.topbar-desktop-only`；border-top-left-radius；— |
| `2px` | 1328 | 67 | ❌ 不是 4／8／12／膠囊 | `….backlink-card > span.backlink-card-snippet > mark.backlink-card-match`；border-top-left-radius；— |
| `3px` | 928 | 64 | ❌ 不是 4／8／12／膠囊 | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；border-top-left-radius；(找不到：inline <style>) |
| `16px` | 580 | 148 | ❌ 不是 4／8／12／膠囊 | `…i-layer > div.app-topbar-right > div.user-menu-wrap > button.user-chip`；border-top-left-radius；packages/frontend/src/styles/global.css:76 |
| `9px` | 96 | 6 | ❌ 不是 4／8／12／膠囊 | `…ected.card-node--tree-root > div.react-flow__resize-control.nodrag.top`；border-top-left-radius；— |

### 邊框粗細（`border-width`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `1px` | 27530 | 398 | ✔ | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；border-bottom-width；— |
| `2px` | 968 | 122 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；border-bottom-width；— |
| `3px` | 72 | 24 | ✔ | `…tasks-tabs[aria-label="任務"] > button[role=tab].tasks-tab.tasks-tab--on`；border-bottom-width；— |
| `4px` | 30 | 6 | ❌ 不在 1／2／3 | `…de-card.nopan > div.card-node.card-node--selected.card-node--tree-root`；border-top-width；packages/frontend/src/components/CardNode.css:36 |

### 邊框樣式（`border-style`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `solid` | 8480 | 398 | ✔ | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；border-style；— |
| `dashed` | 100 | 64 | ✔ | `…fo-panel-body > section.info-fn[aria-label="功能"] > button.info-fn-more`；border-style；— |

### 邊框出現的位置（`border-where`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `off:按鈕外面一圈框` | 3024 | 330 | ❌ 按鈕外面一圈框 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；border；packages/frontend/src/components/viewTabs/ViewTabs.css:17 |
| `off:四邊都有框（非欄位、非表格）` | 2888 | 304 | ❌ 四邊都有框（非欄位、非表格） | `…side.obsidian-sidebar > div.obsidian-page-list > div.obsidian-page-row`；border；packages/frontend/src/components/ObsidianImport.css:127 |
| `ok:separator` | 1728 | 372 | ✔ | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；border；— |
| `ok:table-grid` | 576 | 64 | ✔ | `…l="筆記內容"] > div.cm-table > div.cm-table-body.obsidian-preview--md > th`；border；— |
| `ok:tab-underline` | 168 | 80 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；border；— |
| `ok:dashed-drop-area` | 100 | 64 | ✔ | `…fo-panel-body > section.info-fn[aria-label="功能"] > button.info-fn-more`；border；— |
| `ok:field-frame` | 84 | 60 | ✔ | `….split-quick > input.ui-text-input.split-quick-input[aria-label="記一下"]`；border；— |
| `ok:accent-rule` | 8 | 8 | ✔ | `…h-p--same > article.obsidian-preview.obsidian-preview--md > blockquote`；border；— |
| `off:兩邊有框` | 4 | 4 | ❌ 兩邊有框 | `…rkspace.inspector-hidden > div.notes-center-wrap > section.graph-panel`；border；packages/frontend/src/styles/global.css:1203 |

### 陰影（`shadow`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `--ac-shadow-modal` | 184 | 184 | ✔ | `…ttom-nav[aria-label="主要"] > button.mobile-nav-capture[aria-label="捕捉"]`；box-shadow；— |
| `raw:color(srgb 0.85098 0.588235 0.603922 / 0.08)…` | 116 | 32 | ❌ 沒有對應的 token | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；box-shadow；(找不到：inline <style>) |
| `raw:color(srgb 0.611765 0.227451 0.282353 / 0.08…` | 116 | 32 | ❌ 沒有對應的 token | `…1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo`；box-shadow；(找不到：inline <style>) |
| `--ac-edge-up` | 112 | 112 | ✔ | `…mobile-shell > nav.ui-layer--narrow.mobile-bottom-nav[aria-label="主要"]`；box-shadow；— |
| `--ac-bar-bottom` | 96 | 96 | ✔ | `…st].info-panel-tabs[aria-label="資訊"] > button[role=tab].info-panel-tab`；box-shadow；— |
| `--ac-shadow-float` | 52 | 34 | ✔ | `…ole=menu].ui-menu.ui-menu--sheet.note-actions-sheet[aria-label="更多動作"]`；box-shadow；— |
| `--ac-shadow-sm` | 48 | 22 | ❌ token 在 A 裡取消或併入 | `…nter-wrap > section.graph-panel > div[role=toolbar][aria-label="白板工具"]`；box-shadow；packages/frontend/src/components/BoardToolbar.css:5 |
| `--ac-ring-halo` | 48 | 6 | ❌ token 在 A 裡取消或併入 | `…node--tree-root > div.react-flow__handle.react-flow__handle-top.nodrag`；box-shadow；packages/frontend/src/components/CardNode.css:254 |
| `--ac-inset-ring-thin` | 32 | 32 | ❌ token 在 A 裡取消或併入 | `…w > button[role=gridcell].ui-month-day[aria-label="2026年11月17日，這天有內容"]`；box-shadow；— |
| `raw:rgb(124, 87, 0) 3px 0px 0px 0px inset` | 16 | 4 | ❌ 沒有對應的 token | `…box][aria-label="筆記內容"] > div.cm-line.callout-warning.cm-callout-first`；box-shadow；(找不到：inline <style>) |
| `--ac-bar-start` | 16 | 8 | ✔ | `…textbox][aria-label="筆記內容"] > div.cm-line.callout-tip.cm-callout-first`；box-shadow；— |
| `raw:rgb(208, 171, 109) 3px 0px 0px 0px inset` | 16 | 4 | ❌ 沒有對應的 token | `…box][aria-label="筆記內容"] > div.cm-line.callout-warning.cm-callout-first`；box-shadow；(找不到：inline <style>) |
| `--ac-shadow-sheet` | 12 | 12 | ✔ | `…k-capture-overlay[aria-label="記一筆"] > div.ui-sheet.quick-capture-sheet`；box-shadow；— |
| `raw:rgb(34, 98, 145) 3px 0px 0px 0px inset` | 8 | 4 | ❌ 沒有對應的 token | `…extbox][aria-label="筆記內容"] > div.cm-line.callout-note.cm-callout-first`；box-shadow；(找不到：inline <style>) |

（另有 4 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 控制項高度（畫出來的）（`control-height`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `44px` | 2056 | 284 | 部分❌（294／2056）桌面要 28 或 32 | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；height；— |
| `32px` | 1798 | 176 | 部分❌（952／1798）觸控螢幕要 44 | `…tton.note-actions-more-btn.note-actions-ai-btn[aria-label="問 AI 這則筆記"]`；height；packages/frontend/src/components/NoteActions.css:16 |
| `34px` | 1552 | 142 | ❌ 觸控螢幕要 44 | `…v.topbar-desktop-only[aria-label="主要"] > button.topbar-mode-btn.active`；height；packages/frontend/src/components/AppTopbar.css:60 |
| `31.5px` | 1040 | 156 | 部分❌（544／1040）觸控螢幕要 44 | `…sidian-group-header > button.obsidian-page-button.obsidian-group-title`；height；packages/frontend/src/components/OverviewSidebar.css:241 |
| `40px` | 600 | 152 | ❌ 觸控螢幕要 44 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；height；packages/frontend/src/components/viewTabs/ViewTabs.css:117 |
| `24px` | 404 | 88 | ❌ 觸控螢幕要 44 | `…obsidian-sidebar-header > div.sidebar-tabs > button.sidebar-tab.active`；height；packages/frontend/src/components/OverviewSidebar.css:211 |
| `35.5px` | 372 | 104 | ❌ 觸控螢幕要 44 | `…st].info-panel-tabs[aria-label="資訊"] > button[role=tab].info-panel-tab`；height；packages/frontend/src/components/InfoTagsTab.css:15 |
| `56px` | 336 | 112 | ❌ 觸控螢幕要 44 | `…rrow.mobile-bottom-nav[aria-label="主要"] > button.mobile-nav-btn.active`；height；packages/frontend/src/components/MobileNav.css:28 |
| `18px` | 310 | 116 | ❌ 觸控螢幕要 44 | `…te-edited-line > button.note-history-link[aria-label="剛剛修改，打開這篇筆記的歷史"]`；height；packages/frontend/src/components/OverviewEditor.css:98 |
| `28px` | 306 | 156 | 部分❌（146／306）觸控螢幕要 44 | `…yer > div.app-topbar-right > button.topbar-next-up.topbar-desktop-only`；height；packages/frontend/src/components/AppTopbar.css:189 |
| `33px` | 304 | 108 | ❌ 觸控螢幕要 44 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；height；(行內 style／TSX) |
| `48px` | 260 | 110 | ❌ 觸控螢幕要 44 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；height；(行內 style／TSX) |
| `20px` | 190 | 46 | ❌ 觸控螢幕要 44 | `…題"] > button.note-edge-line.note-edge-line--h2[aria-label="第一節：為什麼要寫"]`；height；packages/frontend/src/components/NoteEdgeOutline.css:5 |
| `43.5px` | 142 | 8 | ✔ | `…].parent-picker-options[aria-label="可選的上層筆記"] > li[role=option].active`；height；— |

（另有 68 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 觸控目標（實際可點的大小，只在觸控螢幕量）（`tap-target`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `44px` | 1621 | 248 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；hit-size；— |
| `43px` | 1270 | 212 | ❌ 可點的範圍有一邊不到 44 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；hit-size；— |
| `32px` | 738 | 68 | ❌ 可點的範圍有一邊不到 44 | `…sidian-page-list > div.obsidian-page-row > button.obsidian-page-button`；hit-size；— |
| `31.5px` | 468 | 64 | ❌ 可點的範圍有一邊不到 44 | `…sidian-group-header > button.obsidian-page-button.obsidian-group-title`；hit-size；— |
| `42px` | 370 | 126 | ❌ 可點的範圍有一邊不到 44 | `…st].info-panel-tabs[aria-label="資訊"] > button[role=tab].info-panel-tab`；hit-size；— |
| `56px` | 336 | 112 | ✔ | `…rrow.mobile-bottom-nav[aria-label="主要"] > button.mobile-nav-btn.active`；hit-size；— |
| `38px` | 226 | 110 | ❌ 可點的範圍有一邊不到 44 | `…tton.note-actions-more-btn.note-actions-ai-btn[aria-label="問 AI 這則筆記"]`；hit-size；— |
| `48px` | 194 | 68 | ✔ | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；hit-size；— |
| `33px` | 168 | 70 | ❌ 可點的範圍有一邊不到 44 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；hit-size；— |
| `20px` | 148 | 44 | ❌ 可點的範圍有一邊不到 44 | `…idian-group > div.obsidian-group-header > button.obsidian-group-toggle`；hit-size；— |
| `34px` | 128 | 60 | ❌ 可點的範圍有一邊不到 44 | `…p-only > button.palette-trigger.topbar-desktop-only[aria-label="指令面板"]`；hit-size；— |
| `43.5px` | 120 | 58 | ✔ | `…st].info-panel-tabs[aria-label="資訊"] > button[role=tab].info-panel-tab`；hit-size；— |
| `52px` | 112 | 112 | ✔ | `…ttom-nav[aria-label="主要"] > button.mobile-nav-capture[aria-label="捕捉"]`；hit-size；— |
| `28px` | 92 | 52 | ❌ 可點的範圍有一邊不到 44 | `…yer > div.app-topbar-right > button.topbar-next-up.topbar-desktop-only`；hit-size；— |

（另有 63 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 圖示尺寸（`icon-size`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `16px` | 2074 | 218 | ✔ | `…] > button.topbar-mode-btn.active > svg.lucide.lucide-layout-dashboard`；width；— |
| `14px` | 1374 | 290 | ❌ 圖示只有 12／16／20／24 | `…bile-tabs > span.pnl > button.pnl-put > svg.lucide.lucide-folder-input`；width；— |
| `18px` | 804 | 226 | ❌ 圖示只有 12／16／20／24 | `…ions-more-btn.note-actions-ai-btn[aria-label="問 AI 這則筆記"] > svg.lucide`；width；— |
| `15px` | 600 | 206 | ❌ 圖示只有 12／16／20／24 | `…on.palette-trigger.topbar-desktop-only[aria-label="指令面板"] > svg.lucide`；width；— |
| `20px` | 492 | 152 | ✔ | `…"] > button.mobile-nav-btn.active > svg.lucide.lucide-layout-dashboard`；width；— |
| `13px` | 264 | 124 | ❌ 圖示只有 12／16／20／24 | `… > button.topbar-next-up.topbar-desktop-only > svg.lucide.lucide-clock`；width；— |
| `11px` | 235 | 125 | ❌ 圖示只有 12／16／20／24 | `…筆記"] > div.note-meta-line > button.space-chip > svg.lucide.lucide-lock`；width；— |
| `22px` | 220 | 132 | ❌ 圖示只有 12／16／20／24 | `… button.omt-back[aria-label="返回筆記列表"] > svg.lucide.lucide-chevron-left`；width；— |
| `26px` | 112 | 112 | ❌ 圖示只有 12／16／20／24 | `… > button.mobile-nav-capture[aria-label="捕捉"] > svg.lucide.lucide-plus`；width；— |
| `12px` | 60 | 48 | ✔ | `…utton.ui-btn.ui-btn--ghost.ui-btn--sm > svg.lucide.lucide-chevron-down`；width；— |
| `28px` | 20 | 20 | ❌ 圖示只有 12／16／20／24 | `…ty-state--panel > div.onden-empty-state-icon > svg.lucide.lucide-inbox`；width；— |
| `17px` | 16 | 4 | ❌ 圖示只有 12／16／20／24 | `…apture-kinds > button.quick-capture-kind[aria-label="手寫"] > svg.lucide`；width；— |
| `12.5px` | 14 | 2 | ❌ 圖示只有 12／16／20／24 | `…ggle.nodrag.nopan[aria-label="收起子筆記"] > svg.lucide.lucide-chevron-left`；width；— |
| `14.9px` | 14 | 2 | ❌ 圖示只有 12／16／20／24 | `…ggle.nodrag.nopan[aria-label="收起子筆記"] > svg.lucide.lucide-chevron-left`；width；— |

（另有 9 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 圖示線寬（`icon-stroke`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `2` | 6292 | 382 | ❌ 不在 1.5 | `… button.omt-back[aria-label="返回筆記列表"] > svg.lucide.lucide-chevron-left`；stroke-width；— |
| `1.5` | 20 | 20 | ✔ | `…ty-state--panel > div.onden-empty-state-icon > svg.lucide.lucide-inbox`；stroke-width；— |

### 層級（`z-index`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `--z-base` | 400 | 142 | ✔ | `div.md-editor-wrap > div.md-editor-cm > div.ͼ1.ͼ2.ͼw > div`；z-index；— |
| `--z-local-1` | 250 | 134 | ✔ | `…-tagtree--section > div.sb-tagtree-heading.sb-tagtree-heading--section`；z-index；— |
| `--z-pane-overlay` | 164 | 164 | ❌ 層級在 A 裡併入 | `…v.split-left > section.workspace-grid.inspector-open > header.ui-layer`；z-index；packages/frontend/src/components/AppTopbar.css:8 |
| `--z-local-6` | 130 | 94 | ❌ 層級在 A 裡併入 | `…debar > div[role=separator].pane-resizer--sidebar[aria-label="調整側欄寬度"]`；z-index；packages/frontend/src/components/ui/ui.css:325 |
| `--z-bar` | 116 | 112 | ✔ | `…mobile-shell > nav.ui-layer--narrow.mobile-bottom-nav[aria-label="主要"]`；z-index；— |
| `--z-pane-float` | 104 | 64 | ❌ 層級在 A 裡併入 | `…ction.overview-workspace.obsidian-workspace > div.overview-mobile-tabs`；z-index；packages/frontend/src/styles/global.css:1565 |
| `--z-local-2` | 34 | 14 | ✔ | `…pane-main > div.day-timeline-body > div.day-lanes > div.day-block-grip`；z-index；— |
| `--z-sticky` | 24 | 6 | ✔ | `…__nodes > div[role=group].react-flow__node.react-flow__node-card.nopan`；z-index；(行內 style／TSX) |
| `--z-popover` | 20 | 20 | ✔ | `…ole=menu].ui-menu.ui-menu--sheet.note-actions-sheet[aria-label="更多動作"]`；z-index；— |
| `--z-local-3` | 16 | 16 | ✔ | `… > div.day-lanes > div[role=separator].day-now[aria-label="現在"] > span`；z-index；— |
| `raw:12` | 16 | 6 | ❌ 沒有對應的 --z-* token | `… div.notes-center-wrap > section.graph-panel > div.board-view-controls`；z-index；packages/frontend/src/components/BoardViewMenu.css:2 |
| `--z-local-5` | 14 | 14 | ❌ 層級在 A 裡併入 | `…s-wrap > div[role=application].react-flow.light > div.canvas-ink-layer`；z-index；packages/frontend/src/components/CanvasInkLayer.css:6 |
| `--z-local-7` | 8 | 8 | ❌ 層級在 A 裡併入 | `…en > div.pagebook > button.pagebook-zoom[aria-label="縮放 100%，點一下符合寬度"]`；z-index；packages/frontend/src/pagebook/PageBook.css:86 |
| `--z-toast` | 8 | 8 | ✔ | `div[role=status].ui-layer.toast-stack`；z-index；— |

（另有 5 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 最大寬度（文字欄與容器）（`max-width`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `224px` | 284 | 136 | ❌ 不在 320／400／560／640／720 | `…ia-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active`；max-width；packages/frontend/src/components/viewTabs/ViewTabs.css:17 |
| `96px` | 116 | 116 | ❌ 不在 320／400／560／640／720 | `…user-menu-wrap > button.user-chip > span.user-name.topbar-desktop-only`；max-width；packages/frontend/src/components/AppTopbar.css:82 |
| `764.1px` | 100 | 100 | ❌ 不在 320／400／560／640／720 | `…ace.obsidian-workspace > div.notes-center-wrap > section.obsidian-main`；max-width；packages/frontend/src/components/OverviewEditor.css:5 |
| `260px` | 100 | 100 | ❌ 不在 320／400／560／640／720 | `…yer > div.app-topbar-right > button.topbar-next-up.topbar-desktop-only`；max-width；packages/frontend/src/components/AppTopbar.css:189 |
| `390px` | 55 | 55 | ❌ 不在 320／400／560／640／720 | `…iv.split-root > div.split-left > section.workspace-grid.inspector-open`；max-width；packages/frontend/src/styles/global.css:372 |
| `1280px` | 55 | 55 | ❌ 不在 320／400／560／640／720 | `…iv.split-root > div.split-left > section.workspace-grid.inspector-open`；max-width；packages/frontend/src/styles/global.css:372 |
| `800px` | 55 | 55 | ❌ 不在 320／400／560／640／720 | `…iv.split-root > div.split-left > section.workspace-grid.inspector-open`；max-width；packages/frontend/src/styles/global.css:372 |
| `680px` | 32 | 32 | ❌ 不在 320／400／560／640／720 | `…tion.workspace-grid.full-page.module-screen-daily > div.journal-screen`；max-width；packages/frontend/src/modules/daily/JournalScreen.css:9 |
| `1320px` | 16 | 16 | ❌ 不在 320／400／560／640／720 | `…eft > section.workspace-grid.full-page > section.tasks-mode.tasks-page`；max-width；packages/frontend/src/modules/tasks/TasksMode.css:91 |
| `760px` | 16 | 8 | ❌ 不在 320／400／560／640／720 | `….tasks-mode.tasks-page > div[role=tablist].tasks-tabs[aria-label="任務"]`；max-width；packages/frontend/src/modules/tasks/TasksMode.css:108 |
| `240px` | 16 | 16 | ❌ 不在 320／400／560／640／720 | `…box[aria-label="收件匣"] > div.onden-empty-state.onden-empty-state--panel`；max-width；packages/frontend/src/components/EmptyState.css:16 |
| `360px` | 12 | 12 | ❌ 不在 320／400／560／640／720 | `…ge[aria-label="這一天的日記"] > div.day-strip > div.ui-month.day-strip-month`；max-width；packages/frontend/src/modules/daily/day/day.css:19 |
| `700.1px` | 8 | 8 | ❌ 不在 320／400／560／640／720 | `…> div.notes-center-wrap > div.schema-lens.tag-page > div.tag-page-main`；max-width；packages/frontend/src/components/SchemaLens.css:198 |
| `533.1px` | 8 | 8 | ❌ 不在 320／400／560／640／720 | `…schema-lens.tag-page > div.tag-page-main > button.tag-description-edit`；max-width；packages/frontend/src/components/SchemaLens.css:216 |

（另有 12 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）

### 透明度（`opacity`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `0.7` | 384 | 120 | ✔ | `…utton.topbar-mode-btn.topbar-more-btn > svg.lucide.lucide-chevron-down`；opacity；— |
| `0.75` | 272 | 72 | ❌ 不在 0／0.5／0.7 | `…on.sb-tag-node.sb-tagtree-name[aria-label="打開 #範例"] > span.sb-tag-hash`；opacity；packages/frontend/src/components/OverviewSidebar.css:126 |
| `0.8` | 264 | 68 | ❌ 不在 0／0.5／0.7 | `…f > span.obsidian-group-toggle.sb-tagtree-toggle > span.sb-tagtree-dot`；opacity；packages/frontend/src/styles/sidebar.css:111 |
| `0.6` | 128 | 39 | ❌ 不在 0／0.5／0.7 | `…itle-tag-row--empty[aria-label="筆記標籤"] > button.prop-tag.prop-tag--add`；opacity；packages/frontend/src/components/OverviewEditor.css:134 |
| `0.45` | 92 | 56 | ❌ 不在 0／0.5／0.7 | `…pan.cm-block-tags > span[role=img].cm-block-task-icon[aria-label="任務"]`；opacity；(找不到：inline <style>) |
| `0.35` | 80 | 40 | ❌ 不在 0／0.5／0.7 | `…label="版面"] > button.ui-btn.ui-btn--icon.ui-btn--sm[aria-label="筆記列表"]`；opacity；packages/frontend/src/components/AppTopbar.css:98 |
| `0.85` | 48 | 48 | ❌ 不在 0／0.5／0.7 | `…idian-workspace > div.overview-mobile-tabs > span.pnl > button.pnl-put`；opacity；packages/frontend/src/components/PhoneNoteLocation.css:4 |
| `0.5` | 48 | 42 | ✔ | `…div.split-pane-body > form.split-quick > button.ui-btn.ui-btn--primary`；opacity；— |
| `0.55` | 40 | 8 | ❌ 不在 0／0.5／0.7 | `…l="搜尋"] > li.module-row > div.module-row-head > button.module-row-open`；opacity；packages/frontend/src/components/ModuleLibrary.css:37 |

### 動畫時間（`transition-ms`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `120ms` | 35466 | 378 | ✔ | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；transition-duration；packages/frontend/src/styles/global.css:46 |
| `80ms` | 8434 | 378 | ❌ 只有 120／200 毫秒 | `…pace > div.overview-mobile-tabs > button.omt-back[aria-label="返回筆記列表"]`；transition-duration；packages/frontend/src/styles/global.css:46 |
| `150ms` | 5410 | 290 | ❌ 只有 120／200 毫秒 | `…label="版面"] > button.ui-btn.ui-btn--icon.ui-btn--sm[aria-label="筆記列表"]`；transition-duration；packages/frontend/src/styles/global.css:46 |
| `200ms` | 780 | 152 | ✔ | `…tton.note-actions-more-btn.note-actions-ai-btn[aria-label="問 AI 這則筆記"]`；transition-duration；— |
| `100ms` | 768 | 88 | ❌ 只有 120／200 毫秒 | `…sidebar-sort-bar > button.sb-bar-btn.sb-bar-btn--icon[aria-label="建立"]`；transition-duration；packages/frontend/src/components/OverviewSidebar.css:148 |
| `160ms` | 134 | 130 | ❌ 只有 120／200 毫秒 | `…ialog.ui-modal.palette-backdrop[aria-label="指令面板"] > div.palette-modal`；animation-duration；packages/frontend/src/styles/global.css:46 |
| `180ms` | 22 | 22 | ❌ 只有 120／200 毫秒 | `…ole=menu].ui-menu.ui-menu--sheet.note-actions-sheet[aria-label="更多動作"]`；animation-duration；packages/frontend/src/styles/global.css:46 |

### 焦點框（`focus-ring`）

| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |
| --- | ---: | ---: | --- | --- |
| `off:陰影形的光圈（A 只留 outline）` | 814 | 320 | ❌ 陰影形的光圈（A 只留 outline） | `…abs > div.view-tabs > button.view-tab.view-tab--add[aria-label="新增檢視"]`；outline；— |
| `ok:outline 2px solid、外距 2px` | 246 | 118 | ✔ | `…n > h3.info-relations-heading > button.ui-btn.ui-btn--ghost.ui-btn--sm`；outline；— |
| `ok:outline 2px solid、外距 -2px` | 74 | 44 | ✔ | `…bsidian-page-button.sb-tag-node.sb-tagtree-name[aria-label="打開 #版面測試"]`；outline；— |
| `off:沒有可見的焦點框` | 52 | 52 | ❌ 沒有可見的焦點框 | `…ction.obsidian-main > textarea.obsidian-title-input[aria-label="筆記標題"]`；outline；— |
| `off:outline 1px auto、外距 0px` | 4 | 4 | ❌ outline 1px auto、外距 0px | `…ime-zone-picker > div[role=listbox].time-zone-options[aria-label="時區"]`；outline；— |

## 三、哪個畫面最不整齊

每個畫面所有種類的「不在刻度上的次數」加總，與佔該畫面量到總次數的比例（所有寬度與主題加總）。

| 畫面 | 不在刻度上 | 量到總數 | 比例 |
| --- | ---: | ---: | ---: |
| `ai-panel` | 6838 | 16790 | 41% |
| `canvas` | 5991 | 14334 | 42% |
| `note-long` | 5891 | 14106 | 42% |
| `offline` | 5818 | 13872 | 42% |
| `note-callouts` | 5062 | 11740 | 43% |
| `tree-selected-parent` | 4882 | 11246 | 43% |
| `info-features` | 4852 | 12064 | 40% |
| `info-relations` | 4654 | 11192 | 42% |
| `tree-expanded` | 4554 | 10362 | 44% |
| `info-tags` | 4544 | 11420 | 40% |
| `search-sidebar` | 4470 | 10800 | 41% |
| `note-missing` | 4304 | 9676 | 44% |
| `note-ink` | 4202 | 11400 | 37% |
| `note-pdf` | 4032 | 10548 | 38% |
| `search-empty` | 3950 | 9998 | 40% |
| `note-children` | 3846 | 9608 | 40% |
| `tags-table` | 3820 | 9878 | 39% |
| `slides` | 3768 | 9528 | 40% |
| `tags-list` | 3736 | 9430 | 40% |
| `note-image` | 3688 | 8824 | 42% |

## 四、哪個原始檔最常是來源

把不在刻度上的值，依「最後勝出的規則」（近似層疊）歸給它所在的 CSS 檔。`(找不到：…)` 是瀏覽器裡的規則沒對到原始碼（例如編輯器自己注入的樣式）。

| 來源檔 | 不在刻度上的次數 | 其中最多的種類 |
| --- | ---: | --- |
| `packages/frontend/src/styles/global.css` | 51981 | radius 26296、transition-ms 13638、spacing 6592 |
| `(未解析)` | 35715 | radius 13340、icon-stroke 6292、tap-target 4293 |
| `packages/frontend/src/components/OverviewSidebar.css` | 11152 | spacing 7416、control-height 1704、transition-ms 756 |
| `packages/frontend/src/components/AppTopbar.css` | 10534 | spacing 5964、control-height 1502、radius 1472 |
| `(找不到：inline <style>)` | 4232 | colour 1540、radius 1248、font-size 688 |
| `packages/frontend/src/components/ObsidianImport.css` | 3780 | border-where 1868、spacing 1164、colour 320 |
| `packages/frontend/src/settings/SettingsModal.css` | 3170 | spacing 2072、control-height 602、font-size 416 |
| `packages/frontend/src/components/ui/ui.css` | 2430 | spacing 2076、font-size 244、z-index 88 |
| `packages/frontend/src/styles/previewTable.css` | 2304 | spacing 2304 |
| `packages/frontend/src/components/viewTabs/ViewTabs.css` | 2226 | spacing 1530、border-where 284、max-width 284 |
| `packages/frontend/src/components/OverviewEditor.css` | 1592 | spacing 708、control-height 464、font-size 132 |
| `packages/frontend/src/modules/daily/day/day.css` | 1541 | font-size 529、colour 456、spacing 200 |
| `packages/frontend/src/components/InfoTagsTab.css` | 1516 | spacing 680、control-height 484、font-size 260 |
| `packages/frontend/src/components/MobileNav.css` | 1456 | spacing 1008、control-height 448 |
| `packages/frontend/src/styles/sidebar.css` | 1370 | spacing 320、colour 264、opacity 264 |
| `packages/frontend/src/components/NoteRelations.css` | 1164 | spacing 1108、control-height 56 |
| `packages/frontend/src/components/CommandPalette.css` | 1102 | spacing 656、border-where 190、font-size 138 |
| `packages/frontend/src/modules/tasks/tasks.css` | 826 | spacing 346、border-where 150、control-height 128 |
| `packages/frontend/src/components/CardNode.css` | 666 | spacing 204、transition-ms 168、control-height 74 |
| `packages/frontend/src/components/InfoFunctions.css` | 602 | spacing 316、font-size 104、control-height 86 |

規則對應：精確 100934、近似（只對到類別名）0、行內 style 340、沒對到 35499。

## 五、同時有最多種類不在刻度上的 20 個地方

「地方」＝一種元素（標籤＋角色＋前兩個類別），跨畫面合併。依「幾種不同的種類不在刻度上」排序，再依次數。

| # | 元素 | 不在刻度上的種類 | 次數 | 出現在 | 來源檔 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | `…l-body > section.info-relations-section > button.ui-btn.ui-btn--ghost.ui-btn--sm` | 10：spacing=6px、transition-ms=150ms、font-size=12.5px、font-weight=500、control-height=24.3px、tap-target=43.3px、line-height=1.35、radius=6px、border-where=off:按鈕外面一圈框、colour=token:--ac-faint | 5267 | info-tags、info-relations、tree-expanded、tree-selected-parent…等 23 個 | `packages/frontend/src/components/InfoTagsTab.css`、`packages/frontend/src/styles/global.css` |
| 2 | `…n-sidebar > div.sidebar-sort-bar > div.sidebar-sort-dropdown > button.sb-bar-btn` | 9：font-size=11px、font-weight=500、spacing=9px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=100ms、control-height=24px、tap-target=43px、colour=raw:color(srgb 0 | 2068 | note-long、note-children、info-features、info-tags…等 19 個 | `packages/frontend/src/components/OverviewSidebar.css`、`packages/frontend/src/styles/global.css` |
| 3 | `…or-details.info-panel-body > button.ui-btn.ui-btn--secondary.info-relations-full` | 8：spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=150ms、font-size=12.5px、font-weight=500、control-height=30.9px、tap-target=43px | 2436 | info-relations、tree-expanded、tree-selected-parent、tags-list…等 22 個 | `packages/frontend/src/components/InfoTagsTab.css`、`packages/frontend/src/components/ui/ui.css` |
| 4 | `…記的父筆記"] > div.split-pane-body > form.split-quick > button.ui-btn.ui-btn--primary` | 8：font-weight=500、spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=150ms、font-size=12.5px、control-height=44px、tap-target=43.3px | 266 | split-note-note、settings-more、slides、create-panel | `packages/frontend/src/styles/global.css`、`packages/frontend/src/components/ui/ui.css` |
| 5 | `…rap > div.schema-lens.tag-page > div.tag-page-main > button.tag-description-edit` | 8：line-height=1.6、colour=raw:rgb(209, 203、spacing=10px、radius=6px、max-width=533.1px、transition-ms=80ms、control-height=38.8px、tap-target=38.8px | 86 | tags-list | `packages/frontend/src/components/SchemaLens.css`、`packages/frontend/src/styles/global.css` |
| 6 | `…only[aria-label="版面"] > button.ui-btn.ui-btn--icon.ui-btn--sm[aria-label="筆記列表"]` | 7：spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=150ms、control-height=30px、tap-target=43px、opacity=0.35 | 8462 | note-long、split-note-note、note-children、info-features…等 44 個 | `packages/frontend/src/components/ui/ui.css`、`packages/frontend/src/components/AppTopbar.css` |
| 7 | `…bs-list[aria-label="版面檢查用的長筆記 的視角"] > button[role=tab].view-tab.view-tab--active` | 7：spacing=10px、radius=6px、border-where=off:按鈕外面一圈框、max-width=224px、transition-ms=80ms、control-height=40px、tap-target=43px | 1860 | note-long、note-children、split-note-note、info-features…等 23 個 | `packages/frontend/src/components/viewTabs/ViewTabs.css`、`packages/frontend/src/styles/global.css` |
| 8 | `…one-view-tabs > div.view-tabs > button.view-tab.view-tab--add[aria-label="新增檢視"]` | 7：spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、max-width=224px、transition-ms=80ms、control-height=40px、tap-target=40px | 1588 | note-long、note-children、split-note-note、info-features…等 23 個 | `packages/frontend/src/components/viewTabs/ViewTabs.css`、`packages/frontend/src/styles/global.css` |
| 9 | `…iv[role=group].app-colors__swatches[aria-label="顏色"] > button.app-colors__swatch` | 7：font-size=12.5px、colour=token:--ac-ink-2、spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=80ms、control-height=72.8px | 720 | settings-more | `packages/frontend/src/settings/AppColorsSetting.css`、`packages/frontend/src/styles/global.css` |
| 10 | `div` | 7：spacing=6px、colour=token:--ac-overl、radius=6px、border-where=off:四邊都有框（非欄位、非表、transition-ms=150ms、font-size=17px、line-height=1.7 | 472 | note-long、note-children、split-note-note、info-tags…等 23 個 | `packages/frontend/src/styles/global.css` |
| 11 | `…xt > article.obsidian-preview.obsidian-preview--md > button.wikilink-token.known` | 7：font-size=11px、line-height=1.7、colour=token:--ac-accen、spacing=1px、transition-ms=80ms、control-height=25.8px、tap-target=25.8px | 292 | split-note-note、daily、daily-date-picker、canvas…等 6 個 | `packages/frontend/src/styles/global.css` |
| 12 | `…tion.note-relations-children > ul.tag-member-list.tag-member-list--flat > button` | 7：transition-ms=80ms、control-height=44px、spacing=10px、font-weight=500、tap-target=35px、colour=raw:rgb(196, 60,、border-where=off:按鈕外面一圈框 | 252 | note-children、tags-list、tree-selected-parent、tasks-sheet…等 7 個 | `packages/frontend/src/styles/global.css`、`packages/frontend/src/components/MemberList.css` |
| 13 | `…iv[role=tablist].view-tabs-list[aria-label="專案 的視角"] > button[role=tab].view-tab` | 7：spacing=10px、radius=6px、border-where=off:按鈕外面一圈框、max-width=224px、transition-ms=80ms、control-height=40px、tap-target=43px | 164 | tags-table、canvas | `packages/frontend/src/components/viewTabs/ViewTabs.css`、`packages/frontend/src/styles/global.css` |
| 14 | `…nk-note--pen > div.pagebook > button.pagebook-zoom[aria-label="縮放 100%，點一下符合寬度"]` | 7：spacing=10px、border-where=off:按鈕外面一圈框、shadow=token:--ac-shado、z-index=token:--z-local-、transition-ms=80ms、control-height=32px、tap-target=32px | 60 | note-ink | `packages/frontend/src/pagebook/PageBook.css`、`packages/frontend/src/styles/global.css` |
| 15 | `…av.app-primary-nav.topbar-desktop-only[aria-label="主要"] > button.topbar-mode-btn` | 6：spacing=9px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=80ms、control-height=34px、tap-target=34px | 6534 | note-long、split-note-note、note-children、info-features…等 30 個 | `packages/frontend/src/components/AppTopbar.css`、`packages/frontend/src/styles/global.css` |
| 16 | `div.ͼ1.ͼ2.ͼw > div[role=textbox][aria-label="筆記內容"] > div.cm-line > span.ͼo` | 6：font-size=14.45px、line-height=1.7、colour=alpha:--ac-accen、spacing=1px、radius=3px、shadow=raw:color(srgb 0 | 2320 | note-long、split-note-note、info-features、info-tags…等 12 個 | `(找不到：inline <style>)`、`packages/frontend/src/styles/global.css` |
| 17 | `header.ui-layer > div.app-topbar-right > div.user-menu-wrap > button.user-chip` | 6：spacing=6px、radius=16px、border-where=off:按鈕外面一圈框、transition-ms=80ms、control-height=34px、tap-target=43px | 1690 | note-long、split-note-note、note-children、info-features…等 29 個 | `packages/frontend/src/components/AppTopbar.css`、`packages/frontend/src/styles/global.css` |
| 18 | `…av.topbar-desktop-only[aria-label="主要"] > button.topbar-mode-btn.topbar-more-btn` | 6：spacing=9px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=80ms、control-height=34px、tap-target=34px | 1620 | note-long、split-note-note、note-children、info-features…等 30 個 | `packages/frontend/src/components/AppTopbar.css`、`packages/frontend/src/styles/global.css` |
| 19 | `…primary-nav.topbar-desktop-only[aria-label="主要"] > button.topbar-mode-btn.active` | 6：spacing=9px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=80ms、control-height=34px、tap-target=43px | 1566 | note-long、split-note-note、note-children、info-features…等 29 個 | `packages/frontend/src/components/AppTopbar.css`、`packages/frontend/src/styles/global.css` |
| 20 | `…bar > div.sidebar-sort-bar > button.sb-bar-btn.sb-bar-btn--icon[aria-label="建立"]` | 6：spacing=6px、radius=6px、border-where=off:按鈕外面一圈框、transition-ms=100ms、control-height=24px、tap-target=43px | 1114 | note-long、note-children、info-features、info-tags…等 19 個 | `packages/frontend/src/components/OverviewSidebar.css`、`packages/frontend/src/styles/global.css` |

## 六、原始碼的靜態數字

掃了 19693 條 CSS 宣告（`src/` 下所有 .css，不含測試）與 481 個 .tsx。

| 種類 | 寫死的宣告 | 用 token 的宣告 | 寫死的值有幾種 | 最常見的寫死值 |
| --- | ---: | ---: | ---: | --- |
| 顏色 | 3 | 3115 | 3 | #6b7280×1、#fff×1、#111827×1 |
| 字級 | 76 | 1030 | 18 | 0.85em×27、0.9em×13、0.8em×6、1em×5、1.15em×4、1.3em×3、1.4em×3、1.25em×3 |
| 字重 | 300 | 27 | 6 | 600×197、500×50、400×28、700×23、100×2、900×2 |
| 行高 | 171 | 7 | 21 | 1.5×38、1.6×23、1.4×18、1.3×17、1×16、1.2×9、1.7×8、1.35×8 |
| 字距 | 37 | 2 | 11 | 0.04em×11、0.5px×6、0.02em×5、0.06em×4、0.05em×3、-0.02em×2、-0.015em×2、0.01em×1 |
| 字體 | 18 | 67 | 7 | ui-monospace×7、IBM Plex Sans×4、Fraunces×2、IBM Plex Mono×2、monospace×1、system-ui×1、Noto Serif TC Variable×1 |
| 間距（padding／margin／gap） | 2360 | 155 | 95 | 8px×595、6px×447、4px×440、10px×302、12px×301、2px×225、16px×124、14px×95 |
| 圓角 | 4 | 652 | 2 | 2px×2、999px×2 |
| 邊框粗細 | 589 | 15 | 10 | 1px×503、2px×45、3px×22、1.5px×14、4px×3、0.55rem×2、0.9rem×1、1.25px×1 |
| 邊框樣式 | 21 | 0 | 3 | dashed×11、solid×8、dotted×2 |
| 陰影 | 2 | 99 | 2 | 0 8px 24px rgb(0 0 0 / 0×1、0 0.5em 1.5em color-mix(×1 |
| 控制項高度（畫出來的） | 603 | 45 | 79 | 44px×187、100%×54、32px×53、48px×39、36px×34、28px×19、40px×18、24px×15 |
| 層級 | 0 | 95 | 0 |  |
| 最大寬度（文字欄與容器） | 147 | 13 | 53 | 100%×65、100vw×11、360px×8、260px×5、220px×5、24px×5、16px×5、640px×3 |
| 透明度 | 196 | 0 | 15 | 1×39、0.5×35、0.6×33、0.7×19、0.8×16、0.4×11、0.55×10、0.45×8 |
| 動畫時間 | 75 | 9 | 21 | 120ms×32、150ms×27、100ms×12、200ms×12、0.01ms×6、80ms×3、180ms×3、250ms×2 |
| 焦點框 | 44 | 86 | 8 | 2px×26、-2px×9、1px×3、3px×2、-5px×1、-1px×1、1.5px×1、-1.5px×1 |

圖示（.tsx 的 `size={n}`，共 507 處）：14px×173、16px×89、13px×56、15px×55、12px×38、18px×32、11px×31、20px×10、22px×10、28px×5、10px×3、17px×2、1px×1、26px×1、32px×1。
`strokeWidth={…}`：2×1、3×1、1.5×4。行內 `style={{…}}`：87 處（只算同一行寫得出的；多半只是設自訂屬性）。

媒體查詢寬度：`(width > 600px)`×10、`(width > 900px)`×11、`(max-width: 900px)`×62、`(max-width: 600px)`×32、`(min-width: 900px)`×4、`(min-width: 600px)`×1；其他條件：`(pointer: coarse)`×40、`(hover: none)`×11、`(prefers-reduced-motion: reduce)`×16、`(hover: hover)`×6、`print`×1、`(prefers-color-scheme: dark)`×4、`(prefers-reduced-motion: no-preference)`×4、`(pointer: fine)`×3。

## 七、沒量到的畫面與原因

| 狀態 | 畫面 | 原因 | 寬度×主題 |
| --- | --- | --- | --- |
| 略過 | `split-note-note` | 手機沒有並排 | 390__dark、390__light、800x1280__light、800x1280__dark |
| 出錯 | `canvas` | locator.waitFor: Timeout 60000ms exceeded. | 390__dark、800x1280__dark |
| 略過 | `phone-more-sheet` | 只有手機版面有底部列 | 1280x800__light、1280x800__dark、1440__dark、1440__light |


**畫面有量到，但內容不是真的**（不是工具壞了，是瀏覽器版叫不出來）：

- 離線：瀏覽器版的資料存在本機，不會出現「離線」橫幅；`offline` 只量到 AI 分頁裡「離線時不能問 AI」那一句。
- 儲存失敗、同步失敗、`RegionErrorBoundary`、`AppErrorBoundary`、提示訊息（toast）：要伺服器失敗或元件壞掉才會出現，沒有量；錯誤類只量了「筆記不存在」。
- AI 面板用替身（固定的兩輪對話），不是真的 AI 回答；待審建議（接受／全部捨棄）的畫面沒有量。
- 書籤、推播、登入與帳號閘門：瀏覽器版沒有（回 501 或不存在）。
- 平板直放 800×1280 的 `canvas`：打不開（60 秒逾時），原因沒有查。
- 「這次更新」卡片（已關掉）與試用版提示（被隱藏）不在畫面裡；簡報播放、鍵盤彈出、輸入法組字中、拖曳中的狀態沒有量。

## 八、這份測量的限制

- 量的是瀏覽器版的 Chromium、裝置像素比 1、基礎字級 14px、預設密度；使用者自己調的字級、密度、顏色不在內。手機與平板是 Playwright 的觸控模擬，不是真機。
- 只量畫面上顯示出來的元素（`display:none`、`visibility:hidden`、透明度 0 的子樹不算）；對話框或選單打開時只量那一層（和 layout-audit 相同）。捲到畫面外的內容有量，但要先被渲染出來（長清單可能是虛擬化的）。
- 外距 `auto` 沒辦法從算出來的值分辨，用啟發式略過（置中、推到邊的），可能少算。
- 「來源」是依層疊順序最後一條有宣告該屬性、又符合該元素的規則，不處理優先權與 `!important`，所以是近似。
- 畫布（手寫的筆跡）、圖片、PDF 頁面內容、使用者的螢光筆顏色是內容，不是介面，沒有量。`filter: drop-shadow` 與 `text-shadow` 沒量。
- 動畫時間量的是算出來的 `transition-duration`／`animation-duration`（測試環境允許動態）；從狀態變化才出現的 hover／active 樣式沒有被觸發，所以沒量到。
- 焦點框只在每個畫面按三次 Tab 取樣，不是全部可聚焦元素。
