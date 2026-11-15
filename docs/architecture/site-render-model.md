# 網站的呈現模型（W38）

> 狀態：現行（最後確認 2026-11-01）

> 2026-10-14，note-66 依 note-0f 的指派寫成。檔案位置以 `packages/backend/src`、`packages/frontend/src` 為根。
>
> 2026-10-24（發布改版 P5）：文中提到的分享連結、學員 token 模式、集合（`payload.collections`）、`pageLayouts`、`site.json` 與 `dist-published` 都已刪除，
> 現況見 [發布改版](proposals/publish-redesign-2026-10-24.md)；快照模型 B（快照為準、下架即時）沿用。

> 2026-11-10：網站上有哪些筆記改成**以空間決定**（業主，參考 Obsidian Publish 的包含資料夾、Notion 的頁面樹、Logseq 的全部公開）：空間打開「發布到網站」，裡面的筆記都在網站上，除非被排除——筆記自己的「不發布」（`_published` = `false`，優先於空間）、空白筆記（沒有文字、底下沒有筆記、旁邊沒存東西）、從訂閱存下的文章（`source_type = rss`）。「發布」（`true`）讓空白筆記或存下的文章照樣上去；在不發布的空間裡沒有作用。唯一條件在 `publishing/publishedSet.ts publishedNodeIds`。首頁沒指定時，用網站頁數最多的那個空間的最上層筆記（`siteHome.ts`）。新工作區的預設空間發布開關是關的；migration 186 把從沒發布過東西的空間關掉。下文寫的「`_published` 的筆記」都改讀成「網站上的筆記」。
>
> 2026-11-13（業主）：**在「不發布」的筆記底下新建的筆記，預設也「不發布」。** 只看**直接上層**自己的 `_published`：上層是 `false`，新筆記就帶 `false`；上層的上層不發布、但上層已被「放回網站」，照一般筆記算。決定只在「新建」那一刻（`noteCreate.ts createNote`，另有複製與範本子項兩個不經 `createNote` 的 INSERT，都呼叫 `services/siteDefault.ts`），前後端共用 `@onden/markdown` 的 `newNoteSiteDefault`，離線建立時前端先畫出同樣的結果。**不改既有筆記**（沒有 migration，不補標記）；**搬動筆記不套用這條**（跟不跟著變待業主決定）。怎麼分辨「自己標的」與「繼承預設的」：繼承時除了 `_published`＝`false`，再寫一個系統屬性 `_published_by_parent`＝`true`；之後任何對 `_published` 的寫入（不發布、發布、放回網站＝移除）都會移除它，所以帶著它的「不發布」一定是預設來的。發布前預覽的 `left_out` 多一個原因 `kept_off_by_parent`（舊版前端不認得時，與 `kept_off` 一樣當成「不發布」顯示）；筆記的網站列與預覽對話框用白話說明原因，旁邊有「放回網站」。

