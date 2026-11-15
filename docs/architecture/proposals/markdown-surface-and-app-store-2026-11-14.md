# 提案：@onden/markdown 的入口寬度與前端 app store 的讀寫入口

> 狀態：提案（2026-11-14）。**只有文件與只准減少的守門**，沒有改任何產品程式；遷移由後面列的小 PR 逐步做。
> 所有數字都是 2026-11-14 在 `origin/main`（`7795ea5c`）重新量的；量法在第 1 節，守門測試會持續量同一件事。
> **2026-11-14 午後更新**：合併 #1642（main `b8b21eb95`）後重量；基準隨之更新為 692／509／328（`fe-app-store-reach`）／248／61／18，細節表若與這些數字差 1–3 是這次合併的新功能（例如 `modules/review/reviewCard.ts` 新增 2 處字面 `sendWrite`、1 個新事件）。
> 標示：**〔量測〕** 是今天數出來的；**〔建議〕** 是本提案；**〔待驗證〕** 是還沒確認的事。
> 正在進行的其他 PR（刪 `packages/markdown` 與前端的未用匯出、取代 node 種類判斷、把 wire 型別搬進 `packages/contract`）不在本提案範圍，也沒有被碰。

---

## 給業主的一頁（白話）

**哪裡不對。** 有兩個「大門太寬」的地方，改任何一件小事都要在很多房間裡找：

1. **`@onden/markdown` 名字叫 Markdown，其實是全專案的「共用領域核心」。**
   它的根入口一口氣對外 692 個名稱（來自 99 個檔案），前端和後端實際用到其中 509 個。
   Markdown 語法只是其中一半左右；任務的逾期／今天分頁、重複規則、月曆、前後端共用的上限數字、
   頁面和背景 worker 之間的訊息格式、網站 `<head>` 的 Google Analytics 程式碼、媒體上傳的大小上限（nginx 用）都放在同一個「門」裡。
   結果是：想知道「這個數字誰在用」要全專案搜；新增一個共用值時沒有地方比較合適，只好又丟進這扇門。
2. **前端的 app store（`lib/appStore`）是所有畫面共用的介面，但沒有一個小而具名的讀取介面。**
   115 個檔案裡有 248 處就地寫 `useAppSelector((s) => s.data.nodes)` 這類讀法，每一處都知道 store 的內部形狀；
   形狀一改（例如把 `nodes` 拆開），要改的是 115 個檔案而不是一個。
   同時有 61 處畫面自己寫出 `/api/...` 路徑去呼叫 `sendWrite`（AI 設定、收件匣、空間、RSS、讀書卡…），
   各自決定路徑、內容與錯誤處理，而不是走 `lib/data` 的「使用者要完成的事」介面（AGENTS.md 的設計硬規則）。
   做得好的對照組已經存在：`lib/data`（55 行入口、246 個檔案使用、只有 3 處深入內部）、`components/ui`、`pagebook`。

**做完長什麼樣。**
- `@onden/markdown` 的根入口只剩「Markdown 語法與渲染管線」；任務／時間規則、網站渲染、前後端共用的數值各有名字清楚的入口
  （或搬到本來就叫「合約」的 `@onden/contract`）；沒有人用的名稱不再對外。目標：根入口 692 → 約 300 以下。
- 畫面要讀 store，只用 `lib/data` 提供的十來個具名 hook（`useNodes()`、`useTagsById()`、`useIsOnline()`…）；
  畫面要寫，只呼叫 `lib/data` 的領域 writer（`aiRoles.rename(...)`、`inbox.approve(...)`）；
  app 內部互相喚醒（開設定、開快速新增…）用一張有型別的事件表，而不是各自寫字串。
- 每一步都有一個「只准減少」的數字守著，所以退步會在 CI 紅燈，不靠記憶。

**代價。**
- 約 14 個小 PR（見第 4 節），多數是機械式改 import 或把一個畫面的 `sendWrite` 搬進 writer；沒有一個會改使用者看到的行為。
  預估總工時約 8–12 個工作天，分成互不相依的兩條線（markdown 線、app store 線）可以並行。
- 風險最大的兩處：新增子入口要在 5 個地方登記（package.json、astro 設定、前端與後端的 vitest 別名、後端 tsconfig），漏一處就是 build 或測試才爆；
  以及開機 JS 預算（現在 313.3 KiB gzip，**不能調高**）——搬 import 路徑本身不增加位元組，但根入口因為被別名成「有副作用」，新入口必須照既有子入口的方式登記，否則會把不用的東西留在開機包裡。

**順序。** 先做「不動行為、只減少數字」的便宜步驟（把沒人用的匯出收起來、把 `useAppSelector` 換成具名 hook），
再搬子入口，最後才處理 `lib/api.ts` 與 `lib/editor*` 的整理。每一步先過守門再往下。

**這個 PR 交付什麼。** 這份提案＋6 個新的只准減少的守門（第 5 節）。守門的起點就是今天的數字，之後只能降。

**和委託時給的數字不同之處（我重量後的結果）。** 以下以我量到的為準，量法在第 1 節：
根入口名稱 692（委託寫約 594，差在我把型別也算進去）、前後端取用 509（委託約 474，同樣含型別）；
就地 selector 248 處／115 檔（委託約 103 處／59 檔，那是「只算 `s.data.X` 且不含 modules」的子集；我量到 `s.data.*` 共 146 處）；
`setData` 在 `lib/data` 外 **0 處**（委託列的 `AppTopbar`、`SidebarTagTree`、`taskDrag` 是瀏覽器的 `dataTransfer.setData`，不是 store 的 `setData`；
真正直接寫 store 的只剩 `lib/buildVersion.ts` 的一次 `setAppState`）；
`sendWrite` 寫出 `/api/` 字面路徑 61 處／26 檔（委託 27 處／14 檔；我把模板字串與 modules 也算進去）；
`onden:` 事件名稱 17 個（委託 57 個，推測連 `onden.xxx` 的本機儲存鍵與 CSS class 一起算了；那些不是事件）。

