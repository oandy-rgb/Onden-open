// Feature-audit deepening (2026-10-07): TAG-01 — tag create / rename / path /
// colour: slug occupancy, resolve-path edge cases and concurrency, the import
// name check vs resolve-path, a full idempotent resend, rename projections
// (catalog, tree, search, note chip, sidebar) and rename/colour bounds.
import { test, expect, type Page } from "@playwright/test";
import { ready, titleTags, BASE, H } from "./helpers";


// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
const SLUG_RULE = "services/nodes.ts slugFor/uniqueTagSlug";

test("TAG-01: slug, resolve-path, import vs path, resend, rename projections", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const rp = async (path: string) => {
    const r = await page.request.post("/api/tags/resolve-path", { ...H, data: { path } });
    return { status: r.status(), body: r.status() === 200 ? await r.json() as { leaf_id: string; created_ids: string[] } : await r.text() };
  };
  const leafOf = (r: { body: unknown }) => (r.body as { leaf_id: string }).leaf_id;
  const createdOf = (r: { body: unknown }) => (r.body as { created_ids: string[] }).created_ids;
  const tagRow = async (id: string) => (await (await page.request.get(`/api/tags/${id}`)).json()) as Record<string, unknown>;
  const tree = async () => ((await (await page.request.get("/api/tags/tree")).json()).tags as { id: string; name: string; parent_id: string | null }[]);
  const slugOf = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    return (boot.nodes as { id: string; slug: string }[]).find((n) => n.id === id)?.slug ?? "(not in bootstrap)";
  };
  // The sidebar's tag tree (one row per tag, "Open #name"); a "+ New tag" there opens the section by itself.
  const sidebarTag = (p: Page, name: string) => p.getByRole("button", { name: `Open #${name}`, exact: true });

  // A) Slug: `tag-` + the Unicode-preserving slug of the name, made unique inside the tag's own scope (a tag has no
  //    space), so a note in a space that already holds `tag-sl<stamp>` does not push the tag to `-2`.
  const squat = await (await page.request.post("/api/nodes", { ...H, data: { title: `tag-sl${stamp}`, markdown: "squatter" } })).json();
  const sl = await rp(`sl${stamp}`);
  expect(sl.status).toBe(200);
  expect(await slugOf(squat.id), SLUG_RULE).toBe(`tag-sl${stamp}`);
  expect(await slugOf(leafOf(sl)), SLUG_RULE).toBe(`tag-sl${stamp}`);
  // CJK names keep their characters in the slug (nodes.ts: the old ASCII slug collapsed them).
  const c1 = await rp(`課程${stamp}`), c2 = await rp(`筆記${stamp}`);
  expect([c1.status, c2.status]).toEqual([200, 200]);
  expect(await slugOf(leafOf(c1))).toBe(`tag-課程${stamp}`);
  expect(await slugOf(leafOf(c2))).toBe(`tag-筆記${stamp}`);

  // B) resolve-path (tagHierarchy.ts "written name" rule).
  const first = await rp(`rp${stamp}/a/b`);
  const again = await rp(`rp${stamp}/a/b`);
  expect(createdOf(first), "one new tag per missing segment, in path order").toHaveLength(3);
  expect(createdOf(again), "resolving an existing path creates nothing").toEqual([]);
  expect(leafOf(again)).toBe(leafOf(first));
  // Segments are split on "/", trimmed, and empty ones dropped.
  const spaced = await rp(` /rp${stamp}// a / b/ `);
  expect(spaced.status).toBe(200);
  expect(leafOf(spaced)).toBe(leafOf(first));
  // pinned: today's behaviour, no written rule (the unit test only says "an empty path throws"; the HTTP answer is a 500)
  expect((await rp(" / / ")).status).toBe(500);
  // The route's schema: a path is 1..200 characters (routes/tags.ts resolvePathSchema).
  expect((await rp("x".repeat(201))).status).toBe(400);
  // A segment matches the ONE sibling whose title differs only in case (tagHierarchy.ts tagIdForWrittenName).
  const rootRp = (await tree()).find((t) => t.name === `rp${stamp}` && t.parent_id === null)!;
  const caseVariant = await rp(`RP${stamp}`);
  expect(caseVariant.status).toBe(200);
  expect(createdOf(caseVariant)).toEqual([]);
  expect(leafOf(caseVariant)).toBe(rootRp.id);
  // Concurrency: 6 parallel resolves of one brand-new chain converge on one chain (tagIdForWrittenName: "resolving is idempotent under concurrency").
  const par = await Promise.all(Array.from({ length: 6 }, () => rp(`race${stamp}/x/y`)));
  expect(par.map((p) => p.status)).toEqual([200, 200, 200, 200, 200, 200]);
  expect(new Set(par.map(leafOf)).size).toBe(1);
  expect((await tree()).filter((t) => t.name === `race${stamp}`)).toHaveLength(1);

  // C) The tag-name rule is per parent: the same leaf name at the root is free while `par/leaf` exists,
  //    and a bare name written afterwards means that ROOT tag (never `par/leaf`).
  const nested = await rp(`par${stamp}/leaf${stamp}`);
  expect(nested.status).toBe(200);
  const imp = await page.request.post("/api/tags/import", { ...H, data: { name: `leaf${stamp}`, fields: [] } });
  expect(imp.status()).toBe(201);
  const rootViaPath = await rp(`leaf${stamp}`);
  expect(rootViaPath.status).toBe(200);
  expect(createdOf(rootViaPath)).toEqual([]);
  expect(leafOf(rootViaPath)).toBe((await imp.json()).id);
  expect(leafOf(rootViaPath)).not.toBe(leafOf(nested));

  // D) A full resend: same id + same Idempotency-Key answers the same result and creates no second tag
  //    (AGENTS.md 「網路失敗可能只是回應遺失：重試沿用原冪等鍵」).
  const cid = crypto.randomUUID();
  const send = () => page.request.post("/api/tags/import", { headers: { ...H.headers, "idempotency-key": cid }, data: { id: cid, name: `resend${stamp}`, fields: [] } });
  const s1 = await send(), s2 = await send();
  expect(s1.status()).toBe(201);
  expect(s2.ok()).toBe(true);
  // pinned: today's behaviour, no written rule (the replay's exact status and body)
  expect(s2.status()).toBe(200);
  expect(await s2.json()).toEqual({ deduped: true });
  expect((await tree()).filter((t) => t.name === `resend${stamp}`)).toHaveLength(1);
  // Same id without the key: the name is taken at the root → 409 tag_name_conflict (tagPacks.ts installTagPack doc).
  const s3 = await page.request.post("/api/tags/import", { ...H, data: { id: cid, name: `resend${stamp}`, fields: [] } });
  expect(s3.status()).toBe(409);
  expect((await s3.json()).error).toBe("tag_name_conflict");

  // E) Rename bounds: a new name has the tag-name shape and is free under the tag's parent; the colour is a hex colour or null
  //    (tagIdentity.ts writeTagIdentity). A refused rename changes nothing.
  const R = leafOf(await rp(`ren${stamp}`));
  const patch = async (data: Record<string, unknown>) => {
    const r = await page.request.patch(`/api/tags/${R}`, { ...H, data });
    return { status: r.status(), error: r.status() === 200 ? "" : (await r.json()).error as string };
  };
  await rp(`sib${stamp}`);
  expect(await patch({ name: `sib${stamp}` })).toEqual({ status: 409, error: "tag_name_conflict" });
  expect(await patch({ name: "   " })).toEqual({ status: 400, error: "tag_name_invalid" });
  expect((await tagRow(R)).name).toBe(`ren${stamp}`);
  expect(await patch({ name: `with/slash${stamp}` })).toEqual({ status: 400, error: "tag_name_invalid" });
  expect((await tagRow(R)).name).toBe(`ren${stamp}`);
  // A "/" in a path is a level, not part of a name: it makes two tags, neither of them the renamed one.
  const slashPath = await rp(`with/slash${stamp}`);
  expect(createdOf(slashPath)).toHaveLength(2);
  expect(leafOf(slashPath)).not.toBe(R);
  const colorBefore = (await tagRow(R)).color;
  expect((await patch({ color: "not-a-colour; background:url(x)" })).status).toBe(400);
  expect((await tagRow(R)).color).toBe(colorBefore);
  expect((await patch({ color: null })).status).toBe(200); // tagIdentity.ts: `color?: string | null`
  expect((await tagRow(R)).color).toBeNull();
  expect((await patch({ name: `ren${stamp}`, color: "#3366ff" })).status).toBe(200);

  // F) Rename projections: a stored membership follows the rename everywhere; an inline #word of the old name is text,
  //    not a tag (docs/decisions/tag-model.md 3).
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `RenNote ${stamp}`, markdown: `body mentions #ren${stamp} inline` } })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${R}`, { ...H, data: {} });
  await ready(page, `/?view=notes&node=${note.id}`);
  if (await page.locator(".notes-inspector-toggle").getAttribute("aria-pressed") === "false") await page.locator(".notes-inspector-toggle").click();
  const sources = titleTags(page);
  await expect(sources.getByRole("button", { name: `#ren${stamp}`, exact: true })).toBeVisible();
  await page.request.patch(`/api/tags/${R}`, { ...H, data: { name: `renamed${stamp}` } });
  await expect(sources.getByRole("button", { name: `#renamed${stamp}`, exact: true })).toBeVisible();
  await expect(sources.getByRole("button", { name: `#ren${stamp}`, exact: true })).toHaveCount(0);
  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(sidebarTag(page, `renamed${stamp}`)).toBeVisible();
  await expect(sidebarTag(page, `ren${stamp}`)).toHaveCount(0);
  const hit = async (q: string) => {
    const r = (await (await page.request.get(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()) as { id: string }[] | { results?: { id: string }[] };
    return (Array.isArray(r) ? r : r.results ?? []).some((x) => x.id === note.id);
  };
  expect(await hit(`#renamed${stamp}`)).toBe(true);
  expect(await hit(`#RENAMED${stamp}`), "tag names match case-insensitively (block-nodes.md)").toBe(true);
  expect(await hit(`#ren${stamp}`), "the old name is no longer the tag's name, and the body's #word is text").toBe(false);
  expect((await tree()).filter((t) => t.id === R).map((t) => t.name)).toEqual([`renamed${stamp}`]);
  expect(await slugOf(R), "the `tag-` slug follows the name (tagIdentity.ts)").toBe(`tag-renamed${stamp}`);

  // G) Another human (editor): renaming a tag and installing a pack are the owner's; creating a plain tag is any member's who
  //    can write somewhere (routes/tags.ts header; tagHierarchy.ts createTag "any_space_write").
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `T01 ${stamp}`, email: `t01-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `T01 ${stamp}`, type: "human", external_id: signup.user.id } });
  const ed = human.request;
  expect((await ed.patch(`/api/tags/${R}`, { ...H, data: { name: `hijack${stamp}` } })).status()).toBe(403);
  expect((await ed.post("/api/tags/resolve-path", { ...H, data: { path: `edpath${stamp}` } })).status()).toBe(200);
  expect((await ed.post("/api/tags/import", { ...H, data: { name: `edimp${stamp}`, fields: [] } })).status()).toBe(403);
  expect((await tree()).some((t) => t.name === `edimp${stamp}`)).toBe(false);
  // The same editor through the sidebar's "+ New tag" (tagWriter → POST /api/tags).
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, "/?view=notes");
  await hp.locator(".sidebar-tag-new").click();
  await hp.locator(".sidebar-tag-new-input").fill(`edui${stamp}`);
  await hp.locator(".sidebar-tag-new-input").press("Enter");
  await expect.poll(async () => (await tree()).some((t) => t.name === `edui${stamp}`)).toBe(true);
  await expect(sidebarTag(hp, `edui${stamp}`)).toBeVisible();
  await human.close();

  // H) Owner UI "+ New tag" with the create response lost after the server committed it: the retry reuses the key, so the
  //    tag exists once, the sidebar shows it, and nothing reports a failure (errors-and-saves.md: a lost response is not a failed save).
  await ready(page, "/?view=notes");
  let lost = false;
  await page.route("**/api/tags", async (route) => {
    if (!lost && route.request().method() === "POST") {
      lost = true;
      await route.fetch().catch(() => null); // the server commits…
      await route.abort("connectionreset"); // …the browser never sees it
    } else await route.continue();
  });
  await page.locator(".sidebar-tag-new").click();
  await page.locator(".sidebar-tag-new-input").fill(`lostresp${stamp}`);
  await page.locator(".sidebar-tag-new-input").press("Enter");
  await expect(sidebarTag(page, `lostresp${stamp}`)).toBeVisible();
  await expect.poll(async () => (await tree()).filter((t) => t.name === `lostresp${stamp}`).length).toBe(1);
  expect(lost).toBe(true);
  await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
  await expect(page.locator(".toast-message")).toHaveCount(0);
  await page.unroute("**/api/tags");
  await ready(page, "/?view=notes");
  await expect(sidebarTag(page, `lostresp${stamp}`)).toBeVisible();
  await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
  expect((await tree()).filter((t) => t.name === `lostresp${stamp}`)).toHaveLength(1);
});
