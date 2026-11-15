# 介面與用詞一致性審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：`packages/frontend/src` 的元件、`modules/*`、`lib/i18n*.ts`、導覽（MobileNav、AppTopbar、側欄、指令面板、設定 registry）。

方法與限制：

- 全部來自讀程式碼與靜態掃描。沒有開瀏覽器、沒有在 Android 真機或手機尺寸跑過，所以「畫面上看到什麼」是從元件與字典推出來的。
- 本次沒有跑 vitest／build（只審查、不改程式）。
- 沒有讀任何 `.md` 文件。
- 掃描腳本放在 session scratchpad，沒有提交。
- 嚴重度：**P1** = 使用者會困惑或被擋住；**P2** = 不一致或打磨。
- **CONFIRMED** = 已在程式碼中確認字串與觸發路徑；**SUSPECTED** = 看得出問題，但沒實際操作確認。

## 摘要

- 共 37 項：P1 8 項、P2 29 項。
- 各組數量：用詞 11、技術細節外洩 6、死路 4、匯入步驟 3、重複入口 5、手機／桌面 3、無障礙 5。
- 最大的問題有兩個：
  - 「功能要用到才出現、不需要匯入步驟」這條規則，目前在程式裡不成立（M1、M2）。
  - 同一件事有好幾個入口與好幾個名字（E1、E4、W1、W2）。
- 英文遺漏很少：全部 2504 個 `t("…")` 字面字串都有 zh-TW 對應，字典 3030 條裡只有 7 條值不含中文（`English`、`Markdown` 等刻意保留）。真正漏掉的是**不經 `t()` 的資料字串**（W10、W11）。

## 第一次使用的前五分鐘：概念數

以下是從程式碼推算，不是實際觀察一位新使用者。依「首頁、頂欄、側欄、歡迎卡、新增選單」列出新使用者會碰到、需要分辨的名詞，共約 **18 個**：

1. 筆記
2. 捕捉（快速捕捉）
3. 標籤（`#`）
4. 白板
5. 今日筆記／日記
6. 起始標籤
7. 網站（發布）
8. 任務
9. 關係圖
10. 歷史
11. 收件匣
12. 搜尋／指令面板
13. 更多
14. 資訊面板
15. 設定
16. 同步狀態（待同步、離線）
17. 新增類型（手寫、PDF、圖片、書籤）
18. 空間（筆記上的空間標籤）

打開「更多」或任何一個「需要匯入」的提示後，還會再加上「功能／模組／匯入／模組庫」這組同義詞，加上技能、複習、RSS 等約 6 個。這比一個專為學生日常使用的 PWA 該有的量多；W2、M1 就是在這裡放大。

## 詞彙對照表（使用者看得到的概念）

| 概念 | 畫面上的中文（字典行） | 出現位置 | 判斷 |
| --- | --- | --- | --- |
| 模組（可匯入的東西） | 模組（2548、設定分頁）／功能（2618「Features」、1101、2457「Functions」）／加功能（2992）／模組庫／「設定 › 模組」 | 更多面板群組 `shellNavigation.ts:241`；設定分頁 `registry.tsx:50,92`；標籤頁 `TagFunctionPicker.tsx:71` | **三個名字指同一個東西**（W2） |
| 復原／還原 | 還原（152、1199、1202、475）／復原（845、115、441、1774） | 歷史、衝突、版本、事件、備份 | **混用**（W1） |
| 白板 | 白板（1080、890）／畫布（954「Canvases」、935、939） | 指令面板群組 `CommandPalette.tsx:203`；模組名 | **混用**（W4） |
| 看板 | 看板（674「Board」） | kanban 模組；但 3049「Boards under Notes」＝白板 | **一詞兩義**（W5） |
| 視角（lens） | 檢視（2098）／視圖（921、922、581） | `LensStrip.tsx:35`、指令面板 | **混用**（W6） |
| 歷史 | 歷史（888）／時間軸（897）／操作紀錄（28、29） | 導覽、右鍵、設定 | **三名**（W7） |
| 日記 | 日記（2768、2771）／每日筆記（928） | `modules/daily`、範本、歡迎卡 | **兩名**（W8） |
| AI | AI 助手（429、1715、1778）／agent（1724）／代理（2371）／AI（SpaceChip） | 側欄、歷史、設定、事件紀錄 | **四名**（W3） |
| 金鑰 | 金鑰（1042、1050、1060）／token（1918–1920） | 事件紀錄標籤 | **混用**（W9） |
| 捕捉／新增筆記 | 捕捉（1071）／快速捕捉（358）／新筆記（1207）／新增其他類型（825） | 頂欄、手機 +、側欄 + | **多名多入口**（E1） |
| 新增標籤 | 「Add a tag」與「New tag」都譯成「新增標籤」 | `TitleTagRow.tsx:137`、`OverviewSidebar.tsx:554` | **一個是套用、一個是建立**（E4） |
| 移動 | 移到…（379）／移動…（1183）／設定上層（1186） | `SpaceChip.tsx:105`、`MoveToDialog.tsx:26`、`NoteBreadcrumb.tsx:94` | **「移到…」有兩種意思**（E3） |
| 空間／工作區 | 空間（390）／工作區（242） | 設定、歡迎卡 | 一致（空間＝權限容器、工作區＝整體）；做得好 |
| 標籤的繼承 | 繼承（2450–2523）／上層標籤（2523） | 標籤頁 | 兩個詞同時出現；SUSPECTED 會讓新手多想 |
| 網站 | 網站（Site／Website）／網站呈現（Web Render）／站台（1 處，967） | 網站模組 | 小不一致，併入 T6 一起改 |

