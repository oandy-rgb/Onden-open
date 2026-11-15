import { chromium } from "@playwright/test";

// Sign up a throwaway user (emailAndPassword signup is open) and dismiss the
// first-run storage picker (choose browser OPFS — the folder option opens a
// native dialog Playwright can't drive), then persist cookies + localStorage so
// every spec starts authenticated and inside the workspace.
export default async function globalSetup() {
  const base = process.env.E2E_BASE || "http://localhost:5099";
  // FIXED account, sign-in first: a fresh stack's first signup becomes the
  // owner, and every later invocation signs back into that SAME owner. The
  // old `e2e_${Date.now()}` scheme minted a new (editor) user per playwright
  // invocation, so owner-gated specs (publish/config) silently skipped unless
  // the stack volume was reset between runs.
  const email = "e2e-owner@example.com";
  const password = "e2e-pass-12345";

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: base });

  const authHeaders = { origin: base, "content-type": "application/json" };
  const signin = await ctx.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: authHeaders,
  });
  if (!signin.ok()) {
    const signup = await ctx.request.post("/api/auth/sign-up/email", {
      data: { email, password, name: "E2E" },
      headers: authHeaders,
    });
    if (!signup.ok()) throw new Error(`signup failed: ${signup.status()} ${await signup.text()}`);
  }

  const page = await ctx.newPage();
  await page.goto("/?view=notes", { waitUntil: "load" });
  // The app mounts asynchronously after `load` (SSE keeps networkidle from ever
  // firing, so we can't use it). Wait for whichever surfaces first: the app
  // shell, or the first-run storage picker — then dismiss the picker if it won.
  const shell = page.locator(".app-topbar nav").first();
  const opfs = page.getByText("Use browser storage", { exact: false }).first();
  await shell.or(opfs).waitFor({ timeout: 30_000 });
  if (await opfs.isVisible().catch(() => false)) {
    await opfs.click();
  }
  await shell.waitFor({ state: "visible", timeout: 20_000 });
  // Module library: a fresh workspace imports nothing, so the suite's
  // workspace imports every shipped module once (specs that exercise the
  // library itself remove and re-import modules explicitly).
  for (const module of ["review", "rss", "website", "daily", "ai"]) {
    const res = await ctx.request.patch("/api/workspace/modules", { data: { module, imported: true }, headers: authHeaders });
    if (!res.ok()) throw new Error(`importing module ${module} failed: ${res.status()} ${await res.text()}`);
  }

  // Pre-dismiss the first-run welcome banner so it doesn't overlay the editor
  // for the whole suite (a dedicated spec re-enables it to test it).
  await page.evaluate(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  // The offline warm-up's mark says this device's service worker holds the
  // lazily loaded screens; each spec's context starts with an empty worker
  // cache, so it must not start with the mark (lib/offlineWarmup.ts).
  await page.evaluate(() => localStorage.removeItem("onden.offlineWarmBuild"));
  // Every spec starts on one pane: side by side is an account pref with a device copy (helpers closeSideBySide).
  const onePane = await page.request.put("/api/me/prefs/splitPane", { headers: { origin: new URL(page.url()).origin, "content-type": "application/json" }, data: { value: null } });
  if (!onePane.ok()) throw new Error(`clearing side by side failed: ${onePane.status()} ${await onePane.text()}`);
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("onden.splitPane")) localStorage.removeItem(key); });

  await ctx.storageState({ path: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  await browser.close();
}
