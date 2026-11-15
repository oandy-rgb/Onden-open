// 原型引擎的「先後規則可調」版：執行時讀 ../proto/engine.ts，只改兩處再寫到 gen/engine.ts 載入（不動原型）：
//   1. 右父（rightParent）：Fugue 版＝只有下一項的左原點與自己相同才記，其餘 -1；FugueMax 版＝一律記下一項。
//   2. 同位置並行時的先後：以 (agent 名, seq) 升冪（小的在左）；desc 反過來。
// 規則由 globalThis.__TB = { max, desc } 在每次呼叫時讀取。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(here, "..", "proto", "engine.ts"), "utf8");
const swap = (from: string, to: string) => {
  if (!src.includes(from)) throw new Error(`原型引擎的這一行變了，需同步更新 variantEngine.ts：${from}`);
  src = src.replace(from, to);
};
swap("rP = nx.oL === oL ? nx.lv : -1;", "rP = (globalThis as any).__TB.max || nx.oL === oL ? nx.lv : -1;");
swap("cgLib.lvCmp(ctx.log.cg, lv, other.lv) < 0", "((globalThis as any).__TB.desc ? -1 : 1) * ((globalThis as any).__TB.byLv ? lv - other.lv : cgLib.lvCmp(ctx.log.cg, lv, other.lv)) < 0");
swap("scanning = r < 0;", "scanning = (globalThis as any).__TB.noScan ? false : r < 0;");
src = src
  .replace(/from "\.\.\/vendor\//g, 'from "../../vendor/')
  .replace(/from "\.\.\/textBuf\.js"/, 'from "../../textBuf.js"')
  .replace(/from "\.\.\/types\.js"/, 'from "../../types.js"')
  .replace(/from "\.\/seq\.js"/g, 'from "../../proto/seq.js"');
mkdirSync(join(here, "gen"), { recursive: true });
writeFileSync(join(here, "gen", "engine.ts"), `// 自動產生（variantEngine.ts），不要手改、不進版本庫。\n${src}`);

export type Rule = { max: boolean; desc: boolean; byLv?: boolean; noScan?: boolean };
export const RULES = {
  /** 原型現況：Fugue 版右父、(agent,seq) 升冪 */
  fugueAsc: { max: false, desc: false },
  fugueDesc: { max: false, desc: true },
  maxAsc: { max: true, desc: false },
  maxDesc: { max: true, desc: true },
} satisfies Record<string, Rule>;
/** 故意寫壞的規則，只用來證明性質測試真的會失敗（不是推薦）。 */
export const BROKEN: Record<string, Rule> = {
  /** 先後看「收到的順序」（本機編號 LV）而不是來源標記 */
  byArrival: { max: false, desc: false, byLv: true },
  /** 掃描時永遠不跳過別人的子樹（等於忽略右原點的比較） */
  noScan: { max: false, desc: false, noScan: true },
};

const engine = (await import("./gen/engine.js")) as typeof import("../proto/engine.js");
export const { buildOpLog, appendTxns, replay, makeBranch, mergeIntoBranch } = engine;
export function withRule<T>(rule: Rule, fn: () => T): T {
  (globalThis as any).__TB = rule;
  return fn();
}
