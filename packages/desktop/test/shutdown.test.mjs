// 乾淨關閉（docs/desktop/README.md）：用桌面版真正的入口 serverEntry.mjs 起後端（PGlite、暫存資料夾），
// 照外殼的做法送 { type: "shutdown" }，檢查：行程在上限內正常結束、關閉前還在跑的派發工作做完了、
// 重開同一個資料夾還在，且連線池結束之後沒有任何寫入。不需要 Electron，但需要後端已建好
// （`npm run build -w packages/backend`，以及 markdown／contract／site；desktop:check 的打包步驟會先做）。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dataLayout, ensureDataDirs } from "../src/dataLayout.mjs";
import { backendEnv } from "../src/backendProcess.mjs";
import { freePort } from "../src/ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "../../backend/dist");
/** serverEntry.mjs 自己的強制結束是 8 秒；乾淨關閉必須比它快。 */
const EXIT_LIMIT_MS = 8_000;

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** 起後端，回傳 { expect(type) 等下一個該類型的訊息, send, exited }。 */
async function startEntry(layout) {
  const port = await freePort(0);
  const env = backendEnv({
    layout, secrets: { ONDEN_SECRET_KEY: "a".repeat(64), BETTER_AUTH_SECRET: "b".repeat(64) },
    backendPort: port, origin: "http://127.0.0.1:1", timezone: "UTC",
  });
  const child = fork(join(here, "../src/serverEntry.mjs"), [distDir], {
    cwd: layout.data, stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: ["--import", join(here, "fixtures/shutdownProbe.mjs")],
    env: { ...env, SHUTDOWN_PROBE_DIST: distDir },
  });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => log.push(String(chunk)));
  const waiting = new Map();
  const seen = new Map();
  child.on("message", (message) => {
    seen.set(message.type, message);
    waiting.get(message.type)?.(message);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  const expect = (type) => seen.has(type) ? Promise.resolve(seen.get(type)) : new Promise((resolve, reject) => {
    waiting.set(type, resolve);
    exited.then((e) => reject(new Error(`後端在送出 ${type} 之前結束了（${JSON.stringify(e)}）：\n${log.slice(-20).join("")}`)));
  });
  await expect("booted");
  return { expect, send: (m) => child.send(m), exited, kill: () => child.kill("SIGKILL") };
}

describe("桌面版乾淨關閉（serverEntry.mjs）", () => {
  it("關閉前還在跑的派發工作做完、行程在上限內結束、之後沒有寫入、重開後資料還在", async () => {
    assert.ok(existsSync(join(distDir, "server.js")), `${distDir} 還沒建好：先 npm run build -w packages/backend（及 markdown、contract、site），或跑 npm run desktop:check`);
    const root = mkdtempSync(join(tmpdir(), "onden-shutdown-test-"));
    dirs.push(root);
    const layout = dataLayout(root);
    ensureDataDirs(layout);

    const first = await startEntry(layout);
    try {
      first.send({ type: "queue-job" });
      await first.expect("job-queued");
      const sentAt = Date.now();
      first.send({ type: "shutdown" }); // 外殼關視窗時送的同一則訊息

      const late = await first.expect("late-write");
      const exit = await first.exited;
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null }, "正常結束，不是被強制結束（強制是 exit 1）");
      assert.ok(exit.at - sentAt < EXIT_LIMIT_MS, `關閉花了 ${exit.at - sentAt} ms，超過 ${EXIT_LIMIT_MS} ms 的強制結束上限`);
      // (c) 連線池結束後的寫入被拒絕，不是悄悄寫進另一個資料庫
      assert.equal(late.wrote, false);
      assert.match(late.message, /pool was ended/);
    } finally { first.kill(); }

    // (b) 同一個資料夾再起一次：關閉前排的工作做完了，結束後的那筆不在
    const second = await startEntry(layout);
    try {
      second.send({ type: "read" });
      assert.deepEqual((await second.expect("rows")).notes, ["job"]);
      second.send({ type: "shutdown" });
      await second.expect("late-write");
      assert.equal((await second.exited).code, 0);
    } finally { second.kill(); }
  });
});