> 2026-11-14（業主，「按建議」）三條發布規則：
>
> 1. **拿下來的內容不會自己回來。** 筆記離開網站（不發布、刪除、所在空間的發布關掉），之後又符合條件（「放回網站」、還原、重新打開空間開關），**不會**立刻用舊快照的文字重新上線，要等業主下一次按發布。做法：服務出去的是「最近快照 − 下架」，所以在**會讓東西下架的同一個交易**裡（網站模組的 hook 本來就在那裡要求重建，`requestSiteRebuild`）先把「快照裡有、現在已不在發布集合」的筆記 id 記進**那份快照自己的 payload**（`taken_down`，`publishing/takenDown.ts recordTakedowns`）。讀者面的所有出口（`loadServedSite`、媒體閘門 `servedSiteShowsMedia`、筆記的網站狀態 `noteSiteState`）用 `servedNodeIds` ＝ 發布集合 − `taken_down`；新快照與預覽仍用 `publishedNodeIds`，所以下一次發布會把它們（以現在的文字）帶回來，記錄隨舊快照作廢，不需要清除、也**沒有 migration**。發布前預覽的 `diff.returning` 列出這些筆記（不再重複列在 `changed`）；前端在「放回網站」與空間開關旁說明「下次發布時才會回到網站上」。已知限制：筆記被清空變成空白又重新寫字，這條路沒有 hook，不在記錄內（空白期間本來就不在發布集合；之後文字回來時仍照舊快照的版本，需另案決定要不要掛 body hook）。
> 2. **「不發布這則」遇到底下還有網站上的筆記時問一次**：「底下 N 則要不要一起不發布？」（一起不發布／只有這則）。「一起」走 `POST /api/publish/keep-off-subtree`（`services/siteDefault.ts keepSubtreeOffSite`）：同一個交易裡，根的 `ATTRIBUTE_SET` 是原因，每則底下的 live 筆記各自的 `ATTRIBUTE_SET` 都 `triggered_by` 它，各自用自己的 `set_attribute` 權限判斷（任何一則不行就全部不寫），所以一次 `restoreEvent(根事件, { cascade: true })` 就是一次復原。「只有這則」維持原行為：底下的筆記仍在網站上，`scrubUnpublishedParents` 把它們的上層拿掉（不洩漏不發布的上層）；該筆記的網站列顯示「底下 N 則仍在網站上」。**搬動**筆記到「不發布」的筆記底下：目前沒有相關對話框，維持原樣（搬動不套用此規則）。
> 3. **網站是工作區擁有者的。** 非擁有者不能把自己的個人空間打開「發布到網站」（`services/spaces.ts updateSpace` 回 403 `owner_only`；設定 › 空間與成員不顯示該開關）；`spine/spaceScope.ts publishableSpaceNodeIds`（發布集合的共同底線）也**永遠不含**非擁有者個人空間的筆記，即使開關早已是開的，所以不需要 migration。擁有者自己的個人空間照舊可以。

> 2026-11-01：首頁、筆記頁、標籤頁的版面改成「盒子與零件」，見 [網站的盒子模型](proposals/site-boxes-2026-11-01.md)；本文的呈現模型（快照為準、下架即時）不變。

## 現況

發布網站的資料和畫面目前各有幾條路，彼此不一致。

### 內容：快照與即時資料混在一起

- 「發布」（`POST /api/publish` → `modules/website/publishing/snapshot.ts buildAndEnqueueSnapshot`）寫一列 `publish_snapshots`：筆記的 **Markdown 原文**（id、標題、slug、正文、父層、標籤）、edges、collections、presentation、首頁。先做 redaction（未發布的 wikilink 變成「(private)」、未發布的父層拿掉），再排一個 `pages_push`。切換 `_published` 會自動重做快照（`republishSite`）。快照另帶 `redirects`（舊網址 → 筆記或標籤 id），公開站換成只含現行頁的 `site_redirects`，見[舊網址轉址](proposals/site-stable-urls-2026-11-04.md)。
- 自架的 `/site/...`（Astro SSR）讀 `GET /api/site` → `servedSite.ts loadServedSite`，它是**混合的**：
  - 筆記正文來自**最近一次快照**，但只留下**現在**仍在 `publishedNodeIds` 的筆記；
  - collections **即時重算**；
  - 站點設定（品牌、導覽、版面）**即時覆蓋**，區塊以快照為準；
  - 沒有快照時，回退成即時草稿。
  - 結果：快照之後新發布的筆記不會出現，直到下一次發布；但下架會立即生效。
- 媒體是即時的：匿名讀者看圖時，`canReadMedia` 檢查擁有它的筆記目前是否公開。
- 外部靜態主機（`pagesPush.ts`）拿到的 site.json 是**凍結的快照**，**沒有**經過 `loadServedSite` 的即時過濾；設定、CNAME、SEO 檔卻是即時的；媒體複製進 bundle。`docs/deploy-static-site.md` 說 site.json 來自 `/api/site`，和實作不符。
- 分享連結與 zip 匯出都走 `loadServedSite`。

### 畫面：兩套 Markdown 渲染，各有差異

| 渲染器 | 用在哪 | 支援 | 不支援 |
| --- | --- | --- | --- |
| 後端 `htmlUtils.ts md2html`（unified：gfm、wiki-link、raw、sanitize、正規表示式版 KaTeX、iframe 白名單） | 單篇匯出、匯出預覽、單篇匯出（`singleNoteHtml.ts`）；zip 與 Pages 已改存前端 SSR 的 HTML（P4，`blockRenderer.ts` 已刪） | 數學（regex）、內嵌 HTML | callouts、mermaid、語法上色、frontmatter／區塊 id 清除 |
| 前端 `MarkdownRenderer.tsx`（react-markdown + 一串 remark／rehype 外掛） | 發布網站、Studio、編輯器預覽、集合、複習、卡片、RSS | callouts、remark-math+KaTeX、mermaid、上色、嵌入影片 | （各呼叫端用旗標開關） |

