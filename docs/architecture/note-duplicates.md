# 筆記安全副本（NOTE-11／PER-02／DEC-02）

> 狀態：現行（最後確認 2026-11-19）
> 涵蓋：packages/backend/src/services/noteDuplicate.ts, packages/frontend/src/lib/data/nodeActions.ts

普通複製使用 `POST /api/nodes/:id/duplicate`，JSON 可帶穩定的客戶端 UUID `{ "id": "…" }`，以及副本標題的結尾 `copy_suffix`（使用者語言的「 副本」，一行、最多 20 字、不含控制或零寬字元；形狀在 `@onden/contract` 的 `DuplicateNoteRequest`，舊的伺服器對這個欄位回 400，所以後端要先上或同時上），重試沿用 `Idempotency-Key`。首次成功回 `201` 與完整新節點；同鍵已提交的重送沿用共用 `200 { "deduped": true }`，客戶端以該 UUID 讀取或同步結果。只接受 live content 筆記；class tag、媒體、白板與帶 `#task` 身分的節點回 `422`。來源不可讀或已不存在時拒絕，拒絕不留下副本、標籤關係、成功事件或已提交的冪等鍵。

後端 `duplicateNote` 在同一事件交易內讀取來源，核對來源讀取、editor 建立角色、目前父層的 read／write_node、每個目前直接標籤的 apply 政策，再建立副本。即使後續屬性權限拒絕，整筆交易也回滾。直接標籤仍附在新節點，並各自有 `TAG_APPLIED` 歷史與關係狀態識別；該內部紀錄不執行欄位 default 或 template。複製的明確屬性產生各自 `ATTRIBUTE_SET` 事件。

普通副本的標題加請求帶來的 `copy_suffix`，沒帶就是 ` (Copy)`（前端用使用者語言的字並一起送出，離線先畫的標題與伺服器建的一致）；歷史 `as_new_node` 維持原 API wire shape 與 `[Restored]` 標題，用該事件 `body_hash` 的正文及 inverse patch 重建歷史內容，再搭配來源**目前**的父層、直接標籤與明確屬性。缺少可信的歷史正文或標題回 `history_incomplete`，不以今天的正文冒充歷史。歷史另存可以從保留的軟刪除來源讀取，仍要求新的 live 父層和現行標籤權限；它不修改原節點或撤回原事件的子操作。

副本也帶「內容」分頁的紀錄（連同 `hidden` 與位置）與「手寫」分頁的位置；沒有別的分頁可顯示時，伺服器把「內容」清回顯示（`functionRefs` 的 `keepContentTabShowing`，見 [decisions-ui.md](../agents/decisions-ui.md)）。

副本包含正文中的媒體引用、來源為 `ui`／legacy `explicit` 的獨立屬性（包括其中的媒體引用），不複製 row ID、版本、任務子節點、來源的明確圖邊、`dispatcher`／`markdown`／`frontmatter`／`derived` 屬性或 `_import_*` 索引。`_published` 的「發布」（`true`）不帶到副本，副本照它所在空間的規則；「不發布」（`false`）會帶過去，設成不上網站的筆記複製後也不會上去；使用者可見的 `_color`／`_pinned` 若是明確屬性則保留。正文中寫出的 wikilink 和 block marker 依新正文重建索引，沒有搬移來源的邊。複製不重新推導其他正文屬性，避免觸發 defaults／behaviours；日後正常編輯仍依一般編輯契約更新。

已存的檢視只帶兩種跟著資料走的分頁：「手寫」（筆畫在複製過去的 `note_ink`）與「內容」的紀錄（layout `content`，連同 `layout_config.hidden` 與位置；來源沒有這筆紀錄就不建，副本是內建的「內容」分頁）。其他檢視（表格、看板、白板…）是來源自己的，不複製；所以來源的「內容」是收起來的、而副本沒有別的分頁時，伺服器會讓副本的「內容」顯示（`services/functionRefs.ts` 的 `keepContentTabShowing`）。

UI 的筆記選單及側欄／白板節點選單僅對 content 顯示 Duplicate。前端 writer 使用新 UUID 與一般保存生命週期，區分伺服器確認和持久化離線佇列。離線請求在重連時按**伺服器當時**的來源內容建立；若來源或政策已改變，正常回報拒絕，佇列保留可恢復輸入。這項副本操作不承諾把離線瞬間的來源快照鎖定到伺服器。

實測、案例狀態及正式環境限制見[瀏覽器驗收紀錄](../archive/browser-acceptance-2026-09-21.md)。
