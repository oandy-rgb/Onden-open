# 跨套件「功能重複」清單（2026-10-29）

> 狀態：歷史紀錄（進行中的盤點／計畫，完成後移到 docs/archive/）（寫於 2026-11-01） 引用的路徑、函式與行號是寫作當時的，現況以程式為準。

範圍：`packages/frontend`、`backend`、`markdown`、`site` 之間，同一條規則各寫一套（名稱、寫法不同也算）。
不含測試與 migrations；單一套件內部的重複由另外兩個任務掃，這裡只列跨套件的。

方法：比對四個套件的頂層函式與常數名稱、搜尋「must stay equal／twin／mirrors」這類自述重複的註解，
再依規則（UUID、顏色、`^id`、字數、截字、CSS、實體、任務、邊、檢視篩選）逐項讀兩邊程式。
「已收斂」是本 PR 做完並加守門的；「待辦」依價值與風險排序，後面分成可派工的批次。

先講結論：markdown 與 site 這幾輪已經收掉大部分語法與日期規則。剩下的重複多是**小常數與小判斷**，
兩邊靠註解（「與某檔相同」）或一個讀對方原始碼的測試維持一致——那種一致要人記得才成立。
真正會算出不同結果的只有少數幾組，列在批次 B1。

## 一、已收斂（本 PR）

守門測試：`packages/markdown/src/test/guards/crossPackage.guard.test.ts`（掃四個套件的正式程式碼）。

| # | 規則 | 之前的位置 | 現在的唯一位置 | 行為變化 |
| --- | --- | --- | --- | --- |
| 1 | 任務身分：模組 id `tasks`、任務標籤功能 `tasks_checkable`／`tasks_dates`、`_task_*` 八個屬性鍵 | 後端 `spine/taskIdentity.ts`（`TASKS_MODULE_ID`、`NOTE_TASK_FUNCTION`、`K`）；前端 `lib/tasks/noteTasks.ts`（功能常數一份，`TASKS_MODULE_ID` 在同檔又一份）、`lib/noteTaskWrite.ts`（五個鍵）；後端 `taskListFile.ts`、`backupArchive.ts` 直接寫鍵字串 | `@onden/markdown` `sharedContract.ts`：`TASKS_MODULE_ID`、`NOTE_TASK_FUNCTION`、`TASK_ATTR` | 無（值相同；`taskIdentity`、`noteTasks` 仍用原名匯出，呼叫者不用改） |
| 2 | 發布頁會畫的邊類型 `knowledge_link`／`suggested_link`／`nav_link` | 後端 `modules/website/publishing/snapshot.ts`（陣列，註解寫「前端是同一份清單」）；前端 `lib/edgeRoles.ts`（`Set`） | `sharedContract.ts` `PUBLISHED_EDGE_TYPES` | 無 |
| 3 | 數字上限：回溯一次最多 2000 則、標籤頁最多 100 列、密碼 8–128 字 | 後端 `history/rewind.ts`／前端 `history/rewindApi.ts`；後端 `publishing/siteRows.ts`／前端 `website/studio/editorData.ts`；後端 `authPasswordRules.ts`／前端 `lib/passwordRules.ts`（外加一個讀後端原始碼比對的測試） | `sharedContract.ts` `REWIND_MAX_NOTES`、`TAG_PAGE_ROWS_MAX`、`PASSWORD_MIN_LENGTH`、`PASSWORD_MAX_LENGTH` | 無。刪除 `frontend/src/test/passwordRules.test.ts`（兩邊現在是同一個值，測試無事可驗） |
| 4 | 檢視（saved view）的內建欄位 `title/slug/updated_at/created_at/sort_order`、篩選運算 `eq…lte` | 後端 `filter/sqlClauses.ts`（欄位集合與 `FilterOp` 型別）、`nodeQuery.ts`、`tagViews.ts`（共三份運算清單）；前端 `viewLayoutKit/groupRows.ts`、`collections/ViewBuilder.tsx`（註解「Keep these in lock-step」） | `sharedContract.ts` `BUILT_IN_FIELD_NAMES`、`FILTER_OP_NAMES`、`FilterOpName` | 無；`FilterOp` 型別與兩個 zod enum 都由同一份推導 |
| 5 | UUID 長相（8-4-4-4-12） | 後端 `routes/nodes.ts`（兩處）、`history/agentRuns.ts`、`backupFile.ts`（兩處）；前端 `lib/data/syncEngine.ts`；`markdown/nodeRef.ts` | `markdown/uuid.ts`：`isUuid`、`UUID_SOURCE`（要在字串裡找 id 的人用 source） | 無（`backupFile` 維持只收小寫，因為它原本沒有 `i`） |
| 6 | `#rrggbb` 顏色驗證 | 後端 `systemAttributes.ts`、`edgeManifest.ts`、`agentTools/proposeTagPack.ts`、`actorPrefs.ts`；前端 `lib/noteMarks.ts` | `markdown/color.ts` `isHexColor` | 無；`actorPrefs` 原本只收小寫，保留（`isHexColor` 且全小寫）。`site/src/validate.ts` 是例外，見 B2-4 |
| 7 | `^id` 的字元集 | 後端 `modules/tasks/placement.ts`（兩處）、`services/taskListFile.ts` 各自寫 `[A-Za-z0-9-]` | `markdown/blockId.ts` `BLOCK_ID_CHARS`（編輯器補全早已用它） | 無（同一字元集；64 字上限沒套用，見 B2-5） |

