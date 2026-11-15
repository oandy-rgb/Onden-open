# 邊界決定：白板（第 22、26–38 批，2026-09-15～17）

> 狀態：現行（最後確認 2026-11-01）

何時讀：改白板的密度、加入、布局、分組、拖動、對齊、匯出入、卡片編輯之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 第二十二批：白板卡片密度與閱讀（2026-09-15）

- **解釋架構是長期使用目標，先讓圖可讀。** 使用者釐清當前問題是卡片與連線太密；
  本批不建立架構範本或新插件系統。比較增加並排編輯器與按需展開卡片後，選擇後者。
  既有 `KnowledgeWorkspace` 擁有精簡顯示，12 張起預設開啟，可手動切換；這是視覺選擇，
  不是效能上限。精簡高度和連線篩選只進 React Flow 投影，不寫回 folded、位置或尺寸。
- **選取是閱讀意圖，資料刷新不是重新置中意圖。** 精簡卡片只展開目前閱讀對象，第一次
  聚焦至少用 1×；後續正文更新及密度切換不移動鏡頭。長正文在保存尺寸內捲動，縮放不能
  卸載仍在編輯的 CodeMirror。普通點擊取代舊選取，多選仍要求修飾鍵／框選。
- **共同標籤是衍生提示。** 比較所有成員兩兩連線與選取卡片的同伴提示，選擇後者；
  多個共同標籤合成一條提示。沿用正文 hashtag 的既有來源，不把提示當作已保存語意邊、
  插件依賴或授權證據，也不提供刪除該虛擬邊。只在實際可見卡片之間生成。
- **卡片接收自己的點擊。** 卡片層次高於連線的透明互動路徑，避免點卡片卻選到線。
  手機工具列採一列橫向捲動，保留至少 44px 操作；桌面收合檢視窗的殘留按鈕不進手機布局。
  全域力導向圖以容器尺寸渲染，選取不重建布局物件，深淺色文字跟隨目前主題。
- **縮圖使用實際顯示尺寸。** 補驗發現 controlled nodes 沒有保留量測，MiniMap 只有視窗框。
  比較複製固定 style 尺寸與保留 React Flow 的尺寸通知後，選後者，以涵蓋內容決定高度的卡片及群組。
  `KnowledgeWorkspace` 只在目前白板的顯示狀態中接收 dimensions，投影為 `Node.measured`；
  拖曳／resize 的保存仍由既有操作負責，精簡高度不能寫入白板資料。這不是新的布局保存入口。
- **標籤不能排擠筆記導覽。** 桌面側欄的標籤區最多占 35% 並自行捲動，避免大量標籤把清單壓扁；
  手機保留整個列表頁捲動，不繼承桌面的局部限高。

本批證據與限制見 [白板密度實測](../archive/graph-density-fixes-2026-09-15.md)。

## 第二十六批：白板加入選單（2026-09-15）

- **可見卡片不等於白板成員。** 比較在 KnowledgeWorkspace 追加表單狀態與讓 CanvasNotePicker 擁有候選／等待生命週期後，選擇後者。完整成員來自 activeCanvas.data，不能從搜尋、聚焦或虛擬化後的顯示清單判定重複。
- **接受後才揭示新卡片。** 加入 callback 保留 Promise，不用 backgroundWrite 擦掉結果；接受後關閉並交給既有卡片選取／置中，拒絕保留搜尋、共用 reportWriteFailure。已關閉或離開白板的晚到完成不導航。
- **表單與布局調和分屬不同邊界。** 本批重現重播拒絕後本機白板仍保留擺放（GAP-33），當時尚未修復；第二十七批已補開啟白板核對。從 canvas writer／同步讀取邊界處理；不能在 picker 直接刪快取，或以整份遠端布局覆蓋待同步操作。

實測、限制與方案比較見 [白板加入筆記盤點](../archive/canvas-note-picker-audit-2026-09-15.md)。

## 第二十七批：白板布局重新核對（2026-09-16）

- **白板核對由白板 writer 擁有。** 比較 UI 刪除拒絕擺放／強制重新選取與非導航操作後，選擇 `refreshOpenCanvas()`。sync 等待它完成才解除本次畫面核對；不假定 node delta 或 canvas metadata 已包含布局。
- **保護輸入與承認拒絕分開。** 同白板 queued／unconfirmed 輸入保留本機布局；rejected 副本留在 recovery，不再固定目前布局。讀取和本機更新加入既有 canvas 寫入順序，revision／selection 保護更新期間的編輯及切換；不讓晚到結果覆蓋新操作。
- **核對失敗仍須能重試。** 404 只清掉 canvas 副本；其他讀取／副本失敗傳回同步邊界。冷啟動本機讀取若跨越上線要重查；布局讀取期間出現新的拒絕要再核對。只核對開啟白板，不宣稱完整快照已具備跨分頁合併。

實測、方案比較與限制見 [白板布局核對](../archive/canvas-reconciliation-fixes-2026-09-16.md)。

## 第二十八批：白板卡片操作與移除（2026-09-16）

- **觸控操作留在螢幕座標。** 比較每張卡片加入隨縮放的按鈕與固定大小入口後，採白板上單一「卡片操作」，重用 ContextMenu。卡片本身不理解選單布局或保存；選單依視窗邊界定位，手機點擊範圍與色票視覺尺寸分開。
- **移除擺放等待既有保存契約。** 移除 callback 回傳 Promise，選單在接受／durable queued 後關閉，拒絕保留並共用一次錯誤通知；舊完成不能關閉新選單。等待時可關閉選單，其他操作停用。本文不把其他舊右鍵操作視為已遷移。
- **成功後才收尾選取。** Builder 只在仍處原白板 editor 與原選取時選回白板，讓重載維持白板；拒絕不導航，不刪筆記正文。writer 繼續負責布局回復與同步，不擁有畫面選取。

實測與尚未驗收範圍見 [白板卡片操作](../archive/canvas-card-actions-audit-2026-09-16.md)。

## 第二十九批：追加卡片與未快取白板（2026-09-16）

- **追加使用目前布局，目標使用原白板。** 比較 UI 各自讀最新 store 與 writer 意圖操作後，選 `placeCanvasNode(canvasId, nodeId, position?)`。writer 擁有判重、預設位置、快取重查與保存確認；呼叫者保留開始建立時的白板 ID。進行中同一追加共用 Promise，已有擺放保持幾何；慢讀取不得覆蓋新編輯，已移除白板拒絕並保留筆記。
- **取消卡片選取不等於關掉白板。** editor 的空白點擊選回 openBoardId，使雙擊建立與手機閱讀持續；writer 不接管 URL 或導航。右鍵新建與雙擊／工具列共用 handler 和錯誤邊界。
- **讀取意圖不依賴副本已存在。** 比較 UI 監看 online 重試與 writer 保留選取後，選後者；`refreshOpenCanvas()` 也補讀已選取但本機無副本的白板。明確取消、快速切換、建立／移除及失敗回復維持同一目標生命週期，晚到讀取不能復活舊目標。
- **筆記與擺放仍分別確認。** 擺放拒絕不能刪掉已建立筆記，也不能宣稱整組原子提交。此追加只合成本頁最新布局；跨分頁快照、相依操作拒絕與所有拖放入口並未一併解決。

真實桌／手測試、方案比較及剩餘項目見 [新建卡片與共用筆記](../archive/canvas-create-audit-2026-09-16.md)。本批隔離帳號升權經使用者明確授權，測完已恢復 viewer；不變更正式帳號政策。

## 第三十批：分組幾何與一手勢一復原（2026-09-16）

- **搬組與復原使用同一份成員語意。** `sectionCarry` 擁有儲存幾何的中心點判定，包含預設尺寸與折疊高度；
  顯示密度不改變成員。分組計數／搬移／復原快照都用該集合，篩選不可刪掉未顯示的原成員。
  重疊框各自有幾何成員，不把另一分組框視為巢狀子節點。
- **一個布局手勢是一筆記憶體復原。** 比較逐卡儲存與完整手勢後，選擇分組保存原框及原成員座標，
  多選／對齊／排版保存一份卡片位置集合。`restoreSectionPosition`／`applyCanvasPositions` 一次寫入；
  UI 不逐卡組合保存。新增卡片不被舊復原搬動，移除卡片不被重建，其他欄位維持原值。
- **復原等待保存接受才移除紀錄。** callback 保留 Promise，拒絕留在 stack，進行中不重送；晚到接受
  不移除新手勢或另一白板的紀錄。此處接受包括已持久化的待同步操作，UI 仍區分待同步與已同步。
  stack 不跨重載／切板持久化，沒有 redo；正向操作遭拒可能留下無位移紀錄，尚未補完整處置。
- **縮放擁有完整矩形。** 比較可選座標補丁與必要完整矩形後，卡片／分組都傳 `CanvasBounds`，
  原點與寬高同次保存；不按把手方向另組移動流程。分組縮放不搬成員，群組搬移才搬成員。

實測、缺陷與未支援入口見 [白板分組盤點](../archive/canvas-groups-audit-2026-09-16.md)。
分組顏色／手動折疊沒有現成 UI；不能把資料型別或低縮放 LOD 當成已通過這些功能。

## 第三十一批：可見對齊與受控選取（2026-09-16）

- **對齊使用可見幾何，只保存位置。** 比較元件內逐分支補尺寸與集中規則後，選擇
  `alignCanvasCards(renderedNodes, selectedIds, mode)` 統一八種對齊／分布，優先使用即時量測，
  未量測才退回明確尺寸與共用預設值。元件只記錄原位置、交給既有批次 writer；不保存顯示密度尺寸。
  分組搬移仍使用第三十批的儲存幾何，不能用 DOM 尺寸改變成員。
- **受控選取必須接受取消事件。** `onNodesChange` 處理 select／deselect，`onSelectionChange`
  不能作為讀回舊受控旗標的唯一來源。框與卡的明確選取保持在本白板，卡片操作排除分組 ID，
  切板清空多選；閱讀焦點的單卡高亮保持原有意義。這不代表混合拖動已有完整保存契約。
- **窄版多選操作保持可到達。** 工具列限於面板內、可水平捲動，位於主工具列下方；
  操作區 44px，色票視覺 20px，鍵盤焦點可見。桌面保留原緊湊尺寸，布局差異不改保存／復原契約。

實測、方案比較與未驗範圍見 [白板對齊盤點](../archive/canvas-alignment-audit-2026-09-16.md)。

## 第三十二批：混合拖動的位置集合（2026-09-16）

- **手勢擁有固定的卡片與分組集合。** 比較依序搬動各組與一次位置集合後，選擇
  `captureCanvasPositions(data, cardIds, sectionIds)` 封裝所選卡片與所選分組原成員的聯集。
  重疊卡片只移一次，隱藏成員仍納入；顯示節點不再傳遞 memberPositions。
- **正向與復原共用一個布局入口。** `applyCanvasPositions(nodes, sections)` 只合併位置，保留目前其他欄位；
  移除的卡片不重建，後來新增的成員不回捲，缺少目標分組則整筆拒絕。
  此入口取代第三十批的 restoreSectionPosition，單卡／分組／混合拖動不再分別配置保存 callback。
- **Undo 不理解 React Flow 的主節點。** `recordPositions` 只保存位置集合，接受後才移除紀錄；
  拒絕、等待與晚到完成仍沿用既有契約。這不是 redo、縮放或跨重載持久歷史，正向拒絕的無位移紀錄仍待處理。

實際桌／手、403 重試、回歸與限制見 [混合拖動盤點](../archive/canvas-mixed-drag-audit-2026-09-16.md)。
匯出漏成員／尺寸是另一個未修使用案例，見 [白板匯入匯出盤點](../archive/canvas-interchange-audit-2026-09-16.md)。

## 第三十三批：完整白板的匯出（2026-09-16～17）

