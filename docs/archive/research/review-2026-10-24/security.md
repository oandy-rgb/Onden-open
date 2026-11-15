# 安全審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：認證與 session、公開路徑白名單、CORS 與 cookie、邀請、分享連結、發布站與遮蔽、HTML／SVG／CSS 清理、
iframe 嵌入、站內 XSS、RSS／書籤／連結預覽的外連、媒體上傳與提供、MCP 與 agent 工具、備份與匯出、log、依賴。
不含逐路由寫入權限（另有 `test/write-permission-matrix`）與 GET 權限（`permissionMatrix.test.ts`）。

審查方式：只讀程式碼，沒有讀任何 `.md`。執行過的驗證：`npm ci`、`npm audit --omit=dev`、
幾支丟棄式腳本（SVG 清理器、Markdown 管線、better-auth 取 IP、Chromium 載入 SVG）與一個丟棄式整合測試（已刪除、未提交）。

環境限制（請如實看待）：本機 Postgres 是 16，缺 `age`／`pgroonga`／`vector` 擴充，所以只載入了部分 schema。
需要全文／向量搜尋的路徑（例如 `prompts/get` 的 `ask` 搜尋範圍）沒能跑；改用不需要搜尋的 `node_ids` 範圍驗證。
沒有連到任何真實部署。依賴部分只看 lockfile 裡的版本與 advisory 範圍，沒有實際打弱點。

標記說明：**CONFIRMED（執行）**＝我跑出了結果；**CONFIRMED（讀碼）**＝程式碼本身已足以證明，沒另外跑；
**SUSPECTED**＝有具體推理但沒執行驗證。

## 摘要

| 嚴重度 | 數量 | CONFIRMED | SUSPECTED |
| --- | --- | --- | --- |
| P0 | 1 | 0 | 1 |
| P1 | 6 | 4 | 2 |
| P2 | 15 | 7 | 8 |
| 合計 | 22 | 11 | 11 |

最需要先處理的五件事：

1. `pdfjs-dist` 6.0.227 落在「開啟惡意 PDF 即可執行任意 JS」的受影響範圍，且 PDF 在 app 同源下渲染（P0，SUSPECTED）。
2. 登入速率限制在目前的 nginx 後面形同虛設：沒有可信 IP，所有人共用一個桶，或被偽造 `X-Forwarded-For` 繞過（P1，CONFIRMED）。
3. MCP `prompts/get` 繞過 token 的 `allowed_tools`、速率限制與稽核，鎖死的 token 仍能讀筆記全文（P1，CONFIRMED）。
4. `sanitizeSvg` 可被 XML 內部實體繞過，腳本在沒有 CSP 的情境會執行；`/api/media` 的 CSP sandbox 目前擋住了（P1，CONFIRMED）。
5. #技能 筆記「只認自己寫的」只在建立時檢查，共編者改寫內容後仍會被當成你的指令（P1，SUSPECTED）。

---

## P0

### 1. pdfjs-dist 在受影響範圍，PDF 在 app 同源渲染（SUSPECTED）

- 位置：`packages/frontend/package.json:51`（`pdfjs-dist ^6.0.227`，實際安裝 6.0.227）、
  `packages/frontend/src/components/pdf/PdfViewerHost.tsx:218`（`core.getDocument({ url })`）、
  `packages/backend/src/services/media.ts`（`SIGNATURES[".pdf"]` 只檢查開頭 `%PDF-`）。
- `npm audit` 對 `pdfjs-dist >=5.6.83 <6.2.108` 列 GHSA-hq66-cqwq-w95j：開啟惡意 PDF 可執行任意 JavaScript。
  前端的 `getDocument` 呼叫沒有設 `isEvalSupported: false`。
- 情境：有編輯權的成員在共用空間上傳構造過的 PDF（上傳只驗證檔頭與大小）。其他成員（含 owner）在 app 裡打開它，
  腳本在 app 的來源下執行，可用對方的 session 讀寫對方看得到的所有資料。這是跨權限邊界的洩漏與寫入。
