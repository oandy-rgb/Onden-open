# 資料完整性審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：筆記文字、標籤、樹位置會不會遺失、重複或損毀。只讀程式碼形成判斷，未參考文件。

驗證方式與限制：
- CONFIRMED＝有執行重現。#1、#2 由 vitest 重現；#3 用 `threeWayMergeBody` 加上 `nodeUpdate.ts:242` 守門條件的等價腳本重現。
- SUSPECTED＝由程式碼推理，未執行。其中標「讀碼確定」者，路徑單純，但沒有跑。
- 本環境只有 Postgres 16，缺 `age`、`pgroonga`、`vector` 擴充，`db/schema.sql` 無法載入，所以沒有跑任何資料庫整合測試。
- 這份審查的一部分由三個唯讀審查者分頭讀碼（後端還原／備份／標籤合併；前端存檔與同步；匯入匯出／blob／migration），結果我合併排序。審查者未回報讀過 `backupArchive.ts`、`backupFile.ts`、`githubBackup.ts`。

數量：P0 ×1、P1 ×9、P2 ×15，共 25 項；CONFIRMED 3、SUSPECTED 22。

---

## P0

### 1. 切到別的筆記再切回，存檔進行中時，下一次存檔會把已打的字刪掉（CONFIRMED，vitest）
- 位置：`packages/frontend/src/lib/data/draftActions.ts:152-160`（`resetDraftForNode` 不遞增 `draftRevision`）、`:456-460`（`applyRemoteNode` 在比對草稿前先因 `markdown === base.markdown` 提早返回）。
- 情境：輸入「base one」並送出存檔（網路慢，仍在途）→ 再輸入「 two」→ 點筆記 B → 點回 A → 兩次存檔完成。
- 結果：編輯器顯示「base one」，store 與伺服器是「base one two」。下一個按鍵送出 `{markdown:"base one!", base_markdown:"base one two"}`，伺服器三方合併把「 two」當成使用者刪除，文字無聲消失。
- 原因：回到 A 時，草稿取自 store 那一列（只有第一次存檔的樂觀文字），不是仍排隊的第二次存檔；第二次存檔再把 `bases` 設成自己的文字，`applyRemoteNode` 因此認為沒有差異。
- 修法：`resetDraftForNode` 以該筆記最新的未送出／在途文字（`pendingSave` 或最後送出的文字）播種並遞增 `draftRevision`；`applyRemoteNode` 先比對可見草稿再看 base。

## P1

### 2. 離開頁面（pagehide／切 App）時，若前一次存檔仍在途，新打的字沒有任何保護（CONFIRMED，vitest）
- 位置：`draftActions.ts:204-215`。`flushPendingSave` 先 `await previous` 才呼叫 `writer.patch`，keepalive 請求與 `rememberUnconfirmedWrite` 都在 `commit()` 內，所以要等前一次存檔結束才會發生；此時 `isDirty`、`pendingSave` 已清空。
- 重現：在途存檔＋再打字＋`flushPendingSave({keepalive:true})`，回復副本 0 份、pagehide 當下沒有請求；沒有前一次存檔的對照組則同步產生 1 份。
- 情境：手機網路慢，使用者打字後切到別的 App 被系統回收，最後一段文字遺失。`:199` 的註解「寫入通道會排序」對這條路徑不成立。
- 修法：keepalive 時不等 `previous`，同步交給 writer（`saveNoteBody` `:401` 已是這樣做）；或至少在 await 之前呼叫 `rememberUnconfirmedWrite`。

### 3. 只改標題（或把內文改回原樣）的存檔，會用舊內文蓋掉伺服器上較新的內文（CONFIRMED，等價腳本）
- 位置：`packages/backend/src/services/nodeUpdate.ts:242`，條件 `oldBody !== baseMarkdown && oldBody !== newBody && baseMarkdown !== newBody`。
- 情境：裝置 B 把內文加了一段；裝置 A（離線，或草稿在 `isDirty` 時 `applyRemoteNode` 被略過）只改標題。前端一律送 `{title, markdown: 草稿}`，草稿等於 base，所以 `baseMarkdown === newBody`，守門條件不做合併，直接把舊內文寫回。B 的內文只剩版本歷史裡有，也不會產生 BODY_CONFLICT。
- 重現：base `"A\n\nB\n"`、伺服器 `"A\n\nB\n\nFROM-B\n"`、incoming 等於 base：守門條件為 false，存入 `"A\n\nB\n"`；若有呼叫 `threeWayMergeBody` 則得 `"A\n\nB\n\nFROM-B\n"`。
- 修法：拿掉 `baseMarkdown !== newBody` 這一項（`threeWayMergeBody` 已處理 `incoming === base`，回傳 current），或在 incoming 等於 base 時直接不寫入 markdown 欄位。

