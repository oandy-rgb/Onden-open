// Feature-audit deepening (2026-10-07): TAG-04 — every schema field type and
// custom value type: empty / valid / invalid / modify / clear through the API,
// zero and false, Enter vs blur in featured cells and the inspector, phone.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";


const FIELDS = [
  { name: "f_text", type: "text" }, { name: "f_area", type: "textarea" }, { name: "f_rich", type: "richtext" },
  { name: "f_num", type: "number" }, { name: "f_rate", type: "rating", max: 5 }, { name: "f_bool", type: "boolean" },
  { name: "f_date", type: "date" }, { name: "f_sel", type: "select", options: ["a", "b"] },
  { name: "f_media", type: "media" }, { name: "f_rel", type: "relation" },
  { name: "f_req", type: "text", required: true },
];

test("TAG-04: field types through API, featured cells, inspector and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T04${stamp}`, fields: FIELDS } })).json();
  const mkNote = async (title: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
    const r = await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    out[`apply:${title.split(" ")[0]}`] = String(r.status());
    return n.id as string;
  };
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `RelTarget ${stamp}`, markdown: "t" } })).json();
  const api = await mkNote(`ApiNote ${stamp}`);
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_ref?: string; value_type: string }[]).map((a) => [a.key, `${a.value ?? ""}|${a.value_ref ?? ""}|${a.value_type}`]));
  const put = async (id: string, key: string, data: Record<string, unknown>) => {
    const r = await page.request.put(`/api/nodes/${id}/attributes/${key}`, { ...H, data });
    return r.status() === 200 ? "200" : `${r.status()} ${(await r.text()).slice(0, 70)}`;
  };

  // A) API matrix.
  const cases: [string, string, string?][] = [
    ["f_text", ""], ["f_text", "hello"], ["f_text", "changed"],
    ["f_area", "line1\nline2"], ["f_rich", "**bold** <script>x</script>"],
    ["f_num", "0", "number"], ["f_num", "-1.5", "number"], ["f_num", "1e3", "number"], ["f_num", "0x10", "number"], ["f_num", " ", "number"], ["f_num", "Infinity", "number"], ["f_num", "abc", "number"], ["f_num", "", "number"],
    ["f_rate", "0", "number"], ["f_rate", "5", "number"], ["f_rate", "6", "number"], ["f_rate", "2.5", "number"], ["f_rate", "-1", "number"],
    ["f_bool", "false", "bool"], ["f_bool", "true", "bool"], ["f_bool", "1", "bool"], ["f_bool", "TRUE", "bool"], ["f_bool", "", "bool"],
    ["f_date", "2026-10-07", "date"], ["f_date", "2026-10-07T10:00:00Z", "date"], ["f_date", "2026-02-30", "date"], ["f_date", "2026-13-45", "date"], ["f_date", "10/07/2026", "date"],
    ["f_sel", "a"], ["f_sel", "c"], ["f_sel", ""],
    ["f_media", "https://example.com/a.png"], ["f_media", "javascript:alert(1)"],
    ["f_req", ""], ["f_req", "present"], ["f_req", ""],
  ];
  const matrix: string[] = [];
  for (const [k, v, vt] of cases) matrix.push(`${k}=${JSON.stringify(v)} → ${await put(api, k, { value: v, value_type: vt ?? "text" })}`);
  matrix.push(`f_rel=ref(target) → ${await put(api, "f_rel", { value_ref: target.id, value_type: "node_ref" })}`);
  matrix.push(`f_rel=ref(random) → ${await put(api, "f_rel", { value_ref: "00000000-0000-4000-8000-000000000000", value_type: "node_ref" })}`);
  out.apiMatrix = matrix.join("\n");
  out.apiStored = JSON.stringify(await attrs(api));
  // Clear by DELETE, incl. the required one.
  const del = async (k: string) => { const r = await page.request.delete(`/api/nodes/${api}/attributes/${k}`, H); return `${r.status()} ${(await r.text()).slice(0, 60)}`; };
  out.apiDelete = `num:${await del("f_num")} bool:${await del("f_bool")} req:${await del("f_req")} rel:${await del("f_rel")}`;
  out.apiAfterDelete = JSON.stringify(await attrs(api));
  // Custom (non-schema) value types.
  const custom: string[] = [];
  for (const [vt, v] of [["text", "x"], ["number", "12"], ["number", "abc"], ["date", "2026-10-07"], ["date", "nope"], ["bool", "true"], ["bool", "maybe"], ["node_ref", "not-a-uuid"], ["weird", "x"]] as const) {
    custom.push(`${vt}:${JSON.stringify(v)} → ${await put(api, `c_${vt}_${custom.length}`, { value: v, value_type: vt })}`);
  }
  custom.push(`node_ref ref → ${await put(api, "c_ref", { value_ref: target.id, value_type: "node_ref" })}`);
  out.customTypes = custom.join("\n");

  // B) Featured cells (1280).
  const fNote = await mkNote(`Featured ${stamp}`);
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts.push(`${r.url().split("/attributes/")[1]}=${JSON.stringify(JSON.parse(r.postData() ?? "{}").value)}`); });
  await ready(page, `/?view=notes&node=${fNote}`);
  const ff = (p: Page, name: string) => p.locator(".ff-cell", { has: p.locator(".ff-label", { hasText: new RegExp(`^${name}$`) }) });
  await expect(ff(page, "f_num")).toBeVisible();
  out.featuredLabels = JSON.stringify(await page.locator(".featured-fields .ff-label").allInnerTexts());
  const ffEdit = async (name: string, v: string, how: "Enter" | "blur") => {
    await ff(page, name).click();
    const input = page.locator(".ff-cell--editing input");
    await input.fill(v);
    if (how === "Enter") await input.press("Enter"); else await page.locator(".obsidian-title-input, .cm-content").first().click();
    await page.waitForTimeout(900);
  };
  puts.length = 0; await ffEdit("f_num", "0", "Enter");
  out.ffNumZeroEnter = `puts=${JSON.stringify(puts)} cell=${await ff(page, "f_num").innerText()} server=${(await attrs(fNote)).f_num}`;
  puts.length = 0; await ffEdit("f_num", "", "blur");
  out.ffNumClearBlur = `puts=${JSON.stringify(puts)} cell=${JSON.stringify(await ff(page, "f_num").innerText())} server=${(await attrs(fNote)).f_num}`;
  await ff(page, "f_num").click();
  out.ffNumInputType = String(await page.locator(".ff-cell--editing input").getAttribute("type"));
  puts.length = 0;
  await page.locator(".ff-cell--editing input").pressSequentially("abc");
  await page.locator(".ff-cell--editing input").press("Enter"); await page.waitForTimeout(900);
  out.ffNumTypedLetters = `puts=${JSON.stringify(puts)} cell=${JSON.stringify(await ff(page, "f_num").innerText())} server=${(await attrs(fNote)).f_num}`;
  await page.keyboard.press("Escape");
  puts.length = 0; await ffEdit("f_text", "typed", "Enter");
  out.ffTextEnter = `puts=${JSON.stringify(puts)} server=${(await attrs(fNote)).f_text}`;
  puts.length = 0; await ffEdit("f_rate", "3", "Enter");
  out.ffRatingText = `inputType=${"text"} puts=${JSON.stringify(puts)} server=${(await attrs(fNote)).f_rate}`;
  puts.length = 0; await ffEdit("f_rate", "9", "Enter");
  out.ffRatingInvalid = `puts=${JSON.stringify(puts)} editing=${await page.locator(".ff-cell--editing").count()} server=${(await attrs(fNote)).f_rate} toast=${JSON.stringify((await page.locator("[role=status], [role=alert]").allInnerTexts()).join(" ").slice(0, 120))}`;
  await page.keyboard.press("Escape");
  const rec = page.locator(".failed-write-recovery");
  if (await rec.isVisible().catch(() => false)) {
    const rb = await rec.boundingBox(); const cb = await ff(page, "f_bool").boundingBox();
    out.recoveryPanelCoversField = `panel=${JSON.stringify(rb)} boolCell=${JSON.stringify(cb)}`;
    await page.getByRole("button", { name: "Minimize recovery panel" }).click();
  }
  await ff(page, "f_bool").click(); await page.waitForTimeout(800);
  const boolOn = `${await ff(page, "f_bool").innerText()}|${(await attrs(fNote)).f_bool}`;
  await ff(page, "f_bool").click(); await page.waitForTimeout(800);
  out.ffBool = `on=${boolOn} off=${await ff(page, "f_bool").innerText()}|${(await attrs(fNote)).f_bool}`;
  await ff(page, "f_date").click();
  await page.locator(".ff-cell--editing input").fill("2026-10-08");
  await page.locator(".ff-cell--editing input").press("Enter"); await page.waitForTimeout(900);
  out.ffDate = `server=${(await attrs(fNote)).f_date}`;
  await ff(page, "f_sel").click();
  await page.locator(".ff-cell--editing select").selectOption("b"); await page.waitForTimeout(900);
  const selB = (await attrs(fNote)).f_sel;
  await ff(page, "f_sel").click();
  await page.locator(".ff-cell--editing select").selectOption(""); await page.waitForTimeout(900);
  out.ffSelect = `b=${selB} cleared=${(await attrs(fNote)).f_sel} cell=${JSON.stringify(await ff(page, "f_sel").innerText())}`;
  puts.length = 0; await ffEdit("f_rel", `RelTarget ${stamp}`, "Enter");
  out.ffRelationAsText = `puts=${JSON.stringify(puts)} server=${(await attrs(fNote)).f_rel} cell=${JSON.stringify(await ff(page, "f_rel").innerText())}`;
  await page.keyboard.press("Escape");
  await ready(page, `/?view=notes&node=${fNote}`);
  await expect(ff(page, "f_num")).toBeVisible();
  out.ffAfterReload = JSON.stringify(Object.fromEntries(await Promise.all(["f_num", "f_text", "f_rate", "f_bool", "f_date", "f_sel"].map(async (k) => [k, (await ff(page, k).innerText()).replace(/\n/g, " ")]))));

  // C) Inspector (Properties panel).
  const iNote = await mkNote(`Inspector ${stamp}`);
  await ready(page, `/?view=notes&node=${iNote}`);
  const panel = page.locator(".attr-panel");
  out.inspectorVisible = String(await panel.isVisible().catch(() => false));
  if (await panel.isVisible().catch(() => false)) try {
    const row = (name: string) => panel.locator(".attr-row", { has: page.locator(".attr-key", { hasText: new RegExp(`\\b${name}$`) }) });
    puts.length = 0;
    await row("f_num").locator("input").pressSequentially("120", { delay: 120 });
    await page.waitForTimeout(1500);
    out.inspNumTyping = `puts=${JSON.stringify(puts)} server=${(await attrs(iNote)).f_num}`;
    puts.length = 0;
    await row("f_num").locator("input").fill("0"); await page.waitForTimeout(900);
    await row("f_num").locator("input").fill(""); await page.waitForTimeout(900);
    out.inspNumZeroThenClear = `puts=${JSON.stringify(puts)} server=${(await attrs(iNote)).f_num}`;
    await row("f_bool").locator("input[type=checkbox]").click(); await page.waitForTimeout(900);
    const bon = `${(await attrs(iNote)).f_bool}/checked=${await row("f_bool").locator("input[type=checkbox]").isChecked()}`;
    await row("f_bool").locator("input[type=checkbox]").click(); await page.waitForTimeout(900);
    out.inspBool = `on=${bon} off=${(await attrs(iNote)).f_bool} checked=${await row("f_bool").locator("input[type=checkbox]").isChecked()}`;
    await row("f_rate").getByRole("radio", { name: "3 stars" }).click(); await page.waitForTimeout(700);
    const r3 = (await attrs(iNote)).f_rate;
    await row("f_rate").getByRole("radio", { name: "3 stars" }).click(); await page.waitForTimeout(700);
    out.inspRating = `set3=${r3} clickAgain=${(await attrs(iNote)).f_rate}`;
    puts.length = 0;
    await row("f_text").locator("button.attr-value").click();
    await row("f_text").locator("input").fill("ent");
    await row("f_text").locator("input").press("Enter"); await page.waitForTimeout(900);
    out.inspTextEnterThenBlur = `puts=${JSON.stringify(puts)} server=${(await attrs(iNote)).f_text}`;
    puts.length = 0;
    await row("f_area").locator("button.attr-value").click();
    await row("f_area").locator("textarea").fill("l1");
    await row("f_area").locator("textarea").press("Enter");
    await row("f_area").locator("textarea").type("l2");
    await page.locator(".attr-panel-section-label").click(); await page.waitForTimeout(900);
    out.inspTextareaEnterNewlineBlur = `puts=${JSON.stringify(puts)} server=${JSON.stringify((await attrs(iNote)).f_area)}`;
    await row("f_date").locator("input[type=date]").fill("2026-10-09"); await page.waitForTimeout(700);
    const d1 = (await attrs(iNote)).f_date;
    await row("f_date").locator("input[type=date]").fill(""); await page.waitForTimeout(700);
    out.inspDate = `set=${d1} cleared=${(await attrs(iNote)).f_date}`;
    await row("f_sel").locator("select").selectOption("a"); await page.waitForTimeout(700);
    out.inspSelect = `server=${(await attrs(iNote)).f_sel}`;
    await row("f_req").locator("button.attr-value").click();
    await row("f_req").locator("input").fill("x"); await row("f_req").locator("input").press("Enter"); await page.waitForTimeout(800);
    await row("f_req").locator("button.attr-value").click();
    await row("f_req").locator("input").fill(""); await row("f_req").locator("input").press("Enter"); await page.waitForTimeout(1000);
    out.inspRequiredClear = `server=${(await attrs(iNote)).f_req} stillEditing=${await row("f_req").locator("input").count()} err=${JSON.stringify((await page.locator(".attr-panel-error, .attr-error, [role=alert]").allInnerTexts()).join(" ").slice(0, 120))}`;
    await page.keyboard.press("Escape");
    out.inspRelationWidget = (await row("f_rel").innerHTML()).replace(/\s+/g, " ").slice(0, 200);
    out.inspMediaWidget = (await row("f_media").innerHTML()).replace(/\s+/g, " ").slice(0, 200);
  } catch (e) { out.inspectorError = String(e).slice(0, 300); }

  // D) Phone viewport — featured cells.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  const pNote = await mkNote(`Phone ${stamp}`);
  await ready(pp, `/?view=notes&node=${pNote}`);
  await expect(ff(pp, "f_num")).toBeVisible();
  const geo = await pp.evaluate(() => {
    const g = document.querySelector(".featured-fields")!.getBoundingClientRect();
    const cells = [...document.querySelectorAll(".ff-cell")].map((c) => c.getBoundingClientRect());
    return { doc: document.documentElement.scrollWidth, ff: `${Math.round(g.left)}..${Math.round(g.right)}`, minH: Math.round(Math.min(...cells.map((c) => c.height))), maxRight: Math.round(Math.max(...cells.map((c) => c.right))) };
  });
  out.phoneGeo = JSON.stringify(geo);
  await ff(pp, "f_num").tap().catch(() => ff(pp, "f_num").click());
  await pp.locator(".ff-cell--editing input").fill("0");
  await pp.locator(".ff-cell--editing input").press("Enter");
  await pp.waitForTimeout(1000);
  await ff(pp, "f_bool").tap().catch(() => ff(pp, "f_bool").click());
  await pp.waitForTimeout(1000);
  out.phoneEdits = JSON.stringify(await attrs(pNote));
  out.phoneInspectorPresent = String(await pp.locator(".attr-panel").isVisible().catch(() => false));
  await pp.screenshot({ path: "/tmp/pw-output/tag04-phone.png", fullPage: true });
  await phone.close();
  console.log(`AUDIT TAG-04 ${JSON.stringify(out, null, 1)}`);
});
