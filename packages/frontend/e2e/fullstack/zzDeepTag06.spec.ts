// Feature-audit deepening (2026-10-07): TAG-06 — inherited / rollup / source
// precedence: closest ancestor wins, local override and cancelling it, parent
// value change and is_inheritable off (live?), `child:` copy-on-create vs field
// default, rollup with a non-numeric value, and an editor who cannot read a
// subtree moved to an owner-only space (leak check). Since spaces, a child
// always shares its parent's space, so "locked child under an open parent" and
// "open child under a locked parent" no longer exist. UI vs API at 1280 and 390px.
import { test, expect, type Page } from "@playwright/test";
import { ready, openInfoTags, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";


// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
// Inheritance rules: backend services/nodeAttributes.ts computeInheritedAttributes (inheritable ancestors only, closest wins, a key the node
// holds itself wins); `child:` copies: services/childAttributes.ts; field defaults: services/fieldDefaults.ts.
test("TAG-06: inheritance, overrides, rollup, sources, revoked access", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  // Root notes in the default space, so the editor in F can read them.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (title: string, parent?: string, p: Page = page) =>
    (await (await p.request.post("/api/nodes", { ...H, data: { title, markdown: "x", ...(parent ? { parent_id: parent } : { space_id }) } })).json()).id as string;
  const put = async (id: string, key: string, value: string, extra: Record<string, unknown> = {}, p: Page = page) => {
    const r = await p.request.put(`/api/nodes/${id}/attributes/${encodeURIComponent(key)}`, { ...H, data: { value, value_type: "text", ...extra } });
    expect(r.status(), `PUT ${key}`).toBe(200);
  };
  const own = async (id: string, p: Page = page) => Object.fromEntries(((await (await p.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; source: string; is_inheritable: boolean }[]).map((a) => [a.key, `${a.value}|${a.source}|inh=${a.is_inheritable}`]));
  // key=value@source#depth for each inherited attribute (depth 1 = the parent).
  const inh = async (id: string, p: Page = page) => {
    const r = await p.request.get(`/api/nodes/${id}/inherited-attributes`);
    if (r.status() !== 200) return r.status();
    return ((await r.json()) as { key: string; value: string; source_node_title: string; depth: number }[]).map((a) => `${a.key}=${a.value}@${a.source_node_title}#${a.depth}`);
  };
  const roll = async (id: string, p: Page = page) => {
    const r = await p.request.get(`/api/nodes/${id}/rollup-attributes`);
    if (r.status() !== 200) return r.status();
    return ((await r.json()) as { key: string; value: number }[]).map((a) => `${a.key}=${a.value}`);
  };

  // A) Precedence chain P → C → G.
  const P = await mk(`InhP ${stamp}`), C = await mk(`InhC ${stamp}`, P), G = await mk(`InhG ${stamp}`, C);
  await put(P, "owner", "Alice", { is_inheritable: true });
  expect(await inh(G), "from two levels up").toEqual([`owner=Alice@InhP ${stamp}#2`]);
  await put(C, "owner", "Bob", { is_inheritable: true });
  expect(await inh(G), "the closest ancestor wins").toEqual([`owner=Bob@InhC ${stamp}#1`]);
  expect((await own(C)).owner, "C holds its own value").toBe("Bob|ui|inh=true");
  expect(await inh(C), "a key the node holds itself is not inherited").toEqual([]);
  await put(C, "owner", "Carol", { is_inheritable: false });
  expect(await inh(G), "only inheritable values reach descendants").toEqual([`owner=Alice@InhP ${stamp}#2`]);
  await put(G, "owner", "");
  expect((await own(G)).owner).toBe("|ui|inh=false");
  expect(await inh(G), "even an empty local value is the node's own and stops inheritance").toEqual([]);
  await page.request.delete(`/api/nodes/${G}/attributes/owner`, H);
  expect(await inh(G), "removing the local value gives inheritance back").toEqual([`owner=Alice@InhP ${stamp}#2`]);
  await page.request.delete(`/api/nodes/${C}/attributes/owner`, H);

  // B) UI: the child's panel, a parent change, inheritable switched off.
  const openPanel = (p: Page) => openInfoTags(p);
  const inhSection = (p: Page) => p.locator(".attr-panel-inherited");
  const flat = async (loc: ReturnType<typeof inhSection>) => (await loc.innerText()).replace(/\s+/g, " ");
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  await expect(inhSection(page)).toBeVisible();
  expect(await flat(inhSection(page))).toBe(`From parent owner Alice from InhP ${stamp}`);
  await put(P, "owner", "Alice2", { is_inheritable: true });
  // pinned: today's behaviour, no written rule (an open panel keeps showing the old inherited value until the note is opened again; a bounded look for a change)
  await expect.poll(() => flat(inhSection(page)), { timeout: 4000 }).not.toBe(`From parent owner Alice from InhP ${stamp}`).catch(() => {});
  expect(await flat(inhSection(page))).toBe(`From parent owner Alice from InhP ${stamp}`);
  await put(P, "owner", "Alice2", { is_inheritable: false });
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  expect(await inh(C)).toEqual([]);
  await expect(inhSection(page), "nothing inherited, nothing shown").toHaveCount(0);
  await put(P, "owner", "Alice2", { is_inheritable: true });

  // C) A tag field with the same key as an inherited value.
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T06${stamp}`, fields: [{ name: "owner", type: "text" }, { name: "status", type: "text", default: "dflt" }] } })).json();
  await page.request.put(`/api/nodes/${C}/tags/${tag.id}`, { ...H, data: {} });
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  const fieldRow = page.locator(".attr-panel-section", { hasText: `#T06${stamp}` }).locator(".attr-row", { has: page.locator(".attr-key", { hasText: /\bowner$/ }) });
  await expect(fieldRow).toBeVisible();
  // pinned: today's behaviour, no written rule (the empty field and the inherited value of the same key are shown side by side, the cell says Empty)
  expect((await fieldRow.innerText()).replace(/\s+/g, " ")).toBe("owner");
  expect(await flat(inhSection(page))).toBe(`From parent owner Alice2 from InhP ${stamp}`);
  expect((await page.locator(".ff-cell", { has: page.locator(".ff-label", { hasText: /^owner$/ }) }).innerText()).replace(/\s+/g, " ")).toBe("owner Empty");

  // D) `child:` copy-on-create (one-shot, direct children, an ATTRIBUTE_SET each — childAttributes.ts), and a field default seeds
  //    only when nothing is there (fieldDefaults.ts: 'derived', never overwriting what is set).
  await put(P, "child:status", "todo");
  expect((await own(P))["child:status"], "stored as an ordinary attribute of the parent").toBe("todo|ui|inh=false");
  const K1 = await mk(`ChildCopy ${stamp}`, P);
  expect(await own(K1)).toEqual({ status: "todo|derived|inh=false" });
  await page.request.put(`/api/nodes/${K1}/tags/${tag.id}`, { ...H, data: {} });
  expect((await own(K1)).status, "the default does not overwrite the copied value").toBe("todo|derived|inh=false");
  const K2 = await mk(`NoParentDefault ${stamp}`);
  await page.request.put(`/api/nodes/${K2}/tags/${tag.id}`, { ...H, data: {} });
  expect((await own(K2)).status, "with nothing there the default is seeded").toBe("dflt|derived|inh=false");
  const evs = await (await page.request.get(`/api/events?target_id=${K1}&limit=50`)).json() as { events: { event_type: string; payload?: { key?: string } }[] };
  expect(evs.events.some((e) => e.event_type === "ATTRIBUTE_SET" && e.payload?.key === "status"), "the copy is recorded as an attribute event").toBe(true);

  // E) Rollup: a sum and a count over the children (the rule for what a number is: attributeValue.ts isStoredNumber — "2h" or "abc" is not one,
  //    so it is not added). A child's number is written with the number type, as the panel does for a number.
  const rt = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T06r${stamp}`, fields: [{ name: "total", type: "number", rollup: { op: "sum", attr: "hours" } }, { name: "kids", type: "number", rollup: { op: "count" } }] } })).json();
  const R = await mk(`RollP ${stamp}`);
  await page.request.put(`/api/nodes/${R}/tags/${rt.id}`, { ...H, data: {} });
  const r1 = await mk(`R1 ${stamp}`, R), r2 = await mk(`R2 ${stamp}`, R);
  await put(r1, "hours", "2", { value_type: "number" }); await put(r2, "hours", "3", { value_type: "number" });
  expect(await roll(R)).toEqual(["total=5", "kids=2"]);
  const r4 = await mk(`R4bad ${stamp}`, R);
  await put(r4, "hours", "abc", { value_type: "number" });
  expect(await roll(R), "a non-number is not summed, but the child is counted").toEqual(["total=5", "kids=3"]);
  await ready(page, `/?view=notes&node=${R}`);
  await openPanel(page);
  await expect(page.locator(".attr-panel-rollup")).toBeVisible();
  expect((await page.locator(".attr-panel-rollup").innerText()).replace(/\s+/g, " ")).toBe("Calculated from items below total 5 kids 3");
  await page.request.delete(`/api/nodes/${r4}/attributes/hours`, H);

  // F) Another human (editor): a hidden parent — its child moves with it (a child always shares its parent's space, docs/architecture/spaces.md),
  //    so neither can be read and nothing of them shows. An unreadable note is missing (routes/nodes.ts: 404, no existence probe).
  const SP = await mk(`SecretParent ${stamp}`);
  await put(SP, "salary", "99999", { is_inheritable: true });
  const OC = await mk(`OpenChild ${stamp}`, SP);
  await hideFromOthers(page.request, SP);
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `T06 ${stamp}`, email: `t06-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `T06 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  expect((await hp.request.get(`/api/nodes/${SP}`)).status()).toBe(404);
  expect((await hp.request.get(`/api/nodes/${OC}`)).status()).toBe(404);
  expect(await inh(OC, hp)).toBe(404);
  // The rollup of a note they can read is readable (R is in the default space).
  expect(await roll(R, hp)).toEqual(["total=5", "kids=3"]); // r4 is still a child, only its value was removed
  await ready(hp, `/?view=notes&node=${OC}`);
  await expect(hp.getByText("It no longer exists, or you can't see it.")).toBeVisible();
  const editorBody = await hp.locator("body").innerText();
  expect(editorBody).not.toContain("99999");
  expect(editorBody).not.toContain(`SecretParent ${stamp}`);
  // Revoke: the owner hides P (the earlier chain, with C and G) → the editor can no longer read C either.
  expect((await hp.request.get(`/api/nodes/${C}`)).status(), "C is readable before the revoke").toBe(200);
  await hideFromOthers(page.request, P);
  await expect.poll(async () => (await hp.request.get(`/api/nodes/${C}`)).status()).toBe(404);
  expect(await inh(C, hp)).toBe(404);
  await human.close();

  // G) Phone: the inherited values show in the panel, the page is not wider than the screen.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${G}`);
  // On the phone the Properties panel is behind the inspector toggle (and its Tags tab, when the sheet has tabs).
  const phoneInspector = pp.locator(".notes-inspector-toggle");
  await expect(phoneInspector).toBeVisible();
  if ((await phoneInspector.getAttribute("aria-pressed")) === "false") await phoneInspector.click();
  const phoneTagsTab = pp.getByRole("tab", { name: /^(Tags|標籤)$/ });
  if (await phoneTagsTab.isVisible().catch(() => false)) await phoneTagsTab.click();
  await expect(pp.locator(".attr-panel-inherited")).toBeVisible();
  const phoneGeo = await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    inherited: (document.querySelector(".attr-panel-inherited") as HTMLElement | null)?.innerText ?? null,
    panelRight: Math.round(document.querySelector(".attr-panel")?.getBoundingClientRect().right ?? 0),
  }));
  expect(phoneGeo.doc).toBeLessThanOrEqual(390);
  expect(phoneGeo.panelRight).toBeGreaterThan(0);
  expect(phoneGeo.panelRight).toBeLessThanOrEqual(390);
  expect(phoneGeo.inherited!.replace(/\s+/g, " ")).toBe(`From parent owner Alice2 from InhP ${stamp}`);
  await phone.close();
});