### 4. 標籤合併略過垃圾桶裡的成員，還原後它們沒有目標標籤（SUSPECTED，讀碼確定）
- 位置：`packages/backend/src/services/tagMerge.ts:192-197`，成員查詢帶 `n.deleted_at IS NULL`。
- 情境：筆記 N 在垃圾桶且帶 #source；把 #source 合併到 #target；再還原 N。N 只有已軟刪的 #source，不會得到 #target。
- 修法：合併時連同已刪除成員一起掛上 #target，或在筆記還原時補掛。

### 5. 帶有已刪除標籤的筆記無法「複製」與「還原為新筆記」（SUSPECTED，讀碼確定）
- 位置：`packages/backend/src/services/noteDuplicate.ts:94-100`；`eventRestore/restore.ts:900-906` 將其對應成 `state_conflict`。
- 情境：標籤合併後，所有舊成員仍有指向已軟刪 #source 的 `node_tags`；`duplicateNote` 對任何已刪除標籤丟 409 "direct tag is unavailable"。
- 修法：複製時略過已刪除的標籤（查詢加 `t.deleted_at IS NULL`），不要整個拒絕。

### 6. 備份還原到另一個工作區時，標籤全部被略過（SUSPECTED）
- 位置：`packages/backend/src/services/backupRestore.ts:308-309`。判斷 `held?.node_type === "class_tag" && !held.deleted` 沒看 `held` 屬於哪個工作區（`taken` 是跨工作區依 id 查的）。
- 情境：工作區 A 的備份還原到同一台伺服器的工作區 B，標籤 id 仍活在 A，計畫判定「已存在」，後續 `applyTagToNode` 丟 `tag not found`，被 `tryWrite` 計為略過；所有筆記回來時沒有標籤，標籤也沒被建立或依路徑對應。
- 修法：只有 `held.readable` 且在本工作區才視為已存在，否則依路徑對應或建立。

### 7. Notion 資料庫列可能拿到別的頁面內文（SUSPECTED）
- 位置：`packages/backend/src/services/importNotionDatabase.ts:79-83`、`:218-222`（`byTitle`）。
- 情境：`byTitle` 涵蓋整包匯出的所有 .md，後者蓋前者；Notion CSV 通常沒有頁面 id，只靠標題比對。兩列同名「Untitled」會拿到同一份內文，其他檔案不被消耗而另成獨立筆記；列標題與一般頁面同名（如「Notes」）時會吞掉那頁，該頁不再單獨匯入。
- 修法：只在該 CSV 所在資料夾內比對（資料夾＋標題為鍵）；一個檔案只消耗一次；遇到重複不猜，當獨立筆記匯入。

### 8. 「拆分筆記」在回應遺失時會把剛建好的子筆記丟進垃圾桶（SUSPECTED）
- 位置：`packages/frontend/src/lib/data/noteStructure.ts:107-114`（`splitNote`）、`:51-57`（`createChildNotes`）。
- 情境：父筆記的 PATCH 已被伺服器接受但回應遺失（逾時）；`splitNote` 把所有新子筆記刪除，父筆記只剩指向垃圾桶筆記的連結，段落文字只存在垃圾桶。另外，回應遺失的建立不在 `created` 裡，不會被清掉而成為孤兒；每次呼叫都重新 `randomUUID()`，重試會產生重複子筆記。
- 修法：只有 `classifyWriteFailure(error) === "rejected"` 才回滾；結果不明時全部保留並提示檢查；每個意圖只產生一次子 id。

### 9. 「合併子筆記」會把沒有併入的孫筆記與子任務一起刪掉（SUSPECTED，讀碼確定）
- 位置：`noteStructure.ts:176-216`（`mergeChildren`）；後端 `trashLive`（`nodeTrash.ts:115`）整棵子樹軟刪，前端 `dropNode`（`storeOps.ts:34`）丟掉該節點上的任務。
- 情境：被合併的子筆記底下還有子筆記或任務；只有子筆記本文被併入，其餘消失，提示卻說「已合併 N 篇」，只能到歷史找回。
- 修法：有後代或任務時拒絕或警告，或先把孫筆記改掛到父筆記再刪。

### 10. Markdown 匯出會無聲丟掉屬性，Notion／CSV 匯入後無法來回（SUSPECTED，讀碼確定）
- 位置：`packages/backend/src/services/exportZip.ts:150`，只保留 `isAttributeKey(a.key)` 且值不含換行者。
- 情境：匯入刻意保留「Due Date」等欄名，Markdown 匯出時這些欄位與多行值被省略且不告知；匯出再匯入後每列都少了欄位。備份路徑有保留。
- 修法：至少在匯出結果列出被省略的鍵並顯示給使用者；較好的做法是以引號 YAML 鍵／區塊純量寫出並讓匯入端讀回。

