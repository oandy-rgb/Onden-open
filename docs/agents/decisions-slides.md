# 簡報的決定

何時讀：改筆記的「簡報」視角、版型與主題、`slides_data`、`@onden/site/look`、播放（`PresentationPlayer`）時。
設計全文：`docs/architecture/proposals/slides-2026-10-31.md`（提案，在 #876；合併後這裡改成連結。本檔只記**已實作**批次的決定）。

## 業主決定（2026-10-31，看過 demo 第 5 版後「好」）

簡報**不是新的筆記類型，也不佔導覽列**：是「簡報」功能（`slides` 模組）給筆記的一個視角分頁。三層：第 0 層自動（不存任何東西）；
第 1 層每頁版型＋整份主題（只存選擇）；第 2 層「定下來」成快照才自由排版（後面的批次）。

## 批 0：外觀共用層

- 簡報的外觀走 `@onden/site/look`（`packages/site/src/look.ts`）：`deckVars(style)` 用網站同一份 `STYLE_PRESETS`／`styleVars`，
  只把字級換成 1920×1080 畫布上的固定 px（基準＝網站基準 × 2.5，約 43px；設計文件原定 1.9，實畫後內文太小，調高）。步驟 −1（放不下時的「縮一級」）不低於 28px，標題（step 2）不低於 48px。
- 簡報程式碼只准 import `@onden/site/look`（守門 `look.guard.test.ts`）；那個出口只 import `style.ts`、`palette.ts` 與型別，不進 registry、驗證、React、Puck。
- **網站輸出不變**由 `look.golden.test.ts` 保證：4 種風格 × 6 個色票 × 3 種亮暗的 `styleCss` 輸出是快照，差一個字元就紅。要改網站外觀，必須在同一個變更更新快照並說明。

## 批 1：簡報視角（第 0 層）

- **入口**是已存視角：`collection_views` 裡 `layout: "slides"`（和 slides 模組同 id）。後端 `ModuleDefinition.noteViewLayout` 登記進 `isStoredViewLayout`
  （**不是** `viewLayout`：不產生模組標籤、不是永遠開著）；`assertLayoutImported` 讓模組關掉時拒絕新增。前端 `FrontendModule.noteView`（`Pane`）；
  `useAddView` 只在**筆記**、模組開著時列「簡報」；`buildViewTabs` 的 `hiddenLayouts` 讓模組關掉時分頁不顯示（視角記錄保留）；標籤頁一律不列。
- **頁是算出來的**（`modules/slides/pages.ts`，建在 `parseDeck` 上）：`---` 優先，沒有就 `##`。頁內純段落是講稿（不上投影片）；
  整頁只有一個短段落（≤ 60 字，第一頁且有標題者除外）是大字標語頁，標題縮成小標。自動版型是規則表（`autoLayoutOf`），日期先於數字判斷。
- **一套渲染**：`SlideView` 畫視角的大圖、縮圖、版型選擇的預覽與全螢幕播放；`PresentationPlayer` 不再自己畫整頁 Markdown。測試證明兩處輸出相同。
- 畫面、版型、式樣全部 `lazyWithReload`／`import()`；`modules/slides/index.tsx` 只多 `noteView: { Pane }` 與登記文字。

## 批 2：版型＋主題（第 1 層）

- **只存選擇**：筆記屬性 `slides_data`（`@onden/markdown` 的 `parseSlidesData`／`serializeSlidesData`），列在 `EDITOR_STORAGE_ATTR_KEYS`（屬性清單不顯示）。
  經 `propertyWriter` 寫入（離線佇列、保存契約、`ATTRIBUTE_SET` 進歷史可復原）；沒有任何選擇時移除屬性。≤ 8 KB、≤ 64 筆（超過丟最舊的）。
  **不加入 `MERGED_KEYS`**：內容很小，後寫者勝，同時改同頁走既有 `ATTRIBUTE_CONFLICT`。未知的版型 id 保留、讀作「自動」。
  **已知限制（業主決定不改成逐鍵合併）**：`slides_data` 是**一個**屬性、整份取代。兩台裝置離線時各改**不同頁**的版型，後同步的那份會整份蓋掉先同步的，
  先到那台的版型選擇會丟（筆記文字不受影響；被蓋掉的版本留在歷史，可從歷史復原）。要避免，離線改版型後先讓它同步完再換另一台改。
