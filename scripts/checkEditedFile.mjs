#!/usr/bin/env node
// PostToolUse hook（.claude/settings.json）：agent 每寫完一個檔就檢查那一個檔，違規時 exit 2 並把訊息寫到 stderr，
// agent 當下就看到。規則與允許清單守門是同一份——前後端各自的 allowlist/fileRules.ts（偵測器＋主人表），
// 這裡只負責「讀 hook 的 JSON、找出是哪個套件、跟 scripts/allowlist-baseline.json 比」。
//   echo '{"tool_input":{"file_path":"/abs/packages/frontend/src/components/X.tsx"}}' | node --import tsx scripts/checkEditedFile.mjs
// 違規＝這個檔在某條規則的次數 > 基準裡這個檔的次數（沒有就是 0）。被擋時改用訊息裡的主人入口，不要改基準
// （基準只准降，由 npm run allowlist:baseline 與棘輪守）。沒有被擋的檔靜默 exit 0。
// 偵測器是 TS，所以用 `node --import tsx` 執行；只載入該檔類型需要的那一側（前端或後端）。
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hintForRule } from "./entrypointsCatalog.mjs";
import { readBaseline, root } from "./allowlistLib.mjs";

const SIDES = {
  frontend: { rules: "packages/frontend/src/test/guards/allowlist/fileRules.ts", fn: "frontendViolations" },
  backend: { rules: "packages/backend/src/test/guards/allowlist/fileRules.ts", fn: "backendViolations" },
};

/** `{ side, rel }`：檔案屬於哪個套件的 src/（rel 是 src/ 下的路徑，用 /）；不在 packages/<frontend|backend>/src 就是 null。 */
export function locate(file, repoRoot = root) {
  const parts = relative(repoRoot, file).split(sep);
  if (parts[0] !== "packages" || !(parts[1] in SIDES) || parts[2] !== "src" || parts.length < 4) return null;
  return { side: parts[1], rel: parts.slice(3).join("/") };
}

/** 回傳違規訊息陣列（空＝通過）。source 沒給就讀檔；檔案不存在（例如被刪除）也算通過。 */
export async function checkEditedFile(file, { source, repoRoot = root, baseline = readBaseline() } = {}) {
  const where = locate(file, repoRoot);
  if (!where) return [];
  if (source === undefined) {
    try { source = readFileSync(file, "utf8"); } catch { return []; }
  }
  const mod = await import(join(root, SIDES[where.side].rules));
  const violations = mod[SIDES[where.side].fn](where.rel, source);
  const byRule = new Map();
  for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  const messages = [];
  for (const [rule, list] of byRule) {
    const allowed = baseline[rule]?.[where.rel] ?? 0;
    if (list.length <= allowed) continue;
    const { what, owner } = list[0];
    messages.push(`${relative(repoRoot, file)}：不准用 ${what}（${list.length} 處，基準 ${allowed}；第 ${list.map((v) => v.line).join("、")} 行），${hintForRule(rule) ?? `請改用 ${owner}`}\n  規則：${rule}`);
  }
  return messages;
}

/** hook 的 stdin JSON → 檔案路徑；格式不對回 null（不是我們的事，靜默放行）。 */
export function editedFileFromHookInput(text) {
  try {
    const path = JSON.parse(text)?.tool_input?.file_path;
    return typeof path === "string" && path ? path : null;
  } catch { return null; }
}

/** CLI 本體：回傳 { code, stderr }，exit 2 表示要把 stderr 回給 agent。 */
export async function run(stdinText, options = {}) {
  const file = editedFileFromHookInput(stdinText);
  if (!file) return { code: 0, stderr: "" };
  let messages;
  try {
    messages = await checkEditedFile(file, options);
  } catch (error) {
    // 檢查器本身壞了（例如沒裝依賴）不該擋住 agent 寫檔：非阻擋錯誤（exit 1），訊息只給使用者看。
    return { code: 1, stderr: `checkEditedFile 無法執行：${error instanceof Error ? error.message : String(error)}\n` };
  }
  if (!messages.length) return { code: 0, stderr: "" };
  return { code: 2, stderr: `${messages.join("\n")}\n改用上面的主人入口；不要改 scripts/allowlist-baseline.json 或 owners.ts 來讓它通過。\n` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, stderr } = await run(readFileSync(0, "utf8"));
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