- **匯出範圍不能來自目前顯示清單。** 比較元件拼裝與完整準備操作後，選擇
  `prepareCanvasExport(canvas, nodes, edges)`；使用完整儲存成員／幾何與已讀實體連線，
  搜尋、聚焦、精簡及折疊不改變匯出內容。未設定尺寸沿用白板共用預設值。
- **未載入不等於空正文。** 缺失或 slim 節點由既有節點讀取補足，失敗就不下載，不能默默略過。
  補讀不更新本機副本或取代本機標題；403／404 在這個讀取邊界轉為適當的可讀性提示，其餘沿用共用錯誤處理。
- **下載跟隨原白板的生命週期。** `useCanvasExport` 擁有等待／防重送及晚到完成；
  離開白板、工作區、進入 membership gate 或卸載即放棄舊下載與回饋。UI 只表達匯出意圖與等待狀態。
  這不是全工作區備份、伺服器原子快照或尚未送交 writer 的編輯草稿匯出。

桌／手實際下載、回歸及匯入工具限制見 [白板匯出修正與匯入初盤](../archive/canvas-interchange-audit-2026-09-16.md)。

## 第三十四批：匯入前驗證與失敗歸屬（2026-09-17）

- **格式驗證在第一筆建立之前完成。** 比較逐筆略過不合法資料與先解析整份輸入後，選擇後者。
  `fromJsonCanvas` 擁有輸入型別、唯一身分、幾何、引用與支援範圍；`JsonCanvasFormatError`
  指出輸入位置，不附帶正文。呼叫者取得已解析的卡片、分組和連線，不自行補缺值或忽略失效引用。
  正尺寸與安全整數是 Onden 的可操作範圍；連到分組尚不支援，明確拒絕而非默默丟線。
- **讀檔、格式與提交失敗分開回饋。** 讀檔／JSON 失敗不呼叫匯入；格式失敗不建立白板。
  其餘失敗沿用 `reportWriteFailure` 並提示可能已有部分內容建立，不使用阻塞式 alert。
  共用通知去重仍有效，不為加上匯入情境而重報已回饋的同一錯誤。
- **連線失敗不能變成成功。** 匯入不再吞掉邊的 API 失敗，停止後續流程且不自動重送。
  目前仍是多個獨立寫入，沒有整批原子性、持久化冪等或回滾；這批驗證不等於解決重匯複本。
  檔案／URL 節點保留原引用文字，不讀外部檔案；其他未映射 metadata 不宣稱完整往返。

回歸重現、桌／手入口與原生選檔缺口見 [匯入前驗證盤點](../archive/canvas-import-validation-audit-2026-09-17.md)。

## 第三十五批：卡片輸入交接與進行中寫入的退出保護（2026-09-17）

- **卡片離開編輯時先交接輸入。** 比較只在匯出前補讀草稿與統一卡片輸入生命週期後，選擇
  `useCardDraft` 擁有停頓保存、blur／取消選取／卸載交接、pagehide 及失敗重試。
  writer 呼叫保持同步開始，下一個點擊才能看到最新樂觀文字；接受仍等待既有 writer 的結果。
  卡片預覽與重開編輯器使用目前草稿，晚到結果不清除新輸入；已拒絕內容不因普通 blur 自動重送。
- **退出保護涵蓋已開始但尚未接受的寫入。** 比較由每個元件追蹤 HTTP 與在共用寫入層追蹤後，
  選擇 `writeLifecycle` 在等待 resource lane／mirror 前登記 `protectPendingWriteOnExit`。
  pagehide 使用既有 recovery 保存請求及原冪等鍵；一般進行中寫入不顯示復原面板。
  收到伺服器或持久佇列接受就解除保護，不等待提交後 mirror；失敗也解除當次追蹤，已建立的退出副本仍保留。
- **可取回不等於已提交。** 退出時的同步 localStorage 復原沿用原有 best-effort 契約；
  有副本不代表伺服器收到，也不能顯示同步完成。真實重載案例需經復原重試及同步才提交。
  直接拒絕後的卡片草稿目前只在該掛載生命週期保留；完整跨卸載保留仍缺，不能以本批成功流程代替。

桌／手下載、快速重開、重載後復原、回歸與未完成邊界見
[卡片內編輯盤點](../archive/canvas-inline-edit-audit-2026-09-17.md)。

## 第三十六批：編輯中的白板可讀性（2026-09-17）

- **開始編輯是明確的鏡頭意圖。** 比較反向放大每張卡片的字體與開始編輯才調整鏡頭後，選擇後者。
  `onNodeEditStart(nodeId)` 由白板擁有置中與至少 1 倍的縮放；原本更大的倍率保留。
  卡片的編輯 effect 取得釋放函式，離開／卸載即停止追蹤可用畫面尺寸；雙擊選字不重啟鏡頭。
  一般總覽沿用既有縮放，不將編輯需求擴散到 Builder 或保存介面。
- **顯示寬度不等於保存尺寸。** 手機只限制編輯卡片內層的實際可見寬度，外層 React Flow 幾何不變。
  編輯期間隱藏 resize 與連線控制，避免把臨時排版誤存成白板布局。ResizeObserver 只追蹤白板容器尺寸，
  排程到下一 frame 置中，並在編輯結束取消 observer／frame；不隨每次輸入重新置中。
- **viewport 通過不能代替真機。** 320／390px 切換、桌面、既有 1.2 倍及快捷保存已實測；
  真實虛擬鍵盤、觸控選字、超高卡片與手機轉向仍未完成。分組標題互蓋另行盤點，不能算本批已解決。

比較、實測及資料還原證據見 [白板編輯可讀性盤點](../archive/canvas-reading-audit-2026-09-17.md)。

## 第三十七批：直接拒絕的復原輸入（2026-09-17）

- **拒絕保留不取決於是否曾離線。** 比較每個編輯器保存自己的拒絕草稿與共用提交邊界後，
  選擇 `submitWrite` 在直接 HTTP 拒絕時呼叫 `preserveDirectRejection`。
  `storeRejectedWrite` 一次建立不可重播的持久列；不先 enqueue 再標記，也不改變 synced／queued／rejected 語意。
  原拒絕照常傳給領域回復和表單；UI 不新增 HTTP 分類或復原格式。
- **等待持久化不能把拒絕退回未知結果。** 同步退出副本帶 rejection／unpersisted，只有 SQLite 提交後
  才顯示已保留；本機失敗另回報並保留原伺服器拒絕。晚到 pagehide 不能改成可重送。
  同鍵要求相同 method／path／body，保存失敗回滾新列；headers／RequestInit 不納入復原。
- **副本與作用中內容分開。** 卡片卸載前後都能保留已提交給 writer 的拒絕輸入，但重開不自動覆蓋已接受正文。
  復原只提供複製與明確移除，後來新請求成功不自動清除舊拒絕副本。帳號分區及目前後端授權不變。

真實捕捉拒絕、桌／手重載複製、卡片回歸與儲存限制見
[直接拒絕復原盤點](../archive/direct-rejection-recovery-audit-2026-09-17.md)。

## 第三十八批：分組標題的顯示與保存（2026-09-17）

- **標題避碰是顯示責任。** 比較只顯示選取組名與保留全部名稱後，選擇白板依目前倍率安排標題。
  `layoutSectionHeadings` 只回傳顯示位置及尺度，不改儲存框體、成員、匯出或復原幾何。
  避碰排序不依賴選取或陣列順序；每次碰撞必須嚴格向上退進，不能依賴浮點恰好相等而終止。
- **改名等待既有操作結果。** 比較另建保存流程與沿用領域操作後，選擇直接傳遞async callback。
  元件只擁有輸入、等待及重試回饋；錯誤、持久佇列與拒絕副本仍由共用writer負責。
  拒絕後普通blur不重送，明確重試才再次操作；composition Enter不提交，低倍率不卸載輸入。
  不把callback完成顯示成已同步，因為既有writer可能只確認持久佇列接受。

桌／手、拒絕／重試及尚未完成的大圖邊界見
[分組標題盤點](../archive/canvas-group-headings-audit-2026-09-17.md)。

## S Pen 側鍵：筆 ↔ 橡皮擦（2026-10-25）

- **網頁收不到側鍵本身**（Chromium `stylus_text_selector` 會吃掉側鍵按著落筆的整段觸控）。只認實機量到的間接訊號，
  不判斷瀏覽器，收到什麼做什麼（`lib/ink/penShortcut.ts`，純狀態機，`InkEngine` 的 `onPenShortcut`）：
  - A 懸空點側鍵（三星網際網路）：沒有任何 pen 按下時，pen `pointermove` 的 `buttons` 由 0 變非 0 → 切換；回到 0 才重新武裝。
  - B 按住側鍵點／畫（Chrome、三星網際網路）：整段筆跡不進網頁，只有約 150ms 後 `contextmenu`，`pointerType` 為 `mouse` 或空字串，
    且元素上沒有指標按著、最近 0.6 秒也沒有指標按下或放開（長按的選單在指標還按著時出現，右鍵緊跟著 pointerdown） → `preventDefault` 並切換。手指（`touch`）與筆（`pen`）長按的 contextmenu 不動。
  - A+B 同一次按（三星網際網路）：A 按住期間、或 A 之後 3 秒內的 B 只 `preventDefault`，不再切第二次。
  - C 畫到一半按側鍵：pen `pointercancel`（約 160ms 後）。這不是切換；`inputPolicy` 的 `draw-cancel` 帶 `keep`，
    引擎保留已畫的部分（≥ 2 點；橡皮擦拖曳保留已擦掉的預覽）。手指被筆取消（掌紋排除）、第二指、瀏覽器取消照舊丟棄。
- **唯讀筆跡**不切換、不攔 contextmenu。無設定開關、畫面無說明文字。
- **宿主**用 `usePenShortcutTool(tool, setTool, enabled?)`：目前是橡皮擦 → 回到最近一個非橡皮擦工具（筆／螢光筆／手形，沒有紀錄用筆），
  否則 → 橡皮擦；走宿主自己的 `setTool`，工具列選取狀態隨之更新。手寫頁（`InkNodeView`）、白板（`CanvasInkLayer`）已接。
- **PDF 劃線已接**（`pagebook/PageInkSurface`＋`PdfNodeView`；2026-11-09 前是 `PdfCaptureSurfaces`）：側鍵、工具列、手指／筆規則與手寫頁同一套，見下節。

### 各裝置的筆（2026-10-26）

「筆的快捷動作」不分裝置：`penShortcut`／`onPenShortcut`／`usePenShortcutTool`（上節的 S Pen 側鍵改名而來），
宿主一律切筆 ↔ 橡皮擦。**iPad 全部未在實機驗證**（手邊沒有 iPad）；下表的 iPad 欄是照 WebKit／MDN 文件寫的，
測試用 jsdom 重播文件上的事件序列（`test/inkPenDevices.test.ts`），不等於 Safari 真的這樣送。

| 訊號／能力 | Galaxy＋三星網際網路 | Galaxy＋Chrome | iPad＋Safari | 要原生殼 |
| --- | --- | --- | --- | --- |
| 筆壓 `pressure`（`pointerType: "pen"` 即視為真壓力，Pencil 同路） | 有 | 有 | 有（未實測） | 否 |
| 側鍵 A：懸空 `buttons` 0→非0 | 有 | 無 | 無此按鍵 | 否 |
| 側鍵 B：`contextmenu`（無前導 pointerdown） | 有 | 有 | 不應出現；出現也被擋（下） | 否 |
| 懸停（pen `pointermove`、`buttons` 0）→ 懸停預覽 | 有 | 收不到 → 不顯示 | M2 以後的 iPad 有（未實測） | 否 |
| `getCoalescedEvents()` 補點 | 有 | 有 | 新版 Safari 才有；沒有就用事件本身 | 否 |
| Pencil 2 雙擊、Pencil Pro 捏一下 | — | — | 網頁收不到（只給 UIPencilInteraction） | **是** |
| 傾斜 `tiltX/Y` | 不用 | 不用 | 不用（這次不做效果） | 否 |