前端內部又因旗標不同而分岔：**發布網站沒開 callouts、也不吃內嵌 HTML**；編輯器預覽兩者都開，註解卻寫著「與發布一致」。後端的 wikilink 指向 `/site/slug/`，前端用 `#wl:` 哨兵；兩份 sanitize schema 靠 `sanitizeSchemaDrift.test.ts` 保持同步。

### 發布前預覽：看不到真正會發布的東西

- Studio 的「預覽」用的是**所有看得到的即時筆記**，不只 `_published`，沒經過 redaction，也沒有空間過濾。
- 「Publish →」確認框列出 `/api/site` 的標題，也就是「上次快照 ∩ 現在允許的」：**這次新勾選的筆記不在清單裡**，而且不顯示內容。
- `POST /api/preview` 只記一筆事件。
- 沒有任何地方能看到「(private)」連結會怎麼顯示、哪些圖片不會公開或不會打包。

## 已拍板的決定（2026-10-14，使用者）

- **呈現模型選 B**：網站的內容與設定以最近一次發布的快照為準；即時資料只能**撤下**（取消發布、空間關掉 publish、刪除、隱藏），不能新增或修改內容。自架 `/site`、分享連結、zip 匯出、外部靜態主機全部讀同一份「快照 − 下架」。
- **只用一套 Markdown 渲染管線**（`ondenMarkdown(profile)`，`app` 與 `published` 兩種 profile）。開工前定好的兩點：
  - **內嵌 HTML：`published` profile 不允許**。公開網站維持現狀（不吃筆記裡的內嵌 HTML），匯出（單篇 HTML、zip）跟著網站走，因為匯出就是網站的離線版本。這是行為變更：曾經依賴內嵌 HTML 的筆記，匯出後那部分會變成純文字，要寫進 release note。`app` profile 維持現狀。
  - **mermaid：離線匯出不打包**。網站上載入後再畫；zip 與單篇 HTML 匯出輸出 `<pre class="mermaid">`，離線開啟時顯示原始碼，不額外打包 mermaid 的程式（避免匯出檔變大）。
  - **補充（2026-10-14，使用者）**：`published` profile 放行 Onden 自己的編輯器會寫出的五個標籤：`<u>`、`<mark>`、`<audio>`、`<video>`、`<source>`（屬性仍經 sanitize 過濾，例如 `onerror`、`style` 會被拿掉）。其他內嵌 HTML 一樣顯示成文字。原因：底線（Mod-U）、螢光筆與舊的影音快速建立都寫這些標籤，不放行的話既有筆記在網站與匯出上會變成標籤原文、影音不能播；放行就不用改寫任何筆記內容。代價是稍微放寬「公開網站不吃內嵌 HTML」，範圍限於這五個標籤。影音快速建立改寫成 `![名稱](網址)`。
- 會讓使用者看得到的變化（下一次發布後）：網站開始顯示 callouts；數學改由 remark-math + KaTeX 渲染，少數 `$` 的寫法顯示可能不同。W38c 合併時要在 release note 說明。
- 實作順序不變：W38a（一份站點資料）與 W38b（發布預覽）不依賴渲染器，可以先做；W38c、W38d 在後。

## 要回答的三個問題

1. 網站顯示的是**發布當下的快照**，還是**現在的筆記**？
2. Markdown 要不要只有**一個渲染器**？
3. 怎麼讓使用者在按下發布前，看到**實際會發布的結果**？

## 選項比較：呈現模型

**A. 全部即時**：網站永遠渲染目前 `_published` 的筆記，沒有「發布」這一步。
- 好處：最簡單，改了就上線，沒有快照與即時不一致的問題。
- 壞處：打到一半的字也立刻公開；靜態主機仍需要某種「推送」時間點；沒有可回顧的版本。和 Onden「先確認再對外」的原則不合。