- 為什麼不是 CONFIRMED：我沒有構造或執行惡意 PDF，只依 advisory 的版本範圍與「PDF 確實在 app 同源渲染」判斷。
- 建議：升到 `pdfjs-dist >=6.2.108`，並在 `getDocument` 傳 `isEvalSupported: false`；升級前可先暫停預覽他人上傳的 PDF。

---

## P1

### 2. 登入速率限制沒有可信的客戶端 IP（CONFIRMED，執行＋讀碼）

- 位置：`packages/backend/src/auth.ts:182`（`betterAuth({...})` 沒設 `advanced.ipAddress.ipAddressHeaders`）、
  `docker/nginx/nginx.conf`（`location /api/` 只送 `X-Real-IP`，沒有改寫 `X-Forwarded-For`）。
- better-auth 1.6.18 預設只讀 `x-forwarded-for`；取不到 IP 時把所有請求放進同一個 `no-trusted-ip` 桶
  （`dist/api/rate-limiter/index.mjs:277-288`），`/sign-in`、`/sign-up` 的特別規則是每 10 秒 3 次。
- 驗證：`NODE_ENV=production` 下呼叫 better-auth 的 `getIp`：只帶 `x-real-ip`（nginx 實際送的）→ `null`；
  帶 `x-forwarded-for: 198.51.100.7` → 回該值；帶 `198.51.100.8, 10.0.0.1` → 回第一段。
  nginx 對客戶端送來的 `X-Forwarded-For` 原樣轉發，所以攻擊者可以每次換一個值。
- 情境：（a）不送 XFF 時，全站的登入／註冊嘗試共用每 10 秒 3 次，一個人亂試就能讓所有人登不進去；
  （b）攻擊者每次換 XFF，就沒有任何限制，可以線上暴力猜密碼。
- 建議：`auth.ts` 設 `advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } }`，並讓 nginx 用 `$remote_addr` 覆寫
  `X-Real-IP` 與 `X-Forwarded-For`（前面若還有受信任的反向代理，再依實際層數調整）。

### 3. MCP `prompts/get` 繞過 `allowed_tools`、速率限制與稽核（CONFIRMED，執行）

- 位置：`packages/backend/src/routes/mcpProtocol.ts:96`（`buildMcpServer` 無條件 `registerSkillPrompts`）、`:75-86`（handler 直接呼叫 `prompt()`）；
  對照 `services/agentTools/registry.ts:90-98`，`assertToolAllowed` 與 `checkRateLimit` 只在 `callTool` 裡。
- 驗證（丟棄式整合測試，已刪）：建一個 `allowedTools: []`（鎖死）、`access: read` 的 token。
  `tools/list` 與 `tools/call` 都不可用；但 `prompts/list` 列出所有內建技能，
  `prompts/get`（`outline`，`node_ids` 範圍）回傳的訊息裡含有該筆記的內文（測試斷言通過）。
  連續 100 次 `prompts/get` 全部成功，而同一個 token 的 `tools/call` 100 次中有 40 次被限速（每分鐘 60）。
  `prompts/get` 也沒有寫 `AGENT_TOOL_CALLED` 事件。
- 仍有的邊界：內容只限 token 可讀、且空間 `external_ai` 開啟的筆記（`harness/scope.ts`），所以不是跨空間洩漏。
- 情境：owner 為了「只讓這個 agent 能做 X」把 `allowed_tools` 縮到最小，agent 仍能無限制、無稽核地讀走同範圍的筆記全文。
- 建議：讓 prompts 走同一個守門（在 `registerSkillPrompts` 裡呼叫 `assertToolAllowed(actor, "prompt:<id>")`，或把技能讀取視為一個需要授權的 read 工具），
  並套用同一個 `tools:${actor.id}` 速率桶，成功與失敗都寫稽核事件。

### 4. `sanitizeSvg` 可被 XML 內部實體繞過（CONFIRMED，執行）

