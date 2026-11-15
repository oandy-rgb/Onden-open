# 提案：自動保存不再重複上傳整篇基準內文（perf F5）

> 狀態：已被取代（by docs/architecture/patch-writes.md）（最後確認 2026-11-01）

狀態：**設計提案，尚未實作。** 本文只描述現況、比較方案並給出建議；沒有修改任何產品程式。
來源問題：[perf-logged-in-2026-10-21.md 的 F5](../research/perf-logged-in-2026-10-21.md)
（50k 字筆記在 3 Mbps 手機上行下，一次保存 0.93 秒）。
引用格式 `路徑:行號` 以 `ce6e6ae`（main）為準。

## 1. 問題與現況

### 1.1 現在送什麼

- 編輯器每次保存呼叫 `writer.patch(id, {title, markdown}, {baseMarkdown})`
  （`packages/frontend/src/lib/data/draftActions.ts:212-215`）。
- `noteWriter.change` 把 `{...changes, cursor_state, base_markdown}` 序列化成 PATCH body
  （`packages/frontend/src/lib/data/noteWriter.ts:182`）。`markdown` 與 `base_markdown` 各是**整篇**。
- `base_markdown` 的意思是「這份草稿所根據的伺服器文字」，不是 store 目前的列
  （`draftActions.ts:41-52`）。它在送出時才讀，因為前一次保存結果會成為下一次的基準（`draftActions.ts:203-206`）。
- 其他送 base 的入口：手動儲存 `draftActions.ts:333`、`saveNoteBody` `draftActions.ts:407`、
  `useOverviewMode.ts:82`、結構操作 `noteStructure.ts:61`（`rewriteBody`）、
  agent 工具 `agentTools/updateNode.ts:20-29`（`markdown` 必須附 `base_markdown`）。
- 路由 `PATCH /:id` 讀 `rawBody.base_markdown`（`packages/backend/src/routes/nodes.ts:151`），
  轉交 `updateNode(...,{baseMarkdown})`（`packages/backend/src/services/nodeUpdate.ts:62-81`）。

### 1.2 伺服器怎麼用它

全部在 `saveNodeChange` 的事件交易內（`nodeUpdate.ts:174-`）：

1. 取工作區事件鎖、`resolveCurrentActor`（:177）、`SELECT … FOR UPDATE` 讀目前列（:178-181）、
   `assertAuthority(write_node)`（:184）。
2. `oldBody` = 鎖內讀到的目前正文（:231）。只有
   `oldBody !== base && oldBody !== newBody && base !== newBody` 才三方合併（:241-248）；
   **base 等於目前正文時完全不合併、base 的內容也沒被讀**。
3. `threeWayMergeBody(base, incoming, current)`（`services/eventLog/bodyMerge.ts:114`）是逐行 diff3；
   重疊行保留這次寫入者的版本，另一方文字進 `BODY_CONFLICT`（`nodeUpdate.ts:337-348`）。
4. 「有沒有送 base」本身是語意：`addBlockIds = writeBlockIds ?? baseMarkdown === undefined`
   （:255）——沒送 base 的寫入者會被伺服器補 `^id`，編輯器自己已補過，所以不能被補。
5. `await claim()` 在 :287，之後才 `putBlob(newBody)`（:288）與 `mutate`。
   所有可能因 base 而拒絕的判斷必須放在 `claim()` 之前，才不會消耗冪等鍵。

### 1.3 離線佇列、冪等與重試

- `submitWrite` 為每個寫入配一個 `Idempotency-Key`（`writeQueue.ts:67-68`），直送失敗（網路/401/5xx）就
  `enqueue` 同一把鍵（:101）。**佇列列保存的是完整 `{method,path,body,idem_key}`**
  （`localDbWorker.ts:925` 的 `pending_writes`），重播在 `drain` 原樣送出（`writeQueue.ts:138-142`）。
- 永久拒絕（含任何 409）→ `preserveDirectRejection`／`preserveRejectedWrite`，保存原 body 供使用者複製，不自動重送
  （`writeQueue.ts:93-96`、`:146-153`；`docs/architecture/note-writes.md`「離線重送遭拒絕」）。
