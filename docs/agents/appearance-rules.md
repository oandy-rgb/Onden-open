> 狀態：現行草案（2026-11-17，等業主看過）
> 涵蓋：packages/frontend/e2e/style-census/scale.mjs, packages/frontend/src/styles/tokens.css, packages/frontend/scripts/appearanceLook.mjs, packages/frontend/scripts/appearanceTokens.mjs

# 外觀規則：方向 A「安靜」

這份文件回答一件事：**畫面上每一種「會影響長相的值」，允許幾個層級、各用在哪裡、今天有沒有守門。**
它是方向 A 的規則草案；業主看過之前，數字都可以改。機器可讀的同一份刻度在
`packages/frontend/e2e/style-census/scale.mjs`，普查工具（[README](../../packages/frontend/e2e/style-census/README.md)）用它判定
「在刻度上／不在刻度上」；`selftest.mjs` 會檢查下面每一種都有一列，文件與工具不會悄悄分家。
實際量到的數字見 [style-census-2026-11-17.md](../research/style-census-2026-11-17.md)。

**這份文件與它對應的守門不改任何產品畫面。** 守門只擋「數量變多」（今天的違規數記成只減不增的基準，見 §三、§五）；把現有的值搬上刻度的工作之後分批做（每一批會讓版面位移，所以一次只動一種屬性）。

## 一、方向 A 的一句話

安靜：幾乎沒有框線，層次靠**留白與字級**，不靠框。

- 底色近白 `#fbfbfa`、字 `#1f1f1e`、次要字 `#6b6a67`、細線 `#ebeae7`（1px，只用來分區，**不圍在按鈕外面**）。
- 強調色（今天的酒紅）只用在少數地方：使用中分頁的 2px 底線、連結、送出鈕、提示框左邊 3px 的線。
- 分頁：文字＋2px 底線；**筆記的分頁與側欄的分頁是同一個元件**；分頁列高 42px。頂列 48px。
- 圖示按鈕靜止時沒有框、沒有底色。小標籤（chip）：膠囊形、淡色底、12px 字。AI 面板的提問：靠右、淡色底的方塊。
- 內文 16px／行高 1.8，欄寬上限約 640px；標題 34px 粗體；二級標題 20px。
- 觸控目標：手機與平板 44px。
- 深色：底 `#171716`、字 `#f1f0ec`、細線 `#2c2c2a`、強調色調亮。

**相對於業主看過的示意圖，我調整或補充的地方**（每一條都有理由，業主可以推翻）：

| 項目 | 示意圖 | 這份草案 | 理由 |
| --- | --- | --- | --- |
| 圓角 | 沒說 | 4／8／12／膠囊 | 今天 6 種（2、4、6、12、16、膠囊）太多；6px 是最常用的（約 270 處），改成 8 讓安靜的版面柔一點，風險是每個框都會變大 2px |
| 欄位的框 | 「幾乎沒有框」 | 輸入欄用 1px、**比細線深**的 `--ac-field-line`（淺色 `#8c8b87`，3.3:1） | 細線 `#ebeae7` 對底色只有 1.16:1，欄位會看不出在哪裡；WCAG 1.4.11 要求控制項邊界至少 3:1。這是新增的一個顏色 |
| 圖示線寬 | 沒說 | 一律 1.5 | 今天大多數是預設 2，少數 1.5；安靜的版面用細一點的線，且只留一種 |
| 觸控判斷 | 「手機與平板 44px」 | 依 `(pointer: coarse)`，用**實際可點大小**（含看不見的擴大範圍）判定，不依寬度、不要求畫出來的框變高 | 1280×800 的平板橫放是桌面版面，但仍是手指在點；業主真機數字要求這樣量 |
| 頂列高度 | 48px | 48px（今天是 `--ac-topbar-h: 52px`） | 照示意圖；要連動檢查 sticky 的偏移 |
| 次要字（深色） | 沒說 | `#a8a7a2`（7.4:1） | 補上深色的值 |

對比（WCAG）：淺色 字／底 15.9:1、次要字／底 5.2:1、強調色／底 6.5:1、白字／強調色底 6.5:1；深色 字／底 15.7:1、次要字／底 7.4:1、強調色／底 7.5:1。

## 二、怎麼讀下面的表

- 「層級」是**算出來的值**（px，基礎字級 14px 時），所以 `em`、`calc()`、`clamp()` 寫出來的東西，算出來也必須落在層級上。
- 「守門」：規則 id 與**起始基準**（今天寫死的宣告數／檔案數，只准減）。規則只擋「寫死的字面值」；「token 有幾個」由 §七 的凍結名單擋。**守門不改變任何值**：基準以內的舊寫法照舊，只是不准再多。
- 「來源」欄的數字是原始碼靜態掃描的結果（`style-census` 的 `static.mjs`），不是畫面上的次數。

## 三、總表：每一種值

