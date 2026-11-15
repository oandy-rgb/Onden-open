import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

// Mobile capture path — installable PWA + Web Share Target + one-tap capture.
//
// 1. The app shell advertises the manifest and the manifest declares a POST
//    (multipart, with images) share_target, so Android/Chrome offers Onden in
//    the system share sheet; the service worker receives it (public/sw.js).
// 2. A GET share-target arrival ("/?capture=1&text=…", what an older installed
//    manifest still sends) opens QuickCapture with the shared text prefilled
//    and the params stripped from the URL (BuilderApp consumes them once at
//    boot — see consumeSharedCapture).
// 3. At phone width the QuickCapture FAB gives one-tap capture (it sits above
//    MobileNav; MobileNav itself stays pure navigation).

test("app shell links the PWA manifest and it declares a share_target", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();
  const manifest = JSON.parse(await res.text()) as {
    name: string;
    display: string;
    start_url: string;
    icons: Array<{ src: string }>;
    share_target?: { action: string; method: string; enctype?: string; params: Record<string, unknown> };
  };
  expect(manifest.name).toBe("Onden");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(manifest.share_target?.action).toBe("/share-target");
  expect(manifest.share_target?.method).toBe("POST");
  expect(manifest.share_target?.enctype).toBe("multipart/form-data");
  expect(manifest.share_target?.params).toMatchObject({ title: "title", text: "text", url: "url" });

  // The referenced icons actually resolve (an unreachable icon silently kills
  // installability in Chrome's eligibility check).
  for (const icon of manifest.icons) {
    expect((await request.get(icon.src)).ok(), `icon ${icon.src} resolves`).toBeTruthy();
  }
});

test("share-target arrival opens QuickCapture prefilled and strips the params", async ({ page }) => {
  await ready(page, "/?capture=1&text=Hello%20shared");
  await expect(page.locator(".quick-capture-textarea")).toBeVisible();
  await expect(page.locator(".quick-capture-textarea")).toHaveValue("Hello shared");
  // Consumed exactly once: a reload must not re-open the sheet with stale text.
  expect(page.url()).not.toContain("capture=1");
  expect(page.url()).not.toContain("Hello");
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one-tap capture FAB opens QuickCapture", async ({ page }) => {
    // ready()'s desktop anchors (.view-tabs) may be hidden at phone width;
    // anchor on the mobile bottom nav instead.
    await page.goto("/?view=notes", { waitUntil: "load" });
    const opfs = page.getByText("Use browser storage", { exact: false });
    if (await opfs.count().catch(() => 0)) {
      await opfs.first().click().catch(() => {});
    }
    // The auto-retrying assertion IS the post-dismiss wait.
    await expect(page.locator(".mobile-bottom-nav")).toBeVisible();

    const capture = page.locator(".mobile-bottom-nav .mobile-nav-capture");
    await expect(capture).toBeVisible();
    await capture.click();
    await expect(page.locator(".quick-capture-textarea")).toBeVisible();
  });
});