- 冪等鍵只看鍵，不看 body：`withIdempotencyClaim` 在 `claim()` 時 `INSERT idempotency_keys … ON CONFLICT DO NOTHING`，
  已存在就丟 `IdempotentReplay`，HTTP 邊界回 `200 {deduped:true}`（`spine/idempotency.ts:56-67`、`httpError.ts:59`）。
  交易回滾會讓記憶體 claim 失效（:64-65）。所以**同一把鍵、換一份 body 重送**是安全的，前提是第一次沒提交。
- 沒有名為「write journal」的模組。最接近的是 `writeLifecycle.ts` 的 `rememberUnconfirmedWrite`
  （pagehide 退出副本，`writeQueue.ts:72`）與 `writeRecovery.ts`；它們也存完整請求。若指的是別的東西請告知。

### 1.4 伺服器已經保存所有 base 嗎？

大致是，而且是不可變的：

- 每次 `NODE_UPDATED`/`NODE_RESTORED`/`NODE_CREATED` 把新正文 `putBlob` 成內容定址的 `blobs`
  （`hash = sha256(UTF-8 全文)`，`services/blobs.ts:30-38`；表 `blobs(hash PK, content, size_bytes, created_at)`，
  `db/migrations/030_blob_layer.sql:26-31`、`db/schema.sql:344`），事件 `payload.body_hash` 指向它
  （`nodeUpdate.ts:288`；事件 payload 於 :304）。連只改標題的保存也會記 `body_hash`（只有 `sort_order` 例外，:227 的 `positionOnly`）。
- 帶 `body_hash` 的事件**不可刪除**（`db/schema.sql:211-219` trigger）；事件修剪明確排除它們
  （`db.ts:297-317` 的 `pruneEvents`，條件含 `NOT (e.payload ? 'body_hash')`）。
  blob 只在沒有事件引用且超過 1 天才被 GC（`prune.ts:25-40`）。
- 例外（會讓「查歷史」找不到）：永久刪除筆記時事件被紅線化成 `{"purged":true}`（`schema.sql:182-196`）；
  不經 `putBlob` 的直接 SQL 寫入；以及**客戶端自己的基準從未被伺服器看過**（離線佇列中、被伺服器合併過的前一筆，見 §3.2）。
  這些都必須有「找不到」的正常路徑，不能假設歷史必有。
- 歷史查詢的現成樣式：`restoreNodeVersion` 用 `domain_events e JOIN blobs b ON b.hash = e.payload->>'body_hash'`
  並限定 `target_id`＋`workspace_id`（`nodeUpdate.ts:122-128`），且在寫入授權之後才查（:119-121 註解）。
  索引為 `domain_events_target_idx (target_type,target_id,created_at DESC)`（`schema.sql:1187`）；
  沒有 `payload->>'body_hash'` 的索引，所以查找會掃該筆記的事件（見風險）。

### 1.5 位元組帳（估算，非新量測）

50,067 字中文，UTF-8 約 3 B/字 → 每份約 150 KB，JSON 不轉義中文。
現在 PATCH ≈ `markdown` 150 KB + `base_markdown` 150 KB ≈ **300 KB**。3 Mbps ≈ 375 KB/s，光上傳 ≈ 0.8 s，與量測的 0.93 s 一致。
nginx 的 gzip 只壓回應，請求 body 沒有壓縮（`docker/nginx/nginx.conf:12-16`）。

> 重要：F5 預期「降到約 0.2–0.3 s」。**只去掉 base 做不到**：剩 150 KB ≈ 0.4 s 上傳加 RTT 約 0.5 s。
> 要到 0.2 s 級，`markdown` 本身也要縮成差異（方案 B）。

## 2. 方案

共通的新概念：**基準以內容雜湊識別**，`base_hash = sha256(base 的 UTF-8)`，與 `blobs.hash` 同一算法。
比較過 `updated_at`、`revision`、事件 id 後不選它們：

| 候選識別 | 問題 |
| --- | --- |
| `updated_at` | 只改標題也會變（`nodeUpdate.ts` 的 UPDATE 除 `positionOnly` 外一律 `updated_at = now()`），且不對應任何已保存的正文；客戶端手上的基準可能是合併結果 |
| 事件 id（`domain_events.id`） | 準確，但 PATCH 回應目前只回 node（`routes/nodes.ts:152`），sync/bootstrap 的 node 也不帶；離線佇列中的基準根本沒有事件 id |
| 雜湊 | 客戶端可由手上基準文字自行算出，不依賴回應欄位；內容定址，自帶驗證；與 `blobs`、冪等重送天然相容 |

