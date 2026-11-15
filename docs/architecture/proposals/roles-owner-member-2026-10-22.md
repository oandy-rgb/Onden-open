# 提案：只剩「擁有者／成員」，權限只在「空間與成員」一個畫面

> 狀態：現行（最後確認 2026-11-01）

> **2026-10-27 畫面改版**：設定 › 空間與成員改為三塊——「空間」（每個空間一張卡：誰看得到的一行摘要、裡面有誰與各自權限、這個空間的筆記能不能發布／給 AI／備份）、「人」、「AI 角色」，可「依空間看｜依成員看」切換；權限改動先顯示後果再套用；新增 AI 角色是一步一步的精靈（跑法清單 `RUN_MODES`，之後可加「API（你的 API key）」）。側欄共享空間標題與筆記的空間標籤都有「成員與權限」入口。後端未動。
> 狀態：**後端已實作**（2026-10-23，PR-A 特徵化測試、PR-B 單一存取函式、PR-C migration 127＋語意切換、PR-D 有效存取與擁有權；無相容期，見第 9 節）；**前端（PR 6a/6b）已實作於 2026-10-23**：依擁有者決定「角色跟空間不要分開設置」「放在設定裡」，合併成設定裡的單一頁面「空間與成員」（`settings/spacesAndMembers/`）——列＝成員與 AI 助手，每列就地顯示每個空間的 不在／可看／可編輯，AI 助手的金鑰在它那一列；舊的「使用者與 AI 助手」抽屜、每個空間內的成員清單、加入空間對話框、角色選單、逐工具 token 選擇都已刪除；**測試詞彙大遷移（PR 7）尚未**。以下為 2026-10-22 的設計提案原文。依 AGENTS.md「對新公共介面先比較至少兩種設計草圖」撰寫；
> 需要使用者決定的事列在第 9 節，其餘章節依「建議」寫成可直接開工的規格。
> 相關：[空間](../spaces.md)、[交給 AI 代理](../agent-delegation.md)、[harness](../harness.md)、
> [membership 與權限 epoch](../membership-and-permission-epoch.md)。
> 引用慣例：`路徑:行號` 皆為 2026-10-22 `main`（`d51619e`）上讀到的內容；後端路徑省略 `packages/backend/src/`，
> 前端省略 `packages/frontend/src/`。

## 0. 摘要

擁有者的決定（2026-10-22）：agent 的存取是「四層」交集、分在兩個畫面，他無法回答「為什麼 agent claude 什麼都讀不到」。

實際讀程式後，這個問題比「四層」更糟，也比文件說的更好解：

1. **工作區角色（viewer/editor/reviewer/admin）對讀寫幾乎已經不起作用。** 自從空間上線（migration 094），讀取只看空間成員
   （`services/spaceScope.ts:1-15`），工作區角色只剩三個用途：判斷誰是擁有者的後備（`spine/authority.ts:118-119`）、
   誰能審核收件匣（`spine/authority.ts:136-140`）、範例資料的資格（`services/sync/bootstrap.ts:310`）。
   對 agent 而言它**完全沒有用途**，但「使用者與代理」畫面仍讓擁有者選它（`components/SideDrawers.tsx:191`），
   這就是擁有者以為自己設了權限、實際沒效果的來源之一。
2. **agent 實際經過的是六道關，不是四道**（第 1.2 節）：agent 是否為該空間的成員、成員身分的 viewer/editor、
   空間的「外部 AI」開關、token 的空間清單、**簽發者（發 token 的人）自己是否在那個空間**（`spine/currentActor.ts:14-21`，
   畫面上完全看不到）、token 的工具清單。新建立的 agent 預設**不屬於任何空間**（`db/migrations/097_explicit_space_membership.sql:1-9`），
   新的共享空間與個人空間的 `external_ai` 預設也是關（`services/spaces.ts:366`、`097…sql:26-29`）——
   所以「claude 讀不到」最常見的三個原因是：沒被加進任何空間、空間的外部 AI 開關是關的、
   擁有者本人不在那個空間（token 範圍被簽發者夾住）。

**建議的目標模型**（細節見第 3–6 節）：

- 工作區只有 `擁有者`（`workspaces.owner_actor_id`，唯一來源）與 `成員`；`actors.role` 欄位最終刪除。
- 每位成員（人或 AI）在**每個空間**有一個權限：`view`（檢視）或 `edit`（編輯）。`manager` 刪除；
  管理空間（成員、開關）只屬於擁有者（個人空間則屬於該人）。
- 存取判斷只在**一處**：新模組 `spine/spaceAccess.ts` 的 SQL 片段，讀取閘、寫入閘、`assertAuthority('space')`、
  agent token 與畫面的「實際存取＋原因」都用它。
- 空間的「外部 AI」開關**保留為空間層級的硬上限**（方案 A），不改成每成員旗標；但畫面把它的後果直接寫在 agent 那一列。
- agent token 只選 `read`／`write`；空間範圍永遠等於 agent 自己的空間成員資格；**移除 per-token 空間範圍**與「簽發者夾住」。
- 擁有權只能透過一個明確的「轉移擁有權」操作改變，資料庫層加守門，避免意外失去擁有權。
- 遷移是「擴充 → 轉換 → 收斂」三步（migration 125／126／127），前兩步可回退；轉換**永不放寬**任何人或 token 的現有可達範圍。

## 1. 現況

### 1.1 每個角色／權限概念：存在哪、在哪檢查

| 概念 | 儲存 | 檢查位置（file:line） |
|---|---|---|
| 工作區角色 `viewer < editor < reviewer < admin` | `actors.role`，預設 `'editor'`（`db/schema.sql:282,286`、`db/migrations/001_baseline.sql:220`）；階層定義 `roles.ts:12-20` | 見下面 1.3。**讀寫閘都不看**（`services/spaceScope.ts:1-15`） |
| 工作區擁有者 | `workspaces.owner_actor_id`（`db/schema.sql:1893`，`ON DELETE SET NULL`）；System 帳號以 `external_id='system'` 辨識（`spine/systemActor.ts`） | `spine/authority.ts:113-123`（`isWorkspaceOwner`）：擁有者 ‖（admin 且〔System ‖ 尚無擁有者〕）；token 永遠不是 |
| 主要權限（principal_admin） | 無，由 `isWorkspaceOwner` 推導 | `spine/authority.ts:201-210`；41 個呼叫點使用（`services/actors.ts`、`tagWrites.ts`、`workspaceModules.ts`、`modules/website/routes.ts`…） |
| 審核者 | `actors.role` ≥ `reviewer` 的人（`spine/authority.ts:136-140`） | `routes/inbox.ts:50-55`（`reviewerDenied`）、`routes/inbox.ts:70-71`、`services/outbox.ts:62,150-153`（`approval: "reviewer" \| "owner"`）、`services/sync/bootstrap.ts:251` |
| 空間成員角色 `viewer < editor < manager` | `space_members(space_id, actor_id, role)`，CHECK（`db/migrations/093_spaces.sql:48`） | `services/spaceScope.ts:31-52`（階層與 SQL 常數）；讀 `spaceScope.ts:68-77`、寫 `spaceScope.ts:101-115,147-168`；`assertAuthority` `spine/authority.ts:178-199` |
| 空間管理者 | `space_members.role='manager'`；共享空間至少一位（僅應用層檢查 `services/spaces.ts:496-497`） | `services/spaces.ts:189-192`（移出）、`399`（改開關）、`468`（候選人）、`489`（設成員）、`533`、`624`（刪除空間）；另有 `services/nodeTrash.ts:305,393,414`（永久刪除垃圾桶內筆記）、`services/backupRestore.ts:247,601,718` 與 `backupRestoreUndo.ts:48`（把備份還原進某空間） |
| 擁有者介入共享空間 | 同上 | `spine/authority.ts:191`（共享空間視同 manager；個人空間不行） |
| 空間類型 `personal`／`shared`／`system` | `spaces.kind`、`spaces.owner_actor_id`（個人空間的主人） | `services/spaces.ts:483-484`（個人／系統空間不能管成員）、`spaces.ts:389`（個人空間開關只歸主人） |
| 空間開關 | `spaces.capabilities` jsonb：`publish`、`external_ai`、`backup`、`shared_seen`、`members_can_move_out`（`services/spaces.ts:348`） | `publish`：`services/spaceScope.ts:127-134`；`external_ai`：token 路徑 `spaceScope.ts:62`、站內 AI `services/harness/scope.ts:53`、`harness/noteSkills.ts:85`、`services/aiRun.ts:120-122`；`members_can_move_out`：`spaces.ts:189` |
| 建立共享空間 | 任何成員，建立者成為 manager | `services/spaces.ts:352-376`（`any_space_write` 權限；`366` 預設開關、`371` 插入 manager） |
| 預設加入哪些空間 | 人類得到個人空間；新成員與 agent **不**加入任何共享空間 | `db/migrations/097_explicit_space_membership.sql:1-34`；System 帳號由開機種子加入 `共用`（`db.ts:263-267`） |
| agent token | `agent_tokens`：`allowed_tools text[]`、`read_space_ids`／`write_space_ids uuid[]`（NULL＝agent 的全部空間）、`expires_at`、`revoked_at`、`issued_by`、`issuer_removed_at`（`db/migrations/094_spaces_on.sql:17-19`、`098_token_issuer.sql`、`102_token_issuer_removed.sql`） | 解析 `spine/currentActor.ts:14-67`；token 空間條件 `services/spaceScope.ts:58-65`；工具 `services/toolScope.ts:33-62`；MCP 限縮 `index.ts:215-222`（bearer 只能打 `/api/mcp/*`） |
| token 範本 | 程式常數（不是資料） | `services/agentTools/templates.ts:20-32`：`read-only`／`organizer`／`researcher`／`publisher`；鑄造時展開成清單存入（`templates.ts:1-6`、`services/actors.ts:463-`） |
| 簽發者 | `agent_tokens.issued_by` | 有效空間＝簽發者的空間 ∩ 授權（`spine/currentActor.ts:14-21`）；簽發者被移除則 token 全撤（`services/actors.ts:763`、`services/agentTokens.ts:125`） |
| 自行註冊 | 第一個人類＝`admin`（並成為擁有者），之後＝`viewer` | `roles.ts:38-40`、`services/actors.ts:383-385`；擁有者由 trigger 設定（`db/migrations/097…sql:16-19`） |
| 邀請 | 預先建立 `actors` 列（`external_id` NULL、含角色）；首次登入以一次性連結認領 | `services/actors.ts:189-231,327-377`（`360` 認領時 actor 暫帶 `viewer`） |
| 被移除成員 | `member_removals`、`session` 終止 | `services/actors.ts:737-`；重新登入時 `actors.ts:379` 拋 401 `membership_removed`（`services/memberRemovals.ts`） |
| membership epoch | `workspaces.membership_epoch` | 空間成員、移動、開關、token 變更會 bump：`services/spaces.ts:393-395,489`、`services/actors.ts:595,696,720,757`；協定見 [membership 文件](../membership-and-permission-epoch.md) |

