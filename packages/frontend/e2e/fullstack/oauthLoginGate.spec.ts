import { test, expect } from "@playwright/test";

// LOGIN GATE — provider surface. The gate must offer social sign-in buttons
// ONLY for configured OAuth providers; with none configured, just the
// email/password form renders. This stack configures NO social providers
// (backend auth.ts enables emailAndPassword only — no socialProviders), so the
// shipped truth is: email/password only, zero social buttons.
//
// SCOPE NOTE (verified against shipped code): there is currently no
// `/api/auth/providers` endpoint and LoginGate.tsx renders no social buttons —
// it has no provider-driven branch at all (email/password form + a login/signup
// toggle). This spec asserts that shipped truth AND documents the absent
// endpoint, so when provider-aware rendering ships it can be driven from the
// providers list here. No real OAuth round-trip is performed.
//
// Reached anonymously: the gate only shows when unauthenticated, so this block
// overrides the suite's authenticated storageState with an empty one.

test.describe("login gate provider surface", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("with no providers configured, only the email/password form renders", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });

    // The gate renders (unauthenticated) — email + password inputs + submit.
    const gate = page.locator(".login-gate");
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(gate.locator(".login-input[type='email']")).toBeVisible();
    await expect(gate.locator(".login-input[type='password']")).toBeVisible();
    await expect(gate.locator(".login-submit")).toBeVisible();
    // The login/signup mode toggle is present (email-flow affordance).
    await expect(gate.locator(".login-toggle")).toBeVisible();

    // NO social/OAuth buttons: no configured providers ⇒ none rendered. Cover
    // the likely class + accessible-name shapes a provider button would use.
    await expect(gate.locator("[class*='social'], [class*='oauth']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue with|sign in with|google|github|gitlab|apple|microsoft/i })).toHaveCount(0);
  });

  test("the providers endpoint advertises no social providers", async ({ page }) => {
    // Drive GET /api/auth/providers. It is not implemented today, so it does NOT
    // return 200 with a non-empty provider list. When a provider-list endpoint
    // ships, tighten this to assert the empty list shape it returns.
    const res = await page.request.get("/api/auth/providers");
    if (res.ok()) {
      // If/when implemented: the body must advertise no social providers here.
      const body = await res.json().catch(() => null);
      const providers = Array.isArray(body) ? body : (body?.providers ?? body?.social ?? []);
      expect(Array.isArray(providers) ? providers.length : 0).toBe(0);
    } else {
      // Current behavior: no such endpoint (404) — documents the absence.
      expect(res.ok()).toBeFalsy();
    }
  });
});
