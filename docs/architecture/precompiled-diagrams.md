# 發布時預先排好的圖表

> 狀態：現行（最後確認 2026-11-02）。範圍：mermaid 流程圖（`flowchart`／`graph`）與狀態圖（`stateDiagram`／`-v2`）。
> 序列圖、甘特圖、圓餅圖等其他類型這版不支援，照舊由讀者的瀏覽器畫。

## 問題與決定（業主 2026-11-02）

發布網站的 ```` ```mermaid ```` 以前是讀者打開網頁才下載 mermaid 並現場畫：手機慢、頁面重、沒 JS 看不到圖。
決定：**在按「發布」的那個瀏覽器裡排版，只把資料送上去，伺服器用自己的範本畫成 SVG。** 伺服器不執行任何東西
（不開無頭瀏覽器、不跑使用者程式）；沒有伺服器的瀏覽器試用版也能用，因為排版本來就在瀏覽器。

## 兩種設計草圖

| | A. 上傳畫好的 SVG，伺服器清洗後存 | B. 上傳結構化資料，伺服器自己畫（採用） |
| --- | --- | --- |
| 上傳內容 | mermaid 在瀏覽器畫出的 SVG 字串 | 節點／線／群組框的幾何與純文字 |
| 伺服器要做 | 清洗任意 SVG（屬性、樣式、`<style>`、`url()`、外部引用、CSS 注入…） | 驗證資料；用固定範本輸出 |
| 攻擊面 | 清洗器的每個漏洞都是儲存型 XSS | 輸出的元素與屬性是範本寫死的清單，作者的值只進屬性值或文字節點並跳脫 |
| 亮暗主題 | SVG 內嵌 mermaid 的色彩，要另做換色 | 只有 CSS class，顏色用網站既有變數，自然跟主題 |
| 逐步圖補間（第 3 層） | 要從 SVG 反解座標 | 節點本來就有穩定 id 與座標 |

選 B：A 的安全性取決於一個要涵蓋整個 SVG／CSS 的清洗器，B 把問題縮成「檢查數字與純文字」。

「何時產生」也比較兩種：

- **發布請求帶資料（採用）**：預覽回答「還缺哪些區塊的排版」（`diagrams_needed`），App 排好後隨 `POST /api/publish` 送出。
  走既有的發布寫入路徑與權限，沒有另開的上傳入口。
- 另開 `PUT /api/diagrams` 預先上傳到資料表：要新的權限檢查、新遷移、清理孤兒資料；而且「何時算過期」要另外管。不採用。

## 契約

資料格式與驗證**只有一份**，在 `@onden/markdown`（`diagramLayout.ts`、`diagramSvg.ts`），前端排版、後端驗證、網站重畫共用：

```ts
type DiagramLayout = {
  version: 1; kind: "flowchart" | "state"; width: number; height: number;
  groups: { id; x; y; w; h; label }[];                    // 群組框／複合狀態（中心點＋尺寸）
  nodes:  { id; shape; x; y; w; h; label }[];             // shape 從固定清單：rect round stadium diamond circle hexagon start end
  edges:  { id; from; to; path; line; arrow_start; arrow_end; label; label_x; label_y }[];
};
type PrecompiledDiagram = { source: string; layout: DiagramLayout };   // source = 該區塊原文，也是頁面查找的鍵
```

- **鍵**：區塊原文本身（去掉縮排與結尾換行，`mermaidSources` 與兩個渲染器讀法一致）。頁面用完全相同的文字查找，所以瀏覽器端不需要雜湊；
  `version` 改了，舊資料驗證不過，自然重算。這取代了「原文＋排版版本的雜湊」：效果相同，少一個雜湊步驟。
- **存哪**：每個快照的 `payload.diagrams: PrecompiledDiagram[]`。**不需要新資料表、不需要遷移**（沒有占用遷移編號）。
  上一個快照的清單就是快取：原文沒變的區塊，下次發布不必重新排版；有新排版就用新的。每次發布只保留還在頁面上的區塊。
- 節點／線的 `id` 取自 mermaid 自己的名稱（`A`、`L_A_B_0`、`state-Still-1`），同一個圖在不同次發布穩定。
- 前端 `lib/diagramPrecompile.ts`：`precompileDiagrams(sources, budgetMs = 8000)` 以 `htmlLabels: false` 讓 mermaid 排版，
  只讀回幾何與文字（用 SVG 的矩陣換算，不依賴 mermaid 的內部結構），**畫出來的 SVG 丟棄不送**。mermaid 用到才載入，不進開機 JS。
  有時間上限；逾時的區塊不帶資料。

## 安全模型

上傳的結果不可信（任何人都能繞過 App 送假資料、帳號可能被盜、之後會給朋友用或別人自架）。防的是儲存型 XSS。

1. **只收資料**。`validateDiagramLayout` 檢查型別、範圍、長度、數量：形狀／箭頭／線型只能是清單內的字；`id` 只允許 `[A-Za-z0-9_.:-]{1,64}`
   且不重複；座標有限且在範圍內；線的 `path` 只允許絕對的 `M L C Q Z` 加數字（不接受相對指令、弧線、指數、任何其他字元）；
   線的兩端必須是存在的節點或群組。**任何一項不合格，整個圖不收**（只是那個圖，其他圖與發布本身照常）。
   輸出時伺服器只回傳重組後的已知欄位，未知欄位不會通過。
2. **SVG 由伺服器的範本畫**（`diagramSvgTree`）。元素只有 `svg g rect ellipse circle polygon path text tspan`，屬性只有
   `viewBox width height role class x y rx ry cx cy r points d text-anchor dominant-baseline dy`。
   沒有 `foreignObject`、`script`、`style` 屬性、`on*`、`href`、`url(`；箭頭用 `polygon` 畫，不用 `marker`／`url(#…)`。
   作者的值只進屬性值（轉成數字或固定清單）或文字節點，由 React／hast 序列化器跳脫。
3. **既有兩道防線不放寬**：`rehype-sanitize` 與發布 CSP 都沒有改。圖表在 sanitize 之後、由受信任的範本插入，與影片、frozen query 區塊同一類。
4. **大小上限**（`DIAGRAM_LIMITS`）：每圖 ≤100 節點、200 線、30 群組、標籤 200 字元／6 行、路徑 4,000 字元、原文 20,000 字元、
   排版 JSON 200 KB；一次發布 ≤50 個圖。超過 50 個的請求整份以 400 拒絕（信封檢查）。
5. **對答案**：每個節點、線、群組的標籤，逐行都必須出現在該區塊原文裡；標籤不得含像 HTML 標籤的字串或控制字元
   （`x > 5` 這種單獨的比較符號可以，因為輸出一律跳脫）。上傳的原文本身也必須是已發布筆記（經過同樣的隱私處理後）裡真有的區塊，
   否則不收——這同時避免有人用這個入口把任意文字塞進公開快照。
6. **出錯就退回**（見下）。
7. **寫入走既有發布路徑與權限**：`POST /api/publish` 本來就要站台管理員（`siteAdmin`，`resolveCurrentActor` 取當下角色）；沒有發布權限的人送出的圖表請求直接 403，什麼都沒存。
   `diagrams_needed`（預覽的回覆）也只給管理員。
8. **下架即時生效**：快照裡的圖表帶著區塊原文，所以 `loadServedSite` 的下架（`applyTakedown`）也會把圖表只留給仍在站上的區塊（`keepServedDiagrams`）；
   頁面讀取時（`readSiteData`）再驗證一次，被竄改的快照也只畫通過檢查的。

「惡意上傳」測試集：`markdown/src/test/guards/diagramUpload.guard.test.ts`（拒絕清單＋被接受的圖經允許清單 sanitize 後不變、無 `script`／`on*`／`href`／`url(`）；
伺服器整合：`backend/src/test/publishDiagrams.integration.test.ts`。

## 退回

沒有預先編譯資料、資料不合格、類型不支援、區塊在清單或引用裡找不到、排版逾時、舊伺服器沒有 `diagrams_needed`：
該區塊照舊——網站載入 `SiteDiagrams.astro` 的讀者端 mermaid，程式碼可讀、語法錯誤時仍是程式碼。
`usesDiagrams(nodes, diagrams)` 現在只在「還有區塊沒有排版」時才為真；**全部都有排版的網站不再帶 mermaid**。
圖的樣子與 mermaid 預設主題不完全相同（顏色跟網站主題、字體用網站字體），也不畫 mermaid 的形狀裡路徑繪製的幾種（體育場形、圓柱、平行四邊形等）：
讀回時遇到不認得的形狀就放棄整個圖、退回讀者端，寧可不預編也不畫錯。

## 沒有瀏覽器參與的重新發布

由伺服器或 MCP 代為發布（核准的 agent 請求、排程重發）時沒有瀏覽器可以排版：`candidateDiagrams` 只用**上一個快照的快取**，
原文沒變的區塊保留排版，新的或改過的區塊暫時退回讀者端，下次有人從 App 按發布時補上。取消發布造成的重發不建新快照，只是下架，圖表一起被濾掉。
匯出（單篇 HTML、zip）：單篇 HTML 匯出若區塊原文與網站快照一致就畫出靜態圖，否則仍是 `<pre class="mermaid">` 原文；zip／Pages 收的是網站伺服端算繪的 HTML，所以跟網站一致。編輯器不變，筆記原文不變。

## 之後給逐步圖補間用的延伸（第 3 層，尚未實作）

樹／圖的補間動畫需要「每一步的節點座標」。此格式已有穩定 `id` 與座標，所以做法是在發布時，對逐步圖每一步各排一次版，
各存一個 `DiagramLayout`（同一份 `version`），節點以 `id` 對應，網站只在兩組座標間內插。不需要改驗證器，只要加「步驟」的外層清單與數量上限。
