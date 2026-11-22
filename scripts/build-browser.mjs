#!/usr/bin/env node
// npm run build:browser — the browser app as a static folder (packages/frontend/dist-browser).
// Design: docs/architecture/browser-app.md. Three parts, none of which touch the normal build (npm run build):
//   1. the packaged database  — migrations applied on Node once, saved as snapshot.tar.gz
//   2. the worker bundle      — the backend (packages/backend/src/browser/worker.ts) with Node's modules replaced
//   3. the page               — the frontend through vite.browser.config.ts, plus the files above
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "packages/backend");
const frontend = join(root, "packages/frontend");
const outDir = join(frontend, "dist-browser");
const nm = (name) => join(root, "node_modules", name);
// The @better-auth/core that the backend's better-auth itself loads: npm may keep better-auth (and so its core) under
// packages/backend/node_modules rather than at the root, and a root-relative path would then find nothing, or an older core.
const betterAuthCoreDir = (() => {
  const betterAuth = createRequire(join(backend, "package.json")).resolve("better-auth");
  return dirname(dirname(createRequire(betterAuth).resolve("@better-auth/core"))); // <core>/dist/index.mjs → <core>
})();
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
// Build parameters (docs/architecture/browser-app.md §13): --tag=<label> names the version in the help page's report;
// --report-url=<address> adds a "where to report" link there (absent: nothing is shown).
// --start-choice makes a first visit (a browser with no notes of ours) start on a choice: use it here, or use it temporarily
// on this computer (browser-app.md §17). Without it the page opens straight into the app, as the e2e scripts expect.
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// One id per build: the page compares it with build.json in the published folder to offer a reload when a newer build is out.
const buildId = process.env.ONDEN_BUILD_ID || Date.now().toString(36);
const step = (name, fn) => (only && only !== name ? undefined : fn());

/** Node's modules and the native packages, replaced or made to fail only when called (packages/backend/browser-shims). */
const shims = join(backend, "browser-shims");
const UNAVAILABLE_PACKAGES = /^(sharp|pg|simple-git|pagefind|web-push|rss-parser|@hono\/node-server|@octokit\/[^/]+|octokit-commit-multiple-files|@modelcontextprotocol\/sdk)(\/.*)?$/;
const UNAVAILABLE_BUILTINS = /^(node:)?(http|https|http2|net|tls|dns|os|zlib|child_process|module|string_decoder|timers|assert|constants|readline|worker_threads|perf_hooks)$/;
const ALIASES = {
  "node:async_hooks": join(shims, "asyncHooks.mjs"), async_hooks: join(shims, "asyncHooks.mjs"),
  "node:crypto": join(shims, "crypto.mjs"), crypto: join(shims, "crypto.mjs"),
  "node:util": join(shims, "util.mjs"), util: join(shims, "util.mjs"),
  "node:url": join(shims, "url.mjs"), url: join(shims, "url.mjs"),
  "node:stream": join(shims, "stream.cjs"), stream: join(shims, "stream.cjs"),
  archiver: join(shims, "archiver.mjs"),
  // An in-memory file system (the staged backup upload lives there) and the zip reader over it: restoring a backup.
  "node:fs": join(shims, "fs.mjs"), fs: join(shims, "fs.mjs"),
  "node:fs/promises": join(shims, "fsPromises.mjs"), "fs/promises": join(shims, "fsPromises.mjs"),
  "node:stream/promises": join(shims, "streamPromises.mjs"), "stream/promises": join(shims, "streamPromises.mjs"),
  yauzl: join(shims, "yauzl.mjs"),
  "node:path": nm("path-browserify/index.js"), path: nm("path-browserify/index.js"),
  "node:events": nm("events/events.js"), events: nm("events/events.js"),
  "node:buffer": nm("buffer/index.js"), buffer: nm("buffer/index.js"),
  // Packages whose "browser" condition reaches for the DOM, which a worker does not have.
  "decode-named-character-reference": nm("decode-named-character-reference/index.js"),
  "hast-util-from-html-isomorphic": nm("hast-util-from-html-isomorphic/lib/index.js"),
  // better-auth's browser build keeps one global where Node keeps one per request.
  "@better-auth/core/async_hooks": join(betterAuthCoreDir, "dist/async_hooks/index.mjs"),
};

/** esbuild's own alias matches by path prefix ("util" would also take "util/types"); these are whole specifiers. */
function exactAliasPlugin(table) {
  return {
    name: "exact-alias",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (Object.hasOwn(table, a.path) ? { path: table[a.path] } : undefined));
    },
  };
}

