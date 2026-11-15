// Feature-audit deepening (2026-10-07): TAG-06 — inherited / rollup / source
// precedence: closest ancestor wins, local override and cancelling it, parent
// value change and is_inheritable off (live?), `child:` copy-on-create vs field
// default, rollup with a non-numeric value, and an editor who cannot read a
// subtree moved to an owner-only space (leak check). Since spaces, a child
// always shares its parent's space, so "locked child under an open parent" and
// "open child under a locked parent" no longer exist. UI vs API at 1280 and 390px.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";


test("TAG-06: inheritance, overrides, rollup, sources, revoked access", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  // Root notes in the default space, so the editor in F can read them.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (title: string, parent?: string, p: Page = page) =>
    (await (await p.request.post("/api/nodes", { ...H, data: { title, markdown: "x", ...(parent ? { parent_id: parent } : { space_id }) } })).json()).id as string;
  const put = async (id: string, key: string, value: string, extra: Record<string, unknown> = {}, p: Page = page) => {
    const r = await p.request.put(`/api/nodes/${id}/attributes/${encodeURIComponent(key)}`, { ...H, data: { value, value_type: "text", ...extra } });
    return r.status() === 200 ? "200" : `${r.status()} ${(await r.text()).slice(0, 80)}`;
  };
  const own = async (id: string, p: Page = page) => Object.fromEntries(((await (await p.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; source: string; is_inheritable: boolean }[]).map((a) => [a.key, `${a.value}|${a.source}|inh=${a.is_inheritable}`]));
  const inh = async (id: string, p: Page = page) => {
    const r = await p.request.get(`/api/nodes/${id}/inherited-attributes`);
    if (r.status() !== 200) return `${r.status()}`;
    return JSON.stringify(((await r.json()) as { key: string; value: string; source_node_title: string; depth: number }[]).map((a) => `${a.key}=${a.value}@${a.source_node_title}#${a.depth}`));
  };
  const roll = async (id: string, p: Page = page) => {
    const r = await p.request.get(`/api/nodes/${id}/rollup-attributes`);
    if (r.status() !== 200) return `${r.status()}`;
    return JSON.stringify(((await r.json()) as { key: string; value: number }[]).map((a) => `${a.key}=${a.value}`));
  };

  // A) Precedence chain P → C → G.
  const P = await mk(`InhP ${stamp}`), C = await mk(`InhC ${stamp}`, P), G = await mk(`InhG ${stamp}`, C);
  await put(P, "owner", "Alice", { is_inheritable: true });
  out.gFromP = await inh(G);
  await put(C, "owner", "Bob", { is_inheritable: true });
  out.gClosestWins = await inh(G);
  out.cLocalWins = `own=${JSON.stringify((await own(C)).owner)} inh=${await inh(C)}`;
  await put(C, "owner", "Carol", { is_inheritable: false });
  out.gSkipsNonInheritable = await inh(G);
  await put(G, "owner", "");
  out.gEmptyOverride = `own=${JSON.stringify((await own(G)).owner)} inh=${await inh(G)}`;
  await page.request.delete(`/api/nodes/${G}/attributes/owner`, H);
  out.gCancelOverride = await inh(G);
  await page.request.delete(`/api/nodes/${C}/attributes/owner`, H);

  // B) UI: the child's panel, live parent change, inheritable off.
  const openPanel = async (p: Page) => {
    const pn = p.locator(".attr-panel");
    await p.locator(".attr-panel").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await expect(pn).toBeVisible({ timeout: 10_000 });
  };
  const inhSection = (p: Page) => p.locator(".attr-panel-inherited");
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  out.uiInherited = JSON.stringify((await inhSection(page).innerText().catch(() => "-")).replace(/\s+/g, " "));
  await put(P, "owner", "Alice2", { is_inheritable: true });
  await page.waitForTimeout(4000);
  out.uiAfterParentChangeNoReload = JSON.stringify((await inhSection(page).innerText().catch(() => "-")).replace(/\s+/g, " "));
  await page.request.delete(`/api/nodes/${C}/attributes/owner`, H);
  await put(P, "owner", "Alice2", { is_inheritable: false });
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  out.uiAfterInheritableOff = `api=${await inh(C)} ui=${JSON.stringify((await inhSection(page).innerText().catch(() => "(none)")).replace(/\s+/g, " "))}`;
  await put(P, "owner", "Alice2", { is_inheritable: true });

  // C) Tag field with the same key as an inherited value: which does the field row show?
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T06${stamp}`, fields: [{ name: "owner", type: "text" }, { name: "status", type: "text", default: "dflt" }] } })).json();
  await page.request.put(`/api/nodes/${C}/tags/${tag.id}`, { ...H, data: {} });
  await ready(page, `/?view=notes&node=${C}`);
  await openPanel(page);
  const fieldRow = page.locator(".attr-panel-section", { hasText: `#T06${stamp}` }).locator(".attr-row", { has: page.locator(".attr-key", { hasText: /\bowner$/ }) });
  out.tagFieldVsInherited = `fieldRow=${JSON.stringify((await fieldRow.innerText().catch(() => "-")).replace(/\s+/g, " "))} inhSection=${JSON.stringify((await inhSection(page).innerText().catch(() => "(none)")).replace(/\s+/g, " "))} featured=${JSON.stringify(await page.locator(".ff-cell", { has: page.locator(".ff-label", { hasText: /^owner$/ }) }).innerText().catch(() => "-"))}`;

  // D) `child:` copy-on-create, and vs a field default.
  await put(P, "child:status", "todo");
  out.childPrefixStored = JSON.stringify((await own(P))["child:status"]);
  const K1 = await mk(`ChildCopy ${stamp}`, P);
  out.childCopy = JSON.stringify(await own(K1));
  await page.request.put(`/api/nodes/${K1}/tags/${tag.id}`, { ...H, data: {} });
  out.childCopyThenDefault = JSON.stringify((await own(K1)).status);
  const K2 = await mk(`NoParentDefault ${stamp}`);
  await page.request.put(`/api/nodes/${K2}/tags/${tag.id}`, { ...H, data: {} });
  out.defaultOnly = JSON.stringify((await own(K2)).status);
  const evs = await (await page.request.get(`/api/events?target_id=${K1}&limit=20`)).json().catch(() => null);
  out.childCopyEvents = JSON.stringify((Array.isArray(evs) ? evs : evs?.events ?? []).filter((e: { target_id?: string }) => !e.target_id || e.target_id === K1).map((e: { type: string; payload?: { key?: string } }) => `${e.type}:${e.payload?.key ?? ""}`).slice(0, 10));

  // E) Rollup: sum over children and a non-numeric value. (A locked child is
  //    gone: children share their parent's space.)
  const rt = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T06r${stamp}`, fields: [{ name: "total", type: "number", rollup: { op: "sum", attr: "hours" } }, { name: "kids", type: "number", rollup: { op: "count" } }] } })).json();
  const R = await mk(`RollP ${stamp}`);
  await page.request.put(`/api/nodes/${R}/tags/${rt.id}`, { ...H, data: {} });
  const r1 = await mk(`R1 ${stamp}`, R), r2 = await mk(`R2 ${stamp}`, R);
  await put(r1, "hours", "2"); await put(r2, "hours", "3");
  out.rollupOk = await roll(R);
  const r4 = await mk(`R4bad ${stamp}`, R);
  await put(r4, "hours", "abc");
  out.rollupWithNonNumeric = await roll(R);
  await ready(page, `/?view=notes&node=${R}`);
  await openPanel(page);
  out.uiRollup = JSON.stringify((await page.locator(".attr-panel-rollup").innerText().catch(() => "(none)")).replace(/\s+/g, " "));
  await page.request.delete(`/api/nodes/${r4}/attributes/hours`, H);

  // F) Another human (editor) — a hidden parent; its child moves with it.
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
  out.editorParentRead = String((await hp.request.get(`/api/nodes/${SP}`)).status());
  out.editorChildRead = String((await hp.request.get(`/api/nodes/${OC}`)).status());
  out.editorInheritedFromLockedParent = await inh(OC, hp);
  out.editorRollup = await roll(R, hp);
  await ready(hp, `/?view=notes&node=${OC}`);
  await openPanel(hp).catch(() => {});
  await hp.waitForTimeout(1200);
  out.editorUiLeak = `salary=${(await hp.locator("body").innerText()).includes("99999")} parentTitle=${(await hp.locator("body").innerText()).includes(`SecretParent ${stamp}`)}`;
  // Revoke: owner hides P (the earlier chain, with C and G) → editor reading C.
  await hideFromOthers(page.request, P);
  out.editorAfterRevokeParent = `C=${(await hp.request.get(`/api/nodes/${C}`)).status()} inh=${await inh(C, hp)}`;
  await human.close();

  // G) Phone: where do inherited values show?
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${G}`);
  await pp.waitForTimeout(800);
  const info = pp.getByRole("tab", { name: /Info/i }).or(pp.getByRole("button", { name: /^Info$/i })).first();
  if (await info.isVisible().catch(() => false)) { await info.click(); await pp.waitForTimeout(800); }
  out.phone = JSON.stringify(await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    panel: !!document.querySelector(".attr-panel"),
    inherited: (document.querySelector(".attr-panel-inherited") as HTMLElement | null)?.innerText ?? null,
    panelRight: Math.round(document.querySelector(".attr-panel")?.getBoundingClientRect().right ?? 0),
  })));
  await pp.screenshot({ path: "/tmp/pw-output/tag06-phone.png", fullPage: true }).catch(() => {});
  await phone.close();
  console.log(`AUDIT TAG-06 ${JSON.stringify(out, null, 1)}`);
});
