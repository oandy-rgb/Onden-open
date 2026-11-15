# 深模組審查：手寫、PDF、媒體（2026-10-27）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：PR #679 #756 #760 #765 #769 #789 #800 #804 #809。只讀程式碼，不讀文件；判斷依據是 main 目前的程式。
路徑皆在 `packages/frontend/src/` 之下，除非標明 backend。

## 一句話結論

**大致算深模組。** 手寫的核心（`InkEngine`）確實是「一個模組、三個呼叫端」：手寫筆記、白板、PDF 共用同一個引擎、同一個 `InkToolbar`、同一套筆壓與橡皮擦；筆的快捷鍵與懸停預覽也被收在 `lib/ink/` 裡，元件只拿到一個 `onPenShortcut` 回呼，沒有裝置判斷外洩。
弱點在邊緣：PDF 的甩動／縮放手勢膠水還留在 614 行的 `PdfNodeView` 裡、`lib/ink` 與 `lib/pdf` 互相引用、一組重複的轉換函式、CardNode 重做了一份播放器包裝。媒體三塊（淡出、Range、插入檔案）各只有一處實作，上傳全走 `lib/data`。

## 判定表

| PR／組 | 新模組入口檔 | 介面大小 | 深度 | 整合度 | 判定 |
|---|---|---|---|---|---|
| #760 #765 #809（筆快捷、Apple Pencil、懸停） | `lib/ink/penShortcut.ts`、`penHover.ts`、`usePenShortcutTool.ts`、`lib/penShortcutBridge.ts` | 對元件只露 1 個 hook（`usePenShortcutTool`）＋引擎 1 個回呼 `onPenShortcut`；內部狀態機 5 個事件方法 | 4 | 5 | 算 |
| #789 #804（PDF 手寫與工具列） | `lib/pdf/drawingEdit.ts`、`lib/pdf/drawSession.ts`、`components/pdf/PdfCaptureSurfaces.tsx` | `lib/pdf/index.ts` 匯出 4 個函式；PDF 工具列不是新檔，直接用既有 `InkToolbar` | 3 | 4 | 部分算 |
| #800（慣性甩動、全螢幕） | `lib/ink/glide.ts`、`hooks/useFullscreenContainer.ts` | `startGlide` 1 個函式；`useFullscreenContainer` 1 個 hook，4 個回傳值 | 3 | 3 | 部分算 |
| #756（Range 回應、播放器不重掛） | backend `services/mediaRange.ts`；`MarkdownRenderer.tsx` 的 `MdVideo`／`MdAudio` | 1 個純函式 `parseMediaRange`，回傳 3 種結果 | 4 | 5 | 算 |
| #769（媒體淡出） | `lib/mediaFadeOut.ts`、`hooks/useFadeOutOnUnmount.ts` | 1 函式＋1 hook | 4 | 4 | 算（有一處小重複） |
| #679（插入檔案入口） | `lib/mediaInsert.ts`；沿用 `lib/data/media.ts` 的 `uploadMedia` | 2 個匯出（`INSERT_MEDIA_ACCEPT`、`isInsertableMedia`） | 2 | 4 | 部分算 |

整體：**算深模組（有小瑕疵）**。

## 問題清單（依嚴重度）

### 1. PDF 的手勢／甩動／縮放膠水留在 `PdfNodeView`，沒有自成小模組（中）
- 現況：問題要問的「PDF 慣性甩動與全螢幕是不是自成小模組」——答案是**一半**。`startGlide` 確實是獨立、純的小函式，手寫頁（`lib/ink/pageCamera.ts:86`）與 PDF（`components/PdfNodeView.tsx:384`）共用，這是好事。但「怎麼捲動 PDF 容器、何時停甩動、捏合延遲套用」整套（`glideStopRef`、`scrollBy`、`pinch`、`PINCH_SETTLE_MS`）直接寫在 `PdfNodeView.tsx:360-400` 的 `useMemo` 裡，而手寫頁把同樣責任放在 `InkPageCamera` 類別。結果 PDF 的「相機」沒有名字、不能單獨測，`PdfNodeView.tsx` 共 614 行。
- 影響：下次調整甩動手感，要改兩處（`pageCamera` 與 `PdfNodeView`）；`PdfNodeView` 的 useMemo 依賴陣列（`:551`）長達 16 項，是「小改動牽動很多入口」的警訊。
- 建議：把 `PdfNodeView.tsx:360-400` 抽成 `lib/pdf/scrollCamera.ts`（回傳 `InkGestureHost`），和 `InkPageCamera` 並列。
- `useFullscreenContainer.ts` 本身很小（42 行）且正確；`ui/Popover.tsx:36-43` 的 `surfaceHost()` 把「全螢幕時選單要掛在全螢幕元素裡」藏在元件庫內，呼叫端不必知道。**但** `ui/Modal.tsx:145` 仍是 `createPortal(dialog, document.body)`，在 PDF 全螢幕裡開 Modal（例如 `PdfNodeView` 的 `confirmDialog`，`:21` 匯入）會被全螢幕元素蓋住——**推測**（未在瀏覽器驗證）。

