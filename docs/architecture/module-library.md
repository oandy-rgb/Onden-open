# 模組庫：內建能力像函式庫一樣開關

> 狀態：現行
> 涵蓋：packages/backend/src/services/workspaceModules.ts, packages/backend/src/modules/types.ts, packages/backend/src/modules/index.ts, packages/frontend/src/modules/types.ts, packages/frontend/src/modules/index.ts, packages/frontend/src/lib/libraryLayout.ts, packages/frontend/src/lib/moduleUse.ts, packages/frontend/src/lib/shellFeatures.ts, packages/backend/src/services/tagFields.ts, packages/frontend/src/lib/tagFields.ts, packages/backend/src/services/parentKind.ts

何時讀：新增或改一個內建模組、決定它在設定裡怎麼列、改「開／關」的行為、改標籤欄位繼承時。
設計過程（引入／延伸／模組標籤的各階段、被取代的畫面草圖、驗證紀錄）在 [module-library-history.md](module-library-history.md)；
那份是歷史，現況以程式與本文為準。分類（功能、內建模組、核心）見 [decisions-modules.md](../agents/decisions-modules.md)，
模組目錄的寫法見[後端模組](../../packages/backend/src/modules/README.md)與[前端模組](../../packages/frontend/src/modules/README.md)。

## 一句話

內建功能像標準函式庫：每個工作區一直都在、預設開著，擁有者可以關掉（資料保留，再開就回來）。
功能不是標籤，標籤也不坐在功能底下。

## 模型：三層圖

```
功能層   複習   看板   圖庫        ← 內建功能（模組）
          ↑ 標籤擁有的功能（功能引用表）
標籤層   #英文 ── #單字            ← 使用者自己的標籤（上層只有一個，組成標籤樹）
          ↑ 套用標籤（可以很多）
筆記層   一篇筆記                  ← 筆記（有自己的筆記樹）
```

- 同一層裡面的邊只有一條 `parent_id`，組成一棵樹；標籤與筆記不互相當上層（`packages/backend/src/services/parentKind.ts`）。
- **功能層不參與標籤樹**：模組標籤沒有上層標籤，也沒有標籤放在模組標籤底下。後端在寫入新上層的同一批地方檢查
  （建立標籤、搬標籤、合併、復原、輸入 `#a/b` 建路徑），違反時回 409 `module_tag_parent`（`parentKind.ts` 丟出，`httpError.ts` 映射）。
  migration 129 修正過舊資料。
- 標籤擁有哪些功能由功能引用表決定（`packages/backend/src/services/functionRefs.ts`，設計見
  [功能引用表](proposals/function-references-2026-11-02.md)），不是靠延伸模組標籤。
  使用者的標籤只帶**欄位**與**檢視**（2026-11-12 決定）；標籤頁沒有「＋ 加功能」，既有的功能引用仍顯示、可移除。
- 模組標籤節點（#複習、#月曆…）在 migration 196 移出使用者的標籤；目前仍宣告 `library.moduleTag` 的只有技能
  （收件匣的標籤由 `packages/backend/src/modules/capture/inboxTag.ts` 建立）。
- 功能在介面上不寫成 `#`：用 `packages/frontend/src/components/FunctionChip.tsx` 的 `FunctionChip`（圖示＋翻譯後的名稱），
  或同檔的 `TagName`（功能是 chip、自己的標籤是 `#名稱`）。

## 開與關

- **預設開**：每個內建模組在每個工作區都能用，擁有者不必先引入；只有擁有者明確關掉的才是關的，之後新增的模組也直接是開的。
  介面用「開／關」；程式與事件名稱沿用舊詞（`MODULE_IMPORTED`、`MODULE_REMOVED`、`module_not_imported`、`PATCH /api/workspace/modules`）。
- **第一次用先確認**（`library.confirmOnce`）：AI、語意搜尋、RSS、網站，這四個會花費用、連到外面或發布到公開網路。
  第一次打開時跳出一句白話確認（`packages/frontend/src/components/ModuleImportConfirm.tsx`，內容來自模組自己的 `library.manifest` 與 `library.confirm`），
  同意記在工作區，之後關掉再開不再問；同意前它是關的，背景工作也不跑。
- **一律開著、沒有開關**：檢視模組（有 `viewLayout`／前端 `view`），以及宣告 `library.alwaysOn` 的白板與簡報。
  規則只在 `isAlwaysOn`（`packages/frontend/src/modules/index.ts`）與後端 `registerLibraryModule` 的 `alwaysOn`；設定不列、不能關（後端回 400）。
- **相依**：`library.requires`（全部要開，前後端都讀；技能需要 AI，關著時伺服器把它列為關），
  前端另有 `library.requiresAny`（任一個開著就行；外部行事曆需要日記或任務），只決定設定頁開關能不能按與說明文字。
  關掉主人不動附屬自己的設定，主人再開就回到原狀。
