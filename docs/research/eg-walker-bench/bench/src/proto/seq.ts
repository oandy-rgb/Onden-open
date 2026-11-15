// 原型的「項目序列」：文件順序的 run 清單（一個 run＝一段連續編號、狀態相同的字元）。
// 參考實作是一個字元一個物件放進平面陣列，找位置要從頭線性掃；這裡
//   (a) 一個 run 代表一段連續插入（run-length），
//   (b) 序列切成小段（chunk），每段快取「目前可見寬度／最終可見寬度」，找位置時整段跳過。
// chunkMax=Infinity 時退化成單一陣列（用來量 (b) 的貢獻）。

/** 尚未插入（回到比它更早的版本時）。0＝已插入；>=1＝被刪除的次數。 */
export const NYI = -1;

export interface Run {
  lv: number;
  len: number;
  cur: number;
  end: 0 | 1;
  /** 第一個字元的 originLeft（-1＝文件開頭）。其餘字元的 originLeft 是前一個字元。 */
  oL: number;
  /** 第一個字元的 rightParent（-1＝文件結尾）。其餘字元為 -1。 */
  rP: number;
  /** 佔位 run（共同祖先時已存在的文字）：每個字元的 originLeft 都是 -1。 */
  ph: boolean;
  /** 最先刪掉這段的操作 LV（分析「誰刪了什麼」用，-1＝沒被刪） */
  delBy: number;
  chunk: Chunk;
}

export interface Chunk {
  runs: Run[];
  /** 在 Seq.chunks 裡的索引（寬度總和存在 Seq 的型別陣列，掃描時不必逐個物件取值） */
  idx: number;
}

export interface Cursor {
  ci: number;
  ri: number;
  /** 游標之前「最終文件」的字元數（＝套用到文字緩衝的位置） */
  endPos: number;
}

/** 新 run 建立時的暫代 chunk（讓 chunk 欄位從一開始就是物件，形狀穩定）；插入序列時才換成真的 */
export const NO_CHUNK: Chunk = { runs: [], idx: -1 };
export const curWidth = (r: Run): number => (r.cur === 0 ? r.len : 0);
export const endWidth = (r: Run): number => (r.end === 0 ? r.len : 0);

export class Seq {
  chunks: Chunk[] = [{ runs: [], idx: 0 }];
  /** 每個 chunk 的「目前可見寬度」「最終可見寬度」總和；找位置時先掃這兩個型別陣列再進入 chunk */
  private cw = new Int32Array(16);
  private ew = new Int32Array(16);
  /** 依 lv 排序的全部 run，用二分搜尋由 LV 找到 run（回溯／前進時用） */
  private byLv: Run[] = [];
  runCount = 0;

  constructor(private readonly chunkMax: number = 64) {}

  get chunkCount(): number {
    return this.chunks.length;
  }

