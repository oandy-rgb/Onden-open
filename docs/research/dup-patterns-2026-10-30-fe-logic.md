# 前端「資料處理與規則」的概念重複（2026-10-30）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：`packages/frontend/src` 的 `lib/`、`hooks/`、`components/`、`modules/`、`settings/`。
這份只查、只寫，**沒有改任何程式碼**。`dup:check`（逐字複製）與 `dup:names`（同名匯出）抓不到的，是「同一件事、不同寫法、不同名字」；本報告找的就是這一類。

不重報（已在 [dup-sweep-2026-10-29-frontend.md](dup-sweep-2026-10-29-frontend.md)／cross／backend 或 AGENTS.md 已定案）：
最近更新排序、Blob 下載、hex／SHA-256、`monthId`、`onPageHide`、剪貼簿＋提示（I）、下拉鍵盤（J）、長按（K）、debounce（L）、ResizeObserver（M）、Esc 監聽（N）、手機 sheet（另案）。

行號是 2026-10-30 的 `origin/main`。

## 總表（依「嚴重度高且工作量小」排序）

| # | 概念 | 份數 | 嚴重度 | 工作量 | 守門方式 |
| --- | --- | --- | --- | --- | --- |
| 1 | 「現在／今天」用裝置時區或渲染一次就凍結，沒走 workspace 時區＋`useToday` | 5 處 | 高 | 小 | guard test（`getHours`／`todayId()` 位置） |
| 2 | 子層（兄弟）排序：同一條規則 3 種寫法，已造成 app 與發布站順序可能不同 | 3 份 | 高 | 小 | guard test（`sort_order` 比較式只在 `childOrder.ts`） |
| 3 | 依標題過濾的選單：14 處自己 `toLowerCase().includes`，沒用 `matchTitle` | 14 處 | 高 | 小～中 | ESLint `no-restricted-syntax`＋例外名單 |
| 4 | 筆記沒有標題時顯示什麼：「未命名」76 處各寫、4 種呈現、11 處寫死中文 | 87 處 | 高 | 中（機械式） | ESLint `no-restricted-syntax`＋guard test |
| 5 | 「這篇筆記有白板」：找白板分頁 10 處、「有沒有板」3 種定義 | 10＋3 處 | 中 | 小 | guard test（`layout === "canvas"` 只在 whiteboard 模組） |
| 6 | 「這篇筆記帶有某標籤」：8 處手寫 `class_tag_ids`＋`label_tag_ids` | 8 處 | 中 | 小 | ESLint `no-restricted-syntax` |
| 7 | 沿 `parent_id` 往上／往下走訪（祖先、子樹、深度、路徑）：12 個迴圈、防環各不同 | 12 處 | 中 | 中 | guard test（迴圈裡的 `parent_id`） |
| 8 | 數量複數：沒有複數工具，28 處三元式＋39 處 `(s)` 字串 | 67 處 | 中 | 中 | guard test（字串掃描）＋基準線 |
| 9 | 「清單裡列哪些筆記」的可見條件（hidden／deleted／system／class_tag）：至少 9 種組合 | 14 處 | 中 | 中 | guard test（列出會違規者，先不擋新增以外） |
| 10 | 標籤名去掉前導 `#`：7 處，`/^#/` 與 `/^#+/` 行為不同 | 7 處 | 低 | 小 | ESLint `no-restricted-syntax` |
| 11 | 本機亂數 id 的備援：4 個各寫一份，格式與 `randomUUID` 不同 | 8 處 | 低 | 小 | guard test |
| 12 | 「是不是擁有者」「可寫」規則：3 處不走 `useIsOwner`、2 處抄 `writes()` | 5 處 | 低 | 小 | ESLint＋guard test |

「嚴重度」：高＝使用者現在看得到不一致；中＝可能出現不一致或有效能／正確性風險；低＝維護成本。

---

## 1. 「現在／今天」：裝置時區、渲染一次就凍結

**概念**：UI 要的「今天」「現在幾點」一律是 workspace 的時區與換日時刻（`lib/localDate.ts`：`todayId`、`dateIdAt`、`dayAndClock`；頁面用 `hooks/useToday.ts`，跨過午夜會更新）。

**各自的寫法**
- `modules/capture/QuickCapture.tsx:151-153` `nowTimeString()`：`new Date().getHours()/getMinutes()`，是**裝置**時區。`localDate.ts:89` 的 `dayAndClock()` 已經有 workspace 時區的 `nowTime`，同一檔 `:310` 另一處就用了它。結果：裝置與 workspace 時區不同時（旅行、`TimeZoneAsk` 正是處理這種情況），快速捕捉的預設標題用的是別的時區的時間，但解析「明天 3pm」用的是 workspace 的時間。
- `components/HomeStart.tsx:48`、`components/history/WorkspaceHistoryChanges.tsx:59`、`components/history/WorkspaceHistoryDeleted.tsx:39`：在 render 裡直接 `todayId()`。頁面開著跨過午夜，要等下一次無關的重繪才換日；`useToday` 就是為此而做（只有 6 處用它）。
- `modules/calendar/CalendarLayout.tsx:41` `useMemo(() => new Date(), [])`：整個頁面生命週期凍結一個 `Date`，之後 `:45`、`buildMonthGrid(..., today)` 的「今天」標記不會更新（`:83` 的「回到今天」是另外重新呼叫 `todayId()`，所以兩者會不同）。

