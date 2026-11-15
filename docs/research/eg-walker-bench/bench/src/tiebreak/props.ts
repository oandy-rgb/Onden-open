// 性質測試的場景產生與檢查（tiebreak.test.ts 與 runProps.ts 共用）。
import { Replica, deliver, replayInOrder, makeRng, type Unit } from "./sim.js";
import { withRule, type Rule } from "./variantEngine.js";

const ALPHABET = "abcdefgh\n 字";

/** 隨機多副本：編輯、隨機同步，最後全部同步。回傳各副本文字是否一致、從零以其他拓撲順序重放是否一致。 */
function guarded<T extends { ok: boolean }>(fn: () => T, bad: (why: string) => T): T {
  try { return fn(); } catch (e) { return bad(`引擎丟出錯誤：${(e as Error).message}`); }
}

export function convergence(seed: number, rule: Rule): { ok: boolean; why?: string; ops: number; concurrent: number } {
  return guarded(() => withRule(rule, () => {
    const rng = makeRng(seed);
    const n = 2 + (seed % 3);
    const reps = Array.from({ length: n }, (_, i) => new Replica(`n${i}`));
    const units = new Map<string, Unit>();
    const rounds = 6 + (seed % 20);
    for (let r = 0; r < rounds; r++) {
      const a = reps[rng.int(n)]!;
      for (let k = 0, m = rng.int(4); k <= m; k++) {
        const len = a.text.length;
        if (len > 0 && rng.chance(0.35)) {
          a.local(units, [rng.int(len), 1, ""]);
        } else {
          const pos = rng.int(len + 1);
          const s = Array.from({ length: 1 + rng.int(4) }, () => rng.pick([...ALPHABET])).join("");
          // 一次輸入的連續字：逐字一個單位，往右打（pos, pos+1, …）
          for (let i = 0; i < s.length; i++) a.local(units, [pos + i, 0, s[i]!]);
        }
      }
      if (rng.chance(0.5)) {
        const b = reps[rng.int(n)]!;
        if (b !== a) deliver(a, b, rng);
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) deliver(reps[j]!, reps[i]!, rng);
    const texts = reps.map((x) => x.text);
    if (!texts.every((t) => t === texts[0])) return { ok: false, why: "副本之間文字不同", ops: units.size, concurrent: 0 };
    const all = [...units.values()];
    for (let k = 0; k < 3; k++) {
      const t = replayInOrder(all, rng);
      if (t !== texts[0]) return { ok: false, why: `換個送達順序從零重放得到不同文字（第 ${k + 1} 次）`, ops: units.size, concurrent: 0 };
    }
    return { ok: true, ops: units.size, concurrent: 0 };
  }), (why) => ({ ok: false, why, ops: 0, concurrent: 0 }));
}

export type Typing = "forward" | "backward" | "block" | "inside";
/** 在同一個間隙，k 個副本各打一段「自己專屬字元」的字；合併後每個副本的字必須各自連成一段。 */
export function interleaving(seed: number, rule: Rule, typings: Typing[]): { ok: boolean; text: string; base: string; units?: Unit[] } {
  return guarded(() => withRule(rule, () => {
    const rng = makeRng(seed);
    const k = typings.length;
    const reps = Array.from({ length: k + 1 }, (_, i) => new Replica(i === 0 ? "base" : `n${i}`));
    const units = new Map<string, Unit>();
    const base = Array.from({ length: 1 + rng.int(8) }, () => rng.pick(["x", "y", "z", "\n"])).join("");
    // 基底用隨機位置插入，讓缺口右邊的字有各種不同的左原點
    let cur = "";
    for (const ch of base) { const at = rng.int(cur.length + 1); reps[0]!.local(units, [at, 0, ch]); cur = cur.slice(0, at) + ch + cur.slice(at); }
    for (let i = 1; i <= k; i++) deliver(reps[0]!, reps[i]!, rng);
    const gap = rng.int(reps[0]!.text.length + 1);
    typings.forEach((how, idx) => {
      const rep = reps[idx + 1]!;
      const letters = Array.from({ length: 2 + rng.int(5) }, (_, i) => String.fromCharCode(0x41 + idx * 8 + i));
      if (how === "forward") letters.forEach((c, i) => rep.local(units, [gap + i, 0, c]));
      else if (how === "backward") letters.forEach((c) => rep.local(units, [gap, 0, c]));
      else if (how === "inside") letters.forEach((c, i) => rep.local(units, [gap + rng.int(i + 1), 0, c])); // 在自己已打的字之間隨機位置插入
      else letters.forEach((c, i) => rep.local(units, [gap + i, 0, c])); // block：同樣的單位，一批送出
    });
    const order = Array.from({ length: k }, (_, i) => i + 1);
    // 隨機順序、隨機批次互送
    for (let round = 0; round < 2; round++) for (const i of order.sort(() => rng.next() - 0.5)) for (const j of order) if (i !== j) deliver(reps[j]!, reps[i]!, rng);
    const texts = reps.slice(1).map((x) => x.text);
    if (!texts.every((t) => t === texts[0])) return { ok: false, text: texts.join(" | "), base };
    const text = texts[0]!;
    // 每個副本的字（A–H、I–P、…）只能出現一個連續段
    let ok = true;
    for (let idx = 0; idx < k; idx++) {
      const lo = 0x41 + idx * 8, hi = lo + 7;
      const re = new RegExp(`[${String.fromCharCode(lo)}-${String.fromCharCode(hi)}]+`, "g");
      if ((text.match(re) ?? []).length !== 1) ok = false;
    }
    return { ok, text, base: reps[0]!.text, units: [...units.values()] };
  }), (why) => ({ ok: false, text: why, base: "" }));
}
