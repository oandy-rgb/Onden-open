# 手機帳號與同步入口修復

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-15。基線：`0e93619` 加既有未提交審核變更。
案例：ACC-06、NOTE-03、UX-01；接續第二十批 GAP-22。

本批補齊手機帳號／登出及可見的待同步筆數，桌面與手機共用操作。
實際手機 A→B→A、待同步重載、同步及登出 503 後重試通過；不代表全帳號生命週期已盤完。

## 使用案例與設計比較

不變條件：使用者可以在手機辨認目前帳號、知道哪些變更仍未同步；登出須先保存編輯器草稿，
等待過程不能繼續修改背景編輯器。失敗保留輸入與操作入口，不能將失去回應當作成功確認。

| 方案 | 呼叫方式與隱藏知識 | 成本 |
| --- | --- | --- |
| 手機另加登入／同步 handlers | MobileNav 與 AppTopbar 分別了解 autosave、snapshot、auth 回傳錯誤、queue 數量及通知 | 同一行為要改兩個入口，較容易一邊先關閉或忽略 resolved error |
| 共用帳號操作與同步呈現（採用） | 兩種 shell 使用 `AccountPanel`、`SyncStatus`；登出準備只呼叫 `await prepareEditorForExit()` | 小幅改變桌面帳號入口為 modal；既有 writer、queue、auth 與同步引擎保持原責任 |

共用的 `ShellDialog` 負責背景 inert、捲動、焦點及等待時禁止關閉。帳號操作不用自行排列資料庫步驟；
同步元件讀既有 pending store，不另維護第二個數量。`expanded` 與 `inlineFeedback` 只選擇呈現位置，
不改變保存、權限或離線政策。

## 已實作的契約

- `prepareEditorForExit()` 取得草稿修訂號，等待既有 active saves 與本次 `flushPendingSave()`，
  再等待 `flushLocalDbSync()`。writer 拒絕回 false；本機提交失敗沿用 `WriteStorageError`；
  準備期間有新輸入則拒絕這次登出。完成表示編輯器保存已被接受或已持久入列，另有本機 snapshot 確認，
  不表示所有內容都已送達伺服器。
- `AccountPanel` 等待上述結果後才呼叫 auth。它同時處理 `signOut()` 的 resolved error 與 rejected
  promise。失去回應顯示「尚未確認登出成功」，不假定伺服器一定仍保有 session；可保留頁面重試。
  auth 確認後由既有 LoginGate 更新畫面，不提前關閉或清空。
- `ShellDialog` 透過 portal 使用原生 modal；等待登出時停用關閉和其他動作，阻止 Escape／背景關閉，
  阻止快捷鍵向背景冒泡。這兩個 shell 的按鈕做 Tab 首尾循環，關閉返回原焦點。
  桌面置中、手機靠底；短畫面只捲動對話框內容。
- 手機「更多」顯示姓名、email、登出；管理使用者沿用原 admin 條件及既有入口。
  帳號名稱／email 可換行，登出／關閉與同步至少 44px。
- 手機有 pending 或離線時，在原五格導航上方保留狀態列；有狀態列時增加正文底部空間，
  捕捉按鈕不再向上突出遮住它。正常連線且 pending 為零時不額外佔高度。
- 手動同步防止同元件重複送出，等待既有 `sync()` 結果。失敗用 `reportWriteFailure`；
  「更多」內顯示行內回饋，避免 toast 被原生 modal 蓋住，其他入口沿用 toast。
  成功／失敗後都以實際 queue 計數為準；零筆顯示「已連線」，不是「所有草稿已保存」。

## 瀏覽器與資料庫實測

沿用隔離資料庫 `onden_import_audit_test`，測試前端 5100、後端 18788，使用既有測試 A／B。
故障由暫存 harness 攔截實際端點：筆記 PATCH、`/api/sync`、`/api/auth/sign-out` 分別可回 503。
未使用正式資料。測試筆記為 `1c4e2cc0-7211-4f4e-87ee-8a272b979f23`。

1. 390×844 打開「更多」能辨識 A、登出與同步；原生 `dialog:modal` 成立。
   Shift+Tab 從關閉跳至設定、Tab 返回關閉，Escape 關閉後焦點回「更多」。
   實測先發現原生 modal 仍可把焦點交給瀏覽器 chrome，補上按鈕首尾循環後重新驗證通過。
