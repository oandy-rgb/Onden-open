# 標籤同名衝突與改名確認（2026-09-13）

> 狀態：歷史紀錄（最後確認 2026-11-01）

本批接續 GAP-17：同一父層的 class_tag 同名會被 PostgreSQL 正確拒絕，但原本 node PATCH／tag PATCH／agent API 回 500。
前端把 500 當作可重試故障，無法向使用者清楚指出名稱衝突。這批沒有更改名稱唯一性或角色政策。

## 修正與邊界

1. `tagHierarchy.assertTagNameAvailable` 擁有同名規則，node PATCH、tag PATCH 和 agent dry-run 共用；
   agent 實際保存沿用 `nodeUpdate`。名稱與移動後父層一起檢查，且在適用授權之後執行。
   同名仍限同 workspace、同父層、未刪除的 class_tag；大小寫敏感，一般筆記可同名。
2. HTTP 回 `409 { error: "tag_name_conflict", detail: ... }`。資料庫約束仍是競態保護，
   共用邊界只辨識它的精確 constraint；未知錯誤仍 500。tag restore 既有 state_conflict 與匯入衝突不改語意。
3. MCP route 不再將所有未特判例外重包成 500；保留原有 scope／authority／rate-limit／invalid_args 回應，
   其他走共用 HTTP 邊界。未知錯誤回 `500 internal`，不再把原始 DB detail 送給客戶端。
4. 瀏覽器找到側欄的第二個缺口：改名 writer 回報錯誤後，外層仍無條件關閉輸入框。
   改名操作現在回傳是否已獲確認，失敗保留輸入；較舊回應不能關掉後來的新名稱或其他節點的表單。
   Enter 與 blur 的同一筆在途提交會合併。錯誤沿用 writeErrors，只通知一次。
5. 瀏覽器也發現成功改名後 tag.name 沒更新，側欄與標籤頁標題不一致。
   共用 patchNode 現在同步既有標籤名稱，並由同一條調和／回滾路徑更新。schema pack 的獨立名稱不變。

相比各入口自行處理 SQL 例外，呼叫者只需提供目標名稱與父層，不必知道 constraint 名稱或重新分類 HTTP。
前端表單只判斷改名是否獲確認，不需再推測「函式結束」代表成功。沒有新增萬用寫入框架。

## 自動驗證

- 隔離 PostgreSQL：`onden_tag_conflict_test`，由目前 schema 建立；沒有使用日常資料庫。
- 新增 `tagNameConflict.integration.test.ts`，13 案：四入口、根層／子層移動、同時改名移動、
  一般筆記／其他父層／刪除標籤／同節點／跨 workspace／大小寫、同鍵有效重試與去重、競爭改名、
  admin 與 token scope、真實資料庫約束回滾、其他儲存錯誤保持 500。
- 完整後端：205 個檔案，1,686 項通過，0 skipped，111.12 秒。
  記錄：`/tmp/onden-tag-conflict-backend-full.log`。
- 前端專項：6 個檔案，79 項通過；覆蓋 noteWriter、草稿 autosave、writeQueue、側欄改名確認、
  OverviewSidebar、storeOps。拒絕保留標題／正文、修正再保存、不排入重試、舊回應保留新表單、
  顯示名稱調和且不更動 schema identity。
  記錄：`/tmp/onden-tag-conflict-frontend-final.log`。
- 完整前端：180 個檔案，1,266 項通過，0 skipped，32.06 秒。
  記錄：`/tmp/onden-tag-conflict-frontend-full.log`。jsdom 的 canvas 環境提示仍存在，不能據此宣稱真實畫布渲染已驗證。
- 後端與前端 TypeScript、lint、build 通過。

首輪新增整合測試的 fixture 曾因 UUID 參數型別錯誤而失敗；修正後才執行行為驗證，
沒有把這次 fixture 失敗宣稱為原始缺陷的重現。原始 500 證據保留在 CF／GAP-17。

## 瀏覽器與剩餘限制

使用 localhost:5100 前端、18788 API、`onden_import_audit_test` 合成標籤與既有測試登入。
桌面 1440×900、手機 viewport 390×844：實際側欄同名提交收到繁中提示，輸入保留，原節點與正文不變，
失敗後成功事件數為零；修改名稱後可保存，成功才關閉。手機提示完整顯示且不與底部導覽重疊，輸入焦點保留。
手機成功後標籤頁名稱立即更新；重新載入再核對名稱。最終資料庫為「0913 同名檢查 B 手機已改正」、
正文仍是「原本的標籤正文」，恰有兩筆 NODE_UPDATED，對應桌面與手機兩次有效改名。

手機測試使用瀏覽器 viewport 及 context menu，沒有驗證真機長按、軟鍵盤、IME、背景回收。
一般編輯器標題與正文衝突由前端行為測試驗證；目前 class_tag 實際頁面是 SchemaLens，瀏覽器走側欄改名。
這不是完整功能盤點完成，也沒有新增跨重載草稿保障，或重做所有標籤／schema 的同步資料投影。
