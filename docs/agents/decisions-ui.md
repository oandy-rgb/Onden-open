# 邊界決定：介面（側欄與頂欄、指令面板、匯出、選位置、視角分頁、設定、編輯器）

> 狀態：現行（最後確認 2026-11-23）
> 涵蓋：packages/frontend/src/components/AppTopbar.tsx, packages/frontend/src/hooks/useWorkspacePanes.ts, packages/frontend/src/hooks/useUrlLocation.ts, packages/frontend/src/lib/pageScrollRestore.ts, packages/frontend/src/hooks/usePageScrollRestore.ts, packages/frontend/src/hooks/useCommandPalette.ts, packages/frontend/src/hooks/useNoteExport.ts, packages/frontend/src/components/SidebarTagTree.tsx, packages/frontend/src/components/CreateSheet.tsx, packages/frontend/src/components/PlacePicker.tsx, packages/frontend/src/components/viewTabs/**, packages/frontend/src/components/ui/Sheet.tsx, packages/frontend/src/lib/splitViewStore.ts, packages/frontend/src/hooks/useEscapeKey.ts, packages/frontend/src/lib/editorKeyboard.ts, packages/frontend/src/lib/cardDisplay.ts, packages/frontend/src/settings/registry.tsx, packages/frontend/src/modules/review/reviewPlace.ts, packages/frontend/src/components/ui/initialFocus.ts, packages/frontend/src/components/tagPage/FieldPopover.tsx

何時讀：改側欄與頂欄、寫作模式、指令面板、筆記匯出與剪貼簿、移動到…／選位置、筆記與標籤頁的視角分頁、並排、設定頁、編輯器的輸入與鍵盤行為之前。
這份只留今天成立的規則。當時的比較、理由、分批進度與已被取代的做法（原文一字未改）在 [decisions-ui-history.md](decisions-ui-history.md)；
兩邊衝突時以這份與程式為準。節標題被程式註解當名字引用（「視角＋並排」「設定改版」「白板卡片顯示」…），改名前先 `grep`。

## 側欄、頂欄與寫作模式

- **桌面（>900px）頂欄分三段，每頁相同**（`AppTopbar.tsx`、`AppTopbar.css`）：左「Onden」；中是導覽（筆記＋釘選的目的地，放不下的收進「更多」）與搜尋鈕；
  右是頭像、兩格開關、設定齒輪。三段只有自己內容那麼寬，**不跟下面的欄位對齊**，所以拖側欄或資訊欄的邊不會牽動頂欄。
  控制項同高 34px、平常無外框，hover 與「正在用」共用 `--topbar-tint`。手機（≤900px）左邊是頁名，右邊依序是頁面動作、搜尋、頭像；設定在頭像的面板裡。
  同步有問題用頭像上的小標記（`useSyncTrouble`）；頂欄沒有常駐的同步點。
- **兩格開關 `PaneSwitch`**：左格＝筆記列表（`toggleSidebar`、`PREFS.sidebarCollapsed`），右格＝資訊欄（`toggleInspector`、`PREFS.inspectorOpen`）；
  整頁畫面（沒有欄位的頁）與手機沒有開關。資訊欄在 ≥1000px 預設開，使用者關掉就維持關，沒有「常駐」模式。
  快捷鍵：`toggle-sidebar`（`$mod+shift+b`）、`toggle-inspector`（`$mod+.`）、`split-view`（`$mod+\`）、`focus-mode`（`$mod+alt+f`，筆記首頁兩側一起收）。
  新快捷鍵登記在 `lib/shortcuts.ts`；`$mod+b` 是編輯器粗體，不要佔。
- **拖窄到底＝收起**：`PaneResizer` 放開時比最小寬度再窄 `COLLAPSE_DRAG_OVERSHOOT`（48px）就收起那一側，並把存起來的寬度還原成拖曳前的值（再打開回到原寬度）。
  收起的窗格不佔寬度：`fitPaneWidths`／`maxPaneWidth` 以 `ShownPanes` 計算。
- **手機頁面可見性由手機導覽決定**，桌面的收合偏好不影響；偏好讀寫失敗保留當次顯示狀態，不阻止開啟筆記。
- **寫作模式（編輯器的暫時模式）與「收起側欄」是兩件事**：`useZenMode()` 擁有頁面 class、可選全螢幕與退出；不持久化。按鈕、Esc、瀏覽器退出與 unmount 都要還原，
  全螢幕被拒仍可寫作，不退出別人開的全螢幕。PDF 的「放大」由 `useExpandedPane` 擁有。
- **上一頁／下一頁沒有按鈕**。`Alt+←`／`Alt+→`（`nav-back`／`nav-forward`，不含 `$mod`，所以編輯器裡不觸發）與瀏覽器、手機的「‹」是同一件事。
  歷史由 `useUrlLocation` 一個擁有者管：何時 push、何時 replace 的表在該檔檔頭；連結跳轉先經 `openTrailEntry` 標記一筆（序號在 `state.ondenTrail`，
  一次跳轉只記一筆），上一頁／下一頁由序號大小判斷，不靠「目前筆記是不是軌跡頂」猜。軌跡堆疊上限 50（`useWorkspaceFocus`）。
- **上一頁／下一頁回到離開時的捲動位置**（業主 2026-11-18「做」）：位置屬於**歷史紀錄的那一筆**，不屬於筆記——每筆歷史的 `state.ondenEntry` 是唯一 id（每次 push 新一個、replace 保留），
  同一篇筆記在軌跡裡出現兩次就有兩個位置。Back 與 Forward 都放回（`lib/pageScrollRestore`：`markHistoryStep` → `arriveAtScreen`，在版面效果裡先放回再繪製）；
  別的方式打開的筆記（列表、搜尋、面板、連結）從最上面開始（桌面的捲動容器會比筆記活得久，手機的視窗也是，所以開新頁時主動放回 0；2026-11-18 量到過新筆記沿用上一篇的位置），重新載入也是（記憶只在這個工作階段的記憶體，不存儲、不同步、不寫進筆記，上限 50 筆）。
  **明確的目標永遠贏**：要揭露的行（`pendingReveal`）、要找的字（`hasPendingFind`）、游標交接（`hasPendingCursor`）存在時不放回位置。放回位置的筆記，編輯器不再為游標捲動（`scrollClaimedFor`），游標本身不動。
  實測的捲動容器（不是猜的）：桌面是 `.obsidian-main.note-document` 這一個元素（編輯與預覽都是它；`.cm-scroller`、`.obsidian-preview` 在頁面裡不捲動），標 `data-scroll-memory`（`note-edit`／`note-preview`，所以只放回離開時所在的那個檢視）；手機是視窗。
  離開前最後的位置由 `markHistoryStep` 當下讀取（捲動事件可能在畫面換掉之後才送到，那一筆不屬於任何頁面）；其餘靠 `scroll` 事件記錄，換頁的過程中（版面效果到寫入歷史之間）的事件不記。
  並排的右欄沒有自己的歷史，不在範圍；頁籤／檢視切換是 replace，不算上一頁。使用者在放回過程中捲動、按鍵、觸控就立刻停手，最長等 4 秒（本文延後載入、圖片撐高）。
- **「返回」先關最上面那一層**：浮層、面板、模式用 `hooks/useEscapeKey.ts` 的 `useDismiss(onDismiss, open)`，Esc 與返回只關最新登記的；`ui/usePopover`（所有 Menu／Popover／sheet）已內建。
  實作是瀏覽器的 `CloseWatcher`（與原生 `<dialog>` 同一個堆疊、不留歷史）；沒有的瀏覽器 Esc 照舊、返回維持離開頁面。整頁式的詳細畫面（手機資訊頁、RSS 文章）仍用歷史紀錄（`useHistoryEntry`），
  不用 `useDismiss`。只聽 Esc 的例外（取色器、全域 Esc、編輯器尋找列）與手勢類在 `dismissStack.guard.test.ts`，只准變少。需要真機驗：Android Brave（PWA）、Samsung Internet 按返回鍵。

## 指令面板

- **查詢有自己的結果與失敗**：每次開啟／query／重試有獨立身分，晚到或取消的回應不採用；失敗保留查詢並提供重試，不當成「沒有結果」、也不當成建立同名筆記的依據。
- **動作完成後才清空輸入**：`PaletteAction` 可回 `Promise`，`false` 表示領域已拒絕並回饋、面板保留查詢（錯誤由 `reportWriteFailure` 去重）；同步導覽或開表單不延後，避免焦點交接錯亂。
  未接 callback 的指令不能視為已實作。
- 方向鍵、原生按鈕啟動、焦點返回與手機關閉共用同一面板；Enter 啟動前消耗預設行為；可用條件讀目前 context，不捕捉開啟時的快照。新增筆記共用快速捕捉入口。
- 側欄、頂欄開關與設定都在面板（`useCommandPalette`）；「前往標籤」呼叫 `useUiMode().showTags()`。

## 筆記匯出與剪貼簿

- **匯出不隱含保存**：`useNoteExport().exportNote(format)` 與 `copyMarkdown()`（選單與指令面板共用，回 boolean，false 時選單／輸入保留）。
  文件編輯器可見時用它的草稿，其他檢視用節點正文；slim 列必須補讀成功，不能匯成空文；等待期間換筆記或撤權就取消晚到的輸出。
- **排版是後端的唯讀轉換**：`POST /nodes/:id/export-preview` 沿用既有 renderer／主題／安全過濾，沒有寫入、發布或離線重播；舊後端不支援就明確失敗，不退回下載舊正文。前後端要一起部署。
- **單篇 Markdown＝zip 裡那篇**：下載與複製都送 `format: "markdown"`，由後端 `exportedSingleNoteFile` 套 zip 的同一規則；差別只有媒體（單檔改成原伺服器的絕對網址）。
  複製用待定的 ClipboardItem 在手勢內開始寫入（`lib/clipboard`）。
- **結果如實**：剪貼簿接受後才顯示已複製，失敗保留選單並提供 Markdown 下載；PDF 是瀏覽器「列印／另存」，呼叫 print 不等於已存檔，失敗關閉自己開的空視窗；
  媒體仍是引用，單篇匯出不能說成完整離線備份。
- 筆記標題列 ⋯ 只列 `NOTE_HEADER_ACTIONS`（歷史、複製一份、複製 Markdown、匯出、顯示、文字樣式、刪除）；`noteActionList` 是「哪些動作成立」的唯一來源，標題列、側欄選單、⌘K 共用，
  不各自組屬性寫入（釘選、顏色走 `lib/data/noteMarkActions`）。手機 ⋯ 是底部選單（`Menu` 的 `sheet`）。模組的筆記指令不在 ⋯，在資訊欄「功能」。

## 側欄的標籤、建立與拖放

- **標籤與筆記一個入口、兩側**：`SidebarTagTree` 同時是手機筆記首頁的「標籤」分頁（`placement="tab"`）與桌面側欄筆記樹下方可收合的「標籤」區（`placement="section"`，開關 `PREFS.sidebarTagsOpen`）；
  列、選單、排序、隱藏都在這一份。手機分頁為「標籤｜筆記」，記在 `PREFS.sidebarPane`；預設底部列只釘「任務」（`DEFAULT_PHONE_PINS`）。標籤不是導覽目的地。
- 列只列標籤階層，▸ 只展開子標籤；點名稱開標籤頁；右側是直接套用數（`directTagUsage`）：**筆記數加段落數**（業主決定 2026-11-19，與標籤頁分開列筆記與段落的方式一致）——標籤直接掛在筆記上算一個，直接掛在段落上也各算一個，所以一則裡 5 段帶同一標籤算 5，不等於「幾則筆記」；只掛在段落上的標籤不算「沒在用」。段落數是伺服器目錄的 `block_usage_count`。排序每層同規則（`pinnedThenUsed`）：釘選 → 用量多到少 → 名稱。
  篩選框只在標籤多於 `TAG_FILTER_THRESHOLD`（12）時出現。右鍵／長按選單：釘選、從側欄隱藏、重新命名、刪除（`TagDeleteConfirm`）、在裡面新增；重新命名與刪除只給擁有者。
- **釘選與隱藏跟著帳號**：偏好 `sidebarTags`（`services/actorPrefs.ts`），同步機制在 `lib/syncedPrefStore.ts`（本機副本立即生效、離線補送、有未送出的編輯時本機勝出）。
  側欄隱藏只是不列出，標籤照常運作，與標籤自己的「隱藏標籤」（擁有者、全工作區）是兩件事，後者也算進「還有 N 個隱藏的標籤」。
- **拖放**：筆記拖到標籤列＝加標籤（`useSidebarDrag` 的 `data-sb-tag-id`，走 `tagWriter.apply`，放開後附「復原」）；標籤拖到另一標籤＝移到它底下，先經 `TagMoveConfirm`，
  `canMoveTagUnder` 擋自己、後代與現有 parent，伺服器 `assertReparent` 是最後防線。手機長按是選單，不拖標籤。鍵盤：上下鍵跨筆記樹與標籤區（`NAV_ROWS`），左右鍵展開／收合。
- **一個建立面板**：側欄 ＋ 開 `CreateSheet`（手機底部面板、桌面彈出），類型來自 `lib/createKinds`（`tag` 是 `named`：先命名才建立、同 parent 不可同名、只有擁有者看得到）。
  「新筆記放在」只有一個值（`lib/newNoteTarget.ts`，`PREFS.quickCaptureTarget`），只有 ＋ 用；快速捕捉有自己的落點設定。建立失敗時面板與輸入保留。
- **整理標籤**（沒在用、名稱相近、已移除模組的標籤）在 設定 › 模組（`TagTidy`、`RemovedModuleTags`），不在側欄。
- **一次性提示是帳號層級**：`hintsSeen`（只增不減，寫回時與伺服器取聯集；帳號清單未知時不顯示），前端用 `useHintOnce(id, legacy?)`；舊的裝置旗標一次性搬入後刪除。
  段落標籤用 `{名稱}`，本文的 `#字` 只是文字；提示文案只說真的會發生的事。

## 移動到…與選位置

- **一個選位置的元件**：`PlacePicker`（搜尋在上、依空間分組、搜尋時平鋪、上限 50 列）；選項由 `lib/placeGroups` 決定（`movePlaceGroups`、`newNotePlaceGroups`、`tagPlaceGroup`），
  規則仍是 `placementCandidates`；選擇回報 `{ spaceId, parentId }`，寫什麼由呼叫者決定。`ParentCombobox` 只剩行內與釘選用法。
- **「移動到…」**（`MoveToDialog`）：只列原空間，加上「可移出且可移入」的其他空間（`canMoveOut`／`canMoveInto`）；離線時只有原空間。同空間 → 換上層寫入；
  跨空間 → 先進確認畫面（`spaceApi.previewMove` 的 `MovePreviewSummary`），按「移動」才 `spaceApi.move`，成功後再設上層；409 重新預覽，不自動重送。
  「從上層移出」＝選「最上層」，沒有 `unparent` 動作。
- 建立面板的「放在」是一行按鈕，點下去選擇器**取代**面板內容（桌面 popover 在外面按時會關閉，不能再疊 Modal）。

## 筆記與標籤頁的視角分頁

- **一個元件** `components/viewTabs/ViewTabs`：只負責列出、新增、改名、排序、刪除；開著哪一頁由呼叫者決定（`useWorkspaceFocus.selectTab`）。分頁 key：`content`、`canvas`、或檢視 id（`lib/viewTabs.ts`）。
  網址：`lens=canvas` 是白板，`lens=editor&tab=<檢視 id>` 是檢視，都沒有是內容；切分頁用 replace。白板型筆記的內文本身就是白板，其「白板」分頁不能移除。
- **存在伺服器的檢視記錄**（筆記：`content_nodes.collection_views`，標籤同），順序用 `pin_order`；白板存成 `layout: "canvas"` 的一筆（只記名稱、位置、是否隱藏）。
  後端只放寬「已存檢視版面」（`services/viewLayouts` 的 `isStoredViewLayout`），檢視模組登記的版面清單（同一個檔的 `registerViewLayout`）不變。移除白板分頁＝標 `layout_config.hidden`，卡片與版面不動。
- **分頁列＝頁面的標題列**（電腦與平板）：`.center-lens-bar` 是中欄頂端滿寬的一列，切分頁位置不動，左邊分頁＋「＋」（筆記與標籤頁都有，只有「內容」也顯示），
  右邊兩個插槽 `ViewStrip`：`tools`（目前分頁的按鈕）與 `more`（筆記 ⋯），內容用 `ViewStripEnd` 以 portal 放進去，按鈕仍由各自元件擁有。白板全螢幕保留標題列。
- **手機**：沒有固定標題列，分頁在標題上方（`.phone-view-tabs`，同一個 `ViewTabs`，可左右滑、＋ 在最後）；⋯ 仍在筆記頂列（`NotesMobileTabs`）。
  唯一例外是手機全螢幕白板，保留 `BoardPhoneNav` 的標題抽屜。
- **「頁面是誰」只有一個答案**：`useWorkspaceFocus` 的 `pageNode`／`pageTag`（開著白板時是白板的主人，其餘是選取的筆記或標籤）；`useViewOwner`、分頁列、手機白板抽屜都吃它，
  在白板上點空白、選卡片、加群組都不改變分頁。
- 「＋」只列「設定 › 功能」開著的檢視；缺欄位時不出現灰按鈕，選了之後用白話說明要加什麼欄位。右鍵／長按選單：重新命名、往左移、往右移、刪除（需確認）；
  繼承自父標籤的分頁唯讀；沒編輯權的人看得到分頁但沒有 ＋ 與選單。
- **每篇記住上次停在哪**：`PREFS.noteViewTabs`（帳號分區，節點 id → `canvas`／檢視 id）；從側欄開筆記回到記住的分頁，點目前已開的那篇或跟隨連結一律顯示內文。
- 非內容分頁用整個筆記區寬度（`OwnerViewPane`＝標題＋`CollectionView`，一次只畫一個檢視）；檢視清單由 `lib/ownerViews` 共用。筆記下方「子筆記」只剩簡單清單（`SubNotesList`）。
- **檢視一律可用**：檢視模組（表格、看板、月曆、圖庫）不參與「引入／關閉」（前端 `moduleFilterFor` 一律回 true，後端 `alwaysOn`），要不要用由分頁列的 ＋ 決定；不寫 migration。
- **可拖曳清單與分頁的觸控手勢只有一套**（`lib/touchHold`）：按住 `HOLD_MS` 浮起、移動超過 `HOLD_SLOP` 是拖曳、原地放開開選單；新的可拖曳清單用 `beginTouchHold`／`createTouchPressGuard`，
  不自己寫計時；觸控時分頁不帶 `draggable`。滑鼠可拖、右鍵與 Shift+F10 開選單。
- **「內容」分頁可以移除、從「＋」加回（2026-11-16，PDF 頁面提案步驟 1a，`docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md` 第 2.5 節）**：
  任何筆記都可以。「內容」有兩種樣子：**沒有紀錄**（所有既有筆記）＝內建分頁，排第一個、不能改名，選單有「往左移／往右移」與「移除分頁」；
  **「內容」不一定要在第一個（業主 2026-11-23）**：第一次把它移離最前面（或把別的分頁移到它前面）時建立它的紀錄（顯示、不隱藏、帶新位置，需要連線，離線說一句「第一次移動『內容』分頁需要連線」、什麼都不動），之後照紀錄排；沒離開最前面的移動不建紀錄，其他分頁照舊從 0 編號（`lib/viewTabs` 的 `reorderTabs`、`lib/contentTab` 的 `placeContentTab`）。標籤頁的第一個分頁（清單）沒有紀錄可存，不能移動；
  **有紀錄**（`collection_views` 一列，layout `content`，`CONTENT_LAYOUT` 在 `@onden/markdown/contract`，只給筆記、標籤的檢視會拒絕；一則筆記只有一列）＝照 `pin_order` 排、可移動，
  `layout_config.hidden` 控制顯示——與白板同一個機制，沒有第二套。**名字固定**：存 `"Content"`，畫面一律顯示當下語言的「內容」，不能改名（「＋」、確認訊息、詢問都這樣叫它）。
  移除＝寫一列 `hidden: true`（沒有紀錄就新建一列，需要連線，離線在確認前就擋掉），**不碰文字**，
  所以搜尋、發布、匯出照舊包含它；確認訊息白話寫「文字還在，只是分頁看不見；搜尋、發布、匯出仍然包含它」。唯一看得到的分頁不能移除；
  **「一則筆記沒有別的分頁可顯示時，「內容」不是收起來的」由伺服器保證，「內容」能不能移除也只有伺服器一個答案**（`services/functionRefs` 的 `contentTabRemovable`：還有沒收起來的其他檢視紀錄，或一塊有卡片卻還沒有白板紀錄的白板，或已退役的白板種類；白板紀錄收起來了就不算）。列出檢視的回應帶 `content_tab_removable`，畫面（`buildViewTabs` 的 `contentRemovable`）只讀它，再加「這頁畫得出另一個分頁」（模組關著的紀錄畫不出來）才提供「移除分頁」。寫檢視紀錄的三個函式（`services/functionRefs` 的 `insertView`／`patchView`／`removeView`）在同一筆交易最後都過
  `keepContentTabShowing`，所以建立、複製、備份還原、別台或 MCP 刪掉最後一個分頁都得到同一個結果，客戶端不補請求。那次清掉 `hidden` 與觸發它的寫入在同一筆交易、同一個事件（`COLLECTION_VIEW_*` 對準這則筆記）之下，別台經同步重送的筆記列（`collection_views` 由資料庫現況組成）拿到最後的旗標；事件的復原資料只記被刪的那一列，所以復原那次刪除不會把「內容」再收起來。MCP 的 `queryView` 只認標籤的檢視，「內容」這一列回「view not found」，不會當資料檢視執行。畫面的保底（`buildViewTabs` 沒有任何分頁時顯示「內容」）
  只給「紀錄還在但這台畫不出來」（模組關著）：那是每次算出來的，模組回來就又收起來。`content` 一則一列只靠服務層（`createNoteView` 已有就回那一列並套用要求的 `hidden`），沒有資料庫層的唯一限制；
  事件重播或復原若造出兩列，畫面取第一列、另一列是死列。這筆紀錄的名字不參與檢視名稱是否重複的判斷。
  **已知的不一致**：隱藏的「內容」唯一的另一個分頁是算出來的白板（有卡片、沒有白板紀錄）時，最後一張卡片離開白板不會有任何檢視寫入，存著的 `hidden` 與畫面顯示會不一致，直到下一次檢視寫入（那時 `keepContentTabShowing` 才清掉）；頁面在沒有分頁可畫時會顯示「內容」，所以不會丟東西。
  「＋」在「內容」被隱藏時第一個列出它；加回＝清掉 `hidden`、排最後（`lib/contentTab.ts` `showContentTab`）。
  **分頁順序只有一個擁有者**：`buildViewTabs` 依 `(pin_order, name)` 排（筆記自己那列的檢視是建立順序，`/views` 才依位置）。
  **預設分頁只有一條規則**（`lib/viewTabs.ts` `defaultTabKey`）：開在最前的白板，否則內建「內容」（若在），否則第一個看得到的分頁；
  頁面、分頁列、並排右側都問它（白板分頁自帶 `opensFirst`，舊的白板種類筆記由 `retiredBoard` 帶入，所以每個呼叫者都只傳 tabs）。記住的分頁、瀏覽器歷史、不帶分頁的網址、指令面板「內容」指向被隱藏的「內容」時開預設分頁
  （`useWorkspaceFocus` 一個 effect，到達方式不拘；只在這個工作階段第一次告知一次「文字還在，從＋加回」）；並排的右側同理（`SplitPane`）。
  需要文字落點的動作（反向連結／提及／任務跳到某一行的 `pendingCursor`，搜尋結果與段落引用的 `setPendingFind`；`hasPendingTextJump`／`dropPendingTextJump` 是同一個概念）也走那一個 effect（它只信這則筆記自己的分頁，不讀同一次提交裡還屬於上一則筆記的畫面狀態）：被隱藏就先開預設分頁、問一次「這則筆記沒有內容分頁，要加上嗎？」，
  否、拒絕或人已離開＝丟掉這次跳轉並清掉 `pendingCursor`；唯讀成員不問、不指向「＋」，說「文字被收起來了，你沒有權限把它加回分頁列」（`lib/contentTab.ts`，延後載入）。並排窗格「開在右邊」、側欄拖放等仍寫死開「內容」，並排改寫時一併換掉，這次沒改。
  複製筆記帶著「內容」那一列（連同 `hidden` 與位置）。舊版客戶端不認得這個 layout，會多顯示一個叫「內容」的檢視分頁（不論是否隱藏），
  點開只說「這個檢視的版面不支援」；刪掉它＝刪掉這一列，新版的「內容」就回到內建樣子（文字不受影響）。

## 視角＋並排

- 一個窗格放一個目的地 `PaneTarget`（`lib/splitView.ts`）：`{ kind: "note", id, tab }` 或 `{ kind: "page", mode }`；**左邊永遠是原本的工作區（有編輯器），右邊是目的地窗格**，剛好兩邊。
  開法集中在 `lib/splitViewStore.ts`：`splitDrag`（視角分頁、側欄筆記、導覽列功能、右窗格標頭的拖曳都用它決定落點）與 `requestSplitOpen`；Ctrl／⌘ 點連結開在另一邊；Esc 取消。
- 右邊筆記內容是讀取檢視＋「記一下」（寫入走既有 `rssQuote.appendToNote`）；同一則筆記的內容兩邊都開允許（右邊讀左邊的草稿，不顯示「記一下」）；
  同一個已存檢視或白板、同一個功能頁不能兩邊都開（`panesConflict`，用一句白話拒絕）。並排時資訊欄自動收起（只記這一次）。
- 狀態：帳號偏好 `splitPane`（`follows: deviceKind`，手機與桌面各存一份）＋網址 `&right=…`，網址優先。
- **手機不並排**：「這台裝置能不能並排」只有一個答案 `canSplit()`（與 `useIsMobile` 同一判斷）；手機不套用 `splitPane` 與 `right=`，也不寫回帳號。
- 未實作的方向（兩邊各自歷史、並排時側欄收成窄條）在提案 [panes-as-pages-2026-11-16.md](../architecture/proposals/panes-as-pages-2026-11-16.md)，沒有業主說開始前不動。

## 資訊欄、標題區與段落工具

- **資訊欄四個分頁**（`lib/infoPanel.ts` 的 `InfoTab`）：功能｜標籤｜關係｜AI；預設由 `initialInfoTab` 決定，手動選的記在 `PREFS.infoPanelTab`。「功能」列的資料型別是 `NoteFunctionRow`（`modules/types.ts`），
  各模組自己提供（`noteFunctionRows`、`noteCommands[].row`），面板不寫 if；網站模組的發布狀態就是它的一列。`noteHeaderAction` 只剩技能模組使用。
  手機（≤900px）的資訊鈕留在標題列，按下去開資訊畫面。
- **這則本身的資訊在筆記上**：字數、閱讀時間在 ⋯ 選單最上面（`NoteStatsBlock`）；標題下一行灰字 `NoteMetaLine`（空間小標籤 `SpaceChip`、唯讀、來源、修改時間、`TitleTagRow`）；
  `NoteEditedLine` 顯示「AI 改過 N 次」。欄位結構屬於標籤，筆記只填值（`NodeAttributesPanel` 沒有自由新增列）。段落跳轉的目錄是內文右側的 `NoteEdgeOutline`（3 個以上標題才出現，手機不顯示）。
- **段落工具只有一份清單**：`lib/toolbarLayout` 的 `PARAGRAPH_TOOLS`；手機格式列、選取列、桌面把手選單都由 `useParagraphPanels().tools` 產生，只決定面板開在哪一側；每顆都能在「設定 › 工具列」開關排序。
  會開面板的按鈕按下時記住段落範圍（`lib/editorParagraphFrame`），面板的動作都作用在記下的範圍。「加標籤」讀 `lib/tagFunctions` 的 `blockFunctions`，不另寫分類。
  桌面的入口是滑鼠旁的單一把手 `ParagraphHandle`（觸控與手機不顯示；唯讀筆記只給讀取類項目）與 `Alt+P`（`paragraph-menu`）。
- **嵌入編輯面板**：編輯器裡 `![[…]]` 的顯示一律是明確動作（方向鍵進該行、行尾細條、手機長按、「編輯嵌入語法」），點嵌入開 `EmbedEditSheet` 編輯來源筆記中被嵌入的範圍
  （`@onden/markdown` 的 `embedEditable`）；保存沿用白板卡片路徑（`useCardDraft`），被拒絕就留在面板並保留輸入；來源不可編輯時唯讀並說明原因。

## 空間與成員（設定）

- 左「空間」右「成員」（人與 AI 角色）互相連動：選空間看誰在裡面、選人看他在哪些空間，權限選單附一句後果；改權限、加入、移出立刻生效並給「復原」提示，刪除空間與移出工作區才確認。
  最上面一句白話（`sentences.ts`）說誰看得到。空間的設定在左欄清單下，工作區層級的人設定在右欄那個人底下。
- 寬版兩欄、窄版兩層，以設定內容區寬度（`TWO_COLUMNS_MIN`＝760px）判斷，不是視窗寬度；兩種版面用同一組 `SpaceList`／`PeopleList`。
- 設定視窗每一頁同樣大（`settingsPageSize.guard.test.ts`）；`Menu`／`Popover` 在 Modal 裡渲染進最上層 Modal（`floatingHost`），否則會被 `<dialog>` 蓋住。用字不露 git／金鑰／id。

## 手機底部 sheet 與輸入

- **手機（≤600px）貼底的面板一律用 `components/ui/Sheet`**（或選單的 `<Menu sheet>`／`<Popover sheet>`）；不自己寫圓角、safe-area、鍵盤處理，外觀記號在 `ui.css` 的 `--ui-sheet-*`；
  守門 `sheet.guard.test.ts`。`steady` 讓高度固定（有搜尋過濾清單的 sheet 一律用）；鍵盤高度由 Sheet 內的 `useVirtualKeyboard` 處理；601px 以上預設置中，貼底用 `desktop="bottom"`。
- **Android 鍵盤讓版面縮小**：viewport 帶 `interactive-widget=resizes-content`（`appShell/head.ts` 的 `KEYBOARD_RULE`，每個 shell 都有）。游標只被**人造成的交易**捲進畫面，視窗縮放、
  鍵盤高度變化、visual viewport 平移永不捲動；擁有者是 `lib/editorKeyboard.ts`（編輯器端）與 `hooks/useEditorKeyboard.ts`（React 端）。iOS 的 visualViewport 只用來擺工具列。
- **焦點、游標落點、捲動都歸編輯器**（`lib/editorTouch.ts` 管落點）：附在編輯器旁的浮層按下去不拿走焦點，共用層做一次（`usePopover` 的 `keepFocus`，表面外的按鈕用 `components/ui` 的 `keepFocus`）。
  守門規則 `fe-keyboard-state`、`fe-focus-steal-guard`、`fe-editor-scroll-margin`（`test/guards/allowlist/fileRules.ts`）。需要真機：Android Brave 按 `/` 選單邊緣不收鍵盤、點最後一行下方游標只落一次。
- **鍵盤分段升起（2026-11-20，Tab S9 的三星鍵盤多一排工具列、升得慢）**：「鍵盤開好了」是鍵盤**大小**（`useVirtualKeyboard` 的 `size`，resizes-content 下 `height` 恆為 0）靜止 250 ms 之後，每次大小變化都重新計時，平移不重算也不捲動；
  之後才做一次「nearest」。檢查 `e2e/browser-app/caretClearOfBar.mjs` 在 Pixel 5 與 1204×714 平板各跑瞬間升起與分段升起（150、+120、+80 px，各隔 300 ms）。
- **統一做法（2026-11-20，業主在 #1931 同意）**：①resizes-content 的瀏覽器上，筆記欄在工具列處結束（`html[data-kb-bar]` 加 `--ac-kb-bar-height`，`global.css` 讓 `.obsidian-main` 的 `margin-bottom` 等於工具列高），
  瀏覽器原生與 CodeMirror 的游標捲動都停在工具列上方；`barClearance` 改成「工具列蓋住捲動區底部多少」＋間隙（`barClearancePx`），捲動區本來就止於工具列時只剩間隙；沒有 resizes-content（iOS）仍用 visualViewport 與 inset。
  ②任何單擊（文字、空白行、最後一行下面）由編輯器放游標並做一次「最近」捲動（`lib/editorTouch`）；長按、雙擊、連結與控制項、輸入法、S Pen 維持原生。
  ③鍵盤打開後的那一次捲動等「捲動區與鍵盤大小連續 6 個影格都沒變」（ResizeObserver＋`size`），不用固定毫秒；一次鍵盤打開只做一次（鍵盤再變大才重做）。實際等待：60 Hz 約 100 ms、120 Hz（Tab S9）約 50 ms、掉到 30 fps 約 200 ms；一次長任務只算一格（延後但不縮短），所以太早做的那次會被之後的大小變化再做一次補正。隨機組合測試的步間停頓取 40／150／300 ms。
  ④`@codemirror/view` 6.43.1 → 6.43.15（它要 `@codemirror/state` ≥ 6.7.0，所以 state 也到 6.7.6，鎖定檔只動這兩個套件；測試環境 happy-dom 要在編輯器更新中把 `selectionchange` 事後送達，見 `test/setup.ts`）。
  ⑤「鍵盤曾開」只屬於它被看到的那次寫字：上一次寫字結束時關掉的鍵盤，不會讓下一次點擊在鍵盤升起前就被當成「鍵盤關了」而離開編輯器（隨機組合測試抓到）。
  檢查 `e2e/browser-app/caretKeyboardMatrix.mjs`：點的位置 × 鍵盤升法 × 尺寸（Pixel 5／1204×714）隨機組合，種子每次隨機並印出，`--seed` 重播；在 main 上紅（種子 424242 九項、種子 7 八項）。
- **寫到底不黏底，由版面幾何達成（2026-11-20，業主：「打字時最下面不要突然塞幾行空白」）**：resizes-content 的瀏覽器（Android 的 Chromium 系與 Firefox；以鍵盤造成的 inset 為 0 判斷，不看瀏覽器名稱）
  **沒有**會出現或長大的結尾空間（電腦沒有觸控工具列，結尾空間照舊在最後一行靠近底部時出現）：筆記欄止於工具列，最後一行捲得到工具列正上方，底部只靠編輯器本來就有的固定 padding（`.md-editor-cm .cm-content` 的 70 px），從載入到最後一個字都不變。
  沒有 resizes-content 的（iOS）才用 `editorEndRoom`，而且只在鍵盤停住時一次放入（大小 = 鍵盤＋工具列，鍵盤本身變大才加大），不再等游標靠近底部才出現，打字中不變；結尾空間的大小不再當作游標的捲動邊距（邊距只取可見高度的三分之一，64–220 px）。
  檢查 `e2e/browser-app/typeAtTheEnd.mjs`（Pixel 5、1204×714 平板、iPhone 視窗；長筆記與短筆記；在最後一行打字加 Enter 十次：頁面高度每次只多一行、最後一行完整在工具列上方）；在 main 上紅（Android 有結尾空間；短筆記第一個 Enter 讓頁面一次多 247 px）。
- **短高度打字版面（2026-11-20）**：寫字、鍵盤開著、可見高度低於 520 px（`SHORT_VISIBLE_PX`；平板橫向鍵盤開著約 364）時，頂欄與筆記的分頁列讓路（`html[data-typing-short]`，`global.css`），
  文字多拿到它們的高度；狀態來自同一個鍵盤擁有者（`useEditorKeyboard`），殼只讀這個屬性，沒有第二個偵測器；游標那行在筆記往下捲過時不動（`keepCaretLineStill`），
  在筆記最上面時文字跟著欄位上移那兩列的高度（頂端之上無處可捲）。返回鍵、編輯器自己的工具列不變。檢查 `e2e/browser-app/shortTypingLayout.mjs`。
- **紙在兩種主題都是白的（2026-11-20，擁有者：「紙應該要白色的吧」）**：手寫頁、PDF 頁、嵌在筆記裡的手繪圖（`styles/embeds.css` 的 `.md-drawing-picture`）、引用的手寫區域，底色是 `--ac-pure-white`（`#fff`，兩種主題相同），
  筆跡用存下來的（淺色主題）顏色畫，**不**反轉；周圍的介面仍跟主題。`lib/ink/color.ts` 的明度反轉只給吃主題的面（白板畫布）。筆預設近黑。守門 `inkPaper.guard.test.ts`；`handwritingTab.mjs` 在深色主題量畫布像素。
- **手寫／PDF 頁與筆工具列在筆記欄置中**：`.view-pane-fill` 左右都是頁面留白（`--ac-page-gutter`）；原本跟表格一樣從 `--view-start` 起算，1204 寬時左邊離螢幕邊 134 px、右邊 24 px。檢查 `handwritingFillsHeight.mjs` 的置中斷言（含 1204×714 側欄開／關）。

## 編輯器的畫法與輸入清單

- **行內符號只淡化不隱藏**，文字本身永遠不改；整塊的東西三種畫法各選一種（都在 `lib/editorRendered.ts` 這一組）：永遠是成品（勾選框 `lib/editorCheckboxes`，點一下走 `taskToggleEdit`）、
  點了才變原文（表格 `lib/editorTables`、嵌入、公式）、只加樣式不換字（提示框 `lib/editorCallouts`）。輸入法組字中（`composingField`）三樣都不新增、移除或替換 widget。新增「畫成品」的東西先選一種。
- **內文的 `#` 永遠只是 Markdown**；段落標籤輸入入口是 `{`（`detectPopupTrigger` 的 `blocktag`）。所有輸入清單（`{`、`((`、`[[`、`@`、`/`）共用 `popupBlockedAt`（`lib/editorCompletion`，讀語法樹：
  程式碼區塊、行內程式碼、公式不跳；```` ```steps ```` 例外；沒關上的行內 `$` 不擋）。建議順序由 `getCompletions` 擁有。
- **小功能**：標題收起只是顯示（`lib/editorFold.ts`，快捷鍵 `Ctrl+Shift+[`／`]` 只綁標題收起，不用 CodeMirror 的 `foldKeymap`，它在 AltGr 鍵盤會吃字；記在 `PREFS.editorFolds`）；
  寫到底不黏底用 `lib/editorEndRoom.ts`，不用 `scrollPastEnd()`；相同字標記與多欄選取（Alt＋拖曳，觸控裝置不啟用）在 `lib/editorSelectionTools.ts`。

## 設定改版

- 手機與電腦同一份清單（`settings/registry.tsx` 的 `TABS`／`LIST_SECTIONS`），每列右邊顯示目前的值（`settings/listValues.ts`，只讀這台裝置）；舊分頁 id 經 `resolveSettingsTab`。
- 設定 › 你的資料有兩列只給擁有者（`ownerOnly`）、都延後載入：「帶到另一台裝置」（`DeviceFileSetting`，製作整個工作區的檔案；要先經 `ReconfirmDialog` 換一次性憑證）與只在瀏覽器版出現的「從另一台裝置帶過來」（`BringSetting`，經 `lib/localOnlyStatus` 的 `bringNotes` 才有）；說明與流程見 [browser-app.md §18](../architecture/browser-app.md)。
  **每個設定只有一個家**：功能自己的設定只在 `module:<id>` 那一頁（`ModuleSettingsPage`）；刪除與重設放在所屬頁最底、紅字（`SettingDef.danger`）；擁有者才能改的控制項對別人停用並顯示鎖頭（`OwnerLock`）。
- 通則：好的預設優先、系統已有的不重做；在用的地方改（筆記字體、大小、寬度在筆記 ⋯ › 文字樣式 `NoteTextStyleSheet`）；一頁約 10–15 項、少用的收進「更多」（`SettingDef.advanced`）；
  選項用看得到結果的方式呈現（`components/ui/Choice` 的 `ChoiceCards`、`Segmented`、`PreviewBlock`，每頁一個預覽，下拉只給長清單）。新設定照這份放，不另開第二套。
- 偏好遷移：新設定先讀自己的 key，沒有就由舊 key 推出（`settings/legacyPrefs.ts`），不改寫舊 key。字體：黑體、明體、楷體（`@fontsource/lxgw-wenkai-tc`，依 unicode-range 切片，不進開機 JS）、等寬。
- 守門測試 `settingsSimplified.test.tsx` 走過整個 registry：每個設定都有名稱或關鍵字、對得到所在頁。

## 白板卡片顯示與提醒

- **摺疊規則集中在 `lib/cardDisplay.ts`**（卡片、「顯示」選單、選取列、樹狀排列都讀它）：這張卡片自己的選擇 > 舊的 `card.folded` > 白板的預設（摺起來／展開）；展開內文最高 `BODY_MAX_H`（170 畫布 px），超出淡出並提供「開啟完整筆記」。
  縮遠門檻：zoom ≥ 30% 照摺疊狀態；15%–30% 只畫標題（可關）；< 15% 區塊內卡片隱藏、只留區塊標題。「摺起來／展開」只指卡片內文，樹狀分支叫「收起／展開子筆記」。
- **放上別人看不到的筆記先提醒放的人**：既有筆記上白板只有一個主人 `useBoardWorkspace` 的 `placeExistingNote`，先問 `lib/boardCardAudience`（權限判斷只來自伺服器 `spaceApi.previewMove`，前端不另算；離線不擋放置）；
  提醒用與側欄拖到別的空間同一個 `MoveToSpaceConfirm`。看的人那邊不顯示任何東西（「有 N 張看不到」本身就是洩漏）。白板上建立的筆記直接建在白板的空間。

## 網站編輯器

- 最外層可直接放內容，版面（`stack`、`sidebar`…）是可選區塊；巢狀規則只有 `allowedAt(place, type)` 一處（`@onden/site` 的 registry，`validateDesign` 與 `designModel` 都呼叫它）。
  發布結果不變：畫的時候 `withImplicitStacks` 把每個最外層內容各自包進預設 `stack`，實際存的資料不含這層，沒有 migration。`@onden/site` 前後端共用，要一起部署。

## 複習按分組練

- 沒有「題組」物件：一組就是一個標籤、或一則筆記與它底下的筆記。選卡規則只有 `modules/review/service.ts` 的 `planSession`；範圍由 `cardsInScope`（`root`／`tag_id`／`untagged`，一次一種）選，
  `GET /api/review/groups?by=tag|note` 每列的到期／新卡數就是 `planSession` 的長度；每日上限仍是全域。AI 的 `reviewQueue` 工具收同樣三種範圍。
- 頁裡的位置是網址的 `m=`（`lib/moduleAddress.ts`，意義由 `modules/review/reviewPlace.ts` 定）；「按標籤｜按筆記」記在 `PREFS.reviewGroupBy`。
- **範圍（業主 2026-11-20「複習應該能按分類複習」）**：複習主頁標題下有「範圍」選擇器（`ReviewScopePicker`），預設「全部」；選項是筆記（連同底下全部，`root`）、標籤（`tag`）、有卡片才出現的「沒有標籤」。
  範圍就是 `ReviewPlace` 去掉 `status`（`ReviewScope`，多一個 `all`），變成請求只經 `reviewPlace.scopeQuery`；佇列、剩餘張數、`/stats`、`/status`（複習狀況）讀同一個範圍，每日上限仍是全域。
  選項與張數就是狀況頁「分組」的列（`GET /api/review/groups`，由 `placeOfGroup` 轉成範圍），所以「練這組」與選擇器開同一個範圍、同一條程式路徑。
  筆記選項＝該筆記底下（含自己）有卡片的最上層筆記（`by=note` 的列），顯示它上面的路徑（如「2.Area › 作業系統」），選項多於八個時出現搜尋。
  最後一次的選擇記在帳號偏好 `reviewScope`（`reviewScopePref`），頁面沒有位址時用它填入位址（不新增歷史項目），所以重新整理與上一頁都保留範圍；狀況頁讀同一個值。
- **標籤範圍（讀取時算，不寫進卡片）**：卡片屬於標籤 T，當它自己、它所在的筆記、或它所在筆記往上任何一層筆記帶有 T（`tagHierarchy.memberTagIds` 的成員標籤也算）。
  只有 `service.ts` 的 `tagScope` 一處；群組列、佇列、`/stats`、`/status` 與「沒有標籤」都經它，所以選擇器的張數等於之後佇列給的張數，一張卡在同一範圍只算一次。
  段落仍不繼承標籤（`block-nodes.md` §5）：這是讀取時的歸類，沒有把標籤寫到任何段落或卡片。

## 對話框的初始焦點

- 有主要文字欄的 `Modal`／`Sheet`，打開時焦點就在那一欄（觸控裝置也一樣，鍵盤會升起：打開表單就是要打字）；只有按鈕的落在第一個**不是 ×** 的控制項；`initialFocus` 仍優先。規則只有一處：`components/ui/initialFocus.ts`，由 `Modal` 在 `showModal()` 之後套用。
- 原因：關閉中的 `<dialog>` 是 `display:none`，`autoFocus` 聚焦不到，`showModal()` 才把焦點給第一個控制項（標題列的 ×）。所以 Modal／Sheet 裡的欄位不必再寫 `autoFocus`（`dialogFocus.guard.test.ts` 擋：開 Modal／Sheet 的檔案不准寫，例外要列理由）。手寫的標題列 ✕ 要展開 `DISMISS_PROPS`（或用 `SheetHeader`），否則焦點會落在它上面。可見性用 `checkVisibility`，CSS `display:none` 的欄位會被跳過。
- **搜尋框在觸控螢幕（`pointer: coarse`）不自動聚焦**，不分底部面板或整頁 Modal（移動到…、放在、選位置、加入既有筆記、設定視窗的「搜尋設定…」）：鍵盤會蓋住一半清單。焦點落在對話框本身（`Modal` 的 `<dialog>` 有 `tabIndex=-1`），點搜尋框才升鍵盤（業主 2026-11-19）。「這個對話框就是要你輸入」的（新增欄位、命名、任務、網址）是一般文字欄，照常聚焦；滑鼠裝置也照常聚焦搜尋框。判斷只在 `initialFocus.ts` 一處，各面板不自己關，也不傳 `initialFocus` 指向搜尋框（`CanvasNotePicker` 已拿掉，改走同一條規則）。打開是為了「看」而不是「填」的對話框（編輯任務 `TaskSheet`），傳 `initialFocus="dialog"`：焦點在對話框本身，不論有沒有欄位、什麼裝置。
- `Popover` 不是對話框，不套用（色盤這類工具面板跳進色碼欄會彈鍵盤）；表單型 Popover 自己在欄位寫 `autoFocus`（它開啟時已顯示，有效）。
- Enter：欄位有內容＝送出；沒有內容＝不做事、不關閉。「新增欄位」先輸入名稱與種類，按「確定」才建立（`tagPage/FieldPopover` 的 `NewFieldBody`），取消不留任何東西。
- 守門：`dialogFocus.guard.test.ts`；行為：`dialogInitialFocus.test.tsx`；`test/setup.ts` 讓測試環境的 `showModal`／`focus()` 像瀏覽器。

## 設計例外與尚未做

- 還沒統一的手勢：`NavLayoutEditor`／`MobileNav` 的 `useLongPress`（按住就開選單、滑鼠也算）與 `useDragReorder`（抓握把立即拖）；要統一須先決定這兩個行為。
- `ESC_ONLY_SURFACES` 與 `ESC_GESTURES`（`dismissStack.guard.test.ts`）只准變少。

> 2026-11-18：標籤頁 ⋯ 選單與筆記動作清單對「在用模組的標籤」不顯示刪除與合併（選單改顯示一句說明），判斷在 `lib/systemNodes.ts` 的 `isTagDefinitionLocked`；命令面板只是多傳一個事實給既有的動作清單。