## P2

### 11. 每次內文存檔都帶標題草稿，可能蓋掉別處的改名（SUSPECTED）
- `draftActions.ts:213`。標題沒有三方合併；`isDirty` 期間 `applyRemoteNode` 略過更新，下一次自動存檔用舊標題蓋掉其他裝置或代理的改名。修法：標題與 `bases.title` 不同時才送。

### 12. 失敗的自動存檔在每次切換筆記、每次分頁隱藏時都會重送（SUSPECTED，讀碼確定）
- `draftActions.ts:221-228`。永久拒絕（403、驗證）的編輯被重送，每次新冪等鍵，重複寫入回復項目與錯誤提示；在別的筆記打字會覆蓋 `pendingSave`。修法：失敗快照只留在回復副本，提供明確重試。

### 13. 超過 64KiB 的筆記在離開頁面時依賴手動回復（SUSPECTED）
- `writeQueue.ts:72`、`writeLifecycle.ts:36`、`hooks/useOverviewMode.ts:148`。瀏覽器對超過 64KiB 的 keepalive 請求丟 TypeError，退到非同步的本機佇列寫入，頁面死掉時只剩 localStorage 的「未確認」副本，需下次載入手動處理。修法：本文小於約 60KB 才用 keepalive，否則同步留回復副本。

### 14. 多分頁的待送佇列順序（SUSPECTED）
- `writeQueue.ts:93`、`lib/localDbWorker.ts:970`。各分頁的 worker 只看得到自己的 `pending_writes`，分頁 B 認為沒有積壓而直接送出，分頁 A 較舊的排隊編輯之後才重播；標題、`sort_order`、`parent_id` 是後寫者勝，舊值可能蓋掉新值（內文有 `base_markdown` 保護）。修法：檢查積壓前或分頁可見時重讀其他 session 的 journal。

### 15. 精簡模式的內文快取淘汰可能把開啟中的筆記清空（SUSPECTED）
- `lib/data/syncEngine.ts:324-336`（`adoptBody`）只排除正在收的 id，不排除 `editorNodeId`。開著筆記 A 時若有超過 150 次其他筆記水合，A 的內文被淘汰成空，`nodeNeedsBody` 為真，編輯器以 null 重置，重新水合又可能與在途存檔競爭（同 #1）。修法：不淘汰編輯器正顯示、有草稿或有存檔在途的筆記。

### 16. 被拒絕的刪除不會完整復原本機狀態（SUSPECTED，讀碼確定）
- `noteWriter.ts:166-176` 回滾只還原 nodes、edges、tasks；`dropNode` 還丟了 `tags` 與 `pointers`。刪除被拒（例如標籤 409）後標籤與釘選在下次完整刷新前消失。修法：回滾時一併還原。

### 17. Notion 列匯入部分失敗會丟內文並重複計數（SUSPECTED）
- `importNotionDatabase.ts:209-232`。`createItem` 提交後才 `attachBody`，檔案卻在 `attachBody` 前就列入 `consumedMdPaths`；`attachBody` 丟匯入拒絕時，列同時算匯入與略過，項目沒有內文，.md 也不會當獨立筆記匯入。修法：成功後才標記已消耗並只計一次。

### 18. 標題、內文或屬性值含 NUL（U+0000）會變成未對應的資料庫錯誤（SUSPECTED）
- `utils.ts:9-12` 的 `nodeSchema` 與 `assertNoteSize` 接受 `\u0000`，`putBlob`（`blobs.ts:31`）與 `content_nodes` 寫入在 Postgres 失敗（22021），`httpError.ts` 沒有對應。貼上或匯入含 NUL 的文字得到 500，編輯器當作可重試；資料夾匯入可能中途中止（前面的筆記已提交）。修法：在 schema 與大小檢查以 400 拒絕，匯入端以原因略過該檔。

### 19. blob 垃圾回收與同內容寫入有競態（SUSPECTED）
- `blobs.ts`、`purgedContent.ts:171-179`。`deleteUnreferencedBlobs` 可能刪掉另一個並行寫入剛在事件鎖外 `putBlob` 的相同內容 blob，版本事件隨後指向不存在的 blob；筆記本文不受影響，但還原該版本失敗。修法：`deleteUnreferencedBlobs` 略過 `created_at` 在寬限期內的 blob，或讓 `putBlob` 進事件交易。

