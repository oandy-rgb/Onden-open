# 模組依賴盤點（2026-10-05）

> 狀態：歷史紀錄（最後確認 2026-11-01）

目的：在模組化之前，找出核心反向認識選用功能的地方。本批只讀程式，不修改執行碼；
行號以盤點當下的工作樹為準，修改後須重新核對。設計提案見
[模組擴充點](../architecture/module-extension-points.md)。

## 判定標準

一個功能算「可刪除的模組」，必須滿足：刪除其目錄與註冊清單中的一行後，
前後端 `tsc --noEmit`、建置與核心測試仍通過，筆記、標籤、任務照常保存。
依此標準，目前沒有任何功能可刪除。

## 現況

- 後端 `src/modules/` 有 `review`、`rss`、`read_later`；`ModuleDefinition` 可註冊路由、agent 工具、
  派發處理器、能力標籤名稱與背景工作（`modules/types.ts`）。
- 前端 `src/modules/` 有 `review`、`rss`；README 決定「第三個模組需要同一插槽時才抽註冊表」。
- 白板與關係圖、AI 問答與收件匣、匯入匯出仍位於核心目錄，不是模組（網站發布已於 2026-10-06 成為模組）。
- 依賴方向：模組只依賴核心（`db`、`spine`、`readPolicy`、各 service），方向正確；
  問題在核心反向依賴模組或選用功能。

## 後端耦合點

| ID | 位置 | 核心知道的選用知識 |
| --- | --- | --- |
| B1（已解，見擴充點 1） | `services/outbox.ts:39`、`:265-310` | `OutboxEffectKind` 與 `performEffect` 固定列出 git、GitHub 備份、向量、發布、RSS、TagPack；`rss_fetch` 以動態 import `../modules/rss/fetch.js` 執行，刪除 RSS 目錄即型別檢查失敗 |
| B1'（已解） | `routes/inbox.ts:76` | `approvalRoleFor` 依 effect 種類字串決定核准所需角色 |
| B2（已解，見擴充點 2） | `services/tagModules.ts:11`、`routes/tags.ts:158`、`:266` | `TAG_MODULE_IDS = ["review", "read_later"]`、PATCH body 只接受這兩個鍵；新增標籤功能必須改核心 |
| B3（已解，見擴充點 3） | `routes/nodes.ts:214`、`:666`、`:991`、`:1048`、`:1062` | 筆記 CRUD 直接排入向量、備份，呼叫 `republishSite` 與 `refreshSuggestedLinks` |
| B4 | `index.ts:469`、`:527`、`:550` | bootstrap 回應內含 `site_config`、`chrome`、`canvas_memberships`、圖座標 |
| B5 | `spine/authority.ts`、`spine/mutate.ts`、`services/readPolicy.ts`、`services/currentActor.ts` → `services/agentTools/{scope,types,toolAuthority}` | agent 範圍屬於核心權限，依賴本身合理，但與選用工具同放在 `agentTools/` |

## 前端耦合點

| ID | 位置 | 問題 |
| --- | --- | --- |
| F1（已解，見擴充點 4） | `components/HomeStart.tsx`、`components/InboxReview.tsx`、`settings/registry.tsx` | 首頁、收件匣、設定直接 import RSS／複習元件與 hook |
| F2（已解，見擴充點 4） | `components/BuilderApp.tsx:80-81`、`components/SideDrawers.tsx:16,18`、`components/SchemaLens.tsx:20` | 三處各自 lazy import RSS／複習面板 |
| F3 | `components/BuilderApp.tsx`（約 2000 行） | 直接組合網站模式、白板操作、介紹網站與網站樣式 |
| F4 | `lib/api.ts:317-321` | 核心 `Bootstrap` 型別含網站與白板欄位 |
| F5（已解） | `lib/tagModules.ts:3`、`components/SchemaLens.tsx:54-55`、`:443-444` | `TagModule = "review" \| "read_later"`，標籤頁寫死兩張功能卡 |
| F6 | `lib/data/` 以外 33 個檔案、約 88 處 | 以 `api()`／`apiFetch()` 直接送 POST／PATCH／PUT／DELETE。媒體上傳、AI、token 管理等可為線上限定；其餘繞過寫入器的離線與保存契約，須逐處分類 |

F6 是以 `method: "POST|PATCH|PUT|DELETE"` 字串計數，含少數非寫入器呼叫的誤差，只作為規模指標。

## 各功能距離可刪除

| 功能 | 阻擋項 |
| --- | --- |
| 複習 | 前後端皆可刪除（2026-10-06 以型別檢查驗證） |
| 稍後讀 | 前後端皆可刪除（首頁區塊與標籤頁佇列皆在模組內） |
| RSS | 前後端皆可刪除（後端 2026-10-05、前端 2026-10-06 驗證）；`RssReaderPanel` 仍自行串接保存與關聯寫入（F6） |
| 網站發布 | 前後端皆可刪除（2026-10-06，`modules/website`）；bootstrap 仍帶 `site_config`／`chrome`（B4、F4，資料欄位，留核心） |
| 白板／關係圖 | B4、F3、F4、F6（`useCanvasActions`） |
| AI／agent／收件匣 | B5（權限部分應留核心）、F6 |

## 建議順序

根因是核心缺少讓模組自行註冊的擴充點，因此先建擴充點，再逐一搬移功能：

1. outbox 副作用註冊（B1、B1'）。
2. 標籤功能註冊（B2、F5）。
3. 筆記提交後掛鉤（B3）。
4. 前端插槽註冊（F1、F2）。

完成 1、2、4 後以 RSS 試點驗證刪除標準。F4、F6 範圍大且涉及離線保存契約，隨各模組搬移分批處理。
