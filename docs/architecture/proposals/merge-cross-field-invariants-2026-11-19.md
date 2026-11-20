# 合併後還要一起成立的欄位：逐表盤點與提案

> 狀態：提案
> 完成後：歸檔

審查：note-91（分散式那條線）。採用的規則做完後併進 [stampedMerge README](../../../packages/backend/src/spine/stampedMerge/README.md) 的「跨列規則是視圖」一節。

**2026-11-19 更新（PR「fix/merge-space-follows-parent」，migration 218）**：父層 × 空間、空間刪除 × 裡面的筆記兩列已做，垃圾桶 × 父層只做了規則（`rules/trash.ts`，模擬器裡成立），資料庫那條路只回報、沒有接上（第 1 輪審查第 6 點），做法寫在 README 的「筆記的空間跟著它的樹」「空間的刪除：寫下的與顯示的」兩節；下面的表與提案照當時的盤點留著，只改了那三列的狀態與提案的寫法。這份提案原本寫的「合併寫回時把推導出的 `space_id` 寫進欄位、不蓋標記」照那樣做是錯的（見下表該列）。

## 為什麼要看這件事

合併核心一次只合一個欄位（一個「單位」，`packages/backend/src/spine/stampedMerge/dbUnits.ts` 的 `UNIT_SOURCES`）。
如果某個值只有和另一個欄位放在一起才有意義，合併出來的組合可能是**沒有任何人寫過的**。（父層、排序鍵）已經這樣修過（`rules/place.ts`）。

一個組合違反規則時有兩種壞結果：

- **只有資料庫擋**：這一包整包失敗。之後每一包都帶著同樣的標記，所以兩台裝置**永遠**交換不了。這不是一次失敗，而是卡死。
  不管是 COMMIT 時才檢查的觸發器（`content_nodes_check_space`），還是語句當下就擋的唯一索引，都一樣：一個錯誤就讓整包的交易回滾。
- **哪裡都沒擋**：存進去了，而且兩台都一樣，只是那個狀態在本機寫入時根本做不出來。例如筆記在已刪除的空間裡，或任務「完成」卻沒有完成時間。

## 測出來的結果（`packages/backend/src/test/mergeSpaceParent.integration.test.ts`，migration 218 之前）

migration 218 之後，每一個情境兩種到達順序都收斂、沒有拒收、兩台相同，再交換一輪與空 `have` 整份重送什麼都不改（測試的「now」與「desired」）。下表是修正前的結果。

每個情境都用產品自己的路由做出來，不手寫標記：`PATCH /api/nodes/:id`、`POST /api/spaces/move`、`POST /api/nodes`、`DELETE /api/spaces/:id`、`DELETE /api/nodes/:id` 與永久刪除。
寫完之後，兩台各複製一份，所以兩種到達順序都會跑（A 的包先到、B 的包先到）。每次交換到沒有新東西為止。PGlite 與真 Postgres（本機 16）都跑過，結果相同。

