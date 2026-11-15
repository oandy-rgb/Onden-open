// Feature-audit deepening (2026-10-07): FIND-05 — pointers: product entry
// (sidebar context menu → pin picker), duplicate pin, target/parent lifecycle,
// unpin retry under 503, and scope for another human.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "../fullstack/helpers";

const pointers = async (page: Page, target: string) =>
  (((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).pointers ?? []) as Array<{ id: string; target_id: string; parent_id: string | null }>).filter((p) => p.target_id === target);

test("FIND-05: pin via UI, duplicates, lifecycle, unpin retry, scope", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const s = Date.now(); const out: Record<string, string> = {};
  // Default space: the second human below must be able to see these.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (t: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: t, space_id } })).json()).id as string;
  const target = await mk(`PinTarget ${s}`), parent = await mk(`PinParent ${s}`), decoy = await mk(`PinParent ${s} decoy`);
  void decoy;

  // Product entry: right-click the target in the sidebar → "Pin under another
  // note…" → the pin picker (D101: it was a window.prompt that took any title,
  // tags too, and pinned at the root on a blank answer).
  const pinViaPicker = async () => {
    await page.locator(".obsidian-page-button", { hasText: `PinTarget ${s}` }).first().click({ button: "right" });
    await page.getByText("Pin under another note…").click();
    const picker = page.getByRole("dialog", { name: /PinTarget/ });
    await picker.getByRole("combobox").fill(`PinParent ${s}`);
    await picker.getByRole("option").filter({ has: page.locator(".move-to-label", { hasText: new RegExp(`^PinParent ${s}$`) }) }).click();
    await page.waitForTimeout(1500);
  };
  await ready(page, `/?view=notes&node=${target}`);
  await pinViaPicker();
  let ps = await pointers(page, target);
  out.uiPin = `count=${ps.length} parentIsExact=${ps[0]?.parent_id === parent}`;
  // Same pin again via UI: 409 treated as "exists", still one pointer.
  await pinViaPicker();
  out.duplicatePin = `count=${(await pointers(page, target)).length} notices=${JSON.stringify((await page.locator(".toast, [role='alert']").allInnerTexts()).slice(-1))}`;

  // Lifecycle: target deleted → pointer hidden? undelete → back. Parent deleted → pointer?
  await page.request.delete(`/api/nodes/${target}`, H);
  out.targetDeleted = `pointersInBootstrap=${(await pointers(page, target)).length}`;
  await page.request.post(`/api/nodes/${target}/undelete`, H);
  out.targetRestored = `pointersInBootstrap=${(await pointers(page, target)).length}`;
  await page.request.delete(`/api/nodes/${parent}`, H);
  out.parentDeleted = `pointersInBootstrap=${JSON.stringify((await pointers(page, target)).map((p) => p.parent_id === parent))}`;
  await page.request.post(`/api/nodes/${parent}/undelete`, H);
  ps = await pointers(page, target);

  // Unpin with the first DELETE failing 503 → queued, lands later.
  await ready(page, `/?view=notes&node=${parent}`);
  let first = true;
  await page.route("**/api/pointers/*", (r) => { if (r.request().method() === "DELETE" && first) { first = false; return r.fulfill({ status: 503, body: "{}" }); } return r.continue(); });
  const pinnedRow = page.locator(".obsidian-page-button", { hasText: `PinTarget ${s}` });
  out.pinnedRowsInSidebar = String(await pinnedRow.count());
  const unpinVia = page.getByText(/Unpin|Remove pin|移除釘選/).first();
  if (await pinnedRow.count() > 1) {
    await pinnedRow.last().click({ button: "right" });
    out.unpinMenu = String(await unpinVia.count());
    if (await unpinVia.count()) await unpinVia.click();
  } else if (ps[0]) {
    out.unpinMenu = "api";
    await page.evaluate(async (id) => { await fetch(`/api/pointers/${id}`, { method: "DELETE", headers: { origin: location.origin } }); }, ps[0].id);
  }
  await page.waitForTimeout(1500);
  await page.unroute("**/api/pointers/*");
  out.afterUnpin503 = `pointers=${(await pointers(page, target)).length}`;
  await page.waitForTimeout(8000);
  out.afterRetryWindow = `pointers=${(await pointers(page, target)).length} syncBadge=${JSON.stringify((await page.locator(".sync-status, [class*=sync]").first().innerText().catch(() => "")).slice(0, 40))}`;

  // Scope: another human (editor) cannot pin an unreadable target or under an unreadable parent; does not see others' pins of unreadable notes.
  const secret = await mk(`PinSecret ${s}`);
  await hideFromOthers(page.request, secret); // an owner-only space
  await page.request.post("/api/pointers", { ...H, data: { target_id: secret, parent_id: parent } });
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `F05 ${s}`, email: `f05-${s}@example.com`, password: `pw-${s}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `F05 ${s}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const pinSecret = await human.request.post("/api/pointers", { ...H, data: { target_id: secret, parent_id: parent } });
  const pinUnder = await human.request.post("/api/pointers", { ...H, data: { target_id: target, parent_id: secret } });
  const boot = await (await human.request.get("/api/bootstrap?bodies=none", H)).text();
  out.editorScope = `pinSecret=${pinSecret.status()} pinUnderSecret=${pinUnder.status()} seesSecretPointer=${boot.includes(secret)}`;
  const delOther = ps[0] ? (await human.request.delete(`/api/pointers/${ps[0].id}`, H)).status() : -1;
  out.editorDeleteOwnersPin = String(delOther);
  await human.close();
  console.log(`AUDIT FIND-05 ${JSON.stringify(out)}`);
});