**B. 快照為準，下架即時**（建議）：網站顯示的**內容與設定**一律來自最近一次發布的快照；即時資料**只能拿掉東西，不能新增或改變內容**。
- 筆記正文、設定、collections、區塊全部在發布時凍結進快照；改設定也要發布才生效。
- 唯一的即時覆蓋是**下架過濾**：取消發布、空間關掉 publish、刪除、隱藏的筆記立刻消失（現在的 `publishedNodeIds` 過濾保留），連到它的 wikilink 在顯示時變成 inert。這是隱私保證，不能等下次發布。
- 自架 `/site`、分享連結、zip 匯出、靜態主機**全部讀同一份「快照 − 下架」**；`pagesPush` 改用 `loadServedSite` 的結果（同時修正 deploy 文件），下架時也觸發一次推送。
- 媒體：自架維持即時檢查；靜態主機只打包「快照 − 下架」引用到的檔案。

**C. 維持現狀的混合**：不建議。同一個站在自架與靜態主機上可能不同，設定與內容的生效時間不同，使用者無法預測發布後會看到什麼。

## 選項比較：渲染器

**A. 一個共用的渲染管線**（建議）：新增一個前後端共用的模組（例如 `packages/markdown`，或先放在前端、由後端透過建置共用），只定義一次外掛清單 `ondenMarkdown(profile)`：gfm、wikilink（href 策略是參數：網站 `/site/slug/`、App `#wl:`）、callouts、remark-math+KaTeX、上色、frontmatter／區塊 id 清除、嵌入、**唯一一份** sanitize schema。
- 前端：react-markdown 用這份清單；後端：同一份清單接 `rehype-stringify` 產生靜態 HTML（匯出、zip、伺服器端預覽）。
- 只有兩種 profile：`app`（編輯器、卡片、複習、集合、RSS）與 `published`（網站、Studio、發布預覽、匯出）。差別只在 wikilink 策略與是否允許內嵌 HTML，**其他功能兩邊一樣**（網站也有 callouts）。
- mermaid 是前端的漸進增強：靜態 HTML 輸出 `<pre class="mermaid">`，網站載入後再畫。流程圖與狀態圖例外：發布時已在作者的瀏覽器排好版，由伺服器範本畫成 SVG，見 [發布時預先排好的圖表](precompiled-diagrams.md)。
- Puck 區塊在網站上已經走同一個 React `renderPublishedBlock`；後端 `blockRenderer.ts` 改成用共用管線渲染文字欄位，最終目標是 zip 匯出也走 SSR 的 `SiteTemplate`，刪掉第二份區塊 HTML。

**B. 保留兩套、加更多對照測試**：成本低，但每加一個語法（例如 `![[transclusion]]`）就要改兩處、測兩處；差異已經存在而且使用者看得到（callouts）。不建議。

## 選項比較：發布預覽

建議 **「預覽就是候選快照」**：

- 新增 `POST /api/publish/preview`（唯讀，與發布同一個權限）：呼叫和 `buildAndEnqueueSnapshot` **同一個**建構函式產生候選快照（不寫入、不排推送），經過同一套 redaction 與下架過濾，回傳 served-site 形狀的資料，加上：
  - 與目前上線版本的差異：新增、移除、內容有改的筆記；
  - 會變成「(private)」的連結清單；
  - 不會公開或不會打包的圖片；
  - 候選內容的 hash；
  - `left_out`：不會上線、但業主可能想知道的筆記與原因：標了「發布」卻被擋（`hidden`＝隱藏；`space_not_published`＝所在空間未開發布，附空間種類與名稱），以及發布中的空間裡被排除的（`kept_off`＝自己設成不發布；`kept_off_by_parent`＝建立時上層不發布而預設不發布；`blank`＝空白；`saved_article`＝從訂閱存下的文章）。
    與 `publishedNodeIds` 同一條件，只列操作者讀得到的筆記，不洩漏他人私人空間的標題。
    `POST /api/publish` 的回應也帶同一份，所以「發布成功但網站是空的」一定有說明。
    對話框據此給動作：搬到可發布的空間（先顯示搬過去誰會多看到，確認後才搬）或開啟該空間的發布設定；不改新筆記預設在「只有我」。