| 種類（普查 id） | 層級（A） | 守門規則與起始基準 | 今天的層級數（原始碼寫死的值有幾種） |
| --- | --- | --- | --- |
| 顏色 `colour` | 見 §4.1：約 20 個 token | `fe-css-color`（只擋字面顏色，基準 0） | `--ac-*` 共 154 個名字（顏色只是一部分，另含尺寸與字體）；寫死 3 處 |
| 字級 `font-size` | 12、13、14、16、20、24、34 | `fe-css-font-size`（只擋寫死的 px，`em`／`%` 放行，基準 0） | 13 種 token 與 `em` |
| 字重 `font-weight` | 400、600、700 | `fe-css-font-weight`：**286 條／87 檔** | 6 種（100、400、500、600、700、900）；寫死 300 處 |
| 行高 `line-height` | 1、1.3、1.5、1.8 | `fe-css-line-height`：**159 條／62 檔** | 21 種；寫死 171 處 |
| 字距 `letter-spacing` | 0、0.04em、-0.02em | `fe-css-letter-spacing`：**35 條／19 檔** | 11 種 |
| 字體 `font-family` | sans、serif、mono、kai（都經 token） | `fe-css-font-family`：**9 條／5 檔** | 7 種寫死的字體名 |
| 間距 `spacing`（padding／margin／gap） | 2、4、8、12、16、24、32、48 | `fe-css-spacing`：**2294 條／143 檔** | 95 種 px；寫死約 2360 個值，用 token 只有 155 處 |
| 圓角 `radius` | 4、8、12、膠囊 | `fe-css-radius`（只擋寫死，基準 0） | 6 種 token（2、4、6、12、16、膠囊） |
| 邊框粗細 `border-width` | 1、2、3 | `fe-css-border-width`：**575 條／125 檔** | 10 種（含 1.25、1.5、0.55rem） |
| 邊框樣式 `border-style` | solid、dashed | **沒有規則**：只有三種值、21 處寫死，沒有列入這一批；偵測寫法與其他規則相同，要加時再加 | solid、dashed、dotted |
| 邊框出現的位置 `border-where` | 見 §4.8 | **沒有規則，也不能有**：要知道元素是按鈕還是輸入欄、有幾邊有框，靜態掃描做不到，只能由普查看到 | — |
| 陰影 `shadow` | 無、float、modal、sheet ＋ 狀態標記 | `fe-css-shadow`（只擋寫死，基準 0） | 33 個陰影／光圈／邊條 token |
| 控制項高度 `control-height`（畫出來的） | 桌面 28、32；觸控 44 | `fe-css-control-height`：**160 條／66 檔**（只看「選擇器像控制項」的 height／min-height，見 §五） | 24、26、28、30、32、34、36、40、44、48… 都有 |
| 觸控目標 `tap-target`（實際可點的大小） | 觸控螢幕（`pointer: coarse`）：可點的範圍寬與高**都** ≥ 44 | `scripts/tap-target-baseline.json`：只減不增（`npm run style:census -- --check-taps`，手動，需要瀏覽器） | 真機（業主的平板）：每個畫面 60–90% 的控制項不到 44 |
| 圖示尺寸 `icon-size` | 12、16、20、24 | `fe-icon-size`：**345 處／133 檔**（lucide 圖示的 `size={n}`；**暫時只擋不在這四個數字上的**，見 §五） | `size={n}` 15 種（13、14、15、16 就占約 380 處） |
| 圖示線寬 `icon-stroke` | 1.5 | `fe-icon-stroke`：**1 處／1 檔**（lucide 圖示的 `strokeWidth={n}`，不是 1.5 的）；沒寫 `strokeWidth` 的預設 2 只能由普查看到 | 預設 2＋少數 1.5、3 |
| 層級 `z-index` | 15 個命名層（§4.13） | `fe-css-z-index`（只擋寫死，基準 0） | 28 個 `--z-*` 名字（含 `--z-local-1..7`；2026-11-19 對過 main） |
| 最大寬度 `max-width` | 320、400、560、640、720 | `fe-css-max-width`：**84 條／52 檔**（所有 `max-width`，分不出是不是文字欄，見 §五） | 53 種 |
| 透明度 `opacity` | 0、0.5、0.7（1 是預設） | `fe-css-opacity`：**150 條／56 檔** | 15 種（0.25–0.96） |
| 動畫時間 `transition-ms` | 120、200（0 即無動畫）；一種緩動 | `fe-css-duration`：**66 條／33 檔**；緩動 `fe-css-easing`：**29 條／19 檔** | 21 種時間；緩動 `--onden-motion-ease` 只有少數用 |
| 焦點框 `focus-ring` | `--ac-focus-outline`：2px 實線，外距 2（會被裁切的列用內距 -2） | `fe-css-focus-ring`：**44 條／8 檔**（outline 的字面值，以及 `:focus` 規則裡不是焦點 token 的 box-shadow） | 44 處寫死的 outline／outline-offset |
| 斷點 `breakpoint` | 600、900、1280 | `fe-css-media-width`（只擋**寬度**條件） | 3 個；`height`、`orientation` 等沒人管 |
| 固定位置 `position-fixed` | 只准 `components/ui` | `fe-css-position-fixed` | — |

**這 14 條基準是待清的存量，不是許可**（擁有者 2026-11-20 決定接受「凍住現況、只准減不准增」，不算違反「例外清單全部清空」）：每一條都要有往下減的負責人或批次，搬完一種就把基準降到 0 並從 `RATCHET_RULES` 拿掉。**目前還沒有指派負責人或批次**——14 條都是空缺，由擁有者排定第一批時填在這裡（規則 → 批次 → 負責人）。

基準的數法：**一條宣告算一條**（`padding: 6px 10px` 是一條，不是兩個值），逐檔計數，記在 `scripts/allowlist-baseline.json`，只准減不准增（與 `be-raw-sql` 同一種棘輪）。新加的規則共 14 條（12 條 CSS、2 條 TSX）；`border-style`、`border-where` 沒有規則（原因見表）。**這 14 條都是「今天的數量不准再多」，不是「今天已經乾淨」**：基準以內的舊寫法照舊，要靠後續的分批搬到刻度上，每搬一批把基準降下來，降到 0 時從 `scripts/allowlistLib.mjs` 的 `RATCHET_RULES` 拿掉，變成和 `fe-css-color` 一樣的嚴格模式。

## 四、各種類的層級、用途與舊值對應

舊值 → 新值的對應是**起點**，修的批次裡逐處看（例如 6px 的間距在密集的列是 4，在卡片是 8）。

### 4.1 顏色 `colour`

今天：`tokens.css` 的 `--ac-*`；`fe-css-color` 擋字面顏色；`fe-css-legacy-token` 擋舊別名。**守門沒有管「token 夠不夠少」。**
A 的做法：保留的名字少於今天；其餘併入。

