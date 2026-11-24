# 提案：PDF 劃線和 RSS 劃線是同一個機制（摘錄）

> 狀態：提案（2026-11-17）。**只寫文件，加兩個把「今天的行為」釘住的測試；不含產品程式、不含 migration。** 另外改了三份既有文件：`docs/decisions/reading-rss-excerpts.md`、`docs/architecture/excerpts.md`（依業主 2026-11-17 的落點決定改「放哪」，標明尚未實作）、`pdf-pages-in-note-2026-11-16.md`（§2.5 `ensureContentTab` 那一列加註被 4.5 取代）。
> 完成後：docs/architecture/excerpts.md
> 起因：業主 2026-11-17：「兩種劃線是一個機制」；規則：每一類問題一個機制、不做權宜之計、不重複邏輯。
> 追加（2026-11-17／18，PR 留言）：業主決定「存的時候不問放哪」，見 **4.5 落點**。
> 上層：[閱讀只留 RSS；摘錄模型](../../decisions/reading-rss-excerpts.md)（2026-10-18：PDF 劃線預設是筆記裡可引用的段落，可隨時升級成子筆記；RSS 那一半已做、PDF 這一半沒做）、
> [摘錄](../excerpts.md)、[PDF 是筆記自己的頁面](pdf-pages-in-note-2026-11-16.md)（2026-11-16 提案，本文的前置之一）。
> **沒有對任何正式伺服器跑過任何東西；下面「查證」之外的說法都是設計，沒有原型。**

## 0. 一段話

RSS 劃線寫成「引用 + 帶連結的來源行」放在筆記**內文**，段落靠錨點（`block_anchors`）認身分；PDF 劃線卻是 `ink_data` 信封裡的**位置紀錄**，
文字和座標都不在內文，所以不能嵌入、不能升級成子筆記、搜尋與 AI 都看不到「我劃了什麼」。
兩者其實是同一件事：**一段別人的文字 + 它在原文的位置**。差別只在「位置怎麼寫」：網頁用文字片段（`#:~:text=`），PDF 用頁碼加同一種「引文選取」（精確文字 + 前後文）。
建議（第 4 節）：PDF 劃線也寫成摘錄放進 PDF 筆記內文，來源行寫 `檔案網址#page=頁碼`；**不另存座標**，畫面上的螢光色塊由「在該頁文字層找到這段引文」算出來；
這個「依引文找位置並標出來」的函式，同時是 RSS「閱讀頁依網址標出已劃段落」（`excerpts.md` 的「之後」）需要的同一個函式。
前提是先把抽出的全文移出內文（2026-11-16 提案的 `pdf_text`），而且要先量一次「找得回來」的比率才動任何使用者資料。

## 1. 起始事實的查證（2026-11-17，`origin/main` f1cce6e）

| # | 說法 | 我查的地方 | 結果 |
| --- | --- | --- | --- |
| 1 | 2026-10-18 決定：PDF 劃線預設是筆記裡可引用的段落，可升級成子筆記；RSS 做了、PDF 沒做 | `docs/decisions/reading-rss-excerpts.md`（「決定」「相關檔案與狀態備註」） | 屬實。檔裡寫的是「`^id` 段落」，但現行做法是**錨點不在文字裡**（見 5），所以「可引用」現在指「有錨點的段落」 |
| 2 | 摘錄＝引用區塊，最後一行是帶連結的來源行，靠段落錨點認身分；`excerptBlock` 只有 `rssQuote.ts` 呼叫 | `packages/markdown/src/excerpt.ts` 檔頭與 `excerptBlock`／`parseExcerpts`；`grep -rn excerptBlock packages`：產品程式只有 `modules/rss/rssQuote.ts`，其他是 `core.ts` 的匯出與測試 | 屬實。注意 `excerptBlock` 現在會**把來源網址原有的 fragment 換成 `#:~:text=`**（`excerpt.test.ts` 已釘「drops the page's own fragment」），所以它還寫不出 `#page=12`；`parseExcerpts` 對沒有文字片段的來源行照常讀（本次新增的測試釘住，見第 7 節） |
| 3 | PDF 劃線今天是 `ink_data` 信封的 `annotations`，舊的在唯讀屬性 `pdf_annotations`；不能被引用或變子筆記 | `lib/pdf/coords.ts`（`PdfHighlightRecord`）、`lib/pdf/pdfAdapter.ts`（`decodePdfInk` 把舊屬性折進信封、不再寫它）、`components/pdf/PdfHighlights.tsx`（只畫半透明方塊）、`components/PdfNodeView.tsx`（`addHighlight` → `commit` → 整份信封存回） | 屬實，另外發現**第三個東西**：按「→ 卡片」（`OverviewEditor.tsx` `spawnHighlightNode`）會另開一則子筆記，內文是 `> 文字\n\n— page N`（**複製**一份文字），帶屬性 `pdf_page` 與一條 `highlight_source` 邊連回 PDF 筆記；這張卡和那筆位置紀錄之間**沒有 id 相連** |
| 4 | PDF 筆記內文是抽出的全文；2026-11-16 提案要改放隱藏屬性 `pdf_text` | 你寫的 `createPdfNote`／`lib/pdf/pdfNote.ts` **不存在**；實際是 `OverviewEditor.tsx` 的 `uploadPdfAsNode`：`extractPdfText(file)`（`lib/pdf/extractText.ts`，上限 6 萬字）→ `noteWriter.create({ markdown, attributes:[pdf_url] })`。提案：`pdf-pages-in-note-2026-11-16.md` §2.4 | 屬實（只是函式名不同）。那份提案 §2.4 已決定採 `pdf_text`，業主 2026-11-16 同意方向 |
| 5 | 段落身分是錨點不是 `^id`；區塊可變子筆記；手寫有「引用一塊區域」 | `excerpt.ts` 檔頭（「the text carries no id」）、`backend/src/services/blockAnchors/store.ts` 的 `anchorExcerpts`（寫入時替每個摘錄形狀的引用補錨點）、`backend/src/services/blockChildNote.ts`（`moveBlockToChildNote`：區塊→`![[子筆記]]`，引用它的連結跟著走）、`packages/markdown/src/inkRegion.ts`（`![[筆記\|ink=頁@x,y,w,h]]`） | 屬實。`inkRegion.ts` 的頁 key 只准 `[A-Za-z0-9_-]`，**寫不進 `pdf:3`**（2026-11-16 提案也提到） |