2. PATCH 回 503，從手機追加「0915 手機入口實測：登出前也必須保存。」。
   實際出現 1 筆等待同步，重載仍保留正文與筆數；PG `strpos` 為 0，證明當時尚未提交。
3. 登出回 503，保留 A、草稿及行內「尚未確認登出成功」回饋。再讓 sync 回 503，
   在「更多」點立即同步後顯示「同步尚未完成」，1 筆仍保留。
   320×568 同時出現兩個錯誤，dialog clientWidth／scrollWidth 同為 269，無橫向溢出；
   630px 內容在 542px 區域內捲動，email 會換行。
4. 恢復 auth／sync 讀取、繼續阻擋 PATCH；全程在 320px 由手機入口登出 A、登入 B。
   「更多」顯示 B、沒有 A 的 pending，正文沒有本次待同步文字。
   再由手機登出 B、登入 A；依既有身分邊界重載後，原文字與 1 筆 pending 完整取回。
   B 當時顯示較舊的已快取正文；本批沒有據此宣稱所有遠端內容刷新已收斂。
5. 1440×900 顯示同一筆 pending，桌面帳號視窗同樣顯示 A。
   實測發現全域 reset 清掉 dialog 預設 margin，導致視窗出現在左上角；明確設 margin 後，
   400×198 視窗位於 (520,351)，置中正確；Shift+Tab 至登出通過。
   回 390px 後手機 dialog 下緣仍等於 844，未被桌面修正改成置中。
6. 恢復 PATCH，從手機「更多」立即同步。PG 正文出現該段文字（strpos=163），新增
   `448 | NODE_UPDATED | 帳號隔離測試 A`，前兩筆事件仍為 447／446。
   待同步列消失，「更多」顯示已連線，正文仍保留。最後讀取的 200 筆 console 紀錄無 error。
7. 320×568 再確認設定按鈕可由鍵盤抵達，按鈕高 72px、下緣 551px，無橫向溢出。
   測試分頁／viewport、前後端程序均清理，原先停止的 PG container 恢復停止，資料保留。

這些是桌面瀏覽器及手機 viewport 測試，沒有真機或實體觸控鍵盤。
編輯器聚焦時既有格式工具列會取代底部導航的可點區，本次使用 Hide keyboard 收起後操作更多；
軟鍵盤彈出、safe area 及不同瀏覽器的實體設備結果仍待驗證。

## 自動驗證

新增 21 案：16 個桌／手帳號及手機同步元件案例，5 個編輯器退出保存案例。
涵蓋角色入口、準備保存時禁止關閉／重複登出、保存拒絕、兩種 auth error 與重試、
Tab 首尾循環、離線 pending 可見、同步失敗只回饋一次，以及等待 queue／snapshot、
失敗保留、新輸入取消、前一筆仍在保存時等待完成。

jsdom 的原生 dialog 替身只驗證生命週期／事件；背景 inert、焦點還原及布局另以真實瀏覽器驗證。
沒有在正式程式加入測試環境放行。

最終全前端 **187 檔／1,364 項通過，0 跳過**；`npx tsc --noEmit`、`npm run lint`、
`npm run build` 通過，退出碼均為 0。建置仍有既有大 chunk／空 Starlight docs 提示。
暫存紀錄：`/tmp/onden-mobile-account-final-all.log`、`/tmp/onden-mobile-account-tsc-final.log`、
`/tmp/onden-mobile-account-lint-final.log`、`/tmp/onden-mobile-account-build.log`。
這些暫存檔不承諾跨重啟保留；最終亦執行 `git diff --check`。

## 剩餘限制

- GAP-22 此入口缺陷已修，ACC-06／NOTE-03／UX-01 仍維持部分完成。
- 退出準備涵蓋此編輯器的草稿、已開始的保存及目前 snapshot，不是所有其他表單、白板、ink
  生產者的統一離開協定，也不等於阻止另一分頁繼續寫入。
- GAP-21 legacy 未綁定副本安全取回、同帳號多分頁 snapshot 互蓋仍未解決。
  GAP-20 完全離線冷啟動仍受登入檢查阻擋。
- 這批不變更授權、重播冪等、復原規則或登入請求身分契約；未重跑全後端測試。
- 真機軟鍵盤／native WebView、頁面重載後遺失 auth 回應的恢復，以及所有背景寫入與登出的競態仍待盤。
