# 白板是筆記的視角（migration 138）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/boardStore.ts, packages/backend/scripts/restoreCanvasNotes.sql, packages/backend/scripts/restoreFoldedBoards.sql, packages/frontend/src/lib/whiteboardNote.ts, packages/frontend/src/lib/whiteboardTab.ts, packages/frontend/src/lib/boardTree.ts, packages/frontend/src/hooks/useBoardTree.ts, packages/frontend/src/hooks/useBoardTreeSettings.ts

2026-10-27。使用者決定「白板是看筆記的一種視角，不是一種筆記類型」。筆記標題上方的分頁列（內容｜白板｜表格…｜＋，見
[views-as-modules.md](views-as-modules.md)）裡，「白板」是其中一個分頁。

## 資料模型

| 項目 | 之前 | 現在 |
| --- | --- | --- |
| 白板的身分 | `content_nodes.node_type = 'canvas'`（migration 057） | 任何筆記；有「白板分頁」＝有一筆 `layout: "canvas"` 的已存檢視 |
| 卡片位置、顏色、折疊 | `node_positions`，surface = 白板節點 id | 不變：surface = 這篇筆記自己的 id |
| 分區框 | 白板節點的 `_canvas_sections` 屬性 | 不變（掛在這篇筆記上） |
| 連線、手繪 | 以卡片筆記 id 為鍵，不屬於白板 | 不變 |
| 白板的筆層 | 白板節點的 `ink_data` 屬性（與手寫頁共用，見下方） | 這篇筆記自己的 `board_ink` 屬性（migration 172，[ink-attributes.md](ink-attributes.md)）；`ink_data` 只屬於手寫頁與 PDF |
| 分頁紀錄 | 無（白板型筆記永遠是白板） | 筆記的一筆 canvas 檢視（遷移 188 起是 `function_refs` 的一列：`function_id`＝`canvas`、`instance`＝檢視 id，設定在 `config`；對客戶端仍組成節點列的 `collection_views`）；`layout_config.opens_first: true`＝這篇預設用白板分頁打開，`hidden: true`＝分頁被移除（白板與卡片保留） |
| 標籤的白板 | surface = 標籤 id | 不變 |

一般筆記以前的「白板」鏡頭其實是顯示「它出現在的另一張白板」，或另建一個 canvas 節點（舊的 `buildBoardFromChildren`）。
現在白板鏡頭顯示這篇自己的白板；子筆記不再要「建立」，白板會自己把它們攤開（見〈白板自動樹〉，2026-10-29 起舊的「從子筆記建立白板」已移除）。筆記若本身沒有白板、只是別張白板上的卡片，
鏡頭仍顯示那張白板（`canvas_memberships`），行為同前。

`node_type = 'canvas'` 已退役：CHECK 仍允許（舊備份、舊事件還原），但沒有程式再建立它，讀取端把它與「有白板分頁」視為同一回事
（後端 `boardStore.whiteboardNoteSql`、前端 `lib/whiteboardNote.ts`）。

## 誰怎麼建立

- 建立面板／指令面板的「白板」：`POST /api/canvases`（離線佇列照舊）→ 一則 `CANVAS_CREATED`，同一交易建立一般筆記
  ＋白板分頁（`opens_first`），前端立刻以相同形狀樂觀顯示。
- 筆記標題上方「＋ → 白板」：`POST /api/nodes/:id/views`（`layout: "canvas"`）。
- 放卡片、移動、分區：`PATCH /api/boards/:id`，`:id` 可以是任何可寫的筆記（權限＝該筆記的 `write_node`；事件 `CANVAS_UPDATED`）。

## 轉換（migration 138）

每個 `node_type = 'canvas'` 的列（含垃圾桶內的）在一個交易內：`node_type` 改為 `content`、加上白板分頁（`opens_first`；若原本已有
canvas 檢視就保留、取消 `hidden`、補 `opens_first`）。id、標題、`slug`（`canvas-<id>`，舊連結不壞）、內文、父層、空間、標籤、
子筆記、屬性、連線、卡片、`updated_at` 都不動；不寫、不改、不刪 `domain_events`。