- **iPad 不誤觸**：Safari 的 `contextmenu` 是沒有 `pointerType` 的 MouseEvent，分不出手指／Pencil 長按與側鍵。判斷改用前面的指標：
  元素上有指標按著、最近 0.6 秒有指標按下或放開（既有），**或**最近 2 秒內有 pen／touch 接觸被 `pointercancel`
  （iOS 長按放大鏡時常先取消指標，選單才在之後出現，`PEN_SHORTCUT_CANCEL_MS`） → 不是側鍵。不辨識瀏覽器。
  代價：S Pen 畫到一半按側鍵（訊號 C，本來就不切換）後 2 秒內的 B 也不切。
- **懸停預覽**（`penHover.ts`，`InkEngine.addPointerHandlers` 掛上）：只有 `pointerType: "pen"` 且沒有 pen 按著時，
  筆尖位置顯示一個 `pointer-events: none` 的 div（筆／螢光筆＝目前顏色與粗細的圓點，橡皮擦＝橡皮擦範圍的圓圈；手形不顯示）。
  rAF 內只改 `transform`，不碰畫布；筆落下、離開元素、或 400 ms（`PEN_HOVER_IDLE_MS`）沒有懸停事件就消失。滑鼠與手指不顯示。
- **Safari 預設行為**：引擎在互動元素上設 `touch-action: none`、`-webkit-touch-callout: none`、`-webkit-user-select`／`user-select: none`，
  擋 `selectstart`；有 pen 按著時才擋 `touchmove` 的預設（手指平移照舊由引擎處理，觸控筆模式不變）。
  `pdf-draw-surface`、`canvas-ink-capture` 的 CSS 也寫同樣四項。Scribble 是否仍會吞事件未實測。
- **原生殼入口**（`lib/penShortcutBridge.ts`，殼尚未實作）：`window.ondenPenShortcut(source?)` 或
  `window.dispatchEvent(new CustomEvent("onden:pen-shortcut", { detail: { source }, cancelable: true }))`，
  `source` 為 `s-pen-button`／`apple-pencil-double-tap`／`apple-pencil-squeeze`（目前只做記錄，行為相同）。
  畫面上可編輯的手寫宿主（手寫頁、白板、PDF 在繪圖工具時）切換筆 ↔ 橡皮擦；第一個接手的宿主 `preventDefault`，
  其餘跳過；函式回傳是否有宿主接手。沒有殼就沒有人呼叫，不影響任何事。

### PDF 手寫與手寫筆記同一套工具（2026-10-26）

- PDF 只有**一條**工具列，沒有「繪製／停止繪製」模式：共用 `InkToolbar`，PDF 經 `leadingTools`／`trailingTools`／`trailing`
  加入「選取」（預設）、矩形、圓形、箭頭與最後的「⋯」選單（放大、縮小、符合寬度、清除全部標註；清除先用 `confirmDialog` 確認）；
  手寫筆記與白板不傳這些，外觀不變。工具狀態是 `PdfNodeView` 的一個 `PdfTool`（`'select' | InkActiveTool | PdfShapeType`），
  `selectTool` 是唯一換工具入口：筆／螢光筆／橡皮擦／手掛 engine；選取與形狀不掛 engine，離開繪圖工具時**先**
  `commitDrawSession()` 再卸下。Esc 回選取（同樣先存）。形狀是工具，畫完留在同一個形狀（可連續畫），用目前顏色與粗細。
  選取保留文字選取（劃線、→ 卡片）與 Alt＋拖曳框選；說明只放在「選取」按鈕的 title／aria-label，沒有計數與說明列。
  唯讀只有選取、手、「⋯」（只有縮放）。全螢幕的「離開」與工具列同一列，不蓋住工具。選單在全螢幕時掛進全螢幕元素（`ui/Popover`）。
  已知限制：復原堆疊在 engine 上，換到選取／形狀會卸下 engine，復原／重做隨之停用（手工具仍可用）。
  觸控筆模式與手寫頁共用 `useInkInputPrefs`（裝置偏好）。
- 每頁的 engine 直接載入該頁的 InkDocument（頁面單位，見下節「PDF 與手寫頁存法統一」）；橡皮擦與復原因此走 engine 現有邏輯。
  （2026-10-28 前是進模式時把 `drawing` 記錄依 capture frame 換成當下縮放的頁面 px 載入，`loadPageDrawings`；已刪。）
- `InkPageSession.apply(doc)`（`lib/ink/pageSession.ts`；PDF 用 `createPdfDrawSession()`，頁面以 `pdf:<n>` 為鍵）是唯一寫回入口，冪等：只處理簽章（筆劃 id＋erased＋形狀 id）有變的頁面，寫的是**整頁**（`setPdfPageDoc`）。
  engine 只在換頁、另一個版本的資料進來時重建；縮放只更新 transform 並重畫（復原堆疊保留）；
  顏色、粗細、工具、觸控筆模式改在現有 engine 上。
- 格式：`PdfDrawingStroke` 加 `points[].p`（筆壓）與 `toolId`；ink 筆劃本來就有。新筆劃一律寫 `toolId`，沒有 `toolId` 的是舊筆劃，
  維持原本的等寬線（讀成頁面單位時 `toolId: "uniform"`，見下節）；有 `toolId` 的用 `strokeOutline`＋`outlineToPath`（與筆記、發布網站同一個輪廓），螢光筆半透明。
  發布網站不畫 PDF 標註，沒有影響。
- 手指：engine 的 `gestures` 接到 PDF 捲動容器（單指拖曳＝捲動）；雙指縮放在手指停下約 0.2 秒後才呼叫 `zoomBy`（原本是因為縮放會重掛各頁 surface；
  現在 engine 不重掛，這個延遲只是避免縮放中途反覆重畫）。
- 甩動（2026-10-27）：手指放開時還在動，engine 回報的 `fling` 由 `lib/ink/glide.ts` 的 `startGlide` 接著捲動、逐漸減速；
  頁面本子（`pagebook/PageBook`）用同一個函式，兩邊手感一樣。PDF 上任何新的 pointerdown（筆或手指）立刻停下滑動。
- 全螢幕是工具列最右邊一顆只有圖示的切換鈕（⤢ 全螢幕／⤡ 離開，文字只在 title 與 aria-label），**沒有雙擊進全螢幕**：
  平板上雙擊是選字或筆的兩下輕點，舊的雙擊捷徑一直誤觸。

## PDF 與手寫頁存法統一（整合第 1 步，2026-10-28）

- **大方向（業主：「把兩個整合在一起吧」）**：PDF 筆記與手寫筆記是同一種頁面——核心書寫層（筆跡、形狀、文字框）＋可插拔的背景
  （空白／PDF 第 N 頁／以後的投影片），像 Saber、Xournal++：PDF 頁只是背景。分三步：**第 1 步（本批）統一存法**；第 2 步一個頁面元件，PDF 筆記與手寫筆記共用，
  PDF 專用工具只在 PDF 頁出現；第 3 步刪 PDF 舊的畫圖程式、停寫舊格式（**要先問業主**）。手寫是核心、沒有開關；PDF 是內建模組
  （pdf.js 延遲載入，頁面單位換算、文字擷取、目錄收在 `lib/pdf`、`components/pdf`）。
- **新格式**（`@onden/markdown/ink` 的 `inkPages.ts`、`inkFormat.ts` 開頭的「Two formats」）：通用頁面信封 `InkPages = { version: 1, pages: { [key]: { key, background, size, doc } } }`。
  - `key`：PDF 頁 `pdf:<頁碼，從 1 開始>`；單頁手寫筆記 `page`（與 `page_text` 的手寫頁 key 同一個）；以後多頁空白頁用 uuid；投影片 `slide:<slideId>`（簡報設計 #876 的承諾，這次不做）。
  - `background`：`{kind:"blank"} | {kind:"pdf", page} | {kind:"slide", slideId}`；沒看過的 kind 原樣保留。
  - `size`：PDF 頁寬 1000 單位、高 1000·h/w；手寫頁照它的頁寬 1000；投影片 1920×1080。
  - `doc`：該頁的 InkDocument，**頁面單位**（`doc.page.width` = 1000，不隨縮放變），就是手寫頁自己的格式——一頁的 InkEngine 直接 `load(doc)`、`serialize()` 就是新的頁面，不用換算。
  - 放哪：PDF 的 `ink_data` 信封多兩個欄位 `units`（`InkPages`）與 `unitsFrom`（寫 `units` 時舊欄位的指紋）。手寫筆記的 `ink_data` 本來就是它的唯一一頁，
    它的 `InkPages` 由那個值推出（`notePages`）、寫回也還是那個值（`noteDoc`）——**內容相同，不另存第二份**（會讓大小加倍、還要另寫合併）；
    手寫頁的畫面與行為不變，路徑改走 `InkPages`（`InkNodeView` 收 `initialPages`／`onPagesChange`）。
  - 合併：不同頁永不衝突；同頁的筆跡、形狀以 id 三方合併、擦除是區間集合（沿用 `mergePage`，與 Format evolution 規則）；頁記錄的 `background`／`size` 與未知欄位逐值三方合併。
- **雙寫（業主條件）**：這一步同時寫新舊兩種格式，目的是退回舊版前端時筆跡照樣看得到、改得到。**讀新的優先，沒有新的（或過期）就從舊的轉**。
  舊格式 = `pages[n]`（筆劃在所屬記錄的 frame 座標）＋`drawing`／`shape` 記錄；文字劃線（`text`／`area` 記錄）不動，也不是筆跡。
  - **寫**（`lib/pdf/pageUnits.ts` 的 `setPdfPageDoc`，唯一入口，`guards/ink.guard.test.ts` 鎖住）：存一頁＝寫 `units` 的該頁，再從它產生舊格式。
    還完整的舊記錄原樣保留（筆劃與形狀提交後不變）；其他筆劃**每筆一個記錄、記錄 id＝筆劃 id**（所以兩種格式的 id 一樣，舊記錄的多筆群組缺一筆時其餘各成一筆）；
    頁面沒有的筆劃／形狀，記錄與 `pages[n]` 的項目一起拿掉。記錄放在寬 1000、高 1000·ratio 的參考 viewport 裡（舊前端照 `Scaled` 縮放到頁面，位置一樣）。
    只有 `pages[n]` 有、記錄沒有的筆劃（記錄已遺失，沒有位置可換）原樣留在 `pages[n]`，也原樣放進頁面。
  - **一次編輯一次存檔**，維持停筆約 1 秒後自動存；帶 base 的三方合併照常。信封變大約一半（同一筆筆劃現在存三處：`units`、`pages[n]`、記錄），停寫舊格式後回到兩處以下。
- **讀取時轉換舊資料**（純函式 `pagesFromLegacy`，不寫 migration、不動後端；筆記只在下次編輯時才被重寫）：
  頁面單位 = （記錄在擷取當時 viewport 的位置＋筆劃點×frame 縮放）× 1000 ÷ 擷取當時 viewport 寬。
  `position.boundingRect` 的 scaled 座標帶著擷取當時的 viewport 寬高；沒有 `content.frame` 的舊記錄照 `recordFrame` 從筆跡範圍推。
  筆劃 id（`drawingStrokeId`）、筆壓、`toolId`、`pages[n].erased` 的同 id 區間照搬，粗細照點的比例換算。
  **沒有 `toolId` 的舊等寬筆跡**讀成 `toolId: "uniform"`（`@onden/markdown/ink` 的 `UNIFORM_TOOL_ID`，`strokeOutline` 畫成固定寬度的圓頭線）：畫面維持等寬，
  工具列不會畫出這種筆。形狀記錄轉成 `InkShape`（框型向內縮半個線寬，與引擎一直以來的畫法一致；線／箭頭用 `startPoint`／`endPoint`）。
  缺 `pages[n]` 副本的很舊資料照樣轉；冪等：`units` 與舊欄位指紋相符的頁不再轉。
  驗證：位置與舊算法在多種縮放下誤差 < 0.5 px、隨機筆跡／擦除／形狀舊→新→舊往返不丟不位移（`pdfPageUnits.test.ts`）。
