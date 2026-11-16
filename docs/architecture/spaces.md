# 空間：用「放在哪裡」決定誰看得到（設計草案 v3）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/spaces.ts, packages/backend/src/spine/spaceAccess.ts

狀態：**全部階段已實作**（2026-10-13，分支 `feat/spaces`，PR #10）。空間一律生效，沒有開關；
現有的標籤權限由 migration 094 一次性、fail-closed 轉換，舊的標籤權限程式已刪除（使用者決定「直接完成轉換，不太需要過度」）。
**第二位成員加入前**必須先完成[實作紀錄](../archive/research/spaces-implementation.md)「v1 未做」1–5（同空間解析 `[[標題]]`、
每空間 slug 唯一、每日筆記以主人辨識、RSS 去重分空間、事件帶 `space_id`）。
使用者以 `/loop 不中斷 完成空間改版` 要求不中斷完成，文末「待確認」全部採建議，空間管理者在 v1 實作。
實作細節、與草案的差異、驗證紀錄見 [實作紀錄](../archive/research/spaces-implementation.md)。
相關：[模組庫](module-library.md)、[membership 與權限 epoch](membership-and-permission-epoch.md)、
[架構收斂計畫](../archive/architecture/convergence-plan.md)、[復原寫入](restore-writes.md)。

> **2026-10-23 更新（後端）**：成員角色與權限已改為[「只剩擁有者／成員」](proposals/roles-owner-member-2026-10-22.md)
> （migration 127）。下文凡提到工作區角色（viewer/editor/reviewer/admin）、空間管理者（`manager`）、token 的
> `read_space_ids`／`write_space_ids`／簽發者夾住，皆為**歷史描述**，現況是：工作區只有擁有者與成員；
> 每位成員（人或 AI）在每個空間是「檢視」或「編輯」；管理空間（成員、開關、永久刪除、還原備份）只屬於擁有者
> （共享空間）或本人（個人空間）；收件匣只有擁有者審核；token 只有「唯讀／可寫」，範圍等於 agent 自己的空間成員資格。
> 存取判斷只在 `spine/spaceAccess.ts`。前端畫面（空間與成員）尚未改，依提案 PR 6a/6b 進行。

## 一句話

**標籤回答「這是什麼」，空間回答「誰看得到」。** 每篇筆記放在一個空間；空間有成員
（檢視者／編輯者）；標籤與模組完全不影響權限。

例子：研究生有「我的」（私人）和「實驗室」（同學可改、教授可看）兩個空間。
`#論文` `#複習` 在兩個空間都能用；把一篇筆記從「我的」移到「實驗室」，
教授才看得到它——這是唯一會改變一篇筆記可見範圍的動作。

## 為什麼要改

### 現在的權限由十幾種概念疊加

| 概念 | 存在哪 |
|---|---|
| 角色階層 viewer < editor < reviewer < admin | `actors.role`、`roles.ts:12` |
| 標籤 policy：角色門檻，取筆記自身標籤與 parent 鏈上所有標籤的最嚴格者 | `class_tag.tag_schema->'policy'`、`readPolicy.ts:25-80`、`dispatcher/permissions.ts:105-141` |
| 沒有 policy 的操作預設放行到 viewer | `dispatcher/permissions.ts:34-37, 70-79` |
| token 標籤白名單、工具白名單 | `agent_tokens.allowed_tag_ids`、`allowed_tools` |
| 人員範圍（matter scope），只看直接掛標籤的筆記，不往下繼承 | `actors.scoped_tag_ids`（migration 066） |
| 任務的範圍主體是宿主筆記 | `taskIdentity.ts`（任務與宿主筆記同一個空間，migration 093） |
| principal_admin：任何非 token 的 admin（不是單一擁有者） | `spine/authority.ts:105-107` |
| workspace 設定節點保護 | `reservedNodes.ts` |
| 移除成員 → 401 | `member_removals`、`index.ts:299` |
| 自行註冊預設 viewer | `signupRoleFor` |
| 公開對象：發布中的空間裡的筆記，扣掉自己設成不發布（`_published` = `false`）、空白、從訂閱存下的（2026-11-10 起；網站一律公開，沒有存取 token 或分享連結） | `publishing/snapshot.ts`、`publishing/publishedSet.ts` |
| inbox／outbox 核准 | `inbox.ts`、`outbox.ts:313` |
| membership epoch（含 `node_tags` 每次增刪的 DB trigger） | `workspaces.membership_epoch`、`schema.sql:1347`（migration 069） |

每個讀寫入口都要組合正確的檢查：讀取授權約 120 個呼叫點、41 個檔案；
直接寫 `node_tags` 的 SQL 有 14 處、11 個檔案。

### 已知的組合漏洞（與本設計無關，先修，見遷移第 0 階段）

- `DELETE /api/nodes/:id` 可刪帶 policy 的標籤（只看掛在節點上的標籤，不看標籤自身 policy；不 bump epoch），
  標籤下的受限筆記隨之可見；`collections.ts:209-221` 對同一件事卻正確要求 principal_admin。復原刪除同樣。
- **viewer 現在可以修改、刪除沒有標籤的筆記**（預設放行；只有 POST /api/nodes 要求 editor）。
  「教授只能看」這個需求今天就沒有滿足。
