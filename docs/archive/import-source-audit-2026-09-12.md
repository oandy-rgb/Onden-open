# 匯入來源、覆蓋保護與回歸收尾 — 2026-09-12

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：DATA-01／DATA-02 的來源辨識、後續編輯保護與桌面／手機匯入流程；另收尾 GAP-07 的回歸缺口。
基線為 `719ce80` 加工作樹既有修改。本輪沒有子代理，保留先前未提交工作；本批沒有新增資料庫 migration。
前批 [圖片盤點](import-media-audit-2026-09-12.md) 的跨來源／筆記覆蓋風險，由這批繼續處理。

## 已完成的行為

| 場景 | 本批結果 |
| --- | --- |
| 不同 vault 有同名資料夾、相同筆記路徑 | 新來源使用不同 ID，各自建立資料夾與筆記；名稱不決定身分 |
| 更新已選來源中的相同路徑 | 唯一目標通過權限與上次匯入狀態核對後，才原 ID 更新 |
| Onden 內已改正文、標題、屬性或父層 | 保留現況，結果列出檔案與 `local_changes`；不先建立該檔的新標籤 |
| 筆記已刪除，或相同來源／路徑有多筆目標 | 略過，不復活、不任選、不默默另建一份 |
| 手動筆記剛好同名 | 移除標題／slug 認領，不覆蓋手動筆記 |
| 舊匯入缺少可靠比對基準 | 相同正文／標題可回 unchanged；需要更新時拒絕，不猜測建立基準 |
| 格式錯誤、路徑越界、正規化後重複路徑 | 上傳前置驗證回 400，尚未寫入圖片／筆記 |
| 單筆保存失敗 | 該筆內容、來源索引、基準、新標籤與事件一起回滾；未知錯誤交共用 HTTP 邊界 |
| 手機 CSS 載入順序不同 | 手機導覽保持橫排換行，不被共用桌面樣式蓋回直排留下空白 |

## 責任邊界與取捨

### 來源不是資料夾名稱

比較過以所選根資料夾名稱作 key，與明確選擇持久來源 ID：前者沒有新增選擇步驟，
但兩個都叫 Vault 的資料夾仍會相撞，改資料夾名稱也會失去身分。選擇後者。

設定頁先讀檔、顯示資料夾與檔案數，再讓使用者選擇「建立新的匯入來源」或更新既有來源，最後送出。
新來源 ID 由前端產生 UUID，名稱可編輯；名稱只是標籤，即使同名也不合併。
來源來自已提交的匯入建立事件，因此重載後能透過 `GET /api/import/sources` 找回。
此清單使用 `readableScopeSql` 在 SQL 中過濾目前可讀的 live 節點，不能先取全部名稱再由 UI 過濾。
知道來源 ID 不授予任何節點權限；逐筆寫入仍核對目前 read／write_node 與 scope。

來源、筆記路徑與上次匯入狀態由 `services/importIdentity.ts` 擁有：

- 建立事件的 `import_source_id`／`import_source_name` 確認來源歸屬；複製屬性不能偽造匯入建立事實。
- `_import_path`／`_import_folder_path`／`_import_source_id` 為既有屬性系統中的內部索引。
- `_import_baseline` 是上次成功匯入後狀態的 SHA-256，與節點及事件同一交易保存。
- 沿用舊資料的 `legacy` 是明確的相容選擇，只查沒有命名來源的舊建立紀錄；不自動認領到新來源。

沿用節點、屬性與事件儲存，沒有新增來源資料表，也沒有建立新的權限或事件平台。

### 更新是領域操作

另一組草圖為路由繼續查目標、把「可以更新嗎」交給 helper，或讓完整單筆匯入由領域擁有。
選擇 `importMarkdownNote({ actor, workspaceId, source, file, parentId, reuse })`，
路由只編排檔案、圖片重寫與計數，不需要組裝目標查找、逆向 patch、基準、標籤、事件、backup／embed。

操作在既有 `withEventTransaction` 中查找與核對；有變更時用 `mutate` 保存，保留原事件種類和歸屬。
結果分為 imported／updated／unchanged／refused；refused 的原因是 local_changes、history_incomplete、
ambiguous 或 unavailable，不回傳受限目標的 ID、正文或名稱。

