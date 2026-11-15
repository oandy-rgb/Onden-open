import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// D5 — settable landing (today / home / resume-last) + the home node's
// auto-content strip. Contracts pinned:
//   • landing follows the per-user setting;
//   • a ?node= deep link ALWAYS wins (non-clobbering);
//   • the home node renders the auto strip (today button etc.) above its body.

test("landing setting 'home' opens the home node with its auto-content strip", async ({ page }) => {
  const stamp = Date.now();
  const home = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Start here ${stamp}`, markdown: "## My MOC\n\nhand-authored part" },
  })).json();
  const patched = await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } });
  expect(patched.ok(), `PATCH /api/workspace → ${patched.status()}: ${await patched.text()}`).toBeTruthy();

  await page.addInitScript(() => localStorage.setItem("home.landing", "home"));
  await ready(page, "/");
  await expect(page).toHaveURL(new RegExp(`node=${home.id}`));
  const strip = page.locator(".home-start");
  await expect(strip).toBeVisible();
  await expect(strip.getByText("Open today's note")).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/shots/home-start.png" });

  // The strip's today button is a real door.
  await strip.getByText("Open today's note").click();
  await expect(page).not.toHaveURL(new RegExp(`node=${home.id}`));
});

test("landing setting 'resume' restores the last location", async ({ page }) => {
  const stamp = Date.now();
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Resume me ${stamp}`, markdown: "left off here" },
  })).json();

  await page.addInitScript((nodeId) => {
    localStorage.setItem("home.landing", "resume");
    // The last location is kept per account (lib/prefs: scope "account", key
    // `onden.lastLocation:account-v1:<account>`); the saved session already
    // holds one, which wins over the unscoped key — set that one.
    const at = `?view=notes&node=${nodeId}&lens=editor`;
    localStorage.setItem("onden.lastLocation", at);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("onden.lastLocation:account-v1:")) localStorage.setItem(key, at);
    }
  }, note.id);
  await ready(page, "/");
  await expect(page).toHaveURL(new RegExp(`node=${note.id}`));
});

test("a deep link always beats the landing setting (non-clobbering)", async ({ page }) => {
  const stamp = Date.now();
  const target = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Deep link ${stamp}`, markdown: "x" },
  })).json();

  await page.addInitScript(() => localStorage.setItem("home.landing", "home"));
  await ready(page, `/?view=notes&node=${target.id}`);
  await expect(page).toHaveURL(new RegExp(`node=${target.id}`));
});
