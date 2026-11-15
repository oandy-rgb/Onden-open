# 通知文字與復原按鈕可讀性（2026-09-30）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：UX-01／GAP-102。使用者的刪除通知截圖顯示深色主題的文字、圖示、復原及關閉幾乎不可見。
起點為 `2f6e62c`，程式修改僅限 `packages/frontend/src/styles/global.css`；不修改通知、刪除或復原的資料流程。

## 重現與修正

舊 `.toast--info` 使用固定底色 `#2d3748`，卻以邊框 token 當文字色。
深色主題的文字為 `#38332a`，Chromium 實測對比 1.05:1，與截圖相符。
所有子元素繼承此色，因此訊息與操作一起看不清楚。

改用既有 `--onden-state-info-bg/text` 配對；復原按鈕使用 `currentColor` 邊框，hover 加強邊框而不改變文字底色，避免警告色原本合格的對比在 hover 時下降。
並補上原本沒有樣式的 warning 通知，使用既有 warning 配對；成功與錯誤通知維持原有配色。
不新增色票、主題機制或通知元件，也不改變保存成功／失敗、計時、復原與關閉語意。

## 驗證記錄

- 2026-09-30：Chromium 無頭、單 worker，Docker 限制 1 CPU／1 GB；兩端 typecheck／lint 與前端 build 依序通過。
- 原有 `ToastStack.test.tsx`、`trashUndeleteOffline.test.tsx`：2 檔／5 項通過。
- 已建置 CSS 的獨立通知樣本：深／淺色 × 1280／390／320px × info／success／warning／error，共 24 組通過。三則堆疊及長標題不越界，手機復原／關閉至少 44px，鍵盤焦點可見；hover 不降低復原文字對比。
- info 通知文字對比：深色 1.05:1 → 10.40:1；淺色改後 7.87:1。其餘三類也通過本輪 4.5:1 檢查。
- 隔離 `onden-toast-e2e`／PostgreSQL `onden_test`，測試 owner、無 scope 限制：既有 `deleteUndo.spec.ts` 1 項通過。開啟新測試筆記 → 選單刪除 → 真實點擊 Undo → `/undelete` 完成 → 伺服器清單確認筆記復原。
- 本批未重跑完整前後端測試或全部 E2E；CSS 無保存／權限變更，沿用本次相關回歸。真機、螢幕閱讀器與跨瀏覽器未重驗。

本機證據：`.acceptance/toast-contrast-2026-09-30/` 的 `before/after-measurements.json`、`before/after-*-stack.png`、`unit.log`、兩端 typecheck/lint 日誌、`frontend-build.log`、`browser/results.json`。配色樣本不是正式使用者資料；真正的復原操作另由上述 full-stack 測試驗證。

本次只關閉已重現的通知配色缺陷，不推進 UX-01 整列；163 項總表狀態維持不變。
正式 VPS 僅驗證服務與產物，刪除／復原在隔離 `onden_test` 執行。

## VPS 更新

程式提交 `d3001bf99e3b9d664cdad9208895ded7d9836daf` 已推送並部署前端。
部署前備份 DB／content，校驗 SHA-256，並在拋棄式資料庫／volume 還原後核對所有 public table 的資料指紋及 content 檔案。
備份：`/srv/onden/backups/toast-contrast-20260930125156-d3001bf99e3b`。
後端容器與映像保持原版本，migration baseline 未變；首頁 200、未登入 bootstrap 401、後端 health 200，正式提供的 CSS 與新版映像 SHA-256 相同。
備份目錄保有僅回復前端、不回灌使用者資料的 `rollback.sh`；演練資源已清理。
