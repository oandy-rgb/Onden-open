// 分段字串緩衝（UTF-16 code unit 定位）。取代整串 slice 拼接：200 KB 文件做上千次編輯時，
// 每次只動一小段（約 1 KB）。這是測試台自己的小工具，不是 Eg-walker 的一部分。
const MAX = 1024;

export class TextBuf {
  private chunks: string[] = [];
  private lens: number[] = [];
  length = 0;

  static from(s: string): TextBuf {
    const b = new TextBuf();
    for (let i = 0; i < s.length; i += MAX / 2) {
      const c = s.slice(i, i + MAX / 2);
      b.chunks.push(c);
      b.lens.push(c.length);
    }
    b.length = s.length;
    return b;
  }

  private locate(pos: number): { ci: number; off: number } {
    let acc = 0;
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const l = this.lens[ci]!;
      if (pos <= acc + l) return { ci, off: pos - acc };
      acc += l;
    }
    throw new Error(`TextBuf: 位置 ${pos} 超出長度 ${this.length}`);
  }

  insert(pos: number, s: string): void {
    if (s.length === 0) return;
    if (this.chunks.length === 0) {
      this.chunks.push(s);
      this.lens.push(s.length);
      this.length = s.length;
      return;
    }
    const { ci, off } = this.locate(pos);
    const c = this.chunks[ci]!;
    const nc = c.slice(0, off) + s + c.slice(off);
    this.length += s.length;
    if (nc.length <= MAX) {
      this.chunks[ci] = nc;
      this.lens[ci] = nc.length;
    } else {
      const parts: string[] = [];
      for (let i = 0; i < nc.length; i += MAX / 2) parts.push(nc.slice(i, i + MAX / 2));
      this.chunks.splice(ci, 1, ...parts);
      this.lens.splice(ci, 1, ...parts.map((p) => p.length));
    }
  }

  delete(pos: number, n: number): void {
    if (n <= 0) return;
    if (pos + n > this.length) throw new Error(`TextBuf: 刪除超出長度 ${pos}+${n}>${this.length}`);
    this.length -= n;
    let { ci, off } = this.locate(pos);
    let left = n;
    while (left > 0) {
      if (off >= this.lens[ci]!) {
        ci++;
        off = 0;
        continue;
      }
      const c = this.chunks[ci]!;
      const take = Math.min(left, c.length - off);
      const nc = c.slice(0, off) + c.slice(off + take);
      left -= take;
      if (nc.length === 0) {
        this.chunks.splice(ci, 1);
        this.lens.splice(ci, 1);
      } else {
        this.chunks[ci] = nc;
        this.lens[ci] = nc.length;
        if (left > 0) {
          ci++;
          off = 0;
        }
      }
    }
  }

  /** 前 pos 個 UTF-16 單位裡有幾對代理字（＝比 unicode 字元數多出的單位數）。DT 以字元計位，轉換用。 */
  astralBefore(pos: number): number {
    let n = 0, left = pos;
    for (const c of this.chunks) {
      const m = Math.min(left, c.length);
      for (let i = 0; i < m; i++) { const u = c.charCodeAt(i); if (u >= 0xd800 && u <= 0xdbff) n++; }
      left -= m;
      if (left <= 0) break;
    }
    return n;
  }

  slice(pos: number, len: number): string {
    return this.toString().slice(pos, pos + len);
  }

  toString(): string {
    return this.chunks.join("");
  }
}
