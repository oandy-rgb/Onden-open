// 新的產生器（b）：專挑「認段落身分」想解的情況，每個情境附「理想結果」。
// 做法：筆記是一串「實體」（段落／清單項目／標題，每個有固定 id 與句子陣列）；兩邊各做幾個以 id 為準的操作
// （搬、插、刪、拆、併、改某一句）。兩邊的操作彼此不衝突時，理想結果＝兩邊的操作都套在 base 上（以 id 找對象，與順序無關）。
// 理想結果標明 clean（該乾淨合）或 conflict（依業主規則該判衝突）。
import { genSentence } from "../genNote.js";
import { makeRng, type Rng } from "../prng.js";

export type Ent = { id: string; sentences: string[]; kind: "para" | "item" | "heading"; join?: boolean };
type Ents = Ent[];
const text = (e: Ent) => e.sentences.join("");

export function render(ents: Ents): string {
  let out = "";
  ents.forEach((e, i) => {
    const next = ents[i + 1];
    const body = e.kind === "heading" ? text(e) : e.kind === "item" ? `- ${text(e)}` : text(e);
    const gap = !next ? "\n" : e.kind === "item" && next.kind === "item" ? "\n" : "\n\n";
    out += body + gap;
  });
  return out;
}

export type ExpectKind = "clean" | "conflict";
export type Scenario = {
  kind: string;
  seed: number;
  base: string;
  /** 兩邊（incoming 與 current 隨機指派；ideal 與指派無關） */
  incoming: string;
  current: string;
  expect: ExpectKind;
  /** expect=clean 時的理想文字；null＝理想結果不唯一（例如兩邊在同一點各插一段，只檢查沒掉字） */
  expected: string | null;
  note: string;
};

let uid = 0;
const mkPara = (rng: Rng): Ent => ({ id: `p${uid++}`, kind: "para", sentences: Array.from({ length: 2 + rng.int(3) }, () => genSentence(rng)) });
const mkItem = (rng: Rng): Ent => ({ id: `i${uid++}`, kind: "item", sentences: [genSentence(rng)] });
const mkHeading = (rng: Rng): Ent => ({ id: `h${uid++}`, kind: "heading", sentences: [`## ${genSentence(rng).replace(/[。！？. ]+$/, "")}`] });

/** 一份約 24 個實體的筆記：標題、段落、一串 6 個項目的清單。 */
function baseDoc(rng: Rng): Ents {
  const ents: Ents = [mkHeading(rng)];
  for (let i = 0; i < 6; i++) ents.push(mkPara(rng));
  ents.push(mkHeading(rng));
  for (let i = 0; i < 6; i++) ents.push(mkItem(rng));
  for (let i = 0; i < 4; i++) ents.push(mkPara(rng));
  ents.push(mkHeading(rng));
  for (let i = 0; i < 5; i++) ents.push(mkPara(rng));
  return ents;
}

// ── 以 id 為準的操作 ─────────────────────────────────────────────
type Op = (ents: Ents) => Ents;
const idx = (ents: Ents, id: string) => ents.findIndex((e) => e.id === id);
const opEdit = (id: string, k: number, at: number, ins: string, del = 0): Op => (ents) => ents.map((e) => {
  if (e.id !== id) return e;
  const s = e.sentences.slice();
  const body = s[k]!;
  const cut = Math.max(1, Math.min(body.length - 2 - del, at));
  s[k] = body.slice(0, cut) + ins + body.slice(cut + del);
  return { ...e, sentences: s };
});
const opMove = (id: string, after: string | null): Op => (ents) => {
  const e = ents[idx(ents, id)]!;
  const rest = ents.filter((x) => x.id !== id);
  const at = after === null ? 0 : idx(rest, after) + 1;
  return [...rest.slice(0, at), e, ...rest.slice(at)];
};
const opDel = (id: string): Op => (ents) => ents.filter((e) => e.id !== id);
const opIns = (after: string | null, add: Ents): Op => (ents) => {
  const at = after === null ? 0 : idx(ents, after) + 1;
  return [...ents.slice(0, at), ...add, ...ents.slice(at)];
};
const opSplit = (id: string, afterSentence: number): Op => (ents) => ents.flatMap((e) => e.id !== id ? [e] : [
  { ...e, sentences: e.sentences.slice(0, afterSentence + 1) },
  { ...e, id: `${e.id}s`, sentences: e.sentences.slice(afterSentence + 1) },
]);
const apply = (ents: Ents, ops: Op[]) => ops.reduce((x, op) => op(x), ents);

