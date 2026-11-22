#!/usr/bin/env node
// 把桌面版要帶的東西整理到 packages/desktop/stage/（electron-builder 與 `electron .` 都從這裡取）：
//   stage/web/      前端建置（packages/frontend/dist/client）
//   stage/server/   後端的正式執行環境：packages/backend/{dist,db}、markdown／contract／site 的 dist，
//                   與 `npm ci --omit=dev` 裝出來的 node_modules（跟 backend/docker/Dockerfile 同一個作法）
// 用法：node scripts/stage.mjs [--no-build]   已經建好前後端就加 --no-build（`npm run dev` 就是）
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const root = resolve(desktop, "../..");
const stage = join(desktop, "stage");
const noBuild = process.argv.includes("--no-build") || process.argv.includes("--dev");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
// 後端執行時會 import 的 @onden/* 套件：跟伺服器映像共用一份清單（少列一個，打包後的後端就起不來——@onden/contract 漏過一次）。
const RUNTIME_PACKAGES = JSON.parse(readFileSync(join(root, "packages/backend/docker/runtime-packages.json"), "utf8")).packages;

// 建置編號：前端（網頁比對「有新版」）與內建後端（回應標頭）要是同一個。自己建就在這裡決定並傳給前端；
// --no-build 沿用已建好的前端，編號只能由 ONDEN_BUILD_ID 告知（沒給就留空：後端不送標頭，不會誤報有新版）。
const gitSha = () => { try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root }).toString().trim(); } catch { return ""; } };
const buildId = process.env.ONDEN_BUILD_ID || (noBuild ? "" : gitSha() || Date.now().toString(36));

if (!noBuild) {
  for (const pkg of [...RUNTIME_PACKAGES, "backend", "frontend"]) {
    execFileSync("npm", ["run", "build", "-w", `packages/${pkg}`], { cwd: root, stdio: "inherit", env: { ...process.env, ONDEN_BUILD_ID: buildId } });
  }
}

const need = [
  "packages/backend/dist/server.js", "packages/frontend/dist/client/index.html",
  ...RUNTIME_PACKAGES.map((pkg) => `packages/${pkg}/dist/index.js`),
];
for (const file of need) {
  if (!existsSync(join(root, file))) throw new Error(`${file} 還沒建好；先跑 npm run desktop:build（或不加 --no-build）`);
}

// ── web ──────────────────────────────────────────────────────────────────────
rmSync(join(stage, "web"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "packages/frontend/dist/client"), join(stage, "web"), { recursive: true });

// ── ai-answerer（桌面版回答程式；純 Node，不需要建置也沒有依賴）──────────────────────────────────
rmSync(join(stage, "ai-answerer"), { recursive: true, force: true });
cpSync(join(root, "packages/ai-answerer/src"), join(stage, "ai-answerer/src"), { recursive: true, filter: (file) => !/\.test\.[cm]?[jt]s$/.test(file) });
cpSync(join(root, "packages/ai-answerer/package.json"), join(stage, "ai-answerer/package.json"));

// ── server ───────────────────────────────────────────────────────────────────
const server = join(stage, "server");
const lockHash = createHash("sha256")
  .update(readFileSync(join(root, "package-lock.json")))
  .update(readFileSync(join(root, "packages/backend/package.json")))
  .digest("hex");
const stamp = join(server, ".deps-stamp");
const depsFresh = existsSync(stamp) && readFileSync(stamp, "utf8") === lockHash;

if (!depsFresh) {
  rmSync(server, { recursive: true, force: true });
  mkdirSync(join(server, "patches"), { recursive: true });
  cpSync(join(root, "package-lock.json"), join(server, "package-lock.json"));
  // 根 package.json 的 workspaces 含 "!packages/desktop"：不要讓桌面套件進這份安裝。
  cpSync(join(root, "package.json"), join(server, "package.json"));
  for (const patch of readdirSync(join(root, "patches")).filter((f) => f.startsWith("micromark+"))) {
    cpSync(join(root, "patches", patch), join(server, "patches", patch));
  }
  for (const pkg of ["backend", "frontend", ...RUNTIME_PACKAGES]) {
    mkdirSync(join(server, "packages", pkg), { recursive: true });
    cpSync(join(root, "packages", pkg, "package.json"), join(server, "packages", pkg, "package.json"));
  }
  run("npm", ["ci", "--workspace=packages/backend", "--omit=dev", "--no-audit", "--no-fund"], server);
  // 工作區的符號連結換成實體資料夾：打包後不依賴連結。
  for (const name of readdirSync(join(server, "node_modules/@onden"))) {
    const link = join(server, "node_modules/@onden", name);
    if (lstatSync(link).isSymbolicLink()) {
      rmSync(link);
      mkdirSync(link);
      cpSync(join(server, "packages", name, "package.json"), join(link, "package.json"));
    }
  }
  writeFileSync(stamp, lockHash);
}

