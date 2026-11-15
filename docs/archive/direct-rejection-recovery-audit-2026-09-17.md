# 直接拒絕輸入的復原盤點（2026-09-17）

> 狀態：歷史紀錄（最後確認 2026-11-01）

案例 NOTE-03／NOTE-06／CAN-06／SYS-03，維持部分。沿用隔離服務5100／18788與 viewer A，
沒有調整角色、政策、正式資料庫或管理員授權。前一批完成可讀性後，優先處理可能丟失文字的拒絕邊界。

## GAP-53：直接拒絕只有掛載中的草稿

修正前 `submitWrite` 對403／404／409／422直接拋出，沒有保存復原輸入；只有離線重播有持久拒絕副本。
四個實際 queue 邏輯回歸全部重現「已拒絕且未入列，但 recovery 沒有 rejected 輸入」。
卡片 hook 則只把草稿保留在原掛載中，卸載後不會重建；第三十五批已記錄這個限制。
紅燈證據 `direct-refusal-before37.log`：4失敗／22通過。另新增 worker 契約的首次紅燈是尚無 RPC，
不將其誤稱為實際磁碟故障重現。

比較各編輯器自行保存拒絕草稿，以及共用提交邊界擁有復原後，選擇後者。
`submitWrite` 沿用原分類，直接拒絕交由 `preserveDirectRejection`；
`storeRejectedWrite(request, reason)` 使用既有 pending_writes 的 rejection 欄位，直接建立不可重播列。
不先排 pending 再改狀態，不新增資料庫格式、重播協定或權限政策；同鍵只接受完全相同的 method／path／body。

等待 SQLite 的 IndexedDB 提交時，有同步 best-effort 退出副本，標示 rejection／unpersisted。
只有持久保存成功才切換到「已保留在此裝置」；磁碟失敗保留警告與可複製文字，仍拋出原伺服器拒絕，
讓領域回復原樂觀欄位。晚到 pagehide 不能把拒絕退回未知結果並重新提供重送。
復原只保存必要請求欄位、原鍵、可讀原因，不保存 headers 或 RequestInit。

卡片重開使用已接受正文；被拒文字從復原面板取回，不默默蓋回遠端內容。
這也套用到使用同一 `submitWrite`／`sendOrQueue` 的現有領域入口；不是每個元件各自加儲存分支。
不同新請求保留獨立副本，不因後來一次成功而自動刪掉舊拒絕輸入。

## 真實瀏覽器證據

使用現有 viewer 的快速捕捉建立限制來取得真實403，沒有為測試升權或更換後端回應。
卡片 PATCH 拒絕本批沒有真實瀏覽器證據；它的 hook＋writer＋queue 組合由下方回歸驗證，兩者分開記錄。

| 情境 | 結果 |
| --- | --- |
| 桌面直接拒絕 | 輸入「0917 直接拒絕復原驗證」及第二行，POST /api/nodes 回403（1789583638314），表單不關閉、不清空；復原12→13，沒有pending成功訊息 |
| 重載桌面 | 第13份仍有完整兩行、共用中文原因，只提供複製／移除，沒有重試按鈕 |
| 390×844複製 | 面板x4.5、寬366，頁面寬375；複製按鈕104×44，位於可見範圍。點複製，再開捕捉以Ctrl-V貼上，逐字等於原兩行；未送出此貼上測試 |
| 捕捉錯誤說明 | 初次實測仍顯示原始英文 `role viewer`。改用 reportWriteFailure 後，以「0917 手機直接拒絕復原驗證」再送一次403（1789583842874），畫面只顯示「目前沒有權限進行這項修改。」且原表單保留 |
| 手機再次重載 | 14份副本，最後兩份就是本批桌／手輸入，皆保留完整文字及不可重送的拒絕語意 |
| 清理／原資料 | 只從介面移除本批最後兩份，重載後原12份內容逐字一致；沒有改動筆記正文、白板布局或角色。viewport恢復桌面，最後控制台無error |

HTTP 紀錄 `/tmp/onden-group-audit/http.jsonl` 只有上述兩次本批 POST /api/nodes，沒有因重載而重送。
故障測試當下的403 console訊息是預期拒絕；最後正常重載沒有新增error。
手機為桌面瀏覽器viewport與鍵盤模擬，非實體手機、IME或系統剪貼簿壓力測試。

## 自動回歸與驗證範圍

- 真實sql.js worker：直接拒絕不進 replay、等待IndexedDB邊界、重開保留、同鍵同請求去重、同鍵不同輸入拒絕、磁碟失敗回滾。
- 真實queue邏輯：403／404／409／422保留原body／key，仍丟原錯誤、沒有自動重播；等待保存時與成功後的pagehide不降級；磁碟失敗保留警告，不保存headers。
- 卡片hook＋領域writer：先離開再收到拒絕、先拒絕再離開兩種排序；重開正文為已接受版、拒絕草稿在recovery、通知一次且沒有自動重送。
- 復原UI：持久化未確認時明確警告，重掛仍能看到文字，沒有重試入口；快速捕捉沿用共用錯誤文字及保留輸入。

完整前端199檔／1,535項通過，0跳過；log為 `frontend-tests37-final.log`。
舊單元mock補上新儲存介面，避免把「mock缺函式」誤當磁碟故障；真正磁碟拒絕仍有專項測試。
TypeScript與build先通過，lint發現捕捉callback不再需要翻譯函式相依項，已移除並重驗。
最終捕捉5項、TypeScript、lint與build（02:42:36）均通過；日誌為 `capture37-final.log`、
`types37-verified.log`、`lint37-final.log`、`build37-final.log`。
沒有修改後端或宣稱全後端已重新執行。

仍未完成：卡片實際PATCH403重試流程、未交接writer的輸入、真機硬關閉、兩種本機儲存同時失敗的瀏覽器實測、
同帳號多分頁SQLite協調及所有領域的真實拒絕入口。原有 queued 拒絕保存失敗仍維持原pending列、停止drain，未更改該契約。
復原持久化失敗的fallback是best-effort，不能承諾重載後一定存在。

本批未部署；localhost仍是第三十二批，第三十三至三十七批只在原始碼及隔離環境。
已另開唯讀localhost頁確認實際component為 `/_astro/AppRoot.DP72YrvL.js`，登入表單正常顯示，隨後關閉核對頁。
凍結來源 `/tmp/onden-group-audit/verified-build37`，清單 `verified-source37.json`；SHA-256
`715a2040687f7fcf4bbd7314675a9b880118caf3aec4c08eeeab98991903258f`。