- 位置：`packages/backend/src/services/svgSanitize.ts:20-72`（regex 清理）、`routes/media.ts:125`（CSP sandbox）。
- 驗證：把 `<!DOCTYPE svg [<!ENTITY a "&#60;script xmlns='http://www.w3.org/2000/svg'&#62;…&#60;/script&#62;">]><svg …>&a;</svg>`
  丟進 `sanitizeSvg`，輸出與輸入完全相同（regex 只找字面的 `<script`）。用 Chromium 以 `image/svg+xml` 當頂層文件載入：
  沒有 CSP 時腳本執行（`document.title` 被改）；加上 `/api/media` 現在送的 `Content-Security-Policy: …; sandbox` 後不執行。
- 現況：App 內 `GET /api/media/*` 有 CSP sandbox，頂層開啟擋住了，`<img>` 本來就不跑腳本，所以 app 本身目前沒被打到。
  但發布時 `mediaBundle` 會把 SVG 當成獨立檔案放進 zip／GitHub Pages，這些位置沒有這個 header（這一點是讀碼推論，沒有實際發布驗證）；
  直接開啟該 `.svg` 的人會在該網域執行腳本。同一份 bytes 也進備份。
- 建議：不要靠 regex。上傳 SVG 時整份拒絕含 `<!DOCTYPE`／`<!ENTITY` 的檔案，並改用解析器型清理器（DOMPurify 的 SVG profile），
  或把 SVG 轉成點陣圖再存；匯出時對 SVG 一律以 `<img>` 引用並在靜態站設 CSP。

### 5. #技能 筆記的「自己寫的」只在建立時檢查（SUSPECTED）

- 位置：`packages/backend/src/services/harness/noteSkills.ts:75`（條件是 `NODE_CREATED` 事件的 actor 等於自己）。
- 推理：技能內文會成為模型的系統指令（`harness/index.ts` 的 `fromNote`）。檔頭註解的不變條件是「技能不是別人的話」，
  但查詢只看誰建立筆記，不看目前內容是誰寫的。共用空間裡有編輯權的 B 可以改寫 A 建立的 #技能 筆記，
  之後 A 的 Claude（含帶寫入權限的 token）會照 B 的內容執行。
- 建議：技能內容以「最後一次改內文的人」或內容雜湊綁定作者（改動後須原作者重新確認），或規定技能筆記只能放在個人空間。

### 6. 任一成員可用上傳吃光後端記憶體與磁碟（SUSPECTED）

- 位置：`packages/backend/src/routes/media.ts:43`（`c.req.parseBody()` 把整個 multipart 讀進記憶體）、`:57`（`Buffer.from(await file.arrayBuffer())` 再複製一份）；
  單檔上限 500 MB（`markdown/src/mediaTypes.ts` 的 `VIDEO_MAX`）。
- 推理：一個請求最多約 1 GB 記憶體，沒有每人並行或總量限制；兩三個並行的 500 MB 上傳就可能 OOM 重啟後端。
  上傳後沒被任何筆記引用的檔案也沒有清理（`media_uploads` 孤兒），磁碟會只增不減。入口只需要「在某個空間可寫」，每位成員都滿足（個人空間）。
- 建議：改成串流寫入暫存檔（busboy 之類）而不是 `parseBody`；加每人並行數與每人容量上限；排程清理超過 N 天未被引用的上傳。

### 7. 已知弱點的依賴有可達的路徑（CONFIRMED 版本範圍，可達性為讀碼推論）

`npm audit --omit=dev` 共列出一長串；以下只列有進入執行路徑的。

