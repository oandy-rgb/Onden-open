// 啟動流程（經過 main.mjs 用的同一批函式）：資料準備順序、備份不見的出口、失敗對話框的文字。不需要 Electron。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dataLayout, ensureDataDirs, loadOrCreateSecrets } from "../src/dataLayout.mjs";
import { shellMessages } from "../src/messages.mjs";
import { createBackup, readUpdateMarker, UpdateFailure, writeUpdateMarker, writeVersionStamp } from "../src/safeUpdate.mjs";
import { failureDialog, prepareUserData, runStartup } from "../src/startup.mjs";

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "onden-startup-test-")); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const BUILD = { version: "0.1.0", buildId: "bbb" };

function seed() {
  const layout = dataLayout(tmp());
  ensureDataDirs(layout);
  writeFileSync(join(layout.pgdata, "PG_VERSION"), "17");
  rmSync(layout.secretsFile, { force: true });
  loadOrCreateSecrets(layout);
  writeVersionStamp(layout, { version: "0.1.0", buildId: "aaa" });
  return layout;
}

describe("資料準備的順序", () => {
  it("上次死在 secrets.json 對調到一半：準備好的金鑰是原本那組（先還原、再讀金鑰）", () => {
    const layout = seed();
    const original = JSON.parse(readFileSync(layout.secretsFile, "utf8"));
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeUpdateMarker(layout, { kind: "upgrade", backup: backup.name, to: "0.1.0+bbb" });
    renameSync(layout.secretsFile, `${layout.secretsFile}.replaced`);
    assert.deepEqual(prepareUserData(layout, BUILD).secrets, original);
    assert.deepEqual(JSON.parse(readFileSync(layout.secretsFile, "utf8")), original);
  });

  it("main.mjs 只經由 prepareUserDataAt 碰金鑰與設定（直接讀金鑰就會跳過先還原）", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.mjs", import.meta.url)), "utf8");
    assert.match(main, /prepareUserDataAt\(/);
    assert.doesNotMatch(main, /loadOrCreateSecrets|readSettings\(|ensureDataDirs/);
  });
});

/** 假的對話框，記下每個被呼叫的對話框。 */
function fakeUi(choice = "quit") {
  const calls = { ask: 0, show: [] };
  return {
    calls,
    askBackupMissing: async () => { calls.ask++; return choice; },
    askRenewalRefused: async () => { calls.ask++; return choice; },
    showFailure: async (error) => { calls.show.push(error); },
  };
}
const missing = () => new UpdateFailure("backup_missing", { from: "?", to: "x", diagnostics: "d" });

describe("備份不見了的流程（runStartup）", () => {
  it("選「結束」：只問一次，不再跳第二個對話框，回 false", async () => {
    const ui = fakeUi("quit");
    const ok = await runStartup({ boot: async () => { throw missing(); }, layout: () => null, ...ui });
    assert.equal(ok, false);
    assert.equal(ui.calls.ask, 1);
    assert.deepEqual(ui.calls.show, []);
  });

  it("選「直接開啟」：清掉標記、再啟動一次，成功回 true，沒有失敗對話框", async () => {
    const layout = seed();
    writeUpdateMarker(layout, { kind: "upgrade", backup: "gone", to: "x" });
    let boots = 0;
    const ui = fakeUi("open");
    const ok = await runStartup({
      boot: async () => { boots++; prepareUserData(layout, BUILD); },
      layout: () => layout, ...ui,
    });
    assert.equal(ok, true);
    assert.equal(boots, 2);
    assert.equal(readUpdateMarker(layout), null);
    assert.deepEqual(ui.calls.show, []);
  });

  it("標記檔壞掉（空檔）走同一條出口", async () => {
    const layout = seed();
    writeFileSync(layout.updateMarker, "");
    const ui = fakeUi("open");
    const ok = await runStartup({ boot: async () => { prepareUserData(layout, BUILD); }, layout: () => layout, ...ui });
    assert.equal(ui.calls.ask, 1);
    assert.equal(ok, true);
  });

  it("選「直接開啟」但再啟動也失敗：照一般失敗顯示那個新的錯誤", async () => {
    const layout = seed();
    const second = new Error("second boot failed");
    let n = 0;
    const ui = fakeUi("open");
    const ok = await runStartup({ boot: async () => { if (n++ === 0) throw missing(); throw second; }, layout: () => layout, ...ui });
    assert.equal(ok, false);
    assert.deepEqual(ui.calls.show, [second]);
  });

  it("清標記本身丟錯：不會漏出去，當成一般失敗顯示", async () => {
    const layout = seed();
    mkdirSync(layout.updateMarker);
    writeFileSync(join(layout.updateMarker, "x"), "x");
    const ui = fakeUi("open");
    const ok = await runStartup({ boot: async () => { throw missing(); }, layout: () => layout, ...ui });
    assert.equal(ok, false);
    assert.equal(ui.calls.show.length, 1);
  });

  it("一般的啟動失敗：不問備份，直接顯示一次", async () => {
    const ui = fakeUi();
    const boom = new Error("boom");
    assert.equal(await runStartup({ boot: async () => { throw boom; }, layout: () => null, ...ui }), false);
    assert.equal(ui.calls.ask, 0);
    assert.deepEqual(ui.calls.show, [boom]);
  });

  it("成功就不碰任何對話框", async () => {
    const ui = fakeUi();
    assert.equal(await runStartup({ boot: async () => {}, layout: () => null, ...ui }), true);
    assert.equal(ui.calls.ask, 0);
    assert.deepEqual(ui.calls.show, []);
  });
});

describe("失敗對話框的文字", () => {
  it("每一種失敗的主文都不同，「備份不見」不會說成「已恢復到更新前」；兩種語言都一樣", () => {
    for (const locale of /** @type {const} */ (["zh-TW", "en"])) {
      const t = shellMessages(locale);
      const mk = (kind) => failureDialog(new UpdateFailure(kind, { from: "0.1.0+a", to: "0.1.0+b", diagnostics: `diag-${kind}`, neededBytes: 5e9, freeBytes: 1e9 }), t, BUILD);
      const messages = ["data_newer", "rolled_back", "restore_failed", "no_space", "backup_missing"].map((k) => mk(k).message);
      assert.equal(new Set(messages).size, messages.length);
      assert.equal(mk("backup_missing").message, t.backupMissing[0]);
      assert.notEqual(mk("backup_missing").detail, t.rolledBack("a", "b")[1]);
      assert.equal(mk("rolled_back").diagnostics, "diag-rolled_back");
    }
  });
  it("一般錯誤：主文是白話，原始訊息只在診斷資訊裡", () => {
    const t = shellMessages("zh-TW");
    const d = failureDialog(Object.assign(new Error("ECONNREFUSED /home/u/secret"), { tail: ["log line"] }), t, BUILD);
    assert.ok(!d.message.includes("ECONN") && !d.detail.includes("ECONN"));
    assert.match(d.diagnostics, /ECONNREFUSED/);
    assert.match(d.diagnostics, /log line/);
  });
});

describe("換不了節點編號的流程（runStartup，review of #1937 point 6）", () => {
  const refused = () => new UpdateFailure("renewal_refused", { from: "x", to: "x", diagnostics: "d" });
  it("選「結束」：只問一次就結束，資料與標記不動", async () => {
    const layout = seed();
    writeFileSync(layout.renewalMarker, JSON.stringify({ backup: "b" }));
    const ui = fakeUi("quit");
    assert.equal(await runStartup({ boot: async () => { throw refused(); }, layout: () => layout, ...ui }), false);
    assert.equal(ui.calls.ask, 1);
    assert.equal(ui.calls.show.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(layout.renewalMarker, "utf8")), { backup: "b" });
  });
  it("選「直接開啟」：標記改成「保留原本的編號」，再啟動一次", async () => {
    const layout = seed();
    writeFileSync(layout.renewalMarker, JSON.stringify({ backup: "b" }));
    const ui = fakeUi("open");
    let n = 0;
    assert.equal(await runStartup({ boot: async () => { if (n++ === 0) throw refused(); }, layout: () => layout, ...ui }), true);
    assert.equal(n, 2);
    assert.deepEqual(JSON.parse(readFileSync(layout.renewalMarker, "utf8")), { keep: true });
  });
  it("對話框的文字白話、不放代碼", () => {
    for (const locale of ["zh-TW", "en"]) {
      const { message, detail } = failureDialog(refused(), shellMessages(locale), BUILD);
      assert.ok(message.length > 0 && detail.length > 0);
      assert.doesNotMatch(`${message} ${detail}`, /node[_ ]id|uuid|sync_|json|onden-restore/i);
    }
  });
});