**建議的唯一入口**：`lib/localDate.ts`（資料）＋`hooks/useToday.ts`（元件）。`nowTimeString()` 改用 `dayAndClock().nowTime`；三個 render 內 `todayId()` 改 `useToday()`；CalendarLayout 改 `useToday()` 並傳字串或由其推導。

**怎麼擋住**
- guard test（`sources.ts` 的 `findUses`）：`getHours\(|getMinutes\(|getDay\(` 只准在 `lib/localDate.ts`、`lib/workspaceTime.ts`、`components/viewLayoutKit/calendarGrid.ts`（純日曆格運算，已確認不判斷今天）。目前會違規：1 處（QuickCapture:153）。
- guard test：`components/**`、`modules/**` 的 `.tsx` 內不准 `todayId\(\)`（要用 `useToday`）；`lib/`、`.ts` 非 hook 不受限。目前違規：3 處（HomeStart、兩個 WorkspaceHistory*）＋CalendarLayout:83 在事件處理器內合法，需放例外。
- guard test：`useMemo\(\(\) => new Date\(\)` 不准出現。目前違規：1 處。
- 已有的 ESLint `time-through-labels` 只擋 `toLocale*String`／`Intl.DateTimeFormat`，擋不到上面這幾種，所以另補。

**嚴重度**：高（時區不同時使用者看得到時間不一致；跨午夜顯示舊日）。**工作量**：小。

---

## 2. 子層（兄弟）排序

**概念**：同一個父層底下的筆記排序＝`sort_order`，再 `created_at`（後端 `ORDER BY sort_order, created_at`）。`lib/childOrder.ts:12` `compareChildren` 的註解寫「every surface that lists siblings uses this one rule … and the published site」。

**各自的寫法**
- `lib/childOrder.ts:12-14` `compareChildren`：`sort_order ?? 0`，再比 `created_at`；其中一邊沒有 `created_at`（樂觀新增）就視為相等，靠穩定排序保留原位。用於 `OverviewSidebar.tsx:158`、`lib/treeLayout.ts:93`、`lib/data/noteStructure.ts:88`。
- `modules/daily/journal.ts:48` `dayChildren`：自己寫 `sort_order` 再 `(a.created_at ?? "").localeCompare(...)`。缺 `created_at` 的列被當成空字串，**會排到最前面**，與上面「留在原位」不同；而且 `localeCompare` 在 ISO 字串上多餘。
- `components/siteFrame/siteModel.ts:112-113` `bySort`（用於 `:121`、`:233`，發布站的上一篇／下一篇與目錄樹）：`sort_order` 相同時改比 `title.localeCompare(..., "zh-Hant")`，**不是 `created_at`**，與 `compareChildren` 註解宣稱的「published site 也用同一條」不符。同一組筆記在 app 側欄與發布站目錄的順序，只要有兩篇 `sort_order` 相同（新筆記常見，預設都是 0）就不同。

**建議的唯一入口**：`lib/childOrder.ts` 的 `compareChildren`（`PublishedNode` 有 `sort_order`／`created_at` 時可直接用；若發布快照沒帶 `created_at`，先確認再決定是補欄位還是明文說「發布站另一條規則」並改註解）。

**怎麼擋住**
- guard test：`sort_order` 與 `-` 或 `localeCompare` 同行，只准在 `lib/childOrder.ts`（`findUses(files, /sort_order.*(\) - \(|localeCompare)|\? ?\? ?0\) - \(/, ["lib/childOrder.ts"])`）。目前違規：2 處（journal.ts:48、siteModel.ts:113）。
- 同檔把註解那句改成可驗證的測試：`siteModel` 與 `compareChildren` 對同一組輸入輸出相同順序。

**嚴重度**：高（可見的順序差異）。**工作量**：小。

---

## 3. 依標題過濾的選單

**概念**：打字過濾標題。`lib/noteSearch.ts:1-9` 的檔頭寫「One rule for every picker that filters by title」：忽略大小寫、重音、全形半形（`ａ１` 找得到 `A1`），連續比對排在分散比對前面，並回傳高亮範圍（`matchTitle`／`rankByTitle`）。