| 情境 | 今天的結果 |
| --- | --- |
| (a) A 把 N 拖到 X 底下（S1 內，只改父層）；B 把 N 搬到 S2 的最上層（父層＋空間）。**A 較晚** | **卡死**。父層的勝者是 A 的 X，空間的勝者是 B 的 S2，組合起來 N 在 S2，父層卻在 S1。兩個方向每一輪都在 COMMIT 失敗：`23514`，`node <N> is in a different space than its parent <X>`。這是資料庫的原始錯誤，不是修改包的拒絕代碼 |
| (a) 同上，**B 較晚** | 收斂：N 在 S2 最上層，A 的「在 X 底下」留成衝突的頭 |
| (b) A 把 C 拖到 P 底下（都在 S1）；B 把 P（連同 B 知道的子樹）搬到 S2 | **卡死**。沒有任何一個單位被兩邊同時寫過，仍然失敗：C 的父層是 P（S2），C 的空間還是 S1。錯誤同上。之後 A 再改一則**無關**筆記的標題，也到不了 B（整包被拒，B 什麼都沒寫） |
| (c) A 把 P 的子樹搬到 S2；B 在 P 底下新建 K（B 那邊還在 S1） | **卡死**。K 帶著建立時的 S1 到 P（S2）底下。錯誤同上，K 永遠到不了 A |
| (d) B 把 P 搬到 S2，A 把 P 搬到 S3（兩種先後都跑） | 收斂：兩次搬動都蓋了整棵子樹的每一列，所以較晚的那次贏每一列 |
| (e1) A 把 N 搬進 S3；B 刪除 S3（B 那邊 S3 是空的） | **兩台悄悄不同，而且沒有任何拒絕**。A 上 S3 還活著、N 在裡面；B 上 S3 已刪除，N 在裡面卻打不開（404）。對照組（只有 B 刪除空的 S3，沒有別的寫入）也一樣：**刪除空間這件事根本沒有傳過去**。已刪除的空間不在讀者的可讀範圍內（`packages/backend/src/spine/spaceAccess.ts:105` `s.deleted_at IS NULL`），包就不送它的列與標記 |
| (e2) A 把 P 丟進垃圾桶（連帶 C）；B 把 C 搬到 S2 | 收斂：C 在 S2 最上層，**而且在垃圾桶裡**。A 的連帶刪除是 C 自己的 `deleted` 單位，B 的搬動沒蓋到它。限制成立，C 也還能從垃圾桶救回 |
| (e2) A 永久刪除 P 與 C；B 把 C 搬到 S2 | 收斂：兩列兩台都不在了。B 的搬動當成晚到的修改還給作者（`rules/trash.ts` `recoverLateEdits`），不是悄悄消失 |

## 逐表盤點

**欄位說明**：

- 「單位」用 `UNIT_SOURCES` 的欄位名。
- 「今天誰擋」指的是**本機寫入**時。
- 「狀態」只有五種：
  - **合成單位**
  - **已是視圖**（寫出檔案）
  - **只有資料庫擋（→可能卡死）**
  - **哪裡都沒擋（→可能悄悄錯）**
  - **不會被破壞**（寫出原因）
- 【測過】：有會失敗的測試。【查過】：讀過程式，附位置。【推論】：沒讀到能證明的程式。

`db/schema.sql` 是 pg_dump 後面接上每個 migration，到 `214_sync_join_source_former` 為止，所以同一個函式可能被後面重新定義。以下位置都是**最後一次**定義。

### workspaces

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 時區與一天開始的時刻 | `time_zone` × `day_start` | 各自檢查（`services/workspaceTime.ts:71-73,100`） | 任何組合都合法 | 不會被破壞（兩者互不依賴）【查過】 |
| 模組的前提：要開一個模組，它需要的模組也要開著 | `off:X` × `off:Y` | `services/workspaceModules.ts:178,183` | 依賴的模組開著、它需要的卻關了 | 已是視圖：讀的時候 `moduleOn` 依前提重算（`workspaceModules.ts:85-88`）【查過】 |
| 要確認一次的模組，開著＝也在 confirmed | `off:X` × `confirmed:X` | `workspaceModules.ts:186-187` | 開著但沒確認 | 已是視圖（同上，`:87`）【查過】 |
| 集合排序、不重複 | 整個集合 | BEFORE 觸發器（schema `workspaces_sets_sorted`）；合併的寫回自己排序 | — | 不會被破壞（`dbUnits.ts` `JSON_SOURCES` 註解）【查過】 |

