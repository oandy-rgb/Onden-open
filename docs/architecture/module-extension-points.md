# 模組擴充點（設計草案）

> 狀態：現行（最後確認 2026-11-01）

狀態：擴充點 1–4 **已實作**（2026-10-05／06，見各節「實作結果」）。
依據 [模組依賴盤點](../archive/module-dependency-inventory-2026-10-05.md)。
本文件處理擴充點 1（outbox 副作用註冊）、2（標籤功能註冊）、3（筆記提交後掛鉤）與
4（前端插槽註冊）。

共同目標：模組在自己的目錄宣告能力，核心從註冊表讀取，不再列出模組名稱或路徑。
不引入動態載入、沙箱或版本化 manifest；註冊仍是 `modules/index.ts` 中可 grep 的一行。

---

## 1. outbox 副作用註冊

### 要減少的理解負擔

新增一種外部副作用時，現在要同時修改 `OutboxEffectKind`、`performEffect` 的分支、
`routes/inbox.ts` 的 `approvalRoleFor`，並複製一段幾乎相同的 `INSERT ... ON CONFLICT` SQL。
RSS 以動態 import 接入，核心因此依賴模組路徑。

### 草圖 A：副作用處理器註冊表（建議）

```ts
// services/outbox.ts — 核心只擁有機制
export type OutboxEffect<P> = {
  kind: string;                      // 全域唯一，寫入 outbox.effect_kind
  parse: (payload: unknown) => P;    // 驗證 payload；拋錯視為永久失敗
  perform: (payload: P) => Promise<void>; // 必須冪等：至少一次投遞
  approval?: "reviewer" | "admin";   // 只用於 pending_approval 列
};
export function registerOutboxEffect(effect: OutboxEffect<any>): void;
export function enqueueEffect(input: {
  workspaceId: string; kind: string; dedupKey: string; payload: unknown;
  held?: boolean;                    // true → pending_approval，等收件匣核准
  triggeredByEventId?: string;
}, exec?: Executor): Promise<void>;

// modules/rss/index.ts — 模組宣告自己的副作用
export const rssModule: ModuleDefinition = {
  id: "rss",
  registerRoutes: (app) => app.route("/api/rss", rssRouter),
  outboxEffects: [{ kind: "rss_fetch", parse: parseRssFetch, perform: performRssFetch }],
};

// modules/rss/fetch.ts — 排入時不再手寫 SQL
await enqueueEffect({ workspaceId, kind: "rss_fetch", dedupKey: `rss_fetch:${sourceNodeId}`, payload });
```

隱藏的知識：outbox 表結構、pending／pending_approval 的去重合併、提交後喚醒 drain、
`xmin` 樂觀併發與退避重試。呼叫者必須知道且寫進契約的：至少一次投遞因而 `perform` 須冪等，
以及 `held` 代表需要人工核准。

核心自己的副作用（`git_commit`、`github_backup`、`embed`、`tag_pack`）在核心註冊；
`pages_push` 先留在核心註冊，網站搬成模組時移入其 `ModuleDefinition`（`publish_site` 已於 2026-10-31 刪除）。
`enqueueBackup` 的 `local_only` 判斷、`enqueuePagesPush` 等保留為各自擁有者的薄包裝。

### 草圖 B：保留固定種類，以路徑對照表延遲載入

```ts
const PERFORMERS: Record<OutboxEffectKind, () => Promise<Performer>> = {
  rss_fetch: () => import("../modules/rss/fetch.js").then(m => m.performRssFetch), ...
};
```

改動最小，但核心仍列出模組路徑，刪除 RSS 依然讓型別檢查失敗；核准角色與 SQL 重複不變。
不解決本次問題。

### 不採用：模組自行訂閱事件並管理重試

會在 outbox 之外形成第二條副作用通道，違反 `AGENTS.md`「外部副作用沿用既有 outbox」
與 `ModuleDefinition.startBackground` 註解中「no third rails」的約束。

### 選擇 A 的契約與相容