### 20. 還原標籤改名可能得到未處理的唯一鍵錯誤 500（SUSPECTED）
- `eventRestore/restore.ts:739-747`、`:802`。對 `class_tag` 直接寫回舊 `title`，只有換 parent 才走 `assertReparent`，沒檢查同層名稱唯一。標籤 a→b 之後別的標籤佔了 a，再還原改名會觸發唯一鍵違反（交易回滾，資料未損，但回傳 500 而不是 `state_conflict`）。修法：對 `class_tag` 呼叫 `tagNameTaken`／`assertTagNameAvailable`。

### 21. 備份還原作業在第一次提交後當機，重試無法判定（SUSPECTED）
- `backupRestoreJobs.ts:71-75`、`:102`、`:147`；`backupRestore.ts:550-561`。`beginRestore` 已提交 BACKUP_RESTORED 與標籤，job 的 `event_id` 要到下一次 `progress("notes")` 才寫入；中間中斷時 job 是 `failed`、`event_id` 為空、可重試，重試卻遇到 `IdempotentReplay` 回報 `already_restored`，使用者無從復原已寫入的部分。修法：在 `beginRestore` 交易內寫入 `event_id`。

### 22. 「沒有逆向補丁」與「內文沒變」都是空字串（SUSPECTED，低機率）
- `eventLog/bodyPatch.ts:52`、`:80`；`eventRestore/restore.ts:143`。含孤立代理字元而編碼失敗時 `makeInversePatch` 回傳 `""`，`rebuildPreEventBody(post, "")` 回傳 post，三方合併得到目前內文：復原回報成功卻什麼都沒做。修法：以 `null` 或旗標區分，無逆向補丁時回 `history_incomplete`。

### 23. 匯出的連結與路徑處理有損（SUSPECTED）
- `exportZip.ts:263`：垃圾桶筆記用 `safeBase` 而不是 `vaultName`，舊 slug 含 `/` 或 `..` 會產生巢狀或逃出的 zip 路徑。`:72-76`：指向未匯出筆記的連結變成不存在的 `./<uuid>.md`；regex 會改寫程式碼區塊內的 `onden://node/`。`tagHierarchy.ts:404-415` 的 `fullTagPath` 遇到已刪祖先就停，匯出的標籤路徑少了上層，重新匯入變成根標籤。修法：沿用 `vaultName`、略過程式碼區段、`fullTagPath` 跨過已刪祖先。

### 24. CSV 匯入有無聲的資訊損失（SUSPECTED）
- 整欄日的部分都 ≤12 時被當月在前而日期對調（`attributeValue.ts:173` 註解承認有歧義）；日期時間欄的時間被丟掉；超出表頭寬度的儲存格被忽略；只用 `\r` 換行的 CSV 被當成一筆（`csvImport.ts:46`）。修法：匯入結果列出受影響欄位，歧義欄保留為文字，單獨的 `\r` 視為換行。

### 25. Migration 110 可能刪掉使用者自己的空 `excalidraw` 標籤（SUSPECTED，多半已執行）
- `db/migrations/110_excalidraw_import_only.sql`。以 regex 改寫 `content_nodes.markdown`（無事件、無 blob，歷史與客戶端 `base_markdown` 與儲存文字不一致）；並刪除沒有子筆記的根 `class_tag` "excalidraw"，檢查只看 `parent_id` 子節點而不是 `node_tags`，與註解「有東西歸在它底下就保留」不符。建議檢查正式資料庫有沒有被刪掉的使用者標籤，以後不要沿用這種寫法。

---

## 做得好、不要動的部分
- `services/eventLog/bodyMerge.ts` 的行級三方合併：分區規則清楚，插入點相鄰與同位置插入不會重複文字，衝突時保留送出方文字並把對方文字送進 BODY_CONFLICT，沒有模糊比對。「同一個字改成兩種」不會再像舊的字元級補丁那樣無聲吞掉一方。
- 本機資料庫 journal 與離線佇列（`lib/localDbJournal.ts`、`lib/localDbWorker.ts:99-160`、`writeQueue.ts`）：寫入前日誌、以 session 與序號重播、不把讀不到的 journal 當成空的；拒絕的寫入保留在回復區而不丟棄，重送沿用原冪等鍵。
- 匯入對既有筆記的保護（`importMarkdown.ts` 與 `importIdentity.ts`）：只有使用者選定來源、唯一匹配、且目前狀態仍等於上次匯入基準雜湊時才會更新，否則回報 `local_changes` 而不覆蓋；也包括 `vaultPaths` 的大小寫無關唯一命名與編輯器非同步結果的 `stillOn`／`editLeftNote` 守衛。