- 標籤合併沒有 `canSeeTag`，成員改掛直接 `INSERT INTO node_tags`，繞過 `tagMembershipWrites`。
- 被移除成員的 401 被前端當成離線，繼續顯示本機鏡像。
- `GET /api/inbox/approvals` 沒有角色檢查，任何登入成員都能讀待核准的 outbox payload。
- rollup 屬性彙總子孫時不逐一過濾讀取權（`nodeAttributes.ts:26-70`）。
- 媒體只要「任一引用它的節點可讀」就可讀；把 `/api/media/<檔名>` 貼進自己的筆記就能永久讀取。
- `^block-id` 以 `(workspace_id, block_id)` upsert、後寫者勝（`blockIds.ts:138`），可劫持別人的段落引用。
- 多個逐節點讀取回 403 而非 404（render、history、export、attributes、restore preview），洩漏存在。

### 根因：標籤同時負責「功能」和「權限」

加／拿標籤、改名、合併、刪除、繼承在筆記軟體裡是隨手動作，現在每一個都可能改變誰看得到什麼；
一篇筆記可以有多個標籤，權限只能靠「最嚴格者勝」組合，使用者難以預測。
[模組庫](module-library.md)讓標籤更像函式庫——在程式世界裡，函式庫決定程式能做什麼，
誰看得到程式碼由 repo 決定。

### 十人以內的實際需求

1. 大部分筆記大家都能看、能改。
2. 少數筆記只給特定幾個人。
3. 有人只能看不能改（指導教授、訪客）。
4. agent 只能碰指定範圍，並可限制工具。

## 不變條件

1. **權限結果正確**：看不到的筆記不出現在任何讀取面，且無法從任何回應推得它存在
   （404、連結解析、唯一性衝突、計數都不洩漏）。
2. **改可見範圍只有一條路**：一篇筆記的可見範圍只因「移動到另一個空間」改變；
   空間的可見範圍只因「改空間成員」改變。
3. **子節點跟父節點同空間**：子筆記、任務、段落節點不能自己設權限；媒體檔案屬於空間。
4. **撤權在伺服器端立即生效、fail-closed**；客戶端在下次連線時清除。一直離線的裝置保有既有副本，
   因此移除成員時同時撤銷其 session。
5. **標籤操作不碰權限**：加／拿／改名／合併／刪除標籤從不 bump membership epoch（第 3 階段移除 `node_tags` trigger 後成立）。

## 方案比較

依 AGENTS.md：新公共介面先比較兩種設計草圖。

### A. 空間（建議）

```ts
// 唯一會改變一篇筆記可見範圍的寫入
await moveToSpace(actor, { nodeId, toSpaceId, expectedAudienceEpoch });

// 標籤寫入不需要知道權限
await applyTag(actor, { nodeId, tagId });   // 只檢查：能編輯這篇筆記的空間

// 讀取閘：一個可索引的條件
WHERE n.space_id = ANY($readableSpaceIds)
```

- **呼叫者要知道的**：筆記在哪個空間；移動會改變誰看得到（確認框列出名單）。
- **隱藏的**：成員角色、epoch、鏡像清除、outbox 重新檢查，都在 `moveToSpace` 與讀取閘內。
- **相容成本**：高（見遷移估算）。

### B. 權限標籤（每篇最多一個，與一般標籤分開）

保留 class_tag + policy，加「權限標籤」旗標與每篇最多一個（參考 Microsoft Purview 敏感度標籤）。

```ts
await applyTag(actor, { nodeId, tagId });
// ↑ 內部必須判斷：tagId 是權限標籤嗎？是 → 要求擁有者、檢查每篇最多一個、bump epoch
```

- **隱藏不了的**：所有寫 `node_tags`、改名、合併、刪除、繼承的路徑都要知道「權限標籤」，知識仍散在 11 個檔案。
- **相容成本**：低。

### 否決：C. 多個工作區

`workspace_id` 是硬邊界（事件游標、模組引入、標籤都按工作區分），跨工作區連結與共用模組標籤要跨工作區 JOIN，
移動等於複製。Anytype 走這條路，結果物件不能在空間間移動、類型與標籤不能共用。

### 選 A 的理由

兩者語意相同（每篇一個權限單位）；A 把權限的程式路徑與標籤完全分開，B 靠「記得檢查」守住。
A 的問題集中在可列舉的邊界（連結解析、唯一性、移動、媒體、對外輸出），本文逐項給出規則。

## 設計

### 概念

- **工作區**：仍是一個（`slug = 'default'`）。有一位**擁有者**（新概念：取代「任何 admin」）與若干**成員**。
- **空間**：筆記的容器。每位成員有一個**私人空間**；另可建**共享空間**。
- **空間成員**：`檢視者`（只讀，真正不能寫）、`編輯者`或`管理者`。
  管理者 = 編輯者 + 管成員、能力開關、把筆記移出空間。建立共享空間的人自動成為管理者，可再指定其他管理者；
  每個共享空間至少一位管理者。參考 Notion（每個團隊空間至少一位團隊空間擁有者）與 Zotero 群組（成員／管理員）。
  擁有者隨時可介入任何**共享**空間（不含私人空間）。
- **標籤一律是全域定義**（v1）：所有成員都能使用、看得到名稱；標籤不屬於任何空間、不帶權限。
  標籤名稱對十人以內的成員可見是接受的代價；真有需要再加「私人標籤」。

### 資料模型