| 套件（安裝版本） | 弱點 | 為何可達 |
| --- | --- | --- |
| `hono`（4.12.25，範圍 ≤4.13.10） | CORS middleware 的 `Access-Control-Request-Headers` ReDoS；`parseBody()` 巢狀 key 記憶體耗盡 | `index.ts` 的 `cors()` 是第一層 middleware，未登入就會跑；`routes/media.ts:43` 用 `parseBody` |
| `sharp`（0.34.5） | libvips／libheif／librsvg 多個 CVE | 上傳的圖片與 SVG 都先經 `sharp(bytes).metadata()`（`services/media.ts` `validateMedia`），任何可寫成員都能送入 |
| `zod`（<4.6.6） | 超大受限集合驗證耗盡記憶體 | 後端所有請求體驗證；上限是 nginx 的 20 MB |
| `@modelcontextprotocol/sdk`（1.29.0，≤1.31.0） | 單一 HTTP 請求可耗盡伺服器記憶體 | `/api/mcp/protocol` 每個請求都建 `WebStandardStreamableHTTPServerTransport`；需要 token 或 session |
| `@astrojs/node`／`astro`（≤11.1.2／≤7.3.1） | Host header 的壞 port 讓 Node adapter 當掉；其餘 XSS／AVIF RCE 要看是否用到對應功能 | `/site/*` 由 Astro SSR 提供，匿名可達；AVIF 圖片最佳化未確認有使用 |

沒有實際可達路徑、不必急的：`simple-git`（指令參數固定，無使用者可控的 config／editor 變數）、`tar`、`xmldom`、
`lodash-es`、`http-cache-semantics`、`smol-toml`、`devalue`、`ip-address`（皆為間接依賴，找不到使用者輸入進入點）。
`dompurify` 僅由 `mermaid`（`securityLevel: "strict"`）使用，受影響的是 `IN_PLACE`／`SAFE_FOR_TEMPLATES` 等未使用的選項。
`@capacitor/android` 只影響 Android 打包，不影響網頁部署。
- 建議：先升 `hono`、`sharp`、`zod`、`@modelcontextprotocol/sdk`、`pdfjs-dist`、`@astrojs/node`（多數 `npm audit fix` 即可，Astro 與 simple-git 需要處理 breaking change）。

---

## P2

### 8. 請求 log 把分享連結 token 寫進去（CONFIRMED，讀碼）

- 位置：`packages/backend/src/index.ts:145`（`${c.req.method} ${c.req.path} …`）。
- 分享連結的 token 在路徑裡（`/api/share/<token>`），是整個發布站的 bearer 秘密。每次造訪都會把它寫進應用 log；
  nginx 預設 access log 還會寫整個 URI，包含學習者連結的 `?access=<token>`。log 通常會送到別的系統。
- 建議：log 前把 `/api/share/*` 的 token 段換成 `…`；nginx 對這兩類路徑關閉 access log 或用 `map` 遮罩。

### 9. App 主頁面沒有 CSP、frame-ancestors、nosniff、HSTS、Referrer-Policy（CONFIRMED，讀碼）

- 位置：只有 `packages/frontend/src/components/SiteHead.astro:29-30` 設了 `frame-ancestors 'self'`／`X-Frame-Options`（`/site/*` 頁面）；
  `pages/index.astro` 與 `docker/nginx/nginx.conf` 都沒有。
- 情境：別的網站可以把 app 放進 iframe 做點擊劫持；且任何一個將來的 XSS 都沒有第二層防線。
- 建議：在 nginx 對 `/` 與 `/api/` 加 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、（HTTPS 下）`Strict-Transport-Security`，
  並逐步導入 CSP（先 report-only）。

### 10. 冪等鍵是全域的，不綁 actor、路由或內容（SUSPECTED）

- 位置：`packages/backend/src/spine/idempotency.ts:58-59`（`INSERT … ON CONFLICT (key) DO NOTHING`，表只有 `key`、`workspace_id`）。
- 推理：任何請求只要重用一個已提交過的 UUID，不論是誰、打哪條路由、送什麼內容，都會得到 `200 {deduped:true}` 而不寫入。
  UUID 隨機所以別人猜不到，但客戶端若在不同操作重用同一個鍵（離線佇列的 bug、重送錯誤的 payload），會得到「成功」卻沒有寫入。
- 建議：把 `actor_id` 與「方法＋路徑」雜湊納入唯一鍵；重放時比對 payload 雜湊，不同就回 422。

### 11. 發布站的存取 token 以明文存放，cookie 沒有 `Secure`（CONFIRMED，讀碼）

