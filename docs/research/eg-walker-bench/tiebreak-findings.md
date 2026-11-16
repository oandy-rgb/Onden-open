# 同一點同時插入：誰在前（第 2 部分查證結果）

> 狀態：歷史紀錄（研究結論）（寫於 2026-11-15）。只動 `docs/research/`；沒有改任何產品程式。 引用的路徑、函式與行號是寫作當時的，現況以程式為準。

## 結論

1. **差異是轉換 trace 時的編號假象，不是演算法錯。** 測試台的轉接層把每個 agent 的序號 `seq` 照「交易出現的順序」從 0 重編，
   但 trace 檔（`*-raw.json`）本來就有真實的 `seqStart`（git-makefile 有 131 筆交易的真實序號和重編後不同，第一筆是第 54 筆：Linus Torvalds 真實 6673、重編成 6424）。
   同一個作者在兩條並行分支各改一處（git 轉成的 trace 一定會這樣），先後規則就退化成比 `seq`，重編讓大小顛倒。
   **改用檔案自己的 `seqStart` 之後，我們的原型與作者的參考實作（`eg-walker-reference`，另跑 108 秒）都逐字等於預期文字，與 diamond-types 一致。**
   所以原報告「原型與參考實作一致、與預期不同」的說法應更正：兩者本來就一致，錯的是餵進去的編號。
2. **推薦的規則（一條）**：FugueMax 的右原點，加上「來源節點 id、序號」升冪、小的在左。完整定義在下面。
   六份有預期文字的 trace 全部符合（見表）；性質測試（任意送達順序都得到同一份文字、兩段以上的多字插入不交錯）全過，並證明這些測試能抓到故意寫壞的規則。
3. **規則一旦存了歷史就不能改**，這次實測直接看到原因：把先後反過來（大的在左）重放 git-makefile，會在「刪除位置超出文件」當場失敗——
   歷史裡的位置是在「當時規則算出的文字」上量的，換規則位置就全錯。所以在存「接在哪幾筆之後」之前定下來是對的。
4. **對 Onden 的實際要求**：來源標記裡的序號必須是**來源節點自己的真實流水號**，不得在接收端依到達順序重編；同一個節點的寫入要有單一序號來源。

## 各實作用的規則

| | 同一點並行插入的先後 | 右原點 |
|---|---|---|
| 參考實作 `eg-walker-reference`（`src/vendor/.../index.ts` 的 `integrate`） | `(agent 名, seq)` 升冪：`rawVersionCmp` 先比 agent 字串（`<`、UTF-16 順序），再比 seq，小的在左 | 「Fugue 版」：下一項的左原點與自己相同才記，否則 -1；FugueMax 那行被註解掉 |
| 我們的 TS 原型（`proto/engine.ts` `integrate`） | 同上（呼叫同一個 `lvCmp`） | 同上 |
| 推薦（本文） | `(來源節點 id, 序號)` 升冪，小的在左 | FugueMax：一律記「插入當下下一個存在的項目」 |

參考實作程式裡的說明：它實作的是「YjsMod / FugueMax」（作者說兩者應相同）。diamond-types 與它屬同一脈絡；
我們**沒有讀 diamond-types 原始碼**，只有「它對得上預期文字」這個結果。

**判定**：不是原型或參考實作的 bug，也不是「另一套有效規則」——就是同一套規則吃了被重編的序號。
實測：`(agent, seq)` 升冪＋真實 seq 之下，Fugue 版與 FugueMax 版的右原點都重放得出全部 trace；大的在左則在 git-makefile 上失敗。

## 最小重現

兩筆並行修改（父版本都是空），同一個 agent `A`，第一筆先到：

| 操作 | 真實序號 | 重編後（到達順序） |
|---|---|---|
| 在 0 插入 `x` | `(A, 5)` | `(A, 0)` |
| 在 0 插入 `y` | `(A, 0)` | `(A, 1)` |
| 結果 | **`yx`**（`(A,0)` < `(A,5)`，y 在左） | `xy`（顛倒） |