---

## 1. 量法與今天的數字〔量測〕

| 量 | 數字 | 量法 |
| --- | ---: | --- |
| `@onden/markdown` 根入口對外名稱 | **692**（99 個來源檔） | TypeScript 編譯器解析 `index.ts`（`export *` 展開），值與型別都算；守門 `markdown-root-export-names` |
| 前後端正式程式從根入口取用的不同名稱 | **509**（前端 371、後端 323；site 7、contract 2） | 語法掃描 `import … from "@onden/markdown"`（不含子入口，含 `type` 與 re-export）；守門 `markdown-root-names-in-use` |
| 根入口有、但前後端都沒從根入口取用 | 182 | 692 − 509；其中 144 個連在 frontend／backend／site／contract 的任何檔案都沒出現過名字 |
| 其他 11 個子入口的取用名稱 | ink 79、page-text 16、page-images 11、snippet 4、task-parse 4、contract 3、steps-enhance／slug／full／block-id 各 1 | 同上 |
| markdown 套件非測試程式 | 15,120 行、122 個檔 | `src/*.ts` 去掉 `.test`、`.generated`、`.testing` |
| 就地 `useAppSelector(<函式>)`（`lib/data`、`lib/appStore` 以外） | **248 處／115 檔**（modules 外 194 處／80 檔） | AST；守門 `fe-store-inline-selector`（逐檔） |
| 其中讀 `s.data.*` | 146 處 | 同上 |
| 整個 store 的寬入口（`getAppState`／`useAppSelector`／`setAppState`／`subscribeApp`） | **328 處／137 檔** | 既有 `fe-app-store-reach`（基準檔原本寫 343，實際早已降到 328，這次一併校正；只往下） |
| 直接寫 store（`setData`／`setAppState`） | **1 處**（`lib/buildVersion.ts`） | 守門 `fe-store-write` |
| `lib/data` 外、路徑寫成 `/api/…` 字面的 `sendWrite` | **61 處／26 檔**（`sendWrite` 全部 68 處／29 檔，另 8 處用 `cardPath()` 或變數組路徑） | AST；守門 `fe-literal-api-write` |
| app 內 window 事件名稱 | **18 個** | `…EVENT` 常數值＋交給 `emitWindowEvent`／`onWindow`／`CustomEvent`／`addEventListener` 的字面；守門 `frontend-window-event-names` |
| `lib/api.ts` | 749 行；290 個檔案 import 它、其中 209 行是 `import type` | 它同時是 wire 型別（27 個 `export type`）、連線設定（`getApiBase`、`setApiBase`）、傳輸（`api`、`apiFetch`、`postRead`）、錯誤類別（`ApiError`）、空工作區常數 |
| `lib/editor*` | 35 個非測試 `.ts`（共 43 檔含測試與 CSS）、無入口 | `ls lib/editor*` |
| `MarkdownEditor` props | `Props` 型別區塊 122–224 行（約 100 行） | 〔待驗證〕委託說 38 個欄位，我沒有逐一數 |
| `useUrlSync` | 11 個位置參數（6 個必要、5 個有預設） | `hooks/useUrlLocation.ts` |
| `BuilderWorkspace` | 527 行、44 次 `useXxx(` 呼叫（39 種） | `grep` |

守門的數字全放在兩處：逐檔的三條走 `scripts/allowlist-baseline.json`（沿用 `fe-app-store-reach` 的機制與 `RATCHET_RULES`），
三個「總數」（根入口名稱、取用名稱、事件名稱）放新的 `scripts/surface-baseline.json`；兩處都在 `scripts/ratchet.mjs` 的「只准減少」檢查範圍內。

---

## 2. 問題 A：`@onden/markdown` 寬而不深

### 2.1 現況：模組依實際用途分組〔量測〕

分組是我讀檔名與內容後手分的，不是程式碼自己宣告的；「根名稱」是該組在根入口對外的名稱數，「取用」是前後端實際從根入口取用的名稱數。

