# 公開庫（Onden-open）跟著私人庫

> 狀態：現行（最後確認 2026-11-20）
> 涵蓋：scripts/public-mirror/*.sh, scripts/public-mirror/removed-paths.json, scripts/public-mirror/removedPaths.mjs, .github/workflows/public-mirror.yml

業主 2026-11-15／16 的決定：分散式做完之前，私人庫開發、公開庫跑完整檢查；兩邊的程式必須一模一樣。
之後公開庫會變成正本（切換另外公告）。

- 鏡像拿掉哪些路徑只有一份資料：`removed-paths.json`（單一檔案、整個資料夾、`docs/` 底下的圖片副檔名）。`public-push.sh`、`verify.sh` 與文件檢查器（`scripts/check-md-links.mjs`：文件提到的路徑在鏡像裡不存在，且符合這份清單，不算過時）都讀它，用 `removedPaths.mjs`；要多拿掉什麼，只改那個檔。
- `public-push.sh <私人庫的 ref> <公開庫的分支>`：把那個 ref 的內容去掉 `docs/` 底下的圖片與
  `docs/research/scan-2026-11-14/` 與 `docs/deploy-log.md`（部署紀錄留在私人庫，業主 2026-11-16），指向它們的連結改成文字，檢查確實去乾淨，做成**一個**提交推到公開庫
  （疊在公開庫那個分支上；新分支疊在公開庫的 main 上）。私人庫的提交歷史永遠不會被推過去。
  推之前會比對「這次比公開庫多了什麼」：新增的圖片、影片、壓縮檔、資料庫檔、金鑰檔、超過 1 MiB 的檔案、
  看起來像金鑰或權杖的文字，任何一種都停下來不推（看過清單確定要公開，才用 `PUBLIC_PUSH_ALLOW=1`）。
  那一個提交的訊息會帶上守門要讀的書面聲明：私人提交裡的 `ratchet-override:` 與「文件不需要更新：<原因>」行，
  以及私人提交或這個分支的 PR 說明裡出現「不需要更新說明」時，單獨一行「不需要更新說明」（這些行同樣經過金鑰／位址檢查）。
- 推一個有 PR 的分支之前，讀 PR 說明的「## 驗收卡」（`scripts/prCardLib.mjs`，AGENTS.md「交付紀律」）：2026-11-21 起開的 PR 缺卡或有空欄就不推；動到觸控／鍵盤／手寫的檔案時，卡裡要提到實機。
- 公開庫收到推送就自己跑 CI（`.github/workflows/ci.yml`，業主 2026-11-20）：守門與全部完整檢查，只有完整 E2E 仍要手動
  （`gh workflow run ci.yml --repo oandy-rgb/Onden-open --ref <分支> -f fullstack=true`）。push 沒有 PR 說明，守門從上面那個提交訊息讀聲明。
  分支必須含有 main 這版的 `ci.yml`（先併 main），否則推上去不會自己開始。
- `verify.sh`：只讀。證明公開庫的 main 等於它提交訊息裡寫的那個私人庫提交，差別只有被排除的檔案與指向它們的連結。
- `.github/workflows/public-mirror.yml`：私人庫的 main 每次有新提交，自動跑上面兩個（密鑰 `PUBLIC_MIRROR_KEY`
  是公開庫的一把只能寫公開庫的 deploy key）。**2026-11-17 起先關掉**：私人庫的 Actions 額度用完，業主不提高上限
  （每月重置）；同一天私人庫的 `CI` 也關掉，守門檢查改在公開庫跑（2026-11-20 起每次推送自動跑）。
- 沒有自動同步的期間：**誰合併到 main，誰接著跑** `bash scripts/public-mirror/public-push.sh origin/main main`
  （它推完會印出公開庫的提交；再跑 `verify.sh` 確認）。
- 擋住不一致的兩道關卡（都問 `verify.sh`，測試在 `packages/markdown/src/test/guards/publicMirror.guard.test.ts`）：
  1. `public-push.sh` 推任何 main 以外的分支之前：公開庫的 main 不是私人庫現在的 main 就不推，並說要先同步。
     每個 PR 合併前都要推到公開庫跑完整檢查，所以落後最多撐到下一次送檢。
  2. `scripts/deploy-vps.sh build`：同樣的檢查，不一致就不建置（公開庫連不上時才用 `DEPLOY_WITHOUT_MIRROR=1`，並寫進部署紀錄）。

規則：
- 方向只有一個：私人庫 → 公開庫。不從公開庫拉任何東西回私人庫。
- 驗收用的分支叫 `acc-<工作階段>-<主題>`；公開庫的 `main` 只由這個工作流程或 `public-push.sh origin/main main` 更新。
- PR #1582、#1626、#1567（傳到我的手機的安全審查與它審的分支）及由它們衍生的內容，不得推到公開庫。
- 不要在 `docs/` 加圖片，不要把真實筆記內容寫進測試資料或文件：推上去就是公開的。
- 推送 `public-push.sh <ref> <分支>`：不是 main 的分支一律是「公開 main ＋ 一個 commit」，蓋掉公開庫上那條分支原本的內容（強制推送），所以 `<ref>` 必須已經包含私人 main（先併 main）。2026-11-22 前是疊在公開分支舊的 commit 上，分支的基準停在舊 main，守門把 main 之後多出的東西都算成這條分支的改動。
- 要完整端對端就加 `--fullstack`：同步 commit 帶一行 `ci-fullstack: true`，推送觸發的那次 run 就會跑完整端對端，不用再手動開一次（手動那次會取消推送的那次）。
- 同一棵樹不重跑（`scripts/ci/sameTreeReceipt.sh`，ci.yml 的 `receipt` 工作）：已有一次跑完、必跑工作全綠的 run 是同一棵 git 樹，這次就沿用它，重的工作跳過、摘要寫出沿用哪一次。批次分支測過後合進 main，同步上來的 main 通常就是同一棵樹。完整端對端、排程的 run、PR 不沿用。「同一棵樹有沒有全綠的 run」只有一份判斷（`scripts/ci/greenRunLib.sh`），收據和下面的合併閘門共用。
- 合併只經過合併閘門（`scripts/ci/mergeGate.sh [--merge] <測過的 ref> <PR>…`，2026-11-23）：公開 CI 對 `<測過的 ref>` 那棵樹有一次必跑工作全綠的 run；每個 PR 的 head 都還是測過的那一版（測完之後沒再推）；今天的 main 加上這些 PR 等於測過的那一份（main 之後自己改的檔與產生的檔除外）；每個 PR 最新一則寫著「審查結論：」的留言是「可合併」，而且「已知缺口：」是「無」或附上擁有者放行的連結。完整端對端有已知紅燈的基準，不在必跑工作裡，合併批次前要自己看。本機的 Claude Code 掛鉤（`~/.claude/hooks/merge-gate-only.sh`）拒絕直接打 `gh pr merge`。閘門自己的測試：`scripts/merge-gate-selftest.sh`（守門通道跑）。
- 審查結論的寫法（給閘門讀）：一行 `審查結論：可合併`（或 `退回`），一行 `已知缺口：無`，或列出缺口並附 `擁有者放行：<擁有者說可以的留言連結>`。
