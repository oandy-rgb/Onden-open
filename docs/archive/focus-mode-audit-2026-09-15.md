# 寫作模式與回歸補驗（2026-09-15）

> 狀態：歷史紀錄（最後確認 2026-11-01）

本批補 NAV-08、UX-01 的實測，並重跑兩端完整 Vitest。NAV-08 由待盤改為部分；
整份清單仍未驗完，也尚未執行既有 fullstack Playwright 全套。

## 重現與修正

1. 桌面收起側欄後縮到 390px，按「返回筆記列表」，畫面只剩「筆記」標題和底部導覽。
   `.focus-mode` 不分裝置隱藏了手機正在使用的 sidebar。現在只在 901px 以上生效；
   隱藏左右欄時改成單欄，保留正文閱讀寬度。
2. 編輯器寫作模式把欄位設定套在外層，真正的 notes grid 還保留原欄位。
   正文擠成窄條，導覽 rail 與檢視窗殘留。現在由 notes workspace 提供單欄、清除導覽預留空間。
3. 320px 工具列原本連字數、退出及預覽一起排，右端超過可用寬度。
   小於等於 480px 隱藏輔助字數，退出按鈕維持 44×44。
4. 手機長文的 wrapper 高度約 504px，內容約 881px，卻設 `overflow:hidden`，實際無法捲到文末。
   現在寫作模式由正文區捲動，內部 wrapper 自然增高；工具列保持可見。
5. 舊寫作模式在 React state updater 裡請求 fullscreen，Escape 只清掉布林值，沒有統一處理
   瀏覽器退出、unmount 或晚到的 fullscreen promise。`useZenMode` 集中這些生命週期，
   不改動筆記 writer、保存結果、側欄偏好或其他 viewer 的 fullscreen。

兩個入口現在分別叫「收起／顯示側欄」和「寫作模式」，避免相同名稱掩蓋不同的持久化／退出行為。
設計比較與責任邊界記於 AGENTS 第二十三批。

## 瀏覽器證據

使用隔離 `onden_import_audit_test`、真實 cookie／API、目前原始碼的 5100 前端；沒有修改正式資料。
測試筆記沿用 `f17fbf33-bdce-4b3a-b165-1e5525fedb83`。本批沒有編輯其正文。

| 情境 | 實際結果 |
| --- | --- |
| 1365×900 收起側欄、重載 | 偏好保留，中心容器 1309px、閱讀區 680px；Ctrl+\\ 可重新顯示側欄 |
| 已儲存桌面偏好 → 390×844 列表 | 返回後 sidebar 為 flex、375px，118 筆記按鈕仍在；不再空白 |
| 320×720 編輯／資訊 | 退出寫作後仍在同筆記，資訊含屬性、反向連結、白板及歷史 |
| 1365×900 寫作 | notes workspace 從 x=0 使用全寬；正文 720px、置中 x=322.5 |
| 320×720 寫作 | 退出 44×44；收起字數後工具列尾端在可用寬度內 |
| 長文捲動 | 正文區 720px、內容 1208px；實際捲到既有最後一段「0915 縮放中編輯保存驗證。」；工具列仍可操作 |
| 寫作退出 | 實際按鈕和 Escape 都恢復導覽、原筆記與兩側布局；不把寫作模式當作重載偏好 |
| fullscreen 拒絕 | 測試 middleware 注入 `Permissions-Policy: fullscreen=()`，curl 確認頁面標頭後再重載操作；仍進入寫作、可捲動與退出 |

Fullscreen API 實際開啟／退出時，in-app browser 的 viewport 截圖曾出現縮放殘留；
沒有把那張失真的截圖當作手機視覺驗收。新分頁＋明確拒絕 fullscreen 後，
以正常 320px 截圖及 DOM 幾何完成手機布局檢查。原生手機全螢幕仍未驗。
測試結束清除 viewport override、關閉分頁及停止開發服務。

## 自動回歸及測試前置條件

- 後端：212 檔、1,756 項通過，0 失敗、0 跳過。
- 前端：190 檔、1,380 項通過，0 失敗、0 跳過；本批 focus／zen 專項 10 項通過。
- 兩端 TypeScript、lint 通過，前端 build 通過；仍有既有大 chunk 及空 docs collection 提示。
- hook 案例包含 Escape、瀏覽器 fullscreenchange、請求拒絕、離開後晚到成功、
  不退出別人的 fullscreen，以及 display preference 儲存失敗。

後端第一次使用全新 `onden_verification_20260915_test`：1,721 通過、3 失敗、32 跳過。
32 個跳過來自三個匯入測試的安全 regex 不接受含數字的 DB 名稱；沒有將它們計作成功。
改用另一個全新 `onden_verification_final_test` 後，這些案例均實際執行。

三個失敗均在 composition 的 viewer 任務正向對照。全新 migrations 種下的 `task` tag
包含 `required_role: editor`；測試卻假定無政策，舊 DB 的 schema-less tag 會掩蓋問題。
在第二個全新 DB 單跑仍重現 30 通過／3 失敗；在已跑過全套的舊 test DB 單跑卻 33 通過。
修正為 fixture 明確將 task policy 設為空，再重跑全套才得到上方 1,756／0／0。
沒有降低正式 task 的預設權限，TASK-07 的宿主／task scope 決定仍未完成。

原始報告位於測試機 `/tmp/onden-storage-live/verification-backend-final.json`；前端、TypeScript、lint、
build 日誌同目錄，以 `focus-`／`verification-backend-` 開頭。這些暫存報告不是持久備份。

## 尚未完成

- ACC-07 三種啟動偏好及遺失目標尚未進行完整矩陣，仍為待盤。
- NAV-08 還缺 PDF／草圖自身 fullscreen、modal／IME 的 Escape 優先序及原生手機。
- 開始操作時曾觀察開發分頁 sign-in 回 200 後仍停登入表單，重載才進工作區；
  尚未區分開發 HMR／控制工具或產品因素，未算成登入驗收通過，也未據此修改認證。
- 現有 legacy 復原副本未刪除；viewer 啟動今日筆記產生的拒絕輸入仍保留，沒有為清理畫面清掉它。
- 正式 Docker 前端尚未套用本批程式；Vitest 全通過不等於全功能或真機驗證完成。