```sql
CREATE TABLE spaces (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal', 'shared', 'system')),
  owner_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,  -- personal 的主人
  capabilities jsonb NOT NULL DEFAULT '{}',  -- {"publish": false, "external_ai": false, "backup": true}
  deleted_at timestamptz
);

CREATE TABLE space_members (
  space_id uuid REFERENCES spaces(id),
  actor_id uuid REFERENCES actors(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  PRIMARY KEY (space_id, actor_id)
);
-- personal 空間恰好一位成員（其主人，manager），由 constraint trigger 保證；擁有者不能把自己加進別人的私人空間。
-- shared 空間至少一位 manager，由 constraint trigger 保證。

-- 模組的個人進度：內容共用、進度每人一份（見「模組的個人進度」）
CREATE TABLE review_states (
  node_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES actors(id) ON DELETE CASCADE,
  state jsonb NOT NULL,              -- 現在 `_review_state` 屬性的內容（FSRS）
  PRIMARY KEY (node_id, actor_id)
);
CREATE TABLE item_progress (         -- RSS 已讀、稍後讀已讀完
  node_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES actors(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rss_seen', 'read_later_done')),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, actor_id, kind)
);
CREATE TABLE actor_module_settings ( -- 個人覆蓋模組設定（例如每日新卡數）
  actor_id uuid REFERENCES actors(id) ON DELETE CASCADE,
  tag_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  PRIMARY KEY (actor_id, tag_id)
);

ALTER TABLE content_nodes ADD COLUMN space_id uuid REFERENCES spaces(id);
-- CHECK：只有 node_type = 'class_tag' 可為 NULL（= 全域標籤定義）。
-- 全域標籤不得有內容子節點、任務或存放成員資料的屬性。
CREATE INDEX ON content_nodes (workspace_id, space_id) WHERE deleted_at IS NULL;

CREATE TABLE media (            -- 新：媒體屬於空間，不再「被誰引用就給誰讀」
  filename text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  uploader_actor_id uuid REFERENCES actors(id)
);

ALTER TABLE agent_tokens
  ADD COLUMN read_space_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN write_space_ids uuid[] NOT NULL DEFAULT '{}';
-- 永不為 NULL（NULL 不代表「全部，包括未來的空間」）。

ALTER TABLE outbox ADD COLUMN space_id uuid;  -- 核准清單與執行時檢查都依空間過濾
```

**觸發器**（審查指出一般的 row trigger 會在多列更新時依列序隨機失敗）：

- `BEFORE INSERT`：有 parent 時從 parent 複製 `space_id`。這讓 24 處 `INSERT INTO content_nodes` 只剩建立頂層節點的路徑
  （`routes/nodes.ts`、`import.ts`、`canvases.ts`、`bookmark.ts`、`agentTools/createNode.ts`、rss、citations、`siteConfig`、`obsidianFolders`）需要指定空間。
- `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`，於 INSERT 與 `UPDATE OF parent_id, space_id, deleted_at` 觸發：
  子節點 `space_id` 必須等於 parent；全域標籤的子標籤只能是全域標籤。

**唯一性改為以空間為範圍**（否則唯一性衝突本身就洩漏存在）：

| 現在 | 改為 |
|---|---|
| `uniqueSlug` 全工作區 | `(space_id, slug)`；URL 用 id 或帶空間 |
| `^block-id` `(workspace_id, block_id)` 後寫者勝 | `(node_id, block_id)`；衝突時拒絕，不改指向 |
| 每日筆記以日期標題全域比對 | 以（主人, 日期）找，建在主人的私人空間 |
| RSS 來源 URL 全域去重回 409 + id | 在同一空間內去重 |
| 引用 DOI／citekey 只在可讀範圍檢查 | 不變；移動時若目標空間已有同 DOI／citekey，確認框提示合併 |

### 讀取規則（唯一一條）

```
readableSpaceIds(actor) = actor 為成員的空間
                        ∩ token.read_space_ids（若是 token）
節點可讀 ⇔ node.space_id ∈ readableSpaceIds(actor)
         或 node 是全域 class_tag（只露定義欄位；成員清單、計數、「被誰繼承」都只算看得到的）
媒體可讀 ⇔ media.space_id ∈ readableSpaceIds(actor)
匿名（公開站台）⇔ 另一個函式 publishable()，見「對外輸出」
```

- 所有讀取面共用同一個 SQL 片段（沿用 `readableScopeSql`）。審查列出的讀取面遠多於 v1 所列，全部納入：
  - 節點：bootstrap、sync（含 `/sync/membership`、`/sync/bodies`、`/sync/nodes`）、搜尋、反向連結、圖譜、垃圾桶、
    `/block/:id`、render、history、ink-versions、export.html、export-preview、attributes、rollup（**逐一過濾子孫**）、
    inherited-attributes、各寫入回應中回傳的列。
  - 標籤：tree、resolve-path、list、detail、export、path、descendants、views、views exec、merge／delete preview、
    `tagCatalog` 的 `usage_count`（現在不過濾）。
  - collections、events（列表、cascade-preview、restore preview）、inbox、versions/recent、day、tasks agenda、
    canvases／boards（含卡片 id 與位置）、review、rss、citations、技能 prompts、semantic suggested-links、MCP 工具（含 dry-run 預覽）、
    `GET /api/actors`、`GET /api/workspace/config`、`GET /api/inbox/approvals`。