比對基準包含標題、正文、parent_id、node_type、標籤集合及非 `_import_` 屬性的值、型別、繼承設定、來源。
排除 row ID、updated_at 及匯入索引本身。同狀態的時間戳更新不製造衝突，正文完全相同的重匯不推進基準，
因此不會把一次「無變更」當作使用者批准以後覆蓋本機修改。
這是完整狀態保護，沒有三方合併或自動挑選衝突欄位；安全的來源更新仍保留普通屬性來源優先序。

YAML 同步也不再寫入 `_` 開頭的保留屬性，防止 frontmatter 偽造來源或基準；原 Markdown 原文仍保留。
標籤名稱解析移到覆蓋判斷之後，`tagHierarchy` 的 segment lookup 使用 `q` 加入呼叫者交易，
能看見同批先建立的共同祖先。空標籤路徑可忽略，未知儲存失敗不能吞成成功。

### API 相容性

```json
{
  "source": { "id": "<UUID 或明確的 legacy>", "name": "資工課程" },
  "upsert": true,
  "files": [{ "path": "課程/筆記.md", "content": "正文" }]
}
```

這是一項有意的收緊：`upsert:true` 現在必須給 source；舊呼叫者若只傳 files／upsert，得到 400，
不能繼續按整個工作區的相對路徑或標題猜測目標。不指定來源且為新建模式仍會建立新來源並回傳其 ID。
回應增加 source 與 conflicts。舊整合案例已改成明確傳入 legacy，保留原本的相同來源路徑測試。
舊節點若缺少基準，不回填猜測值；可先保留原筆記，另以新來源匯入獨立副本。

來源 ID 不等於請求冪等鍵。同一個表單在回應不明時保留已選 ID，但沒有承諾整批原子性或重載後自動重送。
已提交的其他檔案、資料夾及圖片可能存在；CSV／Notion 集合仍照原本規則新建。

## 實際驗證

### 自動測試與資料庫

隔離容器 `onden-browser-test-pg-20260908`，連線埠 15432。
先用 `onden_media_final_test` 重現，再從目前 schema 建立 `onden_source_final_test` 作最終完整回歸。
瀏覽器使用另一個 `onden_import_audit_test`，沒有清除或改寫日常資料庫。

- 修正前 5 個新增案例皆失敗，其中同路徑跨來源及手動同名筆記已直接重現覆蓋；其他案例當時缺少新索引，不能全算獨立行為重現。
- `importSafety.integration.test.ts` 最終 10 項通過：來源、後續編輯、來源清單權限、刪除、歧義、並行、DB 回滾、保留屬性與輸入驗證。
- CHECK constraint 故障使 `_import_baseline` 寫入失敗；確認新筆記、新標籤、索引和事件皆未留下，移除故障後同資料成功重試。
- 既有資料夾、圖片、frontmatter、標籤、路徑身分與 read guard 第一輪合併回歸 8 檔／104 項通過，之後補上另外 5 項安全案例。
- 前端設定專項最終 10 項通過，含提交前檢查、不明回應後沿用 ID、來源選擇、衝突顯示、取消及輸入保留。
- 前端完整回歸：179 檔／1,258 項通過。後端最終完整回歸：203 檔／1,657 項通過，0 失敗、0 跳過。
- 兩端 `npx tsc --noEmit`、`npm run lint` 與前端 `npm run build` 均通過。build 仍提示部分 chunk 大於 500 kB 及 docs collection 為空；本批未處理效能與內容集合設定。
- 沒有新增對外部署或日常 DB migration。

### 回歸缺口的收尾

初次完整後端執行得到 1,634 通過、5 失敗。以下逐項核對，沒有提高整套 timeout 或略過案例：

