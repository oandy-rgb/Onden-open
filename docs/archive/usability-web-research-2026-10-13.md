# 筆記軟體使用行為與痛點：網路證據研究摘要（為 Onden 可用性報告準備）

> 狀態：歷史紀錄（最後確認 2026-11-01）

> 調查日期：2026-10-13　｜　範圍：文字筆記、手寫、白板/畫布、閱讀與標註、跨工具切換、筆記內的間隔重複
> 引文保留原文語言；中文為整理與詮釋。

## 0. 方法與限制（請先讀）

- **Reddit 無法直接抓取**：reddit.com 擋掉了本工具的爬蟲（WebSearch 回傳 `domains are not accessible`，curl 拿到的是封鎖頁，redlib 鏡像也回 403）。因此題目指定的 r/ObsidianMD、r/Notion、r/PKMS、r/GoodNotes 等 subreddit **沒有直接引用**。只有一個 r/PKMS 的內容透過搜尋引擎摘要間接取得，文中已標 ⚠️。用來替代的一手使用者聲音：
  - **Hacker News**：用 Algolia API 抓了 10 個討論串的完整留言，包括 2026-01 的「hoard notes/links」（217 則）、Obsidian Canvas 發表串（387 則）、Readwise Reader 發表串（156 則）等。引文是逐字的。
  - **Apple App Store 評論**：用 iTunes RSS 取 Notability、GoodNotes、Obsidian、Notion 各 250 則最新美區評論，做了關鍵字計數。引文是逐字的。
  - **官方論壇**：Obsidian forum、Logseq forum、Anytype community、Zotero forums、MacPowerUsers、outlinersoftware。
  - **部落格事後檢討、學術論文、官方文件**。
- **引文精確度**：HN 與 App Store 的引文是我從原始資料直接取出的。其他網頁是由抓取工具先抽出段落，**可能有細微字詞差異**，正式引用前請點連結再核對一次。
- **「State of PKM survey」找不到**：搜尋沒有找到叫這個名字、並附公開數據的調查。Obsidian 官方在 2026-10 才開始做第一次「State of Obsidian」調查，結果尚未公布 [S51]。Ness Labs 也沒找到附數據的工具使用調查。
- 標 ⚠️ 的是「未能驗證原始出處」或「只有二手來源」的說法。

---

## 1. 文字型筆記軟體（Obsidian / Notion / Logseq / Tana / Apple Notes / OneNote / Evernote / Bear / Capacities / Anytype / Heptabase）

### 1.1 人們日常實際在做什麼

- **捕捉（capture）要快，常常交給「最快開啟」的 app**：
  - HN 使用者 eternityforest 說：「Many load too slow on mobile… So I use Google Keep. Largely because it loads so fast, so I don't forget what I'm writing before I write it.」[S1]
  - 另有人說：「Obsidian on desktop, and Google Keep for capturing and for carrying notes I may need on the road.」[S1]
  - 也就是說，**捕捉與整理常被拆到兩個 app**。
- **每日筆記／流水帳，加上主題 wiki 兩軌並行**：
  - HN 的 Viliam1234：「I keep two types of notes… "blog" (daily, write-only) and "wiki" (topic-oriented, updated).」[S2]
  - enobrev：一週一個 markdown 檔，每天一個 H2 [S2]。
- **紙筆依然大量存在，數位化只取一小部分**：
  - 「I take notes on paper in a notebook. A vast majority of them always stay there. Maybe 10% of them get converted into digital notes into Obsidian.」[S3]
  - 「Pen and paper. At the end of the week I review the notes and if it's important enough I rewrite the notes on a personal wiki.」[S2]
- **很少回顧，主要靠搜尋**：
  - 「How do you review your Zettelkasten notes?」一串中，高讚回覆是「I don't. It's too mentally taxing for me… I use the Omnisearch plugin to search for what I need.」[S3]
  - 也有人說：「I don't ever review them. If I need a note later, I'll find it.」[S3]
- **學術個案研究**：IBM Research Brazil 訪談並觀察研究員使用 Obsidian 的情形 [S4]。
  - 主要發現：「participants' knowledge retrieval strategy influences how they build and maintain their content」，也就是**預期日後怎麼找，決定了當下怎麼整理**。
  - 參與者同時用資料夾、tag、Inbox 資料夾、連結。研究也記錄到一個小可用性問題：點了資料夾再新增筆記，筆記卻建在根目錄。
- **「information scraps」的經典研究**：Bernstein 等人（MIT，ACM TOIS 2008）研究了 5 個組織的 27 位知識工作者 [S5]。
  - 大量資訊落在便利貼、寄給自己的 email、雜散文字檔，而**不在**正式的 PIM 工具裡。
  - 歸納出的未被滿足需求是：「lightweight entry, unconstrained content, flexible use and adaptability, visibility, and mobility」。

### 1.2 主要抱怨

**(a) 過度工程化／系統建構成癮**
- Obsidian 論壇「pornographic productivity」討論串的原 PO 花了 29 小時整理證照教材的格式，而不是真的去學 [S6]。回覆中有人形容為「System-tweaking as an addiction」[S6]。
- fpnotes 作者說：「I have spent at least five and probably closer to ten (or fifty) times more time *customizing* Obsidian than I have using Obsidian to actually do the research.」[S7]
- bearblog 作者寫 Obsidian：「It's still too complicated, and getting more-so all the time」，以及「all the flexibility of Obsidian… is creating friction and distraction」[S8]
- D'Arcy Norman 說他的 vault「had turned into something of a cargo cult… thousands of notes that I never referred to… So I just deleted all of those.」[S9]
- ⚠️ 某商業部落格聲稱「60% of PKM practitioners name system-building as their primary time sink」，並說 r/ObsidianMD 每週都有這類貼文 [S10]。**找不到這個數字的原始調查**，不建議引用。

**(b) 組織決策在捕捉前就跳出來（organization paralysis）**
- 「Organization is a death sentence for spontaneity.」「Tools like Notion have me questioning my note placement before I've written a single word.」[S11]
- Capacities 官方文件自己承認，型別化（typed objects）會帶來新的摩擦：使用者要決定「what kind of thing it is」。官方還得提供「何時該新增 object type」的三題判斷流程 [S12]。
- Tana：「the process of setting up the super tags and making your own custom flows is so unimaginably difficult for beginners that >90 of users will likely never get there.」[S13]（Substack note，屬個人意見）
- Anytype 使用者離開的理由 [S14]：
  - 「The "Thinking" experience of note-taking is completely absent… I cannot "take a step back" and look at my notes」
  - 「many of my actions were leaving a data-mess that I couldn't clearly see」，例如孤兒頁面、屬性結構不清、重複上傳的檔案。

