// 還原後換節點編號（src/nodeRenewal.mjs）。不變條件：桌面版的資料不論怎麼被倒回較舊的樣子——選單的手動還原、升級失敗退回、補完中斷的更新、
// 使用者關掉 Onden 自己把舊資料夾放回去——下一次開後端時節點編號都是新的，舊編號記成「這台以前的編號」（sync_origins 'self-restore'）；
// 換不了號就不開後端。沒有被還原的資料，開幾次都不換號。
// 前半是判斷規則（假的資料庫）；後半用桌面版真的入口 serverEntry.mjs 開真的 PGlite 資料夾（需要後端已建好，同 shutdown.test.mjs）。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dataLayout, ensureDataDirs } from "../src/dataLayout.mjs";
import { backendEnv, renewalSqlPath } from "../src/backendProcess.mjs";
import { keepNodeIdOnNextStart, readNodeRecord, renewBeforeBoot, RenewalRefused, wentBack, writeNodeRecord } from "../src/nodeRenewal.mjs";
import { createBackup, listBackups, restoreBackup, restoreFromBackup } from "../src/safeUpdate.mjs";
import { freePort } from "../src/ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "../../backend/dist");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
/** <tmp>/u：紀錄檔放在資料夾旁邊（<tmp>/u.node-record.json），也在這個暫存資料夾裡。 */
const tmpLayout = () => { const d = mkdtempSync(join(tmpdir(), "onden-node-renewal-")); dirs.push(d); const u = join(d, "u"); mkdirSync(u); return dataLayout(u); };

const A = "c2c99cde-163c-4164-b342-8bb94744b0cc", B = "1d27eb1c-f154-47d9-a868-068881ab3bcc";

