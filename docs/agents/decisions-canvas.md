# 邊界決定：白板與手寫

> 狀態：現行
> 涵蓋：packages/frontend/src/lib/data/canvasWriter.ts, packages/frontend/src/lib/sectionCarry.ts, packages/frontend/src/lib/canvasAlignment.ts, packages/frontend/src/lib/canvasExport.ts, packages/frontend/src/lib/jsonCanvas.ts, packages/frontend/src/lib/boardTree.ts, packages/frontend/src/lib/boardTreeSettings.ts, packages/frontend/src/lib/boardTouchGestures.ts, packages/frontend/src/lib/whiteboardTab.ts, packages/frontend/src/lib/cardDisplay.ts, packages/frontend/src/lib/penShortcutBridge.ts, packages/frontend/src/lib/inkInputPrefs.ts, packages/frontend/src/lib/inkPrefs.ts, packages/frontend/src/lib/inkRegionQuote.ts, packages/frontend/src/hooks/useCanvasUndo.ts, packages/frontend/src/hooks/useBoardHistory.ts, packages/frontend/src/hooks/useBoardTree.ts, packages/frontend/src/hooks/useCardDraft.ts, packages/frontend/src/hooks/useEyedropper.ts, packages/frontend/src/hooks/useBoardFullscreen.ts, packages/frontend/src/lib/ink/**, packages/frontend/src/lib/pageText/**, packages/frontend/src/lib/pageImages/**, packages/frontend/src/lib/pageLayer/**, packages/frontend/src/lib/pdf/pageUnits.ts, packages/frontend/src/pagebook/**, packages/frontend/src/components/page/**, packages/frontend/src/components/InkNodeView.tsx, packages/frontend/src/components/PdfNodeView.tsx, packages/frontend/src/components/CanvasInkLayer.tsx, packages/frontend/src/components/BoardPhoneNav.tsx, packages/frontend/src/modules/handwriting/**, packages/markdown/src/inkPages.ts, packages/markdown/src/inkFormat.ts, packages/markdown/src/inkRegion.ts, packages/markdown/src/inkShapes.ts, packages/markdown/src/pageImages.ts, packages/backend/src/services/inkChunks.ts, packages/backend/src/modules/handwriting/index.ts

何時讀：改白板（保存、布局、匯出入、卡片編輯、手機手勢、自動樹）或手寫與 PDF（筆與輸入、頁面本子、頁面文字框與圖片、形狀與顏色、引用區域、手寫分頁、存檔）之前。
這份只留今天成立的規則，每條都對過程式。分批的比較過程、當時的實測步驟與限制、已被取代的做法，原文在
[decisions-canvas-history.md](decisions-canvas-history.md)（第 22、26–38 批與 2026-10～11 各批）。

## 白板：保存與布局

- **寫入走 canvas writer。** 卡片的加入、位置、移除與開啟白板的核對由 `lib/data/canvasWriter.ts` 擁有（`place`、`save`、`refreshOpenCanvas`）；
  UI 只表達意圖，不自己讀 store 拼布局。追加用 `placeCanvasNode(canvasId, nodeId, position?)`：呼叫者保留開始時的白板 ID，writer 判重（已有擺放保持原幾何）、
  算預設位置、讀最新布局；同一追加進行中共用同一個 Promise。
- **同步等核對。** `syncEngine` 等 `refreshOpenCanvas()` 完成才解除本次畫面核對；不假定增量已含布局。
- **等結果的操作回傳 Promise。** 加入、移除、改名、復原都等伺服器或離線佇列接受才關閉或收尾，拒絕時保留輸入並走 `reportWriteFailure`，不用 `backgroundWrite`；
  待同步不顯示成已同步。
- **白板成員來自 `activeCanvas.data`**，不從搜尋、聚焦或虛擬化後的顯示清單判定（加入選單 `CanvasNotePicker` 的重複判斷同理）。
- **顯示與保存分開。** 卡片摺疊／展開與遠景只顯示標題（`lib/cardDisplay.ts`，存在白板分頁 `layout_config.display`，見 [decisions-ui.md](decisions-ui.md)〈白板卡片顯示〉）、縮放、
  分組標題避碰（`layoutSectionHeadings`，只回傳顯示位置）、對齊用的即時量測，都不寫回位置與尺寸；縮圖用的尺寸是 React Flow 量測投影成的 `Node.measured`。

## 白板：位置手勢、復原、匯出入、卡片編輯

- **一個手勢一組位置。** `captureCanvasPositions(data, cardIds, sectionIds)` 取所選卡片與所選分組原成員的聯集（重疊只移一次，隱藏成員也算）；
  `applyCanvasPositions(nodes, sections)` 是正向與復原唯一的布局入口：只合併位置、保留其他欄位、已移除的卡片不重建，缺少目標分組整筆拒絕。
- **分組成員看儲存幾何。** 以卡片中心點判定（`lib/sectionCarry.ts`，含預設尺寸與折疊高度），不隨顯示密度變；縮放傳完整 `CanvasBounds`（原點與寬高同次保存），
  分組縮放不搬成員、搬移才搬。`alignCanvasCards(renderedNodes, selectedIds, mode)` 的八種對齊／分布優先用即時量測，只保存位置。
- **復原。** 位置項目（`useCanvasUndo`）登記在白板唯一的 `useBoardHistory`：⌘Z／⌘⇧Z 依時間順序退回，上限 50，只在開著的白板內有效、不跨工作階段（跨工作階段是 `restoreEvent`）。
  項目在伺服器或離線佇列接受後才移出；退回只動仍停在手勢留下位置的卡片，之後被移動過的保留較新位置。
- **匯出**（`prepareCanvasExport`，`lib/canvasExport.ts`）：用完整儲存成員與幾何，不用顯示清單；缺或 slim 的卡片用 `reads.notes.full` 補讀，失敗丟 `WriteActionError`、不下載；
  只匯出會畫在圖上的連線；白板筆跡（`board_ink`）另附 SVG。等待、防重送與晚到完成由 `useCanvasExport` 管。
- **匯入**（`fromJsonCanvas`，`lib/jsonCanvas.ts`）：建立第一筆之前先驗完整份輸入，格式錯丟 `JsonCanvasFormatError`（指出位置，不附正文）。
  `importCanvasFile` 把讀檔、格式、提交失敗分開回饋；提交階段是多個獨立寫入，沒有整批原子性，失敗訊息要說明可能已有部分內容建立，不自動重送。
- **卡片編輯。** `useCardDraft` 擁有卡片輸入：停頓保存、blur／取消選取／卸載交接、pagehide、失敗重試；已被拒絕的內容不因普通 blur 自動重送。
  進行中寫入由 `writeLifecycle` 登記 `protectPendingWriteOnExit`；直接 HTTP 拒絕時 `writeQueue` 呼叫 `preserveDirectRejection`，用 `storeRejectedWrite` 建一筆不可重播的持久列，
  復原面板只給複製與移除。
- **開始編輯是鏡頭意圖。** `onNodeEditStart(nodeId)` 由白板置中並至少 1 倍，原本更大的倍率保留；編輯期間的版面限制不改保存的卡片尺寸。

## 白板是筆記的視角

- 「有白板」＝筆記有一筆 canvas 檢視（白板分頁），卡片位置以這篇筆記自己的 id 為鍵；`node_type = 'canvas'` 已退役，讀取端把它與白板視為同一回事
  （後端 `boardStore.whiteboardNoteSql`、前端 `lib/whiteboardNote.ts`），不要各處判斷節點類型。契約見 [canvas-as-view.md](../architecture/canvas-as-view.md)。
- **給筆記一個白板只有一條路**：`lib/whiteboardTab.ts` 的 `ensureWhiteboardTab`（加分頁或取消隱藏）。不再建同名複本白板；
  建立白板筆記只剩全新的（空白、建立選單、匯入 JSON Canvas）。守門 `guards/board-copies.guard.test.ts`、驗證 `noBoardCopies.test.ts`。
- 白板筆跡存在筆記的 `board_ink`，不是 `ink_data`（`ink_data` 只屬於手寫頁與 PDF）；各屬性的歸屬見 [ink-attributes.md](../architecture/ink-attributes.md)。

## 白板自動樹

規則與資料位置見 [canvas-as-view.md](../architecture/canvas-as-view.md)〈白板自動樹〉，這裡只記設計：

- **即時算、不另存**：`lib/boardTree.ts`（純函式）排版沿用 `lib/treeLayout.ts` 的 `layoutTree`；`hooks/useBoardTree.ts` 把已存卡片與樹卡片合成一張白板交給 `useGraphLayout`、`useCanvasActions`、復原與群組，其他程式不必知道有樹。
- **拖過才存**：`useBoardWorkspace.saveBoardData` 存檔前濾掉與樹畫的位置／大小／顏色／折疊完全相同、也沒存過的樹卡片；不另開第一次拖的寫入路徑。
- 設定存在白板分頁 `layout_config` 的 `tree` 鍵（`lib/boardTreeSettings.ts`），不進卡片資料。預設模式在第一次看到這張白板時決定並在該次開啟內固定（空白板 auto、有卡片 manual）。
- 點卡片不換白板：`useWorkspaceFocus.onActiveBoard` 把 auto 白板根筆記底下的子孫算作在這張白板上。
- 總量與層數是常數（`TREE_CARD_BUDGET`：手機 30、電腦 100；`TREE_CHILD_PAGE` 8；`TREE_DEPTHS`）。換中心（`centerOn`／`backTo`）是只讀瀏覽，不另存位置。

## 手機上的白板

- 手勢只在手指落在空白處、主要輸入是手指時：單指移動、兩指縮放加移動、長按 `BOX_SELECT_HOLD_MS`（400ms）後拖曳才框選；第二指落下取消進行中的框並還原選取。
  做法是 `lib/boardTouchGestures.ts` 在 window capture 階段扣住第一次落下，長按夠久才補送給 React Flow，不改 React Flow。
- 手機（`phone`，≤900px）的白板永遠全螢幕且頁面不捲動：只由 `useBoardFullscreen`（`always` 選項）一個入口管，`body.onden-board-locked` 鎖頁；
  藏掉頂列與導覽後的出口由 `components/BoardPhoneNav.tsx` 提供（‹ 返回、標題面板含視角分頁與資訊／更多）。守門 `e2e/browser-app/boardPhoneFull.mjs`。

## 手寫：輸入規則與筆

- **輸入規則只在 `lib/ink/inputPolicy.ts`。** 設定 `penDraws`（預設開）：筆在任何工具下都畫，手指與滑鼠不受影響；兩個裝置層級偏好（不跟帳號同步）由 `lib/inkInputPrefs.ts` 一處讀寫：
  手指＝舊的 `inkStylusOnly`（`"1"`＝只捲動），筆＝`inkPenDraws`（`"0"`＝照工具列）。第一次偵測到筆（引擎 `onPenSeen` → `notePenSeen()`）只在這台裝置從沒選過手指設定時才把手指改成只捲動。
  「手指也能畫」固定在 `PageMoreMenu`，手寫頁、PDF、白板共用；工具列不放觸控筆開關。
- **引擎分開記「最後的繪圖工具」與「手形」**（`InkEngine.tool`／`hand`），`getTool()` 仍回傳工具列目前的樣子。
- **筆 ↔ 橡皮擦的快捷動作**（`lib/ink/penShortcut.ts`，純狀態機；宿主用 `usePenShortcutTool(tool, setTool, enabled?)`，手寫頁、白板、PDF 已接）：
  網頁收不到側鍵本身，只認實機量到的間接訊號（懸空時 pen `buttons` 變化、約 150ms 後無前導指標的 `contextmenu`、畫到一半的 pen `pointercancel` 只保留已畫部分不切換），
  不辨識瀏覽器。判斷時間窗是 `PEN_SHORTCUT_QUIET_MS`（600）、`PEN_SHORTCUT_DOUBLE_MS`（3000）、`PEN_SHORTCUT_CANCEL_MS`（2000，iPad 長按放大鏡的誤觸）。
  唯讀筆跡不切換、不攔 contextmenu。**iPad 全部未在實機驗證**：`test/inkPenDevices.test.ts` 用 jsdom 重播文件上的事件序列，不等於 Safari 真的這樣送。
- **懸停預覽**（`lib/ink/penHover.ts`）只在 `pointerType: "pen"` 且沒有 pen 按著時顯示，`PEN_HOVER_IDLE_MS`（400）沒有懸停事件就消失；滑鼠與手指不顯示。
- **原生殼入口**（`lib/penShortcutBridge.ts`，`bootApp.ts` 安裝）：`window.ondenPenShortcut(source?)` 或 `onden:pen-shortcut` 事件；殼尚未實作，沒有殼就沒有人呼叫。
- **停住修形**（`lib/ink/recognize.ts`，純函式）：只認直線、箭頭、矩形、橢圓／圓、三角形、菱形，只對筆；寧可不修。0.5 秒（`HOLD_MS`）由引擎計時，動過 4px 重算；
  放開時 `InkModel.snapStrokeToShape` 一次提交，一步復原回原筆畫。開關是帳號偏好 `inkAutoShapePref`（預設開）。
- **顏色與預設**：帳號偏好都在 `lib/inkPrefs.ts`（`inkPalettePref`、`inkShapeKindPref`、`inkAutoShapePref`、`inkShapeFillPref`、`inkPresetsPref`），後端 `PREF_SCHEMAS` 同形狀，
  `backend/src/test/prefKeysContract.test.ts` 對 key。顏色存十六進位值，深色模式在渲染時反轉亮度。筆預設最多 `MAX_PRESETS`（6）個，名稱至多 `INK_PRESET_NAME_MAX`。
- **取色器**（`hooks/useEyedropper.ts`、`lib/ink/colorPick.ts`）從資料取色、不讀畫面像素：引擎登記成取色來源，文字框根元素帶 `data-ink-color`。
  取色時下一次按壓以 capture 階段攔下 pointer／mouse／touch／click，且這次按壓的後續事件也不讓頁面看到（`keepFromPage`），否則筆的 `buttons≠0` 會被當成側鍵切成橡皮擦。
- **形狀**：幾何只有一份，`@onden/markdown` 的 `inkShapes.ts`，引擎、頁面 SVG、靜態 SVG 共用；形狀是引擎的工具（`InkActiveTool` 的 `"shape"`），不在宿主另寫一個指標面。
  形狀只增不改（橡皮擦整個拿掉、復原還原），不認得的 kind 原樣保留不畫。填色 `InkShape.fill?: "none" | "solid"`，半透明 `INK_SHAPE_FILL_ALPHA`（0.25），外框不透明；
  還不能選取已畫好的形狀再改填色。
- 引擎依手指是否捲動把互動元素的 `touch-action` 設成 `pan-x pan-y` 或 `none`，並設 `-webkit-touch-callout: none`、擋 `selectstart`；白板的 `.canvas-ink-capture`（`CanvasInkLayer.css`）也是 `touch-action: none`。Scribble 是否仍吞事件未實測。
- 插入圖片／相機：`InkToolbar` 的 `insert`，只有手寫頁與白板傳，PDF 不傳（`page-images.guard.test.ts`）；上傳只有 `hooks/useImageUpload.ts` → `uploadMedia` 一條路。
  白板的插入重用拖放圖片的 `dropImagesAsCards`。

## 手寫與 PDF：頁面本子與存法

- **一種頁面。** PDF 筆記與手寫筆記都是 `pagebook/PageBook`：它只認頁面信封 `InkPages`（`@onden/markdown/ink`，`inkPages.ts`），背景是 `(page) => ReactNode` 插槽，不認得 PDF；
  不要在頁面元件寫死「是不是 PDF」。頁 key：`pdf:<n>`（舊 PDF 筆記）、頁面清單（`note_pages`）裡 PDF 段的頁 `<段的前綴>:<n>`、手寫第一頁 `page`、其餘空白頁用 uuid（只由 `@onden/markdown/note-pages` 的 `mintPageId` 產生，不重複使用）、投影片保留 `slide:<id>`（尚未畫）。頁寬固定 1000 單位，筆跡與縮放無關。
- **鏡頭**：一個原生捲動容器；縮放是頁的 CSS 寬度（`PAGE_ZOOM_MIN`–`PAGE_ZOOM_MAX`＝0.5–4）；兩指縮放用 `touchSplit` 預覽，甩動用 `lib/ink/glide.ts`。
  每頁一個引擎，只有畫面附近的頁才有（`PageInkSurface`），其他頁畫 `PageInkSvg`；引擎收掉前先把內容交回 `InkPageSession`（`lib/ink/pageSession.ts`）。
  `tool` 為 `null` 時不掛 `PageInkSurface`（PDF 的選取與文字工具、唯讀手寫），讓文字層收得到指標。頁是固定高度的紙，不會因筆跡往下長。
- **PDF 只有一條工具列**（共用 `InkToolbar`，PDF 以 `leadingTools`／`trailingTools` 加「選取」「文字」與 `PageMoreMenu`）；`PdfNodeView` 的 `selectTool` 是唯一換工具入口，離開繪圖工具前先 `commitDrawSession()`；
  Esc 回選取並保留已畫的；復原／重做：文字工具作用在文字框，手形在文字框有步驟時也是，其他工具作用在筆跡。
  清除全部標註先經 `confirmDialog`。「放大畫面」是共用的 `ExpandPaneButton`＋`useExpandedPane`。
- **存法有兩種格式，PDF 雙寫。** PDF 的 `ink_data` 信封多 `units`（`InkPages`）與 `unitsFrom`（寫 `units` 時舊欄位的指紋），舊欄位 `pages[n]`＋`drawing`／`shape` 記錄仍由 `units` 產生，讓舊版前端照樣讀寫。
  讀：`units` 與舊欄位指紋相符才信 `units`，否則從舊欄位轉（`pagesFromLegacy`，純函式，不寫 migration）。
  **寫舊格式的唯一入口是 `lib/pdf/pageUnits.ts` 的 `setPdfPageDoc`**（`guards/ink.guard.test.ts` 鎖住）；停寫舊格式要先問業主。
  手寫筆記的 `ink_data` 本身就是第一頁，其餘頁在 `morePages`（`notePages`／`noteDoc`），不另存第二份；沒有 `toolId` 的舊筆跡讀成 `toolId: "uniform"`（等寬）。
  不需要 `requires`：舊前端原樣保留 `units`／`unitsFrom`，`mergeEnvelope` 只在三方都相符時才重算 `unitsFrom`。
  例外是頁面清單的本子（`note_pages`，2026-11-17）：第一頁可能是 PDF 的頁，沒有自己的 `page`，`noteDoc` 存一張空的載體頁並在 `morePages` 標 `carrier`
  （`inkPageOrder` 不把它當一頁），同時寫 `requires: ["note-pages"]`（`INK_KNOWN_FEATURES` 從這版起認得），所以舊前端只能唯讀開啟，不會把載體頁存成真的一頁。
- **三個屬性、一種視角一份筆跡**：`ink_data`（內容是手寫頁或 PDF）、`board_ink`（白板筆層）、`note_ink`（手寫分頁）；鍵的清單 `INK_PAGE_ATTRS` 在 `@onden/markdown` 的 `sharedContract.ts`，前後端都從那裡來，
  同一個 codec、`saveInk(nodeId, doc, base, { attr })`、同一條 `PUT /attributes/:key` 合併與離線佇列。
- **離開頁面不掉筆跡**：`pagehide`／分頁隱藏時 PDF（`commitDrawSession`）與 `InkNodeView` 立刻以 `keepalive` 存出還沒存的筆跡。
- **存檔基底**（`lib/ink/surfaceSaver.ts` 的 `InkSaver`，手寫、PDF、白板共用）：伺服器回合併值時，下一次存檔先在本機 `mergeInk` 合併再以伺服器文字為基底送 patch，
  不能直接拿伺服器的回答當基底（引擎還看不到別台的筆，下一次存檔會把它們刪掉）；前一次被拒絕的存檔之後的存檔，等沒有存檔在途時用伺服器現值當基底重存；
  從歷史還原後 `announceDrawingRestored(nodeId)`，開著的筆層重新載入。

## 手寫存檔量

量測在 [pdf-ink-save-measure-2026-11-15.md](../research/pdf-ink-save-measure-2026-11-15.md)。

- **上傳**：`makePatch`（`packages/markdown/src/textPatch.ts`）沒有行錨點時改以物件邊界當錨點切多個 hunk，一筆只送一筆。只有用戶端做 patch，舊用戶端與協定版本不受影響。
  整份請求超過上限時先讀伺服器現值、本機合併再送 patch（`lib/data/rebasedPatch.ts` 的 `rebasedOnStored`）。
- **儲存**：超過 `INK_CHUNK_THRESHOLD`（192 K 字）的墨水值依內容切成約 8 KB 區塊，存在該筆記自己的 `ink_chunks`，`ink_manifests` 記每次存檔的區塊清單（`services/inkChunks.ts`，migration 203）。
  事件的 `value_ref` 仍是整份值的 sha256；讀取點（`readInkValues`／`readInkValue`）兩種格式都讀。區塊只屬於一則筆記，永久刪除時 `ON DELETE CASCADE` 一併帶走。
- **清理**：沒有任何事件還指到的清單與區塊，由 `services/maintenance/prune.ts` 的 `collectOrphanBlobs` 清掉；事件仍指到的歷史版本不精簡（刪資料要業主同意）。值本身沒有大小上限（只有 nginx 的 20 MB）。
- **備份**帶當前的整份值（`node_attributes`），不帶區塊與清單、也沒有墨水的版本歷史（`backupInventory` 把 `ink_chunks`／`ink_manifests` 列為「不在備份」）；還原後該筆記第一次存檔就是它自己的區塊。
  世界產生器 `packages/backend/src/test/helpers/roundTripArb.ts` 的 `bigInk` 讓部分筆記帶超過門檻的 `ink_data`，
  `packages/backend/src/test/properties/{backupRoundTrip,backupHostHop,backupRestoreRerun}.property.test.ts` 都開著它；
  還原演練 `packages/backend/scripts/drillInvariants.ts` 檢查區塊與清單列數不減、事件指到的墨水版本都讀得到；瀏覽器版用 `e2e/browser-app/bigInk.mjs`。

## 頁面文字框與圖片層

- 文字框（`page_text`）與圖片（`page_images`）是**核心書寫層**，各是獨立屬性、不放進 `ink_data`；格式與合併在 `@onden/markdown/page-text`、`page-images`（頁面單位、同一套 `pageKey`）。`v` 大於 1 只讀，未知欄位原樣保留。
- 元件 `components/page/TextBoxLayer.tsx`、`PageImageLayer.tsx`；狀態與存檔時機在 `lib/pageText/controller.ts`、`lib/pageImages/controller.ts`，共用骨架 `lib/pageLayer/store.ts`（文件、復原堆疊、選取、與上次不同才存並帶 base）與 `useLayerController`。
- 後端合併走 `attributeWrites` 的 `PAGE_LAYERS` 表（依 id 三方合併；兩邊都改→後存的為準並記成 `ATTRIBUTE_CONFLICT`，欄位 `page_text_conflicts`／`page_images_conflicts`；一邊刪一邊改→保留修改）。
  一次儲存是一筆 `ATTRIBUTE_SET`，不開新事件類型或路由。輸入法組字中不存、不動作。
- 圖片的 `src` 只認 `/api/media/<id>`，其他位址讀取時丟掉；圖片本體在墨水下面（`part="art"`），控制在墨水上面（`part="controls"`）且只在手形工具時出現。
- **復原目標只有一處**（`lib/pageImages/undoTarget.ts`，按鈕與 ⌘Z 共用）：選著圖片且圖片層有步驟→圖片層；文字工具→文字框；手形→文字框有步驟給文字框，否則圖片層有步驟給圖片層，否則筆跡；其他工具一律筆跡。
- 手寫分頁（`HandwritingPane`）目前沒有文字框與圖片層（`page_text`／`page_images` 的頁 key 會與手寫筆記的 `page` 互撞），所以沒有文字層時 `InkNodeView` 不顯示「文字」工具。

## 手寫頁的引用一塊區域

- 單位是一塊矩形區域，不是一組筆畫：筆畫留在原頁，之後補寫的也會出現。語法 `![[筆記|ink=頁@x,y,w,h]]`，解析與序列化在 `@onden/markdown` 的 `inkRegion.ts`
  （前端、後端發布、網站共用）；頁用 page key，座標是頁內單位的整數，最小邊 `INK_REGION_MIN`（24）。標題不能當名字時改用 `onden://node/<id>`（`titleNamesNote`，與解析同一個規則）。
- 畫區域與畫整張圖共用 `@onden/markdown` `inkSvg.ts` 的 `drawDocument(ink, within?)`；app 內只用讀得到的筆記解析，讀不到＝「找不到」，不露筆畫。
- 發布時 `drawingEmbeds.ts` 只在已發布筆記嵌入已發布筆記時凍結成圖（`drawing_regions`）；未發布的由 `redaction.ts` 變 label 或「(private)」，區域參數不當成 label。
  純文字讀法（摘要、搜尋片段、反向連結前後文、閱讀時間、AI 面板）一律不顯示區域參數（`splitWikilink`、`blankInkRegionSyntax`）。
- 本機存檔與別台同步來的變化（`announceDrawingChangesOf`）都讓區域嵌入重畫；同一來源被引用多次共用一次讀取（`drawingChangeSerial`）。手寫頁工具列的「引用」是 `QUOTE_TOOL`。

## 任何筆記都能開「手寫」分頁

- 筆跡存在這則筆記自己的 `note_ink`（`NOTE_INK_ATTR`），格式就是手寫筆記的頁面信封；不用 `ink_data`，因為 `OverviewEditor` 看到 `ink_data` 會把「內容」分頁換成手寫頁。
- 分頁是 `function_refs` 的一列，layout `"handwriting"`（`HANDWRITING_LAYOUT`），不需要 migration。後端 `modules/handwriting`（`noteViewLayout: true`），前端 `modules/handwriting` 的 `noteView`；
  handwriting 仍是內建模組（筆的設定頁在設定›功能›手寫），`NOTE_VIEW_MODULES` 把內建模組與 library 模組合成同一個清單。每則筆記最多一個，已有就開啟它（`useAddView` 的 `firstTabOf`）。
- **刪分頁不刪筆畫**：`deleteNoteView` 只移除那一列，筆畫是另一個屬性，再加回分頁就看得到。內容已是手寫頁（`ink_data`）或 PDF（`pdf_url`）的筆記，「＋」不列「手寫」（`useHasPageSurface`）。
- 畫面與 `OverviewEditor` 共用 `InkNodeView` 與 `useInkSurfaceSaver(attr)`；沒有編輯權限的成員看得到分頁，顯示唯讀提示。`getNode` 的屬性不含筆跡屬性（`isInkPageAttr`），也不含 `note_pages`／`pdf_text` 的原值（`pdf_text` 只給有文字的頁數）。
- **頁面清單（`note_pages`，2026-11-17，[提案](../architecture/proposals/pdf-pages-in-note-2026-11-16.md) 第 1 步）**：筆記有 `note_pages`（空白頁與 PDF 檔的頁段，`@onden/markdown/note-pages`）時，
  `HandwritingPane` 改載 `NotePagesBook`（延後載入，一般手寫分頁不載 pdf.js），畫面仍是同一個 `InkNodeView`。筆畫仍在 `note_ink`，以頁 key 為鍵。
  清單由伺服器以 `mergeNotePages` 合併（`MERGED_KEYS`）；比這版新的清單不能寫（409 `pages_version`）。沒有 `note_pages` 的筆記與以前完全相同；
  **目前沒有建立這種筆記的入口，也沒有 migration**（那是提案的第 2 步以後）。
  同步、歷史（`inkEventSql(…, "note")`）、備份、複製筆記都跟著屬性走；匯出只在筆記還有手寫分頁時把 `note_ink` 接在內容後面成為 SVG。
