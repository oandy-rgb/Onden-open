// Feature-audit deepening (2026-10-08): PER-05 — two devices (same account)
// on one note: concurrent body edits on different and on the same line, the
// same property set to different values, tag apply vs. remove, and a refused
// property change that must not undo the other device's change.
import { test, type Page, type BrowserContext } from "@playwright/test";
import { ready, BASE, H, PAGE } from "../fullstack/helpers";


test("PER-05: two devices, text / property / tag / refusal", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `p05t${stamp}`, fields: [{ name: "stage", type: "text" }, { name: "owner", type: "text" }] } })).json();
  const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Two ${stamp}`, markdown: "line1\nline2\nline3" } })).json()).id as string;
  await page.request.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} });
  const devB: BrowserContext = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const pb = await devB.newPage();
  const server = async () => { const n = await (await page.request.get(`/api/nodes/${id}`)).json(); const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json(); const list = Array.isArray(at) ? at : at.attributes ?? []; return { md: n.markdown, stage: list.find((a: { key: string }) => a.key === "stage")?.value ?? null, owner: list.find((a: { key: string }) => a.key === "owner")?.value ?? null, tags: (n.class_tag_ids ?? []).length }; };
  const editor = (p: Page) => p.locator(".cm-content").first().innerText().then((t) => t.replace(/\n/g, "⏎")).catch(() => "?");
  const appendLine = async (p: Page, lineText: string, add: string) => { await p.locator(".cm-line", { hasText: lineText }).first().click(); await p.keyboard.press("End"); await p.keyboard.type(add); };
  try {
  await ready(page, `/?view=notes&node=${id}&lens=editor`); await ready(pb, `/?view=notes&node=${id}&lens=editor`);
  await page.waitForTimeout(2500); await pb.waitForTimeout(1000);
  // Different lines at the same time.
  await appendLine(page, "line1", " A");
  await appendLine(pb, "line3", " B");
  await page.waitForTimeout(5000); await pb.waitForTimeout(500);
  out.diffLines = { server: (await server()).md, editorA: await editor(page), editorB: await editor(pb) };
  // Same line.
  await appendLine(page, "line2", " AA");
  await appendLine(pb, "line2", " BB");
  await page.waitForTimeout(5000);
  out.sameLine = { server: (await server()).md, editorA: await editor(page), editorB: await editor(pb) };
  // One more edit on A after both: does it keep B's text?
  await appendLine(page, "line1", " A2");
  await page.waitForTimeout(4000);
  out.followUpA = { server: (await server()).md };
  // Property: same key, different values via the API from each device's request context.
  await page.request.put(`/api/nodes/${id}/attributes/stage`, { ...H, data: { value: "fromA", value_type: "text" } });
  await pb.request.put(`/api/nodes/${id}/attributes/stage`, { ...H, data: { value: "fromB", value_type: "text" } });
  await page.waitForTimeout(4000);
  const insp = async (p: Page) => (await p.locator(".ov-prop-row, .attr-row, [class*=attribute]").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").match(/stage[^|]{0,30}/)?.[0] ?? null;
  out.property = { server: (await server()).stage, inspectorA: await insp(page), inspectorB: await insp(pb) };
  // Refused property change on A must not undo B's owner change.
  await pb.request.put(`/api/nodes/${id}/attributes/owner`, { ...H, data: { value: "Bob", value_type: "text" } });
  await page.route(`**/api/nodes/${id}/attributes/**`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const ownerField = page.locator(".ov-prop-row, .attr-row").filter({ hasText: "owner" }).locator("input, [contenteditable=true], button").first();
  out.ownerFieldFound = await ownerField.count();
  if (await ownerField.count()) {
    await ownerField.click().catch(() => {});
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.type("Alice"); await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
  }
  await page.unroute(`**/api/nodes/${id}/attributes/**`);
  out.refusal = { server: await server(), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-120) };
  // Tag apply vs. remove.
  await page.request.delete(`/api/nodes/${id}/tags/${tag.id}`, { headers: PAGE });
  await page.waitForTimeout(4000);
  out.tagRemovedSeenByB = { server: (await server()).tags, bChip: await pb.locator(".tag-chip, .note-tag, [class*=tag-chip]").filter({ hasText: `p05t${stamp}` }).count() };
  } finally {
    console.log("PER05 " + JSON.stringify(out, null, 2));
    await devB.close();
  }
});