## 一、用詞（11）

**W1（P1，CONFIRMED）「還原」和「復原」混用。**
- 字典行 152「Revert」→還原、1199／1202「Restore」→還原、475「Restored」→還原了；同一類操作卻是 115「Restore preview」→復原預覽、441「Undo this change」→復原這項變更、1774「連鎖還原」。
- 使用者在歷史頁按「還原」，結果預覽叫「復原預覽」，完成訊息寫「已復原成新的筆記」。
- 建議：定一個詞（建議「復原」＝撤銷一次操作；「還原」只用在備份），全字典統一。

**W2（P1，CONFIRMED）同一個概念有三個名字：功能、模組、（標籤）功能。**
- 手機「更多」群組叫「功能」（`shellNavigation.ts:241`），列表裡的最後一列叫「管理模組」（:253）。
- 設定有「模組」分頁（`registry.tsx:50`）和「功能」群組（:92）。
- 標籤頁的按鈕叫「加功能」，選單裡的搜尋框叫「搜尋模組」（`TagFunctionPicker.tsx:71-72`）。
- 字典 1064「這個包的自動化需要 {modules} 功能」把模組稱「功能」。
- 建議：對使用者只留一個詞（業主說「功能」），把「模組庫」、「模組」都改掉。

**W3（P1，CONFIRMED）AI 的稱呼有四種，而且技能對話框暗示 Onden 自己跑 AI。**
- 「AI 助手」（429）、「agent」（1724「只看 agent」）、「代理活動」（2371）、「AI」（`SpaceChip.tsx:95`）。
- `NewSkillDialog.tsx:74,77,98` 與 `ImportSkillDialog.tsx:81` 寫「要 AI 做什麼」、「執行技能需要開啟外部 AI 的空間」。但 `modules/skills/api.ts:1` 自己的註解說 Onden 不跑模型，技能是給使用者的 Claude 透過 MCP 用的。
- 使用者會去找一個不存在的「執行」按鈕。
- 建議：統一成「Claude」或「你的 AI 助手」，技能表單的文案改成「寫下 Claude 該怎麼做」，刪掉「執行技能需要…外部 AI」那句。

**W4（P2，CONFIRMED）白板／畫布。**
- 指令面板群組標題「Canvases」→畫布（字典 954，`CommandPalette.tsx:203` 顯示），同一列的項目提示「Canvas」→白板（:238）。
- 「Tidy up canvas (grid)」→整理畫布（935）。
- 建議：全部用「白板」。

**W5（P2，CONFIRMED）「Board」一詞兩義。**
- 看板模組叫「看板」（674）；字典 3049 的 「Boards under Notes」是白板，程式註解也叫 board（`useCommandPalette.ts` 「Board actions」）。
- 建議：英文鍵保持 Board＝看板，白板一律用 Canvas。

**W6（P2，CONFIRMED）檢視／視圖。**
- 「Lens」→檢視（2098）、「Editor lens」→編輯器視圖（921）、「Views」→檢視（模組庫子標題）、「saved views」→儲存視圖（581）。
- 建議：統一成「檢視」。