### spaces 與 space_members

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 個人空間有擁有者；轉成共用時一次改 kind、owner、名稱、開關 | `kind` × `owner` | `services/spaces.ts:466` `orphanPersonalSpace`（同一個 UPDATE） | 一邊轉共用、另一邊沒看過：「personal 但沒有 owner」 | 哪裡都沒擋 →可能悄悄錯【查過寫入／推論後果】 |
| 一個人只有一個活著的個人空間 | `owner` × `kind` × `deleted`（跨列） | 唯一索引 `spaces_one_personal_idx`（schema:2206） | 做不出來：個人空間的 id 由（工作區、本人）推導（migration 201 的 `actors_sync_spaces`，201 也把之前的改成這個 id），兩台建的是同一列；`owner` 只會變成 NULL（`spaces.ts:466`），`kind` 只會從 personal 變 shared，沒有路由刪除或救回個人空間（`spaces.ts:532`）。同一人兩列活著的個人空間需要兩個 id，沒有東西做得出 | 不會被破壞【查過】 |
| 預設空間不能刪 | `deleted` × `is_default`（不是單位） | `spaces.ts:532-534` `deletableSpace` | 不可能：刪除預設空間的寫入在本機就被拒，沒有人寫得出來 | 不會被破壞【查過】 |
| 有活著的筆記就不能刪空間 | `spaces.deleted` × 筆記的 `space`（跨列） | `spaces.ts:600-602` | 一邊刪空間、另一邊搬筆記進去 | 修正前：哪裡都沒擋，而且**刪除根本沒傳**【測過】(e1)、模擬 R2。migration 218 起：刪除會傳；有活著的筆記時空間照樣顯示、刪除留著（README「空間的刪除」）【測過】 |
| 有訂閱源就不能刪空間 | `spaces.deleted` × `rss_subscriptions.space` | `spaces.ts:603-605` | 訂閱源在已刪除的空間裡（讀取時 `modules/rss/sources.ts:99` 過濾掉，變成不會動的訂閱） | 哪裡都沒擋【查過】 |
| 開關的權限（個人空間只有本人能改；發布只有工作區擁有者） | `switch:*` × `kind`／`owner` | `spaces.ts:400,404` | 寫的人當時有權限，轉共用之後的組合沒有人檢查 | 哪裡都沒擋（影響小：對外發布的清單另外過濾個人空間）【查過寫入／推論後果】 |
| 改了會影響誰看得到的東西就要推進 `membership_epoch` | 成員、`switch:external_ai`、`switch:publish`、筆記的 `space` × `workspaces.membership_epoch`（不是單位） | `mutate({ affectsMembership: true })`（`spaces.ts:408-416, 508-509`） | 合併改了可讀集合，epoch 沒推進，客戶端不重核可讀集合 | 哪裡都沒擋（衍生的東西沒跟上）【推論】 |
| 個人空間只有本人一個成員 | `space_members.*` × `spaces.kind` | `spaces.ts:500-501` `setMember` | kind 只會從 personal 變 shared，不會反過來，所以做不出「personal 又有別人」 | 不會被破壞【查過】 |