| 原失敗 | 查明與處理 |
| --- | --- |
| README 缺檔 | 新增真正的 repository 入口 README，連結套件說明、功能地圖、驗證與既有 MIT 授權 |
| logger 預期文字卻收到 JSON | 該案例測 LOG_LEVEL 卻依賴主機 LOG_FORMAT；指定 human 輸出，保留另外的格式與環境讀取案例，沒有改正式 logger |
| modelInvariants 找不到可讀正控制 | 無條件查詢只取前 50 筆，累積測試資料可把正控制排到下一頁；查詢限定本次 title stamp，同時保留允許與拒絕對照 |
| compositionLaws 兩個 5 秒逾時 | 單例包含十組 round-trip，其中一例光固定等待就 4 秒；改成每個變體獨立案例，保留全部斷言及原 timeout |

新測試庫原版兩個相關 suite 的 19 項均通過，沒有資料庫 lock 等待殘留。
修正測試前置條件後，在原本失敗的累積測試庫中，四個相關 suite 共 52 項通過。
最後再跑完整後端，1,657 項全數通過。拆開兩組十個變體使測試數增加 18；那部分不是新增功能覆蓋。

紀錄：`/tmp/onden-import-safety-red.log`、`/tmp/onden-import-safety-backend.log`、
`/tmp/onden-import-safety-extended.log`、`/tmp/onden-import-safety-full.log`、
`/tmp/onden-import-safety-clean-check.log`、`/tmp/onden-import-safety-regression-fixes.log`、
`/tmp/onden-import-safety-full-final.log` 與 `/tmp/onden-import-safety-frontend-full.log`。

### 瀏覽器

暫時 Astro 測試頁載入正式 SettingsModal／FolderImportWidget、全站樣式與 Tailwind；
以原生 File／DataTransfer 觸發正式 input change，正式 API 使用完整 app 及僅測試身分 wrapper。
沒有測原生資料夾選擇器或真實登入，不把這個 fixture 當成全站 E2E。

| 操作／尺寸 | 實際結果 |
| --- | --- |
| 1280×720，新來源 A | 2 篇筆記、1 個資料夾；選完檔案先停在來源確認，按開始才寫入 |
| 重載後選來源 A，原樣重匯 | 0 篇新增、2 篇內容相同、沿用 1 個資料夾；來源清單由 API 重新取得 |
| 正式 PATCH 修改 A 的筆記後，以來源 v2 重匯 | 0 新增、1 相同、1 略過；畫面顯示路徑及「已保留你在 Onden 的修改」 |
| 390×844 | 修正 CSS 覆蓋後，導覽橫排換行；開始／改選按鈕高 44px，頁面寬／scrollWidth 均 390 |
| 320×740 | 衝突清單完整顯示；頁面寬／scrollWidth 均 320，內容寬／scrollWidth 均 287 |
| 320px 同資料夾改選新來源 B | 顯示 2 篇新增、1 個新資料夾；來源名稱輸入後 Tab 可到開始匯入 |
| DB 核對 | A／B 各 3 個節點、不同父層 ID；A 保留考前整理，B 正文為 v2 |

隔離 fixture 的 A 筆記 ID：`2394623e-3c92-47a2-b13a-e9bb580863d2`；
B 筆記 ID：`05530e4c-2131-49d9-bb76-fe3bcb30b9e5`。這些只是可追查的測試資料。
暫時頁面、元件、設定檔與 wrapper 已移除；5101／18788 已停止，瀏覽器尺寸已還原，測試分頁關閉。
僅驗手機 viewport，沒有真機／觸控驗證。

## 仍未完成

- 沒有檔案改名／移動追蹤、三方合併、逐欄衝突解決或強制覆蓋 UI；遇衝突先保留原資料。
- 舊來源仍沒有可靠 vault 身分，舊未記路徑的筆記不再按標題認領；可能需要以新來源建立獨立副本。
- 全部來源節點不可讀／已刪除時不列出來源；尚無來源管理、重新命名或獨立來源生命週期。
- 基準保護涵蓋本批列出的狀態，沒有把附件快取、外部副作用、所有領域資料或編輯器未提交草稿當成已驗。
- CSV／Notion 重匯、整批故障恢復、跨重載持久化冪等與完整伺服器備份仍待盤。
- 原生 picker、大型 vault、不同瀏覽器與所有相容格式仍待驗。DATA-01／DATA-02 維持「部分」。

下一批應繼續跨重載的提交確認／重試、跨裝置撤權與其他尚未盤到的入口；不把測試全綠當成全功能驗收完成。