/** @onden/markdown's fullGrammars (every highlight.js grammar) becomes the common set: ~0.8 MB the browser app's worker need not carry. */
function commonGrammarsPlugin() {
  return {
    name: "common-grammars",
    setup(b) {
      b.onResolve({ filter: /(^|\/)fullGrammars(\.js|\.ts)?$/ }, (a) =>
        /packages\/markdown\/src\//.test(a.importer.replaceAll("\\", "/")) ? { path: join(shims, "fullGrammars.mjs") } : undefined);
    },
  };
}

function migrationsPlugin() {
  return {
    name: "migrations",
    setup(b) {
      b.onResolve({ filter: /^virtual:migrations$/ }, () => ({ path: "migrations", namespace: "onden-migrations" }));
      b.onLoad({ filter: /.*/, namespace: "onden-migrations" }, () => {
        const dir = join(backend, "db/migrations");
        const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => [f.replace(/\.sql$/, ""), readFileSync(join(dir, f), "utf8")]);
        return { contents: `export default ${JSON.stringify(files)};`, loader: "js" };
      });
    },
  };
}

/** Packages and Node modules a browser cannot run: importing them is fine, calling them says so. */
function unavailablePlugin() {
  const stub = join(shims, "unavailable.cjs");
  const named = (spec, importer) => {
    // An ES module importer needs the names it asks for to exist as exports.
    const src = readFileSync(importer, "utf8");
    const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const names = new Set();
    for (const m of src.matchAll(new RegExp(`import\\s+(?:type\\s+)?([^;]*?)\\s+from\\s+["']${esc}["']`, "g"))) {
      for (const part of (/\{([^}]*)\}/.exec(m[1])?.[1] ?? "").split(",")) {
        const n = part.trim();
        if (n && !n.startsWith("type ")) names.add(n.split(/\s+as\s+/)[0]);
      }
    }
    return names;
  };
  return {
    name: "unavailable",
    setup(b) {
      // A call returns a stub whose `await` fails with the message: some packages are called at import time
      // (Octokit.plugin(...)) and must not throw then, but using the result must never look like success.
      const make = `const make=(n,late)=>{const fail=()=>new Error(n+" is not available in the browser app");return new Proxy(function(){},{get:(_,k)=>k==="__esModule"?false:k==="then"?(late?(_r,rej)=>rej(fail()):undefined):k==="prototype"?{}:make(n+"."+String(k),late),apply:()=>make(n+"()",true),construct:()=>{throw fail()}})};`;
      for (const filter of [UNAVAILABLE_PACKAGES, UNAVAILABLE_BUILTINS]) {
        b.onResolve({ filter }, (a) => (a.importer ? { path: `${a.path}\u0000${a.importer}`, namespace: "onden-unavailable" } : undefined));
      }
      b.onLoad({ filter: /.*/, namespace: "onden-unavailable" }, (args) => {
        const [spec, importer] = args.path.split("\u0000");
        if (/\.(ts|mjs|tsx)$/.test(importer) && !importer.includes("node_modules")) {
          const names = [...named(spec, importer)];
          return { contents: `${make}export default make(${JSON.stringify(spec)});${names.map((n) => `export const ${n}=make(${JSON.stringify(`${spec}.${n}`)});`).join("")}`, loader: "js" };
        }
        return { contents: readFileSync(stub, "utf8"), loader: "js" };
      });
    },
  };
}