**各自的寫法**：只有 `DayNoteParentSetting.tsx:41`、`useCommandPalette.ts:343`、`editorCompletion.ts:218/223/227`、`wikilinkTargets.ts:91`、`blockRefSearch.ts:54`、`CommandPalette.tsx:232` 用它。其餘 14 處自己 `toLowerCase().includes(q)`：
- `components/PlacePicker.tsx:56`、`components/ParentCombobox.tsx:38`、`components/CanvasNotePicker.tsx:31`、`components/attributes/RelationFieldEditor.tsx:42`、`modules/tasks/TaskSheet.tsx:83`
- `modules/website/phone/PhoneHomeStudio.tsx:54,89`、`modules/website/studio/fields.tsx:58,104`、`modules/website/studio/blockKinds.tsx:49`
- `components/TagFunctionPicker.tsx:43-44`、`lib/tagTree.ts:128,274`、`lib/agentMentions.ts:102`

差異：打 `cafe` 找不到 `Café`、打 `ａ１` 找不到 `A1`；不能用「縮寫」（`h2` → `Heading 2`）；沒有高亮；排序是原順序而不是「連續者優先」；`ParentCombobox` 用 `(n.title || "")`，其餘直接 `n.title`（標題為 `undefined` 的列會丟例外）。同樣是「移到…」「放進…」「連到…」，不同入口找得到的筆記不一樣。（`hooks/useGraphLayout.ts:181` 搜的是標題＋內文的圖譜高亮，另一件事，不計。）

**建議的唯一入口**：`lib/noteSearch.ts` 的 `matchTitle`（過濾）或 `rankByTitle`（過濾＋排序）。標籤名稱（`tagTree.ts`）用同一個函式即可，它與標題無關。

**怎麼擋住**
- ESLint `no-restricted-syntax`（加在 `SRC_SYNTAX_RULES`）：selector `CallExpression[callee.property.name='includes'] > MemberExpression.callee > CallExpression[callee.property.name='toLowerCase']`，訊息「依標題過濾請用 lib/noteSearch 的 matchTitle／rankByTitle」。因為合法用途很多（內部 key 比對），建議只對 `components/`、`modules/`、`hooks/` 開，並先把上面 14 處列為例外清單，之後只准減。目前違規：14 處（排除 `siteSearch.ts`、`useGraphLayout.ts:181`）。
- 或 guard test 同樣用 `findUses(files, /toLowerCase\(\)\.includes\(/, ALLOWED)`，`ALLOWED` 檔案清單只准減少。

**嚴重度**：高（使用者每天會碰到）。**工作量**：小～中（`rankByTitle` 回傳多一個 `match`，列表要接受；高亮可後做）。

---

## 4. 沒有標題的筆記顯示什麼

**概念**：筆記標題空白時，清單／選單怎麼稱呼它。

**各自的寫法**
- `lib/noteLabel.ts:33` `noteLabel(node)`：標題空白或是占位字（`Untitled`／`未命名`）時，顯示內文第一行（離線也行）。**只有 3 個檔案用它**：`components/OverviewSidebar.tsx`、`lib/data/nodeActions.ts`、定義檔本身。
- 其餘 `title || t("Untitled")` 約 74 處：例如 `components/history/WorkspaceHistoryNoteRow.tsx:45`、`modules/tasks/TaskRow.tsx:52`、`components/InfoTagsTab.tsx:108`、`modules/capture/InboxScreen.tsx:77`、`hooks/useSidebarDrag.ts:398`、`hooks/useBoardWorkspace.ts:328`。同一篇沒標題的筆記，側欄顯示它的第一行文字，歷史、移動、白板路徑、任務卻顯示「未命名」。
- 4 個檢視用另一個字串 `t("(untitled)")`，中文是「（未命名）」（全形括號）：`modules/gallery/GalleryLayout.tsx:87`、`modules/kanban/KanbanLayout.tsx:172`、`modules/table/TableLayout.tsx:195`、`modules/calendar/CalendarLayout.tsx:137,139`。
- 11 處**寫死中文**、不經 `t()`：`modules/website/phone/PhoneHomeStudio.tsx:69,187,188`、`modules/website/phone/phoneHome.ts:45,50`、`modules/website/studio/suggestions.ts:81,92`、`modules/website/studio/fields.tsx:64,71,119,131`。英文介面也會看到「未命名」。
- `lib/utils.ts:21` 匯出用 `"Untitled Page"`（檔案內容，另一件事）；`hooks/useBlockChildNote.ts:107`、`modules/review/index.tsx:72` 用 `?? ""`／`|| ""`（不顯示，合理）。
- 還有「用 id 找標題再 fallback」的小函式各寫一份：`modules/rss/RssReaderPanel.tsx:488`、`modules/website/PublishPreviewDialog.tsx:55`、`components/OverviewEditor.tsx:288`、`hooks/useSidebarDrag.ts:398`、`hooks/useBoardWorkspace.ts:328`、`lib/data/draftActions.ts:588`（最後這個是 `|| text.title || ""`）。

