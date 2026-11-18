// Feature-audit deepening (2026-10-07): TAG-05 — multi-value, relation and
// media pickers: duplicates, deleted/unreadable references, stale select
// options (removed elsewhere), keeping the selection after 503/422, media
// upload failure, and the phone viewport.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ready, openInfoTags, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";


// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
test("TAG-05: multi-value, relation, media, stale options, failures", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const FIELDS = [
    { name: "m_txt", type: "text", cardinality: "many" },
    { name: "m_sel", type: "select", options: ["a", "b"], cardinality: "many" },
    { name: "s_sel", type: "select", options: ["a", "b", "c"] },
    { name: "rel", type: "relation" },
    { name: "med", type: "media" },
  ];
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T05${stamp}`, fields: FIELDS } })).json();
  const tagId = tag.id as string;
  const space_id = await defaultSpaceId(page.request); // the second human (G) must see N
  const mk = async (title: string, tagged = true) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x", space_id } })).json();
    if (tagged) await page.request.put(`/api/nodes/${n.id}/tags/${tagId}`, { ...H, data: {} });
    return n.id as string;
  };
  const attrs = async (id: string, p: Page = page) => Object.fromEntries(((await (await p.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).map((a) => [a.key, `${a.value}|${a.value_type}`]));
  const put = async (id: string, key: string, value: string, value_type = "text", p: Page = page) => {
    const r = await p.request.put(`/api/nodes/${id}/attributes/${key}`, { ...H, data: { value, value_type } });
    return { status: r.status(), error: r.status() === 200 ? "" : (await r.json()).error as string, detail: r.status() === 200 ? "" : String((await r.json()).detail ?? "") };
  };
  const schema = async () => ((await (await page.request.get("/api/tags")).json()) as { id: string; schema_fields: Record<string, unknown>[] }[]).find((t) => t.id === tagId)?.schema_fields ?? [];
  const setOptions = async (name: string, options: string[]) =>
    (await page.request.patch(`/api/tags/${tagId}/schema`, { ...H, data: { fields: (await schema()).map((f) => f.name === name ? { ...f, options } : f) } })).status();
  const serverIs = (id: string, key: string, want: string | undefined) => expect.poll(async () => (await attrs(id))[key], { message: `${key} on the server`, timeout: 60_000 }).toBe(want);

  // A) API matrix. A "many" field stores a JSON list as text (attributeValue.ts encodeValues); empty slots are skipped by fieldViolation;
  //    a scalar is one value; a relation is free-form (elementViolation), so an id nobody holds is accepted.
  const N = await mk(`T05Note ${stamp}`);
  const target = await mk(`RelTarget ${stamp}`, false);
  expect((await put(N, "m_txt", JSON.stringify(["a", "a"]))).status).toBe(200);
  // pinned: today's behaviour, no written rule (a list keeps a repeated value)
  expect((await attrs(N)).m_txt).toBe('["a","a"]|text');
  expect((await put(N, "m_txt", JSON.stringify([""]))).status).toBe(200);
  expect((await put(N, "m_sel", JSON.stringify(["a"]))).status).toBe(200);
  expect((await put(N, "m_sel", "a")).status).toBe(200);
  expect((await put(N, "m_sel", JSON.stringify(["a", "zzz"]))).status, "every element must be one of the options").toBe(422);
  expect((await put(N, "rel", target, "node_ref")).status).toBe(200);
  expect((await put(N, "rel", "not-a-uuid", "node_ref")).status).toBe(200);
  expect((await put(N, "rel", "00000000-0000-4000-8000-000000000000", "node_ref")).status).toBe(200);
  expect((await put(N, "rel", target, "node_ref")).status).toBe(200);
  expect((await attrs(N)).rel).toBe(`${target}|node_ref`);

  // B) The target is deleted. Delete is a soft delete that keeps the reference (docs/decisions/soft-delete-no-trash.md);
  //    the panel shows the target's title while it lives (RelationFieldEditor.tsx: "look it up on each render"), and a name it cannot find as
  //    「Untitled」, never the id (AGENTS.md 「找不到名稱時顯示「未命名」，不退回 id」).
  const panel = page.locator(".attr-panel");
  const openPanel = (p: Page) => openInfoTags(p);
  const row = (p: Page, name: string) => p.locator(".attr-panel .attr-row", { has: p.locator(".attr-key", { hasText: new RegExp(`\\b${name}$`) }) });
  const featured = (p: Page, name: string) => p.locator(".ff-cell", { has: p.locator(".ff-label", { hasText: new RegExp(`^${name}$`) }) });
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await expect(row(page, "rel")).toContainText(`RelTarget ${stamp}`);
  expect((await page.request.delete(`/api/nodes/${target}`, H)).status()).toBe(200);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await expect(row(page, "rel")).toContainText("Untitled");
  await expect(row(page, "rel")).not.toContainText(target);
  expect((await attrs(N)).rel).toBe(`${target}|node_ref`);
  // pinned: today's behaviour, no written rule (the featured cell words a missing target 「Unknown note」, the panel 「Untitled」)
  await expect(featured(page, "rel")).toHaveText(/Unknown note/);
  // (The probe also tried POST /api/nodes/:id/restore here; trash and that route are gone — soft-delete-no-trash.md: restore is from the history.)

  // C) Multi-value text through the panel: add, duplicate, remove.
  expect((await put(N, "m_txt", "")).status).toBe(200);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  const mrow = row(page, "m_txt");
  await expect(mrow.locator(".attr-multi-empty")).toBeVisible();
  await mrow.locator(".attr-multi-add").click();
  await serverIs(N, "m_txt", '[""]|text');
  const slots = mrow.locator(".attr-multi-slot");
  const editSlot = async (i: number, v: string) => {
    const s = slots.nth(i);
    const btn = s.locator("button.attr-value");
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await s.locator("input").fill(v); await s.locator("input").press("Enter");
  };
  await editSlot(0, "dup");
  await serverIs(N, "m_txt", '["dup"]|text');
  await mrow.locator(".attr-multi-add").click();
  await editSlot(1, "dup");
  // pinned: today's behaviour, no written rule (the same value can be entered twice)
  await serverIs(N, "m_txt", '["dup","dup"]|text');
  await mrow.locator(".attr-multi-remove").first().click();
  await serverIs(N, "m_txt", '["dup"]|text');

  // D) Stale select options: the stored value is no longer in the options.
  expect((await put(N, "s_sel", "c")).status).toBe(200);
  expect(await setOptions("s_sel", ["a", "b"])).toBe(200);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  // A select with a few short options is a group of option chips (OptionChips.tsx), the chosen one pressed; a stored value the tag no longer
  // lists stays on screen as its own chip, and stays stored.
  const ssel = row(page, "s_sel").getByRole("group", { name: "s_sel", exact: true });
  const chosen = async (group: Locator = ssel) => group.locator("[aria-pressed=true]").allInnerTexts();
  const listed = async () => ssel.locator(".attr-choice:not(.attr-choice--add)").allInnerTexts();
  await expect.poll(chosen).toEqual(["c"]);
  expect(await listed()).toEqual(["a", "b", "c"]);
  expect((await attrs(N)).s_sel).toBe("c|text");
  await expect(featured(page, "s_sel")).toHaveText(/c/);
  // Another tab removes option "b": this tab follows the tag (the chip goes), the stored "c" stays, and "b" can no longer be picked.
  expect(await setOptions("s_sel", ["a"])).toBe(200);
  await expect.poll(listed, { timeout: 30_000 }).toEqual(["a", "c"]);
  await expect(ssel.getByRole("button", { name: "b", exact: true })).toHaveCount(0);
  expect((await attrs(N)).s_sel).toBe("c|text");
  const stale = await put(N, "s_sel", "b");
  expect(stale.status, "a value the field no longer lists is refused (fieldViolation)").toBe(422);
  expect(stale.detail).toContain("must be one of: a");
  expect((await attrs(N)).s_sel).toBe("c|text");

  // E) 503 on a select change is retryable (errors-and-saves.md): the change waits in the queue and shows as waiting to sync, and lands later.
  expect(await setOptions("s_sel", ["a", "b", "c"])).toBe(200);
  expect((await put(N, "s_sel", "a")).status).toBe(200);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await expect.poll(chosen).toEqual(["a"]);
  await page.route(`**/api/nodes/${N}/attributes/s_sel`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await row(page, "s_sel").getByRole("group", { name: "s_sel", exact: true }).getByRole("button", { name: "b", exact: true }).click();
  await expect(page.locator(".sync-indicator, [class*=sync-status]").first()).toContainText("1 change waiting to sync");
  expect((await attrs(N)).s_sel).toBe("a|text");
  // pinned: today's behaviour, no written rule (docs/agents/decisions-core-sync.md 「屬性…的樂觀投影…另批處理」: the chips still show the stored "a" while "b" waits)
  expect(await chosen(row(page, "s_sel"))).toEqual(["a"]);
  await page.unroute(`**/api/nodes/${N}/attributes/s_sel`);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await serverIs(N, "s_sel", "b|text");
  await expect.poll(() => chosen(row(page, "s_sel"))).toEqual(["b"]);

  // F) Media: the URL is typed into a draft and saved once, on blur or Enter (MediaFieldEditor.tsx); a failed upload is reported.
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/med")) puts.push(JSON.parse(r.postData() ?? "{}").value); });
  await row(page, "med").locator("input[type=url]").pressSequentially("https://x.io/a.png", { delay: 30 });
  expect(puts, "nothing is written while typing").toEqual([]);
  expect((await attrs(N)).med).toBeUndefined();
  await row(page, "med").locator("input[type=url]").press("Enter");
  await serverIs(N, "med", "https://x.io/a.png|text");
  expect(puts).toEqual(["https://x.io/a.png"]);
  await page.route("**/api/media", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  const uploadBtn = row(page, "med").locator("button");
  expect(await uploadBtn.allInnerTexts()).toEqual(["📎"]); // pinned: today's behaviour, no written rule (the upload button's label)
  const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), uploadBtn.first().click()]);
  await fc.setFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
  await expect(page.locator(".toast-message", { hasText: "Could not reach the server. Try again when the connection is available." }).first()).toBeVisible();
  expect((await attrs(N)).med, "the failed upload leaves the typed URL").toBe("https://x.io/a.png|text");
  await page.unroute("**/api/media");

  // G) A relation target the other person cannot read (it sits in a space they are not in). They see neither its title nor an id in the screen,
  //    and the picker does not offer it (read policy: an unreadable note is missing, routes/nodes.ts).
  const secret = await mk(`SecretRel ${stamp}`, false);
  await hideFromOthers(page.request, secret);
  expect((await put(N, "rel", secret, "node_ref")).status).toBe(200);
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `T05 ${stamp}`, email: `t05-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `T05 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, `/?view=notes&node=${N}`);
  await openPanel(hp);
  await expect(row(hp, "rel")).toBeVisible();
  // pinned: today's behaviour, no written rule (the stored value of a note they can read is the id, whatever the target's readability)
  expect((await attrs(N, hp)).rel).toBe(`${secret}|node_ref`);
  // The pill names it 「Untitled」, like any name the screen cannot find.
  await expect(row(hp, "rel")).toContainText("Untitled");
  expect((await row(hp, "rel").innerText()).replace(/\s+/g, " ")).not.toContain(secret);
  await row(hp, "rel").getByRole("button", { name: "Change note", exact: true }).click();
  await hp.getByRole("searchbox", { name: "Search notes…" }).fill("SecretRel");
  await expect(hp.locator(".attr-relation-option").filter({ hasText: "SecretRel" })).toHaveCount(0);
  // The picker does list what they can read (so the empty result above is the read policy, not a dead list).
  await hp.getByRole("searchbox", { name: "Search notes…" }).fill(`T05Note ${stamp}`);
  await expect(hp.locator(".attr-relation-option").filter({ hasText: `T05Note ${stamp}` })).toHaveCount(1);
  expect(await hp.locator("body").innerText()).not.toContain(`SecretRel ${stamp}`);
  expect(await hp.locator("body").innerText()).not.toContain(secret);
  await human.close();

  // H) Phone: the featured cells list the fields in schema order; nothing is wider than the screen; a pick writes like on the desktop.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${N}`);
  await expect(featured(pp, "s_sel")).toBeVisible();
  const phoneGeo = await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    ff: [...document.querySelectorAll(".ff-cell .ff-label")].map((e) => e.textContent),
    panel: !!document.querySelector(".attr-panel"),
  }));
  expect(phoneGeo.doc).toBeLessThanOrEqual(390);
  expect(phoneGeo.ff).toEqual(FIELDS.map((f) => f.name));
  expect(phoneGeo.panel).toBe(true); // pinned: today's behaviour, no written rule (the Properties panel is in the page, not necessarily shown)
  await featured(pp, "s_sel").click();
  await pp.locator(".ff-cell--editing").getByRole("button", { name: "c", exact: true }).click();
  await serverIs(N, "s_sel", "c|text");
  await phone.close();
  void panel;
});