async function bundleWorker() {
  const result = await build({
    entryPoints: [join(backend, "src/browser/worker.ts")],
    outfile: join(outDir, "worker.js"),
    bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, metafile: true, logLevel: "warning",
    tsconfig: join(backend, "tsconfig.json"),
    inject: [join(shims, "globals.mjs")],
    plugins: [exactAliasPlugin(ALIASES), commonGrammarsPlugin(), migrationsPlugin(), unavailablePlugin()],
    nodePaths: [join(root, "node_modules")],
    conditions: ["import", "module", "browser"],
    mainFields: ["browser", "module", "main"],
  });
  // PGlite's contrib extensions name their files "../pgcrypto.tar.gz" (they sit one folder up from its dist/contrib/).
  // Bundled into worker.js the "../" climbs out of a sub-path (GitHub Pages /onden/…) and misses; the files are copied
  // next to worker.js below, so the address is "./…". Exactly two are expected: a changed count fails the build, not the page.
  const workerPath = join(outDir, "worker.js");
  const bundled = readFileSync(workerPath, "utf8");
  const fixed = bundled.replace(/new URL\("\.\.\/(pgcrypto|pg_trgm)\.tar\.gz",import\.meta\.url\)/g, 'new URL("./$1.tar.gz",import.meta.url)');
  const climbing = (fixed.match(/new URL\("\.\.\//g) ?? []).length;
  const changed = bundled.length - fixed.length;
  if (changed !== 2 * "../".length - 2 * "./".length || climbing !== 2) {
    throw new Error(`worker.js: expected to repoint 2 PGlite extension files and keep two others ("../db/migrations/" and one more), found ${changed} characters changed and ${climbing} remaining "../" addresses`);
  }
  writeFileSync(workerPath, fixed);
  writeFileSync(join(outDir, "worker.meta.json"), JSON.stringify(result.metafile));
  // PGlite's engine, filesystem image and extensions are fetched by URL next to the worker.
  const pg = nm("@electric-sql/pglite/dist");
  for (const f of ["pglite.wasm", "pglite.data", "pg_trgm.tar.gz", "pgcrypto.tar.gz"]) copyFileSync(join(pg, f), join(outDir, f));
  copyFileSync(nm("@electric-sql/pglite-pgvector/dist/vector.tar.gz"), join(outDir, "vector.tar.gz"));
  // initdb only runs for an empty data directory; the packaged snapshot means it never does.
  if (process.argv.includes("--with-initdb")) copyFileSync(join(pg, "initdb.wasm"), join(outDir, "initdb.wasm"));
}

function packageSnapshot() {
  // prepareSnapshot runs the backend under Node, which resolves @onden/* to each package's dist: build them first.
  // Without this a build after a change to one of them used the previous dist (a deploy on 2026-11-15 failed here
  // on a missing export, then passed once another step had rebuilt it). Same list as the server image and the desktop app.
  for (const pkg of JSON.parse(readFileSync(join(backend, "docker/runtime-packages.json"), "utf8")).packages) {
    execFileSync("npm", ["run", "build", "-w", `packages/${pkg}`], { cwd: root, stdio: "inherit" });
  }
  execFileSync("npx", ["tsx", "src/browser/prepareSnapshot.ts", join(outDir, "snapshot.tar.gz")], { cwd: backend, stdio: "inherit" });
}

function buildPage() {
  execFileSync("npx", ["vite", "build", "--config", "vite.browser.config.ts"], { cwd: frontend, stdio: "inherit", env: {
    ...process.env, ONDEN_BROWSER_OUT: outDir, ONDEN_BUILD_ID: buildId,
    ...(flag("tag") ? { VITE_TRIAL_TAG: flag("tag") } : {}),
    ...(flag("report-url") ? { VITE_TRIAL_REPORT_URL: flag("report-url") } : {}),
    ...(process.argv.includes("--start-choice") ? { VITE_BROWSER_START_CHOICE: "true" } : {}),
  } });
  // The page is browser.html in the source tree (index.html there is the Capacitor app's); a static host wants index.html.
  renameSync(join(outDir, "browser.html"), join(outDir, "index.html"));
  writeFileSync(join(outDir, "build.json"), JSON.stringify({ build: buildId }));
  // The short address of the temporary session: <folder>/temp/ . Relative, so it works from any sub-path.
  mkdirSync(join(outDir, "temp"), { recursive: true });
  writeFileSync(join(outDir, "temp", "index.html"), `<!doctype html><meta charset="utf-8"><title>Onden</title><meta http-equiv="refresh" content="0; url=../?temp=1"><script>location.replace("../?temp=1")</script>\n`);
}

function sizes() {
  const rows = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!name.endsWith(".meta.json")) {
        const raw = readFileSync(p);
        rows.push({ file: p.slice(outDir.length + 1), raw: raw.length, gzip: /\.(gz|png|woff2?)$/.test(name) ? raw.length : gzipSync(raw, { level: 9 }).length });
      }
    }
  };
  walk(outDir);
  const total = rows.reduce((a, r) => ({ raw: a.raw + r.raw, gzip: a.gzip + r.gzip }), { raw: 0, gzip: 0 });
  const kib = (n) => (n / 1024).toFixed(0).padStart(7);
  const big = rows.sort((a, b) => b.gzip - a.gzip).slice(0, 14);
  console.log("\n  file".padEnd(48) + "raw KiB   gzip KiB");
  for (const r of big) console.log(`  ${r.file}`.padEnd(46) + kib(r.raw) + kib(r.gzip));
  console.log(`  total (${rows.length} files)`.padEnd(46) + kib(total.raw) + kib(total.gzip) + `   = ${(total.gzip / 1048576).toFixed(2)} MiB gzip`);
  writeFileSync(join(outDir, "..", "dist-browser-sizes.json"), JSON.stringify({ files: rows, total }, null, 1));
}

if (!only) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// The page first: vite empties its outDir, the worker files go in after.
step("page", buildPage);
step("snapshot", packageSnapshot);
await step("worker", bundleWorker);
if (!only || only === "sizes") sizes();