**(c) 效能、行動版、離線**
- Obsidian 論壇的 Android 啟動速度請願 [S15]：
  - 1,406 檔的 vault 啟動要「4.8 seconds… unusably slow」，另有人說約 15 秒。
  - 使用者因此改用 Zettel Notes 這類「starts instantly」的 app 來快速捕捉。
  - 提案是「Just start a minimal markdown viewer and editor first. Do everything else… in the background.」
- Notion 離線與行動版：
  - QuadrantNine 說「Notion's site can be slow and clunky at times, and in the worst case: completely down for hours.」[S16]
  - App Store 1 星評論說 iPad 版「Always lagging」，打字時頁面會自己往下捲 [S17]。
- App Store 抽樣（各 250 則最新美區評論，≤2 星）[S17][S18][S19][S20]：
  - **Obsidian**：69 則 ≤2 星中有 **22 則提到 sync**。例如「It only wants to use an online vault from either Obsidian's sync service or iCloud… I just want to use it locally.」也有人抱怨不能用 OneDrive。
  - **Notion**：99 則 ≤2 星中有 **32 則提到 AI**，其中多數是反感。例如「i'm so done with ai slop being shoved down our throats」「It'd be really nice, but the AI ruins it.」

**(d) 鎖定（lock-in）、價格、平台風險**
- Notion 漲價加上 AI 方向，讓 Dave Rupert 遷移到 Obsidian：「I use Notion as a thinking tool, I don't need it to be a think-for-me tool.」[S21]
  - 他也承認在 Notion 裡「over-databased」，而且 Web Clipper 的連結直接「declared bankruptcy」，沒有搬過去 [S21]。
- 「one day Notion would go under and I'd lose everything」[S16]
- Evernote 被 Bending Spoons 收購後，2023-12 起免費版限 50 則筆記、1 個筆記本；官方自己承認使用者可能會「reconsider their relationship with Evernote」[S22]。
- Logseq 改走 DB（SQLite）版引發反彈 [S23][S24]：
  - 「The reason I chose Obsidian was the usage of plain Markdown files」
  - 「Logseq DB uses Sqlite… makes synchronizing really bandwidth and time consuming」
  - 「If its locked in a DB its no use.」
  - 有作者因此直接轉去 Obsidian [S24]。
- HN 早期串：「I get tired when apps and sites go unsupported or have shitty (if any) export features.」[S25]
  - 也有人發現 Apple Notes「there is no good way to export all notes as text for backup」[S25]。

**(e) 換 app 循環（app-hopping）**
- ivolog 依序用過「Evernote, Workflowy, Roam Research, Logseq, Mem.ai, Standard Notes, Notesnook, Apple Notes, Reflect, Obsidian... and many more.」[S26]
  - 他的反省：「Every time I found an issue… my first thought was: 'Maybe there's another app that can do this better.'」
  - 最後的解法是「I can't change my note-taking app for the next 2 months.」
- Tyler Suits 的文章標題就是「Apple Notes > Obsidian > Notion > Apple Notes」[S27]。
- Ness Labs 稱之為「shiny toy syndrome」：「an intense but temporary sense of satisfaction from using a new tool before moving onto something else」[S28]。

---

## 2. 手寫筆記（GoodNotes / Notability / reMarkable / Samsung Notes / OneNote 墨跡 / Supernote）

### 2.1 工作流程

- **為什麼要手寫**（MacPowerUsers 一位學者）[S29]：
  - 「I prefer to use the apple pencil to slow myself down, to doodle」
  - 「I can handwrite on my iPad using the Apple Pencil faster than I can type and it's less obtrusive when in a meeting.」
- **常見的三件組**：GoodNotes 備份到 Dropbox → DEVONthink 做索引與 OCR → Obsidian 當 Zettelkasten。他形容三者「complimentary but quite unique」[S29]。也就是**一個手寫流程就牽動 3 個工具**。
- D'Arcy Norman 說 reMarkable 是「the best digital ink experience I've ever had」，但也坦承「As long as I've been using digital notebooks, I've kept coming back to paper.」[S9]
  - 為了把手寫接回 Obsidian，**他自己寫了 macOS app（rm2md）** 來轉錄 PDF [S9]。
- 另一位作者也自己寫了排程同步：每小時從 reMarkable 雲端取出 → 轉成 PNG → 放進 vault → 由 AI 轉錄並建立連結 [S30]。
  - 痛點原話：「I think on a reMarkable, and those pages stayed stuck on the tablet.」
- MacPowerUsers 的 e-ink 工作流程：Hazel 抓檔 → 呼叫 Mathpix API → 把轉錄附加到 Obsidian 的 daily note。作者稱讚「The quality of the transcription now offered by AI is outstanding」，但其他人回報 Mathpix 處理潦草筆跡效果差 [S31]。

### 2.2 痛點：手寫進不了知識系統

- **進來之後無法連結**：
  - 「Since I can't really link them, I can at least put them in the same folder so at least 'like is next to like.'」[S32]
  - Samsung Notes 使用者想把 PDF 的特定段落連到 Obsidian 筆記，但做不到，討論串無人回答就自動關閉 [S33]。
- **OCR 不可靠或格式髒**：
  - 「OCR still isn't a completely reliable tech」，轉換後會有「unnecessary line breaks and spaces」[S34]。
  - reMarkable 的手寫轉文字被評為「a lot of incorrect words」；工整印刷體約 95%，草寫約 80% [S35]（評論文章的數字，⚠️ 非官方）。
- **轉成文字會丟掉圖**：「Many have diagrams and schematics that would be lost if transcribed to text.」[S32] 使用者要的是**筆跡與文字並存**。
- **搜尋退化**：OneNote 在 Windows 11 25H2 之後新寫的手寫不再被索引。使用者試過重建索引、修復 Office 都沒用，最後放棄 [S36]。
- **隱私與 OCR 的兩難**：「Handwriting conversion needs AI level OCR. Sadly, I haven't found any AI OCR solutions that don't use a cloud service.」[S37]
- **逐頁匯出很繁瑣**：Notability 要匯出 PDF、選擇性 OCR、再拖進 Obsidian，沒有一鍵流程 [S38]。
  - 另一位 GoodNotes 使用者說：「getting tasks out of there is just too manual for me and 'joyless'」[S32]