### content_nodes（筆記與標籤）

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| **筆記和父層、子筆記在同一個空間**（父層是標籤時不算） | `parent` × `space`（本列與父層、子層那幾列） | 延遲觸發器 `content_nodes_check_space`（schema:2287-2317，COMMIT 時）；本機：`services/nodeTree.ts:164-172` `assertReparent`（409 `parent_in_other_space`）、`spaces.ts:285-301` 整棵子樹一起搬 | (a)(b)(c) | 修正前：只有資料庫擋 →**卡死**【測過】。migration 218 起：`space` 是寫下的空間，`space_id` 由樹推導（README「筆記的空間跟著它的樹」）【測過】 |
| 標籤沒有空間；筆記沒有空間時從父層、再從預設空間補 | `space` × `node_type`（不是單位） | BEFORE 觸發器 `content_nodes_derive_space`（schema:2512-2543）。合併時它照樣執行 | 標籤收到一個空間值時，觸發器改成 NULL；兩台做的事一樣 | 不會被破壞【查過】 |
| 外鍵欄位的值在本機找不到那一列時，寫回會變成 NULL | 任何外鍵單位（`space`、`parent`…） | 合併的寫回 `dbUnits.ts:284`（`SELECT p.col FROM 外鍵表 WHERE p.col = v`） | 筆記的空間變 NULL 之後被上一列的觸發器補成父層或預設空間：顯示的值不是任何人寫的 | 哪裡都沒擋（今天整個工作區都會送，所以少見）【查過寫入／推論後果】 |
| 父層的種類：標籤的父層是標籤；筆記的父層不是標籤 | `parent` × 父層的 `node_type`（不是單位、建立後不變） | `services/parentKind.ts:38-46` | 寫父層的那台已經檢查過，而種類不會變 | 不會被破壞【查過】 |
| 模組標籤沒有父層標籤，也不會有標籤掛在它底下 | `parent` × `tag_schema` 的 `key:module`（本列或父層） | `parentKind.ts:60-75` | 一邊把標籤設成模組標籤、另一邊把它搬到別的標籤底下 | 哪裡都沒擋【推論】 |
| 父層不成環 | `parent`（跨列） | `nodeTree.ts:162,175-177` | 兩邊各搬一次就成環 | 已是視圖 `rules/moveCycle.ts`（模擬 R3 在每一步都成立【測過】）。讀取還沒接上這個視圖（README「還沒做的是讀取」） |
| 活著的筆記不在垃圾桶裡的父層底下（D111） | `deleted` × 父層的 `deleted` | `services/nodeTrash.ts:9-13`（丟進垃圾桶時整棵活著的子樹一起；救回時祖先一起回來）；資料庫沒有限制 | 一邊把 P 丟進垃圾桶、另一邊把**早就存在的** N 搬到 P 底下：N 活著、P 在垃圾桶 | 已是視圖：`rules/trash.ts` `trashOrphanedChildren` 讓活著的筆記跟著最近的已刪除祖先；刪的人的 `seen` 只決定通知誰（建立或搬進來的那筆寫入）【測過：模擬 R4】。讀取還沒接上這個視圖 |
| 連帶丟進垃圾桶的一組，靠 `deleted_by_event_id` 一起救回 | `deleted` × `deleted_by_event_id`（不是單位） | `nodeTrash.ts:100-106,456` | 合併寫的刪除沒有這個值，不能整組救回 | 哪裡都沒擋（衍生的東西沒跟上）【查過寫入／推論後果】 |
| 保留標籤不能丟進垃圾桶；同一個 reserved_key 只有一列活著 | `deleted` × `reserved_key` | `services/reservedTags.ts:80-91`；唯一索引 `content_nodes_reserved_key_uq`（schema:1305） | 刪除的寫入在本機就被拒 | 不會被破壞（沒有人寫得出那筆刪除）【查過】 |
| 同一層的標籤不同名 | `title` × `parent` × `deleted`（標籤，跨列） | 唯一索引 `content_nodes_class_tag_workspace_parent_title_uq`（schema:1274）；`services/tagHierarchy.ts:80-112`（409） | 兩台各建同名的頂層標籤 | 臨時探針（沒留成測試）：兩台各用 `POST /api/tags` 建同名頂層標籤，交換之後**沒有**拒收。原因沒追，可能是同名標籤的 id 由名稱衍生。改名或搬動成同名沒有測【推論】 |
| slug 在一個空間的活著的筆記裡不重複 | `title`→slug（不是單位）× `space` × `deleted` | 唯一索引 `content_nodes_space_slug_uq`（schema:2645）；本機寫入撞到時重試 | 合併換標題、換空間、救回時撞號 | 已處理：列層寫回先讓要變的列用暫時的名字，再依 id 決定誰加後綴（`dbRows.ts:231-248`）【查過】 |
| 只有標籤能被設成隱藏 | `hidden` × `node_type` | `services/nodeUpdate.ts:366-373` | 不可能：沒有人能對筆記寫出「隱藏」 | 不會被破壞【查過】 |
| 排序鍵只在設定它的那個父層底下有意義 | `parent` × `sort` | migration 209：改父層的寫入也蓋排序鍵 | 舊父層底下的重排顯示在新父層底下 | 已是視圖 `rules/place.ts`【查過】 |
| 由內文衍生的東西（連結、錨點、任務行、搜尋） | `body` × 衍生的列 | 本機寫入時重算 | 合併進來的內文不重算 | 哪裡都沒擋（README 已列為 2b-2b 的範圍）【查過】 |

