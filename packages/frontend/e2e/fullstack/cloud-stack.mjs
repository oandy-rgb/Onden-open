// 不用 docker 的全端 e2e 堆疊：後端（PGlite，node 直接跑）＋ 前端 SSR（Astro node 伺服器）＋
// 同源轉發（取代 compose.e2e.yaml 的 nginx），聽 :5099，E2E_BASE=http://localhost:5099 原樣可用。
//
// 用法（在 packages/frontend）：
//   npm run e2e:cloud-stack                         起整套，前景等 Ctrl-C，收掉全部程序與暫存資料
//   npm run e2e:cloud-stack -- --run npx playwright test --project=chromium …
//                                                   起整套、等到能用、跑後面的指令、收掉、以該指令的結束碼離開
//   --skip-build                                    沿用上次的 build（改了程式就不要用）
//
// 與 compose 版的差異（寫在這裡是因為會影響測試結果，完整分類見 docs/agents/testing.md）：
// - 資料庫是 PGlite（單連線、無 pgroonga／pgvector）：需要真 Postgres 的 spec 在這裡不會過。
// - 時區寫死：後端與瀏覽器端（--run 的子程序）都是 TZ=UTC，同 compose 的 backend 與 playwright 容器（兩者都沒有設 TZ）。
//   兩邊必須一致：瀏覽器時區與工作區時區不同時，擁有者會看到「旅行時詢問」卡片，它會擋住點擊（TimeZoneAsk）。
//   可用 E2E_BROWSER_TZ 覆寫（要測別的時區就連工作區時區一起設）。
// - 沒有 docker：用 docker exec／docker stop 的 spec（zz*）在這裡跳過，見 helpers.ts 的 e2eContainer。
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, createWriteStream, readdirSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const PORT = Number(process.env.E2E_PORT || 5099);
// 後端與前端的內部埠每次挑空的（同一台可同時起兩套，例如另一個 E2E_PORT）；對外只有 PORT。
let BACKEND_PORT = 0;
let FRONTEND_PORT = 0;
const freePort = () =>
  new Promise((ok, fail) => {
    const probe = createTcpServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
const BASE = `http://localhost:${PORT}`;
const BROWSER_TZ = process.env.E2E_BROWSER_TZ || "UTC";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: REPO, ...opts });

