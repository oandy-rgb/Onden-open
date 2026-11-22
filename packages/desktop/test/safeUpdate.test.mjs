// 換版安全網（備份、失敗還原、保留份數、空間不足、較新的資料）。不需要 Electron。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dataLayout, ensureDataDirs, loadOrCreateSecrets } from "../src/dataLayout.mjs";
import { shellLocale, shellMessages } from "../src/messages.mjs";
import {
  backupSpaceNeeded, createBackup, InsufficientSpaceError, isDataNewerFailure, listBackups, NEWER_DATA_LOG_MARKER, pruneBackups,
  readBuildInfo, readUpdateMarker, readVersionStamp, requiredFreeBytes, restoreBackup, restoreFromBackup,
  abandonInterruptedUpdate, recoverFromInterruptedUpdate, resumeInterruptedUpdate, startWithSafeUpdate, UpdateFailure, writeUpdateMarker, writeVersionStamp,
} from "../src/safeUpdate.mjs";
import { backendEnv, BackendStartError, startBackend } from "../src/backendProcess.mjs";

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "onden-safe-update-")); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const OLD = { version: "0.1.0", buildId: "aaa111" };
const NEW = { version: "0.1.0", buildId: "bbb222" };

/** 一份「舊版開過」的資料：資料庫檔、上傳檔、筆記備份、金鑰、設定、版本檔。 */
function seedOldData() {
  const layout = dataLayout(tmp());
  ensureDataDirs(layout);
  writeFileSync(join(layout.pgdata, "PG_VERSION"), "17");
  mkdirSync(join(layout.pgdata, "base"));
  writeFileSync(join(layout.pgdata, "base", "rel1"), "old-table-rows");
  mkdirSync(join(layout.data, "content", "media"), { recursive: true });
  writeFileSync(join(layout.data, "content", "media", "a.png"), "png-bytes");
  mkdirSync(join(layout.data, "content", ".git"));
  writeFileSync(join(layout.data, "content", ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(layout.secretsFile, '{"k":1}', { mode: 0o600 });
  writeFileSync(layout.settingsFile, '{"webPort":47821}');
  writeVersionStamp(layout, OLD);
  return layout;
}

/** 資料夾內容的指紋（排除 backups 與版本檔以外的暫存）。 */
function fingerprint(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const here = rel ? `${rel}/${name}` : name;
      if (here === "backups") continue;
      if (statSync(path).isDirectory()) { lines.push(`${here}/`); walk(path, here); }
      else lines.push(`${here}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root, "");
  return lines.join("\n");
}

/** 模擬升級：資料庫被改寫，然後成功或丟錯。 */
const upgrade = (layout, { fail, tail = [] } = {}) => async () => {
  writeFileSync(join(layout.pgdata, "base", "rel1"), "half-migrated");
  writeFileSync(join(layout.pgdata, "base", "rel2"), "new-table");
  if (fail) throw Object.assign(new Error("migration 135 exploded"), { tail });
  return "backend";
};

describe("換版時自動備份", () => {
  it("舊版資料 → 先備份（內容相同）→ 再升級；成功後版本檔換成新版", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    let seenAtStart = "";
    const { backup } = await startWithSafeUpdate({
      layout, current: NEW,
      startBackend: async () => {
        // 升級開始的那一刻，備份已經存在、內容就是升級前的資料
        const [b] = listBackups(layout);
        seenAtStart = fingerprint(b.dir);
        return upgrade(layout)();
      },
    });
    assert.ok(backup);
    assert.match(backup.name, /^before-0\.1\.0\+aaa111-to-0\.1\.0\+bbb222-\d{8}T\d{6}Z$/);
    const copy = fingerprint(backup.dir).split("\n").filter((l) => !l.startsWith("meta.json"));
    assert.deepEqual(copy, before.split("\n"));
    assert.equal(fingerprint(listBackups(layout)[0].dir), seenAtStart);
    assert.deepEqual(readVersionStamp(layout), NEW);
  });

  it("版本沒變：不備份、直接啟動", async () => {
    const layout = seedOldData();
    const { backup } = await startWithSafeUpdate({ layout, current: OLD, startBackend: async () => "ok" });
    assert.equal(backup, null);
    assert.deepEqual(listBackups(layout), []);
  });

  it("全新資料夾：不備份，啟動成功後記下版本", async () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    const { backup } = await startWithSafeUpdate({ layout, current: NEW, startBackend: async () => "ok" });
    assert.equal(backup, null);
    assert.deepEqual(readVersionStamp(layout), NEW);
  });

  it("有資料卻沒有版本檔（這個功能之前的舊安裝）：當成「unknown → 新版」備份", async () => {
    const layout = seedOldData();
    rmSync(layout.versionFile);
    const { backup } = await startWithSafeUpdate({ layout, current: NEW, startBackend: async () => "ok" });
    assert.match(backup.name, /^before-unknown-to-/);
  });

  it("上傳檔用硬連結：備份不佔第二份空間，但內容在", async () => {
    const layout = seedOldData();
    const b = createBackup(layout, { kind: "update", from: "x", to: "y" });
    const a = statSync(join(layout.data, "content", "media", "a.png"));
    const c = statSync(join(b.dir, "data", "content", "media", "a.png"));
    assert.equal(a.ino, c.ino);
  });
});

describe("升級失敗自動退回", () => {
  it("升級丟錯 → 資料與備份前完全相同，版本檔沒換，丟出 rolled_back", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    await assert.rejects(
      startWithSafeUpdate({ layout, current: NEW, startBackend: upgrade(layout, { fail: true, tail: ["boom"] }) }),
      (e) => e instanceof UpdateFailure && e.kind === "rolled_back" && e.from === "0.1.0+aaa111" && /boom/.test(e.diagnostics),
    );
    assert.equal(fingerprint(layout.root), before);
    assert.ok(!existsSync(join(layout.pgdata, "base", "rel2")), "不留下升級到一半的新檔");
    assert.deepEqual(readVersionStamp(layout), OLD);
    assert.deepEqual(readdirSync(layout.root).filter((n) => /\.(restoring|replaced)$/.test(n)), []);
  });

  it("備份後被新版新增的設定檔，退回時一併移除", async () => {
    const layout = seedOldData();
    rmSync(layout.settingsFile);
    const before = fingerprint(layout.root);
    await assert.rejects(startWithSafeUpdate({
      layout, current: NEW,
      startBackend: async () => { writeFileSync(layout.settingsFile, "{}"); throw new Error("x"); },
    }));
    assert.equal(fingerprint(layout.root), before);
  });

  it("診斷資訊帶版本與後端日誌，但主要的錯誤種類是白話分類", async () => {
    const layout = seedOldData();
    await assert.rejects(startWithSafeUpdate({ layout, current: NEW, startBackend: upgrade(layout, { fail: true, tail: ["line-a", "line-b"] }) }), (e) => {
      assert.match(e.diagnostics, /from: 0\.1\.0\+aaa111/);
      assert.match(e.diagnostics, /to: 0\.1\.0\+bbb222/);
      assert.match(e.diagnostics, /line-b/);
      return true;
    });
  });
});

describe("資料比程式新", () => {
  it("不動資料、不還原、不留下沒用的備份，版本檔不變", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    await assert.rejects(
      startWithSafeUpdate({
        layout, current: NEW,
        startBackend: async () => { throw Object.assign(new Error("exit"), { tail: [`[error] migrate ${NEWER_DATA_LOG_MARKER}，後端不會啟動`] }); },
      }),
      (e) => e instanceof UpdateFailure && e.kind === "data_newer",
    );
    assert.equal(fingerprint(layout.root), before);
    assert.deepEqual(listBackups(layout), []);
    assert.deepEqual(readVersionStamp(layout), OLD);
  });

  it("後端的日誌字樣與桌面版認的字樣一致（server.ts 改字樣要一起改）", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const server = readFileSync(join(here, "../../backend/src/server.ts"), "utf8");
    assert.ok(server.includes(NEWER_DATA_LOG_MARKER));
    assert.ok(isDataNewerFailure([`x ${NEWER_DATA_LOG_MARKER} y`]));
    assert.ok(!isDataNewerFailure(["something else"]));
  });
});

describe("保留份數與空間", () => {
  it("只留最近 N 份（預設 3），舊的被清掉", async () => {
    const layout = seedOldData();
    const names = [];
    for (let i = 0; i < 5; i++) {
      names.push(createBackup(layout, { kind: "update", from: `v${i}`, to: `v${i + 1}`, now: new Date(Date.UTC(2026, 10, 12, 10, i)) }).name);
    }
    pruneBackups(layout);
    assert.deepEqual(listBackups(layout).map((b) => b.name), [names[4], names[3], names[2]]);
    pruneBackups(layout, 1);
    assert.deepEqual(listBackups(layout).map((b) => b.name), [names[4]]);
  });

  it("換版成功才清，連續換版後最多留 N 份", async () => {
    const layout = seedOldData();
    let n = 0;
    for (let i = 1; i <= 5; i++) {
      await startWithSafeUpdate({ layout, current: { version: "0.1.0", buildId: `b${i}` }, keep: 2, now: new Date(Date.UTC(2026, 10, 12, 10, i)), startBackend: async () => ++n });
    }
    assert.equal(listBackups(layout).length, 2);
  });

  it("空間不足：不升級（後端沒被啟動）、資料不動、不留半份備份", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    let started = false;
    await assert.rejects(
      startWithSafeUpdate({ layout, current: NEW, freeBytes: 1024, startBackend: async () => { started = true; return "x"; } }),
      (e) => e instanceof UpdateFailure && e.kind === "no_space" && e.freeBytes === 1024 && e.neededBytes > 0,
    );
    assert.equal(started, false);
    assert.equal(fingerprint(layout.root), before);
    assert.deepEqual(existsSync(layout.backups) ? readdirSync(layout.backups) : [], []);
  });
});

describe("手動還原", () => {
  it("還原備份：資料回到備份當時；備份之後新增的上傳檔消失", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeFileSync(join(layout.pgdata, "base", "rel1"), "newer rows");
    writeFileSync(join(layout.data, "content", "media", "later.png"), "later");
    writeVersionStamp(layout, NEW);
    restoreBackup(layout, backup.dir);
    assert.equal(fingerprint(layout.root), before);
  });

  it("不完整的備份（沒有 meta）拒絕還原，現況不動", () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    const fake = join(layout.root, "backups", "fake");
    mkdirSync(fake, { recursive: true });
    assert.throws(() => restoreBackup(layout, fake));
    assert.equal(fingerprint(layout.root), before);
  });
});

describe("版本與文字", () => {
  it("建置資訊：讀 build.json；沒有就空白編號", () => {
    const root = tmp();
    assert.deepEqual(readBuildInfo(root, "1.2.3"), { version: "1.2.3", buildId: "" });
    writeFileSync(join(root, "build.json"), '{"buildId":"abc"}');
    assert.deepEqual(readBuildInfo(root, "1.2.3"), { version: "1.2.3", buildId: "abc" });
  });
  it("後端帶 ONDEN_BUILD_ID（有編號才帶）", () => {
    const base = { layout: dataLayout(tmp()), secrets: { ONDEN_SECRET_KEY: "a", BETTER_AUTH_SECRET: "b" }, backendPort: 1, origin: "http://127.0.0.1:2", timezone: "UTC" };
    assert.equal(backendEnv({ ...base, buildId: "abc" }).ONDEN_BUILD_ID, "abc");
    assert.equal("ONDEN_BUILD_ID" in backendEnv({ ...base, buildId: "" }), false);
  });
  it("對話框文字英文與繁中都有，且不含技術字樣", () => {
    assert.equal(shellLocale("zh-TW"), "zh-TW");
    assert.equal(shellLocale("en-US"), "en");
    const zh = shellMessages("zh-TW");
    const en = shellMessages("en");
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    for (const m of [zh, en]) {
      for (const lines of [m.dataNewer, m.rolledBack("1", "2"), m.noSpace(5e9, 1e9), m.restoreFailed]) {
        assert.ok(lines.every((l) => l.length > 0));
        assert.ok(!/json|uuid|ECONN|Error:/i.test(lines.join(" ")));
      }
    }
    assert.match(zh.dataNewer[0], /較新版/);
  });
});

describe("真的 PGlite 資料夾端到端", () => {
  const require = createRequire(import.meta.url);
  let PGlite;
  try { ({ PGlite } = require("@electric-sql/pglite")); } catch { /* 桌面版單獨安裝時可能找不到：下面跳過並明說 */ }
  const open = async (dir) => { const db = new PGlite(dir); await db.waitReady; return db; };

  it("升級改了資料庫又失敗 → 還原後用 PGlite 打開，內容與升級前一模一樣", { skip: PGlite ? false : "找不到 @electric-sql/pglite" }, async () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    let db = await open(layout.pgdata);
    await db.exec("CREATE TABLE notes (id int primary key, body text); INSERT INTO notes VALUES (1,'舊筆記'),(2,'second');");
    await db.close();
    writeVersionStamp(layout, OLD);

    await assert.rejects(startWithSafeUpdate({
      layout, current: NEW,
      startBackend: async () => {
        const d = await open(layout.pgdata);
        await d.exec("ALTER TABLE notes ADD COLUMN extra text; DELETE FROM notes WHERE id = 1; CREATE TABLE half_migrated (x int);");
        await d.close();
        throw Object.assign(new Error("migration failed"), { tail: ["migrate: boom"] });
      },
    }), (e) => e.kind === "rolled_back");

    db = await open(layout.pgdata);
    const rows = (await db.query("SELECT id, body FROM notes ORDER BY id")).rows;
    assert.deepEqual(rows, [{ id: 1, body: "舊筆記" }, { id: 2, body: "second" }]);
    const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='notes' ORDER BY 1")).rows;
    assert.deepEqual(cols.map((c) => c.column_name), ["body", "id"]);
    assert.equal((await db.query("SELECT to_regclass('half_migrated') AS t")).rows[0].t, null);
    await db.close();
  });
});

// ── 中斷安全：升級或還原被強制結束、斷電，下次啟動資料要回到備份前的樣子 ───────────────

/** 一個永遠不結束的「後端啟動」：測試不 await 它，等於升級進行到一半行程被砍。 */
const hangingUpgrade = (layout) => () => { writeFileSync(join(layout.pgdata, "base", "rel1"), "half-migrated"); writeFileSync(join(layout.pgdata, "base", "rel2"), "new"); return new Promise(() => {}); };

describe("升級被強制結束", () => {
  it("標記留著；下次啟動先還原，資料與備份前逐位元相同，標記清掉", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    void startWithSafeUpdate({ layout, current: NEW, startBackend: hangingUpgrade(layout) });
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(fingerprint(layout.root), before, "（前提）資料確實停在升級到一半");
    assert.equal(readUpdateMarker(layout)?.kind, "upgrade");

    const resumed = resumeInterruptedUpdate(layout);
    assert.equal(resumed?.action, "restored");
    assert.equal(fingerprint(layout.root), before);
    assert.equal(readUpdateMarker(layout), null);
  });

  it("下次啟動（新版再開一次）：先還原、再重新升級；失敗也回到同一份資料，而且那份備份沒被清掉", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    void startWithSafeUpdate({ layout, current: NEW, startBackend: hangingUpgrade(layout) });
    await new Promise((r) => setTimeout(r, 50));
    const firstBackup = listBackups(layout)[0].name;
    for (let i = 0; i < 5; i++) {
      await assert.rejects(startWithSafeUpdate({ layout, current: NEW, keep: 1, startBackend: upgrade(layout, { fail: true }) }), (e) => e.kind === "rolled_back");
      assert.equal(fingerprint(layout.root), before);
    }
    // 每次失敗都是從「還原後的正確資料」做備份，所以所有備份內容都等於原始資料
    for (const b of listBackups(layout)) assert.equal(fingerprint(b.dir).split("\n").filter((l) => !l.startsWith("meta.json")).join("\n"), before);
    assert.ok(firstBackup);
  });

  it("標記在、但版本檔已是目標版本（只差清標記就被關掉）：只清標記，不把成功的升級還原掉", () => {
    const layout = seedOldData();
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeUpdateMarker(layout, { kind: "upgrade", backup: backup.name, to: "0.1.0+bbb222" });
    writeFileSync(join(layout.pgdata, "base", "rel1"), "upgraded");
    writeVersionStamp(layout, NEW);
    assert.equal(resumeInterruptedUpdate(layout)?.action, "completed");
    assert.equal(readFileSync(join(layout.pgdata, "base", "rel1"), "utf8"), "upgraded");
    assert.equal(readUpdateMarker(layout), null);
  });

  it("標記指到的備份不會被清掉（還原做完之前）", () => {
    const layout = seedOldData();
    const names = [0, 1, 2, 3].map((i) => createBackup(layout, { kind: "update", from: `v${i}`, to: `v${i + 1}`, now: new Date(Date.UTC(2026, 10, 12, 10, i)) }).name);
    writeUpdateMarker(layout, { kind: "upgrade", backup: names[0], to: "x" });
    pruneBackups(layout, 1);
    assert.ok(listBackups(layout).some((b) => b.name === names[0]));
  });

  it("備份不見或不完整：丟 backup_missing，資料不動；使用者選「直接開啟」（abandon）後就能照常啟動", async () => {
    const layout = seedOldData();
    writeUpdateMarker(layout, { kind: "upgrade", backup: "gone", to: "x" });
    mkdirSync(join(layout.backups, "half"), { recursive: true }); // 有資料夾但沒有 meta.json＝不完整
    const before = fingerprint(layout.root);
    for (const backup of ["gone", "half"]) {
      writeUpdateMarker(layout, { kind: "upgrade", backup, to: "x" });
      await assert.rejects(startWithSafeUpdate({ layout, current: NEW, startBackend: async () => "x" }), (e) => e instanceof UpdateFailure && e.kind === "backup_missing");
    }
    assert.equal(fingerprint(layout.root).replace(/update-in-progress[^\n]*\n/, ""), before.replace(/update-in-progress[^\n]*\n/, ""));
    abandonInterruptedUpdate(layout);
    assert.equal(readUpdateMarker(layout), null);
    const { backend } = await startWithSafeUpdate({ layout, current: NEW, startBackend: async () => "ok" });
    assert.equal(backend, "ok");
  });

  it("標記壞掉（空檔）：丟 backup_missing（有出口），不猜、不動資料", async () => {
    const layout = seedOldData();
    writeFileSync(layout.updateMarker, "");
    const before = fingerprint(layout.root);
    await assert.rejects(startWithSafeUpdate({ layout, current: NEW, startBackend: async () => "x" }), (e) => e.kind === "backup_missing");
    assert.equal(fingerprint(layout.root), before);
  });
});

describe("還原被中斷（每個步驟各砍一次）", () => {
  /** 把「備份 → 升級改壞 → 還原」跑一次，在第 killAt 個步驟丟錯（＝行程被砍）；回傳總步驟數。 */
  function scenario(killAt) {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeUpdateMarker(layout, { kind: "upgrade", backup: backup.name, to: "b" });
    writeFileSync(join(layout.pgdata, "base", "rel1"), "half-migrated");
    writeFileSync(join(layout.data, "content", "media", "later.png"), "later");
    writeFileSync(layout.settingsFile, '{"webPort":1}');
    const names = [];
    let n = 0;
    try {
      resumeInterruptedUpdate(layout, { step: (name) => { names.push(name); if (n++ === killAt) throw new Error("killed"); } });
    } catch (error) {
      assert.equal(error.message, "killed");
    }
    return { layout, before, names };
  }

  it("在複製中、複製完、換位置的兩次 rename 之間、項目與項目之間砍掉，下次啟動都收斂到備份前的資料", () => {
    const total = scenario(Infinity).names.length;
    assert.ok(total >= 10, `步驟太少（${total}）`);
    const kinds = new Set(scenario(Infinity).names.map((n) => n.split(":")[0]));
    for (const k of ["copy-file", "staged", "swap-start", "swap-middle", "swap-done"]) assert.ok(kinds.has(k), k);
    for (let killAt = 0; killAt < total; killAt++) {
      const { layout, before } = scenario(killAt);
      assert.equal(readUpdateMarker(layout)?.kind, "upgrade", `步驟 ${killAt}：標記還在`);
      assert.equal(resumeInterruptedUpdate(layout)?.action, "restored");
      assert.equal(fingerprint(layout.root), before, `在步驟 ${killAt} 被砍`);
      assert.deepEqual(readdirSync(layout.root).filter((n) => /\.(restoring|replaced)$/.test(n)), []);
    }
  });

  it("手動還原被砍：標記是 restore，下次啟動把還原做完（資料等於所選的備份）", () => {
    const layout = seedOldData();
    const chosen = createBackup(layout, { kind: "update", from: "a", to: "b" });
    const chosenPrint = fingerprint(chosen.dir).split("\n").filter((l) => !l.startsWith("meta.json")).join("\n");
    writeFileSync(join(layout.pgdata, "base", "rel1"), "newer");
    let n = 0;
    assert.throws(() => restoreFromBackup(layout, chosen, { from: "cur", step: (name) => { if (name.startsWith("swap-middle") && n++ === 0) throw new Error("killed"); } }), /killed/);
    assert.equal(readUpdateMarker(layout)?.kind, "restore");
    resumeInterruptedUpdate(layout);
    assert.equal(fingerprint(layout.root), chosenPrint);
  });
});

describe("空間要替還原留位置", () => {
  it("需要的空間約是要複製大小的 2 倍加餘裕；比 1 倍加餘裕少就拒絕、剛好夠就過", async () => {
    const layout = seedOldData();
    writeFileSync(join(layout.pgdata, "base", "big"), Buffer.alloc(3 * 1024 * 1024));
    const needed = backupSpaceNeeded(layout);
    assert.ok(needed > 3 * 1024 * 1024);
    assert.ok(requiredFreeBytes(needed) >= needed * 2 * 1.1);
    const oneCopyOnly = needed * 1.1 + 64 * 1024 * 1024;
    assert.ok(requiredFreeBytes(needed) > oneCopyOnly);
    const before = fingerprint(layout.root);
    await assert.rejects(startWithSafeUpdate({ layout, current: NEW, freeBytes: Math.ceil(oneCopyOnly) + 1, startBackend: async () => "x" }), (e) => e.kind === "no_space");
    assert.equal(fingerprint(layout.root), before);
    const ok = await startWithSafeUpdate({ layout, current: NEW, freeBytes: Math.ceil(requiredFreeBytes(needed)), startBackend: async () => "x" });
    assert.ok(ok.backup);
  });

  it("複製到一半磁碟滿了（ENOSPC）：當成空間不足，不留 .partial", () => {
    const layout = seedOldData();
    assert.throws(
      () => createBackup(layout, { kind: "update", from: "a", to: "b", step: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } }),
      (e) => e instanceof InsufficientSpaceError,
    );
    assert.deepEqual(readdirSync(layout.backups), []);
  });

  it("備份不帶快取與暫存（backup-uploads、backup-scratch、site-bundles）", () => {
    const layout = seedOldData();
    for (const name of ["backup-uploads", "backup-scratch", "site-bundles"]) {
      mkdirSync(join(layout.data, "content", name));
      writeFileSync(join(layout.data, "content", name, "big.zip"), "x".repeat(1000));
    }
    const b = createBackup(layout, { kind: "update", from: "a", to: "b" });
    assert.deepEqual(readdirSync(join(b.dir, "data", "content")).sort(), [".git", "media"]);
  });
});

describe("升級成功後的收尾失敗不算升級失敗", () => {
  it("寫版本檔失敗：不還原、回傳後端、資料留在升級後的樣子，只記警告", async () => {
    const layout = seedOldData();
    const warns = [];
    const { backend } = await startWithSafeUpdate({
      layout, current: NEW, onWarn: (m) => warns.push(m),
      startBackend: async () => {
        await upgrade(layout)();
        // 版本檔的位置被一個非空資料夾占住：之後的改名一定失敗
        rmSync(layout.versionFile);
        mkdirSync(layout.versionFile);
        writeFileSync(join(layout.versionFile, "x"), "x");
        return "backend";
      },
    });
    assert.equal(backend, "backend");
    assert.equal(readFileSync(join(layout.pgdata, "base", "rel1"), "utf8"), "half-migrated");
    assert.ok(warns.some((w) => /version file/.test(w)), warns.join("|"));
    assert.equal(readUpdateMarker(layout), null);
  });
});

describe("降版（資料比程式新）先判斷再備份", () => {
  it("版本檔記的升級檔比這個建置多 → 不備份、不啟動、資料不動，即使空間很小", async () => {
    const layout = seedOldData();
    writeVersionStamp(layout, { ...OLD, schema: "190_future.sql" });
    const before = fingerprint(layout.root);
    let started = false;
    await assert.rejects(
      startWithSafeUpdate({ layout, current: { ...NEW, schema: "187_domain_events_device_id.sql" }, freeBytes: 10, startBackend: async () => { started = true; return "x"; } }),
      (e) => e instanceof UpdateFailure && e.kind === "data_newer",
    );
    assert.equal(started, false);
    assert.equal(fingerprint(layout.root), before);
    assert.equal(existsSync(layout.backups), false);
  });
  it("升級檔相同或較舊 → 照常備份升級；成功後版本檔記下新的 schema", async () => {
    const layout = seedOldData();
    writeVersionStamp(layout, { ...OLD, schema: "186_a.sql" });
    await startWithSafeUpdate({ layout, current: { ...NEW, schema: "187_b.sql" }, startBackend: async () => "x" });
    assert.equal(readVersionStamp(layout)?.schema, "187_b.sql");
  });
});

describe("restore_failed", () => {
  it("升級失敗、還原也失敗：丟 restore_failed，標記與備份都留著，下次啟動補完", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    let killed = false;
    await assert.rejects(startWithSafeUpdate({
      layout, current: NEW,
      step: (name) => { if (name === "swap-middle:pgdata" && !killed) { killed = true; throw new Error("disk error"); } },
      startBackend: upgrade(layout, { fail: true }),
    }), (e) => e instanceof UpdateFailure && e.kind === "restore_failed" && /disk error/.test(e.diagnostics));
    assert.equal(readUpdateMarker(layout)?.kind, "upgrade");
    assert.equal(resumeInterruptedUpdate(layout)?.action, "restored");
    assert.equal(fingerprint(layout.root), before);
  });
});

describe("startBackend 真的逾時／提早結束（假的後端程式）", () => {
  /** 一個最小的 serverRoot：packages/backend/dist/{db.js,server.js}。 */
  function fakeServer(serverJs) {
    const root = tmp();
    const dist = join(root, "packages", "backend", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "db.js"), "export const pglite = null;\n");
    writeFileSync(join(dist, "server.js"), serverJs);
    return root;
  }
  const secrets = { ONDEN_SECRET_KEY: "a".repeat(64), BETTER_AUTH_SECRET: "b".repeat(64) };
  const base = (serverRoot, extra = {}) => ({ serverRoot, layout: dataLayout(tmp()), secrets, backendPort: 59123, webPort: 59124, timezone: "UTC", onExit: () => {}, ...extra });

  it("一直沒通過健康檢查：逾時、子程序真的被殺掉才丟 BackendStartError(timeout)", async () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    const root = fakeServer("setInterval(() => {}, 1000);\nconsole.log('migrating…');\n");
    const err = await startBackend(base(root, { layout, readyTimeoutMs: 800 })).then(() => null, (e) => e);
    assert.ok(err instanceof BackendStartError);
    assert.equal(err.reason, "timeout");
    assert.ok(err.tail.some((l) => l.includes("migrating")));
  });

  it("後端自己結束並記下「資料庫較新」字樣：丟 BackendStartError(exited)，日誌尾端認得出來", async () => {
    const layout = dataLayout(tmp());
    ensureDataDirs(layout);
    const root = fakeServer(`console.error(${JSON.stringify(NEWER_DATA_LOG_MARKER)});\nprocess.exit(1);\n`);
    const err = await startBackend(base(root, { layout, readyTimeoutMs: 5000 })).then(() => null, (e) => e);
    assert.ok(err instanceof BackendStartError);
    assert.equal(err.reason, "exited");
    assert.ok(isDataNewerFailure(err.tail));
  });
});

describe("升級成功後標記與版本檔都寫不下去", () => {
  it("停掉後端並還原成備份（不繼續用），不是留著標記等下次啟動把整段使用期間還原掉", async () => {
    const layout = seedOldData();
    const before = fingerprint(layout.root);
    let stopped = false;
    await assert.rejects(startWithSafeUpdate({
      layout, current: NEW,
      stopBackend: async () => {
        stopped = true;
        // 磁碟恢復正常（讓還原能清掉標記）
        rmSync(layout.updateMarker, { recursive: true, force: true });
      },
      startBackend: async () => {
        await upgrade(layout)();
        // 版本檔與標記的位置都被非空資料夾占住：改名與刪除都會失敗
        for (const path of [layout.versionFile, layout.updateMarker]) {
          rmSync(path, { recursive: true, force: true });
          mkdirSync(path);
          writeFileSync(join(path, "x"), "x");
        }
        return "backend";
      },
    }), (e) => e instanceof UpdateFailure && e.kind === "rolled_back");
    assert.equal(stopped, true);
    assert.equal(readUpdateMarker(layout), null);
    assert.equal(readFileSync(join(layout.pgdata, "base", "rel1"), "utf8"), "old-table-rows");
    assert.ok(!existsSync(join(layout.pgdata, "base", "rel2")));
    void before;
  });

  it("標記清不掉但版本檔已寫成：無害，繼續用，只記警告；下次啟動只清標記", async () => {
    const layout = seedOldData();
    const warns = [];
    const { backend } = await startWithSafeUpdate({
      layout, current: NEW, onWarn: (m) => warns.push(m),
      startBackend: async () => {
        await upgrade(layout)();
        rmSync(layout.updateMarker, { recursive: true, force: true });
        mkdirSync(layout.updateMarker);
        writeFileSync(join(layout.updateMarker, "x"), "x");
        return "backend";
      },
    });
    assert.equal(backend, "backend");
    assert.ok(warns.some((w) => /marker/.test(w)));
    assert.equal(readFileSync(join(layout.pgdata, "base", "rel1"), "utf8"), "half-migrated");
  });
});

describe("先補完上次的還原，再讀金鑰", () => {
  it("上次死在 secrets.json 的兩次 rename 之間（檔案不見了）：補完後讀到的是原本的金鑰，不是新產生的", () => {
    const layout = seedOldData();
    rmSync(layout.secretsFile);
    const original = loadOrCreateSecrets(layout); // 合法的金鑰檔
    const backup = createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeUpdateMarker(layout, { kind: "upgrade", backup: backup.name, to: "b" });
    renameSync(layout.secretsFile, `${layout.secretsFile}.replaced`); // 對調到一半：舊的移開了，新的還沒放上
    assert.ok(!existsSync(layout.secretsFile));
    recoverFromInterruptedUpdate(layout, { to: "b" });
    assert.deepEqual(loadOrCreateSecrets(layout), original);
  });
});

describe("寫入後的殘留（注意：fsync 本身沒有測試能涵蓋，斷電行為見 README 已知限制）", () => {
  it("標記與版本檔寫完不留 .tmp；備份完成後沒有 .partial（只驗證沒有殘留檔，不驗證有沒有刷到磁碟）", () => {
    const layout = seedOldData();
    createBackup(layout, { kind: "update", from: "a", to: "b" });
    writeUpdateMarker(layout, { kind: "upgrade", backup: "x", to: "y" });
    writeVersionStamp(layout, NEW);
    assert.deepEqual(readdirSync(layout.root).filter((n) => n.endsWith(".tmp")), []);
    assert.deepEqual(readdirSync(layout.backups).filter((n) => n.endsWith(".partial")), []);
  });
});
