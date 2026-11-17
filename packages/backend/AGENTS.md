# 後端（packages/backend）

全域規則（權限、事件與交易、復原）在[根目錄 AGENTS.md](../../AGENTS.md)與 [docs/agents/backend-rules.md](../../docs/agents/backend-rules.md)，這裡不重複。
這份只回答「在這裡要做 X，一律用 Y」。路徑相對 `src/`；最後一欄是擋住它的守門測試（`src/test/guards/`），違規會在那裡失敗並指出該用誰。
**寫新的工具函式前先看這張表；表上有的不要再寫一份。**

## 這件事歸誰管（手寫；每列都有守門測試）

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 新的資料庫查詢（有型別；舊手寫 `q()` 只減不增） | `dbKysely.ts` 的 `db`；改 migration 後跑 `npm run db:types`（[怎麼寫新查詢](../../docs/architecture/portable-backend.md)） | `allowlist.guard.test.ts`（`be-raw-sql`）、`dbTypes.guard.test.ts` |
| 同層排序：寫（新筆記放最後、舊整數翻成鍵、復原時的鍵、鍵太長重配）與 ORDER BY 片段 | `services/orderKeys.ts`（鍵本身用 `@onden/markdown` 的 `keyBetween`）；欄位 `order_key`／`order_stamp` 逐位元組比較，`sort_order` 已凍結不讀不寫 | `orderKeyWriters.guard.test.ts` |
| SHA-256 十六進位摘要 | `utils.ts` 的 `sha256Hex` | `dupSweep.guard.test.ts` |
| 事件附加鎖 | `spine/eventLock.ts` 的 `lockEventAppend` | `dupSweep.guard.test.ts` |
| 新的區塊 id | `@onden/markdown` 的 `newBlockId` | `dupSweep.guard.test.ts` |
| 「哪些事件算儲存」 | `services/history/bodyEvents.ts` 的 `bodyEventSql` | `dupSweep.guard.test.ts` |
| 復原的 `history_incomplete`／`state_conflict` 拒絕 | `services/eventRestore/refusals.ts` | `dupSweep.guard.test.ts` |
| 路徑中的 bigint id | `routes/params.ts` 的 `parseBigintId`（其他請求輸入也各有一個讀取者） | `dupSweep.guard.test.ts`、`dup-b2-input.guard.test.ts` |
| 新筆記預設落點（個人空間或預設空間） | `services/spaces.ts` | `dupSweep.guard.test.ts` |
| 排序已存檢視 | `services/tagViews.ts` 的 `byPinThenName` | `dupSweep.guard.test.ts` |
| 要求「剛剛再確認過是本人」才給整個工作區或做不可逆的事（再輸入一次密碼；伺服器強制，不只頁面） | `services/freshProof.ts` 的 `issueFreshProof`／`consumeFreshProof`；新的受保護路由在 `FRESH_PROOF_PURPOSES` 加一個用途 | `freshProof.guard.test.ts` |
| 「只准人、不准 token」 | `spine/authority.ts` 的 `requirePerson` | `dup-b2-responses.guard.test.ts` |
| 拒絕請求 | 丟 `StatusError`（`statusError.ts`），由 `httpError.ts` 映射；不手寫 4xx 回應本體 | `dup-b2-responses.guard.test.ts` |
| 新的拒絕類別 | 繼承 `StatusError`，不直接 `extends Error` | `dup-b2-responses.guard.test.ts` |
| 批次讀取的可讀過濾 | `services/readPolicy.ts`、`services/history` 的 `readableNotes` | `dup-b2-responses.guard.test.ts` |
| 非同步權限判斷（`can*`／`assert*`） | 一定 `await`、回傳或交給 `Promise.all`，不當條件用 | `dupPatterns.guard.test.ts` |
| 系統 actor、以 system 身分寫入 | `spine/systemActor.ts` | `systemActor.guard.test.ts` |
| 週期工作 | `backgroundJobs.ts` 的 `startPeriodicJob` | `dup-b2-infra.guard.test.ts` |
| 讀環境變數 | `config.ts` | `dup-b2-infra.guard.test.ts` |
| 輸出日誌 | `logger.ts` | `dup-b2-infra.guard.test.ts` |
| 測試用的拋棄式資料庫檢查 | `scripts/lib/disposableDb.mjs` 的 `assertDisposableDatabase` | `dup-b2-test-helpers.guard.test.ts` |
| 呼叫語言模型 SDK | 只在 `services/agentRuntime/api/`，且只能提建議 | `src/test/harnessBoundary.test.ts`、`aiRuntime.guard.test.ts` |
| 寫入、權限、事件、交易 | `spine/`（見該資料夾的 AGENTS.md）；ESLint 擋 `spine/` import `services/` | ESLint |

## import 層、環境變數、排程、日誌（從 `allowlist/owners.ts` 產生，不要手改）

跑 `npm run agents:tables`（在 repo 根目錄）更新；`agentsTables.guard.test.ts` 會比對。

<!-- generated:owners -->
資料來源：`src/test/guards/allowlist/owners.ts`（路徑相對 `src/`，結尾 `/` 表資料夾）。`scripts/allowlist-baseline.json` 已清零並維持空（嚴格模式；唯一例外是逐檔只減不增的 `be-raw-sql`），任何違規直接失敗。

| 規則 | 內容 |
| --- | --- |
| route 可以 import 的地方 | `requestContext`、`routes/params`、`routes/sseStream`、`services/`、`spine/`、`httpError`、`statusError`、`downloadHeaders`、`localDay`、`utils`、`types`、`logger` |
| `process.env` | 只准 `config.ts` 讀 |
| `setInterval`（週期工作） | 只准 `ticker.ts` 排程 |
| `console` | 只准 `logger.ts`、`admin.ts`；其他一律走 logger |
| 手寫 SQL（`q(`、`client.query`） | 只有 `db.ts`、`dbPglite.ts`、`dbKysely.ts` 這幾個傳輸層檔案；其他檔逐檔計數、只減不增（規則 `be-raw-sql`），新查詢用 `dbKysely.ts` 的 `db` |
| route 內的 `pool.query` | 不准；改呼叫擁有該資料列的 service |
<!-- /generated -->

## 測試

```
cd packages/backend
npx tsc --noEmit && npm run lint && npm run test:pglite   # 或 npm test（真 Postgres）；兩者都跑 DB 測試
ONDEN_TESTS_WITHOUT_DATABASE=1 npx vitest run src/test/guards   # 只跑守門（明說不用資料庫的一輪）
```

每一輪結尾印 `[tests] mode: …, ran N, skipped M`；跳過了資料庫測試、又不是明說的無資料庫輪（`npm run test:no-db`）就失敗。整合測試需要隔離的 Postgres，起法見根目錄 AGENTS.md「驗證」與 [docs/agents/testing.md](../../docs/agents/testing.md)；沒跑的要在回報裡寫明。
