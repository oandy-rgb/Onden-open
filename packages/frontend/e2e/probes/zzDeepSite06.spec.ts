// Feature-audit deepening (2026-10-07): SITE-06 — publish scope: "+ subtree",
// a note in a space that cannot publish, who may publish, media on published
// pages. Since spaces, a child always shares its
// parent's space, so a "read-gated child" cannot exist; the gated note is a
// separate root note moved to an owner-only space (publishing off).
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, openPublishRow, defaultSpaceId, createPublishingSpace, hideFromOthers, addToDefaultSpace, BASE, H, publishRequest } from "../fullstack/helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("SITE-06: subtree scope with a read-gated child, publish permissions, media", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const anon = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const site = async () => await (await anon.get("/api/site")).text();
  // Root notes go to the default space (the editor can read it, it does not publish) unless a space is given: the
  // published tree lives in a space whose publish switch is on.
  const space_id = await defaultSpaceId(page.request);
  const siteSpace = await createPublishingSpace(page.request);
  const mk = async (title: string, md: string, parent?: string, space = space_id) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: md, ...(parent ? { parent_id: parent } : { space_id: space }) } })).json()).id as string;
  const media = await (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `p${s}.png`, mimeType: "image/png", buffer: PNG } } })).json();
  const root = await mk(`PubRoot ${s}`, `root ![pic](${media.url})`, undefined, siteSpace);
  const open = await mk(`PubOpen ${s}`, `open-${s}`, root);
  const gated = await mk(`PubGated ${s}`, `gated-${s}`);
  await hideFromOthers(page.request, gated);
  void open;

  // "+ subtree" through the UI as the owner.
  await ready(page, `/?view=notes&node=${root}`);
  await page.waitForTimeout(1000);
  const { subtree: sub } = await openPublishRow(page);
  out.subtreeButton = JSON.stringify(await sub.innerText().catch(() => "none"));
  if (await sub.count()) await sub.click();
  await publishRequest(page.request, {}); // the space publishes: the tree is on the site from the next publish
  await page.waitForTimeout(2500);
  const sNow = await site();
  out.subtree = `root=${sNow.includes(`PubRoot ${s}`)} open=${sNow.includes(`open-${s}`)} gated=${sNow.includes(`gated-${s}`)}`;
  const gatedAttr = (await (await page.request.get(`/api/nodes/${gated}/attributes`, H)).json() as Array<{ key: string }>).some((a) => a.key === "_published");
  out.gatedMarkedPublished = String(gatedAttr);
  // Even if explicitly marked, a note in a space without publish must not reach the public site.
  await page.request.put(`/api/nodes/${gated}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  out.gatedAfterExplicitMark = String((await site()).includes(`gated-${s}`));

  // Media on a published page is anonymously readable (bundled or allowed).
  const img = await anon.get(media.url);
  out.publishedMedia = `${img.status()}`;

  // Who may publish: an editor marking a readable note, and a note they cannot read.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `S06 ${s}`, email: `s06-${s}@example.com`, password: `pw-${s}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `S06 ${s}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const edNote = await mk(`EdPub ${s}`, `edpub-${s}`);
  const e1 = await human.request.put(`/api/nodes/${edNote}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  const hidden = await mk(`HiddenPub ${s}`, `hiddenpub-${s}`);
  await hideFromOthers(page.request, hidden);
  const e2 = await human.request.put(`/api/nodes/${hidden}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  const s2 = await site();
  out.editorPublish = `readable=${e1.status()} onSite=${s2.includes(`edpub-${s}`)} unreadable=${e2.status()} onSite=${s2.includes(`hiddenpub-${s}`)}`;
  const e3 = await publishRequest(human.request, { title: `ed ${s}` });
  out.editorSnapshot = String(e3.status());
  await human.close();

  await anon.dispose();
  console.log(`AUDIT SITE-06 ${JSON.stringify(out)}`);
});