- **資料遺失與訂閱信任危機**（App Store 抽樣 [S18][S19]）：
  - **Notability**：162 則 ≤2 星中，**49 則提到遺失或刪除**，38 則提到訂閱或價格。
    - 「Now it's deleting handwritten notes while the note is open. I can literally watch my writing disappear.」（6 年、5,500 則筆記的使用者）
    - 「I lost 5 years of notes」
  - **GoodNotes**：151 則 ≤2 星中，38 則提到訂閱。
    - 「I was forced to update to Goodnotes 6 which is on on a monthly subscription and now I can't edit any of my notes anymore.」
  - 2021 年 Notability 改訂閱制，原本把已買功能改成一年後失效，引發強烈反彈後才讓步 [S39]。
  - **含意**：手寫資料一旦被鎖在專有格式裡，價格或政策一變，使用者就會覺得被綁架。

---

## 3. 白板／畫布（Heptabase / Obsidian Canvas / Miro / Excalidraw / Freeform / Logseq whiteboard）

### 3.1 什麼時候用畫布，什麼時候用文件

- Obsidian 開發者對 Canvas 的定位是「less of a piece of drawing software and more of brainstorm/mindmapping/idea workbench」[S40]。
  - 另一位使用者補充：「Obsidian Canvas is about spatially organizing your already-existing knowledge base… Figjam is more like virtual whiteboarding.」[S40]
- Andy Matuschak 指出，數位筆記系統「fixate on the presentation and manipulation of individual notes, mostly ignoring inter-note sense-making」[S41]。
  - 實體卡片可以「shuffling the notes around」，數位版沒有對應的操作。在 backlinks 之間跳來跳去會「lose object permanence」。
  - 這是**畫布存在的理由**。
- 典型用途（HN）：先收集連結、草圖做 moodboard，再隨設計成形切出子區塊 [S40]。
- 畫布的反對意見：「This feature of one-note (text boxes where you click) is the single reason I'm looking for something else. I absolutely hate any interface that has me fiddle with layout when I'm trying to focus on semantics.」[S40]

### 3.2 哪裡會壞

- **卡片與筆記系統脫節**：Obsidian 論壇的熱門請願是讓 Canvas 卡片裡的 wikilink 出現在 outgoing links、backlinks、graph [S42]。
  - 「The lack of this feature… really breaks the 'link your thinking' / backlinks focused navigation」
  - 「Part of what makes canvases exciting… is the hope that they'll integrate like other notes」
- **同步會整份覆蓋**：Obsidian Sync 把 `.canvas` 當附件處理，採「last to make a change wins」，不合併也不產生衝突副本。手機離線改一張卡片，就可能蓋掉筆電上的整張畫布 [S43]。
  - 另有使用者回報：卡片顏色會同步，連線卻不會 [S44]。
- **Excalidraw 檔的同步與索引**：曾有 Obsidian Sync 不同步 Excalidraw 檔的時期，外掛作者只能做一份「slightly messy」的平行 markdown 快取來繞過 [S45]。後來 Obsidian 1.6 又不索引超過 2MB 的檔案，外掛只好改用壓縮 [S46]（⚠️ 二手摘要）。
- **規模與雜亂**：
  - Heptabase 官方說法在演變：搜尋摘要稱「100~150 cards」會開始卡 [S47]，但目前官方頁面改成「There is no single card-count threshold」，建議拆成多個子白板 [S47]。
  - joodaloop 的 canvas UI 評論 [S48]：
    - 「They invite messes」
    - 「Eternal manual adjustments」
    - 「On narrow screens, canvases either become a list, or become unusable」
    - 缺乏「situational anchors」，空間記憶會失效。
- **匯出、多選、操作**（outlinersoftware 的 Heptabase 討論）[S49]：
  - 「Export options are weak, which is a killer for me.」
  - 「It does export to MD but only the entire database not a single card or whiteboard.」
  - 「You can't select multiple cards via Control + Click」
  - 「Obsidian's Canvas was often more effective when I had a task in mind. Simpler whiteboard but far more note options.」
- **Freeform**：只能匯出 PDF；大型白板載入慢；iCloud 同步延遲 [S50]（⚠️ 二手彙整）。MPU 使用者評為「a pretty, but basic, tool for drawing pictures」，並指出「you can't get excerpts from PDF's」[S52]。
- **白板功能被砍**：Logseq DB 版把 whiteboard 擱置。使用者因此卡在只剩維護的 OG 版與還不穩的 DB 版之間 [S23]。
- **格式疑慮**：Canvas 發表時就有人擔心「first move away from… markdown… I hope this isn't a trend towards using proprietary formats」。官方因此開源 JSON Canvas 規格 [S40]。

---

## 4. 閱讀與標註（Readwise/Reader、Zotero、PDF 標註、Kindle、Omnivore、Pocket、Matter、Instapaper）

### 4.1 理想的管線：讀 → 畫線 → 筆記 → 回顧

- Readwise 共同創辦人的出發點：「spending ten hours reading a book, only to promptly forget nearly everything in a week or two」。他宣稱「thousands of users who have maintained the daily review habit… for over a year」[S53]（廠商自述）。
- HN 使用者：「The killer feature is exporting highlights to Obsidian for me… being able to find things I read in the past while doing writing or research.」[S54]
- Zotero 到 Obsidian 的學術流程：Zotero 畫線並用顏色分類 → 「Create Literature Note」→ 加綜合筆記 → 用 Dataview 做文獻表 [S55]。

### 4.2 管線在哪裡漏

- **收集取代理解（collector's fallacy）**：「'to know about something' isn't the same as 'knowing something'」[S56]
  - HN 2026 討論串發起人：「My own "second brain" became a graveyard of good intentions: the organizing tax was higher than the value I got back.」[S57]
  - 回覆：「My main problem always was that I hoard these links and never read again.」[S57]
  - 另一則：「I quit hoarding. Collecting was the bottleneck, not organizing.」[S57]
  - ⚠️ 某部落格引述 2013 年 Pocket 出版商儀表板的「Saved Items Opened」約 10%，**但沒有指名來源** [S58]。不建議引用。
- **單向同步，重新匯入會蓋掉或重複**：
  - Zotero 到 Obsidian：「Obsidian does not auto-sync the literature notes… the user has to manually pull」；只有 `persist` 區塊內的編輯能在重新匯入後保留 [S55]。
  - Zotero 自己的「add note from annotations」每次都**新建一則**筆記，而不是更新原本那則；使用者要手動刪掉重複的才能匯出給 Obsidian [S59]。
  - Readwise 到 Obsidian 是 append-only。官方解釋為了不覆蓋使用者的編輯，選擇不回寫更新 [S60]。所以**在 Readwise 修改畫線，不會反映到 Obsidian**。
- **標註被鎖在 app 裡**：
  - MarginNote 的標註「stored outside of the PDF and not generally accessible without their app」
  - 「I care more about portability since my annotations are for long-lived research.」[S61]
  - Matter：「docs I export as a PDF don't include highlights that I've made, which rather undermines the whole point.」[S62]