雜湊的代價：客戶端要算 SHA-256。`crypto.subtle` 只在安全來源（HTTPS／localhost）存在；區網 `http://` 沒有。
這時不能瞞著降級，而是**直接送完整 base（現況）**，行為不變。

### 方案 A：送 `base_hash`，找不到才補送完整 base

**請求**（新增欄位，其他不變）：

```jsonc
PATCH /api/nodes/:id        Idempotency-Key: <uuid>
{ "title": "…", "markdown": "<150KB>", "base_hash": "<64 hex>", "cursor_state": {…} }
```

`base_hash` 與 `base_markdown` 同時出現時以 `base_markdown` 為準（舊客戶端/補送）。

**伺服器**（`nodeUpdate.ts` 在 `plan()` 之後、`claim()` 之前解析 base）：

1. `sha256(oldBody) === base_hash` → base 就是目前正文，**不查任何東西、不合併**（等同現在 `oldBody === base` 的路徑；
   單裝置單人的絕大多數情況）。這就是方案 C 的一部分。
2. 否則在**同一筆記的歷史**查：`blobs b WHERE b.hash=$1 AND EXISTS(該 workspace/target 的 domain_events payload->>'body_hash' = b.hash)`。
   限定節點很重要：`blobs` 是全域內容定址，不限定的話任何知道雜湊的人都能拿別篇筆記當 base，
   靠合併輸出推測其行內容。限定後能力等同 `restoreNodeVersion`（先 `write_node` 授權，`nodeUpdate.ts:184`）。
3. 查不到 → `NodeUpdateError("base_unknown", 409)`，經 `httpError.ts:71` 變 `409 {error:"base_unknown"}`。
   **拋在 `claim()` 之前**，不留鍵、不寫事件（`nodeUpdate.ts:287` 之前）。
4. 解析出的文字當 `baseMarkdown`；內部另記 `baseSent = true`，`addBlockIds` 與 :255 的語意維持。
   之後 merge、`BODY_CONFLICT`、事件、索引全部不變。

**回應**：node 照舊；建議加 `body_hash`（= 存下的正文的雜湊，伺服器本來就算過，`nodeUpdate.ts:288`）。
用途是客戶端的能力探測（§5），不是必須的基準來源——客戶端可自己算。

**客戶端**：

- 新模組 `noteBaseWire`（暫名，歸筆記寫入擁有）：`slim(request)`、`isBaseUnknown(error)`。
  只有它理解 `PATCH /api/nodes/:id` 的 body 格式——`writeQueue.ts` 是通用層，不該自己認得筆記欄位（AGENTS.md「離線格式由其擁有者處理」）。
- **耐久形式不變**：`pending_writes.body`、`rememberUnconfirmedWrite`、拒絕/復原副本全部仍存完整
  `markdown`＋`base_markdown`。瘦身只發生在「這一次線上送出」的傳輸層，直送（`writeQueue.ts:77-98`）與
  `drain`（`:138-142`）共用一個 `transmit()` 做：算雜湊 → 送瘦版 → 若 `base_unknown` 就用**同一把鍵**送原版。
  `base_unknown` 在 `classifyWriteFailure` 之前處理，**絕不能**落進「其他 HTTP 拒絕」而被存成不可重播的復原輸入。
- 效果：位元組 150 KB（只剩 `markdown`）＋64 B。

**離線佇列**：佇列/復原格式沒改，所以舊版 queue 資料、備份還原、帳號分區完全不受影響。
重播第 n 筆時，其 base 若是客戶端自己的合併前文字（上一筆被伺服器合併過，見 §3.2）→ `base_unknown` → 自動補送本機仍留著的完整 base → 與今天行為一致。

**舊客戶端**：照送 `base_markdown`，路徑不變。**新客戶端 ＋ 舊伺服器**：見 §5，危險，需要能力探測。