測試：`src/tiebreak/tiebreak.test.ts` 第一項。第二項是兩個節點（`n1` 插 `AB`、`n2` 插 `CD`）同點插入：不論哪個先到都是 `ABCD`。

git-makefile 的第 27800 字元起，是「一個作者在兩條分支的並行插入」被顛倒；顛倒的片段長 3926 字元（`TEST_BUILTINS_OBJS += …` 整段清單與前後的空行／註解之間的先後），長度相同。

## 推薦規則的精確定義

輸入（每個插入的字元都有）：
- `origin`：來源節點 id（來源標記的節點，字串，**一律小寫正規化**，例如 UUID）。
- `seq`：來源標記的序號（該節點自己的真實流水號，整數）。
- `leftOrigin`：插入當下左邊那個項目（的 `(origin, seq)`），開頭為「無」。
- `rightOrigin`：插入當下右邊第一個**已存在**（不是尚未收到）的項目，結尾為「無」。FugueMax 一律記它（Fugue 版只在它的左原點等於自己的左原點時才記）。

放到哪裡：從 `leftOrigin` 之後開始，向右掃過所有「與這個插入並行、尚未在當下版本可見」的項目：
1. 遇到左原點比自己更左的項目：停（它不在這個間隙）。
2. 遇到左原點相同、右原點也相同的項目：比 `(origin, seq)`——自己較小就停（插在它前面），否則跳過它繼續。
3. 遇到左原點相同、右原點比自己更左（掃描中）的項目：標記「正在越過一整個子樹」，連續跳過，直到掃描結束條件。
4. 其餘情形跳過。（這就是參考實作 `integrate` 的掃描；推薦版與之相比只改右原點的記法。）

比較 `origin` 用字串的碼元順序（對小寫 UUID 等同位元組順序）；`origin` 相同再比 `seq` 數值。**排序鍵只用來源標記，不含任何本機編號**（LV、收到順序），否則不同節點會算出不同文字（測試的「看到達順序」壞規則就是這樣被抓到）。
同一節點不會有兩筆並行插入（自己的寫入是一條線）；若真的出現（例如 git 轉成的 trace、同一節點的兩個分頁共用 id），序號仍給出全序，前提是序號不重複。

**不交錯的出處**：Weidner 與 Kleppmann，〈The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing〉，IEEE TPDS 2025，arXiv:2305.00583。
論文證明 Fugue 對「同一點兩人各自往右連續輸入」不交錯（forward non-interleaving），並提出 FugueMax 滿足「最大不交錯」（maximal non-interleaving，連往回打也包含）。
本文**沒有重做證明**，也沒有逐條對照論文的定理編號；我們做的是下面的實測。

## 每條 trace 的結果（推薦規則＝`maxAsc`）

`npx tsx src/tiebreak/runTraces.ts` → `bench/out/tiebreak-traces.json`。

| trace（有預期文字者全列） | 推薦（FugueMax＋升冪） | Fugue 右父＋升冪（原型現況） | 大的在左（兩種右原點） |
|---|---|---|---|
| automerge-paper（單人） | 符合 | 符合 | 符合 |
| seph-blog1（單人） | 符合 | 符合 | 符合 |
| friendsforever（2 人，真實 seq） | 符合 | 符合 | 符合 |
| clownschool（2 人；檔案只有 agent 編號，沒有 seq） | 符合 | 符合 | 符合 |
| node_nodecc（多人，真實 seq） | 符合 | 符合 | 符合 |
| git-makefile（多人，真實 seq） | **符合** | 符合 | 重放失敗：刪除位置超出文件 |
| git-makefile（舊轉接，seq 重編） | 不符（27800 起） | 不符 | 重放失敗 |
| git-makefile，**參考實作**＋真實 seq（108 s） | 符合（`out/tiebreak-ref-realseq.json`） | | |