- 位置：`services/publishing/share.ts`、`siteAccess.ts`（`share_token`、`access_tokens` 存在 site-config 屬性裡，明文）；
  `packages/frontend/src/lib/sitePageAccess.ts:45-50`（cookie 設了 `httpOnly`、`sameSite: lax`，沒設 `secure`）。
- 另外 `?access=` 把 token 放在 URL，會進瀏覽器歷史、Referer（`siteHead.ts` 只在 canonical 去掉它）與 nginx log；token 沒有到期時間。
- 好的一面：這些屬性在沒有成員的 `system` 空間，owner 專用路由才能讀（見「做得好的地方」）。資料庫洩漏或備份外流時才有風險。
- 建議：存雜湊（`access_tokens`）、cookie 在 HTTPS 下加 `secure`、學習者 token 加到期時間；`?access=` 第一次兌換後立即導向去掉查詢字串的網址。

### 12. `safeFetch` 的 timeout 是閒置逾時，不是總期限（SUSPECTED）

- 位置：`packages/backend/src/services/safeFetch.ts:165`（`timeout: timeoutMs` 是 socket idle timeout）。
- 推理：對方每 7 秒送 1 個位元組，8 秒的書籤逾時與 2 MB 上限都不會觸發，連線可以掛很久。
  書籤、RSS、DOI 都走這裡，沒有並行上限。要有人願意餵一個慢速伺服器，影響的是工作執行緒與 socket 數量。
- 建議：在 `safeFetch` 外層加總期限（`AbortSignal.timeout` 或自己的 timer）與每個使用者的並行數上限。

### 13. 匿名的 `/api/site` 與 `/api/share/:token` 每次都重新組整份發布站，沒有快取或限速（SUSPECTED）

- 位置：`modules/website/routes.ts:222`、`:262`，`services/publishing/servedSite.ts:111-116`（`SELECT * FROM publish_snapshots …` 載入整個 payload，再做 takedown 查詢）；
  Astro 的每個 `/site/*` 頁面又各打一次。nginx 沒有 `limit_req`。
- 情境：匿名請求便宜，後端每次要做大 JSON 與多個查詢，容易被放大成 DoS。
- 建議：以 snapshot id＋takedown 版本做短 TTL 快取（含 ETag）；對匿名路徑加 nginx `limit_req`。

### 14. 白板卡片會自動把任何 https 網址嵌成 iframe（CONFIRMED，讀碼）

- 位置：`packages/frontend/src/components/CardNode.tsx:254`（內文是單一 URL 就當 `bareUrl`）、`:379-381`（`sandbox="allow-scripts allow-popups"`）。
- 沒有 `allow-same-origin`，所以碰不到 app 的 storage，這點是對的。但共編者放一張 URL 卡，所有打開白板的人都會對任意主機發出請求（洩漏 IP、追蹤），
  對方頁面還能 `allow-popups` 開窗。與 `isAllowedEmbedSrc` 的白名單做法不一致。
- 建議：沿用 `TRUSTED_EMBED_HOSTS`，其他網址顯示成連結卡，使用者按下才載入。

### 15. 嵌入白名單的小不一致（CONFIRMED，讀碼；目前無害）

- `packages/markdown/src/mediaEmbed.ts:74-75`：`toEmbedUrl` 用 `host.endsWith("vimeo.com")`／`endsWith("youtube.com")`，沒有點邊界，
  `evilvimeo.com` 會通過；但輸出會被改寫成固定的 `player.vimeo.com/video/<數字>` 或 `youtube-nocookie.com/embed/<id>`，所以目前沒有實害。
  `isAllowedEmbedSrc` 本身是正確的（`.${h}`），但允許這些網域下的任何路徑與子網域，並給 `allow-scripts`。
- 另外 `<video poster="javascript:…">` 在發布 profile 與 app profile 都會留下（我用 `md2html` 與 app 管線實測）；
  `poster` 不會執行 `javascript:`，目前惰性，但清理 schema 沒有覆蓋 `poster` 的協定。
