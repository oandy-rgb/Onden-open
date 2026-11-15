# 全功能清單驗證迴圈（2026-10-07）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `main` `03075d2`（PR #4 合併後）。工作分支 `verify/feature-audit-2026-10-07`，未提交、未推送。
環境：隔離 e2e stack（`compose.e2e.yaml`，`onden_test`，:5099），Playwright 1.60 Chromium 1280×800；
AI 為 stub、embedding 為 stub；未接觸日常資料庫，沒有真機。原始輸出在 `.acceptance/feature-loop-2026-10-07/`（gitignored）。

本輪目標是取得全貌：先跑完整 Chromium e2e，分類失敗，再替「待盤」列補第一份執行紀錄。
「部分」只表示正常流程有證據；各列「尚缺」欄的失敗、離線、手機、權限邊界仍未做，不改為「已盤」。

## 1. 完整 Chromium 回歸

| 輪次 | 範圍 | 結果 |
| --- | --- | --- |
| 全套 | 143 檔／319 項（單一 worker、共用一個 e2e 使用者） | 283 過、29 失敗、7 跳過，36.5 分 |
| 乾淨 stack 重跑 | 29 個失敗 | 12 過、17 失敗 |
| 更新 selector 後 | 16 個 spec 檔（43 項） | 36 過、7 失敗；再修 Ask 標籤與複習 fixture 後 ragAsk／personas 共 8 項全過 |
| 仍失敗 | 2 項 | multiClientSync（GAP-109）、canvasAlign（待決定）；soak 更新後通過 |
| 最終全套（更新後分支） | 151 檔（含 zz 探測）／333 項 | **312 過**、14 失敗、7 跳過，26.2 分 |
| 跨引擎 | Firefox／WebKit／mobile-chrome／mobile-safari 的 `crossbrowser.spec` | 20／20 通過（行動為 viewport 模擬，不是真機） |

最終全套的 14 個失敗＝canvasAlign、multiClientSync（GAP-109）與 12 個規模污染案例。後者原因已確認：
非 slim 的 `/api/bootstrap` 有 `BOOTSTRAP_NODE_LIMIT = 5000`（依 sort_order、created_at 排序），
`nodeSwitchScale` 建立 5,000 篇後，測試以完整 bootstrap 找自己剛建的筆記會落在上限外（`undefined.label_tag_ids`）；
側欄虛擬化也使部分列不在 DOM。前端在 2,000 篇以上一律走無上限的 slim 模式，因此一般使用不受影響。
**殘餘風險已驗（probe K）**：5,054 篇時完整 bootstrap 回 5,000 篇且不含最新筆記，slim 回 5,054 篇；
新 context（無本機快取）冷啟動並以 503 擋下 slim，最新筆記仍可在側欄搜尋找到，恢復 slim 重載後仍在，伺服器 200。
未觀察到漏列或誤刪。建議規模測試改用獨立帳號或最後執行。

全套中途 `nodeSwitchScale` 會在同一帳號建立 5,000 篇筆記；12 個在乾淨 stack 通過的案例
（offline ×2、reviewScope、tag ×4、todayChanges、todayLens、usecases ×2、mobileStudio）歸為共用狀態干擾，
不是產品缺陷。是否讓規模測試改用獨立帳號，留給測試維護決定。

### 失敗分類

| 類別 | 案例 | 原因與處置 |
| --- | --- | --- |
| UI 已移位（測試過時） | designLenses、interactions、perf | 歷史離開 lens 列（`7795c3e`），lens 名稱 Editor→Content；改測 Table／Content 與 `?lens=timeline` |
| | ragAsk ×2、personas researcher | Ask 入口移到「更多」選單「Ask notes」（`d21b9a2`）；新增 `openAskPanel` helper，3 項通過 |
| | personas student | 複習成為標籤功能後，單純名為 review 的標籤不再啟用複習；改用既有 `ensureReviewTag` fixture，通過 |
| | designSchema、fieldDefaults | 標籤頁變成模組中心，「欄位與設定」預設收合（`358f3f7`）；新增 `openTagSettings` helper，通過 |
| | personas2 knowledge worker | 稍後讀改為標籤功能；改為套用啟用 read_later 的標籤，通過 |
| | inkNote、pdfInk | 事件歷史移到 History 頁；改開 `?lens=timeline`，通過 |
| | screenshot、virtSidebar | 資訊欄按鈕改為 `aria-pressed`、搜尋 placeholder 改字；通過 |
| 測試競態 | obsidianBasics | 固定等 1.2 秒，但筆記自動保存是 1.5 秒（`draftActions.ts:59`，6 月起未變）；改為輪詢伺服器正文，通過 |
| **產品缺陷** | multiClientSync | 見 GAP-109，3／3 重現 |
| 待產品決定 | canvasAlign（4／4 失敗） | 見第 4 節：修飾鍵加選也觸發閱讀鏡頭移動，下一張卡在動畫中移位，點擊等待不到穩定 |
| | soak | 仍點已移除的 History／Editor，每次 `.click().catch()` 先等滿 15 秒，60 次超過 180 秒預算；改為在父筆記上切換 Content ⇄ Table，15 秒通過，無 JS 錯誤、DOM 有界 |
| e2e 基礎設施 | 本輪後段 stack 每次啟動失敗 | `pg_isready` 走 Unix socket，初始化期間的暫時伺服器也會通過；backend 走 TCP 被拒後退出。改為 `pg_isready -h 127.0.0.1`，後續啟動正常。正式 `compose.yaml` 同樣寫法但有既有資料，未改 |

## 2. GAP-109：成員集合核對讓編輯中的輸入失焦、按鍵遺失

- 重現（4／4）：開啟一篇筆記，於編輯器或側欄搜尋輸入時，用同帳號的另一請求建立筆記並套用標籤
  （`resolve-path` + `PUT /nodes/:id/tags/:tag`，會增加 membership epoch）。
- 預期：輸入持續進入原欄位；核對期間可以遮住可能已撤權的內容，但不能吃掉使用者正在打的字。
- 實際：`sync()` 收到成員訊號後 `setMembershipGated(true)`（`useAppData.ts:455`），
  `BuilderApp.tsx:1504` 把整個工作區設為 `inert`；焦點落到 `<body>`，之後的按鍵全部消失。
  編輯器與搜尋都只留下事件前已輸入的字（例：`starttyping-179`、`typing-1791`），核對結束後也不歸還焦點。
- 影響：P0「文字不遺失」相關。觸發者不需撤權——另一台裝置或 agent 套用任何標籤就會發生；
  已輸入並排入保存的文字沒有遺失，遺失的是事件後的按鍵，使用者不一定察覺。
- 對應：NOTE-02、PER-03、FIND-01、UX-03。
- 方向（未實作，需另批設計比較）：核對只在 epoch 真的可能撤權時遮蔽；或遮蔽期間保留並在解除後歸還焦點；
  或只遮蔽不可讀節點而非整個工作區。須保持 Step D「不可讀內容不可見」的既有保證。
- 證據：`zzLoopProbe.spec.ts` probe F（未提交的暫時探測）、`rerun2-out/multiClientSync-*`。

## 2b. GAP-110：Windows 上 Ctrl+Shift+Z 變成再 undo

- 重現（3 種變體皆重現）：輸入 `AAA`、` BBB`，Ctrl+Z 得 `AAA`；再按 Ctrl+Shift+Z 不是回到 `AAA BBB`，
  而是繼續撤銷成 `A` 或空白；等待後 autosave 把縮短的文字存到伺服器。Ctrl+Y 能正常 redo。
- 原因：`@codemirror/commands` 6.10.3 的 `historyKeymap` 只有 `mac: "Mod-Shift-z"` 與 `linux: "Ctrl-Shift-z"`；
  Windows 平台沒有綁定，按鍵去掉 Shift 後命中 `Mod-z` → undo。Playwright「Desktop Chrome」使用 Windows UA，
  因此在 Linux 容器內也重現；Linux 與 macOS 的真實使用者不受影響。
- 影響：Windows 使用者以常見的重做快捷鍵試圖找回文字，反而刪掉更多並被保存（版本歷史仍可找回）。
- 方向：在 `MarkdownEditor.tsx` 的 keymap 明確加入 `{ key: "Mod-Shift-z", run: redo }`，並加 Windows UA 回歸。

## 2c. GAP-111：多值 select 欄位無法保存

- 重現（UI）：標籤欄位 `{ type: "select", options: [ml, db, os], cardinality: "many" }`，在筆記資訊欄按「add」。
  `MultiValueEditor` 寫入 `[""]` → 422 `"topics" must be one of: ml, db, os`，出現兩則錯誤通知與「This change was rejected」復原卡；
  API 直接寫 `["ml","db"]`（全部合法）同樣 422。多值 text 欄位可保存。
- 原因：`violationFor` 的 select 分支以整個字串 `options.includes(value)` 檢查，未依 `cardinality` 解析陣列。
- 影響：TAG-04 的 select 多值變體完全不可用；拒絕進入復原面板，使用者會反覆看到拒絕卡。

## 3. 「待盤」列的第一份執行紀錄

以下 30 列由「待盤」改為「部分」，待盤歸零。證據都只涵蓋正常流程或 API 契約；尚缺欄沿用原文。

| 列 | 本輪證據 |
| --- | --- |
| NAV-03 | `navBackStack`（反向連結後返回）、`navPosition`（游標與捲動在切換與重載後保留）通過 |
| NOTE-09 | `note-templates` 4 項通過；斜線選單列出 Daily／Meeting／Reading notes／Character sheet 四種模板 |
| TAG-08 | `tagMergeUI` 在乾淨 stack 通過：選目標→預覽數字→確認→成員移動 |
| TAG-09 | `tagSafeDelete` 在乾淨 stack 通過：影響預覽→刪除→垃圾桶還原成員 |
| COL-09 | `designLenses` 子節點 Table lens 以列呈現並帶 schema 欄位 |
| RSS-04 | `rssReader` 主流程的 Skip／Skip all 與首頁 skim 行 |
| RSS-07 | API：OPML 匯入 2 筆、同檔重複 URL 合併、重匯 0 新增 2 略過、非 OPML 422、空 body 400、匯出含兩筆且不重複 |
| FIND-05 | `todayChanges` 釘選 pointer 到另一客戶端且 API 不可達時保留（乾淨 stack） |
| HIST-10 | API（admin）：dry-run 只回報不刪；retention 0 實刪垃圾桶 2 筆、live 筆記保留；已清除者 undelete 回 410；負數 400 |
| AI-07 | `approvalGate`：agent 發布被保留，拒絕不執行、批准後歸屬原 agent |
| TOKEN-01 | `tokenMint`：經 actors 抽屜鑄造 researcher token |
| TOKEN-03 | `tokenMint`：即時修改 token 的 tag scope；API：刪除 token 後 REST 與 MCP 立即 401，過期 token 401；軟撤銷後 401 且保留列與 `revoked_at` |
| TOKEN-05 | API（無 cookie 的 agent context）：同一 read-only＋單一標籤 scope token 在 REST 與 MCP protocol 得到相同可見結果；未允許工具 REST 403 `tool_not_allowed`、MCP `isError`；非法參數 REST 400、MCP -32602；被拒寫入未建立任何節點 |
| TOKEN-07 | 同上：範圍外筆記在 searchNodes 不出現、getNode 回 null 且不含正文（REST 與 MCP 一致） |
| FIND-02 | 同上：searchNodes 與 suggestLinks 只回可讀集合；以範圍外筆記為來源的 suggestLinks 回空 |
| TOKEN-08 | `approvalGate` 與 `inboxGovernance`（agent 不能批准自己的變更） |
| SITE-06 | `subtreePublish`（子樹發布、葉節點無此選項）與 `publishing` 私有不外洩 |
| SITE-08 | API：啟用→匿名 200；重複啟用沿用 token；rotate 後舊 404 新 200；停用 404；真正匿名讀寫管理端點 401 |
| SITE-09 | `siteFeeds`（feed／sitemap 跳脫）、`publishing`、`siteComponents` |
| SITE-10 | API：`/api/export-static` 回 zip，私有筆記標題與正文不在檔內 |
| NOTE-05 | Chromium：ClipboardEvent 貼上、Ctrl+Z 撤銷、Ctrl+Y 重做、CDP IME 組字「zhong→中→中文」只留下提交文字並保存；`[[` 補全選單在本探測未出現（連結靠自動補括號寫入），尚未確認；Ctrl+Shift+Z 見 GAP-110 |
| SKETCH-01 | 側欄「＋」→ Sketch 建立、Excalidraw 繪製矩形、保存 1 個元素、重載保留 |
| PDF-01 | 側欄「＋」→ PDF 選檔匯入兩頁 PDF，兩頁渲染、文字層可讀、重載保留 |
| PDF-02 | `zzDeepPdf02.spec.ts`（`tick7/pdf02j.log`）＋診斷 `zzDeepPdf02x.spec.ts`（`tick7/pdf02x.log`）。`pdf02.log`～`pdf02i.log` 為探測問題：第 3 頁文字層延遲渲染、scrollIntoView 帶動整頁、未等 membership gate（選到「Checking your workspace…」）、三擊選字後提示消失、查錯表名 edges（實為 node_edges）；`pdf02d.log` 期間後端一次 `POST /api/nodes 400 20577ms`，之後同請求 201 211 ms，未重現（觀察）。02x：拖選第 1、3 頁都出現提示；雙擊加標註但 tip=0。02：cards1 1 張 page=3 edge=1；edge 500 → 第 2 張 edge=0、toasts 空；503 → toast、ann 3、重選後第 3 張 edge=1、ann 4；lost → 第 4、5 張同為 Line 17（page=- edge=0 與 page=3 edge=1）；父層連結回 PDF scrollTop 0。登記 GAP-225。 |
| PDF-03（第二輪） | `zzDeepPdf03b.spec.ts`（`tick7/pdf03b.log`）。afterHighlight stored 1、dyCenter 0.1 px；reload 0.1 px；zoom×2 0.2 px（spanH 17.5）；crossPage text「Line 39 of page 1 … Page 2 of 20 Line 0 of page 2 …」、boundingPage 1、rectPages [1]、hlP2 0；點擊／右鍵標記 UI 皆空；Clear 前 ann 2、ink 135 字元，Clear 後 dialog none、ann 0、ink `{"version":1,"pages":{}}`、toasts 空；Ctrl+Z 後仍 0。登記 GAP-226。 |
| SKETCH-02 | `zzDeepSketch02.spec.ts`（`tick7/sketch02.log`、`tick7/sketch02-b.png`、`tick7/sketch02-phone.png`）。sceneHasLink true、sceneEmbedsSecret true（快照 SVG 內含 `SECRET-BODY-…`）；連結彈窗 1、點擊後 `node=dafd3d4a…&lens=editor`；改名後 linkTextOld true／New false；lock 200、B 讀來源 404、B 讀草圖屬性 bSceneHasSecret true、bSceneHasTitle true、草圖可開；刪除來源 200 後點連結仍到同一網址、toasts 空；手機 picker 40×46／42×46、輸入框 326×35、無溢出。登記 GAP-227。 |
| ACC-04 | `ServerSetup.test.tsx` 3 項通過（預設同源、Advanced 輸入主機並保存）。e2e web 建置已內建 API base，`shouldSkipServerSetup` 直接略過此頁，瀏覽器入口須 native 或無 base 建置才走得到 |
| TAG-05 | 瀏覽器：多值 text 新增並保存；多值 select 失敗（GAP-111）。API：relation 欄位接受任意文字（未檢查是否為節點 ID）；media 接受 `javascript:` 字串但目前沒有以 href 呈現的入口；relation 選單候選來自本機可讀集合，因此不顯示不可讀節點，但不套用 `relation_supertag` 限制（程式註解標明 v1 刻意如此） |
| AI-02 | 前端沒有任何地方呼叫 `/api/ai/transform`（API 專項；e2e 無金鑰回 503，真實改寫需環境）。AI 寫入的不覆蓋契約以既有證據代替：`governanceContracts` F2（人類後續編輯後拒絕 agent 變更回 409、保留人類文字）、`ragAsk` 答案另存新筆記 |
| AI-08 | API：researcher token 成功 search／create／getNode 與被拒 publishSite，stats 分別計 ok 3、failed 1，變更計 NODE_CREATED 1；dry-run 不建立節點。**參數驗證失敗（400）完全不進統計** |
| PDF-02 | 瀏覽器：選取文字後「→ Card」在 PDF 下建立子筆記，正文 `> 引文` 與 `— page 1`，屬性 `pdf_page=1`；PDF 本身保存 text 標註與座標。Alt 拖曳保存 `area` 標註，但不建立引用筆記也沒有影像內容——「區域捕捉為引用筆記」目前不成立 |
| SKETCH-02 | 瀏覽器：草圖工具列插入連結得到 `onden://node/<id>` 文字元素；插入卡片得到帶 `customData.ondenNodeId` 的快照影像；重載保留 2 個元素。點擊開啟來源未測 |
| PERF-01 | `scaleIntegrity`（5k 節點無遺失、slim→hydrate、搜尋、匯出）、`nodeSwitchScale` |

待盤已全部有第一份執行紀錄。

## 3b. P0 深化：NOTE-02 各保存觸發點（Chromium 1280×800）

| 觸發 | 伺服器收到 |
| --- | --- |
| 停止輸入後 debounce | 1,564ms |
| Ctrl+S（debounce 前） | 144ms |
| 「Save」按鈕 | 134ms |
| 輸入後立即切換筆記 | 199ms（舊筆記先保存） |
| 輸入後頁面隱藏（visibilitychange） | 145ms（keepalive） |
| 同時改標題與本文 | 同一 PATCH 帶 title＋markdown |
| 貼上 214,907 字元正文 | 1,628ms，內容逐字相同，重載後尾端仍在 |
| 輸入後 1.5 秒內重載 | 進入復原面板（見第 4 節） |

仍缺：手機 viewport、GAP-109 期間的輸入、503／403 下的觸發點。NOTE-02 維持「部分」。
探測時另見：開啟筆記後同一瞬間以程式 `fill()` 改標題會被初始化覆蓋；先點擊再輸入或貼上（`insertText`）則正常，
屬自動化時序，不登錄為缺陷。

## 3c. P0 深化：SYS-04 已提交但回應遺失

以 `route.fetch()` 讓請求真的到達伺服器後 `route.abort("failed")`：
- 快速捕捉 `POST /api/nodes`：客戶端自動以**同一冪等鍵**重送，通知與表單正常收尾；等待後重載，伺服器只有 1 篇。
- 編輯器 Ctrl+S `PATCH`：同鍵重送，伺服器正文只附加一次、版本 2 筆（建立＋這次修改）、無復原面板。
仍缺：跨重載前就丟失回應的情況（GAP-05 的跨重載契約），以及其他領域 writer。SYS-04 維持「部分」。

## 4. 其他觀察（非缺陷登錄）

- **重載前 1.5 秒內的輸入**：自動保存尚未送出時重載，文字進入復原面板（`onden.lostWrites`），符合 GAP-51 契約。
  但若此時另有遠端修改，重載後編輯器先顯示本機草稿、再次開啟才顯示伺服器版；兩者都可取回，畫面不一致，
  建議在 NOTE-02 下一輪確認是否為預期。
- **`POST /api/maintenance/prune` 接受 body 的 `workspace_id`**，只檢查 `actor.role === "admin"`，未核對該 admin
  屬於該工作區。目前只會建立 `slug='default'` 一個工作區，無法利用；開放多工作區前須補檢查。
- **白板加選會移動鏡頭**：`handleNodeClick`（`KnowledgeWorkspace.tsx:481`）不論是否按修飾鍵都呼叫 `onSelectNode`，
  觸發閱讀聚焦；⌘／Ctrl 加選第二張卡時視窗平移，第三張卡跑到別處。另 `multiSelectionKeyCode="Meta"`
  固定為 Meta，Windows／Linux 需按 Win／Super 鍵（GNOME 會攔截開啟活動概覽），只剩框選可用。
  兩者影響 CAN-03 多選對齊的可用性，是否視為缺陷待決定。
- **MCP `tools/list` 不依 token allowlist 過濾**：read-only token 仍看到 12 個工具，呼叫時才拒絕。
  授權正確，但 agent 會嘗試不可用工具；是否只列允許的工具屬 TOKEN-04 的產品選擇。
- **無效 bearer 會退回 cookie 身分**：中介層在 bearer 解析失敗時改用 session cookie。正式 agent 不帶 cookie，
  影響有限；但已撤銷的 token 在帶 cookie 的瀏覽器環境會以人類身分成功，而非明確 401，建議評估改為拒絕。
- **沒有標籤政策的筆記對 viewer 也可寫**：`canActor` 對無政策節點預設允許（程式註解明載，governanceContracts S2 亦記為 fail-open）。viewer 角色因此只在有政策的子樹內是唯讀；若期望 viewer 全域唯讀，屬權限契約變更，需另行決定。
- **改角色失敗的通知只顯示 `{}`**：`changeRole` 以 `e.message` 顯示，伺服器回應無 error 欄位時即為原始字串，未走共用 `writeFailureMessage`。
- **撤銷 token 後，其待審請求仍可批准並以 agent 名義執行**：審核畫面不提示請求者已被撤權。若撤權是因為 agent 失控，擱置中的發布仍會被順手批准；可考慮撤權時一併拒絕或標示其待審項。
- **RSS 已看狀態全工作區共用**：`rss_staging.seen_at` 不分使用者，任一成員略過或 skip-all 會清掉所有人的未讀。單人使用無差，多人共享工作區時需決定是否改為每人各自的已讀狀態。
- **lens 切換不進入瀏覽器歷史**：`useUrlLocation.ts` 刻意對 node／lens 變化用 replaceState。好處是返回不會被每次點擊塞滿；代價是切到 Table 後按瀏覽器返回會直接離開目前筆記（若是第一頁則離開 app）。是否改為 lens 也 push，屬產品決定。
- **PDF 檢視工具列未翻譯**：Draw／Rect／Circle／Arrow／Zoom／→ Card 等字串直接寫在 `PdfNodeView.tsx`，未經 `t()`；影響 UX-04 繁中介面。
- **`/api/ai/transform` 沒有前端入口**：只有後端路由，且無 stub 模式；是否保留屬產品決定。
- 先前一次「匿名可讀分享 token」是探測自身錯誤（匿名 context 繼承了登入 cookie），已以空 storageState 重測排除。
- **select 欄位排序依文字而非宣告順序**：saved view 以 status 排序得 doing<done<todo；group_by 卻依宣告的選項順序分欄。是否統一屬 COL-02 的產品選擇。
- **表格儲存格依值猜 value_type**：`TableLayout.inferValueType` 只分 number／text，date 與 boolean 欄存成 text、text 欄的純數字存成 number；伺服器仍依 schema 驗證值，但混型會影響排序鍵。宜改用 `field_meta` 的型別。
- **資訊欄 number 每鍵寫一次**：`SchemaRow` 的 number／date 以 onChange 保存，打 `120` 產生 3 次 PUT（各一筆事件與版本）；text 類則是 Enter／blur 才存。
- **改有值欄位的型別不提示、不轉換**：`SchemaEditor` 只在 tooltip 說明「type changes don't rewrite them」；改型別後舊值無法原值重存（422）。是否加確認或提供轉換，屬 TAG-03 的產品選擇。
- **多值欄位不去重、空格即寫入**：`["dup","dup"]` 照存，按「add」立刻寫入 `[""]`。是否去重屬產品選擇。
- **繼承值與同名標籤欄位並列**：標籤欄位列顯示 empty，同一值出現在「From parent」；繼承區也不隨父層改值即時更新。