| 組 | 模組數 | 根名稱 | 取用（前端／後端） | 它是什麼，誰用 |
| --- | ---: | ---: | ---: | --- |
| **Markdown 語法與管線** | 61 | 373 | 267（173／172） | 解析與改寫：`blocks`、`blockLink`／`blockChild`／`blockRef`、`attributeValue`、`frontmatter`、`paragraphs`、`fences`、`headingAnchors`、`mentions`、`callouts`、`embeds`、`plainText`、`excerpt`、`text`、`textPatch`、`graphemes`、`queryBlocks`、`bases*`、`searchQuery`、`core`（管線本體）。前後端都大量使用 |
| **領域規則（任務、重複、日曆）** | 12 | 70 | 49（37／31） | `taskTime`、`taskBucket`、`taskReminder`、`recur`、`calendar`、`dateParse`、`dayItems`、`dayNote`，加上 `uuid`、`color`、`slug`、`fieldClashes`。與 Markdown 語法無關，是「任務與時間」的規則；根入口之外已有 `task-parse` 子入口（4 個名稱），規則被分在兩處 |
| **前後端約定的值（wire／contract）** | 9 | 117 | 101（83／82） | `sharedContract`（51 個名稱：任務模組 id、`_task_*` 屬性鍵、各種長度上限…）、`mediaTypes`（副檔名表與 **nginx 請求大小上限**）、`browserBridge`（**頁面與瀏覽器版 worker 之間的訊息型別**）、`noteLimits`、`sitePath`、`partLinkExport`、`servedPartLink`、`skillFile`、`slidesData`。`packages/contract/src/node.ts`、`board.ts` 反過來從 markdown 取上限（`@onden/markdown`）：**約定的值在 markdown、約定的型別在 contract**，兩個套件互相需要 |
| **網站／簡報渲染** | 16 | 124 | 88（78／36） | `siteHead`（含 **GA 程式碼產生**）、`mediaMarkup`、`mediaEmbed`、`mediaSanitize`、`embedFrame`、`liteEmbed`、`diagramLayout`／`diagramSvg`、`slide*`、`steps*`、`handwritingPage`。已發布網站、匯出、簡報播放用 |
| 手寫（已是子入口） | — | 5（`inkRegion`） | 79 個名稱走 `./ink` | 已分開，做得對 |
| 只在瀏覽器跑（已是子入口） | — | 0 | `page-text`、`page-images`、`media-enhance`、`steps-enhance`（用到 `window`） | 已分開；根入口沒有被 DOM 程式污染（根入口的 `/api/` 字面約 31 行，分布在 12 個檔，主要是 `mediaRefs`、`mediaTypes`、`browserBridge`，都是「路徑長什麼樣」的約定，不是呼叫） |

另外三件事我確認過：
- 根入口用 `export *` 轉出 `core.ts`，`core.ts` 再轉出約 100 個模組；實際「宣告在 `core.ts` 本身」的只有 8 個名稱。
- 取用最廣的是 `sharedContract`（前端 38、後端 40 個名稱）、`attributeValue`（11／19）、`paragraphs`（9／13）、`frontmatter`（5／13）。
- 11 個子入口之中，`./contract`、`./slug`、`./snippet`、`./block-id` 只是把根入口裡已有的名稱再給一條路；沒有人被迫用它們。

### 2.2 〔建議〕目標形狀

原則：**根入口只放這個套件名字所說的事（Markdown 語法與管線）**；其他組各有名字清楚的入口，名稱依「誰用」分，不依「檔案在哪」分。

| 入口 | 放什麼 | 備註 |
| --- | --- | --- |
| `@onden/markdown`（根） | 語法與管線：上表第一組 | 目標 ≤ 300 名稱；再把沒人用的收掉（下節） |
| `@onden/markdown/tasks-time` | 領域規則組（任務 bucket、重複、日曆、日期解析、`dayItems`、`dayNote`）＋現有 `task-parse` 併進來 | 名字沿用守門 `tasks-time.guard.test.ts` 的說法；一組規則一個地方 |
| `@onden/markdown/site` | 網站／簡報渲染組 | 前端的 `components/siteFrame/` 與後端 `website/publishing/` 是主要用戶；`packages/site` 也用。**不新開套件**：`@onden/site` 已存在但它是「首頁設計資料型別」，把 GA 與 head 產生搬過去會讓 `@onden/site` 依賴 markdown 的 sanitize／媒體規則，現在沒有足夠理由 |
| `@onden/contract`（既有套件） | **前後端約定的值**：`sharedContract` 的上限與常數、`mediaTypes` 的大小上限、`browserBridge` 的訊息型別 | 清楚合理的搬移：這個套件的名字就是這件事；同時拿掉現在 contract → markdown 的反向依賴（`node.ts`、`board.ts`）。markdown 內部要用的值（例如任務規則要 `TASK_ATTR`）改從 contract 取，方向變成 markdown → contract（葉節點）。與另一條進行中的「wire 型別搬進 contract」PR 同方向，但**這份只列計畫，不在那條 PR 範圍內動手** |
| 既有子入口 | `ink`、`page-text`、`page-images`、`media-enhance`、`steps-enhance`、`slug`、`snippet`、`block-id`、`full` | 不動；`./contract` 在搬完後留一個薄 re-export 一個版本期，最後刪 |

**什麼時候再切語法組。** 搬完上面三組＋收掉沒人用的名稱後，根入口預估剩約 267 個「有人用」的名稱。
若屆時還有人覺得「找不到」，再依用途切 `./blocks`（block id／連結／引用／子節點）、`./attributes`（屬性、frontmatter、欄位衝突），
切之前先量：只有當某一組被 ≥ 3 個以上的消費模組成批使用時才值得；**不預先切**。

**為什麼不是新套件。** 唯一「明確合理」的搬移是約定的值進 `@onden/contract`（上表）。
其餘各組都還和 Markdown 管線共用 sanitize schema、語法解析與渲染常數，單獨成套件會多一層 build／版本／別名，卻沒有消除任何錯誤來源；
子入口已經能達到「看名字就知道這組是什麼」。

### 2.3 〔建議〕哪些名稱應該不再對外

182 個名稱前後端都沒從根入口取用。處理方式分三種，**依序，不要一次做**：

1. **沒有任何人用（144 個，連名字都沒在 frontend／backend／site／contract 出現）**：直接不再從 `core.ts` 轉出（模組內部繼續用）。
   這批和進行中的「刪未用匯出」PR 會重疊；先看那條 PR 合併後的 `markdown-root-export-names`，再補剩下的。