**建議的唯一入口**：`lib/noteLabel.ts`。補兩個很小的出口：`displayTitle(node)`（有 `markdown` 才看第一行，沒有就 `title || t("Untitled")`；一律 `t("Untitled")`）與 `titleOfId(nodes, id)`。把「（未命名）」那 4 處改成同一個 key，並把 11 處寫死中文改走 `t()`（`i18n.zh-TW.ts` 已有 `"Untitled": "未命名"`）。是否要全面用「第一行當標題」是產品決定，先統一出口，再決定要不要打開。

**怎麼擋住**
- ESLint `no-restricted-syntax`：selector `LogicalExpression[operator='||'] > CallExpression[callee.name='t'][arguments.0.value=/^\(?[Uu]ntitled\)?$/]`（以及 `Literal[value='未命名']`），訊息「沒標題的顯示請用 lib/noteLabel」。`noteLabel.ts` 自己放例外。目前違規：約 85 處（76 處 `|| t("Untitled")`／`"(untitled)"`／`"未命名"` 加上用 id 找標題的小函式）；一次全改工作量中，但是機械式、可分三批（modules／components／hooks＋lib）。
- 若暫時不能一次改完：guard test 記錄每個檔案的目前違規數當基準線，只准減。

**嚴重度**：高（同一篇筆記在不同畫面叫法不同；英文介面出現寫死的中文）。**工作量**：中。

---

## 5. 「這篇筆記有白板」

**概念**：白板現在是筆記的一個「檢視分頁」（`layout === "canvas"` 的 saved view，migration 138），舊資料還有 `node_type === "canvas"`。

**各自的寫法**
- 找白板分頁 `views.find((view) => view.layout === "canvas")`：`lib/whiteboardNote.ts:16`（`whiteboardTabOf`，擁有者）、`lib/viewTabs.ts:62`、`lib/whiteboardTab.ts:18`、`lib/boardTreeSettings.ts:54`、`hooks/useBoardTreeSettings.ts:19,37`、`components/viewTabs/useViewTabActions.ts:22`、`hooks/useWorkspaceFocus.ts:97`、`components/viewTabs/useAddView.ts:65`，共 10 處 `layout === "canvas"`。其中 `whiteboardTabOf` 讀 `node.collection_views`，其餘讀 `peekOwnerViews(...)`（另一個快取），兩者來源不同。
- 「有沒有板」三種定義：
  - `hooks/useWorkspaceFocus.ts:93-99` `ownsWhiteboard`：`isWhiteboardNote(node)` **或** 有白板分頁 **或** `canvas_memberships` 有它。
  - `components/viewTabs/useViewOwner.ts:49` `hasBoard`：`node.node_type === "canvas"` **或** 有 `canvas_memberships`；**沒有**看白板分頁。
  - `hooks/useGraphLayout.ts:27` `isBoardOwner`：`node_type === "canvas" || node.id === boardOwnerId`。
  
  一篇「只有分頁、還沒有卡片」的筆記，在 `ownsWhiteboard` 是有板，在 `hasBoard` 是沒有板。
- `components/workspace/NotesCenter.tsx:68`、`lib/newNoteTarget.ts:70` 直接比 `node_type === "canvas"`，沒經過 `isWhiteboardNote`（只認舊類型）。

**建議的唯一入口**：`lib/whiteboardNote.ts`。補一個 `ownerWhiteboardTab(views)`（吃 views 陣列，兩種來源都能用）與 `ownsBoard(node, views, memberships)`，其餘三個「有沒有板」都改用它；`node_type === "canvas"` 只准在這個檔案。

**怎麼擋住**：guard test：`/layout\s*===\s*"canvas"|node_type\s*[!=]==\s*"canvas"/` 只准在 `lib/whiteboardNote.ts`、`lib/viewTabs.ts`（建分頁用）、`lib/whiteboardTab.ts`。目前違規：約 12 處（上列加 `NotesCenter`、`newNoteTarget`、`useGraphLayout`、`useViewOwner`）。

**嚴重度**：中（邊界情況才看得到：有分頁沒卡片）。**工作量**：小。

---

## 6. 「帶有某標籤」

**概念**：筆記同時有 `class_tag_ids` 與 `label_tag_ids`，任何「是不是帶標籤 X」都要兩者都看（`lib/nodeTags.ts:6-9` 註解寫明「needs both」，`nodeHasTag` 在 `:49`）。

**各自的寫法**：手寫一半或兩半
- `hooks/useSidebarDrag.ts:123`、`lib/data/tagWriter.ts:17,18,21,22,40`、`lib/moduleUse.ts:26`：兩個陣列都檢查，但各寫一份。
- `components/OverviewEditorHost.tsx:87`：只看 `class_tag_ids`（意圖是「有 schema 的標籤」，但寫法與上面無法區分，讀者要自己判斷是不是漏了 label）。
- `hooks/useGraphLayout.ts:98`、`hooks/useCommandPalette.ts:373`：`(n.class_tag_ids?.length ?? 0) === 0`，意思是「沒有任何有 schema 的標籤」，也是手寫判斷。

