# 寫入改走共用 writer（2026-10-10）

> 狀態：歷史紀錄（最後確認 2026-11-01）

評估指出周邊功能重複出現同一類缺陷（重複建立、整份覆寫、離線不重送、失敗不提示），根因是元件直接呼叫 API，
沒有使用 `lib/data/` 的共用寫入流程。本批把資料編輯遷到 writer，並修正因此可一次消除的 GAP。

## 盤點

`packages/frontend/src` 中 `lib/data/` 以外約 80 處直接寫入（先前估計的 30 處只抓到單行呼叫）。分三類：

| 類別 | 處理 |
| --- | --- |
| 資料編輯（約 45 處）：建立筆記並附帶屬性／標籤／連線、檢視與 schema 設定、集合項目、白板放置、側欄移動 | 本批遷移 |
| 結構操作：拆分、合併、清單轉任務（`runStructureOperation`） | 不遷移——刻意只在線上且佇列為空時執行，改成排隊會改變契約；GAP-130 另案 |
| 線上操作：查詢、AI 問答、同步、匯出預覽、token／成員管理、收件匣審核、發布／分享、DOI、RSS 已讀／全文、評分、匯入、RSS 文章保存 | 不遷移——當下就要結果，不需要離線排隊 |

## 設計決定

### 1. 建立筆記可帶入初始標籤與屬性（後端）

比較「後端建立時一併套用（同一事件交易）」與「前端依序送多個請求再補償」後，選前者，沿用既有
`POST /:id/duplicate`「一個領域寫入」的前例。`POST /api/nodes` 新增選填 `tag_ids`（≤20）與 `attributes`（≤50）：

- 先套標籤（`applyTagToNode`，含 apply 政策、欄位預設、automation），再寫屬性，屬性依那些標籤帶來的 schema 驗證。
- 任一項被拒（403、422、保留鍵 400、標籤不存在 404）整筆回滾，不會留下沒有種類屬性的草圖或沒有標籤的集合列。
- 單一屬性寫入抽成 `services/attributeWrites.ts` 的 `setNodeAttribute`，原 `PUT /:id/attributes/:key` 改用它，回應不變。
  `AttributeWriteError` 經共用 HTTP 邊界映射；raw `event()` 白名單由 `routes/nodes.ts` 移到該服務。
- 修正既有缺陷：`fieldForKey` 用 `pool.query`（另一條連線），看不到同一交易內剛套上的標籤；改用 `q`。

### 2. 共用、綁定 store 的 writer 實例

`lib/data/domainWriters.ts` 新增 `noteWriter`、`tagWriter`、`relationWriter`、`workspaceWriter`、`viewWriter`、
`tagSchemaWriter`、`collectionWriter`。元件不再自建 writer 或組請求。`noteWriter.create` 可帶 `id`（同時是冪等鍵）、
`parent_id`、`source_type`、`tagIds`、`attributes`，樂觀更新 store 與本機鏡像。

畫面已有自己的錯誤呈現時（快速捕捉的「以下未套用」、集合快速新增的行內訊息、白板匯入的「已停止」），
用 `createDomainContext(() => {})` 的安靜 writer，同一錯誤只通知一次；`reportWriteFailure` 對同一錯誤物件本來就去重。

### 3. 三個新 writer 的契約

- **viewWriter**：`update` 是一般寫入（伺服器只合併送來的鍵，重送安全），離線／暫時失敗排隊重播；`create` 需伺服器產生 ID，
  離線明確拒絕、重試沿用 Idempotency-Key。
- **tagSchemaWriter**：保存會取代所帶的整段（整份 `fields`、整份 policy）；離線排隊、拒絕通知一次。
  **限制**：從過期副本組的 `fields` 仍會刪掉他處新增的欄位（GAP-132，需伺服器逐欄保存）。