**伺服器儲存**：不需新表。`blobs`＋帶 `body_hash` 的事件已是完整歷史（§1.4）。

**失敗模式**：

| 情況 | 結果 |
| --- | --- |
| base 是自己的合併前文字／永久刪除過的歷史／直接 SQL 改過的正文 | `409 base_unknown` → 多一次往返，補送完整 base，結果同今天 |
| 回應遺失、同鍵重送 | base 解析在 `claim()` 之前：base 若仍可解析→走到 `claim()` 得 `200 {deduped:true}`；不可解析→409 → 補送 → 仍得 deduped。多一次往返，不重複寫 |
| 不安全來源無 `crypto.subtle` | 不瘦身，行為同現況 |
| 歷史很長的筆記 | 非目前版本的查找掃該筆記事件的 jsonb；需量測，必要時加表達式索引 |
| 客戶端雜湊算法差異（孤立 surrogate） | `TextEncoder` 與 Node `update(str,'utf8')` 都轉成 U+FFFD，一致；不一致時只退化成 `base_unknown`，不會錯誤合併 |

**預期**：位元組 300 → ≈150 KB；3 Mbps 上行約 0.93 → **約 0.5 s**（估算）。短筆記幾乎無差別。
另一個副作用：pagehide 的 `keepalive` fetch 受瀏覽器約 64 KiB 的 body 配額限制（規格行為，需實測確認），
目前 300 KB 的長筆記退出保存走不了 keepalive（`noteWriter.ts:183`、`writeQueue.ts:72` 的備援是 localStorage 復原）。A 把它降到 150 KB，仍超過；B 才可能放進 64 KiB。

**改動規模**：後端 2 檔（`routes/nodes.ts` 傳 `base_hash`、`services/nodeUpdate.ts` 解析 base）＋新增小 helper；
前端 3 檔（新 `noteBaseWire`、`writeQueue.ts` 的 `transmit`、`noteWriter.ts` 傳遞 base 雜湊所需資料）；文件 `note-writes.md`。

### 方案 B：送差異（patch），可選搭配 base 雜湊

只送 patch **不能**單獨成立：伺服器必須有確切的 base 才能套 patch 並重建 `markdown`。所以 B 實際是「A ＋ 把 `markdown` 換成相對 base 的差異」。

**請求**：

```jsonc
{ "title": "…", "base_hash": "<64 hex>",
  "markdown_patch": { "from": 41230, "delete": 12, "insert": "新的字" },   // 單一區段取代
  "markdown_hash": "<64 hex>" }                                           // 套用後的完整性檢查
```

**差異格式的選擇**：

| 格式 | 優點 | 缺點 |
| --- | --- | --- |
| diff-match-patch（後端已用，`bodyPatch.ts`、`backend/package.json:25`） | 現成、多區段 | 前端沒有此依賴（+~20 KB）；套用是模糊比對（`bodyPatch.ts` 檔頭自己寫 patch_apply 是 fuzzy），不適合作權威重建 |
| 逐行 hunk（沿用 `bodyMerge` 概念） | 與 merge 同單位 | 需要新增前端 diff 與穩定序列化 |
| **單一區段取代（共同前綴／後綴剪掉，剩中間）** | O(n)、無依賴、套用是精確字串拼接、可驗證 | 多處同時改動時區段變大（但永遠不超過全文；超過約 60% 就改送全文） |

自動保存是 800 ms 停頓後送出（perf F5 的現象），絕大多數是一個游標附近的連續編輯，單一區段取代剛好。
索引用 UTF-16 code unit（兩端都是 JS 字串，拼接精確），邊界避免切在 surrogate pair 中間。

**伺服器**：解析 base（同 A），`newBody = base.slice(0,from) + insert + base.slice(from+delete)`，
驗 `sha256(newBody) === markdown_hash`，不符回 `422 patch_mismatch`（客戶端補送完整 `markdown`）；
之後 `input.markdown = newBody`，流程完全沿用。關鍵：`nodeSchema.partial().parse`（`routes/nodes.ts:134`）
與「只更新有送的欄位」的過濾（:144）發生在 patch 展開**之前或之後**要處理好——建議在 `PATCH` 路由展開成一般的 `markdown` 輸入再進 `updateNode`，`updateNode` 的介面不變。