## 2. (a) 今天兩種劃線並排

| | RSS 劃線（摘錄） | PDF 劃線（位置紀錄） |
| --- | --- | --- |
| 存在哪 | **你的筆記內文**（預設今天的日記）裡一段 Markdown：`> 原文\n>\n> — [標題](網址#:~:text=前-,原文,-後) · 訂閱名`；身分是 `block_anchors` 一列 | **PDF 筆記的 `ink_data` 屬性**，信封的 `annotations`：`{id, type: text/area, content.text, position}`；舊的在 `pdf_annotations`（唯讀、啟動時折進信封）。座標是「劃下當時的畫面像素 + 當時頁寬高」（`Scaled`），畫的時候照比例換算 |
| 怎麼顯示 | 編輯器／預覽裡的一段引用；嵌入處連來源行一起顯示 | 在該頁上疊半透明色塊（`PdfPageHighlights`）；不在內文、不在任何清單 |
| 跳回原處 | 點來源連結，一般瀏覽器依文字片段直接捲到那段。**App 內**「打開 RSS 文章時標出已劃段落」**還沒做**（沒有「網址→摘錄」索引，`excerpts.md`「之後」） | 在 PDF 裡本來就看得到色塊。從別處跳回：只有「→ 卡片」有 `pdf_page` 屬性＋邊可用；**一般劃線沒有從別處跳回的入口** |
| 在別處引用 | 可：`![[筆記#^id]]`（或 `![[筆記/開頭幾個字]]`）嵌入，不複製文字 | **不可** |
| 變成筆記 | 可：同一個「區塊→子筆記」（`moveBlockToChildNote`），引用它的連結跟著走（對摘錄形狀的區塊是否有特例沒有逐一測，列在第 6 節驗收） | 只有「→ 卡片」：**複製**文字另開一則，與劃線紀錄無 id 關聯，之後兩邊各自改 |
| 搜尋 | 內文就是文字：找得到 | 找不到「我劃了什麼」；找得到的是**整篇 PDF 的全文**（因為抽出的全文放在內文） |
| AI 讀得到 | 讀筆記內文就讀得到 | 讀不到：`agentTools/getNode.ts` 把墨水屬性與 `pdf_annotations` 濾掉（第 74 行）；AI 讀到的是 PDF 全文 |
| 發布到網站 | 筆記有發布時內文一起；嵌入摘錄時只展開那一段（`excerptEmbeds.ts`） | 筆畫與文字框有手寫頁的輸出；劃線色塊我**沒有查**是否出現在發布版（`handwritingPages.ts` 沒看到 PDF 劃線的處理，未逐行確認） |
| 匯出 | 內文 Markdown；嵌入處展開成「引用＋來源連結」（`withExcerptsExpanded`） | `exportInk.ts` 對 PDF 筆記只畫筆畫與頁面文字框成 SVG，**不畫劃線色塊**；`exportZip.ts` 把 `ink_data` 當資料屬性帶出（原始紀錄在，但別的軟體讀不懂） |
| 備份 | 跟筆記內文一起（`block_anchors` 是否在備份清單我沒查） | `ink_data` 的當前值在備份裡（`backupFidelity.integration.test.ts` 有測；墨水歷史不在） |
| 兩台裝置同時劃 | 各自在內文**尾端附加一段**，走內文三方合併（`threeWayMergeBody`）。**本次新增的測試證實**：兩邊各加一段摘錄，不論誰先誰後都乾淨合併、兩段都留、兩段都還讀得成摘錄（`bodyMergeExcerpts.test.ts`） | 走 `mergeInk`：`annotations` 逐筆（依紀錄 id）三方合併，兩台各劃各的乾淨合併；同一筆兩邊都改才回報衝突（`ink.ts` 約 296–301 行）。代價：`ink_data` 是 MB 級、開機不載（`BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS`），每劃一筆就是整份信封的一次存檔 |

**兩邊的缺口互補**：RSS 劃線有「身分、引用、搜尋、AI、匯出」但「App 內標回原文」未做；PDF 劃線有「標回原文（色塊）」但沒有身分與引用。
一個機制要同時補上兩邊缺的。

## 3. (b) 一個機制：三種設計

先定共同詞彙（三案相同）：**摘錄**＝一段別人的文字（`exact`）＋它在原文的位置。位置分兩半：
**哪一份原文 + 哪一頁**（網頁用網址；PDF 用檔案網址加 `#page=N`），和**那一頁裡的哪一段**（W3C Web Annotation 的 TextQuoteSelector：`exact` + `prefix` + `suffix`，`excerpt.ts` 已經存了這三個）。

