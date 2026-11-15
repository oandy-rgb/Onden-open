// 大小：序列化後的歷史、打包後 gzip。npm run bench:size
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forkScenarios } from "./cases.js";
import { diff3Impl, makeDtImpl, protoImpl, refImpl } from "./impls.js";
import { loadDt } from "./dtLoader.node.js";
import { TRACE_LIST, dtBytes, loadTrace } from "./traces.js";
import { opCount, buildOpLog } from "./proto/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "out", "size.json");
const gz = (b: Uint8Array | string) => gzipSync(b, { level: 9 }).length;
const br = (b: Uint8Array | string) => brotliCompressSync(b).length;
const enc = new TextEncoder();

async function bundleSize(name: string, entry: string, extra: Record<string, unknown> = {}) {
  const r = await build({
    entryPoints: [entry], bundle: true, minify: true, format: "esm", target: "es2020", write: false, platform: "browser",
    logLevel: "silent", legalComments: "none", ...extra,
  });
  const code = r.outputFiles[0]!.contents;
  return { name, raw: code.length, gzip: gz(code), brotli: br(code) };
}

async function main() {
  const dt = await loadDt();
  const dtImpl = makeDtImpl(dt);
  const res: Record<string, unknown> = {};

  // ---- 序列化後的歷史（base＋A＋B 全部）----
  const hist: Array<Record<string, unknown>> = [];
  for (const sc of forkScenarios(false)) {
    const finalBytes = enc.encode(sc.base).length;
    const row: Record<string, unknown> = { case: sc.id, baseUtf8: finalBytes, textA: enc.encode(sc.textA).length };
    const p = protoImpl.serialize!(sc.history);
    row.proto = { raw: p.length, gzip: gz(p) };
    const d = dtImpl.serialize!(sc.history, { sc });
    row.dt = { raw: d.length, gzip: gz(d) };
    if (sc.base.length < 70_000) {
      const r = refImpl.serialize!(sc.history);
      row.ref = { raw: r.length, gzip: gz(r) };
    }
    hist.push(row);
    console.log(sc.id, JSON.stringify(row));
  }
  res.forkHistory = hist;

  const traces: Array<Record<string, unknown>> = [];
  for (const m of TRACE_LIST) {
    const tr = loadTrace(m.id);
    const n = opCount(buildOpLog(tr.history));
    const row: Record<string, unknown> = { trace: m.id, ops: n, endUtf8: enc.encode(tr.history.endContent ?? "").length };
    const p = protoImpl.serialize!(tr.history);
    row.proto = { raw: p.length, gzip: gz(p) };
    const d = dtBytes(m.dtFile);
    row.dt = { raw: d.length, gzip: gz(d) };
    if (n <= 400_000) { const r = refImpl.serialize!(tr.history); row.ref = { raw: r.length, gzip: gz(r) }; }
    traces.push(row);
    console.log(m.id, JSON.stringify(row));
  }
  res.traces = traces;

  // ---- 打包後大小（minify，esm，目標 es2020）----
  const bundles = [];
  const entry = (code: string) => ({ stdin: { contents: code, resolveDir: here, loader: "ts" as const }, entryPoints: undefined });
  const mk = async (name: string, code: string) => {
    const r = await build({ ...entry(code), bundle: true, minify: true, format: "esm", target: "es2020", write: false, platform: "browser", logLevel: "silent", legalComments: "none" });
    const c = r.outputFiles[0]!.contents;
    return { name, raw: c.length, gzip: gz(c), brotli: br(c) };
  };
  bundles.push(await mk("proto：合併引擎（mergeIntoBranch＋replay，含沿用的因果圖）", `export * from "./proto/engine.ts";`));
  bundles.push(await mk("proto：引擎＋序列化格式", `export * from "./proto/engine.ts"; export * from "./proto/serialize.ts";`));
  bundles.push(await mk("eg-walker-reference（原樣）", `export * from "./vendor/eg-walker-reference/index.ts";`));
  bundles.push(await mk("現行 diff3（bodyMerge＋bodyPatch）", `export { threeWayMergeBody } from "../../../../../packages/backend/src/services/eventLog/bodyMerge.ts";`));
  const wasm = readFileSync(join(here, "..", "node_modules", "diamond-types-web", "dt_bg.wasm"));
  const glue = await build({ entryPoints: [join(here, "..", "node_modules", "diamond-types-web", "dt.js")], bundle: true, minify: true, format: "esm", write: false, logLevel: "silent" });
  const g = glue.outputFiles[0]!.contents;
  bundles.push({ name: "diamond-types：WASM（dt_bg.wasm）", raw: wasm.length, gzip: gz(wasm), brotli: br(wasm) });
  bundles.push({ name: "diamond-types：JS 綁定（dt.js）", raw: g.length, gzip: gz(g), brotli: br(g) });
  res.bundles = bundles;
  for (const b of bundles) console.log(b.name, b.raw, "gzip", b.gzip, "brotli", b.brotli);
  void diff3Impl; void bundleSize;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(res, null, 1));
  console.log("寫入", outFile);
}
main().catch((e) => { console.error(e); process.exit(1); });