- **上游限制**：Kindle 有出版商要求的「copyright export limit」，通常是全書 10–20%，超過的畫線會被截斷 [S63]。
- **服務關閉導致資料蒸發**：
  - Omnivore 被 ElevenLabs 收購後約兩週就關閉並刪除資料 [S64]。wallabag 的匯入器明說「the importer is not expected to support highlights」[S65]。也就是**畫線這種最有價值的資料，最難搬**。
  - HN 使用者的應急辦法是「synchronized everything into an Obsidian vault using the Obsidian Omnivore plugin」[S64]。
  - Pocket 在 2025-07-08 停止服務，2025-10 刪除所有資料，包括 highlights 與 notes [S66]。
- **閱讀散落在多個 app**：「I've got my reading material spread across three different apps (depending on where they come from) which makes it easy to miss things.」[S62]
- **對 all-in-one 閱讀器的戒心**：「Paradoxically, the fact that this is a do-everything app makes me much less likely to try it out… I would be very reluctant to put all my eggs in one basket. Especially a startup」[S54]

---

## 5. 切換之痛：工具之間的切換、重複捕捉、斷鏈、匯入匯出流失、all-in-one 的嘗試

### 5.1 一般人用幾個工具（數據）

- **HBR（2022）**：137 人、20 個團隊、3 家 Fortune 500 公司，追蹤 5 週 [S67][S68]：
  - 「toggled between different apps and websites nearly 1,200 times each day」
  - 每週「just under four hours… reorienting」
  - 等於每年約 5 個工作週，占 9%
  - （對象是一般企業工作，不是 PKM，但可作為切換成本的量級參考）
- **Asana Anatomy of Work**：「the average employee uses 10 different apps every day」（調查超過 10,000 名知識工作者）[S69]
- **個人 PKM 的工具數**（質性資料）：
  - Beth McClelland 用 5 個：「Apple notes for quick notes, Logseq for literature notes, Capacities for permanent notes… and Notion as my LifeOS」[S70]
  - 學者用 GoodNotes + DEVONthink + Obsidian 三件組 [S29]
  - HN 上常見「Obsidian 桌面 + Keep 捕捉」「Apple Notes + Obsidian」「紙 + wiki」的雙工具組合 [S1][S2]
- ⚠️ 「average knowledge worker switches between six different apps to manage information」出自 notelyn 部落格，未附來源。

### 5.2 斷鏈與匯入匯出流失

- **Notion → Obsidian**：
  - 資料庫頁面「all missing their content - properties… are all there, but the actual content from inside the page isn't」，在論壇沒有得到解答 [S71]。
  - 二手彙整指出：資料庫匯出成 CSV 後，view、filter、relation、rollup 全部消失；檔名帶 32 字元 UUID；內部連結失效 [S72]（⚠️ 廠商部落格）。
- **Notion → Anytype**：「hundreds of notes became unreadable」，因為不支援 iPhone 的 HEIC 圖片 [S14]。
- **Evernote → Obsidian**（Yarle）：大致成功，但 web clip 預設會被略過，建立時間會變成轉換時間 [S73]。
- **畫線最難搬**：Omnivore 到 wallabag 不支援 highlights [S65]；Readwise 是單向、只附加 [S60]。
- **手寫幾乎搬不走**：只能匯出 PDF 或圖片，連結與分頁位置都會流失 [S33][S38]。

### 5.3 重複捕捉與任務散落

- 任務寫在 daily note 裡會被遺忘，因此社群出現大量「rollover todos」外掛來補救 [S74]。
- 很多人最後把任務交給 Todoist，再用橋接外掛同步回筆記 [S74]（⚠️ 原始 Lemmy 討論被擋，以 Obsidian 外掛頁與論壇串為證）。
- ⚠️ r/PKMS 搜尋摘要描述：「text notes in one place, voice memos in another, project details buried in to-do lists… constantly switching between apps, losing ideas」。另一位使用者把 Notion 頁面當成「universal inbox」來把捕捉摩擦降到零 [S75]。（原貼文無法開啟，只有搜尋摘要）

### 5.4 使用者對 all-in-one 是讚還是退？

**支持的聲音：**
- 「I like having all my work in a common area」（HN 談 Canvas 與筆記整合）[S40]
- Heptabase 讓研究者不用再組裝外掛，「providing necessary functionality immediately」[S7]

**反對或保留的聲音：**
- 用 Notion 什麼都做，就像用叉匙（spork），後來把東西一件件搬回專用 app [S76]（⚠️ 原文 403，僅搜尋摘要）。
- 「We should not rely on 1 tool」；Capacities「only clicked for me when I assigned it a very specific use case」[S70]
- 「do-everything app makes me much less likely to try it out」[S54]
- Notion 漲價、AI 方向、over-database 化 [S21]

**整體傾向**：
- 使用者**喜歡「一個地方能找到、能連結」**，但**不喜歡「一個 app 強迫所有事用同一種結構做」**，也**害怕把雞蛋放在同一個籃子**（關站或漲價的風險）。
- 真正被稱讚的「整合」，是**資料層面的整合**：同一筆內容可以在多處出現、彼此連得到，加上可攜的格式。不是 UI 把所有功能塞在一起。

---

## 6. 筆記軟體內的間隔重複（Obsidian SR 外掛 / RemNote / Anki 整合 / Readwise 回顧）

### 6.1 誰在用

- 用的人是少數，但核心使用者很投入。Obsidian 官方外掛統計 [S77]：
  - Spaced Repetition 外掛約 **61 萬**下載
  - 對照組：Excalidraw 約 846 萬、Dataview 約 512 萬、Tasks 約 439 萬、Zotero Integration 約 58 萬、PDF++ 約 83 萬
- 用 Readwise 每日回顧畫線的人 [S53]
- RemNote 的學生族群：稱讚它的閃卡，但抱怨速度 [S78]

### 6.2 摩擦

- **寫出好的提示卡很難，而且是瓶頸**（Andy Matuschak）：
  - 「The limiting factor in spaced repetition system capacity is writing enough good prompts」[S79]
  - 「it's not obvious when the prompts you've written are bad」[S80]
  - 「Regular spaced repetition memory practice is an onerous habit to adopt」：大多數系統是「an empty box meant for the user to fill」，好處又不會很快顯現 [S81]
- **排程資料污染筆記**：Obsidian SR 外掛把排程寫進每篇筆記的 YAML。
  - 「runs havoc on my version control system… My notes on "Newton's Laws" shouldn't change every time I just read them」[S82]
  - 相關 bug 包括 metadata 重複寫入、產生無效欄位（#764、#776）[S82]