被轉換的列記在 `canvas_note_conversions`（node_id、加入的分頁 id、原有的 canvas 檢視、原本的 `collection_views`、時間、`restored_at`）。

### 還原

```
psql "$DATABASE_URL" -1 -f packages/backend/scripts/restoreCanvasNotes.sql
```

對每筆尚未還原、現在仍是 `content` 的紀錄：`node_type` 改回 `canvas`，移除 migration 加的分頁（或把改過的 canvas 檢視換回原樣），
轉換後新增的其他檢視、卡片、編輯都保留；`collection_views` 原本是 NULL 且現在空了就回到 NULL；`restored_at` 填上，所以只會做一次。
還原後 138 的後端仍把 `canvas` 型當白板筆記讀寫；要完全回到舊程式，先回滾後端映像再跑腳本。

還原演練（`docs/agents/deploy.md`）：migration 宣告 `notes_live, notes_deleted, canvases_live, canvases_deleted`（筆記數與白板數對調）；
新增的 `whiteboards_live`、`whiteboards_deleted`（白板型或含白板分頁的筆記）與 `board_cards`（白板上的卡片數）必須維持相同。

## 複本併回（migration 139）

「從子筆記建立白板」（舊 `buildBoardFromChildren`）曾另建一篇同名白板，把整棵子樹（含自己）放成卡片。138 之後它是一般筆記，
和原筆記同名，原筆記是它白板上的一張卡片。139 把這種複本 B 併回原筆記 S；**只有以下全部成立才動**，否則不動：

- B 在 `canvas_note_conversions`（轉換過的白板）、未還原、仍存活；
- 同工作區**恰好一篇**其他存活筆記 S 與 B 標題完全相同，S 是一般筆記（非標籤），且是 B 白板上的卡片；
- B 內文空白、沒有子筆記（垃圾桶內的也算）、沒有標籤、除 `_canvas_sections` 外沒有屬性、沒有連結（edges、pointers）、
  不是任何白板上的卡片、沒有卡片的子白板連結指向它、不是工作區首頁。

併回（同一交易）：B 的卡片搬到 S 的白板（位置、大小、顏色、折疊不變；S 自己那張拿掉；S 已有的同一張保留 S 的）；
S 沒有分區時 B 的分區搬給 S；S 加白板分頁（**不** `opens_first`，仍預設開內容；已有 canvas 檢視就保留並取消隱藏）；
B 軟刪除（`deleted_at`、`deleted_by_event_id`，可從垃圾桶／歷史還原）。不刪任何資料。

**客戶端怎麼收到**：照 [sync-protocol.md](sync-protocol.md)，領域事件是唯一的同步機制。migration 以 `system`／`migration:139` 寫入
（083 已有先例）：B 一則 `NODE_DELETED`、S 一則 `COLLECTION_VIEW_CREATED`（已有檢視則 `_UPDATED`）與一則 `CANVAS_UPDATED`。
delta 對 `NODE_DELETED` 送刪除（本機副本仍是 `node_type: "canvas"` 的列也一樣照 id 刪），對 S 的事件重送 S 並帶出所有牽涉到 S 的
`canvas_memberships`（`replace_for` 含 S，所以搬走的、拿掉的成員關係都會被取代）。不需要清資料或重裝；舊前端同樣靠 delta 看到刪除。

**還原**：記錄在 `board_copy_folds`（B 的全部卡片、搬了哪些、丟掉哪些、分區是否搬、加了哪個分頁或原本的分頁、S 原本的 `collection_views`、刪除事件）。

```
psql "$DATABASE_URL" -1 -f packages/backend/scripts/restoreFoldedBoards.sql
```

對每筆未還原的紀錄：B 仍是該次刪除則移出垃圾桶；仍在 S 的搬移卡片回到 B，丟掉的卡片補回；分區還在 S 就搬回；移除加的分頁（或換回原分頁）。
之後在 S 的編輯、其他分頁、新放的卡片保留；同樣寫事件讓裝置同步；`restored_at` 填上只做一次。

