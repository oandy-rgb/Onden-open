// Feature-audit deepening (2026-10-07): TAG-10 — TagPack import/export:
// export→import round trip, malformed packs, version/format differences,
// multi-file install with partial success through Settings → Your Data,
// starter re-install, tag-page export download, the agent proposeTagPack
// dry-run → inbox approval/rejection rail, phone viewport.
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready, tagMenuAction, openSettingsFromAvatar, createAgent, BASE, H } from "./helpers";


async function openYourData(page: Page, phone: boolean) {
  await openSettingsFromAvatar(page); // the gear on a computer, the avatar's account sheet on a phone
  await page.locator(phone ? ".settings-list-row" : ".settings-nav-item", { hasText: "Data and backup" }).click();
  // Importing a tag pack is an advanced setting: folded until 「Show advanced settings」.
  const advanced = page.locator(".settings-advanced-toggle");
  if (await advanced.count() && (await advanced.getAttribute("aria-expanded")) === "false") await advanced.click();
  await expect(page.locator(".settings-tagpack-import")).toBeVisible();
}

// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
// Pack rules: backend services/tagPacks.ts (validateTagPack, installTagPack, exportTagPack, the proposal rail) and
// services/agentTools/proposeTagPack.ts.
test("TAG-10: round trip, malformed, versions, multi-file partial, starter, export, proposal rail, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const imp = async (data: unknown, raw = false) => {
    const r = await page.request.post("/api/tags/import", raw ? { headers: H.headers, data: data as string } : { ...H, data });
    return { status: r.status(), text: await r.text() };
  };
  const body = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;
  const tagNames = async () => {
    const t = (await (await page.request.get("/api/tags")).json()) as { name: string }[] | { tags: { name: string }[] };
    return (Array.isArray(t) ? t : t.tags).map((x) => x.name);
  };
  // ── Round trip ────────────────────────────────────────────────────────
  const src = await (await page.request.post("/api/tags/import", { ...H, data: {
    name: `T10src${stamp}`, color: "#123456", description: "d", version: "1.2.0", dependencies: [],
    fields: [{ name: "stage", type: "select", options: ["a", "b"] }, { name: "n", type: "number" }],
    // Spaces decide access now: a pack's policy is ignored and never exported.
    policy: { operations: { write_node: "editor" } },
    template_children: [{ title: "Child" }],
  } })).json();
  const exp = await (await page.request.get(`/api/tags/${src.id}/export`)).json();
  // exportTagPack: the schema, the behaviour, the library metadata and a format tag.
  for (const key of ["_format", "behaviour", "color", "dependencies", "description", "fields", "name", "template_children", "version"]) expect(exp, key).toHaveProperty(key);
  expect(exp._format).toBe("onden.tagpack/v1");
  expect(exp.version).toBe("1.2.0");
  expect(exp.fields).toHaveLength(2);
  expect(exp.policy).toBeUndefined();
  const re = await page.request.post("/api/tags/import", { ...H, data: { ...exp, name: `T10copy${stamp}` } });
  expect(re.status()).toBe(201);
  const copyId = (await re.json()).id;
  const exp2 = await (await page.request.get(`/api/tags/${copyId}/export`)).json();
  const strip = (o: Record<string, unknown>) => JSON.stringify({ ...o, name: undefined });
  expect(strip(exp2), "an exported pack imports back to the same pack").toBe(strip(exp));
  // The name is taken at the root → 409 (tagPacks.ts installTagPack: TagNameConflictError).
  const same = await imp(exp);
  expect(same.status).toBe(409);
  expect(body(same).error).toBe("tag_name_conflict");

  // A tag whose name has a space or CJK punctuation exports a pack that imports back (validateTagPack: the one tag-name shape,
  // which refused "reading list" when it was the hashtag charset).
  const spaced = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `Reading list ${stamp}` } })).json();
  const spacedExp = await (await page.request.get(`/api/tags/${spaced.leaf_id}/export`)).json();
  expect(spacedExp.name).toBe(`Reading list ${stamp}`);
  await page.request.patch(`/api/tags/${spaced.leaf_id}`, { ...H, data: { name: `Reading-old-${stamp}` } });
  const spacedBack = await imp(spacedExp);
  expect(spacedBack.status).toBe(201);
  expect(body(spacedBack).name).toBe(`Reading list ${stamp}`);
  const cjk = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `讀書・筆記${stamp}` } })).json();
  const cjkExp = await (await page.request.get(`/api/tags/${cjk.leaf_id}/export`)).json();
  await page.request.patch(`/api/tags/${cjk.leaf_id}`, { ...H, data: { name: `cjk-old-${stamp}` } });
  const cjkBack = await imp(cjkExp);
  expect(cjkBack.status).toBe(201);
  expect(body(cjkBack).name).toBe(`讀書・筆記${stamp}`);

  // ── Malformed packs: validateTagPack refuses a body that is not an object, a pack without a name, and fields that are not a list (400);
  //    a bad id is a 400 at the route. ────────────────────────────────────
  expect((await imp("{not json", true)).status).toBe(400);
  expect((await imp([{ name: "x" }])).status).toBe(400);
  expect((await imp({ fields: [] })).status).toBe(400);
  expect((await imp({ name: `T10fo${stamp}`, fields: { a: 1 } })).status).toBe(400);
  expect((await imp({ name: `T10fs${stamp}`, fields: "abc" })).status).toBe(400);
  expect((await imp({ name: `T10bi${stamp}`, id: "nope" })).status).toBe(400);
  // pinned: today's behaviour, no written rule (the other malformed shapes: validateTagPack does not look at them; a string for the dependencies is a 500)
  expect((await imp({ name: `T10ds${stamp}`, dependencies: "abc" })).status).toBe(500);
  expect((await imp({ name: `T10dn${stamp}`, dependencies: [1, 2] })).status).toBe(201);
  expect((await imp({ name: `T10ba${stamp}`, behaviour: [1, 2] })).status).toBe(201);
  expect((await imp({ name: `T10ts${stamp}`, template_children: "abc" })).status).toBe(201);
  // A pack's policy is ignored, not validated (TagPack.policy: "Legacy: older packs carried an access policy. Ignored").
  expect((await imp({ name: `T10ps${stamp}`, policy: "admin" })).status).toBe(201);

  // ── Version / format differences ─────────────────────────────────────
  // pinned: today's behaviour, no written rule (the format tag and the version are not checked on import)
  expect((await imp({ name: `T10ff${stamp}`, _format: "onden.tagpack/v99", fields: [] })).status).toBe(201);
  expect((await imp({ name: `T10vj${stamp}`, version: "banana" })).status).toBe(201);
  // The same name again is a name conflict, whatever the version (there is no upgrade path).
  expect((await imp({ ...exp, version: "2.0.0" })).status).toBe(409);
  // Import never blocks on a missing dependency or module: it installs and warns (TagPack.modules: "Import never blocks on these").
  const missingDeps = await imp({ name: `T10md${stamp}`, dependencies: ["no-such-slug"] });
  expect(missingDeps.status).toBe(201);
  expect(body(missingDeps).missing_dependencies).toEqual(["no-such-slug"]);
  const unknownModule = await imp({ name: `T10um${stamp}`, modules: ["teleport"] });
  expect(unknownModule.status).toBe(201);
  expect(body(unknownModule).missing_modules).toEqual(["teleport"]);

  // ── Settings → Your Data: multi-file install, partial success ────────
  const dir = mkdtempSync(join(tmpdir(), "t10-"));
  const fOk = join(dir, `ok-${stamp}.tagpack.json`);
  const fBad = join(dir, `bad-${stamp}.tagpack.json`);
  const fDup = join(dir, `dup-${stamp}.tagpack.json`);
  const fTxt = join(dir, `notes-${stamp}.txt`);
  writeFileSync(fOk, JSON.stringify({ name: `T10ui${stamp}`, fields: [{ name: "x", type: "text" }] }));
  writeFileSync(fBad, "{ broken");
  writeFileSync(fDup, JSON.stringify({ ...exp }));
  writeFileSync(fTxt, "hello");
  await ready(page, "/?view=notes");
  await openYourData(page, false);
  const results = page.locator(".settings-tagpack-results span");
  const pick = async (files: string[]) => {
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".settings-tagpack-import").click();
    await (await chooser).setFiles(files);
  };
  // The file input takes several files (TagPacksWidget: `multiple`).
  expect(await page.locator('input[type=file][accept*="tagpack"]').getAttribute("multiple")).not.toBeNull();
  await pick([fOk, fBad, fDup]);
  // Each file is reported on its own line, newest first (the widget puts each result in front): a taken name and a broken file are
  // reported without stopping the one that installs.
  await expect(results).toHaveCount(3);
  const lines = await results.allInnerTexts();
  expect(lines[0]).toBe(`⚠ dup-${stamp}.tagpack.json — A tag with this name already exists in this parent. Choose another name or parent.`);
  expect(lines[1]).toBe(`⚠ bad-${stamp}.tagpack.json — malformed JSON body`);
  expect(lines[2]).toBe(`✅ ok-${stamp}.tagpack.json — installed as #T10ui${stamp}`);
  expect((await tagNames()).filter((n) => n === `T10ui${stamp}`)).toHaveLength(1);
  // A file that is not a pack file is not read (importFiles: only .json).
  await pick([fTxt]);
  await expect(results).toHaveCount(4);
  expect((await results.allInnerTexts())[0]).toBe("⚠ (none) — No tag pack files selected");
  // 503 on import: an install is online-only, so the failure is reported (serverErrors: the 503 wording), nothing is installed.
  await page.route("**/api/tags/import", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }));
  writeFileSync(fOk, JSON.stringify({ name: `T10ui503${stamp}` }));
  await pick([fOk]);
  await expect(results).toHaveCount(5);
  expect((await results.allInnerTexts())[0]).toBe(`⚠ ok-${stamp}.tagpack.json — Could not reach the server. Try again when the connection is available.`);
  await page.unroute("**/api/tags/import");
  expect(await tagNames()).not.toContain(`T10ui503${stamp}`);
  // Offline: the import button is disabled (TagPacksWidget: `disabled={busy || !ctx.online}`).
  await page.context().setOffline(true);
  await expect(page.locator(".settings-tagpack-import")).toBeDisabled();
  await page.context().setOffline(false);
  await expect(page.locator(".settings-tagpack-import")).toBeEnabled();

  // ── Tag page export download ─────────────────────────────────────────
  await ready(page, `/?view=notes&node=${src.id}`);
  await expect(page.getByRole("button", { name: `Open #T10ui${stamp}`, exact: true }), "the installed tag is in the sidebar").toBeVisible();
  // The export sits in the tag page's ⋯ menu, with the other rare actions.
  const dl = page.waitForEvent("download", { timeout: 15_000 });
  await tagMenuAction(page, "Export tag");
  const d = await dl;
  expect(d.suggestedFilename()).toBe(`t10src${stamp}.tagpack.json`);
  expect(JSON.parse(readFileSync((await d.path())!, "utf8")), "the download is the pack the API exports").toEqual(exp);

  // ── Agent proposal rail: dry-run → approve / reject (proposeTagPack.ts: an agent proposes, a principal admin approves in the inbox) ─
  // A token is `access: read | write` since 2026-10-22 (the old "researcher" template is gone); proposing needs write.
  const made = await createAgent(page.request, `T10agent ${stamp}`, { access: "write" });
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: made.headers });
  const approvals = async () => ((await (await page.request.get("/api/inbox/approvals")).json()).approvals as { id: string; effect_kind: string; payload: { pack: { name: string } } }[]).filter((a) => a.effect_kind === "tag_pack");
  const pendingNamed = async (name: string) => (await approvals()).filter((a) => a.payload.pack.name === name).length;
  const propose = async (name: string, q = "") => {
    const r = await agent.post(`/api/mcp/tools/proposeTagPack${q}`, { data: { args: { name, fields: [{ name: "k", type: "text" }] } } });
    return { status: r.status(), text: await r.text() };
  };
  const dry = await propose(`T10prop${stamp}`, "?dryRun=true");
  expect(dry.status).toBe(200);
  expect(dry.text).toContain("[dry-run]");
  expect(await pendingNamed(`T10prop${stamp}`), "a dry run files nothing").toBe(0);
  expect((await propose(`T10prop${stamp}`)).status).toBe(200);
  expect(await pendingNamed(`T10prop${stamp}`)).toBe(1);
  // The same name again is the same held request (tagPacks.ts enqueueTagPackProposal: dedupKey by name).
  expect((await propose(`T10prop${stamp}`)).status).toBe(200);
  expect(await pendingNamed(`T10prop${stamp}`)).toBe(1);
  // A name with a space is a legal tag name (tagHierarchy.ts isTagNameShape), so it is filed.
  const spacedName = `bad name ${stamp}`;
  expect((await propose(spacedName)).status).toBe(200);
  expect(await pendingNamed(spacedName)).toBe(1);
  // Decide it so it does not wait in the shared inbox: its name has a space, which the zh-TW screen sweep reads as English.
  const spacedOne = (await approvals()).find((a) => a.payload.pack.name === spacedName)!;
  expect((await page.request.post(`/api/inbox/approvals/${spacedOne.id}/reject`, H)).status()).toBe(200);
  // A name the root already has is refused at the proposal, as a direct import is (proposeTagPack.ts: "same rule and 409").
  const existing = await propose(`T10src${stamp}`);
  expect(existing.status).toBe(409);
  expect(JSON.parse(existing.text).error).toBe("tag_name_conflict");
  // The agent installs nothing itself and cannot approve (tagPacks.ts header: gated at principal-admin directly, at inbox approval for agents).
  expect((await agent.post("/api/tags/import", { data: { name: `T10agentimp${stamp}` } })).status()).toBe(403);
  const mine = (await approvals()).find((a) => a.payload.pack.name === `T10prop${stamp}`)!;
  expect((await agent.post(`/api/inbox/approvals/${mine.id}/approve`)).status()).toBe(403);
  expect(await tagNames()).not.toContain(`T10prop${stamp}`);
  // The inbox shows the proposal.
  await ready(page, "/?view=notes");
  await page.locator(".sidebar-tab", { hasText: /Inbox/ }).first().click();
  await expect(page.getByText(`Install tag pack #T10prop${stamp}`)).toHaveCount(1);
  expect((await page.request.post(`/api/inbox/approvals/${mine.id}/approve`, H)).status()).toBe(200);
  await expect.poll(async () => (await tagNames()).includes(`T10prop${stamp}`), { timeout: 20_000 }).toBe(true);
  // Reject path: nothing is installed.
  await propose(`T10rej${stamp}`);
  const rej = (await approvals()).find((a) => a.payload.pack.name === `T10rej${stamp}`)!;
  expect((await page.request.post(`/api/inbox/approvals/${rej.id}/reject`, H)).status()).toBe(200);
  await expect.poll(async () => await pendingNamed(`T10rej${stamp}`)).toBe(0);
  expect(await tagNames()).not.toContain(`T10rej${stamp}`);
  // Race: a proposal is pending, the owner imports the same name, then approves. The approval is accepted, the install collides and does not
  // install a second tag (tagPacks.ts installTagPackApproved: TagNameConflictError "instead of silently double-installing").
  await propose(`T10race${stamp}`);
  const race = (await approvals()).find((a) => a.payload.pack.name === `T10race${stamp}`)!;
  expect((await imp({ name: `T10race${stamp}` })).status).toBe(201);
  expect((await page.request.post(`/api/inbox/approvals/${race.id}/approve`, H)).status()).toBe(200);
  await expect.poll(async () => await pendingNamed(`T10race${stamp}`), { timeout: 30_000 }).toBe(0);
  expect((await tagNames()).filter((n) => n === `T10race${stamp}`)).toHaveLength(1);
  await agent.dispose();

  // ── Phone: the import button is inside the screen, nothing is wider than it, and the button is a 44px target (e2e/layout-audit R7) ──
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  await openYourData(pp, true);
  await pp.locator(".settings-tagpack-import").scrollIntoViewIfNeeded();
  const geo = await pp.evaluate(() => {
    const b = document.querySelector(".settings-tagpack-import")!.getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth, left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) };
  });
  expect(geo.doc).toBeLessThanOrEqual(390);
  expect(geo.left).toBeGreaterThanOrEqual(0);
  expect(geo.right).toBeLessThanOrEqual(390);
  expect(geo.h).toBeGreaterThanOrEqual(44);
  await phone.close();
});

