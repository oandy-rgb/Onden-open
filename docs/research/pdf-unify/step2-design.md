# PDF 與手寫頁合一：第 2 步的設計與進度

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/frontend/src/pagebook/**, packages/frontend/src/components/PageMoreMenu.tsx, packages/frontend/src/components/pdf/PdfPageBackground.tsx
> 歷史：當時的比較、提案契約、為什麼畫面沒動、當初的問題在 [step2-design-history.md](step2-design-history.md)。

第 1 步（#907）把 PDF 筆跡改成手寫頁的頁面信封 `InkPages`；第 2 步把畫面合成一種：**頁面本子 `PageBook`**。

## 現在的樣子

- `packages/frontend/src/pagebook/` 是頁面本子：頁面由上往下排在一個原生捲動容器裡，每頁自己的繪圖面；只認得頁面信封（`@onden/markdown/ink` 的 `InkPages`），不認得頁面後面是什麼。契約（props、`background`／`layers` 插槽、鏡頭規則）寫在 `PageBook.tsx` 檔頭，這裡不再抄一份。
- 鏡頭採 A（原生捲動；縮放＝頁面 CSS 寬度；兩指縮放用 `lib/ink/touchSplit.ts`，甩動用 `lib/ink/glide.ts`）；頁面是固定高度的紙，筆跡不會讓頁變長。
- 外殼：`InkNodeView`（手寫筆記）與 `PdfNodeView`（PDF 筆記，PDF 頁由 `components/pdf/PdfPageBackground.tsx` 當背景畫）各自接存檔；兩個畫面共用「更多」選單 `PageMoreMenu`。
- import 邊界：`pagebook` 只准 import 自己、`components/ui`、`lib/ink`、`lib/pdf`、React、`@onden/markdown`（`eslint.boundaries.config.js` 的 `pagebook` 區）。
- 已完成：輸入規則（筆不用切換，見 [decisions-canvas.md〈筆不用切換〉](../../agents/decisions-canvas.md)）、手寫筆記變成可加頁的本子（頁面合一 b，2026-11-09）、PDF 換到本子上（頁面合一 c，2026-11-09），細節見 decisions-canvas。
- **未完成**：d（PDF 頁與空白頁混排、加頁）。設計在 [pdf-pages-in-note-2026-11-16.md](../../architecture/proposals/pdf-pages-in-note-2026-11-16.md)，檔頭狀態是「提案」，未見產品程式。

## 擁有者已定（2026-11-09）

1. 鏡頭採 A：原生捲動、固定高度的頁＋「＋ 新增一頁」；已存的高頁保留自己的高度；接受高頁在高倍放大時比較模糊。
2. 手寫筆記改成多頁（`ink_data` 的第一頁照舊，其餘在 `morePages`；舊版 App 只看得到第一頁，可以接受）。
3. 白板手形工具下，筆照規則畫、手指平移。
4. 同一則筆記之後可以有 PDF 頁和空白頁混排，所以本子不認得 PDF，背景是插槽。

## 抽成獨立套件還差哪幾步

1. 建 `src/pagebook/`（守門已就位），只靠 props 注入存檔、讀檔、翻譯、裝置設定、PDF 網址。
2. `lib/ink` 現在還 import 應用的 `lib/`（`observeSize`、偏好、`utils` 等）：要嘛把這幾個小工具搬進 `lib/ink`，要嘛改成注入；`lib/pdf` 同理。
3. `components/ui` 的 `Button`／`Menu` 等要能單獨帶走（或換成注入的元件）。
4. 文字框層（`components/page/*`）與圖片層、`lib/pageText`、`lib/pageImages` 的 controller 介面要留在套件裡或定成注入的型別。
5. i18n：套件內的字串改成 props 傳入的 `t`。
6. CSS 的 token（`--onden-*`）要有套件自己的預設。

> 2026-11-17 核對：第 2 步仍成立——`lib/ink` 與 `lib/pdf` 還 import 應用的 `lib/`（例如 `../haptics`、`../uuid`、`../data`）；其餘幾步沒有做的跡象。
