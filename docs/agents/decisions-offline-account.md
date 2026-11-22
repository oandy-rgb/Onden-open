# 邊界決定：離線佇列、登入與帳號隔離、啟動（第 16、18–21、24、25 批，2026-09-13～15）

> 狀態：現行（最後確認 2026-11-18）
> 涵蓋：packages/frontend/src/lib/accountStorage.ts, packages/frontend/src/lib/indexedDbStorage.ts, packages/frontend/src/lib/pendingNoteProjection.ts, packages/frontend/src/lib/data/writeQueue.ts, packages/frontend/src/lib/data/writeRecovery.ts, packages/frontend/src/components/AccountSessionBoundary.tsx, packages/frontend/src/components/MembershipGate.tsx

何時讀：改離線佇列、拒絕輸入保留、登入檢查、帳號本機副本分區、手機帳號入口或啟動位置之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 第十六批：離線重送遭拒絕時保留輸入（2026-09-13）

- **拒絕不等於丟棄。** 比較先複製到 localStorage 再刪 queue 與在原 SQLite queue 標記狀態後，
  選擇 `rejectPendingWrite(write, reason)` 在原列保留請求和冪等鍵，保存確認後才退出自動重送。
  避免兩份儲存的提交順序與重複清理；UI 沿用既有 recovery 入口，不再建另一套通知面板。
  schema 的 rejection 為 null 才是 pending；401／網路／限流／5xx 繼續原有重試策略。
- **拒絕的輸入與可讀副本分開。** recovery 只保存原本待送出的請求，不補存伺服器整份快照。
  這筆記錄不能使原節點繼續出現在閱讀、搜尋、任務或可讀集合中，也不能作為授權依據。
  收到明確拒絕後不提供自動／一鍵原樣重送；保留原因、複製與明確移除本機副本。
- **只有 durable 狀態才算交接完成。** 拒絕狀態或使用者移除的保存失敗須保留原列，錯誤往上傳，
  本輪 drain 停止；不能已刪掉唯一請求再顯示「未儲存」。舊 queue migration 保留原鍵、順序和 attempts。
  DB 無法保存時不保證重載仍記得伺服器拒絕，但原本 durable pending 請求必須存在。