- **Format evolution 的判斷**（寫在 `ink.ts` 標頭第 3 條）：**不需要 `requires`，也沒有寫 `features`**。`units`／`unitsFrom` 是舊前端看不懂、但不必看懂的新欄位：
  舊前端的存檔路徑（`decodeInk`→改舊欄位→`encodeInk`、伺服器 `mergeEnvelope` 的未知欄位三方合併）都**原樣保留**它們（`ink.test.ts` 以舊前端的存檔路徑驗證）。
  唯一的風險是舊前端只改舊欄位、`units` 就比舊欄位舊，所以 `unitsFrom`（舊欄位的指紋：每頁筆劃、擦除、形狀＋ drawing／shape 記錄，與順序無關）必須相符，讀的人才信 `units`
  （`currentUnits`）；不符就從舊欄位重轉（舊欄位是最新的）。`mergeEnvelope` 只在三方的 `units` 都已知與其舊欄位相符時才為合併結果重算 `unitsFrom`，
  否則去掉它，讀的人就轉換合併後的舊欄位——它含兩邊畫的所有東西。下一次新版本存檔（base 是轉換後的）會讓它相符。
  `requires` 會讓每個舊前端對一個它可以安全忽略的形式唯讀，不划算。
- **顯示**：PDF 頁上的筆跡與形狀由 `pagebook/PageInkSvg.tsx`（2026-11-09 前是 `components/pdf/PdfPageInk.tsx`）從頁面畫，與手寫筆記／嵌入卡片同一套靜態幾何（`strokeOutline`、`visibleRuns`、`inkShapePathD`），
  SVG 的 viewBox 是 `0 0 1000 <1000·h/w>`、疊在頁面上隨縮放縮放；`PdfPageHighlights` 只畫文字與區域劃線（舊的 `PdfInkStrokes`／`PdfShapeView` 與 `.pdf-ink-svg`、`.pdf-hl-shape-svg` 的 CSS 已刪）。
- **編輯**：每頁 `InkEngine` 的 transform＝頁面 px ↔ 頁面單位（scale＝頁面寬／1000）。縮放時 `PageInkSurface` 更新 canvas 尺寸並 `viewChanged()` 重畫、**不重掛 engine**，復原／重做保留。
  工具列的筆粗細是「螢幕上幾 px」：engine 的筆粗細設成 px ÷ scale；橡皮擦半徑新增 engine 選項 `eraserRadius`，PDF 傳 12 px ÷ scale（螢幕上同樣大）。
  已知的小差異：形狀與筆劃的線寬現在**隨縮放**（以前形狀固定 px）；形狀寬 `1 + 1.2×粗細` 的「1」是頁面單位，所以在縮放 ≠ 1 時最多差 `|scale − 1|` px（600 px 寬頁約 0.4 px）。
  頁面全被擦光的筆劃留在頁面裡（與手寫筆記一樣，筆劃提交後不變，擦除只加區間），不再像以前那樣把記錄一起拿掉。
- **離開頁面不掉筆跡**：`pagehide` 與 `visibilitychange`（hidden）時，PDF 頁（`commitDrawSession`）與 `InkNodeView`（`engine.flush()`）立刻存出還沒存的筆跡，
  存檔帶 `keepalive`（`saveInk(…, { keepalive: true })` → `submitWrite` 在 await 之前就 `rememberUnconfirmedWrite`，頁面死了下次啟動由復原清單接手）。
  不用寫佇列自己的 `pagehide` 監聽：它在我們的處理函式裡才註冊，同一次事件不會被呼叫。沒有待存的內容就什麼都不存。
- **沒法在雲端驗證**（驗收的人做）：真機（S Pen、觸控）手感、縮放時筆粗細／橡皮擦大小；用**真備份**或正式資料中舊的 PDF 筆記開啟、畫一筆、
  再用上一版前端打開確認舊筆跡與新畫的都看得到、改得到，再回新版確認舊版改的沒被蓋掉。
- **第 2、3 步之前不要做的事**：不要在頁面元件寫死「是不是 PDF」；不要停寫舊格式（要先問業主）；`lib/pdf/pageUnits.ts` 是舊↔新轉換唯一的地方。

## 白板改成視角（2026-10-27，migration 138）

- **白板是筆記的視角，不是筆記類型。** 卡片位置以這篇筆記自己的 id 為鍵；「有白板」＝有一筆 canvas 檢視（白板分頁）。
  `node_type = 'canvas'` 退役，讀取端與白板型視為同一回事（`boardStore.whiteboardNoteSql`、`lib/whiteboardNote.ts`），不再各處判斷節點類型。
- 比較過的做法：(a) 把位置改以新鍵存放——要搬資料、舊前端寫入會落空；(b) 位置鍵不動、只改節點類型與分頁紀錄（採用）——資料零搬移，
  舊路由仍讀寫同一組列。轉換可還原（`canvas_note_conversions`、`scripts/restoreCanvasNotes.sql`）。完整契約見 [canvas-as-view.md](../architecture/canvas-as-view.md)。
- 點選白板上「本身有白板」的卡片仍進入它的白板（原本點 canvas 型卡片的行為）；只是別張白板上的卡片，仍留在目前白板。

## 白板複本併回原筆記（2026-10-27，migration 139）

- **問題**：舊的「從子筆記建立白板」另建一篇同名白板、把整棵子樹（含自己）放成卡片；138 把它轉成一般筆記後，工作區有兩篇同名筆記，
  側欄又把「放在白板上的頂層筆記」列在白板底下，真正的筆記看起來被收進複本。
- **做法**：migration 139 只處理**確定是複本**的（條件見 [canvas-as-view.md](../architecture/canvas-as-view.md)「複本併回」）；
  卡片、分區搬到原筆記，原筆記自己那張卡片拿掉，複本軟刪除，並寫 `NODE_DELETED`／`COLLECTION_VIEW_*`／`CANVAS_UPDATED` 事件讓已開著的裝置下次同步就看到。
  可還原：`board_copy_folds`＋`scripts/restoreFoldedBoards.sql`。不確定的一律不動。
- **側欄**：`tidySidebarRoots` 只剩「產生的筆記（RSS）離開樹」；不再把卡片列在白板底下，節點只照真正的父子關係。
- **之後不再產生複本**：「給這篇筆記一個白板」只有一條路 `lib/whiteboardTab.ts` 的 `ensureWhiteboardTab`（加分頁或取消隱藏）。
  `buildBoardFromChildren` 只放子孫，不放自己；白板上把卡片「開成子白板」改成開那張卡片筆記自己的白板分頁（舊的 `subCanvasId` 連結照舊能開）。
  建立白板筆記只剩全新的（空白、建立選單、匯入 JSON Canvas）；`guards/board-copies.guard.test.ts` 鎖住，`noBoardCopies.test.ts` 驗證動作不新增筆記。

## 手寫：形狀、停住自動修形、更多顏色（2026-10-27）

- **「形狀畫不出來」的根因**：PDF 的形狀不是 ink 引擎的工具，而是另一個 React 指標面（`PdfPageShapeSurface`），
  `touchSplit` 的 `penOwned` 只認筆／螢光筆／橡皮擦，所以選形狀時筆的觸控沒被接管、手指拖曳被瀏覽器捲動打斷（`pointercancel`）。
  不在 `penOwned` 補一個分支，而是把形狀收進引擎：`InkActiveTool` 加 `"shape"`，PDF、手寫頁、白板都走同一套輸入規則
  （筆畫、手掌不捲、單指原生捲動、雙指縮放、觸控筆模式）。`PdfPageShapeSurface` 已刪。
- **一份形狀幾何**：`@onden/markdown` 的 `inkShapes.ts`（各 kind 的折線、`inkShapeIsDrawable`、`polylineOutline`）給引擎、PDF 頁面 SVG、
  靜態 SVG（複習卡、嵌入、發布網站）共用，三處畫得一樣。引擎把形狀展成 `toolId: "shape"` 的內部筆畫交給既有的 Canvas2D 渲染，
  不另寫渲染器。`InkShape.size` 一律是實際線寬；用筆或形狀工具存時是 `1 + 粗細 × 1.2`（跟筆同寬）。
- **格式**：`InkShapeKind` 增 `line`、`roundedRectangle`、`ellipse`、`triangle`、`diamond`、`star`（舊的 `circle` 只讀，畫法同橢圓）；
  未知 kind 仍原樣保留（舊前端讀新資料不壞，只是不畫）。形狀仍 append-only，橡皮擦整個拿掉、復原還原。
- **停住修形**（`lib/ink/recognize.ts`，純函式，有性質測試）：只認直線、箭頭、矩形、橢圓／圓、三角形、菱形；只對筆（不含螢光筆）。
  以筆畫外框為範本比對外形距離，傾斜的矩形／橢圓、半圓、字跡一律不修（寧可不修）。0.5 秒由 `InkEngine` 的計時器判定，
  動過 4 px 就重算；顯示修好的形狀加一圈淡光暈；放開時 `InkModel.snapStrokeToShape` 一次提交，**一步復原回原筆畫**，再一步才移除該筆畫。
  設定「畫完停住自動修成形狀」跟帳號（`inkAutoShape`，設定頁「手寫」），預設開。
- **PDF 儲存**：（2026-10-28 起，見下節）形狀是頁面 InkDocument 的 `shapes`（頁面單位），橡皮擦、復原、停住修形直接作用在它們上；
  舊格式的 `type: "shape"` 記錄由 `setPdfPageDoc` 從頁面產生（框是線的外緣，舊前端畫在同一處）。引擎畫不出的 kind（較新版本的）留在頁面裡、不畫也不刪。
- **顏色**：工具列 5 個快速色＋「更多」（20 色色盤、色碼／色輪、我的顏色、最近用過、替換快速色）。自訂與最近、快速色是帳號偏好
  （`inkPalette`；`lib/ink/palette.ts` 純函式；後端 `actorPrefs` 有同一形狀，`prefKeysContract.test.ts` 對 key）。
  顏色是十六進位值（不再是 `colorId`），深色模式仍在渲染時反轉亮度。最後用的形狀也跟帳號（`inkShape`）。
- **平板上怎麼驗收**（雲端驗不到手感）：Galaxy Tab S9 + S Pen，Samsung Internet／Chrome：
  1. PDF 開啟，選「形狀」→ 圓角矩形，S Pen 拖一個；再關掉手機設定裡的「觸控筆模式」，用手指拖一個；兩者都不被捲動打斷。
  2. 觸控筆模式開著時，選形狀後手指拖曳只捲動 PDF、不畫；兩指縮放照常；手掌放著不捲。
  3. 手寫頁用筆畫一個歪的矩形、停住約半秒：出現淡光暈、放開後變成直角矩形；復原一次回到原本歪的筆畫。畫字、畫弧線停住不應被修。
  4. 工具列按「更多」：選色盤顏色、輸入色碼、用色輪；換一個快速色；換另一台裝置登入，快速色與最近顏色跟著來。

## 頁面文字框（2026-10-28，`page_text`）

- **是什麼**：PDF 與手寫頁上的「文字框」，原本的字不改。屬於**核心書寫層**，不是 PDF 專用、沒有開關；簡報（#876）與統一頁面之後共用同一個元件與格式。
  元件 `components/page/TextBoxLayer.tsx`（頁面只給「頁 key、頁寬幾單位、tapTarget」），狀態與儲存時機是 `lib/pageText/controller.ts`，PDF 只在 `PdfNodeView` 的頁面 overlay 掛上、手寫頁掛在紙張內。