describe("什麼時候換號（假的資料庫）", () => {
  it("紀錄在資料夾外面：整個資料夾放回去，紀錄不會跟著回去", () => {
    const layout = tmpLayout();
    assert.equal(dirname(layout.nodeRecord), dirname(layout.root));
    assert.ok(!layout.nodeRecord.startsWith(layout.root + "/"));
  });

  it("同一個編號、兩邊都有的某個工作區號碼比紀錄小＝倒回去了；一樣大、變大、工作區不見了、編號不同、沒有紀錄都不算", () => {
    const rec = { nodeId: A, clocks: { w1: 10, w2: 5 } };
    assert.equal(wentBack(rec, { nodeId: A, clocks: { w1: 9, w2: 5 } }), true);
    assert.equal(wentBack(rec, { nodeId: A, clocks: { w1: 10 } }), false); // 紀錄過的工作區不見了：刪掉一個工作區不是倒回去（review point 7）
    assert.equal(wentBack(rec, { nodeId: A, clocks: { w1: 9 } }), true); // 留下來的那個倒回去了才算
    assert.equal(wentBack(rec, { nodeId: A, clocks: { w1: 10, w2: 5 } }), false); // 沒有任何號碼被發兩次
    assert.equal(wentBack(rec, { nodeId: A, clocks: { w1: 11, w2: 6, w3: 1 } }), false);
    assert.equal(wentBack(rec, { nodeId: B, clocks: { w1: 1 } }), false);
    assert.equal(wentBack(null, { nodeId: A, clocks: {} }), false);
    assert.equal(wentBack({ nodeId: null, clocks: {} }, { nodeId: A, clocks: {} }), false);
  });

  /** 假的資料庫：回答節點編號與號碼；換號 SQL 照 `answer` 回答或丟錯。 */
  const fakeDb = (state, answer) => {
    const sent = [];
    const query = async (text, params) => {
      sent.push({ text, params });
      if (text.includes("to_regclass($1)")) return { rows: [{ ok: true }] };
      if (text.startsWith("SELECT node_id FROM sync_node")) return { rows: state.nodeId ? [{ node_id: state.nodeId }] : [] };
      if (text.startsWith("SELECT workspace_id::text AS ws")) return { rows: Object.entries(state.clocks).map(([ws, next]) => ({ ws, next: String(next) })) };
      if (text.startsWith("SELECT * FROM pg_temp.onden_renew_after_restore")) {
        if (answer instanceof Error) throw answer;
        Object.assign(state, answer.after);
        return { rows: [answer.row] };
      }
      return { rows: [] };
    };
    return { query, sent };
  };

  it("還原留下的標記：一定換號，把上次的編號交給換號的 SQL，換完記下新的、清掉標記", async () => {
    const layout = tmpLayout();
    writeNodeRecord(layout, { nodeId: A, clocks: { w1: 3 } });
    writeFileSync(layout.renewalMarker, "{}");
    const db = fakeDb({ nodeId: A, clocks: { w1: 7 } }, { row: { outcome: "renewed", before_id: A, after_id: B }, after: { nodeId: B, clocks: { w1: 1 } } });
    const result = await renewBeforeBoot({ layout, query: db.query, renewalSql: "-- the file" });
    assert.deepEqual(result, { renewed: true, why: "restored", before: A, after: B, kept: false });
    assert.equal(db.sent.find((s) => s.text === "-- the file") !== undefined, true);
    assert.deepEqual(db.sent.find((s) => s.text.startsWith("SELECT * FROM pg_temp"))?.params, [A, false]);
    assert.deepEqual(readNodeRecord(layout), { nodeId: B, clocks: { w1: 1 } });
    assert.equal(existsSync(layout.renewalMarker), false);
  });

  it("沒有標記、資料沒倒回去：不換號，只記下現況", async () => {
    const layout = tmpLayout();
    writeNodeRecord(layout, { nodeId: A, clocks: { w1: 3 } });
    const db = fakeDb({ nodeId: A, clocks: { w1: 4 } }, new Error("must not be called"));
    assert.deepEqual(await renewBeforeBoot({ layout, query: db.query, renewalSql: "-- the file" }), { renewed: false });
    assert.equal(db.sent.some((s) => s.text === "-- the file"), false);
    assert.deepEqual(readNodeRecord(layout), { nodeId: A, clocks: { w1: 4 } });
  });

  it("換不了號（migration 190–205 的資料）：丟 RenewalRefused、標記與紀錄都留著（下次還是要換）", async () => {
    const layout = tmpLayout();
    writeNodeRecord(layout, { nodeId: A, clocks: { w1: 3 } });
    writeFileSync(layout.renewalMarker, "{}");
    const db = fakeDb({ nodeId: A, clocks: { w1: 2 } }, new Error("ERROR: onden-restore: no-origins-table"));
    await assert.rejects(renewBeforeBoot({ layout, query: db.query, renewalSql: "-- the file" }), (e) => e instanceof RenewalRefused && e.reason === "no-origins-table");
    assert.equal(existsSync(layout.renewalMarker), true);
    assert.deepEqual(readNodeRecord(layout), { nodeId: A, clocks: { w1: 3 } });
  });

  it("紀錄檔壞了或不是節點編號：當成沒有紀錄（不會讓換號因為格式不對而拒絕）", () => {
    const layout = tmpLayout();
    for (const text of ["{not json", JSON.stringify({ nodeId: "a-folder-name", clocks: {} }), JSON.stringify({ nodeId: 42 })]) {
      writeFileSync(layout.nodeRecord, text);
      assert.equal(readNodeRecord(layout), null, text);
    }
    writeFileSync(layout.nodeRecord, JSON.stringify({ nodeId: A, clocks: { w1: 2, w2: "x" } }));
    assert.deepEqual(readNodeRecord(layout), { nodeId: A, clocks: { w1: 2 } });
  });

  it("使用者選了照樣開啟（keepNodeIdOnNextStart）：換號的 SQL 收到「換不了就保留」", async () => {
    const layout = tmpLayout();
    writeNodeRecord(layout, { nodeId: A, clocks: { w1: 3 } });
    keepNodeIdOnNextStart(layout);
    const db = fakeDb({ nodeId: A, clocks: { w1: 3 } }, { row: { outcome: "kept", before_id: A, after_id: A }, after: {} });
    const result = await renewBeforeBoot({ layout, query: db.query, renewalSql: "-- the file" });
    assert.deepEqual(db.sent.find((s) => s.text.startsWith("SELECT * FROM pg_temp"))?.params, [A, true]);
    assert.deepEqual(result, { renewed: true, why: "restored", before: A, after: A, kept: true });
    assert.equal(existsSync(layout.renewalMarker), false);
  });

  it("還原（restoreBackup）在動資料之前寫下標記", () => {
    const layout = tmpLayout();
    ensureDataDirs(layout);
    writeFileSync(join(layout.pgdata, "PG_VERSION"), "16\n");
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    let markerAtFirstStep = null;
    restoreBackup(layout, backup.dir, { step: () => { markerAtFirstStep ??= existsSync(layout.renewalMarker); } });
    assert.equal(markerAtFirstStep, true);
  });
});