- **成員 tick 後立即離線（TAG-02 探測，4 次中 1 次）**：資訊欄套用標籤觸發 membership gate，150ms 內離線時工作區停在「Checking your workspace… / Check again」12 秒，重連 282ms 後自動解除；其餘 3 次與專門重現 4 次皆在離線後解除。未登錄缺陷，若之後再現可併入 GAP-109 的 gate 行為。
- **建立標籤的權限分歧**：editor 以 import 或側欄「+ New tag」建立 403，卻可經 resolve-path（快速捕捉 `#tag`、模板預設標籤）建立；已併入 GAP-146。
- **探測副作用已清理**：TAG-02 的 `task` 改名探測在前幾次執行留下 2 個改名為 `todo…` 的舊 task 標籤（僅 `:5199` 私有 stack），已將原標籤改回 `task`；最終版探測依「刪新標籤→改回」順序自行清理。
- **設定頁 starter 列表不隱藏已安裝的包**：Tags 頁的 Ready-made tags 只列缺少的包，Settings → Your Data 則列出全部，按已安裝者的 Install 回 409「already exists… rename in the pack JSON」。兩處行為宜一致。
- **集合寫入失敗訊息多為原始伺服器字串**：view 建立、layout 切換遇 503 顯示 `down`，離線顯示 `Failed to fetch`，目前 view 被刪顯示 `not_found`；都未經共用 `writeFailureMessage`，也不排入同步佇列（同 GAP-149／GAP-124 的範圍）。
- **重開 saved views 不記住上次選取的 view**：一律選 pin_order 最前者；目前沒有 UI 可改 pin_order，等同第一個建立的 view 永遠是預設。
- **集合 layout 的開啟與月份不持久**：月曆重載一律回到本月；看板、月曆、圖庫都沒有「找不到這筆」提示，開啟已撤權卡片得到空白主區（GAP-158）。
- **月曆「Today」按鈕與頂部「Today」同名**：兩者 accessible name 都是 Today（一個開今日筆記、一個跳回本月），螢幕閱讀器與自動化需靠 title 區分。
- **Table 的日期儲存格是文字輸入**：沒有原生 date picker，任何字串都送到伺服器驗證（見 GAP-127）。

## 5. 部分→已盤

判定沿用清單標準：該列「尚缺」所列入口與邊界都有執行結果；發現的缺陷另登錄並連結。
真機、正式部署屬「平台／外部整合」里程碑，於各列註明，不計入瀏覽器基線（同 TASK-07 前例）。

| 列 | 證據（`zzDeep*.spec.ts`） |
| --- | --- |
| TOKEN-04 | 12 個工具各鑄單工具 token：自身可達、其餘 11 個皆 `tool_not_allowed`。scope=[tIn] 時 getNode 範圍外回 null、update／apply／remove／createNode（含未標籤）範圍外 403 `tag_not_allowed`，範圍內 update／apply／remove 200；queryView 範圍內 200 且列含筆記、範圍外 403、未知 ID 500（GAP-112）；searchNodes／suggestLinks 不洩漏。actor scope=[tIn]∩token scope=[tOut] 時兩端皆不可讀。第 61 次呼叫 429、`Retry-After: 60` |
| TOKEN-02 | 1280 與 390px 各以 UI 鑄造 read-only／organizer／researcher／publisher：存下的 allowed_tools 與模板逐項相同；明文可複製到剪貼簿、按 Done 後消失、LWP will support https URLs if the LWP::Protocol::https module
is installed. 不含明文；mint 回 503 時顯示錯誤、名稱與模板保留、不產生 token，解除後重試只建 1 筆；390px 經底部「More」進入，無橫向溢出、按鈕高 46px。觀察：Copy 沒有成功／失敗回饋；四個模板都不含 `reviewQueue`，read-only token 無法讀複習佇列 |
| NOTE-09 | 四模板（Daily／Meeting／Reading／Character）經 ⌘K「New from template」各建一篇：標題格式、骨架標題、預設標籤（daily／meeting／reading／ttrpg/character）皆正確，連續建立不含其他模板段落；斜線選單在空筆記蓋上骨架且不留下 /觸發字。失敗：`POST /api/nodes` 503 時不建立節點並提示，但面板關閉、輸入的查詢遺失（GAP-60）；`resolve-path` 503 時筆記照建並提示「1 tags or fields could not be applied」 |
| NAV-02 | 葉節點 lens 列無 gated 分頁；有子節點的父節點顯示 Content／Canvas／Table。`?lens=table|timeline|editor` 直接開啟對應窗格且重載後保持；`lens=local-graph` 轉為 editor；葉節點 `lens=table` 顯示「has no children yet」說明，未建白板的 `lens=canvas` 顯示 New canvas／Build canvas from children。資訊欄「All versions」開啟版本視窗、Escape 關閉回到編輯器。lens 切換依 `useUrlLocation.ts` 文件契約使用 replaceState（`history.length` 不變），因此瀏覽器返回會離開目前筆記；若此筆記是第一頁則離開 app——屬設計取捨，列為觀察 |
| RSS-07 | 1280 與 390px（390 經底部 More→Settings）：Your Data 的「Import subscriptions」以 filechooser 選檔，3 筆（A、B、`not a url`）回「Imported 3 feeds」；非 OPML 檔顯示「no feeds found in the OPML」；「Export」觸發下載 `onden-subscriptions.opml`，內含三筆；以下載檔回匯「Imported 0, skipped N」。批次不在匯入時驗證：`not a url` 與不可達來源首次抓取後分別記 `_rss_last_error`「Invalid URL」與連線拒絕，`/api/rss/sources` 的 `last_error` 一併回報。390px 無橫向溢出。元件文字未經 `t()` |
| TOKEN-01 | UI 以 Add Actor 建立 agent（editor），在有 `write_node: editor` 政策的筆記上：既有 organizer token 寫入 200；UI 改為 viewer 後同一 token 403、改回 editor 200；改角色遇 503 時下拉回到原值、伺服器不變，但通知只顯示原始 `{}`。token scope：`null` 可讀、`[]` 全不可讀、指定標籤可讀。第二位人類（editor、非 owner）建立 admin actor、把自己升為 admin、替自己鑄 token、列出 actors 皆 403；owner 降其為 viewer 後寫入受保護筆記 403、升回 editor 200。**GAP-113**：UI「Remove」agent 後列消失，但 API 因 `external_id <> 'system'` 遇 NULL 不成立而回 `{ok:true}` 不刪除、無事件，token 仍可使用。無政策的筆記 viewer 也可寫，屬 `canActor` 預設允許契約 |
| SITE-08 | 網站工作室 Design→Share & domain，1280 與 390px：開關啟用後顯示 `/api/share/<token>` 並可複製；「New link」後舊 token 404、新 token 200；關閉後 404。匿名回應只含已發布筆記，未發布筆記標題與正文不在內；無 Cache-Control。site access 設為 token 模式時，未帶或錯誤 access 401，`?access=`／`x-site-access` 正確值 200，owner 200，改回 public 後匿名 200。啟用遇 503 時開關停在關閉、沒有任何訊息。**GAP-114**：把分享連結交給訪客，瀏覽器顯示的是 `{"id":...,"workspace_id":...}` 原始 JSON；前端沒有任何頁面渲染 `/api/share/:token` |
| COL-09 | 父節點 Table lens：子節點 PATCH 改父到別處後該列不重載即消失，新建子節點即出現，點列開啟該子節點；無子節點時顯示「has no children yet」說明。第二位人類（editor）開同一父節點只看到可讀的兩列，`read: admin` 子節點的列與標題都不出現。390px 顯示 3 列、表寬 334px、頁面無橫向溢出 |
| FIND-04 | 目標筆記開在一個分頁，另一分頁在來源筆記編輯器輸入 `[[Target]]` 並 Ctrl+S：目標的反向連結計數 385ms 內變 1，摘要標出連結文字。點反向連結卡開啟來源，連結所在行捲入視窗（長文第 41 行）。刪除連結保存後重開目標，計數 0。只寫標題文字不加括號時，「Unlinked mentions」在延遲掃描後出現（數字標題與一般詞標題皆然）。390px 由頂部 Info 分頁看到 1 筆反向連結，卡片高 46px、無溢出，點擊開啟來源 |
| AI-08 | organizer token（agent role admin）各一次：updateNode 成功、createNode 不在 allowlist 403、searchNodes 空查詢 400。事件只有 AGENT_TOOL_CALLED、AGENT_TOOL_FAILED（被拒那次）與 NODE_UPDATED，被拒與非法呼叫沒有產生任何變更事件；stats 為 calls 2／failures 1／changes 1。**GAP-115**：AGENT_TOOL_CALLED 的 `tx_meta.args` 存整份參數（含 updateNode 寫入的正文），target_type 是 tool 而非節點，`/api/events` 的讀取政策不過濾——另一位 editor 對該 `read: admin` 筆記本身 404、版本 403，卻能從 `/api/events` 讀到正文；同一筆的 NODE_UPDATED 則正確隱藏。**GAP-116**：參數驗證在 try 之前，400 呼叫不寫 AGENT_TOOL_FAILED，也不進 stats；token 面板的統計列在新呼叫後 4 秒內不更新 |
| HIST-10 | 手動啟動的隔離 e2e stack（`onden_test`，測完 `down -v`）：剛移到垃圾桶的節點，`retention_days: 1` dry-run 計畫 0 筆、`0` 計畫 1 筆。在 content_nodes 加 BEFORE DELETE trigger 對該節點丟例外：prune 回 500，節點仍在且 `deleted_at` 保留，`NODE_PURGED` 為 0（事件與刪除同一交易回滾）；拿掉 trigger 重試，清除 1 筆、同時存在的 live 筆記不受影響、`NODE_PURGED` 恰 1 筆。第二位人類（非 admin）403 `admin role required`；admin role 的 agent token 403 `token_scope`。同一 DB 上執行 `pruneBlobGc.integration.test.ts`（保留 body_hash／value_ref／逆向 value_ref 仍引用的 blob，只刪真正孤兒）與 `prune.test.ts`，共 9 項通過、0 跳過 |
| SITE-10 | `/api/export-static` 解壓為 `.nojekyll`、`index.html`、`site/index.html`、每篇 `site/<slug>/index.html`；未發布與私有筆記的標題／正文都不在檔內。以 `python -m http.server` 服務解壓目錄：根目錄 meta refresh 轉到首頁，頁間連結可點、內容為已發布版本。**GAP-118**：連結是目錄式 `../slug/`，以 file:// 直接開啟時無法導覽；正文圖片輸出為 `/api/media/<hash>.webp`，zip 不含媒體檔，部署到任何靜態主機都 404。**GAP-117**：發布後在 A 修改正文，`/api/site` 仍給已發布版本；但把另一篇 B 取消發布（或發布 C）後，`/api/site` 改為提供 A 的未發布草稿，匯出亦同 |
| TOKEN-05 | 以官方 MCP SDK `Client`＋`StreamableHTTPClientTransport` 帶 researcher token 連 `/api/mcp/protocol`：server 回報 onden 0.1.0；`listTools` 列 12 個工具且 schema 含欄位；`getNode` 讀到正文；`createNode` 成功且之後 bootstrap 可見；`noSuchTool` → isError「Tool noSuchTool not found」（-32602）；`getNode` 非 uuid → isError 輸入驗證；`publishSite` 不在模板 → isError「does not allow tool」。REST `createNode?dryRun=true` 回 `dryRun: true`，節點未建立，該 actor 的 AGENT_TOOL_CALLED 與 NODE_CREATED 皆無新增 |
| TOKEN-07 | 同一工作區：帶 scope 標籤的父節點、無標籤的子節點、已刪除的同標籤筆記、另一標籤筆記。searchNodes、getNode、queryView 與 owner 的 REST 集合項目結果一致——只有父節點；子節點（token scope 依節點自身標籤、不繼承祖先）、垃圾桶、他標籤都不出現。媒體：只被範圍外筆記引用的圖片，scoped token 取得 404，範圍內 token 200。把 live token 改 scope 到另一標籤後，下一次呼叫原筆記不可見、新範圍可見；軟撤銷後 401。另見 GAP-119 |
| TOKEN-03 | 對 30 篇筆記每 15ms 送一筆 updateNode，200ms 後由 owner 軟撤銷 token：21 筆 200、9 筆 401、沒有其他狀態；其中 11 筆 200 的回應在撤銷完成後才送達，但所有 NODE_UPDATED 的 created_at 都早於 `revoked_at`（晚於撤銷的提交 0 筆），且 200 筆數＝事件數＝正文實際改變數（21）。token 列保留並帶 `revoked_at`。另：UI 撤銷保留 revoked 標示（tokenMint）、硬刪除與過期 token 401、live re-scope 下一次呼叫即生效（TOKEN-07） |
| TOKEN-08 | admin role 的 agent 帶 publisher token：直接呼叫 `POST /api/publish` 與 `GET /api/inbox/approvals` 都 403（bearer 僅限 /api/mcp）；`publishSite` 兩次相同參數各回 `pending_approval`，outbox 只多 1 筆；agent 嘗試批准自己的請求 403。owner 軟撤銷該 token 後批准：200，執行並產生歸屬 ai_agent 的 PUBLISH_SNAPSHOT_CREATED 與 user 的 EFFECT_APPROVED；同一 id 再批准 404，不重複執行；之後 pending 清單為 0。第二位人類（editor）批准另一筆 publish 403（需 admin） |
| TOKEN-06 | researcher token 以相同 `Idempotency-Key` 送兩次 `createNode`：第一次 200 建立，第二次 200 `{deduped:true}`，bootstrap 只有 1 篇；`updateNode` 同鍵重送也回 200。organizer token 對節點 `applyTag`，該標籤 behaviour 會設 `status=new`：事件為 TAG_APPLIED（root、`triggered_by_event_id` 為空）與 ATTRIBUTE_SET（`triggered_by_event_id` 指向該 TAG_APPLIED），兩者 actor 皆為該 agent，屬性 source 為 `dispatcher`。AGENT_TOOL_CALLED 的 `tx_meta` 有 `tool_name` 與 `token_id`，事件全文不含 token 明文；參數過度保存另見 GAP-115 |
| AI-07 | `approvalGate.spec` 兩項在最終全套通過：agent 發布顯示為「Hasn’t run yet」待審卡，UI 拒絕後不執行；UI 批准後執行並歸屬請求的 agent。隔離 stack：agent publishSite → owner 批准 → 立即 `docker restart` backend，恢復後該 outbox 列為 `done`、`publish_snapshots` 只多 1 份、該 agent 的 PUBLISH_SNAPSHOT_CREATED 恰 1 筆；再重啟一次數量不變。GitHub 等真實外部目的地未設定，不在瀏覽器基線內 |
| AI-06 | organizer agent 對 5 篇筆記各 updateNode、對第 5 篇 applyTag（behaviour 設屬性）。單筆：批准第 1 篇保留 agent 文字，再批准 409；拒絕第 2 篇還原原文，再拒絕 409。批次 reject 送 [第 3、4 篇事件、已批准的第 1 篇、不存在 id、一筆人類事件]：回 decided 2、skipped 三筆（不存在與人類事件為「no reviewable agent event」、第 1 篇為「already reviewed」），第 3、4 篇還原、第 1 篇不變。群組 reject 以 TAG_APPLIED 為根：rejected 2，標籤與 behaviour 設的屬性都移除。agent 以 token 審核、editor 人類審核皆 403。UI 入口由 `inboxReview`、`inboxGovernance`、`liveUpdates` 在最終全套通過 |
| AI-05 | 空工作區顯示「Inbox is empty」。兩個 agent（Ann 4、Bob 2 筆）：chip 顯示正確計數，點 Bob 只剩其項目、清除後無 active chip。再以三個 agent 各 45 筆（避開 60/分鐘限流）共 141 筆：chip 計數 45／45／45／4／2 正確，但清單只渲染 100 筆、沒有載入更多，側欄徽章也停在 100——第 101 筆以後無法從 UI 審核（GAP-120）。首次載入 `/api/inbox` 回 503 時，畫面顯示「Inbox is empty」而非錯誤（GAP-120）。390px 經「‹ Notes」進入 Inbox 分頁，5 個 chip、100 筆、無橫向溢出 |
| TAG-09 | 帶 `read: admin` 政策與 select 欄位的標籤，兩篇成員各有屬性值。第二位人類（editor）讀成員 404，卻能 `DELETE /api/nodes/<標籤>` 得 200，之後讀同一成員 200（**GAP-121**）。刪除後：`/api/tags` 不再列出、成員不再帶此標籤，但屬性值與正文保留。刪除期間以同名建立新標籤 201，此時 undelete 舊標籤回 409 `tag_name_conflict` 並說明；刪掉新標籤後 undelete 200，成員關係、schema 欄位與政策都回來，editor 讀成員再度 404 |
| TAG-08 | 來源標籤（`read: admin`、欄位 status[s1,s2]、only_src）、目標標籤（status[t1]）。預覽回 members_gaining_target 1、already_in_target 1、fields_only_in_source [only_src]、reversible true。editor 合併 403；目標不存在 404；owner 合併 200（source_deleted）；再合併 404。合併後：只在來源的筆記改帶目標、`only_src`＝keep me 與 status＝s2 保留（s2 不在目標選項內，未提示）；兩邊都有的筆記目標只出現一次；`/api/tags` 不再列來源；目標集合項目 2；來源的儲存檢視未移到目標；以 #來源 文字引用的筆記正文不變。原 `read: admin` 成員合併後 editor 可讀（admin 操作的預期結果，但預覽未提示）。同名欄位在兩個標籤選項不同時，筆記同屬兩者也只依第一個定義驗證，target 合法的 t1 被 422（**GAP-122**） |
| COL-02 | 6 篇（status×score）建立 table view。API：status asc＋score desc 得 `CFDBAE`（select 依字母序 doing<done<todo，非宣告順序；number 依數值 10 先於 3）；score desc＋title desc 同分依標題；`ne done`＋`score nempty`＋`title contains` 三條 AND 得 4 列，`gt 5`＋`eq doing` 得 2 列；只送 layout 或 pin_order 的 PATCH 保留其他欄位；非法 op／layout／dir 皆 400、未知排序欄位 200 視為空值。UI：builder 加兩條排序與兩條篩選，伺服器設定與表格順序一致。**GAP-123**：刪除一條篩選後 400ms 內再刪一條排序，只送出 `{"sorts":[…]}`，篩選仍為 2 條且 UI 被重讀覆蓋回 2 條。**GAP-124**：PATCH 503 顯示「save failed」、無通知、伺服器不變，下一次改同段時整段重送而恢復；離線刪排序同樣只顯示「save failed」，恢復連線 4 秒後仍未重送、UI 與伺服器不一致，重載回到伺服器版。390px 工具列、builder、表格皆在 28..362、頁面無溢出、按鈕高 44px |
| COL-03 | Saved views 表格（status／score／due／done／memo）：score Enter、memo blur 各 1 次 PUT，伺服器與儲存格一致；select／date／boolean 也只有文字框，合法值可存；表格依值猜 value_type，date 與 boolean 存成 text、text 欄的 `123` 存成 number（觀察）。`bogus`→422：表格上方顯示原因、輸入框保留 `bogus`、伺服器不變，另出現「已拒絕」復原卡；`abc`→422 同。**GAP-126**：PUT 503 時編輯框關閉、無錯誤，儲存格立即回到 `—`；同步指示「2 change(s) waiting to sync」，線上等待 60 秒未重試；離線→上線後連同離線編輯一起落地（score=7、memo=offline-edit），儲存格仍顯示舊值 `123`。quick-add 正常建立並清空輸入。**GAP-125**：套標籤 PUT 503 顯示「down」並保留標題，重按 Enter 後同標題 2 篇、表格 1 列；POST 回應遺失（伺服器已建立）顯示「Failed to fetch」，重送後同樣 2 篇、1 列。390px：表格容器 332px 內橫向捲動（內容 440px）、頁面寬 390、儲存格按鈕高 44px，點擊編輯保存成功 |
| TAG-04 | API 逐項：text／textarea／richtext 空值、多行、含 `<script>` 原樣存；number `0`、`-1.5`、`1e3` 可存，`Infinity`、`abc` 422；rating 0～5 可存，6、2.5、-1 422；boolean 只收 `true`／`false`（`1`、`TRUE` 422）；date ISO 日期與時間可存、`10/07/2026` 422；select 選項外 422、空字串可存；required 空值與 DELETE 皆 422；DELETE 其他欄位 200。**GAP-127**：`2026-02-30`、`2026-13-45`、`0x10`、`" "` 可存；自訂 value type 只驗型別名稱（`weird` 400），值不驗。featured 儲存格：number `0` Enter 存 `0` 且顯示 0、清空 blur 存空並顯示 Empty、type=number 擋字母；boolean ✓→○ 存 `false`；date、select 設值與清空；重載後全數保留。**GAP-128**：rating 只有文字框（9→422）、relation 輸入標題後存成 `node_ref` 的標題文字；復原面板蓋住 featured 儲存格並攔截點擊。資訊欄：number 打 `120` 送 3 次 PUT（每鍵一次，觀察）、`0` 後清空；checkbox 開關；星等點 3 再點清除；text Enter 只送 1 次；textarea Enter 換行、blur 存 `l1\nl2`；date 設定與清空；required 清空時保留編輯並提示。390px：featured 列 20..370、最右儲存格 326、頁面寬 390，tap 編輯 number 0 與 boolean 皆保存；手機版面不顯示資訊欄 |
| TAG-03 | API：有值的 `f_txt` 改 number、`f_num` 改 date 皆 200，既有值保留原 value_type（`hello|text`、`6|number`），同值重存 422、其他欄位照常可寫；刪除 select 欄後值 `a` 留作一般屬性、可寫 `zzz`，重新加回帶 options 後 `zzz` 保留、重存 422；delete-preview 用量前後一致。**GAP-131**：空名、重名、`nonsense` 型別、`42`、options 字串皆 200 存入。UI：三欄皆顯示「1 in use」；改型別無確認、立即保存；刪除有值欄位跳出「"f_txt" has values on 1 note(s)…」，取消保留、確認後只刪欄、值保留，以同 key 加回後徽章仍「1 in use」。PATCH 400：「Save failed」＋已拒絕復原卡；503：「Waiting to sync」，線上 45 秒未重送，重載後才落地。**GAP-132**：`/api/tags` 回應延遲 3.5 秒時先輸入的標籤名已保存，但晚到的舊快照把輸入框改回舊值；他分頁新增 `f_remote` 後本頁不顯示，本頁再改一個標籤名即把 `f_remote` 刪除。390px：列右緣 374、頁寬 390、刪除鈕高 44px，改名可保存 |
| TAG-05 | API：多值 text `["a","a"]` 照存、`[""]` 可存；多值 select 陣列 422（GAP-111）而單值字串 200；relation 存不存在的 UUID 與 `not-a-uuid` 皆 200。資訊欄：多值「add」新增空格即寫入 `[""]`，兩格皆填 `dup` 存成 `["dup","dup"]`，移除一格剩 `["dup"]`。**GAP-134**：relation 目標進垃圾桶後資訊欄顯示「empty」、featured 顯示原始 UUID、API 仍存 ID；select 選項 `c` 被刪後資訊欄下拉顯示「—」、featured 顯示 `c`。他分頁刪除選項 `b` 後 2.5 秒內本頁選單只剩 `a`，無法選過期值。select 改 `b` 遇 503：同步指示「1 change(s) waiting」但下拉跳回 `a`，重載後 `b` 落地（同 GAP-126）。**GAP-133**：media URL 以 30ms 間隔輸入產生 18 次 PUT，最後存成 `hts/og`（重跑為 `tp/og`）；上傳 503 無提示、值不變。editor 對 `read: admin` 目標：資訊欄 empty、搜尋候選空、頁面無標題，API 回原始 ID（只洩漏存在）。390px featured 列出 5 欄、select 改 `c` 保存 |
| TAG-06 | API：G 在 P→C→G 中取 P 的 `owner=Alice`（depth 2）；C 設 inheritable `Bob` 後 G 取 Bob；C 改為非 inheritable 後 G 回到 Alice；G 本機空字串遮蔽繼承，刪除後恢復。UI：C 的「From parent」顯示 `Alice from InhP`；父層改 `Alice2` 後 4 秒未更新（重開才更新，觀察）；在 Extra fields 新增 `owner` 後繼承列消失；關 inheritable 後 API 與 UI 皆無。子節點標籤欄位 `owner` 與繼承值同名時欄位列與 featured 顯示 empty、繼承區顯示 `Alice2`（觀察）。欄位 default 在套標籤時寫入 `dflt|derived`。**GAP-136**：父層 `child:status=todo` 後以 API 建子節點，子節點無任何屬性。rollup：sum 5／count 2 正確；**GAP-135**：加入 `read: admin` 子節點（hours 100）後 sum 105、count 3，editor 讀 rollup 也得 105；加入 `hours=abc` 後 sum 欄消失、只剩 count。editor：受保護父節點與其子節點皆 404、inherited 403，撤權（父層加鎖）後同。390px：展開 Properties 顯示繼承值、面板右緣 376、頁寬 390 |
| TAG-01 | API：一般筆記標題 `tag-sl…` 占用 slug 後，resolve-path 建同名標籤得 `tag-sl…-2`；兩個 CJK 標籤 slug 各為 `tag-課程…`、`tag-筆記…`。`rp/a/b` 首次 created 3、重送 0 同葉；` /rp// a / b/ ` 同葉；`" / / "` 500（GAP-145）；201 字 400；`RP…` 另建新標籤；6 個並行解析新鏈全 200、單一葉、單一根。子層 `par/leaf` 存在時根層 import `leaf` 409，resolve-path `leaf` 在根層建立。import 同 id＋Idempotency-Key 第二次 409；UI「+ New tag」以 route 先送達再中斷回應：重送 409、通知「A queued change was rejected」、復原面板出現，伺服器只有 1 個該標籤，重載後仍有復原面板（GAP-146）。改名同父層重名 409；`"   "` 與 `with/slash…` 200 並存入，之後 resolve-path 同字串另建 2 段新鏈；顏色 `not-a-colour; background:url(x)` 與 null 200（GAP-145，前端未把顏色寫入 HTML 字串）。改名後資訊欄 chip 4 秒內變新名，側欄有 `#新名 1` 與正文舊名 hashtag 的 `#舊名 1`；搜尋 `#新名`／`#新名大寫` 命中、`#舊名` 不中，tree 與 slug 同步。editor：改名 403、import 403、resolve-path 200；UI「+ New tag」顯示無權限通知、伺服器無此標籤 |
| TAG-02 | 成員 n1、僅正文 `#L` 的 n2、兩者 n3、正文 `#LAB` 的 n4：側欄 `#L` 計數 3，點擊進標籤頁「Tagged notes 2」列 n1、n3；搜尋 `#L` 得 n1、n3；`#LAB` 另一 chip 計數 1，點擊為側欄篩選、列 n4（GAP-138）。`pa/dup`、`pb/dup` 各套一篇：側欄單一 `#dup` 計數 2，點擊開其中一個標籤頁、只列 1 篇（兩次執行分別開 A、B），選單有兩個 `#dup`，搜尋兩篇皆中。資訊欄離線套用：通知「Tag saved locally; waiting to sync.」，chip 與側欄計數 1，重連後伺服器有成員；離線移除後 chip 0，重連後成員消失；PUT 503：同一通知、chip 1、同步指示 1，解除後 90 秒內伺服器仍無成員（同 GAP-126）。快速捕捉線上 `QC online #tag`：標題與正文去掉 `#tag`、成員 1；離線：標題與正文保留 `#qcoff…`、重連 6 秒後成員 0、無此標籤、搜尋不中。`task`：建任務後 agenda 有、bootstrap 無；改名 `todo…` 後 agenda 無、bootstrap 出現；再建任務產生第 2 個 `task` 標籤；原標籤改回 409；刪掉新標籤後改回 200，原任務回 agenda，期間的任務仍在 bootstrap。`proj/task` 套在一般筆記（不論是否有 `_task_status`）：該筆記不在 bootstrap、直接 GET 200、不在 agenda；刪 `proj/task` 後回到清單（GAP-139） |
| TAG-07 | UI：Access「Admins only」→ 說明「Only admins can attach or remove this tag.」，伺服器 `{required_role:"admin"}`；editor 套用 403、讀成員 404、寫成員 403（GAP-140）。Automation「When this tag is added → Set a field」填 status／todo：摘要「→ set status = todo」，伺服器 `on_apply` 相同，API 套用後 attrs `{status:todo}`。API 規則：sequence〔a=1、number 欄 n=`abc`〕套用 200、兩值皆存；`steps:"oops"`、`{type:"explode"}` 套用 200、無屬性；空鍵存 `""`；`value_type:"bogus"` 保存 200、套用 500、成員與前一步皆無（GAP-142）。同一 500 規則以資訊欄套用：通知「Tag saved locally; waiting to sync.」、chip 1、伺服器無成員；其後於另一標籤加 notify 並以 App 內換頁離開，20 秒內未落地、同步指示 2；API 修好規則後 720ms 內兩者落地（GAP-143）。另一次執行換頁送出正常落地。政策：`read:"owner"`、`required_role:"Admin"` 200 且 editor 讀 200，`admin` 時 404；`operations:"all"` 200（GAP-141）。300 層 when 巢狀保存與套用 200；2MB notify 訊息 200；on_attribute_change 自設同欄位只產生 1 筆 ATTRIBUTE_SET。150ms 內重載：該次 `reload-now` 未存、無復原面板；離線修改顯示「Waiting to sync」，重連落地；route 403：標題旁「Save failed」、輸入保留、無通知，重載後回到伺服器值（GAP-144）。390px：設定區可見、無橫向溢出 |

