# 待同步筆記文字與遠端載入

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-13。延續 GAP-04，本批限定「既有筆記的標題／正文仍在 durable queue，
遠端載入不能把待送文字換回舊值」。同時修正 slim bootstrap 因任意請求文字參照 ID 就保留舊節點的判斷。
保留前幾批未提交工作，沒有開子代理；後端產品程式與權限政策未更動。

## 問題與修正

原本 full bootstrap、sync delta 與單筆 lazy hydration 都直接套用遠端正文。
即使 queue 還有新文字，只要寫入失敗而讀取正常，重載就會顯示舊正文；使用者接著編輯可能以舊內容為起點。
另一個時序是 queue 已保存、樂觀內容快取還沒寫入磁碟，離線重開只能看到舊鏡像。

現在 bootstrap、sync、membership 補資料、單筆 hydration 和本機 loadBootstrap 都使用
`pendingNoteProjection` 的文字投影：依 active queue 順序套用 title／markdown，空字串也有效。
不使用 base_markdown 當正文，不改請求／冪等鍵，不解讀其他領域的更新格式。

只有傳入的可讀節點會被投影。slim bootstrap 的舊 `pendingBlob.includes(id)` 改成
明確 POST `/api/nodes` 的建立 ID 集合；PATCH、其他操作或正文引用某 ID 不再保護已撤權的 mirror。
原請求仍留在 queue，等正式後端回應；永久拒絕後沿上一批 recovery 契約取回輸入。

本案例登錄 **GAP-19 已修**。沒有宣稱所有 pending 操作或所有授權生命週期已完成。

## 比較方案與責任

比較兩種方案：每個 GET 入口自行讀 queue、解析請求並重新套用文字；以及由既有 SQLite 接收操作
統一調和，回傳實際套用的投影。選第二種，避免 UI、bootstrap 與 worker 各自維護一套保護規則。

```ts
setData(await persistBootstrap(remoteBootstrap));

const applied = await applySync(remoteDelta);
setData(previous => applySyncDelta(previous, applied));

const full = await persistRemoteNode(await api(`/api/nodes/${id}`));
```

- `pendingNoteProjection.ts` 只擁有 node PATCH 文字與明確 node create ID 的解讀。
  請求格式錯誤不猜值、不移除，仍交給既有後端錯誤分類。
- `localDbWorker` 在既有序列中讀 active queue、調和並寫快取；`persistBootstrap`／`applySync`
  現在回傳調和後資料，新增 `persistRemoteNode` 用於遠端單筆讀取。
  本機樂觀寫入繼續用 `upsertNode`，避免舊 pending 覆蓋新一次尚未入列的樂觀更新。
- `useAppData` 的 refresh、full hydration、slim 初始載入、membership 套用、delta 和 lazy hydration
  都使用回傳值；不再先畫原始回應再以 fire-and-forget 保存。
- `loadBootstrap` 也把 durable queue 投影到現有本機節點，因此 queue 已保存、鏡像尚未寫完時仍能提供文字。
  它不從請求引用重建已移除的節點。
- slim 的 `body_len=0` 明確表示空正文，不能用 COALESCE 把較舊非空正文留下。
  未附正文且沒有明確零長度時，保持原有省略正文的快取契約。

這些回傳值表示快取中可用的有效投影，沒有新增「伺服器已接受」或「鏡像已持久化」的保存確認。
鏡像仍排程寫入；使用者輸入的 durable 保證來自原 queue。邊界見 [AGENTS 第十七批](../../AGENTS.md)。

## 自動測試

- 新契約的 5 項測試在舊實作失敗，包括缺少回傳投影及 pending PATCH 仍保留已移出 readable set 的節點。
  `/tmp/onden-pending-notes-red.log`；舊回傳為 void 的失敗不單獨當成資料遺失證明。
- 另以舊鏡像＋新 durable queue 重開 worker，實際讀到舊正文的回歸紅燈：
  `/tmp/onden-pending-notes-cold-red.log`。修正後該案通過。
- `rejectedWritePersistence` 新增 **8 項**（共 18 項）：真實 sql.js、正式 worker RPC、匯出 bytes 後重開；
  涵蓋 full／slim、delta 最新欄位與空正文、單筆載入、拒絕／提交後不再投影、撤權清除和離線冷啟動時序。
  IDB 保存邊界由測試控制，不冒充 OPFS 或原生資料夾實測。
