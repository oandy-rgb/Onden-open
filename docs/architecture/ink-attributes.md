# 筆跡存在哪個屬性（`ink_data`、`board_ink`）

> 狀態：現行（最後確認 2026-11-02）
> 涵蓋：packages/markdown/src/sharedContract.ts, packages/frontend/src/lib/data/inkWriter.ts, packages/frontend/src/lib/ink/store.ts, packages/backend/src/services/attributeWrites.ts, packages/backend/src/services/history/bodyEvents.ts, packages/backend/src/services/history/inkChanges.ts

一篇筆記最多有三份筆跡，各有自己的屬性，格式與寫入路徑相同、用途不同（第三份 `note_ink` 是 2026-11-12 加的「手寫」分頁，見文末）：

| 屬性 | 誰讀寫 | 內容 | 常數 |
| --- | --- | --- | --- |
| `ink_data` | 「內容」分頁（手寫頁 `InkNodeView`）、PDF（信封，`lib/pdf`） | 手寫頁的一頁 `InkDocument`，或 PDF 信封 `{version:1, pages, annotations}` | `INK_DATA_ATTR` |
| `board_ink` | 白板分頁的筆層（`CanvasInkLayer`） | 一頁 `InkDocument`（白板座標，沒有頁寬邊界） | `BOARD_INK_ATTR` |
| `note_ink` | 「手寫」分頁（`modules/handwriting` 的 `HandwritingPane`） | 手寫筆記同一種頁面信封（第一頁＋`morePages`） | `NOTE_INK_ATTR` |

常數與 `INK_PAGE_ATTRS`、`isInkPageAttr` 在 `@onden/markdown`（`sharedContract.ts`，也從 `@onden/markdown/ink` 匯出）。
**一個屬性＝一種視角的筆跡**：以前（migration 138 起）白板筆層也存在 `ink_data`，所以在白板上畫幾筆，「內容」分頁就變成手寫頁
（`OverviewEditor` 看到 `ink_data` 就換成 `InkNodeView`），反過來手寫頁的筆畫也會出現在白板上，兩邊座標系又不同。
現在 `OverviewEditor` 只讀 `ink_data`、白板只讀寫 `board_ink`，互相看不到。

## 同一條路，鍵是參數

不是第二套寫入：`saveInk(nodeId, doc, base, { attr })`（`lib/data/inkWriter.ts`）、`loadInkPage(nodeId, attr)`（`lib/ink/store.ts`）、
`PUT /api/nodes/:id/attributes/:key`（`services/attributeWrites.ts` 的 `MERGED_KEYS`＝`INK_PAGE_ATTRS` ＋ 頁面圖層 ＋ `note_pages`）走同一個 codec、
`base_value` 三方合併（`mergeInk`）、`value_patch`（`patchedBody.ts`）、離線佇列與 ATTRIBUTE_SET 事件（內容定址：`attributeSnapshot.encodeSnapshot`）。
懶 bootstrap 把兩者都留到打開才載（`BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS`、本機資料庫 worker 的 `DRAWING_KEYS_SQL`），`/sync/drawings` 依鍵列出。

## 每一處 `ink_data` 是改還是不用改