- **collectionWriter**：`saveItem` 只送編輯器開啟後有改動的欄位與狀態（伺服器逐欄合併）；建立項目／集合需伺服器，
  重試沿用 Idempotency-Key；刪除為持久的破壞性寫入。

## 遷移的入口與修正的缺陷

| 入口 | 改為 | 缺陷 |
| --- | --- | --- |
| 側欄 PDF／圖片／影音／檔案／草圖／手寫／範本建立（`useNodeCreation`） | 一次建立帶種類屬性與標籤；移除建立後的整份 refresh | 範本的預設標籤若被拒，整篇不建立並提示（原為建好但少標籤） |
| PDF 引用卡、PDF 上傳（`OverviewEditor`） | 一次建立含 parent／`pdf_page`；來源連線走 relation writer | GAP-225 |
| 白板匯入、拖放圖片（`useCanvasActions`） | note／relation writer | GAP-176；匯入時連線遇 503 改為排隊重送，403 仍中止 |
| 問答存為筆記、從連結建立、RSS 引用卡、範例網站、伺服器合併、側欄拖曳移動 | note／relation／property／workspace writer | 從連結建立離線也可用；拖曳被拒會回滾 |
| 集合快速新增（`QuickAddRow`） | 一次建立帶集合標籤；同標題重試同 ID | GAP-125 |
| 快速捕捉的 #tag／@date | tag／property writer（安靜） | — |
| 複習卡擷取 | 卡片建立即帶複習標籤、study task 走 task writer、白板放置走 canvas writer | 放置仍是整份白板保存（GAP-178 類型，已在註解註明） |
| ViewBuilder、CollectionView | viewWriter；同一去抖視窗內變更合併送出，卸載時送出 | GAP-123；GAP-124 部分 |
| SchemaLens、NodeAttributesPanel 的 schema 保存與刪除標籤 | tagSchemaWriter、noteWriter | GAP-144 部分（403 改發通知） |
| 網站集合（`CollectionsManager`） | collectionWriter | GAP-163、GAP-164 |
| 媒體欄位（`MediaFieldEditor`） | 本機草稿，失焦／Enter 保存一次；上傳失敗回報 | GAP-133 |
| 網站設定覆寫（`useWebsiteMode`） | 保存結束即清除已送鍵的覆寫 | GAP-243 |

其他：前端 `NodeEdge` 型別補上後端已註冊的 `highlight_source`；網站預覽只傳連結類連線（`publishableEdges`）。

## 驗證

- 後端：新整合測試 `nodeCreateWithExtras`（成功、422、403、保留鍵、未知標籤皆不留筆記）；屬性相關 210 項、全套
  238／240 檔通過（`migration`、`realtime` 為既有測試 DB 環境問題）。
- 前端：243 檔／1 819 項通過，lint、build 通過。新增或改寫：`collectionWriter`、`MediaFieldEditor`、`websiteSettingsOverlay`、
  `QuickAddRow`、`quickCreateFailures`、`CollectionFieldAuthoring`（含 GAP-123）、`canvasImportValidation`、`serverMerge`、`useSidebarDrag`。
  GAP-123、GAP-243 的測試已確認在舊程式上失敗。
- e2e：乾淨小型 stack（:5299）30 個相關 spec 59 項中 57 過；`reviewExtract` 的白板放置因 `placeCanvasNode` 需要本機白板副本而失敗，
  改用 canvas writer 的 save 後複習三個 spec 全過；`tagMembershipJourney` 為只允許 5099／5100 埠的既有限制。
  大型工作區（:5199）離線捕捉、離線建立子筆記與屬性重播、離線冷啟動、離線正文、白板拖圖、範本共 10 項全過。
- 沒有真機測試。

## 剩餘

- GAP-132（schema `fields` 整份取代）、GAP-178（白板整份保存）需要伺服器端逐欄／逐卡寫入。
- GAP-124 的建立檢視、GAP-144 的 pagehide 保存未處理。
- 結構操作（拆分、合併、清單轉任務）與 GAP-130 另案。
