## 做了什麼

<!-- 一到三句：改了哪個使用案例、減少了什麼理解負擔。 -->

## 重用了哪些既有入口

<!-- 列出這次改動呼叫的現成入口（路徑＋名稱），例如 `lib/noteLabel.ts` 的 `displayTitle`。
     不確定有沒有現成的，先看根目錄 AGENTS.md「這件事歸誰管」與各套件的 AGENTS.md。 -->

## 新寫的函式／元件為什麼不用現成的

<!-- 每個新的匯出函式、hook、元件各寫一行：為什麼上面列的入口不夠用。沒有新的就寫「沒有」。 -->

## 基準或例外有沒有動（只准減少）

<!-- `scripts/dup-baseline.json`、`scripts/dup-names-baseline.json`、`scripts/allowlist-baseline.json`、
     各 guard 測試的例外清單：寫「降了哪幾條」或「沒動」。只准減少；新增例外要在這裡說明理由。 -->

## 測試結果

<!-- 跑了什麼、結果如何；沒跑的也要寫（例如沒有 Postgres 所以整合測試沒跑）。
     使用者看得到的改動：`changes/` 已加，或寫「不需要更新說明」。
     新功能預設延後載入（`lazyWithReload`／動態 import）；`npm run build` 會印出開機 JS 與每個開機 chunk 最大的來源檔，
     開機 JS 有變大就寫前後 KiB 與原因。 -->

---

<!-- 以下由 agent 填入署名 -->
