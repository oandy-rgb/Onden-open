# 後端「各寫各的」概念重複清單（2026-10-30）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：`packages/backend/src`（不含測試、migrations）。`dup:check`（jscpd）只抓逐字複製、`dup:names` 只抓同名匯出；這份找的是
**同一件事、不同寫法、不同名字**。[上一輪清單](dup-sweep-2026-10-29-backend.md)已處理的（A1–A8）與已列為批次的（B1–B14）不重報；
B 系列在本文中只在「現況有變、或補了新證據」時出現，標為「承 Bn」。

**只查、只寫報告，沒有改任何程式碼。** 位置以 2026-10-30 的 `origin/main` 為準，行號會漂移。
「實測」＝我實際跑過；「讀碼推斷」＝只讀程式判斷、沒有重現，後面都標明。本次沒有跑任何整合測試（只做靜態閱讀與 grep）。

> **需要馬上看的一條（R1）**：`modules/review/service.ts:193` 對一個 async 的權限函式少了 `await`，
> 條件永遠為 false，「看不到的標籤回 404」這道檢查形同虛設。它不是「重複」，是這輪掃描順便撞到的；
> 因為修法與守門都很小，放在總表第一列。

---

## 總表（依「嚴重度高且工作量小」排序）

| # | 概念 | 份數 | 嚴重度 | 工作量 | 守門方式 |
| --- | --- | --- | --- | --- | --- |
| R1 | async 權限判斷（`canSeeTag` 等）被當同步布林用，漏 `await` | 1 處現況違規 | **高**（授權） | 小 | guard test（名稱比對）＋後續可上 ESLint `no-misused-promises` |
| R2 | `LIKE`／`ILIKE` 的萬用字元跳脫（`%`、`_`） | 3 處（2 處沒跳脫） | **高**（使用者看得到：檢視篩選「包含 100%」會全中） | 小 | guard test（`ILIKE` 的檔案必須 import `escapeLike`） |
| R3 | 下載檔名與 `Content-Disposition` | 4 處 | **高**（中文標題匯出成 `----.html`） | 小 | guard test（標頭只准在一個檔） |
| R4 | 「只准本人、不准 token」的檢查 | 10+ 處，6 種拒絕形狀 | 中（同一件事被拒時狀態碼 403／409／404 不一） | 中 | guard test（`.tokenScope` 判斷＋throw 的組合） |
| R5 | 路徑／body 的 uuid 驗證與 `id::text = ANY(...)` | 5 種驗證寫法、17 處 `::text` 比對 | **高**（壞 id 回 500 或 404 或 400；承 B3） | 中 | ESLint `no-restricted-syntax`＋guard test |
| R6 | 401 未登入的手寫回應 | 9 處 | 低（本文相同，行為一致） | 小 | ESLint `no-restricted-syntax` |
| R7 | 404／400 回應本文的拼法（承 B4） | 8 種 404 拼法、41 處手寫 400 | 中（前端翻譯靠字串比對） | 中 | guard test（本文只准白名單）＋基線只減 |
| R8 | 請求 body 解析：壞 JSON 要不要當空物件 | 34 處吞掉、其餘直接拋 400 | 中（壞 body 可能套用預設值執行） | 小 | ESLint `no-restricted-syntax`＋唯一入口 `parseBody` |
| R9 | 背景工作排程（`setInterval`／`setTimeout`） | 8 處，5 種做法 | 中（多實例會重複跑；進程退出行為不一） | 中 | guard test（`setInterval` 只准在 `backgroundJobs.ts`） |
| R10 | 錯誤類別形狀與 `httpError.ts` 的 40 個 `instanceof`（承 B5） | 63 個 `extends Error` | 低 | 中 | guard test（新錯誤類別必須繼承 `StatusError`） |
| R11 | 路由內直接 `pool.query`（承 B2） | 24 處（7 個路由檔）＋2 個模組路由 | 中（讀寫之間的空窗；繞過服務層） | 中 | ESLint 擴充 `no-route-writes` 為 `no-route-sql`＋例外名單 |
| R12 | 「這批 id 裡我讀得到哪些」 | 4 種寫法 | 中（效能＋垃圾桶規則不一） | 中 | guard test＋共用 `readableAmong` |
| R13 | `process.env` 散在 17 個檔案、各自轉型與預設 | 17 檔、28 個鍵 | 低到中（`Number(x ?? d)` 遇到壞值變 `NaN`） | 中 | ESLint `no-restricted-properties`＋`config.ts` |
| R14 | 日誌：`console.*` 與 `logger.ts` 並存 | 7 個非測試檔 | 低 | 小 | ESLint `no-console` |
| R15 | 查詢參數文法：整數、`since`、旗標（承 B13） | 7 種 | 中（`?days=1.5` 等輸入各入口結果不同） | 小 | 唯一入口 `parseCount`／`parseFlag` |

排序說明：R1–R3 嚴重度高、各自只要改一到四個位置；R5 嚴重度高但牽涉面大，所以排在小項目之後。

---

## R1. async 權限判斷漏 `await`

- **概念**：`readPolicy.canSeeTag`／`canReadNode` 是 `async`，回傳 `Promise<boolean>`；沒有 `await` 時 `!canSeeTag(...)` 永遠是 `false`。
- **各自的寫法**：
  - 正確：`routes/nodes.ts:335`（`await canReadNode`）、`services/tagMerge.ts:48`、`services/tagViews.ts:161`、`services/noteViews.ts:45` 都有 `await`。
  - **錯誤**：`modules/review/service.ts:193`：`if (!exists.rows.length || !canSeeTag(actor, tagId)) throw new ReviewError(404, "tag not found");`
    `canSeeTag` 定義在 `services/readPolicy.ts:69`，`async`。結果：`assertVisibleTag` 只剩「標籤存在」這一半，使用者看不到的標籤仍會通過（回應不是 404）。
  - 影響範圍（讀碼推斷，未實測）：`assertVisibleTag` 在複習模組裡驗證標籤；標籤定義依註解對「任何空間成員」可見，所以一般成員不受影響；
    受影響的是**限定範圍的 token** 或只能看部分空間的操作者能不能碰到該標籤。嚴重度以授權計為高；實際可利用面要由權限擁有者確認。
  - 全 backend 掃描：對 `canReadNode`、`canReadRetainedNode`、`canSeeTag`、`canReadMedia`、`canReadSource`、`canPlaceUnder`、`canWriteSomewhere` 的呼叫，條件式中沒有 `await` 的**只有這一處**。
    其他 `assert*`／`is*`／`has*` 的 async 函式也都有 `await`（已逐一 grep）。
