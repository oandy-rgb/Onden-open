// Feature-audit deepening (2026-10-09, tick 32): PER-03 — revocation reaching
// an open browser. User B (editor, real UI session) has N1 open; the owner moves
// it to an owner-only space → how fast does N1 leave B's editor / list / search?
// Then B edits N2 offline; the owner locks N2; B reconnects → the edit must be
// refused (not applied), the input kept in recovery, N2 purged locally.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H, psql as db, pendingCount } from "../fullstack/helpers";

async function settle(p: Page) {
  // A new account first sees the storage choice (StorageSetup).
  const choose = p.getByRole("button", { name: /Use browser storage/ });
  await choose.or(p.locator(".obsidian-title-input")).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
  if (await choose.isVisible().catch(() => false)) { await choose.click(); }
  await p.locator(".obsidian-title-input, .login-card").first().waitFor({ state: "visible", timeout: 90_000 }).catch(() => {}); await p.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await p.waitForTimeout(3000); for (const b of await p.locator(".fwr-dismiss").filter({ visible: true }).all()) await b.click().catch(() => {}); }
async function off(ctx: BrowserContext, p: Page) { await ctx.setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event("offline"))); }
async function on(ctx: BrowserContext, p: Page) { await ctx.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event("online"))); }

test("PER-03: revocation reaches an open session", async ({ page, browser }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const space_id = await defaultSpaceId(req); // B must see both until they are locked
  const N1 = await (await req.post("/api/nodes", { ...H, data: { title: `Per03 N1 ${s}`, markdown: `secret one ${s}`, space_id } })).json();
  const N2 = await (await req.post("/api/nodes", { ...H, data: { title: `Per03 N2 ${s}`, markdown: `secret two ${s}`, space_id } })).json();
  const email = `per03-${s}@example.com`, pw = `pw-${s}-x`;
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });
  const b = await ctx.newPage();
  const bErrors: string[] = []; b.on("pageerror", (e) => bErrors.push(String(e).slice(0, 140))); b.on("console", (m) => { if (m.type() === "error") bErrors.push("console: " + m.text().slice(0, 140)); });
  const su = await (await b.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Per03 ${s}`, email, password: pw } })).json();
  await req.post("/api/actors", { ...H, data: { name: `Per03 ${s}`, type: "human", external_id: su.user.id } });
  const bActor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Per03 ${s}`)!;
  await addToDefaultSpace(req, bActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  try {
    await b.goto(`${BASE}/?view=notes&node=${N1.id}`); await settle(b);
    out.B_loginCard = await b.locator(".login-card").count();
    out.B_errorsEarly = bErrors.slice(0, 6);
    out.B_seesN1 = { title: await b.locator(".obsidian-title-input").inputValue().catch(() => null), body: (await b.locator(".cm-content").innerText().catch(() => "")).includes(`secret one ${s}`) };
    // 1. Lock N1 while open.
    const t0 = Date.now();
    await hideFromOthers(req, N1.id);
    let goneMs: number | null = null;
    for (let i = 0; i < 60; i++) {
      const body = (await b.locator("body").innerText().catch(() => "")); if (!body.includes(`secret one ${s}`) && !body.includes(`Per03 N1 ${s}`)) { goneMs = Date.now() - t0; break; }
      await b.waitForTimeout(500);
    }
    out.N1_lock = { goneFromScreenMs: goneMs, gateSeen: await b.locator(".membership-gate").count(), url: new URL(b.url()).searchParams.get("node") === N1.id ? "still N1 in URL" : "moved", serverReadB: (await b.request.get(`/api/nodes/${N1.id}`)).status() };
    await b.screenshot({ path: test.info().outputPath("after-lock.png") });
    // 2. Offline edit on N2, owner locks N2 meanwhile.
    await b.goto(`${BASE}/?view=notes&node=${N2.id}`); await settle(b);
    await off(ctx, b);
    await b.locator(".cm-content").click({ force: true }); await b.keyboard.press("Control+End"); await b.keyboard.type(` B-offline-${s}`);
    await b.waitForTimeout(2500);
    out.N2_pendingOffline = String(await pendingCount(b));
    await hideFromOthers(req, N2.id);
    await on(ctx, b); await b.waitForTimeout(12_000);
    const bodyAfter = await b.locator("body").innerText().catch(() => "");
    out.N2_afterReconnect = {
      serverHasEdit: db(`select position('B-offline-${s}' in markdown) > 0 from content_nodes where id='${N2.id}'`),
      screenShowsN2: bodyAfter.includes(`Per03 N2 ${s}`) || bodyAfter.includes(`secret two ${s}`),
      recovery: (await b.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 200)),
      pending: String(await pendingCount(b)),
      toasts: await b.locator(".toast-message").allInnerTexts(),
    };
    // 3. Reload: nothing of N1/N2 in the local mirror.
    await b.reload(); await settle(b);
    const r = await b.locator("body").innerText();
    out.afterReload = { n1: r.includes(`Per03 N1 ${s}`), n2: r.includes(`Per03 N2 ${s}`), secrets: r.includes(`secret one ${s}`) || r.includes(`secret two ${s}`) };
    out.searchB = (await (await b.request.get(`/api/nodes/search?q=Per03`)).text()).includes(`${s}`);
  } finally {
    await ctx.close();
    for (const n of [N1, N2]) await req.delete(`/api/nodes/${n.id}`, H).catch(() => {});
    await req.delete(`/api/actors/${bActor.id}`, H).catch(() => {});
    console.log("PER03 " + JSON.stringify(out, null, 2));
  }
});
