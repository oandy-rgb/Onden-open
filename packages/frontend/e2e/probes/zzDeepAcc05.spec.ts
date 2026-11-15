// Feature-audit deepening (2026-10-09, tick 33): ACC-05 — first storage choice
// for a brand-new account (StorageSetup). The native folder picker is stubbed:
// cancel (AbortError), a permission error, a folder handle that cannot be
// stored; then "Use browser storage"; the choice sticks across a reload and is
// per account (a second new account sees the screen again); 390 px layout.
import { test, type Page, type Browser } from "@playwright/test";
import { BASE, H } from "../fullstack/helpers";

const DB_NAME = "onden.sqlite3"; // lib/fileSystemStorage.ts DB_FILENAME

async function newAccount(browser: Browser, owner: Page, tag: string, viewport = { width: 1280, height: 800 }) {
  const s = Date.now();
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport });
  // Stub the picker; the page sets window.__pickMode before each click.
  await ctx.addInitScript(() => {
    const w = window as unknown as { __pickMode?: string; showDirectoryPicker?: unknown };
    w.showDirectoryPicker = async () => {
      const mode = w.__pickMode ?? "abort";
      if (mode === "abort") throw new DOMException("The user aborted a request.", "AbortError");
      if (mode === "security") throw new DOMException("Not allowed", "SecurityError");
      // Real handles from the origin-private file system (structured-cloneable).
      if (mode === "opfs-empty" || mode === "opfs-existing") {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(`acc05-${mode}-${Date.now()}`, { create: true });
        if (mode === "opfs-existing") { const f = await dir.getFileHandle((window as unknown as { __dbName: string }).__dbName, { create: true }); const wr = await f.createWritable(); await wr.write("SQLite format 3\u0000 existing"); await wr.close(); }
        (window as unknown as { __lastDir: string }).__lastDir = dir.name;
        return dir;
      }
      // A handle that cannot be structured-cloned / read.
      return { kind: "directory", name: "fake", getFileHandle: async () => { throw new DOMException("nf", "NotFoundError"); }, queryPermission: async () => "granted", requestPermission: async () => "granted", values: async function* () { /* empty */ }, fn: () => 1 };
    };
  });
  const p = await ctx.newPage();
  const su = await (await p.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Acc05 ${tag} ${s}`, email: `acc05-${tag}-${s}@example.com`, password: `pw-${s}-x` } })).json();
  await owner.request.post("/api/actors", { ...H, data: { name: `Acc05 ${tag} ${s}`, type: "human", external_id: su.user.id } });
  const actor = ((await (await owner.request.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Acc05 ${tag} ${s}`)!;
  return { ctx, p, actorId: actor.id };
}
test.skip("ACC-05: real folder handles (OPFS) — existing backup refused, empty accepted (tick 34/35, done)", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const A = await newAccount(browser, page, "f");
  try {
    await A.p.goto(`${BASE}/?view=notes`);
    await A.p.getByText("Choose where to keep your data").waitFor({ timeout: 60_000 });
    const folder = A.p.getByRole("button", { name: /Choose a folder/ });
    await A.p.evaluate((n) => { (window as unknown as { __dbName: string }).__dbName = n; }, DB_NAME);
    await A.p.evaluate(() => { (window as unknown as { __pickMode: string }).__pickMode = "opfs-existing"; });
    await folder.click(); await A.p.waitForTimeout(1500);
    out.existing = { stillOnSetup: await setupVisible(A.p), alert: await alertText(A.p) };
    await A.p.evaluate(() => { (window as unknown as { __pickMode: string }).__pickMode = "opfs-empty"; });
    await folder.click();
    await A.p.locator(".obsidian-title-input").first().waitFor({ timeout: 60_000 }).catch(() => {});
    await A.p.waitForTimeout(8000);
    out.empty = {
      setup: await setupVisible(A.p),
      pref: await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("onden-storage-pref")).map((k) => localStorage.getItem(k))),
      folderFiles: await A.p.evaluate(async () => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle((window as unknown as { __lastDir: string }).__lastDir); const names: string[] = []; for await (const [n, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) { const f = h.kind === "file" ? await (h as FileSystemFileHandle).getFile() : null; names.push(`${n}:${f?.size ?? "dir"}`); } return names; }),
    };
    const dirName = await A.p.evaluate(() => (window as unknown as { __lastDir: string }).__lastDir);
    out.dirName = dirName;
    const listFolder = () => A.p.evaluate(async (dn) => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle(dn); const names: string[] = []; for await (const [n, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) { const f = h.kind === "file" ? await (h as FileSystemFileHandle).getFile() : null; names.push(`${n}:${f?.size ?? "dir"}`); } return names; }, dirName);
    await A.p.locator(".cm-content").first().click({ force: true }).catch(() => {});
    await A.p.keyboard.type(" folder-copy-check");
    const timeline: string[] = [];
    for (let i = 0; i < 12; i++) { await A.p.waitForTimeout(5000); timeline.push(`${(i + 1) * 5}s ${JSON.stringify(await listFolder())}`); if ((await listFolder()).length) break; }
    out.afterEdit = timeline;
    await A.p.reload(); await A.p.waitForTimeout(8000);
    out.afterReload = { setup: await setupVisible(A.p), title: await A.p.locator(".obsidian-title-input").first().inputValue().catch(() => null) };
    // After a reload (folder activated at startup): editor typing, then a title rename.
    await A.p.locator(".cm-content").first().click({ force: true }).catch(() => {});
    await A.p.keyboard.type(" after-reload-edit");
    const t2: string[] = [];
    for (let i = 0; i < 6; i++) { await A.p.waitForTimeout(5000); const l = await listFolder(); t2.push(`${(i + 1) * 5}s ${JSON.stringify(l)}`); if (l.length) break; }
    out.afterReloadEditorEdit = t2;
    if (!(await listFolder()).length) {
      const title = A.p.locator(".obsidian-title-input").first();
      await title.click(); await title.press("End"); await title.type(" R"); await title.press("Enter");
      const t3: string[] = [];
      for (let i = 0; i < 6; i++) { await A.p.waitForTimeout(5000); const l = await listFolder(); t3.push(`${(i + 1) * 5}s ${JSON.stringify(l)}`); if (l.length) break; }
      out.afterTitleRename = t3;
    }
    if (!(await listFolder()).length) {
      // Positive control: a nodeMutations write (inspector Parent select → assignToGroup).
      const sel = A.p.locator(".ov-prop-row").filter({ hasText: /^Parent/ }).locator("select").filter({ visible: true }).first();
      await sel.focus().catch(() => {}); await A.p.waitForTimeout(400);
      const opt = await sel.locator("option").nth(1).getAttribute("value").catch(() => null);
      if (opt) await sel.selectOption(opt).catch(() => {});
      out.parentOption = opt;
      const t4: string[] = [];
      for (let i = 0; i < 6; i++) { await A.p.waitForTimeout(5000); const l = await listFolder(); t4.push(`${(i + 1) * 5}s ${JSON.stringify(l)}`); if (l.length) break; }
      out.afterParentChange = t4;
      if (opt) await sel.selectOption("").catch(() => {});
    }
  } finally {
    await A.ctx.close();
    await page.request.delete(`/api/actors/${A.actorId}`, H).catch(() => {});
    console.log("ACC05F " + JSON.stringify(out, null, 2));
  }
});
const setupVisible = (p: Page) => p.getByText("Choose where to keep your data").isVisible().catch(() => false);
const alertText = (p: Page) => p.locator(".storage-setup-overlay [role=alert]").innerText().catch(() => null);