**還原演練**：宣告 `notes_live, notes_deleted, whiteboards_live, whiteboards_deleted, board_cards, notes_gone`（B 離開存活集合、卡片少了被拿掉的自己那張）；
新增 `board_cards_not_self`（不含「筆記放在自己白板上」那張的卡片數）**不宣告、必須相同**，證明只少了自己那張。

**之後不再產生**：給一篇筆記白板只有 `lib/whiteboardTab.ts` 的 `ensureWhiteboardTab`（加分頁／取消隱藏；〈白板自動樹〉移除了 `buildBoardFromChildren`）；白板上把卡片開成子白板改開那張卡片筆記自己的白板分頁。側欄只照父子關係（`lib/sidebarTidy.ts` 不再把卡片列在白板底下）。
後端與前端一起部署：後端 migration 先把資料整理好，前端不再把卡片塞進白板底下、也不再另建複本。

## 舊前端相容

開著幾天的 PWA 仍用舊程式：

- `GET/PATCH/DELETE /api/canvases/:id`、`GET /api/canvases` 對「白板型或含白板分頁」的筆記照舊回 `{id, title, data:{nodes, sections}}`；
  整份 `data` 覆寫仍回 410，不會抹掉卡片。
- `PATCH /api/boards/:id` 接受任何筆記；`GET` 的 `kind` 對筆記一律是 `"canvas"`。
- 舊前端的本機副本仍有 `node_type: "canvas"` 的列；新前端也照白板讀。
- `clientWritesReplay`（舊版建立白板的期望改成「白板型或含白板分頁」）與 `clientReadsDecode` 守這件事。

## 前端

- `lib/whiteboardNote.ts`：`isWhiteboardNote`、`opensOnWhiteboard`。`canvasList`、`useViewOwner`、`useWorkspaceFocus`（預設分頁、
  `decideCanvasView` 的 `ownsWhiteboard`）、`useGraphLayout`、`canvasWriter.create` 都改用它，不再看 `node_type`。
- 預設分頁：沒有使用者選擇時，`opens_first` 的筆記開白板；選了「內容」會被記住（`rememberTab` 的預設分頁參數）。
- 分頁列的白板分頁可像其他分頁一樣移除（只隱藏，白板保留）；伺服器建立的分頁名 `Canvas` 以使用者語言顯示。

## 白板自動樹：以這篇筆記為根展開子筆記

2026-10-29。使用者決定：筆記的白板一打開就有東西，不是一張空畫布。像表格、看板一樣，白板預設把這篇筆記底下的子筆記攤開。

**規則**（純函式在 `lib/boardTree.ts`，排版沿用 `lib/treeLayout.ts` 的 `layoutTree`；元件只接結果）：

| 項目 | 規則 |
| --- | --- |
| 根 | 白板所屬的筆記是根卡片；子筆記、孫筆記…往右一層層排（根在左，直向的手機畫面也排得開），父子之間畫既有的父層連線 |
| 子筆記 | 側欄會列的子筆記（不含標籤列與隱藏筆記）；看不到的筆記不在 `data.nodes`，自然不出現；`parent_id` 迴圈不會畫兩次 |
| 層數 | 1／2／3／全部，預設 2；每張白板記住自己的選擇（使用者改了才存） |
| 每個節點 | 最多露 8 個子筆記，最近修改（`updated_at`）的排前面；其餘收成一張「+N 篇」卡，點一下再多露 8 個（本次瀏覽狀態，不存） |
| 分支 | 每張卡可單獨收起／展開；收起時顯示底下所有層的筆記總數；展開／收起後版面重排（`layoutTree` 依畫出的卡片重算，不留空位） |
| 總量上限 | 手機 30 張、電腦 100 張（`TREE_CARD_BUDGET`；「+N」卡也算一張）；從根往外一層層（廣度優先）排，滿了就停，後面的分支保持收起並顯示數量 |
| 即時 | 只算不存：子筆記新增、搬走、刪除、改標題時白板自己跟著變；只是打開看不寫任何資料（不建白板分頁、不寫卡片） |
| 點卡片 | 照舊是選取那篇筆記，白板保持開著（`useWorkspaceFocus` 的 `onActiveBoard` 把樹畫出的子筆記算作「在這張白板上」） |
| 沒有子筆記 | 只有根卡片，加一句說明（在筆記裡新增子筆記就會出現在這裡） |