- **版型選擇怎麼對頁**（頁的鍵，`pageKey` 在 `pages.ts`）：標題的 `^id` → 標題文字（小寫、去記號）→ 頁首 24 字 → 位置；同鍵第 2 張起 `~2`、`~3`。
  頁的其他內容改了選擇仍對得上；沒有 `^id` 的標題被改掉，那頁回到自動（已知限制）。沒有對應頁的選擇保留。
- **12 種版型**（`layouts.ts` 一份註冊表）：封面、章節、條列、段落、圖文、全幅圖、引言、兩欄比較、三個重點、數字重點、時間軸、程式碼或公式。
  任何版型都能畫任何頁（缺的結構由現有內容拼出）；大字標語頁是「章節」的標題區，不另設第 13 種。
- **放不下**：步驟一，瀏覽器實量，內容超出就整頁縮一級（`.sv-shrunk`，內文不低於 28px）；步驟二，只**提議**同內容的另一個版型（`alternativeLayout`，按了才換）；
  步驟三，仍放不下就明說「這一頁的內容比較多，建議在筆記裡拆成兩段」，文字從不裁掉。第 0–1 層不自動拆頁（頁是筆記文字的切分）。
- **表格（2026-11-11）**：有表格的頁，表格吃滿內容區寬度（不套段落的 30em 行寬、不分兩欄），短儲存格（≤16 em）不換行、只有長句換行；放不下時整張表（字與內距同用 em）
  比一般頁多縮一級（`.sv-shrunk-2`＝28px，投影片內文下限），仍放不下提示「這張表格一頁放不下，建議在筆記裡拆成兩頁」（`TABLE_TOO_MUCH_HINT`）。對齊只照 Markdown 的 `:--`／`--:` 標記，沒標記靠左。
  28px 仍**橫向**放不下時才放寬（只太高時不放寬，因為沒有幫助）：`relax` 1＝短儲存格也允許換行（4 欄各 14 字、12 欄各 6 字這類），再不行 `relax` 2＝`overflow-wrap: anywhere`（長網址可斷）；平時只用 `break-word`，英文單字不會被從中間斷開。畫面上是 `data-relax`。圖＋表格的頁（media 版型）溢出時提議「段落」（表格全寬）；
  media 的 grid 列固定為區域高、內文 `max-height: 100%`，否則內容撐高列而量不到溢出。兩欄（compare）：兩欄一樣重（拿掉第二欄固定強調 `sv-col-strong`）；`.sv-cols` 的 grid 列固定為區域高、`.sv-col` `box-sizing: border-box; min-height: 0`，否則欄比區域高 1px 時（量測容差 1px 放行）下邊框被裁掉。PPTX：表頭的強調色下緣（與其他邊不同的下邊框）另輸出一條線。已知：約 15 列以上仍會被切底並提示；表格不是 PowerPoint 原生表格。
  `SlideView` 在投影片從「還沒畫出」（播放模式的 `<dialog>` 開啟前）變成有尺寸時重量，否則播放模式從不縮小。真瀏覽器檢查：`npm run e2e:slides`（`slideTables.mjs`、`slideTablesPptx.mjs`、`slideColumns.mjs`）。已知：投影片第一次量測時字型還沒載完會讓縮放／放寬步數與載完後不同（只會更保守，不會切掉）。
- **主題**：跟網站一樣（即時跟著網站的風格、主色、亮暗；沒有網站設計就用安靜＋預設主色＋跟隨 Onden）／深色（同網站、一律深色）／紙本（紙本風格、網站主色、一律淺色）。
  對應在 `theme.ts` 的 `themeStyle`，是暫定值，看過畫面後可調。
- 沒有編輯權的人能看、能播，版型與主題按鈕停用。手機：大圖在上、縮圖橫排在下，版型與主題用底部面板（`Popover`／`Menu` 的 `sheet`）。

## 批 0–2 第二輪審查後的決定（2026-10-31）

- **「開始播放」只有一個入口**：`modules/slides/present.tsx` 的 `presentNote(node, openNode, startAt?)`。它讀筆記的 `slides_data`（`slidesDataOf`），
  ⌘K、功能分頁的列、簡報分頁的「播放」都呼叫它，所以播出來的版型與主題一定是使用者選的；不再有各自的播放程式。