test.skip("ACC-05: first storage choice (tick 33, done)", async ({ page, browser }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {};
  const A = await newAccount(browser, page, "a");
  const B = await newAccount(browser, page, "b", { width: 390, height: 780 });
  try {
    await A.p.goto(`${BASE}/?view=notes`);
    await A.p.getByText("Choose where to keep your data").waitFor({ timeout: 60_000 });
    const folder = A.p.getByRole("button", { name: /Choose a folder/ });
    for (const mode of ["abort", "security", "badhandle"]) {
      await A.p.evaluate((m) => { (window as unknown as { __pickMode: string }).__pickMode = m; }, mode);
      await folder.click(); await A.p.waitForTimeout(1500);
      out[`pick_${mode}`] = { stillOnSetup: await setupVisible(A.p), alert: await alertText(A.p), buttonsEnabled: await folder.isEnabled(), pref: await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("onden-storage-pref")).map((k) => `${k.slice(0, 40)}=${localStorage.getItem(k)}`)) };
    }
    await A.p.getByRole("button", { name: /Use browser storage/ }).click();
    await A.p.locator(".obsidian-title-input, .app-topbar, [class*=topbar]").first().waitFor({ timeout: 60_000 }).catch(() => {});
    out.afterBrowserChoice = { setup: await setupVisible(A.p), pref: await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("onden-storage-pref")).map((k) => localStorage.getItem(k))) };
    await A.p.reload(); await A.p.waitForTimeout(6000);
    out.afterReload = { setupAgain: await setupVisible(A.p) };

    // Second new account in a different browser context at 390 px.
    await B.p.goto(`${BASE}/?view=notes`);
    await B.p.getByText("Choose where to keep your data").waitFor({ timeout: 60_000 });
    out.phone = await B.p.evaluate(() => {
      const vw = innerWidth; const btns = Array.from(document.querySelectorAll(".storage-setup-overlay button")) as HTMLElement[];
      return { scrollWidth: document.documentElement.scrollWidth, vw, buttons: btns.map((b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)}`; }), overflow: btns.some((b) => b.getBoundingClientRect().right > vw + 1) };
    });
    await B.p.screenshot({ path: test.info().outputPath("phone-setup.png") });
    await B.p.getByRole("button", { name: /Use browser storage/ }).click();
    await B.p.waitForTimeout(5000);
    out.phoneAfterChoice = { setup: await setupVisible(B.p) };
    // Same browser context as A, sign B's credentials? Instead: in A's context sign out and sign up C → setup again?
    const s2 = Date.now();
    await A.ctx.clearCookies();
    const su = await (await A.p.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Acc05 c ${s2}`, email: `acc05-c-${s2}@example.com`, password: `pw-${s2}-x` } })).json();
    await page.request.post("/api/actors", { ...H, data: { name: `Acc05 c ${s2}`, type: "human", external_id: su.user.id } });
    await A.p.goto(`${BASE}/?view=notes`); await A.p.waitForTimeout(6000);
    out.sameBrowserOtherAccount = { setupShown: await setupVisible(A.p) };
    const cId = ((await (await page.request.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Acc05 c ${s2}`)?.id;
    if (cId) await page.request.delete(`/api/actors/${cId}`, H);
  } finally {
    await A.ctx.close(); await B.ctx.close();
    await page.request.delete(`/api/actors/${A.actorId}`, H).catch(() => {});
    await page.request.delete(`/api/actors/${B.actorId}`, H).catch(() => {});
    console.log("ACC05 " + JSON.stringify(out, null, 2));
  }
});

// Tick 39 (DATA-05): folder permission revoked on a later visit.
test("DATA-05: folder permission denied after setup", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const A = await newAccount(browser, page, "perm");
  try {
    await A.p.goto(`${BASE}/?view=notes`);
    await A.p.getByText("Choose where to keep your data").waitFor({ timeout: 60_000 });
    await A.p.evaluate(() => { (window as unknown as { __pickMode: string }).__pickMode = "opfs-empty"; });
    await A.p.getByRole("button", { name: /Choose a folder/ }).click();
    await A.p.locator(".obsidian-title-input").first().waitFor({ timeout: 60_000 }).catch(() => {});
    out.setupPref = await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("onden-storage-pref")).map((k) => localStorage.getItem(k)));
    // Revoke: every directory handle now reports "denied".
    await A.ctx.addInitScript(() => {
      const proto = (globalThis as unknown as { FileSystemHandle?: { prototype: Record<string, unknown> } }).FileSystemHandle?.prototype;
      if (proto) { proto.queryPermission = async () => "denied"; proto.requestPermission = async () => "denied"; }
    });
    const errs: string[] = []; A.p.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    await A.p.reload();
    await A.p.locator(".obsidian-title-input").first().waitFor({ timeout: 60_000 }).catch(() => {});
    await A.p.waitForTimeout(5000);
    out.afterRevoke = {
      workspaceLoaded: await A.p.locator(".obsidian-title-input").first().isVisible().catch(() => false),
      setupShown: await setupVisible(A.p),
      text: (await A.p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160),
      toasts: await A.p.locator(".toast-message").allInnerTexts(),
      pref: await A.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("onden-storage-pref")).map((k) => localStorage.getItem(k))),
      errors: errs,
    };
    // Does Settings say anything about the folder copy?
    await A.p.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click().catch(() => {});
    await A.p.waitForTimeout(800);
    await A.p.getByRole("button", { name: /^Your Data$/ }).or(A.p.getByRole("tab", { name: /^Your Data$/ })).first().click().catch(() => {});
    await A.p.waitForTimeout(800);
    out.settingsData = (await A.p.locator("[role=dialog], .settings-panel, .settings-modal").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    await A.p.screenshot({ path: test.info().outputPath("revoked-settings.png") });
  } finally {
    await A.ctx.close();
    await page.request.delete(`/api/actors/${A.actorId}`, H).catch(() => {});
    console.log("DATA05 " + JSON.stringify(out, null, 2));
  }
});