  private register(run: Run): void {
    const a = this.byLv;
    if (a.length === 0 || a[a.length - 1]!.lv < run.lv) a.push(run);
    else {
      let lo = 0, hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid]!.lv < run.lv) lo = mid + 1;
        else hi = mid;
      }
      a.splice(lo, 0, run);
    }
    this.runCount++;
  }

  /** 加入新 run（lv 必須互不重疊）。 */
  insertRun(cur: Cursor, run: Run): void {
    const ch = this.chunks[cur.ci]!;
    run.chunk = ch;
    ch.runs.splice(cur.ri, 0, run);
    this.cw[ch.idx]! += curWidth(run);
    this.ew[ch.idx]! += endWidth(run);
    this.register(run);
  }

  /** 附加新 run 到序列最前面（初始化佔位用）。 */
  pushInitial(run: Run): void {
    const ch = this.chunks[0]!;
    run.chunk = ch;
    ch.runs.push(run);
    this.cw[ch.idx]! += curWidth(run);
    this.ew[ch.idx]! += endWidth(run);
    this.register(run);
  }

  setCur(r: Run, cur: number): void {
    const i = r.chunk.idx;
    this.cw[i]! -= curWidth(r);
    r.cur = cur;
    this.cw[i]! += curWidth(r);
  }

  setEnd(r: Run, end: 0 | 1): void {
    const i = r.chunk.idx;
    this.ew[i]! -= endWidth(r);
    r.end = end;
    this.ew[i]! += endWidth(r);
  }

  /** 讓一個已是「已插入、可見」的 run 變長（把緊接著的連續插入併進來）。 */
  grow(r: Run, by: number): void {
    r.len += by;
    this.cw[r.chunk.idx]! += by;
    this.ew[r.chunk.idx]! += by;
  }

  /** 把 run 切成 [前 off 個][其餘]，回傳後半。狀態相同，所以 chunk 的寬度總和不變。 */
  split(r: Run, off: number): Run {
    const tail: Run = {
      lv: r.lv + off,
      len: r.len - off,
      cur: r.cur,
      end: r.end,
      oL: r.ph ? -1 : r.lv + off - 1,
      rP: -1,
      ph: r.ph,
      delBy: r.delBy,
      chunk: r.chunk,
    };
    r.len = off;
    const runs = r.chunk.runs;
    runs.splice(runs.indexOf(r) + 1, 0, tail);
    this.register(tail);
    return tail;
  }

  /** 若這個 chunk 超過上限就切成多段（呼叫後原有游標失效）。chunk 的寬度總和在型別陣列裡就地維護。 */
  fix(ch: Chunk): void {
    if (ch.runs.length <= this.chunkMax) return;
    const ci = ch.idx;
    const target = Math.max(2, this.chunkMax >> 1);
    const all = ch.runs;
    ch.runs = all.slice(0, target);
    const pieces: Chunk[] = [];
    for (let i = target; i < all.length; i += target) {
      const nc: Chunk = { runs: all.slice(i, i + target), idx: -1 };
      for (const r of nc.runs) r.chunk = nc;
      pieces.push(nc);
    }
    const nOld = this.chunks.length;
    const k = pieces.length;
    if (nOld + k > this.cw.length) {
      const cw2 = new Int32Array((nOld + k) * 2), ew2 = new Int32Array((nOld + k) * 2);
      cw2.set(this.cw.subarray(0, nOld)); ew2.set(this.ew.subarray(0, nOld));
      this.cw = cw2; this.ew = ew2;
    }
    this.cw.copyWithin(ci + 1 + k, ci + 1, nOld);
    this.ew.copyWithin(ci + 1 + k, ci + 1, nOld);
    this.chunks.splice(ci + 1, 0, ...pieces);
    for (let i = ci; i < this.chunks.length; i++) this.chunks[i]!.idx = i;
    for (let i = ci; i <= ci + k; i++) {
      let c = 0, e = 0;
      for (const r of this.chunks[i]!.runs) { c += curWidth(r); e += endWidth(r); }
      this.cw[i] = c;
      this.ew[i] = e;
    }
  }

  /** 回溯／前進可能一口氣切碎很多 run：全部 chunk 檢查一次。 */
  rebalance(): void {
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const before = this.chunks.length;
      this.fix(this.chunks[ci]!);
      ci += this.chunks.length - before;
    }
  }

  /**
   * 游標移到「目前版本可見字元恰好數到 target 個」的地方（那個字元之後、其後的看不見項目之前）。
   * 落在 run 中間時把 run 切開。與參考實作的 findByCurPos 同語意。
   */
  findByCurPos(target: number): Cursor {
    if (target === 0) return { ci: 0, ri: 0, endPos: 0 };
    let cur = 0, end = 0;
    const cw = this.cw, ew = this.ew, n = this.chunks.length;
    for (let ci = 0; ci < n; ci++) {
      const w0 = cw[ci]!;
      if (cur + w0 < target) {
        cur += w0;
        end += ew[ci]!;
        continue;
      }
      const ch = this.chunks[ci]!;
      for (let ri = 0; ri < ch.runs.length; ri++) {
        const r = ch.runs[ri]!;
        const w = curWidth(r);
        if (cur + w < target) {
          cur += w;
          end += endWidth(r);
          continue;
        }
        const off = target - cur;
        if (off < w) this.split(r, off);
        return { ci, ri: ri + 1, endPos: end + endWidth(r) };
      }
    }
    throw new Error(`文件不夠長，找不到位置 ${target}`);
  }

  /** 游標所在的 run（必要時越過 chunk 邊界；游標會被正規化）。 */
  peek(c: Cursor): Run | undefined {
    for (;;) {
      const ch = this.chunks[c.ci]!;
      if (c.ri < ch.runs.length) return ch.runs[c.ri];
      if (c.ci + 1 >= this.chunks.length) return undefined;
      c.ci++;
      c.ri = 0;
    }
  }

  /** 游標前一個 run。 */
  prev(c: Cursor): Run | undefined {
    if (c.ri > 0) return this.chunks[c.ci]!.runs[c.ri - 1];
    for (let ci = c.ci - 1; ci >= 0; ci--) {
      const rs = this.chunks[ci]!.runs;
      if (rs.length) return rs[rs.length - 1];
    }
    return undefined;
  }

  /** 找到包含 LV 的 run。 */
  runAt(lv: number): Run {
    const a = this.byLv;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid]!.lv <= lv) lo = mid;
      else hi = mid - 1;
    }
    const r = a[lo];
    if (!r || lv < r.lv || lv >= r.lv + r.len) throw new Error(`找不到 LV ${lv} 的項目`);
    return r;
  }

  /** 讓 [a,b) 的邊界對齊 run 邊界，回傳涵蓋它的 run（依 lv 排序）。 */
  runsCovering(a: number, b: number): Run[] {
    let r = this.runAt(a);
    if (r.lv < a) r = this.split(r, a - r.lv);
    const out: Run[] = [];
    let pos = a;
    while (pos < b) {
      if (r.lv + r.len > b) this.split(r, b - r.lv);
      out.push(r);
      pos = r.lv + r.len;
      if (pos < b) r = this.runAt(pos);
    }
    return out;
  }

  /** run 在文件順序中的位置 [chunk, 段內索引]；只用於罕見的「同處並行插入」比較。 */
  indexOfRun(r: Run): [number, number] {
    return [this.chunks.indexOf(r.chunk), r.chunk.runs.indexOf(r)];
  }

  /** 由前到後走訪所有 run。 */
  *iter(): Generator<Run> {
    for (const ch of this.chunks) for (const r of ch.runs) yield r;
  }
}