**W7（P2，CONFIRMED）歷史／時間軸／操作紀錄。**
- 導覽叫「歷史」（888），指令面板「前往歷史」（924），右鍵（雖然不可達，見 D1）叫「時間軸」（897）。
- 「Activity across your workspace」→工作區的操作紀錄（29）。
- 建議：全部用「歷史」。

**W8（P2，CONFIRMED）日記／每日筆記。**
- 模組叫「日記」，範本與歡迎卡叫「每日筆記」（928），指令叫「開啟今天的筆記」。
- 建議：統一成「今日筆記」或「日記」其一。

**W9（P2，CONFIRMED）金鑰／token。**
- 字典 1042–1060 用「金鑰」，但 1918–1920 的事件名叫「建立 token」「撤銷 token」「變更 token 範圍」，旁邊的 1921 叫「變更金鑰權限」。
- 事件紀錄列表會同時出現兩種寫法。
- 建議：事件名跟著用「金鑰」，或乾脆在介面避開這個詞。

**W10（P2，CONFIRMED）資料字串漏翻：心情提示與調色盤名稱。**
- `HomeStart.tsx:82` `title={m.label}`：`lib/moodStreak.ts:16-20` 的 Rough／Low／Okay／Great 不在字典，手機長按與桌面懸停會看到英文（Good 剛好有條不相干的 683 所以是中文）。
- `WebsiteDesignPanel.tsx:188,192`（強調色）與 :200 起（紙張色）直接顯示 `p.name`：Rust／Forest／Teal／Ocean／Plum／Rose／Slate／Warm／Sand／Mist／Cloud 都是英文（字典雖有 Oxblood（2049）但這裡沒呼叫 `t()`）。
- 建議：加 `t()` 並補字典。

**W11（P2，CONFIRMED）白板新增的框預設標題寫死英文。**
- `hooks/useCanvasActions.ts:125`「Section」、:136「Group」被存進白板資料，之後中文使用者的新分區標題就是英文。
- 建議：建立時用 `t("Section")`／`t("Group")`。

## 二、技術細節外洩（6）

**T1（P1，CONFIRMED）匯入 `.canvas` 失敗時 toast 會印出 JSON 路徑與「JSON」。**
- 路徑：白板匯入有問題的檔案 → `lib/data/canvasImport.ts:38` 把 `error.message` 塞進「無法匯入這份 .canvas 檔案：{detail}」；`lib/jsonCanvas.ts:94` 的訊息格式是 `${path}: ${t(detail)}`，例如 `nodes[3].id: 節點 ID 不可為空且不可重複`（字典 2214、2218）。
- 字典 593 還直接寫「不是有效的 JSON」。
- 建議：只說「第幾張卡片有問題」或「這份檔案格式不對」，不要印路徑與 JSON。

**T2（P2，CONFIRMED）登入表單會顯示伺服器原文。**
- `LoginGate.tsx:33` `return error.message ?? fallback;`。沒被前面幾個代碼接住的認證錯誤，會顯示 better-auth 的英文原文。
- 建議：沒有對照就用 `fallback`。

**T3（P2，CONFIRMED）伺服器網址檢查會印出 HTTP 狀態碼。**
- `lib/api.ts:450` →「伺服器回應 {status}」。第一次設定連錯網址時看到「伺服器回應 404」。
- 建議：改成「這個網址不像 Onden 伺服器」。

**T4（P2，CONFIRMED）PDF 載入失敗印出函式庫原文。**
- `components/PdfNodeView.tsx:503`「無法載入 PDF：{message}」，`message` 是 pdf.js 的英文錯誤。
- 建議：只顯示「無法載入這份 PDF」。

**T5（P2，CONFIRMED）區塊連結選單有「產生新 ID」。**
- `lib/editorCompletion.ts:193`，在筆記裡輸入 `^` 時會看到。
- 建議：「為這段建立連結」。