| token | 淺色 | 深色 | 用在 |
| --- | --- | --- | --- |
| `--ac-bg` | `#fbfbfa` | `#171716` | 頁面底 |
| `--ac-surface`（併入 `--ac-raised`、`--ac-code-bg`） | `#f3f2ef` | `#222220` | 淡色底：小標籤、AI 提問框、程式碼區塊、輸入欄底、側欄 |
| `--ac-elevated` | `#ffffff` | `#262624` | 選單、對話框、浮層（靠陰影分開） |
| `--ac-line` | `#ebeae7` | `#2c2c2a` | 細線：只分區 |
| `--ac-field-line`（**新**） | `#8c8b87` | `#77766f` | 輸入欄的框（3:1 以上） |
| `--ac-ink` | `#1f1f1e` | `#f1f0ec` | 內文、標題 |
| `--ac-muted`（併入 `--ac-ink-2`、`--ac-faint`） | `#6b6a67` | `#a8a7a2` | 次要字、未使用的分頁 |
| `--ac-accent`、`--ac-link` | `#9c3a48` | `#d9969a` | 強調（只有第一節那幾處）、連結 |
| `--ac-accent-ink` | `#fcfaf5` | `#221012` | 強調色底上的字 |
| `--ac-accent-soft` | `#f6e0e1` | `#3e2a2c` | 選取、使用中的淡色底 |
| `--ac-focus` | `#ae5962` | `#e5a8ac` | 焦點框 |
| `--ac-hover`、`--ac-selected`、`--ac-overlay-*` | 現有 | 現有 | 懸停、選取、按下的疊色 |
| `--ac-danger`、`-soft`；`--ac-warning`；`--ac-success`；`--ac-info` | 現有 | 現有 | 狀態（要在新底色上重驗對比，今天對 `#f8f4ec` 設計） |
| `--ac-selection`、`--ac-scrim` | 現有 | 現有 | 選取文字、遮罩 |
| `--ac-hl-*`、`--ac-pdf-*`、`--ac-pure-*` | 現有 | 現有 | **使用者內容**（螢光筆、PDF 頁面、照片），不算介面 |

取消或併入：`--ac-accent-tint-*`（7 個）、`--ac-accent-wash`／`-muted`／`-border`、`--ac-success-wash`、`--ac-purple`、
`--ac-callout-*`、`--ac-info-soft`／`warning-soft`／`success-soft`（併入 `--ac-surface` 加狀態色字）。
「半透明疊色」（同一個 token 加透明度，普查標成 `alpha:`）只允許 `--ac-overlay-*` 與 `--ac-scrim`。

**只能由普查看到**：`color-mix()` 與透明度疊出來的顏色、繼承來的顏色、編輯器（CodeMirror）自己注入的樣式、使用者內容（螢光筆、PDF、照片）。

### 4.2 字級 `font-size`

| 層級 | 用在 | 舊值 → 新值 |
| --- | --- | --- |
| 12 | 小標籤、計數、中繼資料、說明 | 11（`--ac-fs-xs`）→12；12.5（`caption`）→12；12（`--onden-text-sm`）→12 |
| 13 | 次要文字、麵包屑 | 13（`small`）→13 |
| 14 | 介面（導覽、清單、選單）、行內程式碼 | 14（`ui`）→14；`0.85em`／`0.9em` 的行內程式碼→ 14（寫成 `0.875em` 在 16px 內文裡） |
| 16 | **內文**、輸入欄（iOS 要求 ≥16）、手機的介面字、三級標題 | 15（`ui-touch`）→16；17（`prose`）→16；`--ac-fs-input` 本來就是 16 |
| 20 | 二級標題、卡片標題 | 18（`lg`）→20；20（`h3`）→20；22→20 |
| 24 | 手機筆記標題、標籤頁標題 | 24→24 |
| 34 | 筆記標題 | 32→34 |

13 種 → 7 種。使用者的「基礎字級」與「內文大小」設定仍然縮放整套（`--ac-fs-base` 乘數）；層級以預設 14／16 為準。

**只能由普查看到**：`em`、`%`、`calc()` 算出來的字級（`fe-css-font-size` 放行相對值）、`font:` 簡寫裡的字級、使用者設定的「基礎字級」造成的實際 px。

### 4.3 字重 `font-weight`

400（內文）、600（標籤、使用中的分頁、三級標題、二級標題）、700（筆記標題、粗體）。500→ 內文性質的用 400、標籤用 600（逐處看）；100／300／900 只准出現在 `@font-face` 的可變範圍宣告。

**只能由普查看到**：`font:` 簡寫裡的字重、`<b>`／`<strong>`／`<th>` 瀏覽器預設的粗體、編輯器注入的粗體。

### 4.4 行高 `line-height`（與自己字級的比值）

1（單行的圖示按鈕、徽章）、1.3（標題）、1.5（介面）、1.8（內文、引用）。舊：1.2／1.25／1.35→1.3；1.4／1.45／1.55／1.6→1.5；1.65／1.7／1.75／1.85／1.9→1.8；`18px` 之類固定 px 改成比值。

**只能由普查看到**：`font:` 簡寫裡的行高、繼承來的行高、`calc()` 算出的行高；行高是比值，實際 px 要看字級。

### 4.5 字距 `letter-spacing`

0（預設）、0.04em（全大寫的小標籤；中文介面很少用）、-0.02em（筆記標題）。其他 0.01–0.06em、0.5px 併入這三個。

**只能由普查看到**：繼承來的字距、`calc()` 算出的字距。

### 4.6 字體 `font-family`

只有四個名字，且都經 token：`sans`（`--ac-font-ui`，介面）、`serif`（`--ac-font-prose`／`display`，內文與標題）、`mono`（`--ac-font-mono`）、`kai`（使用者選的楷體）。寫死的 `IBM Plex Sans`、`Fraunces` 等是舊殘留（已發布網站的樣式表用的另當別論）。

**只能由普查看到**：`font:` 簡寫裡的字體、token 的**內容**（`--ac-font-ui` 實際排出哪一個字體）、使用者選的楷體。

### 4.7 間距 `spacing`（padding、margin、gap 的每一邊）

| 層級 | 用在 |
| --- | --- |
| 2 | 圖示與文字之間的微距、列與列的細縫 |
| 4 | 緊密元件內（小標籤的上下、按鈕內圖示與字） |
| 8 | 元件內的預設、相鄰元件的預設間距 |
| 12 | 卡片與列的內距、區塊內的段距 |
| 16 | 頁面與面板的邊距（手機 gutter 也是 16）、區塊與區塊 |
| 24 | 段落群組、頁面欄的左右邊距 |
| 32 | 大區塊之間 |
| 48 | 頁面頂部／底部留白 |

