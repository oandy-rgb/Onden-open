# 摘錄（excerpt）：帶來源的段落

> 狀態：現行（最後確認 2026-11-01）

> 狀態：RSS 劃線已實作（2026-10-29）。PDF 劃線、「閱讀頁依網址找出劃線」尚未做，見下方「之後」。
> 涵蓋：packages/markdown/src/excerpt.ts, packages/frontend/src/lib/noteExportExcerpts.ts, packages/backend/src/modules/website/publishing/excerptEmbeds.ts

## 這是什麼

一段**別人寫的文字**，連同它的出處，存在**你的筆記**裡。RSS 文章劃線就是寫一個摘錄；之後 PDF 劃線寫同一種。
格式與解析只有一份：`packages/markdown/src/excerpt.ts`（前後端共用；守門測試 `frontend/src/test/guards/excerpts.guard.test.ts`
擋應用程式自己再寫第二套）。

## 格式

純 Markdown，拿出 Onden 也看得懂：

```markdown
> 被選的原文
>
> — [文章標題](https://原文網址#:~:text=前文-,被選的原文,-後文) · 訂閱名稱
> ^id
```

- **引用區塊 + `^id`**：就是 `blocks.ts` 已有的「引用區塊的 id 放在最後一行」形式，所以 `![[筆記#^id]]` 嵌入時會連來源行一起顯示，
  不需要新的嵌入種類。`> 原文 ^id` 只會錨到第一段，來源行貼在下面還會被當成引用的延續，所以不用那種寫法。
- **位置 = 瀏覽器標準的 Text Fragment**（`#:~:text=`）：在一般瀏覽器開原文連結會直接跳到那段。`-`、`&`、`,` 與括號依規範做百分比編碼。
  短的一段整段寫進去；長的或多行的用 `開頭,結尾` 範圍（各取 40 字），網址不會跟著原文一樣長。
- **前後文**（prefix / suffix，各最多 32 字，用 `graphemes.ts` 切）對應 W3C Web Annotation 的 TextQuoteSelector：
  `exact` 是引文本身，前後文用來分辨同一段文字在頁面出現兩次的情況。
- **`^id`** 用既有的區塊 id 文法（`blockId.ts`）；呼叫端挑一個筆記裡還沒用過的（`existingIds`）傳進去。
- 只有**帶連結**的來源行才算摘錄（`parseExcerpts`）。沒有網址的文章仍會寫成引用加 `^id`，可以嵌入，但不會被當成「已知的摘錄」。

`parseExcerpts(markdown)` 回傳 `{ id, exact, prefix, suffix, url（去掉 fragment）, title, feed }[]`；
`sameExcerpt` 以「網址（去掉 fragment）＋原文（空白壓成一格）」判斷是不是同一段。

## 放哪（規則）

**業主 2026-11-17／18 決定（尚未實作，設計見[提案 4.5](proposals/pdf-highlights-as-excerpts-2026-11-17.md)）：存的時候不問放哪。**

- **原文是你的筆記**（PDF 筆記）→ 摘錄放在它**自己的「內容」分頁**；沒有「內容」分頁時第一次存就自動加上，不先問。
- **原文不是你的**（RSS 文章、網頁）→ 預設放**收件匣**，設定（`captureDestinationPref`）裡可以改成今天的日記或某則筆記；**不問**。
  同一篇文章存的幾段收成一組（容器筆記裡一節，標題是文章名與出處），不是每篇一則筆記。

**現況（程式仍是舊規則）**：預設是今天的日記（日記模組開啟時）；其次是上次用的筆記（沿用 `defaultQuoteTarget` / `rememberQuoteTarget`）；或選別篇。

其他筆記要用同一段，**嵌入它**（`![[筆記#^id]]`），不複製文字。「寫點什麼」帶的本次引用也是嵌入。

## 不重複

同一個網址＋同一段原文，這台裝置若已知某篇筆記裡有這段摘錄（`existingExcerpt`：先看本機已有內文的筆記，沒有內文的列用
`reads.notes.search` 以網址找，再讀內文解析），再點時問「這段已經在〈…〉」，給「打開」和「引用它到別篇筆記…」（寫嵌入）。
找不到（或離線搜尋失敗）就照常新增——這是這台裝置的盡力判斷，不是跨裝置的保證。

## 匯出與發布

- **匯出（Markdown / HTML）**：`withExcerptsExpanded`（`lib/noteExport.ts`）在送出快照前，把單獨成行的 `![[筆記#^id]]`
  若指向摘錄，換成「引用 + 來源連結」；讀不到來源筆記的嵌入、指向一般段落的嵌入維持原樣。只讀這位使用者讀得到的筆記。發布用同一個展開函式（見下）。
- **發布到網站**（使用者決定 2026-10-29）：**只展開摘錄**。發布當下，單獨成行的 `![[筆記#^id]]` 若解析得出是摘錄，
  就把「引用 + 來源行（標題、帶 Text Fragment 的原文連結、訂閱名稱）」寫進被發布的筆記快照，即使來源筆記（例如私人日記）沒有發布。
  理由：摘錄只是公開文章的一句話加原文連結，符合 Onden 鼓勵輸出的原則。
  - **只有那一個段落**出去：來源筆記的其他內容（摘錄底下的想法、日記的其他段落）、標題、id 與連到它的連結都不會進快照。
  - **不是摘錄的嵌入**（一般段落、讀不到的筆記）維持 `publishBlockEmbeds` 既有規則：網站只放連到已發布筆記的連結，否則顯示「(private)」。
  - **是快照**（呈現模型 B）：展開發生在發布當下（`modules/website/publishing/excerptEmbeds.ts`，在 redaction 之前），之後改或刪日記
    不影響已發布的網站；重新發布才會更新。展開用的仍是 `@onden/markdown` 的 `expandExcerptEmbeds`（與匯出同一份，不另寫一套）。
  - 只讀發布者讀得到的筆記；沒有發布者身分（匿名）時不展開。

## 之後

- **PDF 劃線**：在 PDF 筆記裡呼叫同一個 `excerptBlock`，來源行的連結指向 PDF 本身（頁碼/座標另定，不放進 Text Fragment）；
  `parseExcerpts` 需要的只是「引用 + 帶連結的來源行 + `^id`」，不必改。
- **閱讀頁依網址找出劃線**（打開 RSS 文章時把已劃的段落標出來）：需要「網址 → 摘錄」的索引。目前只能掃本機筆記，
  對少量筆記可行，筆記多了不夠。建議方向：後端在儲存筆記時用 `parseExcerpts` 抽出 `(note_id, url, exact, prefix, suffix, id)`
  存成可查詢的列（跟區塊錨點同一個時機與權限範圍，用 `readPolicy` 過濾），前端 `GET` 一次取回一個網址的全部摘錄再比對文字。
  **這次沒做**，也沒有新增後端 API。
