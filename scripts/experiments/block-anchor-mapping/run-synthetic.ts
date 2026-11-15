// 合成情境（真實歷史裡罕見的）：答案寫死，四種做法各跑一次。
import { ChangeSet } from "@codemirror/state";
import { threeWayMergeBody } from "../../../packages/backend/src/services/eventLog/bodyMerge.js";
import {
  DEFAULTS, classify, segment, lineAlign, m1Mark, m1Locate, m1Step, m2Init, m2Step, m3Init, m3Step,
  type Params, type Range, type Cls, type Form, type Seg,
} from "./lib.ts";

const P = [
  "Onden 是給資工大學生用的筆記工具，重視資料可靠與日常使用舒適。",
  "每個段落都可以被連結、嵌入或貼上標籤，連結要在筆記改版後仍指到同一段文字。",
  "編輯器知道使用者每一次輸入的確切位置，因此可以精準地移動錨點。",
  "伺服器收到整篇內容時只看得到舊版與新版，\n必須自己比較兩個版本才能推測哪一段對應哪一段。",
  "多台裝置離線編輯同一篇筆記後再同步，伺服器要把兩邊的修改合併成一份。",
  "外部工具也可能直接改寫筆記內容，例如匯入、還原到舊版或由程式代為修改。",
  "找不到對應位置時，系統應該誠實地告訴使用者找不到，而不是默默指向別的段落。",
  "備份與匯出必須保持內容完整，\n匯出給其他筆記軟體時可以暫時加入需要的記號。",
  "效能也要考慮，因為每次儲存都要對整篇筆記做一次比較，大型筆記不能讓儲存變慢。",
  "最後用真實的修改紀錄量測各種做法，再決定要採用哪一種設計。",
];
type Doc = { text: string; para: Range[] };
function build(paras: string[]): Doc {
  const blocks = ["# 段落錨點", ...paras.slice(0, 5), "## 設計考量", ...paras.slice(5)];
  let text = "", para: Range[] = [];
  blocks.forEach((b, i) => { if (i) text += "\n\n"; const from = text.length; text += b; if (b !== "# 段落錨點" && b !== "## 設計考量") para.push({ from, to: text.length }); });
  return { text, para };
}
type Change = { from: number; to: number; insert: string };
function apply(text: string, cs: Change[]): string {
  let out = text;
  for (const c of [...cs].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}
const mid = (s: string) => Math.floor(s.length / 2);

type Anchor = { range: Range; kind: "single" | "range" };
type Outcome = { text: string; cs?: ChangeSet; preMerged?: boolean } & ({ expected: Range | null });
export type Case = { scenario: string; kind: "單段" | "範圍"; label: string; base: Doc; anchor: Range; run: (m1: (form: Form) => { clean: string; locate: Range | null }) => void; edit: Outcome; devices?: { dev1: string; dev2: string } };

const find = (text: string, s: string, from = 0): Range => { const i = text.indexOf(s, from); if (i < 0) throw new Error("找不到 " + s); return { from: i, to: i + s.length }; };

function* cases(): Generator<Case & { kindZh: string }> {
  for (const kindZh of ["單段", "範圍"] as const) {
    for (let i = 1; i <= 6; i++) {
      const base = build(P);
      const last = kindZh === "單段" ? i : i + 1;
      const A: Range = { from: base.para[i]!.from, to: base.para[last]!.to };
      const aText = base.text.slice(A.from, A.to);
      const mk = (scenario: string, edit: Outcome, b: Doc = base, anchor: Range = A, devices?: Case["devices"]) =>
        ({ scenario, kind: kindZh, kindZh, label: `${scenario}#${i}`, base: b, anchor, edit, devices, run: () => {} }) as Case & { kindZh: string };

      // 1 同篇整段搬移（搬到另一處）
      const j = (i + 4) % 7 + 1 <= 7 && ![i, last].includes((i + 4) % 7 + 1) ? (i + 4) % 7 + 1 : 9;
      if (j > last + 1 || j < i - 1) {
        const dest = base.para[j]!.to;
        const ch: Change[] = [{ from: A.from - 0, to: Math.min(A.to + 2, base.text.length), insert: "" }, { from: dest, to: dest, insert: "\n\n" + aText }];
        if (A.to + 2 > base.text.length) ch[0]!.from = A.from - 2;
        const text = apply(base.text, ch);
        yield mk("同篇搬移整段", { text, cs: ChangeSet.of(ch, base.text.length), expected: find(text, aText, text.indexOf(aText) < A.from ? 0 : 0) });
      }
      // 2 兩段接成一段
      if (kindZh === "單段") {
        const sep = { from: base.para[i]!.to, to: base.para[i + 1]!.from, insert: "" };
        const text = apply(base.text, [sep]);
        const first = find(text, base.text.slice(base.para[i]!.from, base.para[i]!.to));
        yield mk("兩段接成一段（錨在前段）", { text, cs: ChangeSet.of([sep], base.text.length), expected: first });
        const secondA = base.para[i + 1]!;
        const second = find(text, base.text.slice(secondA.from, secondA.to));
        yield { ...mk("兩段接成一段（錨在後段）", { text, cs: ChangeSet.of([sep], base.text.length), expected: second }, base, { from: secondA.from, to: secondA.to }) };
      } else {
        const sep = { from: base.para[i]!.to, to: base.para[i + 1]!.from, insert: "" };
        const text = apply(base.text, [sep]);
        yield mk("兩段接成一段（範圍涵蓋兩段）", { text, cs: ChangeSet.of([sep], base.text.length), expected: { from: A.from, to: A.to - 2 } });
      }
      // 3 一段拆成兩段（在第一個「，」後斷）
      {
        const ins = (kindZh === "單段" ? base.para[i]! : base.para[last]!);
        const cut = ins.from + base.text.slice(ins.from, ins.to).indexOf("，") + 1;
        const ch = [{ from: cut, to: cut, insert: "\n\n" }];
        const text = apply(base.text, ch);
        yield mk("一段拆成兩段", { text, cs: ChangeSet.of(ch, base.text.length), expected: { from: A.from, to: A.to + 2 } });
      }
      // 4 範圍邊界打字：不向外延伸
      for (const [name, at, ins, expectShift] of [
        ["範圍起點打字", A.from, "新增的一句。", "start"],
        ["範圍終點打字（接在同一行）", A.to, "新增的一句。", "end"],
        ["範圍終點換行後新段落", A.to, "\n\n新增的新段落。", "end"],
      ] as const) {
        const ch = [{ from: at, to: at, insert: ins }];
        const text = apply(base.text, ch);
        const exp = expectShift === "start" ? { from: A.from + ins.length, to: A.to + ins.length } : A;
        yield mk(name, { text, cs: ChangeSet.of(ch, base.text.length), expected: exp });
      }
      // 5 範圍內字全刪（留下空行） / 整段（含空行）刪掉
      {
        const ch = [{ from: A.from, to: A.to, insert: "" }];
        yield mk("範圍內字全刪（留空行）", { text: apply(base.text, ch), cs: ChangeSet.of(ch, base.text.length), expected: null });
        const ch2 = [{ from: A.from, to: A.to + 2, insert: "" }];
        yield mk("範圍連同空行整段刪除", { text: apply(base.text, ch2), cs: ChangeSet.of(ch2, base.text.length), expected: null });
      }
      // 6 剪下貼到別篇（本篇沒有相似段／有近似段落）
      {
        const ch = [{ from: A.from, to: A.to + 2, insert: "" }];
        yield mk("剪下貼到別篇（本篇無相似段）", { text: apply(base.text, ch), cs: ChangeSet.of(ch, base.text.length), expected: null });
        // 近似段：把一個 4 字片段換掉的複本，放在遠處
        const src = base.text.slice(base.para[i]!.from, base.para[i]!.to);
        const m = mid(src);
        const dup = src.slice(0, m) + "（略）" + src.slice(m + 2);
        const paras = [...P]; const at = (i + 5) % 9 + 1;
        const idx = at >= i && at <= last ? 9 : at;
        paras.splice(idx + 1, 0, dup);
        const b2 = build(paras);
        const A2 = { from: b2.text.indexOf(src), to: b2.text.indexOf(src) + (kindZh === "單段" ? src.length : (base.text.slice(A.from, A.to).length)) };
        const ch3 = [{ from: A2.from, to: Math.min(b2.text.length, A2.to + 2), insert: "" }];
        yield mk("剪下貼到別篇（本篇有近似段）", { text: apply(b2.text, ch3), cs: ChangeSet.of(ch3, b2.text.length), expected: null }, b2, A2);
      }
      // 7 範圍中間改幾個字（對照組）
      {
        const t = base.text.slice(A.from, A.to);
        const at = A.from + mid(t);
        const ch = [{ from: at, to: at + 2, insert: "XX" }];
        const text = apply(base.text, ch);
        yield mk("對照：範圍中間改兩個字", { text, cs: ChangeSet.of(ch, base.text.length), expected: A });
      }
      // 8 兩台裝置同時改（由伺服器合併）
      {
        const pi = base.para[i]!;
        const key = base.text.slice(pi.from, pi.from + 8);
        const src = base.text.slice(pi.from, pi.to);
        const m = pi.from + mid(src);
        const expLine = (merged: string): Range => {
          const s = merged.indexOf(key); const ls = merged.lastIndexOf("\n", s - 1) + 1;
          const lastKey = base.text.slice(base.para[last]!.to - 8, base.para[last]!.to);
          const le0 = merged.indexOf(lastKey, ls); const le = merged.indexOf("\n", le0 < 0 ? ls : le0); 
          return { from: ls, to: le < 0 ? merged.length : le };
        };
        const mkDev = (scenario: string, d1: Change[], d2: Change[], exact = false) => {
          const dev1 = apply(base.text, d1), dev2 = apply(base.text, d2);
          const r = threeWayMergeBody(base.text, dev2, dev1);
          // exact：範圍起點的插入不納入（範圍不向外延伸），答案是原文本身
          const expected = exact ? (() => { const f = find(r.merged, aText); return f; })() : expLine(r.merged);
          return mk(scenario, { text: r.merged, expected }, base, A, { dev1, dev2 });
        };
        yield mkDev("兩台裝置同改一段（同段落不同位置）", [{ from: pi.to, to: pi.to, insert: "（裝置一補充）" }], [{ from: m, to: m + 2, insert: "ＹＹ" }]);
        const pj = base.para[(i % 7) + 1 === i || (i % 7) + 1 === last ? 9 : (i % 7) + 1]!;
        yield mkDev("兩台裝置各改不同段（無衝突）", [{ from: m, to: m + 2, insert: "ＸＸ" }], [{ from: pj.from + 3, to: pj.from + 5, insert: "ＹＹ" }]);
        yield mkDev("兩台裝置在同一點各自插入", [{ from: pi.from, to: pi.from, insert: "甲裝置：" }], [{ from: pi.from, to: pi.from, insert: "乙裝置：" }], true);
      }
    }
  }
}

export type SynRec = { scenario: string; kind: string; label: string; expected: Range | null; res: Record<"M1a" | "M1b" | "M2" | "M3", Range | null>; cls: Record<"M1a" | "M1b" | "M2" | "M3", Cls>; m1Broken: { M1a: boolean; M1b: boolean } };

export function runSynthetic(P_: Params = DEFAULTS): SynRec[] {
  const out: SynRec[] = [];
  for (const c of cases()) {
    const base = c.base, A = c.anchor;
    const kind = c.kind === "單段" ? "single" : "range";
    const segs = segment(base.text);
    const inside = segs.filter((s) => s.from >= A.from && s.to <= A.to);
    const first = inside[0]!, lastS = inside[inside.length - 1]!;
    const marks = kind === "single" ? [{ id: "zq1", seg: first }] : [{ id: "zq1a", seg: first }, { id: "zq1b", seg: lastS }];
    const res: SynRec["res"] = { M1a: null, M1b: null, M2: null, M3: null };
    const broken = { M1a: false, M1b: false };
    const finalText = c.edit.text;
    for (const [form, key] of [["eol", "M1a"], ["next", "M1b"]] as const) {
      let marked = m1Mark(base.text, marks, form);
      if (c.devices) {
        marked = m1Step(marked, base.text, c.devices.dev1).marked;
        marked = m1Step(marked, base.text, c.devices.dev2).marked;
      } else marked = m1Step(marked, base.text, finalText).marked;
      const loc = m1Locate(marked, { id: "zq1", kind }, form, marks.map((m) => m.id));
      res[key] = loc.range; broken[key] = loc.clean !== finalText;
    }
    const aligned = A;
    res.M2 = m2Step(m2Init(base.text, aligned), base.text, finalText, P_);
    res.M3 = m3Step(m3Init(base.text, aligned), base.text, finalText, P_, c.edit.cs);
    const cls = Object.fromEntries((["M1a", "M1b", "M2", "M3"] as const).map((k) => [k, classify(res[k], c.edit.expected)])) as SynRec["cls"];
    out.push({ scenario: c.scenario, kind: c.kind, label: c.label, expected: c.edit.expected, res, cls, m1Broken: broken });
  }
  return out;
}

if (process.argv[1]?.endsWith("run-synthetic.ts")) {
  const recs = runSynthetic();
  console.log(recs.length, "cases");
  const bad = recs.filter((r) => Object.values(r.cls).some((x) => x !== "correct"));
  console.log(bad.length, "with any non-correct");
}
