# 把例外清單清空：給雲端工作的指示

> 狀態：歷史紀錄（寫於 2026-11-17）。一次性的工作指示；規則本身在根目錄 `AGENTS.md`「這件事歸誰管」的允許清單守門一段。

擁有者 2026-11-17：「例外清單全部清空」。`scripts/allowlist-baseline.json` 有 48 條規則，43 條已經是空的；剩下五條還有逐檔的計數
（`be-raw-sql`、`fe-app-store-reach`、`fe-store-inline-selector`、`fe-store-write`、`fe-literal-api-write`）。目標是全部歸零，
之後這五條和其他規則一樣是嚴格模式。你的份是任務訊息裡指定的規則與檔案範圍，範圍外的不要動。

## 怎麼做

1. **先讀規則。** 每條規則禁止什麼、該改用誰，寫在 `packages/frontend/src/test/guards/allowlist/fileRules.ts`（後端在
   `packages/backend/src/test/guards/allowlist/`）的 `what` 與 `owner`。看一個檔還有幾處：`node scripts/checkEditedFile.mjs <檔>`，
   或跑該套件的允許清單守門測試。
2. **用既有的主人入口。** 先找 `lib/appStore.ts`、`lib/data/` 裡已經有的具名 hook／selector／writer（`grep`、讀
   [entrypoints-catalog.md](../agents/entrypoints-catalog.md)）。沒有現成的才新增，而且新增的要是「使用者在做的事」的名字
   （`useSelectedId()`、`renameSpace(id, name)`），不是把整個 store 或一條路徑換個名字轉出來的殼
   （`useStoreState()`、`postTo(path)` 這種等於沒改）。同一件事只加一個入口，兩個檔需要同一個就共用。新增的共用入口登記進
   `scripts/entrypoints.catalog.json` 並跑 `npm run catalog`。
3. **行為不變。** 這是搬家，不是改功能：同樣的畫面、同樣的請求（方法、路徑、內容、冪等鍵）、同樣的錯誤處理、同樣的重繪時機。
   - store 的讀取：具名 selector 要回傳和原本相同的值，而且不能讓元件比原本多重繪（原本 `useAppSelector((s) => s.x.y)` 只在 `y` 變時重繪，
     新的 hook 也要只在 `y` 變時重繪；回傳新物件或新陣列的 selector 要有穩定的比較）。
   - 寫入：搬進 `lib/data` 的 writer 要沿用 `writeLifecycle`／`writeQueue`／`writeErrors`，不自創通知或重試；原本等結果的呼叫者照樣等結果。
   - 改一個檔之前先找它的測試；沒有測試覆蓋到你要搬的行為，就先補一個在**改之前**會通過的測試，再搬。
4. **一個檔清到 0 就從基準刪掉那一項**（`ALLOWLIST_WRITE=1` 的寫法見 `scripts/allowlistLib.mjs`；只准往下）。一條規則整個清空後，
   把它從 `allowlistLib.mjs` 的 `RATCHET_RULES` 拿掉（變成嚴格模式），基準裡留空物件。最後一個檔由誰清掉，就由誰拿掉。
5. **搬不動的不要硬搬。** 某一處搬過去會改變行為、或需要一個你判斷不了該叫什麼的入口，就留著，在 PR 說明列出來（檔案、行、卡在哪）。
   不要用 `eslint-disable`、改規則的比對方式、或把檔案加進規則的排除清單來讓數字變 0。

## 驗證（貼出最後幾行）

- 該套件的 `npx tsc --noEmit`、`npm run lint`。
- 前端：`ONDEN_TESTS_WITHOUT_DATABASE=1 npx vitest run`（整套）、`npm run build`（貼出開機 JS 大小；預算只准調低，不能變大）。
  後端：`npm run test:pglite`（整套）。
- `bash scripts/guard-lane.sh`（`PR_BODY` 帶上你 PR 說明裡的「不需要更新說明」那一行）。
- 改到畫面元件時：`npm run build:browser` 後跑 `node packages/frontend/e2e/browser-app/smoke.mjs chromium`。

## PR 說明（繁體中文，白話）

一張表：規則｜改前幾處幾檔 → 改後｜新增了哪些入口（名字、放在哪、為什麼沒有現成的）。然後列：沒搬的（檔案、行、原因）。
寫明哪些驗證跑了、結果的最後幾行、哪些沒跑。使用者看不出差別，附一行「不需要更新說明」。非草稿 PR，不要自己合併。
