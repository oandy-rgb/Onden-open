# 匯入圖片與媒體讀取盤點 — 2026-09-12

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：DATA-01／DATA-02 的重複圖片與來源連結，以及本批發現的 MEDIA-02／PER-06 媒體讀取漏判。
基線是 `719ce80` 加工作樹既有歷史、備份與資料夾匯入修改；本批保留那些未提交工作，沒有使用子代理。
前一批資料夾結果見 [匯入盤點](import-audit-2026-09-12.md)。

後續進度：[來源與覆蓋保護盤點](import-source-audit-2026-09-12.md) 已處理新來源命名空間、
筆記覆蓋保護及本報告留下的兩項回歸失敗；以下保留本批當時的結果與限制。

## 結果

相同操作者在同一工作區再次匯入相同圖片，現在沿用原本可讀的 URL，未改的筆記維持 unchanged。
不同目錄的同名圖片按筆記來源路徑解析；無法唯一比對的圖片連結保留原文，結果提示檢查路徑。
GAP-09 在本批的索引與格式範圍內已修正；這不代表跨 vault 的筆記覆蓋與整批重試已安全。

另確認先前跳過的媒體權限測試揭露了真實的 SQL 查詢問題，而非已證實的測試框架問題：
PGroonga 的 ILIKE 索引掃描漏掉含媒體 URL 的引用，導致受限圖片被當成「沒有引用的上傳」。
已改為字面子字串查找並重新啟用 3 個案例。這是伺服器授權結果的修正；沒有證據顯示已發生正式環境存取事件。

| 修正前的行為 | 本批結果 |
| --- | --- |
| 相同圖片重匯生成新檔名，原筆記也被計為更新 | 私有內容索引沿用 URL；同內容筆記維持 unchanged |
| basename 對照表由最後一個同名檔案覆蓋 | 依筆記路徑解析；唯一短檔名才 fallback，歧義不挑任一張 |
| 正規表示式可能改寫程式範例 | Markdown AST 只處理圖片語法，wiki embed 只處理正文文字；程式碼及 frontmatter 保留 |
| 壞圖、重複來源路徑可能導向另一張同名圖 | 保留失敗路徑占位，略過檔案並保留無法比對的原引用 |
| 媒體 SQL 查不到引用時可能繞過節點政策 | 正文／屬性都用字面包含比對，再沿用既有 readPolicy 授權 |
| 結果無法分辨新圖與重用圖 | UI 顯示新匯入、沿用圖片、未解析引用數 |

## 責任與設計取捨

比較兩種內容辨識方案：

1. 直接讓 URL 等於圖片內容雜湊。容易去重，但 URL 可由已知內容推算，改變目前不透明檔名的保證。
2. 私有索引保存內容雜湊到隨機檔名的對照。選擇此方案；URL 仍隨機，索引不是權限或媒體所有權。

新增 migration 082 的 `imported_media`，主鍵為工作區、操作者 ID、消毒後內容 SHA-256、格式。
它只記錄匯入不可變檔案的對照，不承擔節點、來源 vault、政策、同步或領域事件的責任。
有索引不代表能讀取；每次重用仍由 `canReadMedia` 判斷目前權限。
不同操作者／工作區不共用索引；同一操作者已失去原圖可讀性時，匯入其提供的相同位元組會建立新 URL。

公開操作為：

```ts
const media = await prepareImportedImages({ actor, workspaceId, files });
const markdown = media.rewrite(sourceMarkdown, sourcePath);
```

`prepareImportedImages` 擁有格式與大小驗證、SVG 消毒、內容辨識、授權核對、落盤與索引交易。
呼叫者只傳入來源檔案及每篇筆記的原始路徑，取得 imported／reused／skipped／unresolvedReferences。
這些計數表示已處理的媒體與引用，不能當成整批筆記已提交。
`importedImageLinks` 擁有本次上傳的路徑解析，不知道 DB、權限或檔案儲存。
因此路由不再同時理解隨機檔名、磁碟寫入、重用條件與圖片連結語法。
Notion 資料列的正文也傳入原始 Markdown 路徑；CSV 的集合建立與重匯語意維持既有行為。

### 來源連結契約