**建議的唯一入口**：`lib/nodeTags.ts` 的 `nodeHasTag`（兩個都看）；需要「只看有 schema 的」就補 `nodeHasClassTag`，名字明說。

**怎麼擋住**：ESLint `no-restricted-syntax`，selector `MemberExpression[property.name=/^(class|label)_tag_ids$/]`（在 `lib/nodeTags.ts`、`lib/data/*Writer.ts`、`storeOps.ts`、`localDb*`、`bootstrapWire.ts` 以外禁止 `.includes`／`.some`）。目前違規：8 處（見上）。

**嚴重度**：中。**工作量**：小。

---

## 7. 沿 `parent_id` 走訪

**概念**：祖先、子樹、是否位於某節點之下、深度、路徑。防環（資料損壞時不能無限迴圈）各自處理。

**各自的寫法**（`parent_id` 出現在 `for`／`while` 條件上的有 12 行）
- 筆記祖先：`lib/noteLocation.ts:12` `noteAncestors`：用 `nodes.find`（每一層掃一次全部，O(n·深度)），已訪問集合包含起點。
- 筆記祖先標題：`hooks/useOverviewSearch.ts:65-75`：自己再寫一次，註解寫「building a path for every note with a scan per ancestor … was quadratic」，改成 `Map`；但它的防環是標記 `cur.id`，若資料有環 A↔B，路徑會把起點 A 當成自己的祖先。`noteLocation.ts` 沒這個問題，但慢。
- 子樹：`lib/utils.ts:38` `getSubtreeIds`（BFS，用 `queue.shift()`）；`modules/website/PublishNoteRow.tsx:92`、`hooks/useWorkspaceFocus.ts:28` 用它。`hooks/useGraphLayout.ts:84` 只取直接子層；`components/OverviewSidebar.tsx:327` `renderItem(..., visited)` 遞迴時自己帶 `visited`；`lib/placeGroups.ts:36` `inTreeOrder` 又自己建 `kids` Map＋遞迴。
- 路徑：`lib/boardTree.ts:180` `pathFromRoot`：用 `up.includes(at)`（陣列）加硬上限 `up.length < 100` 防環；與別處的 `Set` 不同。
- 往上累計：`modules/review/cardsUnder.ts:19`、`lib/data/dayNotes.ts:119`（`dayNotesOutside` 的 `above`）各自寫一次。
- 標籤樹（`Pick<Tag, "id" | "parent_id">`，與筆記同形）：`lib/tagTree.ts:98`（`canMoveTagUnder`）、`:107-115`（`withDescendants`，**對每個標籤各走一次**，最壞 O(n·深度)）、`lib/data/tagPaths.ts:56`（`tagPath`）、`components/tagPage/tagTreeModel.ts:20,22,35`（三個迴圈：`ancestors`、`ancestorIds`、`isBelow`，每次呼叫都重建 `Map`）。`lib/nodeTags.ts:75-85` 的 `memberTagIds` 又是一個子孫 BFS。

差異總結：祖先走訪 7 份，防環機制 4 種（visited Set、`includes`、`length<100`、`depth>8` 見 `siteModel.ts:233`），資料損壞時結果不同；`noteLocation` 與 `tagTreeModel` 在 render 路徑上重複建 `Map`／線性掃描。

**建議的唯一入口**：新建 `lib/treeWalk.ts`（泛型，只吃 `{ id; parent_id }`）：`ancestorsOf(rows, id)`、`subtreeIds(rows, rootId)`、`isUnder(rows, id, ancestorId)`，內部同一套 `Map`＋`Set` 防環，筆記與標籤共用；`getSubtreeIds` 移進去，`utils.ts` 轉出。依 AGENTS.md「新抽象須在本批遷移中實際使用」：第一批遷移 `noteLocation`、`useOverviewSearch`、`tagPath`、`tagTreeModel`、`withDescendants`、`cardsUnder`、`dayNotesOutside`（7 處，全部同形）；`boardTree.pathFromRoot` 與 `placeGroups.inTreeOrder` 語意不同（要根到節點的路徑／依序展開），列為例外。

**怎麼擋住**：guard test：`/(for|while)\s*\(.*parent_id/` 只准在 `lib/treeWalk.ts` 與例外名單（`boardTree.ts`、`placeGroups.ts`、`journal.ts` 的 `groupNodes` 類）。目前違規：12 行，遷移後降到 ≤3。

**嚴重度**：中（目前沒有已知可見錯誤，但有效能與損壞資料風險）。**工作量**：中。

---

## 8. 數量的複數文案

**概念**：「1 篇筆記」「N 篇筆記」的英文複數。`lib/i18n.ts` 的 `t(text, vars)` 只做代換，沒有複數。