- 建議：兩個函式共用同一個嚴格的主機判斷；只允許 `/embed/`、`/video/` 路徑；schema 對 `poster` 套用協定白名單。

### 16. `queryView` 不檢查視圖定義本身的讀取權（SUSPECTED）

- 位置：`packages/backend/src/services/agentTools/queryView.ts`（`SELECT … FROM content_nodes n, jsonb_array_elements(collection_views)`，只依 `workspace_id`）。
- 推理：資料列有用 `readableNodeIdSet` 過濾，但回傳的 `view`（`visibleFields`、`groupBy`、`tagId`）來自使用者讀不到的標籤筆記時仍會給出，
  「找不到」與「讀不到」的錯誤也不同。需要知道視圖 UUID，所以風險低。另外 `readableNodeIdSet` 把整個可讀 id 集合載入記憶體，大工作區會慢。
- 建議：用 `readableScopeSql` 把視圖所在的 tag 節點也納入查詢條件；讀不到一律回「找不到」。

### 17. MCP 協定通道把 handler 例外原文回給 agent（SUSPECTED）

- 位置：`packages/backend/src/routes/mcpProtocol.ts:74-86`；REST 通道走 `toolOnError`／`apiOnError`（`httpError.ts:115` 對未知例外只回 `internal`）。
- 推理：MCP SDK 會把 tool callback 丟出的 `Error.message` 當成錯誤內容回給客戶端。資料庫錯誤（例如 slug 唯一性衝突的 `Key (…)=(…) already exists`）
  可能帶出該 agent 讀不到的筆記的 slug 或欄位值。我沒有實際觸發。
- 建議：在 `buildMcpServer` 的 callback 外包一層，把非 `ScopeError`／`AuthorityError`／`ZodError` 的例外換成通用訊息。

### 18. 被拒絕的 agent 呼叫每次都寫一筆稽核事件，可灌爆 `domain_events`（CONFIRMED，讀碼）

- 位置：`packages/backend/src/services/agentTools/registry.ts:100-112`（限速或 scope 拒絕時仍 `event(…"AGENT_TOOL_FAILED"…)`）。
- 情境：被限速的 token 仍可以每秒送大量請求，每一個都插入一列 `domain_events`（表是 append-only，預設不清）。
- 建議：同一個 token＋原因在一分鐘內只記第一筆並累計次數；或被限速後直接回應，不寫事件。

### 19. 書籤把遠端頁面的標題、描述、圖片網址不加跳脫地拼進 Markdown（CONFIRMED，讀碼）

- 位置：`packages/backend/src/routes/bookmark.ts:53-60`（`![](${imageUrl})`、`> ${description}`、`[${title}](${url})`）。
- 情境：遠端頁面的 `og:description` 含換行（HTML 實體 `&#10;` 會被 `decodeHtmlEntities` 解開）時，只有第一行在引用區塊內，
  其餘變成使用者筆記的 Markdown 內容（追蹤用圖片、假連結、`[[…]]`）。標題含 `](…)` 也能改寫連結目標。
  輸出仍會經過清理，所以不是 XSS，是內容注入。
- 建議：標題與描述壓成單行並跳脫 Markdown 特殊字元；`imageUrl` 驗證為 http(s) 且跳脫 `)`。

### 20. 註冊把關有小空隙（SUSPECTED）

- 位置：`packages/backend/src/auth.ts:143-147`（`hasAnyUser` 沒有鎖）、`:183`（`emailAndPassword` 沒開 `requireEmailVerification`）。
- 推理：（a）`first-only` 模式下，全新部署時兩個並行的第一次註冊都會通過把關；`actorForSession` 的 advisory lock 保證只有一個成為 owner，
  但另一個仍建立了 better-auth 帳號（成為沒有任何空間的成員）。（b）`open` 模式下 email 不驗證，邀請流程靠的是連結本身（一次性、綁 email），所以邀請本身沒問題。
- 建議：把「是否已有使用者」的檢查與 user 建立放進同一個 advisory lock；若要開放註冊，打開 email 驗證。