### 3.1 A：每個 PDF 劃線寫成摘錄放進 PDF 筆記內文，位置紀錄（頁＋矩形）另存、用錨點 id 對起來（業主 2026-10-18 的原話）

契約：

```ts
// 寫：一個領域操作，說的是使用者要做的事
highlightPdfSelection(noteId, { file, page, exact, prefix, suffix, rects }): Promise<{ anchorId: string }>
//   = 在 PDF 筆記內文附加 excerptBlock(...)（與 RSS 同一個附加函式），
//     再把 { [anchorId]: { page, rects } } 寫進隱藏屬性 pdf_marks
// 讀：畫面 = parseExcerpts(body) 配 pdf_marks[anchorId].rects
```

呼叫範例：`await highlightPdfSelection(pdfNote.id, { file: pdfUrl, page: 12, exact, prefix, suffix, rects: selectionRects })`。

要先成立的事：**抽出的全文不能再在內文**（`pdf_text`，2026-11-16 提案）。否則內文有 6 萬字機器文字，摘錄附加在它後面、
每次內文合併與錨點重算都帶著它，使用者一打開「內容」就看到一大段不是自己寫的字。同時要有一個地方看劃線（因為 2026-11-16 決定新 PDF 筆記一開始沒有「內容」分頁）：PDF 檢視器旁加「劃線清單」，內容是 `parseExcerpts(body)`。

兩個現有儲存變成：`annotations` 的 text／area 紀錄**搬走**（劃線變摘錄＋`pdf_marks`）；`ink_data` 只剩筆畫與頁面信封；`pdf_annotations` 不再讀。「→ 卡片」變成 `moveBlockToChildNote(摘錄的錨點)`，`pdf_page` 屬性與 `highlight_source` 邊不再需要（到時再查還有誰讀）。

缺點：**又是兩個儲存**（內文的段落＋`pdf_marks`）靠錨點 id 對起來，要維持一致：刪掉段落留下孤兒矩形、兩台裝置各改一邊、`pdf_marks` 要有自己的合併規則（又一個 `MERGED_KEYS`）。這正是今天「卡片與紀錄各管各的」那種結構，只是換了位置。優點：座標原樣保存，搬舊資料不損失任何位置。

### 3.2 B：劃線維持位置紀錄；只有人要「引用」時才寫摘錄

契約：`quotePdfHighlight(noteId, recordId, { into: noteId })`：讀紀錄的文字與頁，寫一個摘錄到目標筆記。呼叫範例：在色塊上按「放進筆記」。

兩個儲存：紀錄（位置，不在內文）＋摘錄（引用過的才有），**紀錄與摘錄之間沒有 id 相連**（同一段被引用兩次就有兩份，紀錄被刪也不影響摘錄）。
不改動既有資料，搬遷成本最低、不需要 `pdf_text`、開機不變。但**沒有解決業主點的問題**：「劃線」仍分成兩種東西（沒被引用的是紀錄、被引用的是摘錄），
搜尋、AI、匯出對「只劃線沒引用」的段落依舊看不到；這等於把今天的「→ 卡片」重做一次。**不建議**，留在這裡是為了說明為什麼不選。

### 3.3 C：劃線就是摘錄；不另存座標，色塊由「在該頁找到這段引文」算出來（建議）

契約（三處小改，沒有新儲存）：

```ts
// ① @onden/markdown excerpt.ts：來源行的位置多一種寫法
//    — [論文標題](/api/media/paper.pdf#page=12:~:text=前文-,引文,-後文) · 第 12 頁
//    excerptBlock(quote, source, untitled?)   source 多一個 page?: number；有 page 時 fragment = `#page=N` 接同一段 text directive
//    Excerpt 多一個 page: number | null；parseExcerpts 認 `:~:text=`（目前只認 `#:~:text=`）
// ② lib/pdf/locateQuote.ts（新，純函式，不 import pdfjs）：
//    locateQuote(pageItems: {str, rect}[], { exact, prefix, suffix }): Scaled[] | null   // 找得到回傳色塊矩形，找不到 null
// ③ lib/data（與 RSS 共用的附加函式，從 modules/rss/rssQuote.ts 搬出）：
//    appendExcerpt(noteId, source, quote): Promise<AppendResult>     // 已有 `appendToNote`
```

呼叫範例：

```ts
// 劃線（PdfNodeView 按「劃線」）
await appendExcerpt(pdfNote.id, { title, url: pdfUrl, page: 12, feed: "" }, { exact, prefix, suffix });
// 畫色塊（每頁文字層載好時）
const marks = excerptsOfPage(body, pdfUrl, anchors).filter((e) => e.page === n)
  .map((e) => ({ id: e.id, rects: locateQuote(items, e) }));
// 找不到（掃描檔、文字被改）：跳到該頁，並在頁首顯示一條引文，不假裝有色塊
```

**來源連結是什麼**：`/api/media/<檔名>#page=<頁>`。理由：(1) 與 RSS 一樣是「網址標出原文」，`sameExcerpt`（同網址去 fragment + 同文字）直接可用，本次新增測試釘住這點；
(2) `#page=N` 是 PDF 的標準開啟參數，用瀏覽器直接開這個檔就是那一頁（**我沒有在瀏覽器驗證，也沒驗證 `:~:text=` 接在後面時 PDF 檢視器是否忽略它**，列為第 5 節問題 3）；
(3) 檔案永遠不被改（2026-11-16 提案已定），所以頁碼不會漂移；(4) 匯出的 Markdown 帶著它，離開 Onden 還是看得懂。

