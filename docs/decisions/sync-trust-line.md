# 同步的信任界線：收到的一律檢查；不被信任的電腦只當工作階段；不防「已接納的節點說謊」

> 狀態：現行（最後確認 2026-11-22）
> 涵蓋：packages/backend/src/spine/stampedImport.ts, packages/backend/src/services/stampedSnapshot.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-11-17（業主決定：「好」） |
| 實作狀態 | **部分實作**（第一層逐個入口在補，見備註；第二層的後端核心已合併；第三層是明確不做） |

## 決定

節點之間的同步分三層看，各層做法不同：

1. **第一層——收到的東西一律先檢查（要做足）。** 快照、修改包、以及來源自己報的任何清單（例如還原過的伺服器報的舊編號），進資料庫之前檢查格式、範圍、數量上限、前後一致，並且和實際送來的內容對得上。不合就整份拒收，什麼都不寫。假設的對象是**壞掉**的節點（還原錯的備份、有錯的舊版、損毀的檔案），不是惡意的；但檢查的寫法不依賴「對方是善意的」。
2. **第二層——每個參與者只能做它被允許的事（要做足）。** 不被信任的電腦**永遠不會成為節點**：它只能是臨時工作階段，走受空間限制的入口，拿不到快照與修改包。
3. **第三層——已被接納的完整節點故意說謊（明確不做）。** 不做逐筆簽章、不做金鑰管理、不做共識節點、不偵測「對不同節點說不同的話」。會互相交換修改包的節點都是同一個人自己的裝置。

裝置遺失或被偷：從接納名單移除那一台。被控制的裝置在移除之前弄亂的資料，靠備份與歷史救回。

## 為什麼

- 能讓一台完整節點說謊的人，已經完全控制那台裝置（已解鎖、已登入），或騙過本人親手接納它；他本來就能直接讀寫所有筆記。防住「說謊」幾乎沒有多擋到什麼。
- 做得到第三層的產品（Anytype 的 any-sync：每筆修改簽章、修改用內容雜湊串成圖、權限由共識節點排序、全部加密）前提是伺服器不可信且多人協作，代價是復原金鑰、多種伺服器、伺服器端不能讀內容。Onden 的搜尋、發布網站、AI 都在伺服器上讀明文，伺服器是使用者自己的。
- 即使做了簽章，一台有寫入權的裝置寫入「內容合法但惡意」的修改（例如清空筆記），任何系統都分不出是不是本人。
- 壞掉的節點比惡意的常見，而且一台壞掉會把錯誤傳給每一台：所以第一層不能省。

## 例外／之後要重看的時候

- 如果開放**別人的伺服器**作為對等節點互相同步（不是訪客、不是工作階段），這條線要重畫，那時才需要第三層。
- 2026-11-19 業主另外決定了「幾個人各有伺服器、共用幾個空間」的做法（[共用空間的主場](shared-space-home.md)，尚未實作）：別人的伺服器是**成員**，不是對等節點——它只和那個空間的主場交換，主場把它送來的每一筆都當成不可信的來檢查（第一層），並用當下的權限判斷（第二層）；仍然不做第三層。所以那個做法不需要重畫這條線；要讓成員的伺服器之間直接交換時才需要。
- **分段收修改包時「不合就整份拒收，什麼都不寫」的放寬（業主 2026-11-24 同意：「按建議」，note-91 轉達；PR #1987）。** 大的修改包分成幾段收（每段自己的交易，不讓寫入被鎖住幾十秒）。寫第一段之前，每一段先試跑一次並回滾，查得到的拒收仍然是整份不寫。只有真的寫到後面才會出現的拒收，可以留下前面**各自通過全部檢查**的段，條件是四項都成立而且各有測試：留下的狀態等於收完一個合法的較小的包；`have` 不推進，同一包再送不會越收越多；使用者被明白告知這次沒有收完與下一步；這台自己的寫入與之後別的包不被卡住的包擋住。還會留下前面的段的情形要列舉在 `spine/stampedMerge/README.md`。一次收完的小包與快照不變：仍然整份不寫。
- 可以之後做、不需要金鑰的一小塊：事件紀錄用雜湊串起來，讓損毀或被改過的歷史能被發現。現在不排。