**T6（P2，CONFIRMED）中文文案裡的工程詞。**
- 「LWW 勝出」`ConflictList.tsx:79,90`（字典 831、832）。
- 「連鎖還原：…後續觸發的事件（略過預覽）」`NodeEventHistory.tsx:192`、`EventLogPanel.tsx:177`，按鈕本身只顯示 `+3`。
- 「schema tag」`registry.tsx:603`（字典 1064）。
- 「frontmatter」`registry.tsx:320`（字典 204）。
- 「外部副作用」`InboxReview.tsx:515`、「對外動作」:184。
- 「MCP」（字典 2627–2630，模組說明）。
- 「同源」（265）。
- 「下載備份（.sqlite3）」（207）。
- 建議：用一句白話取代，或乾脆不顯示。

## 三、死路（4）

**D1（P2，CONFIRMED）整個「節點右鍵選單」打不開，連帶的「Git」面板是死碼，裡面還有技術細節。**
- `KnowledgeWorkspace.tsx:986-996` 有「時間軸／Git／網站呈現」按鈕，但 `setNodeMenu` 只會被呼叫成 `null`（`useNodeSelection.ts:38`、`useNodeLifecycle.ts:57`、`useBoardWorkspace.ts:177`），沒有任何地方打開它。
- 那個「Git」面板（`SideDrawers.tsx:62-72`）會印 `node_id`、`slug` 和「預計路徑 content/….md」，標題「Git」沒翻譯。一旦有人接上就是技術外洩。
- 建議：整組刪掉（`nodeMenuLabel`（`modules/types.ts:44`）也一起）。

**D2（P2，SUSPECTED）Base 檔的地圖檢視只會說「尚未實作」。**
- `components/views/BaseRenderer.tsx:119`。如果 `.base` 檔寫了 `type: map`，使用者看到「地圖檢視尚未實作。」。
- 建議：不要讓這個選項出現，或改成明確的「不支援」。

**D3（P2，SUSPECTED）不可復原的事件，按鈕是停用的，原因只寫在 `title`。**
- `NodeEventHistory.tsx:199`。手機沒有 hover，看不到為什麼不能按。
- 建議：把原因印在按鈕旁邊的一行小字。

**D4（P2，CONFIRMED）快速捕捉的浮動按鈕永遠不顯示但仍渲染。**
- `QuickCapture.tsx:459-468` 渲染 `.quick-capture-fab`，`QuickCapture.css:5` 設 `display:none`；頂欄註解（`AppTopbar.tsx:207-212`）也還寫它是「手機浮動按鈕」。
- 建議：移除按鈕與過時註解。

## 四、匯入步驟（3）——對應業主規則「功能用到時就出現」

**M1（P1，CONFIRMED）「匯入模組」仍是使用者要自己走的獨立步驟，非擁有者在這裡會被完全擋住。**
- 新工作區預設只匯入白板（`packages/backend/src/modules/index.ts:168`）。
- 介面上有一整套概念：「已匯入（n）／可匯入」（`ModuleLibrary.tsx:60-61`）、「匯入這個模組？」確認視窗含「它會加入／它能存取」（`ModuleImportConfirm.tsx:103-123`）、標籤頁的「需要匯入／匯入並加上／由擁有者匯入」（`TagFunctionPicker.tsx:55-65`）。
- 至少 14 處文案叫使用者「到 設定 › 模組 匯入」（`ModuleNotImported.tsx:25`、`FunctionsSection.tsx:79,110,122`、`AddViewMenu.tsx:103`、`TagTidy.tsx:75`、`ModuleSettingsPage.tsx:73`…）。
- 非擁有者只看到「由擁有者匯入」或「請擁有者匯入」，沒有下一步。
- 建議：模組在第一次被用到時自動啟用，確認視窗只保留「它能連到外網」這種真的需要同意的情況。

**M2（P1，CONFIRMED）第一次使用就撞上匯入牆：歡迎卡「建立你的第一個網站」。**
- `WelcomeBanner.tsx:107` 的按鈕在新工作區必按得到：`useWelcomeBanner.ts:66-70` 發現網站模組沒匯入，只彈出 info toast「請先到 設定 › 模組 匯入」並跳到設定，網站不會被建立。
- 同樣的 toast 還出現在 `setupReview.ts:20`（複習）與 `moduleLibrary.ts:126`（標籤加功能），toast 本身沒有按鈕。
- 建議：歡迎卡的動作自己匯入需要的模組（這是使用者明確按下的動作），或在模組沒匯入時不顯示該按鈕。