- **卡片被漏掉，信任崩潰**：
  - Obsidian SR 更新後，卡片「from having about 1500 flashcards to about 155」[S83]
  - RemNote 5,000 張卡的使用者發現「cards that have never been reviewed in more than 1 year… How can I trust RemNote?」[S84]
- **演算法與控制**：Obsidian SR 外掛讚數最高的需求是換成現代演算法（FSRS）、每日上限、「Pause / Take a Break / Go On Holiday」、「Export to Anki」[S85]
- **語法雜訊**：卡片分隔語法會讓筆記變亂，所以出現 Aosr 這類把排程資料存成獨立資料庫的外掛 [S86]
- **RemNote 行動版**：「The mobile app is slow, sync doesn't always work immediately, and creating flashcards on your phone isn't pleasant」；有使用者因 iPhone 版太慢而轉去 Obsidian [S78]（⚠️ 評論彙整站）

---

## 7. 跨領域痛點（Top 15）

強度：●●● 多個獨立一手來源反覆出現，或有量化數據；●● 數個一手來源；● 少量來源或推論。

| # | 痛點 | 強度 | 代表來源 |
|---|---|---|---|
| 1 | **捕捉太慢或太重**：啟動慢、要先決定放哪，結果捕捉被外包給 Keep、Apple Notes 或紙 | ●●● | [S15] Android 4.8–15 秒啟動；[S11] 「death sentence for spontaneity」；[S1] Keep 因為「loads so fast」；[S5] information scraps 的「lightweight entry」 |
| 2 | **收了不回顧**：筆記與稍後讀變成墓園 | ●●● | [S57] 「graveyard of good intentions」；[S56] collector's fallacy；[S3] 「I don't [review]. It's too mentally taxing」；[S9] 刪光數千則從未用過的筆記 |
| 3 | **系統建構成癮、過度設定** | ●●● | [S6] 29 小時排版；[S7] 自訂時間是研究的 5–50 倍；[S8] 「too complicated」 |
| 4 | **手寫是孤島**：不能連結、不能搜尋、OCR 不可靠、圖會流失 | ●●● | [S32] 「Since I can't really link them」；[S34] OCR 不可靠；[S9][S30] 使用者被迫自寫轉換工具；[S36] OneNote 手寫索引退化 |
| 5 | **資料鎖定與服務消失的恐懼**（關站、漲價、改訂閱、改格式） | ●●● | [S64][S66] Omnivore、Pocket 刪資料；[S22] Evernote 50 則上限；[S39] Notability 改訂閱；[S23] Logseq DB；[S16] 「I'd lose everything」 |
| 6 | **遷移時結構與畫線流失**：連結斷、資料庫變 CSV、highlights 不支援 | ●●● | [S71] Notion 資料庫內文消失；[S65] 匯入「not expected to support highlights」；[S14] HEIC 無法讀 |
| 7 | **跨工具的單向同步**：重新匯入會蓋掉或重複，修改不回寫 | ●● | [S55] Zotero 只保留 persist 區塊；[S59] 重複產生筆記；[S60] Readwise 只附加 |
| 8 | **同步不可靠、衝突處理粗糙**（特別是非文字檔：畫布、手繪、手寫） | ●●● | [S43] canvas 「last change wins」；[S44] 連線不同步；[S45] Excalidraw 不同步；[S17] Obsidian ≤2 星中 22/69 提 sync；[S18] Notability ≤2 星中 49/162 提遺失 |
| 9 | **畫布與筆記圖譜脫節**：卡片連結不進 backlinks 或 graph | ●● | [S42] 「breaks the 'link your thinking'」；[S41] 「lose object permanence」 |
| 10 | **畫布規模失控、雜亂、行動版難用、匯出弱** | ●● | [S48] 「invite messes」「become unusable」on mobile；[S47] Heptabase 建議拆白板；[S49] 只能匯出整個資料庫 |
| 11 | **概念太多、學習曲線陡**（typed objects、supertags、properties） | ●● | [S13] Tana 「>90 … will likely never get there」；[S12] Capacities 需要判斷流程；[S23] Logseq properties 迫使「upfront planning」 |
| 12 | **工具碎片化與切換成本**：同一個主題散落 3–5 個 app | ●● | [S67] HBR 每天約 1,200 次切換；[S69] 每天 10 個 app；[S70] 一人 5 個工具；[S62] 「spread across three different apps」 |
| 13 | **任務被埋在筆記裡**，最後外移到專用任務 app | ●● | [S74] rollover 外掛與 Todoist 橋接；[S32] 「getting tasks out… joyless」 |
| 14 | **間隔重複的建卡負擔與信任問題**（卡片漏排、metadata 污染筆記） | ●● | [S79] 寫好提示卡是瓶頸；[S83] 1500 張剩 155；[S84] 「How can I trust RemNote?」；[S82] YAML 弄亂版本控制 |
| 15 | **對強推 AI 的反感**，以及「AI 要在本機、只在我要的時候出現」 | ●● | [S17] Notion ≤2 星中 32/99 提 AI；[S21] 「think-for-me tool」；[S57] 隱私與 local-first 是硬需求、偏好 pull 而非 push |

---

## 8. 對 Onden 的啟示

Onden 同時有 markdown 筆記、帶「功能」的 tag（間隔重複、稍後讀、RSS、引用）、白板與墨跡、Excalidraw、PDF 標註與墨跡、任務與議程、集合（表格／看板）、網站發佈、AI agents、offline-first 同步和 Android app。依照上面的證據，這樣一個工具最該做對的是：

1. **捕捉的速度是第一優先**（痛點 1）。
   - Android 和 Web 都要在 1 秒內出現可輸入的編輯器，其他東西在背景載入（呼應 [S15] 的提案）。
   - 捕捉時**不要求選擇型別、空間、資料夾**。建議預設進 Inbox 或今日筆記，之後再加 tag。新筆記預設 Only me 是對的，但不要在捕捉時跳出權限選擇。
   - 分享選單、快捷磚、語音也應該直接寫入 Inbox。
2. **讓 tag 的「功能」降低系統建構成本，而不是增加概念**（痛點 3、11）。
   - 使用者讚賞「開箱就有」（[S7] Heptabase），討厭「先學 supertag 才能用」（[S13]）。
   - 「功能」應該是加一個 tag 就生效、看得懂、可以撤銷；不要讓使用者先設計 schema。「繼承」這種概念要可以完全忽略也能用。
3. **把「回顧／重現」做成內建的、拉取式的、低量的功能**（痛點 2、14）。
   - SR tag、Readwise 式的每日少量重現、「好久沒碰的筆記」，都放進同一個每日回顧入口。
   - 預設 **pull 而不是 push**，有每日上限和「暫停／度假」（[S57] 與 [S85] 都這樣要求）。
   - 排程資料**不要寫回筆記本文或 frontmatter**（[S82]），並提供「從未排入佇列的卡片」檢查，避免 [S83][S84] 那種信任崩潰。