### content_nodes.tag_schema（標籤的欄位定義，一鍵一個單位）

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 標籤不能宣告祖先（父層、`extends`）已經有的欄位 | `key:fields` × 別的標籤的 `key:fields`、`parent` | `services/tagFields.ts:105-131`、`nodeTree.ts:181` | 兩邊各在父標籤、子標籤加同名欄位 | 哪裡都沒擋【推論】 |
| 受管理的屬性，`value_type` 跟著欄位的儲存型別 | `tag_schema` × `node_attributes.type`（跨列） | `services/attributeChange.ts:254-334` `retypeGoverned`（每次改管理關係就重算，蓋標記） | 一邊改欄位型別，另一邊寫值 | 哪裡都沒擋【推論】 |
| `extends` 和引用的 `config.source_tag_id` 同步 | `key:extends` × `function_refs.config` 的 `key:source_tag_id` | `services/functionRefs.ts:420,459-467`（同一筆寫入） | 兩邊只改了其中一邊 | 哪裡都沒擋（過渡期的欄位）【推論】 |

### node_attributes（屬性，一列一個鍵）

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 值配得上型別（數字、日期、真假） | `value` × `type`（同一列） | `@onden/markdown` `attributeValue.ts:340-379`；`attributeChange.ts:177-183` | A 寫「abc」（text）、B 寫 5（number），合出值是一邊的、型別是另一邊的 | 哪裡都沒擋【推論：形狀與 place 相同，沒有測】 |
| 任務完成 ⇔ 有完成時間 | `_task_status` 列 × `_task_done_at` 列 | `modules/tasks/update.ts:257-261`（同一筆寫入） | 一邊勾完成、另一邊改回未完成：完成但沒有時間，或未完成卻有時間 | 哪裡都沒擋【查過寫入／推論後果】 |
| 結束時間只跟著開始時間，而且晚於開始 | `_task_until` × `_task_time` | `update.ts:169-175` | 一邊改開始、另一邊改結束：結束早於開始 | 哪裡都沒擋【查過寫入／推論後果】 |
| 提醒跟著任務的日子與時間走 | `_task_remind_at` × `_task_when`／`_task_time` | `update.ts:178-183` | 提醒留在舊的日子 | 哪裡都沒擋（影響小）【推論】 |
| 重複任務完成時做出下一次 | `_task_status` × 下一個任務列 | `update.ts:194-252` | 合併進來的「完成」不會做出下一次 | 哪裡都沒擋（衍生）【推論】 |

### node_tags、node_edges、note_pointers、node_positions

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 套用標籤時展開範本與預設值，並重算型別 | `node_tags.*` × 屬性 | `services/tagMembershipWrites.ts:102-117,158-161` | 合併進來的套用不展開 | 哪裡都沒擋（衍生）【推論】 |
| 檢視模組的標籤不能套在筆記上 | `node_tags.*` × 標籤的 `key:module` | `tagMembershipWrites.ts:106,141` | 一邊套用、另一邊把標籤改成檢視模組 | 哪裡都沒擋（影響小）【推論】 |
| 同一條手動連結（來源、目標、種類）只有一列 | `node_edges.*` × id | 唯一索引 `node_edges_unique_origin_idx`（schema:1548）；本機以鍵 upsert（`services/edgeWrites.ts:46-51`） | 兩台各建同一條連結，id 不同：列鍵是（來源、目標、種類），所以兩台是**同一列**，id 跟著勝出的建立，沒有拒收 | 不會被破壞【測過】：`mergeSpaceParent.integration.test.ts`「the same manual link made on two nodes」。輸的那台原本的 id 不在了，指向它的事件（`EDGE_CREATED` 的 target）在那台指到不存在的 id【推論，影響小】 |
| 只有手動連結會送；衍生的連結不會被刪 | `status` × `origin`（不是單位） | `edgeWrites.ts:58-64` | — | 不會被破壞（`where` 只送 manual）【查過】 |
| 指標的父層與目標是 id 的一部分 | `parent`／`target`（不是單位） | migration 194 | — | 不會被破壞（換父層就是另一列）【查過】 |
| 卡片的位置、外觀 | `x+y`、`width+height+color+folded` | — | — | 合成單位【查過】 |
| 子白板指向一則筆記 | `sub_canvas` × 那則筆記（跨列，沒有外鍵） | `services/boardWrites.ts:102`（只檢查是不是 uuid） | 指到已刪除的筆記 | 哪裡都沒擋（本機也只是 uuid 檢查）【查過】 |

