// 手寫的小例子：看 diff3 與 Eg-walker（字元級）各自把同一對修改合成什麼。
// edits 用 base 座標的取代 [起, 迄, 新文字]，同一支內互不重疊；產生器會由後往前套用成逐步的 PatchOp。
import type { History, PatchOp } from "./types.js";

export interface Example {
  id: string;
  title: string;
  base: string;
  a: Array<[number, number, string]>;
  b: Array<[number, number, string]>;
}

const BASE = "今天完成同步功能的第一版，測試都通過了。接下來處理離線佇列的重試。最後整理文件。\n下週開始寫研究報告。\n";
const at = (s: string): number => {
  const i = BASE.indexOf(s);
  if (i < 0) throw new Error(`例子 base 裡沒有「${s}」`);
  return i;
};

export const EXAMPLES: Example[] = [
  {
    id: "E1",
    title: "同一行、不同句（各改各的）",
    base: BASE,
    a: [[at("第一版"), at("第一版") + 3, "第二版"]],
    b: [[at("重試"), at("重試") + 2, "重送"]],
  },
  {
    id: "E2",
    title: "同一句、不同詞（依規則應衝突）",
    base: BASE,
    a: [[at("第一版"), at("第一版") + 3, "第二版"]],
    b: [[at("測試"), at("測試") + 2, "驗證"]],
  },
  {
    id: "E3",
    title: "同一個詞改成不同字（依規則應衝突）",
    base: BASE,
    a: [[at("第一版"), at("第一版") + 3, "第二版"]],
    b: [[at("第一版"), at("第一版") + 3, "第三版"]],
  },
  {
    id: "E4",
    title: "同一點各插入一句（相鄰、不重疊）",
    base: BASE,
    a: [[at("接下來"), at("接下來"), "另外補測試。"]],
    b: [[at("接下來"), at("接下來"), "先看效能。"]],
  },
  {
    id: "E5",
    title: "同一句中間各插入不同字（依規則應衝突）",
    base: BASE,
    a: [[at("離線"), at("離線"), "手機"]],
    b: [[at("離線"), at("離線"), "桌機"]],
  },
  {
    id: "E6",
    title: "一邊刪掉整句、一邊改這句裡的詞（依規則應衝突）",
    base: BASE,
    a: [[at("接下來"), at("最後"), ""]],
    b: [[at("重試"), at("重試") + 2, "重送"]],
  },
  {
    id: "E7",
    title: "不同行各改一處",
    base: BASE,
    a: [[at("第一版"), at("第一版") + 3, "第二版"]],
    b: [[at("研究報告"), at("研究報告") + 4, "實驗報告"]],
  },
];

export function exampleTexts(ex: Example): { a: string; b: string; history: History; rangeA: [number, number]; rangeB: [number, number] } {
  const apply = (edits: Example["a"]): { text: string; ops: PatchOp[] } => {
    const sorted = edits.slice().sort((x, y) => y[0] - x[0]); // 由後往前：每步位置都以 base 座標為準
    let text = ex.base;
    const ops: PatchOp[] = [];
    for (const [s, e, ins] of sorted) {
      if (e > s) ops.push([s, e - s, ""]);
      if (ins) ops.push([s, 0, ins]);
      text = text.slice(0, s) + ins + text.slice(e);
    }
    return { text, ops };
  };
  const A = apply(ex.a), B = apply(ex.b);
  const units = (ops: PatchOp[]) => ops.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
  const n = ex.base.length;
  const uA = units(A.ops), uB = units(B.ops);
  return {
    a: A.text,
    b: B.text,
    history: {
      txns: [
        { agent: "base", start: 0, parents: [], ops: [[0, 0, ex.base]] },
        { agent: "A", start: n, parents: [n - 1], ops: A.ops },
        { agent: "B", start: n + uA, parents: [n - 1], ops: B.ops },
      ],
    },
    rangeA: [n, n + uA],
    rangeB: [n + uA, n + uA + uB],
  };
}
