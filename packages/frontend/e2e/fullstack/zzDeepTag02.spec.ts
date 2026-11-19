// Feature-audit deepening (2026-10-07): TAG-02 — apply / remove / count / click
// agree across projections (sidebar count + click, search #tag, tag page
// members, note chips) for label and class tags; same name under two
// parents; online vs offline entries (note tag picker, quick capture); and the
// tasks, which are not tags (a task makes no `task` tag). Since T10 (2026-10-16)
// a #word written in a note's body or title is text, not a tag: inline-only
// notes are never members, and quick capture leaves its #word as text.
import { test, expect, type Page } from "@playwright/test";
import { ready, ensureInbox, openQuickCapture, saveQuickCapture, titleTags, titleTagAdd, titleTagOption, applyTagFromTitle, expectOfflineReady, H } from "./helpers";


// 2026-11-18 (owner: 「都改成檢查」): every value this probe used to record is now a check. Each `expect` names the written
// rule it follows; a line marked `pinned:` has no written rule and only records today's behaviour.
test("TAG-02: projections agree, duplicate names, offline entries, renamed task tag", async ({ page, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const mk = async (title: string, markdown = "x") => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()).id as string;
  const rp = async (path: string) => (await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path } })).json()).leaf_id as string;
  const tagOn = (n: string, t: string) => page.request.put(`/api/nodes/${n}/tags/${t}`, { ...H, data: {} });
  const memberIds = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const row = (boot.nodes as { id: string; class_tag_ids?: string[]; label_tag_ids?: string[] }[]).find((n) => n.id === id);
    return [...(row?.class_tag_ids ?? []), ...(row?.label_tag_ids ?? [])];
  };
  const searchIds = async (q: string) => ((await (await page.request.get(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()) as { id: string }[]).map((r) => r.id);
  const tagTree = async () => ((await (await page.request.get("/api/tags/tree")).json()).tags as { id: string; name: string; parent_id: string | null }[]);
  // The sidebar's tag tree: one row per tag ("Open #name"), with the count of directly tagged notes
  // (SidebarTagTree.tsx: directTagUsage). The name opens the tag's page.
  const sidebarRow = (p: Page, name: string) => p.getByRole("button", { name: `Open #${name}`, exact: true });
  const sidebarCount = async (p: Page, name: string) => Number((await sidebarRow(p, name).locator(".sb-tagtree-count").innerText()).trim());
  const memberTitles = async (p: Page) => (await p.locator(".tag-members-section li, .tag-members-section tbody tr").allInnerTexts());

  // A) Label tag L: n1 stored membership, n2 inline #L only, n3 both, n4 inline #L in capitals.
  //    docs/decisions/tag-model.md 3: a #word in the text is text, not a tag — members are n1 and n3 only,
  //    and the inline words create no tag of their own.
  const L = `lab${stamp}`;
  const tL = await rp(L);
  const n1 = await mk(`T02 member ${stamp}`), n2 = await mk(`T02 inline ${stamp}`, `text #${L} here`), n3 = await mk(`T02 both ${stamp}`, `#${L}`), n4 = await mk(`T02 lower ${stamp}`, `#${L.toUpperCase()}`);
  await tagOn(n1, tL); await tagOn(n3, tL);
  await ready(page, "/?view=notes");
  await expect(sidebarRow(page, L)).toBeVisible();
  expect(await sidebarCount(page, L)).toBe(2);
  await expect(sidebarRow(page, L.toUpperCase())).toHaveCount(0);
  expect((await tagTree()).filter((t) => t.name.toLowerCase() === L)).toHaveLength(1);
  await sidebarRow(page, L).click();
  await expect(page.locator(".tag-members-section")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("node")).toBe(tL);
  await expect.poll(async () => (await memberTitles(page)).length).toBe(2);
  const tagPageText = (await memberTitles(page)).join("\n");
  expect(tagPageText).toContain(`T02 member ${stamp}`);
  expect(tagPageText).toContain(`T02 both ${stamp}`);
  expect(tagPageText).not.toContain(`T02 inline ${stamp}`);
  expect(tagPageText).not.toContain(`T02 lower ${stamp}`);
  // Search `#tag` lists what the tag page lists (tagHierarchy.ts memberTagIdsNamed), names case-insensitive.
  for (const q of [`#${L}`, `#${L.toUpperCase()}`]) {
    const ids = await searchIds(q);
    expect(ids, q).toContain(n1); expect(ids, q).toContain(n3);
    expect(ids, q).not.toContain(n2); expect(ids, q).not.toContain(n4);
  }

  // B) Same leaf name under two parents: two tags (the name rule is per parent), each with its own members;
  //    a name search lists the members of every tag with that title (memberTagIdsNamed).
  const dup = `dup${stamp}`;
  const tA = await rp(`pa${stamp}/${dup}`), tB = await rp(`pb${stamp}/${dup}`);
  expect(tA).not.toBe(tB);
  const d1 = await mk(`T02 dupA ${stamp}`), d2 = await mk(`T02 dupB ${stamp}`);
  await tagOn(d1, tA); await tagOn(d2, tB);
  const dupTags = (await tagTree()).filter((t) => t.name === dup);
  expect(dupTags.map((t) => t.id).sort()).toEqual([tA, tB].sort());
  expect(new Set(dupTags.map((t) => t.parent_id)).size).toBe(2);
  const sD = await searchIds(`#${dup}`);
  expect(sD).toContain(d1); expect(sD).toContain(d2);
  for (const [tagId, mine, other] of [[tA, `T02 dupA ${stamp}`, `T02 dupB ${stamp}`], [tB, `T02 dupB ${stamp}`, `T02 dupA ${stamp}`]]) {
    await ready(page, `/?view=notes&node=${tagId}`);
    await expect(page.locator(".tag-members-section")).toBeVisible();
    await expect.poll(async () => (await memberTitles(page)).join("\n")).toContain(mine);
    expect((await memberTitles(page)).join("\n")).not.toContain(other);
  }
  // The note's tag picker offers both and no "Create" (TitleTagRow.tsx: a tag that differs only in parent is offered instead of a near-duplicate).
  const pick = await mk(`T02 picker ${stamp}`);
  await ready(page, `/?view=notes&node=${pick}`);
  const sources = titleTags(page);
  await (await titleTagAdd(page)).click();
  await sources.getByRole("combobox", { name: "Add a tag" }).fill(dup);
  await expect(page.locator("#title-tag-options").getByRole("option")).toHaveCount(2);
  await expect(titleTagOption(page, `#${dup}`)).toHaveCount(2);
  expect(await page.locator("#title-tag-options .title-tag-create").count()).toBe(0);
  await sources.getByRole("combobox", { name: "Add a tag" }).press("Escape");

  // C) Picker online → offline → reconnect. A queued write shows as saved locally and waiting, never as synced
  //    (AGENTS.md 「保存確認」; docs/decisions/no-p2p-intermittent-server.md: usable offline, synced on reconnect).
  const tOff = await rp(`off${stamp}`);
  await ready(page, `/?view=notes&node=${pick}`);
  // The harness has no cache of the lazily loaded screens until the idle warm-up has run (lib/offlineWarmup.ts). Offline
  // before that, the first screen the page needs is a failed chunk load: the whole app becomes "Not available offline yet",
  // its reconnect handler is gone and the queued removal below is never sent (a device that has used Onden online has them).
  await expectOfflineReady(page);
  await context.setOffline(true);
  await applyTagFromTitle(page, `off${stamp}`);
  await expect(sources.getByRole("button", { name: `#off${stamp}`, exact: true })).toBeVisible();
  await expect(page.locator(".toast-message", { hasText: "Tag saved locally; waiting to sync." })).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 30_000 }).toBe(true);
  // A membership tick that lands just before the connection drops must not lock the workspace while offline.
  const gate = page.locator(".membership-gate");
  await context.setOffline(true);
  await expect(gate).toBeHidden();
  await expect(sources.getByRole("button", { name: `Remove #off${stamp} from this note`, exact: true })).toBeVisible();
  await expect(gate, "still usable after the browser has been offline a while").toBeHidden();
  await context.setOffline(false);
  await expect(gate, "reconnecting needs no click").toBeHidden({ timeout: 30_000 });
  // Remove offline, reconnect.
  await context.setOffline(true);
  await sources.getByRole("button", { name: `Remove #off${stamp} from this note`, exact: true }).click();
  await expect(sources.getByRole("button", { name: `#off${stamp}`, exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 30_000 }).toBe(false);
  // 503 on apply is a retryable failure (errors-and-saves.md): the chip stays, the change is shown as waiting to sync
  // (no failure toast), and it lands once the server answers again.
  await page.route(`**/api/nodes/${pick}/tags/${tOff}`, (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
  await applyTagFromTitle(page, `off${stamp}`);
  await expect(sources.getByRole("button", { name: `#off${stamp}`, exact: true })).toBeVisible();
  await expect(page.locator(".sync-indicator, [class*=sync-status]").first()).toContainText("1 change waiting to sync");
  await expect(page.locator(".toast-message").filter({ hasNotText: "saved locally" }), "a 503 is retried, not reported as a failure").toHaveCount(0);
  expect((await memberIds(pick)).includes(tOff)).toBe(false);
  await page.unroute(`**/api/nodes/${pick}/tags/${tOff}`);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 90_000 }).toBe(true);

  // D) Quick capture with a #word, online and offline: the #word stays in the title and body, and no tag is made for it
  //    (tag-model.md 3). The note is filed in the inbox (docs/decisions/quick-capture-inbox.md), so its only membership is the inbox's.
  await ensureInbox(page);
  const inboxTagId = (await (await page.request.post("/api/capture/inbox", { ...H, data: {} })).json()).tag_id as string;
  const qcOn = `qcon${stamp}`, qcOff = `qcoff${stamp}`;
  const findByTitle = async (prefix: string) => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    return (boot.nodes as { id: string; title: string; markdown: string }[]).find((n) => n.title.startsWith(prefix));
  };
  await ready(page, "/?view=notes");
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(`QC online ${stamp} #${qcOn}`);
  await saveQuickCapture(page);
  await expect.poll(async () => !!(await findByTitle(`QC online ${stamp}`))).toBe(true);
  const on = (await findByTitle(`QC online ${stamp}`))!;
  expect(on.title).toBe(`QC online ${stamp} #${qcOn}`);
  expect(on.markdown).toBe(`QC online ${stamp} #${qcOn}`);
  expect(await memberIds(on.id)).toEqual([inboxTagId]);
  await context.setOffline(true);
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(`QC offline ${stamp} #${qcOff}`);
  await saveQuickCapture(page);
  await context.setOffline(false);
  await expect.poll(async () => !!(await findByTitle(`QC offline ${stamp}`)), { timeout: 30_000 }).toBe(true);
  const off = (await findByTitle(`QC offline ${stamp}`))!;
  expect(off.title).toBe(`QC offline ${stamp} #${qcOff}`);
  expect(off.markdown).toBe(`QC offline ${stamp} #${qcOff}`);
  expect(await memberIds(off.id)).toEqual([inboxTagId]);
  const names = (await tagTree()).map((t) => t.name);
  expect(names).not.toContain(qcOn);
  expect(names).not.toContain(qcOff);
  expect(await searchIds(`#${qcOff}`)).not.toContain(off.id);

  // E) Tasks are not tags: a task is its own row (docs/architecture/tasks-module.md), so making one creates no `task` tag, and a plain
  //    nested tag named "task" does not make a note a task (tag-model.md 2: a tag is not a state).
  const host = await mk(`T02 task host ${stamp}`);
  const tasksTags = async () => (await tagTree()).filter((t) => t.name === "task").length;
  const before = await tasksTags();
  const mkTask = await page.request.post(`/api/nodes/${host}/tasks`, { ...H, data: { title: `T02 task ${stamp}` } });
  const agendaHas = async (title: string) => JSON.stringify((await (await page.request.get("/api/tasks/agenda")).json())).includes(title);
  const bootTitles = async () => JSON.stringify((await (await page.request.get("/api/bootstrap")).json()).nodes.map((n: { title: string }) => n.title));
  expect(mkTask.status()).toBe(201);
  expect(await agendaHas(`T02 task ${stamp}`)).toBe(true);
  expect(await bootTitles()).not.toContain(`T02 task ${stamp}`);
  expect(await tasksTags()).toBe(before);
  const nestedTask = await rp(`proj${stamp}/task`);
  const plain = await mk(`T02 plain ${stamp}`);
  await tagOn(plain, nestedTask);
  expect(await bootTitles()).toContain(`T02 plain ${stamp}`);
  expect(await agendaHas(`T02 plain ${stamp}`)).toBe(false);
  expect((await page.request.get(`/api/nodes/${plain}`)).status()).toBe(200);
  await page.request.delete(`/api/nodes/${nestedTask}`, H);
});
