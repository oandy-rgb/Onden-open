// Feature-audit deepening (2026-10-08): NOTE-10 — sidebar "Move to…" picker,
// the picker's top-level row, "Hide" and "Unhide" (the notes list's Hidden group): other fields
// untouched, persisted across reopen, a refused move, undo via the event
// restore, and a move into / out of a read-restricted parent seen by a second
// human (editor).
import { test, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "../fullstack/helpers";


async function findRow(page: Page, text: string, cls = ".obsidian-page-button") {
  const loc = page.locator(cls, { hasText: text }).first();
  for (let i = 0; i < 80 && !(await loc.isVisible().catch(() => false)); i++) {
    await page.locator(".obsidian-page-button").first().evaluate((el) => {
      let p: HTMLElement | null = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (p) p.scrollTop += 300;
    });
    await page.waitForTimeout(60);
  }
  return loc;
}

test("NOTE-10: move / remove parent / hide / promote, refusal, undo, cross-scope", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  // Default space: the second human below must see P and C.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (title: string, md: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: md, space_id } })).json()).id as string;
  const P = await mk(`NP ${stamp}`, "parent body");
  const L = await mk(`NL ${stamp}`, "locked parent");
  const C = await mk(`NC ${stamp}`, "child body keep");
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `n10t${stamp}`, fields: [{ name: "score", type: "number" }] } })).json();
  await page.request.put(`/api/nodes/${C}/tags/${tag.id}`, { ...H, data: {} });
  await page.request.put(`/api/nodes/${C}/attributes/score`, { ...H, data: { value: "7", value_type: "number" } });
  await hideFromOthers(page.request, L); // L lives in an owner-only space
  const snap = async (id: string) => { const n = await (await page.request.get(`/api/nodes/${id}`)).json(); const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json().catch(() => []); return { parent: n.parent_id === P ? "P" : n.parent_id === L ? "L" : n.parent_id ?? null, title: n.title, md: n.markdown, hidden: !!n.hidden, tags: (n.class_tag_ids ?? []).length, score: (Array.isArray(at) ? at : at.attributes ?? []).find((a: { key: string }) => a.key === "score")?.value ?? null }; };
  const menu = async (rowText: string, item: string | RegExp) => {
    const row = await findRow(page, rowText);
    await row.click({ button: "right" });
    await page.locator(".ctx-menu").getByRole("menuitem", { name: item }).first().click();
    await page.waitForTimeout(2000);
  };
  const setParent = async (value: string) => {
    const toggle = page.locator(".notes-inspector-toggle");
    if (await toggle.count() && (await toggle.getAttribute("aria-pressed")) === "false") await toggle.click();
    const row = page.locator(".ov-prop-row", { hasText: "Parent" }).locator("select").first();
    await row.dispatchEvent("pointerdown");
    await row.focus();
    await page.waitForTimeout(500);
    await row.selectOption(value);
    await page.waitForTimeout(2000);
  };
  try {
  out.start = await snap(C);
  await ready(page, `/?view=notes&node=${C}`);
  out.sidebarMoveUnderOffersP = await (async () => { const row = await findRow(page, `NC ${stamp}`); await row.click({ button: "right" }); await page.locator(".ctx-menu").getByRole("menuitem", { name: "Move to…" }).click(); await page.getByRole("combobox", { name: "Find a place to move to" }).fill(`NP ${stamp}`); const n = await page.getByRole("option", { name: new RegExp(`NP ${stamp}`) }).count(); await page.keyboard.press("Escape"); return n; })();
  await setParent(P);
  out.afterMoveUnder = await snap(C);
  await ready(page, `/?view=notes&node=${C}`);
  out.afterReopen = { ...(await snap(C)), parentRow: await (await findRow(page, `NP ${stamp}`, ".obsidian-group-title")).count() };

  // Undo the move with the event restore (latest NODE_UPDATED on C).
  const evs = await (await page.request.get(`/api/events?target_id=${C}&limit=20`)).json();
  const list = (evs.events ?? evs) as Array<{ id: string; event_type: string; payload?: Record<string, unknown> }>;
  const moveEv = list.find((e) => /UPDATED|PARENT|MOVE/.test(e.event_type) && JSON.stringify(e.payload ?? {}).includes("parent"));
  out.moveEvent = moveEv ? moveEv.event_type : list.map((e) => e.event_type).slice(0, 6);
  // Make an unrelated later edit first: undo must only revert the parent.
  await page.request.patch(`/api/nodes/${C}`, { ...H, data: { markdown: "child body keep + later edit" } });
  if (moveEv) {
    const r = await page.request.post(`/api/events/${moveEv.id}/restore`, { ...H, data: {} });
    out.restoreMove = { status: r.status(), body: (await r.text()).slice(0, 140), after: await snap(C) };
  }

  // Refused move (403).
  await ready(page, `/?view=notes&node=${C}`);
  await page.route(`**/api/nodes/${C}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await setParent(P);
  out.refusedMove = { server: await snap(C), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 120) };
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Hide → the notes list's Hidden group → Unhide.
  await ready(page, `/?view=notes&node=${C}`);
  await menu(`NC ${stamp}`, /Hide/);
  out.afterHide = await snap(C);
  const hiddenToggle = page.locator(".sb-hidden-toggle");
  if ((await hiddenToggle.getAttribute("aria-expanded").catch(() => null)) !== "true") await hiddenToggle.click().catch(() => {});
  await page.waitForTimeout(1000);
  const hiddenRow = page.locator(".sb-hidden-item .obsidian-page-button", { hasText: `NC ${stamp}` }).first();
  out.inboxListed = await hiddenRow.count();
  if (await hiddenRow.count()) {
    await hiddenRow.click({ button: "right" });
    await page.locator(".ctx-menu").getByRole("menuitem", { name: "Unhide" }).click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  out.afterPromote = await snap(C);

  // Cross-space: move under the parent in the owner-only space (a child shares
  // its parent's space); editor's view.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `N10 ${stamp}`, email: `n10-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `N10 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  out.editorBefore = (await human.request.get(`/api/nodes/${C}`)).status();
  await ready(page, `/?view=notes&node=${C}`);
  await setParent(L);
  out.underLocked = { owner: await snap(C), editor: (await human.request.get(`/api/nodes/${C}`)).status() };
  await setParent("");
  out.outOfLocked = { owner: await snap(C), editor: (await human.request.get(`/api/nodes/${C}`)).status() };
  await human.close();
  } finally {
    console.log("NOTE10 " + JSON.stringify(out, null, 2));
  }
});
