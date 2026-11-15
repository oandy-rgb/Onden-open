import { test, expect } from "@playwright/test";
import { ready, selectNodeByTitle, H } from "./helpers";

// FEATURE [nav-back-stack] — following a backlink pushes the node you came from
// onto a back-stack; the topbar Back chevron returns to it (the #1 "no way back"
// linkage seam). Notion's back-arrow / Tana's breadcrumb return.


test("following a backlink then Back returns to the source note", async ({ page }) => {
  const stamp = Date.now();
  const tB = `Btarget ${stamp}`;
  const tA = `Asource ${stamp}`;
  // B is the target; A links to B in its body, so B's inspector lists A as a backlink.
  await page.request.post("/api/nodes", { ...H, data: { title: tB, markdown: `anchorB ${stamp}` } });
  await page.request.post("/api/nodes", { ...H, data: { title: tA, markdown: `anchorA ${stamp} — see [[${tB}]]` } });

  await ready(page);
  await selectNodeByTitle(page, tB); // open B
  const content = page.locator(".md-editor-cm .cm-content");
  await expect(content).toContainText(`anchorB ${stamp}`);

  // The inspector backlinks list A. Reveal the inspector if collapsed.
  let card = page.locator(".backlink-card", { hasText: tA }).first();
  if (!(await card.isVisible())) {
    await page.locator(".notes-inspector-toggle").first().click();
  }
  card = page.locator(".backlink-card", { hasText: tA }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click(); // follow backlink → A (pushes B onto the stack)
  await expect(content).toContainText(`anchorA ${stamp}`);

  // The browser's Back returns to B (the link was a history entry), and Forward
  // goes to A again; the top bar has no back/forward buttons.
  await page.goBack();
  await expect(content).toContainText(`anchorB ${stamp}`);
  await page.goForward();
  await expect(content).toContainText(`anchorA ${stamp}`);
  // Alt+← is the same step.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(content).toContainText(`anchorB ${stamp}`);
});
