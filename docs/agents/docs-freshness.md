# 文件防過時：檢查器怎麼判斷

> 狀態：現行（最後確認 2026-11-16）
> 涵蓋：scripts/check-md-links.mjs

何時讀：寫或改任何 `.md`、檢查器擋下你、要在文件裡寫「這份文件說明哪些程式」時。
業主 2026-11-16：「文件也要有對應機制防過時」；同一天的規則：一類問題一個機制。所以只有一支檢查器（`scripts/check-md-links.mjs`，
名字是歷史，一開始只查連結），不在旁邊再開第二支。它跑在兩處：完整 `node scripts/check-md-links.mjs`（markdown 套件的 `docs.guard.test.ts`，
`scripts/guard-lane.sh` 的第一步會跑）與 PR 時的 `npm run docs:covered`（guard-lane 的最後一步）。檢查器自己的測試：
`packages/markdown/src/test/guards/docsFreshness.guard.test.ts`。

## 狀態行（檔頭）

`docs/` 底下每份 `.md`（`docs/archive`、`pr-assets`、`screenshots` 除外）檔頭要有一行：

| 寫法 | 意思 | 要求 |
| --- | --- | --- |
| `> 狀態：現行` | 照這份做就對 | 要嘛宣告 `> 涵蓋：<glob>`（見下），要嘛登記在 baseline 的 `noCoverage`（只准減少，新文件不能加）。下面「程式碼引用」會查。「最後確認 YYYY-MM-DD」可寫可不寫，不再要求：那是沒有東西在查的日期 |
| `> 狀態：提案` | 還沒做、或還沒決定 | 可再寫一行 `> 完成後：<做完後變成的現行文件路徑，或「歸檔」>`；`--report` 列出**最後一次被 commit 改動**超過 60 天的提案（沒有 git 歷史才退回檔頭、檔名日期；只報告，不失敗）。只有提案會過期，現行文件沒有日曆期限 |
| `> 狀態：已被取代` | 有新文件接手 | 同一行要有連結或 `路徑` 指向接手的文件 |
| `> 狀態：歷史紀錄` | 描述過去的某個時間點（掃描報告、量測、已實作的設計） | 不查裡面的路徑與函式；現況以程式為準 |

由資料檔產生的文件（檔頭有 `<!-- 由 npm run … 產生 -->`）不需要「最後確認」：它按定義與資料一致。

## 程式碼引用（只查狀態為現行的文件、各層 `AGENTS.md`、`packages/` 裡的 README、`docs/agents/*`）

- 行內程式碼裡長得像 repo 路徑的要存在：`packages/…`、`scripts/…`、`docs/…`、`changes/…`、`.github/…`、
  `db/migrations/…`（相對 `packages/backend`）、`src/…`（在文件所在的套件，或文件提到的 `packages/<名稱>` 裡找）。
  `scripts/` 是 repo 根目錄的；套件自己的腳本寫完整路徑（`packages/frontend/scripts/check-boot-bundle.mjs`）。
- `路徑:行號`（也接受 `:12-30`、`:16,44-45`）要有那麼多行。
- 「migration 123」（或同一行有 migration／遷移的「第 123 號」）要有 `db/migrations/123_*.sql`。
- `` `檔案.ts` `識別字` ``（兩個行內程式碼緊接，中間只有空白、括號或「的」）：識別字要出現在那個檔裡（純文字搜尋）。
  用頓號、逗號隔開的是清單，不當成「這個檔的這個名稱」。
- 不查：佔位符（`<…>`、`NNN`、`YYYY`）、程式碼區塊、建置產物（`dist`、`node_modules`、`.cache`）。
- 歷史紀錄／提案／已被取代的文件與 `docs/archive` 不查：它們描述過去或未來。
- 有日期的紀錄不查：標題以日期開頭（`### 2026-11-16　…`）的小節，到下一個同級或更高級的標題為止。它記的是那一天看到的事
  （[mistakes.md](mistakes.md) 每一筆的證據），之後檔案搬了或被取代，紀錄不改寫。連結仍然會查。
- 查不過又無法在這批修：登記在 `scripts/docs-freshness-baseline.json` 的 `codeReferences`（`{ 文件: 理由 }`），**只准減少**
  （`ratchet:check`）；清單裡的文件查得過了，檢查器要你刪掉那一項。新的過時文件請修掉或改狀態，不要登記。

## 涵蓋：改了程式，就要看文件