呼叫者少理解的概念：不用再問「前端這個常數是不是跟後端同一個」「這個 id 正規式要不要 `i`」「新增篩選運算要改幾處」。

### 為什麼放 `@onden/markdown`，不開新套件

markdown 已是四個套件都依賴、也已放了跨端契約的地方（`mediaTypes.ts` 的 `MAX_REQUEST_BYTES`、`noteLimits.ts`、`uuid.ts`）。
新套件要多一套建置、alias 與 tsconfig 路徑；site 核心與本機資料庫 worker 為了控制大小，每個子路徑出口都要在多個設定檔登記
（`block-id` 就登記了 site、backend、frontend 的 tsconfig 與 vite／vitest 設定）。
`sharedContract.ts` 只放純資料與型別、沒有 import，本機資料庫 worker 也不經 index（它只用 `@onden/markdown/snippet`、`page-text` 子路徑）。

## 二、待辦（尚未收斂）

每項寫：規則、位置、歸屬、差異輸入（兩邊會算出不同結果的輸入）、風險。

### 批次 B1：會算出不同結果，值得先處理（需要先決定哪邊對）

**B1-1 字數（編輯器顯示的「字數」與發布頁閱讀時間）**
- 位置：前端 `lib/wordStats.ts`（自己的 `CJK` 與剝語法規則）；`markdown/readingTime.ts`（`CJK`、`proseOf`）。閱讀時間已共用 `readingMinutes`，**字數沒有**。
- 歸屬：`@onden/markdown` 新增 `countWords`，與 `readingMinutes` 共用 `proseOf`。
- 差異輸入：
  - `~~~\nsome code words\n~~~`：前端只剝 ``` 圍欄，`~~~` 圍欄內的字會算進字數；`readingMinutes` 兩種圍欄都剝。
  - 以 `---` frontmatter 開頭的筆記：前端沒有先剝 frontmatter，key／value 會算成字；`readingMinutes` 先 `stripFrontmatter`。
  - 長音 `ー`（U+30FC，如「カー」）：前端的 `CJK` 範圍含它，算 1 字；`\p{Script=Katakana}` 不含，被當成英文字詞。
  - 韓文字母 `ㄱ`（Jamo）：`\p{Script=Hangul}` 算 CJK，前端的 `가-힯` 不算。
- 風險：中。字數是使用者看得到的數字，統一後有些筆記的數字會變。要先決定長音算不算字，PR 說明列出變化；以 fast-check 對照新舊算法。

**B1-2 發布頁的自訂 CSS 消毒**
- 位置：後端 `modules/website/publishing/htmlUtils.ts`（`sanitizeCustomCss`：截 50,000 字、`<`→`\3c `）；`site/src/css.ts`（`sanitizeSiteCss`：另外丟掉 `@import` 與 `@\` 跳脫）。後端註解寫「MUST stay equal to frontend `lib/customCss.ts`」，但那個檔案已不存在，註解是過期的。
- 歸屬：`@onden/site` 的 `css.ts`（站台 CSS 的入口）。
- 差異輸入：`@import url(https://example.test/x.css);`——`sanitizeCustomCss` 原樣保留（只換 `<`），`sanitizeSiteCss` 丟掉。
- 風險：中高，是安全規則。先確認「站主自己的 CSS 可不可以 `@import`」是產品決定（`sanitizeCustomCss` 的註解寫「作者擁有網站，除了防逃脫不另限制」，看起來是刻意的）。若刻意，兩個函式是不同規則，只需改掉過期註解；若不是，改成共用並補測試。

**B1-3 鬆散的 UUID 檢查**
- 位置：後端 `modules/rss/routes.ts`、`services/githubBackup.ts`、`services/agentSessions.ts`（`[0-9a-f-]{36}`）；`services/tasksStore.ts`（`[0-9a-f]{8}-[0-9a-f-]{27}`）；`services/backupRestore.ts`、`services/exportZip.ts`（`onden://node/` 後面 `[0-9a-fA-F-]{36}`）。
- 歸屬：`isUuid`／`UUID_SOURCE`（已在 markdown）；`onden://node/` 這兩處改用 `nodeRefId`／`NODE_REF_PREFIX`。
- 差異輸入：36 個連字號，或 `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaaa`（尾巴多一格）會通過鬆散檢查而被 `isUuid` 拒絕；通過後多半在資料庫 `::uuid` 轉型才失敗。
- 風險：低到中。收緊後原本在深處失敗的輸入會提早以 400／404 回應，要逐處確認回應碼不違背既有 API 契約；`onden://node/` 兩處在備份還原與匯出，改前要有往返測試。這些都在 backend 內部，建議交給掃 backend 內部的任務一併處理。

### 批次 B2：值相同、成本低，需要先決定共用點

- **B2-1 `newBlockId`**：前端 `lib/data/draftActions.ts`（4 位元組→8 個十六進位字）；後端 `services/blockNodes.ts` 與 `services/agentSessions.ts`（`randomBytes(4).toString("hex").slice(0, 6)`，6 字）。差異：兩邊新 id 的長度不同。要共用得先決定長度；本批不動，因為會改變新 id 的長度（產品行為）。後端兩份在 backend 內部。
- **B2-2 任務狀態清單**：前端 `lib/tasks/noteTasks.ts`（`todo/doing/waiting/done/cancelled`）；後端 `modules/tasks/agenda.ts`（`TASK_STATUSES`，多一個 `later`）、`modules/tasks/noteUpdate.ts`（`NOTE_STATUSES`，與前端同五個）。歸屬：`sharedContract.ts`。
- **B2-3 保留標籤的 key**：後端 `spine/reservedTagKeys.ts`（`config`、`page`）；前端 `lib/systemNodes.ts` 的 `ReservedTagKey`（`"task" | "workspace-config" | "page"`，多了 migration 135 之後後端已不保留的 `task`）。歸屬：`sharedContract.ts`。
- **B2-4 site 的 `#rrggbb`**：`site/src/validate.ts`。site 核心只 import `@onden/markdown/block-id` 一個子路徑，為的是編譯後的核心不拖進整個 index。要共用得新增子路徑 `@onden/markdown/color`，並在 `markdown/package.json`、site 的 tsconfig 與 vitest 設定、backend／frontend 的 alias 登記。守門測試把這一處列為例外並寫明原因。
- **B2-5 `^id` 的長度上限**：後端 `placement.ts`（`after_block_ref`、`takenRefs`）、`taskListFile.ts`（`TAIL_REF`）都沒有 64 字上限，`markdown/blockId.ts` 的 `BLOCK_ID_MAX` 有。差異輸入：65 字以上的 `^id` 後端當成 id，markdown 掃描器不當成。收斂用 `BLOCK_ID_PATTERN`，並確認任務產生的 `^t-…` 參照不會超過 64。

### 批次 B3：該用「對齊測試」，不是共用（SQL 與 TS 兩種寫法）

- **B3-1 能不能放在某個父層下**：前端 `lib/data/placement.ts` `canPlaceUnder`（TS，決定選單該不該出現）；後端 `services/nodePlacement.ts` `canPlaceUnder`（真正的伺服器判斷）。兩邊各有測試（`placement.test.ts`、`reparentOwner.test.ts`），**沒有共用的 fixture**。照 `taskBucketRule.integration.test.ts` 的做法：一份「父類型 × 子類型 × 角色」fixture，前端單元測試與後端整合測試都吃同一份。
- **B3-2 發布的邊規則**：前端 `lib/edgeRoles.ts` `publishes()`（active ＋ 類型在清單中）；後端 `snapshot.ts` 的 SQL。類型清單已共用（本 PR #2）；`status = 'active'` 這半仍兩處各寫，加一個小對齊測試即可。
- **B3-3 系統節點**：前端 `lib/systemNodes.ts` `isSystemNode`；後端 `spine/reservedNodes.ts` `NOT_SYSTEM_NODE_SQL`，已有 `tagMembershipParity.json` 對齊。`services/dayLens.ts` 的 `LENS_NODE_FILTER` 另外寫了一份，不在 fixture 內（backend 內部）。

### 批次 B4：看起來重複、其實不是同一條規則（不收斂）

- `URL_RE`：後端 `services/harness/scope.ts`（工具輸入中的網址，排除 `)]>"'`）與前端 `lib/share/sharePayload.ts`（分享文字中的網址，排除全形括號）——用途與終止字元都不同。
- 後端 `publishing/css.ts` 的背景色檢查接受 `#rgb` 到 `#rrggbbaa`（3–8 位），不是 `#rrggbb`。
- `workspaceTimeZone`（後端 `localDay.ts`、前端 `lib/localDate.ts`）：兩邊都是讀各自狀態的存取器，不是規則。
- `TITLE_MAX`（`blockTasks.ts` = 500、`blockChild.ts` = 50）：同名不同義。
- `DAY_MS`（`review/fsrs.ts`、`markdown/calendar.ts`）：前者是 FSRS 排程自己的毫秒換算，後端內部，不屬跨套件。
- `ENTITIES`（後端 `modules/rss/htmlToMarkdown.ts` 與前端 `lib/siteSearch.ts`）：前者要把 RSS 的 HTML 轉成 Markdown（具名實體很多），後者只還原伺服器自己轉義過的幾個；集合不同是刻意的。

## 三、之後可派工的批次

| 批次 | 內容 | 預估範圍 | 前置決定 |
| --- | --- | --- | --- |
| A（半天） | B2-2 任務狀態清單、B2-3 保留標籤 key 進 `sharedContract.ts`；守門加兩個名字 | 前端約 3 檔、後端約 3 檔 | 前端 `ReservedTagKey` 要不要拿掉 `task` |
| B（1 天） | B1-1 字數：`countWords` 進 markdown，編輯器改用；fast-check 對照舊算法 | markdown 1 檔、前端 2 檔 | 長音算不算字；`~~~` 與 frontmatter 不算字 |
| C（半天，只動後端） | B1-3 鬆散 UUID 檢查換 `isUuid`／`nodeRefId`；先補回應碼測試 | 後端 6 檔 | 與 backend 內部任務協調 |
| D（1 天） | B3-1 placement fixture 兩端對齊；B3-2 邊規則對齊 | 前端 1 測試、後端 1 整合測試、1 份 fixture | 無 |
| E（待決定） | B1-2 自訂 CSS：先決定 `@import` 是否允許，再決定共用或只改註解 | site、後端各 1 檔 | 產品與安全決定 |
| F（待決定） | B2-1 `newBlockId` 長度、B2-5 `^id` 長度上限、B2-4 site 子路徑 | markdown 加子路徑、設定檔多處 | 新 id 要幾個字 |

## 四、驗證（本 PR）

見 PR 說明：markdown、frontend、backend 的 tsc、lint、完整 vitest（`--maxWorkers=2`），前端 build（含 worker 大小檢查），根目錄 `dup:check`。