- Studio 的預覽與「Publish →」確認框都渲染這份資料（用 `published` profile 的同一個 `SiteTemplate`），不再用「所有看得到的筆記」。
- 發布時帶上預覽的 hash；伺服器重建候選快照，hash 不同就回 409「內容在預覽後變了，請重新預覽」。使用者確認的就是實際發布的。

## 建議的實作順序

1. **W38a 一份站點資料**：`pagesPush` 改用 `loadServedSite`；設定與 collections 寫進快照、即時只做下架過濾；修正 `deploy-static-site.md`。測試：自架、分享、zip、靜態 site.json 對同一快照輸出相同節點集合；下架立即從四者消失。
2. **W38b 發布預覽**：`POST /api/publish/preview` + hash 確認；Studio 預覽與確認框改用它。測試：新勾選的筆記出現在預覽；private 連結與不公開圖片列出；預覽後改內容 → 發布 409。
   - 實作（2026-10-14）：差異是跟**上次發布的快照**比，不是跟讀者現在看到的比。下架是立即生效的，所以讀者看到的永遠是候選內容的子集，拿來比的話，「移除」那一欄永遠是空的。
     - 已經下架、這次發布才正式移除的筆記，會標成「讀者已經看不到」。
     - 設定的差異用 canonical JSON 比對，因為 jsonb 會重排 key。
   - Studio 的「發布 →」（標題列、手機分頁、Puck 畫布）一律先顯示預覽，「看看網站」用發布用的 SiteTemplate 畫出候選內容。
   - 編輯中的眼睛按鈕是「草稿預覽（尚未發布）」：顯示即時草稿，方便邊改邊看，畫面上方標明它不是讀者看到的網站。
   - **哪些發布會帶 hash**（2026-10-14，note-0f 確認）：
     - 介面上的每一條發布路徑都先預覽、再帶 hash 發布：Studio 的「發布 →」（標題列、手機分頁、Puck 畫布），以及時間軸的「發布…」（原本的「Snapshot」，它一直是真的發布，現在改名並走同一個預覽）。兩者都用 `usePublishReview`。
     - 曾有的例外「收件匣核准的代理人發布」（不帶 hash）已於 2026-10-31 隨代理的發布工具一起刪除；現在每條發布路徑都是擁有者自己按的。
     - **`preview_hash` 必填**（2026-11-12，依空間發布之後）：`POST /api/publish` 不帶 hash 回 400，不發布。依空間的規則下，一次發布會把發布中空間的所有筆記放上網站，所以沒預覽過的內容不能發出去；舊的 API 用戶端、腳本要先打 `POST /api/publish/preview` 取得 hash。不新增內容的內部重建（`republishSite`，取消發布後的重新部署）不經過這條路，它只用已經發出去的快照重做輸出。
   - 同樣內容一定得到同樣的 hash：候選內容的每個查詢都有完整排序（`created_at` 相同時以 id 決定，標籤列也排序），測試會把有相同時間戳的資料建兩次候選內容來比對。
   - `settings_changed` 也涵蓋只有集合改變的情況。
   - **差異與 hash 用同一份「讀者看得到的內容」**（D80，`modules/website/publishing/siteDiff.ts`）：每則筆記的標題、網址、內文、上層、標籤、它在兄弟筆記間的順序（`moved`），以及它兩端的已發布連結（`links_changed`，Related／反向連結／導覽連結），加上網站設定。hash 只算這些，所以預覽說「沒有變動」時發布不會 409，409 時新預覽一定列得出變了什麼。`updated_at`、原始 `sort_order` 數值、`node_type`、`side_effects` 不算：只有時間戳變了不是變動，也不會讓預覽過期；快照仍存確認當下的 `updated_at`，網站上的日期、sitemap 的 lastmod 和 feed 的 pubDate 都讀它。