誠實的限制：**只有 git-makefile 能區分先後方向，沒有任何一條 trace 能區分 Fugue 版與 FugueMax 版**（兩者全部符合）。
選 FugueMax 的理由是論文的保證與「右原點」定義更單純，不是 trace 逼出來的。

## 性質測試（在測試台，不在產品）

`src/tiebreak/`：`variantEngine.ts`（讀原型引擎、只改右原點與先後兩行，產生 `gen/engine.ts` 載入；不動原型）、`sim.ts`（多副本模擬）、`props.ts`（場景與檢查）、`tiebreak.test.ts`。
`npm run test:tiebreak`（約 7 秒；`TIEBREAK_N=1000` 約 30 秒）。

- **任意送達順序收斂**：2–4 個副本隨機本機編輯（插入、刪除、連續輸入），隨機兩兩同步，每次同步把缺少的修改以**隨機的合乎因果的順序、隨機批次**送過去並各合併一次；最後全部同步後所有副本文字必須相同，
  而且把全部修改以另外三個隨機拓撲順序（本機編號 LV 不同、來源標記相同）從零重放也必須得到同一份。歷史是用同一個規則產生的（位置只在產生它的規則下有效）。
- **不交錯**：基底隨機建立（讓缺口右邊的字有各種左原點），2–3 個副本在同一個缺口各打一段專屬字元（2–6 字）：往右打、往回打、一次貼上、在自己已打的字之間隨機插入，及其組合；
  互送後每個副本的字必須各自只形成**一段連續**，而且副本之間文字一致。7 種組合 × N 個種子。
- **有檢出力**：兩個故意寫壞的規則（先後看到達順序；掃描不跳過別人的子樹）會被測試抓到（前者 281/300 個種子發散，後者 187/300）。
- 結果（N=1000，每個規則）：推薦規則與 Fugue 版都是 0 個失敗；探索時另跑過 4 種規則組合各 3000 個種子 × 7 種輸入組合，0 失敗。
  **這組測試分不出 Fugue 與 FugueMax**（同一組修改在兩者下文字相同，各 1500 個場景；另試過論文中會讓兩者右原點不同的手寫場景：往回打、左右鄰居的左原點不同，結果也相同）。
  所以「FugueMax 才有最大不交錯」目前只能靠論文，不是我們量到的。

## 還有什麼不一樣、為什麼

- 舊轉接層（`traces.ts` 的 `fromDtExport`、`refAdapter.ts` 與 `proto/engine.ts` 的 `appendTxns` 都用 `nextSeq`）仍會重編；**沒有改它們**（本批只動 `docs/research/` 且新增檔案）。
  要重跑原報告請改用 `src/tiebreak/realSeq.ts`。clownschool 的檔案本身沒有 seq（只有 agent 編號），不受影響，結果符合。
- 論文的 trace 是 git 作者當 agent，同一 agent 會有並行分支；Onden 的節點寫入是一條線，這類情形較少，但「序號必須是來源的真實流水號」仍是硬要求。
- 沒做：Safari／真機、其他 trace、diamond-types 原始碼比對、Fugue 論文的形式證明；對 `(origin)` 非小寫或非 ASCII 的比較順序沒有測（trace 的作者名是 BMP 字元，都對）。

## 指令與結果

已跑：`./scripts/fetch-data.sh`（下載成功）；`npx tsx src/tiebreak/runTraces.ts`；`npx tsx src/tiebreak/checkRefRealSeq.ts`（108 s，符合）；`npm run test:tiebreak`（14 項全過；`TIEBREAK_N=1000` 也過）。
未跑：既有 `npm test`（沒動到）、`run-all.sh`、瀏覽器版。
trace 來源（不進版本庫，`data/` 被忽略）：`scripts/fetch-data.sh`，來自 josephg/eg-walker-reference、josephg/editing-traces、josephg/diamond-types 的固定 commit。
