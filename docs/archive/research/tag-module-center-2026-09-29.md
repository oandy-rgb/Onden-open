# 標籤功能中心第一版（2026-09-29）

> 狀態：歷史紀錄（最後確認 2026-11-01）

本批完整使用案例：管理員在標籤頁啟用稍後讀／複習，筆記的直接標籤關聯提供功能；
改名、移除、停用、重載與同步後仍有一致結果。白板、安裝第三方程式與動態插件不在本批。
以下為本次實作契約；本批不推進全功能盤點的整列狀態數。

## 設計比較

1. 工作區固定 `reviewTagId`、`readingTagId`：呼叫少，改名穩定，但每功能只有一個承載標籤，
   課程或論文標籤仍須另外套用特殊標籤；使用者要理解兩種標籤的連動。
2. 標籤自身保存 `tag_schema.behaviour.modules`：每個標籤可帶多功能，既有 schema、事件、
   TagPack 與同步能共同承載；必須定義多來源合成與舊名稱的遷移。

選擇第二種。畫面只呼叫 `setTagModules({ actor, workspaceId, tagId, modules: { review: true } })`
對應的 `PATCH /api/tags/:id/modules`，不組合 schema、權限與事件。不同功能的狀態仍由其領域擁有，
不新增萬用插件框架。一般筆記套標籤繼續使用 `tagMembershipWrites` 與既有前端 writer。

## 不變條件與相容

- `behaviour.modules.review.enabled`、`read_later.enabled` 僅明確布林 true 啟用。
  標籤名稱、純正文 `#toread`、祖先標籤不作功能依據；標籤本身仍是 node，只有 content 筆記進入這兩個功能。
- migration 083 一次轉換原有 live `review` 與 schema-less `toread`。未來同名標籤不自動取得功能。
  此遷移不補建純正文 hashtag 的關聯；未建立實際關聯的舊首頁正則命中不再計入閱讀清單。
- 設定功能要求事件鎖內的目前 principal admin 與標籤可見性；套用功能不授予管理權、讀取權或擴大人類／token scope。
  無變更也先授權。只合併本次指定的模組，保留其他 schema／automation／policy，成功事件與狀態同交易。
- 一般 schema PATCH 保留現在的 `behaviour.modules`，舊離線表單不能意外覆蓋功能設定。
  TagPack 匯入與現有完整欄位 CAS 復原仍明確保存設定。首次建立 schema 仍沿用既有不支援逆向刪除 schema 的限制。
- 啟用不重跑 automation/default/template、不重標成員，也不修改筆記正文。停用／移除保留 `_review_state`。
- 新建的功能 schema 設 `publish_collection:false` 與獨立 `module-<UUID>` schema slug，
  不因啟用功能而多出公開集合。TagPack、待審核安裝保留此發布選擇；既有集合的發布契約不變。
- 稍後讀第一版是成員閱讀清單，尚無每人已讀／未讀狀態。筆記資訊欄顯示來源標籤，
  不提供會暗中移除課程／專案標籤的功能開關。
- 複習每筆記仍只有一份共用狀態，不宣稱個人化排程。同時有多個來源標籤只顯示一次，
  retention 取最高、interval 上限取最短；新卡須同時滿足各來源標籤配額。各 scope 只統計可讀卡片。
  新狀態保存首次 introduced_at；舊的多次複習狀態無法推知首次日期，不猜測回填。
  舊的明確 subtree 複習保留不限新卡量契約，tag_id 篩選本身不繞過限額。
- 評分在同一事件交易內重驗身分、筆記類型、讀寫能力與當前模組成員；先停用／撤權的操作會使後到評分拒絕。
- 功能設定為線上操作：403 保留草稿；503／回應遺失沿原 key 明確重試，不顯示已啟用。
  dedup 確認後讀取失敗仍為已提交，重試只讀結果。這份重試狀態限該頁生命週期，未跨重載持久化。
- 同步的 tag 事件刷新標籤與直接成員，class／label 投影一致；前端 tags 投影與本機重載保留功能設定。
  實際授權與撤權仍由後端可讀集合機制決定。

## 介面