| 位置 | 判定 | 理由 |
| --- | --- | --- |
| `@onden/markdown` `sharedContract.ts`（`EDITOR_STORAGE_ATTR_KEYS`） | 改 | 加 `board_ink`（屬性面板不列為可編輯欄位）；新增三個共用常數 |
| `markdown/ink*.ts`、`inkFormat.ts`（codec、合併、diff） | 不用改 | 鍵無關；`board_ink` 是同一個單頁格式 |
| `markdown/pageText.ts`、`pageImages.ts`、`inkPages.ts`、`inkSvg.ts`、`inkChange.ts` | 不用改 | 手寫頁／PDF 的頁面層與繪圖；白板筆層沒有文字框、圖片層、單位頁 |
| 前端 `lib/ink/store.ts` | 改 | `InkAttributeKey` 加 `board_ink`；`loadInkPage(nodeId, attr)` |
| 前端 `lib/data/inkWriter.ts` | 改 | `saveInk` 的 `options.attr`（路徑、鏡像、離線佇列都跟著鍵） |
| 前端 `lib/data/patchedBody.ts` | 改 | `value_patch`／`base_value` 的路徑正規式用 `INK_PAGE_ATTRS` |
| 前端 `lib/data/propertyWriter.ts` | 改 | 還原衝突後不把筆跡放進筆記清單的記憶體 attrs（兩個鍵都是） |
| 前端 `lib/localDbWorker.ts`（兩處） | 改 | 筆跡不載進記憶體 attrs map、分頁載入跳過 `board_ink` |
| 前端 `lib/createKinds.ts` | 不用改 | 「手寫筆記」建立時寫 `ink_data`，正是手寫頁 |
| 前端 `lib/embedSources.ts`、`lib/embeds.ts` | 不用改 | `![[手寫]]` 嵌入只畫手寫頁；白板筆層不是可嵌入的「圖」 |
| 前端 `components/CanvasInkLayer.tsx` | 改 | 讀寫 `board_ink` |
| 前端 `components/OverviewEditor.tsx`、`InkNodeView.tsx`、`PdfNodeView.tsx` | 不用改 | 只認 `ink_data`（這正是修正） |
| 前端 `components/InboxReview.tsx`、`ConflictList.tsx` | 改 | 筆跡變更的預覽、筆跡衝突卡片用 `isInkPageAttr` |
| 前端 `modules/importers/drawingImport.ts`、`excalidraw.ts` | 不用改 | 匯入的繪圖是手寫筆記，寫 `ink_data` |
| 前端 `modules/review/ReviewPanel.tsx`、後端 `modules/review/service.ts` | 不用改 | 複習卡的手寫面是筆記的手寫頁 |
| 前端 `lib/pdf/*` | 不用改 | PDF 信封 |
| 後端 `services/attributeWrites.ts` | 改 | `MERGED_KEYS` 含 `board_ink`（`base_value` 合併、衝突紀錄） |
| 後端 `services/eventLog/attributeSnapshot.ts` | 改 | `board_ink` 的事件同樣內容定址（`value_ref`），復原讀得到 |
| 後端 `services/eventQuery.ts` | 改 | `board_ink` 的 ATTRIBUTE_CONFLICT 列表同樣不帶兩份整張圖 |
| 後端 `services/sync/bootstrap.ts`、`sync/drawings.ts`、`routes/sync.ts` | 改 | `BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS`＝`INK_PAGE_ATTRS` ＋ `pdf_annotations` ＋ `pdf_text`（2026-11-17 起）；`drawings.ts` 用同一串，不另寫 |
| 後端 `services/backupArchive.ts` | 改（計數）／不用改（內容） | 備份側車帶節點的**所有**屬性，`board_ink` 不會遺失；`counts.drawings` 加算 `board_ink` |
| 後端 `services/exportZip.ts`（`DATA_ATTRIBUTES`） | 改 | 同 `ink_data`：資料屬性不寫進 frontmatter。**`board_ink` 因此不在 Markdown 匯出中**，完整備份才有；`feat/export-ink` 若要匯出白板筆跡須以 `board_ink` 為來源 |
| 後端 `modules/importers/markdown/note.ts`、`obsidian/import.ts` | 不用改 | 匯入的繪圖是手寫筆記 |
| 後端 `modules/website/publishing/drawingEmbeds.ts`、`handwritingPages.ts` | 不用改 | 只發布手寫頁（`ink_data` 且非 PDF）；白板筆層不發布，與之前白板不發布一致 |
| 後端 `services/history/bodyEvents.ts`（`inkEventSql`）、`inkChanges.ts`、`activity.ts`、`routes/nodes.ts` `/ink-versions`、`/ink-edits`、`/ink-change`、`nodeReads.ts` | 改 | 歷史有兩種筆跡，`kind`＝`handwriting`（`ink_data`）／`board`（`board_ink`，另含 172 之前存在 `ink_data` 的舊儲存）。同一組查詢，`kind` 是參數，不複製；見下節「歷史」 |
| 前端 `lib/data/reads.ts`（`InkVersion`、`inkEdits`、`inkChange`）、`NoteHistory`、`WorkspaceHistoryNoteRow`、`InkChangeDisclosure` | 改 | 讀取帶 `kind`；標籤分「手寫」與「白板筆跡」；還原走 `nodeMutations.restoreInkVersion` |
| 後端 `routes/nodes.ts` 的屬性讀取 | 不用改 | 依鍵讀，`?keys=board_ink` 直接可用 |
| `packages/backend/scripts/drillInvariants.ts` | 改 | 新增 `ink_pages_notes`、`ink_bytes`（總量不能少）與 `ink_data_rows`／`board_ink_rows` |
| `canvasExport`（白板匯出 JSON Canvas） | 不用改 | 只匯出卡片、分區與連線，本來就不含筆跡 |

