> 狀態：現行
> 涵蓋：packages/backend/src/modules/index.ts, packages/frontend/src/modules/index.ts, packages/frontend/src/lib/sidebarTidy.ts, packages/backend/src/services/sync/bootstrap.ts, packages/backend/src/services/workspaceModules.ts

# 核心功能與模組：哪些關不掉、為什麼

業主規則（2026-11-01）：「每個新功能都必須是可以關掉的模組，關掉後不能在任何地方留下痕跡。」
本文列出**現在不是可關閉模組**的功能（以實際程式為準），逐項寫「為什麼是核心」或「建議改成模組」。
**表中的「建議」沒有照做**（手寫已成內建模組，見表）；要不要改成可關閉的模組由業主決定。
2026-11-01 當天的殘留修正記錄在最後一節，不是現行規則。

## 怎麼檢查「關掉不留痕跡」

- 前端：`packages/frontend/src/test/moduleOffNoTrace.test.ts`。對 `MODULES` 每個可關閉的模組，逐一檢查導覽列／更多、
  建立選單、`/` 選單、指令面板、筆記指令、資訊欄分頁與開關、標籤頁與標籤功能、首頁、日子時間線、閱讀區、
  選取工具列的區塊動作、設定頁都找不到它；打開時它宣告的每個入口都在。新增模組自動被檢查。
- 後端：`packages/backend/src/test/moduleOffNoTrace.test.ts`（不需資料庫）。每個 library 模組關掉時：路由寫入回 409
  `module_not_imported`、MCP／API 工具清單不列出它的工具且呼叫被拒、節點 hook 不觸發、檢索來源不回結果。
- 靜態：前後端模組資料夾與 `MODULES` 登記互相對照；有背景工作的模組必須列出它的關閉判斷。
  模組以外的程式只能經 `modules/index` 碰模組：既有的 `moduleBoundary.test.ts` 已涵蓋。
- 沒涵蓋（需要資料庫，見 PR 說明）：背景工作實際跳過關閉的工作區（`rssModule`、`tasksModule` 的 integration 測試）、
  bootstrap／同步不帶模組專屬資料（見下方「已知殘留」）。

## 已經是模組

可關閉：`review`、`rss`、`website`、`skills`、`semantic`、`daily`、`tasks`、`external_calendars`（外部行事曆；日記或任務任一個開著才能開）、
`ai`（預設關著，同意一次才開；`skills` 依賴它）。
永遠開著（這是明確決定，測試鎖住清單）：視圖版面 `table`／`kanban`／`calendar`／`gallery`、白板 `canvas` 與簡報 `slides`（業主 2026-11-15）。
內建、沒有開關：`capture`（收件匣）、`graph`（關係圖）、`importers`（匯入）、`handwriting`（手寫）。
後端與前端的註冊表各有一份清單（`modules/index.ts`），資料夾與註冊互相對照由測試守住。

## 不是模組的功能

| 功能 | 現況 | 為什麼是核心／建議 |
| --- | --- | --- |
| 筆記、編輯器、Markdown | 核心 | 產品本體；沒有它其他模組沒有東西可掛。 |
| 標籤、標籤頁、欄位 | 核心 | 模組靠標籤宣告能力（模組標籤、標籤功能），拿掉就沒有掛載點。 |
| 空間、分享、成員與權限 | 核心 | 權限與可讀範圍的基礎，不能由使用者關。 |
| 歷史、版本、垃圾桶、復原 | 核心 | 資料可靠性的底線（寫入事件與復原契約）。 |
| 同步、離線、本機副本、備份與匯出 | 核心 | 資料可靠性；匯出／備份不該能被關掉。 |
| 搜尋（側欄、指令面板、`((`） | 核心 | 找到自己的東西是基本需求；沒有可關的理由。 |
| 手寫（ink） | **內建模組 `handwriting`、無開關** | 筆記的「手寫」分頁、設定 › 手寫的筆選項是模組的；編輯器裡的手寫內容（`InkNodeView`）與白板墨水層仍是核心畫面。要不要改成可關閉（收起工具列、指令面板的「新增手寫筆記」與筆選項）由業主決定；[模組庫](module-library.md)目前寫「手寫不是功能（關不掉）」。 |
| PDF 內嵌與標註 | 核心 | 附件顯示的一部分（`PdfNodeView`）。**建議改成模組**：與手寫同理，是否值得取決於 PDF 標註是不是多數人會用。 |
| 白板 | 永遠開著的模組（`canvas`） | 目前只有版面切換，程式織進核心畫面（`shellFeature: whiteboard`）。維持「永遠開著」或改成可關，由業主決定；改成可關需要補上筆記上的「在白板」資訊與備份匯出的處理。 |
| 時間線（核心頁「歷史」的工作區變更） | 核心 | 是歷史的畫面，不是新功能。日子頁的時間線屬 `tasks`／`daily` 模組。 |
| 專注計時 | 在 `tasks` 模組內 | 隨任務模組一起關。不需另外處理。 |
| AI、MCP 工具與 token 管理 | **已是模組 `ai`**（2026-11-01） | 見 [AI 整個是可以關掉的模組](../decisions/ai-is-a-module.md)。 |
| 匯入（資料夾、Markdown、圖片）、收件匣（捕捉）、關係圖 | 內建模組、無開關 | 匯入與資料搬移屬資料可靠性，建議維持常開。收件匣與關係圖是「看法」，可評估改成可關（收件匣影響手機第三個分頁，要先決定預設落點）。 |
| 帳號、登入、設定、更新紀錄 | 核心 | 基礎設施。 |

## 已知殘留（測試或審查發現）

1. **側欄樹把「模組自動建立的筆記」收起，不看模組開關**：`GENERATED_SOURCE_TYPES`（RSS 文章與來源）在 RSS 關掉後仍被收起，
   而閱讀頁也不可用，使用者只能用搜尋找到。屬「關掉保留資料」與「看得見」之間的取捨，**沒有改**，等業主決定
   （選項：模組關掉時這些筆記照一般筆記顯示）。
2. **bootstrap 仍帶 `tasks` 陣列**（`services/sync/bootstrap.ts` 的 `taskRowsForBootstrap`）：它是筆記屬性的投影，關掉任務模組後前端不會顯示，但資料仍同步到裝置。
   需要資料庫才能驗證，這次沒有寫測試也沒有改；是否在模組關掉時不帶，是同步契約的決定。
3. **背景工作的關閉判斷靠各模組自己**：目前 `rss`、`semantic`、`external_calendars` 各用 `workspaceHasModule`，`tasks`（排程與推播提醒）用 SQL 的
   `modules_off`；新模組若有 `startBackground`，測試會要求在 `moduleOffNoTrace.test.ts` 登記它的判斷。
   第三份已經出現（現在是四個模組、兩種寫法）；先前的建議（把「這個工作區有開嗎」收成 `startPeriodicJob` 的選項，而不是各自判斷）尚未做，是否做由業主決定。

### 2026-11-01　當天修掉的殘留

- **MCP／API 工具清單列出已關模組的工具（已修）**：`GET /api/mcp/tools`、MCP `tools/list` 與 API 執行階段原本不看工作區的
  模組狀態，關掉的模組工具仍出現（呼叫才被拒）。現在 `AgentTool.available` 由模組閘門提供，清單依工作區過濾；
  測試先失敗再通過（後端 `moduleOffNoTrace.test.ts`）。