標籤頁保留既有色彩與導航：功能卡 → 成員清單／已儲存檢視 → 折疊的欄位與設定。
複習直接使用既有卡片面板，scope 切換重建 session，晚到請求不能帶回上一個標籤的卡片。
共用面板在 membership gate、事件或重新連線後隱藏尚未重驗的卡片，序列化讀取目前 queue，
只保留本 session 尚未完成且仍可用的卡片。失敗不退回舊正文；評分中先暫緩重讀，
成功按 ID 移除而不是刪掉清單第一筆。回應遺失後即使該卡已不在 queue，仍保留不含舊內容的
原評分按鈕，以原 key 確認提交。所有三個複習入口使用同一機制。
核對成功且仍是同一張卡時保留答案展開狀態；失敗、排除或換卡仍重設。
手機採單欄與可觸控控制。擷取 Q/A 時優先沿用宿主筆記已套用的複習標籤；
沒有來源而工作區有多個可用標籤時，要求先在筆記選標籤，不任意替使用者挑一個。

## 驗證紀錄

基線 `f275cad`；本輪版本為後續提交此文件的程式提交。單一 worker，真 PostgreSQL
`127.0.0.1:55433/onden_test`；瀏覽器另用獨立 compose project 與 `localhost:5099`。
權限與故障案例不對正式 VPS 執行。

可重現流程：

1. 管理員建立沒有 schema 的普通標籤，將一筆 content 筆記直接套用此標籤。
   從標籤頁啟用兩項功能、改名、重載；標籤頁與閱讀／複習清單仍辨識同一個 ID。
2. 以 editor、delegated admin token、已降權的舊 actor 與空 human scope 嘗試配置，
   包含無變更請求；後端拒絕且不寫入 schema／成功事件。非法開關與 ID 回 400。
3. 同一筆記套兩個複習標籤，驗證只出現一次、組合排程、零配額與隱藏標籤。
   停用最後一個來源後評分回 409；停用先取得事件鎖時，晚到的評分同樣拒絕。
   標籤 node 不當作複習卡。既有進度、正文與標籤關聯保持。
4. 以 human／token tag scope 接收同步：標籤目錄可用，但不偽造 scope 外的 tag node；
   撤權後 membership 送出空目錄。本機保存與重載保留明確空目錄，不從舊 node 重建。
5. 畫面注入 403、提交前 503、提交後丟失回應；草稿保留、明確重試，同一不確定請求
   沿用原冪等鍵，成功事件只增加一次。設定被其他分頁變更時只送出本次修改的開關。
6. 新建功能 schema 與 migration／TagPack 直接或待審核安裝皆保持 `publish_collection:false`；
   既有集合仍按原發布契約處理。已有的 automation/default/template 不因配置而重跑。
7. 開啟複習答案後從另一請求停用來源，持有面板必須移除正文且不能評分；一般同步核對
   仍允許同一卡片時則保留已展開狀態，不打斷評分。核對失敗後重試需要重新展開答案。

來源與資料邊界回歸位於 `tagModules.integration.test.ts`、`reviewTagModules.integration.test.ts`、
`tagpackModules.integration.test.ts`，畫面與保存位於 `TagModuleCenter.test.tsx`、
`tagModuleWriter.test.ts`、`NoteModuleSources.test.tsx`，完整瀏覽器流程位於
`e2e/fullstack/tagModuleCenter.spec.ts` 與 `readLater.spec.ts`。

首次完整後端掃描 1,884 項中 10 項失敗：兩個新服務缺讀取 gate 登記、principal gate 數量、
舊 HTTP mock 少一次 tag 分類讀取、未持久化 actor 的 fixture、舊名稱啟用複習的 fixture、
獨立路由 seam 的非 UUID 及 membership 額外目錄投影。修正測試前置／登記，未放寬授權。
一次重跑被沙盒網路阻擋，已中止，不計為通過；改以已授權的隔離 DB 連線重跑。
前端第一次 1,620 項有一個舊 queued 回傳斷言；後續 1,629 項掃描的唯一失敗是選擇失效標籤
仍能套用的新增回歸（該輪載入修正前元件）。最終修正與定向驗證結果列於下方。
瀏覽器首輪 31 項中 27 項通過：兩個 TagPack fixture 使用不允許的空白名稱、一個成員定位
同時命中側欄，以及同步核對意外收起複習答案。前三項修正測試資料／定位，最後一項修正
持有卡片與暫時隱藏的狀態區分，並新增兩個單元回歸；沒有刪除失敗斷言。