### 權限提升掃描（2026-10-07，隔離 stack、editor 對 `read: admin` 內容）

| 嘗試 | 結果 |
| --- | --- |
| PATCH 標籤 policy／schema_policy | 403、仍不可讀 |
| 從受保護筆記移除政策標籤 | 403、仍不可讀 |
| 刪除政策標籤 | **200，成員變可讀（GAP-121）** |
| 把受保護子節點移出受保護父節點 | **200，子節點變可讀（GAP-129）** |
| 刪除看不到的受保護父節點 | 200（可盲刪，GAP-129） |
| 改名政策標籤 | 200（只是名稱） |
| 把政策標籤套到自己的筆記 | 200，自己隨即不可讀（符合政策） |
| HIST-08 | 根節點下兩個子節點、其一再有孫節點，刪根後四者 404；`?view=timeline` 的 Trash 分頁按 Undelete，四者 200、孫節點仍在原父下；再 undelete 409。另一筆離線時按 Undelete：沒有任何提示，重連後伺服器 200（佇列重送）。`read: admin` 的筆記刪除後，第二位人類（editor）的 `/api/nodes/trash` 不含它，但 `POST /undelete` 200 並真的恢復（GAP-129 盲寫）。390px 的 Trash 分頁可見列與 75×44px 的 Undelete，按下後恢復、無溢出。slug 被新筆記占用時的恢復由既有 `undeleteSlugConflict.spec`（最終全套通過）驗證。垃圾桶「刪除者」顯示 actor UUID 而非名稱 |
| NOTE-12 | 三段標題筆記經指令面板拆分：正常建 3 個子筆記並改寫父筆記。第 3 個 POST 回 503：子筆記全數移除、父筆記保留全文、提示連線失敗；父筆記 PATCH 503：同樣全數移除；之後重試成功建 3 個。第 2 個 POST 在伺服器提交後丟棄回應：拆分中止、父筆記保留全文，但「Beta」子筆記留下（未被記入 created，回滾刪不到），提示只說無法連線（**GAP-130**）。合併 3 個子筆記、其一刪除 503：父筆記含三段文字，剩下 K2 並提示「1 child notes could not be removed」。editor 對含 `read: admin` 子節點的父筆記合併：只併入可讀的子筆記，不可讀者保持原狀。390px 以指令面板拆分成功；手機底部 Search 依程式接到同一指令面板 |
| REV-01 | 以 `modules.review.enabled` 標籤納入三張卡（其一另帶 `read: admin`）。改標籤名稱後佇列仍是三張；移除 CardB 的標籤後只剩 CardA 與 CardSecret。第二位人類（editor）的佇列只有 CardA、stats.new 為 1、回應不含受保護卡，對受保護卡評分 404。owner 評分 CardA 後停用功能，佇列清空；重新啟用後 CardA 保留 `_review_state`（未到期故不在佇列）、CardSecret 回到佇列。複習抽屜在停用時清掉卡片的 UI 行為由 `tagModuleCenter.spec` 在最終全套通過 |
| REV-02 | 「Review cards under this note」開四張卡的 deck，依序以 Again／Hard／Good／Easy 評分：四張卡各 reps 1，stability 0.49／1.40／3.71／13.82，due 為次日、次日、+4、+14 天，完成顯示「Done — 4 reviewed」。對 Good 雙擊：只有 1 個 grade 請求、只評第一張。離線時顯示答案後四個評分鈕皆停用（明確拒絕，但沒有說明文字），重連重載後伺服器未記錄評分。390px：第一次評分 503 時保留同一張卡並提示「Retry the same button to finish」，再按一次只評該卡一次；按鈕 76×44px、無溢出。桌面的回應遺失與提交前 503 由 `reviewGradeRecovery.spec` 在最終全套通過 |
| SITE-06 | 根筆記（含圖片）下兩個子筆記，其一帶 `read: admin`。owner 在 Share 視窗按「Publish with 2 nested notes」：根與一般子筆記上 `/api/site`，受保護子筆記雖被標上 `_published` 仍不出現（讀取政策把關）；再明確標記一次也不出現。已發布根筆記內嵌的圖片匿名取得 200。第二位人類（editor）可把自己可讀的筆記標為發布並立即公開；對看不到的受保護筆記寫 `_published` 也回 200（不上站，屬 GAP-129 盲寫）；呼叫 `/api/publish` 403。集合：已發布項目在 `/api/site` 與 `/site/<集合>/<項目>` 都可讀；未發布項目與不存在的 slug 都回 200 頁面但不含內容（soft 404） |
| RSS-04 | 三篇文章的來源：收件匣卡「Onden — 3 new articles」、`/api/rss/sources` unseen 3、items 未讀 3 一致。閱讀器略過一篇後重載，該篇仍為已看；全部讀過後 unseen 0、收件匣卡消失。`/seen` 回 503 時（開啟文章前即攔截）：閱讀器照樣前進到下一篇，清單把前一篇標成 `read`，沒有任何錯誤提示，伺服器兩篇都仍未看，重載後恢復未讀（**GAP-137**）。第二位人類（editor）：帶 `read: admin` 的來源文章看不到、標記單篇 404、對該來源 skip-all 標記 0 篇，owner 仍未讀。已看狀態存在 `rss_staging.seen_at`、屬整個工作區：editor 對一般來源 skip-all 後，owner 的未讀也歸零 |
| FIND-03 | 來源筆記含 `[[T]]`、`[[T|Nice Name]]`、`[[T#Deep Section]]`、`[[T#^blk]]` 與不存在的 `[[Ghost]]`。預覽中前四者都開啟目標，標題錨點與 block 所在行（長文第 60 行之後）捲入視窗；標題／block 連結顯示原始的 `T#Deep Section`。Ghost 連結沒有 `known` 樣式，點擊後開啟新建的 Ghost，恰 1 篇。兩篇發布後，公開頁把連結輸出為 `<button class="published-inline-link" data-preview-slug>`、alias 顯示 Nice Name，但沒有 `href`。目標改名後，來源正文的 `[[T]]` 未被改寫；預覽中點舊連結建立一篇新的同名空筆記，原目標的反向連結消失（**GAP-147**） |
| FIND-05 | UI：側欄右鍵目標 → 「📎 Pin under another note…」跳出原生 prompt，輸入父節點標題，存在含相同字串的誘餌時仍釘到完全相符者；再釘一次 409 視為已存在、仍只有 1 筆、無通知。生命週期：刪除目標後 bootstrap 不再列該 pointer，undelete 後恢復。展開父節點後右鍵釘選列 → 「Remove pin」，第一次 DELETE 503：pointer 保留、同步列顯示 1 筆待送，重連後送出並刪除。第二位人類（editor）：以受保護筆記為目標或父節點建立 pointer 皆 404，bootstrap 不含 owner 對受保護筆記的 pointer；editor 可刪除 owner 建立的一般 pointer（200） |
| TAG-10 | API：含欄位、政策、behaviour、template_children 的標籤匯出後改名匯入、再匯出，除名稱外逐欄相同；原名重匯 409，version 改 2.0.0 仍 409。缺依賴回 `missing_dependencies`、未知模組回 `missing_modules`。**GAP-151**：`fields` 為物件或字串、`dependencies` 為字串皆 500；`dependencies:[1,2]`、`policy:"admin"`、`behaviour:[1,2]`、`template_children:"abc"`、`color:"not-a-colour"`、5,000 字名稱、`_format:"onden.tagpack/v99"`、`version:"banana"` 皆 201。**GAP-152**：resolve-path 建立的 `Reading list …` 與 `讀書・筆記…`，自身匯出檔再匯入 400（名稱字元限制）。Your Data：檔案輸入為 multiple，一次選三檔得 ✅ 1、⚠ 壞 JSON「body must be a JSON object」、⚠ 同名；伺服器只多 1 個，側欄出現新標籤；`.txt` 提示「No .tagpack.json files selected」；503 列出原始「down」；離線時按鈕停用；已安裝的 Person 在設定頁仍列出，按 Install 回 409 訊息（Tags 頁的 Ready-made tags 會隱藏已安裝者）。標籤頁「Export tag」下載 `<slug>.tagpack.json`，內容與 API 相同。researcher token 的 proposeTagPack：`?dryRun=true` 回 [dry-run] 且收件匣不增加；實送增加 1 筆，同名再送仍回 filed 但以 dedup 合併（仍 1 筆）；收件匣 UI 顯示「Install tag pack #…」；agent 直接 import 與自行核准皆 403；owner 核准後標籤出現，拒絕後不安裝。名稱含空白或與既有標籤同名的提案回 500（GAP-151）。**GAP-153**：提案待審時 owner 手動匯入同名再核准，核准 200、outbox `pending` 重試（`tag '…' already exists; proposal cannot install`，上限 8 次後 dead），UI 無提示。390px：匯入按鈕與 Install 高 44px、頁面無溢出 |
| COL-01 | API 管理與 UI 可達性分開記。API：建立三個 view（`pin_order:-1` 排第一）、同名建立 409、空名／81 字／`pivot` layout 400；改名 200、改空名 400、不存在的 view 404；刪除 200、再刪 404、已刪 view 的 exec 404；viewer 建立與刪除 403，editor 建立與刪除 200。**GAP-148**：PATCH 改成既有名稱 200，清單變成 `Alpha,Alpha`。UI：工具列只有 view chip、New view、layout 切換、篩選排序與重新整理；沒有改名、刪除、置頂按鈕，chip 右鍵與雙擊無反應；選第二個 view 後重載回到第一個。**GAP-149**：刪除一個 view 後，UI 第一次建立「View 3」成功，第二次又送「View 3」→ 409，之後每按一次都 409；目前 view 在 API 端被刪時按重新整理只顯示 `not_found`，舊 chip 與 2 列舊資料保留。乾淨狀態下：建立遇 503 顯示「down」、按鈕可再按，解除後重試只建 1 個、錯誤清除；離線建立顯示「Failed to fetch」、不排隊，恢復後不補建。刪光所有 view 後重開顯示「No views yet…」，New view 建立 View 1 並顯示 2 列。390px：頁面寬 390、工具列 28..362、chip 與 New view 高 44px |
| COL-04 | List layout（status／score／updated_at）：Alpha 顯示 `status todo`、`score 0`；沒有值的 Bare 只顯示 updated_at；長標題（6 段中英混合與無空白長字）在列內換行，按鈕寬 375、高 137，列與容器右緣同為 940、無溢出。點列與 Tab 到列標題後按 Enter 皆開啟該筆記；Tab 從第一列移到下一列標題，`:focus-visible` 成立（全域 box-shadow 焦點環）。空標題 `POST /api/nodes` 400，故無「(untitled)」列可測。篩選無結果顯示「No rows match the current filters.」。`group_by: status` 分為 todo／done／(none) 各 1，builder 有分組控制。UI 切 Table 後重載仍是 Table；layout PATCH 503 顯示「down」並留在原 layout，下次切換成功後錯誤清除。**GAP-150**：再加 330 篇（共 333 篇）後 exec 預設回 200 列、`hasMore: true`，`limit=1000` 回 333 列；畫面掛載 200 列、無虛擬化、無計數或載入更多，捲到底最後為 `Bulk 131`，score 0 的 Alpha 不在畫面。390px：頁面寬 390、列高至少 44px、長標題 38..332 換行 |
| AI-01 | stub 模式（ASK_MODE=stub）。`/api/ai/ask` 回 503：顯示錯誤，但輸入框已被清空、該輪問答被移除，使用者的問題不見了（**GAP-154**）。SSE 只送 sources 與一段 delta 就結束（無 done）：畫面把「Partial answ」當成完整答案顯示，沒有中斷或錯誤提示（未提供存成筆記）（**GAP-154**）。送出鈕雙擊再加 Ctrl+Enter：只有 1 個請求。答案延遲 2.5 秒時切到另一篇筆記：面板保持開啟，答案完成並引用原筆記。390px：More 選單的「Ask notes」開啟面板，取得帶 [1][2][3] 引用的答案、無橫向溢出；送出鈕 51×37px（低於 44px），另一次執行時開機的「created」通知覆蓋輸入列。真實模型與 API key 屬外部整合 |
| HIST-04 | 390px：筆記頂部 Info → 最近版本「All versions」（85×44px）→ 版本視窗選最舊版本 → Restore，視窗關閉後 Content 分頁與伺服器正文都是 ORIGINAL，無橫向溢出。兩個分頁各開一篇筆記並同時還原：兩篇都回原文、編輯器同步顯示，版本數各為 3（建立、修改、還原）。同一篇在兩分頁同時還原：兩邊都顯示「Version restored」，伺服器為原文，多出兩筆內容相同的還原版本 |
| COL-05 | 看板 stage（select：todo／doing／review／done）＋舊值 legacy＋無值。Chromium 原生拖曳 Alpha todo→done：伺服器 stage=done，score 3、標題、正文不變，另一卡不受影響；拖回同欄 0 次 PUT；拖到 No value 送 `{"value":""}` 200，伺服器值為空、卡片歸入 No value；鍵盤 focus＋select 把 Nobody 移到 done。拖入舊值欄 legacy：422「"stage" must be one of: todo, doing, review, done」顯示於看板、卡片留在 done。PUT 403：顯示「You don't have permission to make this change.」，卡片不動。只有 title 的 view 顯示「Kanban needs a field to group by…」。**GAP-155**：初始只有 TODO／DONE／LEGACY／NO VALUE 四欄，doing、review 從未出現；todo 清空後拖曳目標與 select 選項都沒有 todo。503：卡片不動、無錯誤、無同步提示，解除後 8 秒內伺服器仍是舊值，重載後才寫入並移到 done（GAP-126 同類）。390px：頁面 390、看板 492／334 在容器內橫向捲動、移動 select 高 22px，選 No value 寫入成功 |
| COL-06 | due（date）9 筆：Asia/Taipei 10 月 15 日 1 筆、22 日顯示 3 筆＋「+2 more」；12/31 與 2027/1/1 翻兩頁與三頁後各在正確日期；Today 回 October 2026；無日期筆記顯示「1 of 9 rows have no “due” date and aren’t shown on the grid.」。他端 API 改 due 為 10/03 後 12 秒內月曆不變（GAP-158）；同一 view 切 Table 改 due 為 2026-10-09（文字輸入，無日期 picker）存入，切回 Calendar 移到 9 日；點項目開啟筆記；翻到 12 月後重載回到本月。**GAP-157**：view 只顯示 `exam`（date 型別）時欄位標示 updated_at，9 筆全在 10/7（+6 more）；「+2 more」為 SPAN、無 role／tabindex，點擊不展開。**GAP-156**：America/Los_Angeles 下 10/09→8 日、10/22→21 日、12/31→30 日、2027-01-01 顯示於 2026 年 12 月 31 日，January 2027 空白。390px：頁面 390，格線 501／334 需內部橫捲，Thu 欄被長標題撐寬、Sat／Sun 不在可視範圍，導覽鈕 26×44，點項目開啟筆記 |
| COL-07 | gallery（cover／pic／author）8 筆：上傳圖（只被 cover 屬性引用）以 `/api/media/…` 與裸 id 皆載入，`pic` 欄存圖片 URL 也作為封面；無封面顯示首字佔位。**GAP-159**：`https://img.invalid/nope.png` 與文字 `just some words`（解析為 `/api/media/just some words`）都顯示破圖；`pic` 另以原始 URL 徽章列出；長標題 2 行截斷但無空白長字水平溢出。點卡片開啟；Tab 聚焦後 `:focus-visible` 套 box-shadow，Enter 開啟；重載後仍為 gallery。第二位人類（editor）先看到 8 張，owner 為 Secret 加 `read: admin` 後 6 秒仍顯示 8 張（GAP-158），點 Secret 卡主區空白、無提示、標題與作者不外露；重載後 7 張，exec 亦不含 Secret。390px：單欄、卡寬 334、最矮卡 252px、無溢出 |
| HIST-05 | 桌面：筆記有兩個版本，編輯器另有未保存輸入時開版本視窗（Read 模式）選最舊版本。之後以同一操作者連續保存三次，會合併進最新的 session 列（版本數仍為 2），視窗內預覽仍是最舊版本內容、選取不跳動；點 Current 顯示含未保存輸入的草稿。切到離線：視窗保留預覽與兩個項目，Restore 鈕停用；恢復連線後視窗仍開啟，草稿依自動保存送出 |
| HIST-02 | 390px 開 `?view=timeline` 的 Events 分頁：Actor 與 Event type 下拉皆可見（All actors／User／AI agent／System；類型 6 選項）。工作區有人類建立與修改、agent 修改：選 AI agent 2 列、User 4 列、System 0 列並顯示「No events match the current filter.」，類型 NODE_UPDATED 2 列。`/api/events` 回 503 時按 Reload：原 6 列保留並顯示錯誤；失敗中改選 AI agent：清單為 0 並顯示錯誤、篩選顯示 ai_agent，不把舊查詢結果當作新篩選的內容。頁面無橫向溢出。錯誤訊息直接顯示伺服器的「unavailable」 |
| REV-04 | 講義筆記帶啟用複習的標籤、含兩組 Q:/A:。指令面板「Extract review cards」時讓第 2 張卡的標籤 PUT 回 503：兩張卡都建立，只有 1 張帶標籤並提示無法連線；再執行一次補上標籤（「Added review tags to 1 existing cards」），第三次回「All 2 cards already extracted」。改原文 ATP 的答案並新增題目後重載再擷取：新題目成卡，ATP 卡的答案仍是舊的（以題目文字比對、不更新既有卡）。筆記開著時若從他處修改，3 秒內編輯器未更新，這時擷取讀到舊正文、不會出新卡，重載後才正確。390px：筆記選單沒有此指令，經底部 More→Search 開指令面板可擷取 |
| TASK-01 | `zzDeepTask01.spec.ts`（`tick7/task01b.log`）。任務頁快速新增：宿主為今日筆記、輸入清空、列出現；`PayRent… @tomorrow #c01t…` 的解析晶片顯示明日與標籤，建立後 due 為 2026-10-09。Enter ×3 與雙擊 Add 各只 1 筆。403：輸入保留、無列、權限提示。503：輸入清空、列先出現（佇列），線上 29 秒伺服器仍 0、離線→上線後 1（GAP-126 同類）。回應遺失：重連後伺服器 1 筆，重載後列 1。今日筆記與一般宿主筆記：Ctrl+Shift+Enter、泡泡按鈕各建 1 筆、宿主正確、原行改 `- [x]`；**連按兩次建 2 筆**（GAP-160）；403 時原行保持 `- [ ]`、提示權限、伺服器 0。前一次 403 的復原面板會蓋住編輯器，需先收合。API：缺宿主 404、空標題 400、全空白標題 201、`2026-02-30` 201（GAP-161）、同冪等鍵重送 201／200 只 1 筆。首次執行的 `- [ ] - [ ]` 是探測造成（Enter 自動接續清單符號），已修探測後重跑 |
| COL-08 | `zzDeepCol08.spec.ts`（`tick6/col08d.log`）。UI 建立 Item1，data 與標籤正確；503 保留輸入、重試 1 筆；回應遺失後重按 Save 得 2 筆（GAP-163）；離線提示無法連線、輸入保留、上線後 0 筆（不排隊）。規則壞掉：UI 提示「Could not reach the server」、API 500，孤兒筆記 0（回滾成立）。他處 PATCH Summary 後本機改 Title 存檔，Summary 回到舊值（GAP-164）。一般筆記成員 data 為 `{}`、列顯示「— —」；按 Delete → 對話框「Delete this item?」→ 筆記 404 並在垃圾桶（GAP-165），undelete 後正文與另一標籤都在。editor：清單 5 筆不含 Secret，PATCH／DELETE Secret 200 且真的刪除（GAP-129）；經 node 路由同樣 200。非 UUID collection id 500、跨集合 PATCH 404、跨集合 DELETE 200 但未刪（GAP-166）。viewer：建立 403、PATCH 200、DELETE 200（無政策項目）。刪除集合 200，成員筆記都還在 |
| COL-10 | `zzDeepCol10.spec.ts`（`tick6/col10.log`）。API 見 audit 列。預覽：5 個 fence（含畸形 YAML 與非 spec 文字）全部以 `hljs language-onden-*` 的原始程式碼呈現，`.onden-query-block` 0、表格 0；owner、editor、390px 相同（GAP-162，根因在 `MarkdownRenderer.tsx:437`）。因此點擊結果、嵌入內權限、畸形提示與載入更多都無法從 UI 驗證，列維持「部分」 |
| TASK-02 | `zzDeepTask02.spec.ts`＋`zzDeepTask02b.spec.ts`（`tick7/task02b.log`、`task02c.log`）。任務頁：勾選→done、移出未完成區；展開已完成、Reopen→todo 回到未完成；狀態 doing 顯示徽章，waiting 移到 Waiting 區。403：checkbox 回到未勾、列保留、提示權限、伺服器 todo。503：列立即消失、已完成區也沒有、同步列「1 Sync now」，線上 20 秒伺服器仍 todo，重載後 done（GAP-126 同類）。宿主筆記：Ctrl+Shift+Enter 轉換後行為 `- [x]`，經 API 完成與重開後都仍是 `- [x]`。重複任務：UI 雙擊勾選只生成 1 個；重開再完成生成第 2 個 `todo 2026-10-09`（GAP-167）。390px：無橫向溢出、勾選 B-tomorrow 後伺服器 done，checkbox 13×13px |
| TASK-04 | 同上 spec 的 API 段。每日：完成→`todo 2026-10-09`，同冪等鍵 200／200 只 1 筆。1/31 每月：過去的完成後下一次 `2026-11-03`、2027/1/31 完成後 `2027-03-03`（GAP-168）。每週改回 null 後完成不生成。無 due＋`1d`：200，完成 200 但不生成也不提示。`0d`／`1y`／`1000d`／` 1d` 400、`2w` 200。`2026-10-09T15:15` 每週完成→`2026-10-16T15:15` |
| TASK-06 | 補驗 `zzDeepTask06.spec.ts`（`tick7/task06.log`）：延遲 4 秒的舊 agenda 回應在較新讀取之後抵達，被 `readVersion` 丟棄，已完成的 LateX 不復活；讀取中離開頁面無錯誤。列改為已盤。原紀錄：瀏覽器 Asia/Taipei 本地 2026-10-08、UTC 2026-10-07：伺服器 bucket 昨天→today、今天→upcoming、今天 00:01→upcoming、明天→upcoming、+7／+8→scheduled、無日期→unscheduled；畫面的區塊跟著伺服器、徽章跟著本地（Today 區的「1d overdue」、Upcoming 區的「Today」）（GAP-169）。agenda 503 重載：仍顯示舊清單（Overdue 4…），無錯誤提示。舊請求晚到當時未測（已補驗） |
| TASK-03 | `zzDeepTask03.spec.ts`（`tick7/task03b.log`）。DueA（3 天後）在編輯卡的日期欄點擊後鍵入「12252026」：只送出 1 個 PATCH `{"due_date":"0001-10-11"}`，伺服器即為此值（GAP-170）。時間 fill 15:15→`0001-10-11T15:15`；清除時間→純日期；清除日期→null、Unscheduled、時間欄停用。Late（-3 天）+1 day→`2026-10-09`（本地明天）；Future（+5）+1 week→`2026-10-20`。本地 03:18 時，今天 00:30 與 23:30 的任務都在 upcoming（GAP-169）。PATCH 驗證：`2026-02-30`、`2026-13-01`、`2026-10-08T25:00`、`…T15:15:00` 200；帶 `+08:00` 與 `20261008` 400 |
| TASK-05 | 同上 spec。載入後立即離線：gate 出現、12.2 秒後仍鎖、新增框不可見；上線 521ms 後解除（GAP-171）。核對完成後離線：新增 Off1、Off2 @tomorrow 兩列出現、無提示；Off1 +1 week 徽章 in 7d；離線重載停在「Unable to check your sign-in status」（GAP-20）；上線後 Off1 `2026-10-15`、Off2 `2026-10-09`。離線勾選 Refuse＋新增 AfterRefuse，重連時 Refuse 的 PATCH 回 403：伺服器 todo、AfterRefuse 1 筆、復原面板與「A queued change was rejected…」提示、Refuse 回到未完成。宿主筆記離線轉換：行 `- [x]`、提示「Task created」（GAP-172），上線 8 秒內 1 筆任務 |
| CAN-07 | `zzDeepCan07.spec.ts`、`zzDeepCan07b.spec.ts`（`tick7/can07b.log`、`can07e.log`）。API：A→B 重複 POST（第二次帶不同 id）201／201、同 id、1 條；B→A 201；C→C 201；目標全零 UUID 404、來源全零 UUID 403；manifest `knowledge_link,suggested_link,nav_link,highlight_source,parent(planned),canvas_member(planned),embed(planned)` 逐一 201；`made_up_kind` 201、`Bad-Kind`／空／65 字 400；`suggested` 201、`deleted` 400。目標刪除後 bootstrap 不含該線、對它建立 404，undelete 後恢復。DELETE 全零 404、`not-a-uuid` 500。editor：A→Secret 404、Secret→B 201、看不到 owner 的 Secret→A、DELETE 它 200 且真的刪掉、DELETE owner 的 A→B 200（無政策，既有契約）（GAP-173）。UI：右側 handle 拖到另一卡左側 handle → POST knowledge_link、伺服器 U1→U2、畫面 1 條；再拖一次 2 個 POST、伺服器仍 1 條、畫面 1 條；拖動 UB 後連線不變；POST 403 時畫面回到 1 條、提示權限、伺服器 0。右鍵連線中點：選單「ARROW TYPE knowledge suggested nav · Delete arrow」，Delete 後伺服器移除、畫面剩 1 條；左鍵點選連線 `.selected` 0、按 Delete 無作用（GAP-174）。截圖中連線幾乎看不見 |
| CAN-01 | `zzDeepCan01.spec.ts`（`tick7/can01b.log`）。選擇頁開啟 1.5 秒後白板數 5→5。dblclick New canvas：POST 1、+1、網址 `node=<新>&lens=canvas`、空白板提示可見。POST 403：數量不變、選擇頁仍在、按鈕可用、無白板、提示權限（復原面板顯示「This change was rejected… Untitled Canvas」）。側欄（需先捲動才找得到該列）：Rename→`C01Renamed`，伺服器與側欄一致；PATCH 403：伺服器維持、`.sb-rename-input` 保留、提示權限；空白名稱：伺服器維持、無提示。Delete：DELETE 403 時仍在並提示；成功時沒有 confirm／dialog，白板 404、成員 200／200、網址回 `lens=editor`、選擇頁 0 筆；undelete 200，`m1@40`、`m2@400`。390px：More→Canvas、New canvas 128×38、scrollWidth 390、建立 +1 並顯示白板 |
| CAN-08 | `zzDeepCan08.spec.ts`（`tick7/can08b.log`）。`?view=graph&node=N` → This note：「3 connections」清單 linked to GA／GB、contains GC。點 GA → `lens=editor`；Back → `?view=graph&node=N`，標題回到「Links」（Everything）。他處刪 GB：6 秒內清單剩 GA、GC；undelete 後 6 秒內三列都在。再連 GD：「4 connections」、清單 0、canvas 1。editor 開同一清單後 owner 對 GA 加 `read: admin`：514ms 後清單只剩 GB、GC。Everything：bootstrap 1,085 篇，canvas 376ms 出現；拖曳＋滾輪無 pageerror。長任務觀察器在換頁時重設，0 筆不能當作無卡頓證據。手機 390×844 canvas 390×695，轉 844×390 為 844×251，轉回 390×695，scrollWidth 等於寬度 |
| CAN-06 | 既有 4 個 canvas 卡片 spec（`tick7/can06-base.log`）＋`zzDeepCan06.spec.ts`、`zzDeepCan06b.spec.ts`（`can06c.log`、`can06d.log`）。卡片以 `data-id` 定位（標題不在卡片文字內）。CEdit 雙擊→`.card-node--editing` 1→打字→點空白處：伺服器 `start plus typed`。CTall：280×4537、無捲動容器、與 CWebData 卡重疊（GAP-175）。拖放 `fail.png` 且 `/api/media` POST 503：擺放 +0、無提示（GAP-176，`useCanvasActions.ts` `if (!up.ok) continue`）。editor 對 CLock（`write_node: admin`）：API PATCH 403；UI 雙擊打字後離開，PATCH 403，卡片「Card changes not saved Retry saving … editor tried」、復原面板、權限提示，伺服器 `locked body`，重載後卡片為 `locked body`。CTask：checkbox 為 `button[role=checkbox]`，第一次點擊後伺服器與 aria 都未變，第二次 `- [x] one`（GAP-177）。嵌入：`javascript:`、`data:` 無 iframe 無連結；`http://example.invalid/page`、`https://example.com/ok` 有 iframe（sandbox allow-scripts allow-popups）；`https://example.com/a b` 只有連結 `https://example.com/a` |
| CAN-09 | `canvasJsonCanvas.spec.ts`＋`zzDeepCan09.spec.ts`（`tick7/can09.log`）。匯入無效檔：notJson「This .canvas file is not valid JSON…」、dupIds「nodes[1].id: expected a non-empty, unique node ID」、badSize「nodes[0].width: expected a positive integer」、danglingEdge「edges[0]: an endpoint does not exist in nodes」，各 0 筆、留在原白板；`{nodes:[],edges:[]}` 建立 1 個空白板。有效檔：+3 筆、+1 連線、+1 白板並開啟；匯出 `Plan-<stamp>.canvas`：group 500、text 270、text 140、edges 1。再匯入：+3 筆、同名白板 2、無提示。連線 503：+3 筆、+1 白板、連線 0、「Import stopped. Some content may already have been created; check your notes before importing again…」。PATCH 403 後匯出：`server text`，卡片顯示「Card changes not saved … server text REFUSED」。390px：匯出鈕在可橫捲的工具列內（44×44），點擊下載 `C09Seed-board-<stamp>.canvas`。缺正文路徑需 slim（≥2,000 篇）或補讀失敗，本輪未觸發 |
| CAN-02 | `zzDeepCan02.spec.ts`、`zzDeepCan02b.spec.ts`（`tick7/can02.log`、`can02b.log`）。裝置 B（同帳號第二個 context）開白板、核對完成後離線、把 Y 往下拖 ~170px；API 加入 Z 後伺服器 `[X, Y@40, Z]`；B 上線 8 秒後 `[X, Y@210]`，B 畫面無 Z（GAP-178）。中心空白的白板：雙擊、工具列 C＋點擊、右鍵選單（只有「Create node here」）各 +1 篇 +1 擺放；第一次執行的雙擊落在放大的種子卡上（探測位置問題，已改用中心空白的白板重測）。POST /api/nodes 403：請求 1 次、擺放 2→2、卡片 2、提示權限、復原面板。離線雙擊：`.card-node--editing` 0，打的字沒有進入卡片；上線後 POST /api/nodes 201、PATCH /api/canvases 200，擺放 +1、新筆記「New Note」正文空白 |
| CAN-03 | `zzDeepCan03.spec.ts`、`zzDeepCan03b.spec.ts`（`tick7/can03b.log`、`can03d.log`）。Grid 後保存 `R@80,80 500x300`、`C1@440,80`、`C2@80,360 420x380`、`G2@800,80 600x200`…，Fit 後 DOM 重疊 R×C1、R×C2、R×G3、C2×G3、C2×Loose（GAP-179）；Undo 回到 `R@0,0`、`C1@137,211`…。選 R 後 Arrange as tree：`R@80,405`、`C1@440,210`、`C2@440,600`、`G1@800,80`、`G2@800,340`、`G3@800,600`、Loose 原地 `822,566`，重疊 R×C2、C2×G3、C2×Loose、G3×Loose。12 卡的大板 Fit 後 0.139 倍、卡片 36×10px；從卡片中央拖 100px → dx 656、dy 0。第一次拖到被工具列蓋住的卡（`canvas-tools`）位移 0，屬探測位置問題 |
| CAN-05 | `zzDeepCan05.spec.ts`（`tick7/can05b.log`）：拖 Y 至 `600,437`；API 移到 `1500,1500`，4 秒內畫面 `translate(1500px, 1500px)`；Undo 後伺服器 `600,300`、無提示（GAP-180）。X 拖動的 PATCH 延遲 3 秒，期間經 More→Canvas→C05B 切板：X 落地 `172,0`、B 無 X、P 不動、B 上 Undo 停用；回 A 後 Undo 停用。第一次用整頁跳轉切板時請求被中斷、X 留在 `0,0`，不屬 app 內切換。另見 `zzDeepCan03.spec.ts`：重新開啟白板後 Undo disabled。PATCH 403 的 Tidy：伺服器不變、畫面回原位、提示權限、Undo enabled，按下後伺服器不變並再提示一次。Ctrl+Shift+Z、Ctrl+Y 不改變伺服器版面 |
| CAN-04 | `zzDeepCan04.spec.ts`（`tick7/can04.log`）。16 分組、6 卡：Fit 0.733 倍與 2 倍時 `.section-node-heading` 16 個、重疊 0 對、標題截斷 6；自訂顏色 4 個生效。標題右鍵 `.ctx-menu` 空、分組內按鈕 0（GAP-181）。403 拖動段落：伺服器未變、無提示、Undo 停用，判斷為拖動未觸發，不作為證據 |
| NOTE-08 | `zzDeepNote08.spec.ts`、`zzDeepNote08b.spec.ts`（`tick7/note08.log`、`note08c.log`）。模擬時鐘 2040-12-31T23:59+08：Today→標題 `2040-12-31`、伺服器 1；`fastForward 02:00` 後 Today→`2041-01-01`，d1=1、d2=1；再快轉一天 dblclick Today→`2041-01-02` 1 篇；裝置 B（第二個 context、模擬 2041-01-03 09:00）與 A 同時按→伺服器 1 篇、兩邊標題皆 `2041-01-03`；離線 Today→`2041-01-04`、「1 change(s) waiting to sync」，上線 8 秒後 1 篇。390px 可見按鈕無 Today；More 選單含「Today's note」（159×44），點擊開啟 `2026-10-08`、scrollWidth 390、伺服器同日 1 篇 |
| NOTE-06 | `zzDeepNote06.spec.ts`（`tick7/note06.log`），390px、Ctrl+Enter 保存。線上 `OnCap … #cap… @tomorrow\nsecond line`：標題 `OnCap …`、正文含第二行、tags 1、parent 有、due `2026-10-09`。離線同一行：表單關閉、無提示；上線 10 秒後標題 `OffCap … #cap…`、tags 0、due `2026-10-09`（GAP-182）。LostCap：POST 已提交但連線重設，表單關閉、無提示，伺服器 1 筆。標籤 PUT 403：表單關閉、提示「Captured, but these could not be applied: #cap…」、標題 `TagRef …`（無 #tag）、tags 0、due 有。筆記 POST 403：表單仍開、保留 `NoteRef …`、提示權限、伺服器 0 |
| NOTE-10 | `zzDeepNote10.spec.ts`（`tick7/note10c.log`）。NC（1 標籤、score 7）：側欄右鍵 Move under 不含 NP（0）；資訊欄 Parent 選 NP→parent P、其他欄位同；重開後仍 P、`.obsidian-group-title` NP 1。PATCH 正文後 restore 移動事件（NODE_UPDATED）：200、parent null、正文為後來的「+ later edit」。PATCH 403：伺服器不變、提示權限。Hide→hidden true、Inbox 列出 1、Promote→hidden false，tags 1、score 7 不變。editor 讀 NC：200；移到 NL（`read: admin`）後 404；Parent 選 None 後 200 |
| NOTE-04 | `zzDeepNote04.spec.ts`（`tick7/note04.log`）。MdHostile 預覽：script 0、iframe 0、on* 0、危險 href 0、fixed 覆蓋 0、details 1、u/mark/kbd 1、`window.__xss1..5` 皆未設定；未閉合 ```js 之後的表格、粗體、`[[`、數學全被當程式碼。MdTable 預覽 201 列、頁寬 1280 不溢出。MdLong（3,000 段）預覽可見 Paragraph 2999，末尾輸入 26 字 266ms。`_published` 後 POST /api/publish 201；匿名開 `/site/<slug>`：script 0、on* 0、無 XSS、無 dialog，但正文文字為「<script>window.__xss1=1</script> <img src=x onerror=…>」等原始碼，details／kbd 0（GAP-183）。公開頁表格 201 列、不溢出 |
| NOTE-01 | `zzDeepNote01.spec.ts`（`tick7/note01b.log`）。頂欄 Create new note→捕捉「頂欄新筆記 …\n第二行內容」：表單關閉、伺服器 1、開啟該標題；POST 403：表單仍開、保留「頂欄被拒 …」、伺服器 0、權限提示。Ctrl+Shift+N：同一捕捉表單，建立 1 篇。側欄 Create new node→Note：+1、標題 Untitled；改名「側欄改名 中文 …」後伺服器 1；403：+0、編輯器仍是前一篇、權限提示。Ctrl+K「指令面板新筆記 …」→ Create note：伺服器 1、開啟、面板關閉；403：面板開、查詢保留、伺服器 0、權限提示 |
| NOTE-13 | `zzDeepNote13.spec.ts`（`tick7/note13c.log`、`note13d.log`）。正文含上傳的 PNG（轉成 webp），編輯器末尾打「unsaved draft line」後立即匯出：`Exp <stamp>.md` 含草稿與圖片引用，伺服器正文尚無草稿；`.html` 含草稿、`<img src="http://localhost:5199/api/media/….webp">`、script 0、31,659 bytes；未登入 fetch 該圖 200（GAP-119）。PDF：popup 開啟、含草稿、print 呼叫 1 次。`window.open` 回 null：「Allow pop-ups to print this note to PDF」。`**/export-preview` 403：無下載、權限提示。離線 Markdown 下載成功；離線 HTML 無下載、「Could not reach the server…」。`clipboard.writeText` 拒絕：「Could not copy. Download Markdown from the note menu instead.」，More actions 選單仍開 |
| NOTE-02 | `zzDeepNote02.spec.ts`（`tick7/note02.log`），390×844 isMobile。debounce 1,620ms；Back to notes list 1,529ms；visibilitychange hidden 245ms。PATCH 503：伺服器無、編輯器有、「1 change(s) waiting to sync Sync now」、無提示；離線→上線 258ms 落地。PATCH 403：伺服器無、編輯器有、復原面板、權限提示；重載後伺服器無、復原面板含原文 |
| NOTE-05 | `zzDeepNote05.spec.ts`、`zzDeepNote05b.spec.ts`（`tick7/note05.log`、`note05c.log`）。CDP 組字：編輯器 92 字，伺服器＝編輯器＝預期、無 [a-z]；組字中按 Enter 的模擬結果為「筆記，好\n\n」，模擬保真度不足、不下結論。標題組字「新」「標題」後 Enter：`IME <stamp>新標題`。捕捉：組字「ji」時 Ctrl+Enter，表單關閉，存成「開會ji」。dispatch `keydown{key:Enter,keyCode:229,isComposing:true}`：側欄改名輸入「改名 zhong」→伺服器標題「改名 zhong」、輸入框關閉（GAP-184）；任務快速新增「任務 ren …」未建立、草稿保留；指令面板保持開啟、未建立 |
| NOTE-03 | `zzDeepNote03.spec.ts`、`zzDeepNote03b.spec.ts`、`zzDeepNote03c.spec.ts`（`tick7/note03k.log`、`note03c.log`、`note03j.log`）。核對完成後離線，等待 0.6／1.5／5 秒再捕捉，10 秒內工作區都沒有鎖住，上線後 0.3–0.6 秒的核對即解除（先前截圖的鎖住是測試結束恢復連線時的正常核對）。離線捕捉：網址有 node、`.cm-content` 0、標題 null；上線 8 秒後才顯示 `CapOff …`（GAP-185）。側欄 Create new node 離線 disabled；指令面板離線查詢沒有 Create note 列。合併：離線把 line1 改成 `line1 LOCAL`，API 把 line3 改成 `line3 REMOTE`，重連 10 秒後伺服器 `line1 LOCAL\nline2\nline3 REMOTE`、編輯器 `line1 LOCAL⏎line2⏎line3`；再離線改 line2「MINE」、API 改「THEIRS」，重連後伺服器 `line1 LOCAL\nline2 THEIRS MINE\nline3`（REMOTE 遺失，GAP-186），無提示、版本 2。401：伺服器 `auth start`、「1 Sync now」、「Sign in again…」×2；解除後離線→上線，伺服器 `auth start queued-under-401` |
| NAV-05 | `zzDeepNav05.spec.ts`、`zzDeepNav05b.spec.ts`（`tick7/nav05d.log`、`nav05c.log`）。觸發結果見 audit 列。Ctrl+N：`.create-node-box` 0、dialog 0、焦點仍在 BODY、筆記數不變。`press("?")`：事件 `key=? shift=false code=Slash`，說明表開啟；`press("Shift+Slash")`：說明表未開（GAP-187）。Ctrl+\：側欄 visible true→false。防誤觸：Ctrl+F 後輸入 `a?b`，值為 `a?b`、說明表未開；編輯器輸入 ` q?x` 後 Delete，仍在原筆記、說明表未開；面板查詢 `x?` 時 Ctrl+N 不建立；捕捉內容 `cap?` 時 Ctrl+Shift+D，表單仍開、內容保留 |
| NAV-01 | `zzDeepNav01.spec.ts`、`zzDeepNav01b.spec.ts`（`tick7/nav01.log`、`nav01b.log`）。9 個目的地網址：`view=notes`、`tasks`、`review`、`rss`、`notes&lens=canvas`、`graph`、`tags`、`website`；pageerror 0。打字後立即點 Tasks：伺服器含 `switch-draft`；回 Notes 標題與正文一致。GET 503：Reading「Reader Add feed {} All feeds…」、Review「Review {} Check again」（GAP-188）；Tasks、Tags、Site 顯示既有內容。新帳號註冊後首頁為「Choose where to keep your data…」 |
| NAV-03 | `zzDeepNav03.spec.ts`（`tick7/nav03.log`）。A（120 段＋末尾 `[[NavB]]`）預覽捲到連結（scrollTop 5,075）點擊→B、Back 可見；Back→A、預覽、scrollTop 0。Ctrl+K「NavC」Enter→C、Back 不可見。`?view=graph&node=B` This note 點 NavC→C、Back 不可見。重新開 A 後點 wikilink 到 B，瀏覽器 goBack 回到更早的 C（筆記切換不進瀏覽器歷史）。390px：wikilink→B、按鈕「‹ Back」→A |
| NAV-06 | `zzDeepNav06.spec.ts`（`tick7/nav06.log`），390×844 isMobile。分頁「‹ Notes, Content, Table, Canvas, Info」。打 DRAFT1 後 Info（屬性列可見）→ Content、Table → Content、Canvas → Content：DRAFT1 皆在、scrollWidth 390；History 無入口。高度 420：caretTop 392／innerHeight 420、可見。844×390：scrollWidth 844、編輯器可見、KBD 在。打 DRAFT2 後點返回清單：清單可見、伺服器含 DRAFT2 |
| NAV-07 | `zzDeepNav07.spec.ts`（`tick7/nav07b.log`，每次讀列前把虛擬清單捲到頂端；第一次未捲頂的結果作廢）。Order 前 8 列 `A…F, Alpha, Beta`；Title 以 `2026-10-07…2041-01-04, A …` 開頭；Modified 以剛建立的 `ZZLong …` 開頭；Created date 與 Order 完全相同；選 Title 後重新整理回到 Order 順序（GAP-190）。長標題列 187×32、標題 scrollWidth 大於 clientWidth、`text-overflow: ellipsis`、無 title；側欄 scrollWidth 239。可拖曳列 0。從第一列 Tab 25 次經過 page-button、delete-btn、group-toggle |
| NAV-09 | `zzDeepNav09.spec.ts`（`tick7/nav09c.log`，截圖 `toast-overlap.png`）。3 個任務依序勾選、PATCH 皆 403：toast 3 則、文字相同；dismiss 鈕中心點的元素不是該鈕（被 `.failed-write-recovery` 420,16 440×690 覆蓋），點擊逾時，8 秒後仍 3 則（GAP-191）。崩潰：`/api/tasks/agenda` 回 `{buckets:{today:[{title:{bad:1},due_date:42}]},count:"NaN",done:"nope"}`，編輯器打字後點 Tasks：整頁為錯誤邊界、伺服器已有草稿（GAP-192）；Reload 後錯誤畫面消失、Tasks 正常 |
| NAV-04 | `zzDeepNav04.spec.ts`（`tick7/nav04.log`）。每個動作都在新建的筆記（含 # H1／# H2、兩個 `- [ ]`、一個子筆記）上執行，紀錄面板是否關閉、網址、下載、新提示。動作結果見 audit 列；筆記／白板名稱列皆開啟對應筆記。Copy as Markdown 在無頭瀏覽器剪貼簿被拒，提示並保留面板。全工作區 zip／Markdown 匯出略過（大檔，屬 DATA）。`/api/search` 503：面板仍列本機筆記結果；離線：「Search is unavailable. Your query is still here. Try again」 |
| NAV-08 | `zzDeepNav08.spec.ts`（`tick7/nav08b.log`）。`body.onden-zen` 進入：true。Ctrl+K→Escape：面板關、zen 保留；More actions 開→Escape：選單關、zen 保留；在編輯器 dispatch `keydown{Escape,keyCode:229,isComposing:true}`：zen 退出（GAP-184）；一般 Escape：退出。指令面板 Create new sketch 後雙擊草圖右下：`document.fullscreenElement` 為 `sketch-node sketch-node--fullscreen`、Exit 按鈕可見，點擊後離開全螢幕 |
| DATA-03 | `zzDeepData03.spec.ts`（`tick7/data03c.log`；第一次以 `unzip` 讀取時因檔名過長失敗，改用 Python zipfile）。owner：200、1,476 檔、最長檔名 5,020 bytes（GAP-194）、attachments 8；`zipchild-….md` frontmatter 有 tags、無 parent／score；`zipparent-….md` 圖片為 `./attachments/….webp`；`canvas-<id>.md` 正文空白；無 ZipTask；有 `tag-ziptag….md`、`tag-ziplock….md`；含 `zipsecret`。editor：200、1,439 檔、無 zipsecret。指令面板 Download all notes → `onden-export.zip`；離線同一操作：無下載、無提示。390px More 選單項目無匯出 |
| DATA-08 | `zzDeepData08.spec.ts`（`tick7/data08c.log`；中途一次失敗是探測中延遲 20 秒的 route 在 unroute 後才 abort，已加 catch）。A：PATCH 403 → REJ 卡。B：PATCH 掛起時 Ctrl+S 後 0.6 秒重新整理 → 清單 `[UNCONF, UNCONF, REJ]`、伺服器無 B 文字；第二分頁同樣三張。點一張 UNCONF 的 Try again：清單 `[UNCONF, REJ]`、同步列「1 Sync now」；之後只看到 A 的 PATCH 200，B 在 10 秒內沒有 PATCH、伺服器無（GAP-195，佇列線上不重送同 GAP-126；`data08e.log` 以回應監聽確認，先前「沒有任何請求」的說法已更正）。A 再輸入 NEWER-A 成功保存，REJ 仍在。移除 REJ：本分頁 `[UNCONF]`；第二分頁仍 `[UNCONF, REJ]`，重新整理後 `[UNCONF]` |
| PER-05 | `zzDeepPer05.spec.ts`（`tick7/per05.log`）。diffLines：伺服器 `line1 A\nline2\nline3 B`、editorA `line1 A⏎line2⏎line3`、editorB `line1 A⏎line2⏎line3 B`。sameLine：伺服器 `line1 A\nline2 AA BB\nline3`（line3 的 B 此時已不在伺服器）、editorA `…line2 AA…`、editorB `…line2 AA BB…`。A 再加「A2」：伺服器 `line1 A A2\nline2 AA\nline3`（GAP-186）。stage：A 寫 fromA、B 寫 fromB → fromB。owner 欄位選擇器 0，拒絕回復未執行。刪除標籤後伺服器 tags 0、B 畫面仍有 chip |
| MEDIA-01 | `zzDeepMedia01.spec.ts`（`tick7/media01b.log`；51 MB 檔改用磁碟路徑傳入，Playwright 不接受 50 MB 以上的記憶體檔）。picker +1、取消 +0、paste +1、drop +1；huge.png（53,477,376 bytes）：+0、錯誤「HTTP 413」、5 秒後空白；corrupt.png：+0、「HTTP 500」、API 500；x.exe API 400；離線：+0、「Can't upload images while offline」；重載預覽 3 張 naturalWidth>0；390px 按鈕 69×44 |
| SKETCH-01 | `zzDeepSketch01.spec.ts`（`tick7/sketch01b.log`；第一次以鍵盤 r 選工具沒畫出圖形，改點工具列矩形）。元素數取自 `sketch_data`：等待 2 秒 1；第二框後 0.2 秒點 Tasks → 1（預期 2）；新草圖畫兩框（第二框後 0.2 秒 reload）→ 1、無復原；新草圖畫一框後 0.2 秒 goto 另一篇 → 0（GAP-197）。離線畫框：「1 change(s) waiting to sync」，上線 6 秒後 1。PUT 403：存的仍 1、權限提示、復原面板「This change was rejected…」、畫布仍在 |
| INK-01 | `zzDeepInk01.spec.ts`（`tick7/ink01.log`）。基準 1 筆；第二筆後 0.2 秒點 Tasks → 2；新筆記兩筆（第二筆後 0.2 秒 reload）→ 1、無復原（GAP-197）。Highlighter＋Color 第 3 鈕＋Size 最後一鈕：`toolId highlighter, color #315f8f, size 7`。Pen 第二筆後 Ctrl+Z → 1、Ctrl+Shift+Z → 2。PUT 403：仍 2、權限提示、復原面板。離線：「1 change(s) waiting to sync」→ 上線 6 秒後 1 |
| SKETCH-01（tick 8，→已盤） | `zzDeepSketch01b.spec.ts`（`tick8/sketch01b.log`）：雙擊畫布 → `document.fullscreenElement` 為 `.sketch-node--fullscreen`、同時出現 `textarea.excalidraw-wysiwyg`，打「hi」後存 1 個元素（GAP-228）；Escape 只結束文字編輯，Exit 鈕退出全螢幕。兩框 → 2；Ctrl+A、Delete → 0；Ctrl+Z → 2；Ctrl+Shift+Z → 0；重載後 Ctrl+Z 仍 0。API 灌 3 000 矩形（1.19 MB）：開啟 1 415 ms、畫框 369 ms、存 3 001，PUT 1 473 618／1 474 140 bytes 皆 200；15 000（5.97 MB）：1 924 ms、430 ms、15 001，PUT 7.41 MB×2 皆 200，無吐司、無復原面板。`zzDeepSketch01c.spec.ts`（`tick8/sketch01c.log`）：只開三次不編輯 → 3 個 `sketch_data` PUT（642 bytes），存值 450→507 bytes（GAP-229） |
| INK-03（tick 8，仍部分） | `zzDeepInk03.spec.ts`（`tick8/ink03c.log`；第一次以 `p` 切筆模式時筆模式已從上一張白板帶過來被關掉，改為工具列不在才按；第二次把無 ink 的一般筆記當對照，非手寫筆記，排除）。筆記／PDF × {無法解析、`{"version":1}`、空字串}：皆開成空白頁、無錯誤、無提示，畫一筆後存 `doc:1`／`pdf:1`。白板：對照、無法解析、空字串可畫並存 1 筆，但開啟即有吐司「This canvas is not available on this device…」（GAP-231）；`{"version":1}` → `.app-error-boundary`「Something went wrong」，重開仍是（GAP-230）。保存 500：白板／PDF 第二筆後伺服器仍 1 筆、無吐司、無復原面板、同步列「1／2 Sync now」，取消攔截 8 秒後仍 1，重開後 2（PDF 畫面 2 條 path） |
| MEDIA-02（tick 9，→已盤） | `zzDeepMedia02.spec.ts`（`tick9/media02b.log`；第一次用的 2×2 PNG base64 無效，sharp 500，改用有效的 1×1 PNG）。GET：200、`image/webp`、`Cache-Control: public, max-age=31536000`、`Vary: Origin`。B 頁面 Image＋fetch：上鎖前 1px／200；上鎖後 API 404、頁面 1px／200，重載後仍 1px／200（GAP-232）。上鎖筆記唯一引用：B 404、匿名 404；移到垃圾桶後 B 200、匿名 404。上鎖筆記把圖刪出正文：404 → 200（GAP-233）。上鎖＋公開筆記共用 → 200；上鎖節點屬性 `cover` 引用 → 404；未嵌入的新上傳 B 200、匿名 404。`.txt`：`text/plain; charset=utf-8`、無 Content-Disposition、網址為隨機名（GAP-234）；假 docx 200；HTML 內容的 `.png` 500 |
| INK-03（tick 9，→已盤） | `zzDeepInk03b.spec.ts`（`tick9/ink03b.log`）。歷史頁 Recent Events：筆記「drew 1 stroke／drew 1 stroke／erased 1 span／undid 1 stroke, restored 1 erased span」、白板相同、無 `ink_data = {`；PDF 4 筆皆「drawing updated (1 KB)」，`ink-versions` 200（GAP-235）。複習卡：擦掉 s0 的手寫筆記 `.review-ink-thumb` 1 條 path；帶 2 筆手寫的 PDF 卡無縮圖、「This note is empty.」 |
| PER-06（tick 10，→已盤） | `zzDeepPer06.spec.ts`（`tick10/per06b.log`；第一次用 `unzip -l` 遇長檔名警告非零退出，改以 Python zipfile 讀）。匿名：未發布筆記的圖 200、節點 401、站點不含；發布頁 → 頁面在、上鎖筆記標題／正文皆不在、圖 200；上鎖 → 頁面不在、圖 404；解鎖並取消發布 → 頁面不在、圖 200（GAP-236）。B：zip 200，不含上鎖筆記檔與其圖、宿主不含上鎖正文；`export.html` 200 不含上鎖正文（標題命中是宿主自己寫的 `[[…]]` 文字）；`export-preview` 200 不含；讀上鎖圖 404。`DELETE /api/actors/:id` 200 後 B 舊 session 讀圖 200、讀筆記 200（GAP-237，`index.ts` 身分解析自動建立 actor） |
| SITE-01（tick 11，仍部分） | `zzDeepSite01.spec.ts`（`tick11/site01*.log`；前幾次以 `.first()` 選到隱藏的手機「New page」、`/api/nodes?q=` 不存在、列表未等載完，均為探測問題）。`zzDeepSite01c.spec.ts`（`tick11/site01c3.log`）：閒置 10 秒 `.puck-left-panel` 出現 4 個不同元素；真實雙擊後輸入框取樣 `[1,1,0,…]`，3 秒後面板已換新（GAP-238）。`zzDeepSite01b.spec.ts`（`tick11/site01b5.log`）：長標題 202 字存 202、slug 182 字；`site01d.log` 刪頁送出 `PATCH /api/nodes/:id`，列表移除、`GET` 200；以同一寫入 `PATCH {hidden:true}` → hidden true、deleted_at null、不在垃圾桶、指令面板找得到 1、側欄 0（GAP-239）；刪除首頁 → `home_node_id` null、站點無首頁內容。第一個 POST abort：對話框關、清單 1、「1 Sync now」，20 秒內 POST 次數仍 1，重載後清單 1、伺服器建立 1、無復原面板。slug 由 `websiteWriter.renamePage` 的 ASCII 規則產生（GAP-240，程式碼） |
| SITE-09（tick 12，→已盤）／SITE-03 | `zzDeepSite09b.spec.ts`（`tick12/site09b3.log`；前兩次點到隱藏的手機 Design 鈕與用錯確認鈕文字，探測問題）。Design 分頁 Upload：logo PNG → 200、存 `.webp`；favicon `.ico` → 400、無吐司；favicon PNG → 200。四版型各：「Website changes saved」、對話框「28 notes will go public」、publish 201。匿名 `/site/`、`/site/<slug>`：quartz-garden 文章 h1 1；clean-docs 文章 h1 0、內文從「Section」開始；personal-blog 文章 h1 1；landing-hub 首頁 h1 1、文章 h1 0（GAP-241）。四版型 390px overflow 0；`link[rel=icon]` 皆為上傳的 webp；favicon、logo 匿名 GET 200 |
| SITE-02（tick 13，→已盤） | `zzDeepSite02.spec.ts`（`tick13/site02.log`）：7 欄填入、「Website changes saved」、重載後 0 欄不符。Tagline A → 伺服器 A；另一請求 PATCH tagline B 200；8 秒後欄位仍 A；改 Site name 後伺服器 tagline A、brand 新值（GAP-243）。PATCH 403：狀態「Website changes not saved Retry saving」、吐司「You don't have permission…」、復原面板「This change was rejected…」、伺服器維持；解除後 Retry → 1 個 PATCH、saved、伺服器為被拒的值；下一次編輯正常保存。`zzDeepSite02b.spec.ts`（`tick13/site02b.log`）：0.2 秒後切 Edit＋點頁 → 已存；切 Notes → 已存；reload → 未存、復原面板保留 |
| SITE-05（tick 14，仍部分） | `zzDeepSite05.spec.ts`（`tick14/site05.log`）。PATCH config `custom_css` = `body{…}</sty</stylele><script>window.__cssEscape=<stamp></script><style>` 200、原樣保存；publish 201；匿名 `/site/` 與文章頁 `window.__cssEscape` 皆為 stamp（GAP-244）；擁有者造訪文章頁亦執行，頁內 `fetch("/api/actors")` 200；`export.html` 含 `</style><script>…`；`export-preview` html 含 script。無效 CSS → 文章頁 200 且正文在。60 000 字 → PATCH 200、存 59 994。textarea 顯示 `.site-root h1{…}`。測後還原原 CSS 並重新發布 |
| SITE-03（tick 15，→已盤） | `zzDeepSite03.spec.ts`（`tick15/site03b.log`；第一次以 `/api/snapshots` 讀快照版面，該端點不回 payload，探測問題，改讀 `/api/site`）。Cancel：template clean-docs、標記版面保留；確認 Personal Blog：template personal-blog、blocks `site_nav, blog_list, page_meta, markdown_body`、標記消失；重載 active 卡 Personal Blog；連切 → landing-hub 與其 5 塊一致。先以標記版面發布，再切 Quartz Garden 不發布：`/site/<slug>` `data-template="quartz-garden"` 且仍含標記（GAP-245），`/api/site` presentation template quartz-garden、blocks `callout, markdown_body`。空版面：造訪 Studio 後仍 0 塊；點 Clean Docs 不跳確認、套成 5 塊；發布空版面 → 0 塊、文章頁 200 含正文。舊安裝：chrome `{}`、快照含標記 → Studio Publish 後快照仍為 `callout, markdown_body`。測後還原 template／chrome、刪除測試筆記並以原版面重新發布 |
| SITE-05（tick 15，→已盤） | `zzDeepSite05b.spec.ts`（`tick15/site05b.log`、`out/…/design-390.png`、`design-320.png`）。存檔：accent `#b3402f`、site_bg `#f5f1e8`、font serif、locale ja、darkMode true、allow_indexing false、plausible＋`s05b-<stamp>.example.com`、custom_css 完整；重載後 active 為 Rust／Paper、各 select／toggle／輸入相符。Tab 切換後 CSS 相符。預覽 `.site-root`：clean-docs、`site-root font-serif site-dark`、accent／bg 同上；公開頁同值且 `lang=ja`、robots noindex、有 plausible script。預覽開啟時 `.studio-preview-btn` outline `rgb(41,38,32) 3px` → `rgb(1,2,3) 7px`，關閉後還原（GAP-246）。390／320：`scrollWidth` = 視窗寬、溢出元素 0。預覽首頁未顯示測試筆記標題（顯示首頁內容），未用於判定節點集合。測後設定還原（原本不存在的鍵以 null 移除）、測試筆記刪除 |
| SITE-04（tick 16，→已盤） | `zzDeepSite04.spec.ts`（`tick16/site04e.log`）、`zzDeepSite04c`（手機 Fields，`site04p.log`）、`zzDeepSite04d`（drawer 拖曳與重排，`site04drag2.log`）、`zzDeepSite04e`（遠端版面，`site04e-remote2.log`）、`zzDeepSite04f`（hydration 基準，`site04f.log`）。探測問題（不登錄）：action bar 按鈕 `visible=0`（後查為 CSS 隱藏 → GAP-248）；最初拖曳以 `.first()` 抓 drawer 項目且未先 hover，拖不動，改 hover＋按住 300 ms 後新增成功；手機第一次點「Fields」的定位器沒點到，改點文字後可編輯；一次重載後 main dropzone 量不到（頁面仍在換版面）。公開站：missing 只有不支援 media 的兩個 caption（預期隱藏）；`__s04` null；iframe `youtube-nocookie … sandbox=allow-scripts allow-presentation allow-popups`；pageerror 含 React #418、YouTube iframe 的 caches／writeEmbed 錯誤（iframe 自身）。Edit：editTitle `B-<stamp>`；Delete 鍵後 `header:site_nav, main:markdown_body, footer:footer`；undo 後 callout 回到伺服器；拖曳新增後 main 2 個 callout；重排後伺服器 id 順序與畫布一致；500 → 「saved locally」、`failServer` false，重載後 `serverAfterReopen` true。遠端版面：L1 開啟 → API 寫 L2 → 8 秒後、重載兩次畫布仍為 L1；伺服器 L2；改 Title 後伺服器變成 `L1(EDIT)`＋footer（L2 的 callout 與 cta 消失）；再次進入畫布為 L2，而 `/api/bootstrap` 與伺服器皆為 L1(EDIT)（GAP-247）。測後還原 chrome、刪除測試筆記並以原版面重新發布 |
| SITE-01（tick 17，→已盤） | `zzDeepSite01d.spec.ts`（`tick17/site01d*.log`；第一次以 Playwright `dblclick` 試 4 次輸入框都沒出現〔GAP-238 重掛〕，改在一個 `page.evaluate` 內派送 dblclick、設定值並送 Enter）。`route` 讓 `PATCH /api/nodes/:id` 回 403。改名：toast 1 則、清單 `S01r <stamp>`、伺服器標題不變、復原卡含 `S01r <stamp> R`。刪除：toast、列數 1、hidden false、復原卡含 `{"hidden":true}`；重載後列與復原卡仍在。390 px：toast、列數 1、該列沒有改名控制。取消攔截後改名為 `中文頁 <stamp>` → slug `中文頁-<stamp>`（原 `s01r-<stamp>`）；再改為純中文，請求 body `{"title":"純中文標題測試住","slug":"untitled"}`，伺服器 slug `純中文標題測試住`（GAP-240 更正）。測後刪除測試筆記 |
| CAN-09（tick 18，仍部分）／GAP-249 | `zzDeepCan09b.spec.ts`（`tick18/can09b2.log`；第一次用本輪新建的 13 篇，正文隨同步到達，未走 slim 路徑，改用既有 slim 筆記）、`zzDeepCan09c.spec.ts`（`tick18/slimtraffic*.log`）。白板 13 卡、開啟時逐篇 GET 0；500／404／斷線／乾淨×2 五次匯出：`fetchedDuringExport` 0、皆下載、13／13 正文。冷啟動流量：39 個 API 回應共 4 825 353 bytes；`POST /api/sync` 的 `since` 依序 0, 500, 1003, 1570, 2070, 2570, 3070, 3594, 4094, 4594, 5094, 6104, 6266，回應內 `"markdown":"…"` 合計 2 357 個；`/api/bootstrap?bodies=none` 頂層鍵無 `last_event_id`／游標。白板測後刪除（筆記為既有資料，未改動） |
| HIST-09（tick 19，→已盤） | `zzDeepHist09.spec.ts`（`tick19/hist09c.log`；第一次以事件 API 找事件，已刪節點的事件被讀取政策過濾、`value_type:"string"` 不合法、`POST /api/nodes` 不能建 class_tag，均為探測問題；改以 `docker exec psql` 讀 `domain_events`、`/api/tags/resolve-path` 建標籤）。支援類型：原事件 6281/6283/6286/6288/6291/6294/6296 → 新事件 6282 NODE_UPDATED、6284 NODE_DELETED、6287 NODE_UNDELETED、6289 ATTRIBUTE_DELETED、6292 TAG_REMOVED、6295 TAG_APPLIED、6297 TAG_UPDATED，皆 trig＝from＝原事件、actor e879dda3。undo-the-undo 200；再復原原事件 409 already_in_state。不支援：EDGE／CANVAS_UPDATED／SITE_CONFIG_UPDATED 422、0 新事件；PUBLISH 409 external。衝突 merge（6308）cascade：409 state_conflict「cascade event 6310 …」、0 新事件。完整 merge（6360）cascade：200、`TAG_APPLIED:ok`、6362 NODE_UNDELETED trig 6360、6363 TAG_REMOVED trig 6361；DB 中 m3 只剩 `h09a…` |
| UX-01（tick 20，→已盤）／GAP-250 | `zzDeepUx01.spec.ts`（`tick20/ux01.log`，截圖 `out/…/{1280,390,320}-longnote.png`、`*-slow-*`、`*-fail-*`）、`zzDeepUx01b.spec.ts`（`tick20/ux01b2.log`）。read_later、citations、history、trash、settings 不是 URL 檢視（落回 notes），不計入矩陣。24 格與 3 個長筆記：docScroll＝vw、cut 0。slow：2.5 秒時只有「Onden」、14 秒時正常。fail：早期即顯示清單與「1 change(s) waiting to sync」。GAP-250：失敗期間 0 個寫入請求，「Sync now」後仍 1 筆；重載後送出 `POST /api/nodes {"id":"d51d4d6c…","title":"2026-10-09",…}`，今日筆記 1 → 2（event 6366）；測後以 API 刪除該重複筆記，回到 1 |
| SYS-03（tick 21，仍部分） | `zzDeepSys03.spec.ts`（`tick21/sys03c.log`；前兩次在情境 C 被前一情境的復原面板擋住點擊，且 B 的捕捉掛在已被拒的 A 底下，均為探測問題）、`zzDeepSys03b.spec.ts`（`tick21/sys03detail.log`：離線捕捉的 `parent_id` 是前一筆捕捉）。A：`POST → 403`、`POST → 404`，復原卡含 `S03A …` 與 `parent not found S03B …`，serverA 0、serverB 0。B（父層 S03P）：`POST ✗ ERR_CONNECTION_RESET`、`POST → 200`，serverC 1。C：`PATCH → 401` ×2、pending 1、recovery 0；解除後 pending 0、伺服器含 `offline-401-<stamp>`。測後刪除所有測試筆記 |
| SYS-03（tick 22，→已盤）／GAP-251 | `zzDeepSys03c.spec.ts`（`tick22/sys03c.log`）、`zzDeepSys03d.spec.ts`（`tick22/sys03d-keep{1,0}.log`）。D：離線 pending 1 → 重連 pending 0、伺服器父層 `S03 P2`。E：離線 pending 2；DELETE P3 200；重連後 pending 0、復原卡 `parent not found {"parent_id":"c6ccd96f…"}`、伺服器父層 `S03 P1`、正文含 `offline-edit-<stamp>`、選單顯示 P1。F：兩分頁 pending 各 1。KEEP_TAB1=1：n1Landed t、n1Events 1；分頁 1 關閉（兩次）：n1Landed f、重載後 f、recovery 0、n1Events 0，n2Landed t。測後刪除測試筆記 |
| SYS-02（tick 23，仍部分）／GAP-252 | `zzDeepSys02.spec.ts`（`tick23/sys02b.log`；第一次 applyTag／removeTag 用了 `node_id`／`tag_id`，工具參數是 `nodeId`／`tagId`，400 為探測問題；Playwright 會把字串 `data` 再編碼成 JSON，壞 JSON 改用 curl 驗）。curl：`{not json` 與空本文 → 400 malformed JSON body；`[1,2]`、`"str"` → 200 回傳整篇節點；POST 同樣輸入 400。DB：該測試節點 6448、6449 兩筆 NODE_UPDATED，payload 與 6447 建立時相同 body_hash（GAP-252）。agent createNode 的 403 來自 `createNode.ts:88` `AuthorityError("workspace", "parent is not available in this workspace")`。測後刪除節點、標籤與 agent actor |
| SYS-02（tick 24，→已盤）／GAP-253 | `zzDeepSys02b.spec.ts`（`tick24/sys02b.log`、`sys02b2.log`、截圖 `out/…/outage.png`）。兩輪皆 `docker inspect` 後端 `exited exit=1`；`docker logs`：最後一筆 `[http] GET /api/inbox/approvals 200` 後 `node:events:497`、`error: terminating connection due to administrator command`、`Emitted 'error' event on BoundPool instance`。中斷：GET／PATCH 逾時 20 s，POST、agent、session、health 502（nginx HTML）；pending 1、toast 0、recovery 0。第二輪手動 `docker start` 後端：recoveryGets 502, 502, 200；after pending 0、bodyLanded t、outageCreates 0；重載 editorHas true。另：後端 log 有較早的 `[unhandled] invalid input syntax for type uuid: "undefined"`（`tagMembershipWrites.js:38` ← `routes/nodes.js:943`），未造成崩潰、來源請求未定位，未登錄。測後刪除測試筆記與 agent |
| SYS-02（tick 25）／GAP-254 | 來源：tick 24 後端日誌的 `[unhandled] invalid input syntax for type uuid: "undefined"` 是 tick 19 第一輪 HIST-09 探測（標籤建立失敗、tagId 為 `undefined`）送出的 `PUT／DELETE /api/nodes/49d76c79…/tags/undefined 500`。curl（`tick25/malformed-uuid.txt`）以 `not-a-uuid`：PUT／DELETE node tags 500 internal；PUT `/api/nodes/not-a-uuid/tags/<id>` 404 tag not found；PATCH／DELETE node 500；GET／PUT attributes 500；GET／PATCH canvases 404；GET／PATCH tags 500；POST nodes parent_id 400；events target_id 200 空；versions 404；POST edges 400；1 分鐘內新增 8 筆 `[unhandled]`。測後刪除探測筆記 |
| PER-04（tick 25，仍部分）／GAP-255 | curl（`tick25/per04-cursors.txt`）：11 種 since 的狀態碼、`last_event_id`；超前游標漏事件：max 6 482 → 建立筆記（6 483）→ since 6 482 回 6 483 且含該筆記，since 6 532 回 6 532 且不含。解析位置 `routes/sync.ts` 389、399 行（`parseInt`／`typeof === "number"`）。測後刪除探測筆記 |
| PER-05（tick 26，仍部分） | `zzDeepPer05b.spec.ts`（`tick26/per05b2.log`、`per05b3.log`；第一次以 input 定位屬性列失敗——Extra fields 要點值才出現 `input.attr-input--value`，探測問題）、`zzDeepPer05c.spec.ts`（`tick26/per05c2.log`）。拒絕：afterB server `{k1:b1,k2:b0}`、A 顯示 k1 a0（未即時更新）；afterRefusal server 不變、A_k2 `editing:a2`、toast 1、recovery 1、B_k2 b0；重載 A `{k1:b1,k2:b0}`。即時：boot 14 次 sync；title／body 變更後 `{since:6521}`→last 6522 hasNote true、`{since:6522}`→6523 hasNote true，畫面 40 次輪詢未變；property 570 ms（body 文字含 v-remote）；新建另一筆記 20 秒內側欄找不到（清單可能虛擬化，不採用）。Per05b 的 propertyDelayB 45 秒 null。標籤 chip 選擇器在套用前就命中（chipBefore 1），不採用 |
| SYS-06（tick 27，→已盤） | `zzDeepSys06.spec.ts`（`tick27/sys06b.log` B、`sys06c.log` A、`sys06d.log`＋`sys06-approval.txt` C；fixture `tick27/fixture/server.mjs` 加 `/lateslow.xml`）。探測問題：慢 feed 直接訂閱時訂閱本身同步抓取而逾時、欄位是 `source_node_id`、120 秒視窗太短（該列 attempts 2 後於 2 分 45 秒 done）、approvals 回應包在 `approvals` 鍵、標籤名在 `payload.pack.name`。A：10805 pending → 重啟 → 17 s done、staged 1、fixture hits 3。B：初始 4、重啟後 refresh 200×2、staged 4、distinct guid 4。C：propose 200 pending_approval；重啟前後 10807 pending_approval、標籤 0；approve 200 → done、標籤 1、事件 6541 TAG_IMPORTED；再 approve 404。測後刪除來源、標籤與 agent |
| SYS-01（tick 28，→已盤） | `zzDeepSys01.spec.ts`（`tick28/sys01.log`；猜錯的表名 sidebar_pointers／node_tasks／canvases／collection_schemas 改為 note_pointers、content_nodes＋node_attributes、node_positions；「collection create」判 CHECK 是因標籤名被轉小寫 `s01col…`、比對大小寫敏感，DB 確認 id b9a4712e 為 class_tag、事件 6552 COLLECTION_SCHEMA_CREATED）。22 列逐列 status／事件類型／狀態是否改變見日誌。測後刪除白板、集合、任務、匯入與測試筆記 |
| SYS-04（tick 29，→已盤） | `zzDeepSys04.spec.ts`（`tick29/sys04.log`）。A：dropped 1、重載前 server 1、捕捉框已關；重載後 server 1、pending 0、recovery 0（筆記在父筆記 S04 parent 底下，清單頂層看不到，非缺陷）。B：dropped 1、重載前伺服器出現 1 次；重載後伺服器 1 次、編輯器 1 次、pending 0、recovery 0、衝突副本 0、NODE_UPDATED 1。測後刪除測試筆記 |
| PER-01（tick 30，→已盤） | `zzDeepPer01.spec.ts`（`tick30/per01.log`）。B 以 sign-up 取得 session，owner `POST /api/actors` 綁 external_id、role editor。每次 owner `PATCH /api/actors/:id` 之後立即用 B 的同一 session 呼叫：editor 寫 200 landed；viewer 寫 200 landed、讀 200、建立 403；editor 寫 200；scope=[T]：寫 403 landed=false、讀 404；套 T 後寫 200、讀 200；scope=null 寫 200。NODE_UPDATED 依序 v1、v2、v3、v5、v6（v4 被拒無事件）。測後刪除 actor、筆記、標籤 |
| PER-02（tick 31，→已盤）／GAP-256 | `zzDeepPer02.spec.ts`（`tick31/per02.log` 矩陣、`per02b.log` 細節）。B 欄：GET O 200:O、P／C／D 404；子路由 403（不存在 ID 也是 403，GET 皆 404）；search 200:O；bootstrap 200:O；events target P 0 筆；trash 200:-；markdown.zip 200:-（owner 亦未匹配，壓縮內容不可直接搜尋，不採用）；agent getNode `result:null`、searchNodes O。sync：D 的 ID 只出現在 ID 陣列內、無標題。canvas：`data.nodes` 含 P 的 nodeId、無標題／正文。`/api/query` 400 為探測 payload 格式錯。測後刪除白板、筆記、標籤、actor |
| PER-03（tick 32，→已盤） | `zzDeepPer03.spec.ts`（`tick32/per03d.log`；前三次 B 畫面空白／停在儲存選擇：新帳號首次載入需按「Use browser storage」，`isVisible({timeout})` 不會等待而沒點到，探測問題；`tick32/dbg*.log` 為除錯紀錄）。N1：開著時標題 `Per03 N1 <stamp>`、正文在；加鎖後 1 089 ms 消失、gate 出現 1 次、GET 404。N2：離線 pending 1；加鎖、重連 12 秒：serverHasEdit t、畫面無 N2、recovery 0、pending 0、toast 0。重載：N1／N2／正文皆不在。測後刪除筆記、標籤、actor |
| ACC-05（tick 33，仍部分）／GAP-257 | `zzDeepAcc05.spec.ts`（`tick33/acc05.log`、`out/…/phone-setup.png`）。abort：stillOnSetup、alert null、pref []；security 與 badhandle：stillOnSetup、alert「Could not reach the server…」、按鈕可用、pref []；選瀏覽器後 setup 消失、pref `opfs`、重載 setupAgain false；390 px 按鈕 316×93、scrollWidth 390；同瀏覽器另一新帳號 setupShown true。測後刪除三個 actor |
| ACC-05（tick 34，仍部分）／GAP-258 | `zzDeepAcc05.spec.ts`（第二個 test，`tick34/acc05f.log`、`acc05f2.log`；`tick34/opfsq.log`：OPFS handle `queryPermission` = granted、可寫入 1 byte，排除權限探測問題）。existing：stillOnSetup、alert 為「This folder already contains an Onden backup…」。empty：setup 消失、pref `fs-access`、folderFiles []；輸入後 5～60 秒 12 次檢查皆 []；重載 setup false、標題 `2026-10-09`。程式：`useAppData.ts:42-48` 的 `scheduleUserFolderSync`（2 秒去抖、`.catch(() => null)`）；`draftActions.ts:24-28` 與 `domainWriters.ts:13` 傳入 `scheduleUserFolderSync: () => {}` |
| ACC-05（tick 35，仍部分）／GAP-258 細化 | `zzDeepAcc05.spec.ts`（`tick35/acc05g2.log`、`acc05g3.log`；第一次重載後 `window.__lastDir` 遺失，探測問題，改由測試端保存資料夾名）。g2：設定後 60 秒空、重載後輸入 30 秒空、改標題 30 秒空。g3：設定後 60 秒空、重載後輸入 5 秒內出現 `onden.sqlite3:15994880`。結論：第一個工作階段一律不寫；之後依其他 dataCtx 寫入順帶觸發 |
| ACC-02（tick 36，→已盤）／GAP-259、260 | 空 stack：`docker compose -p onden-e2e-acc02 -f compose.e2e.yaml -f tick36/compose.acc02.yaml up -d --build`（:5299）。`zzDeepAcc02.spec.ts`（`tick36/acc02.log` 第一次：自建帳號在 global-setup 的 E2E 之後註冊而成為 viewer，探測問題；`acc02b.log` 以 e2e-owner 重跑）：firstBootstrap role admin、eligible false、nodes 2；首次開啟 3 篇（Site Config、workspace-config、2026-10-09）、作者 1 個 user；重載 3、第二瀏覽器 3；刪光後原瀏覽器 2、新瀏覽器 3；同時兩個乾淨瀏覽器 → 4 篇、`2026-10-09` ×2。`tick36/acc02-config-wipe.txt`：owner 設定 200、viewer 刪兩個系統節點 200、viewer PATCH 403、設定變 None |
| ACC-08（tick 37，→已盤） | `zzDeepAcc08.spec.ts`（`tick37/acc08.log`、`out/…/offline-cold.png`）。A：online 正文在；SW `http://localhost:5199/sw.js`；離線 reload `loaded`、畫面只有登入狀態訊息與「Retry connection」、editorHasBody false；恢復後 true。B：serverHasEdit true；延遲中 editorHasEdit false（清單已顯示，編輯器尚未開該筆記）；延遲後 true。測後刪除筆記 |
| ACC-04（tick 38，→已盤）／GAP-261 | `zzDeepAcc04.spec.ts`（`tick38/acc04b.log`、`out/…/bad-server.png`；第一次 Save 定位到編輯器的 Save 鈕，探測問題）。pendingBefore 1；欄位初值空；存入後 localStorage `http://127.0.0.1:9`、對新位址請求 0；重載後畫面只有登入狀態訊息與「Retry connection」、settingsReachable 0；手動清 localStorage 並解除攔截後 pending 0、伺服器有 `pending-<stamp>`、recovery 0。程式：`BuilderApp.tsx` 143-156、`lib/api.ts` 328-356、`settings/registry.tsx` 761-781 |
| DATA-05（tick 39，→已盤） | `zzDeepAcc05.spec.ts` 第三個 test（`tick39/data05.log`、`data05b.log`、`out/…/revoked-settings.png`；第一次點「Data」分頁名稱不符，實際為「Your Data」）。setupPref `fs-access`；以 init script 讓 `FileSystemHandle.prototype.queryPermission／requestPermission` 回 denied 後重載：workspaceLoaded true、setupShown false、toasts []、pref 仍 `fs-access`、pageerror 0；Your Data 分頁只有 EXPORT／IMPORT |
| DATA-01（tick 40，仍部分）／GAP-262 | `zzDeepData01.spec.ts`（`tick40/data01.log` 路徑與 1 500 檔 vault；`data01b.log` 修正查詢後的 frontmatter、3 MB、嵌入與 60 檔 vault——第一次以 `# 標題` 查詢，實際標題取檔名，探測問題）。正文 hashtag 對照：`POST /api/nodes`、`PATCH` 帶 `#htc…`／`#htp…` 皆 0 個 node_tags、無同名標籤節點。60 檔 vault 的 wikilink 指向 `V… ` 標題而筆記標題是檔名 `n…`，edges 0 為測資問題、不採用。測後刪除全部匯入筆記與資料夾 |
| DATA-02（tick 41，仍部分） | `zzDeepData02.spec.ts`（`tick41/data02.log`）：first imported 2、folders 1；unchanged 2；rename imported 1／unchanged 1 → 標題 a、a2、b；move imported 1、folders 1 → 多出 b@sub；conflict skipped 1、`local_changes`、正文仍為 LOCAL EDIT；csvAgain 全 0、alpha／beta 列 2；partial unchanged 1、清單不變；upsert 無來源 400「Choose an import source before updating notes」。測後刪除 9 個節點 |
| DATA-08（tick 42，→已盤） | `zzDeepData08b.spec.ts`（`tick42/data08.log`）。**注意**：本輪新探測最初以 `zzDeepData08.spec.ts` 寫入，覆蓋了 tick 7 的同名未提交探測檔（舊檔無法復原；其結果仍在本文件 DATA-08 列與 `tick7/data08c.log`），已改名為 `zzDeepData08b.spec.ts`。patchStarted 1；重載後 1 張 UNCONF 卡、伺服器已有文字；401 下 Try again：patchesSent 0、cards []、toasts []、pending 1；解除後 Sync now：patchesSent 1、pending 0、server true；再重載 cards []、pending 0 |
| DATA-06（tick 43，仍部分） | `zzDeepData06-crossbrowser.spec.ts`（檔名符合 `CROSS_ENGINE`；`tick43/data06-{chromium,firefox,webkit}.log`）。chromium／firefox：basic server+editor true；wiped `["onden-storage"]`；afterWipeEdit server true、toast 0；afterWipeReload editor true；pendingBeforeWipe 1 → afterWipeOnline server true、pending 0；afterWipeOnlineReload recovery 0；afterInterrupted 標題與正文正常；pageErrors []。webkit：`browserType.launch: Host system is missing dependencies` |
| DATA-07（tick 44，→已盤） | `zzDeepData07.spec.ts`（`tick44/data07.log` 桌面／手機、`quota.log` 覆寫生效驗證、`data07r.log` 離線重載）。quota.log：兩種 origin 寫法皆 `idbWrite: abort QuotaExceededError`、estimate 不變。data07：桌面 offline pending 1 → 上線 pending 0、serverHasOffline／Online true；手機同（手機離線時 pending 顯示 0）。data07r：beforeReload pending 1、toast 0、recovery 0、console 0；離線重載顯示登入檢查畫面；恢復後 serverHasEdit true、editorHasEdit true |
| DATA-04（tick 45，仍部分）／GAP-263、264 | `zzDeepData04.spec.ts`（`tick45/data04*.log`；第一次在離線時才開設定而 App 崩潰——即 GAP-263，`zzDeepSettingsOffline.spec.ts`／`settings-offline{2,3}.log` 證實設定與任務畫面離線首次開啟皆 `Failed to fetch dynamically imported module`；之後改為上線時先載入設定）。`zzDeepData04Confirm.spec.ts`（`tick45/confirm.log`、`out/…/confirm.png`）：按鈕 count 1、visible true，但 elementFromPoint 為「Export subscriptions (.opml)」、settings z 9000、confirm z 300，點擊被攔截；畫面「Importing…」。data04b／c 中「已還原」的結果實為還原未發生（Overwrite 點擊逾時），不採用 |
| DATA-01（tick 46，→已盤）／GAP-265 | `zzDeepData01Notion.spec.ts`（`tick46/notion.log`、`notion2.log`；第一次集合查詢 SQL 的 JSON 轉型寫錯，探測問題）。回應：imported 2、folders 2、collections_imported 1、collection_rows_imported 2、bodies_attached 2。節點：`Child Page … aaaa…2 @Home … aaaa…1`、兩個 `Home … aaaa…1`（一個在 Export 下為資料夾、一個為頁面）、`tasks-db-<stamp>`、`Write report`、`Review`。Home 正文：連結原樣、圖片 `/api/media/d4019…png`；edges 0。列屬性 `Due=October 10, 2026`。測後刪除 7 個節點 |
| ACC-06（tick 47，→已盤） | `zzDeepAcc06b.spec.ts`（`tick47/acc06b.log`、`acc06b2.log`）。登出後 writes：`{"config":{"tagline":"tagline-<stamp>"}}` → 401；B：recovery []、bodyHasMarker false、pending 0、SITE_CONFIG_UPDATED 事件 0；owner 重新登入：同一 PATCH → 200、taglineField 與伺服器皆為 marker、pending 0。測後還原 tagline、刪除 B actor |
| ACC-05（tick 48，→已盤） | `zzDeepAcc05b.spec.ts`（`tick48/acc05w*.log`，`WASM_DELAY` 0 與 8000）。兩者 atTypeTime：gate true、inert true、focusedEditor false、contentEditable "true"；textShownRightAway false；15 秒後編輯器、伺服器、重載後都沒有輸入；toast 0、復原卡 0、pageerror 0。editorReadyMs 3 422（不延遲）／11 070（延遲）。測後刪除 actor |
| PER-04（tick 49，→已盤） | `zzDeepPer04b.spec.ts`（`tick49/per04b.log`）。capturedT2 true；回放 1 次；請求 since 序列 `"10174"`, 10174, `"10175"`, 10175, **10174**, `"10177"`, 10177, 10177。清單的 T2／T3 在各階段皆 false（目標列不在可視清單），UI 判定不採用。測後刪除兩篇筆記 |
| PER-05（tick 50，→已盤） | `zzDeepPer05d.spec.ts`（`tick50/per05d.log`）：before false；runs `[{apply 550, remove 1033}, {520, 1031}, {518, 1029}]` ms。測後刪除筆記與標籤 |
| DATA-02（tick 51，→已盤） | `zzDeepData02b.spec.ts`（`tick51/data02b.log`、`data02b-race.log` 以 `RETRY_NOW=1` 立即重送）：firstRun 用戶端逾時、countRightAfter 52／53、15 秒後 100；immediateRetry unchanged 100；secondRun unchanged 100、folders_reused 6；final notes 100、duplicates 0、folders 5；mixedBatch 400、created 0。`tick51/legacy-media.txt`（第一段因 `created_at` 欄位不存在而無效，以「--- rerun」段為準）：index row 1 → 刪除 0 → 重匯 updated 1、images_imported 1、新舊檔名不同、兩者 GET 200、新檔索引 1 |
| DATA-06（tick 52，→已盤） | `zzDeepData06b.spec.ts`（`tick52/data06b.log`、`out/…/legacy.sqlite3`）。pendingBefore 1；snapshot key `db:account-v1:[…]`；python：cols_before `[id, method, path, body, idem_key, created_at, attempts, rejection]`、rows 1、cols_after `[id, method, path, body, created_at]`；寫回 ok（從同源的 `/favicon.svg` 頁）；上線後 serverHasEdit true、occurrences 1、patches 1、pending 0、recovery 0、errors []。測後刪除筆記 |
| PDF-03 | `zzDeepPdf03.spec.ts`（`tick7/pdf03.log`，沿用 pdfInk.spec 的單頁空白 PDF）。基準 1；第二筆 Stop drawing 後 0.2 秒點 Tasks → 1（預期 2）；新 PDF 兩筆、0.2 秒 reload → 1（GAP-197）；畫完不按 Stop、按 Escape → 0、無 SVG、無提示；PUT 403 → 伺服器 0、SVG 1、兩則權限提示、復原面板 |
| RSS-05 | `zzDeepRss05.spec.ts`（`tick7/rss05b.log`；先發布 4 篇 `R05 art i (<stamp>)` 再訂閱站內 feed，首次執行未發布所以沒有文章）。同時保存：201／201、node_id 不同；資料庫中該文章有 2 篇 `source_type=rss` 的筆記（其中一篇後續刪除）。node_id 指定為無關筆記：200、文章的 saved_node_id 變成該筆記、其正文不變。刪除已保存筆記後再保存：200、already_saved、回傳已刪除 id、GET 404（GAP-198）。UI 段落 Save 按鈕 0 個，未執行。補驗 `zzDeepRss05b.spec.ts`（`tick7/rss05d.log`、`rss05e.log`；需先取消「Unseen only」才看得到已讀文章）：回應遺失→按鈕「Saved」、5 秒後 1 篇且已保存；`.rss-act-open` 開到該筆記；離線→「Saved」、上線 8 秒後 1 篇 |
| RSS-06 | `zzDeepRss06.spec.ts`（`tick7/rss06b.log`；第一次執行後段被復原面板擋住，已先收合）。正常：卡 1 張、父為文章筆記、有連線。`/api/edges` POST 403：引用列仍在；解除後再按→2 張，`[{edge:false},{edge:true}]`（GAP-199）。`/api/nodes` POST 403：伺服器 0、側欄 0。`/api/nodes` POST 503 → 離線／上線 → 1 張、有連線 |
| SITE-09 | `zzDeepSite09.spec.ts`（`tick7/site09.log`）＋curl。POST /api/publish 201。匿名：`/site` 200、含 Public、不含 Private／Locked；文章 200、title「S09 Public … — 」、description「Custom description …」、og:title 同 title、canonical `http://localhost/site/s09-public-…`、lang zh-TW、無 robots；Private 直連 200（不洩漏）、Locked 直連 200 不含正文；不存在 slug 由 Playwright 看到 200，curl 顯示 302 → `/site/`；feed 200、rss+xml、只含 Public；sitemap 200、只含 Public、`<loc>http://localhost/site/…</loc>`（GAP-200）。390px scrollWidth 390、body 14px、無 h1 |
| FIND-02 | `zzDeepFind02.spec.ts`（`tick7/find02.log`）。owner：search `[Hidden, Normal, Revoked, Secret]`、query `[Normal, Revoked, Secret]`、bootstrap `[Hidden, Normal, Revoked, Secret]`、直接 GET trashed 404 其餘 200。editor：search `[Hidden, Normal, Revoked]`、query `[Normal, Revoked]`、bootstrap 同 search、secret 404、trashed 404。suggested-links 200、空。editor 面板 `[Normal, Revoked, Hidden]`；owner 對 Revoked 加鎖 4 秒後 `[Normal, Hidden]`，API search `[Hidden, Normal]` |
| AI-02 | `zzDeepAi02.spec.ts`（`tick7/ai02b.log`；第一次 actor type 用錯為 ai_agent）。agent updateNode 200 → 伺服器 `line1\nline2\nline3\nAGENT-ADDED`、owner 編輯器 `line1⏎line2⏎line3`；owner 在 line1 加 OWNER 後 3 秒 → 伺服器 `line1 OWNER\nline2\nline3`（GAP-186）。owner 在 line2 打 DRAFT 未保存時 agent 寫入 `…\nAGENT-2` → 3.5 秒後伺服器 `line1 OWNER\nline2 DRAFT\nline3\nAGENT-2`、編輯器同。收件匣含該筆記 |
| FIND-01 | `zzDeepFind01.spec.ts`（`tick7/find01.log`）。側欄：「量子」2、「薛丁格<tag>」1（方程式整理）、不存在詞 0 且顯示空狀態、清空後列表回來、「長清單<tag>」50（共 250，GAP-201）。面板：「量子」2、正文詞 1＋Create note 列（含 snippet「這裡寫了薛丁格…」）、長清單 8。延遲首查詢 3.5 秒後改查：只剩正文詞結果。離線：側欄「量子」2；面板「Search is unavailable. Your query is still here. Try again」 |
| HIST-07 | `zzDeepHist07.spec.ts`（`tick7/hist07.log`）＋版本 API。各類型 preview／restore 狀態見 audit 列；第二次對最新 NODE_UPDATED（即還原產生的事件）restore 200（等於重做）。H07c：PATCH first、PATCH second，restore(first) 200 → 正文「base」；同事件 force → 409 already_in_state；as_new_node 200。`/api/nodes/<H07c>/versions` 2 筆、皆「base」（GAP-202） |
| ACC-01 | `zzDeepAcc01.spec.ts`（`tick7/acc01b.log`；第一次未處理儲存位置選擇頁）。錯誤密碼：仍在登入頁、「Invalid email or password」。登入＋Use browser storage：工作區可見。清 cookie 後 Ctrl+S：伺服器無、編輯器有、toast 空、「1 Sync now」、登入頁未出現；重新整理：登入頁、私人標題不可見；重新登入 6 秒後伺服器有該文字、無復原卡。Sign out：登入頁；goBack：仍登入頁、私人標題不可見 |
| ACC-06 | `zzDeepAcc06.spec.ts`（`tick7/acc06c.log`，截圖 `b-landing.png`）。登出後 localStorage 符合 recent／lastLocation／draft／search 的 key 只有 `onden.lastLocation`。B 登入後頁面為「Your account has changed」→ Reload page → Use browser storage：網址仍為 A 的受保護筆記 id（GAP-203）、B 讀取 404、畫面無正文。B 面板空查詢不列、搜尋 0、側欄搜尋 0、直接網址無正文、`?view=timeline` 不含該標題 |
| UX-02 | `zzDeepUx02.spec.ts`、`zzDeepUx02b.spec.ts`（`tick7/ux02.log`、`ux02b.log`）。設定值與首屏背景、對比、動畫、溢出結果見 audit 列（溢出清單為空）。14→22px：sidebarTitle 13→13、topbarBtn 13→13、editor 17→26.71、noteTitle 30→30、inspector 12→12、tagChip 11→11；365 個葉節點文字中 24 個變大（GAP-204） |
| UX-03 | `zzDeepUx03.spec.ts`（`tick7/ux03b.log`；第一次執行在快速捕捉 Escape 後遮罩未關、擋住後續操作）。unnamed 0／391；Tab 40 站 noRing 0、body 0。palette：`div role=dialog modal=true`、逃出 0、Escape 關、焦點回 cm-content。capture：dialog 語意 none、逃出 14、Escape 未關、焦點落在 sidebar-tab。More actions：`role=menu`、逃出 0、Escape 關、焦點回 note-actions-more-btn。Share：`role=dialog modal=null`、逃出 14、Escape 未關。PATCH 403 的 toast role=alert。鍵盤流程：捕捉建立 1 篇、面板 Enter 開啟標題正確、焦點 `body`、打字未進入正文（GAP-205） |
| UX-04 | `zzDeepUx04.spec.ts`（`tick7/ux04.json`，3.4 分鐘）＋`zzDeepUx04b.spec.ts`（`tick7/ux04b.log`）＋`zzDeepUx04c.spec.ts`（`tick7/ux04c.log`）。兩組情境：App 繁中＋瀏覽器 en-US、App 英文＋瀏覽器 zh-TW，各掃 24 個畫面的可見文字與 placeholder／title／aria-label。繁中模式英文殘留：歷史頁 31～45 條、網站編輯器 45 條、設定「你的資料」8 條、Ask 5 條；`{}` 殘留 0、英文複數錯誤 0。歷史 modal 繁中只有兩句翻譯，其餘「HISTORY／Changes／Read／Authorship／Current／Live body／TODAY／04:52 PM」。英文模式：版本列「10月8日 下午04:05」、垃圾桶「下午04:17」等 17 條中文日期。`<html lang>` 6 種系統語言與即時切換後皆為 zh-Hant。字數：1,340 中文字→「1 詞 · 閱讀約 1 分鐘」／「1 word · 1 min read」。403 toast 繁中正確。發布站：lang=zh-TW、chrome 繁中；預設版型無日期區塊；前端容器 node 實測 2026-10-07T20:30Z→「2026年10月7日」（台北應為 10月8日）。Ask 為 stub 回答，無法觸發無金鑰錯誤（程式寫死英文）。登記 GAP-206～210。 |
| PERF-01 | `zzDeepPerf01.spec.ts`（`tick7/perf01.json`，57 s）＋`zzDeepPerf01b.spec.ts`（`tick7/perf01b.log`）。CDP Performance.getMetrics（GC 後）、PerformanceObserver longtask 與 event（≥16 ms）。冷啟動 tShell 2,299／tRows 2,374／tSettled 4,276 ms、long task 6 個 480 ms；熱啟動 902／1,059／2,015 ms。bigNote tOpen 1,809、typing eventP95 32、preview 1,055 ms＋longTaskMs 916。search 側欄 220、palette 871 ms。table500 tFirst 1,281、rowsInDom 500、tScrollEnd 205。bigImage 5.1 MB tVisible 2,644。graph tFirstPaint 3,901、eventMax 312。切換 4 輪 heap 16.3→19.6→19.7→20.2 MB、listener 633→639→639→639。登記 GAP-211。 |
| REV-03 | `zzDeepRev03.spec.ts`（`tick7/rev03.log`）＋`zzDeepRev03b.spec.ts`（`tick7/rev03b.log`）。stats 起始 due 8／new 8／new_per_day 3／new_available 3；decks「Ch1:4、Ch2:3、Course:1」；queue tag 3、root=Course 8、root=Ch1 4、root=Empty 0。UI：複習頁「3 left · 0 of 3 new cards today」，課程 deck「8 left · Studying R03 Course · 0 of 3 new cards today」。評 3 張後 stats new_today 3／new_remaining 0、tag 佇列 0、root=Course 仍 5。改 `_review_state.introduced_at`＝2026-10-07T23:30Z（隔離 DB；台北 07:30）後 new_today 2、tag 佇列多出 c1-3。第二位 editor：撤 Ch2 前 due 5、後 2，decks 去掉 Ch2，root=Ch2 0，評鎖定卡 404。登記 GAP-212、213。 |
| REV-05 | `zzDeepRev05b.spec.ts`（`tick7/rev05b.log`）＋`zzDeepRev05c.spec.ts`（`tick7/rev05c.log`）＋`zzDeepRev05d.spec.ts`（`tick7/rev05d.log`）＋`zzDeepRev05e.spec.ts`（`tick7/rev05e.log`）；`zzDeepRev05.spec.ts`（`tick7/rev05-old.log`）首輪卡在 Show answer，05d 單獨重現 normal／empty／oldInk／blankSpaces 皆 40–54 ms 揭曉、無錯誤，判為探測假象。rich 卡 tables 1／katex 1／callout 2／svg 1／pre 2、690/690 無溢出；image ok；missing ok=false；ink inkThumb 1；text+ink inkThumb 0；embed 文字「Embed card ![[R05 Target …]]」；wikilink 無連結元素。Open→`view=notes&lens=editor`，返回 `view=review`、5 left。手機：表格 612 px 在 overflow auto 容器內、頁面不溢出、字 15 px、Again／Hard／Good／Easy 76×44、Open 46×17；結束文字「1 new cards available today」。05e：B 讀 urlA 200、只在鎖定筆記的 urlB 404（owner 200）、UI 圖片載入；鎖卡後 urlA 404、佇列 1→0、評分 404，UI 按 Good 後顯示「Nothing to review」、無 toast。登記 GAP-214、215。 |
| REV-06 | `zzDeepRev06.spec.ts`（`tick7/rev06.log`）＋`zzDeepRev06b.spec.ts`（`tick7/rev06b.log`）＋`zzDeepRev06c.spec.ts`（`tick7/rev06c3.log`；`rev06c.log`／`rev06c2.log` 為定位器錯誤的探測假象——待確認狀態的 Good 在 `.review-empty` 而非 `.review-grades`）。設定變體：baseline per_day=5；string5→20、negative→0、huge→500、fraction→2、zero→0、null／array→20，皆 save=200 且 stored 原值；modules 在整個 behaviour 取代後仍保留。max 1 天 Easy×3 皆 days=1.00；max 0 仍 1.00。badRating 400、stringRating 400；editor schema 403 owner_only、modules 403、owner 設定不變。06b：桌面 4.9 s、390 px 3.0 s 離開 Loading，網路 stats 2.8 s→queue 4.9 s。06c：lost＝server 200→ERR_CONNECTION_RESET→同 key 重送 `{deduped:true}`、reps 1；503 時 Easy 不送出（reqs 1），Good 重試成功；409 顯示「note has no enabled review tag」；離線 Good disabled、恢復後錯誤字仍在；重新整理後「Studying R06c deck」消失、佇列 4→19。登記 GAP-216、217。 |
| REV-07 | `zzDeepRev07.spec.ts`（`tick7/rev07b.log`；`rev07.log` 只因探測查錯表名 node_tasks 失敗）。@1280／@390 結果相同：extract1「Extracted 3 review cards」；grade 200；lectureSaved t；extract2（標籤 PUT 500）兩張新卡 tags=0；extract3「Added review tags to 2 existing cards」→tags=1；extract4「All 4 cards already extracted」；「What is latency?」仍為「Time to first byte.」、「Define throughput」與「What is throughput?」並存；改名後 backlinks「0 new / 5 old」；deck 複習順序：講義本身（「Week 1 Q: What is a cache? A: …」）、latency、Define throughput、throughput、CDN（已評的 cache 不出現）；study 任務 1 筆；overflow false。登記 GAP-218。 |
| RSS-01 | `zzDeepRss0102.spec.ts`（`tick7/rss0102d.log`；`rss0102.log`～`c.log` 為探測問題：復原面板擋住按鈕、啟動 membership gate 5.4 s 未等待、一次清空輸入未重現）。fixture `tick7/fixture/server.mjs` 以 `docker cp`＋`docker exec -d` 跑在 backend 容器 :8080（獨立容器的映像已被清掉）。ui_good「Subscribed — fetching the feed now.」；dup「already_subscribed」＋PANEL；bad「Failed to fetch feed: Unclosed root tag Line: 0 Column: 48」＋PANEL；html「Feed not recognized as RSS 1 or 2.」；500「feed fetch failed: HTTP 500」；autodiscover「Unexpected close tag Line: 0 Column: 103」；notUrl「bad_request」；各附 PANEL。sourcesAfterUi 只有 FX Good（unseen 3）；viewer 403「role 'viewer' is below required 'editor'」；offline 1→reload 1；slow 422 timeout（10,143 ms）。登記 GAP-219。 |
| RSS-02 | 同上＋`zzDeepRss02b.spec.ts`（`tick7/rss02b2.log`；`rss02b.log` 因保留屬性 `_rss_url` API 回 400，改用隔離 DB SQL）。dupItems 2、刷新兩次後 2、unseen 2；goodCounts「sources.unseen=3 items(unseen)=3」、UI 徽章 3。500→last_error「feed fetch failed: HTTP 500」、UI「⚠ FX Good …」、title「Last fetch failed: …」、點擊後「Pick an article to read.」、舊文 3；slow→「timeout」；改回→unseen 5、last_error null。刪除來源筆記 200、refresh 404、清單與文章皆移除。登記 GAP-220。 |
| RSS-03 | `zzDeepRss03.spec.ts`（`tick7/rss03b.log`；`rss03.log` 手機步驟因「Unseen only」篩掉已讀文章失敗）＋`zzDeepRss03b.spec.ts`（`tick7/rss03b2.log`）。summary scripts 0／onclick 0／pwned null、外鏈 rel=noreferrer、缺圖 ok=false visible=false；header link rel「noreferrer noopener」；full0 為全文、pwned2 null；full2fail 提示「Failed to load the page: page fetch failed: HTTP 500」、保留摘要、按鈕可用；lateOpen 前後皆 item 3。03 的 lateFull 未覆蓋是探測假象（桌面版沒有 Back 按鈕，點擊被 catch）；03b：11,503 ms 送出 item 1 全文，11,957 ms 開 item 3（顯示 item 3），16,566 ms 回應 200 後畫面變成「FX item 1 :: Full /article/1」。手機：13px／20.8px、body 390、pre 2908/360 auto、61 段、文末 bottom 616／vh 800。登記 GAP-221。 |
| RSS-08 | `zzDeepRss08.spec.ts`（`tick7/rss08b.log`；`rss08.log` 因工作區沒有首頁筆記，「To read」區塊不存在、手機步驟停在編輯頁）。fixture `tick7/fixture/server2.mjs` 在 backend 容器 :8081。setHome 200（結束時復原為 NULL，已確認）；homeToRead「R08 B（前一輪）、R08 A、R08 B」；開 A → `node=…&lens=editor`；Back → about:blank；untag 後不在佇列；首頁列按鈕 0。bm_plain 201 含 og:image／description；bm_dup 201 新 id、dupCount 2；500／404／pdf 皆 201、title「backend」、正文只有 `[backend](url)`；slow 201 於 8,160 ms；og：md 原樣含 `[title](javascript:alert(1))`、`[link](http://evil)`、`![](javascript:alert(2))`，預覽文字「Desc with tags and a link [Weird title bold & more](…)」、javascript 連結 0；notUrl 400；bookmark 標籤數 0。手機「+」→ Bookmark 跳出 prompt「Bookmark URL:」，輸入 500 頁 → 開啟新筆記、無 toast；phoneToRead 有 B。登記 GAP-222。 |
| PDF-01 | `zzDeepPdf01.spec.ts`（`tick7/pdf01.log`）＋`zzDeepPdf01b.spec.ts`（`tick7/pdf01b.log`）；測試檔由 `tick7/fixture/mkpdf.py` 產生（text20 12 KB、scan3 16 KB、big300 179 KB、bigscan 30 MB、broken 4 KB、notpdf 30 B，皆未提交）。UI 匯入 1,529 ms、pages 20、textSpans 41；kinds：text20 430 ms／scan3 248 ms（textSpans 0）／big300 456 ms（300 頁、rendered 2、heap 64 MB）／bigscan 上傳 413／broken 與 notpdf「Invalid PDF structure.」；zoom「676 → 811 → 676」；scrolledTo 8,840 → reopen 0；手機 pageW 350、toolbar 350/350 h=110、contentH 560、8 個按鈕 26 px；pageIndicator 皆 null。01b：UI 選 30 MB 檔，12 s 後 toast 為 nginx「413 Request Entity Too Large」HTML，未建立筆記。登記 GAP-223、224。 |

## 6a. 修正：GAP-264、GAP-260（2026-10-09，`a2c663d`）

稽核迴圈結束後依使用者要求修正兩項，提交於本分支（未推送）。其餘稽核文件與既有未提交改動不在該提交內。

| GAP | 修正 | 驗證 |
| --- | --- | --- |
| GAP-264 | `ConfirmDialog.css` 背景 z-index 300 → 10000 | :5199 重建後 `zzDeepData04Confirm.spec.ts`：最上層為確認鈕、點擊後重載（`fix-verify/gap264-confirm.log`）；`zzDeepData04.spec.ts` 離線往返與空 profile 還原（`fix-verify/gap264-roundtrip.log`，結果見 DATA-04 列） |
| GAP-260 | 新增 `services/reservedNodes.ts`；`spine/authority.ts` 對保留的設定節點／標籤非讀取操作需 admin；read-gate lint 將該檔列為 INTERNAL；`httpRoutes`／`dispatcherAudit` 單元測試 mock 略過此查詢 | 新整合測試 `reservedConfigAuthority.integration.test.ts`（拋棄式 `onden_test`；移除修正時失敗）；:5199 viewer 實測全部 403、設定保留、owner 仍可改（`fix-verify/gap260.txt`，測試 viewer 已刪除） |

後端測試：除 `migration.integration.test.ts`、`realtime.integration.test.ts` 外全過；這兩檔在修正前後都因測試 DB 已有 `member_removals`（`relation "member_removals" already exists`）失敗，屬環境問題，未處理。
DATA-04 tick 53 補驗取消與兩分頁還原後改為「已盤」（見下）。

| 列 | 證據 |
| --- | --- |
| DATA-04（tick 53，部分→已盤） | `zzDeepData04c.spec.ts`（`tick53/data04c.log`；`data04c-probe-artifact.log` 為探測以 Escape 關不掉設定視窗、分頁 2 未輸入而中斷，改點 overlay 角落後重跑）。Cancel：確認中 Download 停用、「Importing…」1；取消後 download／restore 皆 enabled、Importing 0、同檔再選確認框 1。兩分頁：t2 待同步 1→分頁 1 還原後仍 1；上線後 hasX true、X 出現 1 次、t1 PATCH 0／t2 PATCH 1、兩分頁待同步 0；關 t2 重載 t1 正文含 X、待同步 0、復原卡 0；errors [] |

## 6b. 修正：GAP-20／162／185／186／249（2026-10-09）

使用者要求修正卡住最後三列「部分」的缺口。設計取捨、契約與限制見
[卡住驗收列的缺口修正](blocked-gap-fixes-2026-10-09.md)；證據在 `.acceptance/feature-loop-2026-10-07/fix-verify/`。

| 項目 | 證據 |
| --- | --- |
| GAP-162／266 | `fix3-zzDeepCol10.log`：query 區塊 3、base 表格 2、原始碼 0；`tags: X` 由 400 變 4 matches；editor 不見受限成員；390px 無溢出 |
| GAP-249 | `fix2-cursor-order.log`：冷啟動先 bootstrap（`last_event_id=10795`），再單次 `sync since=10795`；修正前 `fix2-cursor-order` 第一版與 `fix2-zzDeepCan09c.log` 為 since=0 起 22 次；`fix2-zzDeepCan09c-b.log`：1 次、0.32 MB、0 份正文 |
| 大型工作區副作用 | `fix2-regression.log`：noteMerge、offlineHandwriting、offlineOrganize 在 :5199 失敗、在乾淨 :5299 全過（`fix2-small-stack.log`）。修正後 `fix3-offline-specs.log`／`fix4-offline-specs.log`：noteMerge、offlineHandwriting、offlineOrganize 通過；`zzFixOfflineBodies` 12 批、2 296 份正文，離線開啟與離線冷啟動皆顯示未開過的筆記正文 |
| GAP-185 | `fix2-zzDeepNote03c.log`：離線捕捉後 url／editor／標題皆正確，上線後仍在；`fix3-zzDeepNote03d.log` 見 NOTE-03 |
| GAP-186 | `fix2-zzDeepPer05.log`：editorA 顯示 `line3 B`，A 再改後伺服器 `line1 A A2\nline2 AA BB\nline3 B`；`fix2-zzDeepNote03.log`：離線重放後編輯器含 `line3 REMOTE` |
| GAP-20 | `fix2-gap20-gate-stuck.log`：第一版離線進入但卡在權限閘門（大型快取走錯分支）；`fix2-gap20.log`：進入、待同步 1、上線 PATCH 1、伺服器恰 1 份 |
| 回歸 | `fix2-regression2.log`：14 個離線／同步／捕捉／帳號 spec 23 過 2 敗——multiClientSync（GAP-109，既有）、offlineOrganize（下載尚未到達，後以「最近更新優先＋bootstrap 後立即下載」修正，`fix4` 通過）。offlineFlakyNetwork 在 :5199 時過時敗，修正前的 `final-out` 已是相同畫面（大型工作區既有問題），:5299 通過 |

三列改為已盤：NOTE-03、COL-10、CAN-09。另登錄 GAP-266（已修）、GAP-267（未修）。

## 6. 本輪改動（未提交）

- 15 個 e2e spec 更新至目前 UI（含 soak）；`helpers.ts` 新增 `openAskPanel`、`openTagSettings`。
- `compose.e2e.yaml` 的 Postgres healthcheck 改走 TCP。
- `zzAuditProbes.spec.ts`：RSS-07／SITE-08／SITE-10／HIST-10／NOTE-09 的 API 探測；`zzAuditTokens.spec.ts`：TOKEN-03／05／07、FIND-02。
  兩者可保留為回歸或改名後併入。
- `zzAuditEditor.spec.ts`：NOTE-05／SKETCH-01／PDF-01 的瀏覽器探測。
- `zzAuditFields.spec.ts`：TAG-05 欄位驗證探測；`zzAuditSave.spec.ts`：NOTE-02 保存觸發點；`zzAuditLostResponse.spec.ts`：SYS-04。
- `zzDeepCol02.spec.ts`、`zzDeepCol03.spec.ts`、`zzDeepTag04.spec.ts`：COL-02／COL-03／TAG-04 深化探測。另一 session 同時以 run.sh 重設 `onden-e2e` 並清除 Playwright 容器，本批改在 `:5199` 的獨立 compose project（`onden-e2e-tick2`）以主機 Playwright 執行（`LANG=en_US`，否則介面為繁中）。
- `zzDeepTag03.spec.ts`、`zzDeepTag05.spec.ts`、`zzDeepTag06.spec.ts`：TAG-03／TAG-05／TAG-06 深化探測（同在 `:5199` 獨立 stack，各 1 項通過）。
- `zzDeepTag01.spec.ts`、`zzDeepTag02.spec.ts`、`zzDeepTag07.spec.ts`：TAG-01／TAG-02／TAG-07 深化探測（`:5199` 獨立 stack，各 1 項通過；紀錄在 `.acceptance/feature-loop-2026-10-07/tick2/tag0{1,2,7}.log`）。
- `zzDeepTag10.spec.ts`、`zzDeepCol01.spec.ts`、`zzDeepCol04.spec.ts`：TAG-10／COL-01／COL-04 深化探測（`:5199` 獨立 stack）。
- `zzDeepCol05.spec.ts`、`zzDeepCol06.spec.ts`、`zzDeepCol07.spec.ts`：COL-05／06／07 深化探測（`:5199` 獨立 stack）。
- `zzDeepCol08.spec.ts`、`zzDeepCol10.spec.ts`、`zzDeepTask01.spec.ts`：COL-08／COL-10／TASK-01 深化探測（`:5199` 獨立 stack，紀錄在 `tick6/`、`tick7/`）。
- `zzDeepTask02.spec.ts`、`zzDeepTask02b.spec.ts`：TASK-02／04／06 深化探測（`tick7/`）。
- `zzDeepTask03.spec.ts`：TASK-03／05 深化探測（`tick7/`）。
- `zzDeepTask06.spec.ts`、`zzDeepCan07.spec.ts`、`zzDeepCan07b.spec.ts`：TASK-06 晚到回應、CAN-07 深化探測（`tick7/`）。
- `zzDeepCan01.spec.ts`：CAN-01 深化探測（`tick7/`）。
- `zzDeepCan08.spec.ts`：CAN-08 深化探測（`tick7/`）。
- `zzDeepCan06.spec.ts`、`zzDeepCan06b.spec.ts`：CAN-06 深化探測（`tick7/`）。
- `zzDeepCan09.spec.ts`：CAN-09 深化探測（`tick7/`）。
- `zzDeepCan02.spec.ts`、`zzDeepCan02b.spec.ts`：CAN-02 深化探測（`tick7/`）。
- `zzDeepCan03.spec.ts`、`zzDeepCan03b.spec.ts`：CAN-03／05 深化探測（`tick7/`）。
- `zzDeepCan05.spec.ts`：CAN-05 深化探測（`tick7/`）。
- `zzDeepCan04.spec.ts`：CAN-04 深化探測（`tick7/`）。
- `zzDeepNote08.spec.ts`、`zzDeepNote08b.spec.ts`：NOTE-08 深化探測（`tick7/`）。
- `zzDeepNote06.spec.ts`：NOTE-06 深化探測（`tick7/`）。
- `zzDeepNote10.spec.ts`：NOTE-10 深化探測（`tick7/`）。
- `zzDeepNote04.spec.ts`：NOTE-04 深化探測（`tick7/`）。
- `zzDeepNote01.spec.ts`：NOTE-01 深化探測（`tick7/`）。
- `zzDeepNote13.spec.ts`：NOTE-13 深化探測（`tick7/`）。
- `zzDeepNote02.spec.ts`：NOTE-02 深化探測（`tick7/`）。
- `zzDeepNote05.spec.ts`、`zzDeepNote05b.spec.ts`：NOTE-05 深化探測（`tick7/`）。
- `zzDeepNote03.spec.ts`、`zzDeepNote03b.spec.ts`、`zzDeepNote03c.spec.ts`：NOTE-03 深化探測（`tick7/`）。
- `zzDeepNav05.spec.ts`、`zzDeepNav05b.spec.ts`：NAV-05 深化探測（`tick7/`）。
- `zzDeepNav01.spec.ts`、`zzDeepNav01b.spec.ts`：NAV-01 深化探測（`tick7/`）。
- `zzDeepNav03.spec.ts`：NAV-03 深化探測（`tick7/`）。
- `zzDeepNav06.spec.ts`：NAV-06 深化探測（`tick7/`）。
- `zzDeepNav07.spec.ts`：NAV-07 深化探測（`tick7/`）。
- `zzDeepNav09.spec.ts`：NAV-09 深化探測（`tick7/`）。
- `zzDeepNav04.spec.ts`：NAV-04 深化探測（`tick7/`）。
- `zzDeepNav08.spec.ts`：NAV-08 深化探測（`tick7/`）。
- `zzDeepData03.spec.ts`：DATA-03 深化探測（`tick7/`）。
- `zzDeepData08.spec.ts`：DATA-08 深化探測（`tick7/`）——檔案已於 tick 42 被誤覆蓋後改名，見下一行。
- `zzDeepData08b.spec.ts`：DATA-08 未確認卡在 401 下 Try again、恢復後同步（`tick42/`）。
- `zzDeepData06-crossbrowser.spec.ts`：DATA-06 本機資料庫生命週期（Chromium、Firefox）（`tick43/`）。
- `zzDeepData07.spec.ts`：DATA-07 本機配額已滿（CDP 覆寫）下的離線／線上編輯與離線重載（`tick44/`）。
- `zzDeepData04.spec.ts`、`zzDeepData04Confirm.spec.ts`、`zzDeepSettingsOffline.spec.ts`：DATA-04 備份下載／還原、還原確認框被遮擋（GAP-264）、離線首次開啟 lazy 畫面崩潰（GAP-263）（`tick45/`）。
- `zzDeepData01Notion.spec.ts`：DATA-01 合成 Notion 匯出（頁面、巢狀、資料庫、連結、圖片）（`tick46/`）。
- `zzDeepAcc06b.spec.ts`：ACC-06 網站設定防抖保存跨登出／換帳號（`tick47/`）。
- `zzDeepAcc05b.spec.ts`：ACC-05 worker 延遲下首次輸入（gate 期間按鍵丟棄）（`tick48/`）。
- `zzDeepPer04b.spec.ts`：PER-04 過期 delta 回放與游標（`tick49/`）。
- `zzDeepPer05d.spec.ts`：PER-05 遠端標籤套用／移除反映到開啟中筆記的時間（`tick50/`）。
- `zzDeepData02b.spec.ts`：DATA-02 中斷後整批恢復、立即重送、混合批次；舊未索引媒體以 curl 驗證（`tick51/`）。
- `zzDeepData06b.spec.ts`：DATA-06 舊版本機 schema（無 idem_key 等欄位）的 migration 與佇列重送（`tick52/`）。
- `zzDeepPer05.spec.ts`：PER-05 深化探測（`tick7/`）。
- `zzDeepMedia01.spec.ts`：MEDIA-01 深化探測（`tick7/`）。
- `zzDeepSketch01.spec.ts`：SKETCH-01 深化探測（`tick7/`）。
- `zzDeepInk01.spec.ts`：INK-01 深化探測（`tick7/`）。
- `zzDeepSketch01b.spec.ts`、`zzDeepSketch01c.spec.ts`：SKETCH-01 全螢幕／刪除／大圖／開啟回寫（`tick8/`）。
- `zzDeepInk03.spec.ts`：INK-03 三宿主損壞值與保存 500（`tick8/`）。
- `zzDeepMedia02.spec.ts`：MEDIA-02 快取、垃圾桶／刪出正文後的授權、共用引用、檔名（`tick9/`）。
- `zzDeepInk03b.spec.ts`：INK-03 三宿主歷史文字與複習卡縮圖（`tick9/`）。
- `zzDeepPer06.spec.ts`：PER-06 匿名媒體、發布／上鎖／取消發布、成員匯出、刪除成員後 session（`tick10/`）。
- `zzDeepSite01.spec.ts`、`zzDeepSite01b.spec.ts`、`zzDeepSite01c.spec.ts`：SITE-01 長標題、刪頁語意、首頁被刪、重送、Pages 面板重掛（`tick11/`）。
- `zzDeepSite09b.spec.ts`：SITE-09／SITE-03 四版型發布、logo／favicon 上傳（`tick12/`）。
- `zzDeepSite02.spec.ts`、`zzDeepSite02b.spec.ts`：SITE-02 全欄位、舊鍵重送、拒絕重試、快速切換（`tick13/`）。
- `zzDeepSite05.spec.ts`：SITE-05 custom CSS 跳脫、無效 CSS、長度上限（`tick14/`）。
- `zzDeepSite03.spec.ts`：SITE-03 版型切換取消／確認、雙存檔、連切、刻意清空、舊快照相容、未發布半套（`tick15/`）。
- `zzDeepSite05b.spec.ts`：SITE-05 非文字控制持久化、切分頁、預覽與公開頁相符、預覽 CSS 範圍、390／320 長設定（`tick15/`）。
- `zzDeepSite04.spec.ts`、`zzDeepSite04c～f.spec.ts`：SITE-04 全區塊公開渲染與惡意值、Edit 分頁編輯／刪除／新增／重排／undo／500 重試／重開、手機 Fields、遠端版面覆蓋、hydration 基準（`tick16/`）。
- `zzDeepSite01d.spec.ts`：SITE-01 改名／刪除被拒回饋（桌面 drawer、390 px 清單）、中文改名 slug（`tick17/`）。
- `zzDeepCan09b.spec.ts`、`zzDeepCan09c.spec.ts`：CAN-09 slim 工作區匯出補讀失敗、冷啟動正文流量（`tick18/`）。
- `zzDeepHist09.spec.ts`：HIST-09 各領域復原事件／因果／操作者、未遷移領域 422、merge 分組衝突與完整復原（`tick19/`）。
- `zzDeepUx01.spec.ts`、`zzDeepUx01b.spec.ts`：UX-01 三寬度視覺矩陣、長筆記、慢／失敗冷啟動；bootstrap 失敗後的今日筆記重複建立（`tick20/`）。
- `zzDeepSys03.spec.ts`、`zzDeepSys03b.spec.ts`：SYS-03 相依重播（父層被拒）、在途成功回應、401 重播（`tick21/`）。
- `zzDeepSys03c.spec.ts`、`zzDeepSys03d.spec.ts`：SYS-03 離線移動、目標父層被刪、多分頁佇列（關閉分頁遺失修改，GAP-251）（`tick22/`）。
- `zzDeepSys02.spec.ts`：SYS-02 REST 與 agent 工具錯誤類別 15 列對照（`tick23/`）。
- `zzDeepSys02b.spec.ts`：SYS-02 Postgres 中斷、後端崩潰（GAP-253）、恢復後佇列送達（`tick24/`）。
- `zzDeepPer05b.spec.ts`、`zzDeepPer05c.spec.ts`：PER-05 屬性拒絕只回復本次、開啟中筆記的遠端更新（`tick26/`）。
- `zzDeepSys06.spec.ts`＋`tick27/fixture/server.mjs`：SYS-06 後端重啟時的 RSS outbox、重複 refresh、待核准效果（`tick27/`）。
- `zzDeepSys01.spec.ts`：SYS-01 未遷移寫入的成功⇔事件、拒絕⇔無變更對照（`tick28/`）。
- `zzDeepSys04.spec.ts`：SYS-04 已提交回應遺失後立即重載（建立、正文）（`tick29/`）。
- `zzDeepPer01.spec.ts`：PER-01 角色與人類 scope 變更後下一個請求立即生效（`tick30/`）。
- `zzDeepPer02.spec.ts`：PER-02 讀取政策跨 20 餘個讀取入口（含繼承、retained、agent）（`tick31/`）。
- `zzDeepPer03.spec.ts`：PER-03 開啟中撤權、撤權後離線修改重播（`tick32/`）。
- `zzDeepAcc05.spec.ts`：ACC-05 首次儲存選擇（取消、權限錯、壞 handle、瀏覽器儲存、帳號分區、390 px）（`tick33/`）。
- `zzDeepAcc02.spec.ts`＋`tick36/compose.acc02.yaml`：ACC-02 空工作區首次啟動、範例資格、同時開啟、viewer 刪系統節點（`tick36/`）。
- `zzDeepAcc08.spec.ts`：ACC-08 離線冷啟動、已提交編輯後的慢 bootstrap（`tick37/`）。
- `zzDeepAcc04.spec.ts`：ACC-04 Backend URL 設定（不可達位址、無法回復、待同步保留）（`tick38/`）。
- `zzDeepAcc05.spec.ts`（第三個 test）：DATA-05 資料夾權限被撤回後的載入與設定頁（`tick39/`）。
- `zzDeepData01.spec.ts`：DATA-01 匯入惡意路徑、frontmatter、3 MB、嵌入語法、1 500 檔 vault 與重匯（`tick40/`）。
- `zzDeepData02.spec.ts`：DATA-02 同來源重匯、改名／移動、衝突、CSV 重匯、部分檔案（`tick41/`）。
- `zzDeepPdf03.spec.ts`：PDF-03 深化探測（`tick7/`）。
- `zzDeepRss05.spec.ts`、`zzDeepRss05b.spec.ts`：RSS-05 深化探測（`tick7/`）。
- `zzDeepRss06.spec.ts`：RSS-06 深化探測（`tick7/`）。
- `zzDeepSite09.spec.ts`：SITE-09 深化探測（`tick7/`）。
- `zzDeepFind02.spec.ts`：FIND-02 深化探測（`tick7/`）。
- `zzDeepAi02.spec.ts`：AI-02 深化探測（`tick7/`）。
- `zzDeepFind01.spec.ts`：FIND-01 深化探測（`tick7/`）。
- `zzDeepHist07.spec.ts`：HIST-07 深化探測（`tick7/`）。
- `zzDeepAcc01.spec.ts`：ACC-01 深化探測（`tick7/`）。
- `zzDeepAcc06.spec.ts`：ACC-06 深化探測（`tick7/`）。
- `zzDeepUx02.spec.ts`、`zzDeepUx02b.spec.ts`：UX-02 深化探測（`tick7/`）。
- `zzDeepUx03.spec.ts`：UX-03 深化探測（`tick7/`）。
- `zzDeepUx04.spec.ts`、`zzDeepUx04b.spec.ts`、`zzDeepUx04c.spec.ts`：UX-04 深化探測（`tick7/`）。
- `zzDeepPerf01.spec.ts`、`zzDeepPerf01b.spec.ts`：PERF-01 深化探測（`tick7/`）。
- `zzDeepRev03.spec.ts`、`zzDeepRev03b.spec.ts`：REV-03 深化探測（`tick7/`）。
- `zzDeepRev05.spec.ts`、`zzDeepRev05b.spec.ts`～`zzDeepRev05e.spec.ts`：REV-05 深化探測（`tick7/`）。
- `zzDeepRev06.spec.ts`、`zzDeepRev06b.spec.ts`、`zzDeepRev06c.spec.ts`：REV-06 深化探測（`tick7/`）。
- `zzDeepRev07.spec.ts`：REV-07 深化探測（`tick7/`）。
- `zzDeepSketch02.spec.ts`：SKETCH-02 深化探測（`tick7/`）。
- `zzDeepPdf03b.spec.ts`：PDF-03 第二輪（`tick7/`）。
- `zzDeepPdf02.spec.ts`、`zzDeepPdf02x.spec.ts`：PDF-02 深化探測（`tick7/`）。
- `zzDeepPdf01.spec.ts`、`zzDeepPdf01b.spec.ts`：PDF-01 深化探測（`tick7/`）；測試 PDF 產生器 `tick7/fixture/mkpdf.py`。
- `zzDeepRss08.spec.ts`：RSS-08 深化探測（`tick7/`）；fixture `tick7/fixture/server2.mjs`。
- `zzDeepRss03.spec.ts`、`zzDeepRss03b.spec.ts`：RSS-03 深化探測（`tick7/`）。
- `zzDeepRss0102.spec.ts`、`zzDeepRss02b.spec.ts`：RSS-01／02 深化探測（`tick7/`）；fixture `.acceptance/feature-loop-2026-10-07/tick7/fixture/server.mjs`。
- `zzLoopProbe.spec.ts`：暫時診斷用，已刪除（2026-10-08 晚）。

## 仍未涵蓋

跨引擎只跑 `crossbrowser.spec`；其餘 spec 只在 Chromium。真機、真實 AI／embedding、對外發布皆未測。
上表的「部分」不代表失敗、離線、權限或手機邊界已驗。
