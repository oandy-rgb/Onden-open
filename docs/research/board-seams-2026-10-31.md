# 白板兩層之間的接縫（2026-10-31）

> 狀態：歷史紀錄（寫於 2026-10-31）

白板是兩層：卡片層（`@xyflow/react`，`components/KnowledgeWorkspace.tsx`）與手寫層（`lib/ink/`，由 `components/CanvasInkLayer.tsx` 疊上去，座標靠 `lib/ink/flowTransform.ts`）。
本文記錄查證結果（行號是改動**前**的 `origin/main`）、這批做了什麼、以及留給擁有者決定的事。
「已實作」「已測試」「建議」分開寫。

## A. 查證

### A1. 兩套復原（已確認；本批已收斂）

| 事實 | 位置 |
| --- | --- |
| 卡片移動走 `useCanvasUndo`，筆模式下它自己放棄處理 ⌘Z | `hooks/useCanvasUndo.ts:156`（`if (penActiveRef.current) return`） |
| 手寫的 ⌘Z 只在筆模式內作用，叫引擎自己的堆疊 | `components/CanvasInkLayer.tsx:299-310`、`lib/ink/model.ts:55` |
| 工具列的復原鈕在筆模式下對卡片移動關閉 | `components/KnowledgeWorkspace.tsx:744` |
| 兩指／三指輕點也只動引擎堆疊 | `lib/ink/engine.ts:589-594` |
| 移除卡片（Delete）、畫箭頭、刪箭頭完全不在 ⌘Z 裡（移除只有 toast 的「復原」） | `KnowledgeWorkspace.tsx:546-562`、`hooks/useBoardWorkspace.ts` 的 `onConnect`／`onEdgeDeleted` |

驗證方式：讀程式路徑；`test/useCanvasUndo.test.tsx` 原本有一則「筆模式下 ⌘Z 留給手寫層」的測試，直接證明這個分岔。

### A2. 選取能不能跨層（不能；本批已補）

- 引擎沒有選取工具：`InkActiveTool` 只有筆、橡皮擦、手、形狀（`lib/ink/types.ts:24`），模型也沒有「移動」操作（`lib/ink/model.ts` 的 `InkOp` 只有 add／addShape／snap／erase）。
- 框選是 React Flow 的 `selectionOnDrag`（`KnowledgeWorkspace.tsx:857`），只選卡片與群組。
- 移動卡片只寫卡片位置（`handleNodeDragStop`，`KnowledgeWorkspace.tsx:491`），不碰筆畫。所以畫在卡片上或旁邊的筆畫**不會跟著走**（筆畫存在白板節點的 `ink_data`，座標是白板座標）。
- Delete 只移除卡片（`boardKeyDown`，`KnowledgeWorkspace.tsx:563`）；筆畫只能用橡皮擦。

### A3. 流程圖的方框會不會多出筆記

- **卡片方框：每個都是一則筆記。** 雙擊空白處走 `createCardAt`，它呼叫 `createNodeRaw(…"markdown"…)` 建立筆記後才放上白板（`hooks/useBoardWorkspace.ts:191-199`）。畫 20 個方框的流程圖，筆記樹就多 20 則「新筆記」。
- **手寫方框：不會建立筆記。** 形狀工具只呼叫 `model.addShape`（`lib/ink/engine.ts:822`），存進白板的 `ink_data`。
- **手寫的箭頭存在，但不是連線。** 與任務說明不同：`inkShapes` 有 `arrow` 種類（`packages/markdown/src/inkShapes.ts:33`），可以畫出箭頭；只是它只是圖形，不連到任何卡片。xyflow 的 `onConnect`（`KnowledgeWorkspace.tsx:445`）則只連卡片，建立一條 `knowledge_link` 關聯。兩者互不相通：手寫方框接不上連線，連線也看不到手寫方框。

### A4. 其他「兩層各一份」的東西

| 項目 | 卡片層 | 手寫層 | 狀態 |
| --- | --- | --- | --- |
| 復原 | `useCanvasUndo` | 引擎堆疊 | **本批合一**（B） |
| 選取／框選 | xyflow | 無 | **本批補上**（C） |
| 刪除 | `removeSelectedCards`（`:546`） | 橡皮擦 | 本批：框選到的筆畫可用 Delete 一起刪 |
| 對齊 | `lib/canvasAlignment.ts:19` 只收 `type === "card"` | 無 | **未做**：筆畫不參與對齊，也沒有另寫第二套；若要，應擴充 `canvasAlignment.ts`（需要給它筆畫的外框） |
| 吸附 | xyflow `snapToGrid`（`:862`） | 無 | **未做**：移動筆畫不吸附格線 |
| 縮放／平移 | xyflow viewport | 引擎透過 `reactFlow.setViewport` 改同一個 viewport（`CanvasInkLayer.tsx:277-295` 的滾輪、`gestures.zoom/pan`） | 已是單一來源，不重複 |
| 鍵盤快捷鍵 | `useCanvasTools`（`:49`）、`boardKeyDown`（`:563`） | 筆／橡皮擦鍵在 `useApplyPen` | 各管各的鍵，沒有衝突；Delete 與 ⌘Z 現在同時照顧兩層 |
| 複製貼上 | 白板沒有卡片複製貼上 | 無 | 兩層都沒有，沒有重複 |
| 匯出 | JSON Canvas 匯出只含卡片與關聯（`lib/canvasExport.ts:11` 明說不含筆跡） | `ink_data` | 匯出不含筆畫（既有限制，沒動） |
| 小地圖 | 只畫卡片 | 不畫筆畫 | 既有限制，沒動 |

