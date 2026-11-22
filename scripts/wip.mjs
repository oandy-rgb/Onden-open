#!/usr/bin/env node
// 同時進行的量有上限（業主 2026-11-20 採用，取自 Tolaria「每條線最多 1–2 張進行中」）：開著的 PR 到了上限就不派新工作，
// 先把開著的審完、合併或關掉。派工的一方（本機的 agent、排程）派之前跑：
//   node scripts/wip.mjs          開著的 PR 數與上限；超過就以 1 結束
// 例外只有業主明說的（緊急修正、資料安全）；替已開的 PR 修審查意見不算新工作。
import { execFileSync } from "node:child_process";

export const WIP_LIMIT = 20;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const open = JSON.parse(execFileSync("gh", ["pr", "list", "--state", "open", "--limit", "500", "--json", "number,isDraft"], { encoding: "utf8" }));
  const live = open.filter((pr) => !pr.isDraft).length;
  console.log(`開著的 PR：${open.length}（草稿 ${open.length - live}），上限 ${WIP_LIMIT}`);
  if (open.length > WIP_LIMIT) {
    console.error(`超過上限 ${open.length - WIP_LIMIT} 張：先審、合併或關掉，再派新工作。`);
    process.exit(1);
  }
}