### 1.2 agent 的存取路徑（實際六道關）

agent 以 bearer token 呼叫 MCP（`index.ts:183`、`services/agentTokens.ts:142-159`）。每次請求重新載入一次授權
（`spine/currentActor.ts:33-67`）。一則筆記對 token 可讀，必須**同時**成立：

| # | 關卡 | 在哪裡 | 畫面上看得到嗎 |
|---|---|---|---|
| 1 | token 有效：未撤銷、未過期、非 System 帳號 | `currentActor.ts:50-52` | 「使用者與代理」→ 鑰匙；撤銷／到期要點開 token 列表 |
| 2 | agent 是該空間的**成員**（任何角色） | `spaceScope.ts:69-71`（`FROM space_members m … WHERE m.actor_id = …`） | 在「設定 › 空間」展開某空間才看得到；agent 沒有「我在哪些空間」的總覽 |
| 3 | 空間的 **`external_ai` 開關為開** | `spaceScope.ts:62` | 在「設定 › 空間」的核取方塊；token 畫面沒說 |
| 4 | token 的 `read_space_ids`（NULL＝不再限制） | `spaceScope.ts:63`、`currentActor.ts:15-17` | 鑄造／重設範圍表單（`components/TokenManager.tsx`） |
| 5 | **簽發者**自己是該空間成員（寫入還要是 editor 以上） | `currentActor.ts:14-21`：有效清單＝簽發者的空間 ∩ token 清單；簽發者被移除則為空（`issuer_removed_at`，`:15`） | **完全看不到** |
| 6 | 呼叫的工具在 `allowed_tools` 內 | `toolScope.ts:33-36,60-62` | token 列顯示「N 個工具」 |

寫入另外要求：agent 在該空間是 `editor`／`manager`（`spaceScope.ts:52,107`）、空間在 `write_space_ids` 內
（`spaceScope.ts:61,101-115`）、簽發者在該空間是 editor 以上（`currentActor.ts:20`）。
改變可見範圍的動作（移動筆記、設定成員、改開關）對 token 一律拒絕（`spine/authority.ts:179-181`；`spaces.ts:132-135`）。

**「工作區角色」不在上表**：`actors.role` 對 agent 的讀寫沒有任何影響（grep 全部 `.role`／`roleAtLeast` 呼叫點，
非測試程式僅剩 `spine/authority.ts:139`、`services/sync/bootstrap.ts:298,310`、`services/actors.ts` 的管理操作）。
所以擁有者看到的「四層」其實是：工作區角色（無效）、空間角色（第 2 關）、外部 AI 開關（第 3 關）、token 工具＋範圍（第 4、6 關），
而真正讓人困惑的第 5 關完全隱形。

**「claude 讀不到」的檢查清單**（目前要人工依序查）：token 是否已過期／撤銷 → claude 是否被加進**任何**空間
（新 agent 預設沒有）→ 該空間 `external_ai` 是否為開（新共享空間預設是關）→ token 的空間清單是否把它排除 →
擁有者本人是否也在那個空間 → 呼叫的工具是否在清單內。第 6.3 節把這個清單變成畫面上的一行原因。

### 1.3 工作區角色的所有實際用途（非測試）

- `spine/authority.ts:113-123`：`isWorkspaceOwner` 的後備——無擁有者時，admin 就是擁有者；System 帳號需 admin。
  這個後備是「意外失去擁有權後，任何 admin 自動接手」的來源。
- `spine/authority.ts:136-140`：審核資格＝擁有者，或 `type=human` 且角色 ≥ reviewer。
- `services/actors.ts:101-103`（驗證）、`195`（建立預設 `editor`）、`411-425`（改角色；`418-419` 擁有者角色固定，`424` 禁止自我升為 admin）。
- `services/sync/bootstrap.ts:298`（回傳 `actor_role`）、`310`（`example_seed_eligible`）。
- `components/SideDrawers.tsx:191`（選單：`viewer`/`editor`/`reviewer`）、`252`（旁邊的提示「看得到什麼要到設定 › 空間」）。
- 備份：`services/backupArchive.ts:226-234` 匯出 `space_members.role`（備份格式含空間角色）。

### 1.4 現在的兩個畫面

- **使用者與代理**（`components/SideDrawers.tsx:89-`）：人與 agent 的表格、角色下拉、邀請（連結一次性顯示）、
  移除、每個 agent 的 token 區（`TokenManager`）。
- **設定 › 空間**（`settings/SpacesSetting.tsx`；分頁登記 `settings/registry.tsx:50`）：每個空間一列，
  展開後看成員與角色、五個開關（`SpacesSetting.tsx:49-54`）、新增成員的 `select`、改名／刪除。
  `AGENTS.md` 與 `ExternalAiOffNotice`（`components/ExternalAiOffNotice.tsx:7,18`）都把使用者導向這裡。

兩個畫面沒有一處能回答「這個 agent 現在讀得到什麼、為什麼」。

### 1.5 文件與程式的出入（修正順序前先記下）

- [spaces.md](../spaces.md) 待確認 3 寫「移除 reviewer 角色」、對照表寫「principal_admin：單一擁有者」，
  但程式仍有 reviewer（`roles.ts:12`、`authority.ts:136-140`）與「無擁有者時 admin 接手」（`authority.ts:118-119`）。
- spaces.md 寫「建立共享空間的人自動成為管理者」，這也是目前行為（`spaces.ts:371`）；本提案會改變它（第 9 節決定 2）。
- `agent-delegation.md` 規則 2 的「token ＝哪些空間 × 哪些工具」將變成「token ＝ 讀／寫」。

## 2. 設計目標與不變條件

1. 擁有者只需理解：**誰在哪個空間有什麼權限**（人與 AI 同一種成員）＋ **這個空間的開關**。
2. 任何一個「讀不到／寫不到」都能在畫面上指出**第一個擋住它的原因**。
3. 只有一個函式回答「這個操作者能不能讀／寫這個空間」；沒有另一份 TypeScript 規則平行存在。
4. 遷移不放寬任何既有可達範圍（人與 token 皆然）；放寬只會是擁有者之後明確的操作。
5. 擁有權不會被意外移走或清空。

## 3. 目標模型

### 3.1 概念

- **擁有者**：每個工作區恰有一位（`workspaces.owner_actor_id`）。人類。管理一切：成員、空間、開關、token、模組、標籤定義、
  審核收件匣。原生 App 的 System 帳號在該裝置上等同擁有者（沿用 `authority.ts:118-119` 的 `external_id` 判斷，去掉 role 條件）。