**各自的寫法**
- 28 處三元式 `n === 1 ? t("1 new article") : t("{n} new articles", { n })`：`components/ConflictList.tsx`（5）、`lib/taskChips.ts`（3）、`modules/tasks/quickAddTask.ts:39-42`、`components/SidebarTagTree.tsx`（3）、`modules/rss/RssNavIndicator.tsx:21`、`modules/rss/RssHomeSection.tsx:23`、`modules/review/ReviewHomeSection.tsx:34`、`settings/spacesAndMembers/sentences.ts`（2）…
- 39 行（15 檔）用 `(s)` 偷懶：`components/PurgeDeletedModal.tsx:70-74,93,109`、`components/SyncStatus.tsx:28,30,42,77,83,84`、`components/tagPage/MergePanel.tsx:40,42`、`modules/rss/RssReaderPanel.tsx:878`、`modules/capture/QuickCapture.tsx:567`。英文使用者會看到「1 file(s)」「3 change(s)」。
- `modules/rss/RssOpmlWidget.tsx:51-52` 甚至把三元式放進 `t(...)` 參數，兩種寫法並存。
- 同一概念兩種呈現：`SyncStatus.tsx:77`「{n} change(s) waiting to sync」與 `QuickCapture.tsx:567` 同一句，但沒有共用。

**建議的唯一入口**：在 `lib/i18n.ts` 加 `tn(one: string, other: string, n: number)`（英文用 `n === 1`；`zh-TW` 等無複數語言兩者對應同一個譯文；字典 key 維持原有「兩個字串」格式，不用新語法）。第一批遷移 `SyncStatus`、`PurgeDeletedModal`、`MergePanel`、三處 RSS（約 15 處），其餘以基準線只准減。

**怎麼擋住**：guard test：字串掃描 `/t\("[^"]*\((s|es|ies)\)/`（只准減，基準線 39）與 `/(===|!==)\s*1\s*\?\s*t\(/`（基準線 28），並在 `lib/i18n.ts` 以外禁止新增。

**嚴重度**：中（英文介面看得到「(s)」；中文看不到）。**工作量**：中。

---

## 9. 「清單裡列哪些筆記」的可見條件

**概念**：選單／清單要排除：已刪除、被隱藏（`hidden`）、系統機制（`source_type === "system"` 或系統標籤節點）、標籤定義（`class_tag`）、白板節點。`lib/nodeTags.ts:92` `listsAsTagMember` 是標籤成員的唯一規則（`!hidden && !deleted_at && node_type !== "class_tag" && source_type !== "system"`），`lib/systemNodes.ts:41` `isSystemNode` 是系統判斷。

**各自的寫法**（同一件事「挑得到哪些筆記」，條件不同）
- `components/CanvasNotesPanel.tsx:51`：`!hidden`。
- `components/CanvasNotePicker.tsx:30`：`!hidden && node_type !== "class_tag"`。
- `components/attributes/RelationFieldEditor.tsx:37`：`!hidden`。
- `modules/graph/AllCardsGraph.tsx:100`：`!hidden`（圖譜會畫出系統節點）。
- `modules/graph/LocalGraphLens.tsx:35`：`!hidden && !isSystemNode`。
- `modules/rss/RssNotePickSheet.tsx:28`、`RssDestinationFields.tsx:54`：`node_type === "content" && !hidden`。
- `lib/recentNotes.ts:11`：`!hidden && id !== home && node_type === "content"`。
- `lib/newNoteTarget.ts:70`：`!== "class_tag" && !== "canvas" && !isSystemNode`。
- `modules/tasks/TasksMode.tsx:93`：`node_type === "content" && source_type !== "system"`。
- `modules/website/studio/editorData.ts:40`：`content && !hidden && !isSystemNode`。
- `modules/capture/inbox.ts:39,53`、`modules/daily/journal.ts:34`、`lib/data/dayNotes.ts:121`：另外檢查 `deleted_at`。
- `hooks/useCommandPalette.ts:373`、`hooks/useGraphLayout.ts:98`：`!hidden && … && class_tag_ids.length === 0`。

幾乎沒有兩份條件相同：例如 `RssNotePickSheet` 會列出系統筆記，`CanvasNotePicker` 也會；`newNoteTarget` 不會。已刪除的列是否會進 `state.data.nodes` 我沒有逐一證實（同步引擎與 `storeOps` 看起來會移除），所以 `deleted_at` 的差異目前判斷為防禦性，不是實際可見的 bug。

**建議的唯一入口**：`lib/nodeTags.ts` 旁新建 `listsAsNote(node, { board?: boolean })`（或沿用 `listsAsTagMember`，更名成與標籤無關的名字）。先決定「選單選得到哪些」的產品規則，再把上面各處改用它；不要先抽象再猜。

**怎麼擋住**：guard test：`/filter\(\(?\w+\)?\s*=>\s*!\w+\.hidden/` 與 `node_type\s*===\s*"content"\s*&&` 只准在規則檔與例外名單。目前違規：9（`!hidden`）＋約 14（`node_type === "content" &&`）。建議先把這 23 行記為基準線，只准減。