**M3（P2，CONFIRMED）通往同一個地方的名字有四種。**
- 「模組庫」（`ModuleLibrary.tsx:141`）、「設定 › 模組」、「管理模組」（`shellNavigation.ts:253`）、「打開 設定 › 模組」（`ModuleNotImported.tsx:27` 的按鈕）。
- 建議：隨 W2／M1 一起收斂。

## 五、重複入口（5）

**E1（P1，CONFIRMED）「建立筆記」至少 8 個入口，名字與結果都不同。**
- 頂欄「捕捉」（`AppTopbar.tsx:228-237`）→ 開快速捕捉面板。
- 手機中間 `+`（`MobileNav.tsx:110-118`）→ 同一個面板。
- 側欄 `+`「新筆記」（`SidebarCreateMenu.tsx:29-34`）→ 立即建立空白筆記。
- 同一處「新增其他類型」選單裡又有一個「筆記」（:50）。
- 指令面板：「快速捕捉」（`useCommandPalette.ts:196`）、「建立筆記：{title}」（:265）、從範本新增、「新增手寫筆記」（:208）。
- 空狀態「新筆記」按鈕（`OverviewSidebar.tsx:653`、`OverviewEditor.tsx:725`）。
- 歡迎卡「寫下第一篇筆記」與「開啟今天的筆記」。
- 同樣是「寫一篇新的」，一組叫捕捉（先填內容再存）、一組叫新筆記（先建立再寫），使用者要先學會兩個詞。
- 建議：只留一個「新增」入口（手機＋、桌面頂欄），其他入口都呼叫同一個動作。

**E2（P2，CONFIRMED）搜尋有三個入口，三個名字。**
- 頂欄「搜尋…」其實是「指令面板」（`AppTopbar.tsx:240-242`，aria-label 是「指令面板」）。
- 手機頂欄搜尋圖示 aria-label 是「搜尋」但開的是同一個指令面板（:301-305）。
- 側欄有自己的「搜尋筆記」輸入框（`OverviewSidebar.tsx:540-569`），「篩選標籤」（:548）也是搜尋。
- 指令面板的 `?` 前綴又是「搜尋」（`CommandPalette.tsx:256`）。
- 建議：頂欄統一叫「搜尋」，指令用 `>` 前綴；側欄輸入框保留但標示它只過濾清單。

**E3（P2，CONFIRMED）「移到…」有兩種意思。**
- 筆記選單的「移到…」是換上層筆記（`MoveToDialog.tsx:26`「Move “{title}” to…」）。
- `SpaceChip.tsx:105` 的「移到…」是換空間（權限邊界）。
- 麵包屑的「移動…／設定上層」（`NoteBreadcrumb.tsx:94`）又是第三種寫法。
- 建議：換空間改叫「換到其他空間」，換上層統一叫「移到…」。

**E4（P1，CONFIRMED）「新增標籤」同時代表建立標籤與套用標籤。**
- `TitleTagRow.tsx:137`（筆記標題旁的 `+`，aria-label「新增標籤」）是把既有標籤貼到這篇筆記。
- `OverviewSidebar.tsx:554`（側欄，aria-label 也是「新增標籤」）是建立一個全新的標籤。
- 還有「加標籤…」（`ParagraphMenu.tsx:120`）、輸入 `#`、把筆記拖到標籤列上，共 5 條路。
- 建議：套用叫「貼上標籤」、建立叫「建立標籤」。

**E5（P2，CONFIRMED）匯出／備份三個說法、兩個位置。**
- 指令面板同時有「匯出工作區為 Markdown」（`useCommandPalette.ts:212`）和「下載所有筆記（.zip）」（:213），做的是同一件事。
- 設定 › 你的資料裡又有「匯出」「完整備份」「備份（還原回 Onden）」三個小節（`registry.tsx:781-845`）。
- 建議：指令面板只留一個，設定裡把三個合成「匯出」與「備份與還原」兩個。

## 六、手機與桌面（3）

**P1（P2，CONFIRMED）同一個面板在手機叫「搜尋」、桌面叫「指令面板」。**
- 見 E2：`AppTopbar.tsx:240` 與 :303。螢幕閱讀器使用者在兩種裝置聽到不同的名稱。

**P2（P2，SUSPECTED）寫作模式開關只有桌面有。**
- `AppTopbar.tsx:245`（`onToggleFocus && !phone`）。手機沒有看到對應入口；若業主希望手機是主要裝置，這個沒有對等。

