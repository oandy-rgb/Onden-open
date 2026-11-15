# 歡迎卡片與側欄邊界（2026-09-28）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `1ef6006`。使用者截圖顯示歡迎卡片左緣比側欄分隔線向左突出 4px。
`.obsidian-workspace` 的實際側欄是 220px，但 `.overview-workspace` 在
240px 用背景畫線；卡片左邊距 16px，使其起點 236px 落在假線左側。
本批移除固定座標的背景線，由桌面側欄自身的 `border-inline-end` 畫邊界。
手機沒有此直線；桌面收起側欄時邊界隨側欄消失，不再需要 focus 背景特例。
歡迎卡片尺寸、操作、保存與權限契約沒有變更。

隔離 `onden-welcome` stack 使用獨立 `onden_test`，測試帳號為該工作區
第一位管理者，未設定 token/tag scope。重用 2026-09-25 的
`onden-acceptance-note-{backend,frontend}` 與 PostgreSQL 映像：修前用原
frontend 映像；修後掛載本輪 `preflight` 建出的 frontend dist，避免重建
無變更的依賴與後端。單一無頭 Chromium worker，瀏覽器容器限制 1 CPU、
1 GiB；所有建立資料都在隔離 DB。

最初重用舊大量資料卷時截圖被 membership gate 遮住，不算有效視覺證據。
改用乾淨 DB、要求 gate 消失後，修前深色畫面重現 4px 突出，新增的
分隔線斷言如預期失敗；修後同案通過。截圖目視確認分隔線回到真正側欄
右緣，卡片留有 16px 間距。

本輪結果：

- `WelcomeBanner.test.tsx`：10/10 通過。
- `welcomeBanner.spec.ts`：6/6 通過，零重試。包含原有顯示／關閉／建立，
  新增繁中 1280px 深／淺色、側欄收起再顯示，390px／320px 各重新載入後
  核對按鈕左右界及頁面無水平 overflow；已檢視桌面深色與 320px 截圖。
- 兩端 TypeScript、兩端 lint、前端 build 通過；`git diff --check` 通過。
- Chromium 清單目前為 290 項／135 檔，本輪只跑上述 6 項。

證據與 SHA-256 保存在 gitignored
`.acceptance/2026-09-28/welcome-boundary/`。本次為布局修正，未注入寫入失敗
或斷線；未宣稱真機、其他瀏覽器及完整 UX 矩陣通過。關閉 GAP-83，UX-01
仍為「部分」，不改動全功能盤點狀態總數。正式套用紀錄另見 VPS 部署文件。
