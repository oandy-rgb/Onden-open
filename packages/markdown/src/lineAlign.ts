// Which line of one version of a text is which line of the next: the shared
// rule behind the steps block's code transition (the app's player and the
// published site's both ask here, so a line slides the same way on both).
//
// Lines are compared by their trimmed text, so wrapping a body in a loop (new
// indentation) still reads as the same line moving. A longest common
// subsequence keeps the order; lines it cannot keep in order are then paired
// by equal text, so a line MOVED to another place slides there instead of
// fading out and in.

export type LineAlignment = {
  /** For each line of the new text, the index of the same line in the old text, or null (new). */
  from: Array<number | null>;
  /** Indexes of old lines that are gone. */
  removed: number[];
};

/** Beyond this many cells the order-keeping pass is skipped (equal text is still paired). */
const LCS_CELLS_MAX = 250_000;

export function alignLines(before: readonly string[], after: readonly string[]): LineAlignment {
  const a = before.map((l) => l.trim());
  const b = after.map((l) => l.trim());
  const from: Array<number | null> = b.map(() => null);
  const taken = new Array<boolean>(a.length).fill(false);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) { from[head] = head; taken[head] = true; head++; }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    from[b.length - 1 - tail] = a.length - 1 - tail; taken[a.length - 1 - tail] = true; tail++;
  }

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n > 0 && m > 0 && n * m <= LCS_CELLS_MAX) {
    // lcs[i][j]: longest common subsequence of a[head+i..] and b[head+j..]
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[head + i] === b[head + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) { from[head + j] = head + i; taken[head + i] = true; i++; j++; }
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
      else j++;
    }
  }

  // Moved lines: the same text, left unpaired on both sides, in order.
  const free = new Map<string, number[]>();
  a.forEach((text, i) => { if (!taken[i] && text !== "") (free.get(text) ?? free.set(text, []).get(text)!).push(i); });
  b.forEach((text, j) => {
    if (from[j] !== null || text === "") return;
    const i = free.get(text)?.shift();
    if (i !== undefined) { from[j] = i; taken[i] = true; }
  });

  return { from, removed: a.flatMap((_, i) => (taken[i] ? [] : [i])) };
}
