// Per-page SEO meta override (beat-Notion): a published note's frontmatter
// `description:` overrides the auto first-paragraph in the served <head>.
import { test, expect } from "@playwright/test";
import { createPublishingSpace, publishSite, H } from "./helpers";


test("a note's frontmatter description overrides the auto page description", async ({ page }) => {
  const stamp = Date.now();
  const md = `---\ndescription: Hand-written SEO blurb ${stamp}\n---\n\n# Heading\n\nThe first body paragraph ${stamp} that would otherwise be the description.`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `Meta ${stamp}`, markdown: md } })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page.request); // snapshot model B

  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  // the frontmatter description wins…
  expect(html).toContain(`content="Hand-written SEO blurb ${stamp}"`);
  // …and the first body paragraph is NOT used as the meta description
  expect(html).not.toContain(`content="The first body paragraph ${stamp}`);
});

test("without frontmatter, the first body paragraph is still used (frontmatter skipped)", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `MetaAuto ${stamp}`, markdown: `# H\n\nAuto paragraph ${stamp} as description.` } })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page.request);
  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain(`Auto paragraph ${stamp} as description.`);
});
