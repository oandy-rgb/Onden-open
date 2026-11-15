# @onden/contract

伺服器與 App 約好的資料形狀，用 zod 定義一次；型別由 `z.infer` 推導。

| 名稱 | 是什麼 | 誰用 |
| --- | --- | --- |
| `ServerNode` | 讀取介面送出的筆記（bootstrap、同步增量、`GET /api/nodes/:id`）：資料列加標籤 id、屬性、事件資訊 | 後端查詢的型別；前端 `ContentNode` 由它推導 |
| `ServerNodeRow` | `POST`／`PATCH /api/nodes` 回的資料列（`content_nodes` 的欄位） | 後端 `createNote`／`updateNode` |
| `DraftNode` | 建立／修改筆記的請求內容（PATCH 時每個欄位可省略） | 後端請求驗證 |

```ts
import { DraftNode, type ServerNode } from "@onden/contract";
const input = DraftNode.parse({ title: "計畫" }); // 後端：驗證請求
export const titleOf = (node: ServerNode) => node.title; // 前端：只用型別
```

- **前端只准 `import type`**。zod 進開機包會超過預算（`scripts/check-boot-bundle.mjs`）。
- 後端不在每個請求上 `parse` 回應（bootstrap 很大）；守門是 `packages/backend/src/test/nodeContract.integration.test.ts`，
  用 `.strict()` 解析真實回應，欄位多了或少了就失敗。
- 讀法與其他套件相同：型別檢查與測試讀 `src/`，後端正式映像跑 `npm run build` 產生的 `dist/`。
- **API 回應的形狀（純型別）**依主題分檔：`bootstrap.ts`（cold start、同步增量與其資料列）、`tags.ts`、`site.ts`、`ai.ts`、`history.ts`、`spaces.ts`、`publish.ts`、`backup.ts`、`trash.ts`、`blocks.ts`、`tasks.ts`、`views.ts`、`importers.ts`、`paging.ts`。
  後端查詢與路由、前端讀取都 `import type` 同一份；欄位放**上線的形狀**（例如 `MovePreview.membership_epoch` 是數字字串，前端的 `MovePreviewNumericEpoch` 由它衍生）。
  前端與後端各自再定義同名型別會被 `npm run dup:names` 擋下（`scripts/dup-names-baseline.json` 的 `types` 要維持空；核對過是兩個不同模型的同名型別記在 `typesAllow`，連同兩個檔案與理由，只准減）。
  前端需要較寬鬆的讀法時，用上線形狀衍生並說明原因（`BackupManifestAsRead` 讀舊備份檔、`SyncDelta` 讀舊伺服器、`Tag`）。
- 還沒收進來：白板、收件匣等形狀，以及後端用 `as` 轉型建出來所以還不是型別錯誤的回應（`SyncDelta.tags`、bootstrap 的酬載；見該型別的註解）。
- `node.ts`、`board.ts`、`bootstrap.ts` 仍從 `@onden/markdown` 引入型別與上限（拆分是後續工作）。
