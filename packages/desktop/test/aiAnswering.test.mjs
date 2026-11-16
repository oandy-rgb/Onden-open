// 「用這台電腦上的 AI 回答」的主程序部分：加密儲存、橋的驗證、開／關／還原的生命週期（假的 AI 工具）。
// 不需要 Electron。`npm test`（node --test）。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as answerer from "../../ai-answerer/src/index.mjs";
import { writeFakeTool } from "../../ai-answerer/src/testing/fakeTool.mjs";
import { AI_CHANNELS, createAiHandlers, isTrustedSender } from "../src/aiAnswering/bridge.mjs";
import { createAiAnsweringController, unavailableAiAnswering } from "../src/aiAnswering/controller.mjs";
import { createAiAnsweringStore, safeStorageCipher } from "../src/aiAnswering/store.mjs";

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "onden-ai-answering-test-")); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CODE = `ondt_${"a".repeat(43)}`;
const ACTOR = "11111111-2222-4333-8444-555555555555";
const waitFor = async (check, ms = 15_000) => { const until = Date.now() + ms; while (!(await check())) { if (Date.now() > until) throw new Error("waitFor timed out"); await new Promise((r) => setTimeout(r, 50)); } };

/** 假的「系統加密」：base64 加一個前綴，看得出有沒有被用。 */
const fakeCipher = (available = true) => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`ENC:${Buffer.from(text).toString("base64")}`),
  decrypt: (data) => { const s = data.toString(); if (!s.startsWith("ENC:")) throw new Error("bad"); return Buffer.from(s.slice(4), "base64").toString(); },
});

describe("連線碼的儲存", () => {
  it("加密後存檔（0600、檔案裡沒有明文），讀回同一把碼", () => {
    const file = join(tmp(), "ai-answering.json");
    const store = createAiAnsweringStore({ file, cipher: fakeCipher() });
    store.saveEnabled("own", { code: CODE, actorId: ACTOR });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").includes(CODE), false);
    assert.deepEqual(store.get("own"), { enabled: true, code: CODE, actorId: ACTOR, codeId: undefined, address: undefined });
  });
  it("忘掉碼：關著、沒有碼；自己的 AI 的 id 留著、別台伺服器的網址不留", () => {
    const store = createAiAnsweringStore({ file: join(tmp(), "a.json"), cipher: fakeCipher() });
    store.saveEnabled("own", { code: CODE, actorId: ACTOR });
    store.saveEnabled("remote", { code: CODE, address: "https://notes.example.com" });
    store.forgetCode("own"); store.forgetCode("remote");
    assert.deepEqual(store.get("own"), { enabled: false, code: null, actorId: ACTOR, codeId: undefined, address: undefined });
    assert.deepEqual(store.get("remote"), { enabled: false, code: null, actorId: undefined, codeId: undefined, address: undefined });
  });
  it("沒有安全儲存就不存；檔案壞了或解不開就當關著，不丟錯", () => {
    const file = join(tmp(), "a.json");
    assert.throws(() => createAiAnsweringStore({ file, cipher: fakeCipher(false) }).saveEnabled("own", { code: CODE }), /secure_storage_unavailable/);
    writeFileSync(file, "{ not json");
    assert.equal(createAiAnsweringStore({ file, cipher: fakeCipher() }).get("own").enabled, false);
    const store = createAiAnsweringStore({ file, cipher: fakeCipher() });
    store.saveEnabled("own", { code: CODE });
    assert.equal(createAiAnsweringStore({ file, cipher: { ...fakeCipher(), decrypt: () => { throw new Error("keyring changed"); } } }).get("own").enabled, false);
  });
  it("Linux 沒有鑰匙圈（basic_text）不算安全儲存", () => {
    const base = { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: String };
    assert.equal(safeStorageCipher({ ...base, getSelectedStorageBackend: () => "basic_text" }).available(), false);
    assert.equal(safeStorageCipher({ ...base, getSelectedStorageBackend: () => "gnome_libsecret" }).available(), true);
    assert.equal(safeStorageCipher({ ...base, isEncryptionAvailable: () => false }).available(), false);
  });
});