- **資料**：獨立屬性 `page_text`（不放進 `ink_data`：筆跡存法另有工作在重做，打字與寫字也不互相衝突），格式與合併在 `@onden/markdown/page-text`
  （`{v:1, pages:{[pageKey]:{boxes:[{id,x,y,w,text,size,color,align,updated_at}]}}}`，頁面單位、與縮放無關）。
  `pageKey`：`pdf:<頁碼>`、手寫頁固定 `page`（手寫頁沒有頁 id）、投影片以後 `slide:<id>`。PDF 頁寬 1000 單位；手寫頁用自己的頁面座標（寬 1000）。
  `v` 大於 1 的值只讀（不編輯、不存）。未知欄位（框、頁、文件）原樣保留。
- **合併**（`MERGED_KEYS` 加 `page_text`，`attributeWrites.mergeAttribute` 依 key 選合併器）：以框 id 三方合併，不同框都留；兩邊改同一框→後存的為準，
  另一版記成 `ATTRIBUTE_CONFLICT`（欄位 `page_text_conflicts`，收件匣 Revert 只拿回那幾個框）；一邊刪一邊改→保留修改。與 ink 共用 `jsonMerge.ts` 的 `mergeById`。
- **事件**：沿用屬性寫入，不開新事件類型或路由。一次儲存＝一筆 `ATTRIBUTE_SET`（含改之前的快照，`eventRestore` 的屬性還原直接支援，後來改過就 `state_conflict`）。
  何時存（controller 負責，介面不重複判斷）：打字停約 1 秒、放開（移動／改寬）、改大小／顏色／刪除／復原立即、點到別處（blur／空白處）與 `pagehide`／分頁隱藏／離開頁面。
  輸入法組字中不存、不動作（Esc／Enter／Ctrl+Z 都留給候選字）。空的框不存（結束編輯時刪掉，不留復原步驟）。離線同 ink：先寫本機副本再排隊，帶 `base_value`。
  歷史用人話（「改了…頁面上的文字」），不露屬性名。
- **復原**：文字工具的復原／Ctrl+Z 作用在文字框（新增／打字一段／移動／改寬／樣式／刪除各一步），Hand 工具在文字框有步驟時也是，其他工具照舊作用在筆跡；兩邊各有堆疊（寫字與打字是不同的編輯）。
- **搜尋**：前端本機搜尋（`localDbWorker.searchNodes`）會找框內文字（只比對框的文字，不比對 JSON 的 key）。**後端搜尋沒做**：pgroonga 索引在 `content_nodes(title, markdown)`，
  要搜框內文字得加衍生欄位或索引（migration），另開一批。
- **舊前端**：不認得 `page_text` 的版本把它當一般屬性同步、不顯示、不寫；它存 `ink_data` 不會動到 `page_text`（`pageText.integration.test.ts`）。
- **匯出／備份**：Markdown 匯出不把它寫進 frontmatter（同 `ink_data` 的資料屬性）；完整備份的側車帶所有屬性，所以一併帶上；備份計數 `drawings` 也算只有文字框的頁面。

## 手寫：插入圖片／相機、筆的預設、取色器、形狀填色、調色盤（2026-10-28）

- **插入一格**（`InkToolbar` 的 `insert` 屬性，`InkInsertButton`）：一顆「＋」開兩個選項——「從相簿或檔案選圖片」與「用相機拍照」。
  兩個都是 `<input type=file>`：相機是 `accept="image/*" capture="environment"`（不用 `getUserMedia`，沒有相機的瀏覽器就是一般檔案選擇）。
  只有手寫頁與白板的筆工具列傳 `insert`；**PDF 不傳**（PDF 本身從新增面板的「上傳檔案」來；`page-images.guard.test.ts` 鎖住）。
- **上傳只有一條路**：`hooks/useImageUpload.ts` → `lib/data` 的 `uploadMedia`（與 `/` 插入、拖放同一條：同一個大小／類型檢查、同一則錯誤訊息）。
  失敗的檔案用白話提示並略過，其他檔案照常；瀏覽器 3 秒內讀不出圖片尺寸仍會插入（4:3）。
- **手寫頁：圖片是頁面上的一層**（`page_images`，格式與合併在 `@onden/markdown/page-images`，仿 `page_text`）：
  `{v:1, pages:{[pageKey]:{images:[{id,x,y,w,h,src,alt,updated_at}]}}}`，頁面單位（寬 1000）、同一套 `pageKey`（手寫頁 `page`）。
  `src` 只認 `/api/media/<id>`（媒體語法 `mediaRefs.ts`）：伺服器的檔案歸屬（`claimUploadedMedia`）與讀取檢查照舊在屬性值裡找到它；
  其他位址（`javascript:`、`data:`、外站）讀取時丟掉。清單順序＝疊放順序。與 `page_text`／`ink_data` 各自獨立，不互相合併或衝突。
  後端合併走 `attributeWrites` 的 `PAGE_LAYERS` 表（`page_text` 與 `page_images` 共用一條：依 id 三方合併、兩邊都改→後存的為準並記成 `ATTRIBUTE_CONFLICT`，
  欄位 `page_images_conflicts`；一邊刪一邊改→保留修改）。Markdown 匯出不寫進 frontmatter；備份側車照帶；歷史說「改了…頁面上的圖片」。
- **一層、兩個部分**：圖片本體在紙張裡、**墨水下面**（`PageImageLayer part="art"`，z-index 0 < 墨水舞台 1），所以筆跡畫在圖片上；
  控制（透明的點擊框、外框、四角把手、刪除鈕）在墨水**上面**（`part="controls"`，z-index 6），只在手形工具（選取）時出現——別的工具圖片只顯示、不吃點擊。
  移動、縮放筆與手指都行（框 `touch-action: none`；四角把手觸控範圍 44 px；縮放保持比例、鎖在頁寬與目前頁長內）。鍵盤：方向鍵微調、Delete 刪除、Esc 放開。
  已知限制：手形工具下兩指都落在圖片框上時，雙指縮放頁面被框吃掉（文字框一樣）；兩指落在圖片外照舊。
- **共用的控制器骨架**：文字框與圖片的控制器共用 `lib/pageLayer/store.ts`（文件、復原／重做堆疊、選取、訂閱、存「與上次不同才存」並帶 base）與
  `useLayerController`（離開頁面／分頁隱藏時存、卸載時存）；各層只寫自己的編輯與何時存（文字：停頓後存；圖片：每個完成的動作立刻存）。
- **插入的位置與復原**：圖片放在畫面可見範圍的中央（`visiblePageBand`／`centeredIn`），多張略為錯開；插入後切到手形工具並選取最後一張。
  **復原規則（`lib/pageImages/undoTarget.ts`，按鈕與 ⌘Z 同一處）**：選著圖片且圖片層有步驟→圖片層；文字工具→文字框；手形工具→文字框有步驟時給文字框，
  否則圖片層有步驟給圖片層，否則筆跡；其他工具（筆、螢光筆、橡皮擦、形狀）一律是筆跡。三者各有堆疊。
- **白板**：沿用既有的圖片卡片——`CanvasInkLayer` 的 `onInsertImages` 接到 `useBoardWorkspace.onInsertImages` → `useCanvasActions.dropImagesAsCards`
  （拖放圖片進白板用的同一個函式：上傳→建一篇內容是圖片的筆記→放到白板），位置是目前視野中央往左上退半張卡片；放完前按鈕顯示「上傳中」。
- **筆的預設**（`InkPresetButton`、`lib/ink/presets.ts`、帳號偏好 `inkPresets`）：工具（筆／螢光筆）＋顏色＋粗細，最多 6 個，名稱最多 24 個字（不在字元中間切）。
  工具列一顆書籤鈕開清單：點一下套用並關閉；⋯ 或長按改名／刪除；底下「把目前的筆存成預設」（橡皮擦、手形、形狀時存成筆）。
  後端 `PREF_SCHEMAS.inkPresets`（`strict`、至多 6 個、工具與粗細列舉）；`prefKeysContract.test.ts` 對 key。
- **取色器**（顏色面板的滴管、`hooks/useEyedropper.ts`、`lib/ink/colorPick.ts`）：從**資料**取色，不讀畫面像素。
  墨水引擎在加上指標處理時登記成取色來源（筆跡與形狀在 canvas 裡，沒有 DOM），回答「這一點有哪個筆跡或形狀」（含形狀填色的內部、被橡皮擦掉的段落不算；形狀壓在筆跡上面）；
  文字框的根元素帶 `data-ink-color="#rrggbb"`，依畫面位置找。回傳的是存起來的原色（不是深色模式反轉後的顏色）。
  按滴管：面板關起來、底部出現提示（有取消鈕，觸控沒有 Esc）；下一次按壓（筆、手指、滑鼠皆可）是「取色」而不是筆畫或捲動——以 capture 階段攔下 pointer／mouse／touch／click，
  所以白板的拖曳平移也不會動。按在沒有東西的地方：提示改成「那裡沒有東西」並繼續等；Esc、提示裡的滴管或「取消」、換工具都取消。
  **踩過的坑**：只攔 `pointerdown` 時，同一次按壓後續的 `pointermove`（筆 `buttons≠0`）會被引擎當成 S Pen 側鍵而把筆切成橡皮擦（進而取消取色）；
  現在這次按壓的後續事件也不讓頁面看到，取色結束之後也一樣（`keepFromPage`）。PDF 只有在繪圖工具（引擎掛上）時取得到筆跡與形狀；選取工具時只取得到文字框。
- **形狀填色**：`InkShape.fill?: "none" | "solid"`（沒有欄位＝不填；不認得的值當不填、原樣保留；線與箭頭沒有內部）。填色是半透明（`INK_SHAPE_FILL_ALPHA = 0.25`），
  外框維持全不透明。引擎把內部做成一條 `toolId: "shape-fill"` 的內部筆畫（點＝封閉多邊形，先畫），白板與手寫頁共用同一套（`strokeAlpha`）；
  橡皮擦碰到填色形狀的內部也會擦掉它。`inkSvg`（網站、匯出、複習卡）、PDF 頁面 SVG（`PdfShapeView`）與 PDF 形狀記錄（`PdfShapeData.fill`）畫得一樣。
  設定在形狀鈕的清單底下「不填色／填滿」（帳號偏好 `inkShapeFill`），新畫的形狀與停住自動修成的形狀都套用。**沒做**：選取已畫好的形狀再改填色
  （形狀是只增不改的，也還沒有選取形狀的機制）。
- **顏色面板的自訂顏色改成調色盤**（`InkColorPicker`）：上面一塊飽和度（橫）／明暗（直）的方塊（至少 200×140，觸控 160 高），下面色相條（觸控目標 44 px 高），
  再下面一行可編輯的色碼與滴管。拖曳時筆的顏色即時跟著變，放開才記進「我的顏色」，所以沒有「使用」鈕；色碼打到合法就即時套用，Enter／離開欄位時記下。
  不用原生 `<input type=color>`（Android 視窗小、各瀏覽器不同）。方塊與色相條可用方向鍵微調（Shift 十倍）；色相另外記著（拖到灰或黑再拖回來還是同一個色相）。