**怎麼跳回頁與色塊**：從 `(筆記, 錨點 id)` 讀出那一段 → 讀 `page` → PDF 檢視器捲到那頁 → `locateQuote` 畫出色塊並閃一下。**頁碼在摘錄裡，所以不需要座標就能跳到頁**；座標只是畫色塊用，而色塊是算出來的。
從別的筆記 `![[PDF筆記#^id]]` 嵌入看到的摘錄，點來源行走同一條路（嵌入已知道是哪則筆記與哪個錨點）。

**兩台裝置同時劃**：與 RSS 相同（本次測試已釘）：各自在內文尾端附加一段，內文三方合併兩段都留。不需要新的合併規則（A 需要）。
殘留風險是「同一行兩邊只加字」的合併規則（`body-merge-same-line-2026-11-13.md`，提案中）：附加是新行，不在那條路徑上，但摘錄是多行、行與行相同（`>`），我只測了兩段不同引文，沒測「兩台劃**同一段**」會不會產生兩段重複（列在第 6 節測試；`excerpts.md` 的「不重複」只管這台裝置）。

**要先成立的事**：同 A（`pdf_text` 移出內文、劃線清單），另加：
- `appendToNote` 與 `bodyOf` 現在在 `modules/rss/rssQuote.ts`；PDF 不該 import RSS 模組，先搬到共用的 `lib/data`（RSS 也改用，不留兩份）。模組互相 import 是否被 ESLint 擋我沒查，搬出去是不管有沒有擋都對的做法。
- **面積劃線（沒有文字的框選）不是文字，沒有 `exact`**。它是「一塊頁面區域」，和手寫的「引用一塊區域」（`inkRegion.ts`）同一類，建議第 4 步一起處理，不在這一案假裝解決（見 §5 問題 4、§6 第 4 步）。
- 「→ 卡片」變成 `moveBlockToChildNote`。升級後摘錄跑到子筆記裡，PDF 檢視器要仍能畫出色塊：先在本機掃「PDF 筆記內文＋它的子筆記」找摘錄（RSS 的 `existingExcerpt` 也是本機掃）；之後由「網址→摘錄」伺服器索引取代（RSS 的「之後」要的是同一個索引，**一次做、兩邊用**）。

兩個現有儲存變成：`annotations` 的 text 紀錄 → 摘錄，色塊改算；area 紀錄 → 區域引用（第 4 步）；drawing／shape 紀錄**不動**（那是筆畫，不是劃線）；`pdf_annotations` 不再讀；`pdf_page`／`highlight_source` 邊隨「→ 卡片」改為區塊升級而不再需要。

缺點：**色塊靠「找得到引文」**。文字層與抽出文字的差異（連字、斷行連字號、雙欄閱讀順序、掃描檔沒有文字層）會讓找不回，這是真實風險，要先量（第 6 節第 1 步）。

### 3.4 三案對照

| | A：摘錄＋另存座標 | B：紀錄＋引用才寫 | **C：摘錄＋色塊算出來** |
| --- | --- | --- | --- |
| 解決「一個機制」嗎 | 部分：內文＋`pdf_marks` 兩個儲存要對齊 | 否：仍兩種東西 | 是：只有摘錄；位置是引文選取（與 RSS 同一個） |
| 刪掉什麼 | 紀錄 text／area、`pdf_annotations` 讀取 | 無 | 同 A，另外 `pdf_marks` 根本不存在 |
| 舊資料搬遷 | 無位置損失；內文會多出摘錄，`ink_data` 要改寫 | 不搬 | **有位置損失風險**（找不回的要保留原座標，見下節）；內文多摘錄，`ink_data` 要改寫 |
| 來源連結 | `檔案#page=N`，座標在 `pdf_marks` | 無（引用才寫） | `檔案#page=N:~:text=…` |
| 兩台同時劃 | 內文合併＋`pdf_marks` 新合併規則 | 同今天 | 內文合併（已測） |
| 開機包 | `pdf_marks` 若不放「開機不載」清單會進開機；其餘延後載入 | 無 | 無新屬性；`locateQuote` 在 PdfNodeView 的延後載入包；`excerpt.ts` 多一個欄位的解析，預估不到 1 KB gzip（**沒量**）。`check-boot-bundle.mjs` 的預算只准調低，2026-11-16 提案引用的審查說「剩約 3.7 KiB」，實作前要重量 |
| 風險 | 兩儲存不一致 | 不解決問題 | 找不回引文 |

## 4. (c) 建議：C，而且先量再動資料

選 **C**，理由：業主要的是「一個機制」，C 是唯一**不新增儲存**的做法——位置本來就是引文選取，RSS 已經在存。A 把今天「紀錄與卡片各管各的」搬到「段落與 `pdf_marks` 各管各的」，B 沒解問題。
C 還有一個 A 沒有的好處：`locateQuote` ＋「某來源的全部摘錄」讀取，**正是 RSS 的「閱讀頁標出已劃段落」要的功能**；做 C 等於順手把 RSS 那一半的缺口補成同一份程式。

C 的風險（找不回引文）靠流程管：**第 1 步只量不改資料**（對業主指定的 PDF，唯讀跑 `locateQuote` 對照舊座標，算「找得回、位置重疊」的比率）。
比率夠高就繼續 C；不夠，**退到 A 的子集**：只替「找不回」的那幾筆保留座標，存成**可重建的快取**（不是真相），不是全部都存。這個退路在量完之前不蓋，避免為假想情況預建。

