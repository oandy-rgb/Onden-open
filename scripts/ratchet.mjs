// `npm run ratchet:check`：基準與例外清單只准減少（邏輯與規則見 scripts/ratchetLib.mjs）。
import { runRatchet } from "./ratchetLib.mjs";

const result = runRatchet();
if (!result.ok) {
  console.error("ratchet 失敗（基準或例外清單變大了，或找不到 origin/main 無法比對）：");
  for (const e of result.errors) console.error(`  - ${e}`);
  console.error("真的要放寬：擁有者在 PR 說明寫明原因，並在 commit 訊息加一行 `ratchet-override: <原因>`。");
  process.exitCode = 1;
} else {
  for (const n of result.notes) console.log(`ratchet：${n}`);
  console.log("ratchet：沒有變大的基準或例外清單。");
}