2. **只有 markdown 自己的測試用**：測試改成相對 import 該模組，根入口不再轉出。
3. **site／contract 取用的名稱（共 9 個，其中有些前後端也用）**：隨該組搬到子入口。

名稱數最多的來源檔（未被前後端取用者）：`blocks`（10）、`sharedContract`（8）、`highlight`（7）、`dayItems`（7）、`blockLink`（7）、`attributeValue`（6）、`mediaMarkup`（6）、`diagramLayout`（6）、`blockChild`（6）、`siteHead`（6）。
這幾個檔先看。

### 2.4 〔建議〕消費者怎麼搬，不用一個巨大 PR

規則：**每搬一組，3 步，各自一個 PR，每步守門數字都往下**：

1. **加入口**：建立子入口，登記在 5 個地方（見風險 R1），根入口暫時繼續轉出同一份名稱。此步名稱數不變，唯一產出是「新路徑可用」。
2. **搬消費者（可拆成 backend／frontend／site 三個 PR）**：機械式把 `import { X } from "@onden/markdown"` 改成新入口。
   `markdown-root-names-in-use` 每個 PR 都下降；單一 PR 不超過約 150 個檔案的 import 行（純 import 變動，不夾其他修改）。
3. **刪根入口的轉出**：`markdown-root-export-names` 降低，TypeScript 編譯器會指出漏搬的人。

搬的過程中「兩條路都能用」，所以不會有「某個 PR 合併後別的 PR 壞掉」的瞬間；多個 PR 同時進行時只要各自負責不同組即可。

### 2.5 〔建議〕順手收的重複（先不做，記下來）

