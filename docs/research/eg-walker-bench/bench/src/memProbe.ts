// 記憶體探測（一個 case 一個全新程序）：
//   node --expose-gc --max-semi-space-size=2048 --import tsx src/memProbe.ts <impl> <fork:200KB-1000:a | trace:node_nodecc:b>
// 輸出一行 JSON：
//   allocBytes＝這個操作期間 JS 堆積增加量（semi-space 設很大，幾乎不發生 GC，所以約等於「配置總量」，是峰值的上界）
//   rssDeltaKB＝程序峰值常駐記憶體（含 WASM 線性記憶體）相對操作前的增量（只在操作把峰值推高時 >0）
import { SEED } from "./cases.js";
import { diff3Impl, makeDtImpl, protoImpl, refImpl, type Impl, type Prep } from "./impls.js";
import { loadDt } from "./dtLoader.node.js";
import { makeFork } from "./genFork.js";
import { dtBytes, loadTrace, TRACE_LIST } from "./traces.js";

const [implId, spec] = process.argv.slice(2) as [string, string];
const gc = (globalThis as { gc?: () => void }).gc!;

async function main() {
  const dt = await loadDt();
  const impl: Impl = { diff3: diff3Impl, ref: refImpl, proto: protoImpl, dt: makeDtImpl(dt) }[implId as "ref"]!;
  const [kind, id, op] = spec.split(":") as [string, string, string];
  let mk: Prep | undefined;
  if (kind === "fork") {
    const m = /^(\d+)KB-(\d+)$/.exec(id)!;
    const sc = makeFork(Number(m[1]) * 1024, Number(m[2]), SEED);
    mk = op === "a" ? impl.mergeFork?.(sc) : op === "b" ? impl.replay?.(sc.history, { sc }) : impl.loadApply?.(sc);
  } else {
    const meta = TRACE_LIST.find((t) => t.id === id)!;
    const tr = loadTrace(id);
    mk = impl.replay?.(tr.history, { dtBytes: implId === "dt" ? dtBytes(meta.dtFile) : undefined });
  }
  if (!mk) { console.log(JSON.stringify({ impl: implId, spec, skipped: true })); return; }
  const run = mk();
  gc(); gc();
  const heap0 = process.memoryUsage().heapUsed;
  const rss0 = process.resourceUsage().maxRSS;
  const t0 = performance.now();
  const out = run();
  const ms = performance.now() - t0;
  const heap1 = process.memoryUsage().heapUsed;
  const rss1 = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({ impl: implId, spec, allocBytes: heap1 - heap0, rssDeltaKB: rss1 - rss0, rssPeakKB: rss1, ms, outLen: out.length }));
}
main();