### 2. `lib/ink` ↔ `lib/pdf` 雙向依賴（中）
- 現況：`lib/ink/pdfAdapter.ts:18` 引用 `../pdf/coords`；`lib/pdf/drawingEdit.ts:24-35` 引用 `../ink`（index）。`eslint-rules/module-entry-allowlist.json:41-45`、`:14` 等多筆例外（`PdfNodeView` 有 7 條深層引用，`lib/ink/pdfAdapter` 與 `lib/ink/store` 都列了 `lib/pdf/coords`）把這個環記成「已知例外」。
- 證據：#789 沒有新增 allowlist 條目（`git diff 40f9a82^1 40f9a82` 對 eslint-rules 為空），但也沒有解開。
- 影響：想改 PDF 座標型別會牽動 ink 引擎的型別；PDF 不是「引擎的一個宿主」而是和引擎互相知道。
- 建議：把 `PdfHighlightRecord`／`PdfDrawingStroke` 這類 PDF 儲存型別下沉到引擎也能引用的中立位置，或把 `pdfAdapter.ts` 整個移到 `lib/pdf/`，環就消失。

### 3. 重複實作：「引擎 stroke → 儲存 stroke」轉換有兩份（低～中）
- 現況：`lib/ink/pdfAdapter.ts:49`（`inkToDrawingStrokes`）與 `lib/pdf/drawingEdit.ts:93`（`inkDocToDrawingStrokes`）做同一件事，差別只在後者一律寫入 `toolId`、前者只在 highlighter 時寫。
- 證據：全 repo 的非測試程式裡，`inkToDrawingStrokes` **0 個呼叫端**，只有 `test/pdfInkAdapter.test.ts:8,27` 在用；`inkDocToDrawingStrokes` 在 `drawingEdit.ts:180` 被用。#789 新增了後者卻沒刪前者。
- 影響：兩份行為不同（toolId 規則），測試守的是沒人用的那份。
- 建議：刪 `inkToDrawingStrokes` 與其測試，測試改指向 `inkDocToDrawingStrokes`。

### 4. 插入檔案：上傳只有一處，但「插入」有三條小路（低）
- 好的部分：全 repo 的 `uploadMedia` 呼叫端 7 個（`OverviewEditor.tsx:435,463`、`QuickCapture.tsx:399`、`MediaFieldEditor.tsx:39`、`useNodeCreation.ts:186`、`useCanvasActions.ts:334`、`SiteImageField.tsx:36`），全部經 `lib/data`；`new FormData` 只出現在 `lib/data/media.ts:27`；沒有人繞過。型別檢查（不認得的副檔名拒絕）也集中在 `lib/data/media.ts`。
- 問題：「選檔 → 上傳 → 把 markdown 放進文字」有三份相似流程：`MarkdownEditor.tsx:425`（`insertMediaAtCaret`，貼上／桌面按鈕／手機工具列用）、`:752-756`（斜線選單，用固定位置 `next.at`）、`:1077`（拖放，自己呼叫 `onMediaInsertRef`）。三者都各自處理 `stillOn`（換筆記保護）。
- 另：`lib/mediaInsert.ts:13` 的 `isInsertableMedia` 在正式程式碼中 **0 個呼叫端**，只有 `test/mediaInsert.test.ts:3` 使用——這是為測試而存在的匯出。`mediaInsert.ts` 整檔只剩一個常數，介面淺。
- 貼上只接受 `image/`（`MarkdownEditor.tsx:1030`），但斜線與按鈕都接受音訊影片——規則不一致（**推測**為有意，但沒有註解說明）。
- 建議：把 `insertMediaAtCaret` 改成接受可選位置 `at?`，斜線與拖放都呼叫它；刪掉 `isInsertableMedia` 或真的用在貼上／拖放的過濾。

