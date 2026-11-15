// Feature-audit deepening (2026-10-07): TOKEN-02 — mint from each template via
// the actors drawer; fixed tool sets; plaintext shown once; copy; failure keeps
// the form and does not mint; desktop and phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

const EXPECTED: Record<string, string[]> = {
  "read-only": ["searchNodes", "getNode", "getAttachment", "semanticSearch", "suggestLinks", "queryView"],
  organizer: ["searchNodes", "getNode", "getAttachment", "semanticSearch", "suggestLinks", "queryView", "applyTag", "removeTag", "updateNode"],
  researcher: ["searchNodes", "getNode", "getAttachment", "semanticSearch", "suggestLinks", "queryView", "applyTag", "removeTag", "updateNode", "createNode", "proposeTagPack"],
  publisher: ["searchNodes", "getNode", "getAttachment", "semanticSearch", "suggestLinks", "queryView", "applyTag", "removeTag", "updateNode", "createNode", "proposeTagPack", "publishSite"],
};

async function openTokens(page: Page, agentName: string) {
  const menuBtn = page.locator(".user-menu-wrap button").filter({ visible: true }).first();
  if (await menuBtn.count()) await menuBtn.click();
  else await page.locator(".mobile-nav-btn", { hasText: "More" }).click();
  await page.getByText("Manage Users").filter({ visible: true }).first().click();
  await expect(page.locator(".actors-table").filter({ visible: true }).first()).toBeVisible();
  const row = page.locator("tr", { hasText: agentName }).first();
  await row.locator(".actors-tokens-btn").click();
  await expect(page.locator(".token-mint-form")).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`TOKEN-02 @${viewport.width}px: templates, plaintext once, copy, failure keeps form`, async ({ browser, page: base }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport, baseURL: BASE,
      permissions: ["clipboard-read", "clipboard-write"] });
    const page = await ctx.newPage();
    const stamp = Date.now();
    const agentName = `T02 ${viewport.width} ${stamp}`;
    const agent = await (await page.request.post("/api/actors", { ...H, data: { name: agentName, type: "agent" } })).json();
    await ready(page, "/?view=notes");
    const opened = await openTokens(page, agentName).then(() => true).catch((e) => { console.log(`AUDIT TOKEN-02 ${viewport.width} open drawer failed: ${String(e).slice(0, 160)}`); return false; });
    await page.screenshot({ path: `/tmp/pw-output/token02-${viewport.width}.png`, fullPage: true });
    if (!opened) { await ctx.close(); return; }

    const results: Record<string, string> = {};
    for (const template of Object.keys(EXPECTED)) {
      await page.locator(".token-mint-template").selectOption(template);
      await page.locator(".token-mint-name").fill(`${template} ${stamp}`);
      await page.locator(".token-mint-btn").click();
      const plain = page.locator(".token-fresh-plain");
      await expect(plain).toBeVisible();
      const shown = (await plain.textContent()) ?? "";
      await page.getByRole("button", { name: "Copy" }).click();
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "unreadable");
      await page.getByText("Done").click();
      const stillShown = await page.locator(".token-fresh-plain").count();
      const tokens = await (await page.request.get(`/api/actors/${agent.id}/tokens`, H)).json() as Array<{ name: string; allowed_tools: string[] } & Record<string, unknown>>;
      const row = tokens.find((tk) => tk.name === `${template} ${stamp}`)!;
      const same = JSON.stringify([...row.allowed_tools].sort()) === JSON.stringify([...EXPECTED[template]].sort());
      const apiLeaks = JSON.stringify(tokens).includes(shown);
      results[template] = `toolsMatch=${same} copied=${clip === shown} hiddenAfterDone=${stillShown === 0} apiLeaksPlain=${apiLeaks}`;
    }

    // Failure: 503 on mint keeps template + name and shows an error; no token created.
    const before = (await (await page.request.get(`/api/actors/${agent.id}/tokens`, H)).json()).length;
    await page.route(`**/api/actors/${agent.id}/tokens`, (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: JSON.stringify({ error: "unavailable" }) }) : r.continue());
    await page.locator(".token-mint-template").selectOption("organizer");
    await page.locator(".token-mint-name").fill(`fail ${stamp}`);
    await page.locator(".token-mint-btn").click();
    await expect(page.locator(".token-error")).toBeVisible();
    const keptName = await page.locator(".token-mint-name").inputValue();
    const keptTemplate = await page.locator(".token-mint-template").inputValue();
    const after = (await (await page.request.get(`/api/actors/${agent.id}/tokens`, H)).json()).length;
    await page.unroute(`**/api/actors/${agent.id}/tokens`);
    await page.locator(".token-mint-btn").click();
    await expect(page.locator(".token-fresh-plain")).toBeVisible();
    const final = (await (await page.request.get(`/api/actors/${agent.id}/tokens`, H)).json()) as Array<{ name: string }>;
    results.failure = `error=${await page.locator(".token-error").count()} keptName=${keptName === `fail ${stamp}`} keptTemplate=${keptTemplate === "organizer"} createdOn503=${after - before} retryCreated=${final.filter((tk) => tk.name === `fail ${stamp}`).length}`;
    const mintBox = await page.locator(".token-mint-btn").boundingBox();
    results.layout = `mintBtn=${mintBox ? `${Math.round(mintBox.width)}x${Math.round(mintBox.height)}` : "none"} docWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`;
    console.log(`AUDIT TOKEN-02 ${viewport.width}px ${JSON.stringify(results)}`);
    await page.screenshot({ path: `/tmp/pw-output/token02-${viewport.width}-done.png`, fullPage: true });
    await ctx.close();
  });
}
