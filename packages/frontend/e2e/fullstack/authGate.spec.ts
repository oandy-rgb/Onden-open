import { test, expect } from "@playwright/test";
import { BASE } from "./helpers";

// SEC#1 regression: the global auth gate (index.ts middleware) requires an actor
// for every request except a small public allowlist. An anonymous caller must
// NOT be able to read private workspace data (export/sync/events/bootstrap/tags…),
// while genuinely public surfaces (/health, /api/site, published media) stay open
// and an authenticated session keeps working. Chromium only — API-level.

test.describe("auth gate", { tag: "@critical" }, () => {
  test("anonymous cannot read private data, but public paths stay open", async ({ playwright }) => {
    // Force a truly anonymous context — explicit empty storageState so it can't
    // inherit the suite's signed-up session cookie.
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    try {
      for (const path of ["/api/bootstrap", "/api/export", "/api/sync", "/api/events", "/api/tags"]) {
        expect((await anon.get(path)).status(), `${path} must require auth`).toBe(401);
      }
      // Public surface stays open (/health isn't proxied by the e2e nginx, so we
      // assert the published-snapshot endpoint, which is the anonymous surface).
      expect((await anon.get("/api/site")).status()).not.toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test("an authenticated session still reads the workspace", async ({ page }) => {
    // default context carries the signed-up session (storageState)
    expect((await page.request.get("/api/bootstrap")).ok()).toBeTruthy();
  });
});
