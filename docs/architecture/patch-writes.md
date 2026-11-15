# 只送差異的寫入

> 狀態：現行（最後確認 2026-11-01）

業主 2026-10-30：「所有地方都改成只送差異，看能不能共用」。

## 為什麼

一萬筆手寫的頁面，每次停筆存檔都上傳整張（約 5.9 MB），再加上合併用的原稿（`base_value`）約 12 MB；
三萬筆約 18 MB，超過 `MAX_REQUEST_BYTES`，寫入端只好丟掉原稿，伺服器就沒有三方合併，另一台裝置的筆畫可能被蓋掉。
這是正確性問題，不只是流量。長筆記的內文（`markdown` + `base_markdown`）同理。

## 一套設計

| 角色 | 唯一入口 |
| --- | --- |
| 產生差異、套用差異、雜湊 | `@onden/markdown` 的 `textPatch.ts`（`makePatch`／`applyPatch`／`hashText`） |
| 前端什麼時候把「整份＋原稿」換成差異 | `lib/data/patchedBody.ts`，由 `writeQueue.ts` 在**送出當下**呼叫 |
| 伺服器把差異還原成「新值」與「原稿」 | `services/patchedValue.ts` 的 `resolvePatched` |

- **線上格式**：整份值 `X` 的欄位改送 `X_patch`（筆記內文 `markdown_patch`；手寫 `ink_data`、白板筆層 `board_ink` 與頁面圖層 `page_text`／`page_images` 為 `value_patch`）。
  差異的 base 就是合併用的原稿，所以不再另送 `base_markdown`／`base_value`。
  `{ base_hash, hunks: [{ at, del, ins }] }`，位置以 UTF-16 code unit 計；`applyPatch` 嚴格：雜湊不符或越界就丟錯。
- **伺服器**：原稿＝目前存的值（雜湊相符，最常見）；否則在 `blobs` 找，但只找**這篇筆記自己歷史**提到的那份
  （`body_hash`、`value_ref`、`prev_field_values.value_ref`），不能拿別篇的雜湊把別篇內容讀出來；都沒有回
  409 `patch_base_unknown`。還原後交給原本的合併（diff3／`mergeInk`／…），合併邏輯不變。
- **前端**：寫入端與離線佇列照舊存**整份＋原稿**；送出當下才算差異，所以連續多筆離線存檔的 base 是上一筆被確認後的值。
  收到 409 `patch_base_unknown` 就用同一個 Idempotency-Key 改送整份一次。
  太小的值（合計少於 `MIN_PATCH_UNITS`）不值得，照舊送整份。
- 事件、blobs、存檔格式、合併演算法都不變。

## 各種寫入現況

| 寫入 | 欄位 | 合併 |
| --- | --- | --- |
| 筆記內文 | `markdown_patch` | diff3（`bodyMerge.ts`） |
| 手寫 `ink_data`、白板筆層 `board_ink` | `value_patch` | `mergeInk` |
| 頁面文字框 `page_text`、圖片 `page_images` | `value_patch` | `mergePageText`／`mergePageImages` |
| 網站外觀 chrome | 未做 | 無合併 |

- 手寫的原稿找得到：每次存檔，被取代的舊值都會以 `value_ref` 存進 blobs（`encodeSnapshot`）。頁面圖層的舊值是內嵌在事件裡、不在 blobs，
  所以原稿不是「目前的值」時回 409，前端改送整份一次（這些值小，代價低）。
- 送整份的備援保留舊行為：整份請求超過上限（`MAX_REQUEST_BYTES` 減 1 MB）時丟掉原稿，伺服器照單全收、不合併（`wholeBody`）。
  差異路徑不需要這個取捨：原稿只以雜湊出現。
- **chrome 沒做**：`chrome_base` 不是原稿文字而是一個版本戳（`rev`），伺服器只拿它判斷是否過期（409 `design_stale`），沒有合併；
  設計 JSON 也小。要做的話得先定義一份標準化的 JSON 文字當 base，收益與風險不成比例。

## 下載方向

只做了**手寫的離線副本**（`POST /api/sync/drawings`）：客戶端對已有舊副本的手寫附上 `have: { "<節點 id>:<key>": hash }`
（hash 來自 `planDrawings` 的 `stale`），伺服器若在這篇筆記自己的歷史裡還找得到那份（或剛好就是目前的值）就回 `value_patch`
（`services/sync/drawings.ts`，同一個 `keptText`），否則回整份；客戶端在主執行緒用 `applyPatch` 套到本機副本上
（`syncEngine.ts fetchDrawings`），套不上就不帶 `have` 再要一次整份。本機資料庫 worker 不引入差異程式
（它的大小預算只剩約 240 B），套用發生在 worker 之外，`replaceStaleAttributeRows` 的 `expected_hash` 守門不變。

其他下載先不做：

| 下載 | 判斷 |
| --- | --- |
| 內文離線下載（`/sync/bodies`） | 只抓本機**沒有**的內文，沒有舊副本可當 base，差異幫不上。 |
| 啟動／重新整理的 bootstrap | 同上；手寫值已延後到上面的下載。 |
| `/sync` 增量（`delta.ts`）裡被改過的筆記與屬性 | **值得，但留作下一批。** 別台裝置每存一次，這台就會收到整份內文（最多 2 MB）與整份 `ink_data`（一萬筆約 6 MB）。伺服器在組增量時不知道客戶端手上是哪一版，要做得靠事件裡的「前一版」（`prev_field_values.value_ref`、前一個 `body_hash`）附 `patch_from` 與 `value_patch`，客戶端雜湊對得上才套、對不上走上面的整份下載；套用要在本機資料庫 worker 內做，需先處理它的大小預算。 |
