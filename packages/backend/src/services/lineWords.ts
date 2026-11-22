// 「哪些字讓一行（或一段）變成某個模組的東西」只在伺服器決定：任務行的 `{task}`、複習卡的 `{review}`。
// 存檔（services/blockNodes）用模組縫隙（taskSeam／reviewSeam）判斷；同一份答案經啟動資料與同步增量的
// `workspace.line_words` 交給編輯器，編輯器不自己推（contract：LineWords）。
// 標籤改名、使用者自己有同名標籤、模組開關，三者都只在這裡與縫隙裡讀。

import type { LineWords } from "@onden/contract";
import { reviewSeam } from "./reviewSeam.js";
import { taskSeam } from "./taskSeam.js";
import { workspaceHasModule } from "./workspaceModules.js";

/** 每個有行字的模組在這個工作區的字。模組沒載入就沒有那一項。 */
async function lineWordsByModule(workspaceId: string): Promise<Record<string, LineWords>> {
  const words: Record<string, LineWords> = {};
  const tasks = taskSeam();
  if (tasks) words.tasks = { words: [...await tasks.lineWords(workspaceId)], on: await tasks.linesAreTasks(workspaceId) };
  const review = reviewSeam();
  if (review) words.review = { words: [...await review.cardWords(workspaceId)], on: await workspaceHasModule(workspaceId, "review") };
  return words;
}

/** 工作區的線上形狀（`workspaceWireRow`）加上 `line_words`：啟動資料、同步增量、設定回應都走這裡，不各自帶。 */
export async function withLineWords<W extends object>(workspaceId: string, wire: W): Promise<W & { line_words: Record<string, LineWords> }> {
  return { ...wire, line_words: await lineWordsByModule(workspaceId) };
}