- `pendingNoteProjection` **4 項**：逐欄 queue 順序、空字串、保持遠端 parent／policy metadata、
  不新增不可讀節點、格式／路徑／值型別與明確 create ID。
- `useAppDataSync` 新增 **3 項**（共 19 項）：確認 refresh、full hydration、lazy hydration 與 delta
  使用 worker 回傳的正文。原有 slim defer／threshold／LRU 測試配合新回傳契約更新 mock 並通過。
- **完整前端：182 檔／1,313 項通過，0 跳過**（41.80 秒），本批新增 15 項。
  `/tmp/onden-pending-notes-full-final.log`。前端 pretest 的通用 DB 提醒不代表本次有跳過。
- TypeScript、lint、build 通過，記錄 `/tmp/onden-pending-notes-tsc.log`、`-lint.log`、`-build.log`。
  測試 fixture 曾缺少 actor_role／home_node_id，被 TypeScript 抓到後已補齊；沒有放寬正式型別。

本批未重跑全後端自動回歸；下面的 PostgreSQL 核對是實際瀏覽器案例，不等同後端全功能驗收。

## 瀏覽器與 PostgreSQL 實測

隔離資料庫 `onden_import_audit_test`、既有測試 editor 帳號，前端 `127.0.0.1:5100`。
透過快速捕捉建立「0913 待同步正文載入實測」，先正常提交基準。
測試 wrapper 只對這一筆 PATCH 回 503；讀取、登入與其他請求走正式 app。
控制檔及記錄放在 `/tmp/onden-pending-notes-live/`，沒有更改產品 API 的回應。

1. **桌面 1440×900**：追加中文，看到 1 筆等待同步。手動重新整理及整頁重載後仍見新正文與 pending 計數。
   此時查 PG 只有原基準與 1 筆 NODE_CREATED，證明畫面文字不是提前成功提交。
2. **手機 390×844 viewport**：追加第二段，清單顯示 2 筆等待同步；明確重載後兩段都在。
   clientWidth／scrollWidth 都是 375（扣除捲軸），中文換行正常，沒有水平溢出。沒有做真機軟鍵盤驗收。
3. 解除 503，從手機按立即同步，計數歸零。日誌第一筆重試沿用同鍵，接著第二筆用自己的鍵提交。
   PG 恰好 2 筆 NODE_UPDATED，正文含兩次追加內容。
4. 再完全停止 API，追加第三段並確認 1 筆已入列，接著手機重載：**停在登入頁**，未進入筆記載入。
   此案 UI 未通過，獨立登錄 GAP-20；不能把 worker 的冷啟動測試當成產品入口已通。
5. 恢復 API 後只重載頁面，原 session 可重新進入，第三段仍在並成功重播。
   最終 PG 正文三段完整，合計 **1 筆 NODE_CREATED、3 筆 NODE_UPDATED**，沒有額外成功事件。

測試頁已關閉、viewport 已 reset、測試伺服器已停止；專用筆記與前一批復原副本保留。
過程中曾在開發頁熱更新後用舊清單狀態尋找按鈕失敗，重新觀察、收合復原面板後返回清單正常；
沒有把這次測試定位失敗當成產品修復。503 與 API 關閉訊息是故障注入的預期結果。

## 未完成邊界與下一批

- **GAP-20：API 不可達時的登入入口。** `LoginGate` 只分 isPending／session／登入表單，
  沒有區分未登入與無法讀取 session；因此已有 local mirror 和 queue 仍進不了編輯器。
  下一批先定義登入失效、服務暫時失聯與允許離線讀取的差異，並核對登出／換帳號的隔離；
  不以「SQLite 有資料就跳過登入」修補。
- pending 建立在 full bootstrap／membership 的存續仍未收尾；slim 只縮小原有建立例外，
  沒有宣稱該例外已和已提交但回應遺失、後續撤權的所有時序協調。
- 屬性、任務、標籤成員與標籤名稱的其他投影，不屬於本次普通筆記文字案例。
- 未入列草稿、兩分頁 SQLite 副本、跨裝置競態和備份置換仍待盤。
- 套用時已離開 pending 的新寫入，與更早開始但較晚抵達的 GET 之間，仍需獨立版本／順序協調。
- 本批未量測大型 queue 投影效能，也沒有改變既有 read snapshot／membership 版本保證。

完整盤點數維持 163 項：4 已盤、104 部分、43 待盤、12 需環境。GAP-04 仍部分；
GAP-19 的完成不能當成所有離線或登入功能已驗收。