const PHRASES = ["（已確認）", "，並且補上說明", "，尚待測試", "（見上週紀錄）", "，這點很重要", "（暫定）", "，改為每日檢查", "，不再需要"];
const editOf = (rng: Rng, e: Ent, k?: number): Op => {
  const kk = k ?? rng.int(e.sentences.length);
  const s = e.sentences[kk]!;
  // 一半是純加字，一半是把幾個字換掉（換字、刪字：產品的逐字合併只收「兩邊都只加字」）
  const del = rng.chance(0.5) ? 0 : 1 + rng.int(3);
  return opEdit(e.id, kk, 2 + rng.int(Math.max(1, s.length - 6)), rng.pick(PHRASES), del);
};

const pickPara = (rng: Rng, ents: Ents, not: string[] = []): Ent => {
  const c = ents.filter((e) => e.kind === "para" && !not.includes(e.id));
  return c[rng.int(c.length)]!;
};

type Kind = (rng: Rng) => { ents: Ents; mine: Op[]; theirs: Op[]; expect: ExpectKind; expected: Op[] | "ambiguous"; note: string };

const KINDS: Record<string, Kind> = {
  /** 一邊把段落搬到別處，另一邊改這個段落 */
  "move-vs-edit": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    const targets = ents.filter((x) => x.kind === "para" && x.id !== e.id && Math.abs(idx(ents, x.id) - idx(ents, e.id)) > 1);
    const to = targets[rng.int(targets.length)]!;
    const mine = [opMove(e.id, to.id)], theirs = [editOf(rng, e)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "搬段落的同時對方改它" };
  },
  /** 一邊在上面插入／刪除段落，另一邊改下面某段 */
  "insert-delete-above-vs-edit": (rng) => {
    const ents = baseDoc(rng);
    const e = ents[8 + rng.int(ents.length - 9)]!;
    const above = ents.slice(0, idx(ents, e.id));
    const mine: Op[] = [];
    const n = 1 + rng.int(3);
    for (let k = 0; k < n; k++) { const at = above[rng.int(above.length)]!; mine.push(opIns(at.id, [mkPara(rng)])); }
    const dels = above.filter((x) => x.kind === "para" && x.id !== e.id);
    if (dels.length > 0 && rng.chance(0.6)) mine.push(opDel(dels[rng.int(dels.length)]!.id));
    const theirs = [editOf(rng, e)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "上面插入或刪段落，下面有人改" };
  },
  /** 一邊把一段拆成兩段，另一邊改這段的某一句（理想：兩者都留） */
  "split-vs-edit": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    const s = rng.int(e.sentences.length - 1);
    const k = rng.int(e.sentences.length);
    const edit = editOf(rng, e, k);
    return { ents, mine: [opSplit(e.id, s)], theirs: [edit], expect: "clean", expected: [edit, opSplit(e.id, s)], note: "拆段落的同時對方改其中一句" };
  },
  /** 一邊把相鄰兩段併成一段，另一邊改其中一段（理想：兩者都留） */
  "join-vs-edit": (rng) => {
    const ents = baseDoc(rng);
    const firsts = ents.filter((x, i) => x.kind === "para" && ents[i + 1]?.kind === "para");
    const a = firsts[rng.int(firsts.length)]!;
    const b = ents[idx(ents, a.id) + 1]!;
    // 併段：兩段的文字用單一換行接起來（不再有空行），成為一個段落
    const joinOp: Op = (es) => es.flatMap((e) => {
      if (e.id === a.id) {
        const cur = es[idx(es, b.id)]!;
        return [{ ...e, sentences: [...e.sentences, "\n", ...cur.sentences] }];
      }
      return e.id === b.id ? [] : [e];
    });
    const target = rng.chance(0.5) ? a : b;
    const edit = editOf(rng, target);
    return { ents, mine: [joinOp], theirs: [edit], expect: "clean", expected: [edit, joinOp], note: "併段落的同時對方改其中一段" };
  },
  /** 清單裡搬一項，另一邊改另一項 */
  "list-reorder-vs-edit-other": (rng) => {
    const ents = baseDoc(rng);
    const items = ents.filter((e) => e.kind === "item");
    const m = items[rng.int(items.length)]!;
    const others = items.filter((x) => x.id !== m.id);
    const dest = others[rng.int(others.length)]!;
    const edited = others.filter((x) => x.id !== dest.id);
    const t = edited[rng.int(edited.length)]!;
    const mine = [opMove(m.id, dest.id)], theirs = [editOf(rng, t)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "清單搬一項、對方改另一項" };
  },
  /** 清單裡搬一項，另一邊改同一項 */
  "list-reorder-vs-edit-same": (rng) => {
    const ents = baseDoc(rng);
    const items = ents.filter((e) => e.kind === "item");
    const m = items[rng.int(items.length)]!;
    const dest = items.filter((x) => x.id !== m.id)[rng.int(items.length - 1)]!;
    const mine = [opMove(m.id, dest.id)], theirs = [editOf(rng, m)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "清單搬一項、對方改這一項" };
  },
  /** 兩邊各搬不同的項目到不同的位置 */
  "list-two-moves": (rng) => {
    const ents = baseDoc(rng);
    const items = ents.filter((e) => e.kind === "item");
    const [m1, m2, d1, d2] = [items[0]!, items[1]!, items[3]!, items[5]!];
    const mine = [opMove(m1.id, d1.id)], theirs = [opMove(m2.id, d2.id)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "清單兩邊各搬不同項目" };
  },
  /** 兩邊改相鄰的兩段（不同段） */
  "adjacent-edits": (rng) => {
    const ents = baseDoc(rng);
    const firsts = ents.filter((x, i) => ents[i + 1] && x.kind !== "heading" && ents[i + 1]!.kind !== "heading");
    const a = firsts[rng.int(firsts.length)]!;
    const b = ents[idx(ents, a.id) + 1]!;
    const mine = [editOf(rng, a)], theirs = [editOf(rng, b)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "兩邊改相鄰的兩段" };
  },
  /** 兩邊在同一個長段落改不同的句子（認段落解不了） */
  "same-paragraph-different-sentences": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents.filter((x) => x.sentences.length >= 2));
    const k1 = rng.int(e.sentences.length);
    let k2 = rng.int(e.sentences.length);
    if (k2 === k1) k2 = (k1 + 1) % e.sentences.length;
    const mine = [editOf(rng, e, k1)], theirs = [editOf(rng, e, k2)];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "同一段不同句，各改各的" };
  },
  /** 兩邊改同一段的同一句（業主規則：衝突） */
  "same-sentence": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    const k = rng.int(e.sentences.length);
    return { ents, mine: [editOf(rng, e, k)], theirs: [editOf(rng, e, k)], expect: "conflict", expected: "ambiguous", note: "兩邊改同一句" };
  },
  /** 一邊刪段落，另一邊改它（衝突） */
  "delete-vs-edit": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    return { ents, mine: [opDel(e.id)], theirs: [editOf(rng, e)], expect: "conflict", expected: "ambiguous", note: "一邊刪、一邊改同一段" };
  },
  /** 兩邊在同一個位置各插一段（順序不唯一，只檢查兩段都在） */
  "both-insert-same-point": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    return { ents, mine: [opIns(e.id, [mkPara(rng)])], theirs: [opIns(e.id, [mkPara(rng)])], expect: "clean", expected: "ambiguous", note: "同一點兩邊各插一段" };
  },
  /** 兩邊把同一段搬到不同的地方（衝突） */
  "move-move-different": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    const ts = ents.filter((x) => x.kind === "para" && x.id !== e.id);
    const t1 = ts[rng.int(ts.length)]!;
    let t2 = ts[rng.int(ts.length)]!;
    if (t2.id === t1.id) t2 = ts[(ts.indexOf(t1) + 3) % ts.length]!;
    return { ents, mine: [opMove(e.id, t1.id)], theirs: [opMove(e.id, t2.id)], expect: "conflict", expected: "ambiguous", note: "兩邊把同一段搬到不同的地方" };
  },
  /** 一邊搬段落，另一邊在別處插入段落 */
  "move-vs-insert-elsewhere": (rng) => {
    const ents = baseDoc(rng);
    const e = pickPara(rng, ents);
    const to = pickPara(rng, ents, [e.id]);
    const at = pickPara(rng, ents, [e.id, to.id]);
    const mine = [opMove(e.id, to.id)], theirs = [opIns(at.id, [mkPara(rng)])];
    return { ents, mine, theirs, expect: "clean", expected: [...mine, ...theirs], note: "一邊搬段落、另一邊別處插段落" };
  },
};

export const KIND_NAMES = Object.keys(KINDS);

export function genScenario(kind: string, seed: number): Scenario {
  const rng = makeRng(seed * 7919 + KIND_NAMES.indexOf(kind) * 104729 + 1);
  uid = seed * 1000;
  const k = KINDS[kind]!(rng);
  const base = render(k.ents);
  const mineText = render(apply(k.ents, k.mine));
  const theirsText = render(apply(k.ents, k.theirs));
  const swap = rng.chance(0.5);
  const expected = k.expect === "conflict" || k.expected === "ambiguous" ? null : render(apply(k.ents, k.expected));
  return {
    kind, seed, base, incoming: swap ? theirsText : mineText, current: swap ? mineText : theirsText,
    expect: k.expect, expected, note: k.note,
  };
}