### 舊資料怎麼搬（會不會改到使用者資料：**會，所以要業主明確同意**）

要改變的資料，逐項：

1. **PDF 筆記的內文會多出摘錄段落**（每個 text 劃線一段，依頁碼、上到下排）。內文是使用者的資料；前提是抽出的全文已先移到 `pdf_text`（2026-11-16 提案的轉換，本身也要業主另行同意）。
2. **`ink_data` 信封的 `annotations` 裡 `type: "text"` 的紀錄會被移除**（`area`、`drawing`、`shape` 不動；drawing／shape 是筆畫）。這是刪除使用者資料，不可只靠「新資料在」就相信，所以**採兩階段**：
   - 階段一（複製）：寫入摘錄，**不刪**紀錄；畫面只畫摘錄（紀錄中 id 已轉成摘錄者不重畫——需要一個對照：搬遷時把「舊紀錄 id → 錨點 id」記在摘錄所屬筆記的一個隱藏屬性裡，階段二後即刪）。
   - 階段二（確認後刪）：對每一筆，`locateQuote` 找得回且與舊座標重疊，才刪紀錄；找不回的**留著並仍顯示**（不丟位置），並列出「這幾段找不回」給業主看。**只要有找不回的，就會同時存在兩種顯示路徑，直到業主決定怎麼處理**；這是量測結果決定的暫態，不是永久的雙機制。
3. **舊的 `pdf_annotations` 屬性**：已經唯讀、啟動時折進信封；搬遷後它的內容已隨信封處理，屬性本身**保留不刪**（它在備份與匯出清單裡），之後單獨決定要不要清。
4. 一則筆記的步驟 1 與 2 要**同一個事件**提交，否則會出現內文已多摘錄、紀錄也還在的半完成狀態；`updateNode` 能否一次寫內文與屬性我沒查，列為第 6 節的驗證項。
5. 沒有伺服器端搬遷：伺服器沒有 PDF 函式庫（2026-11-16 提案已查），所以**由瀏覽器在使用者打開那則筆記時搬**，或由業主按一次「整理 PDF 劃線」（預覽數字：幾則筆記、幾段劃線、幾段會找不回；**業主看過預覽才執行**，同 2026-11-16 提案的流程）。

不會改變的：`area`／`drawing`／`shape` 紀錄、PDF 檔、筆畫、手寫分頁、版本歷史（內文與 `ink_data` 的歷史照舊，搬遷是新操作產生新紀錄，可用事件復原回去）。

## 4.5 落點：存的時候不問放哪（業主 2026-11-17／18，PR #1833 留言，平板實測後）

業主的狀況：「選一個區塊存起來，可是存哪其實想不太到」「平常不太會用（存成筆記／寫點什麼）」。現在的設計在**讀的當下**問「放哪」，人答不出來就乾脆不存。
下面是留言裡的決定（原文見該 PR 留言），再加上我查程式後的回答。**這則留言不算「舊資料搬遷」的同意**（留言自己也這麼說），第 4 節的同意條件不變。

### 決定（業主）

1. 存的時候**不問位置**：選一段、按一下就存；位置之後再搬。
2. **PDF 的重點放它自己那則筆記的「內容」分頁**。那種筆記一開始沒有「內容」分頁（2026-11-16 提案），**第一次存重點時自動加上，不先問**。
   這取代我在 2026-11-16 提案 §2.5 寫的 `ensureContentTab`「問一次」**在「存重點」這件事上的做法**（反向連結、提及跳進內文那些動作仍問，沒有被這則決定改到）；**那份文件的該列已在本 PR 加註，兩份不再矛盾**。
3. **文章（RSS）的重點預設放收件匣，設定裡可以改成今天的日記**（業主選第三個選項「預設收件匣，可以改」）。**這改掉**現行規則「今天的日記 → 上次用的筆記 → 最上層」。
4. **不要每篇文章開一則筆記**；同一篇文章存的幾段在收件匣裡**收成一組**，標題是文章名與出處。不是每段一列，也不是每篇一則筆記。
5. 手寫頁「框一塊區域」的引用同屬這一類：落點是同一則筆記的「內容」分頁（現況已如此）。

### 查證（2026-11-17，main）

- **已經有一個「新東西放哪」的設定，而且它的規則就是業主要的**：`modules/capture/captureDestination.ts` 的 `captureDestinationPref`（帳號偏好，值是 `inbox`／`today`／某則筆記的 id，**沒存就是收件匣**），
  註解寫明「沒有隨情境改變的隱藏預設——不是上次選的筆記、不是剛好開著的筆記」。
  `rssQuoteTarget`（`lib/prefs.ts`）、`defaultQuoteTarget`、`rememberQuoteTarget`（`modules/rss/rssQuote.ts`）是**第二套**「上次用的筆記」式的隱藏預設，正是這個註解要避免的東西。
- 收件匣目前是**標籤成員**：沒有位置的隨手記是頂層筆記帶「收件匣」模組標籤（`modules/capture/inbox.ts` 的 `isPendingCapture`、`backend/src/modules/capture/inboxTag.ts` 的 `ensureInboxTag`）；
  收件匣頁上面是「等你決定」（`DecideSection`：AI 的待審建議、兩邊都改過的段落），下面是等待歸檔的隨手記。
  「改成個人引用、`function_refs` 加 `owner_actor_id`」**還沒做**（`function-refs-b3-remaining-2026-11-17.md` 第 1 項，要業主決定是否仍做）。