- 看不到的節點一律回 **404**，與不存在無法區分。
- **非節點事件**（標籤、邊、白板、collection view、actor、token 事件）寫入時標上 `space_id` 並依此過濾；
  現在這些事件對所有人可見，payload 帶標題。
- 即時事件（SSE）只送游標與 epoch、不含內容，維持現狀（「某人在某處有動作」的時間訊號在十人以內接受）。

### 連結與引用

| 情境 | 規則 |
|---|---|
| 正文 `[[標題]]` | **只在來源筆記的空間內以標題解析**；跨空間連結由 `[[` 自動完成（只列可讀的）插入，存成 id 引用 |
| 編輯器／預覽的 `![[標題…]]` 內嵌 | 先在來源筆記的空間解析；找不到時改用客戶端持有（＝可讀）的其他空間同名筆記顯示內容。只影響顯示：伺服器仍不建邊、不出反向連結 |
| 看不到的標題連結 | 呈現得跟「不存在、要建立嗎？」完全一樣——顯示 🔒 本身就是存在預言機 |
| 看不到的 id 引用（作者原本可讀時建立） | 顯示「無法存取」 |
| 邊（`node_edges`）、指標（`note_pointers`） | **維持現行規則**：兩端都可讀才同步給客戶端（`routes/sync.ts:312-319, 375-376`） |
| 白板卡片 | 同上，看不到的卡片不出現（不做佔位） |
| 反向連結、圖譜、搜尋、`[[` 自動完成、查詢、任務頁、標籤頁、複習佇列 | 依可讀空間過濾；計數也只算看得到的 |

### 寫入規則

| 動作 | 需要 |
|---|---|
| 讀 | 空間成員（任一角色） |
| 建立／編輯／刪除筆記、設定屬性 | 該空間**編輯者**（檢視者真正不能寫） |
| 建立頂層筆記 | 必須指定空間；未指定時預設建立者的**私人空間**（fail-closed，不預設共享空間） |
| 移動到別的空間 | 目標空間的編輯者，且：來源是私人空間 → 主人即可；來源是共享空間 → 來源的**管理者**（或管理者在空間設定開放「編輯者可移出」）。**只在線上**；agent 只能提案（見 agent token） |
| 跨空間改 parent（拖曳、縮排、拖卡片到資料夾白板） | 視為移動：走 `moveToSpace` 的確認框，否則 409。側欄拖曳：把筆記放到另一個空間的標題或列上，開出與「移動到…」同一個確認框（`MoveToSpaceConfirm`），確認後才搬；放進該空間的某篇筆記時，搬完再用一般的改上層放到它底下 |
| 加／拿標籤 | 筆記所在空間的編輯者 |
| 改標籤定義、為標籤「＋ 加入功能」 | 擁有者（與現行「功能」標籤頁的管理權一致；PR #10 審查時決定） |
| 引入／取消引入模組 | 擁有者 |
| 建立共享空間 | 預設任何成員（建立者成為管理者）；擁有者可在工作區設定改成只有擁有者能建（Notion 同款設定） |
| 管成員、改能力開關 | 該空間管理者；擁有者可介入共享空間；私人空間只有其主人 |
| 刪除空間 | 管理者或擁有者；v1 只能刪空的空間 |

`mutate()` 的 `authority` 新增 `{ kind: "space", spaceId, op }`；每次節點寫入（包括 `cascade`、`open` 權限的連鎖寫入、
`fieldDefaults`、模板展開）都由 spine 斷言目標空間對**根操作者**可寫，不再讓呼叫者自選檢查種類——刪標籤漏洞正是宣告錯種類。

### 移動（`moveToSpace`）

參考 Confluence（子頁、附件、留言一起搬）與 Outline（權限不同時警告；目標只列有權限的空間）。

1. **整棵子樹一起搬，包括已在垃圾桶的子孫與任務**；個人進度表（`review_states`、`item_progress`）跟著節點不用動，
   但失去讀取權的人的進度列一併刪除；媒體檔案的 `media.space_id` 一起改（若檔案也被別的空間引用，複製一份）。
2. 確認框寫出影響，並帶 `expectedAudienceEpoch`；伺服器若發現成員已變動就拒絕，請使用者重新確認（避免確認時與執行時名單不同）：
   - 「移到『實驗室』後，王同學、陳教授將看得到」「李同學將看不到」
   - 「**版本歷史也會一起過去**，包括你刪掉過的內容」
   - 「這篇連到 N 篇對方看不到的筆記」「目標空間已有相同 DOI 的論文」
3. 同一交易：更新 `space_id`、寫 `NODE_MOVED_SPACE` 事件、bump membership epoch；
   在來源空間留下不含內容的墓碑事件（「一篇筆記被移出」），來源成員保有稽核軌跡。
4. 移動後（或關閉能力開關後）：刪除該子樹的 `node_embeddings` 與建議連結，若影響公開內容則排程重新部署。
5. **不提供 v1 的 `history: "fresh"`**：它會換 id，打斷連結、指標、邊、`^block-id` 與任務 id；以後做成「複製到空間」。

**復原**：`NODE_MOVED_SPACE` 的逆操作也走 `moveToSpace`，要求復原當下在兩個空間都是編輯者
（否則編輯者可以「復原」同事的移動，把共享筆記推進同事的私人空間）。復原順序比照 `NODE_DELETED`／`TAG_MERGED`：
先把節點搬回，再處理子事件（`restore.ts:231-237`）。復原 reparent 時若舊 parent 已在別的空間，回 409。
`authorizeRestore` 與 `restore.ts` 的 epoch bump 清單都要加上這個事件。