### function_refs、rss_*、external_calendars、actor_module_settings

| 關係 | 單位 | 今天誰擋 | 合併可能做出 | 狀態 |
| --- | --- | --- | --- | --- |
| 掛在一則筆記、一個空間或一個段落，三選一 | `holder` × `space` | CHECK `function_refs_one_holder`（schema:3777） | holder 建立後不會再寫，兩個值都跟著同一個建立 | 不會被破壞【推論】 |
| 同一個掛點、同一個功能、同一個實例只有一列 | `holder`／`space` × `function` × `instance`（跨列） | 唯一索引 `function_refs_holder_unique`（schema:3780） | 兩台各加同一個功能 | 已是視圖 `rules/functionRefs.ts` `mergeDuplicateRefs`（留較早的一列）【查過 README】 |
| 同一個掛點下檢視名稱不重複 | `config` 的 `key:name`（跨列） | `functionRefs.ts:557-561` | 同名的檢視 | 已是視圖 `rules/names.ts` `resolveViewNames`（4.8）；讀取有沒有接上，沒查【推論】 |
| 一個空間裡同一個網址只訂閱一次 | `rss_subscriptions.space` × `url`（跨列，沒有索引） | `modules/rss/subscriptions.ts:69-70` | 重複的訂閱源 | 哪裡都沒擋【查過寫入／推論後果】 |
| 預設父層、預設標籤要活著 | `default_parent`、`default_tags`、`auto_tag` | `modules/rss/destination.ts:16-20`；讀的時候跳過已不在的 | — | 不會被破壞（讀取時本來就容許）【查過】 |
| 靜音的對象：關鍵字或訂閱源二選一 | `keyword` × `source` | CHECK `rss_mutes_one_target`（schema:3240） | 兩欄建立後都不再寫 | 不會被破壞【查過】 |
| 外部行事曆 | — | — | — | 沒有跨單位的關係【查過】 |
| 個人模組設定是整份 JSON 一個單位，服務逐鍵合 | `settings`（整份） | `modules/review/settings.ts:17-34` | 兩邊各改一個鍵：較晚的整份勝，另一份留成頭 | 沒有遺失（留成頭），但兩個改動不會同時生效【推論】 |

## 提案：每一個還開著的關係用哪一種

兩種做法：

- **合成單位**：觸發器把幾欄合成一個單位蓋標記。代價是單位名稱改變，所以要升 `SYNC_DATA_SHAPE_VERSION`，舊的標記也要改寫或換成新的標籤。
- **視圖規則**（`place.ts` 的做法）：兩個單位照舊。顯示的值由各單位的頭用固定規則算出來，輸的寫入留成頭。代價通常是一個 migration，讓相關的寫入用同一個標記蓋所有相關欄位（像 209 對 `sort` 做的）。資料形狀不變。