- 摘錄是**內文裡的一段**（有錨點的引用），不是一則筆記；所以「收進收件匣」一定要有一則筆記當**容器**，不能只丟一段。

### 回答留言的問題

**1. 摘錄進收件匣，怎麼分區才不淹沒；用哪種身分才不再欠一次遷移**

- 分區：**不加第三區**。「等你決定」維持在上面（要你動作的事），下面的清單裡，閱讀摘錄那則容器筆記是**一列**，列上標「閱讀摘錄」與數量（「3 篇文章、7 段」，由 `parseExcerpts` 算，不另存）。
  理由：摘錄不是等你決定的事，只是還沒歸檔的存放；若依來源分三區，每個來源都會長自己的區，使用者要學三個地方。**代價**：容器筆記長大後，一列要擔負很多段；靠第 2 點的分組控制。
- 身分：**摘錄的容器只透過收件匣現有的「建立隨手記」入口建立**（與 `QuickCapture` 同一條，`captureWriter`／`ensureInboxTag`），摘錄程式**不直接碰標籤、不直接寫 `function_refs`**。
  收件匣哪天由標籤改成個人引用，容器跟著所有隨手記一起搬，摘錄這邊不欠遷移。
  容器怎麼被認出來：**一個隱藏屬性（暫名 `_reading_excerpts`）**，不是標題比對（標題會被改名）、不是新資料表。這是新增的一個隱藏屬性，要在實作前對 `systemAttributes` 的慣例確認（我沒查）。
  使用者把容器歸檔到別處（標籤拿掉）後，下次存重點會**新開一則容器**，與隨手記「歸檔後不再在收件匣」的既有規則一致。

**2. 「收成一組」在資料上是什麼**

| | G1：一則「閱讀摘錄」容器筆記，內文依文章分節 | G2：收件匣裡的摘錄依來源網址分組顯示（容器仍是某則筆記） |
| --- | --- | --- |
| 資料 | 一節＝`## 文章名 · 出處` 標題加底下的摘錄段落；全是一般 Markdown | 摘錄散在各容器，分組靠「網址→摘錄」伺服器索引 |
| 新東西 | 隱藏屬性（認容器）；找／建一節的函式 | **新的索引**（也就是這份提案與 `excerpts.md`「之後」都延後的那個）＋收件匣新的分組畫面 |
| 兩台同時存同一篇 | 內文合併，可能出現兩節同名標題；讀的時候同名合併顯示，不另修資料 | 無此問題 |
| 離開 Onden | 匯出的 Markdown 本來就分節、看得懂 | 分組只在 App 內 |
| 搬一組到別處 | 已有「選取內文→子筆記／搬移」（`blockChildNote.ts` 的 `moveSelectionToChildNote`），一節是連續選取 | 要另寫「搬一組」 |
| 代價 | 容器會長大（沒歸檔就一直長） | 要先做索引（一個新表） |

**建議 G1**：不開新資料表（業主的條件），格式全是現有的 Markdown 與摘錄，離開 Onden 仍可讀。G2 的好處（跨容器分組）等索引做了再說，到時 G1 的資料不用改。
「找這篇文章的那一節」用 `parseExcerpts` 認同網址的摘錄所在的標題；沒有就在尾端新增一節。

**3. `rssQuoteTarget`／`defaultQuoteTarget`／`rememberQuoteTarget` 怎麼對應；「新東西放哪」少一個嗎**

- 全部**刪除**，改讀 `captureDestinationPref`：`inbox`（預設）→ 容器筆記；`today` → 今天的日記（同樣依文章分節）；某則筆記的 id → 那則筆記（同樣分節）。**一個設定，管隨手記與摘錄兩件事**。
- 「新東西放哪」少一個：**是，至少少了「RSS 摘錄放哪」這一個**。但你提到的 `one-mechanism-survey-2026-11-17.md` **不在 `origin/main`**（我查了，沒有這個檔），所以我無法對照「無法判斷」列的五個具體是哪五個，只能說：`rssQuoteTarget` 這個偏好會消失、它的功能併進 `captureDestinationPref`。盤整完成後請對照。
- 行為差異（要告知使用者）：「上次用的筆記」這個隱藏預設沒了；想放別處就把設定改成那則筆記，或之後搬。

**4. 閱讀頁兩個按鈕在新規則下還剩什麼**

- **存重點（選一段→按一下）**：成為主要動作，不問位置（決定 1）。
- **「寫點什麼」（業主已決定改名「引用到筆記」）**：只剩「**把這次存的摘錄用嵌入放進另一則筆記**，新草稿或加到現有筆記」。這是**唯一還需要選位置**的地方，而且是人自己要寫東西時才選，不是存的時候。因為摘錄已在容器裡，嵌入不複製文字（不變）。
- **「存成筆記」（整篇文章）**：與摘錄機制無關（它存的是整篇，不是一段），**這份提案不動它**；它的目的地選擇（`RssSaveSheet`、`defaultFor(source_id).parentId`）維持原狀。業主不常用，要不要拿掉由業主另決定；若拿掉，「整篇留下來」就只剩手動複製，這是一個功能的取捨，我不替業主決定。

### 對步驟與其他節的影響