### 對外輸出與能力開關

參考 Deno：預設不給、明確開放、以空間為單位（不做每篇筆記）。所有離開伺服器的資料都要有開關，
**並在執行時（不是排入佇列時）重新檢查**節點目前所在空間與開關：

| 能力 | 管什麼 | 預設 |
|---|---|---|
| `publish` | 打開時這個空間的筆記都會上網站（2026-11-10 起），單篇用 `_published` = `false` 排除；空白筆記、從訂閱存下的文章預設不上，`_published` = `true` 才上。用於 `/api/site`、媒體打包、靜態輸出、GitHub Pages | 關（預設空間也關，migration 186） |
| `external_ai` | 內容可送到外部 AI：MCP 技能 prompts（`services/harness/`；內建 API AI 已於 2026-10-23 移除）、**agent token 只能涵蓋開啟此項的空間** | 共享空間關；私人空間由主人決定 |
| `backup` | 應用層的 git 鏡像與 GitHub 備份（`git.ts`、`githubBackup.ts`，每次存檔都會觸發） | 共享空間開；私人空間見下 |

**備份分兩層**（參考 Notion：工作區匯出不含其他人的私人頁面）：

- **伺服器層**（資料庫 dump、磁碟快照）：含全部資料，是伺服器管理者的責任；文件明寫「自架伺服器的管理者讀得到所有內容」。
- **應用層**（git／GitHub 匯出、`/api/export`）：擁有者設定的備份只含**共享空間**；每位成員可替自己的私人空間
  另外設定備份目的地（預設跟著工作區的備份目的地但分開資料夾，由主人決定開或關）。
  這樣不必在「私人空間的隱私」與「伺服器壞了沒備份」之間二選一。

本機 embedding（`embedder.ts`，multilingual-e5 在伺服器上跑）不送出資料，**不受 `external_ai` 管**。

outbox 效果在執行時：若節點已移到關閉該能力的空間、或開關已關，丟棄該效果。

### agent token

物件能力模型：手上有參照才有權力。

- token = `read_space_ids` × `write_space_ids` × `allowed_tools`；兩組空間都必須是發 token 者自己可讀／可寫，
  且都開啟 `external_ai`（每次請求都檢查）。
- 範圍為 NULL＝token 所屬 agent 的全部空間：**把 agent 加進一個空間，它所有範圍為 NULL 的 token 都能到那個空間**。
- token 的實際權限 = min(發 token 者的空間角色, token 授權)：檢視者發不出能寫的 token。
- 讀寫分開，是為了防止「token 讀私人空間、寫進共享空間」——共享空間裡的提示注入正好能驅動這件事。
- agent 寫入照舊進 inbox，由**發 token 者**審核（擁有者可看全部）。
- **改變可見範圍的動作只能提案**（參考常見的程式代理服務：只能推自己的分支、變更一律是草稿 PR、
  必須由有寫入權的人核准、要求者不能自己核准、agent 不能核准或合併）：
  - agent 不能直接移動筆記、設定 `_published` 或改能力開關；這些動作變成 inbox 裡的提案，
    走「先核准再執行」的 outbox（比照 `tag_pack`）。
  - 核准者必須具備執行該動作本身所需的權限（例如移動需要兩個空間的對應角色），而且**不能是發 token 者以外的 agent**。
  - 核准時重新檢查權限與 `expectedAudienceEpoch`，不沿用提案當下的判斷。

### 模組的個人進度

空間讓分享變常見，下列模組狀態目前存在**共用的筆記上**，會在共享空間互相干擾：

- 複習：每篇筆記一份 `_review_state`；A 按「再一次」會改 B 的到期日；教授（檢視者）的佇列會出現學生的卡片但無法作答。
- 複習每日新卡額度：以可讀筆記計算，實驗室的卡片會吃掉個人額度。
- RSS：`rss_staging.seen_at` 一份，一人標已讀等於全實驗室已讀。
- 稍後讀：讀完就是拿掉標籤，所有人一起消失。

**v3 決定：內容共用、進度每人一份。** 參考：

- RemNote 的共享知識庫把複習進度共用，被使用者當成問題回報、要求分開——反面教材。
- AnkiHub（Anki 協作卡組）：卡片內容同步給所有人，排程與進度留在每個人自己那裡；個人欄位受保護不被覆蓋。
- Feedly：已讀狀態預設每人一份；團隊可以對個別工作區打開「共享已讀」。
- 程式世界：函式庫程式碼共用，執行狀態每個 process 一份；VS Code 設定分層（預設 → 使用者 → 工作區 → 資料夾）。

具體做法：

| 模組 | 現在 | 之後 |
|---|---|---|
| 複習 | 每篇筆記一份 `_review_state` 屬性 | `review_states (node_id, actor_id)`；作答只需**讀取權**（作答是改自己的進度，不是改筆記），所以檢視者（教授）也能複習 |
| 複習設定（每日新卡數、記憶率、最長間隔） | `#複習` 等來源標籤的 `behaviour.review` | 標籤設定是預設值，`actor_module_settings` 是個人覆蓋（模組設定的分層：模組預設 → 標籤 → 個人）；額度只算自己的進度 |
| RSS 已讀 | `rss_staging.seen_at` 一份 | `item_progress(kind='rss_seen')` 每人一份；共享空間的管理者可打開「共享已讀」（`spaces.capabilities.shared_seen`），此時沿用一份 |
| 稍後讀 | 讀完 = 拿掉標籤 | `item_progress(kind='read_later_done')`；標籤仍代表「這篇值得讀」，讀完只影響自己的清單 |