### 21. GitHub 備份不檢查目標倉庫是否私有（SUSPECTED）

- 位置：`packages/backend/src/services/githubBackup.ts:94-137`（只用 `GITHUB_BACKUP_REPO` 與 token，沒有 `repos.get().private` 檢查）。
- 情境：部署者把備份倉庫設成公開（或之後被改成公開），所有開了 `backup` 的空間內容會被推上去。
- 建議：推送前檢查 `private === true`，否則拒絕並在設定頁提示。

### 22. Cookie session 的變更請求沒有 Origin 檢查，MCP 通道也不驗證 Origin（SUSPECTED）

- 位置：`packages/backend/src/index.ts`（CORS 只決定回應 header，不拒絕請求）、`routes/mcpProtocol.ts:121`（`router.all("/")`）。
- 推理：目前跨站偽造請求靠 cookie 的 `SameSite=Lax`（better-auth 預設）擋住；而且 `c.req.json()` 不檢查 `Content-Type`，
  若將來有人把 cookie 改成 `SameSite=None`（例如要做嵌入）就會直接暴露。MCP 規範建議驗證 `Origin` 以防 DNS rebinding。
- 建議：加 Hono 的 `csrf()` 或自己的 Origin 白名單 middleware（同 `CORS_ORIGIN`）給所有非 GET 的 cookie 請求與 `/api/mcp/protocol`。

---

## 做得好的地方（請不要動）

1. **對外抓取（`services/safeFetch.ts`）**：在連線時驗證 DNS 解析結果並檢查所有紀錄、IPv6 各種寫法（mapped、NAT64、6to4）都解析成數值再比對、
   轉址逐跳重驗、大小與逾時上限、測試旗標在 production 強制關閉。書籤、RSS、DOI、技能抓取都走這一條。
2. **站台設定的秘密與發布遮蔽**：`share_token`／`access_tokens` 放在沒有成員的 `system` 空間的設定節點裡，
   分享管理路由是 owner 專用且 token 無法呼叫；公開 payload 用白名單 overlay；未發布的 wikilink 會被改成 alias 或「(private)」，
   隱藏標籤、父層 id 都會清掉，媒體提供端遵循「站上看得到才算公開」。
3. **媒體提供與 token 邊界**：媒體 id 是 128 位元隨機且用 `isMediaId` 檢查（沒有路徑穿越）、副檔名白名單不含任何可執行類型、`nosniff`、
   SVG 加 CSP sandbox（本次實測它擋住了第 4 項的繞過）、原子寫入；bearer token 在入口就被限制在 `/api/mcp/*`，備份下載與還原拒絕 token；
   原生 origin 後門在 production 強制關閉、CORS `*` 在 production 拒絕啟動、auth secret 不接受公開的開發預設值。
4. **Markdown 清理**：同一份 schema 用在 app 與匯出；我用 20 類常見載荷（`javascript:` 各種寫法、事件屬性、mXSS 結構、`<style>`、`<form>`、
   `<meta>`、`<base>`、`srcdoc`、`data:` 連結）跑過 app 與發布兩種 profile，沒有可執行的輸出；手寫墨跡 SVG（`inkSvg.ts`）的顏色有白名單。

## 驗證紀錄

- `npm ci --ignore-scripts`、`npm audit --omit=dev`：已跑。
- `sanitizeSvg` 載荷＋Chromium：第 4 項。`md2html`／app 管線載荷：第 15 項與「做得好」第 4 點。
- better-auth `getIp`（production）：第 2 項。
- 丟棄式整合測試（`allowed_tools=[]` token 的 `prompts/get` 與 100 次呼叫的限速比較）：第 3 項；測試檔已刪除，倉庫只有本檔變更。
- 沒有執行：惡意 PDF（第 1 項）、實際上傳 500 MB（第 6 項）、發布到 GitHub Pages（第 4 項的匯出面）、以 `ask` 搜尋範圍跑 `prompts/get`（缺向量擴充）。