async function waitFor(url, label, okCodes, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (okCodes.includes(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e?.cause?.code ?? e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} 沒有在 ${timeoutMs / 1000} 秒內就緒（最後：${last}）`);
}

/** nginx.conf 的同源轉發：/api、/_astro、其餘 → 後端或前端。X-Real-IP／X-Forwarded-For 一律覆寫成連線位址。 */
function startProxy() {
  const server = createServer((req, res) => {
    const toBackend = (req.url ?? "").startsWith("/api/");
    const port = toBackend ? BACKEND_PORT : FRONTEND_PORT;
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    const headers = { ...req.headers, "x-real-ip": ip, "x-forwarded-for": ip };
    const upstream = httpRequest({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => {
      const out = { ...up.headers };
      delete out["x-content-type-options"];
      delete out["referrer-policy"];
      if ((req.url ?? "").startsWith("/_astro/") && up.statusCode && up.statusCode < 400) {
        out["cache-control"] = "public, max-age=31536000, immutable";
      }
      out["x-frame-options"] = (req.url ?? "").startsWith("/site/") ? undefined : "DENY";
      if (out["x-frame-options"] === undefined) delete out["x-frame-options"];
      out["x-content-type-options"] = "nosniff";
      out["referrer-policy"] = "strict-origin-when-cross-origin";
      res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(PORT, "0.0.0.0", () => ok(server));
  });
}

/** 預先裝好的瀏覽器版本可能與 e2e 釘的 Playwright 不同（例如 chromium-1243 對 1223）。
 *  缺哪個版本資料夾，就在暫存目錄用符號連結指到同名前綴的現成資料夾，回傳要設的 PLAYWRIGHT_BROWSERS_PATH
 *  （沒有需要就回傳 undefined）。Chromium 的小版本差異對這套 spec 無影響；要求精確版本時自己 `playwright install`。 */
function browserShim(work) {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  let wanted = [];
  try {
    const out = execFileSync("npx", ["playwright", "install", "--dry-run", "chromium"], { cwd: join(HERE, ".."), encoding: "utf8" });
    wanted = [...out.matchAll(/Install location:\s+(\S+)/g)].map((m) => m[1]);
  } catch {
    return undefined;
  }
  const missing = wanted.filter((dir) => !existsSync(dir));
  if (missing.length === 0) return undefined;
  const shim = join(work, "browsers");
  mkdirSync(shim, { recursive: true });
  for (const entry of readdirSync(root)) symlinkSync(join(root, entry), join(shim, entry));
  for (const dir of missing) {
    const name = dir.split("/").pop();
    const prefix = name.replace(/-\d+$/, "-");
    const near = readdirSync(root).find((entry) => entry.startsWith(prefix));
    if (near) symlinkSync(join(root, near), join(shim, name));
  }
  return shim;
}

/** 起整套並等到能用；resolves { base, stop }。stop() 收掉全部程序與暫存資料。 */
export async function startCloudStack({ skipBuild = false } = {}) {
  BACKEND_PORT = await freePort();
  FRONTEND_PORT = await freePort();
  const work = mkdtempSync(join(tmpdir(), "onden-e2e-"));
  const children = [];
  let proxy;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    proxy?.close();
    proxy?.closeAllConnections?.();
    for (const child of children) child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  };

  try {
    if (!skipBuild || !existsSync(join(REPO, "packages/backend/dist/server.js"))) {
      // Same packages, same order as packages/backend/docker/Dockerfile: the backend's dist imports contract's dist.
      console.log("▸ build 後端（含 markdown、contract、site）…");
      for (const w of ["markdown", "contract", "site", "backend"]) sh("npm", ["run", "build", "--workspace", `packages/${w}`]);
    }
    if (!skipBuild || !existsSync(join(REPO, "packages/frontend/dist/server/entry.mjs"))) {
      console.log("▸ build 前端（PUBLIC_API_BASE_URL 空＝同源）…");
      sh("npm", ["run", "build", "--workspace", "packages/frontend"], { env: { ...process.env, PUBLIC_API_BASE_URL: "" } });
    }

    const logTo = (name) => createWriteStream(join(work, `${name}.log`));
    const launch = (name, cmd, args, cwd, env) => {
      const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      const log = logTo(name);
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      children.push(child);
      return child;
    };

    // 後端的 cwd 決定 content/（git 內容與媒體）與 .auth-secret 放哪：放進暫存目錄，收掉時一起刪。
    const backendDir = join(work, "backend");
    execFileSync("mkdir", ["-p", backendDir]);
    const backend = launch("backend", process.execPath, [join(REPO, "packages/backend/dist/server.js")], backendDir, {
      ONDEN_DB_DRIVER: "pglite",
      ONDEN_PGLITE_DIR: join(work, "pgdata"),
      DATABASE_URL: "postgres://onden@localhost/onden_cloud_e2e", // pglite 不連線；config 仍要求有值
      PORT: String(BACKEND_PORT),
      CORS_ORIGIN: BASE,
      BETTER_AUTH_SECRET: "e2e-only-secret-not-for-production",
      BETTER_AUTH_URL: BASE,
      EMBEDDING_MODE: "stub",
      SITE_SSR_URL: `http://127.0.0.1:${FRONTEND_PORT}`,
      ONDEN_SIGNUP: "open",
      NODE_ENV: "e2e",
      SAFE_FETCH_ALLOW_PRIVATE: "1",
      TZ: "UTC",
    });
    const frontend = launch("frontend", process.execPath, [join(REPO, "packages/frontend/dist/server/entry.mjs")], join(REPO, "packages/frontend"), {
      HOST: "127.0.0.1",
      PORT: String(FRONTEND_PORT),
      SSR_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    });
    for (const [name, child] of [["後端", backend], ["前端", frontend]]) {
      child.once("exit", (code) => {
        if (!stopped) console.error(`✗ ${name}程序意外結束（code ${code}），記錄：${work}`);
      });
    }

    // /api/bootstrap 回 200 或 401 都代表後端已 migrate 完（同 run.sh）。
    console.log("▸ 等後端 migrate（PGlite 第一次要跑全部 migration）…");
    await waitFor(`http://127.0.0.1:${BACKEND_PORT}/api/bootstrap`, "後端", [200, 401]);
    await waitFor(`http://127.0.0.1:${FRONTEND_PORT}/`, "前端", [200, 301, 302, 303]);
    proxy = await startProxy();
    await waitFor(`${BASE}/api/bootstrap`, "同源轉發", [200, 401]);
    writeFileSync(join(work, "READY"), "");
    console.log(`✓ 整套就緒：${BASE}（暫存與記錄：${work}）`);
    return { base: BASE, stop, work, browsersPath: browserShim(work) };
  } catch (e) {
    console.error(`✗ 起不來：${e instanceof Error ? e.message : e}`);
    for (const name of ["backend", "frontend"]) {
      const file = join(work, `${name}.log`);
      if (existsSync(file)) console.error(`--- ${name} 尾段 ---\n${execFileSync("tail", ["-n", "40", file], { encoding: "utf8" })}`);
    }
    await stop();
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runAt = args.indexOf("--run");
  const command = runAt >= 0 ? args.slice(runAt + 1) : [];
  // The specs read fullstack/generated/hostContract.json (they import nothing from packages/*); same step as run.sh.
  sh("npx", ["tsx", "--tsconfig", "../site/tsconfig.json", "e2e/scripts/writeHostContract.ts"], { cwd: join(HERE, "../..") });
  const stack = await startCloudStack({ skipBuild: args.includes("--skip-build") });
  let code = 0;
  const finish = async (exit) => {
    await stack.stop();
    process.exit(exit);
  };
  process.on("SIGINT", () => void finish(130));
  process.on("SIGTERM", () => void finish(143));
  if (command.length === 0) {
    console.log("按 Ctrl-C 收掉。");
    await new Promise(() => {});
  } else {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, E2E_BASE: stack.base, E2E_CLOUD: "1", E2E_FEED_ORIGIN: `http://127.0.0.1:${PORT}`, TZ: BROWSER_TZ, ...(stack.browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: stack.browsersPath } : {}) },
    });
    code = await new Promise((r) => child.on("exit", (c, s) => r(c ?? (s ? 1 : 0))));
    await finish(code);
  }
}
