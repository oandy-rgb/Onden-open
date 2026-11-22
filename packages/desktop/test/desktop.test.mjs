// 不需要 Electron 的部分：資料夾與金鑰、找埠、靜態檔＋代理。`npm test`（node --test）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { dataLayout, ensureDataDirs, loadOrCreateSecrets, readSettings, writeSettings } from "../src/dataLayout.mjs";
import { backendEnv } from "../src/backendProcess.mjs";
import { freePort } from "../src/ports.mjs";
import { startWebServer } from "../src/webServer.mjs";

const dirs = [];
// one level down: a layout keeps <userData>.node-record.json NEXT TO the folder (dataLayout.mjs), inside this temporary one
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "onden-desktop-test-")); dirs.push(d); const u = join(d, "u"); mkdirSync(u); return u; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("資料夾與金鑰", () => {
  it("第一次產生 64 字元十六進位的金鑰，檔案權限 0600，再讀回同一份", () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    const a = loadOrCreateSecrets(layout);
    assert.match(a.ONDEN_SECRET_KEY, /^[0-9a-f]{64}$/);
    assert.match(a.BETTER_AUTH_SECRET, /^[0-9a-f]{64}$/);
    assert.notEqual(a.ONDEN_SECRET_KEY, a.BETTER_AUTH_SECRET);
    assert.equal(statSync(layout.secretsFile).mode & 0o777, 0o600);
    assert.deepEqual(loadOrCreateSecrets(layout), a);
  });
  it("金鑰檔壞掉時拒絕覆蓋（覆蓋會讓已加密的內容永遠讀不回來）", () => {
    const layout = dataLayout(tmp());
    writeFileSync(layout.secretsFile, "{ not json");
    assert.throws(() => loadOrCreateSecrets(layout));
    writeFileSync(layout.secretsFile, JSON.stringify({ ONDEN_SECRET_KEY: "short" }));
    assert.throws(() => loadOrCreateSecrets(layout), /內容不正確/);
  });
  it("資料夾權限 0700，設定檔讀寫來回", () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    assert.equal(statSync(layout.pgdata).mode & 0o777, 0o700);
    assert.deepEqual(readSettings(layout), {});
    writeSettings(layout, { webPort: 47821 });
    assert.deepEqual(readSettings(layout), { webPort: 47821 });
  });
});

describe("後端啟動參數", () => {
  it("明確要求後端只聽 127.0.0.1", () => {
    const env = backendEnv({
      layout: dataLayout(tmp()), secrets: { ONDEN_SECRET_KEY: "a", BETTER_AUTH_SECRET: "b" },
      backendPort: 4000, origin: "http://127.0.0.1:5000", timezone: "UTC",
    });
    assert.equal(env.ONDEN_LISTEN_HOST, "127.0.0.1");
    assert.equal(env.PORT, "4000");
  });
});

describe("找埠", () => {
  it("偏好的埠被占用就改用系統給的", async () => {
    const blocker = createServer();
    await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = blocker.address().port;
    const got = await freePort(taken);
    assert.notEqual(got, taken);
    assert.ok(got > 0);
    blocker.close();
  });
  it("偏好的埠空著就用它", async () => {
    const probe = await freePort();
    assert.equal(await freePort(probe), probe);
  });
});

describe("靜態檔與後端代理", () => {
  const root = tmp();
  mkdirSync(join(root, "_astro"));
  writeFileSync(join(root, "index.html"), "<!doctype html>app");
  writeFileSync(join(root, "_astro", "a.js"), "export {}");
  writeFileSync(join(root, "app.wasm"), "\0asm");
  /** @type {{ url: string, headers: Record<string, unknown> } | null} */
  let seen = null;
  const backend = createServer((req, res) => {
    seen = { url: req.url ?? "", headers: req.headers };
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  let web;
  let port;
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

  it("起得來", async () => {
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    port = await freePort();
    web = await startWebServer({ webRoot: root, webPort: port, backendPort: backend.address().port });
  });
  after(() => { web?.close(); backend.close(); });
  it("提供靜態檔、正確的 MIME、雜湊檔長快取", async () => {
    const js = await get("/_astro/a.js");
    assert.equal(js.status, 200);
    assert.match(String(js.headers["content-type"]), /javascript/);
    assert.match(String(js.headers["cache-control"]), /immutable/);
    assert.equal((await get("/app.wasm")).headers["content-type"], "application/wasm");
  });
  it("沒有副檔名的路徑回單頁應用，有副檔名卻不存在是 404", async () => {
    assert.equal((await get("/n/some-note")).body, "<!doctype html>app");
    assert.equal((await get("/missing.js")).status, 404);
  });
  it("擋路徑穿越", async () => {
    const r = await get("/..%2f..%2fetc%2fpasswd");
    assert.ok(r.status === 403 || r.status === 404 || r.body === "<!doctype html>app", `got ${r.status}`);
    assert.ok(!r.body.includes("root:"));
  });
  it("/api 與 /health 轉給後端，並蓋掉用戶端自帶的來源位址", async () => {
    const r = await get("/api/nodes?x=1", { "x-real-ip": "6.6.6.6" });
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(seen?.url, "/api/nodes?x=1");
    assert.equal(seen?.headers["x-real-ip"], "127.0.0.1");
    assert.equal((await get("/health")).status, 200);
  });
  it("Host 不是自己的名稱就拒絕（DNS rebinding）", async () => {
    assert.equal((await get("/", { host: "evil.example:80" })).status, 403);
    assert.equal((await get("/", { host: `localhost:${port}` })).status, 200);
  });
});