| 關係 | 提案 | 代價 | 建議 |
| --- | --- | --- | --- |
| **筆記的父層 × 空間** | **非頂層筆記的 `space` 不再是單位，而是推導出來的：空間＝頂層祖先的 `space`**。頂層祖先依合併後的父層找，先套上 4.10 的視圖，避免資料庫裡留著的環沒有頂層。父層是標籤時，自己就算頂層。~~合併的列層寫回把受影響子樹的 `space_id` 照推導寫入，像 slug 跟著標題那樣（`DERIVED_WITH`），不蓋標記。本機寫入照舊（`moveToSpace` 仍然蓋子樹每一列的 `space`）。~~ **照這樣寫不成立**：`space_id` 是 `space` 單位的欄，合併讀它當成既有標記的值、修改包以舊標記的名義送出，同一個標記在兩台說不同的話（#1853 的 `same-stamp-different-content` 那一類）。**做的是**：拆欄。`space` 單位對應新欄 `written_space_id`（人寫下的空間），`space_id` 只放推導值、不是單位；只有寫下的空間改變才蓋 `space`（搬子樹只蓋根）；筆記變成頂層的寫入用當下的空間蓋 `space`；頂層筆記換空間也蓋 `parent`；合併在寫回的最後、套上 4.10 之後推導，涵蓋不在包裡的子孫，本機記結構紀錄、推成員 epoch（migration 218，README「筆記的空間跟著它的樹」）。延遲觸發器留著當最後的保險 | 資料形狀要升版：同一個非頂層筆記的 `space` 標記，新版忽略、舊版照用，兩版會算出不同結果。**既有標記不用改寫**：它們留著，只在那則筆記成為頂層時才有作用；不需要回填。寫回的成本：每包要找出父層或頂層空間變了的子樹，重算一次。另需一個通知：(b)(c) 裡的 C、K 會跟著 P 換空間，可以看到它的人跟著變，搬它的人沒有確認過。結果等於兩個寫入依序發生，但要告訴作者 | **建議**。合成單位（`parent+space`）只修得了 (a)；(b)(c) 是不同列的單位，沒有任何一個單位被兩邊同時寫過，合成也救不了 |
| 空間刪除 × 裡面的筆記 | 先修**刪除不傳**：讀包時，已刪除空間的列與標記要送給握有整個工作區的讀者。分空間的包另外決定，不能洩漏它存在過（README 已提醒）。之後用視圖：空間裡有刪的人**沒看過**的活著的筆記時，`deleted_at` 顯示為未刪除，刪除留成頭，通知刪的人 | 做了（migration 218 第 6 節）：同樣拆欄（`written_deleted_at` 是單位，`deleted_at` 是檢視的結果）。不需要 `meta.seen`：空間裡有活著的筆記，就一定是刪的人沒看過的寫入帶進來的（本機刪不掉有筆記的空間，看過刪除的寫入也放不進去），所以條件只是「裡面有沒有活著的筆記」 | 訂閱源 × 已刪除空間還沒做 |
| 垃圾桶 × 父層（搬進已丟進垃圾桶的父層底下） | 擴充 `trashOrphanedChildren`：除了「刪的人有沒有看過 N 的建立」，也問「有沒有看過 N 的**父層寫入**」。看過的才算刪的人的連帶刪除，沒看過的就跟父層一起進垃圾桶，並通知搬的人 | 規則做了，但改成：活著的筆記一律跟著最近的已刪除祖先，「看過沒有」只決定通知誰（照提案用 `seen` 決定進不進垃圾桶，模擬器仍找得到活著的筆記在垃圾桶裡的父層底下：`seen` 只說刪的人握有被刪那一列的進度，會說得比實際多）。**只在模擬器裡**：資料庫的 `orphansOf` 只看永久刪除的父層、只回報，丟進垃圾桶的父層沒有接上 | 規則已做，資料庫未接 |
| 屬性的值 × 型別 | 視圖：顯示的型別＝和顯示的值同一筆寫入，或看過它的那個型別頭；找不到時依值推斷，或用欄位的儲存型別 | 一個 migration：寫值的觸發器同時蓋 `type`，型別沒變也蓋（同 209） | 建議用視圖（和 place 同一種形狀）。合成單位要升版又要改寫標記 |
| 任務完成 × 完成時間；結束 × 開始 | 視圖：完成時間只在 `_task_status` 的勝者是 done 時顯示。不是同一筆寫入時，用該筆完成寫入的時鐘當完成時間。結束時間只在大於開始時顯示，否則留成頭 | 不同列的單位不能用 `saw` 比先後（README「前提」），所以只能比「是不是同一個標記」：任務的寫入本來就在同一個交易裡，標記相同。不升版 | 建議，放在任務模組的讀取 |
| 空間 kind × owner | 視圖：owner 只顯示和顯示的 kind 同一筆寫入的值；`orphanPersonalSpace` 一次寫兩欄，標記相同 | 不升版；觸發器在 kind 變時也蓋 owner | 建議 |
| （已刪）一人一個個人空間、同一條手動連結兩個 id | 審查要求補測之後：前者做不出來，後者會收斂（見上表），不需要規則 | — | — |
| `membership_epoch`、連帶刪除的 `deleted_by_event_id`、套用標籤的展開、重複任務、`retypeGoverned` | 不是單位之間的關係，是合併沒有做本機寫入順手做的事。寫回時在本機做：只屬於這一台，不跟著傳 | 不升版 | 併進 2b-2b「衍生資料」那一批，同一個機制 |
| 模組標籤 × 父層、欄位定義 × 祖先、`extends` × 引用、RSS 重複網址、檢視模組標籤被套用 | 視圖：在 `rules/names.ts` 那類「找出撞的、通知人」的規則裡回報，不改資料 | 不升版 | 影響小，排在後面 |