遷移：現有 `_review_state` 複製給**目前讀得到該筆記的每位成員**（保持每個人原本看到的排程），之後屬性停用；
現有 `seen_at` 同理複製。複習、RSS、稍後讀三個模組各需改讀寫路徑與測試。

### 新內容落在哪個空間

| 來源 | 落點 |
|---|---|
| 在某篇筆記內快速擷取（子節點） | 該筆記的空間——擷取面板顯示空間標記 |
| 側欄 ＋ 建立面板、從首頁擷取、每日筆記 | 預設擷取者的私人空間；＋ 面板在有兩個以上可寫空間時，「放在」可選各空間的最上層（`lib/newNoteTarget.ts`；快速捕捉不用它，見 decisions-modules.md「捕捉」） |
| RSS 收藏 | 該 RSS 來源所在空間（收藏是來源的子節點） |
| 匯入（Markdown、Obsidian、Notion、CSV） | 匯入時選擇，預設私人空間 |
| agent 建立頂層筆記 | 必須明確指定 `write_space_ids` 中的一個 |
| 原生 App 的 System 身分 | 預設空間（它沒有個人空間） |

以上由 `newNoteSpace`（services/spaces.ts）一處決定。新成員不會自動加入任何共享空間（含「共用」）；
由擁有者或空間管理者在「設定 › 空間」加入（migration 097）。

### 離線撤權

伺服器停止提供資料 + 清客戶端鏡像即可，不需要 Keyhive 式的加密讀取控制。

- **沿用現有的節點 id 集合對帳協定**（`GET /sync/membership`、`POST /sync/nodes`、`membershipReconcile.ts`）：
  它不在乎 `readableNodeIdSet` 怎麼定義，只改伺服器端定義即可。改用空間 id 對帳要在本機鏡像加欄位、
  重送每個被移動的子孫、處理沒有空間的待建立筆記——等需要效能時再做成快速路徑。
- 清除範圍要包括 `pending_writes`、被拒絕的寫入、`missingPendingNoteCreations` 的投影、邊、屬性、指標、全文索引、快取的媒體。
- 對已移到唯讀空間的筆記的離線寫入得到 403、移到不可讀空間得到 404，兩者都已被歸類為「被拒絕的輸入」保留給使用者（`writeErrors.ts:37-44`）；只需補測試。
- 移除成員：撤銷其 session；`space_members` cascade；其私人空間交給擁有者決定（轉移、封存或刪除）。
- 401 `membership_removed`／`account_changed` 不得被當成離線（第 0 階段修正）。

## 與現有機制的對應

| 現有 | 之後 |
|---|---|
| 角色 viewer/editor/reviewer/admin | 工作區：擁有者／成員；空間：檢視者／編輯者／管理者 |
| 預設放行到 viewer 的寫入 | 預設拒絕（比照 PostgreSQL RLS）；檢視者不能寫 |
| `_review_state` 屬性、`rss_staging.seen_at`、稍後讀靠拿掉標籤 | 每人一份的進度表 |
| reviewer 角色 | 移除；agent 寫入由發 token 者審核 |
| 標籤 policy（含 apply／remove／set_attribute 等操作門檻） | 刪除；帶 policy 標籤的筆記移到只有擁有者的「受限」空間（migration 094） |
| `actors.scoped_tag_ids` | 刪除；有範圍的成員只剩個人空間，等擁有者加進空間 |
| `agent_tokens.allowed_tag_ids` | 刪除，改為 `read_space_ids`／`write_space_ids`；有標籤範圍的 token 先不能到任何空間 |
| principal_admin（任何 admin） | 單一擁有者 |
| workspace 設定節點保護 | 設定節點放在只有擁有者的 `system` 空間 |
| membership epoch | 保留；觸發點只剩空間成員、移動、刪除空間、token 範圍 |
| 媒體「被引用即可讀」 | `media.space_id` |
| `mutate()` spine | 保留；authority 依目標空間，連鎖寫入也檢查 |

## 遷移計畫

實際做法（與原計畫不同處見實作紀錄）：

0. **修現有漏洞**：上方「已知的組合漏洞」全部（migration 090、091）。
1. **加入空間**（migration 093）：所有現有節點放進預設空間「共用」，`publish`、`external_ai`、`backup` 都開（維持現有行為）；
   現有成員依角色加入；每位成員建個人空間；觸發器維持「子節點與父節點同空間」。模組個人進度（migration 092）。
2. **一次性轉換並切換**（migration 094）：沒有影子模式、沒有開關。無法以空間表達的舊規則一律 fail-closed——
   帶 policy 標籤的筆記（含子樹）移到只有擁有者的「受限」空間、有標籤範圍的成員只留個人空間、有標籤範圍的 token 先不能到任何空間，
   每項以 RAISE NOTICE 記錄。接著刪除 policy、`scoped_tag_ids`、`allowed_tag_ids`、`node_tags` 的 epoch trigger。
   回滾只能還原資料庫備份。
3. **刪除舊程式**：讀取閘、spine authority、dispatcher 的標籤權限程式與 policy 編輯介面都已刪。