- **拒絕的文字也記得「它不在伺服器上」（2026-11-19）。** 復原區裡被拒的存檔同時是送出時換 base 的依據
  （`writeRecovery.withoutRefusedBase`）：重新整理之後，以它為 base 的存檔改用它自己的 base 送出。
  上一頁離開時只留在 localStorage 的存檔，新頁面在顯示本機副本之前先照原鍵排進佇列（`writeQueue.takeInLeftWrites`）。
  見 [筆記寫入](../architecture/note-writes.md#沒有被收下的文字不算數2026-11-19)。
  拒絕／移除都比對原請求的 method、path、body 與 key；匯入備份後的整數 ID 可能重用，
  舊 HTTP 回應或舊卡片不得改動另一份輸入。403 沿共用錯誤層給可讀說明，不在面板顯示內部角色／ID。
- **連線正常不等於全部保存。** 頂欄圓點只表示已連線；pending 計數不包含已拒絕輸入，
  因此零筆不能顯示「所有變更已儲存」。復原面板可收合並保留數量，收合不刪除資料或重送。
- **本批只收尾明確拒絕的離線修改。** 一般 pending 在 bootstrap／membership 下的 merge、
  分頁跨重試新建、多分頁 SQLite 副本衝突與目前編輯器尚未入列的草稿仍需另批審核。

實際儲存、桌面／手機重連及剩餘範圍見 [拒絕輸入保存驗證](../archive/rejected-writes-fixes-2026-09-13.md)。

## 第十八批：登入檢查失聯與恢復入口（2026-09-13）

- **無法確認登入，不等於已登出。** 比較保存上次 session 並直接解鎖本機資料，與使用既有
  `useSession` 的驗證結果提供重試後，選後者。`LoginGate` 區分初次檢查、已驗證 session、
  成功的空 session／401，以及無法確認；網路、5xx、429、403 不自行推導成未登入。
  冷啟動沒有 session 時不掛載工作區，不以 SQLite 或待送佇列存在作為授權依據。
- **驗證機制仍由 auth client 擁有。** 重試只呼叫既有 `refetch`，不另發手寫 session 請求、
  持久化登入旗標或建立輪詢器。手動重試時保留原提示，阻止重複送出並保留鍵盤焦點；
  驗證成功後沿用原 URL 開啟工作區。既有 session 在暫時檢查失敗時保持掛載，避免丟掉
  編輯器記憶體輸入；明確 401 或成功空 session 仍阻止私人內容，後端授權不變。
- **離線冷啟動須先解決資料歸屬。** 目前 IndexedDB 名稱、SQLite 與待送請求沒有 account owner
  契約，`onden.lostWrites` 也未分帳號；不能因此聲稱 A→B 隔離已完成，也不能推論已發生洩漏。
  本批只修正誤判與恢復入口，完全離線重開筆記、登出後的資料清理／保留及換帳號重播仍另批驗證。

實際故障與桌／手驗證見 [登入檢查恢復驗證](../archive/session-check-fixes-2026-09-13.md)。GAP-20
保留部分完成，ACC-06 帳號隔離仍待盤；不得以本批通過取代離線登入的安全契約。

## 第十九批：頁面請求的登入帳號預期（2026-09-13）

- **請求保有原頁面的帳號預期。** 比較送出前另查一次 session，與請求攜帶預期 user ID 後，
  選後者。前者與正式請求之間仍可換 cookie；後者由同一次後端驗證結果核對。
  `AccountSessionBoundary` 在工作區掛載前呼叫 `bindAccountStorage(userId, serverUrl)`；同一頁不能改綁另一人，
  換帳號先隱藏工作區並提供重載。`api`／`apiFetch` 統一附上 `X-Onden-Expected-User`，
  領域 writer 不自行配置；舊非同步工作仍屬於原頁面，不採用新帳號的全域值。
- **預期身分只能收緊請求，不能授權。** 後端在 cookie 驗證後、actor 查找／建立之前比對，
  不同或沒有 session 時以既有 `UnauthorizedError` 回 401 `account_changed`；bearer 或 native
  fallback 不能滿足此人類帳號預期。未帶預期的既有客戶端維持原契約，匹配後仍須通過原領域政策。
  不把 header 當作 actor ID、scope、憑證或另一次授權來源。
- **401 不消耗原重試。** 拒絕發生在寫入／事件／冪等交易之前，錯誤沿用前端 authentication 分類，
  提示登入原帳號後重試，不把它歸為永久拒絕；原帳號使用同鍵重試仍可完成且不重複事件。
- **頁面隔離不等於持久資料隔離。** 實測已確認新 B 帳號能看見前一帳號只在本機保存的復原文字
  （GAP-21）。本批未改 IndexedDB、SQLite、目錄副本或 legacy recovery 的歸屬，亦未完成
  持久佇列的 A→B 重播驗證。重載只是重新建立記憶體生命週期，不能宣稱它會清掉或隔離磁碟資料。
  舊版資料沒有 owner，不能猜測認領；遷移與安全取回須作為下一個完整使用案例處理。

真實 cookie、事件與桌／手／雙分頁的證據見 [帳號請求審核](../archive/account-request-fixes-2026-09-13.md)。

## 第二十批：本機副本的帳號分區（2026-09-15）

- **整份副本共用一個固定擁有者。** 比較每列／每個呼叫加入 owner 與整份儲存分區後，選後者。
  `accountStorage.ts` 由驗證後的伺服器 URL＋user ID 綁定一次；工作區掛載及儲存偏好讀取必須在其後。
  `localDb` RPC 隱藏分區參數，worker 在初始化前固定 scope；領域 writer 不自行配置 owner。
  IndexedDB、未確認輸入、目錄 handle 與儲存偏好使用同一身分；開啟中的頁面不能把佇列改送新伺服器。
- **舊未綁定資料不自動認領。** 保留原 `db`、legacy recovery、handle 與偏好；web 不回退讀取、不重播。
  初次選擇目錄拒絕已有 Onden 備份的目錄。這不是完成舊資料遷移：安全取回介面仍缺，不能以 workspace
  相同推定擁有者，也不能透過清除舊資料來消除缺口。
- **副本與匯入都檢查帳號身分。** SQLite 的 `local_account` 隨匯出保存；開啟／匯入核對目前帳號與
  伺服器，不符或沒有標記的 web 匯入拒絕，即使工作區相同也不能接手其待同步請求。
  帳號標記是本機防誤用，不是簽章或後端授權。IndexedDB 讀取錯誤須拒絕，不能當作不存在後覆寫。
- **分區不等於解決全部生命週期。** A→B→A 待同步重載、手機追加及原帳號提交已實測；同帳號多分頁
  snapshot 互蓋、未落盤草稿、完全離線登入與 legacy 取回仍待處理。Native 保留原 adapter，未宣稱真機通過。
  手機帳號入口與待同步數量缺口見 GAP-22，不因資料保存正確就將兩種布局判定為同等可用。

比較、實測與剩餘限制見 [帳號本機副本分區](../archive/account-storage-fixes-2026-09-15.md)。

## 第二十一批：手機帳號與同步入口（2026-09-15）

- **布局共用操作，保存準備由編輯器擁有。** 比較各入口組裝草稿／snapshot／auth 與共用操作後，
  選擇 `AccountPanel` 使用 `prepareEditorForExit()`；桌面與手機只提供外殼和既有管理使用者入口。
  準備等待當前草稿、已開始保存及本機 snapshot；拒絕、落盤失敗或期間的新輸入都停止登出。
  這不涵蓋每個表單、白板／ink 生產者、另一分頁，也不表示已同步至伺服器。
- **登出確認與本機保存是兩個結果。** 保存完成才呼叫 auth；resolved error 和 rejected promise
  都保留操作視窗與重試。回應遺失顯示「尚未確認登出成功」，不宣稱 session 一定仍存在。
  既有 LoginGate 處理確認後的畫面；不先清空草稿、先關閉或強制跳頁。
- **等待結果時背景不能繼續編輯。** 帳號／更多使用共用原生 `ShellDialog`，portal、inert、
  背景捲動鎖、按鈕焦點循環與返回由外殼承擔。等待登出時停用關閉和其他動作，
  Escape／背景點擊不能解鎖；桌面置中、手機底部與短畫面捲動是同一契約的呈現。
- **待同步筆數只有一份來源。** `SyncStatus` 共用既有 queue 計數及 `sync()`；手機在有 pending
  或離線時顯示常駐列，更多亦可同步。失敗沿用 `reportWriteFailure`，modal 內採行內回饋，
  避免 toast 被 top layer 蓋住；零筆只說已連線，不能據此說所有草稿／被拒絕輸入已保存。

GAP-22 的手機入口與狀態可見性已修；320／390px、1440px、503 及手機 A→B→A 實測見
[手機帳號與同步入口](../archive/mobile-account-sync-fixes-2026-09-15.md)。真機鍵盤、legacy 取回、
同帳號多分頁及完全離線冷啟動仍待處理，不能以本批通過判定全帳號功能完成。

## 第二十四批：啟動位置與待同步建立（2026-09-15）

- **啟動選擇等待可讀集合調和。** cached bootstrap 不足以確認首頁／上次筆記仍存在；
  `BuilderApp` 等既有 membership gate 後才做一次性選擇。明確 URL 優先，缺少偏好目標回到今日；
  手機使用同一開啟動作進入內容頁，上次位置保留 lens。啟動頁不解讀 queue 或另建授權規則。
- **保留自己的建立輸入，不保護整列快取。** 比較排除 pending ID 的撤權清除與從 durable POST 重建後，
  選後者。`pendingNoteProjection` 解讀既有 content／canvas 建立及後續文字／刪除；只保留本人的請求輸入。
  已撤權副本的父層、標籤、屬性、任務與邊照常移除，即使 ID 同時有 pending POST。
  此決定取代第十七批 slim 對 pending 建立 ID 的整列保留例外；不增加後端可讀集合或授權能力。
- **worker 回傳實際套用的本機投影。** full／slim 與冷啟動都補回缺少的新筆記；slim 清除納入保存交易。
  sync 先完成遠端刪除及相依清除，再套用 `AppliedSyncDelta.pendingCreations`，SQLite 和畫面採同一順序。
  此欄位由 worker 建立，不接受 wire 同名欄位作為本機輸入；它不是新的伺服器同步通道。
  已拒絕／已確認的建立不再重建，rejected 輸入仍走既有復原面板。
- **縮到總覽後再次點選仍是閱讀意圖。** 已選卡片在精簡模式小於 1× 時，再點它回到至少 1×；
  不依賴 selected ID 必須變更。一般正文刷新和精簡切換仍不重新置中，不把鏡頭操作寫成布局修改。

實測與仍有限制見 [啟動及待同步建立](../archive/startup-pending-create-fixes-2026-09-15.md)。
本批不提供跨裝置今日唯一、其他領域建立重播、完全失聯登入或多分頁快照一致的保證。

## 第二十五批：重播拒絕、缺失選取與可操作的回饋（2026-09-15）

- **拒絕會使本機投影需要重新核對。** 比較依失敗 POST 的 ID 直接刪除與交還 membership 核對後，
  選後者；同 ID 可能仍是既有可讀筆記。queue 在拒絕輸入已持久化後推進頁面內 revision，
  sync 即使收到相同後端 epoch 也重新核對，並在開始時捕捉 revision；晚到的拒絕要求下一次核對。
  recovery 的筆數／刪除不是這個版本，重新載入仍沿用冷啟動完整檢查；不新增授權來源。
- **核對失敗要有可用的出口。** 未確認副本保持既有 gate／inert；`MembershipGate` 只呼叫既有 sync，
  不自行解除 gate。空 queue 仍能手動重試，失敗沿用 `reportWriteFailure`。同步列、收合復原與通知
  共用手機底部預留；通知換行並有獨立關閉按鈕，不讓保存失敗遮住恢復操作。
- **指定的筆記不存在，不代表選了另一篇。** 比較清掉 selected ID 與 selector 回傳 null 後，選後者，
  讓延遲載入的深層連結仍可恢復。`selectOverviewSelectedNode` 只在沒有指定 ID 時保留既有首篇回退；
  明確 ID 缺失時，inspector、草稿與衍生操作共用 null，不各自猜測新對象。
  手機依可用內容呈現列表，保留要求的分頁；沒有選卡的既有白板仍可瀏覽。
- **可選的啟動偏好不能阻止掛載。** 設定與啟動共用 `getLaunchPreference()`，讀取失敗僅本次回到今日；
  初始化不重寫原選擇，使用者明確更改時才走 registry 的一般保存。此回退不適用於正文、queue 或授權資料。

證據與剩餘範圍見 [重播拒絕與畫面補驗](../archive/replay-rejection-ui-fixes-2026-09-15.md)。
這不是跨領域相依操作、完全離線登入、同帳號多分頁或所有白板操作已驗收的聲明。

## 離線佇列不被蓋掉、卡住的請求不堵住全部（2026-10-24 審查 sync #1–#4、#9、#12、#23，data #13、#14）

- **同一 origin 的各分頁與已安裝的 PWA 共用同一把快照鍵，所以快照存檔是比較交換。** `indexedDbStorage`
  在同一交易裡讀寫快照與世代（`<key>:generation`）；這個 context 只能蓋掉它自己上次載入或存下的世代，
  否則丟 `SnapshotStaleError`。worker 收到後改用已存的快照加 journal 重載，再存一次
  （`adoptStoredSnapshot`；沒有 journal 時帶著自己的佇列列）。`journalDrop` 只在比較交換成功之後執行，
  所以只會刪除「確實已存進快照」的紀錄。匯入與清除工作區是有意的整份取代（`replace`），不比較世代。
  限制：尚未更新的舊版分頁不寫世代，這個保護對它無效；部署後舊分頁重新載入即可。
- **各分頁的待送佇列順序：** 檢查「有沒有積壓」之前先 `catchUpWithOtherTabs`——世代變了就改用已存快照，
  否則把別的 session 還在 journal 的紀錄重播進來。尚未存進快照的紀錄一定還在 journal，所以不漏。
  佇列依做出那一列的時間排（`made_at`，微秒，見下方「送出前先記下」），兩個分頁的列依做出的順序排；同一微秒的兩列順序不定。
- **bootstrap 落地與 `sync()` 互斥（`landBootstrap`）：** 落地等進行中的 sync，sync 等落地；
  `resync_required` 由 sync 自己呼叫，不再等自己。bootstrap 比 mirror 游標舊時，worker 把游標倒回它自己的
  `last_event_id`，引擎隨後呼叫 `sync()` 重播差異（delta 冪等）。比游標新的 bootstrap 仍不會把游標往前推。
  `setLastEventId`、`applySync` 的游標寫入取 MAX。
- **寫入請求每次嘗試有 25 秒期限：** 逾時視為可重試，沿用同一個冪等鍵進佇列；讀取的 15 秒不變。
- **佇列頭一筆卡住：** 可重試的失敗（5xx、408／425／429、網路錯誤、逾時）都計次數；裝置自知離線時不計。
  達 `STUCK_AFTER_ATTEMPTS`（8）時同步狀態顯示筆數、最舊等了多久與一句原因，並提供
  「移到復原區」（`moveStuckWritesToRecovery`）：頭一筆與其後對同一目標的寫入依序移到復原區，不刪除、不重送；
  其他目標的寫入留在佇列照常送出。不是權限拒絕，所以不推進 `replayRejectionRevision`。
- **快照存檔失敗：** 指數退避（4 秒起、上限 5 分鐘），首次失敗與恢復各通知主執行緒一次，
  同步狀態顯示「這台裝置的本機副本無法儲存」。佇列在 journal 裡，不受影響。
- **IndexedDB 寫入不再佔著 worker 的 RPC 佇列：** 匯出（同步、一致）仍在佇列內，寫入依序在佇列外；
  匯入與清除工作區先等前一筆寫完。
- **超過約 60 KB 的離開頁面儲存不用 keepalive**（瀏覽器上限 64 KiB，會丟 TypeError）；
  仍先同步留下復原副本。

## 佇列寫入與晚到的回答（2026-11-18，#1794）

- **確認的位置跟著帳號的本機副本。** 水位存在本機副本的 `sync_state`，提高時寫進日誌；副本依帳號分區，
  所以換帳號就是另一份水位。同帳號的其他分頁在套用回答前先讀日誌，看得到這個分頁的提高。
- **佇列送出可能先等。** 同步回合裡回答連續 3 次被拒，下一筆送出的寫入（包括佇列重送）先等一份回答被收下
  或這輪同步結束；keepalive 不等。等的期間寫入仍在佇列裡，同步狀態照舊算待同步。
- **重送被拒後讀回伺服器的筆記**（`settleNodeToServer`）也經同一個判斷：讀的位置低於水位就再問（最多 3 次）；仍不收，2 秒後的同步讀它。
  讀回的程式不在開機 JS，在頁面的模組載入時就開始載入（`serverTruthLoad.ts`），不是第一次用到才載。

規則與證明見 [decisions-core-sync.md](decisions-core-sync.md#晚到的回應不蓋掉已確認的保存事件位置與水位2026-11-16取代-1753-的-updated_at-規則1794-審查後定案)。

## 送出前先記下：每次保存先成為佇列的一列（2026-11-18）

- **原因**：線上保存直接送出、不進佇列；送出中的那筆只記在 sessionStorage 的一格（活過重新整理、活不過關分頁），
  本機副本卻在 2 秒的快照防抖後就存下新內文。頁面沒有任何事件就結束時：2 秒內，字不見；2～25 秒（請求卡住），
  重開後編輯器顯示得像已存，其實沒有任何東西會送它，之後伺服器的版本把它換掉（bootstrap 的投影只保護佇列裡有列的筆記）。
- **比較過的兩條路**：(A) 先寫進佇列再送；(B) 把那一格搬到關分頁也活得下來的地方（localStorage），用 Web Locks 判斷做它的那一頁是不是還活著。
  選 A：只有 A 讓「待送紀錄」和本機副本在**同一個儲存**（同一個本機 worker 的同一條工作序列、同一份 IndexedDB），
  順序可以保證——紀錄先寫進磁碟，本機副本才改，所以任何一份存下來的快照裡有新內文時，紀錄一定已經在。
  B 的兩邊在不同的儲存，寫進磁碟的時間各自決定，永遠留一個縫；而且 B 是第二套簿記（佇列之外另一格）。
- **規則與入口**：`writeQueue.recordWrite`（`writeLifecycle` 在更新本機副本之前呼叫；`submitWrite` 沒拿到時自己呼叫）。
  在頁面活著時那一列是它自己的（`lib/data/sendingHere.ts`：每筆一把以冪等鍵命名的 Web Lock；
  `syncStatus.waitingWrites` 不把它算成等待同步）。任何分頁的排空停在鎖還被拿著的列前面，鎖放掉後再排空一次。
  這是選項 B 裡「用 Web Locks 判斷那一頁還活著」的那一半，用在佇列的列上，不是第二套簿記。`inFlightWrite.ts` 與 `adoptInterruptedWrite` 刪除。
- **連帶的修正**（多分頁性質測試在 A 之後找到的）：(1) 佇列依 `made_at` 排（`localDbWorker.queuedAt`，
  `pending_writes.made_at`，日誌紀錄帶著它），否則接手另一個分頁的列時，它較舊的文字排到這一頁較新的後面；
  (2) 依冪等鍵找列（`rowOf`），因為同一個 id 在兩個副本裡可能是不同的寫入，用 id 刪會刪到別人的列；
  (3) 上一頁留在復原區的寫入在這一頁的第一筆紀錄之前排進佇列（`adoptLeftWrites`，一次一個）；
  (4) 待送文字蓋過伺服器較新版本的筆記由副本記著（`noteHeldText`，跟著快照），送出後再讀一次，不論是哪個分頁送的（見 decisions-core-sync）。
  (5) 分頁接手一份**比自己舊**的已存副本（`adoptStoredSnapshot`）時，它在路上的同步請求是從自己較新的游標問的；
  回應落在舊副本上會讓游標越過中間的變更。之後的下一個請求一律從那份副本的游標開始，重播一次無害
  （`localDbSharedStorage.test.ts`）。只有送出同步請求的那一次讀取（`getLastEventId({ startingSync: true })`）用掉這個下限；
  其他讀游標的地方（開機時「同步過沒有」、bootstrap 的前後比較、membership 檢查）看得到它但不用掉，所以誰先讀都一樣。這是既有「接手時取兩個游標中較早的」規則的另一半，也是 multiTab 的已知
  `it.fails`（重新載入可能畫出比分頁更舊的字）同一族；那一個仍開著（快照存檔失敗時丟掉的是分頁自己套用過的資料，不是游標）。
- **測試**：`src/test/saveSurvivesKill.test.ts`、`multiTab.property.test.ts`（第 5 條：打開時本機副本沒有無人負責的內文）。