- **成員**：其餘所有人與 AI（`actors` 列，`type='human'|'agent'`）。沒有任何工作區層級的權限差異。
- **空間權限**（每位成員 × 每個空間一個值）：`view`（可讀）、`edit`（可讀寫）。沒有紀錄＝不是成員＝讀不到。
  個人空間：主人是唯一成員，固定 `edit`；擁有者也不能進入（沿用 spaces.md 不變條件，`spaces.ts:483`）。
- **誰能管理空間**：共享／系統空間＝擁有者；個人空間＝其主人（`spaces.owner_actor_id`）。不再有 `manager` 成員。
- **AI 代理就是成員**：同一張表、同一個權限值。它能做什麼＝（它的空間權限）∩（空間開關）∩（token 的唯讀／可寫）。

### 3.2 資料模型

```sql
-- 125（擴充，可整支回退）──────────────────────────────────────────────
ALTER TABLE space_members ADD COLUMN permission text;           -- 先可為 NULL
UPDATE space_members SET permission =
  CASE role WHEN 'viewer' THEN 'view' ELSE 'edit' END;          -- editor、manager → edit
ALTER TABLE space_members ALTER COLUMN permission SET NOT NULL;
ALTER TABLE space_members ADD CONSTRAINT space_members_permission_check
  CHECK (permission IN ('view', 'edit'));                       -- 日後新增權限＝改這條 CHECK
ALTER TABLE agent_tokens ADD COLUMN access text;                -- 'read' | 'write'；126 回填後 NOT NULL
CREATE TABLE owner_member_migration_log (                       -- 轉換前影像＋報告，供回退與擁有者檢視
  id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, step text NOT NULL,
  subject_type text NOT NULL, subject_id uuid, space_id uuid,
  before jsonb NOT NULL, after jsonb, note text, created_at timestamptz NOT NULL DEFAULT now());
-- 雙向相容 trigger：舊程式只寫 role、新程式只寫 permission 時，另一欄由 trigger 補（見 7.2）。

-- 126（轉換，見第 7 節）──────────────────────────────────────────────
-- 127（收斂，至少一個發佈週期之後）─────────────────────────────────────
ALTER TABLE space_members DROP COLUMN role;
ALTER TABLE agent_tokens  DROP COLUMN read_space_ids, DROP COLUMN write_space_ids;
ALTER TABLE actors        DROP COLUMN role;                     -- 連同 actors_role_check
ALTER TABLE workspaces ALTER COLUMN owner_actor_id ...;         -- 守門見 3.5
```

其餘資料不變：`spaces`（`kind`、`owner_actor_id`、`capabilities`）、`workspaces.owner_actor_id`、`agent_tokens.allowed_tools`
（見 3.4）、`member_removals`、`space_members` 的主鍵 `(space_id, actor_id)`。

TypeScript 型別（取代 `SpaceRole`，`services/spaceScope.ts:31-36`）：

```ts
export const SPACE_PERMISSIONS = ["view", "edit"] as const;
export type SpacePermission = (typeof SPACE_PERMISSIONS)[number];
// 未知字串低於所有權限（沿用 spaceScope.ts:40-42 的 fail-closed 寫法）
```

### 3.3 存取判斷只在一處

新模組 `spine/spaceAccess.ts`（取代 `spaceScope.ts` 的角色與 token 子句；`spaceScope.ts` 其餘節點層級函式保留並改呼叫它）。
契約與呼叫範例（先寫契約，依 AGENTS.md）：

```ts
/** 操作者對一個空間的存取，以及沒有存取時第一個擋住的原因。
 *  actor 必須來自 resolveCurrentActor（重讀過的目前授權）。 */
export type SpaceAccess = {
  read: boolean;
  write: boolean;
  /** read 為 false 時的第一個原因；write 為 false（read 為 true）時的第一個原因。 */
  readBlockedBy: AccessBlock | null;
  writeBlockedBy: AccessBlock | null;
};
export type AccessBlock =
  | "not_member"       // 沒被加入這個空間
  | "no_live_token"    // （agent）沒有未過期、未撤銷的 token
  | "external_ai_off"  // 空間的外部 AI 開關是關（只對 agent／站內 AI）
  | "view_only"        // 成員權限是檢視
  | "token_read_only"; // （agent）token 是唯讀

export function spaceAccessSql(actor: ActorCtx, params: unknown[]): string;   // 子查詢：space_id, can_read, can_write, read_block, write_block
export async function spaceAccess(actor: ActorCtx, spaceId: string): Promise<SpaceAccess>;

// 既有 API 變成薄包裝：
//   readableSpaceIdsSql(actor, params) = 選 spaceAccessSql 中 can_read
//   writableSpaceIdsSql / spaceCanWrite / spaceWritable / canWriteSomewhere 同理
//   assertAuthority({kind:"space", spaceId, need:"read"|"write"|"manage"})
```

規則（寫成一段 SQL，不在 TypeScript 重寫第二份）：

```
can_read(actor, S)  = S 未刪除
                      ∧ actor 在 space_members(S)
                      ∧ （actor 是 token → S.capabilities.external_ai = true ∧ token 有效）
can_write(actor, S) = can_read ∧ permission = 'edit'
                      ∧ （actor 是 token → token.access = 'write'）
manage(actor, S)    = S.kind ∈ {shared, system} ? isWorkspaceOwner(actor)
                    : actor = S.owner_actor_id          -- token 永遠 false
```

與現況的差別只有三處：沒有 `read_space_ids`／`write_space_ids`（現 `spaceScope.ts:61-63`）；沒有簽發者夾住
（現 `currentActor.ts:14-21`）；`manager` 變成 `manage` 這個由空間種類與擁有者決定的能力，不再是成員資料。

`Authority` 聯集（`spine/authority.ts:48-101`）的 `{kind:"space", min:SpaceRole}` 改為 `{kind:"space", need:"read"|"write"|"manage"}`；
`space_write` 保留。全部 17 個 `kind: "space"` 呼叫點（`grep`：`services/spaces.ts` 10 個、`nodeTrash.ts` 3 個、`backupRestore.ts` 3 個、`backupRestoreUndo.ts` 1 個）一次改名；其中 `nodeTrash.ts` 與 `backupRestore.ts` 的 `min: "manager"`（永久刪除、還原備份進空間）同樣變成 `need: "manage"`＝擁有者（共享空間）或個人空間的主人，列入第 7.3 節的影響報告。
`reviewAuthority`（`authority.ts:136`）改為只回傳 `isWorkspaceOwner`（第 9 節決定 1）。

### 3.4 token 模型

| 欄位 | 現況 | 目標 |
|---|---|---|
| `access` | 無（用 `template` 與 `allowed_tools` 表達） | `'read' \| 'write'`，鑄造時選，必填 |
| `allowed_tools` | 使用者可傳清單或範本；NULL＝全部工具 | **內部欄位**：由 `access` 在鑄造／變更時展開成固定清單（沿用 `templates.ts:1-6` 的「註冊表成長不會悄悄放寬既有 token」），UI 不顯示、不接受任意清單 |
| `read_space_ids`／`write_space_ids` | 可選的清單，NULL＝agent 全部空間 | 刪除（127）。範圍＝agent 的成員資格 |
| `issued_by`、`issuer_removed_at` | 夾住有效空間（`currentActor.ts:14-21`） | 只用於稽核與「簽發者被移除就撤銷」（`services/actors.ts:763`）；**不再夾住空間** |
| `expires_at`、`revoked_at`、`name` | 同 | 同 |

工具分類：`AgentTool`（`services/agentTools/types.ts:16-25`）新增必填欄位 `access: "read" | "write"`；
`READ_ONLY` 與其他範本常數（`templates.ts:20-25`）改由註冊表推導，新增工具時必須宣告分類，測試固定目前清單。
`write` ＝ 目前的 `researcher` 組（`organizer` + `createNode` + `proposeTagPack`）。`publishSite` 不在標準 `write` 內（第 9 節決定 4）：
它本來就要擁有者核准（`templates.ts:12-13`），既有 `publisher` token 的 `allowed_tools` 原樣保留。

### 3.5 擁有權守門

目前的防呆：擁有者角色不可改（`services/actors.ts:418-419`）、不能刪自己（`:739`）。缺口：

- `workspaces.owner_actor_id` 是 `ON DELETE SET NULL`（`db/schema.sql:1893`），直接 SQL 或未來的刪除路徑會把工作區變成「無擁有者」，
  接著 `authority.ts:118-119` 讓任何 admin 變成擁有者。
- 沒有「交棒」的合法路徑，所以出事時只能手改資料庫。

目標：