// ── 真的 PGlite 資料夾＋桌面版真的入口 ────────────────────────────────────────────

const require = createRequire(import.meta.url);
/** @type {any} */
let PGlite;
try { ({ PGlite } = require("@electric-sql/pglite")); } catch { /* 沒有就讓下面的斷言說明 */ }

/** 用 serverEntry.mjs 開後端（內含 migration 與換號），等 booted，再請它乾淨關閉（記下紀錄）。回傳後端的日誌。 */
async function bootAndClose(layout) {
  const port = await freePort(0);
  const env = backendEnv({ layout, secrets: { ONDEN_SECRET_KEY: "a".repeat(64), BETTER_AUTH_SECRET: "b".repeat(64) }, backendPort: port, origin: "http://127.0.0.1:1", timezone: "UTC" });
  const child = fork(join(here, "../src/serverEntry.mjs"), [distDir], { cwd: layout.data, stdio: ["ignore", "pipe", "pipe", "ipc"], env });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => log.push(String(chunk)));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const booted = new Promise((resolve) => child.on("message", (m) => { if (m?.type === "booted") resolve(true); }));
  const first = await Promise.race([booted, exited.then((code) => ({ code }))]);
  if (first !== true) return { booted: false, code: first.code, log: log.join("") };
  child.send({ type: "shutdown" });
  const code = await exited;
  return { booted: true, code, log: log.join("") };
}
/** 這台編了 `times` 個號：跟後端的寫入入口一樣先鎖工作區的時鐘（sync_lock_clock，沒有節點編號就在這時取得），再用掉下一個號碼
 *  （spine/stamps.ts；它寫的標記本身這裡不需要：換號只看編號與號碼）。 */
