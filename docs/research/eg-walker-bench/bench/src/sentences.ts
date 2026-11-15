// 「句」的切法：句號類標點（。！？!?；英文句點後接空白或行尾）之後切；換行一定切（換行字元算前一句）。
// 生成器用它分配兩支的編輯，合併分析用它判斷「同一句重疊」，兩邊必須是同一份定義。
export type Span = [start: number, end: number];

export function sentenceSpans(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let cut = false;
    if (c === 10) cut = true; // \n
    else if (c === 0x3002 || c === 0xff01 || c === 0xff1f || c === 33 || c === 63) cut = true; // 。！？!?
    else if (c === 46) {
      const nx = i + 1 < n ? text.charCodeAt(i + 1) : 10;
      if (nx === 32 || nx === 10) cut = true;
    }
    if (!cut) continue;
    let e = i + 1;
    // 標點後面緊跟的空白歸前一句，換行歸前一句
    while (e < n && text.charCodeAt(e) === 32) e++;
    if (e < n && text.charCodeAt(e) === 10 && c !== 10) e++;
    out.push([start, e]);
    start = e;
    i = e - 1;
  }
  if (start < n) out.push([start, n]);
  return out;
}

/** 二分搜尋：位置 p 落在哪一句（start<=p<end），沒有回傳 -1。 */
export function sentenceIndexAt(spans: Span[], p: number): number {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = spans[mid]!;
    if (p < s) hi = mid - 1;
    else if (p >= e) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function lineSpans(text: string): Span[] {
  const out: Span[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) { out.push([s, i + 1]); s = i + 1; }
  if (s < text.length) out.push([s, text.length]);
  return out;
}