舊 → 新（起點）：1→2、3→4、5→4、**6→8**（今天最多的第二名，約 450 處）、7→8、9→8、**10→12**（約 300 處）、11→12、13→12、14→16、15→16、18→16、20→24（`--ac-phone-gutter: 20` 改 16）、22→24、28→24、36→32、40→48。
`--ac-space-1..10`（2、4、6、8、12、16、20、24、32、48）改為（2、4、8、12、16、24、32、48）八級，`--ac-space-3`（6）與 `--ac-space-7`（20）取消。
自動置中的外距（`margin: 0 auto`）不算。

**只能由普查看到**：`calc()` 與 `clamp()` 算出來的間距（規則看得到裡面的字面值，看不到結果）、`gap` 在 grid 的實際行距、`em` 造成的實際 px、行內 `style={{ padding }}`（TSX 沒掃）、編輯器注入的間距。

### 4.8 邊框：粗細、樣式、位置

- **粗細** `border-width`：1（細線、欄位）、2（使用中分頁的底線、焦點）、3（提示框左邊的線）。1.25／1.5→1；4、6→3 或 2（逐處看）。
- **樣式** `border-style`：`solid`；`dashed` 只給「可以放檔案」的區域。`dotted` 取消。
- **位置** `border-where`（今天沒有任何規則在談「框可以出現在哪裡」）：
  - 允許：單邊 1px 的**分隔線**；輸入欄／文字區／下拉的四邊框（`--ac-field-line`）；表格格線；`dashed` 的放置區；使用中分頁的 2px 底線；提示框左邊 3px 的線。
  - **不允許**：按鈕外面一圈框、卡片外面一圈框（改用淡色底或留白）、兩到三邊有框的盒子。
  - 例外要在 `owners` 表裡寫理由（之後守門時）。
  - **第三批（2026-11-28）已做的**：共用按鈕 `ui-btn--ghost` 與 `ui-btn--icon` 靜止時框線透明、沒有底色（框的寬度留著，版面不位移），按下的切換鈕改用 `--ac-accent` 字＋`--ac-accent-soft` 底；普查不再把**透明的框**算成框（`collect.mjs`，有自我測試）。還圍著框的：`secondary` 按鈕（另一批，要先決定它在側欄的淡色底上怎麼看得出來）、不走共用按鈕的自製按鈕（筆記工具列的編輯／並排／預覽一組與 ⋯、側欄頂端的「＋ 排序 展開」、表格的「編輯」）。

**只能由普查看到**：「邊框可以出現在哪裡」（`border-where`）——按鈕外面一圈框、卡片外面一圈框、兩到三邊有框的盒子；要知道元素的角色與哪幾邊有框，只有畫面上算出來才知道。`fe-css-border-width` 只管寫出來的粗細字面值；`border-style` 沒有規則，只能由普查看到。

### 4.9 圓角 `radius`

| 層級 | 用在 | 舊 → 新 |
| --- | --- | --- |
| 4 | 小標記、鍵盤鍵、螢光標示、核取方塊 | 2、3、4（`xs`、`sm`）→4 |
| 8 | 按鈕、輸入欄、卡片、選單項目（預設） | 6（`md`）→8；10→8 |
| 12 | 對話框、底部面板、大卡片 | 12（`lg`）、16（`xl`）→12 |
| 膠囊 | 小標籤、頭像、圓點、開關 | 999、50%→膠囊 |

6 種 → 4 種（`--ac-radius-xs` 取消，`xl` 併入 `lg`，`md` 的值 6→8）。

**只能由普查看到**：`50%`、`calc()` 與繼承的圓角（`fe-css-radius` 只擋字面值）、`overflow: hidden` 時被父層裁出的視覺圓角。

### 4.10 陰影 `shadow`

A 幾乎沒有陰影：層次靠留白與細線。

| 層級 | 用在 | 舊 → 新 |
| --- | --- | --- |
| 無 | 預設，包含卡片與按鈕 | `--ac-shadow-sm`、`--ac-shadow-bar-up` → 無（或 `--ac-edge-up` 一條細線）；`--ac-shadow-card-*`（4 個）→ 無＋`--ac-ring`（選取）＋`float`（拖動中） |
| `float` | 選單、浮層、懸浮面板 | `--ac-shadow-float`、`--shadow`→float |
| `modal` | 對話框 | `--ac-shadow-modal` |
| `sheet` | 手機底部面板 | `--ac-shadow-sheet` |
| 狀態標記 | `--ac-ring`（選取）、`--ac-focus-ring`、`--ac-bar-start`（提示框左線 3px）、`--ac-bar-bottom`（分頁底線 2px）、`--ac-edge-up` | 其餘 `--ac-ring-*`、`--ac-inset-ring*`、`--ac-bar-top`、`--ac-shadow-swatch-*`、`--ac-shadow-picker-thumb`（取色器專用，不算介面陰影，歸「使用者內容」）取消或併入 |

**只能由普查看到**：`filter: drop-shadow()`、疊出來的 `outline` 假陰影、編輯器注入的陰影。

### 4.11 控制項高度 `control-height` 與觸控目標 `tap-target`

**觸控目標用「實際量到的可點大小」判定**（業主 2026-11-17 的要求）：在 `pointer: coarse` 的裝置上，每個 button、連結、tab、輸入框、可點的列，**可點的範圍寬與高都要 ≥ 44 CSS px**；不必把畫出來的框變高，可以用看不見的擴大點擊範圍（`.tap-target` 的偽元素、外包的可點容器）達成。普查在觸控模擬下用 `elementFromPoint` 從四邊往外量，擴大的範圍算進去，所以第一批改完可以用同一個數字比前後（`tap-target`）。判斷依 `(pointer: coarse)`，不依寬度：1280×800 的平板橫放是桌面版面，仍然是手指在點。

**第一批（觸控目標）已做的**：共用零件在 `pointer: coarse` 下改——`global.css` 的擴大點擊範圍清單、`.ui-btn--icon.ui-btn--sm` 與 `.ui-segment` 的 44、側欄的列與展開箭頭（`OverviewSidebar.css`）、頂列的控制項（`AppTopbar.css`）、設定清單與搜尋框；面板拖曳邊（`.pane-resizer`）在觸控裝置上可抓範圍 24px（線仍是 2px）。守門：`scripts/tap-target-baseline.json`（Tab S9 尺寸 1204×714 與手機 390 的各畫面「不到 44」數量，只減不增；`npm run style:census -- --check-taps`，手動）。普查的量法用二分逼近邊界，所以剛好 44 的擴大範圍讀作 44，不是 43。還沒到 44 的：麵包屑、標題旁的標籤與「＋」、筆記邊緣的標題刻度、資訊欄的小標題按鈕、日記時間軸的收合列、行內連結（WCAG 行內例外）。

