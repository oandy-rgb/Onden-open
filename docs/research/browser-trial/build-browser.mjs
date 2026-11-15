// 試著把同一個後端打成「瀏覽器 worker」用的 ESM。第一版不做任何 Node 替身：看 esbuild 會在哪裡報錯（= 要替換的清單）。
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationsPlugin, exposeTxStorage, stripBoot } from "./esbuild-plugins.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const shims = process.argv.includes("--shims");
const r = await build({
  entryPoints: [resolve(here, "src/workerMain.ts")],
  outfile: resolve(here, "dist/browser/worker.js"),
  bundle: true, platform: "browser", format: "esm", target: shims ? "es2020" : "es2022", supported: shims ? { "async-await": false, "async-generator": false, "for-await": false } : {}, logLevel: "silent", write: true, minify: !process.argv.includes("--debug"), inject: [resolve(here, "shims/globals.mjs")], metafile: true,
  alias: { pg: resolve(here, "pgShim.mjs"), ...(shims ? await import("./nodeShims.mjs").then((m) => m.aliases(here)) : {}) },
  plugins: [migrationsPlugin(root), exposeTxStorage(root), stripBoot(root), ...(shims ? [(await import("./nodeShims.mjs")).unavailablePlugin(here)] : [])],
  nodePaths: [resolve(root, "node_modules"), resolve(here, "node_modules")],
}).catch((e) => e);
const errors = r.errors ?? [];
if (r.metafile && process.argv.includes("--write")) {
  const { writeFileSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { gzipSync, brotliSync } = await import("node:zlib").then((z) => ({ gzipSync: z.gzipSync, brotliSync: z.brotliCompressSync }));
  const out = r.outputFiles?.[0];
  mkdirSync(resolve(here, "dist/browser"), { recursive: true });
  const dist = resolve(here, "dist/browser");
  // PGlite 的資產（wasm、檔案系統包、擴充）放在 worker 旁邊；伺服器以檔名對應（build 時 pglite 內的 new URL(…, import.meta.url) 保持原樣）
  const pg = resolve(here, "node_modules/@electric-sql/pglite/dist");
  for (const f of ["pglite.wasm", "pglite.data", "initdb.wasm", "pg_trgm.tar.gz", "pgcrypto.tar.gz"]) copyFileSync(resolve(pg, f), resolve(dist, f));
  copyFileSync(resolve(here, "node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz"), resolve(dist, "vector.tar.gz"));
  const meta = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]];
  const bytes = meta.bytes;
  writeFileSync(resolve(dist, "meta.json"), JSON.stringify(r.metafile));
  console.log("worker.js raw KiB:", (bytes / 1024).toFixed(0));
}
const byMod = new Map();
for (const e of errors) { const m = /Could not resolve "([^"]+)"/.exec(e.text)?.[1] ?? e.text; (byMod.get(m) ?? byMod.set(m, new Set()).get(m)).add(e.location?.file?.replace(/.*packages\//, "") ?? "?"); }
console.log("errors:", errors.length);
for (const [m, files] of byMod) console.log(" ", m.padEnd(28), [...files].slice(0, 4).join(", "), files.size > 4 ? `…共 ${files.size} 個檔` : "");