- **註冊時機**：`mountModules()` 註冊模組副作用；它在 `startOutboxReconciler()` 之前執行。
  重複註冊同一物件為無操作，不同物件搶同一 `kind` 則拋錯（與 agent 工具註冊表一致，測試會重複掛載）。
- **未知種類**：drain 遇到沒有處理器的 `effect_kind` 時，該列保持 pending 並退避、記錄警告；
  不標為 dead。模組暫時移除後再加回，未完成的意圖可繼續執行，資料不因刪除模組而遺失。
- **payload 失敗**：`parse` 拋錯代表資料不符契約，沿用既有失敗計數與最終 dead 處理。
- **資料相容**：`effect_kind` 字串與 payload 格式不變，`outbox.effect_kind` 欄位為 text、無 CHECK 約束，無需遷移。
- **核准**：`approvalRoleFor` 改讀註冊表的 `approval`；未註冊種類的核准請求拒絕。
  權限改為「擁有者＋授權」時，只需改這一處的解讀。

### 驗證

- 單元：重複註冊規則；`enqueueEffect` 的 pending／held 去重合併與既有 SQL 行為一致。
- 整合（真實 PostgreSQL）：未註冊種類保持 pending 而非 dead；註冊後的下一次 drain 會執行；
  既有 outbox 測試全數通過。
- 刪除檢查：暫時從 `MODULES` 移除 RSS，`tsc --noEmit` 不再因 `rss_fetch` 失敗（RSS 其他阻擋項另計）。

### 實作結果（2026-10-05）

- `services/outbox.ts`：`registerOutboxEffect`、`enqueueEffect`、`outboxEffectApproval`、
  `UnregisteredOutboxEffect`；`OutboxEffectKind` 改為 `string`。五段重複的排入 SQL 改用 `enqueueEffect`；
  核心種類（`git_commit`、`github_backup`、`embed`、`pages_push`、`tag_pack`）在本檔註冊（`publish_site` 已於 2026-10-31 刪除）。
- `ModuleDefinition.outboxEffects` 由 `mountModules()` 註冊；RSS 宣告 `rssFetchEffect`，
  `enqueueRssFetch` 改用 `enqueueEffect`，核心不再 import `modules/rss`。
- `routes/inbox.ts` 的核准角色改讀註冊表；未註冊種類的核准回 409 `effect_unavailable`，列保持待核准。
- 未註冊種類：drain 不消耗嘗試次數、延後 15 分鐘再看，不標 dead。
- 行為差異：RSS 排入後也會發出 effects 通知並喚醒 drain（其餘種類原本就如此）；
  held 種類現在也寫入 `triggered_by_event_id`（呼叫者目前皆不提供，值仍為 NULL）。
- 驗證：新增 `test/outboxEffects.integration.test.ts`（註冊規則、核准角色、模組掛載、未註冊保留、
  去重合併、拒絕核准）；outbox、核准、RSS、realtime、pages push 等相關測試通過。
  暫時移除 RSS 目錄與註冊行後，`tsc --noEmit -p tsconfig.build.json` 通過（測試檔仍引用 RSS，不在此檢查內）。

---

## 2. 標籤功能註冊

### 要減少的理解負擔

新增一種「啟用在標籤上的功能」（如複習、稍後讀），現在要修改核心的 `TAG_MODULE_IDS`、
`PATCH /api/tags/:id/modules` 的 zod 結構、前端 `TagModule` 型別，以及 `SchemaLens` 的寫死卡片。

### 草圖 A：前後端各一份由模組填入的註冊表（建議）

```ts
// 後端 modules/types.ts
export type ModuleDefinition = { /* 既有欄位 */ tagFunction?: boolean };
// services/tagModules.ts
export function tagModuleIds(): string[];                 // 由已掛載模組推得
export function isTagModuleEnabled(behaviour: unknown, id: string): boolean;
// PATCH /api/tags/:id/modules：body 為 { [id]: boolean }，未註冊的 id → 400

// 前端 modules/review/index.ts
export const reviewTagFunction: TagFunctionSpec = {
  id: "review", title: "Review",
  description: "Study these notes with spaced repetition.", Icon: GraduationCap,
};
// 前端 lib/tagFunctions.ts — 與後端 MODULES 對應的一行一個註冊
export const TAG_FUNCTIONS: TagFunctionSpec[] = [readLaterTagFunction, reviewTagFunction];
```