4. **讓手寫、墨跡成為一等公民**：可以連結、可以搜尋、保留原筆跡（痛點 4）。
   - 白板墨跡與 PDF 墨跡要能被 `[[連結]]`，也能被 `#tag ^id` 指到特定區塊或頁面。
   - OCR 或轉錄當成**可重新產生的檢視層**，原始筆跡才是真正的來源（[S30] 的架構）。
   - 搜尋要能命中手寫。把「本機 OCR」或「明確同意才上雲」講清楚（[S37]）。
5. **畫布卡片必須就是筆記本身，而不是複本**（痛點 9、10）。
   - 卡片裡的連結要進 backlinks、graph、tag 頁（[S42]）。
   - 大白板要有分區、框架、縮圖導覽，也要能拆成子白板（[S47][S48]）。
   - 在 Android 窄螢幕上提供**列表或大綱 fallback 檢視**（[S48]），並且能匯出單一白板（[S49]）。
6. **非文字檔的同步要能合併，不能「最後寫入者勝」**（痛點 8）。
   - 畫布、Excalidraw、墨跡、PDF 標註的同步要做到元素層級合併，至少要產生衝突副本（[S43][S44]）。
   - 同步狀態要看得到：哪些尚未上傳、離線佇列裡有什麼。
   - 這正是 offline-first 的賣點，也是 Notability、Obsidian 評論區最大的怒點（[S17][S18]）。
7. **閱讀到筆記之間要雙向而且冪等**（痛點 6、7）。
   - RSS 或稍後讀 → 畫線 → 筆記：畫線應該是有穩定 ID 的物件，筆記引用它，而不是複製一份。
   - 重新匯入不能蓋掉使用者的編輯，也不能產生重複（避開 [S55][S59][S60] 的陷阱）。
   - PDF 標註要寫回標準 PDF 標註層，或可以匯出（[S61]）。
   - 「稍後讀」要有清理或到期機制，避免變成墓園（[S56][S57]）。
8. **可攜性要是一種承諾，而且要給使用者看得到的證明**（痛點 5、6）。
   - markdown 加開放格式（畫布用類似 JSON Canvas 的規格，墨跡用 SVG 或標準 PDF 標註），隨時可以完整匯出（包含畫線、墨跡、連結、SR 狀態），而且**匯出後連結不斷**。
   - 能自架或本機優先，是很多人選擇工具的硬條件（[S23][S57]）。
   - 匯入器要優先處理最痛的來源：Notion 資料庫、Omnivore/Readwise 畫線、GoodNotes 與 Notability 的 PDF。
9. **「整合」指的是資料連結，而不是把功能塞進同一個 UI**（痛點 12、13）。
   - 證據顯示，使用者拒絕「被迫用同一種結構做所有事」，但想要「同一處搜尋、互相連結」。
   - Onden 要讓每個 lens（白板、集合、議程、tag 頁）都是**同一份資料的不同視角**，而且每個 lens 都要夠好，不能是 spork（[S76]）。
   - 任務要能在筆記裡就地建立，同時集中顯示在議程裡，並提供 rollover，免得「寫在 daily note 就忘了」（[S74]）。
10. **AI agents 要預設克制**（痛點 15）。
    - 使用者偏好 pull、本機、可審閱、不打擾（[S57]），也明確反感被強推（[S17] Notion 評論）。
    - 建議 AI 只在明確觸發時動作，產出可以 diff 或撤銷，並清楚標示哪些資料會離開裝置。

---

## 9. 來源清單