**嚴重度**：中（目前可見差異較小，但每新增一個選單都是新的猜測）。**工作量**：中（要先做產品決定）。

---

## 10. 標籤名去掉前導 `#`

**概念**：使用者打 `#書` 或 `書`，標籤名一律是「書」。`lib/hashtags.ts:32` `tagName(raw)`：`trim → replace(/^#+/, "") → trim`。

**各自的寫法**
- `modules/skills/NewSkillDialog.tsx:24`、`components/ParagraphMenu.tsx:190,192`、`lib/tagTree.ts:123,273`、`lib/editorParagraphActions.ts:93`：`replace(/^#/, "")`，只去一個 `#`。`##書` 在 `tagName` 得到「書」，在這 7 處得到「#書」。
- 順序也不同：`editorParagraphActions.ts:93` 去完 `#` 還額外 `replace(/[{},]/g, "")`，其他沒有。

**建議的唯一入口**：`lib/hashtags.ts` 的 `tagName`。`tagTree.ts` 用的是搜尋字串，可另補 `tagQuery(raw)`（= `tagName(raw).toLowerCase()`）。

**怎麼擋住**：ESLint `no-restricted-syntax`，selector `CallExpression[callee.property.name='replace'][arguments.0.regex.pattern=/^\^#/]`；`lib/hashtags.ts` 例外。目前違規：7 處。

**嚴重度**：低。**工作量**：小。

---

## 11. 本機亂數 id 的備援

**概念**：產生 id。`lib/uuid.ts` 已提供 `randomUUID()`，且 `installUuidPolyfill()` 已把缺少的 `crypto.randomUUID` 補成全域（`bootApp.ts:20` 說明了原因：LAN 的 HTTP 是非安全環境）；所以直接寫 `crypto.randomUUID()` 的 41 處是**設計內**，不算違規。

**各自的寫法**：4 個局部函式又寫了一次檢查，且備援不是 UUID（而是 `前綴-時間-隨機`）
- `lib/ink/engine.ts:130-135` `newId`（`s-…`）
- `lib/pageText/controller.ts:47-50` `randomId`（`t-…`）
- `lib/pageImages/controller.ts:41-44` `randomId`（`i-…`）
- `hooks/useInkPresets.ts:7-10` `newPresetId`（`p-…`）

polyfill 裝上之後，備援分支永遠不會跑（死碼）；萬一跑了，這些 id 會被當成 UUID 送給後端（`isUuid` 驗證）而被拒絕。另外 `hooks/useCanvasActions.ts:300`（`imported-${i}-${random}`）與 `lib/appStore.ts:270` 也是 `Math.random().toString(36)` 的 id，前者只在暫存列用，合理。

**建議的唯一入口**：`lib/uuid.ts` 的 `randomUUID`。這 4 處直接呼叫它；若 id 前綴有意義（辨識來源），保留 `prefix + randomUUID()`。

**怎麼擋住**：guard test：`/typeof crypto !== "undefined" && typeof crypto\.randomUUID/` 只准在 `lib/uuid.ts`；`Math\.random\(\)\.toString\(36\)` 只准在 `lib/uuid.ts`、`lib/blockIdGen.ts`（區塊 id 有固定字元集）、`lib/appStore.ts`（訂閱 token）、`MarkdownRenderer.tsx`（DOM id）。目前違規：4 處檢查＋8 處 `Math.random().toString(36)`（其中 4 處與上面重疊，其餘為例外）。

**嚴重度**：低（死碼＋維護成本）。**工作量**：小。

---

## 12. 擁有者與可寫的判斷

**概念**：UI 顯示控制項的條件要與伺服器同規則。`lib/capabilities.ts` 檔頭寫明「decided in one place」，並說 `actor_is_owner`、`can_review` 「are read only here」。

**各自的寫法**
- `components/TimeZoneAsk.tsx:16`、`components/CreateSheet.tsx:54`、`settings/TimeSetting.tsx:22`：自己 `useAppSelector((s) => s.data.actor_is_owner === true)`，而不是 `useIsOwner()`（`capabilities.ts:71`）。與檔頭「read only here」不符。
- `modules/rss/RssSourceSpaceWidget.tsx:32`、`modules/website/introSite.ts:44`：`space.can_manage || space.permission === "edit"`，這是 `capabilities.ts` 內私有的 `writes()`，兩處抄了一份。若伺服器的 `write` 規則改動，這兩處不會跟著改。
- `settings/FullBackupSetting.tsx:169`、`settings/spacesAndMembers/SpacesAndMembers.tsx:174` 直接 `space.can_manage`，等同 `manages()`。

**建議的唯一入口**：`lib/capabilities.ts`；把 `writes`／`manages` 以 `canWriteSpace(space)`／`canManageSpace(space)` 匯出（後者已在 `Capabilities` 上）。

