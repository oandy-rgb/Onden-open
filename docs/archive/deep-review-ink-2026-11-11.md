# 深入審查：手寫與頁面圖層（ink）— 2026-11-11

> 狀態：歷史紀錄（全部處理完；修正見 #1498，最後確認 2026-11-12）
> 這次只寫了合併層、後端資料流與頁面工作階段的測試；**前端存檔管線（`saveInk` → 寫入佇列 → 伺服器）沒有做端到端的注入失敗測試**，列在最後的「沒查到的範圍」。

## 總表

| 編號 | 一句話 | 嚴重度 | 狀態 | 測試 |
| --- | --- | --- | --- | --- |
| ink-1 | 一次沒被伺服器收下的存檔，會讓後面的存檔把它獨有的筆畫判成「已被刪除」 | 中（觸發窄） | 已修（PR #1490）；端到端已重現（`inkBaseAfterRejection.test.tsx`）| `packages/markdown/src/inkDeepReview.test.ts` |
| ink-2 | 較新版本寫的「更多頁」（`morePages` version 2）被這個版本讀進來再存回去就整批消失 | 低（要有新舊版本並存） | 已修（PR #1490） | 同上 |
| ink-3 | 白板的筆畫層（`board_ink`）不會出現在 Markdown 匯出的圖片裡 | 中 | 已修（PR #1490） | `packages/backend/src/test/inkDeepReview.integration.test.ts` |

新型測試（沒找到問題，留作安全網）：

- 性質測試：兩台裝置從同一個起點各自新增筆畫，不論誰先存，合併後沒人的筆畫消失、結果相同（`inkDeepReview.test.ts`，ink-3 性質）。
- 性質測試：多頁手寫本隨機「畫／頁面卸載／重掛／套用」之後，每頁最後畫的內容都在（`packages/frontend/src/test/properties/inkPageSession.property.test.ts`）。
- 兩個功能交會：手寫四個屬性（`ink_data`、`board_ink`、`page_text`、`page_images`）× 垃圾桶復原、× 複製筆記（後端整合測試），都原樣保留。

## 細節

### ink-1 沒被收下的存檔會連累後面的存檔（中，信心：合併行為高、實際觸發機率低）

- 位置：`components/OverviewEditor.tsx` `saveSurfaceInk`、`components/CanvasInkLayer.tsx` `persist`——送出存檔後**立刻**把「這次的內容」當成下一次存檔的 base，不管這次有沒有被伺服器收下。伺服器端三向合併在 `packages/markdown/src/jsonMerge.ts` `mergeById`：「base 有、現存沒有、這次沒動」＝「另一邊刪掉了」，維持刪除。
- 觸發：存檔 V1 被永久拒絕（例如 413 過大、權限剛被收回又恢復）或被丟棄，接著使用者又畫一筆存成 V2（base＝V1）。伺服器仍是 V1 之前的內容，於是 V1 獨有的筆畫在 V2 的結果裡消失；畫面上還看得到，重新載入後才不見。
- 後果：使用者以為已畫的筆畫，重新開啟後少了一些。本機副本（mirror）也會被伺服器的合併結果覆蓋。
- 重現：`mergeInk(base=V1, stored=B0, incoming=V2)` 得到 `[a, c]`，應為 `[a, b, c]`。**沒有**用真的 `saveInk` ＋ 失敗回應做端到端驗證；一般的離線／5xx 走佇列依序重送，base 的順序正確，不受影響。
- 建議修法：base 只在「伺服器接受」（`accepted` 回呼）時前進；被拒時保留舊 base。工作量小（兩個宿主＋ `saveInk` 回報結果）。

### ink-2 讀進來再存回去少東西：`morePages` 版本不認得時整批丟掉（低）

- 位置：`packages/markdown/src/inkFormat.ts` `decodeInk`：`asUnits(value.morePages)` 要求 `version === 1`，否則 `delete page.morePages`。與格式演進規則（「未知欄位原樣保留」）不一致；`units` 有舊欄位當備份所以丟了沒事，`morePages` 沒有。
- 觸發：較新版本把第二頁以後存成 `morePages.version: 2`，這個版本（舊 App／離線裝置）開啟並存檔。`requires` 沒有寫入時不會變唯讀。
- 後果：該筆記第二頁以後的手寫全部消失（合併時視為「這邊刪掉」）。
- 建議修法：`morePages` 版本不認得時整份原樣保留並視為唯讀（或寫入 `requires`）。小。目前沒有 version 2，是為之後的格式演進設的防線。

### ink-3 白板筆畫層不進 Markdown 匯出（中）

- 位置：`packages/backend/src/services/exportInk.ts` `noteInkFiles`：白板分支（`node_type === "canvas"` 或有白板分頁）讀的是 `ink_data`；migration 172 之後白板筆畫層存在 `board_ink`。只畫在白板上的筆畫，匯出的 Markdown 沒有那張圖；檔頭註解卻寫「whiteboard note: its ink layer」。
- 後果：使用者匯出 Markdown 以為白板上手寫的東西在，實際沒有（完整備份有帶，所以不是資料遺失）。
- 重現：只有 `board_ink` 的白板筆記，匯出 zip 內沒有 `attachments/ink-<id>-*.svg`。
- 建議修法：白板分支改讀 `board_ink`，`ink_data`（筆記自己的手寫頁）另畫一張。小，連同匯出測試。

## 查過沒問題的

- 離開頁面時存檔：`writeLifecycle` 在 keepalive 寫入前同步記下復原副本；超過 60 KB 的本體不帶 keepalive（`withoutOversizedKeepalive`），由復原副本保護。
- 兩台裝置同時畫：伺服器在列鎖內做三向合併，兩邊新增的筆畫都保留（性質測試 300 組，加既有 `inkMerge.integration.test.ts`）；只有兩邊改同一個項目才記衝突。
- 頁面卸載／重掛：`InkPageSession` 卸載時保留未寫入的編輯（性質測試 200 組，沒有消失）。
- 垃圾桶復原、複製筆記：四個手寫屬性原樣保留（整合測試）。
- 送出體積：patch 取代整份值；整份值要超過約 19 MB（`MAX_REQUEST_BYTES` 20 MB 扣 1 MB）才會被丟掉 base，實際上的手寫頁不會到。
- 讀不懂的資料：整份壞掉當「沒有」（開空白頁），格式有壞的單筆被丟掉屬於「格式錯誤才修」，符合註解的規則；`features/requires` 唯讀機制有單元測試。

## 這次沒查到的範圍

- 前端存檔管線端到端的注入失敗（第 N 次寫入丟例外、回應遺失、中途重新整理）與 `rejectPendingWrite` 後 base 的狀態——ink-1 的實際觸發就在這裡。
- 擦除／套索搬移／復原重做與存檔交錯（只有 `InkPageSession` 層的性質測試，引擎層既有 `ink.property.test.ts`）。
- 一萬筆以上的大頁面效能與請求大小的實測。
- 形狀辨識（停住修形）後的復原、PDF 螢光筆、歷史裡的 `InkVersion`／`DayInkChange`、備份還原的手寫（既有 `backupDownload` 測試有覆蓋，這次沒重審）。
- 真 Postgres：本次測試在 PGlite 上全部能跑，沒有需要補跑的項目。
