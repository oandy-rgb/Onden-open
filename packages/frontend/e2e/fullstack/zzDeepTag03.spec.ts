// Feature-audit deepening (2026-10-07): TAG-03 — schema field authoring when
// the field already carries values: type change, removal (usage badge +
// confirm), rejected saves, 503/offline, and drafts vs. refreshes (slow initial
// load, another tab editing the same schema). 1280 + 390px.
import { test, expect, type Page } from "@playwright/test";
import { ready, openFieldEditor, tagFieldLine, BASE, H } from "./helpers";


test("TAG-03: field edits with existing values, rejected saves, drafts vs refresh", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const FIELDS = [
    { name: "f_num", type: "number" }, { name: "f_txt", type: "text" },
    { name: "f_sel", type: "select", options: ["a", "b"] },
  ];
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T03${stamp}`, fields: FIELDS } })).json();
  const tagId = tag.id as string;
  const mkNote = async (title: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tagId}`, { ...H, data: {} });
    return n.id as string;
  };
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).map((a) => [a.key, `${a.value}|${a.value_type}`]));
  const put = async (id: string, key: string, value: string, value_type = "text") => {
    const r = await page.request.put(`/api/nodes/${id}/attributes/${key}`, { ...H, data: { value, value_type } });
    return r.status() === 200 ? "200" : `${r.status()} ${(await r.text()).slice(0, 80)}`;
  };
  const schema = async () => ((await (await page.request.get("/api/tags")).json()) as { id: string; schema_fields: { name: string; type: string; label?: string; options?: string[] }[] }[]).find((t) => t.id === tagId)?.schema_fields ?? [];
  const patch = async (fields: unknown) => {
    const r = await page.request.patch(`/api/tags/${tagId}/schema`, { ...H, data: { fields } });
    return `${r.status()} ${(await r.text()).slice(0, 90)}`;
  };
  const usage = async () => JSON.stringify(((await (await page.request.get(`/api/tags/${tagId}/delete-preview`)).json()) as { fields: { name: string; values_count: number }[] }).fields.map((f) => `${f.name}:${f.values_count}`));

  const N = await mkNote(`T03Note ${stamp}`);
  out.seed = [await put(N, "f_num", "5", "number"), await put(N, "f_txt", "hello"), await put(N, "f_sel", "a")].join(",");
  out.usageBefore = await usage();

  // A) API: type change / removal with values present.
  const base = await schema();
  out.patchTxtToNumber = await patch(base.map((f) => f.name === "f_txt" ? { ...f, type: "number" } : f));
  out.afterTypeChangeStored = JSON.stringify(await attrs(N));
  out.rewriteSameTextAfterTypeChange = await put(N, "f_txt", "hello");
  out.writeOtherFieldWhileStale = await put(N, "f_num", "6", "number");
  out.patchNumToDate = await patch((await schema()).map((f) => f.name === "f_num" ? { ...f, type: "date" } : f));
  out.numAsDateStored = JSON.stringify((await attrs(N)).f_num);
  out.patchRemoveSel = await patch((await schema()).filter((f) => f.name !== "f_sel"));
  out.removedSelStored = JSON.stringify((await attrs(N)).f_sel);
  out.removedSelFreeForm = await put(N, "f_sel", "zzz");
  out.readdSelWithOptions = await patch([...(await schema()), { name: "f_sel", type: "select", options: ["a", "b"] }]);
  out.staleValueAfterReadd = JSON.stringify((await attrs(N)).f_sel);
  out.staleRewrite = await put(N, "f_sel", "zzz");
  out.usageAfter = await usage();

  // Rejected saves: what the server refuses (or silently stores).
  const good = await schema();
  const rejects: string[] = [];
  for (const [label, body] of [
    ["empty-name", [...good, { name: "", type: "text" }]],
    ["dup-name", [...good, { name: "f_txt", type: "text" }]],
    ["bad-type", [...good, { name: "f_bad", type: "nonsense" }]],
    ["non-object", [...good, 42]],
    ["options-not-array", [...good, { name: "f_o", type: "select", options: "a,b" }]],
  ] as [string, unknown][]) {
    rejects.push(`${label} → ${await patch(body)} stored=${JSON.stringify((await schema()).map((f) => (f && typeof f === "object") ? `${f.name}:${f.type}` : String(f)))}`);
    await patch(good); // restore
  }
  out.rejects = rejects.join("\n");

  // B) UI: tag page — a chip per field; a chip opens that field's settings
  //    (usage badge, type change, removal) in a popover.
  await ready(page, `/?view=notes&node=${tagId}`);
  const chips = tagFieldLine(page).locator(".tag-field-item[data-field]");
  await expect(chips.first()).toBeVisible();
  await page.waitForTimeout(1200);
  const fieldPopover = (p: Page = page) => p.getByRole("dialog", { name: "Field settings", exact: true });
  const nameInput = (p: Page = page) => fieldPopover(p).locator("input.actors-input").first();
  const closePopover = async (p: Page = page) => { if (await fieldPopover(p).isVisible()) await fieldPopover(p).getByRole("button", { name: "OK", exact: true }).click(); };
  // The title row shows a label only while saving or after a problem; a saved state says nothing.
  const metaText = async (p: Page = page) => (await p.locator(".schema-lens-meta").count()) ? await p.locator(".schema-lens-meta").first().innerText() : "(none: saved)";
  const badges: string[] = [];
  for (const name of await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-field") ?? ""))) {
    const popover = await openFieldEditor(page, name);
    badges.push(`${await nameInput().inputValue()}:${await popover.locator(".schema-field-usage").innerText().catch(() => "-")}`);
    await closePopover();
  }
  out.uiBadges = JSON.stringify(badges);
  const patches: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/schema")) patches.push((r.postData() ?? "").slice(0, 400)); });

  // Type change on a populated field: is there a pause?
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
  let txt = await openFieldEditor(page, "f_txt");
  await txt.locator("select").first().selectOption("date");
  await page.waitForTimeout(400);
  out.typeChangeConfirmShown = String(await page.locator(".confirm-dialog").isVisible().catch(() => false) || dialogs > 0);
  await page.waitForTimeout(1200);
  out.typeChangeServer = JSON.stringify((await schema()).find((f) => f.name === "f_txt")?.type);
  out.typeChangeStatus = await metaText();
  await txt.locator("select").first().selectOption("text");
  await page.waitForTimeout(1200);

  // Remove a populated field: confirm text, cancel keeps it, confirm removes.
  await txt.getByRole("button", { name: "Delete field", exact: true }).click();
  await expect(page.locator(".confirm-dialog")).toBeVisible();
  out.removeConfirmText = await page.locator(".confirm-dialog-message").innerText();
  await page.getByRole("alertdialog").getByRole("button").filter({ hasNotText: /Remove/ }).first().click();
  await page.waitForTimeout(1000);
  out.removeCancelKept = String((await schema()).some((f) => f.name === "f_txt"));
  out.removeCancelPopoverOpen = String(await fieldPopover().isVisible());
  if (!await fieldPopover().isVisible()) txt = await openFieldEditor(page, "f_txt");
  await txt.getByRole("button", { name: "Delete field", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button").last().click();
  await page.waitForTimeout(1500);
  out.removeConfirmServer = JSON.stringify((await schema()).map((f) => f.name));
  out.removedValueKept = JSON.stringify((await attrs(N)).f_txt);
  // Usage badge after the removal + add a field back with the same key.
  const added = await openFieldEditor(page);
  await nameInput().fill("f_txt");
  await nameInput().blur();
  await page.waitForTimeout(1500);
  out.readdedViaUi = JSON.stringify((await schema()).map((f) => `${f.name}:${f.label ?? ""}`));
  out.readdedBadge = (await added.locator(".schema-field-usage").innerText().catch(() => "-"));
  await closePopover();

  // C) Rejected / failed saves keep the draft and say so.
  await page.route(`**/api/tags/${tagId}/schema`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 400, body: JSON.stringify({ error: "bad" }), contentType: "application/json" }) : r.continue());
  await openFieldEditor(page, "f_num");
  await nameInput().fill("Num label 400");
  await page.waitForTimeout(1800);
  out.on400 = `status=${await metaText()} draft=${await nameInput().inputValue().catch(() => "?")} toast=${JSON.stringify((await page.locator("[role=status], [role=alert]").allInnerTexts()).join(" ").slice(0, 120))}`;
  await page.unroute(`**/api/tags/${tagId}/schema`);
  await page.route(`**/api/tags/${tagId}/schema`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  if (!await fieldPopover().isVisible()) await openFieldEditor(page, "f_num");
  await nameInput().fill("Num label 503");
  await page.waitForTimeout(1800);
  out.on503 = `status=${await metaText()} server=${JSON.stringify((await schema()).find((f) => f.name === "f_num")?.label ?? null)}`;
  await page.unroute(`**/api/tags/${tagId}/schema`);
  await expect.poll(async () => (await schema()).find((f) => f.name === "f_num")?.label ?? null, { timeout: 45_000 }).toBe("Num label 503").catch(() => {});
  out.after503Drain = `server=${JSON.stringify((await schema()).find((f) => f.name === "f_num")?.label ?? null)} status=${await metaText()}`;
  await closePopover();

  // D) Refresh vs draft (1): the editor's initial /api/tags read is slow and
  // the user types before it lands.
  // Fetch now (pre-edit snapshot), deliver late: the response predates the typed draft.
  await page.route("**/api/tags", async (r) => { if (r.request().method() !== "GET") return r.continue(); const resp = await r.fetch(); await new Promise((res) => setTimeout(res, 3500)); await r.fulfill({ response: resp }); });
  await ready(page, `/?view=notes&node=${tagId}`);
  await openFieldEditor(page, "f_num");
  const firstInput = nameInput();
  await firstInput.waitFor();
  await firstInput.fill("Typed before load");
  await page.waitForTimeout(5000);
  out.slowLoadDraft = `input=${JSON.stringify(await firstInput.inputValue().catch(() => "(popover closed)"))} server=${JSON.stringify((await schema()).map((f) => f.label ?? f.name))}`;
  await page.unroute("**/api/tags");
  await closePopover();

  // Refresh vs draft (2): another tab adds a field while this page is open;
  // this tab then edits a label. Is the remote field shown? kept?
  await ready(page, `/?view=notes&node=${tagId}`);
  await expect(chips.first()).toBeVisible();
  await page.waitForTimeout(1500);
  const remote = [...(await schema()), { name: "f_remote", type: "text", label: "Remote added" }];
  out.remotePatch = await patch(remote);
  await page.waitForTimeout(4000);
  out.remoteFieldShownWithoutReload = String(await tagFieldLine(page).locator('.tag-field-item[data-field="f_remote"]').count() > 0);
  await openFieldEditor(page, "f_num");
  await nameInput().fill("Local edit after remote");
  await page.waitForTimeout(2000);
  out.afterLocalEdit = JSON.stringify((await schema()).map((f) => f.label ?? f.name));
  out.remoteFieldSurvived = String((await schema()).some((f) => f.name === "f_remote"));
  out.patchBodies = patches.slice(-3).join("\n");
  await closePopover();

  // E) Phone.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${tagId}`);
  await openFieldEditor(pp, "f_num");
  await pp.waitForTimeout(1000);
  out.phoneGeo = JSON.stringify(await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    chips: [...document.querySelectorAll(".tag-field-item")].map((r) => Math.round(r.getBoundingClientRect().right)),
    popoverRight: Math.round(document.querySelector(".tag-field-popover")?.getBoundingClientRect().right ?? 0),
    removeBtnH: Math.round((document.querySelector(".tag-field-popover-delete") as HTMLElement)?.getBoundingClientRect().height ?? 0),
  })));
  await nameInput(pp).fill("Phone label");
  await pp.waitForTimeout(1800);
  out.phoneSave = JSON.stringify((await schema()).map((f) => f.label ?? f.name));
  await pp.screenshot({ path: "/tmp/pw-output/tag03-phone.png", fullPage: true }).catch(() => {});
  await phone.close();
  void expect; void (null as unknown as Page);
  console.log(`AUDIT TAG-03 ${JSON.stringify(out, null, 1)}`);
});