- **權限**：開關是工作區層級的決定。`PATCH /api/workspace/modules`（`{ module, imported, tag_name? }`）走 `setModuleImported`，
  要 principal admin（工作區擁有者）；編輯者、非擁有者的管理員、擁有者的 agent token 都回 403 且不寫入。
  重複同一個動作不寫事件；同步時 `MODULE_IMPORTED`／`MODULE_REMOVED` 與 `WORKSPACE_UPDATED` 一樣帶回工作區列。
- **儲存**：`workspaces.modules_off`（擁有者關掉的 id）與 `workspaces.modules_confirmed`（同意了哪些確認一次的模組）；
  傳給前端的 `modules` 是算好的「開著的」清單，另有 `modules_to_confirm`。舊的 `workspaces.modules`（引入清單，migration 085）
  只用來讓開機的 `backfillModuleImports` 認出舊工作區：`modules_confirmed` 為 NULL 的列，把已在用的確認一次模組算已同意（migration 133），
  升級不會關掉正在用的 RSS、網站、語意搜尋。
- **關著的模組不留痕跡**（業主規則 2026-11-01，`packages/backend/src/test/moduleOffNoTrace.test.ts` 與前端同名測試守）：
  `routePrefixes` 底下的寫入回 409 `module_not_imported`（讀取照開，因為關掉保留資料）；agent 工具不提供、呼叫即拒絕；
  節點掛鉤不跑（`nodeHooksWhenOff` 只給只會移除的掛鉤；另一台送來的修改只通知宣告 `nodeHooksOnReceive` 的模組）；`retrievalSource` 回空；背景工作暫停。
  語意搜尋的例子：關著時內容變動不排 `embed`、`POST /api/nodes/:id/suggested-links` 回 409、白板不畫建議連結；已存的 embedding 保留。
- **模組的啟動工作**：`library.whenTurnedOn` 在擁有者打開的同一交易內執行，只准寫 outbox 意圖（語意搜尋開始為既有筆記建索引）。

## 用到才出現

**預設**的導覽列（沒編輯過導覽列時的桌面頂欄、手機底部列）只放核心頁與「在用」的功能；
「更多」列出所有開著、沒釘在導覽列的功能（內容是「編輯導覽列」裡「在「更多」裡」那一組，同一份 `arrangeNavigation` 的 `unpinned`）。
擁有者釘過的留在導覽列，不論有沒有在用。「在用」只在 `packages/frontend/src/lib/moduleUse.ts` 與各模組的 `library.inUse` 一處定義：

| 功能 | 在用 = |
|---|---|
| 白板 | 有白板筆記 |
| RSS | 看得到至少一個訂閱（訂閱存在伺服器資料表，migration 145，前端筆記清單看不出來，數量來自閱讀頁共用的訂閱清單） |
| 網站 | 有筆記標了發布 |
| 日記 | 有日期標題的日記筆記 |
| 其餘沒宣告 `inUse` 的 | 有標籤擁有這個功能，或有筆記直接帶著它的模組標籤（`tagUsed`） |

## 設定 › 功能的版面

這一頁只做一件事：決定哪些可選功能開著。一頁一件事；附屬的排在主人底下；關不掉的不放這裡；一件事一個入口。

- **分組由模組自己宣告**：`library.group`（`{ id, order }`）、`library.blurb`（名稱下一句話）、`library.blurbOff`（關著時換成的一句，目前只有 AI）、
  `library.ownerNote`（只有擁有者看到的第二行）。組別與順序只在 `packages/frontend/src/lib/libraryLayout.ts` 的 `LIBRARY_GROUPS`
  （搜尋、時間、閱讀與學習、AI、呈現與發布）；頁面照註冊表畫，不寫死模組 id。
  列在清單上的模組沒宣告組別或說明，`packages/frontend/src/test/moduleLibraryLayout.test.ts` 失敗；可選功能之間圖示不可重複，同一個測試擋。
- **從屬**：附屬在同組、排在主人之後、縮排；主人關著時暗掉、開關鎖住、說明換成「要先打開…」。
- **關著的留在自己的組裡**（較淡）；**點一列**進功能自己的頁；`library.settingsTab` 讓設定直接在設定的某一頁（AI → 設定 › AI）。
- **記一筆、手寫不是功能**（關不掉）：它們是設定首頁的兩列，舊的 `module:capture`／`module:handwriting` 連結由 `resolveSettingsTab`（`packages/frontend/src/lib/settingsTab.ts`）轉過去。
- **已關閉功能留下的標籤**（`packages/frontend/src/components/RemovedModuleTags.tsx`）只在那個功能自己的頁顯示，有東西才顯示。

## 殼層怎麼問「這個功能開了嗎」