1. 後備規則刪除：**沒有擁有者的工作區沒有擁有者**（System 帳號在原生裝置上仍是擁有者，那是以 `external_id` 判斷，與工作區無擁有者無關）。
2. 127 改 FK 為 `ON DELETE RESTRICT`，並加 `BEFORE UPDATE OF owner_actor_id` trigger：舊值非 NULL 時，只有在同一交易以
   `SET LOCAL onden.owner_transfer = '<新擁有者 uuid>'` 宣告且新值相符才允許；其他一律拒絕。新擁有者必須是同工作區、
   `type='human'`、`external_id IS NOT NULL`（已登入過、非待認領邀請）的成員。
3. 唯一合法入口：`POST /api/workspace/owner-transfer {to_actor_id, confirm_name}`——只有目前擁有者的**登入工作階段**
   （非 token、非 System 除非原生繞過啟用）、`confirm_name` 必須逐字等於新擁有者的名稱；同一交易寫 `WORKSPACE_OWNER_TRANSFERRED`
   事件、bump membership epoch；舊擁有者降為一般成員（保留其空間成員資格）。可用 `Idempotency-Key` 重試。
4. 擁有者不能被移除、不能被降權、不能從 `GET /api/actors` 的操作列表上看到刪除按鈕（API 同樣拒絕，不只是隱藏）。
5. 擁有者帳號遺失：只有「維運程序」（文件中的 SQL，需設 `onden.owner_transfer`），沒有任何 API 後門。

## 4. 比較過的設計（有實際取捨的地方）

### 4.1 空間權限存哪裡

| | A. 原表收窄：`space_members.permission` | B. 新表 `space_member_permissions` | C. 工作區層級預設＋例外 |
|---|---|---|---|
| 呼叫範例 | `INSERT … (space_id, actor_id, permission)` | 另一張表，舊表停用 | 每人一個工作區預設權限，空間內寫例外 |
| 要懂的概念 | 一張表一欄 | 兩張表要同步，遷移期間誰是真相？ | 兩層疊加，正是擁有者看不懂的「多層」 |
| 遷移 | 加欄、回填、收斂；既有 `PK (space_id, actor_id)`、FK cascade、epoch trigger 全部沿用 | 8 個後端檔案直接讀寫 `space_members`（`spaceScope.ts`、`spaces.ts`、`currentActor.ts`、`backupArchive.ts:226-234`、`db.ts:263-267`…），另有 23 處使用角色常數，全部要換表 | 需要新欄＋新規則，且讓「工作區角色」復活 |
| 回退 | 125 只加欄，可直接 DROP；`role`／`permission` 以 trigger 雙向同步到 127 | 回退要搬資料 | — |
| 備份格式 | 備份讀寫 `permission`，匯入時接受舊 `role`（`backupArchive.ts:226-234`） | 新格式 | — |

**建議 A。** 現有的 `space_members` 本來就是「每位成員 × 每個空間一列」，需要改變的只是值域（`manager` 不再是成員資料）。
B 沒有消除任何概念，只增加遷移面；C 重建了要移除的工作區層級。

### 4.2 「外部 AI」開關怎麼辦

| | A. 保留為空間開關（硬上限），畫面說明後果（建議） | B. 改成每位成員一個「AI 可讀」旗標 | C. 移除開關，加入 AI 成員即同意 |
|---|---|---|---|
| 擁有者要理解 | 「這個空間的筆記能不能離開伺服器去給 AI」一個開關 | 每個（成員 × 空間）又多一個旗標＝乘出新的層 | 少一層 |
| 站內 AI（人按「問 AI」）如何處理 | 沿用 `harness/scope.ts:53`、`noteSkills.ts:85`，不變 | 站內 AI 不是成員，仍需要空間層級的開關，結果兩套 | 需要另一個機制 |
| 遷移是否放寬 | 否 | 要為每個 agent×空間決定旗標，易放寬 | **會放寬**：現有「agent 是成員但開關關閉」的組合（在 `spaceScope.ts:62` 被擋）會突然可讀 |
| 事後關閉的成本 | 一個開關即刻切斷所有 agent 與站內 AI（`spaces.ts:393-395` 已 bump epoch） | 要逐一取消旗標 | 要逐一移除 agent |
| 對「為什麼讀不到」的幫助 | 原因 `external_ai_off` 可直接顯示在 agent 那一列 | 同上但多一個去處 | 不會出現這個原因 |

**建議 A。** 它仍是真正獨立的政策（兩條外流路徑共用一個閘），保留它最不會放寬；擁有者的困惑來自它**藏在另一個畫面**，
解法是把它放進空間卡片、並在受它影響的 agent 列直接寫出（第 6 節）。只做文案改名：「可送給 AI（內建 AI 與代理）」。

### 4.3 「單一檢查函式」的形式

| | A. TypeScript 函式讀取事實後判斷＋另寫 SQL 版本 | B. SQL 片段為唯一實作，TypeScript 包裝（建議） |
|---|---|---|
| 一致性 | 兩套實作，需要並行測試防漂移（AGENTS.md「逐筆與集合查詢兩種實作」） | 逐筆與集合查詢都由同一片段產生；沒有第二份規則 |
| 原因（reason） | 容易在 TS 版寫、SQL 版漏 | 同一個 `CASE` 順序決定原因，畫面與閘一致 |
| 現況 | — | `spaceScope.ts` 已是 SQL 優先（`:58-77`），只是 token 子句與角色常數散在 `currentActor.ts`、`spaces.ts` |
| 效能 | 逐筆多一次往返 | 可推進分頁查詢的 `WHERE`（`readableScopeSql`，`readPolicy.ts:38-40`） |

**建議 B。** 仍加一個「parity 測試」：舊實作（`spaceScope.ts` 現版）與新片段在固定 fixture 上對 人類 × token × 讀／寫 結果逐一比較，
作為 PR 2（第 10 節）的完成條件。

### 4.4 token 的工具限制怎麼存

| | A. 只存 `access`，每次請求由註冊表推導工具集 | B. 存 `access` ＋鑄造時展開的固定清單（建議） |
|---|---|---|
| 新增寫入工具時 | **所有 `write` token 立刻多一個工具**＝悄悄放寬 | 既有 token 不變，要新工具時重新設定存取（再展開一次） |
| 與現況相容 | 破壞 `templates.ts:1-6` 的承諾 | 沿用 |
| 缺點 | — | 兩欄要一致：只由一個函式寫入，測試固定 |

**建議 B。** `allowed_tools = NULL`（目前代表「全部工具」）的舊 token 在遷移後標為 `write` 加「舊：全部工具」徽章，不悄悄收窄也不放寬，
由擁有者在畫面上一鍵改成標準 `write`。

### 4.5 擁有者身分的唯一來源

保留 `actors.role='owner'` 與 `workspaces.owner_actor_id` 兩處會產生不一致（現在就有：`authority.ts:118-119` 兩者混用）。
**建議只用 `workspaces.owner_actor_id`**，`actors.role` 在 127 刪除；System 帳號由 `external_id` 判斷。

### 4.6 可不可以只有 `view`／`edit`

候選：`comment`（沒有留言功能）、`add-only`（只新增不改他人）、`edit 但不能刪`、`限時`。
**建議目前只有兩級**：「不能刪」可由復原／垃圾桶補救（[restore-writes](../restore-writes.md)）；agent 的寫入本來就進收件匣由擁有者審核
（[agent-delegation.md](../agent-delegation.md) 規則 3）；限時存取目前只對 token 有意義，且已有 `expires_at`。
需要時只改 CHECK 與 `spaceAccess.ts` 的 `CASE`，因為判斷集中在一處。

## 5. 有效存取（畫面顯示的原因）

`GET /api/spaces/overview`（僅擁有者；其他人用既有 `GET /api/spaces`，`routes/spaces.ts:19-23`，只回自己的空間）回傳：

```jsonc
{
  "owner_id": "…",
  "spaces": [{
    "id": "…", "name": "實驗室", "kind": "shared",
    "capabilities": {"publish": false, "external_ai": false, "backup": true, "shared_seen": false, "members_can_move_out": false},
    "members": [
      {"actor_id": "…", "name": "小明", "type": "human", "permission": "edit"},
      {"actor_id": "…", "name": "claude", "type": "agent", "permission": "edit",
       "effective": {"read": {"ok": false, "blocked_by": "external_ai_off"},
                     "write": {"ok": false, "blocked_by": "external_ai_off"}}}
    ]
  }],
  "unplaced": [{"actor_id": "…", "name": "claude", "type": "agent", "spaces": 0}],  // 不在任何共享空間的成員
  "agents": [{"actor_id": "…", "live_tokens": 1, "write_tokens": 0}]
}
```

私人空間**不出現在 overview**（只出現在本人的 `GET /api/spaces`），擁有者看不到別人的個人空間名稱與成員，沿用 spaces.md 的隱私決定。