async function write(layout, times) {
  const db = new PGlite(layout.pgdata);
  const ws = (await db.query(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`)).rows[0].id;
  for (let i = 0; i < times; i++) {
    await db.transaction(async (tx) => {
      await tx.query(`SELECT * FROM sync_lock_clock($1::uuid)`, [ws]);
      await tx.query(`UPDATE sync_clock SET next_seq = next_seq + 1 WHERE workspace_id = $1`, [ws]);
    });
  }
  await db.close();
}
async function nodeOf(layout) {
  const db = new PGlite(layout.pgdata);
  const id = (await db.query(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id ?? null;
  const next = Number((await db.query(`SELECT max(next_seq)::text AS n FROM sync_clock`)).rows[0]?.n ?? 0);
  const former = (await db.query(`SELECT origin, have FROM sync_origins WHERE vouched_by = 'self-restore' ORDER BY origin`)).rows;
  await db.close();
  return { id, next, former };
}

describe("真的資料夾：還原或放回舊資料夾之後，下一次開後端換了新的節點編號", () => {
  const ready = () => {
    assert.ok(PGlite, "找不到 @electric-sql/pglite（在 repo 根目錄 npm ci）");
    assert.ok(existsSync(join(distDir, "server.js")), `${distDir} 還沒建好：先 npm run build -w packages/backend（及 markdown、contract、site），或跑 npm run desktop:check`);
    assert.ok(existsSync(renewalSqlPath()), "scripts/lib/renewNodeId.sql 不見了");
  };

  it("選單的手動還原（restoreFromBackup）：舊編號記成這台以前的編號，握到備份那一刻的號碼", { timeout: 300_000 }, async () => {
    ready();
    const layout = tmpLayout();
    ensureDataDirs(layout);
    assert.equal((await bootAndClose(layout)).booted, true);
    await write(layout, 3);
    const atBackup = await nodeOf(layout);
    assert.ok(atBackup.id);
    createBackup(layout, { kind: "update", from: "v1", to: "v2" });
    await write(layout, 4); // 備份之後又編了號：還原會把這些號碼「還回去」
    const plain = await bootAndClose(layout);
    assert.equal(plain.booted, true);
    assert.doesNotMatch(plain.log, /node id .* ->/); // 沒有還原：不換
    assert.equal((await nodeOf(layout)).id, atBackup.id);

    restoreFromBackup(layout, listBackups(layout).find((b) => b.kind === "update"), { from: "v2" });
    const boot = await bootAndClose(layout);
    assert.equal(boot.booted, true, boot.log);
    const after = await nodeOf(layout);
    assert.notEqual(after.id, atBackup.id);
    assert.match(boot.log, new RegExp(`the data was restored: node id ${atBackup.id} -> ${after.id}`));
    assert.deepEqual(after.former.map((f) => [f.origin, Math.min(...Object.values(f.have))]), [[atBackup.id, atBackup.next - 1]]);
    assert.equal(existsSync(layout.renewalMarker), false);
    assert.equal(readNodeRecord(layout)?.nodeId, after.id);
    // 再開一次：不再換
    assert.equal((await bootAndClose(layout)).booted, true);
    assert.equal((await nodeOf(layout)).id, after.id);
  });

  it("關掉 Onden、自己把舊的資料夾放回去：認得出來（號碼變小），換號", { timeout: 300_000 }, async () => {
    ready();
    const layout = tmpLayout();
    ensureDataDirs(layout);
    assert.equal((await bootAndClose(layout)).booted, true);
    await write(layout, 2);
    const copy = join(dirname(layout.root), "copy-of-u");
    cpSync(layout.root, copy, { recursive: true }); // 使用者的備份：整個資料夾
    const atCopy = await nodeOf(layout);
    await write(layout, 5);
    assert.equal((await bootAndClose(layout)).booted, true); // 乾淨關閉記下了比複製時更大的號碼

    rmSync(layout.root, { recursive: true, force: true });
    cpSync(copy, layout.root, { recursive: true }); // 放回去
    const boot = await bootAndClose(layout);
    assert.equal(boot.booted, true, boot.log);
    const after = await nodeOf(layout);
    assert.notEqual(after.id, atCopy.id);
    assert.match(boot.log, /put back from an older copy/);
    assert.deepEqual(after.former.map((f) => f.origin), [atCopy.id]);
  });

  it("換不了號的資料（沒有記舊編號的表）：不開後端，資料不動，標記留著；使用者選照樣開啟後保留編號並記下", { timeout: 300_000 }, async () => {
    ready();
    const layout = tmpLayout();
    ensureDataDirs(layout);
    assert.equal((await bootAndClose(layout)).booted, true);
    await write(layout, 1);
    const db = new PGlite(layout.pgdata);
    await db.exec(`DROP FUNCTION sync_renew_node_id(); DROP TABLE sync_origins;`); // 像 migration 190–205 的版本做的資料
    const before = (await db.query(`SELECT node_id FROM sync_node`)).rows[0].node_id;
    await db.close();
    writeFileSync(layout.renewalMarker, "{}");
    const boot = await bootAndClose(layout);
    assert.equal(boot.booted, false);
    assert.notEqual(boot.code, 0);
    assert.match(boot.log, /cannot take a new node id \(no-origins-table\)/);
    const check = new PGlite(layout.pgdata);
    assert.equal((await check.query(`SELECT node_id FROM sync_node`)).rows[0].node_id, before);
    await check.close();
    assert.equal(existsSync(layout.renewalMarker), true);
    // the person chose "open anyway": the next start keeps the id and records it; nothing is restored
    keepNodeIdOnNextStart(layout);
    const kept = await bootAndClose(layout);
    assert.equal(kept.booted, true, kept.log);
    assert.match(kept.log, /could NOT take a new node id; it keeps/);
    const after = new PGlite(layout.pgdata);
    assert.equal((await after.query(`SELECT node_id FROM sync_node`)).rows[0].node_id, before);
    assert.deepEqual((await after.query(`SELECT node_id, reason FROM sync_restore_kept_node_id`)).rows, [{ node_id: before, reason: "no-origins-table" }]);
    await after.close();
    assert.equal(existsSync(layout.renewalMarker), false);
  });
});