Obsidian 提供 wiki embed／Markdown 圖片語法，以及最短唯一、相對筆記、相對 vault 的路徑選項。
參考官方 [嵌入說明](https://obsidian.md/help/embeds) 與 [設定說明](https://obsidian.md/help/settings)。
以下解析順序是 Onden 的明確匯入契約，沒有宣稱完全複製 Obsidian 的解析器：

- 明確 `./` 或 `../` 只相對於筆記所在目錄，不退回根目錄的另一張圖。
- 其他 Markdown 路徑先相對筆記，再嘗試 vault 根目錄；wiki 路徑先根目錄，再相對筆記。
- 不含 `/` 的短檔名最後才嘗試唯一 basename；精確路徑保留大小寫，忽略大小寫的短檔名須唯一。
- 失敗或重複的來源路徑保留占位，不能 fallback 到另一張圖片。無法比對時不改原文並回報數量。
- 支援 URI 編碼、中文、空格、平衡括號、Markdown title／引用式圖片；URL query 與 fragment 保留。
- frontmatter、程式碼區塊、行內程式碼、跳脫的 wiki embed、普通連結及外部 URL 不改寫。

目前圖片格式為 PNG、JPEG、GIF、WebP、SVG、AVIF，依既有大小限制檢查並驗證實際格式。
未完成 HTML `<img>`、Obsidian 圖片尺寸語法或所有外掛的相容驗收。

### 檔案與錯誤契約

SVG 先移除不安全內容再雜湊。新圖先寫入同目錄暫存檔、sync／close，再 rename；之後才提交索引。
同一工作區使用既有事件交易鎖序列化查找與索引更新，不另外增加去重鎖平台。
原圖內容有變就建立新 URL，不覆寫仍被舊筆記引用的圖片。
索引指向的檔案缺失／位元組損壞時，可用本次完全相同的消毒後內容修復原 URL。

只有不支援／不合法圖片屬於略過結果；未知磁碟與 DB 錯誤往共用 HTTP 錯誤邊界傳遞。
檔案已寫入但 DB 失敗可能留下孤立檔案；不在不確定的 COMMIT 後貿然刪檔，也不把整批匯入宣稱為原子交易。
目前沒有媒體清理、整批持久化冪等鍵、離線上傳或機器斷電的一致性驗收。

## 媒體授權漏判的證據與更正

在隔離 PostgreSQL 中，同一筆受限節點可直接查到完整正文，逐筆判斷 `ILIKE` 為 true，
但將同條件放入引用集合查詢時得到零筆。EXPLAIN 選用 `content_nodes_pgroonga_idx`；
關閉該 session 的 index／bitmap scan 後，集合查詢取得正確節點。以下為重現方式的結構：

```sql
-- filename 與 node_id 使用測試資料，不在此文件放正式內容。
SELECT markdown ILIKE '%/api/media/' || :filename || '%'
FROM content_nodes WHERE id = :node_id;

EXPLAIN SELECT id FROM content_nodes
WHERE markdown ILIKE '%/api/media/' || :filename || '%';

SET enable_indexscan = off;
SET enable_bitmapscan = off;
SELECT id FROM content_nodes
WHERE markdown ILIKE '%/api/media/' || :filename || '%';
```

原先 `canReadNode(editor, node)` 拒絕，`canReadMedia(editor, filename, workspace)` 卻允許：
空引用集合會走「尚未掛到筆記的上傳只要求已登入」的既有分支，跳過受限節點的讀取政策。
匿名讀取公開圖片也可能因同一漏查而被錯誤拒絕。
因此不能繼續將這三個跳過案例歸因於 Vitest／連線池。

修正為正文與屬性都使用 `strpos(lower(value), lower('/api/media/' || filename)) > 0`。
其後仍由既有逐筆／公開集合 readPolicy 決定允許或拒絕，沒有改成由匯入索引授權。
已驗受限圖片 anonymous／viewer 拒絕、admin 允許，公開圖匿名可讀，無引用圖仍需已登入，
以及只出現在屬性中的圖片同樣受所屬節點政策限制。
這是授權正確性修正，沒有量測或宣稱效能提升；發布產物、瀏覽器快取與完整撤權仍須另盤。

## 實際驗證

### PostgreSQL 與自動測試

沿用隔離容器 `onden-browser-test-pg-20260908`，連線埠 15432；沒有對日常資料庫執行清除或故障注入。
既有 `onden_import_audit_test` 完成 migration 082 升級，另由更新後 schema 建立 `onden_media_final_test`。
migration 回歸包含空資料庫與升級路徑；schema dump 保留原本種子與 search_path 設定。

| 檢查 | 實際結果 |
| --- | --- |
| 修正前有效的圖片整合測試 | 重匯與不同目錄同名圖片 2 項失敗，確認可重現 |
| 後端完整回歸 | 202 檔：200 通過、2 失敗；1,625 項通過、2 失敗、0 跳過 |
| 後續最終重點回歸 | 10 檔、53 項通過、0 跳過；包含後來增加的格式、磁碟錯誤、屬性授權案例 |
| 最後路徑邊界修正 | 7 項解析器測試再次通過，包含明確相對路徑不得落到根目錄及 query／fragment |
| 前端設定回歸 | 3 檔、16 項通過；驗新圖／重用／未解析引用結果 |
| 兩端型別與 lint | `npx tsc --noEmit`、`npm run lint` 均 exit 0 |
| 前端 production build | exit 0；仍有既有大 chunk 與空 docs collection 提示 |

完整回歸的 2 個失敗仍是 `licenseDeclared` 的 repository README.md 缺失、`logger` 的文字／JSON 格式預期。
本批沒有修改它們，不能宣稱後端全綠。完整回歸在後續新增 3 個案例及最後路徑細節前執行，
最終狀態由重點回歸與解析器補測覆蓋，不把新案例追加到未重跑的全套數量。

重點測試：

- [importImages.integration.test.ts](../../packages/backend/src/test/importImages.integration.test.ts)：11 項，
  含重匯、同名不同圖、內容改變、操作者／工作區、撤權、併發、磁碟修復、SVG、壞檔、光柵格式與真實 EISDIR 錯誤。
- [importedImageLinks.test.ts](../../packages/backend/src/test/importedImageLinks.test.ts)：7 項，含上述語法與路徑不變條件。
- [mediaAuthority.integration.test.ts](../../packages/backend/src/test/mediaAuthority.integration.test.ts)：7 項，原 3 項 quarantine 重新啟用，另增屬性圖案例。
- 既有 folders、frontmatter、tags、upsert、media gate、schema drift、migration 一起回歸。
- [SettingsFolderImport.test.tsx](../../packages/frontend/src/test/SettingsFolderImport.test.tsx) 及備份／資料設定案例一起回歸。

執行紀錄在 `/tmp/onden-media-backend-full.log`、`/tmp/onden-media-targeted-final.log`、
`/tmp/onden-media-frontend.log` 與 `/tmp/onden-media-*-final.log`；暫存 log 不作永久證據唯一來源。

### 瀏覽器與資料核對

在暫時 Astro 頁使用正式 `SettingsModal`／`FolderImportWidget`，以 `File`／`DataTransfer`
提供固定資料，觸發正式 input change 並呼叫真實 import API；後端完整 app 使用僅測試身分 wrapper 與隔離 DB。
因此測到正式元件、傳輸、DB 與渲染，沒有測原生資料夾 picker 或真實登入。

資料為 `0912媒體實測/`：紅、藍兩目錄各有 `筆記.md` 與不同顏色的 `image.svg`，
第三篇只有歧義 `![[image.svg]]`；兩篇正常筆記另含應保持原樣的 Markdown 程式範例。

| 場景 | 觀察 |
| --- | --- |
| 桌面 1280×720 第一次匯入 | 3 篇新增、2 張新圖、1 處無法比對、3 個新資料夾 |
| 原樣第二次匯入 | 0 篇新增、3 篇內容相同、沿用 2 張圖、1 處無法比對、沿用 3 個資料夾 |
| DB 核對 | 媒體索引仍 2 筆；兩篇保存不同圖片 URL；歧義與程式範例原文保留 |
| 正式 MarkdownRenderer | API 讀回正文後顯示紅圖／藍圖；兩圖 complete=true、natural size 180×90 |
| 390×844 | 警告完整換行，頁面 clientWidth／scrollWidth 均 390，操作按鈕高 44px |
| 320×740 | 頁面寬與 scrollWidth 均 320，沒有結果文字水平溢出 |

沿用上一批 14px／1.65 行高與 44px 操作區，本批沒有再改全站或該頁 CSS。
只驗手機 viewport，未驗真機／觸控／原生選檔。
測試頁、fixture 元件與 wrapper 已移除，5101／18788 暫時伺服器已停止，viewport 還原。
既有 5099／18787 沒有重啟；日常執行環境尚未因本批代碼驗證而自動套用 migration。

## 剩餘限制與下一批

- 舊媒體沒有私有內容索引，沒有猜測回填；升級後第一次重匯可能新建一張，以後才穩定沿用。
- 不同 vault 仍沒有來源命名空間；同路徑筆記、舊標題 fallback、Onden 後續編輯覆蓋和跨路徑改名仍待處理。
- CSV／Notion 仍新建集合；本批只讓資料列正文使用正確來源路徑，沒有完成全部 Notion 匯入驗收。
- 沒有整批持久化冪等、部分完成恢復、孤立檔案清理或完整伺服器備份。索引不能取代媒體檔案本身。
- 原生 picker、不同瀏覽器、大型 vault、完整惡意／不合法 payload 與所有嵌入語法待驗。
- `canReadMedia` 仍沿用現有的已登入無引用圖政策；跨入口 scope、發布快取與撤權須繼續 MEDIA-02／PER-06。

DATA-01／DATA-02／MEDIA-02／PER-06 維持「部分」。下一批優先處理跨來源識別與覆蓋保護，
不能將這次圖片去重當成全功能盤點完成。