原因順序（第一個為真者）與畫面文字：

| 順序 | `blocked_by` | 適用 | 文字（zh-TW） |
|---|---|---|---|
| 1 | `no_live_token` | agent，讀寫 | 讀不到：沒有有效的 token（已過期或撤銷） |
| 2 | `not_member` | 只出現在 `unplaced` 與「為什麼」彈窗 | 讀不到：還沒加入任何空間 |
| 3 | `external_ai_off` | agent，讀寫 | 讀不到：這個空間的「可送給 AI」是關的 |
| 4 | `view_only` | 寫 | 不能寫：此成員在這個空間只有檢視權限 |
| 5 | `token_read_only` | agent，寫 | 不能寫：token 是唯讀 |

agent 有多個 token 時，`effective` 取最寬鬆者（任一有效 `write` token 即可寫）。因為 token 之間現在只差 `access` 與到期，
這個合併是完整的，不需要 per-token 範圍說明。計算方式：對每個 agent 以一個合成的 token 脈絡呼叫 `spaceAccessSql`
（`access` ＝ `bool_or(t.access='write')`），畫面與閘共用同一個 `CASE`。

## 6. 畫面規格：「空間與成員」

取代：`設定 › 空間`（`settings/registry.tsx:50`）與「使用者與代理」抽屜（`components/SideDrawers.tsx:89-`）。
舊入口（`ExternalAiOffNotice` 的「Open Settings › Spaces」`components/ExternalAiOffNotice.tsx:18`、各處「Settings › Spaces」提示）
全部改指向 `openSettings("spaces")`，分頁 id 保留 `spaces` 以免深連結失效，標籤改為「空間與成員」。

### 6.1 內容與責任

| 區塊 | 內容 | 操作 |
|---|---|---|
| ① 需要注意 | 沒有任何空間的成員（尤其是 agent）；有「待認領邀請」的人 | 「加入空間」（開 6.3 的選擇器） |
| ② 空間卡片 | 每個共享空間一張：名稱、成員列、開關、實際存取 | 改權限、移除成員、＋加入成員、開關、改名、刪除 |
| ③ 所有成員 | 人與 AI 一覽：邀請（email→一次性連結）、重新產生連結、移除、AI 的 token | 邀請／移除（含確認）、鑄造 token（只選 唯讀／可寫）、撤銷 |
| ④ 擁有權 | 擁有者名稱＋鎖頭、「轉移擁有權…」（危險區） | 轉移（輸入新擁有者名稱確認） |

擁有者以外的成員仍進得了此分頁，但只看到「我的空間與權限」唯讀清單與個人空間的開關（個人空間由本人管理）。

### 6.2 390 px（手機）

```
┌ 空間與成員 ─────────────── ✕ ┐
│ ⚠ 需要注意（1）                │
│  claude（AI）                  │
│  還沒加入任何空間，所以讀不到   │
│  任何筆記。   [加入空間]       │
├───────────────────────────────┤
│ 實驗室                  ▾     │   ← 一張卡片，點開展開
│ 3 人 · 1 個 AI                 │
│ claude 可讀、不能寫            │   ← 收合時的一行摘要
├───────────────────────────────┤
│ 實驗室（展開）           ▴     │
│ 成員                           │
│  小明                          │
│  (檢視)(●編輯)                 │   ← 兩段式單選，各 ≥44px
│  陳教授                        │
│  (●檢視)(編輯)         ⋯      │   ← ⋯：移除
│  claude  AI                    │
│  (●檢視)(編輯)         ⋯      │
│   ⓘ 讀不到：這個空間的「可送給 │
│     AI」是關的   [開啟]        │   ← 原因＋就地動作
│  [＋ 加入成員]                 │   ← 全寬按鈕 ≥44px
│ 這個空間                       │
│  ☐ 可公開發佈                  │
│  ☑ 可送給 AI（內建 AI 與代理） │
│  ☑ 包含在備份                  │
│  ☐ RSS 已讀共享                │
│  ☐ 編輯者可把筆記移出          │
│  [改名] [刪除空間…]            │
├───────────────────────────────┤
│ 所有成員（4）                  │
│  你（擁有者）🔒                │
│  小明 · 陳教授 · claude        │
│  [邀請成員]  claude: [管理 token]│
└───────────────────────────────┘
```

### 6.3 桌面（≥ 900 px）

```
┌ 空間與成員 ────────────────────────────────────────────────┐
│ ⚠ claude（AI）還沒加入任何空間…   [加入空間]               │
│ ┌ 實驗室 ───────────────────┐ ┌ 共用 ─────────────────────┐│
│ │ 小明      (檢視)(●編輯)  ⋯ │ │ 小明      (檢視)(●編輯)  ⋯ ││
│ │ 陳教授    (●檢視)(編輯)  ⋯ │ │ claude AI (●檢視)(編輯)  ⋯ ││
│ │ claude AI (●檢視)(編輯)  ⋯ │ │   ✓ 可讀 · ✗ 不能寫：token 唯讀││
│ │  ⓘ 讀不到：可送給 AI 是關的 │ │ [＋ 加入成員]              ││
│ │ [＋ 加入成員]              │ │ ☑可公開發佈 ☑可送給AI …    ││
│ │ ☐發佈 ☑AI ☑備份 …          │ └────────────────────────────┘│
│ └────────────────────────────┘ ┌ 所有成員 ──────────────────┐│
│                                 │ 你（擁有者）🔒 小明 …      ││
│                                 │  ⠿ 可拖曳到卡片（加強功能）││
│                                 └────────────────────────────┘│
└────────────────────────────────────────────────────────────┘
```

### 6.4 可及性的加入成員流程（WCAG 2.5.7、2.5.8）

主流程**不需要拖曳**：每張卡片都有「＋ 加入成員」按鈕；拖曳只是桌面的加速方式，且有等價的單指標、鍵盤路徑。

1. 按「＋ 加入成員」→ 開啟 `ShellDialog`（portal、焦點圈住、Esc 關閉、關閉後焦點回到按鈕；沿用 AGENTS.md 第二十一批）。
2. 對話框標題「加入成員到 實驗室」；搜尋欄（`type=search`，附 label）＋候選清單（`role=listbox`，可用上下鍵）。
   候選＝尚未在此空間的人與 AI，並以圖示＋文字標示「AI」。
3. 選一個後，出現權限單選：「檢視」（預設）／「編輯」，並顯示一行說明：「檢視：只能讀。編輯：可以新增、修改、刪除。」
4. 若選的是 AI 且此空間「可送給 AI」是關的，顯示警告列：「這個空間的筆記不會送給 AI，claude 加入後仍讀不到。[同時開啟]」——
   不自動開啟，由擁有者決定。
5. 「加入」按鈕送出並等待伺服器結果（沿用保存契約：成功才關閉、失敗保留選擇並顯示錯誤）。
6. 成功後用 `role=status` 播報：「已將 claude 加入 實驗室（檢視）」，並在卡片上把新成員列聚焦。
7. 桌面拖曳：「所有成員」清單項目可拖到卡片；放開後等同步驟 3 的預設值（檢視），並出現可「復原」的提示。
   鍵盤與觸控使用者用 1–6；拖曳不是任何功能的唯一入口。

其他規範：權限單選用 `role=radiogroup`，每段 ≥44×44 px（本專案手機慣例）；狀態不只靠顏色（圖示＋文字）；
`prefers-reduced-motion` 下不做展開動畫；原因文字與「[開啟]」等動作按鈕同列，螢幕閱讀器順序為「成員名稱 → 權限 → 原因 → 動作」。

### 6.5 文案

| 位置 | 文字 |
|---|---|
| 分頁名 | 空間與成員 |
| 權限 | 檢視／編輯；說明「檢視：只能讀。編輯：可以新增、修改、刪除。」 |
| AI 標示 | 「AI」徽章，tooltip「AI 代理，透過 token 存取」 |
| 開關名 | 可公開發佈／可送給 AI（內建 AI 與代理）／包含在備份／RSS 已讀共享／編輯者可把筆記移出 |
| 擁有者 | 「擁有者」＋鎖頭；說明「擁有者管理所有空間與成員，無法被移除。要換人請用『轉移擁有權』。」 |
| 轉移 | 標題「轉移擁有權」；內文「轉移後，{新名稱} 會成為擁有者，你變成一般成員，仍保留在原本的空間。這不能由 AI 或其他成員代為操作。請輸入『{新名稱}』確認。」 |
| 唯讀 token | 「唯讀：只能查詢，不能修改筆記」 |
| 可寫 token | 「可寫：可新增與修改筆記、套用標籤；仍只能在它有『編輯』權限的空間寫入，且新增的內容會出現在收件匣供你檢視」 |
| 無空間 | 「還沒加入任何空間，所以讀不到任何筆記」 |
| 原因（`blocked_by`） | 見第 5 節表 |

