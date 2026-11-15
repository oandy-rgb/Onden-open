// Feature-audit deepening (2026-10-09, tick 47): ACC-06 — a background
// producer across an account switch. The owner types a website tagline (the
// settings autosave is debounced) and signs out at once; user B signs in on
// the same browser. Where does the owner's input end up — saved as the owner,
// lost, sent with B's session, or visible to B in recovery?
import { test } from "@playwright/test";
import { ready, BASE, H, psql as db, pendingCount } from "../fullstack/helpers";


test("ACC-06: website settings autosave across sign-out / sign-in", async ({ browser }) => {
  test.setTimeout(300_000);
  // The owner signs out below: do it on a session of its own, never the shared
  // storage-state session every later spec runs on (global-setup's account).
  const ownerCtx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signIn = await ownerCtx.request.post("/api/auth/sign-in/email", {
    ...H, data: { email: process.env.E2E_OWNER_EMAIL || "e2e-owner@example.com", password: process.env.E2E_OWNER_PASSWORD || "e2e-pass-12345" },
  });
  if (!signIn.ok()) throw new Error(`owner sign-in failed: ${signIn.status()}`);
  const page = await ownerCtx.newPage();
  const out: Record<string, unknown> = {}; const s = Date.now();
  const owner = page.request;
  const cfg0 = (await (await owner.get("/api/workspace/config")).json()).config ?? {};
  const marker = `tagline-${s}`;
  const writes: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/workspace/config") && r.method() === "PATCH") writes.push(`${Date.now() - s}ms ${(r.postData() ?? "").slice(0, 80)}`); });
  page.on("response", (r) => { if (r.url().includes("/api/workspace/config") && r.request().method() === "PATCH") writes.push(`  → ${r.status()}`); });
  const maxEv = Number(db("select max(id) from domain_events"));
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, "/?view=website");
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(2500);
    await page.waitForTimeout(800); // the site settings are the 屬性 panel while nothing is selected
    await page.getByLabel("一句話介紹").fill(marker);
    // Sign out immediately via the account menu.
    await page.locator("button").filter({ hasText: /^E\s*E2E$|E2E/ }).filter({ visible: true }).first().click().catch(() => {});
    await page.getByRole("button", { name: /^Sign out$/ }).filter({ visible: true }).first().click({ timeout: 5000 }).catch((e) => { out.signoutClickErr = String(e).slice(0, 80); });
    await page.waitForTimeout(5000);
    out.afterSignOut = { loginShown: await page.getByPlaceholder("Password").isVisible().catch(() => false), writes: [...writes] };
    // B signs up / in on the same browser context.
    const email = `acc06b-${s}@example.com`, pw = `pw-${s}-x`;
    const su = await (await page.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Acc06b ${s}`, email, password: pw } })).json();
    out.bSignedUp = !!su.user;
    await page.goto(`${BASE}/?view=website`);
    const choose = page.getByRole("button", { name: /Use browser storage/ });
    await choose.or(page.locator(".obsidian-title-input, .hs-studio")).first().waitFor({ timeout: 60_000 }).catch(() => {});
    if (await choose.isVisible().catch(() => false)) await choose.click();
    await page.waitForTimeout(8000);
    out.asB = {
      writes: [...writes],
      recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)),
      bodyHasMarker: (await page.locator("body").innerText()).includes(marker),
      pending: String(await pendingCount(page)),
    };
    out.server = {
      tagline: db("select value from node_attributes a join content_nodes n on n.id=a.node_id where n.title='Site Config' and n.deleted_at is null and a.key='tagline' limit 1"),
      events: db(`select string_agg(e.event_type||' by '||coalesce(a.name,e.actor_id), ', ') from domain_events e left join actors a on a.id::text=e.actor_id where e.id>${maxEv} and e.event_type='SITE_CONFIG_UPDATED'`),
    };
    const bId = db(`select id from actors where name='Acc06b ${s}'`); if (bId) out.bActor = bId.slice(0, 8);
    // Owner signs back in on the same browser: is the tagline recovered / resent?
    await page.context().clearCookies();
    await page.request.post("/api/auth/sign-in/email", { ...H, data: { email: "e2e-owner@example.com", password: "e2e-pass-12345" } });
    await page.goto(`${BASE}/?view=website`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(6000);
    await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(6000);
    await page.waitForTimeout(800);
    out.ownerBack = {
      writes: writes.slice(2),
      recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)),
      pending: String(await pendingCount(page)),
      taglineField: await page.getByLabel("一句話介紹").inputValue().catch(() => null),
      server: db("select value from node_attributes a join content_nodes n on n.id=a.node_id where n.title='Site Config' and n.deleted_at is null and a.key='tagline' limit 1"),
    };
  } finally {
    // Restore the owner's tagline through a fresh owner session.
    const oc = await browser.newContext({ baseURL: BASE });
    await oc.request.post("/api/auth/sign-in/email", { ...H, data: { email: "e2e-owner@example.com", password: "e2e-pass-12345" } });
    await oc.request.patch("/api/workspace/config", { ...H, data: { config: { tagline: cfg0.tagline ?? null } } }).catch(() => {});
    const bId = db(`select id from actors where name='Acc06b ${s}'`);
    if (bId) await oc.request.delete(`/api/actors/${bId}`, H).catch(() => {});
    await oc.close();
    await ownerCtx.close();
    console.log("ACC06B " + JSON.stringify(out, null, 2));
  }
});
