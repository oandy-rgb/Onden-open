// Feature-audit deepening (2026-10-08): ACC-06 — same browser: owner A opens
// and searches a read-restricted note, signs out; account B (editor) signs in:
// palette recents / search, sidebar local search, launch location, events
// history, localStorage keys left behind.
import { test } from "@playwright/test";
import { ready, hideFromOthers, BASE, H } from "../fullstack/helpers";


test("ACC-06: A → sign out → B in the same browser", async ({ browser, page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const secret = await (await page.request.post("/api/nodes", { ...H, data: { title: `SecretA ${stamp}`, markdown: `private-a-${stamp}` } })).json();
  await hideFromOthers(page.request, secret.id);
  const emailB = `acc06b-${stamp}@example.com`, pwB = `pw-${stamp}-x`;
  const tmp = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await tmp.request.post("/api/auth/sign-up/email", { ...H, data: { name: `B ${stamp}`, email: emailB, password: pwB } })).json();
  await tmp.close();
  await page.request.post("/api/actors", { ...H, data: { name: `B ${stamp}`, type: "human", external_id: su.user.id } });
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const p = await ctx.newPage();
  try {
  await ready(p, `/?view=notes&node=${secret.id}&lens=editor`); await p.waitForTimeout(2000);
  await p.keyboard.press("Control+k"); await p.locator(".palette-input-wrap input").fill(`SecretA ${stamp}`); await p.waitForTimeout(1200); await p.keyboard.press("Escape");
  out.aSees = await p.getByText(`SecretA ${stamp}`).first().isVisible().catch(() => false);
  // Sign out.
  await p.getByRole("button", { name: /E2E|Account/ }).filter({ visible: true }).first().click().catch(() => {});
  await p.getByRole("button", { name: "Sign out" }).first().click().catch(() => {});
  await p.waitForTimeout(3000);
  out.signedOut = await p.getByPlaceholder("Password").isVisible().catch(() => false);
  out.lsAfterSignOut = await p.evaluate(() => Object.keys(localStorage).filter((k) => /recent|lastLocation|draft|cursor|lostWrites|search/i.test(k)));
  // Sign in as B.
  await p.getByPlaceholder("Email").fill(emailB); await p.getByPlaceholder("Password").fill(pwB);
  await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(4000);
  if (await p.getByText("Choose where to keep your data").isVisible().catch(() => false)) { await p.locator(".storage-setup-option", { hasText: "Use browser storage" }).click(); await p.waitForTimeout(3500); }
  out.bLanding = { url: p.url().replace(BASE, "").slice(0, 60), bodyHasSecret: (await p.locator("body").innerText()).includes(`private-a-${stamp}`) || (await p.locator("body").innerText()).includes(`SecretA ${stamp}`) };
  out.bLandingIsSecret = p.url().includes(secret.id);
  out.bLandingNodeStatusForB = (await p.request.get(`/api/nodes/${new URL(p.url()).searchParams.get("node")}`)).status();
  out.bLastLocationKey = await p.evaluate(() => localStorage.getItem("onden.lastLocation"));
  await p.screenshot({ path: test.info().outputPath("b-landing.png") });
  const reload = p.getByRole("button", { name: "Reload page" });
  if (await reload.isVisible().catch(() => false)) { await reload.click(); await p.waitForTimeout(4000); if (await p.getByText("Choose where to keep your data").isVisible().catch(() => false)) { await p.locator(".storage-setup-option", { hasText: "Use browser storage" }).click(); await p.waitForTimeout(3500); } }
  out.bAfterReload = { url: p.url().replace(BASE, "").slice(0, 60), isSecretUrl: p.url().includes(secret.id), shown: (await p.locator("main, .app-shell").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120), leaks: (await p.locator("body").innerText()).includes(`private-a-${stamp}`) };
  await p.locator("body").click({ position: { x: 640, y: 400 } }).catch(() => {});
  await p.keyboard.press("Escape");
  await p.keyboard.press("Control+k"); await p.waitForTimeout(800);
  if (!(await p.locator(".palette-input-wrap input").isVisible().catch(() => false))) await p.locator(".palette-trigger").first().click().catch(() => {});
  await p.waitForTimeout(500);
  out.bPaletteEmpty = (await p.locator(".palette-item, [role=option]").allInnerTexts()).some((t) => t.includes(`SecretA ${stamp}`));
  await p.locator(".palette-input-wrap input").fill(`SecretA ${stamp}`); await p.waitForTimeout(1500);
  out.bPaletteSearch = (await p.locator(".palette-item, [role=option]").allInnerTexts()).filter((t) => t.includes(`SecretA ${stamp}`) && !t.startsWith("Create")).length;
  await p.keyboard.press("Escape");
  await p.keyboard.press("Control+f"); await p.waitForTimeout(300);
  await p.getByPlaceholder(/^Search notes \(/).fill(`SecretA`).catch(() => {}); await p.waitForTimeout(1500);
  out.bSidebarSearch = await p.locator(".obsidian-page-button", { hasText: `SecretA ${stamp}` }).count();
  await p.goto(`${BASE}/?view=notes&node=${secret.id}&lens=editor`); await p.waitForTimeout(3000);
  out.bDirectUrl = { body: (await p.locator("body").innerText()).includes(`private-a-${stamp}`), title: (await p.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null)) };
  await p.goto(`${BASE}/?view=timeline`); await p.waitForTimeout(3000);
  out.bHistory = (await p.locator("body").innerText()).includes(`SecretA ${stamp}`);
  } finally {
    console.log("ACC06 " + JSON.stringify(out, null, 2));
    await ctx.close();
  }
});
