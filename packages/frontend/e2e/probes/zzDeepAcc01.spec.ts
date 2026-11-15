// Feature-audit deepening (2026-10-08): ACC-01 — a fresh account: wrong
// password, correct sign-in, session expired mid-edit (cookie cleared):
// does a save look successful, what is shown; sign-out then Back.
import { test } from "@playwright/test";
import { BASE, H, syncLabel } from "../fullstack/helpers";


test("ACC-01: wrong password, expired session mid-edit, sign-out + Back", async ({ browser, page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const email = `acc01-${stamp}@example.com`, pw = `pw-${stamp}-x`;
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  const su = await (await p.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Acc ${stamp}`, email, password: pw } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `Acc ${stamp}`, type: "human", external_id: su.user.id } });
  await ctx.clearCookies();
  try {
  await p.goto(`${BASE}/?view=notes`); await p.waitForTimeout(2500);
  await p.getByPlaceholder("Email").fill(email);
  await p.getByPlaceholder("Password").fill("wrong-password");
  await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(2000);
  out.wrongPassword = { stillLogin: await p.getByPlaceholder("Password").isVisible(), message: (await p.locator(".login-card").innerText()).replace(/\s+/g, " ").match(/(invalid|incorrect|wrong|錯誤)[^.]*/i)?.[0] ?? (await p.locator(".login-card").innerText()).replace(/\s+/g, " ").slice(-120) };
  await p.getByPlaceholder("Password").fill(pw);
  await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(5000);
  if (await p.getByText("Choose where to keep your data").isVisible().catch(() => false)) { await p.locator(".storage-setup-option", { hasText: "Use browser storage" }).click().catch(() => {}); await p.waitForTimeout(3000); }
  await p.screenshot({ path: test.info().outputPath("after-signin.png") });
  out.signedIn = { url: p.url().replace(BASE, "").slice(0, 40), workspace: await p.locator(".app-topbar").isVisible().catch(() => false) };
  // Expire the session mid-edit.
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `AccNote ${stamp}`, markdown: "start" } })).json();
  await p.goto(`${BASE}/?view=notes&node=${n.id}&lens=editor`); await p.waitForTimeout(3000);
  await p.locator(".cm-content").first().click(); await p.keyboard.press("Control+End"); await p.keyboard.type(" typed-after-expiry");
  await ctx.clearCookies();
  await p.keyboard.press("Control+s"); await p.waitForTimeout(3000);
  out.expired = { server: ((await (await page.request.get(`/api/nodes/${n.id}`)).json()).markdown as string).includes("typed-after-expiry"), editorKept: (await p.locator(".cm-content").first().innerText().catch(() => "")).includes("typed-after-expiry"), toast: (await p.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-140), sync: (await syncLabel(p)).replace(/\s+/g, " "), loginShown: await p.getByPlaceholder("Password").isVisible().catch(() => false) };
  await p.reload(); await p.waitForTimeout(3000);
  out.afterReload = { loginShown: await p.getByPlaceholder("Password").isVisible().catch(() => false), privateTitleVisible: await p.getByText(`AccNote ${stamp}`).first().isVisible().catch(() => false) };
  // Sign back in: does the queued text go through?
  if (out.afterReload && (out.afterReload as { loginShown: boolean }).loginShown) {
    await p.getByPlaceholder("Email").fill(email); await p.getByPlaceholder("Password").fill(pw);
    await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(6000);
    out.afterResignIn = { server: ((await (await page.request.get(`/api/nodes/${n.id}`)).json()).markdown as string).includes("typed-after-expiry"), recovery: (await p.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80) };
  }
  // Sign out via the account panel, then Back.
  await p.getByRole("button", { name: /Acc |Account|^A$/ }).filter({ visible: true }).first().click().catch(() => {});
  await p.waitForTimeout(500);
  const so = p.getByRole("button", { name: "Sign out" }).first();
  out.signOutFound = await so.count();
  if (await so.count()) { await so.click(); await p.waitForTimeout(3000); }
  out.afterSignOut = { login: await p.getByPlaceholder("Password").isVisible().catch(() => false) };
  await p.goBack().catch(() => {}); await p.waitForTimeout(2500);
  out.afterBack = { login: await p.getByPlaceholder("Password").isVisible().catch(() => false), privateTitleVisible: await p.getByText(`AccNote ${stamp}`).first().isVisible().catch(() => false) };
  } finally {
    console.log("ACC01 " + JSON.stringify(out, null, 2));
    await ctx.close();
  }
});