## 測試守門

- **讀取面清單測試**：上方列出的每個讀取面各一條：別的空間的節點不出現、直接存取回 404。
- **存在預言機測試**：對看不到的標題寫 `[[標題]]` 呈現為不存在；建立同名筆記得到的 slug 與看不到的筆記無關；
  `^block-id` 衝突被拒絕且不改指向；RSS 重複訂閱不回傳別的空間的 id。
- **只有一條路改 `space_id`**：自訂 eslint 規則禁止在 `services/spaces.ts` 以外寫 `space_id`。
- **子節點同空間**：deferred constraint trigger + 整合測試（建立、移動含垃圾桶子孫、復原刪除、復原 reparent）。
- **對外輸出**：移動到關閉能力的空間後，已排入的 embedding／發佈／備份效果在執行時被丟棄。
- **token**：檢視者發不出可寫 token；token 不能把私人空間的內容寫進共享空間。
- **標籤操作不 bump epoch**。
- **撤權**：移出成員後對帳刪除該空間所有列與待送寫入；401 不被當成離線。

## 待確認

v3 已依調查給出建議，以下請確認或推翻：

1. **私人空間的隱私與備份**：擁有者看不到、不能加入、不能改開關；應用層備份不含別人的私人空間，每人自行設定私人空間的備份；
   伺服器層備份含全部，文件明寫。
2. **建立共享空間**：預設所有成員都能建、建立者成為管理者；擁有者可改成只有擁有者能建。
3. **移除 reviewer 角色**：agent 寫入由發 token 者審核。
4. **跨空間連結**：不露標題、看起來跟不存在一樣；邊與指標維持兩端可讀才顯示。
5. **白板**：看不到的卡片不出現。
6. **新共享空間的預設**：`publish` 關、`external_ai` 關、`backup` 開、`shared_seen` 關。
7. **agent**：改變可見範圍的動作只能提案，由具備該權限的人核准。
8. **模組的個人進度**：每人一份（複習、RSS 已讀、稍後讀），共享空間可選「共享已讀」。代價：三個模組各改讀寫路徑。
9. **移出共享空間**：預設只限管理者；管理者可在空間設定開放給編輯者。

仍開放：**空間管理者這一層要不要在 v1 就做？** 不做的話，問題 2 與 9 退回「只有擁有者」，
學生無法自己開「我 + 教授」的空間。

## 介面

- **側欄**：樹狀清單按空間分組（「我的」「實驗室」），像 Notion 的團隊空間；是分組，不是模式。
  搜尋、標籤、任務、圖譜跨所有可讀空間，每列帶小小的空間標記。
- **麵包屑**：根節點是空間標記（🔒 或 👥）：「實驗室 › 專題 › 筆記」；點它顯示誰看得到、「換到其他空間…」（先預覽再移）。
  筆記選單的「移動到…」是同一件事的另一個入口：一個選位置的畫面，依空間分組，選別的空間的位置時先預覽再移。
- **標籤列**：永遠不放空間——長得像標籤的空間標記會再次混淆「是什麼」與「誰看得到」。
- **資訊欄**：一行「誰看得到」。
- **擷取面板、新筆記對話框**：顯示目標空間。
- **用詞**：「繼承」只用於標籤 extends；空間說「跟著上層的空間」。「成員」只指人；標籤的成員維持「已標記的筆記」。
  避免「私有」（模組庫的私有 schema）與「私人空間」混淆。第 1–2 階段標籤頁「進階」的存取權限標成舊功能。

## v2 → v3 修訂紀錄（依其他筆記軟體與程式慣例調查）

| 調查 | v3 的處理 |
|---|---|
| RemNote 共用進度被抱怨；AnkiHub 內容共用、進度個人；Feedly 預設個人已讀、可選共享已讀 | 模組進度改為每人一份；共享空間可開「共享已讀」 |
| VS Code 設定分層 | 模組設定：模組預設 → 標籤 → 個人覆蓋 |
| Notion 預設所有成員可建團隊空間、每個團隊空間有擁有者；Zotero 群組有管理員 | 新增空間管理者；預設所有成員可建共享空間 |
| Notion 團隊空間擁有者決定成員能否改側欄；GitHub 轉移 repo 需 admin | 移出共享空間預設只限管理者 |
| 常見的程式代理服務只能開草稿 PR、須人核准、要求者不能自核 | agent 改變可見範圍的動作只能提案 |
| Notion 工作區匯出不含他人私人頁面 | 備份分伺服器層與應用層 |
| PostgreSQL RLS 沒有 policy 即全部拒絕 | 第 0 階段：沒有規則的寫入改為預設拒絕 |
| Obsidian 的 block id 只在同一檔案內唯一 | `^block-id` 以 `(node_id, block_id)` 為範圍，與 Obsidian 相容 |
| Outline 附件屬於文件、讀取時檢查文件權限並發臨時簽章網址 | `media` 表；簽章網址留待之後 |

## v1 → v2 修訂紀錄