describe("橋：每個參數都驗證，沒有能執行命令或讀檔的東西", () => {
  const calls = [];
  const controller = {
    detect: async () => ({ ok: true }), status: () => ({ own: {}, remote: {} }),
    enable: async (key, input) => { calls.push([key, input]); return { ok: true }; }, disable: async (key) => { calls.push([key]); return { ok: true }; },
  };
  const handlers = createAiHandlers({ controller, parseServerAddress: answerer.parseServerAddress });

  it("只有清單上的頻道，且清單與 preload.cjs 一致", () => {
    assert.deepEqual(Object.keys(handlers).sort(), Object.values(AI_CHANNELS).filter((c) => c !== AI_CHANNELS.statusChanged).sort());
    const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
    for (const channel of Object.values(AI_CHANNELS)) assert.ok(preload.includes(`"${channel}"`), channel);
    assert.equal((preload.match(/"onden:ai:[a-z-]+"/g) ?? []).length, Object.keys(AI_CHANNELS).length);
    assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\b(?!\.)/s); // 不把 ipcRenderer 本身交出去
  });
  it("拒絕不合規的連線碼、AI 編號、網址與形狀", () => {
    const own = handlers[AI_CHANNELS.enableOwn], remote = handlers[AI_CHANNELS.enableRemote];
    for (const bad of [undefined, null, "x", [], { actorId: "../etc", code: CODE }, { actorId: ACTOR, code: CODE, codeId: "../x" }, Object.create({ actorId: ACTOR, code: CODE })]) {
      assert.throws(() => own(bad), TypeError);
    }
    for (const bad of [undefined, { code: CODE }, { address: 5, code: CODE }, { address: "x".repeat(3000), code: CODE }]) assert.throws(() => remote(bad), TypeError);
    // 使用者會貼錯的碼：回白話的原因，不是丟錯
    for (const code of ["short", `${CODE}\n`, 7, undefined]) {
      assert.deepEqual(own({ actorId: ACTOR, code }), { ok: false, reason: "bad_code" });
      assert.deepEqual(remote({ address: "https://x.com", code }), { ok: false, reason: "bad_code" });
    }
    assert.throws(() => handlers[AI_CHANNELS.previewAddress](42), TypeError);
    assert.equal(calls.length, 0);
  });
  it("合規的呼叫才進控制器；網址規則在這裡也擋（http 只准本機與內網）", async () => {
    assert.deepEqual(await handlers[AI_CHANNELS.enableOwn]({ actorId: ACTOR, code: CODE }), { ok: true });
    assert.deepEqual(await handlers[AI_CHANNELS.enableRemote]({ address: "https://notes.example.com", code: CODE }), { ok: true });
    assert.deepEqual(calls.at(-2), ["own", { code: CODE, actorId: ACTOR, codeId: undefined }]);
    assert.deepEqual(handlers[AI_CHANNELS.previewAddress]("https://notes.example.com/"), { ok: true, address: "https://notes.example.com" });
    assert.deepEqual(handlers[AI_CHANNELS.previewAddress]("http://notes.example.com"), { ok: false });
    assert.deepEqual(handlers[AI_CHANNELS.previewAddress]("http://192.168.1.4:5000"), { ok: true, address: "http://192.168.1.4:5000" });
  });
  it("沒有任何回傳值帶著連線碼", async () => {
    for (const out of [await handlers[AI_CHANNELS.enableOwn]({ actorId: ACTOR, code: CODE }), await handlers[AI_CHANNELS.status](), await handlers[AI_CHANNELS.detect]()]) {
      assert.equal(JSON.stringify(out).includes(CODE), false);
    }
  });
  it("只信這個 App 自己的頁面", () => {
    assert.equal(isTrustedSender("http://127.0.0.1:47821/settings", "http://127.0.0.1:47821"), true);
    assert.equal(isTrustedSender("https://evil.example/", "http://127.0.0.1:47821"), false);
    assert.equal(isTrustedSender("http://127.0.0.1:47821/api/media/abc.html", "http://127.0.0.1:47821"), false, "使用者內容在 /api/ 底下，同一來源也不算");
    assert.equal(isTrustedSender("http://127.0.0.1:9999/", "http://127.0.0.1:47821"), false);
    assert.equal(isTrustedSender(undefined, "http://127.0.0.1:47821"), false);
    assert.equal(isTrustedSender("not a url", ""), false);
  });
});