## 歷史

兩份筆跡都進歷史，一份在「手寫改動」、一份在「白板筆跡改動」，不混在一起。`@onden/markdown` 的 `InkKind`（`handwriting`／`board`）與 `INK_KIND_ATTR`
決定每種筆跡存在哪個屬性；一則筆記的筆跡歷史（`inkChanges.ts`：計數、差異、版本列表、還原；`nodeReads.ts` 的 `/ink-versions`）讀版本表 `note_versions`（歷史複製第 2 批，
migration 220；每種筆跡一個 `unit`＝它的屬性鍵，`INK_KIND_ATTR[kind]`），版本的身分是 `version_key`；`activity.ts`（「這天編輯過的筆記」、活動圖）仍讀事件，用
`services/history/bodyEvents.ts` 的 `inkEventSql(alias, kind)`——「這個事件算哪一種筆跡儲存」的唯一定義。

| 項目 | 做法 |
| --- | --- |
| 這天編輯過 | `editEventSql` ＝ 內文儲存 ∪ 任一種筆跡儲存；兩種筆跡一起算進同一個編輯（5 分鐘內同一人連續存） |
| 當天卡片 | `DayNote.ink`（手寫）與 `DayNote.board_ink`（白板），各自的畫了／擦掉筆數與「看改了哪裡」 |
| 一則筆記的歷史 | `GET /api/nodes/:id/ink-edits?kind=`、`/ink-change?kind=`、`/ink-versions?kind=`；沒帶 `kind` ＝ `handwriting`，不認得的值 400 |
| 還原 | `POST /api/nodes/:id/ink-versions/:id/restore?kind=`（`:id` 是版本的 key；這台事件的編號再收一個版本）：用目前的寫入權限對**該種筆跡自己的屬性**做一次新的 `setNodeAttribute`（整張取代、不合併），產生新的 ATTRIBUTE_SET，所以還原本身也進歷史、可以再回去。那個版本不屬於該 `kind`（例如白板的版本拿來還原手寫）→ 404，不碰另一個屬性 |
| 差異預覽 | 兩種都用 `inkChangeView`＋`inkThumbnailSvg`；畫布是筆跡外框，所以白板（沒有頁寬邊界）不會被切在頁寬 |

**172 搬過的白板**（`board_ink_moves.action = 'moved'`，且沒被 `restoreBoardInk.sql` 還原）：搬之前的儲存在事件紀錄裡的鍵仍是 `ink_data`
（`domain_events` 不改寫）。**版本表在 migration 220 鑄版本時就照這個判斷把 `unit` 寫死**（之後再復原 172 的搬移，舊版本不會跟著搬回手寫頁）；`inkEventSql`（仍讀事件的讀者）用 `board_ink_moves` 判斷：該筆記 `ink_data` 事件的 `created_at < moved_at` 屬於 `board`，之後的 `ink_data` 事件
（筆記後來真的變成手寫頁）屬於 `handwriting`。還原搬移前的舊版本時寫進 `board_ink`。
**模糊的**（`action = 'copied'`）：無法分辨，搬之前的舊儲存維持在手寫歷史，搬之後的白板儲存在白板歷史。
179 決定為白板的筆記改成 `action = 'moved'`、`moved_at` 是決定的時間，所以它到決定前的儲存都算白板。

## migration 172 與還原