**P3（P2，SUSPECTED）手機上列表沒有刪除按鈕，只能長按。**
- `OverviewSidebar.css:262-264`（`@media (hover: none)` 隱藏 `.obsidian-delete-btn`），刪除只在長按選單。這是刻意的，但新使用者不知道長按。

## 七、無障礙（5）

**A1（P2，CONFIRMED，用 `styles/tokens.css` 的背景色計算）寫死的顏色在深色模式對比不夠。**
- `InboxReview.css:118,127` 的 `#2f7d4f` 在深色底 `#1d1b19` 約 3.4:1。
- `ObsidianImport.css:390`、`NodeEventHistory.css:64` 的 `#c0392b` 在深色約 3.2:1。
- `OverviewEditor.css:340` 的 `#a78bfa`（9px 小字）在淺色底約 2.5:1，`CardNode.css:353`、`OverviewEditor.css:366` 同。
- 建議：換成 `--ac-success`／`--ac-danger`／專用 token。

**A2（P2，CONFIRMED）鍵盤聚焦到刪除鈕時看不到它。**
- `ObsidianImport.css:373-387`：`.obsidian-delete-btn { opacity: 0 }`，只有 `:hover` 才顯示（:300、:345），沒有 `:focus-visible` 或 `:focus-within`。
- hover 底色 `#fde8e8` 在深色主題也是亮粉色（:389）。
- 建議：加 `:focus-visible { opacity: 1 }`，hover 色改用 token。

**A3（P2，CONFIRMED）有幾處小於 40px 的點擊目標，而且正好是手機常用的。**
- `NavLayoutEditor.tsx:131-153`（編輯底部導覽列的上移、下移、移除、釘選）用 `size="sm"` 圖示鈕，`ui.css:133,139-141` 在 `pointer: coarse` 時只放大非 sm，所以是 30px。
- `CanvasMode.css:391`（32px 關閉）、`EditorLinkChip.css:8`（32px）、`citations.css:14`（34px）、`global.css:1824-1828`（36px）。
- 做得好的地方：底部導覽列 44–56px（`MobileNav.css:35,115`）。
- 建議：`sm` 在 coarse pointer 也補到 40px 以上。

**A4（P2，CONFIRMED）有圖示按鈕沒有名稱。**
- `CanvasNotesPanel.tsx:46` 的 `+` 新增卡片按鈕沒有 aria-label／title。
- `HomeStart.tsx:78-86` 的心情 emoji 按鈕只有（英文）`title`，沒有 aria-label。
- 建議：補上 `aria-label={t(...)}`。

**A5（P2，SUSPECTED）白板「加入既有筆記」彈窗是 `role="dialog"` 但不是真正的 modal。**
- `CanvasNotePicker.tsx:48` 沒有 `aria-modal`，也不在 `ui/Modal` 之下，不確定 Tab 鍵會不會跑到後面的白板。
- 其他所有對話框都走 `ui/Modal`（見「做得好的地方」）。

## 做得好的地方

1. **i18n 覆蓋非常完整。** 2504 個 `t("…")` 字面字串全部有 zh-TW 對應，字典值幾乎都含中文，英文鍵當 key 的設計讓漏翻只是顯示英文而不會壞掉。真正缺的是 W10、W11 這種不經 `t()` 的資料。
2. **錯誤文字有單一出口。** `serverErrors.ts:200-205` 以錯誤代碼對照；未知代碼用通用訊息，且 `ApiError`（`api.ts:640`）遇到代理伺服器的 HTML 頁面也不會顯示出來。`writeErrors` 負責裝置端的情況。除了 T2、T3、T4，沒有看到直接把 `error.message` 塞進畫面的地方。
3. **對話框的焦點處理一致。** `components/ui/Modal.tsx` 用原生 `<dialog>.showModal()`，後面頁面自動 inert，焦點循環、Esc、輸入法組字、關閉後還原焦點都處理了，專案內的對話框幾乎都走這條。
4. **深色模式的文字色大多通過。** 主要文字 13.8:1、次要文字 6.8:1、強調色 7.1:1（`styles/tokens.css:173-193`），而且「faint」色因為對比不足被重新對應到 muted（`styles/theme-tokens.css:94-97`），有寫原因。
