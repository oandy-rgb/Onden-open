# 前後端欄位合約

`api-shapes.json` 記錄後端實際回傳的 JSON **形狀**（欄位、型別、可否為 null、陣列元素形狀；不含任何值）。
它不是手寫的規格，而是後端測試跑真實組裝好的 app 後產生的；前後端各有一個測試讀它：

| 端 | 測試 | 失敗代表 |
| --- | --- | --- |
| 後端 | `packages/backend/src/test/apiContract.integration.test.ts` | 伺服器現在送的形狀和已提交的檔案不同（有人改了回應卻沒更新合約） |
| 前端 | `packages/frontend/src/test/apiContract.test.ts` | 前端型別要求的欄位，檔案裡沒有或型別不合（前端讀的和後端送的不一致） |

這樣兩邊不再各自用自己的想像測試：後端改欄位名，後端測試先紅；
重新產生合約後，前端測試會指出哪個前端型別讀不到。

## 改了 API 之後

```sh
cd packages/backend
UPDATE_CONTRACT=1 npm test -- src/test/apiContract.integration.test.ts   # 重新產生
git diff ../markdown/contract/api-shapes.json                            # 看差異是不是你要的
cd ../frontend && npm test -- src/test/apiContract.test.ts               # 前端讀得到嗎
```

後端測試需要 `*_test` 資料庫（見 `packages/backend/README.md`）。不需要 pgroonga／age／vector：
需要它們的路由列在測試的 `SKIPPED_NEEDS_EXTENSION`，兩種環境產生同一份檔案。

## 檔案格式

```jsonc
{
  "routes": {
    "GET /api/spaces": { "status": 200, "shape": { "spaces": [ { "id": "string", "permission": "null|string" } ] } }
  },
  "unexercised": { "GET /api/rss/items/:id": "answered 404 for the seeded ids; no success shape recorded" }
}
```

- 純量：`"string"`、`"number"`、`"boolean"`、`"null"` 或聯集 `"null|string"`。
- 物件：`{ "key": 形狀 }`；`"key?"` 表示有些樣本沒有這個欄位。
- 陣列：`[元素形狀]`；取樣都是空陣列時是 `["unknown"]`（無法驗證）。
- 混合容器：`{ "$kinds": "array|null", "$items": …, …欄位 }`（例如可為 null 的物件）。
- 自由鍵的 map：`{ "$map": 值形狀 }`（鍵是使用者資料，例如 `attrs`、事件 `payload`）。
- 同一路由的多個樣本（擁有者、一般成員、陣列的各元素）合併成一個形狀。
- 路由鍵：`METHOD /路由樣式`；bootstrap 另有 `[full]`、`[slim]`、`[lean]`、`[lean2 wire]`、
  `[lean2 decoded]`（壓縮格式經前端自己的解碼器之後）。

## 涵蓋範圍

後端記錄：所有掛載的 GET 路由（從 `app.routes` 取得，新增路由會讓測試失敗直到記錄）、
`POST /api/sync` 與其附屬、種子資料用到的寫入回應（筆記、標籤、邊、白板、任務、屬性、空間）。

前端檢查（`EXPECTATIONS`）：bootstrap 四種形式、sync delta、空間（含成員、總覽、刪除／移動預覽）、
筆記（讀取、建立、更新、版本）、標籤、白板、任務議程、收件匣事件與統計。
前端型別由 TypeScript 編譯器直接從原始碼讀取，不另維護欄位清單。

## 尚未涵蓋

- 前端以行內型別（`api<{ id: string }>(…)`）讀的回應：寫入路由多半如此（建立標籤、邊、任務、空間、屬性），
  後端有記錄形狀，但前端沒有具名型別可比對。
- 取樣為空而無法驗證的：`GET /api/inbox` 的 `groups`、`GET /api/inbox/approvals`、`GET /api/tasks/agenda` 的 `done`。
- 後端種子沒走到的路由（`unexercised` 列出原因）：還原工作、agent／MCP session、RSS 項目、分享連結、
  view 模組的 `aggregate`、集合項目。
- 事件串流（SSE）、下載（zip、html、媒體）等非 JSON 回應。
- 值的內容（列舉成員、格式）；這份合約只比對欄位與型別種類。