### 5. `CardNode` 重做了一份播放器包裝（低）
- 現況：`components/CardNode.tsx:58-63` 的 `FadingMedia` 與 `components/MarkdownRenderer.tsx:335-344` 的 `MdVideo`／`MdAudio` 都是「`span.md-media-wrap` + ref + `useFadeOutOnUnmount`」。
- 另有型別逃逸：`CardNode.tsx:62` 的 `ref={ref as never}`（#769 新增）。
- 淡出的核心 `fadeOutDetached` 只有一份，且三個入口（`MarkdownRenderer` 兩處、`CardNode`、`lib/embedDom.ts:158` 的命令式卸載）都走它，這部分沒有重複。重複的只是 JSX 外殼。
- 建議：匯出 `MarkdownRenderer` 的 `MdVideo`／`MdAudio` 或做一個共用 `<MediaPlayer kind src />`，CardNode 重用，去掉 `as never`。

### 6. 小重複：「這台裝置有觸控」判斷兩份（低）
- `hooks/useInkInputPrefs.ts:8-10`（`hasTouch`）與 `lib/ink/pageCamera.ts:247`（`touchDevice`）都是 `navigator.maxTouchPoints > 0`。是引擎內部判斷，不是元件外洩，但可合併成 `lib/ink/` 的一個小函式。

### 7. 三個宿主各自重複同一段 `penShortcutRef` 接線（低）
- `components/InkNodeView.tsx:145-146`、`components/CanvasInkLayer.tsx:89-90`、`components/PdfNodeView.tsx:345-347` 都是 `const ref = useRef(() => {}); ref.current = usePenShortcutTool(...)`，再傳 `onPenShortcut: () => ref.current()`。3 個呼叫端 3 份相同的 2～3 行。
- 影響很小，但說明 `usePenShortcutTool` 的「穩定回呼」責任沒有完全藏好（引擎只接受建構時的回呼，宿主得自己包 ref）。建議讓 `InkEngine` 提供 `setOptions({ onPenShortcut })`，或 hook 直接回傳穩定函式（目前回傳的函式身分是否穩定未驗證）。

### 8. 測試覆蓋：快捷鍵的宿主接線只測了 1 個宿主（低）
- `test/inkPenShortcutHosts.test.tsx:14-55` 測了 hook 與 `InkNodeView`；`CanvasInkLayer` 與 `PdfNodeView` 沒有對應的快捷鍵測試（`test/PdfInkTools.test.tsx` 沒有 pen-shortcut 相關字樣）。狀態機本身（`inkPenShortcut.test.ts`、`inkPenDevices.test.ts`）有完整測試。
- lint 層面：沒有規則禁止元件直接聽 `pointerType`。目前元件層的確沒有（`PdfNodeView`／`InkNodeView`／`CanvasInkLayer` grep `pointerType` 為 0），是靠慣例守住，不是靠規則。

### 新加的例外／eslint-disable
- 九個 PR **沒有**新增任何 `eslint-disable`，也沒有改 `eslint-rules/`（逐 PR 檢查 diff）。
- 新增 `as never`：正式程式碼 1 處（`CardNode.tsx:62`）；測試 7 處（`InkToolbar.test.tsx`、`PdfInkTools.test.tsx` 等，可接受）。

## 做得好、值得保留

