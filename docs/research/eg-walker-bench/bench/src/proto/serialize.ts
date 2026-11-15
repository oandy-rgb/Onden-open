// 原型的歷史序列化格式（只為量「存歷史要多大」與載入時間；不是產品格式）。
// 版面：魔數、agent 表、交易（父版本以「距離自己起點的差」存）、操作（長度＋種類、位置差值）、
// 全部插入文字串成一塊 UTF-8。LV 是連續的，所以不用存。
import type { History, PatchOp, Txn } from "../types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

class Writer {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private ensure(k: number) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf); this.buf = b; } }
  varint(v: number) { this.ensure(10); while (v >= 128) { this.buf[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); } this.buf[this.n++] = v; }
  zig(v: number) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; }
  out() { return this.buf.slice(0, this.n); }
}
class Reader {
  n = 0;
  constructor(readonly b: Uint8Array) {}
  varint(): number { let v = 0, m = 1; for (;;) { const x = this.b[this.n++]!; v += (x & 127) * m; if (x < 128) return v; m *= 128; } }
  zig(): number { const v = this.varint(); return v % 2 === 0 ? v / 2 : -(v + 1) / 2; }
  bytes(k: number): Uint8Array { const o = this.b.subarray(this.n, this.n + k); this.n += k; return o; }
}

export function encodeHistory(h: History): Uint8Array {
  const w = new Writer();
  const agents: string[] = [];
  for (const t of h.txns) if (!agents.includes(t.agent)) agents.push(t.agent);
  w.varint(0x45475731);
  w.varint(agents.length);
  for (const a of agents) { const b = enc.encode(a); w.varint(b.length); w.bytes(b); }
  w.varint(h.txns.length);
  let text = "";
  for (const t of h.txns) {
    w.varint(agents.indexOf(t.agent));
    w.varint(t.start);
    w.varint(t.parents.length);
    for (const p of t.parents) w.varint(t.start - 1 - p);
    w.varint(t.ops.length);
    let prev = 0;
    for (const [pos, del, ins] of t.ops) {
      const len = del > 0 ? del : ins.length;
      w.varint(len * 2 + (del > 0 ? 0 : 1));
      w.zig(pos - prev);
      prev = pos;
      if (del === 0) text += ins;
    }
  }
  const tb = enc.encode(text);
  w.varint(tb.length);
  w.bytes(tb);
  return w.out();
}

export function decodeHistory(bytes: Uint8Array): History {
  const r = new Reader(bytes);
  if (r.varint() !== 0x45475731) throw new Error("不是 EGW1 格式");
  const agents: string[] = [];
  for (let i = r.varint(); i > 0; i--) agents.push(dec.decode(r.bytes(r.varint())));
  type RawOp = [pos: number, del: number, insLen: number];
  const raw: Array<{ agent: string; start: number; parents: number[]; ops: RawOp[] }> = [];
  for (let nt = r.varint(); nt > 0; nt--) {
    const agent = agents[r.varint()]!;
    const start = r.varint();
    const parents: number[] = [];
    for (let k = r.varint(); k > 0; k--) parents.push(start - 1 - r.varint());
    const ops: RawOp[] = [];
    let prev = 0;
    for (let k = r.varint(); k > 0; k--) {
      const lv = r.varint();
      const pos = prev + r.zig();
      prev = pos;
      ops.push(lv % 2 === 1 ? [pos, 0, (lv - 1) / 2] : [pos, lv / 2, 0]);
    }
    raw.push({ agent, start, parents, ops });
  }
  const text = dec.decode(r.bytes(r.varint()));
  let ti = 0;
  const txns: Txn[] = raw.map((t) => ({
    agent: t.agent,
    start: t.start,
    parents: t.parents,
    ops: t.ops.map(([pos, del, l]): PatchOp => {
      if (del > 0) return [pos, del, ""];
      const s = text.slice(ti, ti + l);
      ti += l;
      return [pos, 0, s];
    }),
  }));
  return { txns };
}
