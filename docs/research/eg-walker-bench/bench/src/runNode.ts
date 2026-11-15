// Node 版測試台：npm run bench:node -- [--quick] [--only proto,dt] [--ops a,b,c,t] [--out out/node.json]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calibrate, measure, type Stats } from "./harness.js";
import { diff3Impl, makeDtImpl, protoImpl, refImpl, type Impl } from "./impls.js";
import { forkScenarios } from "./cases.js";
import { TRACE_LIST, dtBytes, loadTrace } from "./traces.js";
import { loadDt } from "./dtLoader.node.js";
import { opCount, buildOpLog } from "./proto/engine.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const quick = flag("quick");
const only = opt("only", "diff3,ref,dt,proto").split(",");
const ops = opt("ops", "a,b,c,t").split(",");
const heavy = flag("heavy");
const outFile = opt("out", join(dirname(fileURLToPath(import.meta.url)), "..", "out", "node.json"));
const gc = (globalThis as { gc?: () => void }).gc;

interface Row { case: string; op: string; impl: string; stats?: Stats; skipped?: string; agreeWith?: Record<string, boolean>; resultHash?: string; resultLen?: number }
const rows: Row[] = [];

const hash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

async function main() {
  const dt = await loadDt();
  const impls: Impl[] = [diff3Impl, refImpl, makeDtImpl(dt), protoImpl].filter((i) => only.includes(i.id));
  const env = { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, calibrationMs: calibrate(), date: new Date().toISOString() };
  console.log("環境", env);

  const record = (c: string, op: string, impl: Impl, mk: (() => () => string) | null, skipped?: string) => {
    if (!mk) { rows.push({ case: c, op, impl: impl.id, skipped }); console.log(`  ${c} ${op} ${impl.id}: 跳過（${skipped}）`); return undefined; }
    const { stats, result } = measure(mk, { gc });
    rows.push({ case: c, op, impl: impl.id, stats, resultHash: hash(result), resultLen: result.length });
    console.log(`  ${c} ${op} ${impl.id}: 中位數 ${stats.medianMs.toFixed(2)} ms  p95 ${stats.p95Ms.toFixed(2)} ms  n=${stats.n}${stats.note ? " " + stats.note : ""}`);
    return result;
  };

  for (const sc of forkScenarios(quick)) {
    console.log(`情境 ${sc.id}（base ${sc.base.length} 單位）`);
    for (const op of ["a", "b", "c"]) {
      if (!ops.includes(op)) continue;
      const results: Record<string, string | undefined> = {};
      for (const impl of impls) {
        const slowRef = impl.id === "ref" && sc.base.length > 20_000 && (op === "b" || op === "c") && sc.history.txns.length > 0;
        const mkp =
          op === "a" ? impl.mergeFork?.(sc) : op === "b" ? impl.replay?.(sc.history, { sc }) : impl.loadApply?.(sc);
        if (!mkp) { record(sc.id, op, impl, null, "不適用"); continue; }
        void slowRef;
        results[impl.id] = record(sc.id, op, impl, mkp);
      }
      // 結果一致性：三個 CRDT（ref／dt／proto）應該得到同一份文字
      const crdt = ["ref", "dt", "proto"].filter((k) => results[k] !== undefined);
      for (let i = 1; i < crdt.length; i++) {
        const same = results[crdt[0]!] === results[crdt[i]!];
        if (!same) console.log(`  !! ${sc.id} ${op}: ${crdt[0]} 與 ${crdt[i]} 的結果不同`);
        rows.push({ case: sc.id, op: `${op}-agree`, impl: `${crdt[0]}~${crdt[i]}`, agreeWith: { same } });
      }
    }
  }

  if (ops.includes("t")) {
    for (const meta of TRACE_LIST) {
      const tr = loadTrace(meta.id);
      const nOps = opCount(buildOpLog(tr.history));
      console.log(`trace ${meta.id}（${nOps} 個單位操作）`);
      const results: Record<string, string | undefined> = {};
      for (const impl of impls) {
        if (impl.id === "diff3") continue;
        if (impl.id === "ref" && nOps > 30_000 && !(heavy && meta.id === "git-makefile")) {
          record(meta.id, "b", impl, null, "參考實作對 >3 萬操作需時數分鐘到數小時（每步線性掃描），未跑");
          continue;
        }
        const mkp = impl.replay?.(tr.history, { dtBytes: impl.id === "dt" ? dtBytes(meta.dtFile) : undefined });
        results[impl.id] = record(meta.id, "b", impl, mkp ?? null, "不適用");
      }
      for (const [id, r] of Object.entries(results)) if (r !== undefined && tr.history.endContent !== undefined) {
        rows.push({ case: meta.id, op: "b-correct", impl: id, agreeWith: { endContent: r === tr.history.endContent } });
      }
    }
  }

  mkdirSync(dirname(outFile), { recursive: true });
  const prev = existsSync(outFile) && flag("merge") ? JSON.parse(readFileSync(outFile, "utf8")) : null;
  writeFileSync(outFile, JSON.stringify({ env, rows: [...(prev?.rows ?? []), ...rows] }, null, 1));
  console.log("寫入", outFile);
}
main().catch((e) => { console.error(e); process.exit(1); });
