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

test("TAG-10: round trip, malformed, versions, multi-file partial, starter, export, proposal rail, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const imp = async (data: unknown, raw = false) => {
    const r = await page.request.post("/api/tags/import", raw ? { headers: H.headers, data: data as string } : { ...H, data });
    return `${r.status()} ${(await r.text()).slice(0, 140)}`;
  };
  try {
    // ── Round trip ────────────────────────────────────────────────────────
    const src = await (await page.request.post("/api/tags/import", { ...H, data: {
      name: `T10src${stamp}`, color: "#123456", description: "d", version: "1.2.0", dependencies: [],
      fields: [{ name: "stage", type: "select", options: ["a", "b"] }, { name: "n", type: "number" }],
      // Spaces decide access now: a pack's policy is ignored and never exported.
      policy: { operations: { write_node: "editor" } },
      template_children: [{ title: "Child" }],
    } })).json();
    const exp = await (await page.request.get(`/api/tags/${src.id}/export`)).json();
    out.export = JSON.stringify({ keys: Object.keys(exp).sort(), format: exp._format, version: exp.version, fields: exp.fields.length });
    expect(exp.policy).toBeUndefined();
    const re = await page.request.post("/api/tags/import", { ...H, data: { ...exp, name: `T10copy${stamp}` } });
    const copyId = (await re.json()).id;
    const exp2 = await (await page.request.get(`/api/tags/${copyId}/export`)).json();
    const strip = (o: Record<string, unknown>) => JSON.stringify({ ...o, name: undefined });
    out.roundTrip = `${re.status()} identical=${strip(exp) === strip(exp2)}`;
    out.reimportSameName = await imp(exp);

    // A tag whose name has a space (as quick capture / resolve-path allows): can its own export come back?
    const spaced = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `Reading list ${stamp}` } })).json();
    const spacedId = spaced.leaf_id ?? spaced.id ?? spaced.tag?.id ?? spaced.leaf?.id ?? spaced.tags?.at?.(-1)?.id;
    out.spacedResolve = JSON.stringify(spaced).slice(0, 160);
    if (spacedId) {
      const spacedExp = await (await page.request.get(`/api/tags/${spacedId}/export`)).json();
      await page.request.patch(`/api/tags/${spacedId}`, { ...H, data: { name: `Reading-old-${stamp}` } });
      out.spacedReimport = `name=${JSON.stringify(spacedExp.name)} -> ${await imp(spacedExp)}`;
    }
    const cjk = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `讀書・筆記${stamp}` } })).json();
    const cjkId = cjk.leaf_id ?? cjk.id ?? cjk.tag?.id ?? cjk.leaf?.id ?? cjk.tags?.at?.(-1)?.id;
    if (cjkId) {
      const e3 = await (await page.request.get(`/api/tags/${cjkId}/export`)).json();
      await page.request.patch(`/api/tags/${cjkId}`, { ...H, data: { name: `cjk-old-${stamp}` } });
      out.cjkPunctReimport = `name=${JSON.stringify(e3.name)} -> ${await imp(e3)}`;
    }

    // ── Malformed packs ───────────────────────────────────────────────────
    out.badJson = await imp("{not json", true);
    out.arrayBody = await imp([{ name: "x" }]);
    out.noName = await imp({ fields: [] });
    out.fieldsObject = await imp({ name: `T10fo${stamp}`, fields: { a: 1 } });
    out.fieldsString = await imp({ name: `T10fs${stamp}`, fields: "abc" });
    out.depsString = await imp({ name: `T10ds${stamp}`, dependencies: "abc" });
    out.depsNumbers = await imp({ name: `T10dn${stamp}`, dependencies: [1, 2] });
    out.policyIgnored = await imp({ name: `T10ps${stamp}`, policy: "admin" }); // policy is ignored, not validated
    out.behaviourArray = await imp({ name: `T10ba${stamp}`, behaviour: [1, 2] });
    out.templateString = await imp({ name: `T10ts${stamp}`, template_children: "abc" });
    out.colorJunk = await imp({ name: `T10cj${stamp}`, color: "not-a-colour" });
    out.badId = await imp({ name: `T10bi${stamp}`, id: "nope" });
    out.hugeName = await imp({ name: "x".repeat(5000) + stamp });

    // ── Version / format differences ─────────────────────────────────────
    out.futureFormat = await imp({ name: `T10ff${stamp}`, _format: "onden.tagpack/v99", fields: [] });
    out.versionJunk = await imp({ name: `T10vj${stamp}`, version: "banana" });
    out.upgradeSameName = await imp({ ...exp, version: "2.0.0" });
    out.missingDeps = await imp({ name: `T10md${stamp}`, dependencies: ["no-such-slug"] });
    out.unknownModule = await imp({ name: `T10um${stamp}`, modules: ["teleport"] });

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
    const pick = async (files: string[]) => {
      const chooser = page.waitForEvent("filechooser");
      await page.locator(".settings-tagpack-import").click();
      await (await chooser).setFiles(files);
      await page.waitForTimeout(2000);
    };
    out.fileInputMultiple = String(await page.locator('input[type=file][accept*="tagpack"]').getAttribute("multiple"));
    await pick([fOk, fBad, fDup]);
    out.multiResults = JSON.stringify(await page.locator(".settings-tagpack-results span").allInnerTexts());
    const tags = (await (await page.request.get("/api/tags")).json()) as { name: string }[] | { tags: { name: string }[] };
    const tagNames = (Array.isArray(tags) ? tags : tags.tags).map((t) => t.name);
    out.multiServer = `ok=${tagNames.filter((n) => n === `T10ui${stamp}`).length}`;
    out.sidebarHasNew = String(await page.locator("body").innerText().then((t) => t.includes(`T10ui${stamp}`)));
    await pick([fTxt]);
    out.nonJson = JSON.stringify((await page.locator(".settings-tagpack-results span").allInnerTexts())[0]);
    // 503 on import.
    await page.route("**/api/tags/import", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }));
    writeFileSync(fOk, JSON.stringify({ name: `T10ui503${stamp}` }));
    await pick([fOk]);
    out.import503 = JSON.stringify((await page.locator(".settings-tagpack-results span").allInnerTexts())[0]);
    await page.unroute("**/api/tags/import");
    // Offline: the import button.
    await page.context().setOffline(true);
    await page.waitForTimeout(1500);
    out.offlineImportDisabled = String(await page.locator(".settings-tagpack-import").isDisabled());
    await page.context().setOffline(false);
    await page.waitForTimeout(1500);

    // ── Tag page export download ─────────────────────────────────────────
    await ready(page, `/?view=notes&node=${src.id}`);
    // The export sits in the tag page's ⋯ menu, with the other rare actions.
    const dl = page.waitForEvent("download", { timeout: 15_000 });
    await tagMenuAction(page, "Export tag");
    const d = await dl;
    const body = JSON.parse(readFileSync((await d.path())!, "utf8"));
    out.exportDownload = `file=${d.suggestedFilename()} sameAsApi=${JSON.stringify(body) === JSON.stringify(exp)}`;

    // ── Agent proposal rail: dry-run → approve / reject ──────────────────
    // A token is `access: read | write` since 2026-10-22 (the old "researcher" template is gone); proposing needs write.
    const made = await createAgent(page.request, `T10agent ${stamp}`, { access: "write" });
    const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: made.headers });
    const approvals = async () => ((await (await page.request.get("/api/inbox/approvals")).json()).approvals as { id: string; effect_kind: string; payload: { pack: { name: string } } }[]).filter((a) => a.effect_kind === "tag_pack");
    const propose = async (name: string, q = "") => { const r = await agent.post(`/api/mcp/tools/proposeTagPack${q}`, { data: { args: { name, fields: [{ name: "k", type: "text" }] } } }); return `${r.status()} ${(await r.text()).slice(0, 120)}`; };
    const pBefore = (await approvals()).length;
    out.proposeDryRun = `${await propose(`T10prop${stamp}`, "?dryRun=true")} pendingDelta=${(await approvals()).length - pBefore}`;
    out.proposeReal = `${await propose(`T10prop${stamp}`)} pendingDelta=${(await approvals()).length - pBefore}`;
    out.proposeAgainSameName = `${await propose(`T10prop${stamp}`)} pendingDelta=${(await approvals()).length - pBefore}`;
    out.proposeBadName = await propose(`bad name ${stamp}`);
    out.proposeExisting = await propose(`T10src${stamp}`);
    out.agentDirectImport = String((await agent.post("/api/tags/import", { data: { name: `T10agentimp${stamp}` } })).status());
    out.agentApproveSelf = String((await agent.post(`/api/inbox/approvals/${(await approvals())[0]?.id}/approve`)).status());
    // Inbox UI shows the proposal?
    await ready(page, "/?view=notes");
    await page.locator(".sidebar-tab", { hasText: /Inbox/ }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    out.inboxUiShows = String(await page.getByText(`Install tag pack #T10prop${stamp}`).count());
    const mine = (await approvals()).find((a) => a.payload.pack.name === `T10prop${stamp}`)!;
    out.approve = String((await page.request.post(`/api/inbox/approvals/${mine.id}/approve`, H)).status());
    await expect.poll(async () => {
      const t = (await (await page.request.get("/api/tags")).json()) as { name: string }[] | { tags: { name: string }[] };
      return (Array.isArray(t) ? t : t.tags).some((x) => x.name === `T10prop${stamp}`);
    }, { timeout: 20_000 }).toBe(true);
    out.approvedInstalled = "true";
    // Reject path.
    await propose(`T10rej${stamp}`);
    const rej = (await approvals()).find((a) => a.payload.pack.name === `T10rej${stamp}`)!;
    out.reject = String((await page.request.post(`/api/inbox/approvals/${rej.id}/reject`, H)).status());
    await page.waitForTimeout(3000);
    const t2 = (await (await page.request.get("/api/tags")).json()) as { name: string }[] | { tags: { name: string }[] };
    out.rejectedNotInstalled = String(!(Array.isArray(t2) ? t2 : t2.tags).some((x) => x.name === `T10rej${stamp}`));
    // Race: proposal pending, owner imports the same name, then approves.
    await propose(`T10race${stamp}`);
    const race = (await approvals()).find((a) => a.payload.pack.name === `T10race${stamp}`)!;
    out.raceManualImport = await imp({ name: `T10race${stamp}` });
    out.raceApprove = String((await page.request.post(`/api/inbox/approvals/${race.id}/approve`, H)).status());
    out.raceOutboxId = race.id;
    await page.waitForTimeout(5000);
    const t3 = (await (await page.request.get("/api/tags")).json()) as { name: string }[] | { tags: { name: string }[] };
    out.raceTagCount = String((Array.isArray(t3) ? t3 : t3.tags).filter((x) => x.name === `T10race${stamp}`).length);
    await agent.dispose();

    // ── Phone ────────────────────────────────────────────────────────────
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
    const pp = await phone.newPage();
    await ready(pp, "/?view=notes");
    await openYourData(pp, true);
    await pp.locator(".settings-tagpack-import").scrollIntoViewIfNeeded();
    out.phone = JSON.stringify(await pp.evaluate(() => {
      const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return `${Math.round(b.left)}..${Math.round(b.right)} h${Math.round(b.height)}`; };
      return { doc: document.documentElement.scrollWidth, importBtn: r(".settings-tagpack-import") };
    }));
    await pp.screenshot({ path: "/tmp/pw-output/tag10-phone.png", fullPage: true });
    await phone.close();
  } finally {
    console.log(`AUDIT TAG-10 ${JSON.stringify(out, null, 1)}`);
  }
});