- **平板上怎麼驗收**（雲端驗不到手感）：Galaxy Tab S9 + S Pen，Samsung Internet／Chrome：
  1. 手寫頁按「＋」→「從相簿或檔案選圖片」：圖片出現在畫面中央、被選取、可用 S Pen 與手指拖動、拉四角縮放；切回筆在圖片上寫字，字在圖片上面；復原先收回最近一步。
  2. 「＋」→「用相機拍照」：Samsung 相機開啟，拍完回到頁面出現圖片（直拍／橫拍方向正確）。
  3. 白板開筆模式，「＋」插入圖片：出現圖片卡片在畫面中央。
  4. 調好一支筆（螢光筆、粗、琥珀色）存成預設，換別的筆，再點預設一次切回；長按預設改名、刪除；換另一台裝置登入看到同一組。
  5. 顏色面板：S Pen 與手指拖方塊與色相條，顏色即時變；點滴管，再用 S Pen 點一條筆跡、一個形狀內部、一個文字框，顏色變成那個；側鍵不應把筆切成橡皮擦。
  6. 形狀鈕選「填滿」＋橢圓，拖一個：內部半透明、外框實線；匯出／發布網站的圖畫出來相同。

## 白板自動樹：一打開就是這篇筆記與它的子筆記（2026-10-29）

使用者覺得空白板沒意義；白板和表格、看板一樣，打開就看到這篇筆記底下的東西。規則、資料位置與舊白板處理的完整寫法在
[canvas-as-view.md〈白板自動樹〉](../architecture/canvas-as-view.md)。這裡只記設計決定：

- **即時算、不另存一份**：`lib/boardTree.ts`（`computeBoardTree`、`boardTreePositions`、`toggleBranch`）是純函式，排版沿用 `lib/treeLayout.ts` 的 `layoutTree`
  （原本「依樹狀排列」按鈕用的那份，抽出共用核心，不另寫第二套）。`hooks/useBoardTree.ts` 把「已存的卡片」和「樹的卡片」合成**一張白板**（`canvas`）交給
  `useGraphLayout`、`useCanvasActions`、復原與群組，所以縮放、折疊、上色、群組、父層連線都不必知道有樹。
- **拖過才存**：`useBoardWorkspace.saveBoardData` 存檔前把「和樹畫的位置／大小／顏色／折疊完全一樣、也沒存過」的樹卡片濾掉；沒動過的永遠是自動排。
  不為「第一次拖」另開一條寫入路徑。
- **設定存在白板分頁的 `layout_config.tree`**，不改後端、不加 migration（檢視的 `layout_config` 本來就接受任意鍵）。沒有 `tree` 鍵的舊白板原樣。
  不放進卡片資料（`/api/boards/:id` 的卡片與分區有固定欄位）。
- **預設模式在「第一次看到這張白板」時決定並在該次開啟內固定**（`useBoardTree` 的 `firstMode`）：空白板 auto、有卡片 manual；第一次寫入 auto 白板時才把 `mode: "auto"` 存起來。
  已知限制：拖第一張卡片時，卡片寫入與模式寫入是兩個請求；若中間斷線，下次開啟會因為「有一張卡片」而當成手動，使用者可在白板上方按「跟著子筆記」。
- **打開只讀不寫**：沒有自己白板的一般筆記，`decideCanvasView` 改成讀它自己 id 的白板（空的）而不是 `needsBuild`；`buildBoardFromChildren`、`NoBoardYet` 移除。
- **點卡片不換白板**：`useWorkspaceFocus.onActiveBoard` 把「auto 白板根筆記底下的子孫」算作在這張白板上；沒有它，點一張沒存過的樹卡片會被當成「這篇筆記沒有白板」而改開它自己的白板。
- **總量與層數是常數**（`TREE_CARD_BUDGET`：手機 30、電腦 100；`TREE_CHILD_PAGE` 8；`TREE_DEPTHS`），「+N」卡也算一張，從根往外廣度優先填，滿了就停。
- **換中心是只讀瀏覽**（`useBoardTree.centerOn`／`backTo`）：換中心後只畫那棵樹、不能拖、改白板的操作拒絕並提示，不為「換中心後的位置」另存一份；返回路徑只在記憶體。
- **未做**：「依樹狀排列」與 `.canvas` 匯出只處理已存的卡片；Delete 鍵對沒存過的樹卡片沒有作用。

## 筆不用切換：觸控筆永遠畫、手指捲動（PDF 與手寫頁合一第 2 步的第一半，2026-10-31）

使用者 10/27 的決定：觸控筆永遠用最後一次選的手寫工具畫，不管工具列選的是什麼；手指捲動和縮放；第一次偵測到觸控筆就進入觸控筆模式；
「手指也能畫」放在「更多」選單，不放工具列。這一批只做**輸入規則**；合成同一種畫面的第二半見
[step2-design.md](../research/pdf-unify/step2-design.md)（比較兩種設計、契約、為什麼這次沒做）。

- **規則只在 `lib/ink/inputPolicy.ts`**：多一個設定 `penDraws`（預設開）。筆在任何工具欄（手形、選取、文字）都畫，其他不變；手指與滑鼠不受影響。
  設定是兩個裝置層級偏好，不跟帳號同步，由 `lib/inkInputPrefs.ts` 一處讀寫（更多選單、設定頁、第一次偵測到筆、各畫面都走這裡）：
  手指＝沿用舊的 `inkStylusOnly`（`"1"`＝只捲動，所以舊裝置的選擇不變）；觸控筆＝新的 `inkPenDraws`（`"0"`＝照工具列，其他＝一碰就畫）。
- **引擎把「最後的繪圖工具」和「手形」分開存**（`InkEngine.tool`／`hand`）：以前 `setTool("hand")` 會蓋掉筆，之後筆不知道要用什麼畫。
  `getTool()` 仍回傳目前工具列的樣子。
- **第一次偵測到筆＝一次性的切換**：引擎在第一次 pen pointerdown 叫 `onPenSeen`；`notePenSeen()` 只在「這台裝置從沒選過手指設定」時把手指改成只捲動並提示一次。
  為此 `useInkInputPrefs` 不再在掛載時把預設值寫進儲存（以前 `usePersistedFlag` 會寫，就分不出「沒選過」和「選了不要」）。明確選過的人不會被覆蓋。
- **工具列不放觸控筆開關**：`InkToolbar` 的 `stylusOnly`／`onStylusOnlyToggle` 移除；`PageMoreMenu`（取代 `PdfMoreMenu`）固定有「手指也能畫」，
  手寫頁、PDF、白板共用。白板只改到「走同一份 inputPolicy」：它的手形工具以前讓筆平移白板，現在筆照規則畫（手指仍平移）。
- **還沒做**：PDF 在「選取／文字」工具時沒有繪圖面（引擎只在手寫工具掛載，為了不擋文字選取），所以這兩個工具下筆還不能直接畫；
  手指長按選文字也要等繪圖面改成「只收筆」才做得到。兩者都屬於畫面合一的第二半。
- **驗收（平板上）**：Tab S9 + S Pen：手寫頁選手形，用筆寫字會寫出來、手指能捲動；開設定 › 書寫改成「照工具列」，筆在手形下改成平移；
  全新裝置第一次用筆，手指改成只捲動並出現提示一次；更多選單開「手指也能畫」，手指能畫。

## 手機上的白板：手勢像地圖、底部只留一條工具列（2026-11-02）

業主回報（Android、深色、樹狀自動排列）：兩指縮放會變成框選、底部疊了三層、「還沒有子筆記」被工具列壓住、小地圖擠在後面。

- **手勢（手指落在空白處，且主要輸入是手指 `isCoarsePointer`）**：單指拖曳＝移動；兩指＝縮放＋移動；長按約 400ms（`BOX_SELECT_HOLD_MS`，在 `lib/touchHold.ts`）再拖＝框選；
  第二根手指落下時，進行中的框立刻取消並還原框選前的選取（含手寫選取）；點卡片照舊選取；滑鼠、觸控筆、筆工具、手形工具都不經過這裡。
- **為什麼要「扣住第一次落下」**：React Flow 在 pane 的 pointer-down 就開始框（`selectionOnDrag`），同時 d3-zoom 在 touch-start 開始平移，所以雙指縮放的第一根手指會先開框。
  `lib/boardTouchGestures.ts` 在 window 的 capture 階段扣住手指的第一次落下（React 的 root 監聽在 window 之後），長按夠久才補送給 React Flow，框開著時擋掉該手指的 touchmove，不讓板子一起移。
  只是輕點空白處時補送「落下＋抬起」，取消選取的行為不變。設計比較：改 React Flow（打補丁）或自己畫框都比這個大，沒採用。
- **版面（`phone`＝手機版面，≤900px）**：復原／重做移到左上角（`.board-history`，與右上「顯示」同高）；手指為主時沒有 −／＋；「整個看到」進主工具列的 ⋯；
  小地圖不顯示（「顯示」面板也拿掉開關，`fitPadding` 不再留小地圖的空間）；「還沒有子筆記」放在頂部約 5 秒後淡出；邊／對齊／提示橫幅、空白提示都留在頂端按鈕與底部工具列之間。
  桌面的「還沒有子筆記」原本壓在置中的主工具列上，改成在工具列（筆工具列開著時在它上方）之上。
- **留給之後**：瀏覽器版（試用版）左下角的「資料只存在這個瀏覽器」小標籤在手機上會蓋到主工具列左緣，那是 App 層的元素，這批沒動。

## 白板的筆跡有自己的屬性 `board_ink`（2026-11-02）

業主回報：「在白板畫畫後，內容也會變成畫畫」。原因：migration 138 起白板是筆記的視角，白板筆層卻仍存在筆記的 `ink_data`，而「內容」分頁看到 `ink_data` 就換成手寫頁。

- **決定**：白板筆層改存 `board_ink`（同一個單頁格式、同一個 codec、同一條 `PUT /attributes/:key` 合併與離線佇列），`ink_data` 只屬於手寫頁與 PDF。
  不複製寫入或合併邏輯：「哪個屬性」是 `saveInk`／`loadInkPage` 的參數；鍵的清單在 `@onden/markdown` 的 `INK_PAGE_ATTRS`，後端與前端都從那裡來。
- **搬家**：migration 172 確定地搬 138 轉過來的舊白板，以及筆畫畫到頁面外的筆記（只有白板會這樣；正式站的 4 則經擁有者確認都是白板），都是改名同一列；其餘有白板分頁、筆畫都在頁面內的單頁 `ink_data` 無法分辨，複製並記下證據與建議（`board_ink_moves`），不刪 `ink_data`。
- **模糊的怎麼決定（2026-11-07）**：業主回報日記的文字被蓋掉：172 留下的模糊筆記一直沒有人決定，App 也沒有地方能決定，內容分頁繼續顯示手寫頁。業主決定有文字的都算白板（migration 179）：手寫頁沒有文字，所以有文字就足以判斷。頁面上有文字框或圖片的不動，那些是真的當手寫頁用過。
- **不採用**：在 `ink_data` 內加欄位標記白板（舊版前端會把標記丟掉、兩邊仍共用一個合併單位）；用事件來源判斷（白板與手寫頁走同一個呼叫，事件沒有差別）。
- 全部 `ink_data` 用到的地方逐項判定見 [ink-attributes.md](../architecture/ink-attributes.md)。

## 手機白板永遠全螢幕、頁面不捲動（2026-11-02，業主回報 Android Brave PWA）

業主：「這頁本身希望捲動不了」「默認全螢幕」「放大按鈕拿掉」。只改手機（沿用 `useIsMobile`／KnowledgeWorkspace 的 `phone`）；平板與桌面不變，⤢ 照舊。

- **全螢幕仍只由 `useBoardFullscreen` 一個入口管**：加 `always` 選項。手機且有 `BoardPhoneNav` 提供者（只有筆記首頁有）時，白板在畫面上＝全螢幕，body 另加 `onden-board-locked`；沒有新狀態。
  不在畫面上（資訊頁、筆記清單）仍結束全螢幕，回來又開。手機沒有 ⤢，Esc 也不離開（沒有可離開的狀態）。
- **鎖頁**：`body.onden-board-locked`（CanvasMode.css）把 html／body／app-shell／workspace／`.graph-panel` 都設成 100dvh、不捲動、`overscroll-behavior: none`，藏底部導覽、同步條與筆記右上的 ⊟ ⋯。
  根因是 `.graph-panel` 高度原本扣掉頂列與導覽（global.css），藏掉那兩條後留下空帶；鎖定時高度就是畫面。主工具列貼底並考慮 safe-area。
