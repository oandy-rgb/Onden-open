// Feature-audit deepening (2026-10-07): TAG-04 — every schema field type and
// custom value type: empty / valid / invalid / modify / clear through the API,
// zero and false, Enter vs blur in featured cells and the inspector, phone.
import { test, expect, type Page } from "@playwright/test";
import { ready, openInfoTags, BASE, H } from "./helpers";


const FIELDS = [
  { name: "f_text", type: "text" }, { name: "f_area", type: "textarea" }, { name: "f_rich", type: "richtext" },
  { name: "f_num", type: "number" }, { name: "f_rate", type: "rating", max: 5 }, { name: "f_bool", type: "boolean" },
  { name: "f_date", type: "date" }, { name: "f_sel", type: "select", options: ["a", "b"] },
  { name: "f_media", type: "media" }, { name: "f_rel", type: "relation" },
  { name: "f_req", type: "text", required: true },
];

// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
// The rules for a value written to a field are @onden/markdown attributeValue.ts: fieldViolation (what a field refuses) and
// normalize (how it is stored); the write path is PUT /api/nodes/:id/attributes/:key (routes/nodes.ts).
test("TAG-04: field types through API, featured cells, inspector and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `T04${stamp}`, fields: FIELDS } })).json();
  const mkNote = async (title: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
    const r = await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    expect(r.status(), `applying the tag to ${title}`).toBe(200);
    return n.id as string;
  };
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `RelTarget ${stamp}`, markdown: "t" } })).json();
  const api = await mkNote(`ApiNote ${stamp}`);
  // key → "value|type" as stored (a relation's value is the note id).
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).map((a) => [a.key, `${a.value ?? ""}|${a.value_type}`]));
  const stored = async (id: string, key: string) => (await attrs(id))[key];
  const put = async (id: string, key: string, data: Record<string, unknown>) => {
    const r = await page.request.put(`/api/nodes/${id}/attributes/${key}`, { ...H, data });
    return { status: r.status(), error: r.status() === 200 ? "" : (await r.json()).error as string };
  };

  // A) API matrix: [key, value, hint, expected status]. A field refuses what fieldViolation says; an empty value only a required field refuses.
  const cases: [string, string, string, number][] = [
    ["f_text", "", "text", 200], ["f_text", "hello", "text", 200], ["f_text", "changed", "text", 200],
    ["f_area", "line1\nline2", "text", 200], ["f_rich", "**bold** <script>x</script>", "text", 200],
    ["f_num", "0", "number", 200], ["f_num", "-1.5", "number", 200],
    // A stored number is NUMBER_PATTERN: optional minus, digits, optional decimals — no exponent, hex, blank or "Infinity".
    ["f_num", "1e3", "number", 422], ["f_num", "0x10", "number", 422], ["f_num", " ", "number", 422], ["f_num", "Infinity", "number", 422], ["f_num", "abc", "number", 422], ["f_num", "", "number", 200],
    // A rating is a whole number of stars from 0 to its max (5 here).
    ["f_rate", "0", "number", 200], ["f_rate", "5", "number", 200], ["f_rate", "6", "number", 422], ["f_rate", "2.5", "number", 422], ["f_rate", "-1", "number", 422],
    ["f_bool", "false", "bool", 200], ["f_bool", "true", "bool", 200], ["f_bool", "1", "bool", 422], ["f_bool", "TRUE", "bool", 422], ["f_bool", "", "bool", 200],
    // A date is a real calendar day, optionally with a time of day (isCalendarDate).
    ["f_date", "2026-10-07", "date", 200], ["f_date", "2026-10-07T10:00:00Z", "date", 200], ["f_date", "2026-02-30", "date", 422], ["f_date", "2026-13-45", "date", 422], ["f_date", "10/07/2026", "date", 422],
    ["f_sel", "a", "text", 200], ["f_sel", "c", "text", 422], ["f_sel", "", "text", 200],
    // media and relation are free-form (elementViolation: "text/textarea/richtext/media/relation: free-form").
    ["f_media", "https://example.com/a.png", "text", 200], ["f_media", "javascript:alert(1)", "text", 200],
    ["f_req", "", "text", 422], ["f_req", "present", "text", 200], ["f_req", "", "text", 422],
    ["f_rel", target.id, "node_ref", 200], ["f_rel", "00000000-0000-4000-8000-000000000000", "node_ref", 200],
  ];
  for (const [k, v, vt, want] of cases) {
    const r = await put(api, k, { value: v, value_type: vt });
    expect(r.status, `${k}=${JSON.stringify(v)}`).toBe(want);
    if (want === 422) expect(r.error, `${k}=${JSON.stringify(v)}`).toBe("field_invalid");
  }
  // A governed value is stored under the field's storage type (normalize): a rating is a number, an empty value is text, a relation is node_ref.
  expect(await attrs(api)).toEqual({
    f_text: "changed|text", f_area: "line1\nline2|text", f_rich: "**bold** <script>x</script>|text", f_num: "|text", f_rate: "5|number",
    f_bool: "|text", f_date: "2026-10-07T10:00:00Z|date", f_sel: "|text", f_media: "javascript:alert(1)|text", f_req: "present|text",
    f_rel: "00000000-0000-4000-8000-000000000000|node_ref",
  });
  // Clear by DELETE; a required field cannot be cleared while its tag is applied (routes/nodes.ts: 422 field_required).
  const del = async (k: string) => { const r = await page.request.delete(`/api/nodes/${api}/attributes/${k}`, H); return { status: r.status(), error: r.status() === 200 ? "" : (await r.json()).error as string }; };
  expect(await del("f_num")).toEqual({ status: 200, error: "" });
  expect(await del("f_bool")).toEqual({ status: 200, error: "" });
  expect(await del("f_rel")).toEqual({ status: 200, error: "" });
  expect(await del("f_req")).toEqual({ status: 422, error: "field_required" });
  const afterDelete = await attrs(api);
  expect(Object.keys(afterDelete).sort()).toEqual(["f_area", "f_date", "f_media", "f_rate", "f_req", "f_rich", "f_sel", "f_text"]);
  // Custom (non-schema) keys: the writer's type hint is kept only when the value fits it, else the value's own type (normalize / freeFormType);
  // a hint outside the five value types is a 400 (routes/nodes.ts).
  const customCases: [string, string, string, string][] = [
    ["c_text", "text", "x", "x|text"], ["c_num", "number", "12", "12|number"], ["c_numbad", "number", "abc", "abc|text"],
    ["c_date", "date", "2026-10-07", "2026-10-07|date"], ["c_datebad", "date", "nope", "nope|text"],
    ["c_bool", "bool", "true", "true|bool"], ["c_boolbad", "bool", "maybe", "maybe|text"],
    // fitsType: any non-empty value fits node_ref.
    ["c_ref", "node_ref", "not-a-uuid", "not-a-uuid|node_ref"], ["c_ref2", "node_ref", target.id, `${target.id}|node_ref`],
  ];
  for (const [key, vt, v, want] of customCases) {
    expect((await put(api, key, { value: v, value_type: vt })).status, key).toBe(200);
    expect(await stored(api, key), key).toBe(want);
  }
  expect((await put(api, "c_weird", { value: "x", value_type: "weird" })).status).toBe(400);
  expect(await stored(api, "c_weird")).toBeUndefined();

  // B) Featured cells (1280): the tag's fields, in schema order, as cells at the top of the note (FeaturedFields.tsx).
  const fNote = await mkNote(`Featured ${stamp}`);
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts.push(`${r.url().split("/attributes/")[1]}=${JSON.stringify(JSON.parse(r.postData() ?? "{}").value)}`); });
  await ready(page, `/?view=notes&node=${fNote}`);
  // Pressed, a cell shows the field's control (SchemaRow) in place of its label and value: the name is then its .attr-key.
  const ff = (p: Page, name: string) => p.locator(".ff-cell", { has: p.locator(".ff-label, .attr-key", { hasText: new RegExp(`^${name}$`) }) });
  const open = (p: Page, name: string) => ff(p, name).click().then(() => p.locator(".ff-cell--editing"));
  const cellText = async (name: string) => (await ff(page, name).innerText()).replace(/\s+/g, " ").trim();
  const serverIs = (id: string, key: string, want: string | undefined) => expect.poll(() => stored(id, key), { message: `${key} on the server` }).toBe(want);
  // For "nothing is written": a bounded look for a request that must not come.
  const noWrite = async () => { await expect.poll(() => puts.length, { timeout: 1500 }).toBeGreaterThan(0).catch(() => {}); expect(puts).toEqual([]); };
  await expect(ff(page, "f_num")).toBeVisible();
  expect(await page.locator(".featured-fields .ff-label").allInnerTexts()).toEqual(FIELDS.map((f) => f.name));
  const ffEdit = async (name: string, v: string, how: "Enter" | "blur") => {
    await ff(page, name).click();
    const input = page.locator(".ff-cell--editing input");
    await input.fill(v);
    if (how === "Enter") await input.press("Enter"); else await page.locator(".obsidian-title-input, .cm-content").first().click();
  };
  // A number box writes on Enter or on leaving it (TextValueField.tsx); zero is a value, an emptied box writes "" (text, normalize).
  puts.length = 0; await ffEdit("f_num", "0", "Enter");
  await serverIs(fNote, "f_num", "0|number");
  expect(puts).toEqual(['f_num="0"']);
  await expect(ff(page, "f_num")).toHaveText(/0/);
  expect(await cellText("f_num")).toBe("f_num 0");
  puts.length = 0; await ffEdit("f_num", "", "blur");
  await serverIs(fNote, "f_num", "|text");
  expect(puts).toEqual(['f_num=""']);
  await expect(ff(page, "f_num")).toHaveText(/Empty/);
  // pinned: today's behaviour, no written rule (the number control is a browser number input)
  await ff(page, "f_num").click();
  expect(await page.locator(".ff-cell--editing input").getAttribute("type")).toBe("number");
  // Letters cannot be typed into a number input, so the box is unchanged and nothing is written (TextValueField: "only if the text changed").
  puts.length = 0;
  await page.locator(".ff-cell--editing input").pressSequentially("abc");
  await page.locator(".ff-cell--editing input").press("Enter");
  await noWrite();
  await page.keyboard.press("Escape");
  expect(await stored(fNote, "f_num")).toBe("|text");
  await expect(ff(page, "f_num")).toHaveText(/Empty/);
  puts.length = 0; await ffEdit("f_text", "typed", "Enter");
  await serverIs(fNote, "f_text", "typed|text");
  expect(puts).toEqual(['f_text="typed"']);
  // A rating is stars, not a box (the API matrix above covers 6 and 2.5): a star writes its number, the same star again clears (DateValueField/StarRating header).
  puts.length = 0; await (await open(page, "f_rate")).getByRole("radio", { name: "3 stars", exact: true }).click();
  await serverIs(fNote, "f_rate", "3|number");
  expect(puts).toEqual(['f_rate="3"']);
  puts.length = 0; await (await open(page, "f_rate")).getByRole("radio", { name: "3 stars", exact: true }).click();
  await serverIs(fNote, "f_rate", "|text");
  expect(puts).toEqual(['f_rate=""']);
  await expect(page.locator(".ff-cell--editing")).toHaveCount(0);
  // A failed-write panel may sit over the cells; minimize it (the writes above all succeeded, so it is normally absent).
  const rec = page.locator(".failed-write-recovery");
  if (await rec.isVisible().catch(() => false)) await page.getByRole("button", { name: "Minimize recovery panel" }).click();
  // A boolean cell toggles on press: ✓ / ○ (FeaturedFields.tsx), stored as bool.
  await ff(page, "f_bool").click();
  await serverIs(fNote, "f_bool", "true|bool");
  await expect(ff(page, "f_bool")).toContainText("✓");
  await ff(page, "f_bool").click();
  await serverIs(fNote, "f_bool", "false|bool");
  await expect(ff(page, "f_bool")).toContainText("○");
  // A date opens its quick picks (today, tomorrow, next week, a date box); a pick closes the cell; Tomorrow is the day after the workspace's today (DateValueField.tsx).
  let dateCell = await open(page, "f_date");
  await dateCell.getByRole("button", { name: "f_date", exact: true }).click();
  await dateCell.getByRole("button", { name: "Today", exact: true }).click();
  await expect.poll(async () => (await stored(fNote, "f_date")) ?? "").toMatch(/^\d{4}-\d{2}-\d{2}\|date$/);
  const today = (await stored(fNote, "f_date"))!.split("|")[0]!;
  dateCell = await open(page, "f_date");
  await dateCell.getByRole("button", { name: "f_date", exact: true }).click();
  await dateCell.getByRole("button", { name: "Tomorrow", exact: true }).click();
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await serverIs(fNote, "f_date", `${tomorrow}|date`);
  await expect(page.locator(".ff-cell--editing")).toHaveCount(0);
  // A select is option chips; the chosen one pressed again clears.
  await (await open(page, "f_sel")).getByRole("button", { name: "b", exact: true }).click();
  await serverIs(fNote, "f_sel", "b|text");
  await (await open(page, "f_sel")).getByRole("button", { name: "b", exact: true }).click();
  await serverIs(fNote, "f_sel", "|text");
  await expect(ff(page, "f_sel")).toHaveText(/Empty/);
  // A relation picks a note from a list; typing its title is a search, not the value; the cell then shows the note's title.
  puts.length = 0;
  const relCell = await open(page, "f_rel");
  await relCell.getByRole("button", { name: /^Pick a note/ }).click();
  await relCell.getByRole("searchbox", { name: "Search notes…" }).fill(`RelTarget ${stamp}`);
  expect(puts, "typing the search writes nothing").toEqual([]);
  await relCell.locator(".attr-relation-option").filter({ hasText: `RelTarget ${stamp}` }).first().click();
  await serverIs(fNote, "f_rel", `${target.id}|node_ref`);
  expect(puts).toEqual([`f_rel=${JSON.stringify(target.id)}`]);
  await expect(ff(page, "f_rel")).toContainText(`RelTarget ${stamp}`);
  // Everything is still there after a reload.
  await ready(page, `/?view=notes&node=${fNote}`);
  await expect(ff(page, "f_num")).toBeVisible();
  const shown = Object.fromEntries(await Promise.all(["f_num", "f_text", "f_rate", "f_bool", "f_date", "f_sel"].map(async (k) => [k, (await ff(page, k).innerText()).replace(/\n/g, " ")])));
  expect(shown).toMatchObject({ f_num: "f_num Empty", f_text: "f_text typed", f_rate: "f_rate Empty", f_bool: "f_bool ○", f_sel: "f_sel Empty" });
  expect(shown.f_date, "the saved day is shown, not 「Empty」").toMatch(/^f_date (?!Empty).+/);
  expect(await stored(fNote, "f_date")).toBe(`${tomorrow}|date`);

  // C) Inspector (Properties panel).
  const iNote = await mkNote(`Inspector ${stamp}`);
  await ready(page, `/?view=notes&node=${iNote}`);
  await openInfoTags(page);
  const panel = page.locator(".attr-panel");
  await expect(panel).toBeVisible();
  const row = (name: string) => panel.locator(".attr-row", { has: page.locator(".attr-key", { hasText: new RegExp(`\\b${name}$`) }) });
  // Text and number boxes write on Enter or on leaving the box, and only when the text changed — not while typing (TextValueField.tsx header).
  puts.length = 0;
  await row("f_num").locator("input").pressSequentially("120", { delay: 120 });
  await noWrite();
  expect(await stored(iNote, "f_num")).toBeUndefined();
  await row("f_num").locator("input").press("Enter");
  await serverIs(iNote, "f_num", "120|number");
  expect(puts).toEqual(['f_num="120"']);
  await row("f_num").locator("input").fill("0"); await row("f_num").locator("input").press("Enter");
  await serverIs(iNote, "f_num", "0|number");
  await row("f_num").locator("input").fill(""); await row("f_num").locator("input").press("Enter");
  await serverIs(iNote, "f_num", "|text");
  const sw = row("f_bool").getByRole("switch");
  await sw.click();
  await serverIs(iNote, "f_bool", "true|bool");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await serverIs(iNote, "f_bool", "false|bool");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await row("f_rate").getByRole("radio", { name: "3 stars" }).click();
  await serverIs(iNote, "f_rate", "3|number");
  await row("f_rate").getByRole("radio", { name: "3 stars" }).click();
  await serverIs(iNote, "f_rate", "|text");
  puts.length = 0;
  await row("f_text").locator("input").fill("ent");
  await row("f_text").locator("input").press("Enter");
  await serverIs(iNote, "f_text", "ent|text");
  expect(puts, "Enter writes once; the blur that follows finds nothing changed").toEqual(['f_text="ent"']);
  // A textarea: Enter is a new line, the write comes when the box is left (TextValueField: Enter commits only a single-line box).
  puts.length = 0;
  await row("f_area").locator("textarea").fill("l1");
  await row("f_area").locator("textarea").press("Enter");
  await row("f_area").locator("textarea").pressSequentially("l2");
  expect(puts, "nothing is written while typing").toEqual([]);
  await page.locator(".obsidian-title-input, .cm-content").first().click();
  await serverIs(iNote, "f_area", "l1\nl2|text");
  expect(puts).toEqual(['f_area="l1\\nl2"']);
  await row("f_date").getByRole("button", { name: "f_date", exact: true }).click();
  await row("f_date").getByRole("button", { name: "Today", exact: true }).click();
  await expect.poll(async () => (await stored(iNote, "f_date")) ?? "").toMatch(/^\d{4}-\d{2}-\d{2}\|date$/);
  const today2 = (await stored(iNote, "f_date"))!.split("|")[0]!;
  await row("f_date").getByRole("button", { name: "f_date", exact: true }).click();
  await row("f_date").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await serverIs(iNote, "f_date", `${new Date(Date.parse(`${today2}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}|date`);
  await row("f_sel").getByRole("button", { name: "a", exact: true }).click();
  await serverIs(iNote, "f_sel", "a|text");
  // A required field refuses to be emptied (field_invalid "is required"): the stored value stays, the draft stays in the box, and the reason is shown
  // (TextValueField: a failed write keeps the draft; lib/serverErrors.ts shows a detail the dictionary translates).
  await row("f_req").locator("input").fill("x"); await row("f_req").locator("input").press("Enter");
  await serverIs(iNote, "f_req", "x|text");
  await row("f_req").locator("input").fill(""); await row("f_req").locator("input").press("Enter");
  await expect(page.locator(".toast-message", { hasText: '"f_req" is required' }).first()).toBeVisible();
  expect(await stored(iNote, "f_req")).toBe("x|text");
  expect(await row("f_req").locator("input").count()).toBe(1);
  expect(await row("f_req").locator("input").inputValue()).toBe("");
  // A relation shows a pick button (a note is chosen from a list, RelationFieldEditor) and a media field takes a URL or an upload.
  await expect(row("f_rel").getByRole("button", { name: /^Pick a note/ })).toBeVisible();
  await expect(row("f_media").locator("input[type=url]")).toBeVisible();
  await expect(row("f_media").locator("input[type=url]")).toHaveAttribute("placeholder", "URL or upload →");
  expect(await row("f_media").locator("button").count()).toBeGreaterThan(0);

  // D) Phone viewport — featured cells: the same write contract, nothing wider than the screen.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  const pNote = await mkNote(`Phone ${stamp}`);
  await ready(pp, `/?view=notes&node=${pNote}`);
  await expect(ff(pp, "f_num")).toBeVisible();
  const geo = await pp.evaluate(() => {
    const g = document.querySelector(".featured-fields")!.getBoundingClientRect();
    const cells = [...document.querySelectorAll(".ff-cell")].map((c) => c.getBoundingClientRect());
    return { doc: document.documentElement.scrollWidth, left: Math.round(g.left), right: Math.round(g.right), maxRight: Math.round(Math.max(...cells.map((c) => c.right))) };
  });
  expect(geo.doc).toBeLessThanOrEqual(390);
  expect(geo.left).toBeGreaterThanOrEqual(0);
  expect(geo.right).toBeLessThanOrEqual(390);
  expect(geo.maxRight).toBeLessThanOrEqual(390);
  await ff(pp, "f_num").tap().catch(() => ff(pp, "f_num").click());
  await pp.locator(".ff-cell--editing input").fill("0");
  await pp.locator(".ff-cell--editing input").press("Enter");
  await serverIs(pNote, "f_num", "0|number");
  await ff(pp, "f_bool").tap().catch(() => ff(pp, "f_bool").click());
  await serverIs(pNote, "f_bool", "true|bool");
  expect(await attrs(pNote)).toEqual({ f_bool: "true|bool", f_num: "0|number" });
  // pinned: today's behaviour, no written rule (the Properties panel is not open on the phone note page until it is asked for)
  expect(await pp.locator(".attr-panel").isVisible().catch(() => false)).toBe(false);
  await phone.close();
});