**離線／冪等／重試／合併／BODY_CONFLICT**：同 A——耐久形式仍存完整 `markdown`＋`base_markdown`，只在傳輸層瘦身；
patch 套用失敗或 base 不明都有「補送完整」退路，三方合併與 `BODY_CONFLICT` 不變，因為它們只看 `newBody`、`base`、`oldBody` 三段文字。
`markdown_hash` 是必要的：沒有它，bug 或 base 不一致會悄悄寫出錯誤正文，而這個系統的首要不變條件是「文字不遺失」。

**舊客戶端**：不受影響。**新客戶端＋舊伺服器**：舊伺服器會把沒見過的 `markdown_patch` 靜默丟掉（zod 預設 strip，`utils.ts` 的 `nodeSchema` 非 strict），
導致「這次沒改正文」卻回 200——**比 A 更危險**，一定要能力探測。

**預期**：典型一次輸入 patch 數百位元組～數 KB ＋雜湊 128 B → 位元組 300 KB → **約 1–3 KB**；3 Mbps 下上傳可忽略，
總時間主要剩 RTT＋伺服器（桌面量測 80–105 ms 級），手機估約 **0.15–0.25 s**（估算）。大規模改寫（貼上整段、全文取代）退化成送全文。

**成本**：多一套差異格式要維護與測試（邊界、surrogate、CRLF、空字串）；伺服器要多驗一次雜湊（150 KB 的 SHA-256 約毫秒級）；
`BODY_CONFLICT`／歷史不受影響，但 `rewriteBody`（`noteStructure.ts:61`）、agent 工具等不經 `noteWriter` 的入口不一定受益（agent 繼續送完整，保持現況）。

**改動規模**：A 的全部，加 前端 patch 計算（新檔＋測試）、後端 patch 展開（1 檔）；約 +2 檔。

### 方案 C：其他發現

C1（併入 A）**base 等於伺服器目前正文時完全不需要 base**。`nodeUpdate.ts:241-242` 的條件已經是這樣；
差別只在「由誰證明相等」：現在靠客戶端上傳 150 KB 讓伺服器比；改成客戶端上傳 64 B 雜湊，伺服器比 `sha256(oldBody)`。
也就是說在單裝置情境下，A 的 base 解析**永遠是第一步就命中**，不查歷史、不載 blob。

C2 **對請求 body 做 gzip**（`CompressionStream('gzip')`＋`Content-Encoding: gzip`）：中文 150 KB 通常可壓到約三分之一，
而且與 A/B 疊加。缺點：Hono/後端目前沒有解壓請求的中介層、nginx 需要允許；deflate 視窗只有 32 KB，
所以「同一份文字送兩遍」**不會**被去重——不能代替 A；對 B 的小 patch 則沒意義。屬於獨立的小優化，不納入本案。

C3 **伺服器記住每個客戶端最後確認的 base**：不需要 base 欄位，但要有客戶端識別與狀態、多分頁/多裝置誤配，並違反「請求自帶所需資訊、重試安全」。不採用。

C4 **完全不送 base，改用樂觀版本鎖**（`If-Match`，不一致就 409 由客戶端重載合併）：把今天伺服器端的合併搬到客戶端，
動到 `BODY_CONFLICT`/收件匣契約（`docs/architecture/note-writes.md` 與 `nodeUpdate.ts:337-348`）。範圍遠大於 F5，不採用。

## 3. 對照表

| 項目 | 現況 | A：`base_hash` | B：A＋區段 patch |
| --- | --- | --- | --- |
| 50k 中文筆記 PATCH 大小 | ≈300 KB | ≈150 KB | ≈1–3 KB（大改寫退化成 ≈150 KB） |
| 3 Mbps 保存來回（估算） | 0.93 s（量測） | ≈0.5 s | ≈0.15–0.25 s |
| 伺服器新增儲存 | — | 無（`blobs`＋事件已有） | 無 |
| 佇列／復原耐久格式 | 完整 | **不變** | **不變** |
| 冪等鍵 | 一鍵一請求 | 不變；`base_unknown` 在 `claim()` 前，同鍵補送 | 同左，另加 `patch_mismatch` |
| 舊客戶端 | — | 相容 | 相容 |
| 新客戶端＋舊伺服器 | — | 需能力探測 | 需能力探測（更危險） |
| 新增失敗模式 | — | `base_unknown`（多一次往返） | 再加 `patch_mismatch`、patch 計算 bug |
| 後端改動 | — | 2 檔＋helper | 3 檔 |
| 前端改動 | — | 3 檔＋新模組 | 4–5 檔＋patch 演算法 |

