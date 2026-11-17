# eg-walker-reference（原樣收錄，僅供比較用）

> 狀態：現行（研究測試台的第三方程式碼說明）（最後確認 2026-11-01）
> 涵蓋：docs/research/eg-walker-bench/bench/src/vendor/eg-walker-reference/*.ts

- 來源：<https://github.com/josephg/eg-walker-reference>（commit `7287f4bc2c054984838b3582a27b4fea8f6d8161`）
- 授權：BSD-2-Clause（依該套件 package.json 的 `license` 欄位；上游 repo 沒附 LICENSE 檔）
- 檔案：`causal-graph.ts`、`index.ts` 未修改。依賴 `binary-search`（MIT）、`priorityqueuejs`（MIT）。
- 這份實作「故意沒優化」（沒有 run-length、不跳過線性歷史），本研究把它當成「最差情況」的對照。
