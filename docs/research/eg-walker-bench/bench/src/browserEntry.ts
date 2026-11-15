// 瀏覽器端：esbuild 打成 bundle.js，由 runBrowser.ts 載入並以 page.evaluate 呼叫 window.__bench。
import { calibrate, measure, type Stats } from "./harness.js";
import { diff3Impl, makeDtImpl, protoImpl, refImpl, type Impl, type ImplId } from "./impls.js";
import { makeFork } from "./genFork.js";
import { SEED } from "./cases.js";
import { loadDt } from "./dtLoader.web.js";
import type { History } from "./types.js";

export interface Spec { kind: "fork" | "trace"; id: string; op: "a" | "b" | "c"; impl: ImplId; dtFile?: string }
export interface RunResult { stats?: Stats; skipped?: string; hash?: string; len?: number; baseHash?: string }

const hash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
const traceCache = new Map<string, History>();

async function run(spec: Spec): Promise<RunResult> {
  const dt = await loadDt();
  const impl: Impl = { diff3: diff3Impl, ref: refImpl, proto: protoImpl, dt: makeDtImpl(dt as never) }[spec.impl];
  let mk;
  let baseHash: string | undefined;
  if (spec.kind === "fork") {
    const m = /^(\d+)KB-(\d+)$/.exec(spec.id)!;
    const sc = makeFork(Number(m[1]) * 1024, Number(m[2]), SEED);
    baseHash = hash(sc.base + "\u0000" + sc.textA + "\u0000" + sc.textB);
    mk = spec.op === "a" ? impl.mergeFork?.(sc) : spec.op === "b" ? impl.replay?.(sc.history, { sc }) : impl.loadApply?.(sc);
  } else {
    let h = traceCache.get(spec.id);
    if (!h) { h = (await (await fetch(`/traces/${spec.id}.json`)).json()) as History; traceCache.set(spec.id, h); }
    const dtb = spec.impl === "dt" ? new Uint8Array(await (await fetch(`/dt/${spec.dtFile}`)).arrayBuffer()) : undefined;
    mk = impl.replay?.(h, { dtBytes: dtb });
  }
  if (!mk) return { skipped: "不適用" };
  const gc = (globalThis as { gc?: () => void }).gc;
  const { stats, result } = measure(mk, { gc });
  return { stats, hash: hash(result), len: result.length, baseHash };
}

/** 冷啟動：頁面剛載入、JIT 還沒暖過時，操作第一次執行要多久（真實使用就是這樣：合併一年也沒幾次）。 */
async function runCold(spec: Spec): Promise<{ firstMs: number; secondMs: number; thirdMs: number }> {
  const dt = await loadDt();
  const impl: Impl = { diff3: diff3Impl, ref: refImpl, proto: protoImpl, dt: makeDtImpl(dt as never) }[spec.impl];
  const m = /^(\d+)KB-(\d+)$/.exec(spec.id)!;
  const sc = makeFork(Number(m[1]) * 1024, Number(m[2]), SEED);
  const mk = spec.op === "a" ? impl.mergeFork!(sc) : impl.loadApply!(sc);
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) {
    const go = mk();
    const t0 = performance.now();
    go();
    ms.push(performance.now() - t0);
  }
  return { firstMs: ms[0]!, secondMs: ms[1]!, thirdMs: ms[2]! };
}

(window as unknown as { __bench: unknown }).__bench = { run, runCold, calibrate: () => calibrate(), ua: navigator.userAgent };
