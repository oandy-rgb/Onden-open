# 分散式同步的設計對照論文與其他軟體（2026-11-16）

> 狀態：歷史紀錄（寫於 2026-11-16）

業主問：「搜尋論文與其他軟體，看目前做法適不適合 Onden。」兩路調查（論文、其他軟體）的結論與我的核對。調查被要求找反對意見；每一點標明是**來源寫的**還是**推論**，以及 Onden 現況。原始報告在 note-cf 的工作階段紀錄，這裡只留結論與出處。

## 結論

核心（每欄位一個標記＋每單位的「看過什麼」＋保留輸的值）是文獻裡已知的構造，也是整個設計最穩的部分：等同多值暫存器加點狀版本向量，和 Automerge 的衝突模型幾乎一樣；逐欄位用混合邏輯時鐘的後寫者勝是 Actual Budget、Evolu、TinyBase、cr-sqlite 都在用的做法；保留輸的一方是 CouchDB、Joplin、Obsidian 衝突檔的路線。沒有現成的同步引擎同時符合「兩端同一種 Postgres、純瀏覽器、對等」，所以欄位這一層繼續自己做是對的。

弱點不在核心，在它周圍。下面依嚴重度列出，並標 Onden 現況。

## 送出「修改包」之前必須處理的（給 2b 的規格）

| # | 事項 | 出處 | Onden 現況 |
| --- | --- | --- | --- |
| 1 | **還原備份、複製瀏覽器設定檔之後，節點編號要換新**；同一個（節點、序號）出現不同內容時整包拒收。否則兩台以為彼此一樣、其實資料不同 | Active Directory「USN rollback」；Kleppmann 的 BFT-CRDT 論文；delta-CRDT 論文要求計數器耐當機 | 瀏覽器副本已有自己的編號（#1706）；**伺服器從備份還原後沒有換編號**，拒收規則還沒有 |
| 2 | **收回範圍、本機丟掉資料，不能經過標記觸發器**，否則「這台不再帶這個空間」會變成一筆會傳出去的刪除 | Cimbiosys（NSDI 2009）把「移出」當成另一種通知，不是刪除 | 有「觸發器讓開」的開關（204）；收回要走它，還沒做 |
| 3 | **伺服器上「序號大於 N」不等於「在 N 之後提交」**：序號小的列可能較晚提交，切點會漏列 | Postgres outbox 的已知問題 | 標記觸發器會拿工作區的鎖（S2 的鎖序測試），可能已經排成一列；**2b 要用測試證明** |
| 4 | **每個來源的修改包要連續、照順序套用，一包一個交易**；起點超過自己看過的就拒收並改拿快照 | delta-CRDT 的因果條件 | 2b 的範圍 |
| 5 | **刪除紀錄與衝突的回收政策要寫下來**，並有「離線太久的裝置」規則（先把沒送出的修改當新的送出，再整份換掉；不合併過期的狀態）。需要明確的裝置名單 | Cassandra 的殭屍資料、AD 的殘留物件、Riak 的復活 | **沒有政策**；裝置名單在 #1714 的工作階段模型裡 |
| 6 | **衍生的修正必須是「從已複製的狀態算出來」，不能是新的有標記寫入**（搬移成環的處理、重名加「(2)」、自動合併內文、補核取方塊、migration） | Kleppmann 的搬移論文；CouchDB | 合併核心的跨列規則與內文合併都是「檢視」，符合；**背景工作與會改寫資料的 migration 在多台各跑一次會製造沒人寫過的衝突**——要靠「指定一台執行」（#1714 的值班節點）或不蓋標記 |
| 7 | **看過的寫入一定贏過被看過的，即使時鐘較小**；延後的寫入不能推進本機時鐘；延後要有上限與「請修正時鐘」的狀態 | HLC 論文 4.1；Actual 在送出與收到兩端都拒絕偏差超過 5 分鐘 | `saw` 決定覆蓋，符合；「延後」是 Onden 自己的做法，文獻與實作都是**拒絕**；寫入端蓋章時就檢查比較便宜 |
| 8 | **（父層、排序鍵）應該是一個單位**：排序鍵只在它的父層裡有意義，分開合併可能得到「這個人的父層＋那個人的鍵」 | Kleppmann 的搬移操作把父層與中繼資料當一個不可分的操作；COPS 論文說明逐鍵因果不夠 | **現在是兩個單位（`parent`、`sort`）**——要改或證明無害 |
| 9 | 刪除父層 vs 同時建立子層 | ElectricSQL 的「補償」；Kleppmann 把刪除當成搬進垃圾桶 | `rules/trash.ts` 有規則；要對照這兩個來源確認 |
| 10 | 修改包帶 schema 版本 | 《Local-first software》列為未解問題 | 快照有；修改包要帶 |

## 做「同步哪些空間」之前

Cimbiosys 證明「照完整協定做，只是不送範圍外的列」**不會收斂**。需要：移出通知；裝置自己把東西改到範圍外時，先送到持有完整資料的節點再丟；每個範圍各自的「看過到哪」（單一的來源序號切點對只帶部分資料的裝置是錯的）；只帶部分資料的裝置只和持有完整資料的節點同步，不互相同步。成環檢查、同層不重名、「看過但不存在＝已刪除」在部分副本上都無法判斷，只能在完整副本上做。

