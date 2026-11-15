// 計時：中位數與 p95。Node 與瀏覽器共用。外層 mk() 準備新鮮狀態（不計時），內層才計時。
import type { Prep } from "./impls.js";

export interface Stats { n: number; medianMs: number; p95Ms: number; minMs: number; meanMs: number; note?: string }

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

export interface MeasureOpts { budgetMs?: number; minIters?: number; maxIters?: number; slowMs?: number; gc?: () => void }

export function measure(mk: Prep, o: MeasureOpts = {}): { stats: Stats; result: string } {
  const budget = o.budgetMs ?? 1500, maxIters = o.maxIters ?? 400, slow = o.slowMs ?? 1500;
  let minIters = o.minIters ?? 9;
  const once = (): { ms: number; res: string } => {
    o.gc?.();
    const run = mk();
    const t0 = performance.now();
    const res = run();
    return { ms: performance.now() - t0, res };
  };
  const first = once();
  let result = first.res;
  if (first.ms > slow * 4) {
    return { stats: { n: 1, medianMs: first.ms, p95Ms: first.ms, minMs: first.ms, meanMs: first.ms, note: "太慢，只量一次" }, result };
  }
  if (first.ms > slow) minIters = 3;
  else result = once().res; // 第二次暖機
  const samples: number[] = [];
  let total = 0;
  while (samples.length < maxIters && (samples.length < minIters || total < budget)) {
    const r = once();
    samples.push(r.ms);
    total += r.ms;
    result = r.res;
  }
  const s = samples.slice().sort((a, b) => a - b);
  return {
    stats: { n: s.length, medianMs: pct(s, 0.5) === undefined ? 0 : median(s), p95Ms: pct(s, 0.95), minMs: s[0]!, meanMs: total / s.length },
    result,
  };
}

function median(s: number[]): number {
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 固定工作量的校準：讓不同機器／瀏覽器降速設定下的數字可以互相對照。 */
export function calibrate(): number {
  const runs: number[] = [];
  for (let k = 0; k < 7; k++) {
    const t0 = performance.now();
    let x = 123456789, acc = 0;
    for (let i = 0; i < 30_000_000; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; acc = (acc + (x & 1023)) | 0; }
    runs.push(performance.now() - t0);
    if (acc === 0.5) console.log(acc);
  }
  runs.sort((a, b) => a - b);
  return runs[3]!;
}