- 第 6 節新增一步（插在第 2 與第 3 步之間，**RSS 與 PDF 共用**）：「落點」——`appendExcerpt` 的目的地一律來自 `captureDestinationPref`（RSS）或該 PDF 筆記自己的「內容」（PDF，缺就自動加上）；找／建一節；刪 `rssQuoteTarget` 三個函式。測試：預設是收件匣、改成日記後跟著變、容器被歸檔後再存會新開一則、同網址兩台同時存、PDF 沒有「內容」時第一次存就加上且不問、唯讀成員不能存。
- 摘錄與區域引用：兩種區塊形狀**不併成一種**（一個是文字加來源行，一個是圖片嵌入），但**寫入位置的規則併成一個**（附加到落點筆記的內文），所以 PDF 面積劃線與手寫「框一塊區域」都走同一個「附加到落點」入口，落點都是該筆記的「內容」。見第 8 節。

## 5. (e) 要問業主的事（每題附建議）

1. **PDF 劃線寫進 PDF 筆記內文**（而不是日記）可以嗎？內文是你寫字的地方，加上「內容」分頁後會看到這些引用。**建議：可以**（2026-10-18 本來就這樣決定；`excerpts.md`「放哪」也寫「原文是你的筆記 → 摘錄放在它裡面」）。
2. **「找不回引文」的門檻**：量測後多少比率算夠？**建議：先量，再由業主看數字定**，不先猜。找不回的保留座標、不刪。
3. **來源行 `#page=12:~:text=…` 要不要實測**：在 Chrome／Firefox 直接開這個連結，是否跳到那頁、是否被 `:~:text=` 干擾？**建議：第 1 步順便實測；若干擾，來源行只寫 `#page=12`，前後文改存在哪裡要再議**（選項：不存，只靠 `exact`；多數情況夠用）。
4. **面積劃線（框一塊、沒有文字）**怎麼處理：用手寫那套「引用一塊區域」（要先放寬頁 key 允許 `pdf:3`，並等 #1577 把來源擴到 `note_ink`）。**建議：做，放在最後一步**；在那之前面積劃線維持現狀、不假裝統一。
5. **升級成子筆記後，色塊還要畫嗎**？**建議：要**（先本機掃子筆記，之後用「網址→摘錄」索引）；否則升級會讓 PDF 上的標記消失，使用者會以為劃線不見了。
6. **「網址→摘錄」伺服器索引**（RSS 的「之後」也要）：要不要現在做？**建議：不在第一批**；先用本機掃，筆記多了、掃描變慢再做，同一次補上 RSS。
7. **搬舊資料的時機**：業主按一次，還是使用者打開筆記時自動？**建議：業主按一次**（有預覽、可停；自動搬等於未經同意改使用者資料）。
8. **整篇的「存成筆記」按鈕**要不要保留？**建議：這份提案不動它**（它存整篇，不是一段；業主另決定）。
9. **容器筆記的隱藏屬性（暫名 `_reading_excerpts`）**可以新增嗎？**建議：可以**（替代方案是標題比對，會被改名弄壞）。

## 6. (d) 步驟（每步完成後 main 都是正確的）

| 步驟 | 做什麼 | 完成後的狀態 | 測試 |
| --- | --- | --- | --- |
| 0 | 前置：2026-11-16 提案的 `pdf_text`（抽出全文移出內文）與「PDF 筆記一開始沒有『內容』」。**不是本提案的步驟，本提案只依賴它**；轉換既有資料要業主另行同意 | 內文是使用者自己的字 | 該提案自己的測試 |
| 1 | **只量不改**：寫 `lib/pdf/locateQuote.ts`（純函式）＋一個唯讀量測腳本，對業主指定的 PDF 與其現有 text 劃線，算「找得回／位置重疊」的比率；順便實測 `#page=12` 在瀏覽器的行為。報告寫進 `docs/research/`。**不接到畫面** | 沒有使用者可見的變化 | `locateQuote` 單元測試：同頁同句出現兩次靠前後文分辨、跨行、斷行連字號、全形半形、掃描檔回 null；量測腳本不寫任何資料 |
| 2 | `excerpt.ts` 認 `page` 與 `#page=N:~:text=`；`excerptBlock` 的來源多一個 `page`；把 `appendToNote`／`bodyOf` 從 `modules/rss/rssQuote.ts` 搬到 `lib/data`，RSS 改用共用的那份 | RSS 行為不變；PDF 還沒用 | `excerpt.test.ts`：寫出再讀回一致（含 `page`）；既有 RSS 測試全綠；`excerpts.guard.test.ts` 新增：除 `lib/data` 的附加函式外，沒有別處自己組摘錄；**兩台裝置劃同一段不產生重複**（後端整合測試，本次只測了兩段不同引文） |
| 2.5 | **落點（RSS 與 PDF 共用，見 4.5）**：`appendExcerpt` 的目的地 RSS 讀 `captureDestinationPref`（預設收件匣；容器筆記、依文章分節）、PDF 是該筆記自己的「內容」（缺就自動加上）；刪 `rssQuoteTarget`／`defaultQuoteTarget`／`rememberQuoteTarget`；收件匣列出容器（標「閱讀摘錄」與數量） | RSS 存重點不再問位置；舊的「上次用的筆記」沒了 | 預設是收件匣；改成日記後跟著變；容器歸檔後再存會新開一則；同網址兩台同時存；PDF 沒有「內容」時第一次存就加上且不問；唯讀成員不能存；收件匣畫面（桌面與手機）；`excerpts.guard.test.ts`：不再有第二套目的地偏好 |
| 3 | PDF 檢視器：按「劃線」→ `appendExcerpt` 寫摘錄；每頁用 `locateQuote` 畫摘錄的色塊；「劃線清單」（`parseExcerpts(body)`）；「→ 卡片」改成 `moveBlockToChildNote`。**舊紀錄照舊畫、照舊可用**（兩者並存，標在 `decisions-canvas.md`：只有新劃線走摘錄） | 新劃線是摘錄；舊劃線不變、不被刪 | 劃線→內文多一段、錨點補好；離線排隊；PDF 筆記唯讀成員不能劃；子筆記升級後仍畫色塊；搜尋與 AI 讀得到新劃線；桌面與手機尺寸瀏覽器檢查 |
| 4 | 面積劃線 → 區域引用（放寬頁 key、`note_ink` 來源，依 #1577）；舊 area 紀錄於第 5 步一起搬 | 兩種「引用一塊區域」合一 | `inkRegion.test.ts` 對 `pdf:N`；嵌入渲染；匯出 |
| 5 | **搬舊資料**（需業主同意）：預覽數字 → 階段一複製 → 階段二確認後刪；`pdf_annotations` 保留 | 舊劃線都是摘錄；`annotations` 只剩筆畫與面積之外的紀錄 | 一個事件內寫內文與信封；重跑不重複（冪等）；找不回的保留且仍顯示；可用事件復原；撤權與唯讀成員；備份還原後仍成立 |
| 6 | 收尾：刪除舊的 text 紀錄畫法（`PdfPageHighlights` 的 text 分支）與 `spawnHighlightNode` 複製文字的做法；若 `pdf_page`／`highlight_source` 沒有其他讀者，一併移除；加守門測試：`annotations` 不再接受 `type: "text"` | 只有一個劃線機制 | 守門測試；`npm run dup:check`、`ratchet:check` |