### 3.1 BODY_CONFLICT 與三方合併為何不變

`threeWayMergeBody(base, incoming, current)` 與條件式（`nodeUpdate.ts:241-248`）只吃三段**字串**。
A/B 只改「base（與 incoming）字串怎麼進來」，進來之後同一份程式處理。
`BODY_CONFLICT` 事件（:337-348）的 payload 是衝突行與 `oldBody.slice(0,500)`，不含 base 全文，與 base 如何傳輸無關。
`addBlockIds` 的「有沒有送 base」語意用 `baseSent` 保留（§方案 A 步驟 4）。

### 3.2 離線佇列中的連續編輯（最容易出錯的情境）

離線時對同一筆記排了 W1、W2。W2 的 base ＝ W1 的樂觀結果 X1。重播 W1 時若伺服器已被他人改過，會合併出 X1′ ≠ X1，
則 W2 的 `base_hash = H(X1)` 在伺服器歷史中**不存在**。若佇列只存瘦版，這時就丟失了合併所需的 base；
所以耐久形式必須保留完整 base，`base_unknown` 後本機補送。這也是不把「瘦身」做進 `enqueue` 的原因。
（此情況下結果＝今天：用客戶端的 X1 當 base 去合併 X1′，沒有更差。）

## 4. 安全與授權

- 授權不變：`write_node` 在解析 base 之前就檢查（`nodeUpdate.ts:184`）；base 查找限定同 workspace、同 target 的事件，不能用別篇的 blob。
- `base_unknown` 對沒有寫入權的人不會出現（先授權、後查 base），不洩漏歷史是否存在。
- 雜湊不是授權依據，也不當冪等鍵或同步游標（對照 AGENTS.md 第三批對 `node_tag_states` 的同樣限制）。
- 紅線化（purge）過的事件沒有 `body_hash`，找不到就走 `base_unknown`，不會讀到已刪內容。

## 5. 相容與推出順序

- 後端先上（AGENTS.md 第十五批「分開更新時先更新後端」），而且 A 只新增可選欄位，舊客戶端不受影響。
- **能力探測**：舊伺服器會靜默丟掉 `base_hash`／`markdown_patch`，沒有 `base_markdown` 的請求被當成「無 base 的寫入」，
  結果是 (a) 不合併、最後寫入覆蓋他人修改（GAP-186 想避免的問題），(b) 伺服器替正文補 `^id`（:255）。
  因此客戶端只在**看過伺服器支援證據**後才瘦身：PATCH／GET node 回應帶 `body_hash` 欄位（舊伺服器不會有），
  或之後一個明確的 capability 欄位。沒看過就送完整，保證最差情況＝今天。
- 擴充順序必須是：後端 → 客戶端 A → 客戶端 B；B 不應早於 A 的量測。

## 6. 測試需求

後端（整合測試，使用隔離資料庫，確認未被跳過）：

1. `base_hash` = 目前正文 → 不合併、不查歷史、結果同送 `base_markdown`。
2. `base_hash` = 本筆記較舊版本，且他人改了不重疊行 → 兩邊都保留；重疊行 → `BODY_CONFLICT` 與今天逐欄相同（對照測試：同一組輸入分別走 `base_markdown`／`base_hash`，`node`、`bodyConflicts`、事件相同）。
3. `base_hash` = 別篇筆記的 blob／不存在的雜湊 → `409 base_unknown`，且**沒有**寫入 `idempotency_keys`、事件或 blob。
4. 同鍵先 `base_unknown`、再補送完整 → 成功；已提交後同鍵再送（回應遺失）→ `200 {deduped:true}`。
5. 無寫入權的 actor ＋ 任意雜湊 → 授權錯誤，不是 `base_unknown`。
6. 已永久刪除（紅線化）歷史 → `base_unknown`。
7. `writeBlockIds`／`addBlockIds` 在送 `base_hash` 時與送 `base_markdown` 時一致（沿用 `blockNodes.integration.test.ts`、`coreConsistency.integration.test.ts:152-166` 的案例）。
8. 方案 B：patch 邊界（空、全文、surrogate pair、CRLF）、`markdown_hash` 不符 → `422 patch_mismatch` 且不寫入。