- **為什麼擋不住**：`packages/backend/eslint.config.js` 檔頭明說只開 `require-read-gate`、`no-route-writes`、`module-entry` 等自訂規則，
  `@typescript-eslint` 規則一條都沒開，所以 `no-floating-promises`／`no-misused-promises` 都不在。
- **建議的唯一入口**：不新增抽象；修法是補 `await`。
- **怎麼擋住**：
  1. guard test（`dupSweep.guard.test.ts` 同一個檔案風格）：對 `readPolicy.ts` 與 `spine/` 匯出的 `async function (can|may)\w+`，
     掃所有非測試檔，找 `[!&|?(]\s*NAME\(` 且該行沒有 `await NAME` 的。目前違規 **1 處**（上面那個），修完歸零，不需要例外名單。
  2. 長期：ESLint 開 `@typescript-eslint/no-misused-promises`（`checksConditionals: true`）。這條需要型別資訊（`parserOptions.project`），
     會讓 lint 變慢，所以先用 1 擋；要不要上 2 由維護者決定。
- **嚴重度**：高（授權）。**工作量**：小。

---

## R2. `LIKE`／`ILIKE` 萬用字元跳脫

- **概念**：把使用者輸入放進 `ILIKE '%…%'` 前，要把 `\`、`%`、`_` 跳脫，否則輸入的 `%`、`_` 會被當萬用字元。
- **各自的寫法**：
  - 有跳脫：`modules/citations/papers.ts:196`：`` `%${opts.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` ``。
  - **沒有跳脫**：`services/filter/sqlClauses.ts:109-110`（`contains`，欄位）：`` params.push(`%${f.value ?? ""}%`) `` 後接 `ILIKE $n`；
    `services/filter/sqlClauses.ts:155-158`（`contains`，屬性）：同樣沒有跳脫。
  - 結果（讀碼推斷，未實測）：在筆記集合檢視／儲存的檢視裡建一個「標題包含 `100%`」的篩選，`%` 會被當萬用字元，
    等於「標題包含 `100`」；篩選 `_` 則會比對任何單一字元，等於不篩。這是使用者看得到的不一致。
  - 不算違規：`services/harness/scope.ts:109-110` 的 `ILIKE ANY($2::text[])` 詞來自 `retrievalTerms`（`scope.ts:300`），
    只含 `[\p{L}\p{N}-]`，不會有萬用字元；但規則靠這個正規式的巧合成立，守門時要列入「已確認安全」。
    `services/collectionViewQuery.ts:11` 只是註解。
- **建議的唯一入口**：新增 `services/sqlLike.ts`（或放 `utils.ts`）`escapeLike(text)` 與 `containsPattern(text)`，
  `papers.ts` 與 `sqlClauses.ts` 都改用它；SQL 要加 `ESCAPE '\'`（Postgres 預設跳脫字元就是 `\`，可省，但明寫比較不會被改壞）。
  注意 `services/mediaAccess.ts:74` 的註解：媒體網址比對刻意用 `strpos(lower())` 而不是 ILIKE（PGroonga 的索引掃描會漏掉標點多的網址），
  新 helper 不要被用在那裡。
- **怎麼擋住**：guard test：非測試檔含 `ILIKE`（或 `\bLIKE\b`）者，必須 import `escapeLike`／`containsPattern`，例外名單放 `harness/scope.ts`（理由：詞只含字母數字）。
  目前違規：`filter/sqlClauses.ts`（1 個檔、2 處）。
- **嚴重度**：高（使用者看得到）。**工作量**：小（兩個呼叫點＋一個 helper＋一個整合測試：值含 `%`／`_` 的篩選）。

---

## R3. 下載檔名與 `Content-Disposition`

- **概念**：回應一個要下載的檔案時，檔名要同時對舊式 `filename=` 與 `filename*=UTF-8''…` 安全，且 header 不可被檔名注入。
- **各自的寫法**：
  - `routes/nodes.ts:344-345`（單篇筆記 `export.html`）：`slug.replace(/[^a-z0-9-]/gi, "-")` ＋ `filename="${filename}"`。
    **slug 規則保留中日韓文字**（`@onden/markdown` `slug.ts:1-8`：任何文字的字母、數字、組合記號都保留），所以標題「我的筆記」的 slug 是 `我的筆記`，
    經這個 `replace` 變成 `----.html`；整個檔名剩下破折號（讀碼推斷；`replace` 的行為是確定的，端到端沒有實測）。
    這個 app 的使用者是中文使用者，影響面大。
  - `routes/backup.ts:42`：`backupFileName()`（`services/backupArchive.ts:122`）產生，純 ASCII，沒有使用者字串。
  - `routes/export.ts:22`：固定字串 `onden-export.zip`。
  - `modules/website/routes.ts:259`：`site-static-${Date.now()}.zip`。
  - 四處都手寫標頭字串；沒有一處用 `filename*=`。
- **建議的唯一入口**：新增 `downloadHeaders.ts` 的 `attachmentHeaders(filename, contentType)`：輸出 `attachment; filename="<ascii 後備>"; filename*=UTF-8''<percent-encoded>`，
  後備名稱把非 ASCII 換成底線並移除引號、換行；四處都改呼叫它。`routes/nodes.ts` 該改用標題當檔名（跟 zip 匯出裡的檔名規則一致，見 `services/exportZip.ts`），而不是 slug 去掉非 ASCII。
- **怎麼擋住**：guard test：字串 `Content-Disposition`（不分大小寫）只准出現在 `downloadHeaders.ts`。目前違規 **4 處**（4 個檔）。
- **嚴重度**：高（中文標題的單篇匯出檔名）。**工作量**：小（一個 helper、四個呼叫點、一個測試：中文標題、含引號標題）。

---

## R4. 「只准本人（不是 token）」的檢查

- **概念**：某些操作只有本人（人類、非 token）能做：備份還原、批准／拒絕 agent 變更、建立空間、取消 session……
  目前每處自己寫 `if (actor.tokenScope) throw …`。
- **各自的寫法**（拒絕時使用者／client 看到的不同）：

  | 位置 | 條件 | 拒絕形狀 |
  | --- | --- | --- |
  | `routes/backup.ts:33` | `actor.tokenScope` | `AuthorityError("backup", …)` → 403 `{error: message}` |
  | `services/backupRestore.ts:294`、`:406`、`:549` | `tokenScope` | 同上，但訊息文字不同（"a backup is restored by a person, not a token"） |
  | `routes/inbox.ts:53` | `tokenScope` | 回傳字串，`reviewer()`（`:289`）包成 `403 {error:"forbidden", detail}`——**本文與 `AuthorityError` 不同** |
  | `services/spaces.ts:361` | `tokenScope` | `SpaceMoveError(409, "token_cannot_create", …)`——**409，不是 403** |
  | `services/ownerTransfer.ts:36` | `tokenScope` | `OWNER_ONLY`（`ActorAdminError`），刻意在任何查詢前，「token 什麼都學不到」 |
  | `services/agentSessions.ts:315` | `type !== "human" \|\| tokenScope` | `AgentSessionError` |
  | `services/agentSessions.ts:731` | `tokenScope` | `AgentSessionError("human_required", …, 403)` |
  | `services/agentSessions.ts:754`、`:769`、`:816` | `tokenScope` | 有的回 `not_found`（404）、有的 403 |
  | `services/agentSessions.ts:837` | `tokenScope \|\| !reviewAuthority` | 403 |
  | `services/harness/noteSkills.ts:57`、`services/spaces.ts:87`、`services/eventVisibility.ts:42`、`services/sync/delta.ts:500` | `tokenScope` | 不是拒絕，是「token 走另一條規則」——這類不算本議題，但同樣散落 |

  差異的後果：同樣是「token 想做只有本人能做的事」，對 client 可能是 403、409 或 404，訊息文字也各自不同；
  `ownerTransfer` 有「先擋再查」的資訊洩漏考量，其他處沒有統一遵守。
- **建議的唯一入口**：`spine/authority.ts`（已有 `AuthorityError`、`assertAuthority`）加 `requirePerson(actor, capability)`：
  人類且沒有 `tokenScope` 才通過，否則丟 `AuthorityError(capability, …)`（403）。需要「看不到＝404」的 agentSessions 三處保留自己的分支（有意為之），
  但改用 `isPerson(actor)` 述詞，不再各自展開條件。屬權限行為，不能順手改狀態碼：`spaces.ts:361` 的 409 是否改 403 要明確決定並通知前端
  （`lib/serverErrors.ts` 有 `token_cannot_create`）。
- **怎麼擋住**：guard test：`routes/`、`services/`（`spine/` 除外）出現 `if \(.*\.tokenScope\)\s*throw` 的檔案，必須在例外名單上（理由欄必填）。
  目前符合此樣式的違規約 **10 處**（上表前九列）；先把名單固定，之後只准減少。
- **嚴重度**：中。**工作量**：中（要先決定每處的狀態碼是否改變，並驗證允許／拒絕案例）。

---

## R5. uuid 驗證與 `id::text = ANY(...)`（承 B3，現況補充）

- **概念**：路徑／query／body 中的 id 必須是 uuid；之後拿去比對 `uuid` 欄位。
- **各自的寫法（現況；`routes/params.ts` 目前仍只有 `parseBigintId`，B3 還沒做）**：
  1. `isUuid(id)` → 404：`routes/boards.ts:69,81`、`routes/canvases.ts:101,124`、`routes/nodes.ts:379`；
     `routes/canvases.ts:140` 壞 id 回 `{ok:true}`（刪除）、`routes/nodes.ts:413` 壞 id 回 `{home:null}`、`routes/nodes.ts:391` 另一種。
  2. `z.string().uuid().safeParse` → 404：`routes/history.ts:81,126`。
  3. `z.string().uuid().parse(c.req.param("id"))` → 400（`bad_request`）：`routes/spaces.ts:46,57,67,86,93,101,108,116,117`、`routes/nodes.ts:181,190,218,231,356`、`routes/tags.ts:168,179`。
  4. 完全沒驗證就丟進 SQL：`routes/edges.ts:55-59`（`DELETE /:id`）、`routes/pointers.ts:74-78`、`routes/tags.ts:125-127`（`GET /:id`）。
     `WHERE id = $2` 的 `$2` 若不是 uuid，Postgres 會丟 `invalid input syntax for type uuid`，被 `apiOnError` 當未知例外回 **500**（讀碼推斷；
     B3 當時也標「尚未驗證」，這次仍**沒有實測**）。
  5. 私有 regex：`services/tasksStore.ts:254`（`/^[0-9a-f]{8}-[0-9a-f-]{27}$/i`，放寬到不是嚴格 uuid）。
  - 同一個 `/api/xxx/<壞 id>`，視入口不同回 404、400、`{ok:true}` 或（可能）500。
- **`::text` 比對的另一半**：`n.id::text = ANY($2::text[])`（把欄位轉文字，主鍵索引用不上；壞字串不會報錯、只是比不到）共 **17 處**：
  `services/history/{readableNotes.ts:25,rewind.ts:221,234,agentRuns.ts:107,140,activity.ts:193,321,pointInTime.ts:154}`、
  `services/canvasMemberships.ts:24,28,57`、`services/sync/{bootstrap.ts:220,delta.ts:504}`、`modules/website/publishing/siteHome.ts:35`、
  `services/wikilinkEdges.ts:40`、`services/purgedContent.ts:260`；
  對照 `id = ANY($n::uuid[])` 有 56 處（例如 `services/boardStore.ts:196`）。
  兩種寫法對壞輸入的行為相反：`::uuid[]` 遇到非 uuid 字串直接 500，`::text[]` 靜默比不到。
  效能影響沒量測；`history/` 一帶的呼叫量多不多要先量，不在此宣稱。
- **建議的唯一入口**：`routes/params.ts` 加 `uuidParam(c, name)`：壞 id 一律走同一個回應（建議 404，與 `isUuid` 多數入口、「看不到＝不存在」同向；
  改成 404 對現在回 400 的 `spaces`／`nodes` 是可觀察的變更，要先跟前端確認）。`::text` 比對改 `::uuid[]`，輸入在進服務前就驗證。
- **怎麼擋住**：
  1. ESLint（`eslint.config.js` 對 `src/routes/**` 加 `no-restricted-syntax`）：禁止 `z.string().uuid().parse(c.req.param(...))` 與直接把 `c.req.param(` 傳進 SQL 參數；
     或 guard test 的樣式比對。目前違規：類型 3 約 **16 處**、類型 4 **3 處**。
  2. guard test：`::text = ANY` 的檔案清單固定為現有 17 處（基線），只准減少；`id::text` 出現在 WHERE 比對時要求註解說明為什麼不能用 `uuid[]`。
- **嚴重度**：高。**工作量**：中（要決定壞 id 的狀態碼，補整合測試，把 17 處逐一改並確認呼叫端有驗證）。

---

## R6. 401 未登入的手寫回應

- **概念**：沒有 actor 就回 401。
- **各自的寫法**：`requireActor`（`spine/actor.ts:11`）丟 `UnauthorizedError`，由 `httpError.ts` 統一回 `{error:"unauthorized"}` 401，路由檔裡用了 114 次。
  手寫的：`routes/pointers.ts:24,76`、`routes/bookmark.ts:40,49`、`routes/me.ts:32,40`、`routes/events.ts:200`、`routes/mcp.ts:42`；
  `index.ts:226` 是 middleware，**可能是刻意**（還沒進路由），不算違規，加例外。
- **差異**：本文相同，行為一致；只是維護成本。另外 `routes/inbox.ts` 的 `reviewer()` 在 `requireActor` 之外再手寫 403（見 R4）。
- **建議的唯一入口**：`requireActor`。
- **怎麼擋住**：ESLint `no-restricted-syntax`：`src/routes/**` 內 `c.json({ error: "unauthorized" }, 401)`；例外 `index.ts`。目前違規 **8 處**（上面 8 個位置）。
- **嚴重度**：低。**工作量**：小。

---

## R7. 404／400 回應本文（承 B4，補現況數字）

- **概念**：同一類錯誤要有穩定的本文，前端靠它翻譯（`frontend/src/lib/serverErrors.ts`；其中 `:229` 以正規式 `/^[a-z][a-z ]* not found$/` 接住「X not found」類，另有 `not_found`、`note_not_found`、`parent_not_found`、`upload_not_found` 等代碼）。
- **各自的寫法（`c.json({error:…}, 404)` 共 75 處）**：
  - `"not found"` 24、`"not_found"` 19、`"tag not found"` 12、`"node not found"` 11、`"item not found"` 3、`"target not found"` 2、`"source not found"` 2，
    其餘各 1（`pointer`／`edge`／`parent`／`parent note`／`paper`／`token`／`upload_not_found`／`job_not_found`）。
  - **同一個檔案兩種拼法**：`routes/nodes.ts:444,447,453,456,462,464` 用 `"not_found"`，同檔 `:335` 用 `"node not found"`、`:341` 用 `"not found"`；
    `routes/tags.ts:264,278,286,292` 是 `"not_found"`，同檔其他處是 `"tag not found"`（11 處）。
  - 400 共 41 處手寫，其中一半是英文整句（`"days must be 1–90"`、`"id must be a positive integer"` ×9）、一半是 snake_case 代碼（`"invalid_pref"`、`"contains_nul"`），
    還有 `"bad cursor"`（`modules/rss/routes.ts:205`）、`"no file"`（`routes/media.ts:46`）。zod 失敗另走 `bad_request` ＋ issues（`httpError.ts:112`）。
  - 另有 410 ×1、413 ×1、422 ×1 也是手寫。
- **後果**：未知字串在前端落到通用訊息（`serverErrors.ts` 規則：未知代碼＝通用訊息），所以多數情況使用者看到的是「它已不存在」之類同一句；
  但英文整句的 400 不在翻譯表，使用者拿到的是通用錯誤，沒有「days 要 1–90」這種有用訊息。
- **建議的唯一入口**：`statusError.ts` 的 `StatusError`／`CodedStatusError`（已有）；`CodedStatusError` 目前只允許 400／404／409，要補 403／410／413／422。
  先做「本文不變」的機械替換，再談統一拼法。
- **怎麼擋住**：guard test：`src/routes/**`、`src/modules/**/routes.ts` 內 `c.json({ error: "<字串>" }, 4xx)` 的 `<字串>` 必須在白名單（`routes/errorBodies.json`）；
  目前 404 的 15 種拼法＋400 的 41 種文字就是基線，只准減少、新增要在 PR 說明寫為什麼。
- **嚴重度**：中。**工作量**：中（本文是契約，前端翻譯要同步）。

---

## R8. 請求 body 解析：壞 JSON 要不要當空物件

- **概念**：`c.req.json()` 遇到空 body 或壞 JSON 會丟 `SyntaxError`（`httpError.ts:115-117` 轉成 400 `malformed JSON body`）。
- **各自的寫法**：
  - 直接 `parse(await c.req.json())`，壞 JSON → 400：34 處（例如 `routes/tags.ts:304`、`routes/spaces.ts:126`、`routes/workspace.ts:79`）。
  - `.catch(() => ({}))` 然後 `parse`，**壞 JSON 被當成空物件**：34 處（`routes/history.ts:98,145,155,162,167`、`routes/spaces.ts:77,102`、
    `routes/nodes.ts:108,189,216,228`、`routes/events.ts:370`、`modules/tasks/routes.ts:48,56,62,73,81`、`modules/rss/routes.ts:94,126,142,249,260,286,313,359`、
    `modules/website/routes.ts:69,89,113` 等）。
  - `.catch(() => null)`：`routes/inbox.ts:353`、`routes/bookmark.ts:41`、`routes/tags.ts:214`、`modules/review/routes.ts:86,93`。
  - `try { body = await c.req.json(); } catch { /* … */ }`：`routes/sync.ts:38,83,101,116`。
- **差異與可能的後果**：當 schema 的欄位都有預設時，壞 JSON（網路截斷的 body）會被當成「用預設值執行」：
  例如 `routes/spaces.ts:102`（`permission` 預設 `"view"`）、`routes/nodes.ts:108`（promote 的 `id` 可省略）。
  schema 有必填欄位時結果是 400，但訊息是 zod 的 `bad_request`，不是 `malformed JSON body`。
  網路中斷造成的截斷 body 與「刻意不送 body」不能區分——這是實際的語意問題，不只是風格。
- **建議的唯一入口**：`routes/params.ts` 加 `readJson(c, { optional: true })`：
  沒有 body（`content-length: 0`）才回 `{}`，有 body 但壞 JSON 一律 400。`sync.ts` 的四處寫法是刻意寬鬆，保留成明確選項並註明。
- **怎麼擋住**：ESLint `no-restricted-syntax`：`src/routes/**`、`src/modules/**/routes.ts` 內 `.json().catch(`，例外名單放 `sync.ts`。目前違規 **34 處**。
- **嚴重度**：中。**工作量**：小到中（機械替換，但每個路由要驗證「刻意不送 body」的情況，前端是否真的會送空 body）。

---

## R9. 背景工作排程

- **概念**：定期執行的工作（清理、掃描、重試）。
- **各自的寫法**：

  | 位置 | 做什麼 | 首次執行 | 錯誤處理 | 多實例互斥 | `unref` |
  | --- | --- | --- | --- | --- | --- |
  | `index.ts:403` | `pruneEvents`（實驗） | 立即 | `void`，函式內處理 | 無 | 否 |
  | `index.ts:420` | `pruneIdempotencyKeys` | 立即 | try/catch＋`log.error` | 無（單純 `DELETE`，重複無害） | 否 |
  | `index.ts:432` | `sweepAgentSessions` | 立即 | try/catch＋`log.error` | 無 | 否 |
  | `modules/tasks/scheduler.ts:198-203` | 任務滾動 | 15 秒後 | `.catch(log.error)` | **有**（`pg_try_advisory_lock` 自己的鍵 `4_242_044_044`，`:175`） | 否 |
  | `modules/rss/fetch.ts:310` | 到期抓取＋保留掃描 | **沒有**（等一個間隔） | `console.error`（沒走 `logger.ts`） | **無** | 否 |
  | `services/dispatcherQueue.ts:404` | 補跑 | 立即 | `.catch(log.error)` | 無（靠寬限時間） | 否 |
  | `services/outbox.ts:923,930` | drain／reap | 立即（armed） | drain 自己處理；reap `.catch` | **有**（`:568` 另一個 advisory lock） | 否 |
  | `services/workspaceTime.ts:52` | 時鐘重載 | 否 | 函式內 try/catch | 無 | **是** |

  - 互斥有兩套自己的 advisory lock 實作（`scheduler.ts:175-187`、`outbox.ts:568`）；其他都沒有。
  - `modules/rss/fetch.ts:310` 在多實例時每個實例各抓一次（讀碼推斷；`enqueueRssFetch` 是否去重沒有逐行確認，要查 outbox 冪等鍵），
    且它是唯一沒有 `log` 的排程。
  - 只有 `workspaceTime` 做了 `.unref()`，其他的 `setInterval` 會阻止進程自然結束（測試與 `admin.ts` 腳本載入這些模組時要小心）。
- **建議的唯一入口**：新增 `backgroundJobs.ts` `startPeriodicJob({ name, everyMs, runFirstAfterMs?, exclusive?: boolean }, run)`：
  統一做 try/catch＋`log.error(name, …)`、`unref()`、可選的 advisory-lock 互斥（把 `scheduler.ts:175-187` 抽成通用版，鍵由 `hashtext(name)` 推導）。
  `outbox` 的 drain 有「instant kick」語意，先不併，只把互斥與錯誤處理遷過去。
- **怎麼擋住**：guard test：`setInterval(` 只准出現在 `backgroundJobs.ts`；目前違規 **8 處（7 個檔）**，基線固定；`setTimeout` 不納入（大多是逾時，不是排程）。
- **嚴重度**：中（RSS 重複抓取為推斷，未實測）。**工作量**：中（每個排程要確認第一次執行時機與互斥需求）。

---

## R10. 錯誤類別形狀（承 B5，現況）

- **概念**：「訊息＋狀態碼（＋代碼）」的錯誤類別。
- **現況**：`class … extends Error` 共 63 個；`httpError.ts:57-105` 有約 35 個 `instanceof` 分支，各自決定本文：
  `{error: message}`（`NodeUpdateError`、`AgentRunError`、`TagMembershipError`、`TagModuleError`、`ModuleLibraryError`）、
  `{error: code, detail: message}`（`AgentSessionError`、`ParentKindError`、`NoteSizeError`、`SpaceMoveError`、`ChromeStale`、`DerivedEdgeError`…）、
  `{error: code}`（`RewindError`、`InviteError`、`BackupRestoreRefusal`）、直接 `err.body`（`TagMergeError`、`ReservedTagError`）。
  參數順序也不同：`NodeUpdateError(message, status)` 對 `StatusError(status, message)`。
  真正繼承 `StatusError`／`CodedStatusError` 的只有 `review/service.ts:47`（`ReviewError`）與 `website/publishing/snapshot.ts:57`（`PublishPreviewStale`）。
- **建議的唯一入口與擋法**：同 B5（繼承 `StatusError`／`CodedStatusError`，各類別保留名稱與 `instanceof`）。
  guard test：`httpError.ts` 的 `instanceof` 分支數有上限（現在約 35，只准減少）；新的 `extends Error` 且名稱含 `Error|Refusal` 的類別必須在例外名單。
  目前違規約 **60 個**類別——不要一次全遷，先固定基線。
- **嚴重度**：低。**工作量**：中到大（逐類保留本文）。

---

## R11. 路由內直接 `pool.query`（承 B2，現況）

- **概念**：路由應只做解析、呼叫服務、回應；SQL 在服務層。
- **現況**：`routes/*.ts` 共 24 處 `pool.query`（`canvases.ts` 2、`edges.ts` 1、`events.ts` 2、`inbox.ts` 3、`nodes.ts` 5、`tags.ts` 9、`versions.ts` 1）＋
  `modules/rss/routes.ts:211`、`modules/website/routes.ts:154`。`tags.ts:330-411` 是 `delete-preview`（約 90 行，7 次查詢）。
  已有的 `eslint-rules/no-route-writes.js` 只擋**寫入**，讀取不擋。
- **差異與風險**：
  - `routes/edges.ts:55-60` 與 `routes/pointers.ts:74-80` 先 `SELECT` 再呼叫 mutator，兩次之間有空窗（承 B2）。
  - 讀取端的「看不到＝不存在」靠路由自己先 `canReadNode`；同一規則在服務層才有 `require-read-gate`（`eslint-rules/require-read-gate.js`）保護。
- **建議的唯一入口**：同 B2（服務層）。
- **怎麼擋住**：把 `no-route-writes` 擴成 `no-route-sql`（讀寫都擋），例外名單檔 `eslint-rules/route-sql-allowlist.json` 寫入現有 26 處，只准減少。
- **嚴重度**：中。**工作量**：中。

---

## R12. 「這批 id 裡我讀得到哪些」

- **概念**：給一組 id，回傳操作者讀得到的子集。
- **各自的寫法**：
  1. `services/boardStore.ts:192` `readableAmong`：`readableScopeSql` ＋ `n.id = ANY($2::uuid[])`，**只算活的**。
  2. `services/history/rewind.ts:215` `readableNotes`：`readableNotesSql(… includeTrashed: true)` ＋ `n.id::text = ANY(…)`，**活的＋垃圾桶**。
  3. `services/history/agentRuns.ts:107`：另一份 `readableSql` 組合，同樣 `::text`。
  4. 先取整個可讀集合再在 JS 過濾：`services/harness/scope.ts:56` `aiReadable`（還多一次 `pool.query` 取全部系統節點，不經 `q()`；
     同檔 `:104` 在 `pool.query` 裡直接帶 `id = ANY($4::uuid[])`）、`services/tasksStore.ts:221` `taskRowReadable`、`services/sync/rows.ts:44` `readablePointer`。
  5. 逐筆 `canReadNode`／`canSeeTag`：`routes/nodes.ts:335`、`services/tagMerge.ts:48`。
- **差異**：垃圾桶是否計入、`::text` 與 `::uuid` 的選擇、系統節點是否排除（`NOT_SYSTEM_NODE_SQL` 只有 `harness/scope.ts`、`embeddings.ts`、`nodeSearch.ts` 用，其他集合查詢不排除）各不相同。
  `AGENTS.md` 說讀取走 `services/readPolicy.ts` 並含集合查詢的 SQL 範圍；現況是核心判斷在 `readPolicy`，但「在一批 id 內」這個包裝有 3 份。
- **建議的唯一入口**：`readPolicy.ts` 加 `readableAmong(actor, ws, ids, { includeTrashed })`；`boardStore.readableAmong`、`rewind.readableNotes`、`agentRuns` 內那份改用。
  屬權限讀取，需新舊並行對照測試（逐筆與集合），**列出但不建議這一輪動手**。
- **怎麼擋住**：guard test：`services/` 內函式名稱符合 `readable\w*(Among|Notes|Ids)` 且不在 `readPolicy.ts` 者，必須在例外名單；現況 **4 處**（上面 1–3 與 `readableNotesSql`）。
- **嚴重度**：中。**工作量**：中（權限相關，須驗證允許／拒絕）。

---

## R13. 設定讀取（`process.env`）

- **概念**：環境設定在啟動時一次讀成有型別的設定物件。
- **現況**：`process.env` 出現在 17 個非測試檔、28 個不同的鍵（`index.ts` 12 處、`auth.ts` 5、`db.ts` 4、`services/githubBackup.ts` 4、`modules/website/publishing/githubPages.ts` 4 …）。
  沒有 `config.ts`。轉型與預設各自寫：
  - `db.ts:37,39,44`：`Number(process.env.X ?? 15_000)`——環境值若是 `"abc"` 會得到 `NaN`，傳給 pg 的 `max`／逾時。
  - `services/sync/bootstrap.ts:45`：`Number(process.env.BOOTSTRAP_NODE_LIMIT) || 5000`——壞值退回預設。
  - `index.ts:374`：`Number(process.env.PORT ?? 8787)`——`NaN` 的行為同 `db.ts`。
  - 布林與列舉各自比字串：`=== "on"`（`EVENT_PRUNE_EXPERIMENTAL`，`index.ts:399`）、`=== "pg"`（`RATE_LIMIT_BACKEND`，`:428`）、`=== "*"`（`CORS_ORIGIN`）、
    另有 `NODE_ENV` 12 次比對。
  - GitHub 備份與 Pages 兩組設定各自讀（`githubBackup.ts` 與 `githubPages.ts`，鍵名前綴不同、讀法不同）。
  - `logger.ts` 每次呼叫都讀 `LOG_LEVEL`／`LOG_FORMAT`（有註解說明是刻意的：測試會中途切換）。
- **建議的唯一入口**：新增 `config.ts`：`env.int("PG_POOL_MAX", 20)`、`env.flag("…")`、`env.oneOf(…)`，壞值丟啟動錯誤（或退回預設並 `log.warn`，二選一要決定）；
  `NODE_ENV` 以 `isTest` 匯出。`logger.ts` 的每次讀取保留為例外。
- **怎麼擋住**：ESLint `no-restricted-properties`（`object: "process", property: "env"`），例外檔：`config.ts`、`logger.ts`（`eslint.config.js` 逐檔 override）。
  目前違規：17 個檔（約 40 處讀取）。基線只准減少。
- **嚴重度**：低到中（`NaN` 為讀碼推斷，未實測）。**工作量**：中。

---

## R14. 日誌

- **概念**：`logger.ts` 是結構化日誌的唯一入口（`log.error(tag, msg, {err})`，有 `LOG_LEVEL`／`LOG_FORMAT=json`）。
- **現況**：還在直接用 `console.*` 的非測試檔：`modules/rss/fetch.ts`（2 處，含 `:313` 排程錯誤）、`services/githubBackup.ts`（2）、`services/realtime.ts`（1）、
  `modules/website/publishing/siteBundle.ts`（1）、`spine/txHooks.ts`（1）、`routes/edges.ts`（1）、`httpError.ts`（`[unhandled]`，1）、`index.ts`（1）、`admin.ts`（3，CLI 腳本，可能是刻意）。
  這些在 `LOG_FORMAT=json` 時會變成非 JSON 行，混進日誌收集器；也不受 `LOG_LEVEL` 控制。
- **建議的唯一入口**：`logger.ts`。
- **怎麼擋住**：ESLint `no-console`，例外：`logger.ts`、`admin.ts`（CLI 輸出）。目前違規 **約 10 處（7 個檔）**。
- **嚴重度**：低。**工作量**：小。

---

## R15. 查詢參數文法（承 B13，補現況）

- **概念**：整數、游標、時間點與旗標參數的解析。
- **各自的寫法**：
  - 整數：`routes/history.ts:19-23` `countParam`（`Number()`＋`isInteger`＋範圍，壞值 400）、
    `routes/mcpSessions.ts:45`（`parseInt` 加夾限，壞值當 0）、`routes/sync.ts:27-30`（`parseInt`，`NaN`→0，且 `parseInt("12abc")` 得 12）、
    `services/paging.ts` `parsePage`（zod，壞值 400）、`services/collectionViewQuery.ts:145`（`Math.min(Math.max(Math.floor(…)))`，夾限）、
    `services/sync/membership.ts:131`。同樣是「limit」，壞輸入的結果在 400、夾限、預設值之間不一致。
  - 時間點：`routes/inbox.ts:243-246`（`Date.parse`，最寬）、`routes/history.ts:38,50,58`（`YYYY-MM-DD`）、`routes/day.ts:18`。
  - 旗標：`=== "1"`（`routes/nodes.ts:63,260`）、`=== "none"`（`routes/bootstrap.ts:17,18`）、`=== "en"`（`routes/export.ts:18`）。
- **建議的唯一入口與擋法**：`services/paging.ts` 加 `parseCount`；旗標統一 `parseFlag(raw)`。guard test：`routes/` 內 `parseInt(c.req.query(`／`Number(c.req.query(` 禁止，
  目前違規 **約 4 處**（`mcpSessions.ts:45`、`sync.ts:27`、`history.ts:21` 的 `countParam` 內、`actors.ts:43` 傳進服務再解析）。
  時間點文法統一會拒絕目前通過的輸入，屬行為變更，不建議順手改。
- **嚴重度**：中。**工作量**：小。

---

## 其他已確認「承 Bn」的現況變化（不另開條）

- **B1（媒體引用 SQL）**：三處仍在（`services/mediaOwners.ts`、`services/purgedContent.ts:122`、`services/backupRestore.ts`），本輪沒有新增證據。
- **B6（標籤名稱 NFC）**：`lower(title)` 無 NFC 的位置仍在：`services/harness/noteSkills.ts:113`、`services/workspaceModules.ts:229,231`；
  其他地方有做 `normalize("NFC")`。沒有改變。
- **B9（HTML 轉文字）**：仍三份：`modules/rss/sanitize.ts:119`、`services/harness/scope.ts:269-274`、`services/pageMeta.ts:28`；
  另外 `modules/citations/crossref.ts:92` 又有一份 `replace(/<[^>]+>/g, " ")`（上輪沒列）。實體解碼仍兩份：`@onden/markdown` `decodeHtmlEntities` 與 `modules/rss/htmlToMarkdown.ts:25` `decodeEntities`。
- **B14（小工具）**：`iso(d)` 現在是**四份**：`modules/rss/subscriptions.ts:254`、`modules/rss/sources.ts:80`、`modules/website/publishing/siteDiff.ts:49`、
  `services/history/noteVersions.ts:92`（上輪列三份）；批次迴圈 `for (… += BATCH)` 仍在 `backupRestore.ts` 6 處＋`exportZip.ts:379`，沒有 `chunk()`。
- **B7、B10**：本輪未動，也沒有新證據。

## 檢查過、不算重複（避免重報）

- Markdown 處理：`utils.ts` 的 `extractWikilinks`、`extractAttributes`、`extractFrontmatterAttributes` 已全部委派給 `@onden/markdown`
  （`wikilinkBodies`、`attributeLines`、`readFrontmatter`）；`utils.ts:118` 註解提到的 `modules/importers/routes.ts` 的 `parseFrontmatter` 已不存在。
  `eslint.config.js` 也已用 `no-restricted-imports` 擋掉自己引入 `unified`／`remark` 等。
- slug：後端只用 `@onden/markdown` 的 `slugify`；`services/nodes.ts` 是唯一的唯一化層。
- id 產生：`randomUUID` 散在約 25 檔，但全是「產生一個新 id」，沒有第二種格式；`randomBytes` 的用途（token、檔名、區塊 id）各不相同，不合併。
- 時間：後端沒有 `toISOString().slice(0,10)` 式的「今天」計算（唯一一處是 `siteRows.ts:51`，上輪已列）；日界一律走 `localDay.ts`。
- 外部抓取：`services/safeFetch.ts` 是唯一入口；`modules/website/publishing/staticSite.ts:166` 的 `fetch` 打的是內部 SSR（`SITE_SSR_URL`），有自己的 `AbortSignal.timeout`，不需合併。
- 冪等鍵：只有 `index.ts:259` 一處讀 `idempotency-key` header，驗證為 UUID；沒有第二種入口。
- `{ ok: true }`／`{ deleted: true }` 成功回應（15 處）形狀不一，但前端沒有依賴它們的欄位；不列為問題。

---

## 建議的守門總設計

**原則**：能用語法樹判斷的放 ESLint（編輯器即時、不用等 vitest）；需要跨檔語意或「檔案清單」的放 guard test；
所有「目前有 N 處違規」的規則都用**基線＋只准減少**，不是一次清零。

### 放 ESLint（`packages/backend/eslint.config.js`，`src/routes/**` 與全域）

| 規則 | 對應 | 目前違規 | 例外 |
| --- | --- | --- | --- |
| `no-restricted-syntax`：`c.json({ error: "unauthorized" }, 401)` | R6 | 8 | `index.ts` |
| `no-restricted-syntax`：路由內 `.json().catch(` | R8 | 34 | `routes/sync.ts` |
| `no-restricted-syntax`：路由內 `z.string().uuid().parse(c.req.param(` | R5 | 約 16 | 無（遷到 `uuidParam`） |
| `no-restricted-properties`：`process.env` | R13 | 17 檔 | `config.ts`、`logger.ts` |
| `no-console` | R14 | 約 10 | `logger.ts`、`admin.ts` |
| 擴充 `onden/no-route-writes` → 也擋讀取 SQL | R11 | 26 | 例外檔案清單 JSON |
| （選用）`@typescript-eslint/no-misused-promises` | R1 | 1 | 需型別資訊，先不開 |

ESLint 的例外與基線放 `packages/backend/eslint-rules/*-allowlist.json`（沿用 `module-entry-allowlist.json` 的做法）。

### 放 guard test（`packages/backend/src/test/guards/dupSweep.guard.test.ts` 或新檔 `dupPatterns.guard.test.ts`，沿用其 `files`／`outside()` 掃檔）

| 規則 | 對應 | 目前違規 |
| --- | --- | --- |
| 沒有 `await` 的 async 權限述詞 | R1 | 1 |
| `ILIKE`／`LIKE` 檔案必須 import `escapeLike` | R2 | 1 檔（2 處） |
| `Content-Disposition` 只在 `downloadHeaders.ts` | R3 | 4 |
| `.tokenScope` 後接 `throw` 的位置 ＝ 白名單 | R4 | 約 10 |
| `::text = ANY` 的檔案清單 ＝ 基線 | R5 | 17 |
| 404／400 本文字串 ＝ 白名單 | R7 | 15 種 404＋41 種 400 |
| `setInterval(` 只在 `backgroundJobs.ts` | R9 | 8 |
| `httpError.ts` 的 `instanceof` 分支數 ≤ 基線 | R10 | 約 35 |
| `readable*Among/Notes/Ids` 函式只在 `readPolicy.ts` | R12 | 4 |
| `parseInt(c.req.query(`、`Number(c.req.query(` 禁止 | R15 | 約 4 |

### 例外名單怎麼管

1. 每條規則一份 JSON（`{ file, count, reason }`），**放在規則旁邊**，不寫在測試內文。`reason` 必填，空字串視為失敗。
2. 只准減少：測試比對「實際違規數 ≤ 名單數」，且名單數 > 實際數時也失敗，逼人把名單降下來（跟 `dup:baseline`、`dup:names:baseline` 同一種「變少時要更新基線」的做法）。
3. 例外要寫「為什麼不能用唯一入口」，不是「還沒改」；「還沒改」只准出現在基線檔，並附 `docs/research/` 的對應條號（例如 `R5`）。
4. 新規則與它的收斂寫在同一個 PR（AGENTS.md「收斂一處重複時，同一個 PR 加守門測試」）；
   若一次收不完，PR 先加規則與基線（違規數＝現況），之後每批 PR 降低基線。
5. 這份報告的條號（R1…R15）寫進守門失敗訊息，開發者一看就知道去哪裡找原因與唯一入口。

### 建議的收斂順序

1. **R1**（補一個 `await`＋1 條 guard）、**R2**（`escapeLike`）、**R3**（`downloadHeaders`）——各自獨立，可同一天做完，使用者可見的錯誤先消。
2. **R6**、**R14**、**R8**——機械替換，ESLint 規則一次到位。
3. **R5**（先決定壞 id 的狀態碼，與前端對過）、**R15**。
4. **R9**、**R13**——需要設計小契約（兩種草圖：`startPeriodicJob` 的選項式與包裝式、`env.int` 壞值要不要拋錯），依 AGENTS.md 先比較再實作。
5. **R4**、**R12**、**R7**、**R10**、**R11**——牽涉權限或前端契約，先寫新舊對照測試或與前端確認再做。