- **頁內分類只有一套**：`modules/slides/analyze.ts` 不再逐行分類，而是把 `@onden/markdown` 的 `topBlocks`（從 `parserFor("anchors")` 的 mdast 樹來，
  和渲染、大綱同一個讀法）對到投影片的角色。沒有外框的表格、縮排程式碼、callout、`***`、段落下接清單都以樹為準。整行 `![[…]]`（手寫、筆記、任務嵌入）與
  一行多張圖由 `topBlocks` 認成 `embed`／`image`：留在投影片上、照它在筆記裡的樣子畫（圖文版型的圖位），不被當成講稿。任務行是一般的清單項目（箱子當項目符號）。
- **數字與步驟只畫文字**：`splitStat`／`splitStep` 先經 `itemText`（去清單與任務記號、強調、連結語法、行尾 `^id`）再切。段落 `^id` 永遠不顯示。
- **很長的第一段不被切掉**：標題＋長文（第一段超過約 120 字寬，`MAX_SUBTITLE`）時，第一段是投影片的文字（版型「段落」，會縮放），不再當副標；封面／章節的置中區也納入量測
  （`.sv-center.sv-fit`），放不下同樣縮一級、並出現「放不下」提示。
- **畫面重量測的鍵含實際文字**（不只區塊數）：刪字後縮小的投影片會回到原大小。
- **後端也擋**：標籤的視角不收「簡報」（`assertLayoutForTag`，422 `view_layout_not_for_tags`；建立與改版型都擋）；模組關掉時筆記新增／改成簡報視角仍是 409 `module_not_imported`。
- **手機直向**：播放時偵測窄螢幕直向（`usePresentLandscape`），盡力要求全螢幕與橫向鎖定（失敗不顯示錯誤），並提示「把手機轉成橫向」。
- **鍵盤**：簡報分頁內 ←／→ 換頁，縮圖列（桌面直排、窄螢幕橫排）都吃四個方向鍵；`ReplaceWith` 在桌面按 Esc 關閉。
- **延遲載入的字典只有一套機制**：`registerDictionary`（相加不覆蓋）；`extendDictionary` 已刪。

## 還沒做（後面的批次）

自由排版與快照、來源筆記更新提示、多份簡報視角、PPTX 匯入匯出、播放中的筆與雷射筆與講者模式、AI 改簡報走待審建議、歷史的白話差異（「換了第 3 張的版型」）。

## 批 3：外部 AI 看得到簡報（MCP 工具，2026-11-11）

- **切頁與版型判斷只有一份，在 `@onden/markdown`**：`slideDeck.ts`（`parseDeck`）、`slideAnalyze.ts`、`slidePages.ts`（`pagesOf`、`autoLayoutOf`、頁的鍵）、`slideLayouts.ts`。
  前端 `modules/slides/{slides,analyze,pages,layouts}.ts` 只剩 re-export（舊 import 路徑不變，`Page` 是套件的 `SlidePage`）；段落錨點不再是前端 store 的型別，
  而是 `pagesOf(markdown, anchors)` 的參數（`AnchorSpan` 形狀）。`SlidePage.range` 是這頁文字在筆記內文中的起訖（CRLF 當 LF 算）。
- **`getSlides`（唯讀）／`setSlideLayout`（寫）** 在 `backend/src/modules/slides/deckTools.ts`，隨 slides 模組登記（模組關掉就不提供）。
  伺服器用 `noteAnchorRanges` 當 anchors，所以頁的鍵與前端一致。`setSlideLayout` 只改 `slides_data`（同前端：`serializeSlidesData`，沒有任何選擇時移除屬性），
  走 `setNodeAttribute`／`recordAttributeChange`，要 `set_attribute` 權限；不合法的版型、不存在的頁鍵回 422 並說明。
- **「先給我審」的 AI 不能直接改版型**：跟 `applyTag` 等所有屬性類寫入同一條規則（`mutate()` 的 `assertWriteModeAllows` 只放行 `AI_SUGGESTION_CREATED`），
  回 `suggest_only`；試跑（dryRun）也一樣。版型不是文字，不走建議流程；想表達就用 `commentOnNote`。