最終結果：後端完整 221 檔／1,884 項、前端完整 208 檔／1,638 項全部通過，皆零略過。
複習持有快取先跑 7 failed／16 passed，修正後單檔 23 項全通過；再補兩項同步與展開狀態
回歸，本輪完整掃描 25 項通過。兩端 typecheck、lint、後端 build、前端正式 build 與
published build 全部通過。最後只調整 checkbox 尺寸，前端正式 build 再次通過。

瀏覽器第二輪使用全新隔離資料庫，31 項中 30 項通過；唯一失敗是閱讀清單按鈕含更新時間，
測試卻用完整相等文字定位。修改定位後，再跑稍後讀與模組中心 5 項，全部通過、零略過。
因此本批 31 個不重複瀏覽器案例均有通過證據。人工檢視發現 checkbox 被既有表單樣式撐寬，
修正後重拍 1280／390／320px，控制項與文字排列正常且沒有水平溢出；手機保留整列 44px 觸控範圍。

本輪記錄保存在 `.acceptance/tag-modules-2026-09-29/`：
`backend-final.json`、`frontend-release.json`、`browser-final/results.json`、
`browser-recheck/results.json`；最後畫面在 `browser-recheck/tag-module-center*.png`。
瀏覽器使用無頭 Chromium 單一 worker、1 CPU／1GB 限制；未宣稱其他引擎或 163 項整體驗收完成。

## VPS 部署與還原演練

程式提交 `358f3f7681970fbb510b007be9bcffde259f202b` 已推送既有遠端 main。
2026-09-29 部署完成；2026-09-30 再次唯讀核對正式服務仍使用此版本。
網址維持 `http://oandy-vps.tail9249f1.ts.net:5180/`，沿用 Tailnet 與既有登入設定。

- 發布目錄：`/srv/onden/releases/358f3f7681970fbb510b007be9bcffde259f202b`；
  `/srv/onden/current` 已指向此目錄。
- 備份：`/srv/onden/backups/tag-modules-20260929093645-358f3f768197`。
  停止後端寫入後備份 PostgreSQL 與 content volume，三份 checksum 全部通過。
  `.env`、DB dump、content archive 均為 600，備份目錄為 700，未輸出秘密。
- 在拋棄式 DB／volume 還原成功，節點／事件／成員／屬性數量及媒體檔案 checksum 一致。
  使用新映像的實際 migration runner 演練：14 個節點保持、78 個原事件保留，
  1 個舊名稱標籤補上明確模組與非公開 schema，新增 1 個遷移事件，事件總數 79。
  成員與屬性完全不變，其他節點內容／身分不變；再執行 migration 無額外事件。
- 正式 migration 083 與前後端更新完成。首頁 200、未登入 bootstrap 401、後端健康檢查 200；
  正式容器映像與預期一致，HTTP 取得的 `SchemaLens.Cbcel4lO.js` 與新映像逐位元校驗一致。
  前端模組檔 SHA-256：`aeb04a2617b41bbe1a9db312ad3faebe5d99d40e3bad211aab573d6129dffae4`。
- 正式環境僅做唯讀檢查，未建立驗收帳號、修改既有筆記或注入故障。
  這不是另一次正式登入後寫入 E2E；讀寫流程的證據來自上述隔離 full-stack 案例。
  演練用 DB／volume 與本機 `onden-modules-e2e` stack 已清除，報告與截圖保留。

完整部署證據位於備份目錄的 `SUCCESS`、`release.txt`、`checksums.log`、
`migration-rehearsal.log`、`production-after.txt`，本機另保留
`.acceptance/tag-modules-2026-09-29/deploy-verification.log` 與 `deploy-artifacts.log`。