`SchemaLens` 依 `TAG_FUNCTIONS` 渲染功能卡與草稿狀態，不再出現 `review`／`read_later` 字面值。
各模組仍以 `isTagModuleEnabled(behaviour, "review")` 判斷自己的成員，這是模組內部知識。

### 草圖 B：核心把 `behaviour.modules` 當不透明物件

核心接受任意鍵、不驗證，由模組自行解讀。最少程式碼，但拼錯的鍵會靜默無效；
TagPack 匯入的「缺少模組」警告失去依據；agent 或 pack 可寫入任意鍵。
不採用，但保留其優點：儲存格式本來就是開放的 `behaviour.modules.<id>.enabled`，A 只在寫入邊界加驗證。

### 選擇 A 的契約與相容

- 儲存格式、PATCH body 形狀、事件（`TAG_SCHEMA_UPDATED`）與復原契約不變，無資料遷移。
- 保留既有不變條件：只有明確 `true` 才啟用；改名不影響；停用保留模組狀態；
  設定需要事件鎖內的 principal admin；套用標籤不授予設定權。
- 已儲存但目前未註冊的模組鍵：讀取時忽略、寫入時原樣保留，不因模組暫時移除而清掉使用者設定。
- 前後端註冊表需一致：前端卡片對應的 id 若後端未註冊，PATCH 會回 400；
  兩者同 repo 同版發布，以一個比對兩份清單的測試防止漂移。
- RSS 原本使用名稱 `subscription` 的舊能力標籤契約（`capabilityTags`）；migration 114 已移除：訂閱來源改以內部屬性 `_rss_kind = 'source'` 標記（migration 145 再改存資料表 `rss_subscriptions`，不再是筆記），`capabilityTags` 欄位一併拿掉，TagPack 的 `modules` 只來自標籤上開啟的功能。

### 驗證

- 後端整合：未註冊 id → 400 且無事件；已註冊 id 的開關、無變更、權限拒絕與既有測試相同；
  未註冊鍵在其他模組開關後仍保留。
- 前端單元：`SchemaLens` 依註冊表渲染；移除註冊項後該卡片消失，其他卡片不受影響。
- 一致性：前端 `TAG_FUNCTIONS` 的 id 集合等於後端 `tagFunction: true` 模組的 id 集合。

### 實作結果（2026-10-05）

- 後端：`ModuleDefinition.tagFunction`；`services/tagModules.ts` 改為由 `mountModules()` 填入的
  `registerTagModule`／`tagModuleIds`，移除 `TAG_MODULE_IDS`。`setTagModules` 對未註冊 id 回
  `TagModuleError(400)`，不寫入、不產生事件；PATCH body 改為 `{ [id]: boolean }`。標籤包匯出改讀註冊表。
- 前端：新增 `src/modules/index.ts`（`TAG_FUNCTIONS`、`enabledTagFunctions`），各模組以
  `tagFunction.ts` 提供標題、說明與圖示（`modules/review/`、新的 `modules/read_later/`）。
  `SchemaLens` 的功能卡與草稿、`TagsOverview` 與 `NoteModuleSources` 的功能標示改讀註冊表；`TagModule` 改為 `string`。
- 未處理（屬擴充點 4 前端插槽）：`SchemaLens` 中複習面板開關與閱讀佇列排序、`useOverviewMode` 的複習來源，仍直接引用模組 id。
  （已由擴充點 4 處理：`TagFunctionSpec.panel`、`members`；抽卡移入 `modules/review/extractCards.ts`。）