## 7. 本次新增的測試（只釘住「今天的行為」）

- `packages/markdown/src/excerpt.test.ts`：PDF 形狀的來源行（`…paper.pdf#page=12`）被 `parseExcerpts` 原樣讀成摘錄（網址含 `#page=12`、無前後文）；
  `sameExcerpt` 把「同檔不同頁」當同一段；`excerptBlock` 現在**會把 `#page=12` 換掉**（這就是第 6 節的第 2 步要改的點）。
- `packages/backend/src/test/bodyMergeExcerpts.test.ts`：兩台裝置各在同一則筆記尾端附加一段摘錄，不論誰先誰後都乾淨合併、兩段都留、都還是完整摘錄（純函式，不用資料庫）。

## 8. (f) 同一個形狀的其他成對機制（只列名；另一個例行工作在盤整全 App）

引用一段內容：

- 摘錄（`packages/markdown/src/excerpt.ts`）／手寫區域引用（`packages/markdown/src/inkRegion.ts`）／區塊參照（`blockLink.ts`、`blockLinkRewrite.ts`）／整篇與區塊嵌入（`embeds.ts`、`embedExtract.ts`）：四種「引用一處」，各有自己的寫法、解析、匯出展開。
- 「→ 卡片」的複製（`OverviewEditor.tsx` `spawnHighlightNode`）與「區塊→子筆記」（`backend/src/services/blockChildNote.ts`）：同樣是「一段文字變一則筆記」，一個複製、一個搬移。

「存到哪」：

- `modules/capture/captureDestination.ts`（隨手記放哪）／`modules/rss/rssQuote.ts` 的 `defaultQuoteTarget`（摘錄放哪）／`modules/rss/RssSaveSheet`（整篇放哪，`defaultFor(source_id)`）：三套「新東西放哪」；本提案 4.5 收掉第二套。
- 手寫「框一塊區域」與 PDF 面積劃線：寫入位置併進同一個「附加到落點」入口（4.5），區塊形狀仍是兩種。

頁面上的標註：

- PDF 劃線（`lib/pdf/coords.ts`）／頁面文字框（`lib/pageText`）／頁面圖片（`page_images`）／筆畫（`ink_data`、`note_ink`）：同一頁上四種東西、三個屬性（`ink_data`、`page_text`、`page_images`；`attributeWrites.ts` 的 `PAGE_LAYERS` 各有合併函式），2026-11-16 提案已在處理其中一部分。
- 兩種頁 key：PDF 是 `pdf:<n>`，手寫是 `page`／uuid（`inkPages.ts`、`inkRegion.ts` 的正規式），所以區域引用寫不進 PDF 頁。
- 兩份抽取：PDF 全文（`lib/pdf/extractText.ts`，進內文）與搜尋索引（`textSearch.ts`、`modules/semantic`）：2026-11-16 提案 §2.4 的 `pdf_text` 會改變它。

## 9. 我沒有做、沒有確認的

- 沒有跑任何 PDF、沒有開瀏覽器；`#page=N`、`:~:text=` 在瀏覽器的行為完全是推論。
- 沒有量 `locateQuote` 的命中率（因為還沒寫；那是第 1 步）。
- 發布版是否含 PDF 劃線色塊、`block_anchors` 是否在備份清單、`updateNode` 能否一個事件寫內文與屬性、區塊→子筆記對摘錄形狀的區塊有沒有特例：**沒查**，已列在步驟的驗證項。
- 開機預算的實際餘裕沒量；「不到 1 KB」是估計。
- 用到的行號與函式名是 2026-11-17 在 `origin/main` f1cce6e 讀到的；實作前要重讀。
