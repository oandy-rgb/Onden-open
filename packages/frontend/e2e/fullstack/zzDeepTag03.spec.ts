// Feature-audit deepening (2026-10-07): TAG-03 — schema field authoring when
// the field already carries values: type change, removal (usage badge +
// confirm), rejected saves, 503/offline, and drafts vs. refreshes (slow initial
// load, another tab editing the same schema). 1280 + 390px.
import { test, expect, type Page } from "@playwright/test";
import { ready, openFieldEditor, addTagField, tagFieldLine, BASE, H } from "./helpers";


// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
const FIELDS = [
  { name: "f_num", type: "number" }, { name: "f_txt", type: "text" },
  { name: "f_sel", type: "select", options: ["a", "b"] },
];

async function makeTag(page: Page, stamp: number) {
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T03${stamp}`, fields: FIELDS } })).json();
  const tagId = tag.id as string;
  const schema = async () => ((await (await page.request.get("/api/tags")).json()) as { id: string; schema_fields: { name: string; type: string; label?: string; options?: string[] }[] }[]).find((t) => t.id === tagId)?.schema_fields ?? [];
  const labelOf = async (name: string) => (await schema()).find((f) => f.name === name)?.label ?? null;
  return { tagId, schema, labelOf };
}

test("TAG-03: field edits with existing values, rejected saves, drafts vs refresh", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const { tagId, schema, labelOf } = await makeTag(page, stamp);
  const mkNote = async (title: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tagId}`, { ...H, data: {} });
    return n.id as string;
  };
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).map((a) => [a.key, `${a.value}|${a.value_type}`]));
  const put = async (id: string, key: string, value: string, value_type = "text") => {
    const r = await page.request.put(`/api/nodes/${id}/attributes/${key}`, { ...H, data: { value, value_type } });
    return { status: r.status(), error: r.status() === 200 ? "" : (await r.json()).error as string, detail: r.status() === 200 ? "" : (await r.json()).detail as string };
  };
  const patch = async (fields: unknown) => (await page.request.patch(`/api/tags/${tagId}/schema`, { ...H, data: { fields } }));
  const usage = async () => ((await (await page.request.get(`/api/tags/${tagId}/delete-preview`)).json()) as { fields: { name: string; values_count: number }[] }).fields.map((f) => `${f.name}:${f.values_count}`);

  const N = await mkNote(`T03Note ${stamp}`);
  expect([(await put(N, "f_num", "5", "number")).status, (await put(N, "f_txt", "hello")).status, (await put(N, "f_sel", "a")).status]).toEqual([200, 200, 200]);
  expect(await usage(), "the usage badge counts the notes holding a value per field").toEqual(["f_num:1", "f_txt:1", "f_sel:1"]);

  // A) API: type change / removal with values present.
  const base = await schema();
  // pinned: today's behaviour, no written rule (a type change on a populated field is accepted and leaves stored values as they are)
  expect((await patch(base.map((f) => f.name === "f_txt" ? { ...f, type: "number" } : f))).status()).toBe(200);
  expect((await attrs(N)).f_txt).toBe("hello|text");
  // A value written now is judged by the field's current type (services/attributeChange.ts: 422 field_invalid) …
  const rewrite = await put(N, "f_txt", "hello");
  expect(rewrite.status).toBe(422);
  expect(rewrite.error).toBe("field_invalid");
  // … and only the key written is judged: another field is still writable.
  expect((await put(N, "f_num", "6", "number")).status).toBe(200);
  // pinned: today's behaviour, no written rule (a number field changed to date keeps its stored value untouched)
  expect((await patch((await schema()).map((f) => f.name === "f_num" ? { ...f, type: "date" } : f))).status()).toBe(200);
  expect((await attrs(N)).f_num).toBe("6|text");
  // Removing a field keeps its values as plain properties (i18n 「The values stay as plain properties」), which then take any value.
  expect((await patch((await schema()).filter((f) => f.name !== "f_sel"))).status()).toBe(200);
  expect((await attrs(N)).f_sel).toBe("a|text");
  expect((await put(N, "f_sel", "zzz")).status).toBe(200);
  // pinned: today's behaviour, no written rule (re-adding the field keeps the off-list value "zzz" as it was)
  expect((await patch([...(await schema()), { name: "f_sel", type: "select", options: ["a", "b"] }])).status()).toBe(200);
  expect((await attrs(N)).f_sel).toBe("zzz|text");
  // A value written now must be one of the options (fieldViolation, attributeChange.ts).
  const staleRewrite = await put(N, "f_sel", "zzz");
  expect(staleRewrite.status).toBe(422);
  expect(staleRewrite.detail).toContain("must be one of: a, b");
  expect(await usage(), "values stay counted whatever happened to the field").toEqual(["f_num:1", "f_txt:1", "f_sel:1"]);

  // Rejected saves: a field needs a name, a known type, and an array for options (fieldSchema.ts attributeFieldSchema → 400 invalid_field);
  // a refused save changes nothing.
  const good = await schema();
  const signature = (list: unknown[]) => list.map((f) => (f && typeof f === "object") ? `${(f as { name: string }).name}:${(f as { type: string }).type}` : String(f));
  for (const [label, body] of [
    ["empty-name", [...good, { name: "", type: "text" }]],
    ["bad-type", [...good, { name: "f_bad", type: "nonsense" }]],
    ["non-object", [...good, 42]],
    ["options-not-array", [...good, { name: "f_o", type: "select", options: "a,b" }]],
  ] as [string, unknown][]) {
    const r = await patch(body);
    expect(r.status(), label).toBe(400);
    expect((await r.json()).error, label).toBe("invalid_field");
    expect(signature(await schema()), label).toEqual(signature(good));
  }
  // pinned: today's behaviour, no written rule (a second field with a name this tag already has is accepted; the field-name rule only covers names inherited from other tags)
  expect((await patch([...good, { name: "f_txt", type: "text" }])).status()).toBe(200);
  expect(signature(await schema())).toEqual([...signature(good), "f_txt:text"]);
  await patch(good);

  // B) UI: tag page — a chip per field; a chip opens that field's settings (usage badge, type change, removal) in a popover.
  await ready(page, `/?view=notes&node=${tagId}`);
  const chips = tagFieldLine(page).locator(".tag-field-item[data-field]");
  await expect(chips.first()).toBeVisible();
  const fieldPopover = (p: Page = page) => p.getByRole("dialog", { name: "Field settings", exact: true });
  const nameInput = (p: Page = page) => fieldPopover(p).locator("input.actors-input").first();
  const closePopover = async (p: Page = page) => { if (await fieldPopover(p).isVisible()) await fieldPopover(p).getByRole("button", { name: "OK", exact: true }).click(); };
  // The title row shows a label only while saving or after a problem; a saved state says nothing (useTagStructure.ts savingNotice).
  const meta = (p: Page = page) => p.locator(".schema-lens-meta");
  for (const name of await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-field") ?? ""))) {
    const popover = await openFieldEditor(page, name);
    expect(await nameInput().inputValue()).toBe(name);
    await expect(popover.locator(".schema-field-usage"), "the usage badge (i18n 「{n} in use」)").toHaveText("1 in use");
    await closePopover();
  }
  const patches: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/schema")) patches.push(r.postData() ?? ""); });

  // Type change on a populated field.
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
  let txt = await openFieldEditor(page, "f_txt");
  await txt.locator("select").first().selectOption("date");
  await expect.poll(async () => (await schema()).find((f) => f.name === "f_txt")?.type).toBe("date");
  // pinned: today's behaviour, no written rule (changing the type of a populated field asks for no confirmation)
  expect(await page.locator(".confirm-dialog").count() + dialogs).toBe(0);
  await expect(meta(), "a saved state says nothing").toHaveCount(0);
  await txt.locator("select").first().selectOption("text");
  await expect.poll(async () => (await schema()).find((f) => f.name === "f_txt")?.type).toBe("text");
  await expect(meta()).toHaveCount(0); // the save has finished (the popover is rebuilt by it)

  // Remove a populated field: the confirmation says how many notes hold values and that they stay; cancel keeps the field; confirm removes it.
  await txt.getByRole("button", { name: "Delete field", exact: true }).click();
  await expect(page.locator(".confirm-dialog")).toBeVisible();
  await expect(page.locator(".confirm-dialog-message")).toHaveText('"f_txt" has values on 1 note(s). Remove the field? The values stay as plain properties.');
  // The buttons are pressed with a dispatched click: in this flow a mouse click on the confirmation was twice intercepted by the field popover (not reproduced in isolation; see the PR text).
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).dispatchEvent("click");
  await expect(page.locator(".confirm-dialog")).toHaveCount(0);
  expect((await schema()).some((f) => f.name === "f_txt")).toBe(true);
  if (!await fieldPopover().isVisible()) txt = await openFieldEditor(page, "f_txt"); // a pointer press outside the popover closes it; a dispatched click does not
  await txt.getByRole("button", { name: "Delete field", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove field", exact: true }).dispatchEvent("click");
  await expect.poll(async () => (await schema()).map((f) => f.name)).toEqual(["f_num", "f_sel"]);
  expect((await attrs(N)).f_txt, "the values stay as plain properties").toBe("hello|text");
  // Add a field back with the same key: the stored values count again.
  await addTagField(page, "f_txt");
  await expect.poll(async () => (await schema()).map((f) => f.name)).toEqual(["f_num", "f_sel", "f_txt"]);
  // pinned: today's behaviour, no written rule (a field added by name gets that name as its label)
  expect((await schema()).find((f) => f.name === "f_txt")?.label).toBe("f_txt");
  const added = await openFieldEditor(page, "f_txt");
  await expect(added.locator(".schema-field-usage")).toHaveText("1 in use");
  await closePopover();

  // C) A refused or failed save keeps the draft and says so (errors-and-saves.md: 保留可恢復輸入; unknown server codes show the generic message, lib/serverErrors.ts).
  await page.route(`**/api/tags/${tagId}/schema`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 400, body: JSON.stringify({ error: "bad" }), contentType: "application/json" }) : r.continue());
  await openFieldEditor(page, "f_num");
  await nameInput().fill("Num label 400");
  await expect(meta()).toHaveText("Save failed");
  expect(await nameInput().inputValue()).toBe("Num label 400");
  await expect(page.locator(".toast-message").filter({ hasText: "Something went wrong on the server." }).first()).toBeVisible();
  expect(await labelOf("f_num")).toBeNull();
  await page.unroute(`**/api/tags/${tagId}/schema`);
  // A 503 is retryable: the edit shows as waiting to sync, the server has nothing yet, and it lands when the server answers again.
  await page.route(`**/api/tags/${tagId}/schema`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  if (!await fieldPopover().isVisible()) await openFieldEditor(page, "f_num");
  await nameInput().fill("Num label 503");
  await expect(meta()).toHaveText("Waiting to sync");
  expect(await labelOf("f_num")).toBeNull();
  await page.unroute(`**/api/tags/${tagId}/schema`);
  await expect.poll(() => labelOf("f_num"), { timeout: 45_000 }).toBe("Num label 503");
  // pinned: today's behaviour, no written rule (after the queue has drained the label still says "Waiting to sync" until the next save)
  await expect(meta()).toHaveText("Waiting to sync");
  await closePopover();

  // D) Another tab adds a field while this page is open, then this tab edits a label.
  await ready(page, `/?view=notes&node=${tagId}`);
  await expect(chips.first()).toBeVisible();
  const remote = [...(await schema()), { name: "f_remote", type: "text", label: "Remote added" }];
  expect((await patch(remote)).status()).toBe(200);
  // The editor follows the tag list the store holds (sync keeps it current), so the open page shows the field another tab added.
  await expect.poll(() => tagFieldLine(page).locator('.tag-field-item[data-field="f_remote"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await openFieldEditor(page, "f_num");
  await nameInput().fill("Local edit after remote");
  await expect.poll(() => labelOf("f_num")).toBe("Local edit after remote");
  // The save sends this tab's whole field list, which now includes the field the other tab added: it survives.
  expect((await schema()).some((f) => f.name === "f_remote")).toBe(true);
  // The save carries the list of fields and nothing else (useSchemaDraft: one PATCH of the slices edited).
  expect(patches.length).toBeGreaterThan(0);
  for (const body of patches) expect(Object.keys(JSON.parse(body))).toEqual(["fields"]);
  await closePopover();

  // E) Phone: same save contract, no horizontal overflow, tap targets of at least 44px (e2e/layout-audit R7).
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${tagId}`);
  await openFieldEditor(pp, "f_num");
  const geo = await pp.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    chips: [...document.querySelectorAll(".tag-field-item")].map((r) => Math.round(r.getBoundingClientRect().right)),
    popoverRight: Math.round(document.querySelector(".tag-field-popover")?.getBoundingClientRect().right ?? 0),
    removeBtnH: Math.round((document.querySelector(".tag-field-popover-delete") as HTMLElement)?.getBoundingClientRect().height ?? 0),
  }));
  expect(geo.doc).toBeLessThanOrEqual(390);
  expect(Math.max(...geo.chips)).toBeLessThanOrEqual(390);
  expect(geo.popoverRight).toBeGreaterThan(0);
  expect(geo.popoverRight).toBeLessThanOrEqual(390);
  expect(geo.removeBtnH).toBeGreaterThanOrEqual(44);
  await nameInput(pp).fill("Phone label");
  await expect.poll(() => labelOf("f_num")).toBe("Phone label");
  await phone.close();
});

// A slow, older read of the tag list must not replace what was typed meanwhile (AGENTS.md 「保留較新修改與可恢復輸入」). The editor
// has no read of its own (useSchemaDraft follows the store's tag list), so nothing late can put the previous label back into the input.
test("a slow first read of the tag list does not replace what was typed meanwhile", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const { tagId, labelOf } = await makeTag(page, stamp);
  await expect.poll(() => labelOf("f_num")).toBeNull();
  await ready(page, `/?view=notes&node=${tagId}`);
  await expect(tagFieldLine(page).locator(".tag-field-item[data-field]").first()).toBeVisible();
  // Fetch now (before the edit), deliver late: the response predates the typed label.
  let delivered: () => void = () => {};
  const landed = new Promise<void>((res) => { delivered = res; });
  // Nothing in the app has to read /api/tags again now, so `landed` may never come: judge after the late read's delay at the latest.
  await page.route("**/api/tags", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const resp = await r.fetch();
    await new Promise((res) => setTimeout(res, 3500));
    await r.fulfill({ response: resp });
    delivered();
  });
  await ready(page, `/?view=notes&node=${tagId}`);
  await openFieldEditor(page, "f_num");
  const input = page.getByRole("dialog", { name: "Field settings", exact: true }).locator("input.actors-input").first();
  await input.waitFor();
  await input.fill("Typed before load");
  await expect.poll(() => labelOf("f_num")).toBe("Typed before load");
  await Promise.race([landed, page.waitForTimeout(5000)]);
  // Give the late read a bounded chance to show up in the input before judging.
  await expect.poll(() => input.inputValue(), { timeout: 3000 }).not.toBe("Typed before load").catch(() => {});
  expect(await input.inputValue()).toBe("Typed before load");
});