| ID | 來源 | 類型 |
|---|---|---|
| S1 | HN「Ask HN: What note taking app do you use and why?」(2024) https://news.ycombinator.com/item?id=41228758 | HN 一手 |
| S2 | HN「Ask HN: How do you take notes throughout your work day?」(2021) https://news.ycombinator.com/item?id=28508811 | HN 一手 |
| S3 | HN「Ask HN: How do you review your Zettelkasten notes?」(2023) https://news.ycombinator.com/item?id=38711029 | HN 一手 |
| S4 | IBM Research Brazil, "How People Manage Knowledge in their 'Second Brains'" (2025) https://arxiv.org/abs/2509.20187v1 | 學術 |
| S5 | Bernstein, Van Kleek, Karger, schraefel, "Information Scraps" ACM TOIS 2008 https://people.csail.mit.edu/msbernst/papers/TOIS-final-with-refs.pdf | 學術 |
| S6 | Obsidian Forum「How do you manage "pornographic" productivity」https://forum.obsidian.md/t/how-do-you-manage-pornographic-productivity-in-obsidian/15906 | 論壇 |
| S7 | fpnotes「I'm trying out Heptabase (and maybe kind of abandoning Obsidian)」https://www.fpnotes.io/im-trying-out-heptabase-and-maybe-kind-of-abandoning-obsidian/ | 部落格 |
| S8 | 「obsidian is starting to stress me out」https://ma314.bearblog.dev/obsidian-is-starting-to-stress-me-out/ | 部落格 |
| S9 | D'Arcy Norman「rebooting my note-taking」(2026) https://darcynorman.net/2026/07/17/rebooting-my-note-taking/ | 部落格 |
| S10 | ⚠️ codeculture「Stop Overengineering Your Obsidian Vault」https://codeculture.store/blogs/developer-culture/obsidian-minimal-developer-setup | 商業部落格（數據未驗證） |
| S11 | Signal「Why I Still Use Apple Notes」https://joinsignal.substack.com/p/why-i-still-use-apple-notes | 部落格 |
| S12 | Capacities docs「object types vs folders」https://docs.capacities.io/tutorials/object-types-vs-folders | 官方文件 |
| S13 | Substack note on Tana https://substack.com/note/c-132660571 | 個人貼文 |
| S14 | Anytype Community「Why I Can't Stay In AnyType For Now」https://community.anytype.io/t/why-i-cant-stay-in-anytype-for-now/28733 | 論壇 |
| S15 | Obsidian Forum「Mobile, startup: Reduce the time until the user can write」https://forum.obsidian.md/t/mobile-startup-reduce-the-time-until-the-user-can-write/57450 | 論壇 |
| S16 | QuadrantNine「So long, Notion」https://buttondown.com/QuadrantNine/archive/so-long-notion/ | 部落格 |
| S17 | App Store 評論抽樣：Obsidian https://apps.apple.com/us/app/id1557175442 、Notion https://apps.apple.com/us/app/id1232780281（iTunes RSS，各 250 則，2025-06～2026-10） | 一手評論 |
| S18 | App Store 評論抽樣：Notability https://apps.apple.com/us/app/id360593530（250 則，2026-08～10） | 一手評論 |
| S19 | App Store 評論抽樣：GoodNotes https://apps.apple.com/us/app/id1444383602（250 則，2026-08～10） | 一手評論 |
| S20 | （同 S17，Notion 部分） | |
| S21 | Dave Rupert「Notion to Obsidian」(2025) https://daverupert.com/2025/05/notion-to-obsidian/ | 部落格 |
| S22 | TechCrunch「Evernote will restrict free users to 50 notes」https://techcrunch.com/2023/11/29/its-official-evernote-will-restrict-free-users-to-50-notes | 新聞 |
| S23 | Logseq Forum「Is anyone planning to use OG version indefinitely?」https://discuss.logseq.com/t/is-anyone-planning-to-use-og-version-indefinitely/35091 ；「Concerns on DB version… from a 3-year user」https://discuss.logseq.com/t/concerns-on-db-version-and-future-state-from-a-3-year-user/29225 ；whiteboard 擱置見搜尋摘要 | 論壇 |
| S24 | 「Farewell, LogSeq」https://zoia.org/posts/farewell-logseq/ | 部落格 |
| S25 | HN「Ask HN: Favorite note-taking software?」(2018) https://news.ycombinator.com/item?id=17532094 | HN 一手 |
| S26 | 「I Finally Stopped Switching Note-Taking Apps」https://ivolog.bearblog.dev/stopped-switching-apps/ | 部落格 |
| S27 | Tyler Suits「Apple Notes > Obsidian > Notion > Apple Notes」https://tylersuits.bearblog.dev/apple-notes-obsidian-notion-apple-notes/ | 部落格 |
| S28 | Ness Labs「Shiny Toy Syndrome」https://newsletter.nesslabs.com/posts/ness-labs-shiny-toy-syndrome | Ness Labs |
| S29 | MacPowerUsers「Goodnotes, Obsidian, and Devonthink」https://talk.macpowerusers.com/t/goodnotes-obsidian-and-devonthink/25551 | 論壇 |
| S30 | 「Getting reMarkable notes into Obsidian automatically」https://khalidibnehasan.substack.com/p/getting-remarkable-notes-into-obsidian | 部落格 |
| S31 | MacPowerUsers「Harnessing Handwritten Notes in Obsidian (An e-ink workflow)」https://talk.macpowerusers.com/t/harnessing-handwritten-notes-in-obsidian-an-e-ink-workflow/37407 | 論壇 |
| S32 | MacPowerUsers「PKM with handwritten notes?」https://talk.macpowerusers.com/t/pkm-with-handwritten-notes/21676 | 論壇 |
| S33 | Obsidian Forum「Link to Obsidian Note from Samsung Notes (PDF)」https://forum.obsidian.md/t/link-to-obsidian-note-from-samsung-notes-pdf/57110 | 論壇 |
| S34 | Obsidian Forum「How to use and link handwritten Notes」https://forum.obsidian.md/t/how-to-use-and-link-handwritten-notes/16719 | 論壇 |
| S35 | ⚠️ reMarkable 手寫轉文字準確率（評論文章彙整，見搜尋結果；官方說明 https://support.remarkable.com/articles/Knowledge/Convert-handwritten-notes-into-text ） | 二手 |
| S36 | Microsoft Tech Community「OneNote cannot search for handwriting」https://techcommunity.microsoft.com/discussions/microsoft-365/onenote-cannot-search-for-handwriting/4554604 | 論壇 |
| S37 | Obsidian Forum 同 S34，#43 https://forum.obsidian.md/t/how-to-use-and-link-handwritten-notes/16719/43 | 論壇 |
| S38 | Obsidian Forum「How to transfer my handwritten notes from Notability to Obsidian?」https://forum.obsidian.md/t/how-to-transfer-my-handwritten-notes-from-notability-to-obsidian/105070 | 論壇 |
| S39 | Michael Tsai「Notability's Subscription Transition」https://mjtsai.com/blog/2021/11/12/notabilitys-subscription-transition ；AppleInsider https://appleinsider.com/articles/21/11/03/notability-backs-down-on-subscriptions-for-existing-users | 新聞與評論 |
| S40 | HN「Show HN: Obsidian Canvas」(2022, 387 則) https://news.ycombinator.com/item?id=34066824 | HN 一手 |
| S41 | Andy Matuschak「Digital note-writing systems fixate on… individual notes」https://notes.andymatuschak.org/zsRuFxYgckGS81tr2eiBAP | 專家筆記 |
| S42 | Obsidian Forum「Canvas cards and notes in links, backlinks and… graph view」https://forum.obsidian.md/t/canvas-cards-and-notes-in-links-backlinks-and-outgoing-arrows-in-graph-view/49697 | 論壇 |
| S43 | Obsidian Forum「Canvas sync bug: single-note edit on mobile (offline) overwrites entire canvas」https://forum.obsidian.md/t/canvas-sync-bug-single-note-edit-on-mobile-offline-overwrites-entire-canvas-on-laptop/103907 | 論壇 |
| S44 | Obsidian Forum「Canvas sync」https://forum.obsidian.md/t/canvas-sync/49348 | 論壇 |
| S45 | Obsidian Forum「Sync Excalidraw files」https://forum.obsidian.md/t/sync-excalidraw-files/17994 | 論壇 |
| S46 | ⚠️ Excalidraw 2MB 索引限制（搜尋摘要，來源 https://github.com/zsviczian/obsidian-excalidraw-plugin/ ） | 二手 |
| S47 | Heptabase Support「Troubleshooting performance and lag」https://support.heptabase.com/en/articles/11430704-troubleshooting-performance-and-lag-issues-in-heptabase | 官方文件 |
| S48 | joodaloop「Canvas UI」https://joodaloop.com/canvas-ui | 部落格 |
| S49 | outlinersoftware「Heptabase - Crimp cured?」https://www.outlinersoftware.com/topics/viewt/10244/0/heptabase--crimp-cured | 論壇 |
| S50 | ⚠️ Freeform 限制彙整（intego、setapp 等搜尋結果）https://www.intego.com/mac-security-blog/apple-freeform-lets-you-brainstorm-and-collaborate-on-mac-ipad-and-iphone/ | 二手 |
| S51 | Obsidian blog「2026 Obsidian October」（State of Obsidian 調查宣布）https://obsidian.md/blog/2026-obsidian-october/ | 官方 |
| S52 | MacPowerUsers「Discussion of Freeform」https://talk.macpowerusers.com/t/discussion-of-freeform/31902 | 論壇 |
| S53 | Ness Labs 訪談 Readwise 共同創辦人 Daniel Doyon https://nesslabs.com/?p=11904 | 訪談 |
| S54 | HN「Show HN: Readwise Reader」(2022, 156 則) https://news.ycombinator.com/item?id=34006202 | HN 一手 |
| S55 | USU Groundwater Lab「A Zotero to Obsidian Workflow」https://groundwater.usu.edu/blog/2023/A-Zotero-to-Obsidian-Workflow/ | 學術部落格 |
| S56 | zettelkasten.de「The Collector's Fallacy」http://zettelkasten.de/posts/collectors-fallacy | 專家文章 |
| S57 | HN「Ask HN: Do you also "hoard" notes/links but struggle to turn them into actions?」(2026-01, 217 則) https://news.ycombinator.com/item?id=46826277 | HN 一手 |
| S58 | ⚠️ memx「read-it-later list graveyard」https://memx.app/blog/read-it-later-list-graveyard/（Pocket 10% 數據無具名來源） | 二手 |
| S59 | Zotero Forums「add an extra option to "add note from annotations" to automatic overwrite」https://forums.zotero.org/discussion/comment/415253/ | 論壇 |
| S60 | Readwise Docs「Readwise to Obsidian export integration」https://docs.readwise.io/readwise/docs/exporting-highlights/obsidian | 官方文件 |
| S61 | Macdrifter「PDF Annotation and Portability」https://macdrifter.com/2021/06/pdf-annotation-and-portability.html | 部落格 |
| S62 | MacPowerUsers「Any one using Matter… to replace Instapaper and Pocket」https://talk.macpowerusers.com/t/any-one-using-matter-in-view-to-replace-instapaper-and-pocket-etc/27034?page=2 | 論壇 |
| S63 | Readwise Docs「Kindle: truncated highlights」https://docs.readwise.io/readwise/docs/importing-highlights/kindle | 官方文件 |
| S64 | HN「Omnivore reader shutting down – favorite alternatives?」https://news.ycombinator.com/item?id=41993167 ；ElevenLabs 公告 https://elevenlabs.io/blog/omnivore-joins-elevenlabs | HN 與官方 |
| S65 | wallabag「Migrate from Omnivore」https://wallabag.org/news/20241031-migrate-from-omnivore/ | 官方 |
| S66 | TechRadar「Pocket shuts down today」https://www.techradar.com/computing/websites-apps/pocket-shuts-down-today-heres-how-to-get-your-data-before-the-app-closes-plus-the-3-best-alternatives ；CyberInsider https://cyberinsider.com/mozilla-to-shut-down-pocket-service-in-july-to-allow-exports-until-october/ | 新聞 |
| S67 | HBR「How Much Time and Energy Do We Waste Toggling Between Applications?」(2022) https://hbr.org/2022/08/how-much-time-and-energy-do-we-waste-toggling-between-applications | 研究（付費牆，數字經 S68 轉述） |
| S68 | Canadian Underwriter 轉述 HBR https://canadianunderwriter.ca/2022/08/31/how-much-time-you-waste-toggling-between-applications/ | 二手 |
| S69 | Asana「Why work about work is bad」https://asana.com/resources/why-work-about-work-is-bad | 廠商調查 |
| S70 | Beth McClelland「You don't need an all-in-one workspace」https://bethmcclelland.beehiiv.com/p/you-dont-need-an-all-in-one-workspace | 部落格 |
| S71 | Obsidian Forum「Missing Notion Database Data when Exporting」https://forum.obsidian.md/t/missing-notion-database-data-when-exporting-to-markdown-csv-or-html/37931 | 論壇 |
| S72 | ⚠️ unmarkdown「Notion export broken」https://unmarkdown.com/blog/notion-export-broken | 廠商部落格 |
| S73 | Yarle README https://unpkg.com/yarle-evernote-to-md@6.16.0/README.md ；Obsidian Forum https://forum.obsidian.md/t/converting-evernote-to-obsidian/1715 | 文件與論壇 |
| S74 | Obsidian Forum「Better Management of Tasks using Daily Notes」https://forum.obsidian.md/t/better-management-of-tasks-using-daily-notes/13429 ；Sync Todoist plugin https://community.obsidian.md/plugins/sync-todoist ；⚠️ Lemmy 討論 https://feddit.it/post/719293（被擋，僅搜尋摘要） | 論壇與外掛 |
| S75 | ⚠️ r/PKMS「Advice on apps」(2024-09) 鏡像 https://lr.us.psf.lt/r/PKMS/comments/1fl7yy1/advice_on_apps（無法開啟，僅搜尋摘要） | Reddit（未驗證） |
| S76 | ⚠️ mickmel「Get all of the best apps or just use a spork」https://mickmel.com/get-all-of-the-best-apps-or-just-use-a-spork（403，僅搜尋摘要） | 部落格（未驗證） |
| S77 | Obsidian 官方外掛下載統計 https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json（2026-10-13 抓取） | 官方數據 |
| S78 | ⚠️ RemNote 評論彙整（G2 https://www.g2.com/products/remnote/reviews 、techjockey） | 評論彙整 |
| S79 | Andy Matuschak「The limiting factor in SRS capacity is writing enough good prompts」https://notes.andymatuschak.org/z4zvsYb38iMhkDgZzKzjqpzKKtwPhvt4FuzcS | 專家筆記 |
| S80 | Andy Matuschak「Writing good spaced repetition memory prompts is hard」https://notes.andymatuschak.org/zKy4FsHTcf8LdkgXkMueeGL | 專家筆記 |
| S81 | Andy Matuschak「Regular spaced repetition memory practice is an onerous habit to adopt」https://notes.andymatuschak.org/zyk3ZCEVSB4Zwej3Xd4CJ2g1FynRFTZGJpQN | 專家筆記 |
| S82 | GitHub obsidian-spaced-repetition #162「Stop using YAML」https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/162 ；#764 https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/764 ；#776 https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/776 | Issue tracker |
| S83 | GitHub obsidian-spaced-repetition #923「Most of my flashcards are now missing」https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/923 | Issue tracker |
| S84 | RemNote Forum「Problems with flashcards」https://forum.remnote.io/t/problems-with-flashcards/6731 | 論壇 |
| S85 | GitHub obsidian-spaced-repetition 依讚數排序的 issues（#516 FSRS +50、#748 +38、#505 Daily Limits、#798 Pause、#27 Export to Anki） https://github.com/st3v3nmw/obsidian-spaced-repetition/issues | Issue tracker |
| S86 | Obsidian Stats「Best Plugins for Spaced Repetition」https://www.obsidianstats.com/posts/2025-05-01-spaced-repetition-plugins | 彙整 |

可直接驗證的獨立來源約 75 個。⚠️ 標記的約 11 個只建議作為背景，不宜單獨引用。