不在根入口寬度的範圍，但同一份盤點看到：
- **圍欄（```）掃描**：`fences.ts` 已經是唯一入口，但仍有 `backend/modules/importers/obsidian/import.ts:42`、`backend/services/taskListFile.ts:221`、`backend/services/exportZip.ts:88`（一條合併的 CODE regex）、
  `frontend/modules/importers/excalidraw.ts:47,52`、`frontend/lib/editorCodeHighlightOnDemand.ts:8` 自己寫。
  `exportZip.ts` 的行內程式碼／圍欄是不同需求（連行內反引號一起略過），不一定能直接換。〔待驗證〕
- 標題、`[ ]` 核取方塊的 regex 在 frontend／backend／site 非測試程式約 4 行；量小，等圍欄那批一起看。

---

## 3. 問題 B：前端 app store 是所有人的介面

### 3.1 〔量測〕呼叫者實際從 store 讀什麼

`lib/data`、`lib/appStore.ts` 以外，就地寫的 `useAppSelector((s) => …)` 一共 248 處。依「讀哪個切片」：

| 讀的切片 | 次數 | 它是什麼 |
| --- | ---: | --- |
| `s.data.nodes` | 54 | 全部筆記節點 |
| `s.data.tags` | 46 | 全部標籤 |
| `s.online` | 45 | 是否連線 |
| `s.selectedId` | 14 | 目前選的筆記 id |
| `s.data.workspace` | 12 | 工作區資訊 |
| `s.data.tasks` | 11 | 任務列 |
| `s.data`（整包） | 10 | 整個 bootstrap |
| `s.activeCanvas` | 9 | 目前開的白板 |
| `s.data.edges` | 7 | 連結邊 |
| `s.membershipGated`／`s.bootstrapped` | 6／6 | 啟動狀態 |
| `s.data.canvas_memberships`／`s.data.actor_is_owner` | 4／4 | 白板成員／是不是擁有者 |
| `s.data.site_config` | 3 | 網站設定 |
| `s.overviewView` | 2 | 預覽或編輯 |
| 其餘 17 個切片各 1 | 18 | `accessRevoked`、`localCopy`、`newVersionAvailable`、`overviewDraft`、`overviewTitleDraft`、`saveStatus`、`overviewPane`、`data.pointers`、`overviewSearchOpen`、`overviewSearchFocusPending`、`sidebarTagsFocusPending`、`data.timezone`、`data.example_seed_eligible`、`overviewSearch`、`toasts`、`data.can_review`、`data.chrome` |

已經用具名 selector 的：`selectOverviewNodes`（7）、`selectOverviewSelectedNode`（4）、`selectCanvases`（3）、`selectSearchableNodes`（2）、`selectTagsById`（1），
加上 `useNode`／`getNode`／`useAllNodes`／`useTaskRows`。也就是**已經有 17 個具名入口，但 248 處就地讀法繼續長**。
數字重點：**前 8 個切片（nodes、tags、online、selectedId、workspace、tasks、整包 data、activeCanvas）佔 201／250 = 80%**。

### 3.2 〔建議〕一小組具名 hook，由 `lib/data` 擁有

形狀集中在一處，呼叫者讀的是「意思」不是 `s.data.nodes`。起手只做佔 80% 的八個，其餘按需要加：

| 具名入口 | 取代 | 備註 |
| --- | --- | --- |
| `useNodes()`（`useAllNodes` 改名並公開） | `s.data.nodes`（54） | 已有 `useAllNodes`，先改用它 |
| `useTagsById()`／`useTags()` | `s.data.tags`（46） | `selectTagsById` 已存在 |
| `useIsOnline()` | `s.online`（45） | 一個布林，最單純的一步 |
| `useSelectedId()` | `s.selectedId`（14） | |
| `useWorkspace()` | `s.data.workspace`（12） | 回傳畫面要的欄位，不是整個 bootstrap |
| `useTaskRows()`（已存在） | `s.data.tasks`（11） | 只要改用 |
| `useActiveCanvas()` | `s.activeCanvas`（9） | |
| `useBootstrapState()` | `bootstrapped`／`membershipGated`／`accessRevoked`（13） | 一個回傳小物件的 hook，不是三個旗標 |

放哪裡：**selector 的實作留在 `lib/appStore.ts`（它擁有 `AppState` 的形狀），從 `lib/data/index.ts` 轉出**，
讓畫面只 import `lib/data`（和現在寫入的習慣一致，且 `lib/data` 的 eslint 邊界已經在強制）。
這樣 `lib/appStore` 的「寬入口」（`useAppSelector` 等）最終只剩 `lib/data` 自己用，守門 `fe-app-store-reach` 的最終目標是 0。

兩種設計草圖比較（新公共介面規則）：
- **A. 具名 hook 集合（建議）**：每個 hook 一個意思，形狀改動只動 appStore。代價：要新增幾個 hook；hook 太多時要維護。
- **B. 單一 `useStore(selector)` 但 selector 必須從 `lib/data/selectors` 取**：呼叫者仍寫 `useStore(selectNodes)`，多一層；
  對讀者來說和現在的 `useAppSelector(selectCanvases)` 沒差別，不減少要理解的概念。
選 A。

### 3.3 〔建議〕寫入：`setData` 已經收乾淨，剩一條

- `setData`：`lib/data` 外 **0 處**（委託列的 8 檔是 DOM 的 `dataTransfer.setData`）。守門 `fe-store-write` 的基準只有 1：`lib/buildVersion.ts` 的 `setAppState`（「有新版本」旗標）。
  處理：在 `lib/data` 加 `markNewVersionAvailable()`（名字說它的意思），`buildVersion.ts` 改呼叫；基準 → 0。一個 PR，十行。
- 目標：`fe-store-write` 永遠 0。

### 3.4 〔建議〕`lib/api.ts`：型別與傳輸分家

749 行、290 個檔案 import；209 個 import 行是 `import type`。它混了五件事：

| 內容 | 約行 | 建議去處 |
| --- | --- | --- |
| wire 型別（`Bootstrap`、`ContentNode`、`TagMergePreview`…；27 個 `export type`） | ~290 | `packages/contract`（另一條進行中的 PR 在做）；前端留 `lib/apiTypes.ts` 作過渡轉出，讓 290 個 importer 不需要一次全改 |
| 連線設定（`getApiBase`、`setApiBase`、`checkOndenServer`、`shouldSkipServerSetup`） | ~130 | `lib/serverSetup.ts` |
| 傳輸（`api`、`apiFetch`、`postRead`、`postReadResponse`、`readWithDeadline`） | ~150 | 留 `lib/api.ts`，只剩傳輸；**畫面不該直接用**（走 `lib/data`） |
| `ApiError` 與監聽器（`setClientTooOldListener`…） | ~60 | 留傳輸旁 |
| `noWorkspaceData`、`hasNoWorkspace`、`nodeNeedsBody`、`pageHref`、`reloadPage`、`fetchTagMergePreview` | ~60 | 前三個進 `lib/data`；`pageHref`／`reloadPage` 進 `lib/globalEvents` 或 `lib/locationActions`〔待驗證名字〕；`fetchTagMergePreview` 進 `lib/data/tagMerge.ts`（已有同名模組） |

順序：先拆型別（機械式，type-only import 不改執行行為，也不改開機位元組），再移出連線設定。傳輸函式最後才整理，因為 `lib/data` 與測試大量依賴。

### 3.5 〔建議〕缺的 writer：AI 設定與收件匣

61 處「畫面自己寫 `/api/…`」的分布（`fe-literal-api-write`）：

| 群 | 檔案數／處數 | 例子 | 建議 writer（放 `lib/data/`） |
| --- | ---: | --- | --- |
| **AI 角色與金鑰** | 8 檔／21 處 | `settings/ai/actions.ts`（8）、`AddAiRoleWizard.tsx`（5）、`AiEditor`（2）、`HelperMention`（2）、`AiRoleStatus`、`ApiRuntimeSetup`、`ChangeConnectionFlow`、`HelperKeys` | `aiWriter`：`createRole`、`renameRole`、`setRuntime`、`setReviewRule`、`createToken`、`revokeToken`、`saveCredential`、`removeCredential`、`setRunnerHandle`、`setRunnerEnabled`。`settings/ai/actions.ts` 已經是半個 writer，搬過去最直接 |
| **空間與成員** | 3 檔／10 處 | `lib/spaces.ts`（6）、`SpacesAndMembers`（3）、`TransferOwnershipDialog`（1） | `spaceWriter`（`lib/spaces.ts` 本來就是，只是在 `lib/data` 外） |
| **收件匣治理與擷取** | 3 檔／8 處 | `hooks/useInboxGovernance.ts`（4）、`hooks/useFailedDeliveries.ts`（3）、`modules/capture/inbox.ts`（1） | `inboxWriter`：`approve`、`decide`、`decideGroup`、`decideBatch`、`retryFailed`、`dismissFailed` |
| **RSS** | 5 檔／10 處 | `RssSourceSheet`（3）、`rssMutes`（3）、`RssReaderPanel`（2）、`RssOpmlWidget`、`RssSourcesSheet` | 模組自己一個 writer 檔；模組可以擁有，但不散在 5 個元件 |
| **讀書卡設定** | 1 檔／1 處（另有約 7 處用 `cardPath()` 組路徑，不在字面計數內） | `ReviewSettings.tsx`；`ReviewPanel`、`StoppedInNote`、`ReviewStatusPage` | 模組自己的 writer；`cardPath()` 那批同樣是「畫面決定路徑」，之後可另開守門 |
| **其他** | 6 檔／10 處 | `CalendarsSetting`（4）、`webPush`（2）、`InviteClaimGate`、`useNodeCreation`、`accountPrefStore`（1）、`FolderImportSetting` | 外部日曆、匯入、邀請、書籤各一個窄 writer；`accountPrefStore`、`webPush` 本身就是專責模組，基準可以留 |

規則（沿用 AGENTS.md 的設計硬規則）：writer 擁有「路徑、內容形狀、冪等鍵、錯誤映射、成功後的本機更新」；畫面只呼叫「使用者要完成的事」。
`sendWrite` 目前沒有被 lint 限制在 `lib/data`；先靠 `fe-literal-api-write` 逐檔只減不增，最後再把 `sendWrite` 本身改成只有 `lib/data` 能 import（和 `lib/data` 的 eslint 邊界同一種做法）。

### 3.6 〔建議〕`lib/editor*` 的入口

35 個 `lib/editor*.ts` 沒有入口；呼叫者各自深入 import。做法與 `lib/data` 同款：

1. 把它們搬進 `lib/editor/`（`git mv`，import 路徑改成 `lib/editor/xxx`；純機械），加 `lib/editor/index.ts`（只轉出「編輯器外面要用」的名稱，其餘留作內部）。
2. eslint 邊界：`lib/editor/*` 以外不准 import `lib/editor/<檔案>`，只能 `lib/editor`（和 `lib/data` 的深入 import 規則相同，現有 3 處深入就是白名單範本）。
3. `components/MarkdownEditor.tsx` 的 Props：在入口裡把「功能群」命名（`EditorHost`、`EditorToolbarOptions`…），Props 分成三四個物件，不是 38 個平行欄位。這步最後做，因為牽動所有呼叫點。〔待驗證〕要先量哪些 props 是呼叫者真的會傳的。

### 3.7 〔建議〕window 事件的型別表

18 個事件名稱散在約 15 個檔案（`lib/featureRequest.ts`、`settingsRequest.ts`、`tagPageRequest.ts`、`textStyleRequest.ts`、`writingModeRequest.ts`、`paneWidths.ts`、`penShortcutBridge.ts`、
`modules/tasks/openQuickAddTask.ts`、`modules/capture/openQuickCapture.ts`…）。形式兩種混用：`onden:xxx` 與 `onden-xxx`；
發送用 `emitWindowEvent(name: string, detail?: unknown)`，聽用 `onWindow(name: string, handler)`，`detail` 完全沒型別。

建議：`lib/appEvents.ts` 一張表 `{ "open-settings": { page?: string }, "open-quick-capture": void, … }`，
輸出 `emitAppEvent(name, payload)`／`onAppEvent(name, handler)`，名稱與 payload 型別一起檢查；
`emitWindowEvent`／`onWindow` 保留給瀏覽器原生事件。遷移是逐事件一個小 PR（每個事件 3–6 行），
守門 `frontend-window-event-names` 的計法在表建好後改成「表的鍵數」。**不統一前綴字串的歷史差異**（`onden:` vs `onden-`）：
只要事件走 `emitAppEvent`，外面看不到字串，內部統一成 `onden:`。

### 3.8 〔建議〕`useUrlSync` 與 `BuilderWorkspace`（本批只記）

- `useUrlSync` 11 個位置參數：改成一個具名物件參數（`{ view, nodeId, lens, tab, trail, rightPane, seedDefaultScreen }`＋ setters 為 `onChange`）。
  只有一個呼叫點（`App`／`hooks/useAppShell`）〔待驗證〕；一個 PR，行為不變。
- `BuilderWorkspace`（527 行、44 次 hook 呼叫）：不是 store 問題，是畫面問題；列入「下一批」，不在本提案內。

---

## 4. 分階段計畫：小而不改行為的 PR〔建議〕

每一步都降低一個守門數字。「並行」欄表示可以和哪條線同時做；大小是改動的檔案數量級，不是工時。

**A 線：markdown**

| # | PR | 降低哪個數字 | 大小 | 風險 | 並行 |
| --- | --- | --- | --- | --- | --- |
| A1 | 收掉沒人用的根入口名稱（144 個）；先等「刪未用匯出」PR 合併再量 | `markdown-root-export-names` 692 → ~545 | 小（`core.ts` 轉出行） | 低；編譯器會指出漏的 | 與 B 線全部並行；與進行中 PR 有重疊，**先確認它的範圍** |
| A2 | 子入口登記同步守門：5 個登記處（package.json、astro、前端 vitest、後端 tsconfig、後端 vitest）必須列同一組子入口 | —（防呆） | 小（一個 guard 測試） | 低 | 與 A1 並行；**其他 A 步的前置** |
| A3 | `./tasks-time` 入口＋前端／後端搬消費者＋刪根轉出（3–4 個 PR） | `…-in-use` −49；`…-export-names` −70 | 中（約 40–60 檔 import） | 中：`task-parse` 併入；任務守門 `tasks-time.guard` 要同步 | A4 之後（共用的 A2）；與 B 線並行 |
| A4 | 約定的值進 `@onden/contract`（`sharedContract`、`mediaTypes` 上限、`browserBridge` 型別）；`@onden/markdown/contract` 留薄 re-export | `…-in-use` −101；`…-export-names` −117 | 大（約 80 檔；contract 與 markdown 的依賴方向反轉） | **中高**：markdown 套件第一次依賴 contract；worker 與瀏覽器版後端的 bundle 要驗；**與進行中的「wire 型別搬進 contract」PR 必須協調順序** | 不與 A3 同時改同一檔；與 B 線並行 |
| A5 | `./site` 入口＋搬消費者＋刪根轉出 | `…-in-use` −88；`…-export-names` −124 | 中（約 50 檔） | 中：發布網站與匯出的渲染要跑 `render-parity` 守門 | 等 A2；與 A3／A4 可並行（不同組） |
| A6 | 再量；若根入口仍 > 300 名稱，才切 `./blocks`／`./attributes`，並刪 `./contract` 薄轉出 | 視量測 | 視量測 | 低 | 最後 |

**B 線：前端 store 與 writer**

| # | PR | 降低哪個數字 | 大小 | 風險 | 並行 |
| --- | --- | --- | --- | --- | --- |
| B1 | `useIsOnline()`＋`useSelectedId()`＋`useActiveCanvas()`：換掉 `s.online`／`s.selectedId`／`s.activeCanvas`（68 處） | `fe-store-inline-selector` 248 → 182；`fe-app-store-reach` 同降 | 中（約 40 檔，機械式） | 低：selector 回傳型別不變；`shallowEqual` 行為要保留 | 與全部並行 |
| B2 | `useNodes()`／`useTagsById()`／`useWorkspace()`／`useTaskRows()`：換掉 `s.data.*` 前四大（123 處） | 182 → ~60 | 大；**拆成「nodes」「tags」「workspace＋tasks」三個 PR** | 低–中：`s.data.nodes` 的讀法有些會做二次過濾，要逐處看是否該用 `selectSearchableNodes` 之類既有的 | B1 後（共用檔案多） |
| B3 | 其餘 17 個切片與 `s.data` 整包（10 處）改具名 hook／拆小 | → 0（`lib/data` 外） | 中 | 低 | B2 後 |
| B4 | `lib/buildVersion.ts` 的 `setAppState` → `lib/data` 具名函式 | `fe-store-write` 1 → 0 | 極小 | 極低 | 隨時 |
| B5 | `aiWriter`：`settings/ai/actions.ts` 搬進 `lib/data`；`AddAiRoleWizard`、`AiEditor`… 改呼叫 | `fe-literal-api-write` 61 → 40 | 中（9 檔） | 中：AI 設定的冪等鍵與錯誤文字（`lib/serverErrors.ts`）要原樣保留；有現成測試 | 與其他 B 並行 |
| B6 | `inboxWriter`（`useInboxGovernance`、`useFailedDeliveries`） | → 31 | 小（3 檔） | 低 | 並行 |
| B7 | 空間 writer 搬進 `lib/data`（`lib/spaces.ts`）＋模組各自 writer（RSS、讀書卡、日曆；各一個 PR） | → ~10 | 中，分 4 個 PR | 低 | 並行 |
| B8 | `lib/api.ts` 拆型別（`apiTypes.ts` 轉出）→ 連線設定 → 去留 | 無新守門；用 `fe-…` 之外的 import 數看板 | 大（import 行數多但全是 type-only） | 低（type-only 不影響執行） | 與 A4／另一條 contract PR **有衝突，要排在其後** |
| B9 | `lib/appEvents.ts` 型別表；逐事件遷移 | `frontend-window-event-names` 18 →（表鍵數；之後 `emitWindowEvent` 限定原生用途） | 小，每事件一個小 PR | 低 | 並行 |
| B10 | `lib/editor/` 入口與 eslint 邊界；之後切 `MarkdownEditor` Props | 新守門：`lib/editor` 深入 import 數（只減） | 大（35 檔 rename） | **中**：搬檔造成大量 diff，要單獨一個 PR、不夾別的；影響 `scripts/entrypoints.catalog.json` 與 `fe-editor-scroll-margin` 等守門的路徑 | 放最後；與 B8 同時別做 |
| B11 | `useUrlSync` 改成物件參數 | 無（可讀性） | 極小 | 低 | 隨時 |

並行線：**A 線與 B 線互不相依**；A 線內 A1、A2 先行；B 線內 B1→B2→B3 有順序，B4–B7、B9、B11 彼此獨立。
總量約 A 線 7–10 個 PR、B 線 15–20 個 PR（B2 與 B7 會拆）。

---

## 5. 這個 PR 加了什麼守門〔已實作、已測試〕

| 守門 | 量什麼 | 基準（今天） | 在哪裡 |
| --- | --- | ---: | --- |
| `markdown-root-export-names` | 根入口對外名稱 | 692 | `packages/markdown/src/test/guards/surface.guard.test.ts` |
| `markdown-root-names-in-use` | 前後端正式程式從根入口取用的不同名稱 | 509 | 同上 |
| `fe-store-inline-selector` | 就地 `useAppSelector((s) => …)`（逐檔） | 248／115 檔 | `allowlist/fileRules.ts` ＋ `scripts/allowlist-baseline.json`（沿用 `RATCHET_RULES`） |
| `fe-store-write` | 直接寫 store（`setData`／`setAppState`，逐檔） | 1 | 同上 |
| `fe-literal-api-write` | `lib/data` 外 `sendWrite` 的 `/api/…` 字面路徑（逐檔） | 61／26 檔 | 同上 |
| `frontend-window-event-names` | 不同 window 事件名稱 | 18 | `packages/frontend/src/test/guards/appStoreSurface.guard.test.ts` |

- 三條逐檔規則和既有 `fe-app-store-reach` **共用同一個 import 解析**（`allowlist/detect.ts` 的 `appStoreReachSites`），不是第二套；它們是它的子集，
  但回答不同的問題（還在讀形狀的就地 selector、還在直接寫的呼叫、還在自己寫路徑的畫面）。`fe-app-store-reach` 的基準順手校正為實際數字 328（原寫 343，已有 8 處悄悄降過；只降不升）。
- 三條新規則也在 `scripts/checkEditedFile.mjs` 的寫檔即檢查內：在新檔寫 `useAppSelector((s) => …)` 會被擋並指到具名 hook。
- 總數三個放 `scripts/surface-baseline.json`；降基準：`npm run surface:baseline`（任何上升就拒絕寫入）。
- `entrypoints.catalog.json` 的 `store-read-named-hook` 與 `domain-writers` 登記了新規則，`docs/agents/entrypoints-catalog.md` 已重新產生。
- 速度：兩個總數守門各約 1–2 秒（TypeScript 解析 markdown 入口約 0.7 秒），逐檔規則併入既有 allowlist 守門，不另掃一遍。

---

## 6. 風險與不做的事

**R1　新增子入口要登記 5 處。**〔量測〕`package.json` 的 `exports`、`packages/frontend/astro.config.mjs`、`packages/frontend/vitest.config.ts`、`packages/backend/tsconfig.json` 的 `paths`、`packages/backend/vitest.config.ts`。
今天各處列的子入口並不一致（例如後端 tsconfig 沒有 `./slug`、`./snippet`、`./contract`，因為用別的方式解析）。漏一處的症狀是 build 或某個測試才紅。→ A2 先加一個「五處一致」的守門。

**R2　開機 JS 預算 313.3 KiB（320,787 B gzip）不能調高**（`packages/frontend/scripts/check-boot-bundle.mjs`，`BOOT_BUDGET_GZIP`）。
根入口之所以不能有第三方 import，是因為 app 透過 Vite 別名取用它，被視為有副作用，第三方 import 會留在開機包。
→ 新子入口**必須**用和 `./ink`、`./page-text` 相同的別名方式登記，並在 PR 裡貼 `npm run build` 印出的開機 JS 大小；搬 import 路徑本身不增加位元組，但搬「模組」到 contract（A4）會改 chunk 切分，要看。
任何 A、B 步驟若讓預算變緊，先找出哪個 chunk 變大，不調預算。

**R3　worker 包。**`packages/frontend/scripts/check-worker-bundle.mjs` 檢查建好的 `localDbWorker-*.js` 不得含重型函式庫（2026-10-16 micromark 事故：worker 沒有 DOM，一條 import 讓它開機即死），且有大小預算；
`src/test/workerImports.test.ts` 在 vitest 下檢查 worker 的輸入。**A 線的每個消費者搬遷都可能改變 worker 的 import 圖**（例如 worker 取用 `taskBucket` 的路徑改變）。
→ 每個 A 步在 PR 裡跑 `npm run build`（含 worker 檢查）並貼結果；`./site` 與 Markdown 管線**不得**被 worker 引入，故任務規則（`./tasks-time`）要確保不依賴管線（`core.ts`）。
B8（拆 `lib/api.ts`）同樣要檢查：worker 若 import `lib/api`，拆分不得把傳輸帶進去。

**R4　markdown ↔ contract 的依賴方向（A4）。**搬完後 markdown 依賴 contract；contract 不可再 import markdown。要有守門（contract 的 import 邊界）。進行中的 contract PR 也在動 contract，**A4 必須排在它之後**。

**R5　與進行中 PR 的重疊。**刪未用匯出（markdown、前端）、取代 node 種類判斷、wire 型別搬進 contract：A1、A4、B8 與它們有檔案重疊。每個步驟開工前先看那幾條 PR 是否已合併，並以合併後的 `main` 重量一次基準（基準只准降，所以它們合併後 CI 會提示可降）。

**R6　行為保持。**所有步驟都是「換 import 路徑」「換成具名 hook」「把呼叫搬進 writer」，不改權限、事件、交易、保存確認或錯誤文字。
B5–B7 搬 writer 時，伺服器錯誤文字仍只走 `lib/serverErrors.ts`、保存確認仍來自伺服器接受或離線佇列已持久化（AGENTS.md「錯誤與保存」）；不得在搬的過程順手改冪等鍵或重試。

**不做的事。**不重寫、不新建套件（除非 A4 的「進 contract」）、不預先把語法組切成更多子入口、不預建 store 的訂閱 DSL、不改 `lib/data` 本身的形狀、
不在這份提案裡動 `BuilderWorkspace` 的 28 個 hook。

---

## 7. 完成條件

| 條件 | 現在 → 目標 |
| --- | --- |
| `markdown-root-export-names` | 692 → ≤ 300 |
| `markdown-root-names-in-use` | 509 → ≤ 270（只剩語法與管線） |
| `fe-store-inline-selector` | 248 → 0（`lib/data` 外） |
| `fe-app-store-reach` | 328 → 0（只有 `lib/data` 與 `lib/appStore` 自己用） |
| `fe-store-write` | 1 → 0 |
| `fe-literal-api-write` | 61 → ≤ 10（只剩專責模組自己的 writer：帳號偏好、推播） |
| `frontend-window-event-names` | 18 →（改計事件表鍵數）；`emitWindowEvent` 只給原生事件 |
| 開機 JS | 313.3 KiB gzip，不增加 |
| `localDbWorker` 與預算 | 不增加重型函式庫 |