## 7. 遷移計畫

編號：目前最新是 `124_actor_prefs.sql`（`ls packages/backend/db/migrations`，`121` 從未存在）。本提案用 **125、126、127**。
遷移器依檔名順序執行（`db.ts:176-205`，advisory lock 序列化）。

### 7.1 步驟

| 步驟 | 內容 | 可回退？ |
|---|---|---|
| **125 擴充** | 加 `space_members.permission`（回填）、`agent_tokens.access`（可為 NULL）、`owner_member_migration_log`；`role`⇄`permission` 雙向 trigger | 是：DROP 新欄／表／trigger，舊欄從未被改動 |
| **126 轉換** | 資料轉換（7.3）；寫 log 前影像；`workspaces.owner_actor_id` 缺值回填；`agent_tokens.access` 回填後 NOT NULL | 資料層可回退：log 保存轉換前 `space_members.role`、`actors.role`、token 範圍與撤銷狀態，附 `126_down.sql`（放在 runbook，不自動執行） |
| **127 收斂** | 刪除 `actors.role`、`space_members.role`、token 範圍欄、相容 trigger；擁有權守門（3.5） | 否（刪欄），所以要等 7.4 的相容期結束並先備份資料庫 |

每一步都附：整合測試（第 8.3 節）、`RAISE NOTICE` 摘要（沿用 094 的做法，`094_spaces_on.sql`），以及寫入
`owner_member_migration_log` 的結構化紀錄，擁有者可在新畫面看到「這次升級改了什麼」。

### 7.2 相容策略（升級期間舊程式／舊用戶端並存）

- 資料庫：`space_members.role` 與 `permission` 由 trigger 雙向補值（`role`: viewer↔view，editor↔edit；`manager` 寫入視為 `edit`）。
  125 起新伺服器只寫 `permission`；若回滾到舊伺服器映像，舊伺服器讀到的 `role` 仍正確。`actors.role` 新伺服器停止寫入、保持預設。
- API：下表。相容期固定為**至少兩個發佈版本且 ≥ 30 天**，並檢查 Android 殼 App（`packages/frontend/android`）最低版本後才進 127。

| 舊用戶端請求 | 相容期內伺服器行為 |
|---|---|
| `POST /api/actors {role:"viewer"\|"editor"}` | 接受，建立成員；`role` 忽略（與現在實際效果相同：工作區角色不影響讀寫）；回應含 `Deprecation: true` |
| `POST/PATCH /api/actors {role:"admin"\|"reviewer"}` | **400 `role_removed`**，訊息「改用擁有者／成員；審核由擁有者進行」。不悄悄降級，避免擁有者以為已授權 |
| `PATCH /api/actors/:id {role:"viewer"\|"editor"}` | 200 no-op + `Deprecation`（現況同樣沒有實際權限效果） |
| `PUT /api/spaces/:id/members/:actorId {role}` | `viewer→view`、`editor→edit`、`manager→edit`（回應 `warnings:["manager_is_edit"]`） |
| `POST /api/actors/:id/tokens {template}` | `read-only→read`；`organizer/researcher/publisher→write`（`publisher` 的 `allowed_tools` 照舊展開） |
| `POST …/tokens {allowed_tools}` | 清單**等於**某個已知存取集合才接受；否則 400 `custom_tools_removed` |
| `POST/PATCH …/tokens {read_space_ids/write_space_ids 非 null}` | **400 `token_scope_removed`**（絕不悄悄放寬成「agent 全部空間」） |
| `GET /api/actors`、`GET /api/spaces`、`GET /api/bootstrap` | 同時回新欄位 `permission`／`access`／`actor_is_owner` 與舊欄位（`role` 由 `permission` 映射；`actor_role`: 擁有者回 `"admin"`、其餘 `"editor"`） |
| 備份匯入舊檔 | `services/backupRestore.ts` 接受 `role` 或 `permission`；`manager→edit`；匯出新檔含兩者直到 127 |
| 離線佇列中的舊請求 | 管理操作需要線上（`SideDrawers.tsx` 的 `disabled={!online}`），不進離線佇列；一般筆記寫入與本提案無關 |

### 7.3 既有資料對應（每個現有值）

**工作區角色 `actors.role`**

| 現值 | 新身分 | 實際影響 |
|---|---|---|
| `admin`，且是 `owner_actor_id` | 擁有者 | 無 |
| `admin`，人類、非擁有者 | 成員 | 失去審核資格（`authority.ts:139`）與範例資料資格（`bootstrap.ts:310`）；`principal_admin` 本來就不給（`authority.ts:201-210`）。報告列出 |
| `admin`，System 帳號（`db.ts:250-252`） | 原生裝置上仍視同擁有者 | 無（改用 `external_id` 判斷，不需 role） |
| `admin`，agent | 成員 | 無（對 agent 本來無效） |
| `reviewer` | 成員 | 失去收件匣審核；報告列出。若擁有者要保留此能力，見第 9 節決定 1 |
| `editor`、`viewer` | 成員 | **無**：讀寫由空間成員資格決定（`spaceScope.ts:1-15`）。這也不會讓 `viewer` 變得可寫——它從來沒有限制過寫入 |

**空間成員角色 `space_members.role`**

| 現值 | 新權限 | 備註 |
|---|---|---|
| `viewer` | `view` | 無變化 |
| `editor` | `edit` | 無變化 |
| `manager`，擁有者 | `edit` | 擁有者管理權來自身分 |
| `manager`，非擁有者，共享空間 | `edit` | **失去管理權**（改開關、加成員、移出）。逐一寫入報告（空間、人） |
| `manager`，個人空間的主人 | `edit` | 管理權來自 `spaces.owner_actor_id` |
| `manager`，System 帳號在 `共用` | `edit` | 原生裝置上它是擁有者 |
| 原 manager 曾可做的另兩件事：永久刪除垃圾桶筆記（`nodeTrash.ts:305,393,414`）、把備份還原進空間（`backupRestore.ts:247,601,718`） | 同「管理」 | 改為擁有者（共享空間）或個人空間主人；列入報告 |
| 共享空間因此「無人可管」 | 無需處理 | 擁有者隱含管理；移除 `last_manager` 檢查（`spaces.ts:496-497`） |

**agent token（逐一，只讀不放寬）**

1. `access` 回填：`allowed_tools` 為 NULL 或含任一寫入工具（`applyTag`、`removeTag`、`updateNode`、`createNode`、`proposeTagPack`、`publishSite`）→ `write`；否則 `read`。
   `NULL`（全部工具）加旗標「舊：全部工具」，`allowed_tools` 不改。
2. `issuer_removed_at IS NOT NULL` 的 token → **設 `revoked_at`**。理由：目前它們因簽發者夾住而可達空間為空（`currentActor.ts:15`）；
   刪除夾住規則後不處理就會「復活」。
3. 每個 agent 的新成員資格＝它所有未撤銷 token 目前**實際**可達範圍（含舊的簽發者夾住與 `external_ai`）的交集：
   - 讀：空間 `s` 保留，僅當 agent 現在每個 token 都讀得到 `s`；
   - 寫：`edit` 保留，僅當每個 `write` token 都寫得到 `s`，否則降成 `view`；
   - 沒有任何未撤銷 token 的 agent：成員資格不變（沒有憑證，無可放寬）。
   範圍較寬的 token 因此可能**變窄**（失效方向），每筆寫入 log，擁有者在畫面「需要注意」看到並可加回。
4. `read_space_ids`／`write_space_ids` 欄位在 126 保留不用，127 刪除。

**邀請**：待認領邀請列（`actors.external_id IS NULL AND invite_email IS NOT NULL`，`services/actors.ts:138-`）一律變成成員；
其預先設好的 `space_members` 依上表對應；邀請畫面不再選角色，改成「加入哪些空間（可稍後）」；認領時 `actorForSession`
（`actors.ts:327-377`）不再帶 `viewer` 暫時角色（`:360`）。

**擁有者缺值**：`workspaces.owner_actor_id IS NULL` 的工作區，回填為最早建立的人類 admin（沿用 093 邏輯 `093_spaces.sql:23`）；
沒有人類時保持 NULL 並在 log 標記（尚未有第一位登入者的新安裝）。第一位自行註冊的人類在 `actorForSession` 中明確成為擁有者
（取代 `signupRoleFor`，`roles.ts:38-40`）。

**e2e 與整合測試的假設**：65 個 `e2e/fullstack/*.spec.ts` 以 `POST /api/actors {role:"editor"|"viewer"}` 建人（9 個也用 `PUT …/members`）；
相容期內它們照舊可跑；PR 7 集中替換成 `permission`。少數規格（例：`zzDeepCol01.spec.ts:44-47`、`zzDeepCol08.spec.ts:187`）
用 `PATCH role` 模擬「降權」，其斷言需實際跑過再改為空間權限；此處**未實測**（本環境未跑 e2e）。