| 審查發現 | v2 的處理 |
|---|---|
| 標題連結解析是存在預言機；🔒 佔位反而洩漏 | 標題只在同空間解析；看不到的連結呈現為不存在；邊與指標維持兩端可讀 |
| slug、block-id、每日筆記、RSS 去重的唯一性都是全工作區 | 改為以空間或節點為範圍；block-id 衝突拒絕 |
| 媒體被引用即可讀 | 新增 `media` 表 |
| token 可讀私人寫共享；未受 AI 開關管 | 讀寫空間分開、須開 `external_ai`、權限取 min |
| 移動是不可逆的外洩，且有確認時與執行時不一致的競態 | 只在線上、帶 epoch、agent 不能移動 |
| 擁有者可透過成員與開關 API 進入私人空間 | 私人空間恰好一位成員、開關只歸主人 |
| outbox 在移動前就擷取內容 | 執行時重新檢查；移動後清 embedding、重新部署 |
| git／GitHub 備份會輸出所有空間 | 新增 `backup` 能力 |
| 本機 embedding 不送出資料 | `ai_read` 改名 `external_ai`，不管本機 embedding |
| 非節點事件對所有人可見 | 事件標 `space_id` |
| 一般 row trigger 在子樹更新時隨機失敗 | 改 deferred constraint trigger + BEFORE INSERT 衍生 |
| 第 1 階段直接取交集會讓公開站台變空白 | 改影子模式；共用空間能力全開 |
| 第 2 階段無法逐標籤轉換、父子不一致很常見、matter scope 會放寬 | 以（可讀者, 可寫者）分組的試算報告，擁有者逐項決定，fail-closed |
| `history: "fresh"` 會換 id、打斷所有引用 | v1 移除 |
| 空間標籤帶來繼承方向、同名、合併等一串規則 | v1 移除空間標籤，標籤一律全域 |
| 模組進度存在共用筆記上 | 新增「模組的個人進度」與待確認 8 |
| 跨空間改 parent 也會改空間 | 視為移動或 409 |
| 改用空間 id 對帳要大改客戶端 | 沿用節點 id 集合對帳 |
| `_published` 是屬性不是標籤；principal_admin 是任何 admin；viewer 今天就能寫 | 事實更正，並列入第 0 階段 |

## 參考資料

- 空間／工作區模型：[Anytype 成員與權限](https://doc.anytype.io/anytype-docs/memberships/monetization/multiplayer-and-membership-faqs)、
  [Tana Workspaces](https://tana.inc/docs/workspaces)、
  [Notion 團隊空間權限](https://www.notion.com/sv/help/guides/grant-access-teamspaces)、
  [Joplin 分享筆記本](https://joplinapp.org/help/apps/share_notebook)
- 跨空間連結：[Notion Links & backlinks](https://www.notion.com/vi/help/create-links-and-backlinks)
- 移動：[Confluence Moving a page](https://confluence.atlassian.com/x/ewWBG)、
  [Outline 跨集合拖曳警告](https://igit.yuuza.net/yuuza/outline/commit/b8efe772fe246dea0e55a4b9f31035a251e8c179)、
  [Linear Labels](https://linear.app/docs/labels)
- 版本歷史與分享：[Google Docs 修訂紀錄與複本](https://www.malwarebytes.com/it/blog/news/2015/06/draftback-sensible-sharing-pays-off)
- 反面教材：[Anytype 空間與類型不能共用](https://community.anytype.io/t/system-design-in-anytype-with-regard-to-spaces/29786)
- 單一標籤權限：[Microsoft Purview 敏感度標籤](https://learn.microsoft.com/en-in/purview/create-sensitivity-labels)
- 能力與依賴：[Deno 權限](https://docs.deno.com/runtime/fundamentals/security.md)、
  [Object-capability model](https://en.wikipedia.org/wiki/Object-capability_model)
- 存在洩漏：[GitHub 私人 repo 存在揭露](https://bounty.github.com/researchers/Geolim4.html)、
  [Bitbucket 可探測私人 repo](https://bitbucket.org/site/master/issues/8713/anyone-can-probe-for-private-repos-bb-200)
- 父子繼承：[OpenFGA Authorization concepts](https://openfga.dev/docs/authorization-concepts)
- local-first 撤權：[Ink & Switch Keyhive](https://www.inkandswitch.com/keyhive/notebook/)
- 個人進度：[RemNote 分開進度的需求](https://feedback.remnote.com/p/separate-flashcard-progress-between-knowledge-base-users)、
  [AnkiHub](https://usabilitytools.com/ankihub-addon-revolutionizing-collaborative-learning-pc9p.html)、
  [Feedly 團隊已讀](https://docs.feedly.com/article/550-when-i-mark-an-article-as-read-in-a-team-feed-will-others-still-see-it-as-unread)、
  [Feeder 共享已讀](https://feeder.co/help/account/collaboration/shared-unreads-for-workspaces/)
- 設定分層：[VS Code User and workspace settings](https://code.visualstudio.com/docs/configure/settings)
- 空間管理：[Notion 團隊空間設定](https://www.notion.com/help/guides/how-workspace-owners-can-set-up-teamspaces-for-their-organization)、
  [Zotero 群組角色](https://forums.zotero.org/discussion/14053/)、
  [GitHub 轉移 repo](https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/transferring-a-repository)
- 備份：[Notion Export your content](https://www.notion.com/en-gb/help/export-your-content)
- 預設拒絕：[PostgreSQL Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)
- block id 範圍：[Obsidian forum](https://forum.obsidian.md/t/block-reference-id-generation-question/7669)
- 附件權限：[Outline attachments API](https://git.coopcloud.tech/coop-cloud-chaos-patchs/outline/src/commit/3b0b37628e07218995fd75ba8df9ab841b2fc437/server/api/attachments.js)
