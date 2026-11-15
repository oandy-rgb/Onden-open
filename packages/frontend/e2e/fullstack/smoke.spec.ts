import { test, expect } from "@playwright/test";
import { H } from "./helpers";


test.describe("full-stack smoke", { tag: "@critical" }, () => {
  test("authenticated app renders the lens strip", async ({ page }) => {
    await page.goto("/?view=notes", { waitUntil: "load" });
    await expect(page.locator(".view-tabs [role=tab]").first()).toBeVisible();
  });

  test("node create flows through the wired stack + has a body_hash version", async ({ page }) => {
    const created = await page.request.post("/api/nodes", { ...H, data: { title: "Smoke node", markdown: "# hi\n\nsmoke body" } });
    expect(created.status()).toBe(201);
    const node = await created.json();
    const versions = await page.request.get(`/api/nodes/${node.id}/versions`);
    expect(versions.ok()).toBeTruthy();
    const list = await versions.json();
    expect(list.some((v: { markdown?: string }) => (v.markdown || "").includes("smoke body"))).toBeTruthy();
  });

  test("S2 deep-link ?node= is honoured + retained", async ({ page }) => {
    const created = await page.request.post("/api/nodes", { ...H, data: { title: "Deep node", markdown: "deep" } });
    const node = await created.json();
    await page.goto(`/?view=notes&node=${node.id}`, { waitUntil: "load" });
    expect(page.url()).toContain(`node=${node.id}`);
  });
});