### 7.4 上線順序

1. 部署 125＋相容 API（伺服器先、前端後）。確認 `/health`、`GET /api/spaces` 舊欄位仍在。
2. 備份資料庫；跑 126；比對 log 摘要（沒有放寬的證據見 8.3 的「前後可達集合」測試，上線前在正式資料副本上跑一次）。
3. 部署新前端（空間與成員畫面）。舊分頁（快取的舊 bundle）呼叫相容 API，不報錯。
4. 觀察一個相容期；確認沒有 `Deprecation` 請求後，127。

## 8. 安全審查

### 8.1 絕不能放寬的情況

1. 遷移後任一人類或 token 的可讀／可寫空間集合，**不得大於**遷移前（8.3 的快照測試）。
2. 有簽發者夾住的 token 不因夾住規則刪除而得到更多空間（遷移規則 3、2）。
3. `issuer_removed_at` 的 token 不復活。
4. `view` 成員（含 AI）不能寫；`write` token 不能越過成員的 `view`。
5. `external_ai` 關閉仍同時擋 agent 與站內 AI（`spaceScope.ts:62`、`harness/scope.ts:53`）；關閉仍 bump epoch（`spaces.ts:393-395`）。
6. 非擁有者從未有的權限不新增：`principal_admin` 仍只屬擁有者且 token 永遠不是（`authority.ts:201-210`）。
   「無擁有者時 admin 接手」（`authority.ts:118-119`）刪除屬於**收緊**。
7. 個人空間：擁有者不能讀、改成員或開關；agent 不能成為個人空間成員（`setMember` 對個人空間一律 409，`services/spaces.ts:483`）。
8. 只有擁有者能改共享空間的成員與開關（原本 manager 也可以）——**收緊**；個人空間的開關仍只歸其主人。
9. 審核（收件匣）：agent 永遠不能審核（`authority.ts:137`）；owner-tier 效果（發佈、標籤包）仍只歸擁有者（`routes/inbox.ts:70-71`）。
10. 舊用戶端不能經由相容 API 取得更寬的 token（400 `token_scope_removed`、`role_removed`）；未知角色／權限字串一律低於所有權限。
11. 轉移擁有權只能由擁有者的登入工作階段發起；token、其他成員、被 `account_changed` 擋住的舊分頁（`index.ts:281`）都不行；目標必須是已登入過的人類。
12. 有效存取端點（`/api/spaces/overview`）僅擁有者可讀，不洩漏個人空間的名稱或成員，找不到的空間回 404 而非 403。
13. 備份匯入舊檔的 `manager` 不會因為映射變成更高權限，只會是 `edit`。
14. 撤銷成員資格、改為 `view`、關閉開關後，客戶端鏡像依 membership epoch 流程清除（[membership 文件](../membership-and-permission-epoch.md)）；`edit→view` 不改可讀集合但仍 bump（保持現有 `spaces.ts:489` 行為）。

### 8.2 稽核事件

沿用 `mutate()`（`spine/mutate.ts`）：狀態與事件同一交易提交。事件不含連結、token 明文或筆記內容。

| 事件 | 時機 | payload（摘要） |
|---|---|---|
| `SPACE_MEMBER_SET` | 設定／移除空間權限 | `actor_id`、`permission`（新）、`previous_permission`；相容期同時含舊 `role` |
| `SPACE_UPDATED` | 開關、改名（不變） | 同現行，另標 `reason_visible: external_ai` 方便稽核 |
| `TOKEN_CREATED` | 鑄造 | `access`（取代 `template`／空間清單） |
| `TOKEN_ACCESS_CHANGED`（取代 `TOKEN_RESCOPED`） | 唯讀⇄可寫 | `from`、`to` |
| `WORKSPACE_OWNER_TRANSFERRED` | 轉移 | `from_actor_id`、`to_actor_id` |
| `OWNER_MEMBER_MIGRATED`（系統） | 126 | 每工作區一筆，只含計數與 `owner_member_migration_log` 的範圍 |
| `ACTOR_UPDATED` | 改名（不再含 `role`） | 舊事件的 `role` 欄位仍可讀；還原／同步消費者忽略未知欄位（需在 PR 3 驗證 `eventRestore` 與 `eventVisibility`） |

### 8.3 要新增或修改的整合測試

**新增**

- `ownerMemberMigration.integration.test.ts`：在測試資料庫建立舊資料（各種角色、manager、多 token 不同範圍、`issuer_removed_at`、
  待認領邀請、外部 AI 開關關閉），先以**舊程式**算出每個人類與每個 token 的可讀／可寫空間集合，執行 126，再以**新程式**重算；
  斷言新集合 ⊆ 舊集合（人類的讀寫相等，只失去管理）。這是「不放寬」的主要證據。另測 125→126→回退 SQL 還原到相同影像、126 重跑為 no-op。
- `spaceAccess.parity.integration.test.ts`：舊 `spaceScope.ts` 結果與 `spaceAccessSql` 在 人類／token／讀／寫 組合上逐一相同（PR 2 完成條件）。
- `spaceAccessReasons.integration.test.ts`：第 5 節每個 `blocked_by` 及優先順序；agent 無 token、未加入、外部 AI 關閉、檢視、唯讀 token；多 token 取最寬。
- `ownerTransfer.integration.test.ts`：只有擁有者的工作階段可轉移；token／成員／System（繞過關閉時）被拒；目標必須已登入的人類；
  `confirm_name` 不符被拒；同一交易回滾事件；`Idempotency-Key` 重試；trigger 擋下直接 `UPDATE workspaces SET owner_actor_id`；
  FK 擋下刪除擁有者；舊擁有者降為成員仍保有空間。
- `legacyApiCompat.integration.test.ts`：7.2 表的每一列（接受、400、映射、回應雙欄位）。
- `tokenAccess.integration.test.ts`：`access` 鑄造、展開固定清單、新增工具不放寬既有 token、`write` token 在 `view` 空間仍不能寫、
  不再受簽發者夾住、簽發者被移除仍撤全部 token（保留 `services/actors.ts:763` 行為）。
- `memberManagement.integration.test.ts`：非擁有者呼叫 `PUT/DELETE members`、`PATCH spaces/:id`、`POST /api/spaces`、永久刪除垃圾桶、還原備份進共享空間皆 403；個人空間的主人可改自己的開關。

**修改**

- `reviewAuthority.integration.test.ts`（目前測 reviewer／非擁有者 admin，`:88-127`）→ 只剩擁有者與拒絕案例。
- `roleReadPolicy.integration.test.ts`、`readPolicy.integration.test.ts`、`readableScope.integration.test.ts`：移除工作區角色矩陣，保留空間矩陣。
- `spaceRoles.test.ts`（釘死 `SPACE_ROLES` 與 CHECK，`:40-47`）→ 改釘 `SPACE_PERMISSIONS` 與新 CHECK。
- `spacesAccess`、`spacesMove`（manager 移出）、`spacesPreInvite`、`memberInvite`、`memberRemoval*`、`actorsAuthzGate`、`actorTokenSpine`、
  `tokenAgentConvergence`、`readScopeAgent`、`readToolsScope`、`tokenTemplates`、`tokenExpansion`、`agentTokens`、`securityAttacks`、
  `backupRestore*`、`harness*`（外部 AI 原因）、`httpRoutes`：以 `grep` 找出的 239 個含工作區角色字串的測試檔為清單，逐一改用 `permission`／`access`。
- 前端：`TokenManager.test.tsx`、`ActorsPanel{Invite,Roles,System}.test.tsx`（刪除／改寫）、`capabilities.test.tsx`、`SpaceChip.test.tsx`、
  `purgeDeleted.test.tsx`、`settingsNavigation.test.tsx`；新增 `SpacesAndMembers.test.tsx`（加入成員流程、鍵盤、原因文字、等待與失敗保留輸入）。
- e2e：`helpers.ts` 的 `addToDefaultSpace`（`e2e/fullstack/helpers.ts:494`）改傳 `permission`；批次替換 65 個規格的 `role` 欄位；新增
  「agent 讀不到→畫面指出原因→按『開啟』→讀得到」一條端到端案例，桌面與 390 px 各跑一次（viewport 測試如實標示，非真機）。

## 9. 需要使用者決定的事

> **2026-10-23 使用者決定：「照建議」**，並套用兩項後來的決定：
> - 決定 7：保留「外部 AI」空間開關，文案改「AI 可讀取」；內建 API AI 已由 `chore/remove-api-ai` 移除，只剩代理（MCP）。
> - 決定 9：**不設相容期**（單一使用者，「現在隨便搞」）。因此第 7.2 節相容策略與雙欄位／雙向 trigger 取消：
>   第 10 節的 PR 3＋4a＋4b 合併為一次性 migration 與語意切換（舊值直接轉換、舊 API 欄位直接移除），PR 8「收斂」不需要。
> - migration 編號用實作當下的下一個空號（125 已由 agent sessions 使用）。