- **出口**（藏了頂列、分頁列、導覽後一定要有路），由 `components/BoardPhoneNav.tsx` 畫、NotesWorkspace 提供內容：
  - 左上 ‹（與復原／重做同一排）＝手機頂列的 ‹（`usePhoneBack`：上一個看過的頁面，沒有就回筆記清單）；
  - 上中「筆記標題 ⌄」開 Sheet：這則筆記的視角分頁（同一份 `ViewTabs`）與原本頂列右上的 ⊟（資訊）⋯（更多）——資訊入口與 ⋯ 收進這個面板；
  - 右上只留「顯示」。
- 標籤頁的白板（沒有筆記標題與頂列那組入口）維持原本行為，不鎖定。
- 守門：`e2e/browser-app/boardPhoneFull.mjs`（真 Chromium、觸控、Pixel 5 深淺色 390×844／320×640）；單元測試在 `boardToolbarRedesign.test.tsx`。

## 手寫筆記變成一本可以加頁的本子（頁面合一 b，2026-11-09）

業主 2026-11-09 定案：鏡頭用原生捲動（PDF 的做法）、手寫筆記改成多頁（存法在 #1358）、白板手形工具下筆照規則畫。設計比較在
[step2-design.md](../research/pdf-unify/step2-design.md)。

- **頁面本子** `src/pagebook/`：`PageBook` 只認得頁面信封（`InkPages`），背景是 `(page) => ReactNode` 插槽（不認得 PDF），文字框與圖片層是 `layers`，
  存檔、翻譯、裝置設定都由外殼傳入（邊界守門 `eslint.boundaries.config.js`）。`InkNodeView` 是薄殼：工具列、裝置設定、文字框／圖片層、存檔。
- **固定高度的頁**：每頁 1000 單位寬；第一頁高度＝`notePages` 給的 size（筆跡高度，最少 1400，舊的長頁照舊、不切開筆跡），新頁 1000×1400。
  頁不再往下長（不用 `growPage`、`fitBelow`）；起筆在頁外不畫（每頁自己的繪圖面，頁與頁之間的空隙不收筆）。
  文字框或圖片比筆跡低的舊筆記，顯示時把那頁撐到蓋住它們（`pagesFittingLayers`，只影響顯示）。
- **「＋ 新增一頁」**是最後一頁下面的按鈕（不放進 ⋯）：`withPageAppended`（`@onden/markdown/ink`）在最後加一頁空白頁、把完整的 `order` 寫出，key 用 `randomUUID`，然後捲到那一頁。唯讀不顯示。
- **鏡頭**：一個原生捲動容器；縮放＝頁的 CSS 寬度（fit width＝1，0.5×–4×），縮放時保持游標／雙指／畫面中心那一點不跳走；兩指縮放用 `touchSplit` 的預覽；
  ⌘／Ctrl＋滾輪；甩動（筆或滑鼠拖曳 Hand 工具）用 `glide`；手指一指捲動是瀏覽器原生。
- **每頁一個引擎，只有畫面附近的頁才有**：`PageInkSurface`（PDF 也用同一份）；其他頁顯示 `PageInkSvg`。引擎被收掉時先把內容交回 `InkPageSession`
  （`detach` → 設定好的存檔），不會丟。**筆粗細的差別**：手寫頁的筆粗細是頁面單位（筆跡隨紙縮放，和以前一樣），PDF 是螢幕 px（`penSize`）。
- **復原／重做**作用在最後畫的那一頁（`InkPageSession`，與 PDF 同一套）；文字框與圖片照 `undoTarget`。
- **存檔**：任何一頁改了，`onPagesChange` 給整份 `InkPages`；`persistInkPages` 用 `noteDoc` 寫回，第二頁以後在 `morePages`。離開頁面（`onPageHide`）時 `keepalive` 存檔。
- **行為改變**：唯讀的筆記不再有引擎，所以滑鼠拖曳平移（Hand）在唯讀時沒有，捲動、縮放、滾輪照常；筆的畫布不再是視窗大小的分塊，而是頁面大小（`cappedPixelRatio` 限制像素），
  高頁在高倍放大時比較模糊（已接受）。引擎的「頁面往下長」模式（`growPage`、`fitBelow`、`onPageHeightChange`）已沒有宿主，只剩引擎測試在用，下一步清掉。

## PDF 筆記換到頁面本子上（頁面合一 c，2026-11-09）

接在 b 之後；設計比較與取捨在 [step2-design.md](../research/pdf-unify/step2-design.md)。PDF 與手寫筆記現在是同一個 `PageBook`，縮放、捲動、兩指、甩動只有那一份。

- **本子不認得 PDF**：PDF 每一頁是本子的一頁，key `pdf:<n>`、背景 `{kind:"pdf", page:n}`、大小 1000×1000·h/w（`pdfPageRecord`，h/w 取 pdf.js 該頁 viewport，含頁面旋轉），頁序照 `inkPageOrder`。
  頁的畫面是外殼傳進 `background` 插槽的 `PdfPageBackground`（`components/pdf/`）：pdf.js 畫布、`TextLayer` 文字層（可選字、可劃線）、連結層。
  插槽與 `layers` 都拿到頁框大小與「是否在畫面附近」（`PageContext`）；遠的頁放掉畫布像素與文字層。縮放後畫布停手 120 ms 才用新解析度重畫，新畫好才換掉舊的（不閃白）；文字層與連結用百分比與 `--pdf-scale`，縮放不必重畫。
- **頁大小在畫出來之前就知道**：`usePdfPageShapes` 讀完第 1 頁就用它的比例排好所有頁，其餘頁在背景每 24 頁一批讀，比例不同才改（本子在頁大小改變時讓畫面頂端那一點不動，單位是頁面單位，不是比例）；
  所有頁都一樣的 PDF 不會有第二次排版。沒有選「先讀完所有頁」：300 頁要等 300 次 worker 往返才開得了。
- **選取工具下文字層收得到指標**：`PageBook` 的 `tool: InkActiveTool | null`，`null` 時每頁不掛 `PageInkSurface`（Select、Text 工具）；選了手寫工具才掛。手寫筆記唯讀時傳 `null`。
- **幾何契約**：已存的劃線與框選相對「頁面框」量；頁框（`[data-page-key]`）沒有邊框與內距（邊緣改用 `box-shadow` 的細框），寬高等於 viewport 等比例縮放；
  `PageBookApi.pageBox(key)` 給 `capture.ts`／`coords.ts` 用的 viewport。測試 `pdfPageBook.test.tsx` 鎖住同一筆舊劃線在 1×、2×、4× 的位置與舊 viewer 算出的一致。
- **連結**：外部網址只開 http／https／mailto，新分頁、`noopener noreferrer`；文件內連結解出頁碼後 `scrollToPage`。**不再畫表單欄位**（以前的表單欄位可以填，但填的內容從來沒有存檔）；其他註解仍畫在畫布上。
- **行為改變**：一律符合寬度開啟（舊的 pdf.js「auto」在橫向頁會整頁塞進視窗高度、寬螢幕最大 1.25×）；縮放範圍 0.5×–4×（舊 0.25×–5×）；選字後「劃線／→ 卡片」小泡泡的位置記成頁面比例，縮放時跟著文字。
- 刪掉：`PdfViewerHost`（＋css）、`scrollCamera`；不再 import `pdfjs-dist/legacy/web/pdf_viewer.mjs`，文字層需要的 CSS 只留 `.pdf-text-layer` 那一部分（`PdfPageBackground.css`）。

## 手寫頁的「引用一塊區域」（2026-11-12）

使用案例：在手寫頁框一塊、複製，貼到任何筆記的內容，那一塊就活著出現在那裡。資料只有一份（筆畫留在原頁），引用不複製筆畫。

- **單位是一塊矩形區域，不是一組筆畫**：筆畫會被擦掉重寫，區域永遠有效，之後在框裡補寫的也會出現（`inkRegionToSvg` 只畫「碰到矩形」的筆畫與形狀，並以矩形當 viewBox 裁切，跨過邊界的只留框內）。
- **語法**：`![[筆記|ink=頁@x,y,w,h]]`，解析與序列化在 `@onden/markdown` 的 `inkRegion.ts`（`parseEmbed` 多回 `inkRegion`；前端、後端發布、網站共用）。
  放在 `|` 而不是 `#`：Obsidian 的 `![[圖片|100x145]]` 已有「`|` 後帶參數」的慣例；`#` 屬於標題與 `#^id`，會被舊解析器當成找不到的標題而壞掉，
  而 `|` 後面舊版只當標籤，**舊版會退回畫整張圖**。`ink=` 開頭、`@x,y,w,h` 結尾的整段才算區域，其他 `|…` 仍是標籤。
- **頁用 page key**（`page` 或 uuid，`InkPages` 的鍵），不是順序：加頁、換順序都不影響；頁被刪了，嵌入顯示白話「這一頁手寫已經刪除了」。
  座標是頁內單位（頁寬固定 1000，與縮放無關），取整數；夾在頁內，最小邊 `INK_REGION_MIN`（24）。
- **之後轉成錨點是機械式的**：錨點的筆記＝嵌入的目標、種類＝手寫區域、鍵＝page key、位置＝(x, y, w, h)；舊文字的 `|ink=…` 逐一對應成一列錨點即可（這次不建錨點列、不建把手子筆記，不新增資料表或 migration）。
- **畫區域與畫整張圖共用同一份**：`drawDocument(ink, within?)`（`@onden/markdown/inkSvg.ts`）多一個裁切參數；前端 `embedDom.renderDrawing` 多一個 `region`（同一個 figure、配色、「開啟手寫頁」按鈕）。
- **權限與發布**：app 內只用 `nodes`（讀得到的筆記）解析，讀不到＝「找不到」，不露筆畫。發布時 `drawingEmbeds.ts` 與整張圖相同：只有「已發布的筆記」被已發布筆記嵌入才凍結成圖
  （`drawing_regions`，鍵是區域文字）；未發布的由 `redaction.ts` 變成 label 或「(private)」，**區域參數不會當成 label 顯示**。區域裡沒東西／頁不在時什麼都不輸出（沒有 label 時為空），不退回整張圖，也不寫死任何語言的字。
- **同名或標題寫不進 `![[ ]]` 的筆記**用 `onden://node/<id>` 當目標（app 的 `resolveEmbed` 只在有區域時認得）；發布時 `redaction.ts` 先把已發布筆記的 id 改寫成 slug（見下方「審查後補的決定」），未發布的仍是 inert。
- **更新**：本機存手寫、文字框、圖片（`saveInk`、`savePageLayer`）與別台裝置同步來的變化（`announceDrawingChangesOf`）都會讓區域嵌入重畫；同一則來源被引用很多次時共用一次讀取（`drawingChangeSerial`）。
- **工具與輸入**：手寫頁工具列新增「引用」（`QUOTE_TOOL`，引擎端等同 Hand）。筆與滑鼠一律框選；手指只有在「手指也能畫」時框選，「只用筆寫字」時手指照常捲動、縮放。
  一次一個框，可拖四角、拖框身移動；按空白處、Esc、「取消」取消。框旁的「複製引用」是看得見的按鈕，寫入剪貼簿失敗時改顯示那段文字讓人自己複製。