白板的筆跡搬家規則見 `db/migrations/172_board_ink_attribute.sql`，記錄在 `board_ink_moves`（每筆：`action` moved／copied、`reason`、`suggested`
board／handwriting／unknown、`signals` 證據、`value_hash`）。

- **確定是白板**（在 `canvas_note_conversions`）：`ink_data` 那一列改名為 `board_ink`（同一列，不改 `updated_at`）。
- **畫在頁面外**（有白板分頁、不在上面，且有筆畫點在頁面左邊、上方或超過頁寬）：手寫頁放不下這種點，只有白板會有，所以和舊白板一樣改名搬過去（`reason` = `outside_page`）。2026-11-02 正式站的 4 則都屬這類，擁有者確認都是白板。
- **模糊**（有白板分頁、不在上面，筆畫都在頁面內）：複製到 `board_ink`，`ink_data` 保留；證據是「有內文」「筆畫超出頁寬」「第一次 `ink_data` 寫入是否跟著筆記建立或是空頁（＝本來就是手寫頁）」。
  由擁有者看 `suggested` 決定（SQL 在 migration 檔頭註解），決定後填 `decision`。
  2026-11-07 擁有者決定有文字的都是白板（migration 179）：移除 `ink_data`，內容分頁變回文字；172 之後才畫在內容分頁的筆畫先依 id 併進 `board_ink`。沒有文字的、頁面上有文字框或圖片的（`page_text`、`page_images`，白板筆層顯示不了）留著，`decision` 仍是空的。
- **不動**：PDF 信封、有 `pdf_url`、沒有白板分頁、讀不出來、沒有筆畫、已經有 `board_ink`。
- 還原：`packages/backend/scripts/restoreBoardInk.sql`（`psql -1`）。測試：`src/test/boardInkMigration.integration.test.ts`、`boardInkDecision.integration.test.ts`（179）。

遷移期（舊版前端還開著）：舊版會把白板筆畫寫回 `ink_data`。新版白板只讀 `board_ink`，所以那些筆畫暫時看不到；
不自動搬（無法分辨是白板還是手寫頁）。部署後重新載入即可。

## `note_ink`：任何筆記的「手寫」分頁（2026-11-12）

一般筆記也能開「手寫」分頁，筆畫存在 `note_ink`，不是 `ink_data`（否則「內容」分頁會被換成手寫頁）。與 `board_ink` 一樣只是 `INK_PAGE_ATTRS` 多一個鍵：
上表每一列「依 `INK_PAGE_ATTRS` 走」的位置（合併、內容定址、延後載入、`/sync/drawings`、備份計數、Markdown 匯出排除）自動涵蓋；另外明確處理的有
`inkEventSql(…, "note")`（歷史 `kind=note`）、`exportInk`（頁接在內容之後）、`drillInvariants` 的計數、備份還原的分頁（`handwritingTabOf`）、複製筆記帶分頁。
`InkKind` 多了 `"note"`；`DayNote` 沒有對應欄位。分頁本身是 `function_refs` 的一列（layout `handwriting`），刪分頁不動 `note_ink`。決定見 [decisions-canvas.md](../agents/decisions-canvas.md)。

## `note_pages`、`pdf_text`：不是筆跡（2026-11-17）

`note_pages`（`NOTE_PAGES_ATTR`）只記一則筆記有哪些頁、什麼順序（空白頁與 PDF 檔的頁段）；那些頁的筆畫仍在 `note_ink`，以頁 key 為鍵。
`pdf_text`（`PDF_TEXT_ATTR`）是 PDF 各頁的文字 `{ [頁 key]: 文字 }`，給語意索引與 `getNode` 的摘要用（`services/pdfText.ts`）；**伺服器的文字搜尋還沒有讀它**。
兩者都不在 `INK_PAGE_ATTRS`，在 `EDITOR_STORAGE_ATTR_KEYS`（屬性面板不列）。`note_pages` 是合併寫入的鍵（`MERGED_KEYS`，`mergeNotePages`）、跟著精簡 bootstrap 走；
`pdf_text` 在 `BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS`，所以不在精簡 bootstrap 裡，並和筆跡一樣由 `/sync/drawings` 列出（`drawings.ts` 用同一串鍵）。