| # | 決定 | 建議 | 若不照建議 |
|---|---|---|---|
| 1 | 審核（收件匣）只剩擁有者？目前 reviewer 與非擁有者 admin 也能審（`authority.ts:136-140`） | 只剩擁有者，與「兩個工作區角色」一致 | 加「在自己有編輯權限的空間內審核該空間的 agent 變更」，需新增一個以空間為範圍的審核規則 |
| 2 | 一般成員不能再建立共享空間，也不能管理自己建立的空間（現在可以：`spaces.ts:352-376`） | 同意；成員向擁有者要空間 | 保留「成員可建立自己的空間」但他們不是管理者就無法加人，等於沒意義 |
| 3 | 非擁有者的 manager 降為 `edit`（失去管理） | 同意；報告列出每一個受影響者 | 無 |
| 4 | 標準 `write` 是否含 `publishSite`（目前只有 `publisher` 範本含，`templates.ts:25`） | 不含；既有 `publisher` token 保留原樣 | 把發佈請求併入 `write`（仍需擁有者核准） |
| 5 | 多 token 的 agent 遷移取「交集」（可能使範圍較寬的 token 變窄） | 同意，失效方向；畫面顯示並可加回 | 先只報告、不轉換，要求擁有者逐一確認——推遲上線 |
| 6 | 加入成員的預設權限 | 檢視（最小權限）；AI 也是檢視 | 編輯 |
| 7 | 保留「外部 AI」為空間開關（方案 A），文案改為「可送給 AI（內建 AI 與代理）」 | 保留 | 方案 C 會放寬，不建議；方案 B 需要 PR 範圍重估 |
| 8 | 擁有者要讀共享空間內容仍需把自己加進該空間（目前行為，`spaceScope.ts:69-71`） | 保持；畫面「＋ 加入成員」可選自己 | 擁有者自動可讀所有共享空間（擴大擁有者的內容讀取，需另行評估） |
| 9 | 相容期長度與 Android App 最低版本 | ≥ 2 個發佈版本且 ≥ 30 天 | 縮短會讓舊分頁／殼 App 碰到 400 |
| 10 | 「轉移擁有權」是否列入本批 | 列入（PR 5），因為守門若沒有合法出口，維運只能手改資料庫 | 延後，先只做 trigger 守門 |

## 10. 工作拆分（依序，每個 PR 可獨立審查與回退）

大小是粗估（淨改行數，含測試）；「檔案」是主要修改位置。

| # | PR | 行為改變 | 主要檔案 | 大小 |
|---|---|---|---|---|
| 1 | **特徵化測試**：把現有存取規則釘成 fixture（人類／token／讀／寫／簽發者夾住／外部 AI）；寫 `ownerMemberMigration` 的「舊程式快照」輔助函式 | 無 | `test/spaceAccess.parity.integration.test.ts`（新）、`test/helpers/accessSnapshot.ts`（新） | S（~400 行） |
| 2 | **單一存取函式**（行為不變）：新增 `spaceAccess.ts`（SQL 片段＋`spaceAccess()`）；`spaceScope.ts`、`currentActor.ts`、`authority.ts` 的 `space`/`space_write`/`any_space_write` 改呼叫；`Authority` 的 `min` 改 `need`（全 17 個呼叫點）；仍用 viewer/editor/manager 值域 | 無（parity 測試為閘） | `spine/spaceAccess.ts`、`spaceScope.ts`、`currentActor.ts`、`spine/authority.ts`、`services/spaces.ts`、`services/nodeTrash.ts`、`services/backupRestore.ts`、`services/backupRestoreUndo.ts` | M（~700） |
| 3 | **migration 125＋相容 API**：`permission`／`access` 欄、`owner_member_migration_log`、雙向 trigger；`/api/spaces`、`/api/actors`、`/api/bootstrap`、備份回傳雙欄位；伺服器改寫 `permission`；接受舊請求（7.2 表） | 無（只加欄與雙寫） | `db/migrations/125_*.sql`、`services/spaces.ts`、`services/actors.ts`、`routes/spaces.ts`、`routes/actors.ts`、`services/backupArchive.ts`、`services/backupRestore.ts`、`services/sync/bootstrap.ts` | L（~900） |
| 4a | **擁有者／成員**：`isWorkspaceOwner` 去後備；`reviewAuthority`→擁有者；移除 `manager`（`manage` 能力由擁有者／個人空間主人）；`createSharedSpace` 擁有者限定；`actorForSession` 首位登入成為擁有者；`updateActor` 去角色；`example_seed_eligible` 改看擁有者 | **有**（收緊，第 9 節決定 1–3） | `spine/authority.ts`、`roles.ts`（刪）、`services/actors.ts`、`services/spaces.ts`、`routes/inbox.ts`、`services/outbox.ts`、`services/sync/bootstrap.ts` | M（~600） |
| 4b | **migration 126＋token 模型**：資料轉換與 log；`AgentTool.access`；`mintToken`／`rescopeToken` 改 `access`；`resolveCurrentActor` 去簽發者夾住；`spaceAccess` 去 token 清單；撤銷 `issuer_removed_at` token | **有**（遷移；不放寬） | `db/migrations/126_*.sql`、`services/agentTools/{types,templates,registry}.ts`、`services/actors.ts`、`services/agentTokens.ts`、`spine/currentActor.ts`、`spine/spaceAccess.ts`、`test/ownerMemberMigration.integration.test.ts` | L（~900） |
| 5 | **有效存取與擁有權**：`GET /api/spaces/overview`；`POST /api/workspace/owner-transfer`；擁有權 trigger 與 FK RESTRICT（若決定 10 為本批，放在 127 前的獨立 migration） | 新增端點、收緊 | `services/spaceOverview.ts`（新）、`routes/spaces.ts`、`routes/workspace.ts`、`db/migrations/`（trigger） | M（~600） |
| 6a | **前端：空間與成員（讀／加入／權限）**：新分頁、卡片、原因、`＋`加入對話框、`radiogroup`、拖曳加強；舊「Spaces」分頁刪除 | UI | `settings/SpacesAndMembers.tsx`（新）、`settings/registry.tsx`、`lib/spaces.ts`、`lib/data/reads.ts`、`components/ExternalAiOffNotice.tsx`、CSS | L（~1100） |
| 6b | **前端：邀請、token、擁有權**：邀請與連結、移除、token（唯讀／可寫）、轉移擁有權對話框；刪除 `ActorsPanel`、簡化 `TokenManager` | UI | `components/SideDrawers.tsx`、`components/TokenManager.tsx`、`settings/…` | M（~700） |
| 7 | **測試與 e2e 詞彙遷移**：第 8.3 節「修改」清單；`helpers.ts`；65 個 e2e 規格；新增端到端案例（桌面＋390 px） | 無 | `backend/src/test/*`、`frontend/src/test/*`、`frontend/e2e/fullstack/*` | L（~1500，多為機械替換） |
| 8 | **收斂**：migration 127；刪相容 API 與 trigger；更新 `spaces.md`、`agent-delegation.md`、`AGENTS.md` 批次紀錄 | 刪除舊介面 | `db/migrations/127_*.sql`、`routes/*`、`docs/architecture/*`、`AGENTS.md` | M（~500） |

建議順序理由：1→2 先把「規則在哪裡」變成一處而不改行為；3 加欄與相容；4a/4b 才實際改權限語意並遷移；
5 補擁有者需要的可見性與守門；6 在後端穩定後才改畫面；7 在相容期內並行；8 最後收斂。
每個 PR 完成條件含 `npx tsc --noEmit`、`npm run lint`、相關 `npm test`；4b 另需在正式資料副本跑 8.3 的前後快照測試。

## 11. 這份提案沒有涵蓋

- 註冊是否開放：任何能登入的人目前都會被建立成成員（`services/actors.ts:383-`），本提案不改，只是不再有 `viewer` 這個等級；
  是否限制註冊是另一個決定。
- 公開站台、分享連結的權限（`publish` 開關與 `_published`）不變。
- 筆記層級的細粒度權限（本來就不提供；可見範圍只由空間決定，spaces.md 不變條件 2）。
- 跨工作區；工作區仍只有一個。
- 實作時需確認的未驗證點：`eventRestore`／`eventVisibility` 對 `ACTOR_UPDATED.role` 與 `TOKEN_RESCOPED` 的消費（PR 3、4b 驗證）；
  Android 殼 App 的最低版本；e2e 全套（本次未實測）。