真機基準（業主的 Galaxy Tab S9，`pointer: coarse`，視窗 1204×714，寬或高任一邊 <44 算不到）：

| 畫面 | 控制項 | 不到 44 |
| --- | ---: | ---: |
| 筆記（三欄，AI 分頁） | 66 | 60 |
| 筆記（功能／標籤／關係分頁） | 87–90 | 81–82 |
| 日記 | 27 | 13 |
| 任務 | 30 | 18 |
| 閱讀 | 21 | 16 |
| 設定 | 61 | 40 |

最小的一批（高 24–26）：側欄頂端的「筆記／收件匣／排序／展開／＋」、日記的「還有 N 篇」、任務的「到期時提醒我」、設定的「顯示進階設定」；側欄樹的列高 32–34，展開箭頭 20×34。**這是第一批的目標**（見 PR 說明的順序）。真機另量到：九個畫面都沒有橫向捲動、沒有超出視窗的元素、沒有被硬切的文字；筆記畫面上 app 自己的字級有 7 種（11、11.05、12、12.5、13、14、15）；有框線的按鈕每個畫面 14–20 個（A 是不加框）。

**畫出來的高度 `control-height`**（桌面，`pointer: fine`）：

| 層級 | 用在 |
| --- | --- |
| 28 | 工具列、選單項目、密集的列 |
| 32 | 預設的按鈕、輸入欄 |

觸控螢幕上畫出來的高度不另設層級（只要可點範圍 ≥ 44，畫出來的可以是 32）。24、26、30、34、36、40、48 取消。
不是控制項、各自有高度的區域：頂列 48、分頁列 42、手機底部列 56（沿用，另議）。
`--ac-control-sm/md`（28／32）與 `--onden-control-sm/md`（30／36）併成前者；`--ac-row` 系列（28／32／36）併入。

**只能由普查看到**：規則只看「選擇器像控制項」的 `height`／`min-height`（元素 button／input／select／textarea／summary、`[role=button|tab|…]`、`[type=…]`、class 名含 btn／button／input／field／select／tab／chip／toggle／switch／checkbox／radio／control／pill 等字，且不含 bar／panel／list／group／row／wrap／container 這類容器字）；**看不到**：class 名沒有這些字的控制項、由 `padding` 加 `line-height` 撐出來的高度、`aspect-ratio`、JS 設的行內高度、`em`／`%` 的高度、偽元素。反過來也會誤判（名字像控制項的容器）。控制項畫出來實際多高，只有普查量得到。

### 4.12 圖示 `icon-size`、`icon-stroke`

| 層級 | 用在 | 舊 → 新 |
| --- | --- | --- |
| 12 | 小標籤與中繼資料裡的圖示 | 10、11、12→12 |
| 16 | 預設（列、按鈕、選單） | 13、14、15、16、17→16 |
| 20 | 頂列、工具列、觸控裝置的圖示按鈕 | 18、20、22→20 |
| 24 | 手機底部列、空狀態的小插圖 | 24、26→24 |

線寬一律 1.5。大於 32 的是插圖，不算圖示。

**只能由普查看到**：沒有寫 `size` 的圖示（lucide 預設 24）、沒有寫 `strokeWidth` 的預設線寬（2）、`size={n}` 的 n 是變數或運算式、CSS 設的 `width`／`height`、不是 lucide 的 SVG、`currentColor` 以外的繪製細節。**暫時的契約**：圖示常數（`lib/iconSize.ts`）會跟第一批搬圖示的改動一起建立，在那之前規則只擋不在 12／16／20／24（線寬 1.5）上的字面值，常數出現後改成「任何字面值」並重算基準。

### 4.13 層級 `z-index`

