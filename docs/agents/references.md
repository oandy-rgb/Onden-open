# 研究依據與閱讀順序

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：無（參考書目）

何時讀：想知道設計準則的論文與教材依據時。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 研究依據與閱讀順序

## A Philosophy of Software Design 與作者公開教材

- John Ousterhout，**A Philosophy of Software Design**，第二版，2021。
  [作者官網](https://web.stanford.edu/~ouster/cgi-bin/aposd.php)提供紙本／電子書購買入口，及
  [20 頁公開節選](https://web.stanford.edu/~ouster/cgi-bin/aposd2ndEdExtract.pdf)。
- 本次查閱範圍（2026-09-08）：上述節選全 20 頁，涵蓋第 6 章、第 21 章及第 9.8、12.6 節等節錄，
  另對照本文所連結的作者 CS 190 原始講義及設計討論；沒有取得完整書籍。
  不將節選或講義標示為書籍全文，也不宣稱本文涵蓋整本書的全部論證。
- 本文將概念轉為 Onden 的開發準則，並非逐章翻譯。設計原則需要配合實際契約與驗證，
  不應變成固定行數上限、所有錯誤一律忽略或無限制新增抽象等機械規則。

## 事件與權限

以下論文提供設計參考；上面的 Onden 做法是專案取捨，不是論文已證明本專案正確。

1. Cutler 等，**Cedar: A New Language for Expressive, Fast, Safe, and Analyzable Authorization**，OOPSLA 2024。
   先讀第 1、2 節，理解政策與應用邏輯的分離、政策驗證與等價性分析。[全文](https://arxiv.org/html/2403.04651)
2. Overeem 等，**An Empirical Characterization of Event Sourced Systems and Their Schema Evolution — Lessons from Industry**，Journal of Systems and Software，2021。
   先讀第 6 節，理解事件溯源的學習、格式演進與投影重建成本。[全文](https://arxiv.org/html/2104.01146)
3. Saltzer、Schroeder，**The Protection of Information in Computer Systems**，Proceedings of the IEEE，1975。
   先讀第一部分的設計原則，特別是簡單機制、完整權限檢查與容易正確使用的介面。[原文](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html)
4. Pang 等，**Zanzibar: Google’s Consistent, Global Authorization System**，USENIX ATC 2019。
   先讀第 2.2 節，理解撤權、內容更新與舊權限快取的一致性問題；依 Onden 的規模選擇實作。[PDF](https://www.usenix.org/system/files/atc19-pang.pdf)