// FINDING: a tag colour is #rrggbb only (@onden/markdown color.test.ts "isHexColor stays #rrggbb only (note, tag and edge colours)"; PATCH /api/tags/:id
// and the agent's proposeTagPack both refuse anything else, and proposeTagPack.ts says it runs "the same format gate the owner's import runs").
// Today the owner's POST /api/tags/import stores any string as the colour.
test("FINDING: a pack import refuses a colour that is not #rrggbb", async ({ page }) => {
  test.fail();
  const stamp = Date.now();
  const r = await page.request.post("/api/tags/import", { ...H, data: { name: `T10cj${stamp}`, color: "not-a-colour" } });
  if (r.status() === 201) await page.request.delete(`/api/nodes/${(await r.json()).id}`, H); // leave nothing behind
  expect(r.status()).toBe(400);
});

// FINDING: a tag name is at most TAG_NAME_MAX (200) characters (routes/tags.ts tagNameLength on create and rename; proposeTagPack.ts
// `name: z.string().max(TAG_NAME_MAX)`). Today the owner's pack import stores a 5000-character name.
test("FINDING: a pack import refuses a name longer than the tag-name limit", async ({ page }) => {
  test.fail();
  const stamp = Date.now();
  const r = await page.request.post("/api/tags/import", { ...H, data: { name: "x".repeat(5000) + stamp } });
  if (r.status() === 201) await page.request.delete(`/api/nodes/${(await r.json()).id}`, H); // leave nothing behind
  expect(r.status()).toBe(400);
});