describe("開、關、還原（假的 AI 工具、假的伺服器）", () => {
  /** 一台假的 Onden：一個排隊的問題，記下收到的 finish。 */
  async function fakeServer({ refuse = false } = {}) {
    const state = { queue: ["s1"], finished: null, claims: 0, polls: 0 };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
        if (refuse) return send(401, { error: "unauthorized" });
        if (req.url.startsWith("/api/mcp/sessions/pending")) { state.polls++; return send(200, { sessions: state.queue.map((id) => ({ id })) }); }
        if (req.url.endsWith("/claim")) { state.claims++; state.queue = []; return send(200, { session: { id: "s1", deadline_at: new Date(Date.now() + 60_000).toISOString() }, rendered: { system: "S", messages: [{ role: "user", content: "問題" }] }, mcp: { path: "/api/mcp/protocol", token: "ondt_session" } }); }
        if (req.url.endsWith("/events")) return send(200, { status: "running" });
        if (req.url.endsWith("/finish")) { state.finished = JSON.parse(body); return send(200, { status: "completed" }); }
        return send(200, { id: "s1", status: "running" });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { state, address: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }
  async function setup({ cipher = fakeCipher(), toolEnv = {} } = {}) {
    const dir = tmp();
    const tool = await writeFakeTool(dir);
    process.env.FAKE_TOOL_RECORD = join(dir, "record.json");
    for (const [k, v] of Object.entries(toolEnv)) process.env[k] = v;
    const store = createAiAnsweringStore({ file: join(dir, "ai.json"), cipher });
    const make = (ownBaseUrl = () => null) => createAiAnsweringController({ store, answerer, ownBaseUrl, toolCommand: tool });
    return { store, make, tool };
  }

  it("說白話的原因：沒有安全儲存、找不到工具、還沒登入、網址不合規、碼被拒絕、連不上", async () => {
    const { make } = await setup({ cipher: fakeCipher(false) });
    assert.deepEqual(await make().enable("remote", { code: CODE, address: "https://x.example" }), { ok: false, reason: "no_secure_storage" });

    const ok = await setup();
    const controller = ok.make();
    assert.deepEqual(await createAiAnsweringController({ store: ok.store, answerer, ownBaseUrl: () => null, toolCommand: join(tmp(), "nope") }).enable("remote", { code: CODE, address: "https://x.example" }), { ok: false, reason: "missing" });
    process.env.FAKE_TOOL_LOGGED_IN = "no";
    assert.deepEqual(await controller.enable("remote", { code: CODE, address: "https://x.example" }), { ok: false, reason: "not_logged_in" });
    delete process.env.FAKE_TOOL_LOGGED_IN;
    assert.deepEqual(await controller.enable("remote", { code: CODE, address: "http://notes.example.com" }), { ok: false, reason: "bad_address" });
    assert.deepEqual(await controller.enable("own", { code: CODE, actorId: ACTOR }), { ok: false, reason: "not_ready" });

    const refusing = await fakeServer({ refuse: true });
    assert.deepEqual(await controller.enable("remote", { code: CODE, address: refusing.address }), { ok: false, reason: "code_refused" });
    await refusing.close();
    assert.deepEqual(await controller.enable("remote", { code: CODE, address: refusing.address }), { ok: false, reason: "unreachable" });
    assert.equal(ok.store.get("remote").code, null); // 失敗的嘗試不留下碼
  });

  it("兩個同時進來的 enable 一次做一件；沒有載入的替身說「現在不能用」", async () => {
    const server = await fakeServer();
    const { make, store } = await setup();
    const controller = make();
    const a = controller.enable("remote", { code: CODE, address: server.address });
    const b = controller.enable("remote", { code: CODE, address: server.address });
    assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
    assert.equal(store.get("remote").enabled, true);
    await controller.disable("remote");
    await server.close();
    const stub = unavailableAiAnswering();
    assert.deepEqual(await stub.enable("own", { code: CODE }), { ok: false, reason: "unavailable" });
    assert.deepEqual(stub.status().own.enabled, false);
  });

  it("自己的 AI：記下伺服器上這把碼的編號，狀態帶著它，關掉後忘掉（AI 的編號留著）", async () => {
    const server = await fakeServer();
    const { make, store } = await setup();
    const controller = make(() => server.address);
    await controller.enable("own", { code: CODE, actorId: ACTOR, codeId: "tok-1" });
    assert.equal(controller.status().own.codeId, "tok-1");
    await controller.disable("own");
    assert.equal(controller.status().own.codeId, undefined);
    assert.equal(store.get("own").actorId, ACTOR);
    await server.close();
  });

  it("對象 B：打開 → 領到問題、用假工具回答、交回 → 關掉：停止、忘掉碼", async () => {
    const server = await fakeServer();
    const { make, store } = await setup({ toolEnv: { FAKE_TOOL_ANSWER: "桌面答案" } });
    const controller = make();
    assert.deepEqual(await controller.enable("remote", { code: CODE, address: server.address }), { ok: true });
    assert.deepEqual(store.get("remote"), { enabled: true, code: CODE, actorId: undefined, codeId: undefined, address: server.address });
    assert.equal(controller.status().remote.enabled, true);
    await waitFor(() => server.state.finished);
    assert.deepEqual(server.state.finished, { status: "completed", result_markdown: "桌面答案" });
    await waitFor(() => controller.status().remote.phase === "waiting");

    const pollsBefore = server.state.polls;
    assert.deepEqual(await controller.disable("remote"), { ok: true });
    assert.equal(controller.status().remote.phase, "stopped");
    assert.equal(store.get("remote").code, null);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(server.state.polls <= pollsBefore + 1, "停止後不再問伺服器");
    await server.close();
    delete process.env.FAKE_TOOL_ANSWER;
  });

  it("對象 A：連到自己的後端；重新開 App（restore）接回開著的對象；結束時停掉", async () => {
    const server = await fakeServer();
    const { make, store } = await setup({ toolEnv: { FAKE_TOOL_ANSWER: "A 的答案" } });
    const first = make(() => server.address);
    assert.deepEqual(await first.enable("own", { code: CODE, actorId: ACTOR }), { ok: true });
    await waitFor(() => server.state.finished);
    assert.equal(first.status().own.actorId, ACTOR);
    await first.stopAll();
    assert.equal(first.status().own.phase, "stopped");
    assert.equal(store.get("own").enabled, true, "結束 App 不等於關掉：下次開啟還在");

    server.state.queue = ["s1"]; server.state.finished = null;
    const second = make(() => server.address);
    second.restore();
    await waitFor(() => server.state.finished);
    assert.deepEqual(server.state.finished, { status: "completed", result_markdown: "A 的答案" });
    await second.disable("own");
    assert.equal(store.get("own").code, null);
    assert.equal(store.get("own").actorId, ACTOR);
    await server.close();
    delete process.env.FAKE_TOOL_ANSWER;
  });

  it("碼被撤銷後（伺服器 401）狀態是 refused，不空轉", async () => {
    const refusing = await fakeServer({ refuse: true });
    const { store, make } = await setup();
    store.saveEnabled("own", { code: CODE, actorId: ACTOR });
    const controller = make(() => refusing.address);
    const phases = [];
    controller.subscribe((s) => phases.push(s.own.phase));
    controller.restore();
    await waitFor(() => phases.includes("refused"));
    await controller.stopAll();
    await refusing.close();
  });
});