- **PDF 手寫沒有複製引擎。** `components/pdf/PdfCaptureSurfaces.tsx` 的 `PdfPageDrawSurface` 直接 `new InkEngine(...)`（`:68` 附近）並呼叫 `engine.addPointerHandlers(host)`，與手寫筆記、白板同一條 pointer 流程、`InkInputPolicy`（`lib/ink/inputPolicy.ts`）、橡皮擦（`erase.ts`）、懸停預覽。PDF 的唯一差異是 `transform` 與 `manageCanvasSize: false`。
- **工具列 1 個元件 3 個呼叫端。** `components/InkToolbar.tsx`（`CanvasInkLayer.tsx:335`、`InkNodeView.tsx:193`、`PdfNodeView.tsx:558`）；PDF 的差異只透過 `leadingTools`／`trailingTools`／`trailing` 三個插槽進入，沒有分叉。
- **筆壓與外形只有一份。** 手寫、PDF 靜態繪製（`components/pdf/PdfHighlights.tsx:21-23,247`）、發佈站都用 `@onden/markdown` 的 `strokeOutline`／`outlineToPath`（#789 只是把 `outlineToPath` 匯出，`packages/markdown/src/inkSvg.ts`），沒有第二套。
- **裝置判斷完全在 `lib/ink/` 內。** S Pen 側鍵（`penShortcut.ts` 的 `PenShortcutDetector`，純狀態機、無 DOM）、Apple Pencil（`penShortcutBridge.ts` 單一事件入口，原生外殼呼叫 `window.ondenPenShortcut`）、懸停（`penHover.ts`）都是「不分裝置的輸入模組」：引擎收事件（`engine.ts:378-411`），宿主只收到「請切換筆↔橡皮擦」。元件層沒有 `pointerType`／userAgent 判斷（grep 0 筆）。
- **Range 回應只有一處。** 全 backend 只有 `routes/media.ts` 用 `createReadStream`／`Accept-Ranges`（`:106-138`），解析在純函式 `services/mediaRange.ts`，有獨立測試 `test/mediaRange.test.ts`（121 行）。
- **播放器不重掛的根因修在結構。** #756 把 `MdVideo`／`MdAudio` 移到模組層級（`MarkdownRenderer.tsx:329-344`，註解寫明原因），測試 `mediaRemount.test.tsx` 守住，而不是在每個呼叫點補 key。
- **全螢幕 + 選單。** 把「全螢幕時浮層要掛進全螢幕元素」放進 `ui/Popover.tsx` 的 `surfaceHost()`，所有 Popover／Menu 使用者（含 PDF）自動受益，沒有在 PDF 裡特例處理。
- 新行為都有對應測試檔：`inkPenShortcut`、`inkPenDevices`、`PdfInkTools`、`pdfInkEdit`、`mediaFadeOut`、`cardNodeMediaFade`、`mediaRemount`、`mediaRange`、`mediaInsert`。

## 不確定、需要人確認的點

1. **PDF 全螢幕內的 Modal**（問題 1 末）：`ui/Modal.tsx` 掛在 `document.body`，我沒在瀏覽器驗證是否被全螢幕元素蓋住；請在平板實測。
2. **`PdfPageShapeSurface`**（`PdfCaptureSurfaces.tsx:~120-200`）用 React 的 `onPointerDown/Move/Up` 自己處理指標，沒有經過 `InkInputPolicy`（手掌拒絕、觸控筆模式）。形狀工具是否本來就該有不同的輸入規則？**推測**是有意（形狀不是筆跡），但「觸控筆模式：手指只捲動」開啟時，手指畫形狀是否仍會觸發，我沒驗證。
3. **S Pen 側鍵的訊號 A／B／C**（`penShortcut.ts` 檔頭註解）靠實機量測（Galaxy Tab S9），iPad 路徑標明「untested on a device」；我只能審結構，無法判斷實機正確性。
4. **與上次審查重構 PR（#694 #698 #699 #704 #706 #712）的衝突**：我沒看到這批程式與它們直接衝突。但若其中有 PR 動到 `lib/ink` 對外 index、`MarkdownRenderer.tsx` 的 `components` 對照表、或 `OverviewEditor`／`MarkdownEditor` 的媒體上傳流程，合併時會碰到 #756/#769/#679 改過的區域；我無法從 main 上判斷這些 PR 的內容，**推測**風險低到中。
5. **`usePenShortcutTool` 回傳的函式身分是否穩定**（問題 7）：看 `usePenShortcutTool.ts` 的 `useCallback([], ...)` 應該穩定，但宿主仍包了一層 ref，原因我沒查到。
