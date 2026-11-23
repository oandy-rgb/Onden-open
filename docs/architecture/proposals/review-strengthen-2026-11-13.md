# 複習畫面、狀況頁與以範圍練習：現況

> 狀態：現行
> 涵蓋：packages/backend/src/modules/review/routes.ts, packages/backend/src/modules/review/service.ts, packages/frontend/src/modules/review/ReviewPanel.tsx, packages/frontend/src/modules/review/ReviewStatusPage.tsx, packages/frontend/src/modules/review/ReviewScreen.tsx
> 提案原文與當時的討論（含別家做法調查）：[review-strengthen-2026-11-13-history.md](review-strengthen-2026-11-13-history.md)。
> 還沒做的部分（挖空出題、標籤頁入口）：[review-strengthen-remaining-2026-11-17.md](review-strengthen-remaining-2026-11-17.md)（提案）。
> 相關：[標籤當範圍](tag-as-scope-2026-11-13.md)、[功能引用第三批](function-refs-b3-2026-11-12.md)。

排程維持 FSRS 與四個評分。2026-11-13 的提案分三步，前兩步（複習畫面與狀況頁、以範圍練習）的後端與畫面已經做了。

## 複習畫面

- 答案揭曉後帶出來源筆記名稱與前後段（`neighbours`、`source_title`，`modules/review/service.ts`）。
- 四個評分按鈕各寫下次的間隔（`intervalLabel`，來自伺服器的 `next_days`）。
- 看得到的動作：開啟原文、改這段（當場編輯，`ReviewEditSheet`）、明天再說（`POST …/tomorrow`）、先不複習這張（`…/suspend`，可在狀況頁或筆記裡恢復，`…/resume`）。
- 上一張可以復原（`…/undo-grade`）。

## 狀況頁

`GET /api/review/status`（接受與佇列相同的範圍，2026-11-20 起狀況頁跟著複習頁的「範圍」），畫面 `ReviewStatusPage.tsx`：今天要複習幾張、逾期的與未來七天分開、常忘的卡（按鈕帶去改那一段，不是停用）、已停用的卡（可恢復）、每人每天上限。上限是帳號偏好 `reviewsPerDay`，到期與新卡合起來算（`reviewCapPref.ts`）。

## 以範圍練習

- `GET /api/review/queue` 接受三種範圍之一：`root`（一棵樹）、`tag_id`（一個標籤）、`untagged`（沒有被任何標籤分組的卡）；同時給兩種回 400。`/api/review/groups` 與 `/decks` 給「依標籤」「依樹」的清單，畫面 `ReviewGroups.tsx` 由那裡開始練；複習主頁標題下的「範圍」選擇器（`ReviewScopePicker.tsx`，業主 2026-11-20）用同樣的列與同一個 `placeOfGroup`，細節見 [decisions-ui.md](../../agents/decisions-ui.md)「複習按分組練」。
- 標籤範圍的規則（`modules/review/service.ts` 的 `tagScope`）：筆記掛著該標籤或其子標籤、延伸它的標籤（`tagHierarchy.memberTagIds`），範圍內的筆記與這些筆記的段落、以及自己掛著這些標籤的段落都算；子筆記不算。樹範圍是該筆記與底下所有 live 的子筆記。
- 筆記的「複習這篇下面的卡片」指令開啟樹範圍（`modules/review/index.tsx` 的 `a-review-here`）。
- 範圍練習現在仍只出範圍內到期與新卡，並受每天上限限制（`queue` 經 `planSession`）；提案的「不看到期日、整個過一遍」沒有做（`deck` 能列出範圍內全部卡片，但沒有練習入口）。

## 提案列為不做的

依個人作答紀錄調整排程參數、AI 自動出題、不評分的回顧、圖片遮蓋（仍然成立）。

`Q:`／`A:`「抓題」保留（`extractCards.ts`）。
