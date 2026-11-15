// Feature-audit deepening (2026-10-07): TAG-01 — tag create / rename / path /
// colour: slug occupancy, resolve-path edge cases and concurrency, the import
// name check vs resolve-path, a full idempotent resend, rename projections
// (catalog, tree, search, note chip, sidebar) and rename/colour bounds.
import { test, expect } from "@playwright/test";
import { ready, BASE, H } from "./helpers";


test("TAG-01: slug, resolve-path, import vs path, resend, rename projections", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const rp = async (path: string) => {
    const r = await page.request.post("/api/tags/resolve-path", { ...H, data: { path } });
    return { status: r.status(), body: r.status() === 200 ? await r.json() as { leaf_id: string; created_ids: string[] } : await r.text() };
  };
  const tagRow = async (id: string) => (await (await page.request.get(`/api/tags/${id}`)).json()) as Record<string, unknown>;
  const tree = async () => ((await (await page.request.get("/api/tags/tree")).json()).tags as { id: string; name: string; parent_id: string | null }[]);
  const slugOf = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    return (boot.nodes as { id: string; slug: string }[]).find((n) => n.id === id)?.slug ?? "(not in bootstrap)";
  };

  // A) Slug occupancy: an ordinary note already holds `tag-sl<stamp>`.
  const squat = await (await page.request.post("/api/nodes", { ...H, data: { title: `tag-sl${stamp}`, markdown: "squatter" } })).json();
  const sl = await rp(`sl${stamp}`);
  const slId = (sl.body as { leaf_id: string }).leaf_id;
  out.slugOccupied = `noteSlug=${await slugOf(squat.id)} tagSlug=${await slugOf(slId)} status=${sl.status}`;
  // CJK names (the old ASCII slug collapsed them).
  const c1 = await rp(`課程${stamp}`), c2 = await rp(`筆記${stamp}`);
  out.cjk = `${c1.status}/${c2.status} slugs=${await slugOf((c1.body as { leaf_id: string }).leaf_id)},${await slugOf((c2.body as { leaf_id: string }).leaf_id)}`;

  // B) resolve-path edge cases.
  const first = await rp(`rp${stamp}/a/b`);
  const again = await rp(`rp${stamp}/a/b`);
  out.idempotent = `first.created=${(first.body as { created_ids: string[] }).created_ids.length} again.created=${(again.body as { created_ids: string[] }).created_ids.length} sameLeaf=${(first.body as { leaf_id: string }).leaf_id === (again.body as { leaf_id: string }).leaf_id}`;
  const spaced = await rp(` /rp${stamp}// a / b/ `);
  out.whitespaceSlashes = `status=${spaced.status} sameLeaf=${(spaced.body as { leaf_id: string }).leaf_id === (first.body as { leaf_id: string }).leaf_id}`;
  out.onlySlashes = `${(await rp(" / / ")).status}`;
  out.tooLong = `${(await rp("x".repeat(201))).status}`;
  const caseVariant = await rp(`RP${stamp}`);
  out.caseVariant = `status=${caseVariant.status} newTag=${(caseVariant.body as { created_ids: string[] }).created_ids.length === 1}`;
  // Concurrency: 6 parallel resolves of one brand-new chain.
  const par = await Promise.all(Array.from({ length: 6 }, () => rp(`race${stamp}/x/y`)));
  const leaves = new Set(par.map((p) => (p.body as { leaf_id?: string }).leaf_id));
  const raceNodes = (await tree()).filter((t) => t.name === `race${stamp}` || (t.name === "x" || t.name === "y"));
  out.concurrent = `statuses=${par.map((p) => p.status).join(",")} distinctLeaves=${leaves.size} raceRoots=${(await tree()).filter((t) => t.name === `race${stamp}`).length}`;
  void raceNodes;

  // C) Import name check vs resolve-path: same leaf name under another parent.
  const nested = await rp(`par${stamp}/leaf${stamp}`);
  const imp = await page.request.post("/api/tags/import", { ...H, data: { name: `leaf${stamp}`, fields: [] } });
  const rootViaPath = await rp(`leaf${stamp}`);
  out.importVsPath = `nested=${nested.status} importRootSameName=${imp.status()} ${(await imp.text()).slice(0, 90)} | resolvePathRoot=${rootViaPath.status} created=${JSON.stringify((rootViaPath.body as { created_ids: string[] }).created_ids?.length)}`;

  // D) Full resend: the sidebar writer's import with the same id + Idempotency-Key.
  const cid = crypto.randomUUID();
  const send = () => page.request.post("/api/tags/import", { headers: { ...H.headers, "idempotency-key": cid }, data: { id: cid, name: `resend${stamp}`, fields: [] } });
  const s1 = await send(), s2 = await send();
  const s2body = (await s2.text()).slice(0, 100);
  out.resend = `first=${s1.status()} second=${s2.status()} ${s2body} count=${(await tree()).filter((t) => t.name === `resend${stamp}`).length}`;
  // Same id, no idempotency header.
  const s3 = await page.request.post("/api/tags/import", { ...H, data: { id: cid, name: `resend${stamp}`, fields: [] } });
  out.resendNoKey = `${s3.status()} ${(await s3.text()).slice(0, 80)}`;

  // E) Rename bounds.
  const R = (await rp(`ren${stamp}`).then((r) => r.body as { leaf_id: string })).leaf_id;
  const patch = async (data: Record<string, unknown>) => {
    const r = await page.request.patch(`/api/tags/${R}`, { ...H, data });
    return `${r.status()}${r.status() === 200 ? "" : " " + (await r.text()).slice(0, 60)}`;
  };
  await rp(`sib${stamp}`);
  out.renameToSibling = await patch({ name: `sib${stamp}` });
  out.renameBlank = `${await patch({ name: "   " })} title=${JSON.stringify((await tagRow(R)).name)}`;
  out.renameSlash = `${await patch({ name: `with/slash${stamp}` })} title=${JSON.stringify((await tagRow(R)).name)}`;
  const slashPath = await rp(`with/slash${stamp}`);
  out.slashNameResolves = `created=${(slashPath.body as { created_ids: string[] }).created_ids.length} sameAsRenamed=${(slashPath.body as { leaf_id: string }).leaf_id === R}`;
  out.colorGarbage = `${await patch({ color: "not-a-colour; background:url(x)" })} color=${JSON.stringify((await tagRow(R)).color)}`;
  out.colorNull = `${await patch({ color: null })} color=${JSON.stringify((await tagRow(R)).color)}`;
  await patch({ name: `ren${stamp}`, color: "#3366ff" });

  // F) Rename projections: note membership + an inline #word of the old name.
  //    The #word is text, not a tag (T10): only the stored membership follows
  //    the rename, and the text keeps saying the old name.
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `RenNote ${stamp}`, markdown: `body mentions #ren${stamp} inline` } })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${R}`, { ...H, data: {} });
  await ready(page, `/?view=notes&node=${note.id}`);
  if (await page.locator(".notes-inspector-toggle").getAttribute("aria-pressed") === "false") await page.locator(".notes-inspector-toggle").click();
  const sources = page.getByRole("region", { name: "Note tags", exact: true });
  await expect(sources.getByRole("button", { name: `#ren${stamp}`, exact: true })).toBeVisible();
  await page.request.patch(`/api/tags/${R}`, { ...H, data: { name: `renamed${stamp}` } });
  await page.waitForTimeout(4000);
  out.chipLiveAfterRename = `old=${await sources.getByRole("button", { name: `#ren${stamp}`, exact: true }).count()} new=${await sources.getByRole("button", { name: `#renamed${stamp}`, exact: true }).count()}`;
  await ready(page, `/?view=notes&node=${note.id}`);
  const chips = await page.locator(".sidebar-tag-chip").allInnerTexts();
  out.sidebarAfterRename = JSON.stringify(chips.filter((c) => c.includes(`ren${stamp}`) || c.includes(`renamed${stamp}`)).map((c) => c.replace(/\s+/g, " ")));
  const search = async (q: string) => ((await (await page.request.get(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()) as { id: string }[] | { results?: { id: string }[] });
  const hit = async (q: string) => { const r = await search(q); const rows = Array.isArray(r) ? r : r.results ?? []; return rows.some((x) => x.id === note.id); };
  out.searchAfterRename = `#renamed=${await hit(`#renamed${stamp}`)} #old=${await hit(`#ren${stamp}`)} #RENAMED=${await hit(`#RENAMED${stamp}`)}`;
  out.treeAfterRename = JSON.stringify((await tree()).filter((t) => t.id === R).map((t) => t.name));
  out.slugAfterRename = await slugOf(R);

  // G) Another human (editor): rename 403, path create allowed?, import 403.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `T01 ${stamp}`, email: `t01-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `T01 ${stamp}`, type: "human", external_id: signup.user.id } });
  const ed = human.request;
  const edRename = await ed.patch(`/api/tags/${R}`, { ...H, data: { name: `hijack${stamp}` } });
  const edPath = await ed.post("/api/tags/resolve-path", { ...H, data: { path: `edpath${stamp}` } });
  const edImport = await ed.post("/api/tags/import", { ...H, data: { name: `edimp${stamp}`, fields: [] } });
  out.editor = `rename=${edRename.status()} resolvePath=${edPath.status()} import=${edImport.status()}`;
  // Same editor through the UI sidebar "+ New tag" (tagWriter → import).
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, "/?view=notes");
  const plus = hp.locator(".sidebar-tag-new");
  if (await plus.isVisible().catch(() => false)) {
    await plus.click();
    await hp.locator(".sidebar-tag-new-input").fill(`edui${stamp}`);
    await hp.locator(".sidebar-tag-new-input").press("Enter");
    await hp.waitForTimeout(2500);
    const toasts = await hp.locator(".toast-message").allInnerTexts().catch(() => []);
    out.editorUiNewTag = `toasts=${JSON.stringify(toasts)} serverHas=${(await tree()).some((t) => t.name === `edui${stamp}`)} chipShown=${await hp.locator(".sidebar-tag-chip", { hasText: `#edui${stamp}` }).count()}`;
  } else out.editorUiNewTag = "no + button for editor";
  await human.close();

  // H) Owner UI "+ New tag" with the create response lost after commit
  //    (tagWriter.create → POST /api/tags since T2; it was the pack import).
  await ready(page, "/?view=notes");
  let lost = false;
  await page.route("**/api/tags", async (route) => {
    if (!lost && route.request().method() === "POST") {
      lost = true;
      await route.fetch().catch(() => null); // the server commits…
      await route.abort("connectionreset"); // …the browser never sees it
    } else await route.continue();
  });
  const importCalls: string[] = [];
  page.on("response", (r) => { if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tags") importCalls.push(String(r.status())); });
  await page.locator(".sidebar-tag-new").click();
  await page.locator(".sidebar-tag-new-input").fill(`lostresp${stamp}`);
  await page.locator(".sidebar-tag-new-input").press("Enter");
  await page.waitForTimeout(8000);
  out.lostResponseUi = `importResponses=${JSON.stringify(importCalls)} toasts=${JSON.stringify(await page.locator(".toast-message").allInnerTexts().catch(() => []))} chip=${await page.locator(".sidebar-tag-chip", { hasText: `#lostresp${stamp}` }).count()} recoveryPanel=${await page.locator(".failed-write-recovery").count()} serverCount=${(await tree()).filter((t) => t.name === `lostresp${stamp}`).length}`;
  await page.unroute("**/api/tags");
  await ready(page, "/?view=notes");
  await page.waitForTimeout(3000);
  out.lostResponseAfterReload = `chip=${await page.locator(".sidebar-tag-chip", { hasText: `#lostresp${stamp}` }).count()} recoveryPanel=${await page.locator(".failed-write-recovery").count()} panelText=${JSON.stringify((await page.locator(".failed-write-recovery").first().innerText().catch(() => "")).slice(0, 160))} serverCount=${(await tree()).filter((t) => t.name === `lostresp${stamp}`).length}`;

  console.log(`AUDIT TAG-01 ${JSON.stringify(out)}`);
});
