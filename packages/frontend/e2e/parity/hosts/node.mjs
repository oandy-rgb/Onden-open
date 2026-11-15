// 宿主一：Node 後端（packages/backend/dist/server.js），也是比對的基準。
// 有 DATABASE_URL（`_test` 結尾）就在那台真 Postgres 上開一個全新的資料庫跑；沒有就用 PGlite，
// 並把「真 Postgres 那一欄沒跑」印出來（具名跳過，不算通過）。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieClient, freePort, PARITY_USER } from "./common.mjs";

export async function startHost({ repo, flag }) {
  const dist = join(repo, "packages/backend/dist/server.js");
  if (!existsSync(dist)) throw new Error("packages/backend/dist/server.js 還沒建好；先跑 npm run build -w packages/backend");
  const work = mkdtempSync(join(tmpdir(), "onden-parity-node-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const notes = [];
  const env = {
    ...process.env,
    PORT: String(port), CORS_ORIGIN: base, BETTER_AUTH_URL: base, BETTER_AUTH_SECRET: "parity-only-secret-not-for-production",
    ONDEN_SECRET_KEY: "0123456789abcdef".repeat(4), // 64 個十六進位字元（桌面版第一次啟動也是產生這種）；測試專用
    EMBEDDING_MODE: "stub", ONDEN_SIGNUP: "open", NODE_ENV: "e2e", TZ: "UTC", ONDEN_TIMEZONE: "UTC", LOG_LEVEL: "warn",
  };
  let dropDatabase = async () => {};
  const adminUrl = flag("database-url") ?? process.env.DATABASE_URL;
  const realPostgres = adminUrl && /_test(\?.*)?$/.test(adminUrl) && process.env.ONDEN_DB_DRIVER !== "pglite" && !process.argv.includes("--pglite");
  if (realPostgres) {
    // 全新的資料庫：第一個註冊的帳號才會是擁有者，劇本也不被舊資料干擾。
    const { Client } = createRequire(join(repo, "packages/backend/package.json"))("pg");
    const name = `onden_parity_${Date.now().toString(36)}_test`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    env.DATABASE_URL = url.toString();
    delete env.ONDEN_DB_DRIVER;
    dropDatabase = async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {}); };
    notes.push(`資料庫：真 Postgres（新建 ${name}）`);
  } else {
    env.ONDEN_DB_DRIVER = "pglite";
    env.ONDEN_PGLITE_DIR = join(work, "pgdata");
    env.DATABASE_URL = "postgres://onden@localhost/onden_parity_test"; // PGlite 不連線；config 仍要求有值
    notes.push("資料庫：PGlite。真 Postgres 那一欄沒跑（具名跳過：沒有 `_test` 結尾的 DATABASE_URL）；差異以 Postgres 為準的部分要在筆電上補跑");
  }
  const cwd = join(work, "backend");
  mkdirSync(cwd, { recursive: true });
  const logFile = createWriteStream(join(work, "backend.log"));
  const child = spawn(process.execPath, [dist], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(logFile); child.stderr.pipe(logFile);
  let exited = false;
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (exited) throw new Error("後端啟動時結束了（log 在 " + join(work, "backend.log") + "）");
    if (Date.now() > deadline) { child.kill(); throw new Error("後端 240 秒內沒有就緒"); }
    const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  const client = cookieClient(base);
  await client.signUp(PARITY_USER);
  return {
    label: realPostgres ? "Node 後端（真 Postgres）" : "Node 後端（PGlite）",
    notes,
    request: (req) => client.request(req),
    async close() {
      child.kill("SIGTERM");
      await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
      await dropDatabase();
      if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
    },
  };
}
