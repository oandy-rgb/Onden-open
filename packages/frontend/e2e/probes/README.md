# 探針（probes）：只印出數值，不擋任何事

這個資料夾放 `zz*.spec.ts`：功能稽核時寫的探針，多半**沒有任何 `expect`**，只把伺服器回應、狀態碼、量到的位置用 `console.log` 印出來給人看。
它們跑完是綠的，**不代表那個功能有被保護**，所以搬離 `fullstack/`（那裡的每個 spec 都該能失敗）。

- 要讓某個探針變成真的測試：加上斷言、改名（去掉 `zz`）、移回 `fullstack/`；`src/test/guards/e2eSelectors.guard.test.ts` 會檢查它用的 class／data-testid 在 src/ 還存在。
- 跑法（需要全端堆疊，與 `fullstack/` 同一套）：
  ```sh
  cd packages/frontend
  npm run e2e:cloud-stack -- --run bash -c 'cd e2e && npx playwright test --config probes/playwright.config.ts'
  # 只跑一個：… npx playwright test --config probes/playwright.config.ts zzDeepTag03
  ```
  `npm run e2e:probes` 是同一個指令（要先有堆疊在 :5099，`E2E_BASE` 可換）。
- 用 `e2eContainer`／`psql`／`docker exec` 的探針需要 docker 與真 Postgres，在雲端堆疊會具名跳過。
- 還留在 `fullstack/` 的 `zz*` 是有 `expect` 的那幾十個；它們照舊跟 `fullstack/` 一起跑。