## B. 收斂成一條復原（已實作、已測試）

### 設計比較

1. **一個 board history，兩層各自登記可復原的動作**（採用）。`hooks/useBoardHistory.ts` 擁有堆疊、忙碌鎖、⌘Z／⌘⇧Z 與「一個手勢同時動兩層合成一步」（`batch`）。卡片層用 `useCanvasUndo` 登記位置項目；手寫層經 `lib/ink/boardHistory.ts` 在引擎每個新編輯時登記一項，退回時叫引擎退自己的那一步。
2. **引擎的 undo 只留給筆記的手寫頁，白板一律走 board history**。要把白板上的手寫編輯改成「可被外部撤銷的增量」：每種操作都得有逆操作的描述與衝突處理，等於重寫引擎的 undo，還會讓白板與手寫頁兩份 undo 並存。

選 1 的原因：引擎本來就有每步的前後狀態（add／erase／snap），不需要重寫；白板只多一個回呼 `onRecord`，手寫頁（`InkNodeView`、PDF）完全不受影響（沒提供回呼就沿用引擎自己的堆疊）。

### 行為

- ⌘Z／⌘⇧Z 不分模式，照時間順序退回／重做：卡片移動、對齊、整理、移除卡片、連線、刪連線、筆畫、形狀、橡皮擦、筆畫的移動／刪除。
- 兩指／三指輕點、工具列的復原鈕也走同一條。
- 「停住不動的筆畫變成形狀」維持原本兩步（先形狀、再筆畫）。
- 移除卡片的 toast「復原」與 ⌘Z 共用同一個狀態，只有其中之一會把卡片放回去，不會放兩次。
- 卡片位置復原維持原有規則：之後被移動過的卡片保留較新的位置。
- 跨工作階段的復原沿用事件紀錄，沒有新增。

### 限制

- 只有「純連線」（`knowledge_link`）的畫與刪進紀錄；父子線（改上層）、換類型、標籤線不進。
- 紀錄只在這次開著這張白板時有效（上限 50 步、換白板即清空），與原本卡片移動一樣。
- 引擎的堆疊在筆跡重新載入（例如另一台裝置同步進來整份取代）時會清空，紀錄裡對應的筆畫項目這時會「無事可做」而被丟棄，不會誤動別的東西。

## C. 跨層選取（已實作、已測試引擎與紀錄；畫面互動未用瀏覽器驗證）

- 白板上拖曳框選時，除了卡片，也選到有「看得見的點」落在框內的筆畫與形狀（沿用橡皮擦的「被擦掉的區段不算」規則，`lib/ink/select.ts` 用 `visibleRuns` 與 `shapeStrokes`；沒有另寫命中判斷）。
- 選到的筆畫外面有虛線框。
- 拖動選取中的卡片，筆畫跟著走，卡片位置與筆畫位置**合成一步**復原。
- 只選到筆畫時，拖動虛線框即可移動筆畫。
- Delete：卡片與筆畫一起移除，一步復原；只選到筆畫時只刪筆畫。
- 筆畫的移動是引擎新增的操作（`InkOp` 的 `move`），形狀移動的是起點與終點。筆畫 id 不變，所以存到伺服器時沿用既有的逐 id 合併。
- 邊界：點到空白處、點未跟筆畫一起選到的卡片、切換筆模式都會取消筆畫選取。

## D. 形狀和卡片的規則（只寫選項，不實作，請擁有者決定）

**做法一：畫出來的方框可以一鍵「變成卡片」，變了才能連線。**
- 好處：筆記樹只會多出使用者**決定要留**的筆記；手寫的草圖保持輕量；連線規則（只連卡片）不變。
- 代價：要新增「形狀 → 卡片」的轉換：建立筆記、在原位放卡片、移除原形狀，這三步要成一個可復原的操作；形狀的文字（現在沒有）要不要變成標題也要定。

**做法二：流程圖方框是不建立筆記的文字框。**
- 好處：畫流程圖不污染筆記樹。
- 代價：要新增第三種白板物件（文字框）：能連線、能對齊、能被框選、要存、要匯出、要在小地圖出現；等於再造一套「像卡片但不是筆記」的東西，與「同一件事只准一個入口」的方向相反。

**建議：做法一。** 它沿用現有「卡片＝筆記」的唯一模型，只多一個轉換入口；做法二會讓白板上有兩種「方框」，之後每個功能（對齊、搜尋、匯出）都得決定要不要管第二種。

## 驗證

- `test/boardHistory.test.tsx`：用真的 `InkEngine` 與 `useCanvasUndo`：畫一筆→移動卡片→⌘Z 兩次兩個都退回（順序正確）並可重做；輕點復原走同一條；跨層框選後移動、刪除再復原一步退回；形狀停住轉換登記兩步。
- `test/useCanvasUndo.test.tsx`：原有 20 則維持；「筆模式留給手寫層」改成「筆模式內也由同一條處理」。
- 完整指令與結果見 PR 說明。
