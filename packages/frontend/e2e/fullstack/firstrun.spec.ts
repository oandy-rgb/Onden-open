import { test, type Page } from "@playwright/test";
import { renderSettled } from "./helpers";

// First-run discoverability captures (PROBE=1): a brand-new user, no docs, no
// prompts — screenshot every decision point and every empty state. Run on a
// FRESH stack so the workspace is genuinely empty.
const S = "/tmp/pw-output/shots";
const shot = async (page: Page, name: string) => {
  await renderSettled(page); // fonts + frames flushed — replaces fixed pre-shot sleeps
  await page.screenshot({ path: `${S}/${name}.png` });
};

// A clean context: NO storageState, so we see what a stranger sees.
test.use({ storageState: { cookies: [], origins: [] } });

test("first-run captures", async ({ page }) => {
  test.skip(!process.env.PROBE, "capture only");
  test.setTimeout(180_000);
  const stamp = Date.now();
  const shell = page.locator(".view-tabs, .app-topbar").first();
  const opfsPick = page.getByText("Use browser storage", { exact: false }).first();
  const authGate = page.locator('input[type="password"]').first();

  // f1 — the very first contact: the STORAGE PICKER (it renders before auth!).
  await page.goto("/", { waitUntil: "load" });
  // Whatever first contact IS (picker or auth gate), wait for it to mount.
  await opfsPick.or(authGate).waitFor({ timeout: 30_000 });
  await shot(page, "f-01-first-contact");
  if (await opfsPick.count()) {
    await opfsPick.click();
    await authGate.waitFor({ timeout: 15_000 }).catch(() => {}); // picker dismissed → the gate
  }

  // f2 — the auth gate.
  await shot(page, "f-02-auth-gate");
  const signupToggle = page.getByText(/sign ?up|註冊|create account/i).first();
  if (await signupToggle.count()) {
    await signupToggle.click();
    await page.locator('input[type="email"], input[name*="email" i]').first().waitFor({ timeout: 5_000 }).catch(() => {}); // form swapped
  }
  // Fill whatever fields exist (email/password/name order unknown — inspect shot).
  const emailInput = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="mail" i]').first();
  const pwInput = page.locator('input[type="password"]').first();
  const nameInput = page.locator('input[name*="name" i], input[placeholder*="name" i]').first();
  if (await emailInput.count()) await emailInput.fill(`fresh${stamp}@example.com`);
  if (await nameInput.count()) await nameInput.fill("Fresh User");
  if (await pwInput.count()) await pwInput.fill("fresh-pass-12345");
  await shot(page, "f-03-signup-filled");
  await page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("註冊")').first().click();
  // Signup hands off to the storage picker OR straight to the app shell.
  await opfsPick.or(shell).waitFor({ timeout: 30_000 });

  // f4 — whatever comes next (storage picker / onboarding / landing).
  await shot(page, "f-04-after-signup");

  // Dismiss storage picker if present (capture it first — done above).
  if (await opfsPick.count()) {
    await opfsPick.click();
    await shell.waitFor({ timeout: 30_000 }); // the app proper
  }

  // f5 — the landing: what does a new user actually see first?
  await shot(page, "f-05-landing");

  // f6..n — every Places surface in its EMPTY state. The shell anchors the
  // wait; the empty states themselves have no further element to await.
  const surfaces: Array<[string, string]> = [
    ["f-06-empty-canvas", "/?view=notes&lens=canvas"],
    // (tags is no longer a place — TagsMode retired)
    ["f-08-empty-tasks", "/?view=tasks"],
    ["f-09-empty-timeline", "/?view=timeline"],
    ["f-10-empty-website", "/?view=website"],
  ];
  for (const [name, url] of surfaces) {
    await page.goto(url, { waitUntil: "load" });
    await shell.waitFor({ timeout: 30_000 });
    await shot(page, name);
  }

  // f11 — inbox empty state.
  await page.goto("/?view=notes", { waitUntil: "load" });
  await shell.waitFor({ timeout: 30_000 });
  const inboxTab = page.locator('.sidebar-tab:has-text("Inbox")');
  if (await inboxTab.count()) {
    await inboxTab.click();
    await shot(page, "f-11-empty-inbox");
  }

  // f13 — the editor with the auto-created daily note (if any): is it obvious
  // you can just type? is there a visible save?
  await page.goto("/?view=notes", { waitUntil: "load" });
  await shell.waitFor({ timeout: 30_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 15_000 }).catch(() => {}); // day-note editor (if any)
  await shot(page, "f-13-editor-day-note");
});