收回權限：讀取面的誠實上限就是「不再送＋請對方丟掉」（《Local-first software》、Keyhive 都這麼說）。寫入面應以**主持節點收到的時間**為準，不用對方裝置的時鐘。

## 兩份報告都指向、需要業主決定的方向問題

1. **傳輸用星狀，資料模型維持對等。** 每台裝置都是對等節點（標記、合併規則不變），但實際交換只在「一台持有完整資料的裝置」與其他裝置之間進行，不做任意兩台互傳的網狀。上表第 3、4、5 項與部分副本的問題因此大幅變小。持有完整資料的可以是伺服器，也可以是當主持的手機。
2. **陌生電腦上的臨時副本只放在記憶體。** 沒有任何筆記軟體出貨「在別人電腦的瀏覽器裡放一份可編輯、會合併回來、會到期的副本」；到期後無法保證對方清掉（1Password 的「公用電腦」清除在實務上出過錯）。放記憶體：關掉分頁就沒有了；修改邊做邊送回主持的裝置，由主持裝置蓋章。代價：主持裝置（手機）在使用期間要連得上。
3. **內文維持逐行合併＋保留衝突，不換成文字 CRDT。** 單一擁有者同時改同一段的情況少；已知損失是同一段落的兩個修改一定衝突、搬動段落會重複。便宜的下一步是在衝突的段落內做詞層級的合併。Eg-walker 需要的編輯事件圖，Onden 的每次存檔歷史加 `saw` 已經是粗略的一份，之後要換不會白做。
4. **配對只用 QR、手機掃電腦上的碼並在手機上確認。** 不做輸入短碼就不需要 PAKE（沒有經過稽核的純 JS 實作）。實際發生過的攻擊是騙人掃錯碼（Signal，2025），不是破解密碼學。
5. **信箱（對方不在線時先寄放）延後**，先把即時通道用熟。持久的信箱等於第二個同步伺服器。

## 其他值得記下的

- 排序鍵：兩列拿到同一個鍵時無法在它們之間插入。Onden 會重新編號（`respaceSiblings`），但在對等節點上重新編號是一批有標記的寫入；Evan Wallace 的做法是產生鍵時加隨機尾數，幾行程式。
- 瀏覽器不是可靠的儲存：Safari 七天沒用會清掉腳本可寫的儲存；PGlite 只有一條連線。除了 Anytype，查到的筆記軟體都留一個耐久的中心。
- Trilium（最接近的資料表型前例）到現在沒有刪除紀錄的回收。
- 樹的搬移：Kleppmann 的做法是保留完整的搬移紀錄並重放；Dropbox 舊引擎把搬移當成刪除加新增而複製出整棵樹，Google Drive 遇到成環會永久不一致。Onden 的規則是從已複製狀態算的純函式，模擬器要涵蓋「三個以上的搬移、任何到達順序」。

## 出處（直接讀過的）

- Kleppmann 等，*A highly-available move operation for replicated trees*：https://martin.kleppmann.com/papers/move-op.pdf
- Kulkarni 等，HLC：https://cse.buffalo.edu/tech-reports/2014-04.pdf
- Gentle、Kleppmann，Eg-walker：https://arxiv.org/abs/2409.14252
- Almeida 等，delta-state CRDT：https://arxiv.org/abs/1603.01529
- Kleppmann，*Making CRDTs Byzantine fault tolerant*：https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf
- Ramasubramanian 等，Cimbiosys：https://static.usenix.org/events/nsdi09/tech/full_papers/ramasubramanian/ramasubramanian_html/index.html
- Khanna 等，diff3 的形式化：https://www.cis.upenn.edu/~sanjeev/papers/fsttcs07_diff3.pdf
- Ink & Switch，*Local-first software*：https://www.inkandswitch.com/essay/local-first/ ；Keyhive：https://www.inkandswitch.com/keyhive/notebook/
- Figma 的排序鍵：https://www.figma.com/blog/realtime-editing-of-ordered-sequences/ ；Evan Wallace：https://madebyevan.com/algos/crdt-fractional-indexing/
- Actual Budget 的時鐘：https://raw.githubusercontent.com/actualbudget/actual/master/packages/crdt/src/crdt/timestamp.ts
- Trilium 的同步：https://docs.triliumnotes.org/developer-guide/concepts/sync
- Obsidian Sync 的衝突處理：https://obsidian.md/help/sync/troubleshoot
- PGlite 同步外掛（只讀）：https://pglite.dev/docs/sync
- Magic Wormhole 的伺服器協定：https://magic-wormhole.readthedocs.io/en/latest/server-protocol.html
- Signal 連結裝置：https://signal.org/blog/a-synchronized-start-for-linked-devices/

只看過搜尋摘要、沒有打開原文的（Riak、Cassandra、CouchDB、Active Directory、PowerSync、cr-sqlite、ElectricSQL 的補償）在採用前要再讀一次。沒查到的：Matrix 的撤權、Peritext、Yjs 與 Automerge 文字的比較。