- 本批未合併 `behaviour.review` 設定至 `modules.review`；需資料遷移，另案。
- 驗證：後端新增 `test/tagFunctionRegistry.integration.test.ts`（註冊、未註冊 id 拒絕且無事件、新模組可啟用、
  未安裝模組的已存設定保留）；直接掛載路由的測試以 `test/helpers/registerTagModules.ts` 註冊。
  前端新增 `test/tagFunctionRegistry.test.ts`，比對前端 `TAG_FUNCTIONS` 與後端 `tagFunction: true` 模組；
  暫時移除後端稍後讀的宣告時此測試失敗。前端完整測試與 `npm run build` 通過。
  （測試輔助檔後來更名為 `test/helpers/registerShippedModules.ts`，一併註冊 outbox 副作用與筆記掛鉤。）

---

## 3. 筆記提交後掛鉤

### 要減少的理解負擔

筆記建立、編輯、還原、匯入、複製時，核心寫入路徑各自呼叫 `enqueueEmbed`（7 處）；
屬性路由在 `_published` 變動後直接呼叫 `republishSite`；「找相關筆記」路由放在 `routes/nodes.ts`。
要知道一次存檔會引發什麼，必須讀遍這些路徑，而且新增一種「存檔後要做的事」必須改核心。

### 設計

`spine/nodeHooks.ts` 只有兩個時點：

- `nodeContentCommitted({ workspaceId, nodeId, text, triggeredByEventId })`：在寫入交易**內**、
  標題或內文改變後呼叫。掛鉤只能排入 outbox 意圖，與寫入一起提交或回滾，不可對外呼叫。
- `nodeAttributeCommitted({ workspaceId, nodeId, key, actor })`：屬性設定或刪除**提交後**呼叫。
  盡力而為：掛鉤失敗只記錄，不讓使用者的寫入失敗。

模組以 `ModuleDefinition.nodeHooks` 宣告，`mountModules()` 經 `registerModuleEffects()` 註冊。
沒有任何模組註冊時，寫入只是沒有額外效果。

不採用：在所有寫入（含標籤、移動）都觸發的泛用事件匯流排。目前只有這兩種需求，
多開時點只會讓「存檔會引發什麼」更難回答；確有需要時再加。

### 實作結果（2026-10-06）

- 新模組 `modules/semantic/`：`embed` outbox 副作用（自 `services/outbox.ts` 移出）、
  內容掛鉤排入向量計算、`POST /api/nodes/:id/suggested-links` 路由（網址不變）。
- 新模組 `modules/website/`：`_published` 變動後重新部署。發布路由與 `pages_push`
  副作用（當時還有 `publish_site`，已於 2026-10-31 刪除）仍在核心（`modules/website/routes.ts`、`services/outbox.ts`），下一步移入此模組。
- 7 處 `enqueueEmbed` 改為 `nodeContentCommitted`；`routes/nodes.ts` 不再引用 `republishSite`、
  `refreshSuggestedLinks`。備份（`enqueueBackup`）屬核心資料保全，維持直接呼叫。
- RSS 保存文章維持「只有來源開啟 `_rss_embed` 才呼叫內容掛鉤」。
- 驗證：新增 `test/nodeHooks.test.ts`（掛鉤執行、屬性掛鉤失敗被隔離、重複註冊拒絕、兩模組宣告存在）。
  既有向量、RSS 與重新發布測試改經模組註冊後通過；後端完整測試 1938 項通過。
  除 `modules/index.ts` 外沒有檔案引用這兩個模組目錄。

### 後續：寫入前的屬性規則（D114，2026-10-18）

之後又加了空間、生命週期、可見性等時點（見 `spine/nodeHooks.ts`；內容與屬性提交的核心前置動作在 `services/nodeCommits.ts`）。D114 加上第一個**寫入前**
的時點 `attributeWriting`：明確的屬性寫入（`setNodeAttribute`：屬性路由、帶欄位建立筆記、模組自己的路由）
在事件鎖內、寫入前呼叫；模組丟出 `AttributeWriteError` 即拒絕整次寫入。曾有的引用模組（2026-11-12 整個移除）用它讓 `citekey`
在寫入者可讀的論文中唯一；目前沒有模組使用，機制保留。衍生寫入
（行內 `key:: value`、frontmatter、匯入、複製）不經過這個時點。

---

---

## 4. 前端插槽註冊