// PGlite 在後端的 package.json 是 devDependency（伺服器版用真 Postgres），所以 `--omit=dev` 不會裝；
// 桌面版靠它跑，從根目錄已用 lockfile 裝好的那份原樣帶進來（版本與 lockfile 一致，不需要網路）。
for (const name of ["pglite", "pglite-pgvector"]) {
  const from = join(root, "node_modules/@electric-sql", name);
  if (!existsSync(from)) throw new Error(`${from} 不存在；先在根目錄跑 npm ci`);
  mkdirSync(join(server, "node_modules/@electric-sql"), { recursive: true });
  rmSync(join(server, "node_modules/@electric-sql", name), { recursive: true, force: true });
  cpSync(from, join(server, "node_modules/@electric-sql", name), { recursive: true });
}

for (const pkg of ["backend", ...RUNTIME_PACKAGES]) {
  rmSync(join(server, "packages", pkg, "dist"), { recursive: true, force: true });
  cpSync(join(root, "packages", pkg, "dist"), join(server, "packages", pkg, "dist"), { recursive: true });
}
rmSync(join(server, "packages/backend/db"), { recursive: true, force: true });
cpSync(join(root, "packages/backend/db"), join(server, "packages/backend/db"), { recursive: true });
// @onden/markdown、@onden/contract 與 @onden/site 是被 node_modules/@onden/* 解析的：把 dist 也放進去。
for (const name of RUNTIME_PACKAGES) {
  const target = join(server, "node_modules/@onden", name);
  rmSync(join(target, "dist"), { recursive: true, force: true });
  cpSync(join(root, "packages", name, "dist"), join(target, "dist"), { recursive: true });
}
// ── 瘦身：只留「正式執行的程式碼」順著 dependencies 走得到的套件 ───────────────────────────────
// `npm ci --workspace` 會連同站台編輯器、測試與建置工具（vitest、tsx、esbuild、happy-dom…）一起裝，
// 打包進去只是白佔幾百 MB。做法：從 dist 裡所有 bare import 出發，沿 dependencies／optionalDependencies／
// peerDependencies 走過每個套件，沒走到的刪掉。每次 stage 都重做（dist 會變），所以放在檢查之前。
function bareImports(dir) {
  const found = new Set();
  const visit = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".js")) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/(?:from\s*|import\s*\(?\s*|require\(\s*)["']([^"'./][^"']*)["']/g)) {
          const spec = m[1];
          if (spec.startsWith("node:")) continue;
          const parts = spec.split("/");
          found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
        }
      }
    }
  };
  visit(dir);
  return found;
}
function pruneServerModules() {
  const nm = join(server, "node_modules");
  const reachable = new Set();
  const locate = (name, fromDir) => {
    for (let dir = fromDir; dir.startsWith(server); dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    return null;
  };
  const queue = [];
  const enqueue = (name, fromDir) => {
    const dir = locate(name, fromDir);
    if (dir && !reachable.has(dir)) { reachable.add(dir); queue.push(dir); }
  };
  const builtins = new Set((createRequire(import.meta.url)("node:module")).builtinModules);
  for (const pkg of ["backend", ...RUNTIME_PACKAGES]) {
    for (const name of bareImports(join(server, "packages", pkg, "dist"))) {
      if (!builtins.has(name)) enqueue(name, join(server, "packages", pkg, "dist"));
    }
  }
  for (const name of ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"]) enqueue(name, server);
  while (queue.length) {
    const dir = /** @type {string} */ (queue.pop());
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    // 選用的 peerDependencies 不跟（better-auth 把 vitest、vite、next… 都列成選用 peer，跟了等於全裝）。
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (field === "peerDependencies" && manifest.peerDependenciesMeta?.[name]?.optional) continue;
        enqueue(name, dir);
      }
    }
  }
  let removed = 0;
  const prune = (modulesDir) => {
    for (const entry of readdirSync(modulesDir)) {
      const dir = join(modulesDir, entry);
      if (entry === ".bin" || entry === ".package-lock.json") { rmSync(dir, { recursive: true, force: true }); continue; }
      const children = entry.startsWith("@") ? readdirSync(dir).map((n) => join(dir, n)) : [dir];
      for (const child of children) {
        if (!statSync(child).isDirectory()) continue;
        if (!reachable.has(child)) { rmSync(child, { recursive: true, force: true }); removed++; }
        else if (existsSync(join(child, "node_modules"))) prune(join(child, "node_modules"));
      }
      if (entry.startsWith("@") && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    }
  };
  prune(nm);
  console.log(`pruned ${removed} unreachable packages; kept ${reachable.size}`);
}
pruneServerModules();

// 後端在 stage 裡必須只靠 stage 自己的 node_modules：Node 會一路往上層資料夾找套件，
// 在 repo 裡開發時會悄悄用到根目錄的 node_modules，打包後才缺東西。逐一檢查解析到哪裡。
const resolveFromBackend = createRequire(join(server, "packages/backend/dist/server.js"));
for (const name of ["@electric-sql/pglite", "@electric-sql/pglite/contrib/pg_trgm", "@electric-sql/pglite-pgvector", "sharp", "better-auth", "hono", "kysely", ...RUNTIME_PACKAGES.map((pkg) => `@onden/${pkg}`), "simple-git"]) {
  let where;
  try { where = resolveFromBackend.resolve(name); } catch (error) { throw new Error(`stage 裡解析不到 ${name}：${error.message.split("\n")[0]}`); }
  if (!where.startsWith(server)) throw new Error(`${name} 解析到 stage 之外：${where}`);
}
// ── 後端用的 Node：官方版，不是 Electron 內建的 ─────────────────────────────────────────────────
// Electron 在 Linux 的執行檔會把系統的 glib 符號帶進程序，sharp（libvips）讀圖片時因此當掉
// （SIGSEGV；sharp 啟動時的 SharpElectronLinux 警告，electron#46323）。後端改用跟伺服器版同一條
// Node 22 跑，放在 server/runtime/node（backendProcess.mjs 找到它就用）。版本與雜湊固定在這裡。
const NODE_VERSION = "22.23.1";
const NODE_SHA256 = { "linux-x64": "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578" };
const nodeTarget = `${process.platform}-${process.arch}`;
if (!NODE_SHA256[nodeTarget]) throw new Error(`沒有 ${nodeTarget} 的 Node 執行檔設定；先在 stage.mjs 的 NODE_SHA256 加上它`);
const nodeName = `node-v${NODE_VERSION}-${nodeTarget}`;
const nodeCache = join(desktop, ".cache");
const tarball = join(nodeCache, `${nodeName}.tar.xz`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (!existsSync(tarball) || sha256(tarball) !== NODE_SHA256[nodeTarget]) {
  mkdirSync(nodeCache, { recursive: true });
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.tar.xz`);
  if (!res.ok) throw new Error(`下載 Node ${NODE_VERSION} 失敗：HTTP ${res.status}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  if (sha256(tarball) !== NODE_SHA256[nodeTarget]) throw new Error(`Node ${NODE_VERSION} 的雜湊不符，不使用`);
}
const runtime = join(server, "runtime");
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
execFileSync("tar", ["-xJf", tarball, "-C", runtime, "--strip-components=1", `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
cpSync(join(runtime, "bin/node"), join(runtime, "node"));
rmSync(join(runtime, "bin"), { recursive: true, force: true });
const runtimeVersion = execFileSync(join(runtime, "node"), ["--version"]).toString().trim();
if (runtimeVersion !== `v${NODE_VERSION}`) throw new Error(`server/runtime/node 是 ${runtimeVersion}，不是 v${NODE_VERSION}`);

// 桌面版自己的建置資訊（main.mjs 讀它：關於視窗、換版判斷、後端的建置標頭）。
// schema＝這個建置帶的最新一個資料庫升級檔：換版時不開資料庫就能判斷「資料比程式新」（降版）。
const schema = readdirSync(join(root, "packages/backend/db/migrations")).filter((f) => f.endsWith(".sql")).sort().at(-1) ?? "";
writeFileSync(join(server, "build.json"), JSON.stringify({ buildId, schema }, null, 2));
// 還原後換節點編號的 SQL（serverEntry.mjs 開後端前讀它；backendProcess.mjs renewalSqlPath）。與伺服器的 scripts/restore.sh 同一份。
cpSync(join(root, "scripts/lib/renewNodeId.sql"), join(server, "renewNodeId.sql"));

console.log(`stage ok: ${stage} (build ${buildId || "unset"})`);
