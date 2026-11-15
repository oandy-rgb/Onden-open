// Feature-audit deepening (2026-10-09, tick 52): DATA-06 — opening a local
// database written by an OLDER schema. Take this account's IndexedDB snapshot
// with a queued offline edit, rebuild `pending_writes` without the later
// columns (idem_key, attempts, rejection) via python sqlite3, write it back
// while no app instance is running, then open the app online: does the
// migration add the columns and replay the legacy queued edit exactly once?
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { ready, BASE, H, pendingCount } from "../fullstack/helpers";


test("DATA-06: legacy local schema", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D06b ${s}`, markdown: "start" } })).json();
  const md = async () => (await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string;
  const inPath = test.info().outputPath("snapshot.sqlite3"), outPath = test.info().outputPath("legacy.sqlite3");
  try {
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.locator(".cm-content").click({ force: true }); await page.keyboard.press("Control+End"); await page.keyboard.type(` legacy-${s}`);
    await page.waitForTimeout(5000);
    out.pendingBefore = String(await pendingCount(page));
    // Read the persisted snapshot (key + bytes).
    const snap = await page.evaluate(async () => new Promise<{ key: string; b64: string } | null>((resolve) => {
      const r = indexedDB.open("onden-storage", 1);
      r.onsuccess = () => { const tx = r.result.transaction("sqlite", "readonly"); const st = tx.objectStore("sqlite"); const keys = st.getAllKeys(); keys.onsuccess = () => { const key = (keys.result as string[]).find((k) => k.startsWith("db:account-v1:")) ?? (keys.result as string[])[0]; const g = st.get(key); g.onsuccess = () => { const bytes = new Uint8Array(g.result as ArrayBuffer); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); resolve({ key, b64: btoa(bin) }); }; }; };
      r.onerror = () => resolve(null);
    }));
    if (!snap) throw new Error("no snapshot");
    writeFileSync(inPath, Buffer.from(snap.b64, "base64"));
    out.snapshotKey = snap.key.slice(0, 30);
    // Rebuild pending_writes in the pre-migration shape.
    out.python = execFileSync("python3", ["-c", `
import sqlite3, shutil, sys
shutil.copy(sys.argv[1], sys.argv[2]); c = sqlite3.connect(sys.argv[2])
cols = [r[1] for r in c.execute("pragma table_info(pending_writes)")]
rows = c.execute("select id, method, path, body, created_at from pending_writes").fetchall()
c.executescript("drop table pending_writes; create table pending_writes (id integer primary key autoincrement, method text not null, path text not null, body text, created_at text not null default (datetime('now')));")
c.executemany("insert into pending_writes (id, method, path, body, created_at) values (?,?,?,?,?)", rows)
c.commit(); print("cols_before=%s rows=%d cols_after=%s" % (cols, len(rows), [r[1] for r in c.execute("pragma table_info(pending_writes)")]))
`, inPath, outPath], { encoding: "utf8" }).trim();
    const legacyB64 = readFileSync(outPath).toString("base64");
    // Close the app, write the legacy snapshot from a non-app page of the same origin.
    await page.close();
    const w = await context.newPage();
    await w.goto(`${BASE}/favicon.svg`);
    out.written = await w.evaluate(async ({ key, b64 }) => new Promise<string>((resolve) => {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const r = indexedDB.open("onden-storage", 1);
      r.onsuccess = () => { const tx = r.result.transaction("sqlite", "readwrite"); tx.objectStore("sqlite").put(bytes.buffer, key); tx.oncomplete = () => resolve("ok"); tx.onerror = () => resolve(`err ${tx.error?.name}`); };
      r.onerror = () => resolve("open-err");
    }), { key: snap.key, b64: legacyB64 });
    await context.setOffline(false);
    const patches: string[] = []; w.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) patches.push((r.postData() ?? "").slice(0, 60)); });
    const errs: string[] = []; w.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
    await w.goto(`${BASE}/?view=notes&node=${note.id}`);
    await w.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await w.waitForTimeout(6000);
    await w.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await w.waitForTimeout(6000);
    const m = await md();
    out.after = { serverHasEdit: m.includes(`legacy-${s}`), occurrences: m.split(`legacy-${s}`).length - 1, patches: patches.length, pending: String(await pendingCount(w)), recovery: (await w.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).length, errors: errs };
  } finally {
    await context.setOffline(false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA06B " + JSON.stringify(out, null, 2));
  }
});