### 要減少的理解負擔

RSS 與複習的畫面散在核心：`BuilderApp` 有各自的模式、狀態與 lazy import；頂列、手機底列、
指令面板、首頁、收件匣、設定頁、標籤頁、筆記選單與「新增」對話框各自寫死。
原 README 的立場是「單一消費者不建註冊表」；現在每個插槽都有兩個以上模組，條件已成立。

### 設計

每個前端模組匯出一個 `FrontendModule`（`src/modules/types.ts`），核心只讀
`src/modules/index.ts` 的 `MODULES` 與衍生清單（`MODULE_SCREENS`、`NOTE_COMMANDS`、
`MODULE_SETTINGS`、`TAG_FUNCTIONS`）。插槽：

| 欄位 | 位置 |
| --- | --- |
| `screen` | 全頁模式 `?view=<id>`；桌面導覽全部列出，手機依 `mobile` 放底列或「更多」 |
| `openCommand`／`dialogEntry` | 指令面板動作（開啟該頁／開啟模組自己的新增對話框）；`dialogEntry` 另在該模組的標籤頁（#論文、#技能）放一顆按鈕，不放進「+」清單 |
| `HomeSection` | 首頁一行（收件匣只放待審核的項目，沒有模組區塊，2026-10-18） |
| `noteCommands` | 資訊欄「功能」段與指令面板共用的筆記動作（`row` 給圖示、一句話、按鈕字；不在筆記 ⋯ 選單） |
| `slashInserts` | 內文 `/` 選單的插入項目（引用） |
| `settings` | 併入設定頁的 `SettingDef` |
| `tagFunction.panel`／`members` | 標籤頁的功能面板；成員排序與標題 |

`ModuleTarget`（itemId、sourceId、rootId、rootTitle）取代 `rssFocusItemId`、`reviewRoot` 等專屬狀態。
`AppMode` 為核心模式或模組頁 id。

不採用：動態載入或遠端外掛。註冊仍是 `modules/index.ts` 中可 grep 的一行。

### 實作結果（2026-10-06）

- 新增 `modules/types.ts`；`rss`、`review`、`read_later` 各以 `index.ts(x)` 宣告。
- 核心改讀註冊表：`BuilderApp`（一組 `moduleTarget`／`openModule`／`runNoteCommand`）、`AppTopbar`、
  `MobileNav`、`shellNavigation`、`useCommandPalette`、`HomeStart`、`InboxReview`、`OverviewSidebar`、
  `settings/registry`、`SchemaLens`、`NoteActions`／`OverviewEditorHost`、`useUrlLocation`、`useUiMode`。
- 移除：`SideDrawers` 中已無入口的複習與 RSS 抽屜；核心「新增」對話框的 RSS 類型與
  舊 `graphMutations.importRss`（訂閱在 RSS 閱讀頁內完成）；`useOverviewMode` 的抽卡（移至 `modules/review/extractCards.ts`）。
- 首頁「待讀」移至 `modules/read_later/ReadLaterHomeSection.tsx`；收件匣 RSS 條移至 （RSS 收件匣區塊，檔案已改名或移除）。
- 筆記選單「Review cards here」改用與指令面板相同的字串「Review cards under this note」。
- 驗證：新增 `test/moduleBoundary.test.ts`（核心檔案不得引用模組內部檔案、前端模組 id 必有同名後端模組）。
  暫時刪除 `modules/rss`、`modules/review` 與其註冊行後，前端 `tsc`（含測試）通過；
  只有檢查出貨組成的測試（導覽按鈕、標籤功能清單）如預期失敗。模組自己的測試已移入模組目錄。
  前端完整測試 1739 項通過。

### 網站模組（2026-10-06）

- 後端：發布、網站、分享、匯出路由（原 `routes/publish.ts`）、部署副作用 `pages_push`（與當時的 `publish_site`、代理工具 `publishSite`，兩者已於 2026-10-31 刪除）移入 `modules/website`；`services/publishing/` 的網站渲染器隨後（2026-10-28）也搬進 `modules/website/publishing/`：發布後端屬於 website 模組。
  核心要網站的東西（匿名可讀的媒體、單篇 HTML 匯出）不 import 模組，改走 `services/publicSite.ts`（`ModuleDefinition.publicSite` 註冊）；
  `PublishPreviewStale` 改為核心 `CodedStatusError` 的子類，`httpError.ts` 不認識網站。