**怎麼擋住**：ESLint `no-restricted-syntax`：`MemberExpression[property.name='actor_is_owner']` 與 `[property.name='can_manage']` 在 `lib/capabilities.ts`、`lib/spaces.ts`、`lib/api.ts`、`lib/localDb*`、`lib/data/syncEngine.ts`、`lib/workspaceMirror.ts` 以外禁止。目前違規：`actor_is_owner` 3 處、`can_manage` 4 處（含 `SpaceSwitches` 等純顯示者，可能需要例外）。

**嚴重度**：低（目前結果相同）。**工作量**：小。

---

## 已確認乾淨（不需動）

- 日期時間格式化：`lib/timeLabels.ts` 是唯一格式化入口，ESLint `time-through-labels` 擋 `toLocale*String`／`Intl.DateTimeFormat`，grep 只剩 `InfoNoteFooter.tsx:15` 的 `Number.toLocaleString`（數字，非日期）。相對時間只有 `agoLabel`（`Intl.RelativeTimeFormat`）。
- 字數與閱讀時間：`lib/wordStats.ts` 明確委派 `@onden/markdown` 的 `readingMinutes`。
- 反向連結：`lib/edgeRoles.ts` `countsAsBacklink` 是唯一規則，`NoteRelations.tsx:115`、`noteNeighborhood.ts:40` 都用它。
- 檢視分頁：`lib/viewTabs.ts` 一處；僅「白板分頁」見 5。
- 隨機 UUID：`crypto.randomUUID()` 直接呼叫由 polyfill 保證（見 11）。
- 寫入錯誤：`writeErrors.report` 在所有 catch 中一致；沒有找到顯示 `error.message` 的 UI。
- 位元組格式化、顏色轉換：沒有找到各自寫的格式化函式；`isHexColor` 只有 `lib/noteMarks.ts` 在用。
- store 與 `useState` 複製：只有輸入草稿（`TaskSheet.tsx:56`、`CardNode.tsx:99`、`SectionNode.tsx:16`），屬正當用途。

## 建議的守門總設計

**放 ESLint（`no-restricted-syntax`，與既有 `SRC_SYNTAX_RULES` 同一組，改動時照 `eslint-rules.test.ts` 的規定）**：適合「一個語法形狀」且與檔案位置無關的規則。
- 3（`toLowerCase().includes` 過濾標題）、4（`|| t("Untitled")`）、6（`.class_tag_ids/.label_tag_ids` 的 `.includes`／`.some`）、10（`replace(/^#/…)`）、12（`actor_is_owner`、`can_manage` 屬性存取）。
- 例外用 `overrides` 的 `files` 清單，不用行內 `eslint-disable`（行內停用不會被基準線計數）。

**放 guard test（`src/test/guards/*.guard.test.ts`，用 `sources.ts` 的 `findUses`）**：適合「某個寫法只准在某檔案」「有基準線」的規則。
- 1（`getHours`、render 內 `todayId()`、`useMemo(() => new Date()…)`）、2（`sort_order` 比較式）、5（`layout === "canvas"`）、7（迴圈裡的 `parent_id`）、8（複數字串基準線）、9（可見條件基準線）、11（備援 id）。
- 一個新檔 `src/test/guards/rule-owners.guard.test.ts` 收這些「規則只在一處」的守門，每條寫成 `{ 規則, 唯一主人, 允許清單, 為什麼 }`，與既有守門格式一致（失敗訊息指向主人檔案）。

**例外名單怎麼管（只准減少）**
- 每條規則的允許清單是**檔案路徑陣列**（不是行號），放在該守門測試檔內，每一項要寫理由（註解）。
- 清單長度寫成常數，測試斷言「實際違規的檔案集合 ⊆ 允許清單」，**並且**「允許清單裡的每個檔案仍然違規」（遷移完成的檔案一定要從清單刪除，否則測試失敗）——這樣清單只會縮。
- 數量型基準線（8 的 `(s)` 39 行、28 三元式；9 的 23 行）放 `scripts/` 旁的 JSON，沿用 `dup:check` 的 `baseline` 腳本模式（`npm run dup:baseline` 同款指令降低它）。
- 新增例外的唯一方式是在 PR 說明寫理由，由審查擋；不提供自動「接受現況」指令。

**建議的收斂順序（每批一個 PR、一個完整使用案例）**
1. 時間與排序（#1、#2）：小、可見、各自獨立。
2. 標題過濾（#3）＋標籤小項（#6、#10）：同一批，都是 `lib/noteSearch.ts`／`nodeTags.ts`／`hashtags.ts` 的出口。
3. 無標題顯示（#4）：機械式，分三批；先決定「是否採用第一行文字」。
4. 白板（#5）、樹走訪（#7）：各做一個新模組出口，遷移同批使用。
5. 複數（#8）、可見條件（#9）：需先有產品／文案決定。
6. 低優先（#11、#12）：順手。
