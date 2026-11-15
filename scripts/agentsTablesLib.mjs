// 各套件 AGENTS.md 裡「從允許清單產生」的區塊：內容由 allowlist/owners.ts 算出，不手抄第二份。
// 區塊以 <!-- generated:owners --> … <!-- /generated --> 圈住；其餘（手寫的對照表）不動。
// 產生：npm run agents:tables；比對：agentsTables.guard.test.ts（兩個套件各一支）。
// owners.ts 只含型別與常數，Node 22 可直接讀（型別會被略過）。
import { readFileSync, writeFileSync } from "node:fs";
import { entriesForRule, loadCatalog } from "./entrypointsCatalog.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_WIDTHS_PX } from "../packages/frontend/src/test/guards/allowlist/css.ts";
import {
  CSS_EXEMPT, ELEMENT_OWNERS, FIXED_POSITION_OWNERS, PLATFORM_OWNERS,
} from "../packages/frontend/src/test/guards/allowlist/owners.ts";
import {
  CONSOLE_OWNERS, PROCESS_ENV_OWNERS, RAW_SQL_OWNERS, ROUTE_IMPORTS, ROUTE_SQL_OWNERS, SET_INTERVAL_OWNERS,
} from "../packages/backend/src/test/guards/allowlist/owners.ts";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const START = "<!-- generated:owners -->";
export const END = "<!-- /generated -->";

const code = (list) => (list.length ? list.map((o) => `\`${o}\``).join("、") : "（沒有，一律不准）");
const catalog = loadCatalog();
const useFromCatalog = (rule) => entriesForRule(rule, catalog).map((e) => e.need).join("；") || "見唯一入口清單";
const cell = (s) => s.replaceAll("|", "\\|");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

function frontend() {
  const platform = table(
    ["要用的全域物件", "只准這些檔案用", "其他地方改用"],
    Object.entries(PLATFORM_OWNERS).map(([name, o]) => [`\`${name}\``, code(o.owners), useFromCatalog(`fe-platform-global:${name}`)]),
  );
  const css = table(
    ["CSS／JSX 規則", "內容"],
    [
      ["原生元素（`<button>`、`<input>`…）", `只准 ${code(ELEMENT_OWNERS)} 裡寫；畫面用其中的元件`],
      ["`position: fixed`", `只准 ${code(FIXED_POSITION_OWNERS)}`],
      ["`@media` 寬度", `只准 ${MEDIA_WIDTHS_PX.join("／")}px`],
      ["顏色、圓角、陰影、`z-index`、字級", "只准 `var(--token)`，不寫字面值（例外檔見下）"],
    ],
  );
  const exempt = table(["不受 CSS 規則約束的樣式", "理由"], Object.entries(CSS_EXEMPT).map(([f, why]) => [`\`${f}\``, why]));
  return [
    "資料來源：`src/test/guards/allowlist/owners.ts`、`allowlist/css.ts`。`scripts/allowlist-baseline.json` 已清零並維持空（嚴格模式），任何違規直接失敗。",
    "", platform, "", css, "", exempt,
  ].join("\n");
}

function backend() {
  const rows = [
    ["route 可以 import 的地方", code(ROUTE_IMPORTS)],
    ["`process.env`", `只准 ${code(PROCESS_ENV_OWNERS)} 讀`],
    ["`setInterval`（週期工作）", `只准 ${code(SET_INTERVAL_OWNERS)} 排程`],
    ["`console`", `只准 ${code(CONSOLE_OWNERS)}；其他一律走 logger`],
    ["手寫 SQL（`q(`、`client.query`）", `只有 ${code(RAW_SQL_OWNERS)} 這幾個傳輸層檔案；其他檔逐檔計數、只減不增（規則 \`be-raw-sql\`），新查詢用 \`dbKysely.ts\` 的 \`db\``],
    ["route 內的 `pool.query`", ROUTE_SQL_OWNERS.length ? code(ROUTE_SQL_OWNERS) : "不准；改呼叫擁有該資料列的 service"],
  ];
  return [
    "資料來源：`src/test/guards/allowlist/owners.ts`（路徑相對 `src/`，結尾 `/` 表資料夾）。`scripts/allowlist-baseline.json` 已清零並維持空（嚴格模式；唯一例外是逐檔只減不增的 `be-raw-sql`），任何違規直接失敗。",
    "", table(["規則", "內容"], rows),
  ].join("\n");
}

/** 有產生區塊的 AGENTS.md → 區塊內容。 */
export const TARGETS = {
  "packages/frontend/AGENTS.md": frontend,
  "packages/backend/AGENTS.md": backend,
};

/** 把 text 裡標記之間換成 block；沒有標記就回傳 null。 */
export function withBlock(text, block) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return `${text.slice(0, a + START.length)}\n${block}\n${text.slice(b)}`;
}

/** 每個 AGENTS.md 現在內容與應有內容；回傳 { file, current, expected }。 */
export function expectedFiles() {
  return Object.entries(TARGETS).map(([file, render]) => {
    const current = readFileSync(join(root, file), "utf8");
    return { file, current, expected: withBlock(current, render()) };
  });
}

export function writeAll() {
  const changed = [];
  for (const { file, current, expected } of expectedFiles()) {
    if (expected === null) throw new Error(`${file} 沒有 ${START} … ${END} 標記`);
    if (expected !== current) { writeFileSync(join(root, file), expected); changed.push(file); }
  }
  return changed;
}