- 前端：網站工作室（`WebsiteStudio`、`PuckStudioCanvas`、`CollectionsManager`、`useWebsiteMode`、`websiteWriter`）
  移入 `modules/website`，以模組頁面 `?view=website` 呈現，從 store 讀資料。公開網站頁（`pages/site`、`published/`）與
  `components/templates` 渲染器留在核心。
- 契約新增：`ModuleScreen.place`（`"organize"` 列在「更多 → 整理與發布」）、`ModuleScreen.nodeMenuLabel`（白板卡片選單開啟該頁）、
  `OpenCommand.group`／`hint`、`FrontendModule.TimelineSection`（時間軸上方區塊；2026-10-30 起已由 `dayItems` 取代，見下）、`ModuleScreenProps.onRefresh` 可回傳 Promise。
- 核心不再出現 `"website"`：`CoreMode`、`CORE_VIEWS`、`PlaceId`、指令面板、`useGraphLayout` 的 nav_link 分支（網站模式不畫圖，已是死碼）。
  資訊欄主題色改由核心從 `site_config` 推導。版面 class `website-studio-open` 改為通用的 `module-screen-<id>`。
- 行為差異：時間軸的「已發布快照」改由網站模組自行載入，不必先開過網站工作室才出現；「Snapshot」按鈕隨之移到該區塊。
  模組頁面（含 RSS、複習）頂列不再顯示資訊欄開關（這些頁面本來就不顯示資訊欄）。
- 驗證：暫時刪除前端 `modules/website` 與註冊行，前端 `tsc`（含測試）通過；後端同樣可刪。前端完整測試 1770 項、`npm run build` 通過。

## 實作順序

先做 1：它解除 RSS 對核心型別檢查的硬依賴，是 RSS 試點的前提。2 規模較小，可緊接著做。
每項各自一批提交，附上述驗證結果，並更新盤點文件中對應的阻擋項。

## `FrontendModule.dayItems`：模組交出「某天」的項目（2026-10-30，日子頁）

`TimelineSection`（唯一實作是網站的已發布快照，而且沒有任何地方渲染它）換成 `dayItems(context) => DayItem[]`：
模組不交元件，交出當天它所知道的事，日子頁（`modules/daily/day`）統一畫成直式時間軸。

- `DayItem`、「同一人連續修改（間隔 < 30 分）合成一段」與時間軸位置計算在 `@onden/markdown` 的 `dayItems.ts`（前後端共用、純函式）。
  時間一律是 ISO 時刻；一天的起訖由前端 `lib/dayWindow.ts` 依工作區時區與一天開始時刻算出，所以一天不從 0 點開始、夏令時間的 23／25 小時天都對得上。
- 來源：任務與收工（tasks 模組，`lib/tasks/dayItems.ts`）、快速記錄（daily 模組）出自本機副本，離線也有；修改（合成段）、新增的筆記、AI 處理出自
  `GET /api/day/:date/lens` 的 `items`（`services/dayLens.ts`，與原本的 buckets 同一組受讀取政策限制的查詢，不是第三套）。
  `collectDayItems(context, isImported)`（`modules/index.ts`）合併各模組的結果；`joinDayItems` 把伺服器的項目併進來並去掉重複的快速記錄。
- 任務可選的 `time`／`until`（`HH:MM`，工作區時鐘）有就畫在時間軸上，沒有就是「不限時間」；任務儲存欄位本身不在這裡定義。
- 網站的已發布快照列表仍在發布紀錄（`PublishLog`）；它沒有變成 DayItem（沒做，見 PR 說明）。
- 原本日記頁下方與筆記頁的 `TodayLens` 已移除：同樣的資料（加上任務與快速記錄）在日子頁的時間軸。