現行文件在狀態行後宣告 `> 涵蓋：<glob>[, <glob>…]`（`**` 跨資料夾，`{a,b}` 可用）。每個 glob 至少要對到一個檔案。
沒有對應程式的現行文件（原則、流程、決定紀錄）登記在 `scripts/docs-freshness-baseline.json` 的 `noCoverage`；
這份清單只准減少：每補一份 `> 涵蓋：` 就刪一項，**新的現行文件一律要宣告涵蓋**。
PR 改了某份文件涵蓋的檔案（測試與 `.md` 不算），卻沒有改那份文件，`npm run docs:covered` 就失敗並列出文件。
只在對應很明顯、很窄的文件上宣告；對到半個 repo 的 glob 比沒有更糟。

### 「文件不需要更新」不是自己說了算

確實不需要時，在 PR 說明或 commit 訊息寫一行 `文件不需要更新：<原因>`（原因不能空；也接受 `--skip` 與 `DOCS_SKIP=1`，但那兩種不留原因）。
放行不是免查：`docs:covered` 仍 exit 0，但**把被放行的文件、涵蓋的 glob、PR 改到的檔案與作者寫的原因印出來**，
由 note-cf 對照 diff 查證文件確實不用改。聲明不需要、事後發現文件過時了，記進 [mistakes.md](mistakes.md)，類別「文件過時」。

### 實作提案的 PR 要指名提案

PR 說明或 commit 訊息有一行 `實作提案：<路徑>` 時，`docs:covered` 檢查那份文件在這個 PR 裡的狀態：仍是「提案」而且這個 PR 沒有動它就失敗
（改狀態，或寫 `> 完成後：` 並說明還剩哪些沒做）。這一項不受「文件不需要更新」影響；沒有那一行就不查。

## 被取代清單：還在 repo、但已被取代的東西

引用檢查只抓得到已經**刪掉**的東西。還留在 repo 裡、但已被別的做法取代的，登記在 `scripts/docs-superseded.json`：
每項 `paths`（路徑或 glob）、`replacedBy`（被什麼取代）、`pr`。現行文件的程式碼引用或 `> 涵蓋：` 指到清單裡的路徑就失敗。
取代發生時登記，路徑從 repo 移除後刪掉那一項。這份清單會增加，所以不是 ratchet 基準。不要為了用上它硬塞：沒有殘留就留空。

## 公開庫的鏡像

公開庫的鏡像會拿掉一些路徑（`docs/` 的圖片、掃描報告資料夾、部署紀錄）。「拿掉什麼」只有一份資料：
`scripts/public-mirror/removed-paths.json`，`public-push.sh`、`verify.sh` 與檢查器都讀它。在鏡像樹裡，文件提到的路徑**不存在而且**符合這份清單
（或是資料夾、而 HEAD 裡它底下的檔案全部都被拿掉）不算過時；私人庫裡路徑存在時照常檢查，不在清單裡的缺檔照樣失敗。
清單裡的文件（掃描報告、部署紀錄）在 `noCoverage`／例外清單裡，在鏡像裡不存在也不算錯。
`npm run docs:covered` 只在私人庫有意義：比不出基底（結束碼 2）時，guard lane 印一行說明並視為略過。

## 數字

文件裡的計數若基準檔已經知道，優先改成「見某個基準檔」，不要抄數字。真的要寫數字時，在同一行數字後面加
`<!-- check: <基準檔>#<路徑> -->`，檢查器比對：JSON 用點號分隔的路徑（數字取值、陣列取長度、物件取鍵數），
`.mjs`／`.ts` 用常數名稱（例如 `packages/frontend/scripts/check-boot-bundle.mjs#BOOT_BUDGET_GZIP`）。
**有日期的快照（例如 dup-trend 的「2026-11-08：14 組」）永遠不加 `check:` 標記、也不改寫**：它記的是那一天的值。

## 檢查器擋下時

| 訊息 | 怎麼辦 |
| --- | --- |
| `missing path`／`missing directory` | 檔案搬了或改名：`git log --follow`、grep 找新位置，改文件；已經不存在：改寫那句話 |
| `identifier not found` | 同上，找名稱現在在哪；用 grep 確認後改文件 |
| `missing migration` | migration 沒這個編號：改成實際編號，或寫成「之後的遷移」 |
| 狀態行問題 | 讀過文件再選狀態；沒有把握時選提案或歷史紀錄，並在 PR 說明請作者確認 |
| `docs:covered` 失敗 | 讀文件、改掉說錯的；不需要就寫 `文件不需要更新：<原因>`（會被印出來，由 note-cf 查證） |
| `superseded path`／`涵蓋 指到已被取代的東西` | 文件在講已被取代的做法：改成現行的做法，或把文件改成歷史紀錄／已被取代 |
| 現行文件要宣告涵蓋 | 補 `> 涵蓋：<glob>`；對不到程式的原則類文件不能新增到 `noCoverage` |
