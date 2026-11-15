// Feature-audit deepening (2026-10-07): TAG-05 — multi-value, relation and
// media pickers: duplicates, deleted/unreadable references, stale select
// options (removed elsewhere), keeping the selection after 503/422, media
// upload failure, and the phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";


test("TAG-05: multi-value, relation, media, stale options, failures", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
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
    return r.status() === 200 ? "200" : `${r.status()} ${(await r.text()).slice(0, 80)}`;
  };
  const schema = async () => ((await (await page.request.get("/api/tags")).json()) as { id: string; schema_fields: Record<string, unknown>[] }[]).find((t) => t.id === tagId)?.schema_fields ?? [];
  const setOptions = async (name: string, options: string[]) =>
    (await page.request.patch(`/api/tags/${tagId}/schema`, { ...H, data: { fields: (await schema()).map((f) => f.name === name ? { ...f, options } : f) } })).status();

  // A) API matrix.
  const N = await mk(`T05Note ${stamp}`);
  const target = await mk(`RelTarget ${stamp}`, false);
  const api: string[] = [];
  api.push(`m_txt dup ["a","a"] → ${await put(N, "m_txt", JSON.stringify(["a", "a"]))} stored=${(await attrs(N)).m_txt}`);
  api.push(`m_txt [""] → ${await put(N, "m_txt", JSON.stringify([""]))}`);
  api.push(`m_sel ["a"] → ${await put(N, "m_sel", JSON.stringify(["a"]))}`);
  api.push(`m_sel "a" (scalar) → ${await put(N, "m_sel", "a")}`);
  api.push(`rel target → ${await put(N, "rel", target, "node_ref")}`);
  api.push(`rel not-a-uuid → ${await put(N, "rel", "not-a-uuid", "node_ref")}`);
  api.push(`rel random uuid → ${await put(N, "rel", "00000000-0000-4000-8000-000000000000", "node_ref")}`);
  await put(N, "rel", target, "node_ref");
  out.api = api.join("\n");

  // B) Deleted reference: trash the target, look at API + UI.
  const panel = page.locator(".attr-panel");
  const openPanel = async (p: Page) => {
    const pn = p.locator(".attr-panel");
    await p.locator(".attr-panel").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await expect(pn).toBeVisible({ timeout: 10_000 });
  };
  const row = (p: Page, name: string) => p.locator(".attr-panel .attr-row", { has: p.locator(".attr-key", { hasText: new RegExp(`\\b${name}$`) }) });
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  out.relLive = (await row(page, "rel").innerText()).replace(/\s+/g, " ");
  const del = await page.request.delete(`/api/nodes/${target}`, H);
  out.trashTarget = String(del.status());
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  out.relAfterTrash = `ui=${JSON.stringify((await row(page, "rel").innerText()).replace(/\s+/g, " "))} api=${(await attrs(N)).rel}`;
  out.featuredRelAfterTrash = JSON.stringify(await page.locator(".ff-cell", { has: page.locator(".ff-label", { hasText: /^rel$/ }) }).innerText().catch(() => "-"));
  const restore = await page.request.post(`/api/nodes/${target}/restore`, H).catch(() => null);
  out.restore = String(restore?.status());

  // C) Multi-value text through the panel: add, duplicate, remove.
  await put(N, "m_txt", "");
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  const mrow = row(page, "m_txt");
  out.multiWidget = (await mrow.innerHTML()).replace(/\s+/g, " ").slice(0, 160);
  await mrow.locator(".attr-multi-add").click(); await page.waitForTimeout(800);
  out.multiAfterAddEmpty = (await attrs(N)).m_txt ?? "(none)";
  const slots = mrow.locator(".attr-multi-slot");
  const editSlot = async (i: number, v: string) => {
    const s = slots.nth(i);
    const btn = s.locator("button.attr-value");
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await s.locator("input").fill(v); await s.locator("input").press("Enter"); await page.waitForTimeout(900);
  };
  await editSlot(0, "dup");
  await mrow.locator(".attr-multi-add").click(); await page.waitForTimeout(800);
  await editSlot(1, "dup");
  out.multiDup = (await attrs(N)).m_txt;
  await mrow.locator(".attr-multi-remove").first().click(); await page.waitForTimeout(900);
  out.multiAfterRemove = (await attrs(N)).m_txt;

  // D) Stale select options: the server value no longer in options.
  await put(N, "s_sel", "c");
  out.removeOptionC = String(await setOptions("s_sel", ["a", "b"]));
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  const ssel = row(page, "s_sel").locator("select");
  out.staleSelectUi = `shown=${JSON.stringify(await ssel.inputValue())} options=${JSON.stringify(await ssel.locator("option").allInnerTexts())} server=${(await attrs(N)).s_sel}`;
  out.staleFeatured = JSON.stringify(await page.locator(".ff-cell", { has: page.locator(".ff-label", { hasText: /^s_sel$/ }) }).innerText().catch(() => "-"));
  // Another tab removes option "b" while this tab still lists it; pick "b".
  out.removeOptionBElsewhere = String(await setOptions("s_sel", ["a"]));
  await page.waitForTimeout(2500);
  out.optionsAfterRemoteChange = JSON.stringify(await ssel.locator("option").allInnerTexts());
  await ssel.selectOption("b").catch((e) => { out.pickStale = String(e).slice(0, 80); });
  await page.waitForTimeout(1500);
  out.pickRemovedOption = `ui=${JSON.stringify(await ssel.inputValue().catch(() => "?"))} server=${(await attrs(N)).s_sel} err=${JSON.stringify((await page.locator(".attr-panel-error, .failed-write-recovery, [role=alert]").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 200))}`;
  const rec = page.locator(".failed-write-recovery");
  if (await rec.isVisible().catch(() => false)) await page.getByRole("button", { name: "Minimize recovery panel" }).click().catch(() => {});

  // E) 503 on a select change: does the selection stay?
  await setOptions("s_sel", ["a", "b", "c"]);
  await put(N, "s_sel", "a");
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await page.route(`**/api/nodes/${N}/attributes/s_sel`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await row(page, "s_sel").locator("select").selectOption("b");
  await page.waitForTimeout(1500);
  out.on503 = `ui=${await row(page, "s_sel").locator("select").inputValue()} server=${(await attrs(N)).s_sel} sync=${JSON.stringify((await page.locator(".sync-indicator, [class*=sync-status]").allInnerTexts()).join(" ").slice(0, 80))}`;
  await page.unroute(`**/api/nodes/${N}/attributes/s_sel`);
  await ready(page, `/?view=notes&node=${N}`);
  await openPanel(page);
  await page.waitForTimeout(3000);
  out.after503Reload = `ui=${await row(page, "s_sel").locator("select").inputValue()} server=${(await attrs(N)).s_sel}`;

  // F) Media: upload failure feedback, URL typing writes.
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/med")) puts.push(JSON.parse(r.postData() ?? "{}").value); });
  await row(page, "med").locator("input[type=url]").pressSequentially("https://x.io/a.png", { delay: 30 });
  await page.waitForTimeout(1500);
  out.mediaTypingPuts = `count=${puts.length} server=${(await attrs(N)).med}`;
  await page.route("**/api/media", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  const uploadBtn = row(page, "med").locator("button");
  out.mediaButtons = JSON.stringify(await uploadBtn.allInnerTexts());
  const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null), uploadBtn.first().click()]);
  if (fc) await fc.setFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
  await page.waitForTimeout(1500);
  out.mediaUpload503 = `server=${(await attrs(N)).med} feedback=${JSON.stringify((await page.locator("[role=status], [role=alert], .attr-panel-error").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 160))}`;
  await page.unroute("**/api/media");

  // G) Unreadable relation target, seen by another human (editor).
  const secret = await mk(`SecretRel ${stamp}`, false);
  await hideFromOthers(page.request, secret);
  await put(N, "rel", secret, "node_ref");
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `T05 ${stamp}`, email: `t05-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `T05 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, `/?view=notes&node=${N}`);
  await openPanel(hp).catch(() => {});
  out.editorRelApi = (await attrs(N, hp)).rel ?? "(none)";
  out.editorRelUi = JSON.stringify((await row(hp, "rel").innerText().catch(() => "-")).replace(/\s+/g, " "));
  await row(hp, "rel").locator("button.attr-value").click().catch(() => {});
  await hp.locator(".attr-relation-picker input").fill("SecretRel").catch(() => {});
  out.editorCandidates = JSON.stringify(await hp.locator(".attr-relation-option").allInnerTexts().catch(() => []));
  out.editorBodyHasSecret = String((await hp.locator("body").innerText()).includes(`SecretRel ${stamp}`));
  await human.close();

  // H) Phone: the panel / featured cells for select + multi.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${N}`);
  await pp.waitForTimeout(1000);
  out.phone = JSON.stringify(await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    ff: [...document.querySelectorAll(".ff-cell .ff-label")].map((e) => e.textContent),
    panel: !!document.querySelector(".attr-panel"),
  })));
  const fsel = pp.locator(".ff-cell", { has: pp.locator(".ff-label", { hasText: /^s_sel$/ }) });
  if (await fsel.isVisible().catch(() => false)) {
    await fsel.click(); await pp.locator(".ff-cell--editing select").selectOption("c").catch(() => {});
    await pp.waitForTimeout(1200);
    out.phoneSelect = (await attrs(N)).s_sel;
  }
  await phone.close();
  console.log(`AUDIT TAG-05 ${JSON.stringify(out, null, 1)}`);
});
