// 把一組 (base, incoming, current) 同時丟給「現行合併」與「認段落身分的原型」，統計與分類。
import { threeWayMergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { mergeLossProblems } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeLoss.js";
import { paraMergeBody } from "./paraMerge.js";

export type Case = {
  id: string;
  base: string;
  incoming: string;
  current: string;
  /** 理想結果（只有新產生器有）：clean＋文字，或 conflict */
  expect?: { kind: "clean" | "conflict"; text: string | null };
  tag?: string;
};

const sub = (needle: string, hay: string): boolean => {
  let k = 0;
  for (let i = 0; i < hay.length && k < needle.length; i++) if (hay[i] === needle[k]) k++;
  return k === needle.length;
};
/** 檢查用的單位＝非空的行（和原型的切段無關，所以不會替原型說話；單行段落、清單項目、表格列各是一行）。 */
const keys = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter((l) => l !== "");

/** 乾淨結果的不變條件（重複、掉字、憑空冒出的段落）。檢查本身已經在產品裡（mergeLossProblems，產品的補救層用它把關），這裡只負責轉成報告用的文字。 */
const PROBLEM_LABEL = { doubled: "重複", dropped: "掉字", "left-out": "該留的段落不見了", invented: "憑空" } as const;
export function invariantProblems(base: string, incoming: string, current: string, merged: string): string[] {
  return mergeLossProblems(base, incoming, current, merged).map((p) => `${PROBLEM_LABEL[p.kind]}：「${p.line.slice(0, 24)}」`);
}

/** 「小一點的版本」：先用現行合併；現行判衝突、而原型能乾淨合、且原型的結果通過行數檢查（沒有重複、掉字、憑空冒出的行）時才採用原型的結果。
 *  行數檢查很便宜（一次走過三份文字），原型搬移出錯時退回現行的衝突，不會默默留下兩份。 */
export function hybridPick<T extends { clean: boolean; problems: string[] }>(cur: T, pro: T): T { return !cur.clean && pro.clean && pro.problems.length === 0 ? pro : cur; }

/** 原型「解掉」的一個現行衝突區：兩邊在這一區各自新寫的行（base 區裡沒有的），是否都還在原型合併後的文字裡
 *  （原樣，或兩邊改同一行而被逐字合進某一行）。不通過＝這一區其實掉了字，不能算解掉。 */
export function regionResolved(d: { base: string; incoming: string; current: string }, merged: string): boolean {
  const sq = (x: string) => x.replace(/\s+/g, "");
  const doc = sq(merged);
  const mergedLines = keys(merged).map(sq);
  const baseLines = new Set(keys(d.base));
  const present = (l: string) => doc.includes(sq(l)) || mergedLines.some((m) => sub(sq(l), m));
  return [...keys(d.incoming), ...keys(d.current)].every((l) => baseLines.has(l) || present(l));
}

export type Outcome = {
  clean: boolean; merged: string; conflicts: number; ms: number;
  problems: string[]; fellBack?: boolean; kinds?: string[]; bases: string[]; details: Array<{ base: string; incoming: string; current: string }>;
};

function timed<T>(f: () => T, minMs = 4): [T, number] {
  const t0 = performance.now();
  const r = f();
  let dt = performance.now() - t0;
  if (dt < minMs) { // 太快就重複量，取每次平均
    let n = 1;
    const t1 = performance.now();
    while (performance.now() - t1 < minMs) { f(); n++; }
    dt = (performance.now() - t1) / n;
  }
  return [r, dt];
}

export function runBoth(c: Case, mode: "block" | "line" = "block"): { cur: Outcome; pro: Outcome } {
  const [cur, curMs] = timed(() => threeWayMergeBody(c.base, c.incoming, c.current));
  const [pro, proMs] = timed(() => paraMergeBody(c.base, c.incoming, c.current, mode));
  return {
    cur: { clean: cur.clean, merged: cur.merged, conflicts: cur.conflicts.length, bases: cur.conflicts.map((x) => x.base), details: cur.conflicts, ms: curMs, problems: cur.clean ? invariantProblems(c.base, c.incoming, c.current, cur.merged) : [] },
    pro: { clean: pro.clean, merged: pro.merged, conflicts: pro.conflicts.length, bases: pro.conflicts.map((x) => x.base), details: pro.conflicts, ms: proMs, problems: pro.clean ? invariantProblems(c.base, c.incoming, c.current, pro.merged) : [], fellBack: pro.fellBack, kinds: pro.kinds },
  };
}

const squash = (s: string) => s.replace(/\s+/g, "");

export type Row = {
  id: string; tag?: string;
  curClean: boolean; proClean: boolean; curConflicts: number; proConflicts: number;
  curMs: number; proMs: number;
  /** same／ws（只差空行）／better／worse／arguable；只在兩邊都乾淨且文字不同時有 */
  diff?: "ws" | "better" | "worse" | "arguable";
  curWrong: boolean; proWrong: boolean;
  /** 理想結果是否達成：clean 且文字相同，或理想就是衝突 */
  curIdeal?: boolean; proIdeal?: boolean;
  fellBack: boolean;
  /** 區域層級：現行的衝突區沒有任何原型衝突落在其中（＝被解掉），以及原型有、現行沒有的衝突 */
  regionsRemoved: number; regionsAdded: number; regionsRemovedBad: number;
  /** 小版本（先現行、衝突時才用原型）的結果 */
  hybClean: boolean; hybConflicts: number; hybWrong: boolean; hybIdeal?: boolean; hybMs: number; hybMerged: string; hybDiff?: boolean;
  newlyClean: boolean; newlyConflict: boolean;
  proKinds: string[];
};

export function classify(c: Case, r: { cur: Outcome; pro: Outcome }): Row {
  const { cur, pro } = r;
  const wrongOf = (o: Outcome) => o.clean && (o.problems.length > 0 || (c.expect?.kind === "clean" && c.expect.text !== null && o.merged !== c.expect.text));
  const row: Row = {
    id: c.id, tag: c.tag,
    curClean: cur.clean, proClean: pro.clean, curConflicts: cur.conflicts, proConflicts: pro.conflicts,
    curMs: cur.ms, proMs: pro.ms,
    curWrong: wrongOf(cur), proWrong: wrongOf(pro),
    fellBack: !!pro.fellBack,
    regionsRemoved: cur.bases.filter((b) => !pro.bases.some((p) => b.includes(p) || p.includes(b))).length,
    regionsRemovedBad: cur.details.filter((d) => !pro.bases.some((p) => d.base.includes(p) || p.includes(d.base))).filter((d) => !regionResolved(d, pro.merged)).length,
    regionsAdded: pro.bases.filter((p) => !cur.bases.some((b) => b.includes(p) || p.includes(b))).length,
    ...(() => {
      const h = hybridPick(cur, pro);
      return {
        hybClean: h.clean, hybConflicts: h.conflicts, hybWrong: wrongOf(h), hybMs: cur.ms + (cur.clean ? 0 : pro.ms), hybMerged: h.merged,
        hybDiff: h.clean && cur.clean && h.merged !== cur.merged,
      };
    })(),
    newlyClean: !cur.clean && pro.clean, newlyConflict: cur.clean && !pro.clean,
    proKinds: pro.kinds ?? [],
  };
  if (c.expect) {
    const ok = (o: Outcome) => c.expect!.kind === "conflict" ? !o.clean : o.clean && (c.expect!.text === null ? o.problems.length === 0 : o.merged === c.expect!.text);
    row.curIdeal = ok(cur); row.proIdeal = ok(pro); row.hybIdeal = ok(hybridPick(cur, pro));
  }
  if (cur.clean && pro.clean && cur.merged !== pro.merged) {
    if (squash(cur.merged) === squash(pro.merged)) row.diff = "ws";
    else if (c.expect?.kind === "clean" && c.expect.text !== null) row.diff = pro.merged === c.expect.text ? "better" : cur.merged === c.expect.text ? "worse" : "arguable";
    else if (cur.problems.length > 0 && pro.problems.length === 0) row.diff = "better";
    else if (pro.problems.length > 0 && cur.problems.length === 0) row.diff = "worse";
    else row.diff = "arguable";
  }
  return row;
}

export type Summary = {
  merges: number;
  curConflict: number; proConflict: number; curRegions: number; proRegions: number;
  newlyClean: number; newlyConflict: number; bothConflict: number;
  differentClean: number; ws: number; better: number; worse: number; arguable: number;
  curWrong: number; proWrong: number; fellBack: number;
  curIdeal?: number; proIdeal?: number; hybIdeal?: number;
  regionsRemoved: number; regionsAdded: number; regionsRemovedBad: number;
  hybConflict: number; hybRegions: number; hybWrong: number; hybMsMedian: number; hybMsP95: number;
  curMsMedian: number; proMsMedian: number; curMsP95: number; proMsP95: number;
  proKinds: Record<string, number>;
};

const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

export function summarize(rows: Row[]): Summary {
  const sum = (f: (r: Row) => boolean) => rows.filter(f).length;
  const kinds: Record<string, number> = {};
  for (const r of rows) for (const k of r.proKinds) kinds[k] = (kinds[k] ?? 0) + 1;
  const hasIdeal = rows.some((r) => r.curIdeal !== undefined);
  return {
    merges: rows.length,
    curConflict: sum((r) => !r.curClean), proConflict: sum((r) => !r.proClean),
    curRegions: rows.reduce((n, r) => n + r.curConflicts, 0), proRegions: rows.reduce((n, r) => n + r.proConflicts, 0),
    newlyClean: sum((r) => r.newlyClean), newlyConflict: sum((r) => r.newlyConflict), bothConflict: sum((r) => !r.curClean && !r.proClean),
    differentClean: sum((r) => r.diff !== undefined), ws: sum((r) => r.diff === "ws"), better: sum((r) => r.diff === "better"),
    worse: sum((r) => r.diff === "worse"), arguable: sum((r) => r.diff === "arguable"),
    curWrong: sum((r) => r.curWrong), proWrong: sum((r) => r.proWrong), fellBack: sum((r) => r.fellBack),
    ...(hasIdeal ? { curIdeal: sum((r) => r.curIdeal === true), proIdeal: sum((r) => r.proIdeal === true), hybIdeal: sum((r) => r.hybIdeal === true) } : {}),
    regionsRemoved: rows.reduce((n, r) => n + r.regionsRemoved, 0), regionsAdded: rows.reduce((n, r) => n + r.regionsAdded, 0), regionsRemovedBad: rows.reduce((n, r) => n + r.regionsRemovedBad, 0),
    hybConflict: sum((r) => !r.hybClean), hybRegions: rows.reduce((n, r) => n + r.hybConflicts, 0), hybWrong: sum((r) => r.hybWrong),
    hybMsMedian: q(rows.map((r) => r.hybMs), 0.5), hybMsP95: q(rows.map((r) => r.hybMs), 0.95),
    curMsMedian: q(rows.map((r) => r.curMs), 0.5), proMsMedian: q(rows.map((r) => r.proMs), 0.5),
    curMsP95: q(rows.map((r) => r.curMs), 0.95), proMsP95: q(rows.map((r) => r.proMs), 0.95),
    proKinds: kinds,
  };
}

/** 讓例子看得懂：換行顯示成 ⏎，太長就截。 */
export const show = (s: string, n = 140) => { const t = s.replace(/\n/g, "⏎"); return t.length > n ? t.slice(0, n) + "…" : t; };

/** 取出和 needle 有關的那一小段 ±pad，讓大文件的例子也讀得懂。 */
export function excerptDiff(a: string, b: string, pad = 40): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `…${show(a.slice(Math.max(0, i - pad), a.length - j + pad), 200)}…`;
}