- **點嵌入**：經一般導覽開來源筆記（返回鍵回到原筆記），`inkRegionFocus` 暫存區域，手寫頁開起來後取走一次、捲到那裡並短暫標出。
- **審查後補的決定（同日）**：
  - 純文字讀法（摘要、搜尋片段、反向連結前後文、閱讀時間、AI 面板）一律不顯示區域參數：`splitWikilink` 對區域別名回 `null`（用標題）；以 id 命名時回「✎」（不綁語言）；沒被畫成連結的 `![[…|ink=…]]` 由 `blankInkRegionSyntax` 抹掉。
  - 標題能不能當名字，用解析同一個規則判斷（`titleNamesNote`＝`linkNameTargets`：標題、slug、別名、大小寫、`.excalidraw`）：另一則筆記也能被這個名字找到就改用 id。
  - 發布：以 id 命名且該筆記已發布 → `redaction.ts` 在變 inert 之前先改寫成 slug；未發布仍 inert。頁面上的文字框一起畫進區域圖；插入的圖片只在 app 內畫（SVG 當圖片用時載不到另一個檔案，發布網站不含圖片）。整張圖的嵌入（`inkToSvg`）仍只畫筆畫與形狀，文字框與圖片沒補（它裁到筆畫外框，與「頁」的座標模型不同）。
  - 「有沒有內容」看實際落在區域內的筆跡（輪廓的角或邊進入矩形），不是筆畫的外框；第一頁沒有自己的底邊（它的高度是畫出來的筆決定的，儲存值沒有），其他頁用儲存的大小。
  - 同步進來的變化：`applyAndShow` 之後 `announceDrawingChangesOf(delta)`；本機存檔在儲存結束後通知一次。多個區域嵌入共用同一次讀取與同一份解碼（`inkSvg` 的小快取）。
  - 手指在「只用筆寫字」時不能動框（框與把手的 `touch-action` 讓手指捲動、縮放）；筆碰到這一層也算「看到筆」。來源已經開著時點嵌入，`onInkRegionFocus` 直接捲到區域並標出。
  - 區域嵌入的純文字抹除（`blankInkRegionSyntax`）用 `embedMatches` 找範圍，線性；`bodyParsersLinear` 測試涵蓋長行後接區域、沒收尾的嵌入、很多個 `|ink=`。`plainText` 在「沒收尾的 `![[`＋長文字」上本來就是二次方（與區域無關，main 上就有），不在這個 PR 處理。
  - 匯出 zip 的「檔名≠標題」改寫保留 `|ink=…`（`wikilinksByFileName`）；備份還原讀同一份 `.md`，由別名解回原筆記（未做端到端測試）。
  - 來源是否 404 無法分辨：`reads.notes.attributeValues` 失敗時退回本機副本，所以來源已刪／讀不到顯示「這則筆記沒有手寫內容」或（筆記不在清單時）「找不到」，不是「找不到」一律。
## 任何筆記都能開「手寫」分頁（手寫分頁，2026-11-12）

業主 2026-11-08／09／12：檢視只是看法不同、資料只有一份；手寫是筆記的一個分頁，與「內容」「簡報」「白板」並列，筆畫是這則筆記自己的資料。
設計與契約：

- **存在哪裡**：這則筆記的屬性 `note_ink`（`NOTE_INK_ATTR`，`@onden/markdown` `sharedContract.ts`），格式就是手寫筆記的頁面信封（第一頁是文件本身，其餘在 `morePages`），
  走同一個 codec、`saveInk(nodeId, doc, base, { attr })`、`base_value` 三方合併、離線佇列、ATTRIBUTE_SET 事件與內容定址歷史（`INK_PAGE_ATTRS` 加一個鍵，其餘多是已有的通則）。
  **為什麼不用 `ink_data`**：`OverviewEditor` 看到 `ink_data` 就把「內容」分頁換成手寫頁，文字就看不到了——與 `board_ink` 當初分出來是同一個理由
  （見 [ink-attributes.md](../architecture/ink-attributes.md)）。一個屬性＝一種視角的筆跡。三個屬性各自獨立：`ink_data`（內容是手寫頁）、`board_ink`（白板筆層）、`note_ink`（手寫分頁）。
- **分頁是 `function_refs` 的一列**：layout `"handwriting"`（`HANDWRITING_LAYOUT`），不需要 migration。後端 `modules/handwriting`（`noteViewLayout: true`，沒有 `library`），
  前端 `modules/handwriting` 的 `noteView`（`Pane` 用到才載）。每則筆記最多一個（`useAddView` 的 `firstTabOf`，已有就開啟它）。
- **為什麼 handwriting 仍是內建模組，不是 `library: { alwaysOn: true }`**：它早就是前後端共有的內建模組（筆的設定頁在設定›功能›手寫，`BuiltInModule`）；
  改成 library 模組會讓這個設定頁從功能清單消失（永遠開著的 library 模組不列出）。所以 `BuiltInModule` 多了選用的 `noteView`（含 `title`／`Icon`），
  `NOTE_VIEW_MODULES` 把兩種來源合成同一個清單（`NoteViewModule`）；消費者（分頁、新增檢視、檢視名稱）不用分辨。
- **刪分頁不刪筆畫**：`deleteNoteView` 只移除那一列 `function_refs`；筆畫是另一個屬性，所以再加回「手寫」分頁就看得到（測試 `handwritingTab.integration.test.ts`）。
  這與簡報一致（`slides_data` 也留著）。
- **畫面與共用**：分頁的 `HandwritingPane` 與手寫筆記的內容分頁用同一個 `InkNodeView`（頁面本子、筆、工具列、`inputPolicy`）；存檔的「base／已接受」記帳抽成
  `lib/ink/surfaceSaver.ts`（`useInkSurfaceSaver(attr)`），`OverviewEditor` 與 `HandwritingPane` 共用，不是複製。分頁目前沒有文字框與圖片層（`page_text`／`page_images`
  的頁 key 與手寫筆記的 `page` 會互撞，且不在這批範圍），所以 `InkNodeView` 在沒有文字層時不顯示「文字」工具。
- **跟著筆記走的**：同步（屬性）、歷史（`inkEventSql(…, "note")`，`kind=note` 的 `/ink-edits`、`/ink-versions`；當天卡片的 `DayNote` 沒有第三個欄位，仍算進「編輯過」）、
  備份（側車帶全部屬性；還原時 `handwritingTabOf` 把分頁加回，與 `whiteboardTabOf` 並列）、匯出（`exportInk` 在筆記**還有**手寫分頁時，把 `note_ink` 的頁接在內容之後成為 SVG；分頁拿掉就不匯出——匯出是使用者看得到的東西，完整備份仍帶著筆畫）、複製筆記
  （屬性照複製，`noteDuplicate` 另把「手寫」分頁帶過去）、移到別的空間與刪除／復原（都是節點與屬性本身）。
- **舊種類不提供**：內容已是手寫頁（`ink_data`）或 PDF（`pdf_url`）的筆記，「＋」不列「手寫」（`useAddView` 的 `useHasPageSurface`；已經有的分頁照常顯示），免得一則筆記兩份筆畫、之後的 migration 189 要處理兩份。
- **唯讀**：沒有編輯權限的成員看得到分頁與筆畫，顯示「你可以讀這則筆記但不能修改」（`InkNodeView` 的 `readOnlyNotice`）；「請更新 App」只給格式比較新的圖。
- **AI**：`getNode` 的屬性不含筆跡屬性（`isInkPageAttr`）。
- **不動**：舊的手寫／PDF 筆記種類（之後的 migration 189）；`![[筆記]]` 嵌入（仍顯示文字內容）；選取工具與嵌入（#1527 在改）。

## 手寫存檔量：一筆只送、只存這一筆（2026-11-15）

掃描 09-ink-pdf.md（未隨公開庫附上） S1（PDF 每畫一筆幾乎整份重傳、伺服器每次存檔永久留一份完整副本）。**先量再改**；量測方法與完整表格在
[pdf-ink-save-measure-2026-11-15.md](../research/pdf-ink-save-measure-2026-11-15.md)。結論：PDF 的上傳與三種手寫的儲存都成立；手寫本與白板的上傳本來就只和一筆成正比。

- **上傳**：一筆在 PDF 信封裡寫在四處（舊 `pages[n]`、舊 `annotations` 紀錄、頁面單位的 `units`、`unitsFrom`），文字是單行，`makePatch` 以前只切共同開頭與結尾，
  一筆的 patch 是「那一頁之後的全部」。現在沒有行錨點時改以物件邊界（`},`）當錨點切成多個 hunk（`packages/markdown/src/textPatch.ts`）。只有用戶端做 patch，伺服器照舊套 hunk，**舊版用戶端不受影響、協定版本不動**。
- **儲存**：墨水值每次存檔都存一整份在 `blobs`。現在超過 `INK_CHUNK_THRESHOLD`（192 K 字）的值依內容切成約 8 KB 的區塊存在該筆記自己的 `ink_chunks`，`ink_manifests` 記每次存檔的區塊清單（`services/inkChunks.ts`，migration 203，只新增）。
  事件的 `value_ref` 仍是整份值的 sha256，歷史、「回到這個版本」、復原、patch 基底都照舊以同一個雜湊找值；讀取點（`readInkValues`／`readInkValue`／`readChunkedValues`）兩種格式都讀，舊的整份值不動。
  區塊只屬於一則筆記（不跨筆記共用）：永久刪除時 `ON DELETE CASCADE` 一併帶走，清理不必去查別則筆記是否還用。寫入在存檔的交易內，回滾不留區塊。
- **存檔基底（`lib/ink/surfaceSaver.ts` 的 `InkSaver`，手寫、PDF、白板三處共用，白板原本抄了一份）**：
  - M3：後面的存檔是從「前一次被拒絕的存檔」做的，被接受後那些筆會被當成對方刪的。現在偵測到這種情況，等沒有存檔在途時，用伺服器現有的版本當基底把畫面上的筆跡再存一次。
  - M2：另一台存過、伺服器回的是合併值時，下一次存檔先在本機用 `mergeInk` 合併（本機上次存的為基底、伺服器的回答為另一邊），再以伺服器的文字為基底送 patch：沒有第二個請求，也不會因為畫面上沒有別台的筆而把它們當成刪除。
    **不能**直接把伺服器的回答當基底而不合併：畫面（引擎）還看不到別台的筆（M6），下一次存檔就會把它們刪掉。
- M4：從歷史還原手寫版本後 `announceDrawingRestored(nodeId)`，開著的手寫頁／PDF／白板筆層重新載入（`hooks/useDrawingRestoreSerial`）。
- M1：整份請求（值＋基底）超過上限時，以前丟掉基底、伺服器照單全收，另一台的筆被蓋掉。現在先讀伺服器現值、本機合併、以伺服器文字為基底送 patch（`patchedBody.ts` `rebasedOnStored`）；讀不到才退回舊做法。
- **仍然沒有上限、也沒有清理**：區塊與清單隨存檔次數線性增加（清單 32 位元組／區塊，約每存一次 6 MB 的值多 12 KB），歷史版本沒有任何精簡；值本身仍沒有大小上限（只有 nginx 的 20 MB）。要精簡舊版本是刪資料，需要業主同意，見研究文件的選項。
- **備份、還原、搬移工作區**：備份帶的是**當前的整份值**（`node_attributes`），不是區塊，也沒有墨水的版本歷史（`ink_chunks`／`ink_manifests` 在 `backupInventory` 列為「不在備份」）；還原後該筆記第一次存檔就是它自己的區塊。`backupRoundTrip`／`backupHostHop`／`backupRestoreRerun` 的世界產生器（`roundTripArb.ts`）現在有筆記帶超過 192 K 字的 `ink_data`，每趟都要逐字帶回來。還原演練（`scripts/drillInvariants.ts`）多兩個計數與一個結構檢查：區塊與清單的列數不減、事件指到的墨水版本沒有讀不到的。瀏覽器版（PGlite）：`e2e/browser-app/bigInk.mjs` 存兩份超過門檻的墨水、重新整理、備份再還原到另一個空間。本機鏡像（`MIRROR_SCHEMA_VERSION`）不變：墨水不在開機同步裡，沒有改任何同步欄位或 id。