保留 15 個命名層（先前寫 13 是我數錯，實際 14，再加下面的 310）：`--z-base`(0)、`--z-local-1..4`、`--z-sticky`(10)、`--z-dropdown`(30)、`--z-bar`(100)、`--z-kb-toolbar`(120)、`--z-floating-panel`(300)、`--z-bar-over-dock`(310，#1805 加的：手機底部列在底部面板停靠時要蓋過它，不能併入 300)、`--z-toast`(400)、`--z-popover`(1000)、`--z-drawer`(4000)、`--z-gate`(9999)。
併入：`--z-raised`(20)→sticky；`--z-pane-float`(40)、`--z-pane-overlay`(50)、`--z-pane-top`(60)→dropdown；`--z-local-5..7`→`--z-local-4`；`--z-board-menu`(200)→floating-panel；`--z-notice-low`(350)、`--z-notice-top`(420)→toast；`--z-pane-expand`(900)、`--z-backdrop`(999)→popover；`--z-bubble`(3000)→popover。
**這個併法會改變誰蓋住誰，每併一個要用 layout-audit 的 R1（可點的東西被蓋住）逐畫面驗。**

**只能由普查看到**：實際誰蓋住誰（層疊上下文）、`position: fixed` 之外的堆疊（`isolation`、`transform` 形成的新層）；併層要用 layout-audit 的 R1 驗。

### 4.14 最大寬度 `max-width`

| 層級 | 用在 |
| --- | --- |
| 640 | 內文欄（`--ac-prose-max`） |
| 720 | 頁面欄與清單（今天 `--ac-page-column` 744 與 `--ac-list-max` 720 併成 720） |
| 560／400 | 一般對話框／小對話框（確認、重新命名） |
| 320 | 側欄與右側面板的寬度上限、選單 |

`100%`、`100vw`、`none` 不算。

**只能由普查看到**：規則擋所有 `max-width` 的 px／rem／ch／em 字面值，**分不出是不是文字欄**（`%`、`vw`、`none` 不算）；`width`、`flex-basis`、`min()`／`clamp()` 設出的欄寬、元素實際排出來的寬度。

### 4.15 透明度 `opacity`

0／1（淡入淡出的兩端，不算）、0.5（停用）、0.7（拖動中的殘影、已完成而淡化的項目）。優先用顏色 token，不靠透明度做層次。舊：0.25–0.6→0.5；0.65–0.96→0.7。

**只能由普查看到**：`opacity` 以外讓東西變淡的方法（`color-mix`、`rgba` 的 alpha、`filter`）、繼承與疊加的透明度、動畫中途的值。

### 4.16 動畫 `transition-ms`

120ms（懸停、焦點、顏色變化）、200ms（面板、底部面板、展開收合）；緩動只有 `--onden-motion-ease`（進）與 `--onden-ease-leave`（出）。
80／100／150／160／180→120；250→200。無限循環的載入動畫（spinner、進度條）不算。使用者設定「減少動態」時全部歸零（沿用 `html[data-reduce-motion]`）。

**只能由普查看到**：`transition: all` 等沒寫出來的預設緩動（`ease`）、`animation-delay`／`transition-delay`（沒掃）、JS 的 Web Animations、`calc()` 算出的時間；`infinite` 的循環動畫不受限。

### 4.17 焦點框 `focus-ring`

只有一種：`outline: var(--ac-focus-outline)`（2px 實線，焦點色），外距 `--ac-focus-offset`（2px）；會被裁切的列用 `--ac-focus-inset`（-2px）。
今天有 `--ac-focus-ring`（陰影形的光圈）與 `--ac-ring-focus` 兩種並存；A 只留 outline 一種，光圈只給無法用 outline 的圓形元件。

**只能由普查看到**：瀏覽器預設的焦點框（沒寫任何規則的元素）、元件庫（CodeMirror、xyflow）自己畫的焦點、`outline` 以外的焦點指示（背景色變化）、`:focus` 規則以外的元素實際有沒有看得見的焦點。

### 4.18 斷點 `breakpoint`

600（手機）、900（以下用手機版面）、1280（桌面）；不新增。觸控大小跟著 `(pointer: coarse)`，不跟寬度。`fe-css-media-width` 只管 `width` 條件；`height`、`orientation`、`hover`、`pointer`、`prefers-*` 目前沒有規則（原始碼裡 `pointer: coarse` 40 處、`hover: none` 11 處、`prefers-reduced-motion` 22 處）。

## 五、守門怎麼做

**同一套機制，沒有第二套**：偵測寫在 `packages/frontend/scripts/appearanceLook.mjs`（CSS 用 postcss，TSX 用 TypeScript 的語法樹），
`allowlist/css.ts`、`allowlist/fileRules.ts` 接成 `fe-css-*`／`fe-icon-*` 規則，由 `allowlist.guard.test.ts` 逐檔計數、對 `scripts/allowlist-baseline.json` 比對，
`scripts/checkEditedFile.mjs` 的寫檔即檢查也自動涵蓋；外觀普查的 `static.mjs` 讀**同一個偵測函式**，所以「守門數到的」和「普查說原始碼寫了什麼」不會分家。
錯誤訊息和 `fe-css-color` 一樣來自 `scripts/entrypoints.catalog.json` 的項目（需求、請用、寫法、取代）。

契約和既有規則相同：**一個字面值出現在該用 token 或允許關鍵字的地方**。每條規則的細節：

| 規則 | 什麼算違規 | 放行 | 要改用 |
| --- | --- | --- | --- |
| `fe-css-spacing` | `padding`／`margin`／`gap`（含 `-top`／`-inline-start` 等分邊與邏輯屬性）裡 var() 以外的非 0 長度（px、rem、em、%…，`calc()` 裡的也算） | 0、`auto`、`var()` | `--ac-space-*` |
| `fe-css-line-height` | `line-height` 的數字或長度字面值 | `normal`、`inherit`、`var()` | `--ac-lh-*` |
| `fe-css-font-weight` | `font-weight` 的數字或 `bold` 等字 | `var()`；`@font-face` 內的範圍宣告 | `--ac-fw-*`（regular／semibold／bold） |
| `fe-css-letter-spacing` | `letter-spacing` 的非 0 長度 | 0、`normal`、`var()` | `--onden-tracking-*` |
| `fe-css-font-family` | `font-family` 的字體名（含 `monospace` 等通用名） | `var()`、`inherit`；`@font-face` 內 | `--ac-font-ui`／`prose`／`mono`／`kai` |
| `fe-css-border-width` | `border`、`border-top` 等簡寫與 `border-*-width` 裡的長度或 `thin`／`medium`／`thick`（顏色函式裡的數字不算） | 0、`none`、`var()` | `--ac-border-thin`／`medium`／`thick` |
| `fe-css-opacity` | `opacity` 不是 0、1、100% 的字面值 | 0、1、`var()` | `--ac-opacity-disabled`（0.5）、`--ac-opacity-dim`（0.7） |
| `fe-css-duration` | `transition`、`transition-duration`、`animation`、`animation-duration` 裡非 0 的時間字面值 | 0、`var()`；含 `infinite` 的循環動畫 | `--onden-motion-fast`（120ms）、`--ac-duration-panel`（200ms） |
| `fe-css-easing` | 同上屬性與 `*-timing-function` 裡的 `ease`／`ease-in`／`ease-out`／`ease-in-out`／`linear`／`cubic-bezier()`／`steps()` | `var()`；循環動畫 | `--onden-motion-ease`、`--onden-ease-leave` |
| `fe-css-control-height` | **選擇器像控制項**的 `height`／`min-height`／`block-size` 的 px／rem 字面值（定義與看不到的見 §4.11） | `var()`、`auto`、`%`、`em`、0 | `--ac-control-sm`／`md`（28／32）、`--ac-tap`（44） |
| `fe-css-max-width` | `max-width`／`max-inline-size` 的 px／rem／em／ch 字面值（分不出是不是文字欄） | `%`、`vw`、`none`、`var()` | `--ac-prose-max`（640）、`--ac-list-max`（720）、`--ac-width-sm`／`md`／`lg`（320／400／560） |
| `fe-css-focus-ring` | `outline`、`outline-offset`、`outline-width`、`outline-style` 的長度或線型字面值；`:focus`／`:focus-visible`／`:focus-within` 規則裡沒有引用「名字含 focus 的 token」的 `box-shadow` | `none`、0、`var()`；`box-shadow: none` | `outline: var(--ac-focus-outline)` 加 `--ac-focus-offset`／`--ac-focus-inset` |
| `fe-icon-size` | `lucide-react` 圖示的 `size={n}`（或 `size="n"`）字面值，**不是 12、16、20、24** | 變數與運算式；非 lucide 的元件 | 12／16／20／24（常數 `lib/iconSize.ts` 之後建立） |
| `fe-icon-stroke` | `lucide-react` 圖示的 `strokeWidth` 字面值，**不是 1.5** | 變數與運算式 | 1.5 |

**誤判時的例外（只有這一種寫法）**：規則猜錯（例如名字像控制項的容器）時，在那一條宣告正上方寫 `/* appearance-ok <規則 id>: <理由> */`（理由至少 6 個字，沒有理由不算數；只放過那一條規則、那一條宣告）。它留在 diff 裡讓審查看得到；其他放行方式（owners 表、改基準）不適用於這 12 條 CSS 規則。

不受規則管的檔案與既有規則一樣：`CSS_EXEMPT`（token 檔、已發布網站的樣式、列印樣式、`components/siteFrame/`）。
**token 沒有對應 TSX 常數之前**，兩條圖示規則放行落在刻度上的數字（上面表中的「暫時」）；其餘 12 條 CSS 規則的 token 都已存在
（新增的只有定義，沒有任何地方在用，所以不改變任何算出來的樣式：`--ac-fw-semibold`、`--ac-border-*`、`--ac-opacity-*`、`--ac-duration-panel`、`--ac-width-*`、`--ac-icon-*`、`--ac-icon-stroke`）。

**還沒做**：對已有規則的五種（顏色、字級、圓角、陰影、層級）把「只准 token」升級成「只准刻度內的 token」——這需要先決定 A 的值（§六），§七 的凍結名單先擋住 token 變多。

**普查的比對模式**（擋守門看不到的）：`node e2e/style-census/run.mjs --compare <舊的 report.json>` 在量完之後比對每一種的「不在刻度上」次數，任何一種變多就結束碼 1；
加 `--against <新的 report.json>` 只比兩份檔案、不開瀏覽器。報告裡的 `summary` 是機器可讀的摘要（量測範圍與每種的 `total`／`off`／`offDistinct`）。
**不接 CI**：要先 `npm run build:browser`，完整跑約 19 分鐘、需要瀏覽器；範圍（寬度×主題）不同的兩份報告不能比，只比兩邊都量到的畫面。建議在每一批搬刻度的改動前後各跑一次。

## 六、還要業主決定的

1. 圓角 `md` 6→8 是否接受（影響最廣的一個數字）。
2. 手機底部列高度（56）與密度設定（compact／spacious 目前改的是列高 24／36）要不要保留。
3. 欄位框 `--ac-field-line` 是否接受多一個顏色。
4. 已發布網站的樣式表（`published-site.css`、`site-tokens.css` 與共用的 `MarkdownRenderer.css`）不跟著 A，這點是否維持。

## 七、token 名單（凍結）

守門擋「寫死的值」，不擋「token 變多」：字級曾有 13 種、圓角 6 種、層級 22 個，每個都合法。`appearanceTokens.guard.test.ts` 補上這一半：
`tokens.css` 與 `theme-tokens.css` 定義的每一個自訂屬性必須在下面的名單裡（依種類），**新增一個名字就失敗**。
名單只有一份來源：`scripts/appearance-token-baseline.json`（棘輪檔，新增名字需要擁有者的 `ratchet-override`）；下面這段由 `npm run appearance:tokens` 從它產生，測試比對兩者相同。
要新增層級：先在這份文件決定它是哪一種的第幾級，再改 JSON、跑指令，並說明為什麼既有的不能用。名單可以變短（刪掉的 token 不會讓守門失敗）。
種類由名稱前綴決定（`--z-*`＝層級、`--ac-fs-*`＝字級…），其餘依值：含顏色的是顏色，指向顏色名字的也是；剩下的是 `other`（版面尺寸）。

<!-- appearance-tokens:begin（由 npm run appearance:tokens 從 scripts/appearance-token-baseline.json 產生，不要手改） -->

- `border-width`（3）：`--ac-border-medium`、`--ac-border-thick`、`--ac-border-thin`
- `colour`（97）：`--ac-accent`、`--ac-accent-border`、`--ac-accent-hover`、`--ac-accent-ink`、`--ac-accent-muted`、`--ac-accent-soft`、`--ac-accent-tint-24`、`--ac-accent-tint-3`、`--ac-accent-tint-38`、`--ac-accent-tint-54`、`--ac-accent-tint-7`、`--ac-accent-tint-70`、`--ac-accent-tint-85`、`--ac-accent-wash`、`--ac-bg`、`--ac-callout-example`、`--ac-callout-quote`、`--ac-code-bg`、`--ac-danger`、`--ac-danger-soft`、`--ac-elevated`、`--ac-faint`、`--ac-focus`、`--ac-hint-color`、`--ac-hl-blue`、`--ac-hl-green`、`--ac-hl-orange`、`--ac-hl-purple`、`--ac-hl-red`、`--ac-hl-yellow`、`--ac-hover`、`--ac-hue-red`、`--ac-hue-spectrum`、`--ac-info`、`--ac-info-soft`、`--ac-ink`、`--ac-ink-2`、`--ac-line`、`--ac-link`、`--ac-link-deep`、`--ac-muted`、`--ac-overlay-hover`、`--ac-overlay-press`、`--ac-overlay-selected`、`--ac-overlay-subtle`、`--ac-pdf-area-edge`、`--ac-pdf-area-fill`、`--ac-pdf-highlight`、`--ac-pdf-highlight-solid`、`--ac-pure-black`、`--ac-pure-white`、`--ac-purple`、`--ac-raised`、`--ac-scrim`、`--ac-selected`、`--ac-selection`、`--ac-success`、`--ac-success-soft`、`--ac-success-wash`、`--ac-surface`、`--ac-warning`、`--ac-warning-soft`、`--accent`、`--accent-muted`、`--accent-strong`、`--bg`、`--border`、`--danger`、`--line`、`--muted`、`--onden-accent-2`、`--onden-accent-9`、`--onden-accent-bg`、`--onden-accent-bg-hover`、`--onden-bg-base`、`--onden-bg-subtle`、`--onden-bg-surface`、`--onden-bg-surface-2`、`--onden-border-default`、`--onden-ink-12`、`--onden-overlay-hover`、`--onden-overlay-selected`、`--onden-state-error-bg`、`--onden-state-error-text`、`--onden-state-info-text`、`--onden-state-success-text`、`--onden-state-warning-text`、`--onden-text-faint`、`--onden-text-muted`、`--onden-text-normal`、`--onden-text-on-accent`、`--onden-text-strong`、`--surface`、`--surface-2`、`--surface-strong`、`--text`、`--text-muted`
- `control-height`（9）：`--ac-control-md`、`--ac-control-sm`、`--ac-row`、`--ac-row-compact`、`--ac-row-touch`、`--ac-tap`、`--onden-control-md`、`--onden-control-sm`、`--onden-tap`
- `easing`（2）：`--onden-ease-leave`、`--onden-motion-ease`
- `focus-ring`（3）：`--ac-focus-inset`、`--ac-focus-offset`、`--ac-focus-outline`
- `font-family`（15）：`--ac-font-display`、`--ac-font-kai`、`--ac-font-mono`、`--ac-font-prose`、`--ac-font-sans`、`--ac-font-serif`、`--ac-font-ui`、`--font-display`、`--font-ui`、`--onden-font-body`、`--onden-font-display`、`--onden-font-mono`、`--onden-font-ui`、`--onden-ui-font-family-editor`、`--onden-ui-font-size-base`
- `font-size`（17）：`--ac-fs-base`、`--ac-fs-caption`、`--ac-fs-h3`、`--ac-fs-input`、`--ac-fs-lg`、`--ac-fs-prose`、`--ac-fs-slide-body`、`--ac-fs-small`、`--ac-fs-title`、`--ac-fs-title-sm`、`--ac-fs-ui`、`--ac-fs-ui-touch`、`--ac-fs-xs`、`--onden-text-base`、`--onden-text-sm`、`--onden-text-sm2`、`--onden-text-xs`
- `font-weight`（8）：`--ac-fw-bold`、`--ac-fw-medium`、`--ac-fw-regular`、`--ac-fw-semibold`、`--onden-weight-bold`、`--onden-weight-medium`、`--onden-weight-normal`、`--onden-weight-semibold`
- `icon`（5）：`--ac-icon-lg`、`--ac-icon-md`、`--ac-icon-sm`、`--ac-icon-stroke`、`--ac-icon-xs`
- `letter-spacing`（4）：`--onden-tracking-normal`、`--onden-tracking-snug`、`--onden-tracking-tight`、`--onden-tracking-wide`
- `line-height`（8）：`--ac-lh-prose`、`--ac-lh-quote`、`--ac-lh-title`、`--ac-lh-ui`、`--onden-leading-normal`、`--onden-leading-relaxed`、`--onden-leading-snug`、`--onden-leading-tight`
- `max-width`（6）：`--ac-list-max`、`--ac-page-column`、`--ac-prose-max`、`--ac-width-lg`、`--ac-width-md`、`--ac-width-sm`
- `opacity`（2）：`--ac-opacity-dim`、`--ac-opacity-disabled`
- `other`（11）：`--ac-hint-style`、`--ac-page-gutter`、`--ac-panel-w`、`--ac-phone-gutter`、`--ac-topbar-h`、`--ac-tree-w`、`--onden-note-font`、`--onden-note-font-min`、`--onden-note-title-scale`、`--onden-ui-density-row-pad`、`--onden-ui-density-scale`
- `radius`（6）：`--ac-radius-full`、`--ac-radius-lg`、`--ac-radius-md`、`--ac-radius-sm`、`--ac-radius-xl`、`--ac-radius-xs`
- `shadow`（33）：`--ac-bar-bottom`、`--ac-bar-start`、`--ac-bar-start-thin`、`--ac-bar-top`、`--ac-edge-up`、`--ac-focus-ring`、`--ac-inset-ring`、`--ac-inset-ring-drop`、`--ac-inset-ring-thin`、`--ac-ring`、`--ac-ring-focus`、`--ac-ring-halo`、`--ac-ring-halo-wide`、`--ac-ring-soft`、`--ac-ring-thin`、`--ac-ring-wide`、`--ac-shadow-bar-up`、`--ac-shadow-card-editing`、`--ac-shadow-card-hover`、`--ac-shadow-card-lifted`、`--ac-shadow-card-selected`、`--ac-shadow-float`、`--ac-shadow-modal`、`--ac-shadow-picker-thumb`、`--ac-shadow-sheet`、`--ac-shadow-sm`、`--ac-shadow-swatch-chosen`、`--ac-shadow-swatch-chosen-panel`、`--ac-shadow-swatch-gloss`、`--ac-shadow-swatch-rim`、`--ac-shadow-thumb`、`--onden-focus-ring`、`--shadow`
- `spacing`（10）：`--ac-space-1`、`--ac-space-10`、`--ac-space-2`、`--ac-space-3`、`--ac-space-4`、`--ac-space-5`、`--ac-space-6`、`--ac-space-7`、`--ac-space-8`、`--ac-space-9`
- `transition-ms`（4）：`--ac-duration-panel`、`--onden-motion-base`、`--onden-motion-fast`、`--onden-motion-instant`
- `z-index`（28）：`--z-backdrop`、`--z-bar`、`--z-bar-over-dock`、`--z-base`、`--z-board-menu`、`--z-bubble`、`--z-drawer`、`--z-dropdown`、`--z-floating-panel`、`--z-gate`、`--z-kb-toolbar`、`--z-local-1`、`--z-local-2`、`--z-local-3`、`--z-local-4`、`--z-local-5`、`--z-local-6`、`--z-local-7`、`--z-notice-low`、`--z-notice-top`、`--z-pane-expand`、`--z-pane-float`、`--z-pane-overlay`、`--z-pane-top`、`--z-popover`、`--z-raised`、`--z-sticky`、`--z-toast`

<!-- appearance-tokens:end -->
