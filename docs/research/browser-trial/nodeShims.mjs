import { resolve } from "node:path";
export function aliases(here) {
  const s = (f) => resolve(here, "shims", f);
  const nm = (p) => resolve(here, "node_modules", p);
  const out = {
    "node:async_hooks": s("asyncHooks.mjs"), async_hooks: s("asyncHooks.mjs"),
    "node:crypto": s("crypto.mjs"), crypto: s("crypto.mjs"),
    "node:util": s("util.mjs"), util: s("util.mjs"),
    "node:url": s("url.mjs"), url: s("url.mjs"),
    "node:path": nm("path-browserify"), path: nm("path-browserify"),
    "node:events": nm("events"), events: nm("events"),
    "node:buffer": nm("buffer"), buffer: nm("buffer"),
    "node:stream": s("stream.cjs"), stream: s("stream.cjs"),
    "node:fs": s("fs.mjs"), fs: s("fs.mjs"), "node:fs/promises": s("fs.mjs"), "fs/promises": s("fs.mjs"),
  };
  // 試用版不提供（或瀏覽器跑不起來）的套件：圖片處理、打包 zip、git、全文索引、推播、RSS 抓取、MCP 伺服器、GitHub 備份、Node 伺服器
  // 有些套件的 "browser" 條件走 DOM（Worker 裡沒有 document）：remark 系的 decode-named-character-reference 就是。改指向不用 DOM 的版本。
  out["decode-named-character-reference"] = resolve(here, "../../../node_modules/decode-named-character-reference/index.js");
  out["hast-util-from-html-isomorphic"] = resolve(here, "../../../node_modules/hast-util-from-html-isomorphic/lib/index.js"); // browser 版用 DOMParser
  // better-auth 的 "browser" 條件用「單一全域變數」的 AsyncLocalStorage 替代品（同時兩個請求會互相覆蓋）。改指向會去 import node:async_hooks 的版本（= 我們的 zone.js 版）。
  out["@better-auth/core/async_hooks"] = resolve(here, "../../../node_modules/@better-auth/core/dist/async_hooks/index.mjs");
  return out;
}
/** 試用版不提供（或瀏覽器跑不起來）的套件：圖片處理、打包 zip、git、全文索引、推播、RSS 抓取、MCP 伺服器、GitHub 備份、Node 伺服器。含子路徑。 */
export const UNAVAILABLE = /^(sharp|archiver|simple-git|pagefind|web-push|rss-parser|yauzl|@hono\/node-server|@octokit\/[^/]+|octokit-commit-multiple-files|@modelcontextprotocol\/sdk)(\/.*)?$/;
export const UNAVAILABLE_BUILTINS = /^(node:)?(http|https|http2|net|tls|dns|os|zlib|child_process|module|string_decoder|timers|assert|constants|stream\/promises|readline|worker_threads|perf_hooks)$/;
/** 把「試用版不提供」的模組換成替身：載入不報錯、被呼叫才拋「試用版沒有這個」。
 *  ESM 匯入者（後端程式）要有具名匯出，所以讀匯入者原始碼取出名字，產生對應的 ESM；CJS 匯入者（node_modules）用 Proxy。 */
export function unavailablePlugin(here) {
  const make = `const make=(n)=>new Proxy(function(){},{get:(_,k)=>k==="__esModule"?false:k==="then"?undefined:k==="prototype"?{}:make(n+"."+String(k)),apply:()=>make(n+"()"),construct:()=>make("new "+n)});`;
  return {
    name: "unavailable",
    setup(b) {
      b.onResolve({ filter: UNAVAILABLE }, (a) => ({ path: `${a.path}\u0000${a.importer}`, namespace: "stub" }));
      b.onResolve({ filter: UNAVAILABLE_BUILTINS }, (a) => ({ path: `${a.path}\u0000${a.importer}`, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, async (args) => {
        const [spec, importer] = args.path.split("\u0000");
        const { readFileSync } = await import("node:fs");
        if (/\.(ts|mjs|tsx)$/.test(importer) && !importer.includes("node_modules")) {
          const src = readFileSync(importer, "utf8");
          const esc = spec.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
          const names = new Set();
          for (const m of src.matchAll(new RegExp(`import\\s+(?:type\\s+)?([^;]*?)\\s+from\\s+["']${esc}["']`, "g"))) {
            for (const part of (/\{([^}]*)\}/.exec(m[1])?.[1] ?? "").split(",")) { const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (n && !/^type\s/.test(part.trim())) names.add(n); }
          }
          return { contents: `${make}export default make(${JSON.stringify(spec)});${[...names].map((n) => `export const ${n}=make(${JSON.stringify(spec + "." + n)});`).join("")}`, loader: "js" };
        }
        return { contents: `${make}module.exports=make(${JSON.stringify(spec)});`, loader: "js" };
      });
    },
  };
}
