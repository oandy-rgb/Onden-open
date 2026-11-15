# 視覺細節的論文依據與試驗值（2026-09-28）

> 狀態：歷史紀錄（最後確認 2026-11-01）

承接[導航比例提案](navigation-proportions-2026-09-28.md)。使用者確認左側窄
功能列併入頂部，再要求查相關論文。本文記錄研究階段，當時未改正式UI。
使用者看過微調版後同意試用，後續實作見
[頂部導航與閱讀比例試用](top-navigation-trial-2026-09-28.md)。
研究支持的方向與 Onden 的候選尺寸分開；找不到固定「最佳側欄比例」或
800px／16px／1.7 適用所有人與文字的證據。

## 論文與可外推範圍

### 字級、行長與行距

1. **Rello, Pielot & Marcos（2016），Make It Big! The Effect of Font Size and
   Line Spacing on Online Readability，CHI。**
   [作者全文](https://pielot.org/pubs/Rello2016-Fontsize.pdf)，
   DOI `10.1145/2858036.2858204`。104 人閱讀 Wikipedia，較大的字級改善以
   平均注視時間衡量的可讀性，部分較大字級也有較好的理解成績；行距影響較小。
   研究用 Arial、17 吋螢幕與短文章，沒有中文或完整筆記編輯流程。
   **18pt 不是18px**；論文行距1.0指字級的120%，不能抄成 CSS line-height:1。

2. **Chan & Lee（2005），Effect of display factors on Chinese reading times,
   comprehension scores and preferences，Behaviour & Information Technology。**
   [出版者摘要](https://www.tandfonline.com/doi/abs/10.1080/0144929042000267073)，
   DOI `10.1080/0144929042000267073`。72 名繁中讀者，14pt 相較10pt的閱讀與
   理解結果較好。這提供繁中字級方向的支持；本輪只讀到摘要，不能據此宣稱
   今日各種螢幕上的最適字級，亦不能把pt換寫成px。

3. **Chan, Tsang & Ng（2014），Effects of Line Length, Line Spacing, and Line
   Number on Proofreading Performance and Scrolling of Chinese Text，Human Factors。**
   [正式摘要](https://pubmed.ncbi.nlm.nih.gov/24930173/)，
   DOI `10.1177/0018720813499368`。操弄中文行長、行數與行距；時間、錯字
   發現率及捲動有取捨。摘要提出36字／行、4行、1.5行距的平衡條件。
   **這是校對任務，不能把4行套成長文編輯器高度**；可讀摘要沒有樣本數，
   不從二手引用補寫。它支持同時看行長與行距，不支持孤立的固定px。

4. **Wang et al.（2024），Column setting and text justification influence
   return-sweep eye movement behavior during Chinese multi-line reading，
   Cognitive Research: Principles and Implications 9:34。**
   [開放全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC11147972/)，
   DOI `10.1186/s41235-024-00559-5`。44 名中文大學生，單／雙欄與靠左／
   齊行影響回行眼跳，但總閱讀時間及理解沒有顯著差異。材料為簡體、大字
   宋體、固定距離；不能推成越窄越快或繁中筆記必須雙欄、左右齊行。

### 導覽、分組與裝飾

5. **Brumby & Zhuang（2015），Visual Grouping in Menu Interfaces，CHI。**
   [UCL全文](https://discovery.ucl.ac.uk/id/eprint/1499240/1/DuncanBrumby_Visual%20Grouping_paper359final.pdf)，
   DOI `10.1145/2702123.2702177`。36 人搜尋英文菜單；語意排序平均3.34秒，
   隨機排序4.23秒。無關項目加框反而比不框慢（4.51對3.95秒）。
   對頂列的啟示是先依功能分組；實驗用矩形框，不能宣稱6px留白本身已被驗證。

6. **Putkonen et al.（2025），Understanding visual search in graphical user
   interfaces，International Journal of Human-Computer Studies。**
   [Aalto全文](https://acris.aalto.fi/ws/portalfiles/portal/177471983/Understanding_visual_search_in_graphical_user_interfaces.pdf)，
   DOI `10.1016/j.ijhcs.2025.103483`。84 人、900個GUI、10,282次搜尋；目標
   是否存在、提示與GUI類型的影響大於視覺複雜度。避免把極簡當成可用性保證。
   研究使用靜態截圖，不能直接證明 Onden 應把全部導航放上方或右欄預設關閉。

7. **Rosenholtz et al.（2009），An Intuitive Model of Perceptual Grouping for
   HCI Design，CHI。**
   [MIT全文](https://web.mit.edu/rruth/www/Papers/RosenholtzEtAlCHI2009PO.pdf)，
   DOI `10.1145/1518701.1518903`。感知分組模型與範例顯示位置、明暗及方向
   如何影響分組；降低背景格線對比可讓主要圖形更清楚。這是模型／案例依據，
   並未直接測試「移除筆記卡片陰影提高多少效率」。

### 深色與對比

8. **Piepenbrock, Mayr & Buchner（2014），Smaller pupil size and better
   proofreading performance with positive than with negative polarity displays，
   Ergonomics。**
   [作者全文](https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/in_press/Piepenbrock-in_press-Smaller_pupil_size_and_better.pdf)，
   DOI `10.1080/00140139.2014.948496`。35 名年輕德語讀者，深字淺底的校對
   成績較佳。使用特定螢幕、亮度與觀看距離；不能推成深色模式對所有人不好，
   更不能用它斷言某種暖灰色最舒適。保留主題選擇，清晰度按實際配色核對。

## 對 Onden 的修訂建議

以下全部是待比較的設計試驗值，不是論文的最佳參數。

| 細節 | 起始值／行為 | 原因與邊界 |
| --- | --- | --- |
| 正文 | 先試17px，比較16／17／18px，保留個人調整 | 優先處理目前14px正文，不連帶把所有工具列放大 |
| 文字行寬 | 約640–720px，17px繁中約38–42字；起點680px | 把上次800px改成可容納媒體的外框上限；正文以實際行長判斷 |
| 行距／段距 | 行高1.65–1.7；段落間距約1em | 不假定越鬆越快；兩者連同可見內容量比較 |
| 層級 | 正文17px、介面13–14px、文章標題28–32px | 主次靠尺寸、字重與位置，避免小字再降低對比 |
| 頂列分組 | 模式切換／全域工具分組；本篇操作放文件附近 | 同組間距先試6–8px，組間16–24px，保持位置穩定 |
| 選中狀態 | 文字配底線或柔和底色；重點色集中 | 不讓每個控制都像主要行動，也不只靠顏色分辨 |
| 正文表面 | 減少大外框與投影，讓內容高度自然伸展 | 這是視覺假設；保留編輯區及可操作控制的必要線索 |
| 右資訊欄 | 可收合，保留帶文字的入口，尊重開關偏好 | 未保存／失敗／撤權狀態不隨面板隱藏 |
| 中英混排 | 單欄、先維持靠左；程式碼、表格可局部加寬 | 不從中文齊行研究推論英文也該強制齊行 |

### 色彩的本機核對

依 `7487701` 的 `theme-tokens.css` 深色原始sRGB色票計算，假設不透明文字
置於三種原始深色表面：正文約9.60–10.98:1、muted約5.46–6.24:1，faint約
3.92–4.49:1。正文色票本身不需要全面調亮；faint若用在需要辨識的小字，
應優先檢查。這不是實際瀏覽器computed style或所有狀態的驗收，不能忽略
元件覆寫、透明度、背景混色或停用狀態；不據此推進UX案例。

另參照[WCAG一般文字對比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum)
4.5:1作檢查門檻；這是標準，不是本輪找到的實驗論文。
[文字間距](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing)要求允許
使用者覆寫後內容與操作不遺失，不表示預設行高必須套某個數值。
[視覺呈現AAA](https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation)
提供包括CJK每行40字上限的可調整呈現機制；不能誤寫成所有網站預設必須40字。

## 低資源驗證方式

固定一篇長繁中筆記、一篇中英／程式混排筆記，以同字體比較16／17／18px
與640／680／720px，先每次只變一組參數。人實際做找回上一行、理解段落、
尋找指定資訊與修改句子；另外做切任務、新增、搜尋、開版本、找反向連結。
記錄完成時間、找錯／誤點、理解結果與舒適度，避免只問「哪個比較漂亮」。

採少量同一人交叉比較時只能作個人使用決策，不冒充代表所有使用者的研究。
單一無頭瀏覽器可核對1280／1920px、手機390／320px、縮放、重載、溢出與
鍵盤可達；它無法替代人的閱讀與辨識評估。本輪沒有執行這組產品試驗。