## 審查怎麼用這份文件

- 每個新的同步入口，審查逐項問：「來源那一端可以在這個欄位放什麼？放了之後這台會記下什麼、之後又會把什麼傳給別台？」
- 來源自己報的數字（「我有到第幾號」）不得高於它實際送來的。
- 節點編號只接受產生時的形式；不得和內部保留字相同。
- 每一種拒絕都要有測試；拒絕之後資料庫沒有變。
- 安全邊界的批次（工作階段、通道、配對、憑證、決定什麼能離開這一台的程式）用較強的模型寫（業主 2026-11-17）。

## 相關檔案與狀態備註

- 第一層：`packages/backend/src/spine/stampedImport.ts`（快照與修改包的入口）。PR #1801（2026-11-17）起：節點編號只收產生時的形式（`isNodeId`；快照的來源與舊編號、修改包的 `sender` 與 `upTo`／`base` 的來源），還原過的來源報的舊編號最多 32 個、每一頁都要和開頭報的相同，舊編號的標記不得超過它報的號碼（`join_stamp_beyond_former`）；每一種拒絕在 `nodeRenewal.integration.test.ts` 有測試。PR #1853（2026-11-18）起：修改包裡的列（`kind: "row"`）一定帶著值與每個單位的文字，兩者都是物件；寄件那一台不握有的列只以它的標記送（`kind: "tombstone"`），收件檢查只對這一種形式不查值——「沒有值」是包裡明確的形式，不是從缺少的欄位推出來的（`checkBundleShape`；`bundleReceivedChecks`「a row item of … without values」三張表各一則）。錨點、段落列、錨點單位的值另有收件檢查（`dbUnits.ts` `check`），列的工作區必須是它筆記的（migration 215 `sync_rows_in_their_notes_workspace`）。PR「fix/merge-space-follows-parent」（2026-11-19）起：修改包的標頭多一個 `holds`（寄件那台在切點握有的，標記不得超過它），`upTo` 不得超過 `holds`；COMMIT 時才檢查的錯誤在收件時提前跑，不合是有代碼的拒收（`bundle_malformed`／`bundle_unique_clash`），不是資料庫的原始錯誤。傳輸提案第 1 批（2026-11-22，PR「fix/merge-core-before-transport-1」）起：**每一張帶走的表**都有收件檢查，同一個機制（`dbUnits.ts` `RowSource.check`，型別上必填）：每個值——贏家與每一個頭——是它的欄位放得下的（型別、NOT NULL、表自己只讀那個欄位的 CHECK，從資料庫目錄讀），新建的列帶來的值等於單位文字；檢查只能和誠實的節點握得住的一樣寬，所以資料庫沒擋的寫入端上限（標題、內文長度、排序鍵）不查，那會讓舊資料的每一包永遠被拒（PR #1940 第 1 輪第 2 點）；之前只有錨點那三張表，別的表的頭完全沒查（`bundleReceivedChecks`「a received value of any carried table」）。
  自己的裝置之間的交換第 2 批（2026-11-22，migration 222）起：快照的來源可以握有別台的修改，第一行與每一頁帶「來源握有的其他來源」（`brought`：每個標籤、每個來源握有到第幾號，最多 32 個來源，和舊編號同一個上限），
  每一頁要和第一行相同、節點編號只收小寫、不得含來源自己、舊編號或 genesis（含這台自己：`join_origin_is_this_node`）、舊的「每個來源一個數字」形狀不被讀成標籤（`join_bad_brought`、`join_wrong_brought`），帶來的來源的標記不得超過它那個標籤報的號碼（`join_stamp_beyond_brought`），
  來源自己的標記不得超過切點（`join_stamp_beyond_cut`）；來源那一端在讀之前先確認自己擔保得了握有的每一個標記（`snapshot_foreign_origin`、`snapshot_source_unsettled`、`snapshot_source_joining`、`snapshot_too_many_origins`）。
  `have` 與包頭的 `base`／`upTo`／`holds` 改成每個標籤一個，舊形狀以 `bundle_have_per_origin` 拒收。每一種拒絕在 `snapshotBrought.integration.test.ts` 有測試，拒絕後資料庫沒有變。
  同步 4a 批（2026-11-22）起：收下的列寫完之後、同一個交易裡，由 `spine/receivedDerivation.ts` 這個插槽（`services/receivedDerivation.ts` 填）算出衍生資料（連結、段落列的顯示欄位、永久刪除的清理、空間與 slug、型別、網站重建、成員 epoch），它不寫任何單位；插槽是空的就整包拒收（`bundle_no_derivation`），所以收包永遠不會只寫了列、沒有衍生。