3. **W38c 共用渲染管線**：先把前端 `MarkdownRenderer` 的外掛清單抽成 `ondenMarkdown(profile)`，網站開啟 callouts；再讓後端 `md2html` 改用同一份清單，刪除正規表示式版 KaTeX 與重複的 sanitize schema（`sanitizeSchemaDrift` 測試改成單一來源的快照測試）。
   - **已完成（2026-10-14）**：共用管線是 workspace 套件 `packages/markdown`（`@onden/markdown`），說明見其 README。part 1（#135）讓前端走它：`MarkdownRenderer` 用 `profile`（`app`／`published`）取代五個旗標，網站開始顯示 callouts。part 2 讓後端匯出走它：`md2html` 是 `published` profile，`math.ts` 與 `extendedSanitizeSchema` 刪除，sanitize schema 改由套件的快照測試把關。
   - 和設計稿的差異：多了 `math` 選項，只在 RSS 閱讀器關掉（外部文章裡的 `$5 to $10` 是價格）；class 只允許管線自己用的（callout、math、程式語言、`md-`），避免筆記或 RSS 文章借用 App 的 CSS 偽裝畫面。
   - 已知限制：同一畫面有多篇筆記時，註腳 id（`user-content-fn-1`）會重複，連結跳到第一篇；筆記卡片的摘要仍顯示 `> [!tip]` 原文。
4. **W38d**（已由發布改版 P4 完成）：zip 與 Pages 存的是前端 SSR 的同一份 HTML，`blockRenderer.ts` 與 `staticBuilders.ts` 已刪除。

每一步都可以單獨合併；W38a 與 W38b 不依賴渲染器的整併。

## 不在這份範圍

- 網站版本歷史與回滾（快照已有歷史，介面另議）。
- `![[...]]` 嵌入（transclusion）：等共用管線完成後只需實作一次。
- RSS feed 目前只取第一段，不渲染 Markdown；共用管線完成後可以輸出全文。

## 讀者功能：連結預覽、連到這裡的那一句、閱讀時間、分享圖（feat/site-reading）

都在同一份 SSR 頁面裡完成，不打 API，所以 zip 與 GitHub Pages 副本一樣能用。

- **連結預覽**（`frames.article.preview`）：文章頁帶一段 `<script type="application/json" id="s-previews">`，
  只放「這一頁連到的、且在網站上的筆記」（內文連結 + 連到這裡的來源，最多 50 篇），以筆記 id 為鍵；
  內文與「連到這裡」的連結帶 `data-note`，`SitePreview.astro` 的小腳本據此取卡片。
  文字（更新日、閱讀時間）在伺服器端就依網站語言組好，腳本沒有自己的字串。
  卡片的「打開這篇」用觸發連結自己的 `href`，副本裡是相對路徑，不必在 JSON 裡改寫。
- **連到這裡的那一句**：`backlinksOf` 回傳 `{ node, places }`；句子由 `@onden/markdown` 的 `linkPlaces`
  從來源筆記的 Markdown 取出（段落或清單項、去語法、連結字標 `<mark>`、約 80 字）。
  `![[…]]` 內嵌在發布時已變成 `[[…]]` 連結，所以伺服器端的 `serveDrawingEmbeds` 把「變成連結的內嵌」本文留在
  節點的 `embeds`，頁面才分得出「內嵌了這篇的一段」與一般連結。
- **閱讀時間**（`frames.article.readingTime`）：`readingMinutes`，中日韓字 ÷ 400 + 其他字詞 ÷ 200，至少 1，程式碼區塊不算。
- **分享圖**：文章第一張圖（`coverImage`）→ `og:image`（絕對網址）＋ `summary_large_image`；沒有就用網站標誌；
  再沒有就維持小卡片。靜態副本換主機時，`retargetStaticSite` 把 `og:image` 換成新網址的 `media/…`。
  **沒有做「自動產生 1200×630 的圖」**：repo 沒有 CJK 字型檔（只有 Fraunces／Plex），要產生中文標題必須新增
  數 MB 的 Noto Sans TC 與 resvg，並在發布時為每篇產圖、再讓副本爬進去，超出本批範圍。
- **不洩漏**：頁面只由「已在網站上的節點與邊」組成（`servedSite.applyTakedown`）；預覽資料、連到這裡、head 都從同一份節點算，
  沒有另一條取得筆記的路。測試：`siteReading.test.tsx`。

截圖（本機 SSR + 假 API，Chromium 桌面與手機尺寸，非真機）：
（截圖未隨公開庫附上：桌面懸停卡片）、
（截圖未隨公開庫附上：手機底部卡片）、
（截圖未隨公開庫附上：連到這裡的那一句）。