**模式**：

- 「跟著子筆記」（auto）：畫出樹。**空白板與新白板預設 auto**。
- 手動（manual）：只畫使用者自己放的卡片，畫面與以前完全相同。**已經有卡片的舊白板預設 manual**（例如「1.Project」）；白板右上的「跟著子筆記」開關可切換，切換後原有的手動卡片仍在。
- 預設是「第一次看到這張白板時」決定的，之後在同一次開啟中不變：空白板放了一張卡片不會突然變手動，手動白板刪光卡片也不會突然長出樹。第一次寫入 auto 白板時才把 `mode: "auto"` 存起來（`useBoardTree.keepAuto`），跨次開啟也不翻轉。

**資料存在哪裡**：白板分頁（`collection_views` 裡 `layout: "canvas"` 那筆）的 `layout_config.tree`：

```json
{ "opens_first": true, "tree": { "mode": "auto", "depth": 3, "open": ["<筆記 id>"], "closed": ["<筆記 id>"] } }
```

- 後端的檢視 `layout_config` 本來就接受任意鍵（`z.record(z.string(), z.unknown())`），**沒有改後端、沒有 migration**；舊白板沒有 `tree` 鍵就是原樣。
- `open`＝超過層數仍被使用者展開的分支，`closed`＝層數內被使用者收起的分支；只存和層數規則不同的部分，最多各留 300 筆。
- 寫入走 `useBoardTreeSettings`：沒有分頁的筆記先 `ensureWhiteboardTab`（和白板其他第一次寫入相同），再只改 `tree` 鍵、保留 `opens_first`／`hidden`；多次選擇依序送出，每次帶完整設定；離線時有分頁的筆記照一般檢視寫入排隊（建立分頁仍需連線，同既有行為）。
- **拖過的卡片**是一般白板卡片（`node_positions`，surface＝這篇筆記）。`useBoardWorkspace.saveBoardData` 存檔前只留「已存的卡片」與「和樹畫的位置／大小／顏色／折疊不同的樹卡片」，所以沒動過的卡片永遠不寫入、持續自動排；動過的才寫入並保留位置。便利貼、框、手寫、從筆記庫拉進來的卡片照舊，和樹畫在同一張白板上；縮放、折疊、上色、群組、復原都沿用既有操作（它們看到的是「已存卡片＋樹的卡片」合併後的版面，`useBoardTree.canvas`）。

**開啟不寫入**：`decideCanvasView` 對沒有自己白板的一般筆記不再回 `needsBuild`，改為讀取它自己的 id 的白板（`/api/boards/:id` 對任何可讀筆記回空卡片清單）；`buildBoardFromChildren`、`NoBoardYet`（「用子筆記建立白板」）因此移除。離線且本機沒有這張白板時行為同前（`clearOffline`）。

**換中心（暫時瀏覽，不存）**：卡片選單的「以此為中心」（觸控用卡片上方「卡片動作」按鈕開同一個選單）讓白板暫時改以那篇為根展開（`useBoardTree.centerOn`，路徑由 `pathFromRoot` 沿 `parent_id` 補齊）。
白板上方出現返回路徑「根 › … › 目前中心」，點任一段回到那一層（`backTo`），點第一段回到白板自己的筆記。換中心期間：

- 只畫那棵樹（樹的位置，不含已存的手動卡片與分區；回到根後原樣回來）；層數與分支收合沿用同一份設定。
- 卡片不能拖，放卡片、建卡片、分組等會改白板的操作一律不寫入，只提示「先回到白板原本的中心，才能修改」（`useBoardWorkspace` 的 `refuseWhileRecentered`），免得寫進一張看不到的版面。
- 路徑只存在記憶體；換白板、重新載入就回到根；路徑上的筆記被刪掉時，路徑停在還在的那一層。點卡片照舊是選取該筆記（不換中心）。

**未做**：「依樹狀排列」與 `.canvas` 匯出只處理已存的卡片；Delete 鍵對沒存過的樹卡片沒有作用；手機沒有長按卡片的捷徑（用「卡片動作」按鈕）。