- 第二層：臨時工作階段的後端核心 `packages/backend/src/services/participantSessions.ts`（PR #1800，2026-11-17 合併）。「工作階段的任何東西不離開這一台」（PR #1856）現在檢查的：
  工作階段的 `actors` 與 `space_members` 列、它們的標記與墓碑不進快照、修改包與摘要（`snapshotTables.ts` `stampMayLeaveSql`；兩節點測試 `sessionsStayOnTheirNode.integration.test.ts`）；
  判斷所靠的工作階段 `actors` 列，在它的工作區還在時，**資料庫**拒絕刪除與改 id、工作區、種類（migration 217 的觸發器；`sessionActorKept.integration.test.ts`），`removeActor` 也拒絕；
  會被帶走的「誰做的」欄位對工作階段記 null（`spine/authority.ts` `carriedActorId`；欄位清單從資料庫目錄讀、每個寫入點從程式碼找，`carriedActorColumns.integration.test.ts`）；
  工作階段寫入時自稱的裝置（`X-Onden-Device-Id`、存檔的 `body_change.device`）不記下（`recordedDeviceId`）；
  走訪（`sessionsStayOnTheirNodeWrites.integration.test.ts`）：工作階段拿自己的憑證、帶著另一台的裝置 id 把寫入掃描的每一條路由打一次；
  它沒被拒絕（401／403／404）的每一類寫入（路由的前兩段）至少一條成功，否則測試紅，只有那一類全都是掃描已知「測試裡不可能成功」（`NO_POSITIVE`，各有理由）的例外；
  然後快照（頁與摘要）與修改包裡找不到它的 actor id（標記的 `author` 除外，照標記的形狀拿掉）、`participant_sessions` 的 id、憑證、憑證雜湊與它自稱的裝置 id。
  工作階段**不得做不可復原的事**（PR #1856 第 3 輪）：永久刪除、清空垃圾桶、刪掉沒有反向操作的東西（檢視、連結、指標）、清除 AI 對話，一律 403，其他人照舊；
  機制是授權種類 `{ kind: "irreversible", of }`／`assertUndoableBy`，「有沒有反向操作」照 `restoreContract.ts` `restoreBlockedReason`；走訪另外從它成功的寫入導出「沒有一個是不可復原的刪除」。
  逐類的表在[第二批提案](../architecture/proposals/sessions-reads-own-2026-11-17.md)第 2d 節。它也不能領取邀請，改成員、空間成員、擁有者、token、另一個工作階段的路由都是 403。
  它**不讓這台伺服器對外抓任何東西**（書籤、訂閱源、文章全文：`assertMayReachOut`，在抓之前；會抓的每一條路由也先檢查自己的權限再抓，所有人都一樣；`sessionNoOutboundFetch.integration.test.ts`）。
  這不是「每一種寫入都證明過」：走訪只走一個世界、一次，每條路由一個請求；寫入的內容不在掃描清單的不會被走到。
  **還沒檢查的**：標記的 `author` 照原樣帶真的 id（是內容雜湊的一部分）；`distributedSync/bridge/*` 這條線；值是一個變數物件的查詢產生器寫入（例如 `.set(columns)`），寫入點掃描讀不到。
- 接納名單的移除畫面：還沒做。
- 相關決定：[身分只有擁有者與成員](identity-owner-member.md)、[不做點對點同步](no-p2p-intermittent-server.md)、[共用空間的主場](shared-space-home.md)。
