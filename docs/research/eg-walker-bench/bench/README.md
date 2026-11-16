# Eg-walker 合併測試台

> 狀態：歷史紀錄（研究測試台；結論見上一層的 [report.md](../report.md)）（寫於 2026-11-01） 引用的路徑、函式與行號是寫作當時的，現況以程式為準。

獨立套件（自己的 `package.json`，不在根目錄 workspaces 內，不進主程式的依賴與打包）。
只**讀**主程式的 `packages/backend/src/services/eventLog/bodyMerge.ts` 當 diff3 基準線，不改任何產品程式。

## 一次準備

```sh
cd docs/research/eg-walker-bench/bench
npm install                 # 只裝測試台自己的依賴（esbuild、tsx、playwright、diamond-types、參考實作的兩個小套件）
./scripts/fetch-data.sh     # 下載論文公開的編輯紀錄到 data/（固定 commit，約 5 MB，不進版本庫）
```

## 一行指令

| 要量什麼 | 指令 |
| --- | --- |
| 正確性：原型與參考實作交叉比對（隨機並行歷史，預設 150 個種子；`FUZZ_N=1500` 加量） | `npm test` |
| Node：四個實作 × 三種操作 × 合成情境與論文 trace | `node --expose-gc --import tsx src/runNode.ts` （`--quick` 只跑 2×2 情境） |
| Chromium，CPU 降速 4 倍（模擬手機） | `npm run bench:browser -- --browser chromium --throttle 4` |
| WebKit（Playwright 的 webkit；雲端抓不到時用下面的 docker） | `npm run bench:browser -- --browser webkit --throttle 1` |
| 序列化大小、打包 gzip 大小 | `npm run bench:size` |
| 記憶體（一個 case 一個程序） | `node --expose-gc --max-semi-space-size=2048 --import tsx src/memProbe.ts proto fork:200KB-1000:a` |
| 優化各貢獻多少 | `node --expose-gc --import tsx src/runAblation.ts` |
| 合併結果比較（diff3 vs Eg-walker） | `npm run bench:compare` |

三種操作：**a** 只處理分岔那段（本機已有 base＋A，遠端的 B 到來）；**b** 整份歷史從頭重放；
**c** 載入既有文件（解序列化）＋套一筆遠端修改。每個數字是多次執行的中位數與 p95（`harness.ts`）。

### 在業主筆電用 Playwright docker 補量 WebKit（模擬弱 CPU）

```sh
docker run --rm -it --cpus=0.7 -v "$PWD/../../../..":/repo -w /repo/docs/research/eg-walker-bench/bench \
  mcr.microsoft.com/playwright:v1.63.0-noble bash -c \
  "npm install --no-audit --no-fund && ./scripts/fetch-data.sh && npm run bench:browser -- --browser webkit --throttle 1"
```

`--cpus=0.7` 只限制 CPU 配額，不等於手機的實際速度；用輸出裡的 `calibrationMs`（固定工作量）把不同機器的數字對起來。

## 目錄

- `src/proto/` 我們的 TS 原型（`engine.ts` 演算法、`seq.ts` 項目序列、`serialize.ts` 歷史格式）。
- `src/vendor/eg-walker-reference/` 論文附的參考實作，原樣（見該資料夾的 NOTICE.md）。
- `src/genNote.ts`、`src/genFork.ts` 合成 Markdown 筆記與兩支分岔編輯（固定種子 `cases.ts` 的 `SEED`）。
- `src/analysis.ts`、`src/examples.ts`、`src/runCompare.ts` 合併結果比較與「同一句重疊」偵測。
- `src/impls.ts` 四個實作的統一轉接；`src/harness.ts` 計時。
- `src/paraId/` 內文合併「認段落身分」原型與量測（[報告](../../body-merge-measurements-2026-11-15.md) 第 1 部分）：`paraMerge.ts` 原型的外殼（邏輯在產品的 `services/eventLog/bodyMergeMoves.ts`）、`scenarios.ts` 新產生器、
  `evaluate.ts` 比對與分類、`runA.ts`／`runB.ts`／`runC.ts` 三組資料（整個原型對現行）、`runProduct.ts`／`perfLarge.ts` 產品 `mergeBody` 的前後對照與大文件耗時、`record/` 錄下既有測試的合併呼叫（需先建 `packages/markdown` 的 dist：`npm run build -w packages/markdown`）。
  （`runProduct.ts`／`perfLarge.ts` 會載入產品的 `blockAnchors`，要先 `npm run build -w packages/contract`。）重跑：`npx tsx src/paraId/runB.ts 300`、`npx tsx src/paraId/runA.ts 20 block|line`；(c) 先用 `record/vitest.record.config.ts` 錄（見報告「怎麼重跑」）再 `runC.ts`；表格 `makeTables.ts`。測試：`npm test`。
- `src/tiebreak/` 同一點同時插入的先後規則查證（[tiebreak-findings.md](../tiebreak-findings.md)）；`npm run test:tiebreak`。
- `out/` 本次量到的原始數字（JSON 與 log），報告的表格由它們整理而來。

## 授權（測試台用到的第三方）

| 套件 | 授權 | 用途 |
| --- | --- | --- |
| eg-walker-reference（原樣收錄） | BSD-2-Clause | 對照組；原型沿用它的因果圖 `causal-graph.ts` |
| priorityqueuejs | MIT | 參考實作的依賴 |
| binary-search | CC0-1.0（公眾領域貢獻宣告，不是 MIT／Apache／BSD 類；只在測試台，不進產品） | 參考實作的依賴 |
| diamond-types-node / -web | ISC OR Apache-2.0 | 作者的 Rust 版（WASM） |
| esbuild、tsx、typescript、@types/* | MIT / Apache-2.0 | 打包、執行、型別檢查 |
| playwright（playwright-core） | Apache-2.0 | 瀏覽器自動化 |
| diamond-types 的 benchmark_data（`.dt` 檔） | diamond-types repo 為 ISC | 只在本機下載，不收進版本庫 |
| 論文 trace（josephg/editing-traces） | 上游 repo 沒附授權檔（資料為公開貼文／程式碼的編輯紀錄） | 只在本機下載，不收進版本庫，也不轉貼內容 |