入口散在殼層的功能（白板的畫面、日記的今日筆記），模組宣告 `shellFeature`（`packages/frontend/src/lib/shellFeatures.ts`），
核心問「這個功能開了嗎」（`shellFeatureOnIn`），不以模組 id 指名；`packages/frontend/src/test/moduleBoundary.test.ts` 擋住核心以 id 詢問或 import 模組檔案。
前端各處列出模組都經過 `ModuleFilter`（`useModuleFilter()`）；從舊連結打開關著的模組畫面，顯示「未開啟」與前往設定的按鈕。

### 日記

日記是模組 `daily`，預設開。`packages/frontend/src/lib/data/dayNotes.ts` 的 `openDay`／`openToday` 是唯一開始日記的地方；
模組關著時拋 `DailyNotesDisabledError`（只查不建時回 null），呼叫端先問 `dailyNotesEnabled()`／`useDailyNotesEnabled()`（`day-notes` 殼層功能）。
關著時今日筆記、導覽的「日記」、首頁的今日區塊與每日範本都隱藏，開啟時不再自動建立今天的筆記；**既有日記不刪不改**，就是一般筆記。
後端掛唯讀的 `GET /api/day/:date/lens`，模組閘門只擋寫入。「新日記放在哪裡」是帳號偏好，存在這台裝置，只在建立時用。

## 欄位繼承

標籤給筆記的欄位 = 自己的欄位 + 它繼承的標籤的欄位，任意深度。來源有：上層標籤（`parent_id`，`#書/小說` 得到 `#書` 的欄位）、
標籤的 `extends` 清單。同名以最近的為準：自己的最先，再廣度優先，同一層上層先於 `extends`。不複製：上游改了欄位，下游立刻跟著變。

- 後端唯一入口 `packages/backend/src/services/tagFields.ts` 的 `effectiveTagFields`：欄位值驗證、套用標籤時的預設值、集合、儲存檢視、
  發布網站都經過它；送給前端的標籤目錄帶 `effective_fields`（繼承來的帶 `inherited_from`）。
- 前端「這個標籤給筆記哪些欄位」一律讀 `packages/frontend/src/lib/tagFields.ts` 的 `tagFields(tag)`；自己的 `schema_fields` 只用在編輯 schema。
- **同名欄位禁止**：標籤不能宣告上層或 `extends`（任意深度）已給的欄位名稱。規則只有一份：`@onden/markdown` 的 `fieldNameClashes`／`newFieldNameClashes`
  （`packages/markdown/src/fieldClashes.ts`），後端與前端欄位編輯器都呼叫它；**只比儲存用的名稱**，顯示名稱相同不算衝突。
  後端 `assertNoNewFieldClash`／`assertFieldChangeAllowed` 比較寫入前後，只拒絕這次寫入**新產生**的衝突，回 409 `field_name_inherited`
  （附 `clashes`）；檢查在兩個 schema 寫入口（`insertTagRow`、`writeTagSchema`）與搬上層（`packages/backend/src/services/nodeTree.ts`、標籤合併）。
  已存在的衝突照「最近的為準」運作、不擋其他編輯；還原路徑不檢查。

## 給模組作者的契約

型別在 `packages/backend/src/modules/types.ts`（`ModuleDefinition`）與 `packages/frontend/src/modules/types.ts`（`FrontendModule`），欄位的用途寫在型別註解裡，這裡只列規則：

- 模組是 `modules/<id>/` 一個目錄、前後端註冊表各一行，可整個刪除；前後端 id 相同（`moduleDefinitionsAlign.test.ts` 守對齊）。
- 有 `library` 的模組才在模組庫、有開關；沒有 `library` 的是基礎設施，一直開。
- 前端 `library` 必填：`title`、`description`、`Icon`、`manifest`（`adds`、`notes`、`network`，`network: null` 表示不連網，確認框顯示它），
  列在設定裡的還要 `group` 與 `blurb`。
- 後端 `library` 選填：`inUse`、`requires`、`confirmOnce`、`alwaysOn`、`whenTurnedOn`、`moduleTag`。後端用 `routePrefixes` 宣告路由前綴才會得到「關著時擋寫入」。
- 判斷成員或功能一律問核心入口，不自己讀標籤名稱或旗標。
- 模組撰寫指南尚無檔案。

## 不做的事

- **執行期安裝第三方程式碼**（下載外掛直接執行）：會讓任何外掛讀到全部筆記，安全風險太大。
  第三方模組走開源貢獻（合併進來、隨版本發布），或自架者在自己的分支加模組。
- **使用者自組指令／流程**：維持「能力由模組提供」。
- **模組版本與相依**：不做；模組都隨 Onden 同一版本發布（`requires` 只表達同一版本內的相依）。

> 2026-11-18：模組自己的標籤（`tag_schema.module`）在模組在用時不能刪除、不能被合併掉（409 `module_tag`）；內建模組（擷取）一律在用，函式庫模組開著才算，關掉時照舊可刪。規則與「在用」的定義見 [decisions-modules.md](../agents/decisions-modules.md)。