## 手寫筆記自己的那一頁（feat/site-handwriting-page）

已發布的手寫筆記（有 `ink_data`、不是 PDF）在自己的頁面上畫出手寫。做法跟 `![[手寫]]` 嵌入走同一條路，一樣是「發布時凍結、提供時再變成內文」：

- **發布**（`publishing/handwritingPages.ts prepareHandwritingPages`，由 `buildCandidate` 呼叫，只讀已發布集合）：節點上只記 `ink_pages`（每頁一個 `/api/media/ink-<雜湊>.svg`）。**這一步不畫圖**：一萬筆的手寫約 2 秒、17 MB，而 `buildCandidate` 每次預覽、發布、分享選單狀態都會跑。檔名由「畫法版本號（`INK_PAGE_RENDER_VERSION`）＋工作區＋筆記＋`ink_data` 的雜湊＋頁的 key」而來，所以不用畫就知道名字，同一份手寫重複發布也是同一個檔；候選快照只帶每個檔的 `render`（`Candidate.handwritingPages`），圖不進快照。
- **存檔**（`storeHandwritingPages` → `services/media.ts storeGeneratedMedia`）：檔案不存在才畫，畫完原子寫入並記成那篇筆記的媒體。預覽（交易外）、發布路由與核准後的發布（`warmHandwritingPages`，交易外）都會先存好，所以發布交易裡通常只剩寫一列資料。改畫法就要升 `INK_PAGE_RENDER_VERSION`（`handwritingPage.test.ts` 釘住一張固定圖的雜湊，沒升會失敗）。
- **回收**：發布記好新快照後，`forgetReplacedPages` 把這個工作區中新快照沒有用到的 `ink-*.svg`（改過手寫留下的舊檔、預覽產生但沒發布的檔）忘掉，走 `services/media.ts removeMediaFiles`（與永久刪除共用同一個「刪紀錄、提交後刪檔」）；永久刪除筆記時 `purgedContent` 也把這篇擁有的檔案列入，一起收掉。
- **提供**（`serveHandwritingPages`，在下架過濾之後、與預覽）：`ink_pages` 變成內文後面的 `![][ink-page-N]`，其位址 `/api/media/….svg#ink-page-N` 帶穩定記號（`@onden/markdown` 的 `handwritingPageMarkdown`／`handwritingPageNumber`），之後就是一般 Markdown 圖片，網站、RSS、分享連結、zip、靜態主機都不必認識手寫。alt 不寫在伺服器：它依網站語言，由網站的 renderer 產生（`siteLocale` 的 `handwritingPage`）。預覽與發布後一樣用網址讀圖（預覽的圖只有能讀那篇筆記的人打得開），回應不再內嵌每頁約 22 MB 的 base64。
- **下架即時**：圖是媒體檔，能不能讀走 `canReadMedia` → 擁有筆記是否仍在網站上（`snapshot_media`），所以下架後頁面與圖片網址同時消失；靜態主機打包時用同一個檢查（`mediaBundle.ts`）。私人筆記不在已發布集合裡，筆畫不會進快照。
- **畫法**：每頁是整張紙（寬 1000、從 x=0 起，高度到最後一筆再留邊，最多到頁高），底色固定淺色紙（`INK_PAPER_COLOR`）。筆跡顏色是照淺色頁存的（深色模式在畫面上才反相），所以紙一律淺色；紙畫在 SVG 裡，不靠 CSS，RSS 閱讀器、zip 與靜態主機看到的一樣。
- **頁面**：`MarkdownRenderer` 只在收到 `handwritingAlt`（網站的 `makeSiteMarkdown` 才傳）時認得位址上的記號，加上 `md-image--ink-page`（`MarkdownRenderer.css` 讓它滿寬、頁間留距）並給網站語言的 alt；App 的 renderer 與使用者自己寫的圖不受影響。網站上所有圖片本來就是 `loading="lazy"`，所以第二頁起是 lazy。RSS 內文只放第一頁（`withoutHandwritingPages`），alt 同樣依網站語言；文章封面與分享圖不取手寫頁（SVG 不是分享圖，也避免跟內文重複）。搜尋索引只讀標題與文字，圖片沒有文字，不受影響。