前端：

1. `noteBaseWire`：雜湊正確、無 `crypto.subtle` 時不瘦身、對非筆記路徑或無 base 的請求原樣。
2. `writeQueue`：直送與 `drain` 都先送瘦版；`base_unknown` 後以同鍵送原版；**不**進入 `preserveDirectRejection`／`preserveRejectedWrite`。
3. 離線 W1／W2 案例（§3.2）：佇列內容仍是完整 body；重播中 W1 被合併後 W2 仍能完成。
4. `noteWriter.test.ts`、`useOverviewModeAutosave.test.tsx`、`rejectedWritePersistence.test.ts`、`failedWriteRecovery.test.tsx` 的既有斷言不變。
5. 能力探測：未見 `body_hash` 前送完整。
6. 量測：以 `perf-logged-in` 同一套 50k 字筆記、手機節流，記錄請求大小與來回時間（這是目前所有數字缺的實測）。

## 7. 建議

**採方案 A（含 C1），先量測，再決定是否做 B。**

理由：

1. A 不需要新儲存，歷史與雜湊已存在（§1.4）；耐久格式不變，離線佇列、復原、備份、冪等全部不需遷移。
2. A 的失敗只會退化成「多一次往返、結果等於今天」，而 B 多出需要驗證的重建流程，錯了會寫壞正文。
3. 但請接受 A 只到約 0.5 s：F5 的 0.2–0.3 s 目標需要 B。是否值得 B 的複雜度，取決於 A 之後的實測與產品選擇（見下）。
4. 把「瘦身」放在傳輸層、耐久層保持完整，是本案最重要的設計決定；任何把瘦版寫進佇列的做法都要重新評估 §3.2。

### 後續 PR 步驟

1. **量測 PR（測試/腳本）**：重現 F5 的請求大小與時間，建立基準；順手確認 `keepalive` 64 KiB 限制對 50k 筆記的實際影響。
2. **後端 PR**：`PATCH` 接受 `base_hash`；`nodeUpdate` 加 base 解析（head 命中 → 同筆記歷史 → `base_unknown`）、回應加 `body_hash`；整合測試 §6 後端 1–7；更新 `note-writes.md`。可獨立部署。
3. **前端 PR**：`noteBaseWire`＋`writeQueue.transmit`（直送與 `drain` 共用）＋能力探測；前端測試 §6 1–5；`pending_writes` 格式不動。
4. **驗證**：桌面與手機 viewport（標示非真機）；離線→恢復重播；兩個分頁同時改同一筆記觸發合併與 `BODY_CONFLICT`。
5. **決策點**：依步驟 1/4 的數字決定是否做 B；若做，另開提案 PR 定稿 patch 格式（建議單一區段取代＋`markdown_hash`），再依相同順序（後端 → 前端）實作。
6. **（可選）** 在 `payload->>'body_hash'` 或查找路徑上加索引，前提是量測顯示長歷史筆記的非 head 查找變慢。

## 8. 需要使用者決定的事

1. 目標是「約 0.5 s」（A）還是「0.2 s 級」（B，多一套差異格式）？
2. 區網 `http://`（無 `crypto.subtle`）是否接受維持完整上傳？
3. 能力探測用「回應帶 `body_hash`」是否可以，還是要正式的 capability 欄位？
4. agent／MCP 路徑是否維持送完整 base（建議維持，不屬於本案）。
5. 「write journal」指的是否為本文假設的 `writeLifecycle`／`writeRecovery`，或另有模組？

## 9. 本文未驗證之處

- 沒有執行測試或量測；所有秒數除了 F5 的 0.93 s 以外都是由位元組數與頻寬換算的估算。
- `keepalive` 的 64 KiB 限制來自瀏覽器規格，尚未在本專案環境實測。
- 長歷史筆記的非 head 查找成本未量測。