### 要不要讓非頂層筆記的 `space` 不再是單位

要，理由如下：

1. 「筆記在父層的空間」本來就是**樹的性質**，不是每一列各自的選擇。本機也是這樣做的：新建時由父層推導（`content_nodes_derive_space`）、搬動時整棵子樹一起改。
2. 只要每一列各自合併，(b)(c) 就一定會出現：沒有任何一個寫入看過另一個，兩個都合法，合起來卻不合法。這不是「兩邊同時改同一處」，所以衝突的頭也表達不了。
3. 推導讓「空間」只剩一個來源：頂層筆記的 `space` 單位。兩台的父層一樣，推導的結果就一樣。

對既有標記的影響：不刪、不改寫。非頂層筆記的 `space` 標記仍然存著、仍然跟著包走。新規則只是不拿它當顯示的值。等它成為頂層筆記（被搬到最上層），那時最新的 `space` 頭才算數。
要升 `SYNC_DATA_SHAPE_VERSION`：舊版節點會照舊逐列合，和新版算出不同的空間。今天還沒有任何傳輸，升版沒有現場的代價。

## 模擬器的不變條件（`packages/backend/src/test/mergeCrossFieldSim.test.ts`）

純記憶體的模擬（既有的 `StampedWorld` 與有故障的網路），本機寫入依產品的規則做。**每一個合併步驟之後**，在合併的那一台檢查：

- R1：父層 × 空間
- R2：活著的筆記不在已刪除的空間裡
- R3：套上 4.10 之後沒有環
- R4：套上 4.9 之後，活著的筆記不在垃圾桶裡的父層底下（模擬器自己的狀態；資料庫沒有這個檢視）

預設每次跑都用新的種子，失敗時印出種子；用 `MERGE_INVARIANT_SEED` 可以固定。修正前 R1、R2、R4 是紅的；migration 218 起四條在每一步都成立，`KNOWN_OPEN` 是空的，當時固定的種子留成「成立」的測試。另一則測試確認三個檢視真的被走到（有環可切、有筆記要進垃圾桶、有空間的刪除被留下）。

## 沒有驗證的

- 標成【推論】的每一列。「只有資料庫擋」只剩父層 × 空間一條（測過）；原本推論會卡死的兩個唯一索引，審查後補查：個人空間做不出來，手動連結會收斂（測過）。
- 父層 × 空間、空間刪除、垃圾桶 × 父層三列已實作（見檔頭）；其他列仍是提案，代價是估計的。推導空間的成本量過一次（README「接上傳輸前必須完成」：1,000 則的子樹，推導 14 個語句，慢的是每則三個語句的 slug）。
- (e2) 裡 C 被連帶丟進垃圾桶，卻已經不在 P 底下。這算不算錯，要業主決定：今天限制成立，C 也還在垃圾桶裡可以救回；救回 P 時 C 會不會一起回來，沒有測。
- 同名標籤沒有卡死，原因沒有追。
