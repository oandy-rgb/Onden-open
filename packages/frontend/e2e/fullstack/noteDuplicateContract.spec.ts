import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { ready, pollBootstrap, BASE, H } from "./helpers";

const headers = H.headers;

for (const width of [1280, 320]) {
  test(`NOTE-11: duplicate menu makes one complete note and survives reload (${width}px)`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 800 });
    const stamp = randomUUID();
    const parent = await (await page.request.post("/api/nodes", { headers, data: { title: `驗收-parent-${stamp}` } })).json();
    const source = await (await page.request.post("/api/nodes", { headers, data: {
      title: `驗收-copy-${stamp}`, markdown: "![media](/media/reference.png)", parent_id: parent.id,
    } })).json();
    expect((await page.request.put(`/api/nodes/${source.id}/attributes/color`, { headers, data: { value: "#aabbcc" } })).ok()).toBe(true);
    try {
      await ready(page, `/?view=notes&node=${source.id}`);
      const more = page.getByRole("button", { name: "More actions" });
      await expect(more).toBeVisible();
      await more.click();
      // Duplicate is one of the four things the ⋯ menu keeps.
      const duplicate = page.getByRole("menuitem", { name: "Duplicate" });
      await expect(duplicate).toBeVisible();
      const responsePromise = page.waitForResponse(res => res.url().endsWith(`/api/nodes/${source.id}/duplicate`) && res.request().method() === "POST");
      await duplicate.click();
      const response = await responsePromise;
      expect(response.status()).toBe(201);
      const copied = await response.json();
      expect(copied).toMatchObject({ title: `${source.title} (Copy)`, markdown: "![media](/media/reference.png)", parent_id: parent.id });
      expect((await (await page.request.get(`/api/nodes/${copied.id}/attributes`)).json()).some((row: { key: string; value: string }) => row.key === "color" && row.value === "#aabbcc")).toBe(true);
      await pollBootstrap(page, bootstrap => bootstrap.nodes.find((node: { id: string }) => node.id === copied.id));
      await page.reload({ waitUntil: "load" });
      await expect(more).toBeVisible();
      const after = await (await page.request.get(`/api/nodes/${copied.id}`)).json();
      expect(after.markdown).toBe("![media](/media/reference.png)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `/tmp/pw-output/shots/note-duplicate-${width}.png` });
      expect((await page.request.delete(`/api/nodes/${copied.id}`, { headers })).ok()).toBe(true);
    } finally {
      await page.request.delete(`/api/nodes/${source.id}`, { headers });
      await page.request.delete(`/api/nodes/${parent.id}`, { headers });
    }
  });
}
